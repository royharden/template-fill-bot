// M2: zod schemas and unknown-key handling for model output (PLAN section 4.5). Written in Dirty Mode; not yet
// run (DV-TESTS).
import { describe, expect, it } from 'vitest';
import {
  CandidateSchema,
  FieldKeySchema,
  FieldStateSchema,
  parseExtractorOutput,
  stripUnknownKeys,
} from '../../supabase/functions/_shared/fillkit/schema.ts';

describe('enums', () => {
  it('field states are the six PLAN states', () => {
    expect(FieldStateSchema.options).toEqual(['valid', 'missing', 'conflict', 'ambiguous', 'invalid', 'none_confirmed']);
  });

  it('field keys reject unknown names', () => {
    expect(FieldKeySchema.safeParse('monthly_rent').success).toBe(true);
    expect(FieldKeySchema.safeParse('weekly_rent').success).toBe(false);
  });
});

describe('CandidateSchema', () => {
  it('accepts a money candidate', () => {
    const c = {
      id: 'monthly_rent:m2:44-58',
      kind: 'money',
      field: 'monthly_rent',
      value: { currency: 'GBP', minor: 120000, period: 'month' },
      quote: '£1,200 a month',
      pointer: 'msg:m2:44-58',
    };
    expect(CandidateSchema.safeParse(c).success).toBe(true);
  });
});

describe('stripUnknownKeys', () => {
  it('drops unknown top-level and per-proposal keys and reports their paths', () => {
    const raw = {
      fields: [{ field: 'landlord', quote: 'Sam Patel', confidence: 0.9 }],
      requests: [{ quote: 'enter without notice', clause_id: null, reasoning: 'x' }],
      extra: 1,
    };
    const { value, droppedKeys } = stripUnknownKeys(raw);
    expect(value).toEqual({
      fields: [{ field: 'landlord', quote: 'Sam Patel' }],
      requests: [{ quote: 'enter without notice', clause_id: null }],
    });
    expect(droppedKeys).toEqual(['extra', 'fields[0].confidence', 'requests[0].reasoning']);
  });

  it('never echoes long or non-ASCII key text', () => {
    const { droppedKeys } = stripUnknownKeys({ ['Rent is £1,200 a month and the landlord said so many things']: 1 });
    expect(droppedKeys).toHaveLength(1);
    expect(droppedKeys[0]).not.toContain('£');
    expect((droppedKeys[0] ?? '').length).toBeLessThanOrEqual(43);
  });

  it('passes non-objects through unchanged', () => {
    expect(stripUnknownKeys([1, 2])).toEqual({ value: [1, 2], droppedKeys: [] });
  });
});

describe('parseExtractorOutput', () => {
  it('accepts valid output, dropping unknown keys and invalid items', () => {
    const r = parseExtractorOutput({
      fields: [
        { field: 'monthly_rent', quote: '£1,200 a month', pointer: 'msg:m2:44-58', value: '£1,200' },
        { field: 'not_a_field', quote: 'x' },
        { field: 'pets' },
      ],
      requests: [{ quote: 'enter without notice', clause_id: null, score: 1 }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.fields).toHaveLength(1);
      expect(r.value.requests).toHaveLength(1);
      expect(r.droppedKeys).toEqual(['requests[0].score']);
      expect(r.droppedItems).toEqual(['fields[1]', 'fields[2]']);
    }
  });

  it('treats missing arrays as empty', () => {
    const r = parseExtractorOutput({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ fields: [], requests: [] });
  });

  it('fails on non-object output or non-array fields', () => {
    expect(parseExtractorOutput('text').ok).toBe(false);
    expect(parseExtractorOutput(null).ok).toBe(false);
    expect(parseExtractorOutput({ fields: 'x' }).ok).toBe(false);
  });
});
