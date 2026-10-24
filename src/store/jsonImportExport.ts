// Bounded, strict canonical MatterState interchange. Approval history is deliberately never imported.
import { z } from 'zod';
import { AnswerInputSchema, FIELD_KEYS, FIELD_SPECS, FieldStateSchema, MATTER_STATE_VERSION, UTILITY_CATEGORIES, applyAnswer, canonicalJson, groundQuote, normaliseIntake, utf8Encode } from '../core/index.ts';
import type { MatterState } from '../core/index.ts';

const value = z.union([z.string().max(8000), z.number().finite(), z.array(z.string().max(8000)).max(8)]);
const key = z.enum(FIELD_KEYS), source = z.enum(['extractor','code']);
const span = z.object({ quote: z.string().max(8000), pointer: z.string().max(64) }).strict();
const answer = z.object({ question_id: z.string().max(128), answer: AnswerInputSchema, answered_at: z.string().max(64) }).strict();
const evidence = span.extend({ value, source, candidate_id: z.string().max(256).optional(), ambiguous: z.literal(true).optional() }).strict();
const field = z.object({ field: key, state: FieldStateSchema, value: value.optional(), method: z.enum(['regex','llm','jev','mock','user_answer','none_confirmed','computed']).optional(), quote: z.string().max(8000).optional(), pointer: z.string().max(64).optional(), evidence: z.array(span).max(512).optional(), candidates: z.array(evidence).max(512), reasons: z.array(z.string().max(128)).max(100), relative: span.extend({ months: z.number().int().positive(), source, claims: z.array(z.number().finite()).max(100).optional() }).strict().optional(), utilities: z.object({ tenant_pays: z.array(z.enum(UTILITY_CATEGORIES)).max(4), included: z.array(z.enum(UTILITY_CATEGORIES)).max(4) }).strict().optional(), answer: answer.optional() }).strict();
const shape = {} as Record<(typeof FIELD_KEYS)[number], typeof field>;
for (const k of FIELD_KEYS) shape[k] = field;
const notIncluded = z.object({ id: z.string().max(256), reason: z.enum(['no_supported_clause','unknown_clause','not_requestable','not_applicable','not_confirmed','quote_not_grounded','pets_qualifier','guarantor_partial']), clause_id: z.string().max(128).nullable(), quote: z.string().max(8000), pointer: z.string().max(64), confirmable: z.boolean() }).strict();
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const MatterStateSchema = z.object({
  schema_version: z.literal(MATTER_STATE_VERSION), revision, extractor_method: z.enum(['regex','llm','jev','mock']),
  intake: z.array(z.object({ id: z.string().max(32), text_normalised: z.string().max(8000) }).strict()).max(12),
  fields: z.object(shape).strict(),
  request_items: z.array(z.object({ id: z.string().max(256), quote: z.string().max(8000), pointer: z.string().max(64), clause_id: z.string().max(128).nullable(), sources: z.array(source).max(2), detectors: z.array(z.string().max(64)).max(16) }).strict()).max(100),
  residuals: z.array(notIncluded).max(100),
  confirmations: z.array(z.object({ request_id: z.string().max(256), confirmed_at: z.string().max(64), revision }).strict()).max(100),
  answers: z.array(answer.extend({ fields: z.array(key).min(1).max(15), revision }).strict()).max(100),
  diagnostics: z.object({ dropped_keys: z.array(z.string().max(256)).max(2000), dropped_items: z.array(z.string().max(256)).max(2000), rejected_proposals: z.array(z.object({ index: z.number().int().nonnegative(), field: z.string().max(128), reason: z.string().max(256) }).strict()).max(200), request_drops: z.array(z.object({ index: z.number().int().nonnegative(), reason: z.string().max(256) }).strict()).max(100), extractor_error: z.string().max(128).optional() }).strict(),
}).strict();
export class MatterJsonError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'MatterJsonError'; this.code = code; }
}
function invalid(code: string): never { throw new MatterJsonError(code); }
/** Validates shape, normalized intake, pointers, values, answer semantics and revision lineage. */
export function validateMatterState(input: unknown): MatterState {
  const parsed = MatterStateSchema.safeParse(input);
  if (!parsed.success) invalid('matter_schema');
  const state: MatterState = parsed.data;
  if (utf8Encode(canonicalJson(state)).length > 262144) invalid('matter_size');
  const norm = normaliseIntake(state.intake.map((m) => ({ id: m.id, text: m.text_normalised })));
  if (!norm.ok || canonicalJson(norm.messages) !== canonicalJson(state.intake)) invalid('matter_intake');
  const intake = { messages: state.intake };
  const checkSpan = (s: { quote: string; pointer: string }): void => { if (!groundQuote(intake, s.quote, s.pointer).ok) invalid('matter_pointer'); };
  for (const k of FIELD_KEYS) {
    const f = state.fields[k];
    if (f.field !== k || (f.state !== 'valid' && f.value !== undefined)) invalid('matter_field_state');
    if (f.state === 'valid') { const r = FIELD_SPECS[k].validate(f.value); if (!r.ok || canonicalJson(r.value) !== canonicalJson(f.value)) invalid('matter_field_value'); }
    if (f.state === 'none_confirmed' && (FIELD_SPECS[k].required || f.method !== 'none_confirmed')) invalid('matter_none');
    if ((f.quote === undefined) !== (f.pointer === undefined)) invalid('matter_span');
    if (f.quote !== undefined && f.pointer !== undefined) checkSpan({ quote: f.quote, pointer: f.pointer });
    f.candidates.forEach((c) => { checkSpan(c); const r = FIELD_SPECS[k].validate(c.value); if (!r.ok || canonicalJson(r.value) !== canonicalJson(c.value)) invalid('matter_candidate_value'); });
    f.evidence?.forEach(checkSpan); if (f.relative) checkSpan(f.relative);
    if (f.utilities && (new Set(f.utilities.tenant_pays).size !== f.utilities.tenant_pays.length || new Set(f.utilities.included).size !== f.utilities.included.length || (f.state === 'valid' && f.utilities.tenant_pays.some((v) => f.utilities!.included.includes(v))))) invalid('matter_utilities');
    if (f.state === 'valid' && f.method === undefined) invalid('matter_method');
    if (f.method === 'computed' && k !== 'end_date') invalid('matter_computed');
    if (f.state === 'valid' && f.method !== 'user_answer' && f.method !== 'computed' && k !== 'utilities' && f.relative === undefined) {
      if (f.quote === undefined) invalid('matter_evidence');
      const r = FIELD_SPECS[k].parse(f.quote);
      if (!r.ok || canonicalJson(r.value) !== canonicalJson(f.value)) invalid('matter_evidence_value');
    }
    if (f.method === 'user_answer' || f.method === 'none_confirmed') {
      if (f.answer === undefined) invalid('matter_answer');
      const entry = state.answers.filter((a) => a.fields.includes(k)).at(-1);
      if (!entry || canonicalJson(f.answer) !== canonicalJson({ question_id: entry.question_id, answer: entry.answer, answered_at: entry.answered_at })) invalid('matter_answer_log');
      const reapplied = applyAnswer(state, f.answer.question_id, f.answer.answer, { clock: () => f.answer!.answered_at });
      if (!reapplied.ok) invalid('matter_answer_parse');
      const again = reapplied.state.fields[k];
      if (again.state !== f.state || canonicalJson(again.value ?? null) !== canonicalJson(f.value ?? null)) invalid('matter_answer_value');
    } else if (f.answer !== undefined) invalid('matter_unexpected_answer');
  }
  const requestIds = new Set<string>();
  for (const r of [...state.request_items, ...state.residuals]) { checkSpan(r); if (requestIds.has(r.id)) invalid('matter_request_duplicate'); requestIds.add(r.id); }
  const revisions = [...state.answers.map((a) => a.revision), ...state.confirmations.map((c) => c.revision)].sort((a,b) => a-b);
  if (revisions.length !== state.revision - 1 || revisions.some((r,i) => r !== i + 2)) invalid('matter_revision_lineage');
  if (state.answers.some((a,i) => new Set(a.fields).size !== a.fields.length || (i && state.answers[i-1].revision >= a.revision))) invalid('matter_answer_order');
  const confirmed = new Set<string>();
  for (const c of state.confirmations) { if (!state.request_items.some((r) => r.id === c.request_id) || confirmed.has(c.request_id)) invalid('matter_confirmation'); confirmed.add(c.request_id); }
  // Return a detached canonical copy; no caller-owned mutable array survives validation.
  return JSON.parse(canonicalJson(state)) as MatterState;
}

export function exportMatterJson(state: MatterState): string {
  return canonicalJson({ format: 'template-fill-bot-matter', version: 1, state: validateMatterState(state) });
}
/** Envelope and state-level approvals are discarded before strict schema validation. */
export function importMatterJson(text: string): MatterState {
  if (text.length > 262144 || utf8Encode(text).length > 262144) invalid('matter_size');
  let input: unknown;
  try { input = JSON.parse(text); } catch { invalid('matter_json'); }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) invalid('matter_envelope');
  const root = { ...(input as Record<string, unknown>) };
  delete root.approvals;
  let state: unknown = root;
  if ('state' in root) {
    if (root.format !== 'template-fill-bot-matter' || root.version !== 1 || Object.keys(root).some((k) => !['format','version','state'].includes(k))) invalid('matter_envelope');
    state = root.state;
  }
  if (typeof state !== 'object' || state === null || Array.isArray(state)) invalid('matter_schema');
  const cleaned = { ...(state as Record<string, unknown>) };
  delete cleaned.approvals;
  return validateMatterState(cleaned);
}
