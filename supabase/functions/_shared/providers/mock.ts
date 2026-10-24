import { failure } from './http.ts';
import type { ChoiceProvider, ChoiceResult, CompletionProvider, CompletionResult } from './types.ts';

/** Explicit offline replay only. Live configuration never falls back to this adapter. */
export function createMockProvider(fixture: { readonly json: unknown; readonly text?: string }): CompletionProvider {
  return { id: 'mock', async complete(request): Promise<CompletionResult> {
    const json = JSON.parse(JSON.stringify(fixture.json)) as unknown;
    return { ok: true, provider: 'mock', model: request.model, text: fixture.text ?? JSON.stringify(json), json,
      usage: { input_tokens: null, output_tokens: null }, raw_usage: null, request_id: null, latency_ms: 0 };
  } };
}
export function createMockChoiceProvider(choices: Readonly<Record<string, string>>): ChoiceProvider {
  return { id: 'mock', async choose(request): Promise<ChoiceResult> {
    const answers: Record<string, { key: string; choice: string; probabilities: Record<string, number>; confidence: null }> = {};
    for (const q of request.questions) {
      const choice = choices[q.key];
      if (choice === undefined || !q.options.includes(choice)) return failure({ provider: 'mock', model: request.model, latency_ms: 0 }, {
        code: 'malformed', reason: 'bad_mock_choice', dispatched: false, retryable: false,
      });
      answers[q.key] = { key: q.key, choice, probabilities: {}, confidence: null };
    }
    return { ok: true, provider: 'mock', model: request.model, answers, usage: { input_tokens: null, output_tokens: null },
      raw_usage: null, request_id: null, latency_ms: 0 };
  } };
}
