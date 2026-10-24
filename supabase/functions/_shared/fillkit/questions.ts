// Questions and answers (PLAN sections 4.5 and K2). Pure.
//
// - One fixed template per non-valid field (template id/text from fields.ts FIELD_SPECS), with code-rendered
//   candidate options and manual entry. Not asked: a field that is missing only because a dependency is not
//   yet valid (`pending_dependency`: end_date, relative deposit).
// - Enum fields offer exactly their closed values (pets: none / with_consent).
// - utilities asks for the FULL tenant-pays set; suggestions complete the partial classification (unclassified
//   categories included in rent, or paid by the tenant).
// - guarantor / break_month with NO evidence at all are coalesced into ONE blocking optional-terms
//   confirmation (K2); a cue without a resolvable value (e.g. "guarantor for Joe only") gets its own question.
// - EVERY open question blocks render.
// - applyAnswer re-parses / re-validates the answer with the SAME field parser/validator, stores method
//   `user_answer` (or `none_confirmed`) with question id, answer and timestamp (from an injected clock) and
//   increments the revision. The model is never re-called. A previously answered question may be answered
//   again (journey step 6: "change the rent answer").
import { z } from 'zod';
import { FIELD_KEYS, FIELD_KIND_OF, UTILITY_CATEGORIES } from '../content/types.ts';
import type { FieldKey } from '../content/types.ts';
import { FURNISHED_VALUES, PETS_VALUES, SMOKING_VALUES } from './candidates/index.ts';
import { DEFAULT_FIELD_CONTEXT, FIELD_SPECS } from './fields.ts';
import type { FieldContext, FieldResult, FieldValue } from './fields.ts';
import type { GroundedField } from './grounding.ts';
import type { AnswerLogEntry, MatterState } from './matter.ts';
import type { FieldState } from './schema.ts';
import { formatDate, formatMoney } from './segments.ts';
import { inclusiveEndDate, validateFields } from './validate.ts';

export const OPTIONAL_TERMS_QUESTION_ID = 'q.optional_terms.v1';
export const OPTIONAL_TERM_FIELDS = ['guarantor', 'break_month'] as const;
export type OptionalTermField = (typeof OPTIONAL_TERM_FIELDS)[number];

/** Fixed optional-terms texts (one per combination of unconfirmed optional fields). */
export const OPTIONAL_TERMS_TEXT = {
  both:
    'No guarantor and no break clause were mentioned. Confirm there is neither, or enter the guarantor\'s full ' +
    'name and/or the month after which the break clause can be used.',
  guarantor: 'No guarantor was mentioned. Confirm there is none, or enter the guarantor\'s full name.',
  break_month: 'No break clause was mentioned. Confirm there is none, or enter the month after which it can be used.',
} as const;

// ------------------------------------------------------------------------------------------------ answers

const AnswerValueSchema = z.union([z.string().max(500), z.number(), z.array(z.string().max(200)).max(8)]);

export const AnswerInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('option'), option_id: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal('text'), text: z.string().max(500) }).strict(),
  z.object({ kind: z.literal('value'), value: AnswerValueSchema }).strict(),
  z.object({ kind: z.literal('none') }).strict(),
  z
    .object({
      kind: z.literal('optional_terms'),
      guarantor: z.union([z.string().max(200), z.null()]).optional(),
      break_month: z.union([z.string().max(50), z.number(), z.null()]).optional(),
    })
    .strict(),
]);
export type AnswerInput = z.infer<typeof AnswerInputSchema>;

/** Stored with an answered field. */
export interface AnswerRecord {
  readonly question_id: string;
  readonly answer: AnswerInput;
  readonly answered_at: string;
}

// ---------------------------------------------------------------------------------------------- questions

export interface QuestionOption {
  readonly id: string;
  /** Code-rendered label (UI text only; never enters the agreement). */
  readonly label: string;
  /** null = "none" (optional fields only). */
  readonly value: FieldValue | null;
}

export interface Question {
  readonly id: string;
  readonly kind: 'field' | 'optional_terms';
  readonly fields: readonly FieldKey[];
  readonly text: string;
  readonly state?: FieldState;
  readonly reasons: readonly string[];
  readonly options: readonly QuestionOption[];
  readonly manual_entry: true;
  readonly blocking: true;
}

const ENUM_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  pets: { none: 'No pets', with_consent: "Pets only with the landlord's consent" },
  smoking: { prohibited: 'No smoking anywhere', permitted_outside: 'Smoking outside only' },
  furnished: { furnished: 'Furnished', unfurnished: 'Unfurnished' },
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  pets: PETS_VALUES,
  smoking: SMOKING_VALUES,
  furnished: FURNISHED_VALUES,
};

function plainJoin(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** UI label for an option value. */
export function optionLabel(field: FieldKey, value: FieldValue | null, ctx: FieldContext = DEFAULT_FIELD_CONTEXT): string {
  if (value === null) {
    if (field === 'guarantor') return 'No guarantor';
    if (field === 'break_month') return 'No break clause';
    return 'None';
  }
  switch (FIELD_KIND_OF[field]) {
    case 'money':
      return typeof value === 'number' ? formatMoney(value, ctx.jurisdiction.currency.symbol) : String(value);
    case 'date':
    case 'computed':
      return typeof value === 'string' ? formatDate(value) : String(value);
    case 'int':
      if (field === 'term_months') return `${String(value)} months`;
      if (field === 'break_month') return `After month ${String(value)}`;
      return `Day ${String(value)}`;
    case 'enum':
      return ENUM_LABELS[field]?.[String(value)] ?? String(value);
    case 'nameList':
      return Array.isArray(value) ? plainJoin(value) : String(value);
    case 'enumSet': {
      if (!Array.isArray(value)) return String(value);
      const tenant = UTILITY_CATEGORIES.filter((c) => value.includes(c));
      const included = UTILITY_CATEGORIES.filter((c) => !value.includes(c));
      const t = tenant.length === 0 ? 'Tenant pays none of these' : `Tenant pays ${plainJoin(tenant)}`;
      return included.length === 0 ? t : `${t}; ${plainJoin(included)} included in rent`;
    }
    default:
      return String(value);
  }
}

function sameValue(a: FieldValue, b: FieldValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
  }
  return a === b;
}

function fieldOptionValues(field: FieldKey, f: GroundedField, eff: Readonly<Record<FieldKey, GroundedField>>): FieldValue[] {
  const kind = FIELD_KIND_OF[field];
  const out: FieldValue[] = [];
  const add = (v: FieldValue): void => {
    if (!out.some((o) => sameValue(o, v))) out.push(v);
  };
  if (kind === 'enum') {
    for (const v of ENUM_VALUES[field] ?? []) add(v);
    return out;
  }
  if (kind === 'enumSet') {
    const p = f.utilities;
    if (p !== undefined) {
      const tenant = UTILITY_CATEGORIES.filter((c) => p.tenant_pays.includes(c) && !p.included.includes(c));
      const unclassified = UTILITY_CATEGORIES.filter((c) => !p.tenant_pays.includes(c) && !p.included.includes(c));
      add(tenant);
      if (unclassified.length > 0) add(UTILITY_CATEGORIES.filter((c) => tenant.includes(c) || unclassified.includes(c)));
    }
    return out;
  }
  if (field === 'end_date') {
    const s = eff.start_date;
    const t = eff.term_months;
    if (s.state === 'valid' && t.state === 'valid' && typeof s.value === 'string' && typeof t.value === 'number') {
      add(inclusiveEndDate(s.value, t.value));
    }
  }
  for (const c of f.candidates) add(c.value);
  return out;
}

function fieldQuestion(field: FieldKey, f: GroundedField, eff: Readonly<Record<FieldKey, GroundedField>>, ctx: FieldContext): Question {
  const spec = FIELD_SPECS[field];
  const options: QuestionOption[] = fieldOptionValues(field, f, eff).map((value, i) => ({
    id: `o${i + 1}`,
    label: optionLabel(field, value, ctx),
    value,
  }));
  if (!spec.required) options.push({ id: 'none', label: optionLabel(field, null, ctx), value: null });
  return {
    id: spec.questionTemplate.id,
    kind: 'field',
    fields: [field],
    text: spec.questionTemplate.text,
    state: f.state,
    reasons: [...f.reasons],
    options,
    manual_entry: true,
    blocking: true,
  };
}

function optionalTermsQuestion(fields: readonly OptionalTermField[]): Question {
  const both = fields.includes('guarantor') && fields.includes('break_month');
  const text = both
    ? OPTIONAL_TERMS_TEXT.both
    : fields.includes('guarantor')
      ? OPTIONAL_TERMS_TEXT.guarantor
      : OPTIONAL_TERMS_TEXT.break_month;
  const label = both ? 'No guarantor and no break clause' : fields.includes('guarantor') ? 'No guarantor' : 'No break clause';
  return {
    id: OPTIONAL_TERMS_QUESTION_ID,
    kind: 'optional_terms',
    fields: [...fields],
    text,
    reasons: ['no_evidence'],
    options: [{ id: 'none', label, value: null }],
    manual_entry: true,
    blocking: true,
  };
}

/** An optional field with no evidence at all (nothing proposed, nothing found, nothing answered). */
export function hasNoEvidence(f: GroundedField): boolean {
  return (
    f.state === 'missing' &&
    f.candidates.length === 0 &&
    f.quote === undefined &&
    f.pointer === undefined &&
    (f.evidence === undefined || f.evidence.length === 0) &&
    f.answer === undefined &&
    f.relative === undefined &&
    f.utilities === undefined &&
    f.reasons.every((r) => r === 'no_proposal')
  );
}

function isOptionalTermField(k: FieldKey): k is OptionalTermField {
  return (OPTIONAL_TERM_FIELDS as readonly string[]).includes(k);
}

/** Open questions for the EFFECTIVE field records, in schema order, optional-terms confirmation last. */
export function buildQuestions(
  eff: Readonly<Record<FieldKey, GroundedField>>,
  ctx: FieldContext = DEFAULT_FIELD_CONTEXT,
): Question[] {
  const out: Question[] = [];
  const optional: OptionalTermField[] = [];
  for (const k of FIELD_KEYS) {
    const f = eff[k];
    if (f.state === 'valid' || f.state === 'none_confirmed') continue;
    if (f.state === 'missing' && f.reasons.includes('pending_dependency')) continue;
    if (isOptionalTermField(k) && hasNoEvidence(f)) {
      optional.push(k);
      continue;
    }
    out.push(fieldQuestion(k, f, eff, ctx));
  }
  if (optional.length > 0) out.push(optionalTermsQuestion(optional));
  return out;
}

// ------------------------------------------------------------------------------------------- applyAnswer

export type ApplyAnswerErrorCode =
  | 'malformed_answer'
  | 'question_not_open'
  | 'unknown_option'
  | 'answer_kind_mismatch'
  | 'invalid_answer';

export interface ApplyAnswerError {
  readonly code: ApplyAnswerErrorCode;
  /** Short code (field failure reason, field name): never echoes the answer text. */
  readonly detail: string;
}

export type ApplyAnswerResult =
  | { readonly ok: true; readonly state: MatterState }
  | { readonly ok: false; readonly error: ApplyAnswerError };

export interface ApplyAnswerOptions {
  /** ISO timestamp source; inject a fixed clock for deterministic tests. */
  readonly clock?: () => string;
  readonly ctx?: FieldContext;
}

type Update = { readonly field: FieldKey; readonly value: FieldValue } | { readonly field: FieldKey; readonly none: true };
type Resolution = { readonly ok: true; readonly updates: Update[] } | { readonly ok: false; readonly error: ApplyAnswerError };

const err = (code: ApplyAnswerErrorCode, detail: string): Resolution => ({ ok: false, error: { code, detail } });

function fromFieldResult(field: FieldKey, r: FieldResult): Resolution {
  return r.ok ? { ok: true, updates: [{ field, value: r.value }] } : err('invalid_answer', `${field}:${r.reason}`);
}

function resolveFieldAnswer(q: Question, answer: AnswerInput, ctx: FieldContext): Resolution {
  const field = q.fields[0];
  if (field === undefined) return err('question_not_open', 'no_field');
  const spec = FIELD_SPECS[field];
  switch (answer.kind) {
    case 'option': {
      const opt = q.options.find((o) => o.id === answer.option_id);
      if (opt === undefined) return err('unknown_option', field);
      if (opt.value === null) {
        return spec.required ? err('answer_kind_mismatch', field) : { ok: true, updates: [{ field, none: true }] };
      }
      return fromFieldResult(field, spec.validate(opt.value, ctx));
    }
    case 'text':
      return fromFieldResult(field, spec.parse(answer.text, ctx));
    case 'value':
      return fromFieldResult(field, spec.validate(answer.value, ctx));
    case 'none':
      return spec.required ? err('answer_kind_mismatch', field) : { ok: true, updates: [{ field, none: true }] };
    default:
      return err('answer_kind_mismatch', field);
  }
}

function resolveOptionalTermsAnswer(q: Question, answer: AnswerInput, ctx: FieldContext): Resolution {
  const fields = q.fields;
  const allNone = (): Resolution => ({ ok: true, updates: fields.map((field) => ({ field, none: true as const })) });
  if (answer.kind === 'none') return allNone();
  if (answer.kind === 'option') {
    return q.options.some((o) => o.id === answer.option_id && o.value === null) ? allNone() : err('unknown_option', 'optional_terms');
  }
  if (answer.kind !== 'optional_terms') return err('answer_kind_mismatch', 'optional_terms');
  const updates: Update[] = [];
  for (const k of OPTIONAL_TERM_FIELDS) {
    const given = answer[k];
    if (!fields.includes(k)) {
      if (given !== undefined) return err('invalid_answer', `${k}:not_in_question`);
      continue;
    }
    if (given === undefined) return err('invalid_answer', `${k}:missing`);
    if (given === null) {
      updates.push({ field: k, none: true });
      continue;
    }
    const spec = FIELD_SPECS[k];
    const r = typeof given === 'string' ? spec.parse(given, ctx) : spec.validate(given, ctx);
    if (!r.ok) return err('invalid_answer', `${k}:${r.reason}`);
    updates.push({ field: k, value: r.value });
  }
  return { ok: true, updates };
}

/** The question to answer: an open one, or a previously answered one being changed. */
function findQuestion(state: MatterState, eff: Readonly<Record<FieldKey, GroundedField>>, questionId: string, ctx: FieldContext): Question | null {
  const open = buildQuestions(eff, ctx).find((q) => q.id === questionId);
  if (open !== undefined) return open;
  if (questionId === OPTIONAL_TERMS_QUESTION_ID) {
    const answered = OPTIONAL_TERM_FIELDS.filter((k) => state.fields[k].answer?.question_id === OPTIONAL_TERMS_QUESTION_ID);
    return answered.length > 0 ? optionalTermsQuestion(answered) : null;
  }
  for (const k of FIELD_KEYS) {
    if (FIELD_SPECS[k].questionTemplate.id === questionId && state.fields[k].answer?.question_id === questionId) {
      return fieldQuestion(k, eff[k], eff, ctx);
    }
  }
  return null;
}

/**
 * Apply one answer. On success returns a NEW state with revision + 1; the input state is not modified.
 * Errors leave the state unchanged and never echo answer text.
 */
export function applyAnswer(
  state: MatterState,
  questionId: string,
  answer: unknown,
  opts: ApplyAnswerOptions = {},
): ApplyAnswerResult {
  const parsed = AnswerInputSchema.safeParse(answer);
  if (!parsed.success) return { ok: false, error: { code: 'malformed_answer', detail: 'answer_schema' } };
  const ctx = opts.ctx ?? DEFAULT_FIELD_CONTEXT;
  const eff = validateFields(state.fields, ctx);
  const q = findQuestion(state, eff, questionId, ctx);
  if (q === null) return { ok: false, error: { code: 'question_not_open', detail: 'question' } };
  const res = q.kind === 'optional_terms' ? resolveOptionalTermsAnswer(q, parsed.data, ctx) : resolveFieldAnswer(q, parsed.data, ctx);
  if (!res.ok) return res;

  const answeredAt = (opts.clock ?? (() => new Date().toISOString()))();
  const record: AnswerRecord = { question_id: q.id, answer: parsed.data, answered_at: answeredAt };
  const fields: Record<FieldKey, GroundedField> = { ...state.fields };
  for (const u of res.updates) {
    const prev = state.fields[u.field];
    fields[u.field] =
      'none' in u
        ? { field: u.field, state: 'none_confirmed', method: 'none_confirmed', candidates: prev.candidates, reasons: [], answer: record }
        : { field: u.field, state: 'valid', value: u.value, method: 'user_answer', candidates: prev.candidates, reasons: [], answer: record };
  }
  const revision = state.revision + 1;
  const entry: AnswerLogEntry = {
    question_id: q.id,
    fields: res.updates.map((u) => u.field),
    answer: parsed.data,
    answered_at: answeredAt,
    revision,
  };
  return { ok: true, state: { ...state, revision, fields, answers: [...state.answers, entry] } };
}
