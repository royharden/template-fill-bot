import { z } from 'zod';
import { FIELD_KEYS, METHOD_TOKENS } from '../../content/types.ts';
import type { LibraryContent, LibraryLock } from '../../content/types.ts';
import { canonicalJson } from '../canonicalJson.ts';
import { verifyLibrary } from '../library.ts';
import { normaliseIntake } from '../normalize.ts';
import type { Provenance } from '../provenance.ts';
import { readDocx, utf8Read } from './docxRead.ts';
import { expectedParagraphs } from './expected.ts';
import { readMarkdown } from './mdRead.ts';
import { validateProvenanceValues } from './rules.ts';
import { GateReadError } from './xmlTokens.ts';
import type { ReadParagraph } from './xmlTokens.ts';

// Gate-owned schema: importing the builder's schema would transitively load rendering modules.
const value = z.union([z.string().max(8000), z.number().finite(), z.array(z.string().max(8000)).max(8)]);
const answer = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('option'), option_id: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal('text'), text: z.string().max(500) }).strict(),
  z.object({ kind: z.literal('value'), value }).strict(),
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('optional_terms'), guarantor: z.string().max(200).nullable().optional(), break_month: z.union([z.string().max(50), z.number().finite()]).nullable().optional() }).strict(),
]);
const span = z.object({ quote: z.string().max(8000), pointer: z.string().max(64) }).strict();
const field = z.object({ state: z.enum(['valid','missing','conflict','ambiguous','invalid','none_confirmed']), value: value.optional(), method: z.enum([...METHOD_TOKENS, 'computed']).optional(), quote: z.string().max(8000).optional(), pointer: z.string().max(64).optional(), evidence: z.array(span).max(512).optional(), relative_months: z.number().int().positive().optional(), question_id: z.string().max(128).optional(), answer: answer.optional(), answered_at: z.string().max(64).optional() }).strict();
const shape = {} as Record<(typeof FIELD_KEYS)[number], typeof field>;
for (const key of FIELD_KEYS) shape[key] = field;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const request = z.object({ id: z.string().max(256), clause_id: z.string().max(128), quote: z.string().max(8000), pointer: z.string().max(64) }).strict();
const schema = z.object({ schema_version: z.literal(1), matter_id: z.string().max(128).nullable(), revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), extractor_method: z.enum(['regex','llm','jev','mock']), intake: z.array(z.object({ id: z.string().max(32), text_normalised: z.string().max(8000) }).strict()).max(12), fields: z.object(shape).strict(), clauses: z.array(z.object({ id: z.string().max(128), version: z.number().int().positive() }).strict()).max(64), requests: z.object({ accepted: z.array(request).max(100), not_included: z.array(request.extend({ clause_id: z.string().max(128).nullable(), reason: z.enum(['no_supported_clause','unknown_clause','not_requestable','not_applicable','not_confirmed','quote_not_grounded','pets_qualifier','guarantor_partial']) }).strict()).max(100) }).strict(), library_hash: hash, jurisdiction_hash: hash, content_hash: hash }).strict();
export interface GateFailure { readonly code: string; readonly paragraph_index?: number; readonly detail: string }
export interface GateResult { readonly ok: boolean; readonly failures: readonly GateFailure[] }
export interface GateInput { readonly content: LibraryContent; readonly lock: LibraryLock; readonly provenanceBytes: Uint8Array; readonly markdownBytes: Uint8Array; readonly docxBytes: Uint8Array }
function normal(text: string): string { return text.replace(/ +/g, ' ').replace(/[ \t]+$/g, ''); }
export function gateBundle(input: GateInput): GateResult {
  const failures: GateFailure[] = [];
  const bad = (code: string, detail = code): GateResult => ({ ok: false, failures: [{ code, detail }] });
  try {
    const verified = verifyLibrary(input.content, input.lock);
    if (!verified.ok) return { ok: false, failures: verified.reasons.map((code) => ({ code, detail: code })) };
    if (input.provenanceBytes.length > 262144 || input.markdownBytes.length > 2 * 1024 * 1024) return bad('gate_input_limit');
    const json = utf8Read(input.provenanceBytes);
    const parsed = schema.safeParse(JSON.parse(json));
    if (!parsed.success) return bad('provenance_schema');
    const p: Provenance = parsed.data;
    if (canonicalJson(p) !== json) return bad('provenance_noncanonical');
    const norm = normaliseIntake(p.intake.map((m) => ({ id: m.id, text: m.text_normalised })));
    if (!norm.ok || canonicalJson(norm.messages) !== canonicalJson(p.intake)) return bad('provenance_intake');
    if (p.library_hash !== verified.lock.overall || p.jurisdiction_hash !== verified.lock.jurisdiction) return bad('provenance_lock_mismatch');
    validateProvenanceValues(p, input.content);
    const expected = expectedParagraphs(p, input.content, verified.lock);
    const compare = (actual: readonly ReadParagraph[], format: 'md' | 'docx'): void => {
      if (actual.length !== expected.length) failures.push({ code: `${format}_paragraph_count`, detail: `${actual.length}/${expected.length}` });
      for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
        const a = actual[i], e = expected[i];
        const style = format === 'md' && e?.style === 'Appendix' ? 'Normal' : e?.style;
        if (!a || !e || a.style !== style || normal(a.text) !== normal(e.text)) failures.push({ code: `${format}_paragraph_mismatch`, paragraph_index: i, detail: 'Paragraph text or style differs from locked reconstruction' });
      }
    };
    // Report each final-byte format independently even if the other format is malformed.
    for (const format of ['md','docx'] as const) {
      try { compare(format === 'md' ? readMarkdown(input.markdownBytes) : readDocx(input.docxBytes), format); }
      catch (error) { const code = error instanceof GateReadError ? error.code : 'malformed'; failures.push({ code: `${format}_${code}`, detail: `${format} closed vocabulary rejected` }); }
    }
    return { ok: failures.length === 0, failures };
  } catch (error) { return bad(error instanceof GateReadError ? error.code : 'gate_malformed_input'); }
}
