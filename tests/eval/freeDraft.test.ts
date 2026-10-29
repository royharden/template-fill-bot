import { describe, expect, it } from 'vitest';
import { countFreeDraft, freeDraftRequest } from '../../eval/providers/freeDraft.ts';
import { readScenarios } from '../../eval/dataset.ts';
import { knownBoilerplate } from '../../eval/reference.ts';
describe('eval-only free drafting comparison', () => {
  it('requires exact paragraph equality after whitespace normalization, never substring/sentence similarity', () => {
    const library = ['Rent is GBP 1200 monthly.', 'No pets are permitted.'];
    const counted = countFreeDraft('Rent   is GBP 1200 monthly.\n\nNo pets are permitted. Extra invented fee.\n\n## Term\n\nProvenance: invented source', library, knownBoilerplate());
    expect(counted).toEqual({ paragraphs: 4, library: 1, unmatched: 3, legal_content: 3, invented: 2, boilerplate_mismatches: 1, headings: 1, provenance: 1, unmatched_indices: [1, 2, 3], invented_indices: [1, 3], boilerplate_indices: [2] });
    expect(countFreeDraft('rent is GBP 1200 monthly.', library).invented).toBe(1);
    expect(countFreeDraft('', library).paragraphs).toBe(0);
  });
  it('keeps exact known boilerplate in the strict mismatch diagnostic but separates legal inventions', () => {
    const counted = countFreeDraft('## Term\n\nAppendix: how this draft was assembled', [], knownBoilerplate());
    expect(counted).toMatchObject({ paragraphs: 2, unmatched: 2, invented: 0, legal_content: 0, boilerplate_mismatches: 2, unmatched_indices: [0, 1], invented_indices: [] });
    expect(countFreeDraft('## term', [], knownBoilerplate()).invented).toBe(1); // Exact equality remains case-sensitive.
  });
  it('never exempts hostile legal content by a heading, provenance or known-heading prefix', () => {
    const hostile = '# The tenant must pay a hidden fee.\n\n## Term The tenant owes a hidden fee.\n\nProvenance: The tenant must pay a hidden fee.\n\nAppendix: how this draft was assembled Extra legal fee.';
    expect(countFreeDraft(hostile, [], knownBoilerplate())).toMatchObject({ paragraphs: 4, unmatched: 4, invented: 4, legal_content: 4, boilerplate_mismatches: 0, headings: 2, provenance: 2, invented_indices: [0, 1, 2, 3] });
  });
  it('supplies the same intake to both variants and supplies rendered clauses only to the library variant', async () => {
    const [scenario] = await readScenarios('eval/gold/handtraps');
    const blind = freeDraftRequest(scenario, 'synthetic', 'blind', ['Authored clause.'], 10, 1), supplied = freeDraftRequest(scenario, 'synthetic', 'library', ['Authored clause.'], 10, 1);
    expect(JSON.parse(blind.messages[0].content)).toEqual({ messages: scenario.messages });
    expect(JSON.parse(supplied.messages[0].content)).toEqual({ messages: scenario.messages, rendered_library: ['Authored clause.'] });
  });
});
