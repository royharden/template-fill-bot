// In-memory Store (demo mode and tests). Data lives only in this object; nothing is persisted.
// Ids and timestamps come from injectable generators so tests are deterministic.
import type { MatterState } from '../core/index.ts';
import { StoreError } from './Store.ts';
import type { ApprovalRecord, MatterRecord, Store } from './Store.ts';

export interface MemoryStoreOptions {
  readonly idGen?: () => string;
  readonly clock?: () => string;
}

/** Approvals as stored: deleting a matter clears the link (the only change ever made to an approval row). */
type StoredApproval = Omit<ApprovalRecord, 'matter_id'> & { matter_id: string | null };

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function defaultIdGen(): () => string {
  let n = 0;
  return () => {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c !== undefined && typeof c.randomUUID === 'function') return c.randomUUID();
    n += 1;
    return `matter-${n}`;
  };
}

export class MemoryStore implements Store {
  private readonly idGen: () => string;
  private readonly clock: () => string;
  private readonly matters = new Map<string, MatterRecord>();
  private readonly states = new Map<string, Map<number, MatterState>>();
  private readonly approvals: StoredApproval[] = [];

  constructor(opts: MemoryStoreOptions = {}) {
    this.idGen = opts.idGen ?? defaultIdGen();
    this.clock = opts.clock ?? (() => new Date().toISOString());
  }

  createMatter(input: { readonly title?: string } = {}): Promise<MatterRecord> {
    const id = this.idGen();
    if (this.matters.has(id)) return Promise.reject(new StoreError('invalid', 'duplicate matter id'));
    const record: MatterRecord = { id, title: input.title ?? 'Untitled matter', created_at: this.clock() };
    this.matters.set(id, record);
    this.states.set(id, new Map());
    return Promise.resolve(copy(record));
  }

  getMatter(matterId: string): Promise<MatterRecord | null> {
    const m = this.matters.get(matterId);
    return Promise.resolve(m === undefined ? null : copy(m));
  }

  listMatters(): Promise<MatterRecord[]> {
    const list = [...this.matters.values()].sort((a, b) =>
      a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    return Promise.resolve(copy(list));
  }

  deleteMatter(matterId: string): Promise<void> {
    if (!this.matters.has(matterId)) return Promise.reject(new StoreError('not_found', 'matter not found'));
    this.matters.delete(matterId);
    this.states.delete(matterId);
    for (const a of this.approvals) if (a.matter_id === matterId) a.matter_id = null;
    return Promise.resolve();
  }

  saveState(matterId: string, state: MatterState): Promise<void> {
    const revs = this.states.get(matterId);
    if (revs === undefined) return Promise.reject(new StoreError('not_found', 'matter not found'));
    if (!Number.isSafeInteger(state.revision) || state.revision < 1) {
      return Promise.reject(new StoreError('invalid', 'revision must be a positive integer'));
    }
    if (revs.has(state.revision)) return Promise.reject(new StoreError('revision_exists', 'revision already stored'));
    const latest = Math.max(0, ...revs.keys());
    if (state.revision <= latest) {
      return Promise.reject(new StoreError('revision_not_increasing', 'revision must increase'));
    }
    revs.set(state.revision, copy(state));
    return Promise.resolve();
  }

  getState(matterId: string, revision?: number): Promise<MatterState | null> {
    const revs = this.states.get(matterId);
    if (revs === undefined || revs.size === 0) return Promise.resolve(null);
    const rev = revision ?? Math.max(...revs.keys());
    const s = revs.get(rev);
    return Promise.resolve(s === undefined ? null : copy(s));
  }

  listRevisions(matterId: string): Promise<number[]> {
    const revs = this.states.get(matterId);
    return Promise.resolve(revs === undefined ? [] : [...revs.keys()].sort((a, b) => a - b));
  }

  appendApproval(approval: ApprovalRecord): Promise<void> {
    if (!this.matters.has(approval.matter_id)) return Promise.reject(new StoreError('not_found', 'matter not found'));
    this.approvals.push(copy(approval));
    return Promise.resolve();
  }

  listApprovals(matterId: string): Promise<ApprovalRecord[]> {
    const out: ApprovalRecord[] = [];
    for (const a of this.approvals) {
      if (a.matter_id === matterId) out.push(copy({ ...a, matter_id: matterId }));
    }
    return Promise.resolve(out);
  }
}
