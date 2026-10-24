// Field specs for the 15 schema fields (PLAN section 4.1): parser, validator, cue words and question template.
// The SAME validators run after extraction, on user answers, on JSON import and in the gate.
//
// Free text (names 1-80 code points per person, address 1-160 code points), applied in this order:
//   NFC -> reject line breaks -> reject other control chars (\p{Cc}) -> reject format/bidi/zero-width chars
//   (\p{Cf}) -> collapse whitespace runs to one space and trim -> empty -> length in CODE POINTS ->
//   reject { } < > [ ] and backticks -> reject . ; : ! ? -> names: reject commas, then digits (\p{N}) ->
//   allowed classes (names: \p{L} \p{M} space ' ’ -; address adds ASCII digits , / #) -> at least one letter
//   -> no token (space-separated) mixing Latin with Cyrillic/Greek (or Cyrillic with Greek).
// Money: GBP only (jurisdiction currency), positive integer pence, at most MAX_MONEY_MINOR; weekly rent and
// other currencies are rejected so a question is asked. Cross-field rules (end date, deposit cap, party
// distinctness, break_month < term) are M3 (validate.ts).
import { JURISDICTION } from '../content/jurisdiction.ts';
import { FIELD_KEYS, FIELD_KIND_OF, UTILITY_CATEGORIES } from '../content/types.ts';
import type { FieldKey, FieldKind, Jurisdiction, UtilityCategory } from '../content/types.ts';
import { isValidIsoDate, parseDateText } from './candidates/dates.ts';
import { parseDueDayText } from './candidates/dueDay.ts';
import { parseDurationText } from './candidates/durations.ts';
import {
  FURNISHED_VALUES,
  PETS_VALUES,
  SMOKING_VALUES,
  canonicalUtilities,
  classifyFurnished,
  classifyPets,
  classifySmoking,
  utilityCategoryOf,
} from './candidates/enums.ts';
import type { EnumClassification } from './candidates/enums.ts';
import { MAX_MONEY_MINOR, parseMoneyText, parseRelativeDepositText } from './candidates/money.ts';
import { MAX_TENANTS, splitTenants } from './candidates/roles.ts';

export { FIELD_KEYS, MAX_MONEY_MINOR, MAX_TENANTS };
export type { FieldKey, FieldKind };

export const NAME_MAX_CODE_POINTS = 80;
export const ADDRESS_MAX_CODE_POINTS = 160;

export type JurisdictionLimits = Pick<
  Jurisdiction,
  'currency' | 'term_months_min' | 'term_months_max' | 'due_day_min' | 'due_day_max' | 'deposit_cap_weeks'
>;

export interface FieldContext {
  readonly jurisdiction: JurisdictionLimits;
}

export const DEFAULT_FIELD_CONTEXT: FieldContext = { jurisdiction: JURISDICTION };

export type FieldValue = string | number | string[];

export type FieldFailureReason =
  | 'not_string'
  | 'empty'
  | 'too_long'
  | 'line_break'
  | 'control_char'
  | 'format_char'
  | 'forbidden_bracket'
  | 'forbidden_punctuation'
  | 'comma_in_name'
  | 'digit_in_name'
  | 'disallowed_char'
  | 'no_letter'
  | 'mixed_script'
  | 'ambiguous_split'
  | 'tenant_count'
  | 'duplicate_tenant'
  | 'not_integer'
  | 'out_of_range'
  | 'not_positive'
  | 'too_large'
  | 'unsupported_currency'
  | 'weekly_rent_unsupported'
  | 'unexpected_period'
  | 'relative_value'
  | 'unrecognised'
  | 'needs_year'
  | 'ambiguous_date'
  | 'impossible_date'
  | 'relative_date'
  | 'invalid_date'
  | 'ambiguous'
  | 'no_cue'
  | 'not_in_set'
  | 'not_array'
  | 'unknown_utility'
  | 'duplicate_utility';

export type FieldResult =
  | { readonly ok: true; readonly value: FieldValue }
  | { readonly ok: false; readonly reason: FieldFailureReason };

export interface QuestionTemplate {
  readonly id: string;
  readonly text: string;
}

export interface FieldSpec {
  readonly key: FieldKey;
  readonly required: boolean;
  readonly kind: FieldKind;
  readonly cueWords: readonly string[];
  /** Parse free text (a grounded quote or a typed answer) into a validated value. */
  readonly parse: (text: string, ctx?: FieldContext) => FieldResult;
  /** Validate an already-typed value; on success returns the normalised value. */
  readonly validate: (value: unknown, ctx?: FieldContext) => FieldResult;
  readonly questionTemplate: QuestionTemplate;
}

const ok = (value: FieldValue): FieldResult => ({ ok: true, value });
const fail = (reason: FieldFailureReason): FieldResult => ({ ok: false, reason });

// ------------------------------------------------------------------------------------------------ free text

const LINE_BREAK_RE = /[\n\r\u000B\u000C\u0085\u2028\u2029]/u;
const CONTROL_RE = /\p{Cc}/u;
const FORMAT_RE = /\p{Cf}/u;
const WHITESPACE_RUN_RE = /\s+/gu;
const BRACKET_RE = /[{}<>[\]`]/u;
const PUNCT_RE = /[.;:!?]/u;
const DIGIT_RE = /\p{N}/u;
const LETTER_RE = /\p{L}/u;
const NAME_ALLOWED_RE = /^[\p{L}\p{M}' ’-]+$/u;
const ADDRESS_ALLOWED_RE = /^[\p{L}\p{M}0-9' ’,\/#-]+$/u;
const LATIN_RE = /\p{Script=Latin}/u;
const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
const GREEK_RE = /\p{Script=Greek}/u;

/** Number of Unicode code points (an astral character counts once). */
export function countCodePoints(s: string): number {
  return Array.from(s).length;
}

/** True when one space-separated token mixes two of Latin / Cyrillic / Greek. */
export function hasMixedScriptToken(s: string): boolean {
  for (const token of s.split(' ')) {
    const scripts = (LATIN_RE.test(token) ? 1 : 0) + (CYRILLIC_RE.test(token) ? 1 : 0) + (GREEK_RE.test(token) ? 1 : 0);
    if (scripts >= 2) return true;
  }
  return false;
}

/** NFC, reject line breaks / controls / format characters, collapse whitespace, trim. */
export function normaliseFreeText(raw: string): FieldResult {
  const s = raw.normalize('NFC');
  if (LINE_BREAK_RE.test(s)) return fail('line_break');
  if (CONTROL_RE.test(s)) return fail('control_char');
  if (FORMAT_RE.test(s)) return fail('format_char');
  return ok(s.replace(WHITESPACE_RUN_RE, ' ').trim());
}

function validateFreeText(value: unknown, kind: 'name' | 'address'): FieldResult {
  if (typeof value !== 'string') return fail('not_string');
  const n = normaliseFreeText(value);
  if (!n.ok) return n;
  const s = n.value as string;
  if (s.length === 0) return fail('empty');
  if (countCodePoints(s) > (kind === 'name' ? NAME_MAX_CODE_POINTS : ADDRESS_MAX_CODE_POINTS)) return fail('too_long');
  if (BRACKET_RE.test(s)) return fail('forbidden_bracket');
  if (PUNCT_RE.test(s)) return fail('forbidden_punctuation');
  if (kind === 'name') {
    if (s.includes(',')) return fail('comma_in_name');
    if (DIGIT_RE.test(s)) return fail('digit_in_name');
    if (!NAME_ALLOWED_RE.test(s)) return fail('disallowed_char');
  } else if (!ADDRESS_ALLOWED_RE.test(s)) {
    return fail('disallowed_char');
  }
  if (!LETTER_RE.test(s)) return fail('no_letter');
  if (hasMixedScriptToken(s)) return fail('mixed_script');
  return ok(s);
}

export function validateName(value: unknown): FieldResult {
  return validateFreeText(value, 'name');
}

export function validateAddress(value: unknown): FieldResult {
  return validateFreeText(value, 'address');
}

/** Comparison key for party distinctness: NFKC, lower-case, whitespace collapsed (used by M3 validate.ts). */
export function partyKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(WHITESPACE_RUN_RE, ' ').trim();
}

function validateTenants(value: unknown): FieldResult {
  if (!Array.isArray(value)) return fail('not_array');
  if (value.length < 1 || value.length > MAX_TENANTS) return fail('tenant_count');
  const names: string[] = [];
  const keys = new Set<string>();
  for (const item of value) {
    const r = validateName(item);
    if (!r.ok) return r;
    const name = r.value as string;
    const key = partyKey(name);
    if (keys.has(key)) return fail('duplicate_tenant');
    keys.add(key);
    names.push(name);
  }
  return ok(names);
}

function parseTenants(text: string): FieldResult {
  const split = splitTenants(text.normalize('NFC'));
  if (!split.ok) return fail('ambiguous_split');
  return validateTenants(split.names);
}

// -------------------------------------------------------------------------------------------- numbers, money

function validateInt(value: unknown, min: number, max: number): FieldResult {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return fail('not_integer');
  if (value < min || value > max) return fail('out_of_range');
  return ok(value);
}

function validateMoneyMinor(value: unknown): FieldResult {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return fail('not_integer');
  if (value <= 0) return fail('not_positive');
  if (value > MAX_MONEY_MINOR) return fail('too_large');
  return ok(value);
}

function parseRent(text: string, ctx: FieldContext): FieldResult {
  const m = parseMoneyText(text);
  if (m === null) return fail('unrecognised');
  if (m.currency !== null && m.currency !== ctx.jurisdiction.currency.code) return fail('unsupported_currency');
  if (m.period === 'week') return fail('weekly_rent_unsupported');
  return validateMoneyMinor(m.minor);
}

/**
 * Absolute deposits only. A relative deposit ("one month's rent") fails with `relative_value`; grounding (M3)
 * then uses parseRelativeDepositText and resolves it once monthly_rent is valid.
 */
function parseDeposit(text: string, ctx: FieldContext): FieldResult {
  if (parseRelativeDepositText(text) !== null) return fail('relative_value');
  const m = parseMoneyText(text);
  if (m === null) return fail('unrecognised');
  if (m.currency !== null && m.currency !== ctx.jurisdiction.currency.code) return fail('unsupported_currency');
  if (m.period !== null) return fail('unexpected_period');
  return validateMoneyMinor(m.minor);
}

function validateDate(value: unknown): FieldResult {
  return isValidIsoDate(value) ? ok(value) : fail('invalid_date');
}

function parseDate(text: string): FieldResult {
  const r = parseDateText(text);
  return r.ok ? validateDate(r.iso) : fail(r.reason);
}

const BREAK_PARSE_RE = /^(?:(?:in\s+)?month\s+|after\s+)?([0-9]{1,3})(?:\s+months?)?$/i;

function validateBreakMonth(value: unknown): FieldResult {
  // Upper bound (break_month <= term_months - 1) is a cross-field rule (M3).
  return validateInt(value, 1, Number.MAX_SAFE_INTEGER);
}

function parseBreakMonth(text: string): FieldResult {
  const t = text.trim();
  const m = BREAK_PARSE_RE.exec(t);
  if (m !== null && m[1] !== undefined) return validateBreakMonth(Number.parseInt(m[1], 10));
  const d = parseDurationText(t.replace(/^after\s+/i, ''));
  return d === null ? fail('unrecognised') : validateBreakMonth(d);
}

// ------------------------------------------------------------------------------------------------- enums

function enumField<V extends string>(
  values: readonly V[],
  classify: (s: string) => EnumClassification<V> | null,
): { parse: (text: string) => FieldResult; validate: (value: unknown) => FieldResult } {
  const validate = (value: unknown): FieldResult =>
    typeof value === 'string' && (values as readonly string[]).includes(value) ? ok(value) : fail('not_in_set');
  const parse = (text: string): FieldResult => {
    const c = classify(text);
    if (c === null) return fail('no_cue');
    if (c.ambiguous || c.value === null) return fail('ambiguous');
    return validate(c.value);
  };
  return { parse, validate };
}

/** The tenant-paid set: a subset of the closed list, returned in closed-list order. */
export function validateUtilities(value: unknown): FieldResult {
  if (!Array.isArray(value)) return fail('not_array');
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !(UTILITY_CATEGORIES as readonly string[]).includes(item)) return fail('unknown_utility');
    if (seen.has(item)) return fail('duplicate_utility');
    seen.add(item);
  }
  return ok(canonicalUtilities(value as UtilityCategory[]));
}

const UTILITY_NONE_RE = /^(?:none|nothing|no\s+utilities|no\s+bills)$/i;
const UTILITY_SPLIT_RE = /\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*/;

/** Parse an answer that LISTS the categories the tenant pays ("electricity and gas", "none"). */
function parseUtilities(text: string): FieldResult {
  const t = text.trim();
  if (UTILITY_NONE_RE.test(t)) return ok([]);
  const parts = t.split(UTILITY_SPLIT_RE).filter((p) => p.length > 0);
  if (parts.length === 0) return fail('empty');
  const cats: UtilityCategory[] = [];
  for (const p of parts) {
    const c = utilityCategoryOf(p);
    if (c === null) return fail('unknown_utility');
    cats.push(c);
  }
  return validateUtilities(cats);
}

// ----------------------------------------------------------------------------------------------- the specs

const ctxOr = (ctx: FieldContext | undefined): FieldContext => ctx ?? DEFAULT_FIELD_CONTEXT;

const pets = enumField(PETS_VALUES, classifyPets);
const smoking = enumField(SMOKING_VALUES, classifySmoking);
const furnished = enumField(FURNISHED_VALUES, classifyFurnished);

function spec(
  key: FieldKey,
  required: boolean,
  cueWords: readonly string[],
  parse: FieldSpec['parse'],
  validate: FieldSpec['validate'],
  questionText: string,
): FieldSpec {
  return {
    key,
    required,
    kind: FIELD_KIND_OF[key],
    cueWords,
    parse,
    validate,
    questionTemplate: { id: `q.${key}.v1`, text: questionText },
  };
}

export const FIELD_SPECS: Readonly<Record<FieldKey, FieldSpec>> = {
  landlord: spec(
    'landlord',
    true,
    ['landlord', 'the landlord', 'landlord is', 'landlord:'],
    (t) => validateName(t),
    (v) => validateName(v),
    "What is the landlord's full name? Use letters, spaces, apostrophes and hyphens only (no full stops, commas or digits).",
  ),
  tenants: spec(
    'tenants',
    true,
    ['tenant', 'tenants', 'tenants:', 'renting to', 'rent to'],
    (t) => parseTenants(t),
    (v) => validateTenants(v),
    'Who are the tenants? Give 1 to 4 full names separated by commas or "and" (letters, spaces, apostrophes and hyphens only).',
  ),
  address: spec(
    'address',
    true,
    ['property', 'property:', 'address', 'address:', 'property at', 'renting'],
    (t) => validateAddress(t),
    (v) => validateAddress(v),
    'What is the property address? Use letters, digits, spaces and , / # \' - only. Write "St Johns Rd", not "St. Johns Rd".',
  ),
  start_date: spec(
    'start_date',
    true,
    ['start', 'starting', 'starts', 'from', 'begin', 'commence', 'move in'],
    (t) => parseDate(t),
    (v) => validateDate(v),
    'On what date does the tenancy start? Include the year, for example 1 March 2027.',
  ),
  term_months: spec(
    'term_months',
    true,
    ['term', 'months', 'year', 'for', 'fixed term'],
    (t, ctx) => {
      const n = parseDurationText(t);
      const j = ctxOr(ctx).jurisdiction;
      return n === null ? fail('unrecognised') : validateInt(n, j.term_months_min, j.term_months_max);
    },
    (v, ctx) => {
      const j = ctxOr(ctx).jurisdiction;
      return validateInt(v, j.term_months_min, j.term_months_max);
    },
    'How long is the fixed term, in whole months?',
  ),
  end_date: spec(
    'end_date',
    true,
    ['end', 'ending', 'until', 'finish', 'expire'],
    (t) => parseDate(t),
    (v) => validateDate(v),
    'Which end date is correct? The end date is the last day of the term, calculated from the start date and the term.',
  ),
  monthly_rent: spec(
    'monthly_rent',
    true,
    ['rent', 'rental', 'monthly', 'a month', 'per month', 'pcm'],
    (t, ctx) => parseRent(t, ctxOr(ctx)),
    (v) => validateMoneyMinor(v),
    'What is the monthly rent in pounds (GBP)? Weekly amounts and other currencies are not supported.',
  ),
  rent_due_day: spec(
    'rent_due_day',
    true,
    ['due', 'due day', 'on the', 'payable', 'of each month'],
    (t, ctx) => {
      const d = parseDueDayText(t);
      const j = ctxOr(ctx).jurisdiction;
      return d === null ? fail('unrecognised') : validateInt(d, j.due_day_min, j.due_day_max);
    },
    (v, ctx) => {
      const j = ctxOr(ctx).jurisdiction;
      return validateInt(v, j.due_day_min, j.due_day_max);
    },
    'On which day of the month is the rent due?',
  ),
  deposit: spec(
    'deposit',
    true,
    ['deposit', 'bond', "month's rent"],
    (t, ctx) => parseDeposit(t, ctxOr(ctx)),
    (v) => validateMoneyMinor(v),
    'What is the deposit, in pounds (GBP)?',
  ),
  pets: spec(
    'pets',
    true,
    ['pets', 'pet', 'animals', 'no pets', 'allowed', 'permitted', 'with consent', 'can keep'],
    (t) => pets.parse(t),
    (v) => pets.validate(v),
    "Are pets allowed? Choose: no pets, or pets only with the landlord's consent.",
  ),
  smoking: spec(
    'smoking',
    true,
    ['smoking', 'no smoking', 'non-smoking', 'smoke outside', 'prohibited'],
    (t) => smoking.parse(t),
    (v) => smoking.validate(v),
    'Is smoking allowed? Choose: prohibited, or permitted outside only.',
  ),
  furnished: spec(
    'furnished',
    true,
    ['furnished', 'unfurnished', 'not furnished'],
    (t) => furnished.parse(t),
    (v) => furnished.validate(v),
    'Is the property furnished or unfurnished?',
  ),
  utilities: spec(
    'utilities',
    true,
    ['utilities', 'bills', 'water', 'electricity', 'gas', 'internet', 'tenants pay', 'included'],
    (t) => parseUtilities(t),
    (v) => validateUtilities(v),
    'Which of water, electricity, gas and internet does the tenant pay? The others are included in the rent.',
  ),
  guarantor: spec(
    'guarantor',
    false,
    ['guarantor', 'guarantor:', 'guarantor is'],
    (t) => validateName(t),
    (v) => validateName(v),
    'Is there a guarantor? If so, give their full name (letters, spaces, apostrophes and hyphens only).',
  ),
  break_month: spec(
    'break_month',
    false,
    ['break', 'break clause', 'after'],
    (t) => parseBreakMonth(t),
    (v) => validateBreakMonth(v),
    'Is there a break clause? If so, after how many months can it be used?',
  ),
};

export const FIELD_SPEC_LIST: readonly FieldSpec[] = FIELD_KEYS.map((k) => FIELD_SPECS[k]);

export function getFieldSpec(key: FieldKey): FieldSpec {
  return FIELD_SPECS[key];
}
