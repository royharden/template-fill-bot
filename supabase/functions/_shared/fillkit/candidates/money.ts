// Money candidates (PLAN section 4.4): `£1,200`, `GBP 1200`, "1,200 a month", "£1,250 actually", and
// relative deposits ("one month's rent", "deposit one month"). Values are integer minor units (pence).
// The nearest cue word in the same sentence decides the field (rent/rental -> monthly_rent,
// deposit/bond -> deposit; preceding cue first, else following; else a stated period implies rent).
import type { FieldKey } from '../../content/types.ts';
import type { IntakeLike } from '../normalize.ts';
import type { Candidate, MoneyValue, RelativeDepositValue } from '../schema.ts';
import { candidateId, findCues, nearestCue, numberFrom, pointerFor, sentenceContaining, sentenceSpans } from './text.ts';
import type { CueRule, Span } from './text.ts';

const CUR_PREFIX = '(£|GBP|\\$|USD|€|EUR)';
const AMOUNT = '([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\\.([0-9]{2}))?';
const CUR_SUFFIX = '(GBP|pounds?|USD|EUR|euros?|dollars?)';
const PERIOD =
  '(a\\s+month|per\\s+calendar\\s+month|per\\s+month|pcm|monthly|a\\s+week|per\\s+week|pw|weekly)';

/**
 * Finder: groups 1 prefix currency, 2 integer part, 3 decimals, 4 suffix currency, 5 period.
 * A bare number only counts when a currency or a period is attached.
 */
const MONEY_FIND_RE = new RegExp(
  `(?<![\\w£$€.,])(?:${CUR_PREFIX}\\s?)?${AMOUNT}(?![0-9])(?![.,][0-9])(?:\\s?${CUR_SUFFIX}\\b)?(?:\\s+${PERIOD}\\b)?`,
  'gi',
);
const MONEY_PARSE_RE = new RegExp(`^(?:${CUR_PREFIX}\\s?)?${AMOUNT}(?:\\s?${CUR_SUFFIX})?(?:\\s+${PERIOD})?$`, 'i');

const REL_NUM = '(one|two|three|four|five|six|an|a|[1-6])';
const DEPOSIT_WORD = 'deposit(?:\\s*:\\s*|\\s+(?:of\\s+|is\\s+|will\\s+be\\s+|equal\\s+to\\s+)?)';
const DEPOSIT_LEAD = `\\b${DEPOSIT_WORD}`;
/** "one month's rent", "two months' rent", "1 month rent". */
const REL_RENT_RE = new RegExp(`(?<![\\w-])${REL_NUM}[\\s-]+months?(?:['’]s|['’])?\\s+rent\\b`, 'gi');
/** "deposit one month", "deposit: two months" (not followed by "rent": REL_RENT_RE covers that). */
const REL_DEPOSIT_RE = new RegExp(
  `(?<=${DEPOSIT_LEAD})${REL_NUM}[\\s-]+months?\\b(?!(?:['’]s|['’])?\\s+rent\\b)`,
  'gi',
);
const REL_PARSE_RE = new RegExp(
  `^(?:${DEPOSIT_WORD})?${REL_NUM}[\\s-]+months?(?:['’]s|['’])?(?:\\s+rent)?$`,
  'i',
);

const MONEY_CUES: readonly CueRule<FieldKey>[] = [
  { tag: 'monthly_rent', re: /\b(?:rent|rental)\b/gi },
  { tag: 'deposit', re: /\b(?:deposit|bond)\b/gi },
];
const DEPOSIT_CUES: readonly CueRule<FieldKey>[] = [{ tag: 'deposit', re: /\b(?:deposit|bond)\b/gi }];

/** Generous sanity bound shared with the field validators: GBP 1,000,000.00. */
export const MAX_MONEY_MINOR = 100_000_000;

function currencyCode(token: string | undefined): string | null {
  if (token === undefined) return null;
  const t = token.toLowerCase();
  if (t === '£' || t === 'gbp' || t === 'pound' || t === 'pounds') return 'GBP';
  if (t === '$' || t === 'usd' || t === 'dollar' || t === 'dollars') return 'USD';
  if (t === '€' || t === 'eur' || t === 'euro' || t === 'euros') return 'EUR';
  return null;
}

function periodOf(token: string | undefined): 'month' | 'week' | null {
  if (token === undefined) return null;
  return /week|pw/i.test(token) ? 'week' : 'month';
}

function minorUnits(intPart: string, dec: string | undefined): number | null {
  const whole = Number.parseInt(intPart.replace(/,/g, ''), 10);
  if (!Number.isSafeInteger(whole)) return null;
  const minor = whole * 100 + (dec === undefined ? 0 : Number.parseInt(dec, 10));
  return Number.isSafeInteger(minor) ? minor : null;
}

function moneyFromGroups(
  prefix: string | undefined,
  intPart: string,
  dec: string | undefined,
  suffix: string | undefined,
  period: string | undefined,
): MoneyValue | null {
  const a = currencyCode(prefix);
  const b = currencyCode(suffix);
  if (a !== null && b !== null && a !== b) return null;
  const minor = minorUnits(intPart, dec);
  if (minor === null) return null;
  return { currency: a ?? b, minor, period: periodOf(period) };
}

/**
 * Parse a whole money string ("£1,200", "GBP 1200", "1,200 a month", "1200"). Currency is null when not
 * stated (callers decide whether to assume the jurisdiction currency). Null when not money or currencies clash.
 */
export function parseMoneyText(text: string): MoneyValue | null {
  const m = MONEY_PARSE_RE.exec(text.trim());
  if (m === null || m[2] === undefined) return null;
  return moneyFromGroups(m[1], m[2], m[3], m[4], m[5]);
}

/** Parse "one month's rent" / "deposit one month" / "2 months" style text; months 1..6, else null. */
export function parseRelativeDepositText(text: string): RelativeDepositValue | null {
  const m = REL_PARSE_RE.exec(text.trim());
  if (m === null || m[1] === undefined) return null;
  const months = numberFrom(m[1]);
  return months !== null && months >= 1 && months <= 6 ? { months } : null;
}

function withField(base: Omit<Candidate, 'field'>, field: FieldKey | null): Candidate {
  return field === null ? base : { ...base, field };
}

export function findMoneyCandidates(intake: IntakeLike): Candidate[] {
  const out: Candidate[] = [];
  for (const msg of intake.messages) {
    const text = msg.text_normalised;
    const sentences = sentenceSpans(text);

    for (const m of text.matchAll(MONEY_FIND_RE)) {
      const [whole, prefix, intPart, dec, suffix, period] = m;
      if (intPart === undefined) continue;
      if (prefix === undefined && suffix === undefined && period === undefined) continue;
      const value = moneyFromGroups(prefix, intPart, dec, suffix, period);
      if (value === null) continue;
      const start = m.index ?? 0;
      const span: Span = { start, end: start + whole.length };
      const sentence = sentenceContaining(sentences, span.start, span.end) ?? span;
      let field = nearestCue(findCues(text, sentence, MONEY_CUES), span);
      if (field === null && value.period !== null) field = 'monthly_rent';
      out.push(
        withField(
          {
            id: candidateId(field ?? 'money', msg.id, span),
            kind: 'money',
            value,
            quote: whole,
            pointer: pointerFor(msg.id, span),
          },
          field,
        ),
      );
    }

    for (const re of [REL_RENT_RE, REL_DEPOSIT_RE]) {
      for (const m of text.matchAll(re)) {
        const whole = m[0];
        const months = m[1] === undefined ? null : numberFrom(m[1]);
        if (months === null || months < 1 || months > 6) continue;
        const start = m.index ?? 0;
        const span: Span = { start, end: start + whole.length };
        const sentence = sentenceContaining(sentences, span.start, span.end) ?? span;
        const field: FieldKey | null =
          re === REL_DEPOSIT_RE || findCues(text, sentence, DEPOSIT_CUES).length > 0 ? 'deposit' : null;
        out.push(
          withField(
            {
              id: candidateId(field ?? 'relative_deposit', msg.id, span),
              kind: 'relative_deposit',
              value: { months },
              quote: whole,
              pointer: pointerFor(msg.id, span),
              flags: ['relative'],
            },
            field,
          ),
        );
      }
    }
  }
  return out;
}
