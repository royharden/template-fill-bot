import { describe, expect, it, vi } from 'vitest';
import { handle, MAX_BODY_BYTES } from '../../supabase/functions/extract-fields/handler.ts';
import type { ProviderFailure } from '../../supabase/functions/_shared/providers/types.ts';
import { CALL, DTO, OWNER, SYNTHETIC_PRICES, harness, request, success } from './handlerHarness.ts';

describe('extract-fields authorization and request boundary (SOURCE, not executed)', () => {
  it('allows exact-origin preflight without auth or storage; rejects other origins', async () => {
    const h = harness();
    const preflight = await handle(request(undefined, { method: 'OPTIONS', body: undefined }), h.deps);
    expect(preflight.status).toBe(204); expect(preflight.headers.get('access-control-allow-origin')).toBe('https://accord.example'); expect(h.deps.authenticate).not.toHaveBeenCalled();
    const denied = await handle(request(DTO, { headers: { origin: 'https://other.example' } }), h.deps);
    expect(denied.status).toBe(403); expect(denied.headers.has('access-control-allow-origin')).toBe(false);
  });
  it('rejects unsupported methods and absent/invalid user JWTs', async () => {
    const h = harness();
    expect((await handle(request(DTO, { method: 'GET', body: undefined }), h.deps)).status).toBe(405);
    expect((await handle(request(DTO, { headers: { 'content-type': 'application/json' } }), h.deps)).status).toBe(401);
    h.deps.authenticate = vi.fn(async () => null);
    expect((await handle(request(), h.deps)).status).toBe(401); expect(h.complete).not.toHaveBeenCalled();
  });
  it.each([
    { ...DTO, request_id: 'bad' }, { ...DTO, matter_id: 'bad' }, { ...DTO, revision: 0 }, { ...DTO, revision: 1.5 },
    { ...DTO, revision: 2147483646 }, { ...DTO, method: 'regex' }, { ...DTO, model: 'caller-model' },
    { ...DTO, fields: ['monthly_rent', 'monthly_rent'] }, { ...DTO, fields: ['unknown'] }, { ...DTO, fields: [] },
    { ...DTO, messages: ['injected'] },
  ])('rejects strict DTO %j before admission', async (body) => {
    const h = harness(); expect((await handle(request(body), h.deps)).status).toBe(422); expect(h.deps.reserve).not.toHaveBeenCalled();
  });
  it('bounds actual streamed UTF-8 bytes independently of content-length', async () => {
    const h = harness();
    const tooBig = request(DTO, { body: 'é'.repeat(MAX_BODY_BYTES / 2 + 1) });
    expect((await handle(tooBig, h.deps)).status).toBe(413);
    const declared = request(DTO, { headers: { authorization: 'Bearer x', 'content-type': 'application/json', 'content-length': String(MAX_BODY_BYTES + 1) } });
    expect((await handle(declared, h.deps)).status).toBe(413); expect(h.deps.readInput).not.toHaveBeenCalled();
  });
  it('rejects malformed JSON and wrong media type', async () => {
    const h = harness(); expect((await handle(request(DTO, { body: '{' }), h.deps)).status).toBe(400);
    expect((await handle(request(DTO, { headers: { authorization: 'Bearer x', 'content-type': 'text/plain' } }), h.deps)).status).toBe(400);
  });
  it('uses scoped data only; missing matter and stale revision never incur cost', async () => {
    const h = harness(); h.deps.readInput = vi.fn(async () => null);
    expect((await handle(request(), h.deps)).status).toBe(404);
    h.deps.readInput = vi.fn(async () => ({ revision: 2, messages: [] }));
    expect((await handle(request(), h.deps)).status).toBe(409); expect(h.deps.reserve).not.toHaveBeenCalled();
  });
  it.each([
    { messages: [{ id: 'm1', text_normalised: 'x'.repeat(8001) }], status: 413 },
    { messages: Array.from({ length: 13 }, (_, i) => ({ id: `m${i}`, text_normalised: 'x' })), status: 413 },
    { messages: [{ id: 'm1', text_normalised: 'forbidden\ttext' }], status: 422 },
    { messages: [], status: 422 },
  ])('re-normalizes and caps stored intake ($status)', async ({ messages, status }) => {
    const h = harness(); h.deps.readInput = vi.fn(async () => ({ revision: 1, messages }));
    expect((await handle(request(), h.deps)).status).toBe(status); expect(h.complete).not.toHaveBeenCalled();
  });
});

describe('atomic paid dispatch, conservative settlement, safe failures', () => {
  it('reserves full request including schema before one bounded dispatch; returns grounded next revision', async () => {
    const h = harness(); const response = await handle(request(), h.deps), body = await response.json();
    expect(response.status).toBe(200); expect(body.revision).toBe(2); expect(body.state.revision).toBe(2); expect(body.ledger.call_id).toBe(CALL);
    expect(h.events).toEqual(['auth', 'read', 'reserve', 'dispatched', 'provider', 'settled', 'ledger', 'read']);
    expect(h.complete).toHaveBeenCalledTimes(1); expect(h.complete.mock.calls[0]).toBeDefined();
    expect(h.rows[0].owner).toBe(OWNER); expect(h.rows[0].raw_usage).toEqual({ input_tokens: 10, output_tokens: 2 });
    expect(JSON.stringify(h.rows)).not.toContain('never-store-this'); expect(JSON.stringify(h.rows)).not.toContain('Rent is');
    const reservation = vi.mocked(h.deps.reserve).mock.calls[0][0]; expect(reservation.maxCost).toBeGreaterThan(.004096);
  });
  it('fails closed on absent config or unverified exact provider/model price before reservation', async () => {
    const h = harness(); h.deps.select = () => null;
    expect((await handle(request(), h.deps)).status).toBe(503); expect(h.deps.reserve).not.toHaveBeenCalled();
    h.deps.select = () => h.selection;
    const response = await handle(request(), { ...h.deps, priceTable: { date: SYNTHETIC_PRICES.date, entries: [] } }); expect(response.status).toBe(503); expect((await response.json()).error.code).toBe('price_missing'); expect(h.complete).not.toHaveBeenCalled();
  });
  it.each(['reserved', 'dispatched', 'settled', 'unknown_after_dispatch', 'conflict', 'quota_exceeded'] as const)('never dispatches replay/admission status %s without dispatch true', async (status) => {
    const h = harness(); h.deps.reserve = vi.fn(async () => ({ status, dispatch: false }));
    expect((await handle(request(), h.deps)).status).toBe(status === 'quota_exceeded' ? 429 : 409); expect(h.complete).not.toHaveBeenCalled();
  });
  it.each(['timeout', 'http_error', 'malformed', 'not_configured'] as const)('settles every returned failure %s without retry and redacts error text', async (code) => {
    const h = harness(); const failure: ProviderFailure = { ok: false, provider: 'mock', model: 'fixture-model', code, retryable: true,
      dispatched: true, reason: 'untrusted-secret-text', usage: null, raw_usage: { prompt: 'private' }, request_id: null, latency_ms: 1 };
    h.complete.mockResolvedValue(failure);
    const response = await handle(request(), h.deps); expect(response.status).toBe(code === 'timeout' ? 504 : code === 'not_configured' ? 503 : 502);
    expect(h.rows[0].status).toBe('unknown_after_dispatch'); expect(h.rows[0].settled_usd).toBeNull(); expect(h.complete).toHaveBeenCalledTimes(1);
    expect(await response.text()).not.toContain('untrusted-secret-text'); expect(JSON.stringify(h.rows)).not.toContain('private');
  });
  it('bills reported usage even on a failed response', async () => {
    const h = harness(); h.complete.mockResolvedValue({ ...success(), ok: false, code: 'malformed', retryable: false, dispatched: true, reason: 'truncated' } as ProviderFailure);
    expect((await handle(request(), h.deps)).status).toBe(502); expect(h.rows[0].status).toBe('settled'); expect(h.rows[0].settled_usd).toBeCloseTo(.000014, 9);
  });
  it('unknown dispatched throws retain full reservations and create a redacted receipt', async () => {
    const h = harness(); h.complete.mockRejectedValue(new Error('secret intake'));
    const response = await handle(request(), h.deps); expect(response.status).toBe(503); expect(h.rows[0].status).toBe('unknown_after_dispatch'); expect(h.rows[0].input_tokens).toBeNull();
    expect(h.complete).toHaveBeenCalledTimes(1); expect(await response.text()).not.toContain('secret');
  });
  it('requires model/provider identity to match reservation; records mismatch as unknown', async () => {
    const h = harness(); h.complete.mockResolvedValue({ ...success(), model: 'other-model' });
    expect((await handle(request(), h.deps)).status).toBe(502); expect(h.rows[0].model).toBe('fixture-model'); expect(h.rows[0].status).toBe('unknown_after_dispatch');
  });
  it('does not fabricate token counts when usage is unreported', async () => {
    const h = harness(); h.complete.mockResolvedValue({ ...success(), usage: { input_tokens: null, output_tokens: null } });
    expect((await handle(request(), h.deps)).status).toBe(200); expect(h.rows[0].settled_usd).toBeNull(); expect(h.rows[0].status).toBe('unknown_after_dispatch');
  });
  it('does not publish invalid output or output whose stored intake changed during dispatch', async () => {
    const h = harness(); h.complete.mockResolvedValue({ ...success(), json: { fields: 'not-array' } });
    expect((await handle(request(), h.deps)).status).toBe(502);
    h.complete.mockResolvedValue(success()); let reads = 0;
    h.deps.readInput = async () => ({ revision: ++reads === 1 ? 1 : 2, messages: [{ id: 'm1', text_normalised: 'Rent is £900 per month.' }] });
    expect((await handle(request(), h.deps)).status).toBe(409);
  });
  it.each(['reserve', 'writeLedger'] as const)('turns %s storage failure into bounded 503 without retry', async (operation) => {
    const h = harness(); if (operation === 'reserve') h.deps.reserve = vi.fn(async () => { throw new Error('database-private'); }); else h.deps.writeLedger = vi.fn(async () => { throw new Error('database-private'); });
    const response = await handle(request(), h.deps); expect(response.status).toBe(503); expect(await response.text()).not.toContain('database-private');
    expect(h.complete).toHaveBeenCalledTimes(operation === 'reserve' ? 0 : 1);
  });
  it('never dispatches when durable dispatched marking fails', async () => {
    const h = harness(); h.deps.settle = vi.fn(async (_id, _actual, status) => { if (status === 'dispatched') throw new Error('mark failed'); });
    expect((await handle(request(), h.deps)).status).toBe(503); expect(h.complete).not.toHaveBeenCalled(); expect(h.rows[0].status).toBe('unknown_after_dispatch');
  });
  it('does not retry or publish a success when final settlement fails', async () => {
    const h = harness(); h.deps.settle = vi.fn(async (_id, _actual, status) => { if (status !== 'dispatched') throw new Error('private-settlement-failure'); });
    const response = await handle(request(), h.deps); expect(response.status).toBe(503); expect(h.complete).toHaveBeenCalledTimes(1); expect(h.rows).toEqual([]);
    expect(await response.text()).not.toContain('private-settlement-failure');
  });
  it('rejects authentication or RLS storage transport failures without dispatch', async () => {
    const h = harness(); h.deps.authenticate = vi.fn(async () => { throw new Error('auth-service-secret'); });
    expect((await handle(request(), h.deps)).status).toBe(503);
    h.deps.authenticate = vi.fn(async () => ({ id: OWNER })); h.deps.readInput = vi.fn(async () => { throw new Error('rls-storage-secret'); });
    expect((await handle(request(), h.deps)).status).toBe(503); expect(h.complete).not.toHaveBeenCalled();
  });
});
