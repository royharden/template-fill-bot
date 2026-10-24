// Allocation-free RFC1951 length preflight. No output buffer is allocated until actual length is proved.
import { GateReadError } from './xmlTokens.ts';
const LEN = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
const LEX = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
const DIST = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
const DEX = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
type Tree = { readonly codes: ReadonlyMap<number, number>; readonly max: number };
function tree(lengths: readonly number[]): Tree {
  const counts = Array<number>(16).fill(0);
  for (const n of lengths) { if (n < 0 || n > 15) throw new GateReadError('zip_deflate_tree'); counts[n]++; }
  let left = 1;
  for (let n = 1; n <= 15; n++) { left = left * 2 - counts[n]; if (left < 0) throw new GateReadError('zip_deflate_tree'); }
  const next = Array<number>(16).fill(0);
  let c = 0;
  for (let n = 1; n <= 15; n++) { c = (c + (n === 1 ? 0 : counts[n - 1])) << 1; next[n] = c; }
  const codes = new Map<number, number>();
  let max = 0;
  lengths.forEach((n, sym) => {
    if (!n) return;
    const v = next[n]++;
    // Huffman codes are read MSB first, although other DEFLATE bit fields are LSB first.
    codes.set((1 << n) + v, sym); max = Math.max(max, n);
  });
  return { codes, max };
}
export function deflateExpandedSize(bytes: Uint8Array, limit: number): number {
  let bit = 0;
  const read = (n: number): number => {
    if (bit + n > bytes.length * 8) throw new GateReadError('zip_deflate_truncated');
    let v = 0;
    for (let i = 0; i < n; i++, bit++) v |= ((bytes[bit >>> 3] >>> (bit & 7)) & 1) << i;
    return v;
  };
  const symbol = (t: Tree): number => {
    let c = 0;
    for (let n = 1; n <= t.max; n++) { c = c * 2 + read(1); const s = t.codes.get((1 << n) + c); if (s !== undefined) return s; }
    throw new GateReadError('zip_deflate_code');
  };
  let output = 0;
  let final = 0;
  do {
    final = read(1);
    const kind = read(2);
    if (kind === 0) {
      bit = Math.ceil(bit / 8) * 8;
      const n = read(16);
      if ((n ^ read(16)) !== 65535) throw new GateReadError('zip_deflate_stored');
      if (bit + n * 8 > bytes.length * 8) throw new GateReadError('zip_deflate_truncated');
      bit += n * 8; output += n;
    } else {
      let literal: Tree;
      let distance: Tree;
      if (kind === 1) {
        literal = tree(Array.from({ length: 288 }, (_, n) => n < 144 ? 8 : n < 256 ? 9 : n < 280 ? 7 : 8));
        distance = tree(Array<number>(32).fill(5));
      } else if (kind === 2) {
        const nl = read(5) + 257, nd = read(5) + 1, nc = read(4) + 4;
        if (nl > 286 || nd > 32) throw new GateReadError('zip_deflate_tree');
        const actualOrder = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
        const cl = Array<number>(19).fill(0);
        for (let i = 0; i < nc; i++) cl[actualOrder[i]] = read(3);
        const ct = tree(cl), lengths: number[] = [];
        while (lengths.length < nl + nd) {
          const s = symbol(ct);
          if (s < 16) lengths.push(s);
          else {
            if (s === 16 && lengths.length === 0) throw new GateReadError('zip_deflate_repeat');
            const n = s === 16 ? read(2) + 3 : s === 17 ? read(3) + 3 : read(7) + 11;
            if (lengths.length + n > nl + nd) throw new GateReadError('zip_deflate_repeat');
            const v = s === 16 ? lengths[lengths.length - 1] : 0;
            for (let j = 0; j < n; j++) lengths.push(v);
          }
        }
        if (!lengths[256]) throw new GateReadError('zip_deflate_end');
        literal = tree(lengths.slice(0, nl)); distance = tree(lengths.slice(nl));
      } else throw new GateReadError('zip_deflate_block');
      for (;;) {
        const s = symbol(literal);
        if (s === 256) break;
        if (s < 256) output++;
        else {
          if (s < 257 || s > 285) throw new GateReadError('zip_deflate_length');
          const n = LEN[s - 257] + read(LEX[s - 257]);
          const ds = symbol(distance);
          if (ds > 29) throw new GateReadError('zip_deflate_distance');
          const d = DIST[ds] + read(DEX[ds]);
          if (d > output) throw new GateReadError('zip_deflate_distance');
          output += n;
        }
        if (output > limit) throw new GateReadError('zip_entry_limit');
      }
    }
    if (output > limit) throw new GateReadError('zip_entry_limit');
  } while (!final);
  if (Math.ceil(bit / 8) !== bytes.length) throw new GateReadError('zip_deflate_trailing');
  return output;
}
