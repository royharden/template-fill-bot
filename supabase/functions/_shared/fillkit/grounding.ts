// Grounding (PLAN section 4.5): extractor proposals + code-found candidates + intake -> one GroundedField per
// schema field. Pure; the same code runs in the browser, in tests and in the edge function.
//
// Rules, per proposal:
// - The field must be a schema field (else rejected `unknown_field`).
// - The span comes from the proposal's quote (grounded exactly at its pointer, or as the unique occurrence when
//   no pointer is given) or, with no quote, from a code-found candidate named by `candidate_id`. A proposal with
//   neither is rejected (`no_quote`); an unknown candidate id is rejected (`unknown_candidate`).
// - The VALUE IS RE-DERIVED FROM THE QUOTE with the field parser. A model value is only compared: a mismatch
//   makes the field `invalid` with reason `value_quote_mismatch`. The model value never becomes the value.
// - Names and addresses must be the payload of a code-matched role cue: the span must start where a role
//   candidate for that field starts (else rejected `no_role_cue`); a span that ends anywhere else than the
//   role payload end is `invalid` (`not_role_payload`, or the validator's reason).
// - Enums need a cue word (the classifiers only fire on cue patterns); utilities need a pays/included cue.
// - A long quote that does not parse as a whole is narrowed to the code-found candidates of that field lying
//   inside it (dates, money and integers only; reason `narrowed_to_candidate`).
// Per field:
// - No grounded proposal -> `missing`, except code-found ambiguity still requires its own question;
//   code-found spans remain evidence even when they yield no option values.
// - Otherwise every grounded value (proposals AND that field's code-found candidates) is kept in
//   `candidates`; >= 2 distinct values -> `conflict` even if the model picked one.
// - Precedence: invalid > conflict > ambiguous > (deposit relative -> missing/pending_dependency) > valid.
// Reasons are short codes; they never contain intake text.
import { canonicalJson } from './canonicalJson.ts';
import { FIELD_KEYS, FIELD_KIND_OF, UTILITY_CATEGORIES } from '../content/types.ts';
import type { FieldKey, MethodToken, UtilityCategory } from '../content/types.ts';
import { groundQuote, parsePointer } from './cited.ts';
import { classifyUtilities, parseDateText, parseRelativeDepositText } from './candidates/index.ts';
import { DEFAULT_FIELD_CONTEXT, FIELD_SPECS, normaliseFreeText, partyKey } from './fields.ts';
import type { FieldContext, FieldValue } from './fields.ts';
import type { IntakeLike } from './normalize.ts';
import type { Candidate, FieldProposal, FieldState } from './schema.ts';
import type { ExtractorMethod } from './extractors/types.ts';
import type { AnswerRecord } from './questions.ts';

/** Method recorded for a value. `computed` is used only for end_date (never shown as an appendix token). */
export type FieldMethod = MethodToken | 'computed';
export type EvidenceSource = 'extractor' | 'code';

/** One grounded reading of a field: a validated value with the verbatim normalised quote and its pointer. */
export interface EvidenceValue {
  readonly value: FieldValue;
  readonly quote: string;
  readonly pointer: string;
  readonly source: EvidenceSource;
  readonly candidate_id?: string;
  /** One reading of an ambiguous span (e.g. both readings of 03/04/2027). Offered as an option only. */
  readonly ambiguous?: true;
}

/** "one month's rent" style deposit; resolved by validate.ts once monthly_rent is valid. */
export interface RelativeDeposit {
  readonly months: number;
  readonly quote: string;
  readonly pointer: string;
  readonly source: EvidenceSource;
  /** Numeric model claims are compared only after rent resolves; they never supply the deposit amount. */
  readonly claims?: readonly number[];
}

/** Partial utilities classification gathered from the evidence (tenant-paid vs included-in-rent). */
export interface UtilitiesPartial {
  readonly tenant_pays: readonly UtilityCategory[];
  readonly included: readonly UtilityCategory[];
}

/**
 * Per-field record. In MatterState this is the BASE record (grounding, then user answers); validate.ts derives
 * the effective record (cross-field rules) from it on every read, so nothing ever has to be "un-applied".
 */
export interface GroundedField {
  readonly field: FieldKey;
  readonly state: FieldState;
  /** Present only when state is `valid`. */
  readonly value?: FieldValue;
  readonly method?: FieldMethod;
  readonly quote?: string;
  readonly pointer?: string;
  /** Contributing unresolved/code-only or utilities spans; each must be re-grounded by the gate. */
  readonly evidence?: readonly { readonly quote: string; readonly pointer: string }[];
  /** All distinct grounded readings (definite values first-seen per value, plus ambiguous readings). */
  readonly candidates: readonly EvidenceValue[];
  readonly reasons: readonly string[];
  readonly relative?: RelativeDeposit;
  readonly utilities?: UtilitiesPartial;
  /** Set when the value came from a user answer (method user_answer / none_confirmed). */
  readonly answer?: AnswerRecord;
}

export type FieldRecords = Readonly<Record<FieldKey, GroundedField>>;

export interface ProposalRejection {
  /** Index into the parsed proposal list. */
  readonly index: number;
  /** The proposal's field name (a schema field name or the literal 'unknown'). */
  readonly field: string;
  readonly reason: string;
}

export interface GroundingInput {
  readonly intake: IntakeLike;
  /** Code-found candidates (findAllCandidates(intake).candidates). */
  readonly candidates: readonly Candidate[];
  readonly proposals: readonly FieldProposal[];
  readonly method: ExtractorMethod;
  readonly ctx?: FieldContext;
}

export interface GroundingResult {
  readonly fields: Record<FieldKey, GroundedField>;
  readonly rejected: ProposalRejection[];
}

// ------------------------------------------------------------------------------------------------ internals

interface GroundSpan {
  readonly quote: string;
  readonly pointer: string;
  readonly message_id: string;
  readonly start: number;
  readonly end: number;
  readonly candidate_id?: string;
}

type Item =
  | { readonly t: 'value'; readonly value: FieldValue; readonly span: GroundSpan; readonly narrowed?: true }
  | { readonly t: 'ambiguous'; readonly reason: string; readonly options: readonly FieldValue[]; readonly span: GroundSpan }
  | { readonly t: 'invalid'; readonly reason: string; readonly span: GroundSpan }
  | { readonly t: 'relative'; readonly months: number; readonly span: GroundSpan; readonly claim?: number }
  | { readonly t: 'utilities'; readonly partial: UtilitiesPartial; readonly span: GroundSpan };

interface Fail {
  readonly t: 'fail';
  readonly reason: string;
}

const fail = (reason: string): Fail => ({ t: 'fail', reason });

function isFieldKey(value: unknown): value is FieldKey {
  return typeof value === 'string' && (FIELD_KEYS as readonly string[]).includes(value);
}

function spanFromCandidate(c: Candidate): GroundSpan | null {
  const p = parsePointer(c.pointer);
  if (p === null) return null;
  return { quote: c.quote, pointer: c.pointer, message_id: p.message_id, start: p.start, end: p.end, candidate_id: c.id };
}

/** Sort key (message order, start, end) for a pointer; unknown pointers sort last. */
export function pointerSortKey(intake: IntakeLike, pointer: string): [number, number, number] {
  const p = parsePointer(pointer);
  if (p === null) return [Number.MAX_SAFE_INTEGER, 0, 0];
  const idx = intake.messages.findIndex((m) => m.id === p.message_id);
  return [idx < 0 ? Number.MAX_SAFE_INTEGER : idx, p.start, p.end];
}

export function comparePointers(intake: IntakeLike, a: string, b: string): number {
  const ka = pointerSortKey(intake, a);
  const kb = pointerSortKey(intake, b);
  return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
}

/** Distinctness key for a field value: party key for names/addresses, canonical JSON otherwise. */
export function valueKey(field: FieldKey, value: FieldValue): string {
  const kind = FIELD_KIND_OF[field];
  if ((kind === 'name' || kind === 'address') && typeof value === 'string') return `p:${partyKey(value)}`;
  if (kind === 'nameList' && Array.isArray(value)) return `l:${canonicalJson(value.map((n) => partyKey(n)))}`;
  return `v:${canonicalJson(value)}`;
}

function evaluateRole(field: FieldKey, span: GroundSpan, codeCandidates: readonly Candidate[], ctx: FieldContext): Item | Fail {
  let role: Candidate | null = null;
  for (const c of codeCandidates) {
    if (c.kind !== 'role' || c.field !== field) continue;
    const p = parsePointer(c.pointer);
    if (p !== null && p.message_id === span.message_id && p.start === span.start) {
      role = c;
      break;
    }
  }
  if (role === null) return fail('no_role_cue');
  const rp = parsePointer(role.pointer);
  const exact = rp !== null && rp.end === span.end;
  const parsed = FIELD_SPECS[field].parse(span.quote, ctx);
  if (!exact) return { t: 'invalid', reason: parsed.ok ? 'not_role_payload' : parsed.reason, span };
  if (role.value === null && (role.flags ?? []).includes('ambiguous')) {
    return { t: 'ambiguous', reason: field === 'guarantor' ? 'partial_guarantee' : 'ambiguous_split', options: [], span };
  }
  if (parsed.ok) return { t: 'value', value: parsed.value, span };
  if (parsed.reason === 'ambiguous_split') return { t: 'ambiguous', reason: 'ambiguous_split', options: [], span };
  return { t: 'invalid', reason: parsed.reason, span };
}

function evaluateDate(field: FieldKey, span: GroundSpan): Item | Fail {
  const r = parseDateText(span.quote);
  if (r.ok) {
    const v = FIELD_SPECS[field].validate(r.iso);
    return v.ok ? { t: 'value', value: v.value, span } : { t: 'invalid', reason: v.reason, span };
  }
  switch (r.reason) {
    case 'ambiguous_date':
      return { t: 'ambiguous', reason: 'ambiguous_date', options: [...(r.alternatives ?? [])], span };
    case 'needs_year':
    case 'relative_date':
      return { t: 'ambiguous', reason: r.reason, options: [], span };
    case 'impossible_date':
      return { t: 'invalid', reason: 'impossible_date', span };
    default:
      return fail('unparseable');
  }
}

function evaluateNumeric(field: FieldKey, span: GroundSpan, ctx: FieldContext): Item | Fail {
  const r = FIELD_SPECS[field].parse(span.quote, ctx);
  if (r.ok) return { t: 'value', value: r.value, span };
  if (field === 'deposit' && r.reason === 'relative_value') {
    const rel = parseRelativeDepositText(span.quote);
    return rel === null ? fail('unparseable') : { t: 'relative', months: rel.months, span };
  }
  if (r.reason === 'unrecognised') return fail('unparseable');
  return { t: 'invalid', reason: r.reason, span };
}

function evaluateEnum(field: FieldKey, span: GroundSpan, ctx: FieldContext): Item | Fail {
  const r = FIELD_SPECS[field].parse(span.quote, ctx);
  if (r.ok) return { t: 'value', value: r.value, span };
  if (r.reason === 'ambiguous') return { t: 'ambiguous', reason: 'ambiguous', options: [], span };
  if (r.reason === 'no_cue') return fail('no_cue');
  return { t: 'invalid', reason: r.reason, span };
}

function evaluateUtilities(span: GroundSpan): Item | Fail {
  const c = classifyUtilities(span.quote);
  if (c === null) return fail('no_cue');
  if (c.ambiguous) return { t: 'ambiguous', reason: 'utilities_contradictory', options: [], span };
  return { t: 'utilities', partial: { tenant_pays: [...c.tenant_pays], included: [...c.included] }, span };
}

/** Evaluate one span for one field (no narrowing). */
function evaluateSpan(field: FieldKey, span: GroundSpan, codeCandidates: readonly Candidate[], ctx: FieldContext): Item | Fail {
  switch (FIELD_KIND_OF[field]) {
    case 'name':
    case 'address':
    case 'nameList':
      return evaluateRole(field, span, codeCandidates, ctx);
    case 'date':
    case 'computed':
      return evaluateDate(field, span);
    case 'money':
    case 'int':
      return evaluateNumeric(field, span, ctx);
    case 'enum':
      return evaluateEnum(field, span, ctx);
    case 'enumSet':
      return evaluateUtilities(span);
    default:
      return fail('unsupported_field_kind');
  }
}

const NARROWABLE_KINDS = new Set(['date', 'computed', 'money', 'int']);

/** Evaluate a proposal span; a long quote that does not parse is narrowed to contained code candidates. */
function evaluateProposalSpan(
  field: FieldKey,
  span: GroundSpan,
  codeCandidates: readonly Candidate[],
  ctx: FieldContext,
): Item[] | Fail {
  const first = evaluateSpan(field, span, codeCandidates, ctx);
  if (first.t !== 'fail') return [first];
  if (first.reason !== 'unparseable' || !NARROWABLE_KINDS.has(FIELD_KIND_OF[field])) return first;
  const inner: Item[] = [];
  for (const c of codeCandidates) {
    if (c.field !== field || c.kind === 'role') continue;
    const cs = spanFromCandidate(c);
    if (cs === null || cs.message_id !== span.message_id) continue;
    if (cs.start < span.start || cs.end > span.end || (cs.start === span.start && cs.end === span.end)) continue;
    const r = evaluateSpan(field, cs, codeCandidates, ctx);
    if (r.t === 'value') inner.push({ ...r, narrowed: true });
    else if (r.t !== 'fail') inner.push(r);
  }
  return inner.length > 0 ? inner : first;
}

function sameFreeText(model: string, value: string): boolean {
  const n = normaliseFreeText(model);
  return n.ok && typeof n.value === 'string' && partyKey(n.value) === partyKey(value);
}

/** Does a model-proposed value agree with the value re-derived from the quote? (Comparison only.) */
function modelAgrees(field: FieldKey, model: unknown, item: Item, ctx: FieldContext): boolean {
  if (model === undefined || model === null) return true;
  const spec = FIELD_SPECS[field];
  if (item.t === 'relative') {
    if (typeof model === 'string') {
      const rel = parseRelativeDepositText(model);
      return rel !== null && rel.months === item.months;
    }
    // A resolved amount cannot be checked before monthly_rent is valid; the quote still decides.
    return typeof model === 'number';
  }
  if (item.t === 'utilities') {
    let cats: unknown = null;
    if (Array.isArray(model)) cats = model;
    else if (typeof model === 'string') {
      const r = spec.parse(model, ctx);
      cats = r.ok ? r.value : null;
    }
    const v = spec.validate(cats, ctx);
    if (!v.ok || !Array.isArray(v.value)) return false;
    const set = v.value;
    return (
      item.partial.tenant_pays.every((c) => set.includes(c)) &&
      !set.some((c) => (item.partial.included as readonly string[]).includes(c))
    );
  }
  if (item.t !== 'value') return true;
  const v = item.value;
  switch (FIELD_KIND_OF[field]) {
    case 'money':
      if (typeof model === 'number') return model === v || model * 100 === v;
      if (typeof model === 'string') {
        const r = spec.parse(model, ctx);
        return r.ok && r.value === v;
      }
      return false;
    case 'int':
      if (typeof model === 'number') return model === v;
      if (typeof model === 'string') {
        const r = spec.parse(model, ctx);
        return r.ok && r.value === v;
      }
      return false;
    case 'date':
    case 'computed':
      if (typeof model !== 'string') return false;
      {
        const r = parseDateText(model);
        return r.ok && r.iso === v;
      }
    case 'enum':
      return model === v;
    case 'name':
    case 'address':
      return typeof model === 'string' && typeof v === 'string' && sameFreeText(model, v);
    case 'nameList': {
      let list: unknown = null;
      if (Array.isArray(model)) list = model;
      else if (typeof model === 'string') {
        const r = spec.parse(model, ctx);
        list = r.ok ? r.value : null;
      }
      if (!Array.isArray(list) || !Array.isArray(v) || list.length !== v.length) return false;
      return list.every((n, i) => typeof n === 'string' && sameFreeText(n, v[i] ?? ''));
    }
    default:
      return false;
  }
}

function pushUnique(list: string[], reason: string): void {
  if (!list.includes(reason)) list.push(reason);
}

function evidenceFrom(item: Item, source: EvidenceSource): EvidenceValue[] {
  const base = (value: FieldValue): EvidenceValue => {
    const e: { -readonly [K in keyof EvidenceValue]: EvidenceValue[K] } = {
      value,
      quote: item.span.quote,
      pointer: item.span.pointer,
      source,
    };
    if (item.span.candidate_id !== undefined) e.candidate_id = item.span.candidate_id;
    return e;
  };
  if (item.t === 'value') return [base(item.value)];
  if (item.t === 'ambiguous') return item.options.map((o) => ({ ...base(o), ambiguous: true as const }));
  return [];
}

function buildCandidates(intake: IntakeLike, field: FieldKey, extractorItems: readonly Item[], codeItems: readonly Item[]): EvidenceValue[] {
  const all: EvidenceValue[] = [];
  for (const it of extractorItems) all.push(...evidenceFrom(it, 'extractor'));
  for (const it of codeItems) all.push(...evidenceFrom(it, 'code'));
  // Stable: definite readings before ambiguous ones for the same value; then by position; extractor first.
  const indexed = all.map((e, i) => ({ e, i }));
  indexed.sort(
    (a, b) =>
      comparePointers(intake, a.e.pointer, b.e.pointer) ||
      (a.e.ambiguous === true ? 1 : 0) - (b.e.ambiguous === true ? 1 : 0) ||
      a.i - b.i,
  );
  const seen = new Set<string>();
  const out: EvidenceValue[] = [];
  for (const { e } of indexed) {
    const k = valueKey(field, e.value);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

function mergeUtilities(items: readonly Item[]): { partial: UtilitiesPartial | null; overlap: boolean } {
  const tenant = new Set<UtilityCategory>();
  const included = new Set<UtilityCategory>();
  let any = false;
  for (const it of items) {
    if (it.t !== 'utilities') continue;
    any = true;
    for (const c of it.partial.tenant_pays) tenant.add(c);
    for (const c of it.partial.included) included.add(c);
  }
  if (!any) return { partial: null, overlap: false };
  const overlap = [...tenant].some((c) => included.has(c));
  return {
    partial: {
      tenant_pays: UTILITY_CATEGORIES.filter((c) => tenant.has(c)),
      included: UTILITY_CATEGORIES.filter((c) => included.has(c)),
    },
    overlap,
  };
}

/** Preserve grounded cues even when they cannot supply a value or a candidate button. */
function evidenceSpans(intake: IntakeLike, items: readonly Item[]): { quote: string; pointer: string }[] {
  const spans = new Map<string, { quote: string; pointer: string }>();
  for (const it of items) spans.set(it.span.pointer, { quote: it.span.quote, pointer: it.span.pointer });
  return [...spans.values()].sort((a, b) => comparePointers(intake, a.pointer, b.pointer));
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function combine(
  intake: IntakeLike,
  field: FieldKey,
  extractorItems: readonly Item[],
  codeItems: readonly Item[],
  rejectedReasons: readonly string[],
  method: ExtractorMethod,
): GroundedField {
  const reasons: string[] = [];
  for (const r of rejectedReasons) pushUnique(reasons, `proposal_rejected:${r}`);
  const candidates = buildCandidates(intake, field, extractorItems, codeItems);
  const out: Mutable<GroundedField> = { field, state: 'missing', candidates, reasons };
  const isUtilities = FIELD_KIND_OF[field] === 'enumSet';
  // Extractor omission cannot turn a recognised unresolved cue into "nothing was mentioned".
  const ambiguous = [...extractorItems, ...codeItems].filter((it) => it.t === 'ambiguous');
  if (ambiguous.length > 0) out.evidence = evidenceSpans(intake, ambiguous);

  if (extractorItems.length === 0) {
    if (codeItems.length > 0) out.evidence = evidenceSpans(intake, codeItems);
    if (isUtilities) {
      const m = mergeUtilities(codeItems);
      if (m.partial !== null) out.utilities = m.partial;
    }
    if (ambiguous.length > 0) {
      for (const it of ambiguous) if (it.t === 'ambiguous') pushUnique(reasons, it.reason);
      out.state = 'ambiguous';
    }
    if (reasons.length === 0) reasons.push('no_proposal');
    return out;
  }

  for (const it of extractorItems) if (it.t === 'value' && it.narrowed === true) pushUnique(reasons, 'narrowed_to_candidate');

  const invalid = [...extractorItems, ...codeItems].filter((it) => it.t === 'invalid');
  if (invalid.length > 0) {
    for (const it of invalid) if (it.t === 'invalid') pushUnique(reasons, it.reason);
    out.state = 'invalid';
    return out;
  }

  if (isUtilities) {
    const m = mergeUtilities([...extractorItems, ...codeItems]);
    if (m.partial !== null) out.utilities = m.partial;
    if (m.overlap) {
      pushUnique(reasons, 'utilities_conflict');
      out.state = 'conflict';
      return out;
    }
    if (ambiguous.length > 0 || m.partial === null) {
      for (const it of ambiguous) if (it.t === 'ambiguous') pushUnique(reasons, it.reason);
      if (m.partial === null) pushUnique(reasons, 'utilities_incomplete');
      out.state = 'ambiguous';
      return out;
    }
    const classified = m.partial.tenant_pays.length + m.partial.included.length;
    if (classified < UTILITY_CATEGORIES.length) {
      pushUnique(reasons, 'utilities_incomplete');
      out.state = 'ambiguous';
      return out;
    }
    const firstEx = extractorItems.find((it) => it.t === 'utilities');
    out.state = 'valid';
    out.value = [...m.partial.tenant_pays];
    out.method = method;
    const evidence = new Map<string, { quote: string; pointer: string }>();
    for (const it of [...extractorItems, ...codeItems]) {
      if (it.t === 'utilities') evidence.set(it.span.pointer, { quote: it.span.quote, pointer: it.span.pointer });
    }
    out.evidence = [...evidence.values()].sort((a, b) => comparePointers(intake, a.pointer, b.pointer));
    if (firstEx !== undefined) {
      out.quote = firstEx.span.quote;
      out.pointer = firstEx.span.pointer;
    }
    return out;
  }

  const definite = new Map<string, Item>();
  for (const it of [...extractorItems, ...codeItems]) {
    if (it.t !== 'value') continue;
    const k = valueKey(field, it.value);
    // Prefer the extractor's own evidence for a value (first extractor item), else the first code item.
    if (!definite.has(k)) definite.set(k, it);
  }
  const relatives = [...extractorItems, ...codeItems].filter((it) => it.t === 'relative');
  const relMonths = new Set(relatives.map((it) => (it.t === 'relative' ? it.months : 0)));

  if (definite.size >= 2 || relMonths.size >= 2) {
    pushUnique(reasons, 'conflicting_values');
    out.state = 'conflict';
    return out;
  }
  if (ambiguous.length > 0) {
    for (const it of ambiguous) if (it.t === 'ambiguous') pushUnique(reasons, it.reason);
    out.state = 'ambiguous';
    return out;
  }
  if (relatives.length > 0) {
    const rel = relatives.find((it) => extractorItems.includes(it)) ?? relatives[0];
    if (rel !== undefined && rel.t === 'relative') {
      out.relative = {
        months: rel.months,
        quote: rel.span.quote,
        pointer: rel.span.pointer,
        source: extractorItems.includes(rel) ? 'extractor' : 'code',
      };
      const claims = relatives.flatMap((it) => it.t === 'relative' && it.claim !== undefined ? [it.claim] : []);
      if (claims.length > 0) out.relative = { ...out.relative, claims };
      out.method = method;
    }
    pushUnique(reasons, 'pending_dependency');
    out.state = 'missing';
    return out;
  }
  const chosenEx = extractorItems.find((it) => it.t === 'value');
  if (chosenEx === undefined || chosenEx.t !== 'value') {
    pushUnique(reasons, 'no_value');
    return out;
  }
  out.state = 'valid';
  out.value = chosenEx.value;
  out.method = method;
  out.quote = chosenEx.span.quote;
  out.pointer = chosenEx.span.pointer;
  return out;
}

// ------------------------------------------------------------------------------------------------- public

/** Ground every proposal and fold in the code-found candidates; returns one record per schema field. */
export function groundFields(input: GroundingInput): GroundingResult {
  const ctx = input.ctx ?? DEFAULT_FIELD_CONTEXT;
  const { intake, candidates } = input;
  const byId = new Map<string, Candidate>();
  for (const c of candidates) if (!byId.has(c.id)) byId.set(c.id, c);

  const extractorItems = new Map<FieldKey, Item[]>();
  const rejectedReasons = new Map<FieldKey, string[]>();
  const rejected: ProposalRejection[] = [];
  for (const k of FIELD_KEYS) {
    extractorItems.set(k, []);
    rejectedReasons.set(k, []);
  }
  const reject = (index: number, field: string, reason: string): void => {
    rejected.push({ index, field, reason });
    if (isFieldKey(field)) rejectedReasons.get(field)?.push(reason);
  };

  input.proposals.forEach((proposal, index) => {
    const field: unknown = (proposal as { field?: unknown }).field;
    if (!isFieldKey(field)) {
      rejected.push({ index, field: 'unknown', reason: 'unknown_field' });
      return;
    }
    let span: GroundSpan;
    if (proposal.quote !== undefined) {
      const g = groundQuote(intake, proposal.quote, proposal.pointer ?? null);
      if (!g.ok) {
        reject(index, field, `ungrounded:${g.reason}`);
        return;
      }
      span = { quote: proposal.quote, pointer: g.pointer, message_id: g.message_id, start: g.start, end: g.end };
    } else if (proposal.candidate_id !== undefined) {
      const c = byId.get(proposal.candidate_id);
      if (c === undefined) {
        reject(index, field, 'unknown_candidate');
        return;
      }
      if (c.field !== undefined && c.field !== field) {
        reject(index, field, 'candidate_field_mismatch');
        return;
      }
      const cs = spanFromCandidate(c);
      // Re-ground the candidate's own quote (defence in depth: candidates come from code, but cheap to check).
      const g = cs === null ? null : groundQuote(intake, c.quote, c.pointer);
      if (cs === null || g === null || !g.ok) {
        reject(index, field, 'candidate_ungrounded');
        return;
      }
      span = cs;
    } else {
      reject(index, field, 'no_quote');
      return;
    }

    const evaluated = evaluateProposalSpan(field, span, candidates, ctx);
    if (!Array.isArray(evaluated)) {
      reject(index, field, evaluated.reason);
      return;
    }
    const bucket = extractorItems.get(field);
    for (const item of evaluated) {
      if (!modelAgrees(field, proposal.value, item, ctx)) {
        bucket?.push({ t: 'invalid', reason: 'value_quote_mismatch', span: item.span });
      } else {
        bucket?.push(item.t === 'relative' && typeof proposal.value === 'number' ? { ...item, claim: proposal.value } : item);
      }
    }
  });

  const codeItems = new Map<FieldKey, Item[]>();
  for (const k of FIELD_KEYS) codeItems.set(k, []);
  for (const c of candidates) {
    if (c.field === undefined || !isFieldKey(c.field)) continue;
    const span = spanFromCandidate(c);
    if (span === null) continue;
    const r = evaluateSpan(c.field, span, candidates, ctx);
    if (r.t !== 'fail') codeItems.get(c.field)?.push(r);
  }

  const fields = {} as Record<FieldKey, GroundedField>;
  for (const k of FIELD_KEYS) {
    fields[k] = combine(
      intake,
      k,
      extractorItems.get(k) ?? [],
      codeItems.get(k) ?? [],
      rejectedReasons.get(k) ?? [],
      input.method,
    );
  }
  return { fields, rejected };
}
