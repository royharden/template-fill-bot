// zod schemas for fields, candidates and extractor proposals (PLAN sections 4.1, 4.4, 4.5).
//
// Model output is NOT parsed with `.strict()`: unknown keys are removed by `stripUnknownKeys` (which reports
// the dropped key paths so callers can log them without intake text), then each proposal is validated on
// its own so that one malformed item is dropped instead of failing the whole output.
import { z } from 'zod';
import { FIELD_KEYS, UTILITY_CATEGORIES } from '../content/types.ts';

export const FieldKeySchema = z.enum(FIELD_KEYS);

export const FIELD_STATES = ['valid', 'missing', 'conflict', 'ambiguous', 'invalid', 'none_confirmed'] as const;
export const FieldStateSchema = z.enum(FIELD_STATES);
export type FieldState = z.infer<typeof FieldStateSchema>;

export const UtilityCategorySchema = z.enum(UTILITY_CATEGORIES);

/** Loose pointer string for model output (strict format is enforced by grounding, cited.ts). */
const LoosePointerSchema = z.string().max(64);

// ---------------------------------------------------------------------------------------------- candidates

export const CANDIDATE_KINDS = [
  'money',
  'relative_deposit',
  'date',
  'duration',
  'due_day',
  'role',
  'enum',
  'utilities',
] as const;
export const CandidateKindSchema = z.enum(CANDIDATE_KINDS);
export type CandidateKind = z.infer<typeof CandidateKindSchema>;

export const CANDIDATE_FLAGS = ['ambiguous', 'needs_year', 'relative'] as const;
export const CandidateFlagSchema = z.enum(CANDIDATE_FLAGS);
export type CandidateFlag = z.infer<typeof CandidateFlagSchema>;

/** Money as written: currency code (null = not stated), integer minor units, and an optional period. */
export const MoneyValueSchema = z.object({
  currency: z.string().nullable(),
  minor: z.number().int(),
  period: z.enum(['month', 'week']).nullable(),
});
export type MoneyValue = z.infer<typeof MoneyValueSchema>;

/** "one month's rent" style deposit. */
export const RelativeDepositValueSchema = z.object({ months: z.number().int() });
export type RelativeDepositValue = z.infer<typeof RelativeDepositValueSchema>;

/** Partial utilities classification from one sentence. */
export const UtilitiesValueSchema = z.object({
  tenant_pays: z.array(UtilityCategorySchema),
  included: z.array(UtilityCategorySchema),
});
export type UtilitiesValue = z.infer<typeof UtilitiesValueSchema>;

export const CandidateValueSchema = z.union([
  z.string(),
  z.number(),
  z.array(z.string()),
  MoneyValueSchema,
  RelativeDepositValueSchema,
  UtilitiesValueSchema,
  z.null(),
]);
export type CandidateValue = z.infer<typeof CandidateValueSchema>;

export const QuoteSpanSchema = z.object({ quote: z.string(), pointer: z.string() });
export type QuoteSpan = z.infer<typeof QuoteSpanSchema>;

/**
 * A code-found candidate. `id` is deterministic: `<field|kind>:<msgid>:<start>-<end>` plus `#<suffix>` when one
 * span yields several readings (ambiguous numeric dates). `value` is null when the span needs a question
 * (year-less date, unclear tenant split, ...). `residual` carries qualifier text (e.g. "a small cat") that
 * the agreement will not include.
 */
export const CandidateSchema = z.object({
  id: z.string(),
  kind: CandidateKindSchema,
  field: FieldKeySchema.optional(),
  value: CandidateValueSchema,
  quote: z.string(),
  pointer: z.string(),
  flags: z.array(CandidateFlagSchema).optional(),
  alternatives: z.array(z.string()).optional(),
  residual: QuoteSpanSchema.optional(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const RequestCandidateSchema = z.object({
  id: z.string(),
  quote: z.string(),
  pointer: z.string(),
  clause_id: z.string().nullable(),
  /** Frozen detector ids (candidates/requests.ts) that fired on this sentence. */
  detectors: z.array(z.string()),
});
export type RequestCandidate = z.infer<typeof RequestCandidateSchema>;

// ------------------------------------------------------------------------------------- extractor proposals

/** Values a model may propose; code always re-derives the value from the quote (grounding.ts, M3). */
export const ProposalValueSchema = z.union([z.string(), z.number(), z.array(z.string()), z.null()]);

export const FieldProposalObject = z.object({
  field: FieldKeySchema,
  candidate_id: z.string().max(200).optional(),
  value: ProposalValueSchema.optional(),
  quote: z.string().max(2000).optional(),
  pointer: LoosePointerSchema.optional(),
});
export const FieldProposalSchema = FieldProposalObject.refine(
  (p) => p.candidate_id !== undefined || p.value !== undefined || p.quote !== undefined,
  { message: 'a field proposal needs candidate_id, value or quote' },
);
export type FieldProposal = z.infer<typeof FieldProposalObject>;

export const RequestProposalSchema = z.object({
  quote: z.string().min(1).max(2000),
  pointer: LoosePointerSchema.optional(),
  clause_id: z.string().max(100).nullable(),
});
export type RequestProposal = z.infer<typeof RequestProposalSchema>;

export const ExtractorOutputObject = z.object({
  fields: z.array(FieldProposalSchema).max(200),
  requests: z.array(RequestProposalSchema).max(50),
  usageRef: z.string().max(200).optional(),
});
export type ExtractorOutput = z.infer<typeof ExtractorOutputObject>;

// ------------------------------------------------------------------------------------- unknown-key handling

const TOP_KEYS: readonly string[] = Object.keys(ExtractorOutputObject.shape);
const FIELD_PROPOSAL_KEYS: readonly string[] = Object.keys(FieldProposalObject.shape);
const REQUEST_PROPOSAL_KEYS: readonly string[] = Object.keys(RequestProposalSchema.shape);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Key names are model-controlled and could carry intake text (e.g. a key named after a tenant). Only
 * identifier-like lower-case keys are logged verbatim; anything else is replaced by an opaque counter.
 */
const SAFE_KEY_RE = /^[a-z][a-z_]{0,23}$/;
let opaqueKeyCounter = 0;
function safeKey(key: string): string {
  if (SAFE_KEY_RE.test(key)) return key;
  opaqueKeyCounter += 1;
  return `<key#${opaqueKeyCounter}>`;
}

function pick(obj: Record<string, unknown>, allowed: readonly string[], path: string, dropped: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (allowed.includes(key)) out[key] = obj[key];
    else dropped.push(`${path}${safeKey(key)}`);
  }
  return out;
}

/**
 * Remove keys the ExtractorOutput schema does not know, at the top level and inside each field / request
 * proposal. Returns the cleaned value (other shapes are passed through unchanged for zod to reject) and the
 * dropped key paths, e.g. `fields[0].confidence`.
 */
export function stripUnknownKeys(raw: unknown): { value: unknown; droppedKeys: string[] } {
  const droppedKeys: string[] = [];
  if (!isPlainObject(raw)) return { value: raw, droppedKeys };
  const top = pick(raw, TOP_KEYS, '', droppedKeys);
  if (Array.isArray(top.fields)) {
    top.fields = top.fields.map((item, i) =>
      isPlainObject(item) ? pick(item, FIELD_PROPOSAL_KEYS, `fields[${i}].`, droppedKeys) : item,
    );
  }
  if (Array.isArray(top.requests)) {
    top.requests = top.requests.map((item, i) =>
      isPlainObject(item) ? pick(item, REQUEST_PROPOSAL_KEYS, `requests[${i}].`, droppedKeys) : item,
    );
  }
  return { value: top, droppedKeys };
}

export type ParseExtractorOutputResult =
  | {
      readonly ok: true;
      readonly value: ExtractorOutput;
      /** Unknown keys removed (paths only). */
      readonly droppedKeys: string[];
      /** Proposals removed because they failed their own schema (paths only, e.g. `fields[2]`). */
      readonly droppedItems: string[];
    }
  | { readonly ok: false; readonly error: string };

/**
 * Validate raw model JSON. Missing `fields` / `requests` arrays are treated as empty; a non-array value for
 * either, or a non-object top level, fails. Individual invalid proposals are dropped and reported.
 */
export function parseExtractorOutput(raw: unknown): ParseExtractorOutputResult {
  if (!isPlainObject(raw)) return { ok: false, error: 'extractor output is not an object' };
  const { value, droppedKeys } = stripUnknownKeys(raw);
  const v = value as Record<string, unknown>;
  const fieldsRaw = v.fields === undefined ? [] : v.fields;
  const requestsRaw = v.requests === undefined ? [] : v.requests;
  if (!Array.isArray(fieldsRaw)) return { ok: false, error: 'fields is not an array' };
  if (!Array.isArray(requestsRaw)) return { ok: false, error: 'requests is not an array' };
  const droppedItems: string[] = [];
  const fields: FieldProposal[] = [];
  fieldsRaw.forEach((item, i) => {
    const r = FieldProposalSchema.safeParse(item);
    if (r.success) fields.push(r.data);
    else droppedItems.push(`fields[${i}]`);
  });
  const requests: RequestProposal[] = [];
  requestsRaw.forEach((item, i) => {
    const r = RequestProposalSchema.safeParse(item);
    if (r.success) requests.push(r.data);
    else droppedItems.push(`requests[${i}]`);
  });
  const candidate: Record<string, unknown> = { fields, requests };
  if (v.usageRef !== undefined) candidate.usageRef = v.usageRef;
  const parsed = ExtractorOutputObject.safeParse(candidate);
  if (!parsed.success) return { ok: false, error: 'extractor output failed schema validation' };
  return { ok: true, value: parsed.data, droppedKeys, droppedItems };
}
