import { mkdtemp, writeFile, open, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DurableBudget, requestBound } from '../../eval/budget.ts';
import type { PriceTable } from '../../supabase/functions/_shared/callledger/types.ts';
const hash = 'a'.repeat(64);
// LABELLED SYNTHETIC TEST RATES. Never a claim about any current paid provider/model.
const synthetic: PriceTable = { date: 'synthetic-test-only', entries: [{ provider: 'anthropic', model: 'synthetic', input_usd_per_million: 1, output_usd_per_million: 2, verified: true }] };
const directory = () => mkdtemp(join(tmpdir(), 's30-budget-test-'));
describe('persisted cumulative eval budget', () => {
  it('bounds the entire serialized schema/prompt/options request and refuses missing verified prices', () => {
    const short = requestBound('{"messages":[]}', 100, 'anthropic', 'synthetic', synthetic);
    expect(requestBound(JSON.stringify({ messages: [], schema: 'x'.repeat(10000), options: ['a', 'b'] }), 100, 'anthropic', 'synthetic', synthetic)).toBeGreaterThan(short);
    expect(() => requestBound('{}', 1, 'anthropic', 'unpriced', synthetic)).toThrow('price_missing');
    expect(() => new DurableBudget('unused', .11, 2)).toThrow('budget_caps');
    expect(() => new DurableBudget('unused', .1, 2.01)).toThrow('budget_caps');
  });
  it('retains crashed/unknown reservations across instances and refuses a retry that would exceed cap', async () => {
    const path = await directory(), budget = new DurableBudget(path, .1, .15);
    const id = await budget.reserve(hash, .1); // Crash before settlement: still charged.
    expect((await new DurableBudget(path, .1, .15).snapshot()).charged_usd).toBe(.1);
    await budget.settle(id, null, true);
    await expect(budget.reserve(hash, .1, id)).rejects.toThrow('budget_cumulative_cap');
    const retry = await budget.reserve(hash, .05, id); await budget.settle(retry, 0, false);
    expect((await budget.snapshot()).charged_usd).toBe(.1);
    await expect(budget.reserve(hash, .01, retry)).rejects.toThrow('retry_limit');
  });
  it('allows one reservation winner across concurrent local processes and never double-settles', async () => {
    const path = await directory(), a = new DurableBudget(path, .1, .1), b = new DurableBudget(path, .1, .1);
    const outcomes = await Promise.allSettled([a.reserve(hash, .1), b.reserve(hash, .1)]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const winner = outcomes.find((o): o is PromiseFulfilledResult<string> => o.status === 'fulfilled')!;
    await a.settle(winner.value, .03, true);
    await expect(a.settle(winner.value, .03, true)).rejects.toThrow('budget_ledger_corrupt');
    expect((await b.snapshot()).charged_usd).toBe(.03);
  });
  it('separates total reserved volume, settled spend and outstanding retained exposure', async () => {
    const budget = new DurableBudget(await directory()), settled = await budget.reserve(hash, .1);
    await budget.settle(settled, .03, true);
    const released = await budget.reserve(hash, .1); await budget.settle(released, 0, false);
    const unknown = await budget.reserve(hash, .1); await budget.settle(unknown, null, true);
    const interrupted = await budget.reserve(hash, .05), snapshot = await budget.snapshot();
    expect(snapshot.reserved_usd).toBe(.35); expect(snapshot.settled_usd).toBe(.03); expect(snapshot.retained_usd).toBe(.15);
    expect(snapshot.charged_usd).toBe(.18); expect(snapshot.outstanding).toBe(2);
    expect(snapshot.attempts).toEqual([
      { id: settled, reserved_usd: .1, settled_usd: .03, state: 'settled' },
      { id: released, reserved_usd: .1, settled_usd: 0, state: 'released' },
      { id: unknown, reserved_usd: .1, settled_usd: null, state: 'unknown' },
      { id: interrupted, reserved_usd: .05, settled_usd: null, state: 'reserved' },
    ]);
  });
  it('returns durable reservation identity and settlement despite a failed disposable state-view rename', async () => {
    const path = await directory(); await mkdir(join(path, 'state.json')); // Directory forces the auxiliary rename to fail.
    const budget = new DurableBudget(path), id = await budget.reserve(hash, .1);
    expect((await budget.snapshot()).attempts).toContainEqual({ id, reserved_usd: .1, settled_usd: null, state: 'reserved' });
    await budget.settle(id, .03, true);
    expect(await budget.snapshot()).toMatchObject({ reserved_usd: .1, settled_usd: .03, retained_usd: 0, outstanding: 0, charged_usd: .03 });
  });
  it('fails closed on partial journals and stale locks instead of silently resetting spend', async () => {
    const path = await directory(), budget = new DurableBudget(path);
    await writeFile(join(path, 'ledger.jsonl'), '{"partial":');
    await expect(budget.snapshot()).rejects.toThrow('budget_partial_write_manual_audit_required');
    const locked = await directory(), handle = await open(join(locked, 'ledger.lock'), 'wx'); await handle.close();
    await expect(new DurableBudget(locked).reserve(hash, .01)).rejects.toThrow('budget_locked_manual_audit_required');
  });
});
