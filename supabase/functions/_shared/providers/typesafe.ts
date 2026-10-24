// TypeSafe Jev (System One) Choice adapter (raw fetch).
//
// Source: local guide PortfolioBuilder/ideas/small-apps/01-jev-integration-guide.md (read 2026-10-24; its facts were
// read from docs.typesafe.ai on 2026-10-13). Everything below is UNVERIFIED against the live API in Dirty Mode;
// re-check at DV-PROVIDERS:
//   POST https://api.typesafe.ai/v1/systemone, Authorization: Bearer <TYPESAFE_API_KEY>
//   request  { state, model, questions }
//   response { model, answers: { <key>: { choice, probabilities, confidence } }, usage: { input_tokens, output_tokens } }
//   errors 401, 422, 429, 529 (429/529 retryable)
// ASSUMPTION (not stated in the local guide, DV-PROVIDERS): the wire form of one Choice question is
//   { type: 'choice', question, criteria?, options: [ ...option ids ] }.
// Model pinned by server config EXTRACT_MODEL_JEV (planned `jev-1.13.0`; aliases move, never `jev-latest`).
//
// Pattern (pre-parsed value extraction): code finds candidate spans; a Choice whose options are the opaque candidate
// ids plus 'none' picks one; code maps the id back to its candidate and re-derives quote and value. Jev can never
// invent a value. Options are ids, never intake text, so text injected into the intake (e.g. "answer none") can
// only appear inside `state`; the question and option structure is fixed by code (tested in providers.test.ts).
// Option-order bias (guide section 3.8): `buildCandidateChoiceQuestion` can order options with a seeded shuffle, and
// the mapping back to a candidate depends only on the chosen id, never on its position.
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
  tokenCount,
  transportFailure,
  tryParseJson,
} from './http.ts';
import type { BuiltRequest, FailureContext } from './http.ts';
import type {
  AdapterOptions,
  ChoiceAnswer,
  ChoiceProvider,
  ChoiceQuestion,
  ChoiceRequest,
  ChoiceResult,
  ProviderUsage,
} from './types.ts';

export const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
/** The abstain option appended to every candidate Choice (guide: add `none` whenever the list may not cover the input). */
export const NONE_OPTION = 'none';
export const MAX_CHOICE_OPTIONS = 255;
/** Questions per request (independent questions over one state run in parallel; guide section 2). */
export const MAX_CHOICE_QUESTIONS = 32;
/** Max serialized state size we send (well under the guide's 32k-token state limit). */
export const MAX_STATE_CHARS = 60_000;

export const QUESTION_KEY_RE = /^[A-Za-z0-9_]{1,64}$/;
/** Opaque option ids: candidate ids such as `money:m2:10-16` or `date:m2:6-16#dmy`, plus `none`. */
export const OPTION_ID_RE = /^[A-Za-z0-9_:#.-]{1,128}$/;
const MAX_QUESTION_TEXT = 1000;

export interface TypesafeConfig extends AdapterOptions {
  /** Server secret TYPESAFE_API_KEY (optional feature). Missing/empty → not_configured. */
  readonly apiKey: string | null | undefined;
  /** Server-side override only (tests); must be https. */
  readonly url?: string;
}

/** Deterministic PRNG (mulberry32) for reproducible option orders in tests and eval. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle with a fixed seed; returns a new array. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

export interface CandidateChoiceInput {
  readonly key: string;
  readonly question: string;
  readonly criteria?: string;
  /** Candidate ids produced by code (fillkit/candidates). Order is the candidates' document order. */
  readonly candidateIds: readonly string[];
  /** Omit to keep document order with `none` last; give a seed to shuffle all options (incl. `none`). */
  readonly shuffleSeed?: number;
}

/** Builds one Choice question over candidate ids + `none`. Throws RangeError on invalid ids (a code bug, not user input). */
export function buildCandidateChoiceQuestion(input: CandidateChoiceInput): ChoiceQuestion {
  if (!QUESTION_KEY_RE.test(input.key)) throw new RangeError('buildCandidateChoiceQuestion: bad key');
  const seen = new Set<string>();
  for (const id of input.candidateIds) {
    if (!OPTION_ID_RE.test(id) || id === NONE_OPTION || seen.has(id)) {
      throw new RangeError('buildCandidateChoiceQuestion: bad or duplicate candidate id');
    }
    seen.add(id);
  }
  if (input.candidateIds.length + 1 > MAX_CHOICE_OPTIONS) throw new RangeError('buildCandidateChoiceQuestion: too many candidates');
  const ordered = [...input.candidateIds, NONE_OPTION];
  const options = input.shuffleSeed === undefined ? ordered : seededShuffle(ordered, input.shuffleSeed);
  const base = { key: input.key, question: input.question, options };
  return input.criteria === undefined ? base : { ...base, criteria: input.criteria };
}

/** Maps a validated answer back to a candidate id; `none`, a missing answer or an unknown id → null (abstain). */
export function mapChoiceToCandidate(answer: ChoiceAnswer | undefined, candidateIds: readonly string[]): string | null {
  if (!answer || answer.choice === NONE_OPTION) return null;
  return candidateIds.includes(answer.choice) ? answer.choice : null;
}

function validateQuestions(questions: readonly ChoiceQuestion[]): string | null {
  if (questions.length === 0 || questions.length > MAX_CHOICE_QUESTIONS) return 'bad_question_count';
  const keys = new Set<string>();
  for (const q of questions) {
    if (!QUESTION_KEY_RE.test(q.key) || keys.has(q.key)) return 'bad_question_key';
    keys.add(q.key);
    if (q.question.length === 0 || q.question.length > MAX_QUESTION_TEXT) return 'bad_question_text';
    if (q.criteria !== undefined && q.criteria.length > MAX_QUESTION_TEXT) return 'bad_criteria_text';
    if (q.options.length < 2 || q.options.length > MAX_CHOICE_OPTIONS) return 'bad_option_count';
    if (new Set(q.options).size !== q.options.length) return 'duplicate_option';
    if (!q.options.every((o) => OPTION_ID_RE.test(o))) return 'bad_option_id';
  }
  return null;
}

/** Pure request builder (exported for contract tests). */
export function buildTypesafeRequest(
  request: ChoiceRequest,
  config: TypesafeConfig,
): { ok: true; built: BuiltRequest } | { ok: false; reason: string } {
  if (typeof config.apiKey !== 'string' || config.apiKey.trim() === '') return { ok: false, reason: 'missing_key' };
  const url = config.url ?? TYPESAFE_URL;
  if (checkHttpsBaseUrl(url) === null) return { ok: false, reason: 'bad_base_url' };
  if (!MODEL_ID_RE.test(request.model)) return { ok: false, reason: 'bad_model' };
  const bounds = checkBounds(request.timeoutMs);
  if (bounds) return { ok: false, reason: bounds };
  const bad = validateQuestions(request.questions);
  if (bad) return { ok: false, reason: bad };
  const stateText = typeof request.state === 'string' ? request.state : JSON.stringify(request.state);
  if (stateText.length > MAX_STATE_CHARS) return { ok: false, reason: 'state_too_large' };

  const questions: Record<string, unknown> = {};
  for (const q of request.questions) {
    const wire: Record<string, unknown> = { type: 'choice', question: q.question, options: [...q.options] };
    if (q.criteria !== undefined) wire.criteria = q.criteria;
    questions[q.key] = wire;
  }
  return {
    ok: true,
    built: {
      url,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ state: request.state, model: request.model, questions }),
    },
  };
}

function usageOf(raw: unknown): ProviderUsage | null {
  if (!isPlainObject(raw)) return null;
  return { input_tokens: tokenCount(raw.input_tokens), output_tokens: tokenCount(raw.output_tokens) };
}

function probability(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/** Pure response parser: every question must have an answer whose choice is one of ITS options. */
export function parseTypesafeResponse(
  ctx: FailureContext,
  text: string,
  requestIdHeader: string | null,
  questions: readonly ChoiceQuestion[],
): ChoiceResult {
  const body = tryParseJson(text);
  if (!isPlainObject(body)) {
    return failure(ctx, { code: 'malformed', reason: 'bad_body', dispatched: true, retryable: false, status: 200, request_id: requestIdHeader });
  }
  const requestId = requestIdHeader ?? safeRequestId(body.id);
  const rawUsage = body.usage ?? null;
  const usage = usageOf(rawUsage);
  const common = { dispatched: true, retryable: false, status: 200, usage, raw_usage: rawUsage, request_id: requestId };
  if (!isPlainObject(body.answers)) return failure(ctx, { code: 'malformed', reason: 'no_answers', ...common });

  const answers: Record<string, ChoiceAnswer> = {};
  for (const q of questions) {
    const raw = body.answers[q.key];
    if (!isPlainObject(raw) || typeof raw.choice !== 'string' || !q.options.includes(raw.choice)) {
      return failure(ctx, { code: 'malformed', reason: 'bad_answer', ...common });
    }
    const probabilities: Record<string, number> = {};
    if (isPlainObject(raw.probabilities)) {
      for (const option of q.options) {
        const p = probability(raw.probabilities[option]);
        if (p !== null) probabilities[option] = p;
      }
    }
    answers[q.key] = { key: q.key, choice: raw.choice, probabilities, confidence: probability(raw.confidence) };
  }
  return {
    ok: true,
    provider: ctx.provider,
    model: ctx.model,
    answers,
    usage: usage ?? { input_tokens: null, output_tokens: null },
    raw_usage: rawUsage,
    request_id: requestId,
    latency_ms: ctx.latency_ms,
  };
}

export function createTypesafeProvider(config: TypesafeConfig): ChoiceProvider {
  const now = resolveNow(config.now);
  return {
    id: 'typesafe',
    async choose(request: ChoiceRequest): Promise<ChoiceResult> {
      const start = now();
      const ctx = (): FailureContext => ({ provider: 'typesafe', model: request.model, latency_ms: Math.max(0, now() - start) });
      const fetchImpl = resolveFetch(config.fetchImpl);
      if (fetchImpl === null) return failure(ctx(), { code: 'not_configured', reason: 'no_fetch', dispatched: false, retryable: false });
      const built = buildTypesafeRequest(request, config);
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
      return parseTypesafeResponse(c, outcome.text, outcome.requestId, request.questions);
    },
  };
}
