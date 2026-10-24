// provenance.json (PLAN section 4.6): zod schema, builder and canonical bytes. Pure.
// The ONLY generated file that carries raw (normalised) source quotes. It includes the normalised intake so
// the independent gate can re-ground every quote at its pointer.
//
// Shape (canonical JSON, keys sorted, no whitespace):
// { schema_version: 1, matter_id: string|null, revision, extractor_method,
//   intake: [{id, text_normalised}],
//   fields: { <every one of the 15 fields>: {state, value?, method?, quote?, pointer?, relative_months?,
//             question_id?, answer?, answered_at?} },
//   clauses: [{id, version}]  (document order),
//   requests: { accepted: [{id, clause_id, quote, pointer}],
//               not_included: [{id, reason, clause_id, quote, pointer}] },
//   library_hash, jurisdiction_hash, content_hash }
import { z } from 'zod';
import { canonicalJson } from './canonicalJson.ts';
import { utf8Encode } from './hash.ts';
import { FIELD_KEYS, METHOD_TOKENS } from '../content/types.ts';
import type { ClauseRecord, FieldKey, LockedLibraryLock } from '../content/types.ts';
import { EXTRACTOR_METHODS } from './extractors/types.ts';
import type { GroundedField } from './grounding.ts';
import type { MatterState } from './matter.ts';
import { AnswerInputSchema } from './questions.ts';
import type { AcceptedRequest, NotIncludedItem } from './requests.ts';
import { NOT_INCLUDED_REASONS } from './requests.ts';
import { FieldStateSchema } from './schema.ts';

export const PROVENANCE_SCHEMA_VERSION = 1;

const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
const FieldValueSchema = z.union([z.string(), z.number(), z.array(z.string())]);

export const ProvenanceFieldSchema = z
  .object({
    state: FieldStateSchema,
    value: FieldValueSchema.optional(),
    method: z.union([z.enum(METHOD_TOKENS), z.literal('computed')]).optional(),
    quote: z.string().optional(),
    pointer: z.string().optional(),
    evidence: z.array(z.object({ quote: z.string(), pointer: z.string() }).strict()).optional(),
    relative_months: z.number().int().positive().optional(),
    question_id: z.string().optional(),
    answer: AnswerInputSchema.optional(),
    answered_at: z.string().optional(),
  })
  .strict();
export type ProvenanceField = z.infer<typeof ProvenanceFieldSchema>;

const fieldShape = {} as Record<FieldKey, typeof ProvenanceFieldSchema>;
for (const k of FIELD_KEYS) fieldShape[k] = ProvenanceFieldSchema;

export const ProvenanceSchema = z
  .object({
    schema_version: z.literal(PROVENANCE_SCHEMA_VERSION),
    matter_id: z.string().nullable(),
    revision: z.number().int().min(1),
    extractor_method: z.enum(EXTRACTOR_METHODS),
    intake: z.array(z.object({ id: z.string(), text_normalised: z.string() }).strict()),
    fields: z.object(fieldShape).strict(),
    clauses: z.array(z.object({ id: z.string(), version: z.number().int().positive() }).strict()),
    requests: z
      .object({
        accepted: z.array(
          z.object({ id: z.string(), clause_id: z.string(), quote: z.string(), pointer: z.string() }).strict(),
        ),
        not_included: z.array(
          z
            .object({
              id: z.string(),
              reason: z.enum(NOT_INCLUDED_REASONS),
              clause_id: z.string().nullable(),
              quote: z.string(),
              pointer: z.string(),
            })
            .strict(),
        ),
      })
      .strict(),
    library_hash: Sha256HexSchema,
    jurisdiction_hash: Sha256HexSchema,
    content_hash: Sha256HexSchema,
  })
  .strict();
export type Provenance = z.infer<typeof ProvenanceSchema>;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Provenance entry for one effective field record (no undefined values: canonicalJson rejects them). */
export function provenanceField(f: GroundedField): ProvenanceField {
  const out: Mutable<ProvenanceField> = { state: f.state };
  if (f.state === 'valid' && f.value !== undefined) out.value = Array.isArray(f.value) ? [...f.value] : f.value;
  if (f.method !== undefined && (f.state === 'valid' || f.state === 'none_confirmed')) out.method = f.method;
  if (f.method !== 'user_answer' && f.method !== 'none_confirmed') {
    if (f.quote !== undefined) out.quote = f.quote;
    if (f.pointer !== undefined) out.pointer = f.pointer;
    if (f.evidence !== undefined) out.evidence = f.evidence.map((e) => ({ quote: e.quote, pointer: e.pointer }));
    if (f.relative !== undefined && f.state === 'valid') out.relative_months = f.relative.months;
  }
  if (f.answer !== undefined && (f.method === 'user_answer' || f.method === 'none_confirmed')) {
    out.question_id = f.answer.question_id;
    out.answer = f.answer.answer;
    out.answered_at = f.answer.answered_at;
  }
  return out;
}

export interface ProvenanceInput {
  readonly state: MatterState;
  readonly matterId: string | null;
  /** EFFECTIVE field records. */
  readonly fields: Readonly<Record<FieldKey, GroundedField>>;
  readonly clauses: readonly ClauseRecord[];
  readonly accepted: readonly AcceptedRequest[];
  readonly notIncluded: readonly NotIncludedItem[];
  readonly lock: LockedLibraryLock;
  readonly contentHash: string;
}

export function buildProvenance(input: ProvenanceInput): Provenance {
  const fields = {} as Record<FieldKey, ProvenanceField>;
  for (const k of FIELD_KEYS) fields[k] = provenanceField(input.fields[k]);
  const p: Provenance = {
    schema_version: PROVENANCE_SCHEMA_VERSION,
    matter_id: input.matterId,
    revision: input.state.revision,
    extractor_method: input.state.extractor_method,
    intake: input.state.intake.map((m) => ({ id: m.id, text_normalised: m.text_normalised })),
    fields,
    clauses: input.clauses.map((c) => ({ id: c.id, version: c.version })),
    requests: {
      accepted: input.accepted.map((r) => ({ id: r.id, clause_id: r.clause_id, quote: r.quote, pointer: r.pointer })),
      not_included: input.notIncluded.map((r) => ({
        id: r.id,
        reason: r.reason,
        clause_id: r.clause_id,
        quote: r.quote,
        pointer: r.pointer,
      })),
    },
    library_hash: input.lock.overall,
    jurisdiction_hash: input.lock.jurisdiction,
    content_hash: input.contentHash,
  };
  // Fail loudly if the builder ever produces something the schema (and so the gate) would reject.
  return ProvenanceSchema.parse(p);
}

/** Canonical JSON text of a provenance object. */
export function provenanceJson(p: Provenance): string {
  return canonicalJson(p);
}

/** Canonical UTF-8 bytes (no BOM) of a provenance object: the exact provenance.json file. */
export function provenanceBytes(p: Provenance): Uint8Array {
  return utf8Encode(provenanceJson(p));
}

export type ParseProvenanceResult = { readonly ok: true; readonly value: Provenance } | { readonly ok: false; readonly error: string };

/** Validate untrusted provenance JSON (already JSON.parse'd). */
export function parseProvenance(raw: unknown): ParseProvenanceResult {
  const r = ProvenanceSchema.safeParse(raw);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: 'provenance failed schema validation' };
}
