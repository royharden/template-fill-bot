import { GateReadError } from './xmlTokens.ts';
import type { ReadParagraph } from './xmlTokens.ts';
import { utf8Read } from './docxRead.ts';
/** Closed Markdown vocabulary: canonical escaped plain paragraphs, title and H1 only. */
export function readMarkdown(bytes: Uint8Array): ReadParagraph[] {
  const text = utf8Read(bytes);
  if (bytes.length > 2 * 1024 * 1024 || text.startsWith('\ufeff') || text.includes('\r') || !text.endsWith('\n')) throw new GateReadError('md_encoding');
  const parts = text.slice(0, -1).split('\n\n');
  if (parts.length > 1024) throw new GateReadError('md_paragraph_limit');
  return parts.map((part) => {
    let style = 'Normal';
    if (part.startsWith('## ')) { style = 'Heading1'; part = part.slice(3); }
    else if (part.startsWith('# ')) { style = 'Title'; part = part.slice(2); }
    if (!part || part.includes('\n') || /^(?:[-+=>]|[0-9]+[.)])/.test(part)) throw new GateReadError('md_structure');
    let plain = '';
    for (let i = 0; i < part.length; i++) {
      const c = part[i];
      if (c === '\\') {
        const next = part[++i];
        if (next === undefined || !/[!-/:-@[-`{-~]/.test(next)) throw new GateReadError('md_escape');
        plain += next;
      } else {
        if (/[`*_{}[\]<>|~&#]/.test(c)) throw new GateReadError('md_unescaped_markup');
        plain += c;
      }
    }
    if (plain.includes('{{') || plain.includes('}}')) throw new GateReadError('leftover_placeholder');
    return { style, text: plain };
  });
}
