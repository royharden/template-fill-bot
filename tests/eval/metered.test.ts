import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DurableBudget, budgetSnapshot } from '../../eval/budget.ts';
import type { BudgetEvent } from '../../eval/budget.ts';
import { ResponseCache } from '../../eval/cache.ts';
import { Meter, newObservation } from '../../eval/providers/metered.ts';
import type { CompletionRequest, CompletionResult } from '../../supabase/functions/_shared/providers/types.ts';
import type { PriceTable } from '../../supabase/functions/_shared/callledger/types.ts';
const synthetic: PriceTable = { date: 'SYNTHETIC-TEST-NOT-CURRENT-PRICES', entries: [{ provider: 'anthropic', model: 'synthetic', verified: true, input_usd_per_million: 1, output_usd_per_million: 2 }] };
const request: CompletionRequest = { model: 'synthetic', system: 'Synthetic fixture only.', messages: [{ role: 'user', content: 'Synthetic.' }], maxTokens: 10, timeoutMs: 1 };
const identity = { thresholds: {}, config: { synthetic: true }, fixture: 'synthetic-fixture', input: 'synthetic' };
async function setup(prices = synthetic, retries: 0 | 1 = 0, now?: () => number) {
  const directory = await mkdtemp(join(tmpdir(), 's30-meter-test-')), budget = new DurableBudget(join(directory, 'budget')),
    cache = new ResponseCache(join(directory, 'cache')), observation = newObservation();
  return { budget, cache, observation, meter: new Meter({ budget, cache, observation, prices, retries, identity, now }) };
}
const success: CompletionResult = { ok: true, provider: 'anthropic', model: 'synthetic', text: 'synthetic answer', json: null, usage: { input_tokens: 10, output_tokens: 2 }, raw_usage: null, request_id: 'synthetic', latency_ms: 5 };
describe('every live provider attempt crosses reservation and cache boundaries', () => {
  it('refuses unpriced dispatch and records no reservation', async () => {
    const { meter, budget } = await setup({ date: 'synthetic-empty', entries: [] }); let calls = 0;
    await expect(meter.call(request, 'anthropic', () => JSON.stringify(request), async () => { calls++; return success; }, 10)).rejects.toThrow('price_missing');
    expect(calls).toBe(0); expect((await budget.snapshot()).charged_usd).toBe(0);
  });
  it('reserves before dispatch and treats replay as zero new paid cost with original cost separate', async () => {
    const { meter, budget, cache, observation } = await setup(); let calls = 0;
    const dispatch = async () => { calls++; expect((await budget.snapshot()).charged_usd).toBeGreaterThan(0); return success; };
    await meter.call(request, 'anthropic', () => JSON.stringify(request), dispatch, 10);
    const paid = observation.paid_usd!; expect(paid).toBeGreaterThan(0);
    const replayObservation = newObservation(), replay = new Meter({ budget, cache, observation: replayObservation, prices: synthetic, retries: 0, identity });
    await replay.call(request, 'anthropic', () => { throw new Error('cache_hit_must_not_build_or_dispatch'); }, dispatch, 10);
    expect(calls).toBe(1); expect(replayObservation).toMatchObject({ paid_usd: 0, replay: true, replay_original_usd: paid, latency_ms: null, dispatched_attempts: 0, latency_observed_attempts: 0 });
    expect((await budget.snapshot()).charged_usd).toBe(paid);
    expect(observation).toMatchObject({ settled_usd: paid, retained_usd: 0, outstanding_attempts: 0, latency_ms: 5, dispatched_attempts: 1, latency_observed_attempts: 1 });
    expect(observation.reserved_usd).toBeGreaterThan(paid);
  });
  it('retains an unknown timeout charge, and one retry always gets another reservation', async () => {
    const { meter, budget, observation } = await setup(synthetic, 1); let calls = 0;
    await meter.call(request, 'anthropic', () => JSON.stringify(request), async (): Promise<CompletionResult> => {
      calls++; return { ok: false, provider: 'anthropic', model: 'synthetic', code: 'timeout', reason: 'timeout', dispatched: true, retryable: true, usage: null, raw_usage: null, request_id: null, latency_ms: 1 };
    }, 10);
    const snapshot = await budget.snapshot();
    expect(calls).toBe(2); expect(snapshot.outstanding).toBe(2); expect(observation.paid_usd).toBeNull();
    expect(observation).toMatchObject({ settled_usd: 0, retained_usd: observation.reserved_usd, outstanding_attempts: 2, latency_ms: 2, dispatched_attempts: 2, latency_observed_attempts: 2 });
    const reservations = snapshot.events.filter((e) => e.kind === 'reserve'); expect(reservations).toHaveLength(2);
    expect(reservations[1].id).not.toBe(reservations[0].id); expect(reservations[1].retry_of).toBe(reservations[0].id);
  });
  it('keeps the reservation after a thrown transport outcome rather than inferring zero cost', async () => {
    let tick = 10; const { meter, budget, observation } = await setup(synthetic, 0, () => { const now = tick; tick += 7; return now; });
    await expect(meter.call(request, 'anthropic', () => JSON.stringify(request), async () => { throw new Error('synthetic transport crash'); }, 10)).rejects.toThrow('provider_unknown_after_dispatch');
    expect((await budget.snapshot()).charged_usd).toBeGreaterThan(0); expect(observation.paid_usd).toBeNull();
    expect(observation).toMatchObject({ latency_ms: 7, dispatched_attempts: 1, latency_observed_attempts: 1, retained_usd: observation.reserved_usd });
  });
  it('releases a pre-dispatch refusal without inventing latency or retained exposure', async () => {
    const { meter, observation } = await setup();
    await meter.call(request, 'anthropic', () => JSON.stringify(request), async (): Promise<CompletionResult> => ({ ok: false, provider: 'anthropic', model: 'synthetic', code: 'not_configured', reason: 'missing_key', dispatched: false, retryable: false, usage: null, raw_usage: null, request_id: null, latency_ms: 0 }), 10);
    expect(observation).toMatchObject({ paid_usd: 0, settled_usd: 0, retained_usd: 0, outstanding_attempts: 0, dispatched_attempts: 0, undispatched_attempts: 1, latency_ms: null, latency_observed_attempts: 0, latency_missing_attempts: 0 });
    expect(observation.reserved_usd).toBeGreaterThan(0);
  });
  it('distinguishes a measured zero duration from a missing duration', async () => {
    const zero = await setup(); await zero.meter.call(request, 'anthropic', () => JSON.stringify(request), async () => ({ ...success, latency_ms: 0 }), 10);
    expect(zero.observation).toMatchObject({ latency_ms: 0, latency_observed_attempts: 1, latency_missing_attempts: 0 });
    const missing = await setup(); await missing.meter.call(request, 'anthropic', () => JSON.stringify(request), async () => ({ ...success, latency_ms: null as unknown as number }), 10);
    expect(missing.observation).toMatchObject({ latency_ms: null, dispatched_attempts: 1, latency_observed_attempts: 0, latency_missing_attempts: 1 });
  });
  it('records provider charge and duration before a failed settlement and reconciles durable reserved state', async () => {
    const { meter, budget, observation } = await setup(); budget.settle = async () => { throw new Error('synthetic_settlement_refused'); };
    await expect(meter.call(request, 'anthropic', () => JSON.stringify(request), async () => success, 10)).rejects.toThrow('synthetic_settlement_refused');
    expect(observation.paid_usd).toBeGreaterThan(0);
    expect(observation).toMatchObject({ settled_usd: 0, retained_usd: observation.reserved_usd, outstanding_attempts: 1, latency_ms: 5, dispatched_attempts: 1, latency_observed_attempts: 1 });
  });
  it('reads a persisted settlement even if later settlement I/O reports failure', async () => {
    const { meter, budget, observation } = await setup(), settle = budget.settle.bind(budget);
    budget.settle = async (...args) => { await settle(...args); throw new Error('synthetic_failure_after_journal'); };
    await expect(meter.call(request, 'anthropic', () => JSON.stringify(request), async () => success, 10)).rejects.toThrow('synthetic_failure_after_journal');
    expect(observation).toMatchObject({ settled_usd: observation.paid_usd, retained_usd: 0, outstanding_attempts: 0, latency_ms: 5 });
    expect(observation.paid_usd).toBeGreaterThan(0);
  });
  it('keeps unknown cost and observed thrown-dispatch latency when settlement also fails', async () => {
    let tick = 0; const { meter, budget, observation } = await setup(synthetic, 0, () => { const now = tick; tick += 9; return now; });
    budget.settle = async () => { throw new Error('synthetic_settlement_refused'); };
    await expect(meter.call(request, 'anthropic', () => JSON.stringify(request), async () => { throw new Error('synthetic_transport'); }, 10)).rejects.toThrow('synthetic_settlement_refused');
    expect(observation).toMatchObject({ paid_usd: null, settled_usd: 0, retained_usd: observation.reserved_usd, outstanding_attempts: 1, latency_ms: 9, dispatched_attempts: 1, latency_observed_attempts: 1 });
  });
  it('uses unknown durable financial fields when ledger observation is unavailable after dispatch', async () => {
    const { meter, budget, observation } = await setup();
    budget.settle = async () => { throw new Error('synthetic_settlement_refused'); };
    budget.snapshot = async () => { throw new Error('budget_locked_manual_audit_required'); };
    await expect(meter.call(request, 'anthropic', () => JSON.stringify(request), async () => success, 10)).rejects.toThrow('synthetic_settlement_refused');
    expect(observation.paid_usd).toBeGreaterThan(0);
    expect(observation).toMatchObject({ reserved_usd: null, settled_usd: null, retained_usd: null, outstanding_attempts: null, latency_ms: 5 });
  });
  for (const finalization of ['journal_close_failed', 'lock_close_failed', 'lock_unlink_failed']) it(`reconciles a persisted reserve whose ${finalization} rejection overrides its return`, async () => {
    const { meter, budget, observation } = await setup(), reserve = budget.reserve.bind(budget); let calls = 0, trackedId: string | undefined;
    // Fault-inject the public reserve boundary: a durable append succeeds, then finalization rejects.
    // The meter must know the id even though reserve never returns it. No provider dispatch is permitted.
    budget.reserve = async (hash, bound, retryOf, attemptId) => { trackedId = attemptId; await reserve(hash, bound, retryOf, attemptId); throw new Error(finalization); };
    await expect(meter.call(request, 'anthropic', () => JSON.stringify(request), async () => { calls++; return success; }, 10)).rejects.toThrow(finalization);
    const snapshot = await budget.snapshot(), durable = snapshot.attempts.find((attempt) => attempt.id === trackedId);
    expect(trackedId).toMatch(/^[a-f0-9-]{36}$/); expect(durable?.state).toBe('reserved'); expect(calls).toBe(0);
    expect(observation).toMatchObject({ reserved_usd: snapshot.reserved_usd, settled_usd: 0, retained_usd: snapshot.retained_usd, outstanding_attempts: 1,
      paid_usd: 0, dispatched_attempts: 0, latency_ms: null, error: finalization });
    expect(observation.retained_usd).toBeGreaterThan(0);
  });
  it('reports unknown volume/exposure when reserve cleanup rejects and a surviving lock prevents reconciliation', async () => {
    const { meter, budget, observation } = await setup(), reserve = budget.reserve.bind(budget); let calls = 0, trackedId: string | undefined;
    budget.reserve = async (hash, bound, retryOf, attemptId) => {
      trackedId = attemptId; await reserve(hash, bound, retryOf, attemptId);
      await writeFile(join(budget.directory, 'ledger.lock'), 'Synthetic surviving cleanup lock; manual audit required.');
      throw new Error('synthetic_lock_unlink_failed');
    };
    await expect(meter.call(request, 'anthropic', () => JSON.stringify(request), async () => { calls++; return success; }, 10)).rejects.toThrow('synthetic_lock_unlink_failed');
    expect(calls).toBe(0); expect(observation).toMatchObject({ reserved_usd: null, settled_usd: null, retained_usd: null, outstanding_attempts: null, paid_usd: 0, dispatched_attempts: 0, latency_ms: null, error: 'synthetic_lock_unlink_failed' });
    await expect(budget.snapshot()).rejects.toThrow('budget_locked_manual_audit_required');
    // Read-only audit of the untouched journal proves that reporting zero retained liability would be false.
    const events = (await readFile(join(budget.directory, 'ledger.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as BudgetEvent), audit = budgetSnapshot(events);
    expect(audit.attempts).toContainEqual({ id: trackedId, reserved_usd: audit.reserved_usd, settled_usd: null, state: 'reserved' });
    expect(audit.retained_usd).toBeGreaterThan(0);
  });
  it('reconciles a true cap refusal as confirmed zero instead of inventing retained exposure', async () => {
    const { cache, observation } = await setup(), directory = await mkdtemp(join(tmpdir(), 's30-cap-refusal-test-')), budget = new DurableBudget(directory, .000001);
    const meter = new Meter({ budget, cache, observation, prices: synthetic, retries: 0, identity }); let calls = 0;
    await expect(meter.call(request, 'anthropic', () => JSON.stringify(request), async () => { calls++; return success; }, 10)).rejects.toThrow('budget_attempt_cap');
    expect(calls).toBe(0); expect((await budget.snapshot()).attempts).toHaveLength(0);
    expect(observation).toMatchObject({ reserved_usd: 0, settled_usd: 0, retained_usd: 0, outstanding_attempts: 0, paid_usd: 0, dispatched_attempts: 0, latency_ms: null });
  });
});
