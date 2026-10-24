// Extractor interface (PLAN section 4.5). An extractor PROPOSES field values and requests, each with a verbatim
// quote (and ideally a pointer); it never decides anything. Its raw output is untrusted model-shaped JSON and
// always goes through schema.ts `parseExtractorOutput` (zod + unknown-key stripping) and then grounding.ts.
// Pure types: no runtime code.
import type { AllCandidates } from '../candidates/index.ts';
import type { FieldSpec } from '../fields.ts';
import type { IntakeLike } from '../normalize.ts';

/** Methods that produce proposals. `mock` is fixture replay (no model, no network). */
export const EXTRACTOR_METHODS = ['regex', 'llm', 'jev', 'mock'] as const;
export type ExtractorMethod = (typeof EXTRACTOR_METHODS)[number];

/**
 * `extract` resolves to RAW output shaped like `{fields: FieldProposal[], requests: RequestProposal[], usageRef?}`.
 * It is typed `unknown` on purpose: callers must not trust it until parseExtractorOutput has run.
 */
export interface Extractor {
  /** Method token recorded for every value grounded from this extractor's proposals. */
  readonly method: ExtractorMethod;
  extract(intake: IntakeLike, fieldSpecs: readonly FieldSpec[], candidates: AllCandidates): Promise<unknown>;
}
