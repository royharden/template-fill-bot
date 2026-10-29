// Anthropic Messages API adapter (raw fetch; no SDK, so the same file runs in Deno, Node and tests).
//
// Request shape (UNVERIFIED against live docs in Dirty Mode; re-check at DV-PROVIDERS):
//   POST {baseUrl}/v1/messages
//   headers: x-api-key, anthropic-version: 2026-10-21, content-type: application/json
//   body: { model, max_tokens, system, messages:[{role, content}],
//           output_config?: { format?: { type:'json_schema', schema }, effort? } }
//
// Structured-output choice: `output_config.format` (JSON-schema structured outputs), NOT forced tool use.
// Planned structured outputs constrain the final text block to the schema (objects need additionalProperties:false).
// The JSON arrives as the text block(s) of the response; we still JSON.parse it here and the caller still
// validates it with zod (model output is untrusted). API/version/model assumptions are pending DV-PROVIDERS.
// No `temperature`/`top_p`/`top_k` or `thinking` field is sent. Thinking blocks are ignored; accounting uses
// only reported usage. No inference about current model defaults or billing is made here.
// The model id always comes from server config (EXTRACT_MODEL_LLM); nothing here picks a model.
import {
  checkBounds,
  checkHttpsBaseUrl,
  failure,
  httpFailure,
  isPlainObject,
  MODEL_ID_RE,
  postJson,
  resolveFetch,
  resolveNow,
  safeRequestId,
  SCHEMA_NAME_RE,
  tokenCount,
  transportFailure,
  tryParseJson,
} from './http.ts';
import type { BuiltRequest, FailureContext } from './http.ts';
import type {
  AdapterOptions,
  CompletionProvider,
  CompletionRequest,
  CompletionResult,
  ProviderUsage,
} from './types.ts';

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2026-10-21';
export const ANTHROPIC_EFFORTS = ['low', 'medium', 'high'] as const;
export type AnthropicEffort = (typeof ANTHROPIC_EFFORTS)[number];

export interface AnthropicConfig extends AdapterOptions {
  /** Server secret ANTHROPIC_API_KEY, passed in by the caller. Missing/empty → not_configured (never a fake reply). */
  readonly apiKey: string | null | undefined;
  /** Server-side override only (tests / a gateway); must be https. */
  readonly baseUrl?: string;
  /** Optional `output_config.effort`; omitted → the model's default. */
  readonly effort?: AnthropicEffort;
}

/** Pure request builder (exported for contract tests). Returns a reason token when the config/request is unusable. */
export function buildAnthropicRequest(
  request: CompletionRequest,
  config: AnthropicConfig,
): { ok: true; built: BuiltRequest } | { ok: false; reason: string } {
  if (typeof config.apiKey !== 'string' || config.apiKey.trim() === '') return { ok: false, reason: 'missing_key' };
  const base = checkHttpsBaseUrl(config.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL);
  if (base === null) return { ok: false, reason: 'bad_base_url' };
  if (!MODEL_ID_RE.test(request.model)) return { ok: false, reason: 'bad_model' };
  const bounds = checkBounds(request.timeoutMs, request.maxTokens);
  if (bounds) return { ok: false, reason: bounds };
  if (request.messages.length === 0 || request.messages[0]?.role !== 'user') return { ok: false, reason: 'bad_messages' };
  if (request.jsonSchema && !SCHEMA_NAME_RE.test(request.jsonSchema.name)) return { ok: false, reason: 'bad_schema_name' };
  if (config.effort !== undefined && !ANTHROPIC_EFFORTS.includes(config.effort)) return { ok: false, reason: 'bad_effort' };

  const outputConfig: Record<string, unknown> = {};
  if (request.jsonSchema) outputConfig.format = { type: 'json_schema', schema: request.jsonSchema.schema };
  if (config.effort !== undefined) outputConfig.effort = config.effort;

  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxTokens,
    system: request.system,
    messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (Object.keys(outputConfig).length > 0) body.output_config = outputConfig;

  return {
    ok: true,
    built: {
      url: `${base}/v1/messages`,
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    },
  };
}

function usageOf(raw: unknown): ProviderUsage | null {
  if (!isPlainObject(raw)) return null;
  return { input_tokens: tokenCount(raw.input_tokens), output_tokens: tokenCount(raw.output_tokens) };
}

/** Pure response parser (exported for contract tests with recorded fixtures). */
export function parseAnthropicResponse(
  ctx: FailureContext,
  text: string,
  requestIdHeader: string | null,
  wantJson: boolean,
): CompletionResult {
  const body = tryParseJson(text);
  if (!isPlainObject(body)) {
    return failure(ctx, { code: 'malformed', reason: 'bad_body', dispatched: true, retryable: false, status: 200, request_id: requestIdHeader });
  }
  const requestId = requestIdHeader ?? safeRequestId(body.id);
  const rawUsage = body.usage ?? null;
  const usage = usageOf(rawUsage);
  const common = { dispatched: true, retryable: false, status: 200, usage, raw_usage: rawUsage, request_id: requestId };

  const stop = body.stop_reason;
  if (stop === 'max_tokens') return failure(ctx, { code: 'malformed', reason: 'max_tokens', ...common });
  if (stop === 'refusal') return failure(ctx, { code: 'malformed', reason: 'refusal', ...common });
  if (stop !== 'end_turn' && stop !== 'stop_sequence') return failure(ctx, { code: 'malformed', reason: 'stop_reason', ...common });

  if (!Array.isArray(body.content)) return failure(ctx, { code: 'malformed', reason: 'no_content', ...common });
  let out = '';
  for (const block of body.content) {
    // Only text blocks carry the answer; thinking / other block types are ignored.
    if (isPlainObject(block) && block.type === 'text' && typeof block.text === 'string') out += block.text;
  }

  let json: unknown = null;
  if (wantJson) {
    json = tryParseJson(out);
    if (json === undefined) return failure(ctx, { code: 'malformed', reason: 'bad_json', ...common });
  }
  return {
    ok: true,
    provider: ctx.provider,
    model: ctx.model,
    text: out,
    json,
    usage: usage ?? { input_tokens: null, output_tokens: null },
    raw_usage: rawUsage,
    request_id: requestId,
    latency_ms: ctx.latency_ms,
  };
}

export function createAnthropicProvider(config: AnthropicConfig): CompletionProvider {
  const now = resolveNow(config.now);
  return {
    id: 'anthropic',
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const start = now();
      const ctx = (): FailureContext => ({ provider: 'anthropic', model: request.model, latency_ms: Math.max(0, now() - start) });
      const fetchImpl = resolveFetch(config.fetchImpl);
      if (fetchImpl === null) return failure(ctx(), { code: 'not_configured', reason: 'no_fetch', dispatched: false, retryable: false });
      const built = buildAnthropicRequest(request, config);
      if (!built.ok) return failure(ctx(), { code: 'not_configured', reason: built.reason, dispatched: false, retryable: false });

      const outcome = await postJson({
        fetchImpl,
        url: built.built.url,
        headers: built.built.headers,
        body: built.built.body,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
        requestIdHeaders: ['request-id'],
      });
      const c = ctx();
      const transport = transportFailure(c, outcome);
      if (transport) return transport;
      if (outcome.kind !== 'response') return failure(c, { code: 'malformed', reason: 'unreachable', dispatched: true, retryable: false });
      if (!outcome.ok) return httpFailure(c, outcome.status, outcome.requestId);
      return parseAnthropicResponse(c, outcome.text, outcome.requestId, request.jsonSchema !== undefined);
    },
  };
}
