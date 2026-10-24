import { unzipSync } from 'fflate';
import { DOCX_PARTS, FIXED_PARTS, ZIP_LIMITS } from './docxVocabulary.v1.ts';
import { deflateExpandedSize } from './deflateSize.ts';
import { GateReadError, readDocumentXml } from './xmlTokens.ts';
import type { ReadParagraph } from './xmlTokens.ts';
export function utf8Read(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new GateReadError('invalid_utf8'); }
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) { crc ^= b; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
interface Entry { name: string; size: number; crc: number }
/** Preflight every local and central header, then count actual DEFLATE output without allocating it. */
export function inspectZip(bytes: Uint8Array): readonly Entry[] {
  if (bytes.length > ZIP_LIMITS.compressed || bytes.length < 22) throw new GateReadError('zip_input_limit');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (p: number): number => { if (p < 0 || p + 2 > bytes.length) throw new GateReadError('zip_truncated'); return dv.getUint16(p, true); };
  const u32 = (p: number): number => { if (p < 0 || p + 4 > bytes.length) throw new GateReadError('zip_truncated'); return dv.getUint32(p, true); };
  const end = bytes.length - 22;
  if (u32(end) !== 0x06054b50 || u16(end + 4) !== 0 || u16(end + 6) !== 0 || u16(end + 20) !== 0) throw new GateReadError('zip_end');
  const count = u16(end + 10), centralSize = u32(end + 12), central = u32(end + 16);
  if (count > ZIP_LIMITS.entries) throw new GateReadError('zip_count_limit');
  if (u16(end + 8) !== count || central + centralSize !== end) throw new GateReadError('zip_central');
  let pos = central, localEnd = 0, total = 0;
  const seen = new Set<string>(), entries: Entry[] = [];
  const pending: { data: Uint8Array; method: number; size: number }[] = [];
  for (let i = 0; i < count; i++) {
    if (u32(pos) !== 0x02014b50) throw new GateReadError('zip_central');
    const flags = u16(pos + 8), method = u16(pos + 10), crc = u32(pos + 16), compressed = u32(pos + 20), size = u32(pos + 24);
    const nl = u16(pos + 28), extra = u16(pos + 30), comment = u16(pos + 32), local = u32(pos + 42);
    if (pos + 46 + nl + extra + comment > end || nl > 128 || extra !== 0 || comment !== 0 || u16(pos + 34) !== 0 || (flags & ~0x800) !== 0 || (method !== 0 && method !== 8)) throw new GateReadError('zip_header');
    const name = utf8Read(bytes.subarray(pos + 46, pos + 46 + nl));
    if (name.startsWith('/') || name.includes('\\') || name.includes(':') || name.split('/').some((p) => p === '..' || p === '' || p === '.') || /\0/.test(name)) throw new GateReadError('zip_path');
    if (seen.has(name)) throw new GateReadError('zip_duplicate');
    seen.add(name);
    if (size > ZIP_LIMITS.entry) throw new GateReadError('zip_entry_limit');
    total += size; if (total > ZIP_LIMITS.total) throw new GateReadError('zip_total_limit');
    if (local !== localEnd || u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method || u32(local + 14) !== crc || u32(local + 18) !== compressed || u32(local + 22) !== size || u16(local + 26) !== nl || u16(local + 28) !== 0) throw new GateReadError('zip_local_mismatch');
    if (utf8Read(bytes.subarray(local + 30, local + 30 + nl)) !== name) throw new GateReadError('zip_local_mismatch');
    localEnd = local + 30 + nl + compressed;
    if (localEnd > central) throw new GateReadError('zip_overlap');
    const data = bytes.subarray(local + 30 + nl, localEnd);
    pending.push({ data, method, size });
    entries.push({ name, size, crc }); pos += 46 + nl + extra + comment;
  }
  if (pos !== end || localEnd !== central) throw new GateReadError('zip_trailing');
  for (const p of pending) {
    const actual = p.method === 0 ? p.data.length : deflateExpandedSize(p.data, ZIP_LIMITS.entry);
    if (actual !== p.size) throw new GateReadError('zip_size_mismatch');
  }
  return entries;
}
export function readDocx(bytes: Uint8Array): ReadParagraph[] {
  const entries = inspectZip(bytes);
  if (entries.length !== DOCX_PARTS.length || entries.some((e) => !(DOCX_PARTS as readonly string[]).includes(e.name))) throw new GateReadError('docx_parts');
  let count = 0, total = 0;
  const expanded = unzipSync(bytes, { filter: (f) => {
    if (++count > ZIP_LIMITS.entries || f.originalSize > ZIP_LIMITS.entry || (total += f.originalSize) > ZIP_LIMITS.total) throw new GateReadError('zip_filter_limit');
    return true;
  } });
  let actualTotal = 0;
  for (const e of entries) {
    const b = expanded[e.name];
    if (b === undefined || b.length !== e.size || b.length > ZIP_LIMITS.entry || (actualTotal += b.length) > ZIP_LIMITS.total || crc32(b) !== e.crc) throw new GateReadError('zip_actual_mismatch');
    const xml = utf8Read(b);
    if (/<!/.test(xml)) throw new GateReadError('xml_declaration');
    if (e.name !== 'word/document.xml' && xml !== FIXED_PARTS[e.name]) throw new GateReadError('docx_fixed_vocabulary');
  }
  return readDocumentXml(utf8Read(expanded['word/document.xml']));
}
