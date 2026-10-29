import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { METHODS, METRIC_FAMILIES } from '../supabase/functions/_shared/evalkit/types.ts';
import type { EvalRow } from '../supabase/functions/_shared/evalkit/types.ts';
import { clusterBootstrap, jevPromotion, rates, sumCounts } from '../supabase/functions/_shared/evalkit/metrics.ts';
import type { Manifest } from '../supabase/functions/_shared/evalkit/split.ts';
import type { Protocol } from './protocol.ts';
import { FIELD_KEYS } from '../supabase/functions/_shared/content/types.ts';

export const FAILURE_START = '<!-- EVAL_FAILURES_START -->';
export const FAILURE_END = '<!-- EVAL_FAILURES_END -->';
const shown = (value: number | null) => value === null ? 'N/A (zero denominator or unknown)' : String(value);
const totalKnown = (values: readonly (number | null)[]) => values.some((value) => value === null) ? null : values.reduce<number>((n, value) => n + value!, 0);
/** New provider latency is an observed-attempt statistic. Missing, undispatched and replay rows cannot dilute it. */
export function operationalSummary(rows: readonly EvalRow[]) {
  const fresh = rows.filter((row) => !row.replay);
  const observedAttempts = fresh.reduce((n, row) => n + row.latency_observed_attempts, 0);
  const missingAttempts = fresh.reduce((n, row) => n + row.latency_missing_attempts, 0);
  const observed = fresh.filter((row) => row.latency_observed_attempts > 0 && row.latency_ms !== null);
  const latency = observedAttempts ? observed.reduce((n, row) => n + row.latency_ms!, 0) : null;
  const fullyObserved = observed.filter((row) => row.dispatched_attempts > 0 && row.latency_missing_attempts === 0 && row.latency_observed_attempts === row.dispatched_attempts);
  return { planned_rows: rows.length, replay_rows: rows.length - fresh.length,
    undispatched_rows: fresh.filter((row) => row.dispatched_attempts === 0).length,
    dispatched_rows: fresh.filter((row) => row.dispatched_attempts > 0).length,
    dispatched_attempts: fresh.reduce((n, row) => n + row.dispatched_attempts, 0),
    undispatched_attempts: fresh.reduce((n, row) => n + row.undispatched_attempts, 0),
    observed_attempts: observedAttempts, missing_attempts: missingAttempts, observed_latency_ms: latency,
    mean_observed_attempt_ms: latency === null ? null : latency / observedAttempts,
    fully_observed_matters: fullyObserved.length,
    mean_fully_observed_matter_ms: fullyObserved.length ? fullyObserved.reduce((n, row) => n + row.latency_ms!, 0) / fullyObserved.length : null,
    observed_charge_usd: totalKnown(rows.map((row) => row.paid_usd)),
    reserved_volume_usd: totalKnown(rows.map((row) => row.reserved_usd)),
    settled_spend_usd: totalKnown(rows.map((row) => row.settled_usd)),
    retained_exposure_usd: totalKnown(rows.map((row) => row.retained_usd)),
    outstanding_attempts: totalKnown(rows.map((row) => row.outstanding_attempts)),
    replay_original_usd: totalKnown(rows.filter((row) => row.replay).map((row) => row.replay_original_usd)),
  };
}
export function failureSection(rows: readonly EvalRow[]): string {
  const failures = rows.flatMap((row) => row.failures.map((failure) => `${row.method}/${row.scope} | ${failure.scenario_id} | ${failure.kind} | ${failure.item}`));
  return `${FAILURE_START}\nGenerated from scenario rows; includes wrong fills, wrong questions, configuration/budget failures and incomplete checks.\n\nMethod/scope | Scenario | Kind | Item\n--- | --- | --- | ---\n${failures.length ? [...new Set(failures)].sort().join('\n') : 'No recorded failures in these rows; this is not proof of absent failures.'}\n${FAILURE_END}`;
}
export function replaceFailureSection(document: string, section: string): string {
  const start = document.indexOf(FAILURE_START), end = document.indexOf(FAILURE_END);
  if (start < 0 || end < start || document.indexOf(FAILURE_START, start + 1) >= 0 || document.indexOf(FAILURE_END, end + 1) >= 0) throw new Error('limitations_failure_markers_required');
  return document.slice(0, start) + section + document.slice(end + FAILURE_END.length);
}
export function renderReport(rows: readonly EvalRow[], metadata: { manifest: Manifest; protocol: Protocol; live: boolean; run_id: string; at: string; split: string }): string {
  const { manifest, protocol } = metadata;
  const sections = [`# Evaluation results\n\n${metadata.live ? 'LIVE ATTEMPT — completeness is reported below; cache replay and mock are nonmeasurement.' : 'OFFLINE / MOCK REPLAY — NOT A MODEL MEASUREMENT.'}\n\nRun ${metadata.run_id}; ${metadata.at}; split ${metadata.split}; manifest ${manifest.digest}; frozen ${manifest.frozen_at ?? 'NO'}.\n\nScores describe this synthetic sample only. Related phrasing variants share a base cluster. Unresolved configuration/budget/security rows remain in JSONL and the completeness table. Every metric family has explicit availability. Unavailable predictions contribute no quality counts, per-field scores or bootstrap clusters. Independently observed pipeline/security conformance is reported separately; it does not establish model quality. Replay, offline and mock diagnostics remain nonmeasurement. No significance or default Jev win is inferred.\n\nMethod | Scope | All rows | Complete | Nonmeasurement | Incomplete\n--- | --- | --- | --- | --- | ---`];
  for (const method of METHODS) for (const scope of ['all', 'jev_eligible'] as const) {
    const group = rows.filter((r) => r.method === method && r.scope === scope); if (!group.length) continue;
    sections.push(`${method} | ${scope} | ${group.length} | ${group.filter((r) => r.status === 'complete').length} | ${group.filter((r) => r.status === 'nonmeasurement').length} | ${group.filter((r) => r.status === 'incomplete').length}`);
  }
  for (const method of METHODS) for (const scope of ['all', 'jev_eligible'] as const) {
    const group = rows.filter((r) => r.method === method && r.scope === scope); if (!group.length) continue;
    const c = sumCounts(group), r = rates(c);
    const interval = clusterBootstrap(group, (counts) => rates(counts).wrong_all_labelled, protocol.seed, protocol.bootstrap_iterations);
    const operational = operationalSummary(group);
    const perField = FIELD_KEYS.flatMap((key) => {
      const values = group.flatMap((row) => row.eligibility.fields && row.field_scores?.[key] ? [row.field_scores[key]!] : []);
      if (!values.length) return [];
      const sum = (name: keyof (typeof values)[number]) => values.reduce((n, value) => n + value[name], 0);
      return [`${key} | ${sum('correct')} | ${sum('labelled')} | ${sum('filled')} | ${sum('wrong')} | ${sum('abstained')}`];
    });
    sections.push(`\n## ${method} / ${scope}\n\nEligible rows by metric family: ${METRIC_FAMILIES.map((family) => `${family} ${group.filter((row) => row.eligibility[family]).length}/${group.length}`).join('; ')}.\n\nPrediction quality source counts (available predictions only; named denominators):\n\nMetric | Numerator | Denominator | Rate\n--- | --- | --- | ---\nWrong / all labelled | ${c.wrong} | ${c.labelled} | ${shown(r.wrong_all_labelled)}\nWrong / all filled | ${c.wrong} | ${c.filled} | ${shown(r.wrong_all_filled)}\nCorrect fill / all labelled | ${c.correct} | ${c.labelled} | ${shown(r.accuracy_all_labelled)}\nCorrect fill / all filled | ${c.correct} | ${c.filled} | ${shown(r.accuracy_all_filled)}\nState accuracy | ${c.state_correct} | ${c.labelled} | ${shown(r.state_accuracy)}\nCoverage | ${c.filled} | ${c.labelled} | ${shown(r.coverage)}\nAbstention | ${c.abstained} | ${c.labelled} | ${shown(r.abstention)}\nRequired question precision | ${c.required_true_positive} | ${c.required_asked} | ${shown(r.required_question_precision)}\nRequired question recall | ${c.required_true_positive} | ${c.required_expected} | ${shown(r.required_question_recall)}\nOptional confirmations (separate) | ${c.optional_correct} correct | ${c.optional_expected} expected; ${c.optional_asked} asked | N/A\nClause exact match | ${c.clause_exact} | ${c.clause_cases} | ${shown(r.clause_exact)}\nUnsupported handled | ${c.unsupported_handled} | ${c.unsupported_expected} | ${shown(r.unsupported_handled)}\nInjection passes | ${c.injection_pass} | ${c.injection_cases} | ${shown(r.injection_pass)}\n\nIndependently observed pipeline/security conformance (includes available checks on incomplete rows):\n\nMetric | Numerator | Denominator | Rate\n--- | --- | --- | ---\nRender blocked correctly | ${c.blocked_correct} | ${c.render_cases} | ${shown(r.blocked_correct)}\nPipeline gate failures | ${c.gate_failures} | ${c.pipeline_rendered} rendered | N/A\nProvenance resolves | ${c.provenance_resolved} | ${c.provenance_spans} spans | ${shown(r.provenance_resolved)}\nSecurity conformance passes | ${c.security_pass} | ${c.security_cases} | ${shown(c.security_cases ? c.security_pass / c.security_cases : null)}\n\nFree-draft diagnostics (strict equality includes all paragraphs):\n\nMetric | Numerator | Denominator | Rate\n--- | --- | --- | ---\nStrict rendered-clause mismatches | ${c.foreign_paragraphs} | ${c.free_paragraphs} all paragraphs | ${shown(c.free_paragraphs ? c.foreign_paragraphs / c.free_paragraphs : null)}\nLegal-content inventions (unrecognized non-boilerplate) | ${c.legal_inventions} | ${c.legal_content_paragraphs} legal-content paragraphs | ${shown(c.legal_content_paragraphs ? c.legal_inventions / c.legal_content_paragraphs : null)}\nExact known boilerplate clause mismatches | ${c.boilerplate_mismatches} | ${c.free_paragraphs} all paragraphs | N/A\nHeading-prefixed paragraphs (diagnostic only) | ${c.headings} | ${c.free_paragraphs} | N/A\nProvenance-prefixed paragraphs (diagnostic only) | ${c.provenance_paragraphs} | ${c.free_paragraphs} | N/A\n\nWrong/all-labelled 95% scenario-cluster percentile interval: ${interval ? interval.join(' to ') : 'N/A (insufficient clusters/denominator)'}. Seed ${protocol.seed}; ${protocol.bootstrap_iterations} resamples.\n\nObserved new provider charge USD ${shown(operational.observed_charge_usd)}; total reserved volume USD ${shown(operational.reserved_volume_usd)}; ledger settled spend USD ${shown(operational.settled_spend_usd)}; outstanding retained exposure USD ${shown(operational.retained_exposure_usd)} across ${shown(operational.outstanding_attempts)} outstanding attempts. Reserved volume is historical, never retained liability. Unknown charges/state stay N/A. Original charge represented by cache replays USD ${shown(operational.replay_original_usd)} is separate from new spend.\n\nProvider-latency denominators: ${operational.planned_rows} planned rows; ${operational.dispatched_rows} fresh dispatched matters; ${operational.dispatched_attempts} dispatched attempts; ${operational.observed_attempts} latency-observed attempts; ${operational.missing_attempts} latency-missing attempts; ${operational.undispatched_rows} undispatched rows; ${operational.undispatched_attempts} reserved but undispatched attempts; ${operational.replay_rows} replay rows. Observed provider latency subtotal ms ${shown(operational.observed_latency_ms)}; mean per observed attempt ms ${shown(operational.mean_observed_attempt_ms)}; mean per fully observed matter ms ${shown(operational.mean_fully_observed_matter_ms)} across ${operational.fully_observed_matters} fully observed matters. Partial/missing durations and replays never become zero or dilute these means. Financial and latency observations repeated in matched scopes describe the SAME calls; never add scopes together.`);
    if (perField.length) sections.push(`\nPer-field source counts (accuracy = correct/labelled; filled accuracy = correct/filled):\n\nField | Correct | Labelled | Filled | Wrong | Abstained\n--- | --- | --- | --- | --- | ---\n${perField.join('\n')}`);
  }
  const promotion = jevPromotion(rows);
  sections.push(`\nJev promotion: ${promotion.promoted ? 'eligible for separate review' : 'NOT PROMOTED'} (${promotion.reason}). Both regex and LLM must use matched eligible held-out fields.\n\nFree-draft strict paragraph equality includes all paragraphs. A separate legal-content invention diagnostic excludes only exact code-supplied known boilerplate; heading/provenance prefixes alone provide no exemption. Exact known boilerplate clause mismatches are separately reported, and the final gate remains strict. The full independent gate additionally checks complete canonical agreement/provenance/DOCX artifacts. Missing a renderable reference is an incomplete gate row, while paragraph counts remain available.\n\nTrap outcomes\n\nScenario | Method/scope | Status | Failure kinds\n--- | --- | --- | ---\n${rows.filter((row) => row.scenario_id.startsWith('trap-')).map((row) => `${row.scenario_id} | ${row.method}/${row.scope} | ${row.status} | ${row.failures.map((f) => f.kind).join(', ') || row.reason || 'none recorded'}`).join('\n')}\n\n${failureSection(rows)}\n`);
  return sections.join('\n');
}
export async function writeReport(root: string, rows: readonly EvalRow[], metadata: Parameters<typeof renderReport>[1]): Promise<void> {
  const limitsPath = join(root, 'docs/LIMITATIONS.md');
  const limits = replaceFailureSection(await readFile(limitsPath, 'utf8'), failureSection(rows)); // Validate markers BEFORE any report writes.
  const directory = join(root, 'results'); await mkdir(directory, { recursive: true }); await mkdir(join(directory, 'runs'), { recursive: true });
  const jsonl = rows.map((row) => JSON.stringify(row)).join('\n') + '\n', report = renderReport(rows, metadata);
  const archive = await open(join(directory, 'runs', `${metadata.run_id}.jsonl`), 'wx'); try { await archive.writeFile(jsonl); await archive.sync(); } finally { await archive.close(); }
  await writeFile(join(directory, 'results.jsonl'), jsonl); await writeFile(join(directory, 'results.md'), report); await writeFile(limitsPath, limits);
}
