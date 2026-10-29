import type { ProviderId, ProviderUsage } from '../providers/types.ts';

export type AttemptStatus = 'reserved' | 'dispatched' | 'settled' | 'failed_before_dispatch' | 'unknown_after_dispatch';
export interface PriceEntry {
  readonly provider: ProviderId;
  readonly model: string;
  readonly input_usd_per_million: number;
  readonly output_usd_per_million: number;
  /** Only a deliberate later price review can enable a live reservation. */
  readonly verified: boolean;
}
export interface PriceTable { readonly date: string; readonly entries: readonly PriceEntry[] }
export interface QuotaCaps {
  readonly rate_per_min_user: number;
  readonly max_attempt_usd: number;
  readonly daily_user_usd: number;
  readonly daily_install_usd: number;
}
/** Closed, redacted ledger row. Never spread a provider response or request into this record. */
export interface CallLedgerRow extends ProviderUsage {
  readonly run_id: string;
  readonly call_id: string;
  readonly request_id: string;
  readonly owner: string;
  readonly matter_id: string | null;
  readonly provider: ProviderId;
  readonly model: string;
  readonly prompt_hash: string;
  readonly reserved_usd: number;
  readonly settled_usd: number | null;
  readonly price_table_date: string;
  readonly latency_ms: number;
  readonly status: AttemptStatus;
  readonly raw_usage: Readonly<Record<string, number>>;
}
export interface ReserveResult {
  readonly status: AttemptStatus | 'conflict' | 'quota_exceeded';
  /** true ONLY for the transaction that created this reservation. Never dispatch on status alone. */
  readonly dispatch: boolean;
  readonly reserved_usd?: number;
  readonly settled_usd?: number | null;
}
export const USAGE_RPCS = { reserve: 'reserve_attempt', settle: 'settle_attempt' } as const;
export const MATTER_RPCS = { save: 'save_matter_state', approve: 'approve_bundle', delete: 'delete_matter' } as const;
