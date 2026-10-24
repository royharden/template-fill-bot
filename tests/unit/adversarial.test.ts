import { describe, expect, it } from 'vitest';
import type { FieldKey } from '../../supabase/functions/_shared/content/types.ts';
import { applyAnswer, buildDraft, deriveView } from '../../supabase/functions/_shared/fillkit/index.ts';
import type { MockFixture } from '../../supabase/functions/_shared/fillkit/index.ts';
import { TEST_LOCK, answerAll, extractScenario, loadJson } from './m3Helpers.ts';
import type { DemoFixture, NotIncludedExpect } from './m3Helpers.ts';
import { notIncludedRows } from './demoTrace.ts';

interface AdversarialFixture extends MockFixture {
  readonly messages: { id: string; text: string }[];
  readonly expected: {
    readonly fields?: Partial<Record<FieldKey, { state: string; value?: unknown; reasons?: string[]; option_values?: unknown[] }>>;
    readonly not_included?: NotIncludedExpect[];
    readonly accepted?: unknown[];
    readonly dropped_keys?: string[];
    readonly request_drops?: unknown[];
    readonly rejected_proposals?: unknown[];
    readonly text_never_present?: string[];
    readonly values_never_present?: unknown[];
    readonly address_answer?: { question_id: string; answer: unknown };
  };
}

describe('adversarial extractor fixtures', () => {
  for (const name of ['quote-absent', 'unknown-clause-id', 'value-not-quote', 'extra-keys', 'clause-text-in-requests', 'smuggled-address']) {
    it(`${name}: untrusted model output cannot supply agreement text`, async () => {
      const f = loadJson<AdversarialFixture>(`adversarial/${name}.json`);
      const state = await extractScenario(f);
      const view = deriveView(state);
      for (const [key, expected] of Object.entries(f.expected.fields ?? {})) {
        const field = view.fields[key as FieldKey];
        expect(field.state, key).toBe(expected.state);
        if ('value' in expected) expect(field.value, key).toEqual(expected.value);
        if (expected.reasons !== undefined) expect(field.reasons, key).toEqual(expected.reasons);
        if (expected.option_values !== undefined) expect(field.candidates.map((c) => c.value)).toEqual(expected.option_values);
      }
      if (f.expected.not_included !== undefined) expect(notIncludedRows(view)).toEqual(f.expected.not_included);
      if (f.expected.accepted !== undefined) expect(view.requests.accepted).toEqual(f.expected.accepted);
      if (f.expected.dropped_keys !== undefined) expect(state.diagnostics.dropped_keys).toEqual(f.expected.dropped_keys);
      if (f.expected.request_drops !== undefined) expect(state.diagnostics.request_drops).toEqual(f.expected.request_drops);
      if (f.expected.rejected_proposals !== undefined) expect(state.diagnostics.rejected_proposals).toEqual(f.expected.rejected_proposals);
      for (const text of f.expected.text_never_present ?? []) expect(JSON.stringify(state)).not.toContain(text);
      for (const value of f.expected.values_never_present ?? []) {
        expect(view.fields.monthly_rent.value).not.toBe(value);
        expect(view.fields.monthly_rent.candidates.some((c) => c.value === value)).toBe(false);
      }
      expect(buildDraft(state, { lock: TEST_LOCK }).ok).toBe(false);
    });
  }

  it('a smuggled address becomes renderable only after a validated answer; the clause sentence is absent', async () => {
    const f = loadJson<AdversarialFixture>('adversarial/smuggled-address.json');
    const source = loadJson<DemoFixture>('demo-01.json');
    const answer = f.expected.address_answer;
    if (answer === undefined) throw new Error('fixture missing address answer');
    const result = applyAnswer(await extractScenario(f), answer.question_id, answer.answer);
    if (!result.ok) throw new Error(result.error.code);
    const state = answerAll(result.state, source.expected.answers);
    const draft = buildDraft(state, { lock: TEST_LOCK });
    if (!draft.ok) throw new Error(draft.reasons.join(','));
    expect(draft.provenance.fields.address.value).toBe('14 Elm Road, Flat 2, Oxtown');
    for (const text of f.expected.text_never_present ?? []) expect(draft.markdown).not.toContain(text);
  });
});
