import { describe, expect, it } from 'vitest';
import { fieldCounts, rates, questionCounts, clusterBootstrap, jevPromotion, sumCounts } from '../../supabase/functions/_shared/evalkit/metrics.ts';
import { FIELD_KEYS } from '../../supabase/functions/_shared/content/types.ts';
import type { FieldKey } from '../../supabase/functions/_shared/content/types.ts';
import type { GroundedField } from '../../supabase/functions/_shared/fillkit/grounding.ts';
import { emptyCounts, noEligibility } from '../../supabase/functions/_shared/evalkit/types.ts';
import { newObservation } from '../../eval/providers/metered.ts';
import type { EvalRow, GoldScenario } from '../../supabase/functions/_shared/evalkit/types.ts';
const scenario: GoldScenario = { version: 1, id: 'test', base_id: 'base', stratum: 'test', origin: 'handtrap', author: 'Synthetic test', licence: 'MIT', messages: [{ text: 'Synthetic.' }], expected: { fields: { landlord: { state: 'valid', value: 'Aster Vale' }, monthly_rent: { state: 'valid', value: 120000 }, deposit: { state: 'missing' } }, required_questions: ['deposit'], optional_confirmation: true, clause_ids: null, unsupported_quotes: [], render_blocked: true }, tags: ['synthetic'] };
function row(method: EvalRow['method'], id: string, wrong: number, filled: number, cost: number): EvalRow {
  return { ...newObservation(), scenario_id: id, base_id: id, method, split: 'heldout', scope: 'jev_eligible', status: 'complete', eligibility: { ...noEligibility(), fields: true, questions: true, extraction: true, conformance: true }, counts: { ...emptyCounts(), labelled: 10, wrong, filled, correct: filled - wrong, abstained: 10 - filled }, failures: [], paid_usd: cost, latency_ms: 1, dispatched_attempts: method === 'regex' ? 0 : 1, latency_observed_attempts: method === 'regex' ? 0 : 1 };
}
describe('harmful errors, denominators and cluster uncertainty', () => {
  it('separates wrong/all-labelled, wrong/all-filled and abstention including unresolved truth', () => {
    const actual = Object.fromEntries(FIELD_KEYS.map((key) => [key, { field: key, state: 'missing', candidates: [], reasons: [] }])) as Record<FieldKey, GroundedField>;
    actual.landlord = { ...actual.landlord, state: 'valid', value: 'Aster Vale' }; actual.monthly_rent = { ...actual.monthly_rent, state: 'valid', value: 130000 };
    const scored = fieldCounts(scenario, actual, FIELD_KEYS), r = rates(scored.counts);
    expect(scored.counts).toMatchObject({ labelled: 3, filled: 2, correct: 1, wrong: 1, abstained: 1, state_correct: 2 });
    expect(r.wrong_all_labelled).toBe(1 / 3); expect(r.wrong_all_filled).toBe(1 / 2); expect(r.abstention).toBe(1 / 3);
    expect(scored.failures).toEqual([{ scenario_id: 'test', kind: 'wrong_fill', item: 'monthly_rent' }]);
    expect(scored.field_scores.monthly_rent).toMatchObject({ wrong: 1 });
    actual.deposit = { ...actual.deposit, state: 'valid', value: 120000 };
    expect(fieldCounts(scenario, actual, FIELD_KEYS).counts.wrong).toBe(2); // Filling a deliberately unresolved field is harmful.
  });
  it('deduplicates required questions and keeps optional confirmations out of this denominator', () => {
    expect(questionCounts(['deposit'], ['deposit', 'deposit', 'address'])).toEqual({ required_expected: 1, required_asked: 2, required_true_positive: 1 });
    expect(rates(emptyCounts()).wrong_all_filled).toBeNull();
  });
  it('excludes unavailable prediction families and clusters while retaining observed conformance', () => {
    const available = row('llm', 'observed', 1, 8, .01), unavailable: EvalRow = { ...row('llm', 'refused', 0, 0, 0), status: 'incomplete', eligibility: { ...noEligibility(), conformance: true },
      counts: { ...emptyCounts(), labelled: 99, abstained: 99, required_expected: 4, required_asked: 4, required_true_positive: 4, injection_cases: 1, injection_pass: 1, render_cases: 1, blocked_correct: 1 } };
    const counts = sumCounts([available, unavailable]);
    expect(counts).toMatchObject({ labelled: 10, abstained: 2, required_true_positive: 0, required_expected: 0, injection_cases: 0, render_cases: 1, blocked_correct: 1 });
    expect(clusterBootstrap([available, unavailable], (c) => rates(c).wrong_all_labelled, 7, 100)).toBeNull();
    const second = row('llm', 'second-observed', 2, 10, .01);
    expect(clusterBootstrap([available, second, unavailable], (c) => rates(c).wrong_all_labelled, 7, 100)).toEqual(clusterBootstrap([available, second], (c) => rates(c).wrong_all_labelled, 7, 100));
  });
  it('uses seeded base-cluster resampling rather than independent field/variant resampling', () => {
    const a = row('regex', 'a', 0, 10, 0), variant = { ...a, scenario_id: 'a-variant' };
    expect(clusterBootstrap([a, variant], (c) => rates(c).coverage, 7, 100)).toBeNull();
    const b = row('regex', 'b', 5, 10, 0), inputs = [a, variant, b];
    expect(clusterBootstrap(inputs, (c) => rates(c).wrong_all_labelled, 7, 100)).toEqual(clusterBootstrap(inputs, (c) => rates(c).wrong_all_labelled, 7, 100));
  });
  it('does not promote Jev for a cost/coverage gain accompanied by worse wrong-fill, missing baseline or replay', () => {
    const rows = [row('jev', 'a', 1, 10, .001), row('regex', 'a', 0, 8, 0), row('llm', 'a', 2, 9, .01)];
    expect(jevPromotion(rows).promoted).toBe(false);
    expect(jevPromotion(rows.slice(0, 2)).reason).toBe('incomplete_or_unmatched_heldout_measurement');
    const better = [row('jev', 'a', 0, 10, .001), row('regex', 'a', 0, 8, 0), row('llm', 'a', 0, 9, .01)];
    expect(jevPromotion(better).promoted).toBe(true);
    expect(jevPromotion(better.map((r) => r.method === 'jev' ? { ...r, replay: true } : r)).promoted).toBe(false);
  });
});
