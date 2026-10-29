import { describe, expect, it } from 'vitest';
import { applyAnswer, approveBundle, buildBundle, createMockExtractor, deriveView } from '../../src/core/index.ts';
import type { BundleApproval, MatterState } from '../../src/core/index.ts';
import { MemoryStore } from '../../src/store/MemoryStore.ts';
import { exportMatterJson, importMatterJson, validateMatterState } from '../../src/store/jsonImportExport.ts';
import { answeredQuestions, canDownload, extractMatter, fieldEvidence, highlightParts } from '../../src/ui/reviewModel.ts';
import { TEST_LOCK, answerAll, loadJson } from './m3Helpers.ts';
import type { DemoFixture } from './m3Helpers.ts';

describe('M5 review state and source highlighting (authored, not run)', () => {
  it('uses exact UTF-16 pointer offsets for repeated text, merges overlap and retains safe text nodes', () => {
    const message = { id: 'm1', text_normalised: '😀 same same <script>' };
    const parts = highlightParts(message, [
      { quote: 'same', pointer: 'msg:m1:8-12' },
      { quote: 'same <script>', pointer: 'msg:m1:8-21' },
      { quote: 'same', pointer: 'msg:m1:3-7' },
      { quote: 'WRONG', pointer: 'msg:m1:0-2' },
      { quote: '\ude00', pointer: 'msg:m1:1-2' },
    ]);
    expect(parts.map((part) => part.text).join('')).toBe(message.text_normalised);
    expect(parts.filter((part) => part.highlighted).map((part) => part.text)).toEqual(['same', 'same <script>']);
  });

  for (const name of ['demo-01.json', 'demo-02.json']) {
    it(`${name}: extraction + every answer saves immutable snapshots, past answers remain editable`, async () => {
      const f = loadJson<DemoFixture>(name);
      const store = new MemoryStore();
      const first = await extractMatter(store, f.messages, createMockExtractor(f, f.scenario_id));
      expect(deriveView(first.state).questions.map((q) => q.id)).toEqual(f.expected.before_answers.questions);
      expect(fieldEvidence(first.state.fields.monthly_rent).length).toBeGreaterThan(1);
      let state = first.state;
      for (const entry of f.expected.answers) {
        const next = applyAnswer(state, entry.question_id, entry.answer);
        if (!next.ok) throw new Error(next.error.code);
        state = next.state;
        await store.saveState(first.matterId, state);
      }
      expect(deriveView(state).questions).toHaveLength(0);
      expect(answeredQuestions(state).map((q) => q.id)).toEqual(f.expected.answers.map((a) => a.question_id));
      const changed = applyAnswer(state, 'q.monthly_rent.v1', { kind: 'text', text: 'GBP 1250' });
      if (!changed.ok) throw new Error(changed.error.code);
      await store.saveState(first.matterId, changed.state);
      expect((await store.getState(first.matterId, 1))?.answers).toHaveLength(0);
      expect((await store.getState(first.matterId))?.revision).toBe(state.revision + 1);
    });
  }

  it('retains the matter on edited intake/re-extraction, advances revision and round-trips JSON with gaps', async () => {
    const f = loadJson<DemoFixture>('demo-01.json');
    const store = new MemoryStore();
    const first = await extractMatter(store, f.messages, createMockExtractor(f, f.scenario_id));
    const answered = answerAll(first.state, f.expected.answers);
    await store.saveState(first.matterId, answered);
    const next = await extractMatter(store, f.messages, createMockExtractor(f, f.scenario_id), first.matterId);
    expect(next.matterId).toBe(first.matterId);
    expect(next.state.revision).toBe(answered.revision + 1);
    expect(next.state.answers).toEqual([]);
    expect(importMatterJson(exportMatterJson(next.state))).toEqual(next.state);
    const updated = applyAnswer(next.state, 'q.monthly_rent.v1', { kind: 'text', text: 'GBP 1200' });
    if (!updated.ok) throw new Error(updated.error.code);
    expect(importMatterJson(exportMatterJson(updated.state))).toEqual(updated.state);
    expect((await store.getState(first.matterId, answered.revision))?.answers).toEqual(answered.answers);
  });

  it('still rejects event revisions outside the head, duplicate events, and reversed logs', async () => {
    const f = loadJson<DemoFixture>('demo-01.json');
    const store = new MemoryStore();
    const extracted = await extractMatter(store, f.messages, createMockExtractor(f, f.scenario_id));
    const state = answerAll(extracted.state, f.expected.answers);
    const mutate = (answers: MatterState['answers']): MatterState => ({ ...state, answers });
    // Field-answer consistency is unchanged; revision-only mutations reach the lineage guard.
    expect(() => validateMatterState(mutate(state.answers.map((a, i) => i ? a : { ...a, revision: state.revision + 1 })))).toThrow('matter_revision_lineage');
    expect(() => validateMatterState(mutate(state.answers.map((a) => ({ ...a, revision: 2 }))))).toThrow('matter_revision_lineage');
    expect(() => validateMatterState(mutate([...state.answers].reverse()))).toThrow('matter_answer_order');
  });

  it('enables downloads only for the current clean revision and exact approved digest/library/matter', async () => {
    const f = loadJson<DemoFixture>('demo-01.json'); const store = new MemoryStore();
    const extracted = await extractMatter(store, f.messages, createMockExtractor(f, f.scenario_id));
    const state = answerAll(extracted.state, f.expected.answers); await store.saveState(extracted.matterId, state);
    const result = buildBundle(state, { matterId: extracted.matterId, lock: TEST_LOCK });
    if (!result.ok) throw new Error(result.reasons.join(','));
    const approval = await approveBundle(store, extracted.matterId, result.bundle, 'Demo reviewer', { lock: TEST_LOCK });
    expect(canDownload(result.bundle, approval, extracted.matterId, state, false)).toBe(true);
    expect(canDownload(result.bundle, approval, extracted.matterId, state, true)).toBe(false);
    expect(canDownload(result.bundle, approval, extracted.matterId, { ...state, revision: state.revision + 1 }, false)).toBe(false);
    for (const changed of [{ ...approval, bundle_digest: '0'.repeat(64) }, { ...approval, library_hash: '0'.repeat(64) }, { ...approval, matter_id: 'other' }] satisfies BundleApproval[]) expect(canDownload(result.bundle, changed, extracted.matterId, state, false)).toBe(false);
    expect(canDownload(null, approval, extracted.matterId, state, false)).toBe(false);
    expect(canDownload({ ...result.bundle, gate: { ok: false, failures: [] } }, approval, extracted.matterId, state, false)).toBe(false);
  });
});
