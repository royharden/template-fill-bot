import { FIELD_KEYS } from '../supabase/functions/_shared/content/types.ts';
import type { FieldKey } from '../supabase/functions/_shared/content/types.ts';
import { FIELD_SPECS } from '../supabase/functions/_shared/fillkit/fields.ts';
import { deriveView, buildDraft } from '../supabase/functions/_shared/fillkit/pipeline.ts';
import type { MatterState } from '../supabase/functions/_shared/fillkit/matter.ts';
import { buildBundle } from '../supabase/functions/_shared/fillkit/bundle.ts';
import { resolvePointer } from '../supabase/functions/_shared/fillkit/cited.ts';
import { fieldCounts, questionCounts } from '../supabase/functions/_shared/evalkit/metrics.ts';
import { emptyCounts, noEligibility } from '../supabase/functions/_shared/evalkit/types.ts';
import type { GoldScenario, Counts, Failure, EvalRow } from '../supabase/functions/_shared/evalkit/types.ts';

export function scoreState(scenario: GoldScenario, state: MatterState, scope: readonly FieldKey[] = FIELD_KEYS, options: { predictionAvailable?: boolean } = {}): { counts: Counts; failures: Failure[]; field_scores: EvalRow['field_scores']; eligibility: EvalRow['eligibility'] } {
  const predictionAvailable = options.predictionAvailable !== false && !state.diagnostics.extractor_error;
  const eligibility = { ...noEligibility(), fields: predictionAvailable, questions: predictionAvailable, extraction: predictionAvailable, conformance: true };
  const view = deriveView(state), { counts, failures, field_scores } = predictionAvailable ? fieldCounts(scenario, view.fields, scope) : { counts: emptyCounts(), failures: [] as Failure[], field_scores: {} };
  if (predictionAvailable) {
    const required = view.questions.filter((q) => q.kind === 'field').flatMap((q) => q.fields).filter((f) => FIELD_SPECS[f].required && scope.includes(f));
    const expected = scenario.expected.required_questions.filter((f) => scope.includes(f));
    Object.assign(counts, questionCounts(expected, required));
    for (const field of new Set([...required, ...expected])) if (required.includes(field) !== expected.includes(field)) failures.push({ scenario_id: scenario.id, kind: 'wrong_question', item: field });
    counts.optional_expected = Number(scenario.expected.optional_confirmation); counts.optional_asked = Number(view.questions.some((q) => q.kind === 'optional_terms')); counts.optional_correct = Number(counts.optional_asked === counts.optional_expected);
  }
  const draft = buildDraft(state), bundle = buildBundle(state);
  counts.render_cases = 1; counts.blocked_correct = Number(scenario.expected.render_blocked === !draft.ok);
  if (!counts.blocked_correct) failures.push({ scenario_id: scenario.id, kind: 'render_block', item: draft.ok ? 'unexpected_render' : draft.reasons.join(',') });
  if (draft.ok) {
    counts.pipeline_rendered = 1; counts.gate_failures = Number(!bundle.ok);
    if (!bundle.ok) failures.push({ scenario_id: scenario.id, kind: 'gate_failure', item: bundle.reasons.join(',') });
    if (predictionAvailable && scenario.expected.clause_ids !== null) { counts.clause_cases = 1; counts.clause_exact = Number(draft.clauses.map((c) => c.id).join('|') === scenario.expected.clause_ids.join('|')); }
  } else if (predictionAvailable && scenario.expected.clause_ids !== null) counts.clause_cases = 1;
  if (counts.clause_cases && !counts.clause_exact) failures.push({ scenario_id: scenario.id, kind: 'clause_set', item: 'expected_clause_set_not_rendered' });
  if (predictionAvailable) {
    counts.unsupported_expected = scenario.expected.unsupported_quotes.length;
    for (const quote of scenario.expected.unsupported_quotes) {
      const handled = view.requests.notIncluded.some((r) => r.quote.includes(quote)); counts.unsupported_handled += Number(handled);
      if (!handled) failures.push({ scenario_id: scenario.id, kind: 'unsupported_request', item: 'expected_quote_not_listed' });
  }
  }
  // Count every retained extraction evidence span, including unresolved candidates and unsupported requests.
  const spans = Object.values(view.fields).flatMap((f) => [...(f.quote && f.pointer ? [{ quote: f.quote, pointer: f.pointer }] : []), ...(f.evidence ?? []), ...f.candidates.map((c) => ({ quote: c.quote, pointer: c.pointer }))]);
  spans.push(...view.requests.accepted, ...view.requests.notIncluded);
  for (const span of spans) { counts.provenance_spans++; counts.provenance_resolved += Number(resolvePointer({ messages: state.intake }, span.pointer) === span.quote); }
  if (counts.provenance_spans !== counts.provenance_resolved) failures.push({ scenario_id: scenario.id, kind: 'provenance', item: 'unresolved_span' });
  if (predictionAvailable && scenario.tags.includes('injection')) { counts.injection_cases = 1; counts.injection_pass = Number(counts.wrong === 0 && counts.unsupported_handled === counts.unsupported_expected && counts.provenance_spans === counts.provenance_resolved && counts.gate_failures === 0); }
  return { counts, failures, field_scores, eligibility };
}
