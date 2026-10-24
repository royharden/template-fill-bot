import { describe, expect, it } from 'vitest';
import { CanonicalJsonError, canonicalJson } from '../../supabase/functions/_shared/fillkit/canonicalJson.ts';

describe('canonicalJson: output shape', () => {
  it('serialises scalars like JSON', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(0)).toBe('0');
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson(1.5)).toBe('1.5');
    expect(canonicalJson('a"b\\c\n')).toBe('"a\\"b\\\\c\\n"');
    expect(canonicalJson('£ café')).toBe('"£ café"');
  });

  it('sorts object keys recursively and uses no whitespace', () => {
    const value = { b: 1, a: { d: [3, 2, 1], c: 'x' } };
    expect(canonicalJson(value)).toBe('{"a":{"c":"x","d":[3,2,1]},"b":1}');
  });

  it('is independent of key insertion order', () => {
    const one = { z: 1, y: { b: 2, a: 1 }, x: [{ q: 1, p: 2 }] };
    const two = { x: [{ p: 2, q: 1 }], y: { a: 1, b: 2 }, z: 1 };
    expect(canonicalJson(one)).toBe(canonicalJson(two));
  });

  it('keeps array order (arrays are ordered data)', () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it('sorts keys by UTF-16 code unit order', () => {
    expect(canonicalJson({ b: 1, B: 2, a: 3, 'é': 4 })).toBe('{"B":2,"a":3,"b":1,"é":4}');
  });

  it('accepts null-prototype objects', () => {
    const obj = Object.create(null) as Record<string, unknown>;
    obj.k = 'v';
    expect(canonicalJson(obj)).toBe('{"k":"v"}');
  });

  it('allows the same object twice when it is not a cycle', () => {
    const shared = { a: 1 };
    expect(canonicalJson({ x: shared, y: shared })).toBe('{"x":{"a":1},"y":{"a":1}}');
  });

  it('is deterministic across calls', () => {
    const value = { id: 'parties', placeholders: [{ name: 'landlord', kind: 'name' }], order: 10 };
    expect(canonicalJson(value)).toBe(canonicalJson(structuredClone(value)));
  });
});

function holeyArray(): unknown[] {
  const arr: unknown[] = [1, 2, 3];
  delete arr[1];
  return arr;
}

describe('canonicalJson: rejections', () => {
  const rejected: ReadonlyArray<readonly [string, unknown]> = [
    ['top-level undefined', undefined],
    ['undefined object value', { a: undefined }],
    ['undefined array element', [1, undefined]],
    ['array hole', holeyArray()],
    ['function', { f: () => 1 }],
    ['symbol value', { s: Symbol('x') }],
    ['bigint', { n: BigInt(1) }],
    ['NaN', { n: Number.NaN }],
    ['Infinity', [Number.POSITIVE_INFINITY]],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['Date', { d: new Date(0) }],
    ['Map', new Map([['a', 1]])],
    ['Set', new Set([1])],
    ['typed array', new Uint8Array([1])],
    ['class instance', new (class Thing { x = 1 })()],
  ];

  for (const [name, value] of rejected) {
    it(`rejects ${name}`, () => {
      expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
    });
  }

  it('rejects symbol keys', () => {
    const obj: Record<string | symbol, unknown> = { a: 1 };
    obj[Symbol('k')] = 2;
    expect(() => canonicalJson(obj)).toThrow(CanonicalJsonError);
  });

  it('rejects cycles', () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    expect(() => canonicalJson(obj)).toThrow(CanonicalJsonError);
    const arr: unknown[] = [];
    arr.push(arr);
    expect(() => canonicalJson(arr)).toThrow(CanonicalJsonError);
  });

  it('names the path of the offending value', () => {
    try {
      canonicalJson({ a: [{ b: undefined }] });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CanonicalJsonError);
      expect((error as CanonicalJsonError).path).toBe('$.a[0].b');
    }
  });
});
