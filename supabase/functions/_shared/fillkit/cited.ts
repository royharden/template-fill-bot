// Source pointers (PLAN section 4.4): `msg:<id>:<start>-<end>`, end-exclusive UTF-16 offsets into the
// NORMALISED message text (normalize.ts). Pure.
import { MESSAGE_ID_PATTERN } from './normalize.ts';
import type { IntakeLike } from './normalize.ts';

/** Offsets are non-negative integers without leading zeros, at most 9 digits. */
export const POINTER_RE = new RegExp(`^msg:(${MESSAGE_ID_PATTERN}):(0|[1-9][0-9]{0,8})-(0|[1-9][0-9]{0,8})$`);

export interface Pointer {
  readonly message_id: string;
  readonly start: number;
  readonly end: number;
}

export type GroundFailureReason =
  | 'empty_quote'
  | 'bad_pointer'
  | 'unresolvable_pointer'
  | 'quote_mismatch'
  | 'not_found'
  | 'ambiguous_occurrence';

export type GroundResult =
  | {
      readonly ok: true;
      readonly pointer: string;
      readonly message_id: string;
      readonly start: number;
      readonly end: number;
    }
  | { readonly ok: false; readonly reason: GroundFailureReason };

const ID_ONLY_RE = new RegExp(`^${MESSAGE_ID_PATTERN}$`);

export function formatPointer(messageId: string, start: number, end: number): string {
  if (
    !ID_ONLY_RE.test(messageId) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start
  ) {
    throw new RangeError('formatPointer: invalid pointer parts');
  }
  return `msg:${messageId}:${start}-${end}`;
}

/** Strict parse; returns null for anything that is not exactly a well-formed pointer with start < end. */
export function parsePointer(pointer: unknown): Pointer | null {
  if (typeof pointer !== 'string') return null;
  const m = POINTER_RE.exec(pointer);
  if (m === null) return null;
  const start = Number(m[2]);
  const end = Number(m[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end) return null;
  return { message_id: m[1], start, end };
}

function isHigh(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}
function isLow(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}
/** True when offset i falls between the two halves of a surrogate pair. */
export function splitsSurrogatePair(text: string, i: number): boolean {
  return i > 0 && i < text.length && isHigh(text.charCodeAt(i - 1)) && isLow(text.charCodeAt(i));
}

/**
 * Resolve a pointer against normalised intake. Null when the pointer is malformed, names an unknown message,
 * runs past the end of the text, or cuts a surrogate pair in half.
 */
export function resolvePointer(intake: IntakeLike, pointer: string | Pointer): string | null {
  const p = typeof pointer === 'string' ? parsePointer(pointer) : pointer;
  if (p === null || typeof p !== 'object') return null;
  if (!Number.isSafeInteger(p.start) || !Number.isSafeInteger(p.end) || p.start < 0 || p.start >= p.end) return null;
  const msg = intake.messages.find((m) => m.id === p.message_id);
  if (msg === undefined) return null;
  const text = msg.text_normalised;
  if (p.end > text.length) return null;
  if (splitsSurrogatePair(text, p.start) || splitsSurrogatePair(text, p.end)) return null;
  return text.slice(p.start, p.end);
}

/** Every start offset (UTF-16) at which `quote` occurs in `text`, overlapping occurrences included. */
export function findOccurrences(text: string, quote: string): number[] {
  const out: number[] = [];
  if (quote.length === 0) return out;
  let from = 0;
  for (;;) {
    const i = text.indexOf(quote, from);
    if (i < 0) break;
    out.push(i);
    from = i + 1;
  }
  return out;
}

/**
 * Ground a quote in the intake.
 * - With a pointer: the pointer must resolve and the resolved text must equal the quote exactly.
 * - Without a pointer: the quote must occur exactly once across all messages (else `not_found` /
 *   `ambiguous_occurrence`; a repeated substring therefore needs an explicit pointer).
 */
export function groundQuote(intake: IntakeLike, quote: unknown, pointer?: string | Pointer | null): GroundResult {
  if (typeof quote !== 'string' || quote.length === 0) return { ok: false, reason: 'empty_quote' };
  if (pointer !== undefined && pointer !== null) {
    const p = typeof pointer === 'string' ? parsePointer(pointer) : pointer;
    if (p === null) return { ok: false, reason: 'bad_pointer' };
    const resolved = resolvePointer(intake, p);
    if (resolved === null) return { ok: false, reason: 'unresolvable_pointer' };
    if (resolved !== quote) return { ok: false, reason: 'quote_mismatch' };
    return { ok: true, pointer: formatPointer(p.message_id, p.start, p.end), message_id: p.message_id, start: p.start, end: p.end };
  }
  let found: { message_id: string; start: number; end: number } | null = null;
  let count = 0;
  for (const msg of intake.messages) {
    for (const start of findOccurrences(msg.text_normalised, quote)) {
      const end = start + quote.length;
      if (splitsSurrogatePair(msg.text_normalised, start) || splitsSurrogatePair(msg.text_normalised, end)) continue;
      count++;
      if (count > 1) return { ok: false, reason: 'ambiguous_occurrence' };
      found = { message_id: msg.id, start, end };
    }
  }
  if (found === null) return { ok: false, reason: 'not_found' };
  return { ok: true, pointer: formatPointer(found.message_id, found.start, found.end), ...found };
}
