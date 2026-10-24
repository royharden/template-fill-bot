import { describe, expect, it } from 'vitest';
import { isSha256Hex, sha256Bytes, sha256Hex, toHex, utf8Encode } from '../../supabase/functions/_shared/fillkit/hash.ts';

// FIPS 180-2 / 180-4 SHA-256 example vectors, plus padding-boundary and non-ASCII vectors.
// All expected digests were cross-checked against an independent SHA-256 implementation
// (Windows Get-FileHash -Algorithm SHA256 over the same UTF-8 bytes) when this file was authored.
const FIPS_VECTORS: ReadonlyArray<readonly [string, string, string]> = [
  ['empty string', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['"abc" (one block)', 'abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    '448-bit message (padding spills into a second block)',
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  ],
  [
    '896-bit message (multi-block)',
    'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
    'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
  ],
];

const BOUNDARY_VECTORS: ReadonlyArray<readonly [number, string]> = [
  [55, '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318'],
  [56, 'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a'],
  [63, '7d3e74a05d7db15bce4ad9ec0658ea98e3f06eeecf16b4c6fff2da457ddc2f34'],
  [64, 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb'],
];

// "£1,200 café 🏠": 2-, 2- and 4-byte UTF-8 sequences (18 bytes in total).
const NON_ASCII = '£1,200 café \u{1F3E0}';
const NON_ASCII_BYTES = [
  0xc2, 0xa3, 0x31, 0x2c, 0x32, 0x30, 0x30, 0x20, 0x63, 0x61, 0x66, 0xc3, 0xa9, 0x20, 0xf0, 0x9f, 0x8f, 0xa0,
];
const NON_ASCII_DIGEST = '904bbcefc590d9326ec45994f0ce4631265842b54146ed9d7bfe01fe3757465f';

describe('sha256Hex', () => {
  for (const [name, message, digest] of FIPS_VECTORS) {
    it(`FIPS vector: ${name}`, () => {
      expect(sha256Hex(message)).toBe(digest);
    });
  }

  for (const [length, digest] of BOUNDARY_VECTORS) {
    it(`padding boundary: ${length} x "a"`, () => {
      expect(sha256Hex('a'.repeat(length))).toBe(digest);
    });
  }

  it('FIPS vector: one million "a" (long message)', () => {
    expect(sha256Hex('a'.repeat(1_000_000))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  it('hashes non-ASCII strings as their UTF-8 bytes', () => {
    expect(Array.from(utf8Encode(NON_ASCII))).toEqual(NON_ASCII_BYTES);
    expect(sha256Hex(NON_ASCII)).toBe(NON_ASCII_DIGEST);
    expect(sha256Hex(new Uint8Array(NON_ASCII_BYTES))).toBe(NON_ASCII_DIGEST);
  });

  it('string and byte inputs agree', () => {
    expect(sha256Hex(new Uint8Array([0x61, 0x62, 0x63]))).toBe(sha256Hex('abc'));
    expect(sha256Hex(new Uint8Array(0))).toBe(sha256Hex(''));
  });

  it('is sensitive to a single changed byte', () => {
    expect(sha256Hex('abd')).not.toBe(sha256Hex('abc'));
  });

  it('does not mutate its input', () => {
    const input = new Uint8Array([1, 2, 3]);
    sha256Bytes(input);
    expect(Array.from(input)).toEqual([1, 2, 3]);
  });

  it('always returns 64 lowercase hex characters', () => {
    for (const message of ['', 'abc', NON_ASCII, 'x'.repeat(1000)]) {
      const digest = sha256Hex(message);
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      expect(isSha256Hex(digest)).toBe(true);
    }
  });
});

describe('helpers', () => {
  it('sha256Bytes returns 32 bytes and toHex matches sha256Hex', () => {
    const bytes = sha256Bytes(utf8Encode('abc'));
    expect(bytes.length).toBe(32);
    expect(toHex(bytes)).toBe(sha256Hex('abc'));
  });

  it('toHex pads single-digit bytes', () => {
    expect(toHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe('00010f10ff');
  });

  it('isSha256Hex rejects malformed digests', () => {
    expect(isSha256Hex('A'.repeat(64))).toBe(false);
    expect(isSha256Hex('a'.repeat(63))).toBe(false);
    expect(isSha256Hex(42)).toBe(false);
  });
});
