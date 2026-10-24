// M3: renderer-side predicate evaluator and clause selection (PLAN sections 4.3, 4.6).
// Written in Dirty Mode; not yet run (DV-TESTS).
import { describe, expect, it } from 'vitest';
import {
  LIBRARY_CONTENT,
  evaluatePredicate,
  selectClauses,
  validateFields,
} from '../../supabase/functions/_shared/fillkit/index.ts';
import { completeRecords, noneConfirmed, records, valid } from './m3Helpers.ts';

describe('evaluatePredicate', () => {
  const f = validateFields(
    completeRecords({ guarantor: valid('guarantor', 'Mary Major'), break_month: noneConfirmed('break_month') }),
  );

  it('true / eq / not / all / any', () => {
    expect(evaluatePredicate(true, f)).toBe(true);
    expect(evaluatePredicate({ eq: ['pets', 'with_consent'] }, f)).toBe(true);
    expect(evaluatePredicate({ eq: ['pets', 'none'] }, f)).toBe(false);
    expect(evaluatePredicate({ not: { eq: ['pets', 'none'] } }, f)).toBe(true);
    expect(evaluatePredicate({ all: [{ eq: ['pets', 'with_consent'] }, { eq: ['smoking', 'prohibited'] }] }, f)).toBe(true);
    expect(evaluatePredicate({ all: [{ eq: ['pets', 'with_consent'] }, { eq: ['smoking', 'permitted_outside'] }] }, f)).toBe(false);
    expect(evaluatePredicate({ any: [{ eq: ['pets', 'none'] }, { eq: ['smoking', 'prohibited'] }] }, f)).toBe(true);
  });

  it('nonEmpty / complementNonEmpty / countGte', () => {
    expect(evaluatePredicate({ nonEmpty: 'utilities' }, f)).toBe(true);
    expect(evaluatePredicate({ complementNonEmpty: 'utilities' }, f)).toBe(true);
    expect(evaluatePredicate({ countGte: ['tenants', 2] }, f)).toBe(true);
    expect(evaluatePredicate({ countGte: ['tenants', 3] }, f)).toBe(false);
    const all4 = validateFields(completeRecords({ utilities: valid('utilities', ['water', 'electricity', 'gas', 'internet']) }));
    expect(evaluatePredicate({ complementNonEmpty: 'utilities' }, all4)).toBe(false);
    const none = validateFields(completeRecords({ utilities: valid('utilities', []) }));
    expect(evaluatePredicate({ nonEmpty: 'utilities' }, none)).toBe(false);
  });

  it('present: valid only (none_confirmed is not present)', () => {
    expect(evaluatePredicate({ present: 'guarantor' }, f)).toBe(true);
    expect(evaluatePredicate({ present: 'break_month' }, f)).toBe(false);
  });

  it('a non-valid field never satisfies eq (fail closed)', () => {
    const missing = validateFields(records());
    expect(evaluatePredicate({ eq: ['furnished', 'furnished'] }, missing)).toBe(false);
    expect(evaluatePredicate({ not: { eq: ['furnished', 'furnished'] } }, missing)).toBe(true);
  });

  it('malformed predicates evaluate to false', () => {
    expect(evaluatePredicate({ bogus: 'x' } as never, f)).toBe(false);
    expect(evaluatePredicate({ all: [] } as never, f)).toBe(false);
  });
});

describe('selectClauses', () => {
  it('mandatory + applicable branch clauses, sorted by order; requestables only when accepted', () => {
    const f = validateFields(completeRecords());
    const ids = selectClauses(LIBRARY_CONTENT, f, []).map((c) => c.id);
    expect(ids).toEqual([
      'parties',
      'joint-and-several',
      'property',
      'furnished-inventory',
      'term',
      'rent',
      'rent-payment',
      'utilities-tenant-pays',
      'utilities-included-in-rent',
      'deposit',
      'deposit-return',
      'use-of-property',
      'pets-with-landlord-consent',
      'smoking-prohibited',
      'repairs-tenant',
      'repairs-landlord',
      'access-with-notice',
      'quiet-enjoyment',
      'ending-tenancy',
      'notices',
    ]);
    const withGarden = selectClauses(LIBRARY_CONTENT, f, ['garden-care']).map((c) => c.id);
    expect(withGarden).toContain('garden-care');
    expect(withGarden.indexOf('garden-care')).toBe(withGarden.indexOf('smoking-prohibited') + 1);
  });

  it('an accepted requestable whose applies fails is not selected', () => {
    const f = validateFields(completeRecords({ furnished: valid('furnished', 'unfurnished') }));
    const ids = selectClauses(LIBRARY_CONTENT, f, ['professional-clean-at-end']).map((c) => c.id);
    expect(ids).not.toContain('professional-clean-at-end');
    expect(ids).toContain('unfurnished');
    expect(ids).not.toContain('furnished-inventory');
  });

  it('guarantor and break clauses appear only when those fields are valid', () => {
    const f = validateFields(completeRecords({ guarantor: valid('guarantor', 'Mary Major'), break_month: valid('break_month', 6) }));
    const ids = selectClauses(LIBRARY_CONTENT, f, []).map((c) => c.id);
    expect(ids).toContain('guarantor');
    expect(ids).toContain('break-clause');
  });
});
