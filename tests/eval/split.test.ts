// Authored in Dirty Mode; never run here. Gold labels are inspected, not derived from an extractor.
import { describe, expect, it } from 'vitest';
import { readScenarios } from '../../eval/dataset.ts';
import { generateGold } from '../../eval/generator.ts';
import { makeManifest, splitBases, verifyManifest } from '../../supabase/functions/_shared/evalkit/split.ts';
import { parseGoldScenario } from '../../supabase/functions/_shared/evalkit/schema.ts';

describe('gold independence, stratification and freeze source contracts', () => {
  it('keeps all40 generated variants paired, all20 hand traps, and exactly30 per split', async () => {
    const traps = await readScenarios('eval/gold/handtraps');
    const { scenarios, split } = generateGold(traps, 3007);
    expect(scenarios).toHaveLength(60); expect(new Set(scenarios.map((s) => s.id)).size).toBe(60);
    for (const scenario of scenarios) expect(() => parseGoldScenario(scenario)).not.toThrow();
    for (const base of new Set(scenarios.map((s) => s.base_id))) expect(new Set(scenarios.filter((s) => s.base_id === base).map((s) => split[s.base_id])).size).toBe(1);
    expect(scenarios.filter((s) => split[s.base_id] === 'dev')).toHaveLength(30);
    expect(scenarios.filter((s) => split[s.base_id] === 'heldout')).toHaveLength(30);
    expect(generateGold(traps, 3007)).toEqual({ scenarios, split });
    for (const stratum of ['ordinary', 'higher_rent']) expect(scenarios.filter((s) => s.stratum === stratum && split[s.base_id] === 'dev')).toHaveLength(10);
    expect(traps.filter((s) => split[s.base_id] === 'dev')).toHaveLength(10);
  });
  it('rejects a reused base id or an unbalanced stratum before variant expansion', () => {
    expect(() => splitBases([{ base_id: 'a', stratum: 'x' }, { base_id: 'a', stratum: 'x' }], 1)).toThrow('duplicate_base');
    expect(() => splitBases([{ base_id: 'a', stratum: 'x' }], 1)).toThrow('stratum_requires_even_base_count');
  });
  it('pins source, labels and membership; a manually altered label cannot pass the frozen digest', async () => {
    const { scenarios, split } = generateGold(await readScenarios('eval/gold/handtraps'));
    const sources = { 'eval/generator.ts': 'a'.repeat(64) }, manifest = makeManifest(scenarios, 3007, split, sources);
    expect(() => verifyManifest(manifest, scenarios, sources)).not.toThrow();
    const changed = structuredClone(scenarios); changed[0] = { ...changed[0], expected: { ...changed[0].expected, unsupported_quotes: ['Newly altered label.'] } };
    expect(() => verifyManifest(manifest, changed, sources)).toThrow('manifest_scenario_mismatch');
    expect(() => verifyManifest(manifest, scenarios, { 'eval/generator.ts': 'b'.repeat(64) })).toThrow('manifest_not_verified');
  });
});
