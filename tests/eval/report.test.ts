import { describe, expect, it } from 'vitest';
import { FAILURE_START, FAILURE_END, replaceFailureSection, failureSection, operationalSummary, renderReport } from '../../eval/report.ts';
import { emptyCounts, noEligibility } from '../../supabase/functions/_shared/evalkit/types.ts';
import { newObservation } from '../../eval/providers/metered.ts';
import type { EvalRow } from '../../supabase/functions/_shared/evalkit/types.ts';
const row = (id: string, overrides: Partial<EvalRow> = {}): EvalRow => ({ ...newObservation(), scenario_id: id, base_id: id, method: 'llm', split: 'dev', scope: 'all', status: 'incomplete', counts: emptyCounts(), failures: [], eligibility: noEligibility(), ...overrides });
const metadata: Parameters<typeof renderReport>[1] = { live: true, run_id: 'synthetic', at: 'synthetic', split: 'dev',
  manifest: { version: 1, state: 'pending', seed: 7, generated_count: 0, handtrap_count: 0, entries: [], sources: {}, protocol_hash: null, frozen_at: null, digest: 'synthetic' },
  protocol: { version: 1, seed: 7, bootstrap_iterations: 100, methods: ['llm'], llm_provider: 'anthropic', llm_model: 'synthetic', jev_model: 'synthetic', max_output_tokens: 10, timeout_ms: 1, retries: 0, option_order_seed: 7, thresholds: { jev_default: false, wrong_fill_nonincrease_both_baselines: true }, note: 'Synthetic test data only.' } };
describe('honest failure and limitations reporting', () => {
  it('retains incomplete budget rows and wrong-question ids without replacing authored limitations', () => {
    const failed = row('trap-test', { reason: 'budget_cumulative_cap', failures: [{ scenario_id: 'trap-test', kind: 'incomplete', item: 'budget_cumulative_cap' }, { scenario_id: 'trap-test', kind: 'wrong_question', item: 'deposit' }], paid_usd: null, reserved_usd: .1 });
    const report = replaceFailureSection(`Authored limits.\n${FAILURE_START}\nNOT MEASURED\n${FAILURE_END}\nAuthored caveats.`, failureSection([failed]));
    expect(report).toContain('Authored limits.'); expect(report).toContain('Authored caveats.');
    expect(report).toContain('trap-test | incomplete | budget_cumulative_cap'); expect(report).toContain('trap-test | wrong_question | deposit');
    expect(() => replaceFailureSection('No markers', failureSection([]))).toThrow('limitations_failure_markers_required');
    expect(() => replaceFailureSection(`${FAILURE_START}${FAILURE_START}${FAILURE_END}`, failureSection([]))).toThrow('limitations_failure_markers_required');
  });
  it('reports unavailable predictions as N/A without losing independently observed conformance', () => {
    const unavailable = row('refused', { eligibility: { ...noEligibility(), conformance: true }, counts: { ...emptyCounts(), labelled: 7, abstained: 7, required_expected: 1, required_asked: 1, required_true_positive: 1, render_cases: 1, blocked_correct: 1 },
      field_scores: { deposit: { labelled: 1, correct: 1, filled: 1, wrong: 0, abstained: 0 } } });
    const report = renderReport([unavailable], metadata);
    expect(report).toContain('fields 0/1; questions 0/1');
    expect(report).toContain('Abstention | 0 | 0 | N/A'); expect(report).toContain('Required question recall | 0 | 0 | N/A');
    expect(report).toContain('Render blocked correctly | 1 | 1 | 1'); expect(report).not.toContain('Per-field source counts');
  });
  it('uses observed attempt and fully observed matter denominators across mixed/null/zero/replay latency', () => {
    const mixed = [row('observed-but-incomplete', { latency_ms: 80, dispatched_attempts: 1, latency_observed_attempts: 1, paid_usd: .03, reserved_usd: .1, settled_usd: .03 }),
      row('undispatched'), row('missing', { latency_ms: null, dispatched_attempts: 1, latency_missing_attempts: 1, paid_usd: null, reserved_usd: .1, retained_usd: .1, outstanding_attempts: 1 }),
      row('replay', { replay: true, replay_original_usd: .02, latency_ms: 999, dispatched_attempts: 1, latency_observed_attempts: 1 }),
      row('measured-zero', { latency_ms: 0, dispatched_attempts: 1, latency_observed_attempts: 1 }),
      row('partial-retry', { latency_ms: 60, dispatched_attempts: 2, latency_observed_attempts: 1, latency_missing_attempts: 1 })];
    const summary = operationalSummary(mixed);
    expect(summary).toMatchObject({ planned_rows: 6, replay_rows: 1, undispatched_rows: 1, dispatched_rows: 4, dispatched_attempts: 5, observed_attempts: 3, missing_attempts: 2, observed_latency_ms: 140, fully_observed_matters: 2, mean_fully_observed_matter_ms: 40,
      observed_charge_usd: null, reserved_volume_usd: .2, settled_spend_usd: .03, retained_exposure_usd: .1, outstanding_attempts: 1, replay_original_usd: .02 });
    expect(summary.mean_observed_attempt_ms).toBe(140 / 3);
    const report = renderReport(mixed, metadata);
    expect(report).toContain('3 latency-observed attempts; 2 latency-missing attempts; 1 undispatched rows');
    expect(report).toContain('Observed provider latency subtotal ms 140'); expect(report).toContain('total reserved volume USD 0.2; ledger settled spend USD 0.03; outstanding retained exposure USD 0.1');
    expect(report).not.toContain('per planned matter ms');
  });
  it('renders all-unobserved provider durations and unknown financial state as N/A', () => {
    const rows = [row('unknown', { dispatched_attempts: 1, latency_missing_attempts: 1, paid_usd: null, reserved_usd: null, settled_usd: null, retained_usd: null, outstanding_attempts: null }), row('not-dispatched'), row('replay-only', { replay: true })];
    expect(operationalSummary(rows)).toMatchObject({ observed_attempts: 0, missing_attempts: 1, observed_latency_ms: null, mean_observed_attempt_ms: null, mean_fully_observed_matter_ms: null, reserved_volume_usd: null, settled_spend_usd: null, retained_exposure_usd: null });
    const report = renderReport(rows, metadata);
    expect(report).toContain('Observed provider latency subtotal ms N/A'); expect(report).toContain('mean per observed attempt ms N/A'); expect(report).toContain('total reserved volume USD N/A'); expect(report).toContain('outstanding retained exposure USD N/A');
  });
});
