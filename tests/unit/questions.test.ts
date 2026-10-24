// M3: questions and answers (PLAN sections 4.5, K2). Written in Dirty Mode; not yet run (DV-TESTS).
import { describe, expect, it } from 'vitest';
import {
  LIBRARY_CONTENT,
  OPTIONAL_TERMS_QUESTION_ID,
  OPTIONAL_TERMS_TEXT,
  applyAnswer,
  buildQuestions,
  createMockExtractor,
  deriveView,
  renderBlockers,
  runExtraction,
  validateFields,
} from '../../supabase/functions/_shared/fillkit/index.ts';
import type { MatterState } from '../../supabase/functions/_shared/fillkit/index.ts';
import { TEST_LOCK, completeRecords, extractScenario, fixedClock, loadJson, records } from './m3Helpers.ts';
import type { DemoFixture } from './m3Helpers.ts';

const demo01 = loadJson<DemoFixture>('demo-01.json');

async function demo01State(): Promise<MatterState> {
  return extractScenario(demo01);
}

describe('question set', () => {
  it('one fixed-template question per non-valid field; pending dependencies are not asked', async () => {
    const view = deriveView(await demo01State());
    expect(view.questions.map((q) => q.id)).toEqual(['q.monthly_rent.v1', 'q.pets.v1', 'q.utilities.v1', OPTIONAL_TERMS_QUESTION_ID]);
    expect(view.questions.some((q) => q.fields.includes('deposit'))).toBe(false);
    for (const q of view.questions) {
      expect(q.blocking).toBe(true);
      expect(q.manual_entry).toBe(true);
    }
  });

  it('rent options are the code-rendered grounded candidates', async () => {
    const q = deriveView(await demo01State()).questions.find((x) => x.id === 'q.monthly_rent.v1');
    expect(q?.options.map((o) => [o.id, o.label, o.value])).toEqual([
      ['o1', '£1,200.00', 120000],
      ['o2', '£1,250.00', 125000],
    ]);
  });

  it('ambiguous pets offers exactly none / with_consent', async () => {
    const q = deriveView(await demo01State()).questions.find((x) => x.id === 'q.pets.v1');
    expect(q?.options.map((o) => o.value)).toEqual(['none', 'with_consent']);
  });

  it('utilities completion asks the full tenant-pays set, with completing suggestions', async () => {
    const q = deriveView(await demo01State()).questions.find((x) => x.id === 'q.utilities.v1');
    expect(q?.text).toContain('Which of water, electricity, gas and internet does the tenant pay?');
    expect(q?.options.map((o) => o.value)).toEqual([
      ['electricity', 'gas'],
      ['water', 'electricity', 'gas', 'internet'],
    ]);
    expect(q?.options[0]?.label).toBe('Tenant pays electricity and gas; water and internet included in rent');
  });

  it('K2: optional fields with no evidence are coalesced into one confirmation question', async () => {
    const q = deriveView(await demo01State()).questions.find((x) => x.id === OPTIONAL_TERMS_QUESTION_ID);
    expect(q?.kind).toBe('optional_terms');
    expect(q?.fields).toEqual(['guarantor', 'break_month']);
    expect(q?.text).toBe(OPTIONAL_TERMS_TEXT.both);
    expect(q?.options.map((o) => [o.id, o.value])).toEqual([['none', null]]);
  });

  it('an optional field WITH evidence gets its own question; the confirmation covers only the other', () => {
    const eff = validateFields(
      records({
        guarantor: { field: 'guarantor', state: 'ambiguous', candidates: [], reasons: ['partial_guarantee'] },
      }),
    );
    const qs = buildQuestions(eff);
    const g = qs.find((q) => q.id === 'q.guarantor.v1');
    expect(g?.options.map((o) => o.id)).toEqual(['none']);
    const opt = qs.find((q) => q.id === OPTIONAL_TERMS_QUESTION_ID);
    expect(opt?.fields).toEqual(['break_month']);
    expect(opt?.text).toBe(OPTIONAL_TERMS_TEXT.break_month);
  });

  it('every open question blocks render', async () => {
    const state = await demo01State();
    const view = deriveView(state);
    const reasons = renderBlockers({
      content: LIBRARY_CONTENT,
      lock: TEST_LOCK,
      fields: view.fields,
      questions: view.questions,
      acceptedClauseIds: [],
      notIncludedCount: 0,
    });
    for (const q of view.questions) expect(reasons).toContain(`question_open:${q.id}`);
  });

  it('an open question alone blocks render even when every field is resolved', () => {
    const eff = validateFields(completeRecords());
    expect(buildQuestions(eff)).toEqual([]);
    const open = buildQuestions(validateFields(records()))[0];
    if (open === undefined) throw new Error('expected a question');
    const reasons = renderBlockers({
      content: LIBRARY_CONTENT,
      lock: TEST_LOCK,
      fields: eff,
      questions: [open],
      acceptedClauseIds: [],
      notIncludedCount: 0,
    });
    expect(reasons).toEqual([`question_open:${open.id}`]);
  });
});

describe('applyAnswer', () => {
  it('stores user_answer with question id, answer, injected timestamp; revision + 1; model not re-called', async () => {
    let calls = 0;
    const base = createMockExtractor(demo01, 'demo-01');
    const counting = {
      method: base.method,
      extract: (...args: Parameters<typeof base.extract>) => {
        calls += 1;
        return base.extract(...args);
      },
    };
    const r0 = await runExtraction(demo01.messages, counting);
    if (!r0.ok) throw new Error('intake');
    const r = applyAnswer(r0.state, 'q.monthly_rent.v1', { kind: 'text', text: '£1,200' }, { clock: () => '2026-10-24T12:00:00.000Z' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls).toBe(1);
    expect(r.state.revision).toBe(2);
    const rent = r.state.fields.monthly_rent;
    expect(rent.state).toBe('valid');
    expect(rent.value).toBe(120000);
    expect(rent.method).toBe('user_answer');
    expect(rent.answer).toEqual({
      question_id: 'q.monthly_rent.v1',
      answer: { kind: 'text', text: '£1,200' },
      answered_at: '2026-10-24T12:00:00.000Z',
    });
    expect(r.state.answers).toHaveLength(1);
    // dependents are revalidated: the relative deposit now resolves
    const view = deriveView(r.state);
    expect(view.fields.deposit.state).toBe('valid');
    expect(view.fields.deposit.value).toBe(120000);
    // the input state is untouched
    expect(r0.state.revision).toBe(1);
    expect(r0.state.fields.monthly_rent.state).toBe('conflict');
  });

  it('answers pass the same parser/validator; a bad answer is rejected without echoing it', async () => {
    const state = await demo01State();
    const bad = applyAnswer(state, 'q.monthly_rent.v1', { kind: 'text', text: '£300 a week' });
    expect(bad).toEqual({ ok: false, error: { code: 'invalid_answer', detail: 'monthly_rent:weekly_rent_unsupported' } });
    const junk = applyAnswer(state, 'q.monthly_rent.v1', { kind: 'text', text: 'lots of money' });
    expect(junk.ok).toBe(false);
    if (!junk.ok) expect(junk.error.detail).not.toContain('lots');
  });

  it('options are resolved through the validator; unknown options are rejected', async () => {
    const state = await demo01State();
    expect(applyAnswer(state, 'q.pets.v1', { kind: 'option', option_id: 'o9' })).toEqual({
      ok: false,
      error: { code: 'unknown_option', detail: 'pets' },
    });
    const r = applyAnswer(state, 'q.pets.v1', { kind: 'option', option_id: 'o2' }, { clock: fixedClock() });
    expect(r.ok && r.state.fields.pets.value).toBe('with_consent');
  });

  it('a question that is not open cannot be answered; malformed answers are rejected', async () => {
    const state = await demo01State();
    expect(applyAnswer(state, 'q.smoking.v1', { kind: 'option', option_id: 'o1' })).toEqual({
      ok: false,
      error: { code: 'question_not_open', detail: 'question' },
    });
    expect(applyAnswer(state, 'q.pets.v1', { kind: 'option', option_id: 'o1', extra: true })).toEqual({
      ok: false,
      error: { code: 'malformed_answer', detail: 'answer_schema' },
    });
    expect(applyAnswer(state, 'q.pets.v1', { kind: 'none' })).toEqual({
      ok: false,
      error: { code: 'answer_kind_mismatch', detail: 'pets' },
    });
  });

  it('optional terms: confirm none, or give values (each passes its validator)', async () => {
    const state = await demo01State();
    const none = applyAnswer(state, OPTIONAL_TERMS_QUESTION_ID, { kind: 'none' }, { clock: fixedClock() });
    expect(none.ok && none.state.fields.guarantor.state).toBe('none_confirmed');
    expect(none.ok && none.state.fields.break_month.method).toBe('none_confirmed');

    const mixed = applyAnswer(
      state,
      OPTIONAL_TERMS_QUESTION_ID,
      { kind: 'optional_terms', guarantor: 'Mary Major', break_month: null },
      { clock: fixedClock() },
    );
    expect(mixed.ok && mixed.state.fields.guarantor.value).toBe('Mary Major');
    expect(mixed.ok && mixed.state.fields.guarantor.method).toBe('user_answer');
    expect(mixed.ok && mixed.state.fields.break_month.state).toBe('none_confirmed');

    const partial = applyAnswer(state, OPTIONAL_TERMS_QUESTION_ID, { kind: 'optional_terms', guarantor: null });
    expect(partial).toEqual({ ok: false, error: { code: 'invalid_answer', detail: 'break_month:missing' } });

    const badName = applyAnswer(state, OPTIONAL_TERMS_QUESTION_ID, { kind: 'optional_terms', guarantor: 'Dr. Who', break_month: null });
    expect(badName).toEqual({ ok: false, error: { code: 'invalid_answer', detail: 'guarantor:forbidden_punctuation' } });
  });

  it('a guarantor answer equal to a party fails the cross-field rule and reopens the question', async () => {
    const state = await demo01State();
    const r = applyAnswer(state, OPTIONAL_TERMS_QUESTION_ID, { kind: 'optional_terms', guarantor: 'Joe Bloggs', break_month: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const view = deriveView(r.state);
    expect(view.fields.guarantor.state).toBe('invalid');
    expect(view.questions.map((q) => q.id)).toContain('q.guarantor.v1');
  });

  it('a previously answered question can be answered again (revision increments)', async () => {
    const clock = fixedClock();
    const s1 = applyAnswer(await demo01State(), 'q.monthly_rent.v1', { kind: 'option', option_id: 'o1' }, { clock });
    if (!s1.ok) throw new Error('answer 1');
    const s2 = applyAnswer(s1.state, 'q.monthly_rent.v1', { kind: 'text', text: '£1,250' }, { clock });
    expect(s2.ok).toBe(true);
    if (!s2.ok) return;
    expect(s2.state.revision).toBe(3);
    expect(s2.state.fields.monthly_rent.value).toBe(125000);
    expect(deriveView(s2.state).fields.deposit.value).toBe(125000);
    expect(s2.state.answers.map((a) => a.revision)).toEqual([2, 3]);
  });
});
