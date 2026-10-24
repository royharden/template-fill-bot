import { deflateSync, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { utf8Encode } from '../../src/core/index.ts';
import { inspectZip } from '../../supabase/functions/_shared/fillkit/gate/docxRead.ts';
import { deflateExpandedSize } from '../../supabase/functions/_shared/fillkit/gate/deflateSize.ts';
import { readDocumentXml } from '../../supabase/functions/_shared/fillkit/gate/xmlTokens.ts';
import { ZIP_LIMITS } from '../../supabase/functions/_shared/fillkit/gate/docxVocabulary.v1.ts';
import { changePart, forgedZip, gateFixture, rejected, text } from './helpers.ts';

describe('M4 closed DOCX XML and ZIP safety (source only)', () => {
  it.each([
    ['comment','<!-- hidden comment -->'],
    ['insert','<w:ins><w:r><w:t xml:space="preserve">hidden</w:t></w:r></w:ins>'],
    ['delete','<w:del><w:r><w:t xml:space="preserve">hidden</w:t></w:r></w:del>'],
    ['textbox','<w:txbxContent><w:p/></w:txbxContent>'],
    ['field','<w:fldSimple w:instr="HYPERLINK evil"/>'],
    ['instruction','<w:instrText>evil</w:instrText>'],
    ['chunk','<w:altChunk/>'],
    ['break','<w:br/>'],
    ['unknown','<w:unknown/>'],
    ['hidden','<w:rPr><w:vanish/></w:rPr>'],
  ])('rejects %s markup', async (_label, markup) => {
    const { input } = await gateFixture();
    expect(rejected(changePart(input,'word/document.xml', (xml) => xml.replace('</w:r>',markup + '</w:r>'))).some((c) => c.startsWith('docx_'))).toBe(true);
  });
  it.each([
    '<!DOCTYPE w:document [<!ENTITY injected "hidden">]>',
    '<!ENTITY injected SYSTEM "https://invalid.example/never-fetched">',
    '<!DOCTYPE w:document SYSTEM "file:///never-read">',
  ])('rejects declaration %s without resolving it', async (declaration) => {
    const { input } = await gateFixture();
    expect(rejected(changePart(input,'word/document.xml', (xml) => xml.replace('?><','?>' + declaration + '<')))).toContain('docx_xml_declaration');
  });
  it('rejects altered namespace bindings, extra namespace declarations and attributes', async () => {
    const { input } = await gateFixture();
    expect(rejected(changePart(input,'word/document.xml', (xml) => xml.replace('2006/main','2006/evil')))).toContain('docx_xml_namespace_or_structure');
    expect(rejected(changePart(input,'word/document.xml', (xml) => xml.replace('<w:body>','<w:body xmlns:x="urn:unknown">')))).toContain('docx_xml_namespace_or_structure');
    expect(rejected(changePart(input,'word/document.xml', (xml) => xml.replace('<w:r>','<w:r w:vanish="true">')))).toContain('docx_xml_run_vocabulary');
  });
  it('rejects added header/comment parts, external relationships and embedded relationships', async () => {
    const { input } = await gateFixture();
    for (const name of ['word/header1.xml','word/comments.xml','word/footnotes.xml','word/embeddings/object.bin']) {
      expect(rejected(changePart(input,name, () => '<extra/>'))).toContain('docx_docx_parts');
    }
    expect(rejected(changePart(input,'word/_rels/document.xml.rels', (xml) => xml.replace('Target="styles.xml"','Target="https://invalid.example/x" TargetMode="External"')))).toContain('docx_docx_fixed_vocabulary');
    expect(rejected(changePart(input,'_rels/.rels', (xml) => xml.replace('word/document.xml','word/embeddings/object.bin')))).toContain('docx_docx_fixed_vocabulary');
  });
  it('decodes only predefined and valid numeric entities and concatenates runs', async () => {
    const { input } = await gateFixture();
    const original = text(unzipSync(input.docxBytes)['word/document.xml']);
    const numeric = original.replace('Residential','&#82;esidential');
    expect(readDocumentXml(numeric)[0].text).toContain('Residential');
    for (const bad of ['&unknown;','&#0;','&#xD800;','&#x110000;','&amp']) expect(() => readDocumentXml(original.replace('Residential',bad))).toThrow();
    const split = original.replace('Residential','Res</w:t></w:r><w:r><w:t xml:space="preserve">idential');
    expect(readDocumentXml(split)).toEqual(readDocumentXml(original));
  });
  it('validates stored, fixed-Huffman and dynamic-Huffman streams before inflation', async () => {
    const { input } = await gateFixture();
    const parts = unzipSync(input.docxBytes);
    for (const level of [0,1,6,9] as const) {
      const compressed = zipSync(parts, { level, mtime: new Date(1980,0,1) });
      expect(rejectedOrGreen({ ...input, docxBytes:compressed })).toEqual([]);
    }
    const values = ['', 'small fixed bytes', 'A'.repeat(100000), Array.from({length:10000},(_,i) => String(i % 137)).join(',')];
    for (const value of values) for (const level of [0,1,6,9] as const) {
      const bytes = utf8Encode(value);
      expect(deflateExpandedSize(deflateSync(bytes,{level}), ZIP_LIMITS.entry)).toBe(bytes.length);
    }
  });
  it('refuses count, per-entry and total declared bombs from tiny headers', () => {
    const many = forgedZip(Array.from({length:33},(_,i) => ({name:`p${i}`})));
    expect(many.length).toBeLessThan(4096);
    expect(() => inspectZip(many)).toThrow('zip_count_limit');
    const entry = forgedZip([{name:'huge.xml',declared:ZIP_LIMITS.entry + 1}]);
    expect(entry.length).toBeLessThan(256);
    expect(() => inspectZip(entry)).toThrow('zip_entry_limit');
    const total = forgedZip(Array.from({length:3},(_,i) => ({name:`p${i}`,declared:2 * 1024 * 1024})));
    expect(total.length).toBeLessThan(1024);
    expect(() => inspectZip(total)).toThrow('zip_total_limit');
  });
  it('rejects lying sizes and actual expanded bombs before fflate allocates output', () => {
    expect(() => inspectZip(forgedZip([{name:'p',data:utf8Encode('abc'),declared:1}]))).toThrow('zip_size_mismatch');
    const bomb = deflateSync(new Uint8Array(ZIP_LIMITS.entry + 1),{level:9});
    expect(bomb.length).toBeLessThan(16384);
    expect(() => inspectZip(forgedZip([{name:'p',method:8,data:bomb,declared:1}]))).toThrow('zip_entry_limit');
    const ordinary = deflateSync(utf8Encode('hello hello hello'),{level:6});
    expect(() => inspectZip(forgedZip([{name:'p',method:8,data:ordinary,declared:1}]))).toThrow('zip_size_mismatch');
  });
  it.each(['../evil','word/../evil','/absolute','C:/absolute','word\\evil','word//evil','./evil'])('rejects path %s', (name) => {
    expect(() => inspectZip(forgedZip([{name}]))).toThrow('zip_path');
  });
  it('rejects duplicate names, mismatched local/central names, trailing data, corruption and oversized compressed input', async () => {
    expect(() => inspectZip(forgedZip([{name:'same'},{name:'same'}]))).toThrow('zip_duplicate');
    expect(() => inspectZip(forgedZip([{name:'a',localName:'b'}]))).toThrow('zip_local_mismatch');
    const { input } = await gateFixture();
    const trailing = new Uint8Array(input.docxBytes.length+1); trailing.set(input.docxBytes);
    expect(() => inspectZip(trailing)).toThrow('zip_end');
    expect(() => inspectZip(new Uint8Array(ZIP_LIMITS.compressed+1))).toThrow('zip_input_limit');
    const corrupt = input.docxBytes.slice();
    const firstNameLength = new DataView(corrupt.buffer).getUint16(26,true);
    corrupt[30+firstNameLength] ^= 1;
    expect(rejected({ ...input,docxBytes:corrupt })).toContain('docx_zip_actual_mismatch');
    expect(() => inspectZip(forgedZip([{name:'p',method:8,data:new Uint8Array([7]),declared:0}]))).toThrow('zip_deflate_block');
  });
});

// A positive helper, separate from rejected(), for accepted DEFLATE packaging variants.
import { gateBundle } from '../../supabase/functions/_shared/fillkit/gate/gate.ts';
import type { GateInput } from '../../supabase/functions/_shared/fillkit/gate/gate.ts';
function rejectedOrGreen(input: GateInput): readonly unknown[] { return gateBundle(input).failures; }
