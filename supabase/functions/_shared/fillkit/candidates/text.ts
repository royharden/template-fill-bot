// Shared text helpers for the candidate finders: spans, sentences, the payload terminator rule, cue search
// and deterministic ids/pointers. Pure.
//
// Regex hygiene used throughout candidates/: regexes with the `g` flag are only ever used through
// `String.prototype.matchAll` (which clones them) and never with `.test`/`.exec`, so no `lastIndex` state leaks.
import { formatPointer } from '../cited.ts';

export interface Span {
  readonly start: number;
  readonly end: number;
}

/** Payload terminators (PLAN section 4.4): `.` `!` `?` `;` and newline. */
export function isTerminator(ch: string | undefined): boolean {
  return ch === '.' || ch === '!' || ch === '?' || ch === ';' || ch === '\n';
}

/**
 * Role-payload terminator rule: index of the first terminator at or after `from`, else text.length.
 * Strict: every `.` counts (so "St. Johns Rd" is cut at "St"; the question text tells users not to write it).
 */
export function payloadEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (isTerminator(text[i])) return i;
  }
  return text.length;
}

const WS_RE = /\s/u;
export function isWhitespace(ch: string | undefined): boolean {
  return ch !== undefined && WS_RE.test(ch);
}

/** Shrink [start, end) so it neither starts nor ends with whitespace. */
export function trimSpan(text: string, start: number, end: number): Span {
  let s = start;
  let e = end;
  while (s < e && isWhitespace(text[s])) s++;
  while (e > s && isWhitespace(text[e - 1])) e--;
  return { start: s, end: e };
}

const DIGIT_RE = /[0-9]/;
/** A `.` between two digits (decimal amount, dotted date) does not end a sentence. */
function isInnerDot(text: string, i: number): boolean {
  return text[i] === '.' && i > 0 && DIGIT_RE.test(text[i - 1] ?? '') && DIGIT_RE.test(text[i + 1] ?? '');
}

/**
 * Sentences for cue-based finders: split on terminators (except a dot between digits), trimmed,
 * terminators excluded, empty pieces dropped.
 */
export function sentenceSpans(text: string): Span[] {
  const out: Span[] = [];
  let s = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || (isTerminator(text[i]) && !isInnerDot(text, i))) {
      const t = trimSpan(text, s, i);
      if (t.end > t.start) out.push(t);
      s = i + 1;
    }
  }
  return out;
}

/** The sentence that contains [start, end), if any. */
export function sentenceContaining(spans: readonly Span[], start: number, end: number): Span | null {
  for (const sp of spans) {
    if (sp.start <= start && end <= sp.end) return sp;
  }
  return null;
}

export interface CueRule<T> {
  readonly tag: T;
  /** Must carry the `g` flag (used with matchAll). */
  readonly re: RegExp;
}

export interface CueHit<T> {
  readonly tag: T;
  readonly start: number;
  readonly end: number;
}

/** All cue matches inside `span` of `text`, with absolute offsets. */
export function findCues<T>(text: string, span: Span, rules: readonly CueRule<T>[]): CueHit<T>[] {
  const out: CueHit<T>[] = [];
  const slice = text.slice(span.start, span.end);
  for (const rule of rules) {
    for (const m of slice.matchAll(rule.re)) {
      const start = span.start + (m.index ?? 0);
      out.push({ tag: rule.tag, start, end: start + m[0].length });
    }
  }
  return out;
}

/** Nearest cue that ends at or before `at.start`; if none, nearest cue that starts at or after `at.end`. */
export function nearestCue<T>(hits: readonly CueHit<T>[], at: Span): T | null {
  let before: CueHit<T> | null = null;
  let after: CueHit<T> | null = null;
  for (const h of hits) {
    if (h.end <= at.start) {
      if (before === null || h.end > before.end) before = h;
    } else if (h.start >= at.end) {
      if (after === null || h.start < after.start) after = h;
    }
  }
  if (before !== null) return before.tag;
  if (after !== null) return after.tag;
  return null;
}

export function pointerFor(messageId: string, span: Span): string {
  return formatPointer(messageId, span.start, span.end);
}

/** Deterministic candidate id `<prefix>:<msgid>:<start>-<end>[#suffix]`. */
export function candidateId(prefix: string, messageId: string, span: Span, suffix?: string): string {
  return `${prefix}:${messageId}:${span.start}-${span.end}${suffix === undefined ? '' : `#${suffix}`}`;
}

/** Case-insensitive pattern for a literal word without the `i` flag (so `\p{Lu}` keeps its meaning under `u`). */
export function ci(word: string): string {
  let out = '';
  for (const ch of word) {
    const lo = ch.toLowerCase();
    const up = ch.toUpperCase();
    if (lo !== up) out += `[${up}${lo}]`;
    else if (ch === ' ') out += '\\s+';
    // Only syntax characters are escaped: under the `u` flag an identity escape such as `\-` is invalid.
    else out += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return out;
}

/** Number words accepted in durations and relative deposits. */
export const NUMBER_WORDS: Readonly<Record<string, number>> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  eighteen: 18,
  'twenty-four': 24,
  'thirty-six': 36,
};

/** Integer from digits or a NUMBER_WORDS entry ("twenty four" == "twenty-four"); null otherwise. */
export function numberFrom(token: string): number | null {
  const t = token.trim().toLowerCase().replace(/\s+/g, '-');
  if (/^[0-9]{1,6}$/.test(t)) return Number.parseInt(t, 10);
  // own-property check: never read inherited members such as "constructor"
  return Object.prototype.hasOwnProperty.call(NUMBER_WORDS, t) ? (NUMBER_WORDS[t] ?? null) : null;
}
