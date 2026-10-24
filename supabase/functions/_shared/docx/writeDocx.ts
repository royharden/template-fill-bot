// Minimal deterministic OOXML. Agreement text is supplied only as validated typed paragraphs.
import { zipSync } from 'fflate';
import type { Zippable } from 'fflate';
import type { Paragraph } from '../fillkit/segments.ts';
import { utf8Encode } from '../fillkit/hash.ts';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/package/2006/relationships';
const O = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';

export function escapeXml(text: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(text) || /[\r\n\t]/.test(text)) throw new Error('docx_invalid_text');
  let out = '';
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    if (n >= 0xd800 && n <= 0xdfff) throw new Error('docx_invalid_surrogate');
    out += ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' } as Record<string, string>)[ch] ?? ch;
  }
  return out;
}

/** Seven entries, fixed order/metadata, no timestamps from the current clock. */
export function writeDocx(paragraphs: readonly Paragraph[]): Uint8Array {
  if (paragraphs.length > 1024) throw new Error('docx_paragraph_limit');
  const body = paragraphs.map((p) => {
    if (!['Title', 'Heading1', 'Normal', 'Appendix'].includes(p.style)) throw new Error('docx_style');
    return `<w:p><w:pPr><w:pStyle w:val="${p.style}"/></w:pPr>${p.segments.map((s) => `<w:r><w:t xml:space="preserve">${escapeXml(s.text)}</w:t></w:r>`).join('')}</w:p>`;
  }).join('');
  const parts: Record<string, string> = {
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    '_rels/.rels': `${XML}<Relationships xmlns="${R}"><Relationship Id="rId1" Type="${O}officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${O}extended-properties" Target="docProps/app.xml"/></Relationships>`,
    'word/document.xml': `${XML}<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    'word/styles.xml': `${XML}<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:basedOn w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Appendix"><w:name w:val="Appendix"/><w:basedOn w:val="Normal"/></w:style></w:styles>`,
    'word/_rels/document.xml.rels': `${XML}<Relationships xmlns="${R}"><Relationship Id="rId1" Type="${O}styles" Target="styles.xml"/></Relationships>`,
    'docProps/core.xml': `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>template-fill-bot</dc:creator><cp:lastModifiedBy>template-fill-bot</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">2000-01-01T00:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2000-01-01T00:00:00Z</dcterms:modified></cp:coreProperties>`,
    'docProps/app.xml': `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>template-fill-bot</Application></Properties>`,
  };
  const zip: Zippable = {};
  // Local-time construction keeps the DOS date fixed in every timezone (ZIP dates have no timezone).
  const mtime = new Date(1980, 0, 1, 0, 0, 0);
  for (const [name, xml] of Object.entries(parts)) zip[name] = [utf8Encode(xml), { mtime, level: 0, os: 0, attrs: 0 }];
  return zipSync(zip, { level: 0 });
}
