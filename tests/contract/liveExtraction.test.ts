import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/store/MemoryStore.ts';
import type { SupabaseStore } from '../../src/store/SupabaseStore.ts';
import { createLiveExtraction } from '../../src/ui/liveExtraction.ts';
import { runExtraction } from '../../src/core/index.ts';
import type { MatterState } from '../../src/core/index.ts';
import { CALL, OWNER } from './handlerHarness.ts';

async function fixture() {
  const events: string[] = [], store = new MemoryStore(); const matter = await store.createMatter();
  const inputs = [{ id: 'm1', text: 'Rent is GBP 900 per month.' }];
  const base = await runExtraction(inputs, { method: 'llm', extract: async () => ({ fields: [], requests: [] }) });
  if (!base.ok) throw new Error('fixture'); const intake = base.state; const state = { ...intake, revision: 2 };
  const currentRevision = vi.fn(async () => 1);
  const saved = {
    saveIntake: vi.fn(async () => { events.push('intake'); await store.saveState(matter.id, intake); return { matterId: matter.id, revision: 1 }; }),
    getState: (id: string, revision?: number) => store.getState(id, revision), currentRevision,
    saveState: vi.fn(async (id: string, value: MatterState) => { events.push('state'); await store.saveState(id, value); }),
  };
  const getUser = vi.fn(async () => ({ data: { user: { id: OWNER } }, error: null }));
  const invoke = vi.fn(async () => { events.push('edge'); expect(await store.getState(matter.id, 1)).not.toBeNull(); return { data: { request_id: CALL, revision: 2, state }, error: null }; });
  const client = { auth: { getUser }, functions: { invoke } } as unknown as SupabaseClient;
  const extract = createLiveExtraction(client, saved as unknown as SupabaseStore, () => CALL);
  return { extract, saved, events, store, matter, inputs, intake, state, getUser, invoke };
}
describe('live persisted-intake/extraction/snapshot workflow', () => {
  it('persists intake before edge invocation, sends IDs only, and appends immutable next revision', async () => {
    const f = await fixture(); const result = await f.extract(f.inputs, 'llm', null);
    expect(f.events).toEqual(['intake', 'edge', 'state']); expect(result.state.revision).toBe(2);
    expect(f.invoke).toHaveBeenCalledWith('extract-fields', { body: { request_id: CALL, matter_id: f.matter.id, revision: 1, method: 'llm' } });
    expect((await f.store.getState(f.matter.id, 1))?.revision).toBe(1); expect(await f.store.listRevisions(f.matter.id)).toEqual([1, 2]);
  });
  it('retains saved intake after backend failure without retry or final snapshot', async () => {
    const f = await fixture(); f.invoke.mockResolvedValue({ data: null, error: new Error('private-backend-text') } as never);
    await expect(f.extract(f.inputs, 'llm', null)).rejects.toThrow('no automatic retry'); expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(await f.store.listRevisions(f.matter.id)).toEqual([1]); expect(f.saved.saveState).not.toHaveBeenCalled();
  });
  it('rejects changed users, stale revisions and response identity/intake substitution', async () => {
    const user = await fixture(); user.getUser.mockResolvedValueOnce({ data: { user: { id: OWNER } }, error: null }).mockResolvedValueOnce({ data: { user: { id: 'other' } }, error: null });
    await expect(user.extract(user.inputs, 'llm', null)).rejects.toThrow('Session changed'); expect(user.saved.saveState).not.toHaveBeenCalled();
    const stale = await fixture(); stale.saved.currentRevision.mockResolvedValue(2);
    await expect(stale.extract(stale.inputs, 'llm', null)).rejects.toThrow('Stored revision changed');
    const forged = await fixture(); forged.invoke.mockResolvedValue({ data: { request_id: 'other', revision: 2, state: forged.state }, error: null });
    await expect(forged.extract(forged.inputs, 'llm', null)).rejects.toThrow('does not match'); expect(forged.saved.saveState).not.toHaveBeenCalled();
    const replaced = await fixture(); replaced.invoke.mockResolvedValue({ data: { request_id: CALL, revision: 2, state: { ...replaced.state, intake: [{ id: 'm1', text_normalised: 'A substituted message' }] } }, error: null });
    await expect(replaced.extract(replaced.inputs, 'llm', null)).rejects.toThrow(); expect(replaced.saved.saveState).not.toHaveBeenCalled();
  });
});
