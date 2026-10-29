// Duration candidates (PLAN section 4.4): "12 months", "a year", "18-month", "two years" -> months.
// Excluded: "a month"/"an month" (money period phrase), "one month's rent" and "deposit one month"
// (relative deposits, money.ts). Field: `break_month` when the sentence mentions a break, none when it is
// about notice, else `term_months`.
import type { FieldKey } from '../../content/types.ts';
import type { IntakeLike } from '../normalize.ts';
import type { Candidate } from '../schema.ts';
import { candidateId, numberFrom, pointerFor, sentenceContaining, sentenceSpans } from './text.ts';
import type { Span } from './text.ts';

const NUM_ALT =
  'twenty[\\s-]four|thirty[\\s-]six|eighteen|twelve|eleven|ten|nine|eight|seven|six|five|four|three|two|one|an|a|[0-9]{1,3}';
const DEPOSIT_LEAD = '\\bdeposit(?:\\s*:\\s*|\\s+(?:of\\s+|is\\s+|will\\s+be\\s+|equal\\s+to\\s+)?)';

/** groups: 1 number, 2 unit */
const DURATION_FIND_RE = new RegExp(
  `(?<![\\w-])(?<!${DEPOSIT_LEAD})(${NUM_ALT})[\\s-]+(months?|years?)\\b(?!(?:['’]s|['’])?\\s+rent\\b)`,
  'gi',
);
const DURATION_PARSE_RE = new RegExp(
  `^(?:(?:for|term(?:\\s+of)?|a\\s+term\\s+of)\\s+)?(${NUM_ALT})[\\s-]+(months?|years?)(?:\\s+(?:term|tenancy|lease|fixed\\s+term))?$`,
  'i',
);
const BARE_INT_RE = /^[0-9]{1,3}$/;
const BREAK_RE = /\bbreak\b/i;
const NOTICE_RE = /\bnotice\b/i;

function toMonths(numToken: string, unit: string): number | null {
  const n = numberFrom(numToken);
  if (n === null || n <= 0) return null;
  return /^y/i.test(unit) ? n * 12 : n;
}

/** Parse "12 months", "a year", "18-month", "for 2 years", or a bare integer (months). Null otherwise. */
export function parseDurationText(text: string): number | null {
  const t = text.trim();
  if (BARE_INT_RE.test(t)) {
    const n = Number.parseInt(t, 10);
    return n > 0 ? n : null;
  }
  const m = DURATION_PARSE_RE.exec(t);
  if (m === null || m[1] === undefined || m[2] === undefined) return null;
  return toMonths(m[1], m[2]);
}

export function findDurationCandidates(intake: IntakeLike): Candidate[] {
  const out: Candidate[] = [];
  for (const msg of intake.messages) {
    const text = msg.text_normalised;
    const sentences = sentenceSpans(text);
    for (const m of text.matchAll(DURATION_FIND_RE)) {
      const numToken = m[1];
      const unit = m[2];
      if (numToken === undefined || unit === undefined) continue;
      const lowerNum = numToken.toLowerCase();
      if ((lowerNum === 'a' || lowerNum === 'an') && /^month/i.test(unit)) continue;
      const months = toMonths(numToken, unit);
      if (months === null) continue;
      const start = m.index ?? 0;
      const span: Span = { start, end: start + m[0].length };
      const sentence = sentenceContaining(sentences, span.start, span.end) ?? span;
      const sentenceText = text.slice(sentence.start, sentence.end);
      let field: FieldKey | null = 'term_months';
      if (BREAK_RE.test(sentenceText)) field = 'break_month';
      else if (NOTICE_RE.test(sentenceText)) field = null;
      const c: Candidate = {
        id: candidateId(field ?? 'duration', msg.id, span),
        kind: 'duration',
        value: months,
        quote: m[0],
        pointer: pointerFor(msg.id, span),
      };
      if (field !== null) c.field = field;
      out.push(c);
    }
  }
  return out;
}
