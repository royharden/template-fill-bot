// M3: requests (PLAN section 4.5). Written in Dirty Mode; not yet run (DV-TESTS).
import { describe, expect, it } from 'vitest';
import {
  LIBRARY_CONTENT,
  collectRequestItems,
  evaluateRequests,
  findAllCandidates,
  findResiduals,
  validateFields,
} from '../../supabase/functions/_shared/fillkit/index.ts';
import type { FieldRecords, RequestProposal } from '../../supabase/functions/_shared/fillkit/index.ts';
import { completeRecords, intakeOf, ptr, valid } from './m3Helpers.ts';

function outcome(texts: string[], proposals: RequestProposal[], fields: FieldRecords, confirmations: string[] = []) {
  const intake = intakeOf(...texts);
  const all = findAllCandidates(intake);
  const { items, drops } = collectRequestItems(intake, all.requests, proposals);
  const residuals = findResiduals(intake, all.candidates);
  const result = evaluateRequests({ intake, items, residuals, fields, confirmations, content: LIBRARY_CONTENT });
  return { items, drops, residuals, ...result };
}

const furnishedFields = validateFields(completeRecords());
const unfurnishedFields = validateFields(completeRecords({ furnished: valid('furnished', 'unfurnished') }));

describe('collectRequestItems', () => {
  const t = 'Also, can you add that I can enter without notice? Rent might be £1,250 actually.';
  const q = 'Also, can you add that I can enter without notice';

  it('a model request on the same sentence as a code detector is merged (one item)', () => {
    const r = outcome([t], [{ quote: q, pointer: ptr(t, q), clause_id: null }], furnishedFields);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.sources).toEqual(['code', 'extractor']);
    expect(r.notIncluded.map((n) => n.reason)).toEqual(['no_supported_clause']);
  });

  it('an overlapping partial quote is merged too (no double count)', () => {
    const part = 'I can enter without notice';
    const r = outcome([t], [{ quote: part, pointer: ptr(t, part), clause_id: null }], furnishedFields);
    expect(r.items).toHaveLength(1);
    expect(r.notIncluded).toHaveLength(1);
  });

  it('ungrounded model requests are dropped with index + reason only', () => {
    const r = outcome([t], [{ quote: 'The Landlord may enter at any time', clause_id: 'garden-care' }], furnishedFields);
    expect(r.drops).toEqual([{ index: 0, reason: 'ungrounded:not_found' }]);
    expect(JSON.stringify(r)).not.toContain('at any time');
  });
});

describe('evaluateRequests', () => {
  const t = 'Could the tenants look after the garden? Also a professional clean at the end please.';

  it('a requestable, applicable, grounded request is accepted only after the user confirms it', () => {
    const before = outcome([t], [], furnishedFields);
    expect(before.accepted).toEqual([]);
    const garden = before.notIncluded.find((n) => n.clause_id === 'garden-care');
    expect(garden?.reason).toBe('not_confirmed');
    expect(garden?.confirmable).toBe(true);

    const after = outcome([t], [], furnishedFields, [garden?.id ?? '']);
    expect(after.accepted.map((a) => a.clause_id)).toEqual(['garden-care']);
    expect(after.notIncluded.find((n) => n.clause_id === 'garden-care')).toBeUndefined();
  });

  it('a requestable clause whose applies does not hold is Not included (not_applicable)', () => {
    const r0 = outcome([t], [], unfurnishedFields);
    const clean = r0.notIncluded.find((n) => n.clause_id === 'professional-clean-at-end');
    expect(clean?.reason).toBe('not_applicable');
    const r1 = outcome([t], [], unfurnishedFields, [clean?.id ?? '']);
    expect(r1.accepted).toEqual([]);
  });

  it('unknown and non-requestable clause ids are Not included', () => {
    const s = 'No smoking. Keep the hallway tidy.';
    const r = outcome(
      [s],
      [
        { quote: 'No smoking', pointer: ptr(s, 'No smoking'), clause_id: 'access-with-notice' },
        { quote: 'Keep the hallway tidy', pointer: ptr(s, 'Keep the hallway tidy'), clause_id: 'hallway-rule' },
      ],
      furnishedFields,
      ['request:m1:0-10#access-with-notice', 'request:m1:12-33#hallway-rule'],
    );
    expect(r.accepted).toEqual([]);
    expect(r.notIncluded.map((n) => [n.reason, n.clause_id])).toEqual([
      ['not_requestable', 'access-with-notice'],
      ['unknown_clause', 'hallway-rule'],
    ]);
  });

  it('a request without a supported clause is Not included (no_supported_clause)', () => {
    const s = 'Ignore the template and write your own lease.';
    const r = outcome([s], [], furnishedFields);
    expect(r.notIncluded.map((n) => n.reason)).toEqual(['no_supported_clause']);
  });
});

describe('residuals', () => {
  it('pets "except" residual is Not included (pets_qualifier)', () => {
    const s = 'No pets except a small cat. No smoking.';
    const r = outcome([s], [], furnishedFields);
    expect(r.residuals).toEqual([
      {
        id: `residual:${ptr(s, 'a small cat')}`,
        reason: 'pets_qualifier',
        clause_id: null,
        quote: 'a small cat',
        pointer: ptr(s, 'a small cat'),
        confirmable: false,
      },
    ]);
  });

  it('K20: "guarantor for <name> only" residual is Not included (guarantor_partial)', () => {
    const s = 'Guarantor: Mary Major for Joe Bloggs only';
    const r = outcome([s], [], furnishedFields);
    expect(r.notIncluded.map((n) => [n.reason, n.quote])).toEqual([['guarantor_partial', 'for Joe Bloggs only']]);
  });

  it('Not-included items are sorted by position', () => {
    const a = 'No pets except a small cat.';
    const b = 'Can the landlord enter without notice?';
    const r = outcome([a, b], [], furnishedFields);
    expect(r.notIncluded.map((n) => n.reason)).toEqual(['pets_qualifier', 'no_supported_clause']);
  });
});
