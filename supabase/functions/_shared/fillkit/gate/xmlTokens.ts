// Namespace-aware, bounded tokenizer for the closed WordprocessingML document grammar.
import { WORD_NS, SECTION_XML } from './docxVocabulary.v1.ts';
export interface ReadParagraph { readonly style: string; readonly text: string }
export class GateReadError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'GateReadError'; this.code = code; }
}
export function decodeXml(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== '&') { out += c; continue; }
    const end = text.indexOf(';', i + 1);
    if (end < 0 || end - i > 12) throw new GateReadError('xml_entity');
    const e = text.slice(i + 1, end);
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', apos: "'", quot: '"' };
    if (Object.hasOwn(named, e)) out += named[e];
    else {
      if (!/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(e)) throw new GateReadError('xml_entity');
      const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      if (!(n === 9 || n === 10 || n === 13 || (n >= 32 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) && n !== 0xfffe && n !== 0xffff))) throw new GateReadError('xml_character');
      out += String.fromCodePoint(n);
    }
    i = end;
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(out)) throw new GateReadError('xml_character');
  return out;
}

/** Strict grammar closes element location as well as element names: no hidden text in unused branches. */
export function readDocumentXml(xml: string): ReadParagraph[] {
  if (/<!|<!--|\]\]>/.test(xml)) throw new GateReadError('xml_declaration');
  const prefix = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${WORD_NS}"><w:body>`;
  const suffix = `${SECTION_XML}</w:body></w:document>`;
  if (!xml.startsWith(prefix) || !xml.endsWith(suffix)) throw new GateReadError('xml_namespace_or_structure');
  const body = xml.slice(prefix.length, -suffix.length);
  const paragraphs: ReadParagraph[] = [];
  let pos = 0;
  while (pos < body.length) {
    if (paragraphs.length >= 1024) throw new GateReadError('xml_paragraph_limit');
    const start = /^<w:p><w:pPr><w:pStyle w:val="(Title|Heading1|Normal|Appendix)"\/><\/w:pPr>/.exec(body.slice(pos));
    if (start === null) throw new GateReadError('xml_paragraph_vocabulary');
    pos += start[0].length;
    let text = '';
    let runs = 0;
    while (!body.startsWith('</w:p>', pos)) {
      if (++runs > 4096 || !body.startsWith('<w:r>', pos)) throw new GateReadError('xml_run_vocabulary');
      pos += 5;
      let count = 0;
      while (!body.startsWith('</w:r>', pos)) {
        if (++count > 4096) throw new GateReadError('xml_token_limit');
        if (body.startsWith('<w:tab/>', pos)) { text += '\t'; pos += 8; continue; }
        const open = '<w:t xml:space="preserve">';
        if (!body.startsWith(open, pos)) throw new GateReadError('xml_text_vocabulary');
        const end = body.indexOf('</w:t>', pos + open.length);
        if (end < 0) throw new GateReadError('xml_unclosed_text');
        const raw = body.slice(pos + open.length, end);
        if (raw.includes('<')) throw new GateReadError('xml_text_markup');
        text += decodeXml(raw);
        pos = end + 6;
      }
      pos += 6;
    }
    pos += 6;
    paragraphs.push({ style: start[1], text });
  }
  return paragraphs;
}
