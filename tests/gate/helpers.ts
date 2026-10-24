// M4 source-only fixtures. Helpers exercise public final-byte APIs after activation; never run in Dirty Mode.
import { unzipSync, zipSync } from 'fflate';
import type { Zippable } from 'fflate';
import { buildDraft, canonicalJson, utf8Encode } from '../../src/core/index.ts';
import type { MatterState, Provenance } from '../../src/core/index.ts';
import { gateBundle } from '../../supabase/functions/_shared/fillkit/gate/gate.ts';
import type { GateInput } from '../../supabase/functions/_shared/fillkit/gate/gate.ts';
import { writeDocx } from '../../supabase/functions/_shared/docx/writeDocx.ts';
import { LIBRARY_CONTENT } from '../../supabase/functions/_shared/fillkit/library.ts';
import { TEST_LOCK, answerAll, extractScenario, loadJson } from '../unit/m3Helpers.ts';
import type { DemoFixture } from '../unit/m3Helpers.ts';

export async function resolvedDemo(name = 'demo-01.json'): Promise<MatterState> {
  const f = loadJson<DemoFixture>(name);
  return answerAll(await extractScenario(f), f.expected.answers);
}
export async function gateFixture(name = 'demo-01.json'): Promise<{ input: GateInput; state: MatterState; provenance: Provenance }> {
  const state = await resolvedDemo(name);
  const draft = buildDraft(state, { lock: TEST_LOCK, matterId: 'invented-matter' });
  if (!draft.ok) throw new Error(draft.reasons.join(','));
  return { state, provenance: draft.provenance, input: { content: LIBRARY_CONTENT, lock: TEST_LOCK, provenanceBytes: draft.provenanceBytes, markdownBytes: utf8Encode(draft.markdown), docxBytes: writeDocx(draft.paragraphs) } };
}
export function text(bytes: Uint8Array): string { return new TextDecoder().decode(bytes); }
export function mutateProvenance(input: GateInput, edit: (p: Provenance) => unknown): GateInput {
  const p = JSON.parse(text(input.provenanceBytes)) as Provenance;
  const changed = edit(p) ?? p;
  return { ...input, provenanceBytes: utf8Encode(canonicalJson(changed)) };
}
export function changePart(input: GateInput, name: string, edit: (xml: string) => string): GateInput {
  const parts = unzipSync(input.docxBytes);
  parts[name] = utf8Encode(edit(parts[name] === undefined ? '' : text(parts[name])));
  const files: Zippable = {};
  for (const [key, value] of Object.entries(parts)) files[key] = [value, { mtime: new Date(1980,0,1), level: 0 }];
  return { ...input, docxBytes: zipSync(files, { level: 0 }) };
}
export function rejected(input: GateInput): string[] {
  const result = gateBundle(input);
  if (result.ok) throw new Error('mutation unexpectedly passed');
  return result.failures.map((f) => f.code);
}

/** Tiny forged archive builder: declared sizes need no corresponding allocation. CRC omitted intentionally.
 * It enables tests to distinguish preflight limit failures from inflate/CRC errors. */
export function forgedZip(entries: readonly { name: string; declared?: number; data?: Uint8Array; method?: number; localName?: string }[]): Uint8Array {
  const locals: Uint8Array[] = [], centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = utf8Encode(e.name), localName = utf8Encode(e.localName ?? e.name), data = e.data ?? new Uint8Array();
    const local = new Uint8Array(30 + localName.length + data.length), l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4,20,true); l.setUint16(8,e.method ?? 0,true); l.setUint32(18,data.length,true); l.setUint32(22,e.declared ?? data.length,true); l.setUint16(26,localName.length,true);
    local.set(localName,30); local.set(data,30 + localName.length);
    const central = new Uint8Array(46 + name.length), c = new DataView(central.buffer);
    c.setUint32(0,0x02014b50,true); c.setUint16(4,20,true); c.setUint16(6,20,true); c.setUint16(10,e.method ?? 0,true); c.setUint32(20,data.length,true); c.setUint32(24,e.declared ?? data.length,true); c.setUint16(28,name.length,true); c.setUint32(42,offset,true); central.set(name,46);
    locals.push(local); centrals.push(central); offset += local.length;
  }
  const centralSize = centrals.reduce((s,v) => s+v.length,0), end = new Uint8Array(22), d = new DataView(end.buffer);
  d.setUint32(0,0x06054b50,true); d.setUint16(8,entries.length,true); d.setUint16(10,entries.length,true); d.setUint32(12,centralSize,true); d.setUint32(16,offset,true);
  const all = [...locals,...centrals,end], bytes = new Uint8Array(offset + centralSize + 22);
  let p = 0; for (const b of all) { bytes.set(b,p); p += b.length; }
  return bytes;
}
