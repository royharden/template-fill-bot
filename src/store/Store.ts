// Persistence interface (PLAN sections 4.8 and 5). Implementations: MemoryStore (demo mode, tests) and
// SupabaseStore (M6, signed-in, RLS). All methods are async so both behave alike.
//
// - matters: one row per matter.
// - matter state: insert-only, one canonical MatterState per (matter, revision); a revision is never overwritten
//   (mirrors the `matter_state` table). The latest revision is the current one.
// - approvals: APPEND-ONLY list (storage slot only; approval/binding logic is M4 rulings/approvals.ts).
// Stores return copies: callers can never mutate stored data through a returned object.
import type { MatterState } from '../core/index.ts';

export interface MatterRecord {
  readonly id: string;
  readonly title: string;
  readonly created_at: string;
}

/** One approval row (PLAN section 4.8). Never updated or deleted by the app. */
export interface ApprovalRecord {
  readonly matter_id: string;
  readonly revision: number;
  readonly bundle_digest: string;
  readonly library_hash: string;
  readonly approver: string;
  readonly approved_at: string;
}

export type StoreErrorCode = 'not_found' | 'revision_exists' | 'revision_not_increasing' | 'invalid';

export class StoreError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

export interface Store {
  createMatter(input?: { readonly title?: string }): Promise<MatterRecord>;
  getMatter(matterId: string): Promise<MatterRecord | null>;
  listMatters(): Promise<MatterRecord[]>;
  /** Deletes the matter and its states. Approvals stay (their matter link is cleared), as in the SQL design. */
  deleteMatter(matterId: string): Promise<void>;

  /** Insert-only: rejects a revision that already exists or is not greater than the latest. */
  saveState(matterId: string, state: MatterState): Promise<void>;
  /** A given revision, or the latest when `revision` is omitted; null when absent. */
  getState(matterId: string, revision?: number): Promise<MatterState | null>;
  listRevisions(matterId: string): Promise<number[]>;

  /** Append-only. */
  appendApproval(approval: ApprovalRecord): Promise<void>;
  listApprovals(matterId: string): Promise<ApprovalRecord[]>;
}
