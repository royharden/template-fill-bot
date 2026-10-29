// Rent due-day candidates (PLAN section 4.4): "on the 1st", "due day 1", "due on the 1st",
// "the 1st of each month". "on the 1st of March" is a date, not a due day. Field `rent_due_day` when the
// phrase says due/payable/paid or the sentence mentions rent/pay/due; otherwise no field.
import type { FieldKey } from '../../content/types.ts';
import type { IntakeLike } from '../normalize.ts';
import type { Candidate } from '../schema.ts';
import { MONTH_ALT } from './dates.ts';
import { candidateId, pointerFor, sentenceContaining, sentenceSpans } from './text.ts';
import type { Span } from './text.ts';

/** groups: 1 (due day N), 2 (on the Nth), 3 (the Nth of each month) */
const DUE_FIND_RE = new RegExp(
  [
    '\\bdue\\s+day\\s+([0-9]{1,2})(?![0-9])',
    `\\b(?:(?:due|payable|paid)\\s+)?on\\s+the\\s+([0-9]{1,2})(?:st|nd|rd|th)\\b(?!\\s+(?:of\\s+)?(?:${MONTH_ALT})\\b)`,
    '\\b(?:the\\s+)?([0-9]{1,2})(?:st|nd|rd|th)\\s+of\\s+(?:each|every|the)\\s+month\\b',
  ].join('|'),
  'gi',
);
const DUE_PARSE_RE =
  /^(?:rent\s+)?(?:is\s+)?(?:due\s+|payable\s+|paid\s+)?(?:day\s+)?(?:on\s+)?(?:the\s+)?([0-9]{1,2})(?:st|nd|rd|th)?(?:\s+of\s+(?:each|every|the)\s+month)?$/i;
const PHRASE_CUE_RE = /\b(?:due|payable|paid)\b/i;
const SENTENCE_CUE_RE = /\b(?:rent|pay|pays|paid|payable|payment|due)\b/i;

/** Parse "1", "1st", "on the 1st", "due day 1", "due on the 1st", "the 1st of each month". Null otherwise. */
export function parseDueDayText(text: string): number | null {
  const m = DUE_PARSE_RE.exec(text.trim());
  if (m === null || m[1] === undefined) return null;
  return Number.parseInt(m[1], 10);
}

export function findDueDayCandidates(intake: IntakeLike): Candidate[] {
  const out: Candidate[] = [];
  for (const msg of intake.messages) {
    const text = msg.text_normalised;
    const sentences = sentenceSpans(text);
    for (const m of text.matchAll(DUE_FIND_RE)) {
      const digits = m[1] ?? m[2] ?? m[3];
      if (digits === undefined) continue;
      const day = Number.parseInt(digits, 10);
      if (day < 1 || day > 31) continue;
      const start = m.index ?? 0;
      const span: Span = { start, end: start + m[0].length };
      const sentence = sentenceContaining(sentences, span.start, span.end) ?? span;
      const field: FieldKey | null =
        PHRASE_CUE_RE.test(m[0]) || SENTENCE_CUE_RE.test(text.slice(sentence.start, sentence.end)) ? 'rent_due_day' : null;
      const c: Candidate = {
        id: candidateId(field ?? 'due_day', msg.id, span),
        kind: 'due_day',
        value: day,
        quote: m[0],
        pointer: pointerFor(msg.id, span),
      };
      if (field !== null) c.field = field;
      out.push(c);
    }
  }
  return out;
}
