// M3 review regression: unresolved optional cues must survive extractor omission. Authored, not run (DV-TESTS).
import { describe, expect, it } from 'vitest';
import {
  OPTIONAL_TERMS_QUESTION_ID,
  OPTIONAL_TERMS_TEXT,
  applyAnswer,
  buildDraft,
  createMockExtractor,
  deriveView,
  groundQuote,
  regexExtractor,
  runExtraction,
} from '../../supabase/functions/_shared/fillkit/index.ts';
import { TEST_LOCK, answerAll, fixedClock, loadJson, ptr } from './m3Helpers.ts';
import type { DemoFixture } from './m3Helpers.ts';

const demo01 = loadJson<DemoFixture>('demo-01.json');

describe('unresolved optional cue pipeline', () => {
  // what_bug_this_catches: cue-only text had no role candidate; recognised optionless ambiguity also
  // disappeared when a model omitted guarantor. Both paths falsely claimed "No guarantor was mentioned".
  it.each([
    { method: 'regex', cue: 'guarantor for Joe only', quote: 'for Joe only', residual: 'for Joe only' },
    { method: 'mock', cue: 'guarantor for Joe only', quote: 'for Joe only', residual: 'for Joe only' },
    { method: 'mock', cue: 'Guarantor: Mary Major for Joe Bloggs only', quote: 'Mary Major for Joe Bloggs only', residual: 'for Joe Bloggs only' },
    { method: 'mock', cue: 'GUARANTOR FOR JOE ONLY', quote: 'FOR JOE ONLY', residual: 'FOR JOE ONLY' },
  ])('$method preserves $cue through explicit resolution', async ({ method, cue, quote, residual }) => {
    const fixture = {
      ...demo01,
      scenario_id: 'optional-cue-regression',
      messages: [...demo01.messages, { id: 'm5', text: `${cue}.` }],
    };
    // The unchanged demo model output deliberately contains no guarantor proposal.
    const extractor = method === 'regex' ? regexExtractor : createMockExtractor(fixture, fixture.scenario_id);
    const extracted = await runExtraction(fixture.messages, extractor);
    if (!extracted.ok) throw new Error('intake');
    const state = extracted.state;
    const view = deriveView(state);
    expect(view.fields.guarantor.state).toBe('ambiguous');
    expect(view.fields.guarantor.value).toBeUndefined();
    expect(view.fields.guarantor.reasons).toContain('partial_guarantee');
    expect(view.fields.guarantor.candidates).toEqual([]);
    expect(view.fields.guarantor.evidence).toEqual([{ quote, pointer: ptr(`${cue}.`, quote, 'm5') }]);
    expect(view.questions.find((q) => q.id === 'q.guarantor.v1')).toMatchObject({
      kind: 'field', fields: ['guarantor'], state: 'ambiguous', blocking: true,
    });
    const optional = view.questions.find((q) => q.id === OPTIONAL_TERMS_QUESTION_ID);
    expect(optional?.fields).toEqual(['break_month']);
    expect(optional?.text).toBe(OPTIONAL_TERMS_TEXT.break_month);
    const notIncluded = view.requests.notIncluded.find((r) => r.reason === 'guarantor_partial');
    expect(notIncluded).toMatchObject({
      quote: residual, pointer: ptr(`${cue}.`, residual, 'm5'), clause_id: null, confirmable: false,
    });
    if (notIncluded === undefined) throw new Error('missing partial-guarantee residual');
    expect(groundQuote({ messages: state.intake }, notIncluded.quote, notIncluded.pointer).ok).toBe(true);

    // Resolve the original demo questions and the absent break clause, leaving only the real cue question.
    const clock = fixedClock();
    const otherwiseResolved = answerAll(state, demo01.expected.answers.map((a) =>
      a.question_id === OPTIONAL_TERMS_QUESTION_ID
        ? { question_id: a.question_id, answer: { kind: 'optional_terms', break_month: null } }
        : a,
    ), clock);
    expect(deriveView(otherwiseResolved).questions.map((q) => q.id)).toEqual(['q.guarantor.v1']);
    expect(buildDraft(otherwiseResolved, { lock: TEST_LOCK })).toEqual({
      ok: false, reasons: ['field_ambiguous:guarantor', 'question_open:q.guarantor.v1'],
    });
    // The no-evidence confirmation cannot silently resolve a field excluded from that question.
    expect(applyAnswer(state, OPTIONAL_TERMS_QUESTION_ID, { kind: 'optional_terms', guarantor: null, break_month: null })).toEqual({
      ok: false, error: { code: 'invalid_answer', detail: 'guarantor:not_in_question' },
    });
    const resolved = applyAnswer(otherwiseResolved, 'q.guarantor.v1', { kind: 'none' }, { clock });
    if (!resolved.ok) throw new Error('guarantor answer');
    expect(resolved.state.fields.guarantor.state).toBe('none_confirmed');
    const draft = buildDraft(resolved.state, { lock: TEST_LOCK });
    expect(draft.ok).toBe(true);
    if (!draft.ok) throw new Error(draft.reasons.join(','));
    expect(draft.notIncluded.find((r) => r.reason === 'guarantor_partial')).toEqual(notIncluded);
    expect(draft.provenance.requests.not_included).toContainEqual({
      id: notIncluded.id, reason: 'guarantor_partial', clause_id: null,
      quote: residual, pointer: notIncluded.pointer,
    });
    expect(draft.markdown).not.toContain(residual);
  });

  // what_bug_this_catches: retaining cues must leave truly absent optional terms in the shared confirmation.
  it.each(['demo-01.json', 'demo-02.json'])('%s still coalesces genuinely absent optional fields', async (file) => {
    const fixture = loadJson<DemoFixture>(file);
    for (const extractor of [regexExtractor, createMockExtractor(fixture, fixture.scenario_id)]) {
      const extracted = await runExtraction(fixture.messages, extractor);
      if (!extracted.ok) throw new Error('intake');
      const view = deriveView(extracted.state);
      expect(view.questions.filter((q) => q.kind === 'optional_terms')).toHaveLength(1);
      expect(view.questions.find((q) => q.id === OPTIONAL_TERMS_QUESTION_ID)?.fields).toEqual(['guarantor', 'break_month']);
      expect(view.questions.some((q) => q.id === 'q.guarantor.v1')).toBe(false);
      const confirmed = applyAnswer(extracted.state, OPTIONAL_TERMS_QUESTION_ID, { kind: 'none' }, { clock: fixedClock() });
      if (!confirmed.ok) throw new Error('optional confirmation');
      expect(confirmed.state.fields.guarantor.state).toBe('none_confirmed');
      expect(confirmed.state.fields.break_month.state).toBe('none_confirmed');
      expect(deriveView(confirmed.state).questions.some((q) => q.kind === 'optional_terms')).toBe(false);
    }
  });
});
