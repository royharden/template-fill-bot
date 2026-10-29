// Shared assertions against authored demo expectations. These tests are source only until DV-TESTS.
import { expect } from 'vitest';
import { FIELD_KEYS } from '../../supabase/functions/_shared/content/types.ts';
import {
  buildDraft, deriveView, groundQuote, parseExtractorOutput,
} from '../../supabase/functions/_shared/fillkit/index.ts';
import type { MatterState, MatterView } from '../../supabase/functions/_shared/fillkit/index.ts';
import { TEST_LOCK, answerAll, extractScenario } from './m3Helpers.ts';
import type { DemoFixture, NotIncludedExpect } from './m3Helpers.ts';

export function notIncludedRows(view: MatterView): NotIncludedExpect[] {
  return view.requests.notIncluded.map(({ reason, clause_id, quote, pointer }) => ({ reason, clause_id, quote, pointer }));
}

/** Assert every field and every question, rather than just checking one happy-path amount. */
export function assertDemoView(state: MatterState, expected: DemoFixture['expected']['before_answers'] | DemoFixture['expected']['after_answers']): void {
  const view = deriveView(state);
  expect(view.revision).toBe(expected.revision);
  expect(Object.keys(view.fields)).toEqual(FIELD_KEYS);
  for (const key of FIELD_KEYS) {
    expect(view.fields[key].state, key).toBe(expected.field_states[key]);
    expect(view.fields[key].value, key).toEqual(expected.field_values[key]);
    if ('field_reasons' in expected && expected.field_reasons[key] !== undefined) {
      expect(view.fields[key].reasons, key).toEqual(expected.field_reasons[key]);
    }
    if ('field_methods' in expected) expect(view.fields[key].method, key).toBe(expected.field_methods[key]);
  }
  expect(view.questions.map((q) => q.id)).toEqual(expected.questions);
  expect(notIncludedRows(view)).toEqual(expected.not_included);
  if ('question_options' in expected) {
    for (const q of view.questions) expect(q.options.map((o) => o.value), q.id).toEqual(expected.question_options[q.id]);
    expect(view.questions.find((q) => q.kind === 'optional_terms')?.fields).toEqual(expected.optional_terms_fields);
    expect(view.requests.accepted.map((r) => r.clause_id)).toEqual(expected.accepted_clause_ids);
  }
}

export async function traceDemo(fixture: DemoFixture): Promise<MatterState> {
  const state = await extractScenario(fixture);
  assertDemoView(state, fixture.expected.before_answers);
  const blocked = buildDraft(state, { lock: TEST_LOCK });
  expect(blocked).toEqual({ ok: false, reasons: fixture.expected.before_answers.render_blocked_reasons });
  const resolved = answerAll(state, fixture.expected.answers);
  assertDemoView(resolved, fixture.expected.after_answers);
  const draft = buildDraft(resolved, { lock: TEST_LOCK, matterId: fixture.scenario_id });
  expect(draft.ok).toBe(true);
  if (!draft.ok) throw new Error(draft.reasons.join(','));
  expect(draft.clauses.map((c) => c.id)).toEqual(fixture.expected.after_answers.clause_ids);
  for (const text of fixture.expected.after_answers.markdown_contains) expect(draft.markdown).toContain(text);
  for (const text of fixture.expected.after_answers.markdown_excludes) expect(draft.markdown).not.toContain(text);
  expect(buildDraft(resolved)).toEqual({ ok: false, reasons: ['library_unlocked'] });
  return resolved;
}

/** Fixtures use literal UTF-16 pointers, including repeated money strings; verify each source pair. */
export function assertFixturePointers(fixture: DemoFixture): void {
  const parsed = parseExtractorOutput(fixture.mock_outputs.llm);
  if (!parsed.ok) throw new Error('fixture output schema');
  const intake = { messages: fixture.messages.map((m) => ({ id: m.id, text_normalised: m.text })) };
  for (const p of [...parsed.value.fields, ...parsed.value.requests]) {
    if (p.quote !== undefined) expect(groundQuote(intake, p.quote, p.pointer ?? null).ok, p.quote).toBe(true);
  }
}
