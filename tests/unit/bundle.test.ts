import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { APP_VERSION, AGREEMENT_FILES, buildBundle, buildDraft, bundleDigest, canonicalJson, sha256Hex, utf8Encode, verifyBundle, writeDocx } from '../../src/core/index.ts';
import { DOCX_PARTS } from '../../supabase/functions/_shared/fillkit/gate/docxVocabulary.v1.ts';
import { inspectZip } from '../../supabase/functions/_shared/fillkit/gate/docxRead.ts';
import { resolvedDemo } from '../gate/helpers.ts';
import { TEST_LOCK } from './m3Helpers.ts';

describe('M4 deterministic writer and bundle digest (source only)', () => {
  it('writes the same seven parts and identical bytes from identical paragraphs', async () => {
    const draft = buildDraft(await resolvedDemo(), { lock:TEST_LOCK });
    if (!draft.ok) throw new Error('draft blocked');
    const a = writeDocx(draft.paragraphs), b = writeDocx(JSON.parse(JSON.stringify(draft.paragraphs)));
    expect(a).toEqual(b);
    expect(inspectZip(a).map((e) => e.name)).toEqual(DOCX_PARTS);
    const parts = unzipSync(a), decoder = new TextDecoder();
    expect(decoder.decode(parts['docProps/core.xml'])).toContain('2000-01-01T00:00:00Z');
    expect(decoder.decode(parts['docProps/core.xml'])).toContain('template-fill-bot');
    expect(decoder.decode(parts['word/document.xml']).match(/<w:p>/g)?.length).toBe(draft.paragraphs.length);
    for (let pos = 0; pos + 30 <= a.length;) {
      const v = new DataView(a.buffer,a.byteOffset,a.byteLength);
      if (v.getUint32(pos,true) !== 0x04034b50) break;
      expect(v.getUint16(pos+10,true)).toBe(0); // 00:00:00 DOS time
      expect(v.getUint16(pos+12,true)).toBe(33); // 1980-01-01 DOS date
      pos += 30 + v.getUint16(pos+26,true) + v.getUint16(pos+28,true) + v.getUint32(pos+18,true);
    }
  });
  it('escapes XML text, preserves segment order, rejects unsupported control characters and styles', () => {
    const make = (text:string) => [{style:'Normal' as const,segments:[{kind:'value' as const,field:'sample',text}]}];
    const xml = new TextDecoder().decode(unzipSync(writeDocx(make('A & B < C "D" \'E\'')))['word/document.xml']);
    expect(xml).toContain('A &amp; B &lt; C &quot;D&quot; &apos;E&apos;');
    for (const bad of ['line\nbreak','tab\tvalue','null\0value','\ud800']) expect(() => writeDocx(make(bad))).toThrow();
    expect(() => writeDocx([{style:'Unknown',segments:[]} ] as never)).toThrow('docx_style');
  });
  it('hashes the exact final files and canonical bundle.json, with key-order-independent manifest digest', async () => {
    const result = buildBundle(await resolvedDemo(), { lock:TEST_LOCK,matterId:'invented-matter' });
    if (!result.ok) throw new Error(result.reasons.join(','));
    const b = result.bundle;
    for (const f of AGREEMENT_FILES) expect(b.manifest.files[f]).toBe(sha256Hex(b.files[f]));
    expect(b.files['bundle.json']).toEqual(utf8Encode(canonicalJson(b.manifest)));
    expect(b.digest).toBe(sha256Hex(b.files['bundle.json']));
    expect(b.manifest.app_version).toBe(APP_VERSION);
    expect(bundleDigest({ ...b.manifest, files:{'provenance.json':b.manifest.files['provenance.json'],'agreement.docx':b.manifest.files['agreement.docx'],'agreement.md':b.manifest.files['agreement.md']} })).toBe(b.digest);
    expect(verifyBundle(b,{lock:TEST_LOCK}).ok).toBe(true);
    const changed = { ...b, files:{...b.files,'agreement.md':utf8Encode('A changed byte\n')} };
    expect(verifyBundle(changed,{lock:TEST_LOCK}).ok).toBe(false);
    expect(bundleDigest({...b.manifest,revision:b.manifest.revision+1})).not.toBe(b.digest);
    expect(bundleDigest({...b.manifest,app_version:'future'})).not.toBe(b.digest);
    expect(bundleDigest({...b.manifest,matter_id:'different'})).not.toBe(b.digest);
  });
  it('is fail closed with the committed UNLOCKED sentinel', async () => {
    expect(buildBundle(await resolvedDemo())).toMatchObject({ok:false,reasons:['library_unlocked']});
  });
});
