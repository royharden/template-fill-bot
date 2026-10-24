// Cross-field validation (PLAN section 4.5). Pure. Takes the BASE field records (grounding + answers) and
// returns the EFFECTIVE records; it is re-run on every read, so a later answer never needs to "undo" a rule.
// Failures become field states (raising questions); nothing is ever auto-fixed.
//
// Rules, in this order:
// 1. every valid value is re-checked with its field validator against the jurisdiction config (term range,
//    due-day range, money bounds, name/address rules);
// 2. end_date = INCLUSIVE last day = (start_date + term_months, end-of-month clamped) - 1 day. Stated end
//    dates (grounded evidence or a user answer) are check candidates: equal -> ok; equal to the exclusive
//    anniversary -> ambiguous (`end_date_exclusive`); otherwise conflict (`end_date_mismatch`).
//    start_date or term_months not valid -> missing (`pending_dependency`, no question);
// 3. relative deposit ("one month's rent") resolves only once monthly_rent is valid; until then deposit is
//    missing with `pending_dependency` (no separate question). A resolved amount that differs from a stated
//    absolute deposit -> conflict (`deposit_relative_mismatch`);
// 4. deposit cap by integer cross-multiplication: deposit * 52 <= cap_weeks * monthly_rent * 12;
// 5. tenants distinct from the landlord (party key: NFKC + lower case + collapsed whitespace; tenants are
//    already distinct from each other by the field validator) -> tenants invalid `tenant_is_landlord`;
// 6. guarantor is not a party -> guarantor invalid `guarantor_is_party`;
// 7. break_month in [1, term_months - 1] -> else break_month invalid `break_month_out_of_range`.
import { FIELD_KEYS } from '../content/types.ts';
import type { FieldKey } from '../content/types.ts';
import { daysInMonth, isValidIsoDate } from './candidates/dates.ts';
import { DEFAULT_FIELD_CONTEXT, FIELD_SPECS, partyKey } from './fields.ts';
import type { FieldContext } from './fields.ts';
import type { FieldRecords, GroundedField } from './grounding.ts';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const ISO_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

function ymd(iso: string): [number, number, number] {
  const m = ISO_RE.exec(iso);
  if (m === null) throw new RangeError('validate: not an ISO date');
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** start + n calendar months; the day is clamped to the last day of the target month (31 Jan + 1 -> 28/29 Feb). */
export function addMonthsClamped(startIso: string, months: number): string {
  const [y, m, d] = ymd(startIso);
  const total = (m - 1) + months;
  const y2 = y + Math.floor(total / 12);
  const m2 = (((total % 12) + 12) % 12) + 1;
  return iso(y2, m2, Math.min(d, daysInMonth(y2, m2)));
}

/** The day before an ISO date. */
export function previousDay(isoDate: string): string {
  const [y, m, d] = ymd(isoDate);
  if (d > 1) return iso(y, m, d - 1);
  if (m > 1) return iso(y, m - 1, daysInMonth(y, m - 1));
  return iso(y - 1, 12, 31);
}

/** Exclusive anniversary: start + term months (clamped). */
export function exclusiveEndDate(startIso: string, termMonths: number): string {
  return addMonthsClamped(startIso, termMonths);
}

/** Inclusive last day of the tenancy (2027-03-01 + 12 months -> 2028-02-29). */
export function inclusiveEndDate(startIso: string, termMonths: number): string {
  return previousDay(addMonthsClamped(startIso, termMonths));
}

/** deposit * 52 <= capWeeks * monthly * 12, in integers (minor units; safe for every validated amount). */
export function depositWithinCap(depositMinor: number, monthlyMinor: number, capWeeks: number): boolean {
  return depositMinor * 52 <= capWeeks * monthlyMinor * 12;
}

function withState(f: GroundedField, state: GroundedField['state'], reason: string): GroundedField {
  const out: Mutable<GroundedField> = {
    field: f.field,
    state,
    candidates: f.candidates,
    reasons: f.reasons.includes(reason) ? [...f.reasons] : [...f.reasons, reason],
  };
  if (f.answer !== undefined) out.answer = f.answer;
  if (f.relative !== undefined) out.relative = f.relative;
  if (f.utilities !== undefined) out.utilities = f.utilities;
  return out;
}

function validateEndDate(eff: Record<FieldKey, GroundedField>): GroundedField {
  const base = eff.end_date;
  const start = eff.start_date;
  const term = eff.term_months;
  if (start.state !== 'valid' || term.state !== 'valid' || typeof start.value !== 'string' || typeof term.value !== 'number') {
    const out: Mutable<GroundedField> = {
      field: 'end_date',
      state: 'missing',
      candidates: base.candidates,
      reasons: ['pending_dependency'],
    };
    if (base.answer !== undefined) out.answer = base.answer;
    return out;
  }
  const computed = inclusiveEndDate(start.value, term.value);
  const exclusive = exclusiveEndDate(start.value, term.value);
  if (!isValidIsoDate(computed)) return withState(base, 'invalid', 'end_date_out_of_range');

  if (base.method === 'user_answer') {
    if (base.value === computed) return { ...base, state: 'valid', value: computed, reasons: [] };
    if (base.value === exclusive) return withState(base, 'ambiguous', 'end_date_exclusive');
    return withState(base, 'conflict', 'end_date_mismatch');
  }
  if (base.state === 'invalid') return withState(base, 'invalid', 'stated_end_date_invalid');
  if (base.state === 'ambiguous') return withState(base, 'ambiguous', 'stated_end_date_unclear');

  const stated = base.candidates.filter((c) => c.ambiguous !== true && typeof c.value === 'string');
  if (stated.some((c) => c.value !== computed && c.value !== exclusive)) {
    return withState(base, 'conflict', 'end_date_mismatch');
  }
  if (stated.some((c) => c.value === exclusive && c.value !== computed)) {
    return withState(base, 'ambiguous', 'end_date_exclusive');
  }
  const out: Mutable<GroundedField> = {
    field: 'end_date',
    state: 'valid',
    value: computed,
    method: 'computed',
    candidates: base.candidates,
    reasons: [],
  };
  const match = stated.find((c) => c.value === computed);
  if (match !== undefined) {
    out.quote = match.quote;
    out.pointer = match.pointer;
  }
  return out;
}

function validateDeposit(eff: Record<FieldKey, GroundedField>, ctx: FieldContext): GroundedField {
  let dep = eff.deposit;
  const rent = eff.monthly_rent;
  const rentValid = rent.state === 'valid' && typeof rent.value === 'number';
  if (dep.method !== 'user_answer' && dep.relative !== undefined && (dep.state === 'missing' || dep.state === 'valid')) {
    if (!rentValid) {
      const out: Mutable<GroundedField> = {
        field: 'deposit',
        state: 'missing',
        candidates: dep.candidates,
        reasons: ['pending_dependency'],
        relative: dep.relative,
      };
      return out;
    }
    const resolved = dep.relative.months * (rent.value as number);
    if (dep.relative.claims?.some((claim) => claim !== resolved && claim * 100 !== resolved)) {
      return withState(dep, 'invalid', 'value_quote_mismatch');
    }
    const check = FIELD_SPECS.deposit.validate(resolved, ctx);
    if (!check.ok) return withState(dep, 'invalid', check.reason);
    const absolute = dep.candidates.filter((c) => c.ambiguous !== true && typeof c.value === 'number');
    if (absolute.some((c) => c.value !== resolved)) return withState(dep, 'conflict', 'deposit_relative_mismatch');
    const out: Mutable<GroundedField> = {
      field: 'deposit',
      state: 'valid',
      value: resolved,
      candidates: dep.candidates,
      reasons: [],
      relative: dep.relative,
      quote: dep.relative.quote,
      pointer: dep.relative.pointer,
    };
    if (dep.method !== undefined) out.method = dep.method;
    dep = out;
  }
  if (dep.state === 'valid' && rentValid && typeof dep.value === 'number') {
    if (!depositWithinCap(dep.value, rent.value as number, ctx.jurisdiction.deposit_cap_weeks)) {
      return withState(dep, 'invalid', 'deposit_over_cap');
    }
  }
  return dep;
}

/** Effective field records after the cross-field rules. Does not mutate `base`. */
export function validateFields(base: FieldRecords, ctx: FieldContext = DEFAULT_FIELD_CONTEXT): Record<FieldKey, GroundedField> {
  const eff = {} as Record<FieldKey, GroundedField>;
  // 1. re-check every valid value with its own validator.
  for (const k of FIELD_KEYS) {
    const f = base[k];
    if (k !== 'end_date' && f.state === 'valid') {
      const r = FIELD_SPECS[k].validate(f.value, ctx);
      eff[k] = r.ok ? { ...f, value: r.value } : withState(f, 'invalid', r.reason);
    } else {
      eff[k] = f;
    }
  }
  // 2. end date.
  eff.end_date = validateEndDate(eff);
  // 3-4. deposit.
  eff.deposit = validateDeposit(eff, ctx);
  // 5. tenants distinct from the landlord.
  const landlord = eff.landlord;
  const tenants = eff.tenants;
  const landlordKey = landlord.state === 'valid' && typeof landlord.value === 'string' ? partyKey(landlord.value) : null;
  const tenantKeys = tenants.state === 'valid' && Array.isArray(tenants.value) ? tenants.value.map((n) => partyKey(n)) : null;
  if (landlordKey !== null && tenantKeys !== null && tenantKeys.includes(landlordKey)) {
    eff.tenants = withState(tenants, 'invalid', 'tenant_is_landlord');
  }
  // 6. guarantor is not a party (compared with whichever parties are known).
  const g = eff.guarantor;
  if (g.state === 'valid' && typeof g.value === 'string') {
    const gk = partyKey(g.value);
    if (gk === landlordKey || (tenantKeys !== null && tenantKeys.includes(gk))) {
      eff.guarantor = withState(g, 'invalid', 'guarantor_is_party');
    }
  }
  // 7. break month within the term.
  const b = eff.break_month;
  const term = eff.term_months;
  if (b.state === 'valid' && typeof b.value === 'number' && term.state === 'valid' && typeof term.value === 'number') {
    if (b.value < 1 || b.value > term.value - 1) eff.break_month = withState(b, 'invalid', 'break_month_out_of_range');
  }
  return eff;
}
