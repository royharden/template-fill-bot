import type { FieldKey } from '../content/types.ts';
import { canonicalJson } from '../fillkit/canonicalJson.ts';
import type { GroundedField } from '../fillkit/grounding.ts';
import { seeded } from './random.ts';
import { emptyCounts } from './types.ts';
import type { Counts, EvalRow, Failure, GoldScenario, MetricFamily } from './types.ts';

export function fieldCounts(scenario: GoldScenario, actual: Readonly<Record<FieldKey, GroundedField>>, scope: readonly FieldKey[]): { counts: Counts; failures: Failure[]; field_scores: NonNullable<EvalRow['field_scores']> } {
  const counts = emptyCounts(), failures: Failure[] = [], field_scores: NonNullable<EvalRow['field_scores']> = {};
  for (const field of scope) {
    const label = scenario.expected.fields[field]; if (!label) continue;
    const got = actual[field]; counts.labelled++;
    const filled = got.state === 'valid';
    const same = got.state === label.state && (!filled || canonicalJson(got.value ?? null) === canonicalJson(label.value ?? null));
    field_scores[field] = { labelled: 1, filled: Number(filled), correct: Number(filled && same), wrong: Number(filled && !same), abstained: Number(!filled) };
    if (same) counts.state_correct++;
    if (filled) { counts.filled++; if (same) counts.correct++; else { counts.wrong++; failures.push({ scenario_id: scenario.id, kind: 'wrong_fill', item: field }); } }
    else counts.abstained++;
  }
  return { counts, failures, field_scores };
}
export function questionCounts(expected: readonly string[], asked: readonly string[]): Pick<Counts, 'required_expected' | 'required_asked' | 'required_true_positive'> {
  const e = new Set(expected), a = new Set(asked);
  return { required_expected: e.size, required_asked: a.size, required_true_positive: [...a].filter((x) => e.has(x)).length };
}
export const ratio = (numerator: number, denominator: number): number | null => denominator ? numerator / denominator : null;
const COUNT_FAMILY: Record<keyof Counts, MetricFamily> = {
  labelled: 'fields', filled: 'fields', wrong: 'fields', correct: 'fields', abstained: 'fields', state_correct: 'fields',
  required_expected: 'questions', required_asked: 'questions', required_true_positive: 'questions', optional_expected: 'questions', optional_asked: 'questions', optional_correct: 'questions',
  clause_cases: 'extraction', clause_exact: 'extraction', unsupported_expected: 'extraction', unsupported_handled: 'extraction', injection_cases: 'extraction', injection_pass: 'extraction',
  render_cases: 'conformance', blocked_correct: 'conformance', pipeline_rendered: 'conformance', gate_failures: 'conformance', provenance_spans: 'conformance', provenance_resolved: 'conformance',
  free_paragraphs: 'free_draft', foreign_paragraphs: 'free_draft', legal_content_paragraphs: 'free_draft', legal_inventions: 'free_draft', boilerplate_mismatches: 'free_draft', headings: 'free_draft', provenance_paragraphs: 'free_draft',
  security_cases: 'security', security_pass: 'security',
};
export function sumCounts(rows: readonly EvalRow[]): Counts {
  const out = emptyCounts(); for (const row of rows) for (const key of Object.keys(out) as (keyof Counts)[]) if (row.eligibility[COUNT_FAMILY[key]]) out[key] += row.counts[key]; return out;
}
export function rates(c: Counts) {
  return { wrong_all_labelled: ratio(c.wrong, c.labelled), wrong_all_filled: ratio(c.wrong, c.filled),
    accuracy_all_labelled: ratio(c.correct, c.labelled), accuracy_all_filled: ratio(c.correct, c.filled),
    state_accuracy: ratio(c.state_correct, c.labelled), coverage: ratio(c.filled, c.labelled), abstention: ratio(c.abstained, c.labelled),
    required_question_precision: ratio(c.required_true_positive, c.required_asked), required_question_recall: ratio(c.required_true_positive, c.required_expected),
    clause_exact: ratio(c.clause_exact, c.clause_cases), unsupported_handled: ratio(c.unsupported_handled, c.unsupported_expected),
    blocked_correct: ratio(c.blocked_correct, c.render_cases), provenance_resolved: ratio(c.provenance_resolved, c.provenance_spans), injection_pass: ratio(c.injection_pass, c.injection_cases) };
}
/** Sample whole base scenarios, retaining all phrasing variants together. Null for fewer than two clusters. */
export function clusterBootstrap(rows: readonly EvalRow[], statistic: (counts: Counts) => number | null, seed = 3007, iterations = 2000, family: MetricFamily = 'fields'): readonly [number, number] | null {
  rows = rows.filter((row) => row.eligibility[family]);
  const clusters = [...new Set(rows.map((r) => r.base_id))].sort().map((id) => rows.filter((r) => r.base_id === id));
  if (clusters.length < 2 || !Number.isSafeInteger(iterations) || iterations < 1) return null;
  const random = seeded(seed), values: number[] = [];
  for (let i = 0; i < iterations; i++) { const sample = clusters.flatMap(() => clusters[Math.floor(random() * clusters.length)]); const value = statistic(sumCounts(sample)); if (value !== null) values.push(value); }
  if (!values.length) return null; values.sort((a, b) => a - b);
  return [values[Math.floor((values.length - 1) * 0.025)], values[Math.ceil((values.length - 1) * 0.975)]];
}
/** Promotion requires the SAME held-out ids and eligible-field scope; no win is presumed. */
export function jevPromotion(rows: readonly EvalRow[]): { promoted: boolean; reason: string } {
  const groups = ['jev', 'regex', 'llm'].map((method) => rows.filter((r) => r.method === method && r.split === 'heldout' && r.scope === 'jev_eligible'));
  const ids = groups.map((g) => g.map((r) => r.scenario_id).sort().join('|'));
  if (!groups[0].length || ids.some((id) => id !== ids[0]) || groups.some((g) => g.some((r) => !r.eligibility.fields || r.status !== 'complete' || r.paid_usd === null || r.replay))) return { promoted: false, reason: 'incomplete_or_unmatched_heldout_measurement' };
  const [jev, regex, llm] = groups.map((g) => rates(sumCounts(g)));
  const wrong = (r: typeof jev) => r.wrong_all_labelled;
  if (wrong(jev) === null || wrong(regex) === null || wrong(llm) === null || wrong(jev)! > wrong(regex)! || wrong(jev)! > wrong(llm)!) return { promoted: false, reason: 'wrong_fill_not_nonincreasing' };
  const total = (g: readonly EvalRow[]) => g.reduce((n, r) => n + (r.paid_usd ?? Infinity), 0);
  const gain = jev.accuracy_all_labelled! > Math.max(regex.accuracy_all_labelled!, llm.accuracy_all_labelled!) || jev.coverage! > Math.max(regex.coverage!, llm.coverage!) || total(groups[0]) < Math.min(total(groups[1]), total(groups[2]));
  return { promoted: gain, reason: gain ? 'eligible_heldout_gain_at_nonincreasing_wrong_fill' : 'no_accuracy_coverage_or_cost_gain' };
}
