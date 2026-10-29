// OpenAI-compatible Chat Completions adapter (raw fetch).
//
// Request shape (UNVERIFIED in Dirty Mode; re-check at DV-PROVIDERS for the configured endpoint):
//   POST {OPENAI_COMPATIBLE_BASE_URL}/chat/completions      (base URL from SERVER config only; users never supply URLs)
//   headers: authorization: Bearer <OPENAI_COMPATIBLE_API_KEY>, content-type: application/json
//   body: { model, messages:[{role:'system', content}, ...], max_tokens | max_completion_tokens,
//           response_format?: { type:'json_schema', json_schema:{ name, strict:true, schema } } }
//
// Structured-output choice: `response_format` json_schema with strict:true. Some compatible servers only accept
// `max_completion_tokens` (newer OpenAI models) or only `max_tokens` (most compatible servers): the parameter
// name is a server config choice (`maxTokensParam`), default `max_tokens`.
// Truncation (finish_reason 'length'), refusals and content filtering are failures, never partial results.
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

export const OPENAI_MAX_TOKENS_PARAMS = ['max_tokens', 'max_completion_tokens'] as const;
export type OpenAiMaxTokensParam = (typeof OPENAI_MAX_TOKENS_PARAMS)[number];

export interface OpenAiCompatibleConfig extends AdapterOptions {
  /** Server secret OPENAI_COMPATIBLE_API_KEY. Missing/empty → not_configured. */
  readonly apiKey: string | null | undefined;
  /** Server config OPENAI_COMPATIBLE_BASE_URL, e.g. https://api.example.com/v1 (https only). Missing → not_configured. */
  readonly baseUrl: string | null | undefined;
  readonly maxTokensParam?: OpenAiMaxTokensParam;
}

/** Pure request builder (exported for contract tests). */
export function buildOpenAiCompatibleRequest(
  request: CompletionRequest,
  config: OpenAiCompatibleConfig,
): { ok: true; built: BuiltRequest } | { ok: false; reason: string } {
  if (typeof config.apiKey !== 'string' || config.apiKey.trim() === '') return { ok: false, reason: 'missing_key' };
  if (typeof config.baseUrl !== 'string' || config.baseUrl.trim() === '') return { ok: false, reason: 'missing_base_url' };
  const base = checkHttpsBaseUrl(config.baseUrl);
  if (base === null) return { ok: false, reason: 'bad_base_url' };
  if (!MODEL_ID_RE.test(request.model)) return { ok: false, reason: 'bad_model' };
  const bounds = checkBounds(request.timeoutMs, request.maxTokens);
  if (bounds) return { ok: false, reason: bounds };
  if (request.messages.length === 0) return { ok: false, reason: 'bad_messages' };
  if (request.jsonSchema && !SCHEMA_NAME_RE.test(request.jsonSchema.name)) return { ok: false, reason: 'bad_schema_name' };
  const param = config.maxTokensParam ?? 'max_tokens';
  if (!OPENAI_MAX_TOKENS_PARAMS.includes(param)) return { ok: false, reason: 'bad_max_tokens_param' };

  const body: Record<string, unknown> = {
    model: request.model,
    messages: [
      { role: 'system', content: request.system },
      ...request.messages.map((m) => ({ role: m.role, content: m.content })),
    ],
    [param]: request.maxTokens,
  };
  if (request.jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: request.jsonSchema.name, strict: true, schema: request.jsonSchema.schema },
    };
  }
  return {
    ok: true,
    built: {
      url: `${base}/chat/completions`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
    },
  };
}

function usageOf(raw: unknown): ProviderUsage | null {
  if (!isPlainObject(raw)) return null;
  return { input_tokens: tokenCount(raw.prompt_tokens), output_tokens: tokenCount(raw.completion_tokens) };
}

/** Pure response parser (exported for contract tests with recorded fixtures). */
export function parseOpenAiCompatibleResponse(
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

  const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
  if (!isPlainObject(choice) || !isPlainObject(choice.message)) return failure(ctx, { code: 'malformed', reason: 'no_choice', ...common });
  if (choice.finish_reason === 'length') return failure(ctx, { code: 'malformed', reason: 'max_tokens', ...common });
  if (choice.finish_reason === 'content_filter') return failure(ctx, { code: 'malformed', reason: 'content_filter', ...common });
  if (choice.finish_reason !== 'stop') return failure(ctx, { code: 'malformed', reason: 'finish_reason', ...common });
  const message = choice.message;
  if (typeof message.refusal === 'string' && message.refusal !== '') return failure(ctx, { code: 'malformed', reason: 'refusal', ...common });
  if (typeof message.content !== 'string') return failure(ctx, { code: 'malformed', reason: 'no_content', ...common });

  let json: unknown = null;
  if (wantJson) {
    json = tryParseJson(message.content);
    if (json === undefined) return failure(ctx, { code: 'malformed', reason: 'bad_json', ...common });
  }
  return {
    ok: true,
    provider: ctx.provider,
    model: ctx.model,
    text: message.content,
    json,
    usage: usage ?? { input_tokens: null, output_tokens: null },
    raw_usage: rawUsage,
    request_id: requestId,
    latency_ms: ctx.latency_ms,
  };
}

export function createOpenAiCompatibleProvider(config: OpenAiCompatibleConfig): CompletionProvider {
  const now = resolveNow(config.now);
  return {
    id: 'openai_compatible',
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const start = now();
      const ctx = (): FailureContext => ({ provider: 'openai_compatible', model: request.model, latency_ms: Math.max(0, now() - start) });
      const fetchImpl = resolveFetch(config.fetchImpl);
      if (fetchImpl === null) return failure(ctx(), { code: 'not_configured', reason: 'no_fetch', dispatched: false, retryable: false });
      const built = buildOpenAiCompatibleRequest(request, config);
      if (!built.ok) return failure(ctx(), { code: 'not_configured', reason: built.reason, dispatched: false, retryable: false });

      const outcome = await postJson({
        fetchImpl,
        url: built.built.url,
        headers: built.built.headers,
        body: built.built.body,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
        requestIdHeaders: ['x-request-id', 'request-id'],
      });
      const c = ctx();
      const transport = transportFailure(c, outcome);
      if (transport) return transport;
      if (outcome.kind !== 'response') return failure(c, { code: 'malformed', reason: 'unreachable', dispatched: true, retryable: false });
      if (!outcome.ok) return httpFailure(c, outcome.status, outcome.requestId);
      return parseOpenAiCompatibleResponse(c, outcome.text, outcome.requestId, request.jsonSchema !== undefined);
    },
  };
}
