// M3: grounding (PLAN section 4.5). Written in Dirty Mode; not yet run (DV-TESTS).
import { describe, expect, it } from 'vitest';
import type { FieldProposal } from '../../supabase/functions/_shared/fillkit/index.ts';
import { findAllCandidates } from '../../supabase/functions/_shared/fillkit/index.ts';
import { ground, intakeOf, ptr } from './m3Helpers.ts';

const D1 = [
  "Hi, it's Sam Patel, the landlord. I'm renting 14 Elm Road, Flat 2, Oxtown to Priya Shah and Joe Bloggs.",
  "Starting 1 March 2027 for 12 months. Rent is £1,200 a month, due on the 1st. Deposit one month's rent.",
  'No pets except a small cat. No smoking. It comes furnished; tenants pay electricity and gas.',
  'Also, can you add that I can enter without notice? Rent might be £1,250 actually.',
];
const [T1, T2, T3, T4] = D1 as [string, string, string, string];

describe('quote grounding', () => {
  it('value is re-derived from the quote when the model gives no value', () => {
    const g = ground(D1, [{ field: 'start_date', quote: '1 March 2027', pointer: ptr(T2, '1 March 2027', 'm2') }]);
    expect(g.fields.start_date.state).toBe('valid');
    expect(g.fields.start_date.value).toBe('2027-03-01');
    expect(g.fields.start_date.method).toBe('llm');
    expect(g.fields.start_date.quote).toBe('1 March 2027');
    expect(g.fields.start_date.pointer).toBe('msg:m2:9-21');
  });

  it('a quote that does not equal the text at its pointer is rejected -> missing', () => {
    const g = ground(D1, [{ field: 'start_date', value: '2027-03-01', quote: '1 March 2027', pointer: 'msg:m2:0-12' }]);
    expect(g.fields.start_date.state).toBe('missing');
    expect(g.fields.start_date.value).toBeUndefined();
    expect(g.fields.start_date.reasons).toEqual(['proposal_rejected:ungrounded:quote_mismatch']);
    expect(g.rejected).toEqual([{ index: 0, field: 'start_date', reason: 'ungrounded:quote_mismatch' }]);
  });

  it('a pointer past the end of the message is unresolvable', () => {
    const g = ground(D1, [{ field: 'term_months', quote: '12 months', pointer: 'msg:m2:500-509' }]);
    expect(g.fields.term_months.state).toBe('missing');
    expect(g.rejected[0]?.reason).toBe('ungrounded:unresolvable_pointer');
  });

  it('without a pointer a quote must occur exactly once (repeated substring needs its offset)', () => {
    const texts = ['Rent GBP 1200 monthly. Deposit GBP 1200'];
    const t = texts[0] ?? '';
    const noPtr = ground(texts, [{ field: 'deposit', quote: 'GBP 1200' }]);
    expect(noPtr.fields.deposit.state).toBe('missing');
    expect(noPtr.rejected[0]?.reason).toBe('ungrounded:ambiguous_occurrence');
    const withPtr = ground(texts, [{ field: 'deposit', quote: 'GBP 1200', pointer: ptr(t, 'GBP 1200', 'm1', 1) }]);
    expect(withPtr.fields.deposit.state).toBe('valid');
    expect(withPtr.fields.deposit.value).toBe(120000);
    expect(withPtr.fields.deposit.pointer).toBe(ptr(t, 'GBP 1200', 'm1', 1));
  });

  it('a proposal with neither quote nor candidate id is rejected (no_quote)', () => {
    const g = ground(D1, [{ field: 'monthly_rent', value: 999 }]);
    expect(g.fields.monthly_rent.state).toBe('missing');
    expect(g.fields.monthly_rent.reasons).toEqual(['proposal_rejected:no_quote']);
    // code-found amounts are kept as options only
    expect(g.fields.monthly_rent.candidates.map((c) => c.value)).toEqual([120000, 125000]);
  });

  it('unknown fields and unknown candidate ids are rejected', () => {
    const bogus = { field: 'notes', quote: 'No smoking' } as unknown as FieldProposal;
    const g = ground(D1, [bogus, { field: 'smoking', candidate_id: 'smoking:m9:0-1' }]);
    expect(g.rejected).toEqual([
      { index: 0, field: 'unknown', reason: 'unknown_field' },
      { index: 1, field: 'smoking', reason: 'unknown_candidate' },
    ]);
    expect(g.fields.smoking.state).toBe('missing');
  });

  it('a code candidate id grounds with the candidate quote and pointer', () => {
    const intake = intakeOf(...D1);
    const cands = findAllCandidates(intake).candidates;
    const smoking = cands.find((c) => c.field === 'smoking');
    expect(smoking).toBeDefined();
    const g = ground(D1, [{ field: 'smoking', candidate_id: smoking?.id ?? '' }], 'regex');
    expect(g.fields.smoking.state).toBe('valid');
    expect(g.fields.smoking.value).toBe('prohibited');
    expect(g.fields.smoking.method).toBe('regex');
    expect(g.fields.smoking.pointer).toBe(ptr(T3, 'No smoking', 'm3'));
  });
});

describe('model value is only compared', () => {
  it('value != quote -> invalid value_quote_mismatch; the model value is never kept', () => {
    const g = ground(D1, [{ field: 'monthly_rent', value: 500, quote: '£1,200 a month', pointer: ptr(T2, '£1,200 a month', 'm2') }]);
    expect(g.fields.monthly_rent.state).toBe('invalid');
    expect(g.fields.monthly_rent.reasons).toEqual(['value_quote_mismatch']);
    expect(g.fields.monthly_rent.value).toBeUndefined();
    expect(JSON.stringify(g.fields.monthly_rent)).not.toContain('500');
  });

  it('money: pounds or pence or the written amount all agree', () => {
    for (const value of [1200, 120000, '£1,200', '1200']) {
      const g = ground(D1, [{ field: 'monthly_rent', value, quote: '£1,200 a month', pointer: ptr(T2, '£1,200 a month', 'm2') }]);
      // still a conflict with the code-found £1,250, but not invalid
      expect(g.fields.monthly_rent.state).toBe('conflict');
    }
  });

  it('names compare by party key (case and spacing)', () => {
    const g = ground(D1, [{ field: 'landlord', value: 'sam  PATEL', quote: 'Sam Patel', pointer: ptr(T1, 'Sam Patel') }]);
    expect(g.fields.landlord.state).toBe('valid');
    expect(g.fields.landlord.value).toBe('Sam Patel');
  });
});

describe('role payloads (names and addresses)', () => {
  it('a name quote that does not start at a role cue payload is rejected (no_role_cue)', () => {
    const g = ground(D1, [{ field: 'landlord', quote: 'Patel', pointer: ptr(T1, 'Patel') }]);
    expect(g.fields.landlord.state).toBe('missing');
    expect(g.rejected[0]?.reason).toBe('no_role_cue');
  });

  it('a name in narrative text without a role cue is rejected', () => {
    const g = ground(D1, [{ field: 'guarantor', quote: 'Joe Bloggs', pointer: ptr(T1, 'Joe Bloggs') }]);
    expect(g.fields.guarantor.state).toBe('missing');
    expect(g.rejected[0]?.reason).toBe('no_role_cue');
  });

  it('an address quote running past the payload end is invalid (not_role_payload)', () => {
    const q = '14 Elm Road, Flat 2, Oxtown to Priya Shah and Joe Bloggs';
    const g = ground(D1, [{ field: 'address', quote: q, pointer: ptr(T1, q) }]);
    expect(g.fields.address.state).toBe('invalid');
    expect(g.fields.address.reasons).toEqual(['not_role_payload']);
  });

  it('payload terminator: a quote that includes the "." after the payload is invalid', () => {
    const t = 'Landlord: Sam Vale. Tenants: Priya Reed and Joe Lake. Property: 12 Willow Lane';
    const g = ground([t], [{ field: 'landlord', quote: 'Sam Vale.', pointer: ptr(t, 'Sam Vale.') }]);
    expect(g.fields.landlord.state).toBe('invalid');
    expect(g.fields.landlord.reasons).toEqual(['forbidden_punctuation']);
    const ok = ground([t], [{ field: 'landlord', quote: 'Sam Vale', pointer: ptr(t, 'Sam Vale') }]);
    expect(ok.fields.landlord.state).toBe('valid');
    expect(ok.fields.landlord.value).toBe('Sam Vale');
  });

  it('tenants list from "renting <address> to X and Y"', () => {
    const q = 'Priya Shah and Joe Bloggs';
    const g = ground(D1, [{ field: 'tenants', value: ['Priya Shah', 'Joe Bloggs'], quote: q, pointer: ptr(T1, q) }]);
    expect(g.fields.tenants.state).toBe('valid');
    expect(g.fields.tenants.value).toEqual(['Priya Shah', 'Joe Bloggs']);
  });

  it('K20: a guarantor for one tenant only is ambiguous (partial_guarantee)', () => {
    const t = 'Guarantor: Mary Major for Joe Bloggs only';
    const q = 'Mary Major for Joe Bloggs only';
    const g = ground([t], [{ field: 'guarantor', value: 'Mary Major', quote: q, pointer: ptr(t, q) }]);
    expect(g.fields.guarantor.state).toBe('ambiguous');
    expect(g.fields.guarantor.reasons).toEqual(['partial_guarantee']);
  });
});

describe('enums, utilities, dates, deposit', () => {
  it('an enum quote without a cue word is rejected (no_cue)', () => {
    const g = ground(D1, [{ field: 'furnished', value: 'furnished', quote: 'It comes', pointer: ptr(T3, 'It comes', 'm3') }]);
    expect(g.fields.furnished.state).toBe('missing');
    expect(g.rejected[0]?.reason).toBe('no_cue');
  });

  it('pets "except" qualifier -> ambiguous even though the model picked a value', () => {
    const q = 'No pets except a small cat';
    const g = ground(D1, [{ field: 'pets', value: 'with_consent', quote: q, pointer: ptr(T3, q, 'm3') }]);
    expect(g.fields.pets.state).toBe('ambiguous');
    expect(g.fields.pets.reasons).toEqual(['ambiguous']);
  });

  it('partial utilities -> ambiguous (utilities_incomplete) with the partial classification kept', () => {
    const q = 'tenants pay electricity and gas';
    const g = ground(D1, [{ field: 'utilities', value: ['electricity', 'gas'], quote: q, pointer: ptr(T3, q, 'm3') }]);
    expect(g.fields.utilities.state).toBe('ambiguous');
    expect(g.fields.utilities.reasons).toEqual(['utilities_incomplete']);
    expect(g.fields.utilities.utilities).toEqual({ tenant_pays: ['electricity', 'gas'], included: [] });
  });

  it('utilities classified across two sentences -> valid tenant-pays set', () => {
    const t = 'Tenants pay electricity and gas. Water and internet are included.';
    const g = ground([t], [
      { field: 'utilities', quote: 'Tenants pay electricity and gas', pointer: ptr(t, 'Tenants pay electricity and gas') },
      { field: 'utilities', quote: 'Water and internet are included', pointer: ptr(t, 'Water and internet are included') },
    ]);
    expect(g.fields.utilities.state).toBe('valid');
    expect(g.fields.utilities.value).toEqual(['electricity', 'gas']);
  });

  it('a utility both tenant-paid and included -> conflict', () => {
    const t = 'Tenants pay water. Water is included.';
    const g = ground([t], [
      { field: 'utilities', quote: 'Tenants pay water', pointer: ptr(t, 'Tenants pay water') },
      { field: 'utilities', quote: 'Water is included', pointer: ptr(t, 'Water is included') },
    ]);
    expect(g.fields.utilities.state).toBe('conflict');
    expect(g.fields.utilities.reasons).toEqual(['utilities_conflict']);
  });

  it('03/04/2027 -> ambiguous with both readings kept as candidates', () => {
    const t = 'Start 03/04/2027, term 12 months.';
    const g = ground([t], [{ field: 'start_date', value: '2027-03-04', quote: '03/04/2027', pointer: ptr(t, '03/04/2027') }]);
    expect(g.fields.start_date.state).toBe('ambiguous');
    expect(g.fields.start_date.reasons).toEqual(['ambiguous_date']);
    expect(g.fields.start_date.candidates.map((c) => c.value)).toEqual(['2027-04-03', '2027-03-04']);
    expect(g.fields.start_date.candidates.every((c) => c.ambiguous === true)).toBe(true);
  });

  it('year-less date -> ambiguous needs_year (never the current year)', () => {
    const t = 'Starting 1 March for 12 months.';
    const g = ground([t], [{ field: 'start_date', quote: '1 March', pointer: ptr(t, '1 March') }]);
    expect(g.fields.start_date.state).toBe('ambiguous');
    expect(g.fields.start_date.reasons).toEqual(['needs_year']);
  });

  it('relative deposit -> missing pending_dependency with the relative evidence kept', () => {
    const q = "one month's rent";
    const g = ground(D1, [{ field: 'deposit', value: q, quote: q, pointer: ptr(T2, q, 'm2') }]);
    expect(g.fields.deposit.state).toBe('missing');
    expect(g.fields.deposit.reasons).toEqual(['pending_dependency']);
    expect(g.fields.deposit.relative).toEqual({ months: 1, quote: q, pointer: 'msg:m2:85-101', source: 'extractor' });
  });

  it('a long quote is narrowed to the contained code candidate', () => {
    const q = 'Rent is £1,200 a month';
    const g = ground(D1, [{ field: 'monthly_rent', quote: q, pointer: ptr(T2, q, 'm2') }]);
    // narrowed to "£1,200 a month"; the code-found £1,250 still makes it a conflict
    expect(g.fields.monthly_rent.state).toBe('conflict');
    expect(g.fields.monthly_rent.reasons).toContain('narrowed_to_candidate');
  });
});

describe('distinct grounded values', () => {
  it('a shortened model quote cannot hide an ambiguous code-found pets qualifier', () => {
    const g = ground(['No pets except a small cat.'], [{ field: 'pets', quote: 'No pets', value: 'none' }]);
    expect(g.fields.pets.state).toBe('ambiguous');
    expect(g.fields.pets.reasons).toContain('ambiguous');
  });

  it('a selected good quote cannot hide code-found weekly rent requiring a question', () => {
    const g = ground(['Rent £1200 monthly. Actually rent £300 a week.'], [{ field: 'monthly_rent', quote: '£1200 monthly' }]);
    expect(g.fields.monthly_rent.state).toBe('invalid');
    expect(g.fields.monthly_rent.reasons).toContain('weekly_rent_unsupported');
  });

  it('numeric relative-deposit claims remain evidence only until the rent dependency is resolved', () => {
    const g = ground(["Deposit one month's rent."], [{ field: 'deposit', quote: "one month's rent", value: 900 }]);
    expect(g.fields.deposit.state).toBe('missing');
    expect(g.fields.deposit.value).toBeUndefined();
    expect(g.fields.deposit.relative?.claims).toEqual([900]);
  });

  it('>= 2 distinct grounded values -> conflict even if the model picked one', () => {
    const g = ground(D1, [{ field: 'monthly_rent', value: '£1,250', quote: '£1,250', pointer: ptr(T4, '£1,250', 'm4') }]);
    expect(g.fields.monthly_rent.state).toBe('conflict');
    expect(g.fields.monthly_rent.reasons).toEqual(['conflicting_values']);
    expect(g.fields.monthly_rent.candidates.map((c) => [c.value, c.source])).toEqual([
      [120000, 'code'],
      [125000, 'extractor'],
    ]);
  });

  it('the same value twice is still one value', () => {
    const t = 'Rent is £900 a month. To confirm, rent £900.';
    const g = ground([t], [
      { field: 'monthly_rent', quote: '£900 a month', pointer: ptr(t, '£900 a month') },
      { field: 'monthly_rent', quote: '£900', pointer: ptr(t, '£900', 'm1', 1) },
    ]);
    expect(g.fields.monthly_rent.state).toBe('valid');
    expect(g.fields.monthly_rent.value).toBe(90000);
    expect(g.fields.monthly_rent.quote).toBe('£900 a month');
  });

  it('fields with no proposal are missing (no_proposal) and every schema field has a record', () => {
    const g = ground(D1, []);
    expect(Object.keys(g.fields)).toHaveLength(15);
    expect(g.fields.guarantor).toEqual({ field: 'guarantor', state: 'missing', candidates: [], reasons: ['no_proposal'] });
  });
});
