// Intake normalisation (PLAN section 4.4). Pure: no Node/Deno APIs.
//
// Per message, in this order:
//   1. "\r\n" -> "\n" (a lone "\r" is then a forbidden control character);
//   2. strip U+200B..U+200D, U+2060, U+FEFF (zero-width characters / BOM);
//   3. reject unpaired UTF-16 surrogates;
//   4. reject every other C0/C1 control except "\n" (so TAB is rejected), DEL, the bidi/format controls
//      U+061C, U+200E, U+200F, U+202A..U+202E, U+2066..U+2069, and U+2028/U+2029 (line/paragraph separators,
//      which would otherwise act as invisible line breaks);
//   4b. reject any other Unicode format character (\p{Cf}, e.g. U+180E, U+206A..U+206F, U+FFF9..U+FFFB,
//      tag characters) so invisible text can never reach quotes or pointers;
//   4c. reject runs of more than MAX_WHITESPACE_RUN consecutive spaces/newlines (bounds regex work in the
//      candidate finders, several of which are quadratic in whitespace-run length);
//   5. NFC.
// Limits: at most MAX_MESSAGES messages and MAX_TOTAL_UTF16 UTF-16 code units (JS string .length) of
// normalised text in total. Pointers (cited.ts) index into the normalised copy.

export const MAX_MESSAGES = 12;
export const MAX_TOTAL_UTF16 = 8000;
/** Raw (pre-normalisation) total length above which we refuse to even normalise (cheap DoS guard). */
export const MAX_RAW_UTF16 = 65536;
/** Message ids must be pointer-safe (see cited.ts POINTER_RE). */
export const MESSAGE_ID_PATTERN = '[A-Za-z0-9_-]{1,32}';
export const MESSAGE_ID_RE = new RegExp(`^${MESSAGE_ID_PATTERN}$`);

/** Characters removed silently. */
export const STRIPPED_CHARS_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
/** Characters that make the intake invalid (after stripping). "\n" (U+000A) is the only allowed control. */
export const FORBIDDEN_CHAR_RE =
  /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]|\p{Cf}/u;
/** Longest allowed run of consecutive spaces / newlines in one message. */
export const MAX_WHITESPACE_RUN = 64;
const WHITESPACE_RUN_RE = new RegExp(`[ \\n]{${MAX_WHITESPACE_RUN + 1}}`);

export interface IntakeMessageInput {
  readonly id?: string;
  readonly text: string;
}

export interface NormalisedMessage {
  readonly id: string;
  readonly text_normalised: string;
}

/** Minimal shape every consumer of normalised intake needs. */
export interface IntakeLike {
  readonly messages: readonly NormalisedMessage[];
}

export interface Intake extends IntakeLike {
  readonly total_utf16: number;
}

export type IntakeErrorCode =
  | 'too_many_messages'
  | 'too_long'
  | 'forbidden_char'
  | 'whitespace_run'
  | 'empty'
  | 'invalid_id';

export interface IntakeError {
  readonly code: IntakeErrorCode;
  /** Diagnostic detail. Never contains intake text (only ids, counts, offsets and code points). */
  readonly detail: string;
}

export type NormaliseResult =
  | { readonly ok: true; readonly messages: NormalisedMessage[]; readonly total_utf16: number }
  | { readonly ok: false; readonly error: IntakeError };

export type NormaliseTextResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly offset: number; readonly codePoint: number; readonly reason?: 'whitespace_run' };

function hex(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Index of the first unpaired surrogate, or -1. */
export function findLoneSurrogate(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) {
        i++;
        continue;
      }
      return i;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return i;
  }
  return -1;
}

/** Normalise one message's text (steps 1-5 above). Offsets in a failure refer to the stripped text. */
export function normaliseText(raw: string): NormaliseTextResult {
  const crlf = raw.replace(/\r\n/g, '\n');
  const stripped = crlf.replace(STRIPPED_CHARS_RE, '');
  const lone = findLoneSurrogate(stripped);
  if (lone >= 0) return { ok: false, offset: lone, codePoint: stripped.charCodeAt(lone) };
  const m = FORBIDDEN_CHAR_RE.exec(stripped);
  if (m !== null) return { ok: false, offset: m.index, codePoint: m[0].codePointAt(0) ?? 0 };
  const w = WHITESPACE_RUN_RE.exec(stripped);
  if (w !== null) return { ok: false, offset: w.index, codePoint: w[0].charCodeAt(0), reason: 'whitespace_run' };
  return { ok: true, text: stripped.normalize('NFC') };
}

function fail(code: IntakeErrorCode, detail: string): NormaliseResult {
  return { ok: false, error: { code, detail } };
}

/**
 * Normalise and limit-check an intake. Ids default to `m1`..`m12` by position when absent.
 * Checks run in this order: empty list, message count, raw size, per-message id / characters / emptiness,
 * total normalised UTF-16 length.
 */
export function normaliseIntake(messages: readonly IntakeMessageInput[]): NormaliseResult {
  if (!Array.isArray(messages) || messages.length === 0) return fail('empty', 'no messages');
  if (messages.length > MAX_MESSAGES) {
    return fail('too_many_messages', `${messages.length} messages; maximum is ${MAX_MESSAGES}`);
  }
  let raw = 0;
  for (const m of messages) raw += typeof m?.text === 'string' ? m.text.length : 0;
  if (raw > MAX_RAW_UTF16) return fail('too_long', `raw input ${raw} UTF-16 units; maximum is ${MAX_RAW_UTF16}`);

  const out: NormalisedMessage[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m === null || typeof m !== 'object') return fail('empty', `message ${i + 1}: not an object`);
    const id = m.id === undefined ? `m${i + 1}` : m.id;
    if (typeof id !== 'string' || !MESSAGE_ID_RE.test(id)) {
      return fail('invalid_id', `message ${i + 1}: id is not of the form ${MESSAGE_ID_PATTERN}`);
    }
    if (seen.has(id)) return fail('invalid_id', `message ${i + 1}: duplicate id ${id}`);
    seen.add(id);
    if (typeof m.text !== 'string') return fail('empty', `message ${id}: text is not a string`);
    const res = normaliseText(m.text);
    if (!res.ok) {
      if (res.reason === 'whitespace_run') {
        return fail('whitespace_run', `message ${id}: more than ${MAX_WHITESPACE_RUN} consecutive spaces/newlines at offset ${res.offset}`);
      }
      return fail('forbidden_char', `message ${id}: forbidden character ${hex(res.codePoint)} at offset ${res.offset}`);
    }
    if (res.text.trim().length === 0) return fail('empty', `message ${id}: empty after normalisation`);
    total += res.text.length;
    out.push({ id, text_normalised: res.text });
  }
  if (total > MAX_TOTAL_UTF16) {
    return fail('too_long', `${total} UTF-16 units of normalised text; maximum is ${MAX_TOTAL_UTF16}`);
  }
  return { ok: true, messages: out, total_utf16: total };
}
