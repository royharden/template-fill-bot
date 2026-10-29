// Date candidates (PLAN section 4.4): ISO `2027-03-01`, "1 March 2027", "March 1st, 2027", numeric d/m/y.
// - numeric with both parts <= 12 and different (03/04/2027) -> TWO candidates flagged `ambiguous`, each
//   carrying both ISO readings in `alternatives` (day-first reading first);
// - numeric with one part > 12 (25/03/2027 or 03/25/2027) -> one unambiguous candidate;
// - impossible dates (31/02/2027, month 13, year outside 2000..2100) -> no candidate;
// - year-less "1 March" -> value null, flag `needs_year` (never the current year);
// - "tomorrow", "next month" ... -> value null, flag `relative`.
// Field: nearest start cue (start/starting/from/begin/commence/move in) or end cue (end/until/finish/expire)
// in the same sentence; otherwise no field.
import type { FieldKey } from '../../content/types.ts';
import type { IntakeLike } from '../normalize.ts';
import type { Candidate, CandidateFlag } from '../schema.ts';
import { candidateId, findCues, nearestCue, pointerFor, sentenceContaining, sentenceSpans } from './text.ts';
import type { CueRule, Span } from './text.ts';

export const MIN_YEAR = 2000;
export const MAX_YEAR = 2100;

/** Month-name alternation, longest names first so "march" wins over "mar". */
export const MONTH_ALT =
  'january|february|march|april|may|june|july|august|september|october|november|december|sept|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec';

const MONTH_NUMBER: Readonly<Record<string, number>> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6,
  july: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11,
  nov: 11, december: 12, dec: 12,
};

const ORD = '(?:st|nd|rd|th)?';
/** groups: 1 day, 2 month name, 3 year? */
const DMY_SRC = `([0-9]{1,2})${ORD}\\s+(?:of\\s+)?(${MONTH_ALT})\\b(?:,?\\s+([0-9]{4})(?![0-9]))?`;
/** groups: 1 month name, 2 day, 3 year? */
const MDY_SRC = `(${MONTH_ALT})\\.?\\s+([0-9]{1,2})${ORD}(?![0-9])\\b(?:,?\\s+([0-9]{4})(?![0-9]))?`;
/** groups: 1 year, 2 month, 3 day */
const ISO_SRC = '([0-9]{4})-([0-9]{2})-([0-9]{2})';
/** groups: 1 a, 2 separator, 3 b, 4 year */
const NUM_SRC = '([0-9]{1,2})([/.-])([0-9]{1,2})\\2([0-9]{4})';
const RELATIVE_SRC =
  '(?:today|tomorrow|next\\s+(?:week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday))';

const ISO_FIND_RE = new RegExp(`(?<![0-9-])${ISO_SRC}(?![0-9-])`, 'g');
const DMY_FIND_RE = new RegExp(`(?<![\\w])${DMY_SRC}`, 'gi');
const MDY_FIND_RE = new RegExp(`(?<![\\w])${MDY_SRC}`, 'gi');
const NUM_FIND_RE = new RegExp(`(?<![0-9/.-])${NUM_SRC}(?![0-9])(?![/.-][0-9])`, 'g');
const RELATIVE_FIND_RE = new RegExp(`\\b${RELATIVE_SRC}\\b`, 'gi');

const ISO_PARSE_RE = new RegExp(`^${ISO_SRC}$`);
const DMY_PARSE_RE = new RegExp(`^${DMY_SRC}$`, 'i');
const MDY_PARSE_RE = new RegExp(`^${MDY_SRC}$`, 'i');
const NUM_PARSE_RE = new RegExp(`^${NUM_SRC}$`);
const RELATIVE_PARSE_RE = new RegExp(`^${RELATIVE_SRC}$`, 'i');

const DATE_CUES: readonly CueRule<FieldKey>[] = [
  {
    tag: 'start_date',
    re: /\b(?:start|starts|starting|started|begin|begins|beginning|commenc\w*|from|move[\s-]in|moving\s+in)\b/gi,
  },
  { tag: 'end_date', re: /\b(?:end|ends|ending|until|till|finish\w*|expir\w*)\b/gi },
];

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

export function isValidYmd(y: number, m: number, d: number): boolean {
  return (
    Number.isInteger(y) && Number.isInteger(m) && Number.isInteger(d) &&
    y >= MIN_YEAR && y <= MAX_YEAR && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m)
  );
}

export function toIso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** True for a real calendar date written as YYYY-MM-DD within MIN_YEAR..MAX_YEAR. */
export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = ISO_PARSE_RE.exec(value);
  if (m === null) return false;
  return isValidYmd(Number(m[1]), Number(m[2]), Number(m[3]));
}

function monthNumber(name: string | undefined): number | null {
  if (name === undefined) return null;
  const key = name.toLowerCase();
  return Object.prototype.hasOwnProperty.call(MONTH_NUMBER, key) ? (MONTH_NUMBER[key] ?? null) : null;
}

/** Readings of a numeric a/b/yyyy date: day-first (d/m) and month-first (m/d), valid ones only. */
export function numericReadings(a: number, b: number, y: number): { dmy: string | null; mdy: string | null } {
  const dmy = isValidYmd(y, b, a) ? toIso(y, b, a) : null;
  const mdy = isValidYmd(y, a, b) ? toIso(y, a, b) : null;
  return { dmy, mdy };
}

export type DateParseResult =
  | { readonly ok: true; readonly iso: string }
  | {
      readonly ok: false;
      readonly reason: 'needs_year' | 'ambiguous_date' | 'impossible_date' | 'relative_date' | 'unrecognised';
      readonly alternatives?: readonly string[];
    };

/** Parse a whole date string. Used by the field parsers (fields.ts) and by grounding (M3). */
export function parseDateText(text: string): DateParseResult {
  const t = text.trim();
  let m = ISO_PARSE_RE.exec(t);
  if (m !== null) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    return isValidYmd(y, mo, d) ? { ok: true, iso: toIso(y, mo, d) } : { ok: false, reason: 'impossible_date' };
  }
  m = DMY_PARSE_RE.exec(t);
  if (m !== null) return fromNamed(Number(m[1]), monthNumber(m[2]), m[3]);
  m = MDY_PARSE_RE.exec(t);
  if (m !== null) return fromNamed(Number(m[2]), monthNumber(m[1]), m[3]);
  m = NUM_PARSE_RE.exec(t);
  if (m !== null) {
    const a = Number(m[1]);
    const b = Number(m[3]);
    const y = Number(m[4]);
    const r = numericReadings(a, b, y);
    if (r.dmy !== null && r.mdy !== null && r.dmy !== r.mdy) {
      return { ok: false, reason: 'ambiguous_date', alternatives: [r.dmy, r.mdy] };
    }
    const one = r.dmy ?? r.mdy;
    return one === null ? { ok: false, reason: 'impossible_date' } : { ok: true, iso: one };
  }
  if (RELATIVE_PARSE_RE.test(t)) return { ok: false, reason: 'relative_date' };
  return { ok: false, reason: 'unrecognised' };
}

function fromNamed(day: number, month: number | null, year: string | undefined): DateParseResult {
  if (month === null) return { ok: false, reason: 'unrecognised' };
  if (year === undefined) {
    // Validate day-in-month against a leap year so "29 February" still asks for the year.
    return day >= 1 && day <= daysInMonth(2028, month) ? { ok: false, reason: 'needs_year' } : { ok: false, reason: 'impossible_date' };
  }
  const y = Number(year);
  return isValidYmd(y, month, day) ? { ok: true, iso: toIso(y, month, day) } : { ok: false, reason: 'impossible_date' };
}

interface RawHit {
  readonly span: Span;
  /** One entry per reading; value null means "needs a question". */
  readonly readings: readonly { value: string | null; suffix?: string }[];
  readonly flags?: readonly CandidateFlag[];
  readonly alternatives?: readonly string[];
}

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

function hitsIn(text: string): RawHit[] {
  const hits: RawHit[] = [];
  for (const m of text.matchAll(ISO_FIND_RE)) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (!isValidYmd(y, mo, d)) continue;
    const start = m.index ?? 0;
    hits.push({ span: { start, end: start + m[0].length }, readings: [{ value: toIso(y, mo, d) }] });
  }
  const named = (start: number, len: number, day: number, month: number | null, year: string | undefined): void => {
    if (month === null) return;
    const span = { start, end: start + len };
    if (year === undefined) {
      if (day >= 1 && day <= daysInMonth(2028, month)) hits.push({ span, readings: [{ value: null }], flags: ['needs_year'] });
      return;
    }
    const y = Number(year);
    if (isValidYmd(y, month, day)) hits.push({ span, readings: [{ value: toIso(y, month, day) }] });
  };
  for (const m of text.matchAll(DMY_FIND_RE)) named(m.index ?? 0, m[0].length, Number(m[1]), monthNumber(m[2]), m[3]);
  for (const m of text.matchAll(MDY_FIND_RE)) named(m.index ?? 0, m[0].length, Number(m[2]), monthNumber(m[1]), m[3]);
  for (const m of text.matchAll(NUM_FIND_RE)) {
    const start = m.index ?? 0;
    const span = { start, end: start + m[0].length };
    const r = numericReadings(Number(m[1]), Number(m[3]), Number(m[4]));
    if (r.dmy !== null && r.mdy !== null && r.dmy !== r.mdy) {
      hits.push({
        span,
        readings: [
          { value: r.dmy, suffix: 'dmy' },
          { value: r.mdy, suffix: 'mdy' },
        ],
        flags: ['ambiguous'],
        alternatives: [r.dmy, r.mdy],
      });
    } else {
      const one = r.dmy ?? r.mdy;
      if (one !== null) hits.push({ span, readings: [{ value: one }] });
    }
  }
  for (const m of text.matchAll(RELATIVE_FIND_RE)) {
    const start = m.index ?? 0;
    hits.push({ span: { start, end: start + m[0].length }, readings: [{ value: null }], flags: ['relative'] });
  }
  // Overlap resolution: earlier start first, then longer span; drop any hit overlapping a kept one.
  hits.sort((a, b) => a.span.start - b.span.start || b.span.end - a.span.end);
  const kept: RawHit[] = [];
  for (const h of hits) {
    if (!kept.some((k) => overlaps(k.span, h.span))) kept.push(h);
  }
  return kept;
}

export function findDateCandidates(intake: IntakeLike): Candidate[] {
  const out: Candidate[] = [];
  for (const msg of intake.messages) {
    const text = msg.text_normalised;
    const sentences = sentenceSpans(text);
    for (const hit of hitsIn(text)) {
      const sentence = sentenceContaining(sentences, hit.span.start, hit.span.end) ?? hit.span;
      const field = nearestCue(findCues(text, sentence, DATE_CUES), hit.span);
      for (const reading of hit.readings) {
        const c: Candidate = {
          id: candidateId(field ?? 'date', msg.id, hit.span, reading.suffix),
          kind: 'date',
          value: reading.value,
          quote: text.slice(hit.span.start, hit.span.end),
          pointer: pointerFor(msg.id, hit.span),
        };
        if (field !== null) c.field = field;
        if (hit.flags !== undefined) c.flags = [...hit.flags];
        if (hit.alternatives !== undefined) c.alternatives = [...hit.alternatives];
        out.push(c);
      }
    }
  }
  return out;
}
