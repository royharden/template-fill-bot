// M2: candidate finders (PLAN sections 4.4, 4.8a, 6 M2). Written in Dirty Mode; not yet run (DV-TESTS).
import { describe, expect, it } from 'vitest';
import { resolvePointer } from '../../supabase/functions/_shared/fillkit/cited.ts';
import {
  classifyFurnished,
  classifyPets,
  classifySmoking,
  classifyUtilities,
  findAllCandidates,
  findDateCandidates,
  findDueDayCandidates,
  findDurationCandidates,
  findEnumCandidates,
  findMoneyCandidates,
  findRequestCandidates,
  findRoleCandidates,
  REQUEST_DETECTORS,
  splitTenants,
} from '../../supabase/functions/_shared/fillkit/candidates/index.ts';
import { normaliseIntake } from '../../supabase/functions/_shared/fillkit/normalize.ts';
import type { Intake } from '../../supabase/functions/_shared/fillkit/normalize.ts';
import type { Candidate } from '../../supabase/functions/_shared/fillkit/schema.ts';

function intake(...texts: string[]): Intake {
  const r = normaliseIntake(texts.map((text) => ({ text })));
  if (!r.ok) throw new Error(`test intake invalid: ${r.error.code}`);
  return r;
}

/** Pointer for the first occurrence of `quote` in message `id` (texts in tests avoid repeats). */
function ptr(text: string, quote: string, id = 'm1'): string {
  const s = text.indexOf(quote);
  if (s < 0) throw new Error(`quote not in text: ${quote}`);
  return `msg:${id}:${s}-${s + quote.length}`;
}

function byField(cs: readonly Candidate[], field: string): Candidate[] {
  return cs.filter((c) => c.field === field);
}

// PLAN section 4.8a demo-01 [C]
const DEMO01 = [
  "Hi, it's Sam Patel, the landlord. I'm renting 14 Elm Road, Flat 2, Oxtown to Priya Shah and Joe Bloggs.",
  "Starting 1 March 2027 for 12 months. Rent is £1,200 a month, due on the 1st. Deposit one month's rent.",
  'No pets except a small cat. No smoking. It comes furnished; tenants pay electricity and gas.',
  'Also, can you add that I can enter without notice? Rent might be £1,250 actually.',
] as const;

// PLAN section 4.8a demo-02 [X]
const DEMO02 = [
  'Landlord: Sam Vale. Tenants: Priya Reed and Joe Lake. Property: 12 Willow Lane',
  'Start 03/04/2027, term 12 months. Rent GBP 1200 monthly, due day 1. Deposit GBP 1200',
  'Actually monthly rent GBP 1250. Pets allowed. Smoking prohibited. Furnished yes',
  'Utilities: water included. Can the landlord enter without notice?',
] as const;

describe('demo-01 messages', () => {
  const it01 = intake(...DEMO01);
  const all = findAllCandidates(it01);
  const [t1, t2, t3, t4] = DEMO01;

  it('landlord "Sam Patel" from "it\'s X, the landlord" (terminator excluded)', () => {
    const c = byField(all.candidates, 'landlord');
    expect(c).toHaveLength(1);
    expect(c[0]?.value).toBe('Sam Patel');
    expect(c[0]?.quote).toBe('Sam Patel');
    expect(c[0]?.pointer).toBe(ptr(t1, 'Sam Patel'));
  });

  it('address and tenants from "renting <address> to X and Y"', () => {
    const addr = byField(all.candidates, 'address');
    expect(addr).toHaveLength(1);
    expect(addr[0]?.value).toBe('14 Elm Road, Flat 2, Oxtown');
    expect(addr[0]?.pointer).toBe(ptr(t1, '14 Elm Road, Flat 2, Oxtown'));
    const ten = byField(all.candidates, 'tenants');
    expect(ten).toHaveLength(1);
    expect(ten[0]?.quote).toBe('Priya Shah and Joe Bloggs');
    expect(ten[0]?.value).toEqual(['Priya Shah', 'Joe Bloggs']);
    expect(ten[0]?.pointer).toBe(ptr(t1, 'Priya Shah and Joe Bloggs'));
  });

  it('start date, term, rent, due day, relative deposit', () => {
    const start = byField(all.candidates, 'start_date');
    expect(start).toHaveLength(1);
    expect(start[0]?.value).toBe('2027-03-01');
    expect(start[0]?.quote).toBe('1 March 2027');
    expect(start[0]?.pointer).toBe(ptr(t2, '1 March 2027', 'm2'));

    const term = byField(all.candidates, 'term_months');
    expect(term).toHaveLength(1);
    expect(term[0]?.value).toBe(12);

    const rent = byField(all.candidates, 'monthly_rent');
    expect(rent.map((c) => c.quote)).toEqual(['£1,200 a month', '£1,250']);
    expect(rent[0]?.value).toEqual({ currency: 'GBP', minor: 120000, period: 'month' });
    expect(rent[1]?.value).toEqual({ currency: 'GBP', minor: 125000, period: null });
    expect(rent[1]?.pointer).toBe(ptr(t4, '£1,250', 'm4'));

    const due = byField(all.candidates, 'rent_due_day');
    expect(due).toHaveLength(1);
    expect(due[0]?.value).toBe(1);
    expect(due[0]?.quote).toBe('due on the 1st');

    const dep = byField(all.candidates, 'deposit');
    expect(dep).toHaveLength(1);
    expect(dep[0]?.kind).toBe('relative_deposit');
    expect(dep[0]?.value).toEqual({ months: 1 });
    expect(dep[0]?.quote).toBe("one month's rent");
    expect(dep[0]?.flags).toEqual(['relative']);
  });

  it('"one month\'s rent" is not also a duration', () => {
    expect(findDurationCandidates(it01).map((c) => c.value)).toEqual([12]);
  });

  it('pets ambiguous with the "small cat" residual; smoking; furnished; utilities partial', () => {
    const pets = byField(all.candidates, 'pets');
    expect(pets).toHaveLength(1);
    expect(pets[0]?.value).toBe('none');
    expect(pets[0]?.flags).toEqual(['ambiguous']);
    expect(pets[0]?.quote).toBe('No pets except a small cat');
    expect(pets[0]?.residual?.quote).toBe('a small cat');
    expect(pets[0]?.residual?.pointer).toBe(ptr(t3, 'a small cat', 'm3'));

    expect(byField(all.candidates, 'smoking')[0]?.value).toBe('prohibited');
    expect(byField(all.candidates, 'furnished')[0]?.value).toBe('furnished');

    const util = byField(all.candidates, 'utilities');
    expect(util).toHaveLength(1);
    expect(util[0]?.value).toEqual({ tenant_pays: ['electricity', 'gas'], included: [] });
    expect(util[0]?.quote).toBe('tenants pay electricity and gas');
  });

  it('"enter without notice" is one unsupported request (clause_id null)', () => {
    expect(all.requests).toHaveLength(1);
    const r = all.requests[0];
    expect(r?.clause_id).toBeNull();
    expect(r?.quote).toBe('Also, can you add that I can enter without notice');
    expect(r?.detectors).toEqual(['enter-without-notice', 'add-that']);
    expect(r?.pointer).toBe(ptr(t4, 'Also, can you add that I can enter without notice', 'm4'));
  });

  it('every candidate pointer resolves to its quote', () => {
    for (const c of [...all.candidates, ...all.requests]) {
      expect(resolvePointer(it01, c.pointer)).toBe(c.quote);
    }
  });
});

describe('demo-02 messages', () => {
  const it02 = intake(...DEMO02);
  const all = findAllCandidates(it02);
  const [t1, t2] = DEMO02;

  it('labelled roles with the payload terminator rule', () => {
    expect(byField(all.candidates, 'landlord')[0]?.value).toBe('Sam Vale');
    expect(byField(all.candidates, 'landlord')[0]?.pointer).toBe(ptr(t1, 'Sam Vale'));
    expect(byField(all.candidates, 'tenants')[0]?.value).toEqual(['Priya Reed', 'Joe Lake']);
    expect(byField(all.candidates, 'address')[0]?.value).toBe('12 Willow Lane');
  });

  it('03/04/2027 gives two ambiguous start_date candidates with both readings', () => {
    const start = byField(all.candidates, 'start_date');
    expect(start).toHaveLength(2);
    const p = ptr(t2, '03/04/2027', 'm2');
    expect(start.map((c) => c.id)).toEqual([`start_date:m2:6-16#dmy`, `start_date:m2:6-16#mdy`]);
    expect(start.map((c) => c.value)).toEqual(['2027-04-03', '2027-03-04']);
    for (const c of start) {
      expect(c.pointer).toBe(p);
      expect(c.flags).toEqual(['ambiguous']);
      expect(c.alternatives).toEqual(['2027-04-03', '2027-03-04']);
    }
  });

  it('GBP amounts, monthly cue, due day, deposit', () => {
    const rent = byField(all.candidates, 'monthly_rent');
    expect(rent.map((c) => c.quote)).toEqual(['GBP 1200 monthly', 'GBP 1250']);
    expect(rent.map((c) => (c.value as { minor: number }).minor)).toEqual([120000, 125000]);
    const dep = byField(all.candidates, 'deposit');
    expect(dep).toHaveLength(1);
    expect(dep[0]?.quote).toBe('GBP 1200');
    expect(dep[0]?.value).toEqual({ currency: 'GBP', minor: 120000, period: null });
    expect(byField(all.candidates, 'rent_due_day')[0]?.value).toBe(1);
    expect(byField(all.candidates, 'rent_due_day')[0]?.quote).toBe('due day 1');
    expect(byField(all.candidates, 'term_months')[0]?.value).toBe(12);
  });

  it('pets allowed -> with_consent, smoking prohibited, furnished yes, water included', () => {
    expect(byField(all.candidates, 'pets')[0]?.value).toBe('with_consent');
    expect(byField(all.candidates, 'pets')[0]?.flags).toBeUndefined();
    expect(byField(all.candidates, 'smoking')[0]?.value).toBe('prohibited');
    expect(byField(all.candidates, 'furnished')[0]?.value).toBe('furnished');
    expect(byField(all.candidates, 'utilities')[0]?.value).toEqual({ tenant_pays: [], included: ['water'] });
  });

  it('entry request is unsupported', () => {
    expect(all.requests).toHaveLength(1);
    expect(all.requests[0]?.clause_id).toBeNull();
    expect(all.requests[0]?.quote).toBe('Can the landlord enter without notice');
  });

  it('every candidate pointer resolves to its quote', () => {
    for (const c of [...all.candidates, ...all.requests]) {
      expect(resolvePointer(it02, c.pointer)).toBe(c.quote);
    }
  });
});

describe('findAllCandidates ordering', () => {
  it('is deterministic, de-duplicated and position-ordered', () => {
    const a = findAllCandidates(intake(...DEMO01));
    const b = findAllCandidates(intake(...DEMO01));
    expect(a).toEqual(b);
    const ids = a.candidates.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = a.candidates.map((c): [number, number, number] => {
      const m = /^msg:m([0-9]+):([0-9]+)-([0-9]+)$/.exec(c.pointer);
      return [Number(m?.[1]), Number(m?.[2]), Number(m?.[3])];
    });
    const sorted = [...keys].sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    expect(keys).toEqual(sorted);
  });
});

describe('money finder', () => {
  it.each([
    ['The rent is £1,200.', '£1,200', 'monthly_rent', { currency: 'GBP', minor: 120000, period: null }],
    ['Deposit GBP 1200', 'GBP 1200', 'deposit', { currency: 'GBP', minor: 120000, period: null }],
    ['It is 1,200 a month.', '1,200 a month', 'monthly_rent', { currency: null, minor: 120000, period: 'month' }],
    ['Rent £1,200.50 pcm.', '£1,200.50 pcm', 'monthly_rent', { currency: 'GBP', minor: 120050, period: 'month' }],
    ['Rent is £300 a week.', '£300 a week', 'monthly_rent', { currency: 'GBP', minor: 30000, period: 'week' }],
    ['Rent is $1,200.', '$1,200', 'monthly_rent', { currency: 'USD', minor: 120000, period: null }],
    ['The bond is 900 pounds.', '900 pounds', 'deposit', { currency: 'GBP', minor: 90000, period: null }],
  ])('%j -> %s', (text, quote, field, value) => {
    const cs = findMoneyCandidates(intake(text));
    expect(cs).toHaveLength(1);
    expect(cs[0]?.quote).toBe(quote);
    expect(cs[0]?.field).toBe(field);
    expect(cs[0]?.value).toEqual(value);
    expect(cs[0]?.pointer).toBe(ptr(text, quote));
    expect(cs[0]?.id).toBe(`${field}:${ptr(text, quote).slice(4)}`);
  });

  it('the nearest preceding cue decides the field', () => {
    const cs = findMoneyCandidates(intake('Rent £1,200 and deposit £1,500.'));
    expect(cs.map((c) => [c.quote, c.field])).toEqual([
      ['£1,200', 'monthly_rent'],
      ['£1,500', 'deposit'],
    ]);
  });

  it('a bare amount with no cue and no period has no field', () => {
    const cs = findMoneyCandidates(intake('It costs £50.'));
    expect(cs).toHaveLength(1);
    expect(cs[0]?.field).toBeUndefined();
    expect(cs[0]?.id.startsWith('money:')).toBe(true);
  });

  it('bare numbers (years, flat numbers, durations) are not money', () => {
    expect(findMoneyCandidates(intake('Flat 2, from 2027 for 12 months, due day 1.'))).toEqual([]);
  });

  it.each([
    ["Deposit one month's rent.", "one month's rent", 1],
    ["Deposit of two months' rent.", "two months' rent", 2],
    ['The deposit is two months.', 'two months', 2],
    ['Deposit: 1 month', '1 month', 1],
  ])('relative deposit %j', (text, quote, months) => {
    const cs = findMoneyCandidates(intake(text));
    expect(cs).toHaveLength(1);
    expect(cs[0]?.kind).toBe('relative_deposit');
    expect(cs[0]?.field).toBe('deposit');
    expect(cs[0]?.quote).toBe(quote);
    expect(cs[0]?.value).toEqual({ months });
    expect(cs[0]?.flags).toEqual(['relative']);
    expect(findDurationCandidates(intake(text))).toEqual([]);
  });
});

describe('date finder', () => {
  it.each([
    ['Start 2027-03-01.', '2027-03-01', '2027-03-01'],
    ['Starting 1 March 2027.', '1 March 2027', '2027-03-01'],
    ['Starting March 1st, 2027.', 'March 1st, 2027', '2027-03-01'],
    ['Starting 1st of March 2027.', '1st of March 2027', '2027-03-01'],
    ['Start 25/03/2027.', '25/03/2027', '2027-03-25'],
    ['Start 03/25/2027.', '03/25/2027', '2027-03-25'],
    ['Start 04/04/2027.', '04/04/2027', '2027-04-04'],
  ])('%j -> %s', (text, quote, iso) => {
    const cs = findDateCandidates(intake(text));
    expect(cs).toHaveLength(1);
    expect(cs[0]?.field).toBe('start_date');
    expect(cs[0]?.quote).toBe(quote);
    expect(cs[0]?.value).toBe(iso);
    expect(cs[0]?.flags).toBeUndefined();
  });

  it('ambiguous numeric date yields both readings', () => {
    const cs = findDateCandidates(intake('Start 03/04/2027'));
    expect(cs.map((c) => c.value)).toEqual(['2027-04-03', '2027-03-04']);
    expect(cs.every((c) => c.flags?.includes('ambiguous'))).toBe(true);
  });

  it.each(['Start 31/02/2027.', 'Start 2027-02-29.', 'Start 13/13/2027.', 'Start 31 April 2027.'])(
    'impossible date %j yields no candidate',
    (text) => {
      expect(findDateCandidates(intake(text))).toEqual([]);
    },
  );

  it('accepts 29 February in a leap year', () => {
    expect(findDateCandidates(intake('Start 2028-02-29'))[0]?.value).toBe('2028-02-29');
  });

  it('year-less date: value null, needs_year, never the current year', () => {
    const cs = findDateCandidates(intake('Starting 1 March.'));
    expect(cs).toHaveLength(1);
    expect(cs[0]?.value).toBeNull();
    expect(cs[0]?.flags).toEqual(['needs_year']);
    expect(cs[0]?.quote).toBe('1 March');
  });

  it('relative date: value null, relative flag', () => {
    const cs = findDateCandidates(intake('We start next month.'));
    expect(cs).toHaveLength(1);
    expect(cs[0]?.value).toBeNull();
    expect(cs[0]?.flags).toEqual(['relative']);
  });

  it('end cue sets end_date', () => {
    const cs = findDateCandidates(intake('It ends on 28 February 2028.'));
    expect(cs[0]?.field).toBe('end_date');
    expect(cs[0]?.value).toBe('2028-02-28');
  });
});

describe('duration finder', () => {
  it.each([
    ['For 12 months.', '12 months', 12],
    ['For a year.', 'a year', 12],
    ['An 18-month tenancy.', '18-month', 18],
    ['For two years.', 'two years', 24],
    ['Term six months', 'six months', 6],
  ])('%j -> %i', (text, quote, months) => {
    const cs = findDurationCandidates(intake(text));
    expect(cs).toHaveLength(1);
    expect(cs[0]?.field).toBe('term_months');
    expect(cs[0]?.quote).toBe(quote);
    expect(cs[0]?.value).toBe(months);
  });

  it('"a month" (money period) is not a duration', () => {
    expect(findDurationCandidates(intake('Rent is £1,200 a month.'))).toEqual([]);
  });

  it('break sentence -> break_month', () => {
    const cs = findDurationCandidates(intake('There is a break clause after 6 months.'));
    expect(cs[0]?.field).toBe('break_month');
    expect(cs[0]?.value).toBe(6);
  });
});

describe('due-day finder', () => {
  it.each([
    ['Rent on the 1st.', 'on the 1st'],
    ['Rent due day 1', 'due day 1'],
    ['Rent is due on the 1st.', 'due on the 1st'],
    ['Pay on the 1st of each month.', 'on the 1st'],
  ])('%j', (text, quote) => {
    const cs = findDueDayCandidates(intake(text));
    expect(cs).toHaveLength(1);
    expect(cs[0]?.field).toBe('rent_due_day');
    expect(cs[0]?.quote).toBe(quote);
    expect(cs[0]?.value).toBe(1);
  });

  it('"on the 1st of March" is a date, not a due day', () => {
    expect(findDueDayCandidates(intake('Moving in on the 1st of March.'))).toEqual([]);
  });
});

describe('role finder', () => {
  it.each([
    ['Landlord: Sam Vale.', 'landlord', 'Sam Vale'],
    ['Landlord: Sam Vale!', 'landlord', 'Sam Vale'],
    ['Landlord: Sam Vale; more text', 'landlord', 'Sam Vale'],
    ['Landlord: Sam Vale?', 'landlord', 'Sam Vale'],
    ['Landlord: Sam Vale\nTenants: Ann Lee', 'landlord', 'Sam Vale'],
    ['The landlord is Sam Vale.', 'landlord', 'Sam Vale'],
    ['Sam Vale, the landlord, agrees.', 'landlord', 'Sam Vale'],
    ['Guarantor: Mary Shah.', 'guarantor', 'Mary Shah'],
    ['The guarantor is Mary Shah.', 'guarantor', 'Mary Shah'],
    ['Property at 3 Oak Close, Oxtown.', 'address', '3 Oak Close, Oxtown'],
    ['Address: 3 Oak Close', 'address', '3 Oak Close'],
    ['The property is at 3 Oak Close.', 'address', '3 Oak Close'],
  ])('%j -> %s %j', (text, field, value) => {
    const cs = byField(findRoleCandidates(intake(text)), field);
    expect(cs).toHaveLength(1);
    expect(cs[0]?.value).toBe(value);
    expect(cs[0]?.quote).toBe(value);
    expect(cs[0]?.pointer).toBe(ptr(text, value));
  });

  it('the terminator is never part of the quote: "St. Johns Rd" is cut at "St"', () => {
    const cs = byField(findRoleCandidates(intake('Property: 12 St. Johns Rd')), 'address');
    expect(cs[0]?.quote).toBe('12 St');
  });

  it('narrative "landlord is happy" is not a name', () => {
    expect(findRoleCandidates(intake('The landlord is happy with that.'))).toEqual([]);
  });

  it('"rent to X and Y" without an address', () => {
    const cs = findRoleCandidates(intake('I rent to Ann Lee and Bo Chan.'));
    expect(cs.map((c) => c.field)).toEqual(['tenants']);
    expect(cs[0]?.value).toEqual(['Ann Lee', 'Bo Chan']);
  });

  it('"Rent is ..." and "Rent might be ..." are not tenant cues', () => {
    expect(findRoleCandidates(intake('Rent is £1,200 a month. Rent might be £1,250 actually.'))).toEqual([]);
  });

  it('more than four tenants -> ambiguous, value null', () => {
    const cs = findRoleCandidates(intake('Tenants: A Lee, B Lee, C Lee, D Lee and E Lee.'));
    expect(cs[0]?.value).toBeNull();
    expect(cs[0]?.flags).toEqual(['ambiguous']);
  });

  it('guarantor for one tenant only -> ambiguous', () => {
    const cs = findRoleCandidates(intake('Guarantor: Mary Shah for Joe only.'));
    expect(cs[0]?.field).toBe('guarantor');
    expect(cs[0]?.value).toBeNull();
    expect(cs[0]?.flags).toEqual(['ambiguous']);
  });
});

describe('splitTenants', () => {
  it.each([
    ['Priya Shah and Joe Bloggs', ['Priya Shah', 'Joe Bloggs']],
    ['Ann, Bo and Cy', ['Ann', 'Bo', 'Cy']],
    ['Ann, Bo, and Cy', ['Ann', 'Bo', 'Cy']],
    ['Ann & Bo', ['Ann', 'Bo']],
    ['Ann Lee', ['Ann Lee']],
    ['Alexander Anderson', ['Alexander Anderson']],
  ])('%j', (payload, names) => {
    expect(splitTenants(payload)).toEqual({ ok: true, names });
  });

  it('unclear splits are ambiguous', () => {
    expect(splitTenants('Ann,, Bo')).toEqual({ ok: false, ambiguous: true, reason: 'empty_part' });
    expect(splitTenants('A, B, C, D, E')).toEqual({ ok: false, ambiguous: true, reason: 'too_many' });
    expect(splitTenants('  ')).toEqual({ ok: false, ambiguous: true, reason: 'empty' });
  });
});

describe('enum cue sentences', () => {
  it.each([
    ['No pets.', 'none', false],
    ['Pets are not allowed.', 'none', false],
    ['Pets allowed.', 'with_consent', false],
    ['Pets permitted.', 'with_consent', false],
    ["Pets with the landlord's consent.", 'with_consent', false],
    ['Tenants can keep a cat.', 'with_consent', false],
    ['No pets except a small cat.', 'none', true],
    ['Pets allowed but only small ones.', 'with_consent', true],
  ])('pets %j -> %s (ambiguous %s)', (text, value, ambiguous) => {
    const c = classifyPets(text.replace(/\.$/, ''));
    expect(c?.value).toBe(value);
    expect(c?.ambiguous).toBe(ambiguous);
  });

  it('contradictory pets cues -> ambiguous, value null', () => {
    expect(classifyPets('No pets, pets allowed')).toEqual({ value: null, ambiguous: true, residual: null });
  });

  it.each([
    ['No smoking', 'prohibited'],
    ['Smoking prohibited', 'prohibited'],
    ['Non-smoking flat', 'prohibited'],
    ['Smoking outside', 'permitted_outside'],
    ['You can smoke outside', 'permitted_outside'],
  ])('smoking %j -> %s', (text, value) => {
    expect(classifySmoking(text)?.value).toBe(value);
  });

  it.each([
    ['It comes furnished', 'furnished'],
    ['Furnished yes', 'furnished'],
    ['Unfurnished', 'unfurnished'],
    ['It is not furnished', 'unfurnished'],
    ['Furnished: no', 'unfurnished'],
  ])('furnished %j -> %s', (text, value) => {
    const c = classifyFurnished(text);
    expect(c?.value).toBe(value);
    expect(c?.ambiguous).toBe(false);
  });

  it('"unfurnished" does not also count as furnished; part furnished is ambiguous', () => {
    const cs = findEnumCandidates(intake('The flat is unfurnished.'));
    expect(cs).toHaveLength(1);
    expect(cs[0]?.value).toBe('unfurnished');
    expect(classifyFurnished('part furnished')).toEqual({ value: null, ambiguous: true, residual: null });
  });

  it('no cue -> null', () => {
    expect(classifyPets('Nice garden')).toBeNull();
    expect(classifySmoking('Nice garden')).toBeNull();
    expect(classifyFurnished('Nice garden')).toBeNull();
    expect(classifyUtilities('Nice garden')).toBeNull();
  });

  it.each([
    ['tenants pay electricity and gas', ['electricity', 'gas'], []],
    ['Utilities: water included', [], ['water']],
    ['Tenants pay gas but water is included', ['gas'], ['water']],
    ['Broadband and electric paid by the tenant', ['electricity', 'internet'], []],
    ['All bills included', [], ['water', 'electricity', 'gas', 'internet']],
  ])('utilities %j', (text, tenantPays, included) => {
    expect(classifyUtilities(text)).toEqual({ tenant_pays: tenantPays, included, ambiguous: false });
  });
});

describe('request detectors (frozen)', () => {
  it('the frozen list has the expected detector ids', () => {
    expect(REQUEST_DETECTORS.map((d) => d.id)).toEqual([
      'enter-without-notice',
      'add-clause',
      'ignore-template',
      'clause-number',
      'add-that',
      'garden-care',
      'professional-clean',
    ]);
  });

  it.each([
    ['Can the landlord enter the property without notice?', ['enter-without-notice'], null],
    ['Can you add a clause about parking?', ['add-clause'], null],
    ['Ignore the template and write your own.', ['ignore-template'], null],
    ['Add clause 99.', ['add-clause', 'clause-number'], null],
    ['Please add that rent can rise.', ['add-that'], null],
    ['Please add that the tenant does garden care.', ['add-that', 'garden-care'], 'garden-care'],
    ['The tenant will look after the garden.', ['garden-care'], 'garden-care'],
    ['The flat must be professionally cleaned at the end.', ['professional-clean'], 'professional-clean-at-end'],
  ])('%j', (text, detectors, clauseId) => {
    const rs = findRequestCandidates(intake(text));
    expect(rs).toHaveLength(1);
    expect(rs[0]?.detectors).toEqual(detectors);
    expect(rs[0]?.clause_id).toBe(clauseId);
    expect(rs[0]?.quote).toBe(text.replace(/[.?]$/, ''));
  });

  it('ordinary sentences are not requests', () => {
    expect(findRequestCandidates(intake('Tenants can keep pets in the garden. Rent is £900.'))).toEqual([]);
  });
});

describe('review fixes (M2 review 0546): enum cues', () => {
  it('"No pets allowed" / "No animals permitted" classify as none, not ambiguous', () => {
    for (const s of ['No pets allowed.', 'No animals permitted.']) {
      const c = classifyPets(s);
      expect(c?.value).toBe('none');
      expect(c?.ambiguous).toBe(false);
    }
  });
  it('"Furnished no pets" stays furnished; "Furnished: no." is unfurnished', () => {
    expect(classifyFurnished('Furnished no pets')?.value).toBe('furnished');
    expect(classifyFurnished('Furnished: no.')?.value).toBe('unfurnished');
  });
});
