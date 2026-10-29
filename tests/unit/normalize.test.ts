// M2: intake normalisation and limits (PLAN sections 4.4, 6 M2). Written in Dirty Mode; not yet run (DV-TESTS).
import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGES,
  MAX_TOTAL_UTF16,
  MAX_WHITESPACE_RUN,
  normaliseIntake,
  normaliseText,
} from '../../supabase/functions/_shared/fillkit/normalize.ts';

const ch = (cp: number): string => String.fromCodePoint(cp);
const ZWSP = ch(0x200b);
const ZWNJ = ch(0x200c);
const ZWJ = ch(0x200d);
const WORD_JOINER = ch(0x2060);
const BOM = ch(0xfeff);
const RLO = ch(0x202e);
const LRM = ch(0x200e);
const RLM = ch(0x200f);
const ALM = ch(0x061c);
const LRI = ch(0x2066);
const PDI = ch(0x2069);
const LINE_SEP = ch(0x2028);
const EMOJI = ch(0x1f600); // astral: 2 UTF-16 code units
const COMBINING_ACUTE = ch(0x0301);

function messages(n: number, text = 'hello'): { text: string }[] {
  return Array.from({ length: n }, () => ({ text }));
}

describe('normaliseIntake limits', () => {
  it('constants match the plan', () => {
    expect(MAX_MESSAGES).toBe(12);
    expect(MAX_TOTAL_UTF16).toBe(8000);
  });

  it('accepts 12 messages', () => {
    const r = normaliseIntake(messages(12));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.messages).toHaveLength(12);
  });

  it('rejects 13 messages with too_many_messages', () => {
    const r = normaliseIntake(messages(13));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('too_many_messages');
  });

  it('rejects an empty list', () => {
    const r = normaliseIntake([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('empty');
  });

  it('accepts exactly 8000 UTF-16 units and rejects 8001', () => {
    const ok = normaliseIntake([{ text: 'a'.repeat(8000) }]);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.total_utf16).toBe(8000);
    const over = normaliseIntake([{ text: 'a'.repeat(8001) }]);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.code).toBe('too_long');
  });

  it('counts the total across messages', () => {
    const r = normaliseIntake([{ text: 'a'.repeat(4000) }, { text: 'b'.repeat(4001) }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('too_long');
  });

  it('counts an astral character as 2 units (8000 ok, 8001 rejected)', () => {
    expect(EMOJI.length).toBe(2);
    const ok = normaliseIntake([{ text: 'a'.repeat(7998) + EMOJI }]);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.total_utf16).toBe(8000);
    const over = normaliseIntake([{ text: 'a'.repeat(7999) + EMOJI }]);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.code).toBe('too_long');
  });

  it('counts after stripping zero-width characters', () => {
    const r = normaliseIntake([{ text: 'a'.repeat(8000) + ZWSP + ZWSP }]);
    expect(r.ok).toBe(true);
  });

  it('rejects whitespace-only messages as empty', () => {
    const r = normaliseIntake([{ text: 'fine' }, { text: '  \n ' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('empty');
  });
});

describe('normaliseIntake characters', () => {
  it('strips U+200B..U+200D, U+2060 and U+FEFF', () => {
    const r = normaliseIntake([{ text: `${BOM}Sam${ZWSP} ${ZWNJ}Pa${ZWJ}tel${WORD_JOINER}` }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.messages[0]?.text_normalised).toBe('Sam Patel');
  });

  it.each([
    ['RLO U+202E', RLO],
    ['LRM U+200E', LRM],
    ['RLM U+200F', RLM],
    ['ALM U+061C', ALM],
    ['LRI U+2066', LRI],
    ['PDI U+2069', PDI],
    ['line separator U+2028', LINE_SEP],
    ['NUL', ch(0)],
    ['TAB', '\t'],
    ['lone CR', '\r'],
    ['DEL', ch(0x7f)],
    ['C1 U+0085', ch(0x85)],
    ['lone high surrogate', String.fromCharCode(0xd800)],
    ['lone low surrogate', String.fromCharCode(0xdc00)],
  ])('rejects %s with forbidden_char', (_label, bad) => {
    const r = normaliseIntake([{ text: `abc${bad}def` }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('forbidden_char');
      expect(r.error.detail).not.toContain('abc');
    }
  });

  it('converts CRLF to LF before counting', () => {
    const r = normaliseIntake([{ text: 'a\r\nb' }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.messages[0]?.text_normalised).toBe('a\nb');
      expect(r.total_utf16).toBe(3);
    }
  });

  it('keeps LF', () => {
    const r = normaliseText('line one\nline two');
    expect(r).toEqual({ ok: true, text: 'line one\nline two' });
  });

  it('applies NFC', () => {
    const r = normaliseIntake([{ text: `Jose${COMBINING_ACUTE}` }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.messages[0]?.text_normalised).toBe('Jos' + ch(0xe9));
      expect(r.total_utf16).toBe(4);
    }
  });
});

describe('normaliseIntake ids', () => {
  it('assigns stable ids m1..mN when absent', () => {
    const r = normaliseIntake(messages(3));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('keeps provided ids', () => {
    const r = normaliseIntake([{ id: 'a1', text: 'x' }, { id: 'b_2', text: 'y' }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.messages.map((m) => m.id)).toEqual(['a1', 'b_2']);
  });

  it('rejects duplicate ids', () => {
    const r = normaliseIntake([{ id: 'm2', text: 'x' }, { text: 'y' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_id');
  });

  it('rejects ids that are not pointer-safe', () => {
    const r = normaliseIntake([{ id: 'a:b', text: 'x' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_id');
  });
});

describe('review fixes (M2 review 0546)', () => {
  it('rejects other Unicode format characters (\\p{Cf}) such as U+180E and tag characters', () => {
    for (const cp of [0x180e, 0x206a, 0xfff9, 0xe0041]) {
      const r = normaliseIntake([{ text: `Rent ${String.fromCodePoint(cp)}is 1200` }]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('forbidden_char');
    }
  });
  it('rejects whitespace runs longer than MAX_WHITESPACE_RUN', () => {
    const ok = normaliseIntake([{ text: `a${' '.repeat(MAX_WHITESPACE_RUN)}b` }]);
    expect(ok.ok).toBe(true);
    const bad = normaliseIntake([{ text: `a${' '.repeat(MAX_WHITESPACE_RUN + 1)}b` }]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('whitespace_run');
  });
});
