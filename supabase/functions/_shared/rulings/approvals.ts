import { buildBundle, verifyBundle } from '../fillkit/bundle.ts';
import type { Bundle, BundleFilename, BundleOptions } from '../fillkit/bundle.ts';
// Structural store contract keeps the pure core independent of browser persistence modules.
import type { MatterState } from '../fillkit/matter.ts';
export interface BundleApproval { readonly matter_id: string; readonly revision: number; readonly bundle_digest: string; readonly library_hash: string; readonly approver: string; readonly approved_at: string }
export interface ApprovalStore {
  getState(matterId: string, revision?: number): Promise<MatterState | null>;
  appendApproval(approval: BundleApproval): Promise<void>;
  listApprovals(matterId: string): Promise<BundleApproval[]>;
}
export class ApprovalError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'ApprovalError'; this.code = code; }
}
export function approvalMatches(approval: BundleApproval, bundle: Bundle, matterId: string, revision: number): boolean {
  return bundle.manifest.matter_id === matterId && bundle.manifest.revision === revision && approval.matter_id === matterId && approval.revision === revision && approval.bundle_digest === bundle.digest && approval.library_hash === bundle.manifest.library_hash;
}
async function currentBundle(store: ApprovalStore, matterId: string, supplied: Bundle, opts: BundleOptions): Promise<Bundle> {
  const checked = verifyBundle(supplied, { ...opts, matterId });
  if (!checked.ok) throw new ApprovalError('gate_failed');
  const state = await store.getState(matterId);
  if (state === null) throw new ApprovalError('missing_state');
  if (state.revision !== supplied.manifest.revision) throw new ApprovalError('stale_revision');
  const regenerated = buildBundle(state, { ...opts, matterId, appVersion: opts.appVersion ?? supplied.manifest.app_version });
  if (!regenerated.ok || regenerated.bundle.digest !== supplied.digest) throw new ApprovalError('regeneration_mismatch');
  return regenerated.bundle;
}
export async function approveBundle(store: ApprovalStore, matterId: string, bundle: Bundle, approver: string, opts: BundleOptions & { readonly clock?: () => string } = {}): Promise<BundleApproval> {
  const frozen = await currentBundle(store, matterId, bundle, opts);
  if (!approver.trim()) throw new ApprovalError('approver_required');
  const approval: BundleApproval = { matter_id: matterId, revision: frozen.manifest.revision, bundle_digest: frozen.digest, library_hash: frozen.manifest.library_hash, approver, approved_at: (opts.clock ?? (() => new Date().toISOString()))() };
  await store.appendApproval(approval);
  return approval;
}
/** Recheck retained bytes, regenerate from persisted state, gate again, then return a fresh byte copy. */
export async function approvedDownload(store: ApprovalStore, matterId: string, bundle: Bundle, filename: BundleFilename, opts: BundleOptions = {}): Promise<Uint8Array> {
  if (!['agreement.md','agreement.docx','provenance.json','bundle.json'].includes(filename)) throw new ApprovalError('unknown_file');
  const frozen = await currentBundle(store, matterId, bundle, opts);
  const approvals = await store.listApprovals(matterId);
  if (!approvals.some((a) => approvalMatches(a, frozen, matterId, frozen.manifest.revision))) throw new ApprovalError('approval_required');
  // Detect a revision bump racing regeneration/listApprovals. Live appendApproval also performs an atomic RPC check.
  if ((await store.getState(matterId))?.revision !== frozen.manifest.revision) throw new ApprovalError('stale_revision');
  return frozen.files[filename].slice();
}
