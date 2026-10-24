import { describe, expect, it } from 'vitest';
import { applyAnswer, buildDraft, deriveView } from '../../supabase/functions/_shared/fillkit/index.ts';
import { TEST_LOCK, extractScenario, loadJson } from './m3Helpers.ts';
import type { DemoFixture } from './m3Helpers.ts';
import { assertFixturePointers, traceDemo } from './demoTrace.ts';

const fixture = loadJson<DemoFixture>('demo-01.json');

describe('demo-01: natural tenancy messages', () => {
  it('traces every expected state, four blocking questions, answers, clause order and Markdown', async () => {
    assertFixturePointers(fixture);
    const state = await traceDemo(fixture);
    expect(deriveView(state).fields.end_date.value).toBe('2028-02-29');
  });

  it('rent conflict defers the relative deposit question; rent answer resolves the deposit', async () => {
    const state = await extractScenario(fixture);
    const before = deriveView(state);
    expect(before.fields.monthly_rent.candidates.map((c) => c.value)).toEqual([120000, 125000]);
    expect(before.fields.deposit.reasons).toEqual(['pending_dependency']);
    expect(before.questions.some((q) => q.fields.includes('deposit'))).toBe(false);
    const result = applyAnswer(state, 'q.monthly_rent.v1', { kind: 'text', text: '£1,200' });
    if (!result.ok) throw new Error(result.error.code);
    expect(deriveView(result.state).fields.deposit.value).toBe(120000);
    expect(before.fields.deposit.value).toBeUndefined();
    expect(buildDraft(result.state, { lock: TEST_LOCK }).ok).toBe(false);
  });

  it('changing the answered rent produces a new draft revision and recalculates its dependent deposit', async () => {
    const state = await traceDemo(fixture);
    const oldDraft = buildDraft(state, { lock: TEST_LOCK });
    const result = applyAnswer(state, 'q.monthly_rent.v1', { kind: 'text', text: '£1,250' });
    if (!result.ok) throw new Error(result.error.code);
    const next = buildDraft(result.state, { lock: TEST_LOCK });
    if (!oldDraft.ok || !next.ok) throw new Error('resolved drafts expected');
    expect(next.revision).toBe(oldDraft.revision + 1);
    expect(next.contentHash).not.toBe(oldDraft.contentHash);
    expect(next.provenance.fields.deposit.value).toBe(125000);
    expect(oldDraft.provenance.fields.deposit.value).toBe(120000);
  });
});
