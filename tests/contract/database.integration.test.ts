// NOT RUN in Dirty Mode. Opt-in only after DV-DB on a DISPOSABLE database dedicated to this suite.
// Creates synthetic auth users and removes them at the end. Retained ledger/quota/approval audit rows
// intentionally survive: use a fresh disposable database for each run, never an existing user's project.
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
const enabled = process.env.RUN_DISPOSABLE_DB_CONTRACTS === '1';
const hash = 'a'.repeat(64);
const fields = Object.fromEntries(['landlord','tenants','address','start_date','term_months','end_date','monthly_rent','rent_due_day','deposit','pets','smoking','furnished','utilities','guarantor','break_month']
  .map((field) => [field, { field, state: 'missing', candidates: [], reasons: [] }]));
const snapshot = (revision = 1, text = 'Synthetic intake for contract checks') => ({ schema_version: 1, revision, extractor_method: 'mock',
  intake: [{ id: 'm1', text_normalised: text }], fields, request_items: [], residuals: [], confirmations: [], answers: [],
  diagnostics: { dropped_keys: [], dropped_items: [], rejected_proposals: [], request_drops: [] } });

describe.skipIf(!enabled)('DISPOSABLE database contracts (deferred; no default network)', () => {
  let service: SupabaseClient; let userA: SupabaseClient; let userB: SupabaseClient; let anon: SupabaseClient;
  const users: string[] = []; let ownerA = ''; let ownerB = ''; let matter = '';
  beforeAll(async () => {
    const url = process.env.DB_CONTRACT_URL; const publicKey = process.env.DB_CONTRACT_ANON_KEY; const serviceKey = process.env.DB_CONTRACT_SERVICE_ROLE_KEY;
    if (!url || !publicKey || !serviceKey) throw new Error('Disposable contract target configuration is required');
    const opts = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };
    service = createClient(url, serviceKey, opts); anon = createClient(url, publicKey, opts);
    const clients: SupabaseClient[] = [];
    for (const seat of ['a','b']) {
      const email = `synthetic-${seat}-${randomUUID()}@example.invalid`; const password = `Synthetic-${randomUUID()}-Only`;
      const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
      if (created.error || !created.data.user) throw new Error('Synthetic user creation failed');
      users.push(created.data.user.id);
      const client = createClient(url, publicKey, opts);
      if ((await client.auth.signInWithPassword({ email, password })).error) throw new Error('Synthetic sign-in failed');
      clients.push(client);
    }
    userA = clients[0]!; userB = clients[1]!; ownerA = users[0]!; ownerB = users[1]!;
    const result = await userA.from('matters').insert({ title: 'Synthetic contract matter' }).select('id').single();
    if (result.error) throw new Error('Synthetic matter creation failed'); matter = result.data.id as string;
  });
  afterAll(async () => { if (service) for (const id of users) await service.auth.admin.deleteUser(id); });

  const saveArgs = (revision = 1, expected = 1, state = snapshot(revision)) => ({ p_matter: matter, p_expected_revision: expected,
    p_state: state, p_state_hash: hash, p_library_hash: hash, p_jurisdiction_hash: hash });
  it('isolates anonymous and second-user reads/writes and rejects forged ownership', async () => {
    expect((await anon.from('matters').select('id').eq('id',matter)).error).not.toBeNull();
    expect((await userB.from('matters').select('id').eq('id',matter)).data).toEqual([]);
    expect((await userB.from('messages').insert({ matter_id: matter, id: 'foreign', ord: 1, text_normalised: 'Synthetic' })).error).not.toBeNull();
    expect((await userA.from('matters').update({ owner: ownerB }).eq('id',matter)).error).not.toBeNull();
    expect((await userB.rpc('save_matter_state', saveArgs())).error).not.toBeNull();
  });
  it('enforces UTF-16 intake bounds and immutable optimistic snapshots', async () => {
    expect((await userA.rpc('save_matter_state', saveArgs(1,1,snapshot(1,'😀'.repeat(4001))))).error).not.toBeNull();
    expect((await userA.rpc('save_matter_state', saveArgs())).error).toBeNull();
    expect((await userA.rpc('save_matter_state', saveArgs())).error).not.toBeNull();
    expect((await userA.from('matter_state').update({ state: {} }).eq('matter_id',matter)).error).not.toBeNull();
    expect((await userA.rpc('save_matter_state', saveArgs(2,0))).error).not.toBeNull();
    expect((await userA.rpc('save_matter_state', saveArgs(2,1))).error).toBeNull();
  });
  it('sets approver server-side, rejects direct writes and stale approvals', async () => {
    const args = { p_matter: matter, p_revision: 2, p_bundle_digest: hash, p_library_hash: hash };
    expect((await userB.rpc('approve_bundle',args)).error).not.toBeNull();
    expect((await userA.rpc('approve_bundle',{...args,p_revision:1})).error).not.toBeNull();
    const approval = await userA.rpc('approve_bundle',args);
    expect(approval.error).toBeNull(); expect(approval.data.approver).toBe(ownerA);
    expect((await userA.from('approvals').insert({ matter_id: matter, owner: ownerA, approver: ownerA, revision: 2, bundle_digest: hash, library_hash: hash })).error).not.toBeNull();
  });
  it('admits duplicate/concurrent calls at most once and retains unknown charges', async () => {
    const request = randomUUID(); const caps = { rate_per_min_user: 5, max_attempt_usd: 0.1, daily_user_usd: 0.1, daily_install_usd: 2 };
    const args = { p_owner: ownerA, p_request_id: request, p_input_hash: hash, p_max_cost_usd: 0.1, p_caps: caps };
    expect((await userA.rpc('reserve_attempt',args)).error).not.toBeNull();
    const admitted = await Promise.all(Array.from({length: 4}, () => service.rpc('reserve_attempt',args)));
    expect(admitted.every((r) => r.error === null)).toBe(true); expect(admitted.filter((r) => r.data.dispatch === true)).toHaveLength(1);
    const conflict = await service.rpc('reserve_attempt',{...args,p_owner:ownerB});
    expect(conflict.data).toEqual({ status: 'conflict', dispatch: false });
    expect((await service.rpc('settle_attempt',{p_request_id:request,p_actual_usd:null,p_status:'dispatched'})).error).toBeNull();
    expect((await service.rpc('settle_attempt',{p_request_id:request,p_actual_usd:null,p_status:'unknown_after_dispatch'})).error).toBeNull();
    const refused = await service.rpc('reserve_attempt',{...args,p_request_id:randomUUID(),p_max_cost_usd:0.01});
    expect(refused.data.status).toBe('quota_exceeded');
    expect((await service.rpc('settle_attempt',{p_request_id:request,p_actual_usd:0,p_status:'failed_before_dispatch'})).error).not.toBeNull();
    expect((await service.rpc('settle_attempt',{p_request_id:request,p_actual_usd:0.03,p_status:'settled'})).error).toBeNull();
    expect((await service.rpc('settle_attempt',{p_request_id:request,p_actual_usd:0.03,p_status:'settled'})).error).toBeNull();
    expect((await service.from('call_ledger').insert({ call_id: randomUUID(), run_id: randomUUID(), request_id: request, owner: ownerA, matter_id: matter,
      provider: 'anthropic', model: 'synthetic', prompt_hash: hash, input_tokens: null, output_tokens: null, reserved_usd: 0.1, settled_usd: 0.03,
      price_table_date: '2026-10-24', latency_ms: 10, status: 'settled', raw_usage: {} })).error).toBeNull();
    expect((await userA.rpc('delete_matter',{p_matter:matter})).error).toBeNull();
    const ledger = await service.from('call_ledger').select('matter_id,settled_usd').eq('request_id',request).single();
    expect(ledger.data?.matter_id).toBeNull(); expect(Number(ledger.data?.settled_usd)).toBe(0.03);
    expect((await service.from('matter_state').select('revision').eq('matter_id',matter)).data).toEqual([]);
    const approvals = await service.from('approvals').select('matter_id').eq('owner',ownerA);
    expect(approvals.data?.length).toBeGreaterThan(0); expect(approvals.data?.every((a) => a.matter_id===null)).toBe(true);
  });
});
