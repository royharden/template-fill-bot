// M2: field parsers / validators, one test per PLAN section 4.1 rule. Written in Dirty Mode; not yet run (DV-TESTS).
import { describe, expect, it } from 'vitest';
import { FIELD_KEYS } from '../../supabase/functions/_shared/content/types.ts';
import {
  ADDRESS_MAX_CODE_POINTS,
  FIELD_SPECS,
  FIELD_SPEC_LIST,
  MAX_MONEY_MINOR,
  NAME_MAX_CODE_POINTS,
  countCodePoints,
  partyKey,
  validateAddress,
  validateName,
  validateUtilities,
} from '../../supabase/functions/_shared/fillkit/fields.ts';
import type { FieldContext } from '../../supabase/functions/_shared/fillkit/fields.ts';

const ch = (cp: number): string => String.fromCodePoint(cp);
const CJK_EXT_B = ch(0x20000); // astral letter (Lo, Han): 1 code point, 2 UTF-16 units
const CYRILLIC_A = ch(0x0430);
const GREEK_ALPHA = ch(0x03b1);
const CYRILLIC_IVAN = [0x0418, 0x0432, 0x0430, 0x043d].map(ch).join('');
const COMBINING_ACUTE = ch(0x0301);
const ZWSP = ch(0x200b);
const RLO = ch(0x202e);
const NBSP = ch(0x00a0);
const RIGHT_QUOTE = ch(0x2019);

const FIELD_SPEC_CTX_BASE = {
  deposit_cap_weeks: 5,
  term_months_min: 6,
  term_months_max: 36,
  due_day_min: 1,
  due_day_max: 28,
};

const okValue = (value: unknown) => ({ ok: true, value });
const failReason = (reason: string) => ({ ok: false, reason });

describe('field spec table', () => {
  it('has exactly the 15 schema fields in schema order', () => {
    expect(FIELD_SPEC_LIST.map((s) => s.key)).toEqual([...FIELD_KEYS]);
    expect(FIELD_SPEC_LIST).toHaveLength(15);
  });

  it('guarantor and break_month are optional; everything else required', () => {
    const optional = FIELD_SPEC_LIST.filter((s) => !s.required).map((s) => s.key);
    expect(optional).toEqual(['guarantor', 'break_month']);
  });

  it('every field has cue words and a question template', () => {
    for (const s of FIELD_SPEC_LIST) {
      expect(s.cueWords.length).toBeGreaterThan(0);
      expect(s.questionTemplate.id).toBe(`q.${s.key}.v1`);
      expect(s.questionTemplate.text.length).toBeGreaterThan(0);
    }
  });

  it('the address question tells users to write "St Johns Rd" not "St. Johns Rd"', () => {
    expect(FIELD_SPECS.address.questionTemplate.text).toContain('"St Johns Rd", not "St. Johns Rd"');
  });
});

describe('names (landlord, tenants, guarantor)', () => {
  it('accepts letters, combining marks, spaces, apostrophes and hyphens', () => {
    expect(validateName("Siobhan O'Brien-Smith")).toEqual(okValue("Siobhan O'Brien-Smith"));
    expect(validateName(`O${RIGHT_QUOTE}Neil`)).toEqual(okValue(`O${RIGHT_QUOTE}Neil`));
    expect(validateName(`Sam ${CYRILLIC_IVAN}`)).toEqual(okValue(`Sam ${CYRILLIC_IVAN}`));
  });

  it('applies NFC', () => {
    expect(validateName(`Jose${COMBINING_ACUTE}`)).toEqual(okValue(`Jos${ch(0xe9)}`));
  });

  it('trims and collapses whitespace (incl. NBSP)', () => {
    expect(validateName(`  Sam ${NBSP}  Patel `)).toEqual(okValue('Sam Patel'));
  });

  it('length is counted in code points: 80 ok, 81 rejected', () => {
    expect(validateName('a'.repeat(NAME_MAX_CODE_POINTS)).ok).toBe(true);
    expect(validateName('a'.repeat(NAME_MAX_CODE_POINTS + 1))).toEqual(failReason('too_long'));
    const astral80 = CJK_EXT_B.repeat(80);
    expect(astral80.length).toBe(160);
    expect(countCodePoints(astral80)).toBe(80);
    expect(validateName(astral80).ok).toBe(true);
    expect(validateName(CJK_EXT_B.repeat(81))).toEqual(failReason('too_long'));
  });

  it('rejects empty', () => {
    expect(validateName('   ')).toEqual(failReason('empty'));
    expect(validateName('')).toEqual(failReason('empty'));
  });

  it('rejects periods and ; : ! ?', () => {
    for (const bad of ['Sam. Vale', 'Sam; Vale', 'Sam: Vale', 'Sam! Vale', 'Sam? Vale']) {
      expect(validateName(bad)).toEqual(failReason('forbidden_punctuation'));
    }
  });

  it('rejects line breaks', () => {
    expect(validateName('Sam\nVale')).toEqual(failReason('line_break'));
    expect(validateName('Sam\r\nVale')).toEqual(failReason('line_break'));
    expect(validateName(`Sam${ch(0x2028)}Vale`)).toEqual(failReason('line_break'));
  });

  it('rejects other control characters', () => {
    expect(validateName('Sam\tVale')).toEqual(failReason('control_char'));
  });

  it('rejects braces, angle brackets, square brackets and backticks', () => {
    for (const bad of ['{{rent}}', 'Sam {Vale}', '<b>Sam</b>', 'Sam [Vale]', 'Sam `Vale`']) {
      expect(validateName(bad)).toEqual(failReason('forbidden_bracket'));
    }
  });

  it('rejects bidi / format / zero-width controls', () => {
    expect(validateName(`Sam${RLO}Vale`)).toEqual(failReason('format_char'));
    expect(validateName(`Sam${ZWSP}Vale`)).toEqual(failReason('format_char'));
  });

  it('rejects commas in names', () => {
    expect(validateName('Shah, Priya')).toEqual(failReason('comma_in_name'));
  });

  it('rejects digits in names', () => {
    expect(validateName('Sam Vale 2')).toEqual(failReason('digit_in_name'));
  });

  it('rejects other symbols', () => {
    expect(validateName('Sam_Vale')).toEqual(failReason('disallowed_char'));
    expect(validateName('Sam & Vale')).toEqual(failReason('disallowed_char'));
  });

  it('requires at least one letter', () => {
    expect(validateName("-'")).toEqual(failReason('no_letter'));
  });

  it('rejects mixed-script tokens (Latin + Cyrillic / Greek in one token)', () => {
    expect(validateName(`S${CYRILLIC_A}m Vale`)).toEqual(failReason('mixed_script'));
    expect(validateName(`P${GREEK_ALPHA}tel`)).toEqual(failReason('mixed_script'));
  });

  it('rejects non-strings', () => {
    expect(validateName(42)).toEqual(failReason('not_string'));
  });
});

describe('address', () => {
  it('accepts digits , / # in addition to name characters', () => {
    expect(validateAddress('14 Elm Road, Flat 2, Oxtown')).toEqual(okValue('14 Elm Road, Flat 2, Oxtown'));
    expect(validateAddress('Flat 2/3, #4 Elm Road')).toEqual(okValue('Flat 2/3, #4 Elm Road'));
    expect(validateAddress('14 St Johns Rd')).toEqual(okValue('14 St Johns Rd'));
  });

  it('rejects "St. Johns Rd" (period)', () => {
    expect(validateAddress('14 St. Johns Rd')).toEqual(failReason('forbidden_punctuation'));
  });

  it('length is counted in code points: 160 ok, 161 rejected', () => {
    expect(validateAddress('a'.repeat(ADDRESS_MAX_CODE_POINTS)).ok).toBe(true);
    expect(validateAddress('a'.repeat(ADDRESS_MAX_CODE_POINTS + 1))).toEqual(failReason('too_long'));
    expect(validateAddress(CJK_EXT_B.repeat(160)).ok).toBe(true);
    expect(validateAddress(CJK_EXT_B.repeat(161))).toEqual(failReason('too_long'));
  });

  it('rejects placeholders, line breaks, bidi controls and mixed scripts', () => {
    expect(validateAddress('{{rent}} Road')).toEqual(failReason('forbidden_bracket'));
    expect(validateAddress('14 Elm\nRoad')).toEqual(failReason('line_break'));
    expect(validateAddress(`14 Elm${RLO} Road`)).toEqual(failReason('format_char'));
    expect(validateAddress(`14 El${CYRILLIC_A}m Road`)).toEqual(failReason('mixed_script'));
    expect(validateAddress('14 Elm Road: Flat 2')).toEqual(failReason('forbidden_punctuation'));
  });

  it('allows commas in addresses', () => {
    expect(FIELD_SPECS.address.parse('3 Oak Close, Oxtown')).toEqual(okValue('3 Oak Close, Oxtown'));
  });
});

describe('tenants', () => {
  const t = FIELD_SPECS.tenants;

  it('parses and validates 1..4 names', () => {
    expect(t.parse('Priya Shah and Joe Bloggs')).toEqual(okValue(['Priya Shah', 'Joe Bloggs']));
    expect(t.parse('A Lee, B Lee, C Lee and D Lee').ok).toBe(true);
  });

  it('rejects unclear splits and counts outside 1..4', () => {
    expect(t.parse('A Lee, B Lee, C Lee, D Lee and E Lee')).toEqual(failReason('ambiguous_split'));
    expect(t.validate([])).toEqual(failReason('tenant_count'));
    expect(t.validate(['A', 'B', 'C', 'D', 'E'])).toEqual(failReason('tenant_count'));
    expect(t.validate('Priya')).toEqual(failReason('not_array'));
  });

  it('rejects duplicate tenants (case/whitespace-insensitive)', () => {
    expect(t.validate(['Priya Shah', 'priya  shah'])).toEqual(failReason('duplicate_tenant'));
    expect(partyKey(' Priya   SHAH ')).toBe('priya shah');
  });

  it('applies the name rules to each tenant', () => {
    expect(t.validate(['Priya Shah', 'Joe 2'])).toEqual(failReason('digit_in_name'));
  });
});

describe('money (monthly_rent, deposit)', () => {
  const rent = FIELD_SPECS.monthly_rent;
  const deposit = FIELD_SPECS.deposit;

  it.each([
    ['£1,200', 120000],
    ['GBP 1200', 120000],
    ['1,200 a month', 120000],
    ['1200', 120000],
    ['£1,200.50', 120050],
    ['1200 pounds', 120000],
  ])('rent %j -> %i pence', (text, pence) => {
    expect(rent.parse(text)).toEqual(okValue(pence));
  });

  it('GBP only; weekly rent rejected', () => {
    expect(rent.parse('$1,200')).toEqual(failReason('unsupported_currency'));
    expect(rent.parse('EUR 1200')).toEqual(failReason('unsupported_currency'));
    expect(rent.parse('£300 a week')).toEqual(failReason('weekly_rent_unsupported'));
    expect(rent.parse('about twelve hundred')).toEqual(failReason('unrecognised'));
  });

  it('positive integer pence with an upper bound', () => {
    expect(rent.parse('£0')).toEqual(failReason('not_positive'));
    expect(rent.validate(120000)).toEqual(okValue(120000));
    expect(rent.validate(1200.5)).toEqual(failReason('not_integer'));
    expect(rent.validate('120000')).toEqual(failReason('not_integer'));
    expect(rent.validate(-5)).toEqual(failReason('not_positive'));
    expect(rent.validate(MAX_MONEY_MINOR)).toEqual(okValue(MAX_MONEY_MINOR));
    expect(rent.validate(MAX_MONEY_MINOR + 1)).toEqual(failReason('too_large'));
  });

  it('deposit: absolute amounts only; relative deposit and periods reported', () => {
    expect(deposit.parse('£1,200')).toEqual(okValue(120000));
    expect(deposit.parse("one month's rent")).toEqual(failReason('relative_value'));
    expect(deposit.parse('Deposit one month')).toEqual(failReason('relative_value'));
    expect(deposit.parse('£1,200 a month')).toEqual(failReason('unexpected_period'));
  });

  it('a non-GBP jurisdiction context rejects GBP', () => {
    const usd = {
      jurisdiction: { ...FIELD_SPEC_CTX_BASE, currency: { code: 'USD', symbol: '$' } },
    } as unknown as FieldContext;
    expect(rent.parse('£1,200', usd)).toEqual(failReason('unsupported_currency'));
  });
});

describe('dates (start_date, end_date)', () => {
  const start = FIELD_SPECS.start_date;

  it.each([
    ['2027-03-01', '2027-03-01'],
    ['1 March 2027', '2027-03-01'],
    ['March 1st, 2027', '2027-03-01'],
    ['25/03/2027', '2027-03-25'],
    ['2028-02-29', '2028-02-29'],
  ])('%j -> %s', (text, iso) => {
    expect(start.parse(text)).toEqual(okValue(iso));
  });

  it('ambiguous, year-less, impossible and relative dates are rejected with a reason', () => {
    expect(start.parse('03/04/2027')).toEqual(failReason('ambiguous_date'));
    expect(start.parse('1 March')).toEqual(failReason('needs_year'));
    expect(start.parse('31/02/2027')).toEqual(failReason('impossible_date'));
    expect(start.parse('2027-02-29')).toEqual(failReason('impossible_date'));
    expect(start.parse('tomorrow')).toEqual(failReason('relative_date'));
    expect(start.parse('soon')).toEqual(failReason('unrecognised'));
  });

  it('validate requires a real ISO date', () => {
    expect(start.validate('2027-03-01')).toEqual(okValue('2027-03-01'));
    expect(start.validate('2027-13-01')).toEqual(failReason('invalid_date'));
    expect(start.validate('1 March 2027')).toEqual(failReason('invalid_date'));
    expect(FIELD_SPECS.end_date.validate('2028-02-29')).toEqual(okValue('2028-02-29'));
    expect(FIELD_SPECS.end_date.kind).toBe('computed');
  });
});

describe('term_months, rent_due_day, break_month', () => {
  const term = FIELD_SPECS.term_months;
  const due = FIELD_SPECS.rent_due_day;
  const brk = FIELD_SPECS.break_month;

  it.each([
    ['12 months', 12],
    ['a year', 12],
    ['18-month', 18],
    ['two years', 24],
    ['12', 12],
  ])('term %j -> %i', (text, months) => {
    expect(term.parse(text)).toEqual(okValue(months));
  });

  it('term must be within the jurisdiction range (6..36)', () => {
    expect(term.parse('5 months')).toEqual(failReason('out_of_range'));
    expect(term.validate(6)).toEqual(okValue(6));
    expect(term.validate(36)).toEqual(okValue(36));
    expect(term.validate(37)).toEqual(failReason('out_of_range'));
    expect(term.validate(12.5)).toEqual(failReason('not_integer'));
  });

  it.each([
    ['on the 1st', 1],
    ['due day 1', 1],
    ['due on the 1st', 1],
    ['28th', 28],
  ])('due day %j -> %i', (text, day) => {
    expect(due.parse(text)).toEqual(okValue(day));
  });

  it('due day must be within 1..28', () => {
    expect(due.parse('29th')).toEqual(failReason('out_of_range'));
    expect(due.validate(0)).toEqual(failReason('out_of_range'));
  });

  it('break_month is an integer >= 1 (upper bound is cross-field, M3)', () => {
    expect(brk.parse('6')).toEqual(okValue(6));
    expect(brk.parse('after 6 months')).toEqual(okValue(6));
    expect(brk.parse('0')).toEqual(failReason('out_of_range'));
    expect(brk.validate(40)).toEqual(okValue(40));
  });
});

describe('enums', () => {
  it('pets: none | with_consent', () => {
    expect(FIELD_SPECS.pets.parse('No pets')).toEqual(okValue('none'));
    expect(FIELD_SPECS.pets.parse('Pets allowed')).toEqual(okValue('with_consent'));
    expect(FIELD_SPECS.pets.parse('No pets except a small cat')).toEqual(failReason('ambiguous'));
    expect(FIELD_SPECS.pets.parse('A lovely garden')).toEqual(failReason('no_cue'));
    expect(FIELD_SPECS.pets.validate('with_consent')).toEqual(okValue('with_consent'));
    expect(FIELD_SPECS.pets.validate('allowed')).toEqual(failReason('not_in_set'));
  });

  it('smoking: prohibited | permitted_outside', () => {
    expect(FIELD_SPECS.smoking.parse('No smoking')).toEqual(okValue('prohibited'));
    expect(FIELD_SPECS.smoking.parse('can smoke outside')).toEqual(okValue('permitted_outside'));
    expect(FIELD_SPECS.smoking.validate('yes')).toEqual(failReason('not_in_set'));
  });

  it('furnished: furnished | unfurnished ("unfurnished" is not furnished)', () => {
    expect(FIELD_SPECS.furnished.parse('unfurnished')).toEqual(okValue('unfurnished'));
    expect(FIELD_SPECS.furnished.parse('furnished')).toEqual(okValue('furnished'));
    expect(FIELD_SPECS.furnished.parse('part furnished')).toEqual(failReason('ambiguous'));
  });
});

describe('utilities (tenant-paid subset of the closed list)', () => {
  const u = FIELD_SPECS.utilities;

  it('parses a list answer into closed-list order', () => {
    expect(u.parse('electricity and gas')).toEqual(okValue(['electricity', 'gas']));
    expect(u.parse('gas, water')).toEqual(okValue(['water', 'gas']));
    expect(u.parse('broadband & electric')).toEqual(okValue(['electricity', 'internet']));
    expect(u.parse('none')).toEqual(okValue([]));
  });

  it('rejects unknown and duplicate categories', () => {
    expect(u.parse('coal')).toEqual(failReason('unknown_utility'));
    expect(validateUtilities(['gas', 'gas'])).toEqual(failReason('duplicate_utility'));
    expect(validateUtilities(['oil'])).toEqual(failReason('unknown_utility'));
    expect(validateUtilities('gas')).toEqual(failReason('not_array'));
    expect(validateUtilities(['internet', 'water'])).toEqual(okValue(['water', 'internet']));
  });
});
