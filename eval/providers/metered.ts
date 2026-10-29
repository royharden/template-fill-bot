import { randomUUID } from 'node:crypto';
import { PRICE_TABLE } from '../../supabase/functions/_shared/callledger/priceTable.2026-10-24.ts';
import { priceFor, usageCost } from '../../supabase/functions/_shared/callledger/ledger.ts';
import type { PriceTable } from '../../supabase/functions/_shared/callledger/types.ts';
import { buildAnthropicRequest, createAnthropicProvider } from '../../supabase/functions/_shared/providers/anthropic.ts';
import { buildOpenAiCompatibleRequest, createOpenAiCompatibleProvider } from '../../supabase/functions/_shared/providers/openaiCompatible.ts';
import { buildTypesafeRequest, createTypesafeProvider } from '../../supabase/functions/_shared/providers/typesafe.ts';
import type { ChoiceProvider, ChoiceRequest, ChoiceResult, CompletionProvider, CompletionRequest, CompletionResult, ProviderId } from '../../supabase/functions/_shared/providers/types.ts';
import { DurableBudget, requestBound } from '../budget.ts';
import { ResponseCache, cacheKey } from '../cache.ts';
import type { CacheIdentity } from '../cache.ts';

export interface Observation {
  paid_usd: number | null; reserved_usd: number | null; settled_usd: number | null; retained_usd: number | null; outstanding_attempts: number | null;
  replay_original_usd: number | null; latency_ms: number | null; replay: boolean; error: string | null;
  dispatched_attempts: number; undispatched_attempts: number; latency_observed_attempts: number; latency_missing_attempts: number;
}
export const newObservation = (): Observation => ({ paid_usd: 0, reserved_usd: 0, settled_usd: 0, retained_usd: 0, outstanding_attempts: 0,
  replay_original_usd: 0, latency_ms: null, replay: false, error: null, dispatched_attempts: 0, undispatched_attempts: 0, latency_observed_attempts: 0, latency_missing_attempts: 0 });
export interface MeterOptions {
  readonly budget: DurableBudget; readonly cache: ResponseCache; readonly identity: Omit<CacheIdentity, 'provider' | 'model' | 'prompt' | 'schema' | 'option_order'>;
  readonly prices?: PriceTable; readonly retries: 0 | 1; readonly observation: Observation;
  readonly now?: () => number;
}
export class Meter {
  readonly options: MeterOptions;
  private readonly reservationIds: string[] = [];
  constructor(options: MeterOptions) { this.options = options; }
  private observeLatency(value: unknown): void {
    const o = this.options.observation;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) { o.latency_ms = (o.latency_ms ?? 0) + value; o.latency_observed_attempts++; }
    else o.latency_missing_attempts++;
  }
  private async observeBudget(): Promise<void> {
    if (!this.reservationIds.length) return;
    const o = this.options.observation;
    try {
      const snapshot = await this.options.budget.snapshot(), attempts = snapshot.attempts.filter((attempt) => this.reservationIds.includes(attempt.id));
      // A valid complete journal can prove a tracked reservation was refused before append. A rejected
      // reserve alone cannot: journal close, lock close or lock unlink can fail AFTER the append commits.
      o.reserved_usd = attempts.reduce((n, attempt) => n + attempt.reserved_usd, 0);
      o.settled_usd = attempts.reduce((n, attempt) => n + (attempt.settled_usd ?? 0), 0);
      const outstanding = attempts.filter((attempt) => attempt.state === 'reserved' || attempt.state === 'unknown');
      o.retained_usd = outstanding.reduce((n, attempt) => n + attempt.reserved_usd, 0); o.outstanding_attempts = outstanding.length;
    } catch {
      // A settlement may have reached the journal even if later I/O failed. Never guess its durable state.
      o.reserved_usd = null; o.settled_usd = null; o.retained_usd = null; o.outstanding_attempts = null;
    }
  }
  async call<T extends CompletionResult | ChoiceResult>(request: CompletionRequest | ChoiceRequest, provider: ProviderId, body: () => string, dispatch: () => Promise<T>, maxOutput: number): Promise<T> {
    const o = this.options.observation, prices = this.options.prices ?? PRICE_TABLE;
    const completion = 'system' in request;
    const key = cacheKey({ ...this.options.identity, provider, model: request.model,
      prompt: completion ? { system: request.system, messages: request.messages } : request.state,
      schema: completion ? request.jsonSchema ?? null : request.questions.map((q) => ({ key: q.key, question: q.question, criteria: q.criteria ?? null })),
      option_order: completion ? [] : request.questions.map((q) => q.options) });
    try {
      const cached = await this.options.cache.read<T>(key);
      if (cached) { o.replay = true; o.replay_original_usd = o.replay_original_usd === null || cached.original_paid_usd === null ? null : o.replay_original_usd + cached.original_paid_usd; return cached.result; }
      const serialized = body(); // Builds exact provider body; may refuse missing config before any reservation.
      const price = priceFor(provider, request.model, prices);
      if (!completion && price.output_usd_per_million !== 0) throw new Error('choice_output_price_not_input_only');
      const bound = requestBound(serialized, maxOutput, provider, request.model, prices);
      let retryOf: string | null = null;
      for (let attempt = 0; attempt <= this.options.retries; attempt++) {
        // Keep identity BEFORE awaiting any reservation I/O. Rejected finalization can override a
        // successful append's return; dispatch stays refused and finally reconciles this exact attempt.
        const id = randomUUID(); this.reservationIds.push(id); o.reserved_usd = null;
        await this.options.budget.reserve(key, bound, retryOf, id);
        let result: T;
        const now = this.options.now ?? (() => performance.now()), started = now();
        try { result = await dispatch(); } catch {
          o.dispatched_attempts++; this.observeLatency(now() - started); o.paid_usd = null;
          // Observations precede fallible settlement, including the thrown-transport path.
          await this.options.budget.settle(id, null, true); throw new Error('provider_unknown_after_dispatch');
        }
        const dispatched = result.ok || result.dispatched;
        if (dispatched) { o.dispatched_attempts++; this.observeLatency(result.latency_ms); } else o.undispatched_attempts++;
        const priorPaid = o.paid_usd; if (dispatched) o.paid_usd = null; // Cost calculation/settlement may throw after a paid dispatch.
        const actual = !dispatched ? 0 : result.usage ? usageCost(provider, request.model, result.usage, prices) : null;
        o.paid_usd = priorPaid === null || actual === null ? null : priorPaid + actual;
        await this.options.budget.settle(id, actual, dispatched);
        if (result.ok) { await this.options.cache.write(key, result, o.paid_usd, o.latency_missing_attempts ? null : o.latency_ms); return result; }
        if (!result.retryable || attempt === this.options.retries) { o.error = `provider_${result.code}`; return result; }
        retryOf = id; // Never reuses a reservation. At most one additional attempt.
      }
      throw new Error('retry_unreachable');
    } catch (error) {
      o.error = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'evaluation_provider_failure'; throw new Error(o.error);
    } finally { await this.observeBudget(); }
  }
}
export function meteredCompletion(provider: 'anthropic' | 'openai_compatible', config: { apiKey?: string; baseUrl?: string }, options: MeterOptions): CompletionProvider {
  const adapter = provider === 'anthropic' ? createAnthropicProvider({ apiKey: config.apiKey }) : createOpenAiCompatibleProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl });
  const meter = new Meter(options);
  return { id: provider, complete(request) {
    return meter.call(request, provider, () => {
      const built = provider === 'anthropic' ? buildAnthropicRequest(request, { apiKey: config.apiKey }) : buildOpenAiCompatibleRequest(request, { apiKey: config.apiKey, baseUrl: config.baseUrl });
      if (!built.ok) throw new Error('provider_not_configured'); return built.built.body;
    }, () => adapter.complete(request), request.maxTokens);
  } };
}
export function meteredChoice(config: { apiKey?: string; url?: string }, options: MeterOptions): ChoiceProvider {
  const providerConfig = { apiKey: config.apiKey, url: config.url };
  const adapter = createTypesafeProvider(providerConfig), meter = new Meter(options);
  return { id: 'typesafe', choose(request) { return meter.call(request, 'typesafe', () => {
    const built = buildTypesafeRequest(request, providerConfig); if (!built.ok) throw new Error('provider_not_configured'); return built.built.body;
  }, () => adapter.choose(request), 0); } };
}
