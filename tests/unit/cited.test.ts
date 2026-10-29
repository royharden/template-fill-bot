// M2: source pointers (PLAN sections 4.4, 6 M2). Written in Dirty Mode; not yet run (DV-TESTS).
import { describe, expect, it } from 'vitest';
import {
  findOccurrences,
  formatPointer,
  groundQuote,
  parsePointer,
  resolvePointer,
} from '../../supabase/functions/_shared/fillkit/cited.ts';
import { normaliseIntake } from '../../supabase/functions/_shared/fillkit/normalize.ts';
import type { Intake } from '../../supabase/functions/_shared/fillkit/normalize.ts';

const EMOJI = String.fromCodePoint(0x1f600);

function intake(...texts: string[]): Intake {
  const r = normaliseIntake(texts.map((text) => ({ text })));
  if (!r.ok) throw new Error(`test intake invalid: ${r.error.code}`);
  return r;
}

describe('formatPointer / parsePointer', () => {
  it('round-trips', () => {
    const p = formatPointer('m1', 3, 9);
    expect(p).toBe('msg:m1:3-9');
    expect(parsePointer(p)).toEqual({ message_id: 'm1', start: 3, end: 9 });
  });

  it.each([
    'msg:m1:5-5',
    'msg:m1:6-5',
    'msg:m1:01-5',
    'msg:m1:-1-5',
    'msg:m 1:0-5',
    'msg:m1:0-5 ',
    ' msg:m1:0-5',
    'msg:m1:1.5-3',
    'msg::0-5',
    'msg:m1:0-',
    'm1:0-5',
    'msg:m1:0-9999999999',
  ])('rejects %j', (bad) => {
    expect(parsePointer(bad)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(parsePointer(42)).toBeNull();
    expect(parsePointer(null)).toBeNull();
    expect(parsePointer({ message_id: 'm1', start: 0, end: 1 })).toBeNull();
  });

  it('formatPointer refuses invalid parts', () => {
    expect(() => formatPointer('m1', 5, 5)).toThrow();
    expect(() => formatPointer('m1', -1, 2)).toThrow();
    expect(() => formatPointer('a:b', 0, 2)).toThrow();
    expect(() => formatPointer('m1', 0.5, 2)).toThrow();
  });
});

describe('resolvePointer', () => {
  const it1 = intake(`a${EMOJI}b`, 'second message');

  it('resolves UTF-16 offsets, astral characters counting as 2', () => {
    expect(resolvePointer(it1, 'msg:m1:0-1')).toBe('a');
    expect(resolvePointer(it1, 'msg:m1:1-3')).toBe(EMOJI);
    expect(resolvePointer(it1, 'msg:m1:3-4')).toBe('b');
    expect(resolvePointer(it1, 'msg:m2:0-6')).toBe('second');
  });

  it('refuses pointers that split a surrogate pair', () => {
    expect(resolvePointer(it1, 'msg:m1:1-2')).toBeNull();
    expect(resolvePointer(it1, 'msg:m1:2-4')).toBeNull();
  });

  it('refuses out-of-range, unknown-message and malformed pointers', () => {
    expect(resolvePointer(it1, 'msg:m1:0-5')).toBeNull();
    expect(resolvePointer(it1, 'msg:m9:0-1')).toBeNull();
    expect(resolvePointer(it1, 'msg:m1:2-1')).toBeNull();
    expect(resolvePointer(it1, 'garbage')).toBeNull();
  });

  it('accepts a parsed Pointer object', () => {
    expect(resolvePointer(it1, { message_id: 'm2', start: 7, end: 14 })).toBe('message');
  });
});

describe('findOccurrences', () => {
  it('finds every occurrence, overlapping included', () => {
    expect(findOccurrences('abab', 'ab')).toEqual([0, 2]);
    expect(findOccurrences('aaa', 'aa')).toEqual([0, 1]);
    expect(findOccurrences('abc', 'x')).toEqual([]);
    expect(findOccurrences('abc', '')).toEqual([]);
  });
});

describe('groundQuote', () => {
  const it2 = intake('Rent is £1,200.', 'Rent might be £1,250 actually.', `${EMOJI} deposit £900`);

  it('grounds a unique quote without a pointer', () => {
    const r = groundQuote(it2, '£1,250');
    expect(r).toEqual({ ok: true, pointer: 'msg:m2:14-20', message_id: 'm2', start: 14, end: 20 });
  });

  it('uses UTF-16 offsets after an astral character', () => {
    const r = groundQuote(it2, '£900');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.start).toBe(11);
      expect(r.pointer).toBe('msg:m3:11-15');
      expect(resolvePointer(it2, r.pointer)).toBe('£900');
    }
  });

  it('requires a pointer for a repeated substring', () => {
    expect(groundQuote(it2, 'Rent')).toEqual({ ok: false, reason: 'ambiguous_occurrence' });
    const withPointer = groundQuote(it2, 'Rent', 'msg:m2:0-4');
    expect(withPointer.ok).toBe(true);
    if (withPointer.ok) expect(withPointer.message_id).toBe('m2');
  });

  it('rejects a pointer whose text differs from the quote', () => {
    expect(groundQuote(it2, 'Rent', 'msg:m2:1-5')).toEqual({ ok: false, reason: 'quote_mismatch' });
    expect(groundQuote(it2, '£1,200', 'msg:m2:14-20')).toEqual({ ok: false, reason: 'quote_mismatch' });
  });

  it('rejects malformed and unresolvable pointers', () => {
    expect(groundQuote(it2, 'Rent', 'msg:m2:4-0')).toEqual({ ok: false, reason: 'bad_pointer' });
    expect(groundQuote(it2, 'Rent', 'msg:m7:0-4')).toEqual({ ok: false, reason: 'unresolvable_pointer' });
    expect(groundQuote(it2, 'Rent', 'msg:m1:0-400')).toEqual({ ok: false, reason: 'unresolvable_pointer' });
  });

  it('rejects quotes that are absent or empty', () => {
    expect(groundQuote(it2, '£9,999')).toEqual({ ok: false, reason: 'not_found' });
    expect(groundQuote(it2, '')).toEqual({ ok: false, reason: 'empty_quote' });
    expect(groundQuote(it2, 42)).toEqual({ ok: false, reason: 'empty_quote' });
  });
});
