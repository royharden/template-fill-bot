import { vi } from 'vitest';
import type { HandlerDeps, LlmSelection } from '../../supabase/functions/extract-fields/handler.ts';
import type { CompletionResult, CompletionSuccess } from '../../supabase/functions/_shared/providers/types.ts';
import type { CallLedgerRow, PriceTable } from '../../supabase/functions/_shared/callledger/types.ts';

export const OWNER = '11111111-1111-4111-8111-111111111111';
export const MATTER = '22222222-2222-4222-8222-222222222222';
export const REQUEST = '33333333-3333-4333-8333-333333333333';
export const CALL = '44444444-4444-4444-8444-444444444444';
export const DTO = { request_id: REQUEST, matter_id: MATTER, revision: 1, method: 'llm' };
export const SYNTHETIC_PRICES: PriceTable = { date: '2026-10-24', entries: [{ provider: 'mock', model: 'fixture-model', input_usd_per_million: 1, output_usd_per_million: 2, verified: true }] };
export function success(): CompletionSuccess {
  return { ok: true, provider: 'mock', model: 'fixture-model', text: '{}', json: { fields: [], requests: [] },
    usage: { input_tokens: 10, output_tokens: 2 }, raw_usage: { input_tokens: 10, output_tokens: 2, secret_prompt: 'never-store-this' }, request_id: 'provider-1', latency_ms: 3 };
}
export function harness() {
  const events: string[] = [], rows: CallLedgerRow[] = [];
  const complete = vi.fn(async (): Promise<CompletionResult> => { events.push('provider'); return success(); });
  const selection: LlmSelection = { method: 'llm', model: 'fixture-model', timeoutMs: 1000, maxTokens: 256,
    provider: { id: 'mock', complete }, body: (request) => JSON.stringify({ ...request, signal: undefined }) };
  const deps: HandlerDeps = {
    allowedOrigins: ['https://accord.example'], caps: { rate_per_min_user: 5, max_attempt_usd: .1, daily_user_usd: .5, daily_install_usd: 2 }, priceTable: SYNTHETIC_PRICES,
    authenticate: vi.fn(async () => { events.push('auth'); return { id: OWNER }; }),
    readInput: vi.fn(async () => { events.push('read'); return { revision: 1, messages: [{ id: 'm1', text_normalised: 'Rent is £900 per month.' }] }; }),
    select: vi.fn(() => selection),
    reserve: vi.fn(async (input) => { events.push('reserve'); return { status: 'reserved', dispatch: true, reserved_usd: input.maxCost }; }),
    settle: vi.fn(async (_id, _actual, status) => { events.push(status); }),
    writeLedger: vi.fn(async (row) => { events.push('ledger'); rows.push(row); }), uuid: () => CALL,
  };
  return { deps, complete, selection, events, rows };
}
export function request(body: unknown = DTO, init: RequestInit = {}): Request {
  return new Request('https://project.example/functions/v1/extract-fields', {
    method: 'POST', headers: { authorization: 'Bearer user-jwt', 'content-type': 'application/json', origin: 'https://accord.example' },
    body: JSON.stringify(body), ...init,
  });
}
