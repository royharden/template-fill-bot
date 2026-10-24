// M3: cross-field validation (PLAN section 4.5). Written in Dirty Mode; not yet run (DV-TESTS).
import { describe, expect, it } from 'vitest';
import {
  addMonthsClamped,
  depositWithinCap,
  exclusiveEndDate,
  inclusiveEndDate,
  validateFields,
} from '../../supabase/functions/_shared/fillkit/index.ts';
import type { GroundedField } from '../../supabase/functions/_shared/fillkit/index.ts';
import { records, valid } from './m3Helpers.ts';

function endDateStated(...values: string[]): GroundedField {
  return {
    field: 'end_date',
    state: values.length > 1 ? 'conflict' : 'valid',
    candidates: values.map((value, i) => ({ value, quote: `q${i}`, pointer: `msg:m1:${i}-${i + 1}`, source: 'extractor' as const })),
    reasons: [],
  };
}

describe('date arithmetic', () => {
  it('inclusive end date = (start + term, clamped) - 1 day', () => {
    expect(inclusiveEndDate('2027-03-01', 12)).toBe('2028-02-29');
    expect(inclusiveEndDate('2027-04-03', 12)).toBe('2028-04-02');
    expect(inclusiveEndDate('2027-01-01', 12)).toBe('2027-12-31');
    expect(inclusiveEndDate('2027-12-15', 1)).toBe('2028-01-14');
    expect(inclusiveEndDate('2027-01-31', 1)).toBe('2027-02-27');
    expect(inclusiveEndDate('2028-01-31', 1)).toBe('2028-02-28');
  });

  it('end-of-month clamping', () => {
    expect(addMonthsClamped('2027-10-31', 4)).toBe('2028-02-29');
    expect(addMonthsClamped('2027-08-31', 1)).toBe('2027-09-30');
    expect(exclusiveEndDate('2027-03-01', 12)).toBe('2028-03-01');
  });
});

describe('end_date', () => {
  const base = { start_date: valid('start_date', '2027-03-01'), term_months: valid('term_months', 12) };

  it('computed when start and term are valid (method computed)', () => {
    const eff = validateFields(records(base));
    expect(eff.end_date.state).toBe('valid');
    expect(eff.end_date.value).toBe('2028-02-29');
    expect(eff.end_date.method).toBe('computed');
  });

  it('pending (missing, no question) while start or term is unresolved', () => {
    const eff = validateFields(records({ term_months: valid('term_months', 12) }));
    expect(eff.end_date.state).toBe('missing');
    expect(eff.end_date.reasons).toEqual(['pending_dependency']);
  });

  it('a stated end date equal to the computed one is ok and keeps its evidence', () => {
    const eff = validateFields(records({ ...base, end_date: endDateStated('2028-02-29') }));
    expect(eff.end_date.state).toBe('valid');
    expect(eff.end_date.quote).toBe('q0');
  });

  it('a stated end date equal to the exclusive anniversary is ambiguous', () => {
    const eff = validateFields(records({ ...base, end_date: endDateStated('2028-03-01') }));
    expect(eff.end_date.state).toBe('ambiguous');
    expect(eff.end_date.reasons).toContain('end_date_exclusive');
  });

  it('any other stated end date is a conflict', () => {
    const eff = validateFields(records({ ...base, end_date: endDateStated('2028-06-30') }));
    expect(eff.end_date.state).toBe('conflict');
    expect(eff.end_date.reasons).toContain('end_date_mismatch');
  });

  it('a user-entered exclusive anniversary remains ambiguous rather than becoming an inclusive date', () => {
    const eff = validateFields(records({ ...base, end_date: valid('end_date', '2028-03-01', { method: 'user_answer' }) }));
    expect(eff.end_date.state).toBe('ambiguous');
    expect(eff.end_date.reasons).toContain('end_date_exclusive');
  });
});

describe('deposit', () => {
  const relative: GroundedField = {
    field: 'deposit',
    state: 'missing',
    method: 'mock',
    candidates: [],
    reasons: ['pending_dependency'],
    relative: { months: 1, quote: "one month's rent", pointer: 'msg:m2:85-101', source: 'extractor' },
  };

  it('relative deposit stays pending while monthly_rent is not valid (no separate question)', () => {
    const conflict: GroundedField = { field: 'monthly_rent', state: 'conflict', candidates: [], reasons: ['conflicting_values'] };
    const eff = validateFields(records({ deposit: relative, monthly_rent: conflict }));
    expect(eff.deposit.state).toBe('missing');
    expect(eff.deposit.reasons).toEqual(['pending_dependency']);
    expect(eff.deposit.value).toBeUndefined();
  });

  it('relative deposit resolves to months x rent once monthly_rent is valid', () => {
    const eff = validateFields(records({ deposit: relative, monthly_rent: valid('monthly_rent', 120000) }));
    expect(eff.deposit.state).toBe('valid');
    expect(eff.deposit.value).toBe(120000);
    expect(eff.deposit.method).toBe('mock');
    expect(eff.deposit.quote).toBe("one month's rent");
    expect(eff.deposit.pointer).toBe('msg:m2:85-101');
  });

  it('checks a numeric model claim only once rent resolves; a mismatched claim never supplies a value', () => {
    const claimed = { ...relative, relative: { ...relative.relative!, claims: [900] } };
    const pending = validateFields(records({ deposit: claimed }));
    expect(pending.deposit.reasons).toEqual(['pending_dependency']);
    const invalid = validateFields(records({ deposit: claimed, monthly_rent: valid('monthly_rent', 120000) }));
    expect(invalid.deposit.state).toBe('invalid');
    expect(invalid.deposit.reasons).toContain('value_quote_mismatch');
    expect(invalid.deposit.value).toBeUndefined();
    const matching = { ...relative, relative: { ...relative.relative!, claims: [1200, 120000] } };
    expect(validateFields(records({ deposit: matching, monthly_rent: valid('monthly_rent', 120000) })).deposit.value).toBe(120000);
  });

  it('resolved relative deposit that differs from a stated amount -> conflict', () => {
    const withAbs: GroundedField = {
      ...relative,
      candidates: [{ value: 100000, quote: '£1,000', pointer: 'msg:m1:0-6', source: 'code' }],
    };
    const eff = validateFields(records({ deposit: withAbs, monthly_rent: valid('monthly_rent', 120000) }));
    expect(eff.deposit.state).toBe('conflict');
    expect(eff.deposit.reasons).toContain('deposit_relative_mismatch');
  });

  it('cap by integer cross-multiplication: deposit * 52 <= weeks * monthly * 12', () => {
    expect(depositWithinCap(138461, 120000, 5)).toBe(true);
    expect(depositWithinCap(138462, 120000, 5)).toBe(false);
    const over = validateFields(records({ deposit: valid('deposit', 200000), monthly_rent: valid('monthly_rent', 120000) }));
    expect(over.deposit.state).toBe('invalid');
    expect(over.deposit.reasons).toContain('deposit_over_cap');
    const ok = validateFields(records({ deposit: valid('deposit', 120000), monthly_rent: valid('monthly_rent', 120000) }));
    expect(ok.deposit.state).toBe('valid');
  });
});

describe('ranges and parties', () => {
  it('due day outside the configured range is invalid', () => {
    const eff = validateFields(records({ rent_due_day: valid('rent_due_day', 30) }));
    expect(eff.rent_due_day.state).toBe('invalid');
    expect(eff.rent_due_day.reasons).toContain('out_of_range');
  });

  it('a tenant who is also the landlord (party key) makes tenants invalid', () => {
    const eff = validateFields(
      records({ landlord: valid('landlord', 'Sam Patel'), tenants: valid('tenants', ['Priya Shah', 'sam  patel']) }),
    );
    expect(eff.tenants.state).toBe('invalid');
    expect(eff.tenants.reasons).toContain('tenant_is_landlord');
  });

  it('a guarantor who is a party is invalid', () => {
    const eff = validateFields(
      records({
        landlord: valid('landlord', 'Sam Patel'),
        tenants: valid('tenants', ['Priya Shah', 'Joe Bloggs']),
        guarantor: valid('guarantor', 'Joe Bloggs'),
      }),
    );
    expect(eff.guarantor.state).toBe('invalid');
    expect(eff.guarantor.reasons).toContain('guarantor_is_party');
  });

  it('break_month must be in [1, term - 1]', () => {
    const atTerm = validateFields(records({ term_months: valid('term_months', 12), break_month: valid('break_month', 12) }));
    expect(atTerm.break_month.state).toBe('invalid');
    expect(atTerm.break_month.reasons).toContain('break_month_out_of_range');
    const inside = validateFields(records({ term_months: valid('term_months', 12), break_month: valid('break_month', 11) }));
    expect(inside.break_month.state).toBe('valid');
  });

  it('never mutates the base records', () => {
    const base = records({ rent_due_day: valid('rent_due_day', 30) });
    const before = JSON.stringify(base);
    validateFields(base);
    expect(JSON.stringify(base)).toBe(before);
  });
});
