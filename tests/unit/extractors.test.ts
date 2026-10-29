import { describe, expect, it } from 'vitest';
import {
  FIELD_SPEC_LIST, createMockExtractor, deriveView, findAllCandidates, parseExtractorOutput,
  regexExtractor, runExtraction,
} from '../../supabase/functions/_shared/fillkit/index.ts';
import type { Extractor } from '../../supabase/functions/_shared/fillkit/index.ts';
import { intakeOf, loadJson } from './m3Helpers.ts';
import type { DemoFixture } from './m3Helpers.ts';

const fixture = loadJson<DemoFixture>('demo-01.json');

describe('regex and mock extractors', () => {
  it('the role-aware regex baseline goes through the same grounding and conflict detection as mock', async () => {
    const result = await runExtraction(fixture.messages, regexExtractor);
    if (!result.ok) throw new Error('intake');
    const view = deriveView(result.state);
    expect(view.fields.landlord.value).toBe('Sam Patel');
    expect(view.fields.address.value).toBe('14 Elm Road, Flat 2, Oxtown');
    expect(view.fields.tenants.value).toEqual(['Priya Shah', 'Joe Bloggs']);
    expect(view.fields.monthly_rent.state).toBe('conflict');
    expect(view.fields.pets.state).toBe('ambiguous');
    expect(view.fields.deposit.reasons).toEqual(['pending_dependency']);
    expect(view.fields.landlord.method).toBe('regex');
    expect(view.questions.map((q) => q.id)).toEqual(fixture.expected.before_answers.questions);
  });

  it('mock replay returns independent raw copies and identifies missing scenario/method without network', async () => {
    const intake = intakeOf('No smoking.');
    const candidates = findAllCandidates(intake);
    const mock = createMockExtractor(fixture, fixture.scenario_id);
    const a = await mock.extract(intake, FIELD_SPEC_LIST, candidates);
    const parsed = parseExtractorOutput(a);
    if (!parsed.ok) throw new Error('schema');
    (a as { fields: unknown[] }).fields.splice(0);
    expect(await mock.extract(intake, FIELD_SPEC_LIST, candidates)).toEqual(fixture.mock_outputs.llm);
    await expect(createMockExtractor(fixture, 'absent').extract(intake, FIELD_SPEC_LIST, candidates)).rejects.toMatchObject({ code: 'scenario_not_found' });
    await expect(createMockExtractor(fixture, fixture.scenario_id, 'jev').extract(intake, FIELD_SPEC_LIST, candidates)).rejects.toMatchObject({ code: 'method_not_found' });
  });

  it('extraction failure becomes missing fields and a code-only diagnostic without retaining provider error text', async () => {
    const fail: Extractor = { method: 'llm', extract: () => Promise.reject(new Error('secret intake in provider error')) };
    const result = await runExtraction(fixture.messages, fail);
    if (!result.ok) throw new Error('intake');
    expect(result.state.diagnostics.extractor_error).toBe('extract_failed');
    expect(result.state.fields.landlord.state).toBe('missing');
    expect(JSON.stringify(result.state.diagnostics)).not.toContain('secret intake');
  });

  it('top-level schema failure fails closed; individual malformed proposals are dropped', async () => {
    const malformed: Extractor = { method: 'llm', extract: () => Promise.resolve({ fields: 'wrong', requests: [] }) };
    const result = await runExtraction(fixture.messages, malformed);
    if (!result.ok) throw new Error('intake');
    expect(result.state.diagnostics.extractor_error).toBe('output_schema');
    expect(result.state.fields.landlord.state).toBe('missing');
    const parsed = parseExtractorOutput({ fields: [{ field: 'unknown', quote: 'No smoking' }, { field: 'smoking', quote: 'No smoking' }], requests: [] });
    if (!parsed.ok) throw new Error('schema');
    expect(parsed.droppedItems).toEqual(['fields[0]']);
    expect(parsed.value.fields).toHaveLength(1);
  });

  it('intake limits reject before the extractor is called', async () => {
    let calls = 0;
    const counting: Extractor = { method: 'mock', extract: () => { calls += 1; return Promise.resolve({ fields: [], requests: [] }); } };
    const result = await runExtraction(Array.from({ length: 13 }, () => ({ text: 'No smoking.' })), counting);
    expect(result.ok).toBe(false);
    expect(calls).toBe(0);
  });
});
