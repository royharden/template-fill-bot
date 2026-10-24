import { describe, expect, it } from 'vitest';
import { CLAUSES } from '../../supabase/functions/_shared/content/clauses.ts';
import { FRAME } from '../../supabase/functions/_shared/content/frame.ts';
import { JURISDICTION } from '../../supabase/functions/_shared/content/jurisdiction.ts';
import {
  CLAUSE_LICENCE,
  DERIVED_PLACEHOLDERS,
  FIELD_KEYS,
  JURISDICTION_PLACEHOLDER_KEYS,
  METHOD_TOKENS,
  PREDICATE_OPERATORS,
  REQUIRED_FRAME_IDS,
} from '../../supabase/functions/_shared/content/types.ts';
import { LIBRARY_CONTENT, placeholderNamesIn, validateContent } from '../../supabase/functions/_shared/fillkit/library.ts';

// Clause inventory of PLAN section 4.3 (K9/K10): 14 mandatory, 11 branch, 2 requestable.
const MANDATORY = [
  'parties',
  'property',
  'term',
  'rent',
  'rent-payment',
  'deposit',
  'deposit-return',
  'use-of-property',
  'repairs-tenant',
  'repairs-landlord',
  'access-with-notice',
  'quiet-enjoyment',
  'ending-tenancy',
  'notices',
];
const BRANCH = [
  'pets-none',
  'pets-with-landlord-consent',
  'smoking-prohibited',
  'smoking-permitted-outside',
  'furnished-inventory',
  'unfurnished',
  'utilities-tenant-pays',
  'utilities-included-in-rent',
  'guarantor',
  'break-clause',
  'joint-and-several',
];
const REQUESTABLE = ['garden-care', 'professional-clean-at-end'];

function idsOf(category: string): string[] {
  return CLAUSES.filter((c) => c.category === category)
    .map((c) => c.id)
    .sort();
}

function operatorsIn(predicate: unknown, out: Set<string>): Set<string> {
  if (predicate === true) return out;
  const [op, arg] = Object.entries(predicate as Record<string, unknown>)[0];
  out.add(op);
  if (op === 'all' || op === 'any') for (const child of arg as unknown[]) operatorsIn(child, out);
  if (op === 'not') operatorsIn(arg, out);
  return out;
}

function sentenceCount(text: string): number {
  return text.split(/[.!?](?:\s+|$)/).filter((s) => s.trim() !== '').length;
}

describe('clause library inventory', () => {
  it('has 27 records split 14 mandatory / 11 branch / 2 requestable', () => {
    expect(CLAUSES).toHaveLength(27);
    expect(idsOf('mandatory')).toEqual([...MANDATORY].sort());
    expect(idsOf('branch')).toEqual([...BRANCH].sort());
    expect(idsOf('requestable')).toEqual([...REQUESTABLE].sort());
  });

  it('has unique ids and unique orders', () => {
    expect(new Set(CLAUSES.map((c) => c.id)).size).toBe(CLAUSES.length);
    expect(new Set(CLAUSES.map((c) => c.order)).size).toBe(CLAUSES.length);
  });

  it('does not contain an "enter without notice" clause (unsupported-request trap)', () => {
    for (const c of CLAUSES) {
      expect(c.id).not.toMatch(/without-notice/);
      expect(c.text.toLowerCase()).not.toContain('without notice');
    }
  });

  it('the committed content passes static validation', () => {
    expect(validateContent(LIBRARY_CONTENT)).toEqual([]);
  });
});

describe('every clause record', () => {
  for (const c of CLAUSES) {
    describe(c.id, () => {
      it('has every PLAN section 4.3 field', () => {
        expect(Object.keys(c).sort()).toEqual(
          ['applies', 'author', 'category', 'id', 'licence', 'order', 'placeholders', 'text', 'title', 'version'].sort(),
        );
        expect(Number.isInteger(c.version) && c.version > 0).toBe(true);
        expect(Number.isInteger(c.order) && c.order > 0).toBe(true);
        expect(c.title.trim()).not.toBe('');
        expect(c.licence).toBe(CLAUSE_LICENCE);
        expect(c.author.trim()).not.toBe('');
      });

      it('has 1 to 4 sentences of plain text', () => {
        const n = sentenceCount(c.text);
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(4);
        expect(c.text).not.toMatch(/[<>[\]`]/);
      });

      it('declares exactly the placeholders it uses, each a field, derived value or jurisdiction value', () => {
        const used = new Set(placeholderNamesIn(c.text));
        const declared = new Set(c.placeholders.map((p) => p.name));
        expect([...used].sort()).toEqual([...declared].sort());
        for (const p of c.placeholders) {
          const known =
            (FIELD_KEYS as readonly string[]).includes(p.name) ||
            Object.prototype.hasOwnProperty.call(DERIVED_PLACEHOLDERS, p.name) ||
            (JURISDICTION_PLACEHOLDER_KEYS as readonly string[]).includes(p.name);
          expect(known).toBe(true);
          expect(p.kind).toBeTruthy();
        }
        const withoutTokens = c.text.replace(/\{\{[a-z_][a-z0-9_]*\}\}/g, '');
        expect(withoutTokens).not.toMatch(/\{\{|\}\}/);
      });

      it('uses only the PLAN section 4.3 predicate operators', () => {
        for (const op of operatorsIn(c.applies, new Set())) {
          expect(PREDICATE_OPERATORS as readonly string[]).toContain(op);
        }
        if (c.category === 'mandatory') expect(c.applies).toBe(true);
      });
    });
  }
});

describe('branch predicates match PLAN section 4.3', () => {
  const applies = (id: string): unknown => CLAUSES.find((c) => c.id === id)?.applies;

  it('maps each branch to its field condition', () => {
    expect(applies('joint-and-several')).toEqual({ countGte: ['tenants', 2] });
    expect(applies('guarantor')).toEqual({ present: 'guarantor' });
    expect(applies('break-clause')).toEqual({ present: 'break_month' });
    expect(applies('pets-none')).toEqual({ eq: ['pets', 'none'] });
    expect(applies('pets-with-landlord-consent')).toEqual({ eq: ['pets', 'with_consent'] });
    expect(applies('smoking-prohibited')).toEqual({ eq: ['smoking', 'prohibited'] });
    expect(applies('smoking-permitted-outside')).toEqual({ eq: ['smoking', 'permitted_outside'] });
    expect(applies('furnished-inventory')).toEqual({ eq: ['furnished', 'furnished'] });
    expect(applies('unfurnished')).toEqual({ eq: ['furnished', 'unfurnished'] });
    expect(applies('utilities-tenant-pays')).toEqual({ nonEmpty: 'utilities' });
    expect(applies('utilities-included-in-rent')).toEqual({ complementNonEmpty: 'utilities' });
  });

  it('shows the landlord-entry notice from the jurisdiction config, not literal text', () => {
    const access = CLAUSES.find((c) => c.id === 'access-with-notice');
    expect(access?.text).toContain('{{notice_hours_landlord_entry}}');
    expect(access?.placeholders).toEqual([
      { name: 'notice_hours_landlord_entry', kind: 'int', source: 'jurisdiction', from: 'notice_hours_landlord_entry' },
    ]);
  });
});

describe('frame', () => {
  const byId = new Map(FRAME.map((r) => [r.id, r]));

  it('has unique ids and every required record', () => {
    expect(byId.size).toBe(FRAME.length);
    for (const id of REQUIRED_FRAME_IDS) expect(byId.has(id)).toBe(true);
  });

  it('has the draft / not-legal-advice notice and the illustrative-jurisdiction notice', () => {
    expect(byId.get('draft-notice')?.text).toMatch(/NOT LEGAL ADVICE/);
    expect(byId.get('jurisdiction-notice')?.text).toContain('not any real law');
  });

  it('has all appendix labels', () => {
    const labels = FRAME.filter((r) => r.kind === 'appendix_label').map((r) => r.id);
    for (const id of REQUIRED_FRAME_IDS.filter((x) => x.startsWith('appendix-'))) {
      expect(labels).toContain(id);
    }
  });

  it('locks the list join tokens ", " and " and "', () => {
    expect(byId.get('join-list-separator')?.text).toBe(', ');
    expect(byId.get('join-list-final')?.text).toBe(' and ');
  });

  it('locks the "requests were not included" sentences', () => {
    expect(byId.get('requests-not-included-many')?.text).toBe('{{n}} requests were not included; see provenance file.');
    expect(byId.get('requests-not-included-one')?.text).toBe('1 request was not included; see provenance file.');
  });

  it('locks the closed method token list', () => {
    expect(byId.get('method-tokens')?.tokens).toEqual([...METHOD_TOKENS]);
    expect([...METHOD_TOKENS]).toEqual(['regex', 'llm', 'jev', 'mock', 'user_answer', 'none_confirmed']);
  });

  it('section headings cover the clause orders in increasing order', () => {
    const headings = FRAME.filter((r) => r.kind === 'heading');
    const starts = headings.map((r) => r.from_order ?? -1);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    const firstClauseOrder = Math.min(...CLAUSES.map((c) => c.order));
    expect(starts[0]).toBeLessThanOrEqual(firstClauseOrder);
  });
});

describe('jurisdiction (PLAN section 4.2)', () => {
  it('has the illustrative values and label', () => {
    expect(JURISDICTION).toMatchObject({
      currency: { code: 'GBP', symbol: '£' },
      deposit_cap_weeks: 5,
      term_months_min: 6,
      term_months_max: 36,
      due_day_min: 1,
      due_day_max: 28,
      notice_hours_landlord_entry: 24,
      notice_days_tenant_end: 30,
      notice_days_landlord_end: 60,
    });
    expect(Number.isInteger(JURISDICTION.version)).toBe(true);
    expect(JURISDICTION.label).toContain('invented example values, not any real law');
  });
});
