// Regex extractor: the non-model baseline (PLAN section 4.5). It proposes every code-found candidate that the
// finders already assigned to a field (role cues included, so names/addresses are role payloads) by
// candidate id, and every detected request sentence. It never adds values of its own: grounding re-derives
// each value from the candidate's quote, exactly as for a model. Output goes through the same zod path.
import type { AllCandidates } from '../candidates/index.ts';
import type { FieldSpec } from '../fields.ts';
import type { IntakeLike } from '../normalize.ts';
import type { Extractor } from './types.ts';

export interface RegexProposals {
  readonly fields: { field: string; candidate_id: string }[];
  readonly requests: { quote: string; pointer: string; clause_id: string | null }[];
}

/** Proposals built from code-found candidates only (deterministic: candidate order). */
export function buildRegexProposals(candidates: AllCandidates): RegexProposals {
  const fields: { field: string; candidate_id: string }[] = [];
  for (const c of candidates.candidates) {
    if (c.field !== undefined) fields.push({ field: c.field, candidate_id: c.id });
  }
  const requests = candidates.requests.map((r) => ({ quote: r.quote, pointer: r.pointer, clause_id: r.clause_id }));
  return { fields, requests };
}

export const regexExtractor: Extractor = {
  method: 'regex',
  extract(_intake: IntakeLike, _fieldSpecs: readonly FieldSpec[], candidates: AllCandidates): Promise<unknown> {
    return Promise.resolve(buildRegexProposals(candidates));
  },
};
