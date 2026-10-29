// Shared HTTP plumbing for the provider adapters: one bounded POST with a timeout, caller cancellation, a
// response-size cap, and a small set of validation helpers. Runtime-neutral (fetch, AbortController,
// setTimeout only). Never logs, never returns provider error bodies to callers.
import type { FetchLike, NowFn, ProviderFailure, ProviderId, ProviderUsage } from './types.ts';

/** Largest response body (UTF-16 code units of the decoded text) an adapter will parse. */
export const MAX_RESPONSE_CHARS = 1_048_576;
/** Request bounds accepted by every adapter (the edge function uses far smaller values). */
export const MAX_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT_TOKENS = 32_000;

export type PostOutcome =
  | { readonly kind: 'response'; readonly status: number; readonly ok: boolean; readonly text: string; readonly requestId: string | null }
  | { readonly kind: 'too_large'; readonly status: number; readonly requestId: string | null }
  | { readonly kind: 'timeout'; readonly reason: 'timeout' | 'aborted' }
  | { readonly kind: 'aborted_before_dispatch' }
  | { readonly kind: 'network' };

export interface PostOptions {
  readonly fetchImpl: FetchLike;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Response headers that may carry the provider's request id, checked in order. */
  readonly requestIdHeaders: readonly string[];
}

/** The injected fetch, or the global one when present; null when neither exists. */
export function resolveFetch(fetchImpl: FetchLike | undefined): FetchLike | null {
  if (fetchImpl) return fetchImpl;
  if (typeof globalThis.fetch === 'function') {
    return (url, init) => globalThis.fetch(url, init);
  }
  return null;
}

export function resolveNow(now: NowFn | undefined): NowFn {
  return now ?? (() => Date.now());
}

/** Same request id format check for every provider: short, printable, no spaces. */
const REQUEST_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export function safeRequestId(value: unknown): string | null {
  return typeof value === 'string' && REQUEST_ID_RE.test(value) ? value : null;
}

function headerRequestId(headers: { get(name: string): string | null }, names: readonly string[]): string | null {
  for (const name of names) {
    const id = safeRequestId(headers.get(name));
    if (id) return id;
  }
  return null;
}

/**
 * POST once. The timeout covers both the fetch and reading the body. A caller signal that is already aborted
 * returns `aborted_before_dispatch` without calling fetch.
 */
export async function postJson(options: PostOptions): Promise<PostOutcome> {
  if (options.signal?.aborted) return { kind: 'aborted_before_dispatch' };
  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(new Error('aborted')); });
  const onCallerAbort = (): void => {
    callerAborted = true;
    controller.abort();
    rejectAbort();
  };
  options.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectAbort();
  }, options.timeoutMs);
  try {
    const response = await Promise.race([options.fetchImpl(options.url, {
      method: 'POST',
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    }), aborted]);
    const requestId = headerRequestId(response.headers, options.requestIdHeaders);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_CHARS * 4) {
      controller.abort();
      return { kind: 'too_large', status: response.status, requestId };
    }
    let text = '';
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await Promise.race([reader.read(), aborted]);
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_RESPONSE_CHARS * 4) { controller.abort(); return { kind: 'too_large', status: response.status, requestId }; }
          text += decoder.decode(chunk.value, { stream: true });
          if (text.length > MAX_RESPONSE_CHARS) { controller.abort(); return { kind: 'too_large', status: response.status, requestId }; }
        }
        text += decoder.decode();
      } finally { reader.releaseLock(); }
    } else {
      // Minimal injected test transports may expose text() only. Real HTTP fetch is streamed above.
      text = await Promise.race([response.text(), aborted]);
    }
    if (text.length > MAX_RESPONSE_CHARS) { controller.abort(); return { kind: 'too_large', status: response.status, requestId }; }
    return { kind: 'response', status: response.status, ok: response.ok, text, requestId };
  } catch {
    if (timedOut) return { kind: 'timeout', reason: 'timeout' };
    if (callerAborted || controller.signal.aborted) return { kind: 'timeout', reason: 'aborted' };
    return { kind: 'network' };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onCallerAbort);
  }
}

/** HTTP statuses worth one bounded retry (each retry needs a new reservation; PLAN section 5). */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status === 529 || (status >= 500 && status <= 599);
}

/** A reported token count, or null when absent/invalid. Never estimated. */
export function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON.parse that returns `undefined` instead of throwing. */
export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export interface FailureContext {
  readonly provider: ProviderId;
  readonly model: string;
  readonly latency_ms: number;
}

export function failure(
  ctx: FailureContext,
  fields: {
    code: ProviderFailure['code'];
    reason: string;
    dispatched: boolean;
    retryable: boolean;
    status?: number;
    usage?: ProviderUsage | null;
    raw_usage?: unknown;
    request_id?: string | null;
  },
): ProviderFailure {
  const base = {
    ok: false as const,
    provider: ctx.provider,
    model: ctx.model,
    code: fields.code,
    retryable: fields.retryable,
    dispatched: fields.dispatched,
    reason: fields.reason,
    usage: fields.usage ?? null,
    raw_usage: fields.raw_usage ?? null,
    request_id: fields.request_id ?? null,
    latency_ms: ctx.latency_ms,
  };
  return fields.status === undefined ? base : { ...base, status: fields.status };
}

/** Converts a non-response PostOutcome into a failure; returns null for a 'response' outcome. */
export function transportFailure(ctx: FailureContext, outcome: PostOutcome): ProviderFailure | null {
  switch (outcome.kind) {
    case 'response':
      return null;
    case 'aborted_before_dispatch':
      return failure(ctx, { code: 'timeout', reason: 'aborted', dispatched: false, retryable: false });
    case 'timeout':
      // Dispatched: the provider may have processed (and billed) the request.
      return failure(ctx, { code: 'timeout', reason: outcome.reason, dispatched: true, retryable: outcome.reason === 'timeout' });
    case 'network':
      // Unknown whether the request reached the provider; treated as dispatched (conservative for quota).
      return failure(ctx, { code: 'http_error', reason: 'network', dispatched: true, retryable: true });
    case 'too_large':
      return failure(ctx, {
        code: 'malformed',
        reason: 'response_too_large',
        dispatched: true,
        retryable: false,
        status: outcome.status,
        request_id: outcome.requestId,
      });
  }
}

/** Non-2xx response → http_error (body is discarded; it may echo the prompt). */
export function httpFailure(ctx: FailureContext, status: number, requestId: string | null): ProviderFailure {
  return failure(ctx, {
    code: 'http_error',
    reason: `http_${status}`,
    dispatched: true,
    retryable: isRetryableStatus(status),
    status,
    request_id: requestId,
  });
}

/** Validates the numeric bounds common to every adapter; returns a reason token or null. */
export function checkBounds(timeoutMs: number, maxTokens?: number): string | null {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) return 'bad_timeout';
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_OUTPUT_TOKENS)) {
    return 'bad_max_tokens';
  }
  return null;
}

/** A model id the adapters accept (from server config, never from a user). */
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** Structured-output schema name (OpenAI json_schema name rule; also a ledger-safe label). */
export const SCHEMA_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface BuiltRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** Validates an https base URL with no credentials, query or fragment; returns it without trailing slashes. */
export function checkHttpsBaseUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return null;
  }
  return value.replace(/\/+$/, '');
}
