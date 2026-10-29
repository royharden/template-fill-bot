// Provider adapter contract (PLAN section 5 "Providers / callledger"; shared contract section 3 `providers`).
//
// Runtime-neutral: adapters use ONLY an injected `fetch`-compatible function (default: the global `fetch`),
// `AbortController` and `setTimeout`, which exist in browsers, Node 18+ and Deno. No Node/Deno APIs, no env
// reads: API keys, base URLs and model ids are passed in by the trusted caller (the edge function reads its
// server env; local eval reads non-VITE_ env in Node). Adapters never log anything, and failure results never
// carry response bodies, so neither prompt nor intake text can leak through an error path.
//
// In the deployed product only `supabase/functions/extract-fields` calls these adapters; the browser bundle
// never imports this folder (tests/contract/boundaries.test.ts, M6b).

export const PROVIDER_IDS = ['anthropic', 'openai_compatible', 'typesafe', 'mock'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Minimal response surface the adapters read. A real `Response` satisfies it. */
export interface ResponseLike {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  /** Real fetch responses expose a stream; adapters bound bytes while reading it. */
  readonly body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

/** Minimal request init the adapters send. */
export interface FetchInit {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

/** Injected fetch (tests pass a stub; production passes nothing and gets the global fetch). */
export type FetchLike = (url: string, init: FetchInit) => Promise<ResponseLike>;

/** Wall clock for latency measurement (injected in tests for deterministic `latency_ms`). */
export type NowFn = () => number;

/** Shared adapter options. */
export interface AdapterOptions {
  readonly fetchImpl?: FetchLike;
  readonly now?: NowFn;
}

/** Token usage exactly as REPORTED by the provider; `null` when the provider did not report it. Never estimated. */
export interface ProviderUsage {
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
}

export const PROVIDER_ERROR_CODES = ['timeout', 'http_error', 'malformed', 'not_configured'] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

/**
 * A failed call. `dispatched` says whether bytes may have reached the provider: `false` only when the adapter
 * refused before calling fetch (not_configured, invalid request). The ledger/quota layer keeps the full
 * reservation for any dispatched failure whose cost is unknown (PLAN section 5: unknown outcome keeps the
 * full reservation). `usage`/`raw_usage` are present when a response arrived and reported usage (e.g. a
 * truncated or refused completion is still billed).
 */
export interface ProviderFailure {
  readonly ok: false;
  readonly provider: ProviderId;
  readonly model: string;
  readonly code: ProviderErrorCode;
  /** HTTP status for `http_error` (and for `malformed` when a 2xx body could not be used). */
  readonly status?: number;
  readonly retryable: boolean;
  readonly dispatched: boolean;
  /** Short fixed reason token (never provider text), e.g. 'max_tokens', 'refusal', 'bad_json', 'missing_key'. */
  readonly reason: string;
  readonly usage: ProviderUsage | null;
  readonly raw_usage: unknown;
  readonly request_id: string | null;
  readonly latency_ms: number;
}

// ---------------------------------------------------------------------------------------------------------
// Completion providers (anthropic, openai_compatible, mock)
// ---------------------------------------------------------------------------------------------------------

export interface ChatMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/** A JSON Schema object (closed: every object needs additionalProperties:false for strict structured output). */
export type JsonSchema = Readonly<Record<string, unknown>>;

export interface StructuredOutputSpec {
  /** `^[A-Za-z0-9_-]{1,64}$` (OpenAI's json_schema name rule; also used as a ledger-safe label). */
  readonly name: string;
  readonly schema: JsonSchema;
}

export interface CompletionRequest {
  readonly model: string;
  readonly system: string;
  readonly messages: readonly ChatMessage[];
  /** When present, the provider is asked for JSON matching this schema and the result carries parsed `json`. */
  readonly jsonSchema?: StructuredOutputSpec;
  readonly maxTokens: number;
  readonly timeoutMs: number;
  /** Optional caller cancellation (e.g. the client disconnected). Reported as code 'timeout', reason 'aborted'. */
  readonly signal?: AbortSignal;
}

export interface CompletionSuccess {
  readonly ok: true;
  readonly provider: ProviderId;
  readonly model: string;
  /** Concatenated text output (for structured output: the raw JSON text). */
  readonly text: string;
  /** Parsed JSON when `jsonSchema` was requested; otherwise null. Still UNTRUSTED: callers validate with zod. */
  readonly json: unknown;
  readonly usage: ProviderUsage;
  readonly raw_usage: unknown;
  readonly request_id: string | null;
  readonly latency_ms: number;
}

export type CompletionResult = CompletionSuccess | ProviderFailure;

export interface CompletionProvider {
  readonly id: ProviderId;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

// ---------------------------------------------------------------------------------------------------------
// Choice providers (typesafe Jev; mock)
// ---------------------------------------------------------------------------------------------------------

/** One Jev Choice question. Options are opaque ids built by code (candidate ids + 'none'), never intake text. */
export interface ChoiceQuestion {
  /** `^[A-Za-z0-9_]{1,64}$`; unique within a request. */
  readonly key: string;
  /** Fixed, code-authored question text (from field templates). */
  readonly question: string;
  /** Fixed, code-authored criteria text (optional). */
  readonly criteria?: string;
  /** 2..255 unique opaque option ids. */
  readonly options: readonly string[];
}

export interface ChoiceRequest {
  readonly model: string;
  /** The data the model reads (intake text and candidate descriptions). Data only, never instructions. */
  readonly state: string | Readonly<Record<string, unknown>>;
  readonly questions: readonly ChoiceQuestion[];
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface ChoiceAnswer {
  readonly key: string;
  /** Always one of the question's options (validated by the adapter). */
  readonly choice: string;
  /** Probability per option id (options the provider omitted are absent). */
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number | null;
}

export interface ChoiceSuccess {
  readonly ok: true;
  readonly provider: ProviderId;
  readonly model: string;
  readonly answers: Readonly<Record<string, ChoiceAnswer>>;
  readonly usage: ProviderUsage;
  readonly raw_usage: unknown;
  readonly request_id: string | null;
  readonly latency_ms: number;
}

export type ChoiceResult = ChoiceSuccess | ProviderFailure;

export interface ChoiceProvider {
  readonly id: ProviderId;
  choose(request: ChoiceRequest): Promise<ChoiceResult>;
}
