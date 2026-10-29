import type { FieldKey } from '../content/types.ts';
import type { FieldValue } from '../fillkit/fields.ts';
import type { IntakeMessageInput } from '../fillkit/normalize.ts';

export const METHODS = ['regex', 'llm', 'jev', 'free_draft_blind', 'free_draft_library', 'mock'] as const;
export type Method = (typeof METHODS)[number];
export interface Label { readonly state: 'valid' | 'missing' | 'ambiguous' | 'conflict' | 'invalid' | 'none_confirmed'; readonly value?: FieldValue }
export interface GoldScenario {
  readonly version: 1; readonly id: string; readonly base_id: string; readonly stratum: string;
  readonly origin: 'generated' | 'handtrap'; readonly author: string; readonly licence: 'MIT';
  readonly messages: readonly IntakeMessageInput[];
  readonly expected: {
    readonly fields: Partial<Record<FieldKey, Label>>;
    readonly required_questions: readonly FieldKey[];
    readonly optional_confirmation: boolean;
    /** null means the independently labelled intake is not renderable before answers. */
    readonly clause_ids: readonly string[] | null;
    readonly unsupported_quotes: readonly string[];
    readonly render_blocked: boolean;
  };
  readonly tags: readonly string[];
  readonly security?: 'stale_approval' | 'expiry_retry_budget' | 'docx_hidden';
}
export interface Counts {
  labelled: number; filled: number; wrong: number; correct: number; abstained: number; state_correct: number;
  required_expected: number; required_asked: number; required_true_positive: number;
  optional_expected: number; optional_asked: number; optional_correct: number;
  clause_cases: number; clause_exact: number; unsupported_expected: number; unsupported_handled: number;
  render_cases: number; blocked_correct: number; pipeline_rendered: number; gate_failures: number;
  provenance_spans: number; provenance_resolved: number; injection_cases: number; injection_pass: number;
  free_paragraphs: number; foreign_paragraphs: number; legal_content_paragraphs: number; legal_inventions: number; boilerplate_mismatches: number; headings: number; provenance_paragraphs: number;
  security_cases: number; security_pass: number;
}
export const emptyCounts = (): Counts => ({ labelled: 0, filled: 0, wrong: 0, correct: 0, abstained: 0, state_correct: 0,
  required_expected: 0, required_asked: 0, required_true_positive: 0, optional_expected: 0, optional_asked: 0, optional_correct: 0,
  clause_cases: 0, clause_exact: 0, unsupported_expected: 0, unsupported_handled: 0, render_cases: 0, blocked_correct: 0,
  pipeline_rendered: 0, gate_failures: 0, provenance_spans: 0, provenance_resolved: 0, injection_cases: 0, injection_pass: 0,
  free_paragraphs: 0, foreign_paragraphs: 0, legal_content_paragraphs: 0, legal_inventions: 0, boilerplate_mismatches: 0, headings: 0, provenance_paragraphs: 0, security_cases: 0, security_pass: 0 });
export const METRIC_FAMILIES = ['fields', 'questions', 'extraction', 'conformance', 'free_draft', 'security'] as const;
export type MetricFamily = (typeof METRIC_FAMILIES)[number];
/** Availability is independent of row completeness: a failed operational step must not invent predictions,
 * and an independently observed conformance check is still available on an incomplete row. */
export type ScoringEligibility = Readonly<Record<MetricFamily, boolean>>;
export const noEligibility = (): ScoringEligibility => ({ fields: false, questions: false, extraction: false, conformance: false, free_draft: false, security: false });
export interface Failure { readonly scenario_id: string; readonly kind: string; readonly item: string }
export interface EvalRow {
  readonly scenario_id: string; readonly base_id: string; readonly split: 'dev' | 'heldout'; readonly method: Method;
  readonly scope: 'all' | 'jev_eligible'; readonly status: 'complete' | 'incomplete' | 'nonmeasurement';
  readonly reason?: string; readonly counts: Counts; readonly failures: readonly Failure[];
  readonly eligibility: ScoringEligibility;
  readonly paid_usd: number | null; readonly reserved_usd: number | null; readonly replay_original_usd: number | null;
  readonly settled_usd: number | null; readonly retained_usd: number | null; readonly outstanding_attempts: number | null;
  readonly dispatched_attempts: number; readonly undispatched_attempts: number;
  readonly latency_observed_attempts: number; readonly latency_missing_attempts: number;
  readonly latency_ms: number | null; readonly replay: boolean;
  readonly field_scores?: Partial<Record<FieldKey, { labelled: number; filled: number; correct: number; wrong: number; abstained: number }>>;
}
