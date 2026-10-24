// Request detectors (PLAN sections 4.4, 4.5). FROZEN LIST: changing a detector changes regex-baseline and
// eval behaviour; treat edits as a deliberate, reviewed change.
// One RequestCandidate per sentence that any detector fires on; the quote is the whole sentence (terminator
// excluded). clause_id is a requestable clause id only for the garden-care / professional-clean detectors;
// every other request (enter without notice, add a clause, ignore the template, "clause 99", "add that ...")
// has clause_id null and ends up "Not included" (M3 requests.ts decides acceptance).
import type { IntakeLike } from '../normalize.ts';
import type { RequestCandidate } from '../schema.ts';
import { candidateId, pointerFor, sentenceSpans } from './text.ts';

export interface RequestDetector {
  readonly id: string;
  /** Non-global; used with .test only. */
  readonly re: RegExp;
  readonly clause_id: string | null;
}

export const REQUEST_DETECTORS: readonly RequestDetector[] = Object.freeze([
  { id: 'enter-without-notice', re: /\benter\b(?:\s+\w+){0,3}?\s+without\s+(?:any\s+|prior\s+|giving\s+)?notice\b/i, clause_id: null },
  { id: 'add-clause', re: /\badd\s+(?:a|an|another|one\s+more|this|the)?\s*clauses?\b/i, clause_id: null },
  { id: 'ignore-template', re: /\bignore\s+(?:the\s+|your\s+|this\s+)?template\b/i, clause_id: null },
  { id: 'clause-number', re: /\bclause\s+#?[0-9]+\b/i, clause_id: null },
  { id: 'add-that', re: /\badd\s+that\b/i, clause_id: null },
  {
    id: 'garden-care',
    re: /\bgarden\s+(?:care|maintenance|upkeep)\b|\b(?:look\s+after|maintain|tend|mow)\b[^.!?;\n]{0,30}\b(?:garden|lawn)\b|\bkeep\s+the\s+(?:garden|lawn)\s+(?:tidy|neat|maintained)\b/i,
    clause_id: 'garden-care',
  },
  {
    id: 'professional-clean',
    re: /\bprofessional(?:ly)?\s+clean(?:ed|ing)?\b/i,
    clause_id: 'professional-clean-at-end',
  },
]);

export function findRequestCandidates(intake: IntakeLike): RequestCandidate[] {
  const out: RequestCandidate[] = [];
  for (const msg of intake.messages) {
    const text = msg.text_normalised;
    for (const sentence of sentenceSpans(text)) {
      const s = text.slice(sentence.start, sentence.end);
      const fired = REQUEST_DETECTORS.filter((d) => d.re.test(s));
      if (fired.length === 0) continue;
      const detectors = fired.map((d) => d.id);
      const clauseIds = [...new Set(fired.map((d) => d.clause_id).filter((c): c is string => c !== null))];
      const pointer = pointerFor(msg.id, sentence);
      if (clauseIds.length === 0) {
        out.push({ id: candidateId('request', msg.id, sentence), quote: s, pointer, clause_id: null, detectors });
      } else {
        // Specific clause detectors win; two in one sentence give one candidate each.
        for (const clauseId of clauseIds) {
          out.push({
            id: candidateId('request', msg.id, sentence, clauseIds.length > 1 ? clauseId : undefined),
            quote: s,
            pointer,
            clause_id: clauseId,
            detectors,
          });
        }
      }
    }
  }
  return out;
}
