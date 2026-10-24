import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluate } from '../../eval/run.ts';
import type { RunOptions } from '../../eval/run.ts';
import type { GoldScenario } from '../../supabase/functions/_shared/evalkit/types.ts';
import { sumCounts, rates, clusterBootstrap } from '../../supabase/functions/_shared/evalkit/metrics.ts';

const scenario: GoldScenario = { version: 1, id: 'synthetic-unavailable', base_id: 'synthetic-unavailable', stratum: 'synthetic', origin: 'handtrap', author: 'Synthetic test', licence: 'MIT', messages: [{ text: 'Please prepare the synthetic agreement; no amount was supplied.' }],
  expected: { fields: { monthly_rent: { state: 'missing' } }, required_questions: ['monthly_rent'], optional_confirmation: true, clause_ids: null, unsupported_quotes: [], render_blocked: true }, tags: ['synthetic', 'injection'], security: 'docx_hidden' };
async function options(env: RunOptions['env']): Promise<RunOptions> {
  return { root: await mkdtemp(join(tmpdir(), 's30-availability-test-')), live: true, split: 'dev', env,
    prices: { date: 'SYNTHETIC-TEST-NOT-CURRENT-PRICES', entries: [{ provider: 'anthropic', model: 'synthetic', verified: true, input_usd_per_million: 1, output_usd_per_million: 2 }] },
    manifest: { version: 1, state: 'pending', seed: 7, generated_count: 0, handtrap_count: 0, entries: [], sources: {}, protocol_hash: null, frozen_at: null, digest: 'synthetic-test' },
    protocol: { version: 1, seed: 7, bootstrap_iterations: 100, methods: ['llm'], llm_provider: 'anthropic', llm_model: 'synthetic', jev_model: 'synthetic', max_output_tokens: 10, timeout_ms: 1, retries: 0, option_order_seed: 7, thresholds: { jev_default: false, wrong_fill_nonincrease_both_baselines: true }, note: 'Synthetic test only; all cases refuse before network dispatch.' } };
}
describe('unavailable predictions never masquerade as abstention/question quality', () => {
  for (const [name, env, reason] of [
    ['missing key', {}, 'provider_not_configured'],
    ['budget refusal', { ANTHROPIC_API_KEY: 'synthetic-never-dispatched', EVAL_MAX_ATTEMPT_USD: '0.000001' }, 'budget_attempt_cap'],
  ] as const) it(`${name}: excludes unavailable quality and retains observed independent conformance`, async () => {
    const rows = await evaluate([scenario], await options(env));
    expect(rows).toHaveLength(2); // All-field and matched eligible scopes describe the same refused call.
    for (const row of rows) {
      expect(row.status).toBe('incomplete'); expect(row.reason).toBe(reason);
      expect(row.eligibility).toEqual({ fields: false, questions: false, extraction: false, conformance: true, free_draft: false, security: true });
      expect(row.counts).toMatchObject({ labelled: 0, filled: 0, correct: 0, wrong: 0, abstained: 0, state_correct: 0,
        required_expected: 0, required_asked: 0, required_true_positive: 0, optional_expected: 0, optional_asked: 0, optional_correct: 0,
        clause_cases: 0, unsupported_expected: 0, injection_cases: 0, render_cases: 1, blocked_correct: 1, security_cases: 1, security_pass: 1 });
      expect(row.field_scores).toEqual({}); expect(row.failures).toContainEqual({ scenario_id: scenario.id, kind: 'incomplete', item: reason });
      expect(row).toMatchObject({ dispatched_attempts: 0, latency_ms: null, latency_observed_attempts: 0, latency_missing_attempts: 0, paid_usd: 0, reserved_usd: 0, retained_usd: 0 });
      expect(rates(sumCounts([row])).abstention).toBeNull(); expect(rates(sumCounts([row])).required_question_recall).toBeNull();
      expect(clusterBootstrap([row], (counts) => rates(counts).wrong_all_labelled, 7, 100)).toBeNull();
    }
  });
  it('marks a no-candidate Jev path unavailable even though its code-only pipeline returns a state', async () => {
    const configured = await options({}), rows = await evaluate([scenario], { ...configured, protocol: { ...configured.protocol, methods: ['jev'] } });
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ reason: 'model_not_dispatched_no_candidates', status: 'incomplete', dispatched_attempts: 0, eligibility: { fields: false, questions: false, extraction: false } });
    expect(rows[0].counts.labelled).toBe(0); expect(rows[0].counts.required_true_positive).toBe(0);
  });
});
