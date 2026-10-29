// Markdown renderer and render gatekeeping (PLAN section 4.6). Pure.
//
// renderAgreement returns RenderBlocked{reasons} (fail closed) for EVERY cause:
//   - library verification failure, verbatim from verifyLibrary (e.g. `library_unlocked`, `clause_hash_mismatch:<id>`);
//   - `field_<state>:<field>` for every field that is not valid (or none_confirmed, optional fields only);
//   - `validation_failed:<field>:<reason>` for every invalid field (field rule or cross-field rule);
//   - `question_open:<question id>` for every open question;
//   - `document_error:<code>` if the paragraph model cannot be built (e.g. a value carrying `{{`).
// Reasons are sorted: library reasons first (as given), then field reasons in schema order, then questions.
//
// Markdown format (canonical: LF only, UTF-8, no BOM, paragraphs separated by one blank line, final LF):
//   Title -> `# <text>`, Heading1 -> `## <text>`, Normal / Appendix -> `<text>`.
// Every segment's text is escaped with escapeMarkdownText (backslash before \ ` * _ { } [ ] < > | ~ & #);
// a paragraph whose text would start a block construct (`-`, `+`, `=`, `>` or digits then `.` / `)`) gets a
// backslash before that character. The gate (M4) inverts this by removing a backslash before any ASCII
// punctuation character. No raw source quote ever reaches this file: only frame, clause and value segments.
import { verifyLibrary } from './library.ts';
import { FIELD_KEYS } from '../content/types.ts';
import type { ClauseRecord, FieldKey, LibraryContent, LibraryLock, LockedLibraryLock } from '../content/types.ts';
import { FIELD_SPECS } from './fields.ts';
import type { GroundedField } from './grounding.ts';
import { buildQuestions } from './questions.ts';
import type { Question } from './questions.ts';
import { validateFields } from './validate.ts';
import { buildDocument, paragraphText, SegmentError } from './segments.ts';
import type { Paragraph } from './segments.ts';
import { selectClauses } from './select.ts';

export interface RenderBlocked {
  readonly ok: false;
  readonly reasons: readonly string[];
}

export interface RenderedAgreement {
  readonly ok: true;
  readonly paragraphs: readonly Paragraph[];
  readonly markdown: string;
  readonly contentHash: string;
  readonly clauses: readonly ClauseRecord[];
  readonly lock: LockedLibraryLock;
}

export type RenderResult = RenderedAgreement | RenderBlocked;

export interface RenderInput {
  readonly content: LibraryContent;
  readonly lock: LibraryLock;
  /** EFFECTIVE field records (validate.ts). */
  readonly fields: Readonly<Record<FieldKey, GroundedField>>;
  /** Open questions (questions.ts buildQuestions). */
  readonly questions: readonly Question[];
  /** Clause ids of accepted requests (requests.ts). */
  readonly acceptedClauseIds: readonly string[];
  /** Count of Not-included items (requests.ts). */
  readonly notIncludedCount: number;
}

const INLINE_ESCAPE_RE = /[\\`*_{}[\]<>|~&#]/;
const BLOCK_START_RE = /^(?:[-+=>]|[0-9]+[.)])/;

/** Backslash-escape the Markdown-significant characters of one segment's text (character by character). */
export function escapeMarkdownText(text: string): string {
  let out = '';
  for (const ch of text) out += INLINE_ESCAPE_RE.test(ch) ? `\\${ch}` : ch;
  return out;
}

function paragraphMarkdown(p: Paragraph): string {
  let body = '';
  for (const seg of p.segments) body += escapeMarkdownText(seg.text);
  const m = BLOCK_START_RE.exec(body);
  if (m !== null) {
    const at = m[0].length - 1;
    body = `${body.slice(0, at)}\\${body.slice(at)}`;
  }
  switch (p.style) {
    case 'Title':
      return `# ${body}`;
    case 'Heading1':
      return `## ${body}`;
    default:
      return body;
  }
}

/** Canonical Markdown for a paragraph list. */
export function markdownFromParagraphs(paragraphs: readonly Paragraph[]): string {
  return `${paragraphs.map(paragraphMarkdown).join('\n\n')}\n`;
}

/** Every reason the agreement cannot be rendered (empty when renderable). */
export function renderBlockers(input: RenderInput): string[] {
  const reasons: string[] = [];
  const verification = verifyLibrary(input.content, input.lock);
  if (!verification.ok) reasons.push(...verification.reasons);
  // The public renderer also checks caller-supplied effective records; callers cannot bypass questions by
  // passing an empty list or relabel a forbidden value as valid.
  const allFieldsPresent = FIELD_KEYS.every((k) => input.fields[k] !== undefined);
  const fields = allFieldsPresent ? validateFields(input.fields, { jurisdiction: input.content.jurisdiction }) : input.fields;
  for (const k of FIELD_KEYS) {
    const f = fields[k];
    if (f === undefined) {
      reasons.push(`field_missing:${k}`);
      continue;
    }
    if (f.state === 'valid') continue;
    if (f.state === 'none_confirmed' && !FIELD_SPECS[k].required) continue;
    reasons.push(`field_${f.state}:${k}`);
    if (f.state === 'invalid') for (const r of f.reasons) reasons.push(`validation_failed:${k}:${r}`);
  }
  const questions = new Set(input.questions.map((q) => q.id));
  if (allFieldsPresent) for (const q of buildQuestions(fields, { jurisdiction: input.content.jurisdiction })) questions.add(q.id);
  for (const id of questions) reasons.push(`question_open:${id}`);
  return reasons;
}

/** Select clauses, build paragraphs and render Markdown, or RenderBlocked. */
export function renderAgreement(input: RenderInput): RenderResult {
  const blockers = renderBlockers(input);
  if (blockers.length > 0) return { ok: false, reasons: blockers };
  const verification = verifyLibrary(input.content, input.lock);
  if (!verification.ok) return { ok: false, reasons: verification.reasons };
  try {
    const fields = validateFields(input.fields, { jurisdiction: input.content.jurisdiction });
    const clauses = selectClauses(input.content, fields, input.acceptedClauseIds);
    const doc = buildDocument({
      content: input.content,
      lock: verification.lock,
      fields,
      clauses,
      notIncludedCount: input.notIncludedCount,
    });
    for (const p of doc.paragraphs) {
      const t = paragraphText(p);
      if (t.includes('{{') || t.includes('}}')) return { ok: false, reasons: ['document_error:leftover_placeholder'] };
    }
    return {
      ok: true,
      paragraphs: doc.paragraphs,
      markdown: markdownFromParagraphs(doc.paragraphs),
      contentHash: doc.contentHash,
      clauses,
      lock: verification.lock,
    };
  } catch (error) {
    const code = error instanceof SegmentError ? error.code : 'unexpected';
    return { ok: false, reasons: [`document_error:${code}`] };
  }
}
