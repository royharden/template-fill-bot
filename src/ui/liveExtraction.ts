import type { SupabaseClient } from '@supabase/supabase-js';
import type { IntakeMessageInput, MatterState } from '../core/index.ts';
import { canonicalJson } from '../core/index.ts';
import { SupabaseStore } from '../store/SupabaseStore.ts';
import { validateMatterState } from '../store/jsonImportExport.ts';

export function createLiveExtraction(client: SupabaseClient, store: SupabaseStore, uuid: () => string = () => crypto.randomUUID()) {
  return async (messages: readonly IntakeMessageInput[], method: 'llm' | 'jev', existingId: string | null): Promise<{ matterId: string; state: MatterState }> => {
    const { data: before, error: beforeError } = await client.auth.getUser();
    if (beforeError || !before.user) throw new Error('Sign in before extraction.');
    const userId = before.user.id;
    // Saves a complete immutable normalized intake revision, invalidating old approvals before any paid call.
    const saved = await store.saveIntake(messages, method, existingId);
    const persisted = await store.getState(saved.matterId, saved.revision);
    const requestId = uuid();
    const { data, error } = await client.functions.invoke('extract-fields', { body: { request_id: requestId, matter_id: saved.matterId, revision: saved.revision, method } });
    if (error || data?.error) throw new Error(`Extraction stopped (${typeof data?.error?.code === 'string' && /^[a-z_]{1,64}$/.test(data.error.code) ? data.error.code : 'backend_error'}). Your intake is saved; no automatic retry was made.`);
    const state = validateMatterState(data?.state);
    if (data.request_id !== requestId || data.revision !== saved.revision + 1 || state.revision !== saved.revision + 1 || state.extractor_method !== method || !persisted || canonicalJson(state.intake) !== canonicalJson(persisted.intake)) throw new Error('Extraction response does not match the saved intake revision.');
    const { data: after, error: afterError } = await client.auth.getUser();
    if (afterError || after.user?.id !== userId) throw new Error('Session changed during extraction.');
    if (await store.currentRevision(saved.matterId) !== saved.revision) throw new Error('Stored revision changed. Reopen the matter.');
    await store.saveState(saved.matterId, state);
    return { matterId: saved.matterId, state };
  };
}
