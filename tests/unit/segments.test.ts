// M3: segment / paragraph model (PLAN section 4.6). Written in Dirty Mode; not yet run (DV-TESTS).
import { describe, expect, it } from 'vitest';
import {
  CanonicalJsonError,
  LIBRARY_CONTENT,
  SegmentError,
  agreementContentHash,
  buildBodyParagraphs,
  buildDocument,
  canonicalJson,
  clauseSegments,
  formatDate,
  formatMoney,
  joinListSegments,
  ordinal,
  paragraphText,
  selectClauses,
  sha256Hex,
  splitTemplate,
  validateFields,
  validateName,
} from '../../supabase/functions/_shared/fillkit/index.ts';
import type { ClauseRecord, FieldKey } from '../../supabase/functions/_shared/content/types.ts';
import type { GroundedField } from '../../supabase/functions/_shared/fillkit/index.ts';
import { TEST_LOCK, completeRecords, valid } from './m3Helpers.ts';

function clause(id: string): ClauseRecord {
  const c = LIBRARY_CONTENT.clauses.find((x) => x.id === id);
  if (c === undefined) throw new Error(id);
  return c;
}

function text(segs: readonly { text: string }[]): string {
  return segs.map((s) => s.text).join('');
}

/** Effective records, bypassing validators (to prove the renderer itself never interprets values). */
function raw(overrides: Partial<Record<FieldKey, GroundedField>>): Record<FieldKey, GroundedField> {
  return { ...validateFields(completeRecords()), ...overrides };
}

describe('formats', () => {
  it('money: £ with thousands separators and two decimals', () => {
    expect(formatMoney(120000, '£')).toBe('£1,200.00');
    expect(formatMoney(125050, '£')).toBe('£1,250.50');
    expect(formatMoney(5, '£')).toBe('£0.05');
    expect(formatMoney(100000000, '£')).toBe('£1,000,000.00');
    expect(formatMoney(99900, '£')).toBe('£999.00');
  });

  it('dates: day month-name year', () => {
    expect(formatDate('2028-02-29')).toBe('29 February 2028');
    expect(formatDate('2027-04-03')).toBe('3 April 2027');
    expect(() => formatDate('2027-13-01')).toThrow(SegmentError);
  });

  it('ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 28].map(ordinal)).toEqual([
      '1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '28th',
    ]);
  });
});

describe('placeholder substitution', () => {
  it('splits on {{name}} tokens', () => {
    expect(splitTemplate('a {{x}} b {{y_z}}')).toEqual([
      { t: 'text', text: 'a ' },
      { t: 'placeholder', name: 'x' },
      { t: 'text', text: ' b ' },
      { t: 'placeholder', name: 'y_z' },
    ]);
  });

  it('replacement patterns in a value stay literal ($&, $1, $$, $`)', () => {
    const tricky = 'Sam $& $1 $$ $` Patel';
    const segs = clauseSegments(LIBRARY_CONTENT, clause('parties'), raw({ landlord: valid('landlord', tricky) }));
    expect(text(segs)).toContain(`between ${tricky} (the Landlord)`);
    expect(segs.filter((s) => s.kind === 'value' && s.field === 'landlord').map((s) => s.text)).toEqual([tricky]);
  });

  it('a value carrying {{rent}} is rejected by the validator and by the segment builder', () => {
    expect(validateName('Sam {{rent}}')).toEqual({ ok: false, reason: 'forbidden_bracket' });
    expect(() =>
      clauseSegments(LIBRARY_CONTENT, clause('parties'), raw({ landlord: valid('landlord', 'Sam {{monthly_rent}}') })),
    ).toThrow(SegmentError);
  });

  it('segments keep locked text and values apart', () => {
    const segs = clauseSegments(LIBRARY_CONTENT, clause('rent'), raw({}));
    expect(segs).toEqual([
      { kind: 'clause_text', clause_id: 'rent', text: 'The rent is ' },
      { kind: 'value', field: 'monthly_rent', text: '£1,200.00' },
      {
        kind: 'clause_text',
        clause_id: 'rent',
        text: ' per month. The rent will not change during the fixed term unless both parties agree in writing.',
      },
    ]);
  });

  it('jurisdiction placeholders render from the config', () => {
    const segs = clauseSegments(LIBRARY_CONTENT, clause('access-with-notice'), raw({}));
    expect(segs.find((s) => s.kind === 'value')).toEqual({ kind: 'value', field: 'notice_hours_landlord_entry', text: '24' });
  });
});

describe('lists use the locked join tokens as frame segments', () => {
  it('a | a and b | a, b and c', () => {
    expect(text(joinListSegments(LIBRARY_CONTENT, 'tenants', ['A']))).toBe('A');
    expect(text(joinListSegments(LIBRARY_CONTENT, 'tenants', ['A', 'B']))).toBe('A and B');
    const three = joinListSegments(LIBRARY_CONTENT, 'tenants', ['A', 'B', 'C']);
    expect(text(three)).toBe('A, B and C');
    expect(three.map((s) => s.kind)).toEqual(['value', 'frame', 'value', 'frame', 'value']);
    expect(three.filter((s) => s.kind === 'frame').map((s) => (s.kind === 'frame' ? s.id : ''))).toEqual([
      'join-list-separator',
      'join-list-final',
    ]);
  });

  it('utilities lists follow the closed order whatever the stored order', () => {
    const f = raw({ utilities: valid('utilities', ['internet', 'electricity']) });
    expect(text(clauseSegments(LIBRARY_CONTENT, clause('utilities-tenant-pays'), f))).toContain(': electricity and internet.');
    expect(text(clauseSegments(LIBRARY_CONTENT, clause('utilities-included-in-rent'), f))).toContain(': water and gas.');
  });

  it('rent_due_day_ordinal', () => {
    const f = raw({ rent_due_day: valid('rent_due_day', 22) });
    expect(text(clauseSegments(LIBRARY_CONTENT, clause('rent-payment'), f))).toContain('on the 22nd day of each month');
  });
});

describe('document', () => {
  const fields = validateFields(completeRecords());
  const clauses = selectClauses(LIBRARY_CONTENT, fields, []);

  it('title, notices, one heading per non-empty section, clauses in order', () => {
    const body = buildBodyParagraphs({ content: LIBRARY_CONTENT, lock: TEST_LOCK, fields, clauses, notIncludedCount: 0 });
    expect(body.slice(0, 3).map((p) => p.style)).toEqual(['Title', 'Normal', 'Normal']);
    const headings = body.filter((p) => p.style === 'Heading1').map(paragraphText);
    expect(headings).toEqual([
      'Parties and property',
      'Term',
      'Rent, bills and deposit',
      'Living in the property',
      'Repairs and access',
      'Ending the tenancy and notices',
    ]);
    expect(body.filter((p) => p.style === 'Normal')).toHaveLength(2 + clauses.length);
  });

  it('the Not-included count sentence: none, one, many (count as a value segment)', () => {
    const at = (n: number) =>
      buildBodyParagraphs({ content: LIBRARY_CONTENT, lock: TEST_LOCK, fields, clauses, notIncludedCount: n }).map(paragraphText);
    expect(at(0).some((t) => t.includes('not included'))).toBe(false);
    expect(at(1)).toContain('1 request was not included; see provenance file.');
    expect(at(3)).toContain('3 requests were not included; see provenance file.');
  });

  it('content hash = sha256 of canonical [style, text] of the body; appendix carries it', () => {
    const doc = buildDocument({ content: LIBRARY_CONTENT, lock: TEST_LOCK, fields, clauses, notIncludedCount: 2 });
    expect(doc.contentHash).toBe(sha256Hex(canonicalJson(doc.body.map((p) => [p.style, paragraphText(p)]))));
    expect(doc.contentHash).toBe(agreementContentHash(doc.body));
    const last = doc.appendix[doc.appendix.length - 1];
    expect(last === undefined ? '' : paragraphText(last)).toBe(`Agreement content hash, ${doc.contentHash}`);
    expect(doc.paragraphs).toEqual([...doc.body, ...doc.appendix]);
  });

  it('appendix rows: field, value, method token, pointer or question id; no end_date row', () => {
    const doc = buildDocument({ content: LIBRARY_CONTENT, lock: TEST_LOCK, fields, clauses, notIncludedCount: 0 });
    const rows = doc.appendix.map(paragraphText);
    expect(rows).toContain('Field, Value, Method, Source pointer');
    expect(rows).toContain('monthly_rent, £1,200.00, mock, msg:m1:0-1');
    expect(rows).toContain('tenants, Priya Shah and Joe Bloggs, mock, msg:m1:0-1');
    expect(rows).toContain('guarantor, , none_confirmed, q.optional_terms.v1');
    expect(rows.some((r) => r.startsWith('end_date'))).toBe(false);
    expect(rows).toContain('Clauses used, Version');
    expect(rows).toContain('parties, 1');
    expect(rows).toContain(`Clause library hash, ${TEST_LOCK.overall}`);
    expect(rows).toContain(`Jurisdiction config hash, ${TEST_LOCK.jurisdiction}`);
  });

  it('a field that is not resolved cannot be rendered', () => {
    const broken = { ...fields, deposit: { field: 'deposit' as const, state: 'missing' as const, candidates: [], reasons: [] } };
    expect(() =>
      buildDocument({ content: LIBRARY_CONTENT, lock: TEST_LOCK, fields: broken, clauses, notIncludedCount: 0 }),
    ).toThrow(SegmentError);
  });

  it('canonical JSON of the paragraph model is stable (determinism)', () => {
    const a = buildDocument({ content: LIBRARY_CONTENT, lock: TEST_LOCK, fields, clauses, notIncludedCount: 1 });
    const b = buildDocument({ content: LIBRARY_CONTENT, lock: TEST_LOCK, fields, clauses, notIncludedCount: 1 });
    expect(canonicalJson(a.paragraphs)).toBe(canonicalJson(b.paragraphs));
    expect(CanonicalJsonError).toBeDefined();
  });
});
