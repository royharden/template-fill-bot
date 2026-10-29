// Web-standard handler; every effect is injected. No retries: a deliberate new request needs a fresh UUID.
import { z } from 'zod';
import { FIELD_KEYS } from '../_shared/content/types.ts';
import { canonicalJson } from '../_shared/fillkit/canonicalJson.ts';
import { sha256Hex as sha256, utf8Encode } from '../_shared/fillkit/hash.ts';
import { normaliseIntake } from '../_shared/fillkit/normalize.ts';
import type { NormalisedMessage } from '../_shared/fillkit/normalize.ts';
import { runExtraction } from '../_shared/fillkit/pipeline.ts';
import { createLlmExtractor } from '../_shared/fillkit/extractors/llm.ts';
import { createJevExtractor } from '../_shared/fillkit/extractors/jev.ts';
import type { ChoiceProvider, ChoiceRequest, ChoiceResult, CompletionProvider, CompletionRequest, CompletionResult, ProviderFailure } from '../_shared/providers/types.ts';
import { LedgerError, makeLedgerRow, reserveCost, usageCost } from '../_shared/callledger/ledger.ts';
import type { AttemptStatus, CallLedgerRow, PriceTable, QuotaCaps, ReserveResult } from '../_shared/callledger/types.ts';

export const MAX_BODY_BYTES = 16 * 1024;
export const ExtractRequestSchema = z.object({
  request_id: z.string().uuid(), matter_id: z.string().uuid(), revision: z.number().int().min(1).max(2147483645),
  method: z.enum(['llm', 'jev']), fields: z.array(z.enum(FIELD_KEYS)).min(1).max(FIELD_KEYS.length).refine((xs) => new Set(xs).size === xs.length).optional(),
}).strict();
export type ExtractRequest = z.infer<typeof ExtractRequestSchema>;
export interface MatterInput { readonly revision: number; readonly messages: readonly NormalisedMessage[]; }
interface SelectionBase { readonly model: string; readonly timeoutMs: number; }
export interface LlmSelection extends SelectionBase {
  readonly method: 'llm'; readonly provider: CompletionProvider; readonly maxTokens: number;
  /** Exact serialized wire body from the same provider builder used by complete (no headers/secrets). */
  readonly body: (request: CompletionRequest) => string;
}
export interface JevSelection extends SelectionBase {
  readonly method: 'jev'; readonly provider: ChoiceProvider;
  readonly body: (request: ChoiceRequest) => string;
}
export interface HandlerDeps {
  readonly allowedOrigins: readonly string[];
  readonly caps: QuotaCaps;
  readonly priceTable?: PriceTable;
  authenticate(token: string): Promise<{ readonly id: string } | null>;
  /** Must use the caller JWT/RLS, never a service-role read. */
  readInput(token: string, matterId: string): Promise<MatterInput | null>;
  select(method: 'llm' | 'jev'): LlmSelection | JevSelection | null;
  reserve(input: { owner: string; requestId: string; inputHash: string; maxCost: number; caps: QuotaCaps }): Promise<ReserveResult>;
  settle(requestId: string, actual: number | null, status: AttemptStatus): Promise<void>;
  writeLedger(row: CallLedgerRow): Promise<void>;
  readonly uuid: () => string;
}
export class EdgeError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  constructor(status: number, code: string, retryable = false) { super(code); this.status = status; this.code = code; this.retryable = retryable; }
}
function providerError(result: ProviderFailure): EdgeError {
  return new EdgeError(result.code === 'timeout' ? 504 : result.code === 'not_configured' ? 503 : 502, `provider_${result.code}`, result.retryable);
}
async function readBody(req: Request): Promise<unknown> {
  const length = req.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new EdgeError(413, 'body_too_large');
  if (!req.body) throw new EdgeError(400, 'invalid_json');
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const result = await reader.read(); if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new EdgeError(413, 'body_too_large'); }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new EdgeError(400, 'invalid_json'); }
}

export async function handle(req: Request, deps: HandlerDeps): Promise<Response> {
  const origin = req.headers.get('origin');
  const headers = new Headers({ 'content-type': 'application/json', vary: 'Origin', 'cache-control': 'no-store' });
  const allowed = origin === null || deps.allowedOrigins.includes(origin);
  if (origin && allowed) headers.set('access-control-allow-origin', origin);
  const respond = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers });
  let requestId: string | null = null;
  try {
    if (!allowed) throw new EdgeError(403, 'origin_not_allowed');
    if (req.method === 'OPTIONS') {
      headers.set('access-control-allow-methods', 'POST, OPTIONS');
      headers.set('access-control-allow-headers', 'authorization, apikey, content-type, x-client-info');
      return new Response(null, { status: 204, headers });
    }
    if (req.method !== 'POST') throw new EdgeError(405, 'method_not_allowed');
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
    if (!match) throw new EdgeError(401, 'unauthenticated');
    const user = await deps.authenticate(match[1]);
    if (!user) throw new EdgeError(401, 'unauthenticated');
    if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) throw new EdgeError(400, 'json_required');
    const parsed = ExtractRequestSchema.safeParse(await readBody(req));
    if (!parsed.success) throw new EdgeError(422, 'invalid_request');
    const input = parsed.data; requestId = input.request_id;
    const saved = await deps.readInput(match[1], input.matter_id);
    if (!saved) throw new EdgeError(404, 'matter_not_found');
    if (saved.revision !== input.revision) throw new EdgeError(409, 'stale_revision');
    const normalized = normaliseIntake(saved.messages.map((m) => ({ id: m.id, text: m.text_normalised })));
    if (!normalized.ok) throw new EdgeError(['too_long', 'too_many_messages'].includes(normalized.error.code) ? 413 : 422, 'invalid_intake');
    const selection = deps.select(input.method);
    if (!selection || selection.method !== input.method) throw new EdgeError(503, 'provider_not_configured');
    let fatal: unknown = null;
    let receipt: { call_id: string; settled_usd: number | null } | null = null;
    let attempted = false;

    async function metered<T extends CompletionResult | ChoiceResult>(body: string, maxOutput: number, dispatch: () => Promise<T>): Promise<T> {
      if (attempted) throw new EdgeError(503, 'retry_disabled');
      attempted = true;
      // Full provider wire body (including schema/state/questions) plus a conservative framing allowance.
      // Tokenizer/billing bound must be verified for the configured model before adding verified paid rates.
      const maxInput = utf8Encode(body).length + 4096;
      const bound = reserveCost(selection!.provider.id, selection!.model, maxInput, maxOutput, deps.priceTable);
      if (bound <= 0) throw new EdgeError(503, 'invalid_price_bound');
      const promptHash = sha256(body);
      const inputHash = sha256(canonicalJson({ owner: user!.id, matter: input.matter_id, revision: input.revision, method: input.method, fields: input.fields ?? null, model: selection!.model, provider: selection!.provider.id, promptHash }));
      const admission = await deps.reserve({ owner: user!.id, requestId: input.request_id, inputHash, maxCost: bound, caps: deps.caps });
      if (admission.dispatch !== true) throw new EdgeError(admission.status === 'quota_exceeded' ? 429 : 409, admission.status === 'quota_exceeded' ? 'quota_exceeded' : 'request_already_used');
      async function unknownReceipt(): Promise<void> {
        await deps.settle(input.request_id, null, 'unknown_after_dispatch');
        const callId = deps.uuid();
        await deps.writeLedger(makeLedgerRow({ run_id: input.request_id, call_id: callId, request_id: input.request_id, owner: user!.id,
          matter_id: input.matter_id, provider: selection!.provider.id, model: selection!.model, prompt_hash: promptHash,
          reserved_usd: admission.reserved_usd ?? bound, usage: null, raw_usage: null, latency_ms: 0, status: 'unknown_after_dispatch' }, deps.priceTable));
      }
      // Reservation is durable before this point; a crash or any bookkeeping failure cannot free it.
      let marked = false; let result: T;
      try {
        await deps.settle(input.request_id, null, 'dispatched'); marked = true;
        result = await dispatch();
      } catch {
        await unknownReceipt();
        throw new EdgeError(503, marked ? 'provider_outcome_unknown' : 'dispatch_record_failed', true);
      }
      let actual: number | null = null;
      if (result.provider !== selection!.provider.id || result.model !== selection!.model) {
        await unknownReceipt();
        throw new EdgeError(502, 'provider_identity_mismatch');
      }
      if (result.usage) { try { actual = usageCost(result.provider, result.model, result.usage, deps.priceTable); } catch { actual = null; } }
      // Once marked dispatched, absent usage stays unknown even for an adapter refusal: conservative,
      // no fabricated zero-token usage and no invalid backward SQL transition.
      const status = actual === null ? 'unknown_after_dispatch' : 'settled';
      await deps.settle(input.request_id, actual, status);
      const callId = deps.uuid();
      const row = makeLedgerRow({ run_id: input.request_id, call_id: callId, request_id: input.request_id, owner: user!.id,
        matter_id: input.matter_id, provider: result.provider, model: result.model, prompt_hash: promptHash,
        reserved_usd: admission.reserved_usd ?? bound, usage: result.usage, raw_usage: result.raw_usage,
        latency_ms: result.latency_ms, status }, deps.priceTable);
      await deps.writeLedger(row);
      receipt = { call_id: callId, settled_usd: actual };
      if (!result.ok) throw providerError(result);
      return result;
    }
    const extractor = selection.method === 'llm'
      ? createLlmExtractor({ id: selection.provider.id, complete: async (request) => {
        try { return await metered(selection.body(request), request.maxTokens, () => selection.provider.complete(request)); }
        catch (error) { fatal = error; throw error; }
      } }, { model: selection.model, timeoutMs: selection.timeoutMs, maxTokens: selection.maxTokens, signal: req.signal })
      : createJevExtractor({ id: selection.provider.id, choose: async (request) => {
        try { return await metered(selection.body(request), 0, () => selection.provider.choose(request)); }
        catch (error) { fatal = error; throw error; }
      } }, { model: selection.model, timeoutMs: selection.timeoutMs, signal: req.signal });
    const result = await runExtraction(normalized.messages.map((m) => ({ id: m.id, text: m.text_normalised })), {
      method: extractor.method,
      extract: (intake, specs, candidates) => extractor.extract(intake, input.fields ? specs.filter((s) => input.fields!.includes(s.key)) : specs, candidates),
    });
    if (fatal) throw fatal;
    if (!result.ok) throw new EdgeError(422, 'invalid_intake');
    if (result.state.diagnostics.extractor_error) throw new EdgeError(502, 'invalid_extractor_output');
    // Recheck after the paid call: a concurrent intake edit must never be published as current output.
    const current = await deps.readInput(match[1], input.matter_id);
    if (!current || current.revision !== input.revision || canonicalJson(current.messages) !== canonicalJson(saved.messages)) throw new EdgeError(409, 'stale_revision');
    const state = { ...result.state, revision: input.revision + 1 };
    return respond(200, { request_id: input.request_id, revision: state.revision, fields: state.fields, requests: state.request_items, state, ledger: receipt });
  } catch (error) {
    const e = error instanceof EdgeError ? error : error instanceof LedgerError ? new EdgeError(503, error.code) : new EdgeError(503, 'service_unavailable', true);
    return respond(e.status, { error: { code: e.code, message: e.code.replaceAll('_', ' '), retryable: e.retryable }, request_id: requestId });
  }
}
