// Segment and paragraph model shared by every renderer (PLAN section 4.6): Markdown (renderMarkdown.ts) and
// DOCX (docx/writeDocx.ts, M4) render the SAME Paragraph[] so their text cannot drift apart. Pure.
// The independent gate (fillkit/gate/) must not import this file; it rebuilds the expected paragraphs itself.
//
// Segments:  {kind:'frame', id, text}            locked frame text (content/frame.ts)
//            {kind:'clause_text', clause_id, text} locked clause text (content/clauses.ts)
//            {kind:'value', field, text}           a validated value rendered by code
// Placeholders are substituted by SPLITTING the locked text on `{{name}}` tokens and building segment arrays;
// a value is never used as a String.replace replacement string (so `$&` or `{{rent}}` in a value stays literal).
//
// Document layout (deterministic):
//   Title      frame `title`
//   Normal     frame `draft-notice`
//   Normal     frame `jurisdiction-notice`
//   for each selected clause in order:
//     Heading1 the heading frame whose range [from_order, next from_order) contains the clause order, emitted
//              once, before the first selected clause in its range (headings with no selected clause are omitted)
//     Normal   the clause text with placeholders substituted (clause titles are not rendered)
//   Normal     `requests-not-included-one` (N = 1) or `-many` with {{n}} (N >= 2); omitted when N = 0
//   --- appendix (everything above is the "body"; its hash is the agreement content hash) ---
//   Heading1   frame `appendix-heading`
//   Appendix   frame `appendix-label-field-values`
//   Appendix   header row: Field, Value, Method, Source pointer   (labels joined by the locked ", " token)
//   Appendix   one row per field in schema order except end_date (computed; shown in the term clause):
//              <field key>, <value>, <method token>, <pointer id | question id for user answers>
//              (none_confirmed rows have an empty value segment; list values use the locked join tokens)
//   Appendix   header row: Clauses used, Version;  then one row per clause: <clause id>, <version>
//   Appendix   Clause library hash, <lock.overall>
//   Appendix   Jurisdiction config hash, <lock.jurisdiction>
//   Appendix   Agreement content hash, <sha256 of the body>
//
// Value formats (deterministic, documented for the gate):
//   money      `<currency symbol><pounds with "," thousands separators>.<2-digit pence>`  e.g. £1,200.00
//   date       `<day without leading zero> <English month name> <year>`                  e.g. 29 February 2028
//   int        decimal digits; rent_due_day_ordinal: 1st 2nd 3rd 4th ... 11th 12th 13th ... 21st 22nd 23rd 28th
//   lists      tenants_list / utilities_*_list: items as separate value segments joined by frame segments
//              `join-list-separator` (", ") and `join-list-final` (" and "): a | a and b | a, b and c
//   utilities  category tokens as stored (water, electricity, gas, internet) in closed-list order
//   enums      the stored token (appendix only)
// Agreement content hash = sha256 hex of canonicalJson(body.map(p => [p.style, paragraphText(p)])).
import { canonicalJson } from './canonicalJson.ts';
import { sha256Hex } from './hash.ts';
import { FIELD_KEYS, FIELD_KIND_OF, METHOD_TOKENS, UTILITY_CATEGORIES } from '../content/types.ts';
import type {
  ClauseRecord,
  FieldKey,
  FrameRecord,
  JurisdictionPlaceholderKey,
  LibraryContent,
  LockedLibraryLock,
  PlaceholderSpec,
} from '../content/types.ts';
import type { FieldValue } from './fields.ts';
import type { GroundedField } from './grounding.ts';

export type Segment =
  | { readonly kind: 'frame'; readonly id: string; readonly text: string }
  | { readonly kind: 'clause_text'; readonly clause_id: string; readonly text: string }
  | { readonly kind: 'value'; readonly field: string; readonly text: string };

export const PARAGRAPH_STYLES = ['Title', 'Heading1', 'Normal', 'Appendix'] as const;
export type ParagraphStyle = (typeof PARAGRAPH_STYLES)[number];

export interface Paragraph {
  readonly style: ParagraphStyle;
  readonly segments: readonly Segment[];
}

/** Thrown when a document cannot be built (renderMarkdown.ts turns it into RenderBlocked). */
export class SegmentError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'SegmentError';
    this.code = code;
  }
}

/** Value-segment field names used outside the schema fields (appendix columns and the request count). */
export const APPENDIX_VALUE_FIELDS = {
  field: 'appendix_field',
  method: 'appendix_method',
  source: 'appendix_source',
  clauseId: 'appendix_clause_id',
  clauseVersion: 'appendix_clause_version',
  libraryHash: 'library_hash',
  jurisdictionHash: 'jurisdiction_hash',
  contentHash: 'content_hash',
  requestCount: 'requests_not_included_count',
} as const;

// ------------------------------------------------------------------------------------------------ formats

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const ISO_DATE_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/** "2028-02-29" -> "29 February 2028". */
export function formatDate(isoDate: string): string {
  const m = ISO_DATE_RE.exec(isoDate);
  const month = m === null ? undefined : MONTH_NAMES[Number(m[2]) - 1];
  if (m === null || month === undefined) throw new SegmentError('bad_date_value');
  return `${Number(m[3])} ${month} ${m[1]}`;
}

/** 120000 (pence) -> "£1,200.00" with symbol "£". */
export function formatMoney(minor: number, symbol: string): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new SegmentError('bad_money_value');
  const pounds = String(Math.floor(minor / 100));
  const pence = String(minor % 100).padStart(2, '0');
  let grouped = '';
  for (let i = 0; i < pounds.length; i++) {
    const fromEnd = pounds.length - i;
    grouped += pounds[i];
    if (fromEnd > 1 && (fromEnd - 1) % 3 === 0) grouped += ',';
  }
  return `${symbol}${grouped}.${pence}`;
}

/** 1 -> "1st", 2 -> "2nd", 3 -> "3rd", 11 -> "11th", 21 -> "21st". */
export function ordinal(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new SegmentError('bad_int_value');
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

// --------------------------------------------------------------------------------------------- templates

export type TemplatePart = { readonly t: 'text'; readonly text: string } | { readonly t: 'placeholder'; readonly name: string };

const TOKEN_SPLIT_RE = /(\{\{[a-z_][a-z0-9_]*\}\})/;

/** Split locked text on `{{name}}` tokens (String.split with a capture group keeps the tokens). */
export function splitTemplate(text: string): TemplatePart[] {
  const out: TemplatePart[] = [];
  const parts = text.split(TOKEN_SPLIT_RE);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';
    if (i % 2 === 1) out.push({ t: 'placeholder', name: part.slice(2, -2) });
    else if (part.length > 0) out.push({ t: 'text', text: part });
  }
  return out;
}

function frameRecord(content: LibraryContent, id: string): FrameRecord {
  const r = content.frame.find((f) => f.id === id);
  if (r === undefined) throw new SegmentError(`frame_missing:${id}`);
  return r;
}

function frameSegment(content: LibraryContent, id: string): Segment {
  const r = frameRecord(content, id);
  if (r.placeholders.length > 0) throw new SegmentError(`frame_has_placeholders:${id}`);
  return { kind: 'frame', id, text: r.text };
}

function checkValueText(text: string): string {
  if (text.includes('{{') || text.includes('}}')) throw new SegmentError('value_contains_placeholder_token');
  if (/[\r\n]/.test(text)) throw new SegmentError('value_contains_line_break');
  return text;
}

function valueSegment(field: string, text: string): Segment {
  return { kind: 'value', field, text: checkValueText(text) };
}

/** Items as value segments joined by the locked frame join tokens: a | a and b | a, b and c. */
export function joinListSegments(content: LibraryContent, field: string, items: readonly string[]): Segment[] {
  const out: Segment[] = [];
  items.forEach((item, i) => {
    if (i > 0) out.push(frameSegment(content, i === items.length - 1 ? 'join-list-final' : 'join-list-separator'));
    out.push(valueSegment(field, item));
  });
  return out;
}

function validFieldValue(fields: Readonly<Record<FieldKey, GroundedField>>, key: FieldKey): FieldValue {
  const f = fields[key];
  if (f === undefined || f.state !== 'valid' || f.value === undefined) throw new SegmentError(`value_unavailable:${key}`);
  return f.value;
}

/** Single-text rendering of a non-list field value. */
export function formatScalarValue(content: LibraryContent, field: FieldKey, value: FieldValue): string {
  const kind = FIELD_KIND_OF[field];
  switch (kind) {
    case 'money':
      if (typeof value !== 'number') throw new SegmentError(`bad_value:${field}`);
      return formatMoney(value, content.jurisdiction.currency.symbol);
    case 'date':
    case 'computed':
      if (typeof value !== 'string') throw new SegmentError(`bad_value:${field}`);
      return formatDate(value);
    case 'int':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new SegmentError(`bad_value:${field}`);
      return String(value);
    case 'enum':
    case 'name':
    case 'address':
      if (typeof value !== 'string') throw new SegmentError(`bad_value:${field}`);
      return value;
    default:
      throw new SegmentError(`not_scalar:${field}`);
  }
}

/** Segments for a field value: lists expand with join tokens; an empty list gives one empty value segment. */
export function fieldValueSegments(content: LibraryContent, field: FieldKey, value: FieldValue): Segment[] {
  const kind = FIELD_KIND_OF[field];
  if (kind === 'nameList' || kind === 'enumSet') {
    if (!Array.isArray(value)) throw new SegmentError(`bad_value:${field}`);
    const items = kind === 'enumSet' ? UTILITY_CATEGORIES.filter((c) => value.includes(c)) : value;
    return items.length === 0 ? [valueSegment(field, '')] : joinListSegments(content, field, items);
  }
  return [valueSegment(field, formatScalarValue(content, field, value))];
}

function placeholderSegments(
  content: LibraryContent,
  fields: Readonly<Record<FieldKey, GroundedField>>,
  spec: PlaceholderSpec,
): Segment[] {
  switch (spec.source) {
    case 'field':
      return fieldValueSegments(content, spec.name as FieldKey, validFieldValue(fields, spec.name as FieldKey));
    case 'derived':
      switch (spec.name) {
        case 'tenants_list': {
          const v = validFieldValue(fields, 'tenants');
          if (!Array.isArray(v) || v.length === 0) throw new SegmentError('bad_value:tenants');
          return joinListSegments(content, 'tenants', v);
        }
        case 'rent_due_day_ordinal': {
          const v = validFieldValue(fields, 'rent_due_day');
          if (typeof v !== 'number') throw new SegmentError('bad_value:rent_due_day');
          return [valueSegment('rent_due_day', ordinal(v))];
        }
        case 'utilities_tenant_list':
        case 'utilities_included_list': {
          const v = validFieldValue(fields, 'utilities');
          if (!Array.isArray(v)) throw new SegmentError('bad_value:utilities');
          const items =
            spec.name === 'utilities_tenant_list'
              ? UTILITY_CATEGORIES.filter((c) => v.includes(c))
              : UTILITY_CATEGORIES.filter((c) => !v.includes(c));
          if (items.length === 0) throw new SegmentError(`empty_list:${spec.name}`);
          return joinListSegments(content, 'utilities', items);
        }
        default:
          throw new SegmentError(`unknown_derived:${spec.name}`);
      }
    case 'jurisdiction': {
      const n: unknown = content.jurisdiction[spec.name as JurisdictionPlaceholderKey];
      if (typeof n !== 'number' || !Number.isSafeInteger(n)) throw new SegmentError(`bad_jurisdiction_value:${spec.name}`);
      return [valueSegment(spec.name, String(n))];
    }
    default:
      throw new SegmentError('unknown_placeholder_source');
  }
}

/** Locked clause text with its placeholders substituted (split, never replaced). */
export function clauseSegments(
  content: LibraryContent,
  clause: ClauseRecord,
  fields: Readonly<Record<FieldKey, GroundedField>>,
): Segment[] {
  const out: Segment[] = [];
  for (const part of splitTemplate(clause.text)) {
    if (part.t === 'text') {
      out.push({ kind: 'clause_text', clause_id: clause.id, text: part.text });
      continue;
    }
    const spec = clause.placeholders.find((p) => p.name === part.name);
    if (spec === undefined) throw new SegmentError(`undeclared_placeholder:${clause.id}:${part.name}`);
    out.push(...placeholderSegments(content, fields, spec));
  }
  return out;
}

/** Frame text with integer placeholders substituted (used by `requests-not-included-many`). */
export function frameSegments(content: LibraryContent, id: string, values: Readonly<Record<string, Segment[]>>): Segment[] {
  const r = frameRecord(content, id);
  const out: Segment[] = [];
  for (const part of splitTemplate(r.text)) {
    if (part.t === 'text') out.push({ kind: 'frame', id, text: part.text });
    else {
      const segs = Object.prototype.hasOwnProperty.call(values, part.name) ? values[part.name] : undefined;
      if (segs === undefined) throw new SegmentError(`frame_placeholder_unbound:${id}:${part.name}`);
      out.push(...segs);
    }
  }
  return out;
}

export function paragraphText(p: Paragraph): string {
  let s = '';
  for (const seg of p.segments) s += seg.text;
  return s;
}

/** sha256 hex of canonicalJson(body.map(p => [style, text])). */
export function agreementContentHash(body: readonly Paragraph[]): string {
  return sha256Hex(canonicalJson(body.map((p) => [p.style, paragraphText(p)])));
}

// ------------------------------------------------------------------------------------------------ document

export interface DocumentInput {
  readonly content: LibraryContent;
  readonly lock: LockedLibraryLock;
  /** Effective field records (validate.ts). Every field must be valid or none_confirmed. */
  readonly fields: Readonly<Record<FieldKey, GroundedField>>;
  /** Selected clauses in document order (select.ts). */
  readonly clauses: readonly ClauseRecord[];
  /** Number of "Not included" items (requests.ts); only the count enters the agreement. */
  readonly notIncludedCount: number;
}

export interface BuiltDocument {
  readonly paragraphs: Paragraph[];
  readonly body: Paragraph[];
  readonly appendix: Paragraph[];
  readonly contentHash: string;
}

export function buildBodyParagraphs(input: DocumentInput): Paragraph[] {
  const { content } = input;
  const out: Paragraph[] = [
    { style: 'Title', segments: [frameSegment(content, 'title')] },
    { style: 'Normal', segments: [frameSegment(content, 'draft-notice')] },
    { style: 'Normal', segments: [frameSegment(content, 'jurisdiction-notice')] },
  ];
  const headings = content.frame
    .filter((f) => f.kind === 'heading' && typeof f.from_order === 'number')
    .slice()
    .sort((a, b) => (a.from_order ?? 0) - (b.from_order ?? 0));
  let current: string | null = null;
  for (const clause of input.clauses) {
    let heading: FrameRecord | null = null;
    for (const h of headings) if ((h.from_order ?? 0) <= clause.order) heading = h;
    if (heading !== null && heading.id !== current) {
      out.push({ style: 'Heading1', segments: [frameSegment(content, heading.id)] });
      current = heading.id;
    }
    out.push({ style: 'Normal', segments: clauseSegments(content, clause, input.fields) });
  }
  const n = input.notIncludedCount;
  if (!Number.isSafeInteger(n) || n < 0) throw new SegmentError('bad_not_included_count');
  if (n === 1) out.push({ style: 'Normal', segments: [frameSegment(content, 'requests-not-included-one')] });
  else if (n >= 2) {
    out.push({
      style: 'Normal',
      segments: frameSegments(content, 'requests-not-included-many', {
        n: [valueSegment(APPENDIX_VALUE_FIELDS.requestCount, String(n))],
      }),
    });
  }
  return out;
}

function row(content: LibraryContent, cells: readonly (readonly Segment[])[]): Segment[] {
  const out: Segment[] = [];
  cells.forEach((cell, i) => {
    if (i > 0) out.push(frameSegment(content, 'join-list-separator'));
    out.push(...cell);
  });
  return out;
}

function isMethodToken(m: unknown): m is (typeof METHOD_TOKENS)[number] {
  return typeof m === 'string' && (METHOD_TOKENS as readonly string[]).includes(m);
}

export function buildAppendixParagraphs(input: DocumentInput, contentHash: string): Paragraph[] {
  const { content, lock } = input;
  const f = (id: string): Segment[] => [frameSegment(content, id)];
  const v = (field: string, text: string): Segment[] => [valueSegment(field, text)];
  const out: Paragraph[] = [
    { style: 'Heading1', segments: f('appendix-heading') },
    { style: 'Appendix', segments: f('appendix-label-field-values') },
    {
      style: 'Appendix',
      segments: row(content, [
        f('appendix-label-field'),
        f('appendix-label-value'),
        f('appendix-label-method'),
        f('appendix-label-pointer'),
      ]),
    },
  ];
  for (const key of FIELD_KEYS) {
    if (key === 'end_date') continue;
    const rec = input.fields[key];
    if (rec === undefined) throw new SegmentError(`field_record_missing:${key}`);
    if (!isMethodToken(rec.method)) throw new SegmentError(`bad_method:${key}`);
    let valueCell: Segment[];
    if (rec.state === 'valid' && rec.value !== undefined) valueCell = fieldValueSegments(content, key, rec.value);
    else if (rec.state === 'none_confirmed') valueCell = v(key, '');
    else throw new SegmentError(`field_not_resolved:${key}`);
    const source =
      rec.method === 'user_answer' || rec.method === 'none_confirmed' ? rec.answer?.question_id : rec.pointer;
    if (source === undefined) throw new SegmentError(`source_missing:${key}`);
    out.push({
      style: 'Appendix',
      segments: row(content, [
        v(APPENDIX_VALUE_FIELDS.field, key),
        valueCell,
        v(APPENDIX_VALUE_FIELDS.method, rec.method),
        v(APPENDIX_VALUE_FIELDS.source, source),
      ]),
    });
  }
  out.push({
    style: 'Appendix',
    segments: row(content, [f('appendix-label-clauses'), f('appendix-label-clause-version')]),
  });
  for (const clause of input.clauses) {
    out.push({
      style: 'Appendix',
      segments: row(content, [
        v(APPENDIX_VALUE_FIELDS.clauseId, clause.id),
        v(APPENDIX_VALUE_FIELDS.clauseVersion, String(clause.version)),
      ]),
    });
  }
  out.push({
    style: 'Appendix',
    segments: row(content, [f('appendix-label-library-hash'), v(APPENDIX_VALUE_FIELDS.libraryHash, lock.overall)]),
  });
  out.push({
    style: 'Appendix',
    segments: row(content, [
      f('appendix-label-jurisdiction-hash'),
      v(APPENDIX_VALUE_FIELDS.jurisdictionHash, lock.jurisdiction),
    ]),
  });
  out.push({
    style: 'Appendix',
    segments: row(content, [f('appendix-label-content-hash'), v(APPENDIX_VALUE_FIELDS.contentHash, contentHash)]),
  });
  return out;
}

/** The whole document: body, appendix and the body's content hash. Throws SegmentError on any gap. */
export function buildDocument(input: DocumentInput): BuiltDocument {
  const body = buildBodyParagraphs(input);
  const contentHash = agreementContentHash(body);
  const appendix = buildAppendixParagraphs(input, contentHash);
  return { paragraphs: [...body, ...appendix], body, appendix, contentHash };
}
