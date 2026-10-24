// SOURCE ONLY. Opt-in disposable target AFTER Dirty Mode. Never a production/existing user's database.
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SupabaseStore } from '../../src/store/SupabaseStore.ts';
import { LIBRARY_CONTENT, computeLock } from '../../src/core/index.ts';

describe.skipIf(process.env.RUN_DISPOSABLE_DB_CONTRACTS !== '1')('live SupabaseStore disposable round trip', () => {
  let service: SupabaseClient, userA: SupabaseClient, userB: SupabaseClient, a: SupabaseStore, b: SupabaseStore;
  const users: string[] = [];
  beforeAll(async () => {
    const url = process.env.DB_CONTRACT_URL, anon = process.env.DB_CONTRACT_ANON_KEY, key = process.env.DB_CONTRACT_SERVICE_ROLE_KEY;
    if (!url || !anon || !key) throw new Error('Disposable DB configuration required');
    const options = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };
    service = createClient(url, key, options); const clients: SupabaseClient[] = [];
    for (let i = 0; i < 2; i++) {
      const email = `synthetic-store-${randomUUID()}@example.invalid`, password = `Synthetic-${randomUUID()}`;
      const result = await service.auth.admin.createUser({ email, password, email_confirm: true });
      if (result.error || !result.data.user) throw new Error('Synthetic account creation failed'); users.push(result.data.user.id);
      const client = createClient(url, anon, options); if ((await client.auth.signInWithPassword({ email, password })).error) throw new Error('Synthetic sign-in failed'); clients.push(client);
    }
    [userA, userB] = clients; a = new SupabaseStore(userA); b = new SupabaseStore(userB);
  });
  afterAll(async () => { if (service) for (const id of users) await service.auth.admin.deleteUser(id); });
  it('persists and resumes canonical snapshots, enforces RLS, attributes approval, and deletes private state', async () => {
    const saved = await a.saveIntake([{ id: 'm1', text: 'A synthetic private intake' }], 'llm', null);
    expect(saved.revision).toBe(1); expect(await b.getMatter(saved.matterId)).toBeNull(); expect(await b.getState(saved.matterId, 1)).toBeNull();
    const initial = await a.getState(saved.matterId); if (!initial) throw new Error('Missing snapshot');
    await a.saveState(saved.matterId, { ...initial, revision: 2 });
    await expect(a.saveState(saved.matterId, { ...initial, revision: 2 })).rejects.toThrow();
    await expect(b.saveState(saved.matterId, { ...initial, revision: 3 })).rejects.toThrow();
    expect(await a.listRevisions(saved.matterId)).toEqual([1, 2]); expect((await a.getState(saved.matterId, 1))?.revision).toBe(1);
    const lock = computeLock(LIBRARY_CONTENT);
    await a.appendApproval({ matter_id: saved.matterId, revision: 2, bundle_digest: 'a'.repeat(64), library_hash: lock.overall, approver: 'forged-client-identity', approved_at: 'forged-client-time' });
    const receipts = await a.listApprovals(saved.matterId); expect(receipts[0].approver).toBe(users[0]); expect(receipts[0].approved_at).not.toBe('forged-client-time');
    expect(await b.listApprovals(saved.matterId)).toEqual([]);
    await a.deleteMatter(saved.matterId); expect(await a.getState(saved.matterId)).toBeNull(); expect(await a.getMatter(saved.matterId)).toBeNull();
    const retained = await userA.from('approvals').select('matter_id').eq('owner', users[0]); expect(retained.error).toBeNull(); expect(retained.data?.[0].matter_id).toBeNull();
  });
});
