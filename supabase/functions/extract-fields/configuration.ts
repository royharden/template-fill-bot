import { createAnthropicProvider, buildAnthropicRequest } from '../_shared/providers/anthropic.ts';
import { createOpenAiCompatibleProvider, buildOpenAiCompatibleRequest } from '../_shared/providers/openaiCompatible.ts';
import { createTypesafeProvider, buildTypesafeRequest } from '../_shared/providers/typesafe.ts';
import type { QuotaCaps } from '../_shared/callledger/types.ts';
import { EdgeError } from './handler.ts';
import type { JevSelection, LlmSelection } from './handler.ts';

export type ServerEnv = (name: string) => string | undefined;
function positive(env: ServerEnv, name: string, fallback: number, max: number, integer = false): number {
  const raw = env(name); const n = raw === undefined || raw.trim() === '' ? fallback : Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > max || (integer && !Number.isInteger(n))) throw new EdgeError(503, 'invalid_server_configuration');
  return n;
}
export function serverCaps(env: ServerEnv): QuotaCaps {
  return { rate_per_min_user: positive(env, 'RATE_PER_MIN_USER', 5, 10000, true), max_attempt_usd: positive(env, 'MAX_ATTEMPT_USD', .10, 1000000),
    daily_user_usd: positive(env, 'DAILY_USER_USD', .50, 1000000), daily_install_usd: positive(env, 'DAILY_INSTALL_USD', 2, 1000000) };
}
export function selectServerProvider(method: 'llm' | 'jev', env: ServerEnv): LlmSelection | JevSelection | null {
  const timeoutMs = positive(env, 'PROVIDER_TIMEOUT_MS', 20000, 120000, true);
  // Model IDs are explicit server configuration, never caller input or moving model aliases.
  if (method === 'jev') {
    const model = env('EXTRACT_MODEL_JEV')?.trim(); const config = { apiKey: env('TYPESAFE_API_KEY') };
    if (!model || !config.apiKey?.trim()) return null;
    return { method, model, timeoutMs, provider: createTypesafeProvider(config), body(request) {
      const result = buildTypesafeRequest(request, config); if (!result.ok) throw new EdgeError(503, 'provider_not_configured'); return result.built.body;
    } };
  }
  const model = env('EXTRACT_MODEL_LLM')?.trim(); if (!model) return null;
  const providerId = env('EXTRACT_PROVIDER_LLM')?.trim() || 'anthropic';
  if (providerId === 'anthropic') {
    const config = { apiKey: env('ANTHROPIC_API_KEY') }; if (!config.apiKey?.trim()) return null;
    return { method, model, timeoutMs, maxTokens: 4096, provider: createAnthropicProvider(config), body(request) {
      const result = buildAnthropicRequest(request, config); if (!result.ok) throw new EdgeError(503, 'provider_not_configured'); return result.built.body;
    } };
  }
  if (providerId === 'openai_compatible') {
    const config = { apiKey: env('OPENAI_COMPATIBLE_API_KEY'), baseUrl: env('OPENAI_COMPATIBLE_BASE_URL') };
    if (!config.apiKey?.trim() || !config.baseUrl?.trim()) return null;
    return { method, model, timeoutMs, maxTokens: 4096, provider: createOpenAiCompatibleProvider(config), body(request) {
      const result = buildOpenAiCompatibleRequest(request, config); if (!result.ok) throw new EdgeError(503, 'provider_not_configured'); return result.built.body;
    } };
  }
  return null;
}
