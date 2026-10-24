// Canonical matter state (one per revision). Pure types plus the schema version constant.
// The state is JSON-compatible (canonicalJson-safe: no undefined values, no Dates) so stores can persist it
// as-is and regenerate the exact same draft later without re-running a model (PLAN section 4.8).
//
// `fields` holds the BASE records (grounding, then user answers). The effective records, questions and the
// request outcome are DERIVED on every read (pipeline.ts deriveView) by validate.ts / questions.ts /
// requests.ts, so a later answer never has to undo an earlier cross-field failure.
import type { FieldKey } from '../content/types.ts';
import type { ExtractorMethod } from './extractors/types.ts';
import type { GroundedField, ProposalRejection } from './grounding.ts';
import type { NormalisedMessage } from './normalize.ts';
import type { AnswerInput } from './questions.ts';
import type { NotIncludedItem, RequestDrop, RequestItem } from './requests.ts';

export const MATTER_STATE_VERSION = 1;

export interface AnswerLogEntry {
  readonly question_id: string;
  readonly fields: readonly FieldKey[];
  readonly answer: AnswerInput;
  readonly answered_at: string;
  /** Revision created by this answer. */
  readonly revision: number;
}

export interface RequestConfirmation {
  readonly request_id: string;
  readonly confirmed_at: string;
  /** Revision created by this confirmation. */
  readonly revision: number;
}

/** Diagnostics carry paths, indices and codes only: never intake text. */
export interface MatterDiagnostics {
  readonly dropped_keys: readonly string[];
  readonly dropped_items: readonly string[];
  readonly rejected_proposals: readonly ProposalRejection[];
  readonly request_drops: readonly RequestDrop[];
  /** Set when the extractor failed or its output failed the schema; every field is then missing. */
  readonly extractor_error?: string;
}

export interface MatterState {
  readonly schema_version: typeof MATTER_STATE_VERSION;
  /** Starts at 1 after extraction; every answer or request confirmation adds 1. */
  readonly revision: number;
  readonly extractor_method: ExtractorMethod;
  readonly intake: readonly NormalisedMessage[];
  readonly fields: Readonly<Record<FieldKey, GroundedField>>;
  readonly request_items: readonly RequestItem[];
  readonly residuals: readonly NotIncludedItem[];
  readonly confirmations: readonly RequestConfirmation[];
  readonly answers: readonly AnswerLogEntry[];
  readonly diagnostics: MatterDiagnostics;
}
