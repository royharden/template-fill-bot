// Source only: not run in Dirty Mode. All rates below are INVENTED TEST VALUES.
import { describe, expect, it } from 'vitest';
import { makeLedgerRow, priceFor, redactUsage, reserveCost, settlementFor, usageCost } from '../../supabase/functions/_shared/callledger/ledger.ts';
import { PRICE_TABLE } from '../../supabase/functions/_shared/callledger/priceTable.2026-10-24.ts';
import type { PriceTable } from '../../supabase/functions/_shared/callledger/types.ts';

const table: PriceTable = { date: '2026-10-24', entries: [
  { provider: 'anthropic', model: 'synthetic', input_usd_per_million: 2, output_usd_per_million: 6, verified: true },
  { provider: 'typesafe', model: 'synthetic-jev', input_usd_per_million: 1, output_usd_per_million: 0, verified: true },
] };
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
describe('dated price accounting (synthetic rates, no live price claims)', () => {
  it('prices reported tokens and reserves the declared maximum', () => {
    expect(usageCost('anthropic', 'synthetic', { input_tokens: 1000, output_tokens: 500 }, table)).toBe(0.005);
    expect(reserveCost('anthropic', 'synthetic', 2000, 1000, table)).toBe(0.01);
  });
  it('Jev output has zero cost while its token count stays as reported', () => {
    expect(usageCost('typesafe', 'synthetic-jev', { input_tokens: 1000, output_tokens: 500 }, table)).toBe(0.001);
    expect(usageCost('typesafe', 'synthetic-jev', { input_tokens: 1000, output_tokens: null }, table)).toBeNull();
  });
  it('fails closed on missing/unverified prices, including every default live model', () => {
    expect(() => priceFor('anthropic', 'synthetic', PRICE_TABLE)).toThrow('price_missing');
    expect(() => priceFor('anthropic', 'synthetic', { ...table, entries: table.entries.map((p) => ({ ...p, verified: false })) })).toThrow('price_missing');
  });
  it('never estimates missing usage and refuses unsafe counts', () => {
    expect(usageCost('anthropic', 'synthetic', { input_tokens: null, output_tokens: 0 }, table)).toBeNull();
    expect(() => reserveCost('anthropic', 'synthetic', -1, 500, table)).toThrow('invalid_usage');
  });
});
describe('redacted ledger and settlement', () => {
  it('retains no intake or error text, even when a provider embeds it inside usage', () => {
    const row = makeLedgerRow({ run_id: uuid(1), call_id: uuid(2), request_id: uuid(3), owner: uuid(4), matter_id: null,
      provider: 'anthropic', model: 'synthetic', prompt_hash: 'a'.repeat(64), reserved_usd: 0.01,
      usage: { input_tokens: null, output_tokens: null }, raw_usage: { input_tokens: 4, source: 'PRIVATE INTAKE', nested: { quote: 'PRIVATE INTAKE' } },
      latency_ms: 10, status: 'unknown_after_dispatch' }, table);
    expect(row.input_tokens).toBeNull(); expect(row.output_tokens).toBeNull(); expect(row.settled_usd).toBeNull();
    expect(row.raw_usage).toEqual({ input_tokens: 4 }); expect(JSON.stringify(row)).not.toContain('PRIVATE INTAKE');
    expect(redactUsage({ output_tokens: -2, total_tokens: '9', prompt_tokens: 9 })).toEqual({ prompt_tokens: 9 });
  });
  it('only proven pre-dispatch failures release cost; timeout remains unknown', () => {
    expect(settlementFor(false, null)).toEqual({ status: 'failed_before_dispatch', actual_usd: 0 });
    expect(settlementFor(true, null)).toEqual({ status: 'unknown_after_dispatch', actual_usd: null });
    expect(settlementFor(true, 0.005)).toEqual({ status: 'settled', actual_usd: 0.005 });
  });
});
