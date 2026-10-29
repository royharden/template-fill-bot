// Node-only cumulative budget. Ledger is authoritative; state.json is a disposable view.
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { PriceTable } from '../supabase/functions/_shared/callledger/types.ts';
import { reserveCost } from '../supabase/functions/_shared/callledger/ledger.ts';
import type { ProviderId } from '../supabase/functions/_shared/providers/types.ts';
import { canonicalJson } from '../supabase/functions/_shared/fillkit/canonicalJson.ts';
import { sha256Hex } from '../supabase/functions/_shared/fillkit/hash.ts';

export interface BudgetEvent {
  version: 1; sequence: number; previous: string; digest: string; at: string; id: string;
  kind: 'reserve' | 'settle'; reserved_nano: number; actual_nano: number | null; dispatched: boolean;
  request_hash: string; retry_of: string | null;
}
const nano = (usd: number) => { if (!Number.isFinite(usd) || usd < 0) throw new Error('invalid_cost'); const n = Math.ceil(usd * 1e9); if (!Number.isSafeInteger(n)) throw new Error('invalid_cost'); return n; };
export interface BudgetAttempt { readonly id: string; readonly reserved_usd: number; readonly settled_usd: number | null; readonly state: 'reserved' | 'settled' | 'released' | 'unknown' }
export interface BudgetSnapshot { readonly events: readonly BudgetEvent[]; readonly attempts: readonly BudgetAttempt[]; readonly charged_usd: number; readonly reserved_usd: number; readonly settled_usd: number; readonly retained_usd: number; readonly outstanding: number }
export function budgetSnapshot(events: readonly BudgetEvent[]): BudgetSnapshot {
  let previous = '0'.repeat(64), sequence = 0;
  const attempts = new Map<string, { reserve: BudgetEvent; settle?: BudgetEvent }>();
  for (const event of events) {
    const { digest, ...body } = event;
    if (event.version !== 1 || event.sequence !== ++sequence || event.previous !== previous || sha256Hex(canonicalJson(body)) !== digest || !Number.isSafeInteger(event.reserved_nano) || event.reserved_nano < 0 || (event.actual_nano !== null && (!Number.isSafeInteger(event.actual_nano) || event.actual_nano < 0))) throw new Error('budget_ledger_corrupt');
    previous = digest;
    if (event.kind === 'reserve') {
      if (attempts.has(event.id) || event.reserved_nano > 100_000_000 || event.actual_nano !== null) throw new Error('budget_ledger_corrupt');
      if (event.retry_of) { const prior = attempts.get(event.retry_of); if (!prior || prior.reserve.retry_of || !prior.settle || prior.reserve.request_hash !== event.request_hash || [...attempts.values()].some((a) => a.reserve.retry_of === event.retry_of)) throw new Error('retry_limit'); }
      attempts.set(event.id, { reserve: event });
    } else if (event.kind === 'settle') {
      const attempt = attempts.get(event.id); if (!attempt || attempt.settle || event.reserved_nano !== attempt.reserve.reserved_nano || event.request_hash !== attempt.reserve.request_hash || (!event.dispatched && event.actual_nano !== 0)) throw new Error('budget_ledger_corrupt'); attempt.settle = event;
    } else throw new Error('budget_ledger_corrupt');
  }
  let charged = 0, outstanding = 0, reserved = 0, settled = 0, retained = 0;
  const states: BudgetAttempt[] = [];
  for (const { reserve, settle } of attempts.values()) {
    const cost = settle?.actual_nano, pending = cost === null || cost === undefined;
    reserved += reserve.reserved_nano; charged += pending ? reserve.reserved_nano : cost;
    if (pending) { outstanding++; retained += reserve.reserved_nano; } else settled += cost;
    states.push({ id: reserve.id, reserved_usd: reserve.reserved_nano / 1e9, settled_usd: pending ? null : cost / 1e9,
      state: !settle ? 'reserved' : cost === null ? 'unknown' : !settle.dispatched ? 'released' : 'settled' });
  }
  if (!Number.isSafeInteger(charged)) throw new Error('budget_overflow');
  return { events, attempts: states, charged_usd: charged / 1e9, reserved_usd: reserved / 1e9, settled_usd: settled / 1e9, retained_usd: retained / 1e9, outstanding };
}
export class DurableBudget {
  readonly directory: string;
  readonly maxAttemptUsd: number;
  readonly maxCumulativeUsd: number;
  constructor(directory: string, maxAttemptUsd = 0.10, maxCumulativeUsd = 2) {
    this.directory = directory; this.maxAttemptUsd = maxAttemptUsd; this.maxCumulativeUsd = maxCumulativeUsd;
    if (!(maxAttemptUsd > 0 && maxAttemptUsd <= 0.10 && maxCumulativeUsd > 0 && maxCumulativeUsd <= 2)) throw new Error('budget_caps');
  }
  private async locked<T>(action: (snapshot: BudgetSnapshot, append: (event: Omit<BudgetEvent, 'version' | 'sequence' | 'previous' | 'digest' | 'at'>) => Promise<void>) => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    // Atomic exclusive creation serializes local processes. Never auto-reap a lock: a crashed owner needs manual audit.
    const lock = await open(join(this.directory, 'ledger.lock'), 'wx').catch(() => { throw new Error('budget_locked_manual_audit_required'); });
    try {
      await lock.writeFile(canonicalJson({ pid: process.pid, at: new Date().toISOString() })); await lock.sync();
      let raw = ''; try { raw = await readFile(join(this.directory, 'ledger.jsonl'), 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (raw && !raw.endsWith('\n')) throw new Error('budget_partial_write_manual_audit_required');
      const events = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as BudgetEvent);
      const snapshot = budgetSnapshot(events);
      return await action(snapshot, async (input) => {
        const body = { ...input, version: 1 as const, sequence: events.length + 1, previous: events.at(-1)?.digest ?? '0'.repeat(64), at: new Date().toISOString() };
        const event: BudgetEvent = { ...body, digest: sha256Hex(canonicalJson(body)) };
        const updated = budgetSnapshot([...events, event]);
        const ledger = await open(join(this.directory, 'ledger.jsonl'), 'a');
        try { await ledger.writeFile(canonicalJson(event) + '\n'); await ledger.sync(); } finally { await ledger.close(); }
        // A crash here leaves the durable reservation intact; the next transaction rebuilds the view from the ledger.
        const temporary = join(this.directory, `state-${randomUUID()}.json`);
        try {
          await writeFile(temporary, canonicalJson({ charged_usd: updated.charged_usd, outstanding: updated.outstanding, last_digest: event.digest }));
          await rename(temporary, join(this.directory, 'state.json'));
        } catch { /* Disposable view failure cannot hide a successfully journaled reservation/settlement. */ }
      });
    } finally { await lock.close(); await unlink(join(this.directory, 'ledger.lock')); }
  }
  async snapshot(): Promise<BudgetSnapshot> { return this.locked(async (snapshot) => snapshot); }
  async reserve(requestHash: string, boundUsd: number, retryOf: string | null = null, attemptId = randomUUID()): Promise<string> {
    const amount = nano(boundUsd);
    if (!/^[a-f0-9]{64}$/.test(requestHash) || amount > nano(this.maxAttemptUsd)) throw new Error('budget_attempt_cap');
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(attemptId)) throw new Error('invalid_reservation_id');
    return this.locked(async (snapshot, append) => {
      if (nano(snapshot.charged_usd) + amount > nano(this.maxCumulativeUsd)) throw new Error('budget_cumulative_cap');
      await append({ kind: 'reserve', id: attemptId, reserved_nano: amount, actual_nano: null, dispatched: true, request_hash: requestHash, retry_of: retryOf }); return attemptId;
    });
  }
  async settle(id: string, actualUsd: number | null, dispatched: boolean): Promise<void> {
    await this.locked(async (snapshot, append) => {
      const reservation = snapshot.events.find((e) => e.kind === 'reserve' && e.id === id); if (!reservation) throw new Error('unknown_reservation');
      await append({ kind: 'settle', id, reserved_nano: reservation.reserved_nano, actual_nano: actualUsd === null ? null : nano(actualUsd), dispatched, request_hash: reservation.request_hash, retry_of: reservation.retry_of });
    });
  }
}
/** Bound the FULL serialized provider body, including schema, instructions, options and token limit.
 * Four tokens per UTF-8 byte + 4096 framing tokens is deliberately conservative; reviewed tokenizer/API assumptions remain DV-PROVIDERS.
 * Choices have no generated-text allowance; caller supplies zero only for verified input-only pricing.
 */
export function requestBound(body: string, maxOutputTokens: number, provider: ProviderId, model: string, prices: PriceTable): number {
  return reserveCost(provider, model, Buffer.byteLength(body, 'utf8') * 4 + 4096, maxOutputTokens, prices);
}
