import { MODEL_ID_RE, tokenCount } from '../providers/http.ts';
import type { ProviderId, ProviderUsage } from '../providers/types.ts';
import { PRICE_TABLE } from './priceTable.2026-10-24.ts';
import type { AttemptStatus, CallLedgerRow, PriceEntry, PriceTable } from './types.ts';

export class LedgerError extends Error {
  readonly code: 'price_missing' | 'invalid_usage' | 'invalid_ledger';
  constructor(code: LedgerError['code']) { super(code); this.name = 'LedgerError'; this.code = code; }
}
function validMoney(value: number): boolean { return Number.isFinite(value) && value >= 0 && value <= 1_000_000; }
export function priceFor(provider: ProviderId, model: string, table: PriceTable = PRICE_TABLE): PriceEntry {
  const price = table.entries.find((entry) => entry.provider === provider && entry.model === model && entry.verified);
  if (!price || !validMoney(price.input_usd_per_million) || !validMoney(price.output_usd_per_million)) throw new LedgerError('price_missing');
  return price;
}
/** Round UP to a nanodollar: reservation arithmetic must never round the bound down. */
function cost(input: number, output: number, price: PriceEntry): number {
  const value = (input * price.input_usd_per_million + output * price.output_usd_per_million) / 1_000_000;
  if (!validMoney(value)) throw new LedgerError('invalid_usage');
  return Math.ceil(value * 1_000_000_000) / 1_000_000_000;
}
export function usageCost(provider: ProviderId, model: string, usage: ProviderUsage, table: PriceTable = PRICE_TABLE): number | null {
  const price = priceFor(provider, model, table);
  // A zero output RATE does not turn an unreported output token count into a reported zero.
  if (usage.input_tokens === null || usage.output_tokens === null) return null;
  if (tokenCount(usage.input_tokens) === null || tokenCount(usage.output_tokens) === null) throw new LedgerError('invalid_usage');
  return cost(usage.input_tokens, usage.output_tokens, price);
}
export function reserveCost(provider: ProviderId, model: string, maxInputTokens: number, maxOutputTokens: number, table: PriceTable = PRICE_TABLE): number {
  if (tokenCount(maxInputTokens) === null || tokenCount(maxOutputTokens) === null) throw new LedgerError('invalid_usage');
  return cost(maxInputTokens, maxOutputTokens, priceFor(provider, model, table));
}
const RAW_USAGE_KEYS = ['input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const;
export function redactUsage(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  const record = raw as Record<string, unknown>;
  for (const key of RAW_USAGE_KEYS) { const value = tokenCount(record[key]); if (value !== null) out[key] = value; }
  return out;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
export interface LedgerInput {
  readonly run_id: string; readonly call_id: string; readonly request_id: string; readonly owner: string;
  readonly matter_id: string | null; readonly provider: ProviderId; readonly model: string; readonly prompt_hash: string;
  readonly reserved_usd: number; readonly usage: ProviderUsage | null; readonly raw_usage: unknown;
  readonly latency_ms: number; readonly status: AttemptStatus;
}
export function makeLedgerRow(input: LedgerInput, table: PriceTable = PRICE_TABLE): CallLedgerRow {
  if (![input.run_id, input.call_id, input.request_id, input.owner].every((id) => UUID_RE.test(id)) ||
      (input.matter_id !== null && !UUID_RE.test(input.matter_id)) || !HASH_RE.test(input.prompt_hash) ||
      !MODEL_ID_RE.test(input.model) || !validMoney(input.reserved_usd) || !Number.isSafeInteger(input.latency_ms) || input.latency_ms < 0) throw new LedgerError('invalid_ledger');
  const usage = { input_tokens: tokenCount(input.usage?.input_tokens), output_tokens: tokenCount(input.usage?.output_tokens) };
  const actual = input.status === 'failed_before_dispatch' ? 0 : input.status === 'settled' ? usageCost(input.provider, input.model, usage, table) : null;
  if (input.status === 'settled' && actual === null) throw new LedgerError('invalid_usage');
  // Explicit keys only. request text, provider errors and unknown usage keys cannot reach storage.
  return { run_id: input.run_id, call_id: input.call_id, request_id: input.request_id, owner: input.owner,
    matter_id: input.matter_id, provider: input.provider, model: input.model, prompt_hash: input.prompt_hash,
    ...usage, reserved_usd: input.reserved_usd, settled_usd: actual, price_table_date: table.date,
    latency_ms: input.latency_ms, status: input.status, raw_usage: redactUsage(input.raw_usage) };
}
/** Only use failed_before_dispatch when the adapter proved it never called fetch. */
export function settlementFor(dispatched: boolean, actualUsd: number | null): { status: AttemptStatus; actual_usd: number | null } {
  if (actualUsd !== null && !validMoney(actualUsd)) throw new LedgerError('invalid_usage');
  if (!dispatched) return { status: 'failed_before_dispatch', actual_usd: 0 };
  return actualUsd === null ? { status: 'unknown_after_dispatch', actual_usd: null } : { status: 'settled', actual_usd: actualUsd };
}
