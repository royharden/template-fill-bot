import { describe, expect, it } from 'vitest';
import { applyAnswer, buildDraft } from '../../src/core/index.ts';
import { MemoryStore } from '../../src/store/MemoryStore.ts';
import { TEST_LOCK, answerAll, extractScenario, loadJson } from './m3Helpers.ts';
import type { DemoFixture } from './m3Helpers.ts';

const fixture = loadJson<DemoFixture>('demo-01.json');

describe('MemoryStore canonical revision snapshots (approval binding belongs to M4)', () => {
  it('creates, lists and deletes isolated in-memory matters with injectable ids and timestamps', async () => {
    let id = 0;
    const store = new MemoryStore({ idGen: () => `matter-${++id}`, clock: () => '2026-10-24T12:00:00.000Z' });
    const a = await store.createMatter({ title: 'Invented demo matter' });
    const b = await store.createMatter();
    expect(a).toEqual({ id: 'matter-1', title: 'Invented demo matter', created_at: '2026-10-24T12:00:00.000Z' });
    expect(b.title).toBe('Untitled matter');
    expect((await store.listMatters()).map((m) => m.id)).toEqual(['matter-1', 'matter-2']);
    await store.deleteMatter(a.id);
    expect(await store.getMatter(a.id)).toBeNull();
    expect(await store.getMatter(b.id)).toEqual(b);
    await expect(store.deleteMatter(a.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('stores insert-only revision copies and returns copies so old snapshots cannot be edited', async () => {
    const store = new MemoryStore({ idGen: () => 'm' });
    const matter = await store.createMatter();
    const state = await extractScenario(fixture);
    const saved = JSON.parse(JSON.stringify(state));
    await store.saveState(matter.id, saved);
    saved.intake[0].text_normalised = 'changed externally';
    const first = await store.getState(matter.id, 1);
    expect(first?.intake[0]?.text_normalised).toBe(fixture.messages[0]?.text);
    if (first === null) throw new Error('snapshot');
    const external = first as unknown as { intake: { text_normalised: string }[] };
    if (external.intake[0] !== undefined) external.intake[0].text_normalised = 'changed returned copy';
    expect((await store.getState(matter.id, 1))?.intake[0]?.text_normalised).toBe(fixture.messages[0]?.text);
    await expect(store.saveState(matter.id, state)).rejects.toMatchObject({ code: 'revision_exists' });
    const next = applyAnswer(state, 'q.monthly_rent.v1', { kind: 'text', text: '£1,200' });
    if (!next.ok) throw new Error('answer');
    await store.saveState(matter.id, next.state);
    expect(await store.listRevisions(matter.id)).toEqual([1, 2]);
    expect((await store.getState(matter.id))?.revision).toBe(2);
    expect((await store.getState(matter.id, 1))?.fields.monthly_rent.state).toBe('conflict');
    await expect(store.saveState('absent', state)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reconstructs the draft from persisted state without running the extractor again', async () => {
    const store = new MemoryStore({ idGen: () => 'm' });
    const matter = await store.createMatter();
    const state = answerAll(await extractScenario(fixture), fixture.expected.answers);
    await store.saveState(matter.id, state);
    const restored = await store.getState(matter.id, state.revision);
    if (restored === null) throw new Error('snapshot');
    const before = buildDraft(state, { lock: TEST_LOCK });
    const after = buildDraft(restored, { lock: TEST_LOCK });
    if (!before.ok || !after.ok) throw new Error('draft');
    expect(after.markdown).toBe(before.markdown);
    expect(after.provenanceBytes).toEqual(before.provenanceBytes);
  });
});
