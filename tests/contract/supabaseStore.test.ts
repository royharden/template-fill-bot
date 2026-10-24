import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { SupabaseStore } from '../../src/store/SupabaseStore.ts';
import { LIBRARY_CONTENT, canonicalJson, computeLock, runExtraction, sha256Hex } from '../../src/core/index.ts';
import type { MatterState } from '../../src/core/index.ts';
import { MATTER, OWNER } from './handlerHarness.ts';

interface Result { data: unknown; error: { code: string } | null; }
class Query implements PromiseLike<Result> {
  readonly response: Result;
  readonly calls: unknown[][];
  constructor(response: Result, calls: unknown[][]) { this.response = response; this.calls = calls; }
  insert(value: unknown): this { this.calls.push(['insert', value]); return this; }
  select(value: string): this { this.calls.push(['select', value]); return this; }
  eq(key: string, value: unknown): this { this.calls.push(['eq', key, value]); return this; }
  order(key: string): this { this.calls.push(['order', key]); return this; }
  single(): Promise<Result> { return Promise.resolve(this.response); }
  maybeSingle(): Promise<Result> { return Promise.resolve(this.response); }
  then<T = Result, U = never>(fulfilled?: ((value: Result) => T | PromiseLike<T>) | null, rejected?: ((reason: unknown) => U | PromiseLike<U>) | null): PromiseLike<T | U> { return Promise.resolve(this.response).then(fulfilled, rejected); }
}
function fake(results: Result[], rpcResult: Result = { data: null, error: null }) {
  const calls: unknown[][] = [];
  const client = {
    from(table: string) { calls.push(['from', table]); const response = results.shift(); if (!response) throw new Error('Unexpected query'); return new Query(response, calls); },
    rpc(name: string, args: unknown) { calls.push(['rpc', name, args]); return Promise.resolve(rpcResult); },
  } as unknown as SupabaseClient;
  return { store: new SupabaseStore(client), calls };
}
const ok = (data: unknown): Result => ({ data, error: null });
async function state(revision = 1): Promise<MatterState> {
  const result = await runExtraction([{ id: 'm1', text: 'A synthetic tenancy message' }], { method: 'llm', extract: async () => ({ fields: [], requests: [] }) });
  if (!result.ok) throw new Error('fixture'); return { ...result.state, revision };
}
function row(value: MatterState) { const lock = computeLock(LIBRARY_CONTENT); return { revision: value.revision, state: value, state_hash: sha256Hex(canonicalJson(value)), library_hash: lock.overall, jurisdiction_hash: lock.jurisdiction }; }

describe('SupabaseStore SQL/RPC contract (authored, not run)', () => {
  it('creates/lists/gets private matters without supplying ownership; returns copies', async () => {
    const matter = { id: MATTER, title: 'Synthetic', created_at: '2026-10-24T00:00:00Z' };
    const f = fake([ok(matter), ok(matter), ok([matter])]);
    const created = await f.store.createMatter({ title: 'Synthetic' }); expect(created).toEqual(matter); expect(created).not.toBe(matter);
    expect(await f.store.getMatter(MATTER)).toEqual(matter); expect(await f.store.listMatters()).toEqual([matter]);
    expect(f.calls).toContainEqual(['insert', { title: 'Synthetic', mode: 'live' }]); expect(JSON.stringify(f.calls)).not.toContain('owner');
  });
  it('saves the canonical validated state atomically with exact content/state hashes', async () => {
    const value = await state(2), f = fake([ok({ revision: 1 })]); await f.store.saveState(MATTER, value);
    const lock = computeLock(LIBRARY_CONTENT);
    expect(f.calls).toContainEqual(['rpc', 'save_matter_state', { p_matter: MATTER, p_expected_revision: 1, p_state: value,
      p_state_hash: sha256Hex(canonicalJson(value)), p_library_hash: lock.overall, p_jurisdiction_hash: lock.jurisdiction }]);
    expect(f.calls.some((call) => call[0] === 'insert')).toBe(false);
  });
  it('preserves immutable revision reads and rejects snapshot hash/library tampering', async () => {
    const value = await state(2), f = fake([ok({ revision: 2 }), ok(row(value)), ok({ revision: 2 }), ok([{ revision: 1 }, { revision: 2 }])]);
    expect(await f.store.getState(MATTER)).toEqual(value); expect(await f.store.listRevisions(MATTER)).toEqual([1, 2]);
    const forged = fake([ok({ ...row(value), state_hash: '0'.repeat(64) })]); await expect(forged.store.getState(MATTER, 2)).rejects.toThrow('Snapshot hash');
    const wrongLibrary = fake([ok({ ...row(value), library_hash: '0'.repeat(64) })]); await expect(wrongLibrary.store.getState(MATTER, 2)).rejects.toThrow('Snapshot hash');
    const absent = fake([ok(null)]); expect(await absent.store.getState(MATTER)).toBeNull();
  });
  it('never returns an old snapshot as current after a concurrent projection change', async () => {
    const value = await state(2), f = fake([ok({ revision: 2 }), ok(row(value)), ok({ revision: 3 })]);
    expect(await f.store.getState(MATTER)).toBeNull();
  });
  it('re-extraction saves intake as an increasing immutable snapshot before any edge call', async () => {
    const previous = await state(3), f = fake([ok({ revision: 3 }), ok(row(previous)), ok({ revision: 3 })]);
    const saved = await f.store.saveIntake([{ id: 'm1', text: 'Changed\r\nsynthetic intake' }], 'jev', MATTER);
    expect(saved).toEqual({ matterId: MATTER, revision: 4 });
    const rpc = f.calls.find((call) => call[0] === 'rpc')!; const args = rpc[2] as { p_state: MatterState };
    expect(args.p_state.intake[0].text_normalised).toBe('Changed\nsynthetic intake'); expect(args.p_state.extractor_method).toBe('jev');
  });
  it('delegates attribution to approval RPC and deletion to delete RPC; never browser-writes audits', async () => {
    const f = fake([ok([])]), approval = { matter_id: MATTER, revision: 2, bundle_digest: 'a'.repeat(64), library_hash: 'b'.repeat(64), approver: 'forged', approved_at: 'forged' };
    await f.store.appendApproval(approval); await f.store.deleteMatter(MATTER); expect(await f.store.listApprovals(MATTER)).toEqual([]);
    expect(f.calls).toContainEqual(['rpc', 'approve_bundle', { p_matter: MATTER, p_revision: 2, p_bundle_digest: approval.bundle_digest, p_library_hash: approval.library_hash }]);
    expect(f.calls).toContainEqual(['rpc', 'delete_matter', { p_matter: MATTER }]); expect(JSON.stringify(f.calls)).not.toContain('forged'); expect(JSON.stringify(f.calls)).not.toContain(OWNER);
  });
  it('maps optimistic concurrency/database failures to bounded Store errors', async () => {
    const f = fake([ok({ revision: 1 })], { data: null, error: { code: '40001' } });
    await expect(f.store.saveState(MATTER, await state(2))).rejects.toMatchObject({ code: 'revision_not_increasing' });
  });
});
