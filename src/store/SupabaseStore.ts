import type { SupabaseClient } from '@supabase/supabase-js';
import { LIBRARY_CONTENT, canonicalJson, computeLock, sha256Hex as sha256 } from '../core/index.ts';
import type { IntakeMessageInput, MatterState } from '../core/index.ts';
import { runExtraction } from '../core/index.ts';
import { validateMatterState } from './jsonImportExport.ts';
import { StoreError } from './Store.ts';
import type { ApprovalRecord, MatterRecord, Store } from './Store.ts';

interface DatabaseError { readonly code?: string; readonly message?: string; }
function check(error: DatabaseError | null): void {
  if (!error) return;
  const code = error.code === 'P0002' ? 'not_found' : error.code === '23505' ? 'revision_exists' : error.code === '40001' ? 'revision_not_increasing' : 'invalid';
  throw new StoreError(code, code === 'revision_not_increasing' ? 'Stored revision changed. Reopen the matter.' : `Storage action failed (${code}).`);
}
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Browser/user JWT client only. Service-role clients must never be passed into this Store. */
export class SupabaseStore implements Store {
  private readonly client: SupabaseClient;
  constructor(client: SupabaseClient) { this.client = client; }
  async createMatter(input: { readonly title?: string } = {}): Promise<MatterRecord> {
    const title = input.title?.trim() || 'Untitled matter';
    if ([...title].length > 120) throw new StoreError('invalid', 'Title exceeds 120 characters.');
    const { data, error } = await this.client.from('matters').insert({ title, mode: 'live' }).select('id,title,created_at').single();
    check(error); if (!data) throw new StoreError('invalid', 'Matter was not created.'); return copy(data as MatterRecord);
  }
  async getMatter(matterId: string): Promise<MatterRecord | null> {
    const { data, error } = await this.client.from('matters').select('id,title,created_at').eq('id', matterId).maybeSingle(); check(error); return data ? copy(data as MatterRecord) : null;
  }
  async listMatters(): Promise<MatterRecord[]> {
    const { data, error } = await this.client.from('matters').select('id,title,created_at').order('created_at').order('id'); check(error); return copy((data ?? []) as MatterRecord[]);
  }
  async deleteMatter(matterId: string): Promise<void> { const { error } = await this.client.rpc('delete_matter', { p_matter: matterId }); check(error); }
  async currentRevision(matterId: string): Promise<number> {
    const { data, error } = await this.client.from('matters').select('revision').eq('id', matterId).maybeSingle(); check(error);
    if (!data) throw new StoreError('not_found', 'Matter not found.'); return data.revision as number;
  }
  async saveState(matterId: string, proposed: MatterState): Promise<void> {
    const state = validateMatterState(proposed);
    const expected = await this.currentRevision(matterId);
    // Content hashes describe the snapshot; computing them does not unlock the committed render sentinel.
    const lock = computeLock(LIBRARY_CONTENT);
    const { error } = await this.client.rpc('save_matter_state', {
      p_matter: matterId, p_expected_revision: expected, p_state: state,
      p_state_hash: sha256(canonicalJson(state)), p_library_hash: lock.overall, p_jurisdiction_hash: lock.jurisdiction,
    }); check(error);
  }
  async getState(matterId: string, revision?: number): Promise<MatterState | null> {
    // A newer projection without a snapshot invalidates the prior snapshot for current-state operations.
    let target = revision;
    if (target === undefined) {
      try { target = await this.currentRevision(matterId); }
      catch (error) { if (error instanceof StoreError && error.code === 'not_found') return null; throw error; }
    }
    const { data, error } = await this.client.from('matter_state').select('revision,state,state_hash,library_hash,jurisdiction_hash').eq('matter_id', matterId).eq('revision', target).maybeSingle();
    check(error); if (!data) return null;
    const state = validateMatterState(data.state), lock = computeLock(LIBRARY_CONTENT);
    if (state.revision !== target || data.revision !== target || sha256(canonicalJson(state)) !== data.state_hash || data.library_hash !== lock.overall || data.jurisdiction_hash !== lock.jurisdiction) throw new StoreError('invalid', 'Snapshot hash or library mismatch.');
    if (revision === undefined && await this.currentRevision(matterId) !== target) return null;
    return copy(state);
  }
  async listRevisions(matterId: string): Promise<number[]> {
    const { data, error } = await this.client.from('matter_state').select('revision').eq('matter_id', matterId).order('revision'); check(error); return (data ?? []).map((row) => row.revision as number);
  }
  async appendApproval(approval: ApprovalRecord): Promise<void> {
    // Caller-supplied identity/time are intentionally ignored. SQL attributes the receipt to auth.uid().
    const { error } = await this.client.rpc('approve_bundle', { p_matter: approval.matter_id, p_revision: approval.revision, p_bundle_digest: approval.bundle_digest, p_library_hash: approval.library_hash }); check(error);
  }
  async listApprovals(matterId: string): Promise<ApprovalRecord[]> {
    const { data, error } = await this.client.from('approvals').select('matter_id,revision,bundle_digest,library_hash,approver,approved_at').eq('matter_id', matterId).order('approved_at'); check(error); return copy((data ?? []) as ApprovalRecord[]);
  }
  /** Save a normalized, empty-proposal snapshot BEFORE the edge function reads intake. No provider here. */
  async saveIntake(messages: readonly IntakeMessageInput[], method: 'llm' | 'jev', existingId: string | null): Promise<{ matterId: string; revision: number }> {
    const base = await runExtraction(messages, { method, extract: () => Promise.resolve({ fields: [], requests: [] }) });
    if (!base.ok) throw new StoreError('invalid', `Intake rejected (${base.error.code}).`);
    const matterId = existingId ?? (await this.createMatter({ title: `Tenancy draft · ${method}` })).id;
    const current = await this.currentRevision(matterId);
    const previous = await this.getState(matterId, current);
    const revision = previous || existingId !== null ? current + 1 : current;
    await this.saveState(matterId, { ...base.state, revision });
    return { matterId, revision };
  }
}
