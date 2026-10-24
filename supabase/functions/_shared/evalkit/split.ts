import { canonicalJson } from '../fillkit/canonicalJson.ts';
import { sha256Hex } from '../fillkit/hash.ts';
import { shuffled } from './random.ts';
import type { GoldScenario } from './types.ts';

export interface Base { readonly base_id: string; readonly stratum: string }
export function splitBases(bases: readonly Base[], seed: number): Record<string, 'dev' | 'heldout'> {
  const ids = new Set<string>(), strata = new Map<string, Base[]>();
  for (const base of bases) {
    if (ids.has(base.base_id)) throw new Error('duplicate_base'); ids.add(base.base_id);
    strata.set(base.stratum, [...(strata.get(base.stratum) ?? []), base]);
  }
  const split: Record<string, 'dev' | 'heldout'> = {};
  for (const [index, [, group]] of [...strata].sort(([a], [b]) => a.localeCompare(b)).entries()) {
    if (group.length % 2) throw new Error('stratum_requires_even_base_count');
    shuffled(group.sort((a, b) => a.base_id.localeCompare(b.base_id)), seed + index).forEach((base, i) => { split[base.base_id] = i < group.length / 2 ? 'dev' : 'heldout'; });
  }
  return split;
}
export interface Manifest {
  readonly version: 1; readonly state: 'pending' | 'generated' | 'frozen'; readonly seed: number;
  readonly generated_count: number; readonly handtrap_count: number;
  readonly entries: readonly { readonly id: string; readonly base_id: string; readonly split: 'dev' | 'heldout'; readonly sha256: string }[];
  readonly sources: Readonly<Record<string, string>>; readonly protocol_hash: string | null; readonly frozen_at: string | null;
  readonly digest: string;
}
export function manifestDigest(manifest: Omit<Manifest, 'digest'>): string { return sha256Hex(canonicalJson(manifest)); }
export function makeManifest(scenarios: readonly GoldScenario[], seed: number, split: Record<string, 'dev' | 'heldout'>, sources: Record<string, string>): Manifest {
  const ids = new Set<string>();
  const entries = [...scenarios].sort((a, b) => a.id.localeCompare(b.id)).map((scenario) => {
    if (ids.has(scenario.id) || !split[scenario.base_id]) throw new Error('invalid_scenario_membership'); ids.add(scenario.id);
    return { id: scenario.id, base_id: scenario.base_id, split: split[scenario.base_id], sha256: sha256Hex(canonicalJson(scenario)) };
  });
  const body: Omit<Manifest, 'digest'> = { version: 1, state: 'generated', seed,
    generated_count: scenarios.filter((s) => s.origin === 'generated').length, handtrap_count: scenarios.filter((s) => s.origin === 'handtrap').length,
    entries, sources, protocol_hash: null, frozen_at: null };
  return { ...body, digest: manifestDigest(body) };
}
export function verifyManifest(manifest: Manifest, scenarios: readonly GoldScenario[], sources: Record<string, string>): void {
  const { digest, ...body } = manifest;
  if (digest !== manifestDigest(body) || canonicalJson(sources) !== canonicalJson(manifest.sources) || manifest.state === 'pending') throw new Error('manifest_not_verified');
  const split = Object.fromEntries(manifest.entries.map((e) => [e.base_id, e.split]));
  const rebuilt = makeManifest(scenarios, manifest.seed, split, sources);
  if (canonicalJson(rebuilt.entries) !== canonicalJson(manifest.entries) || rebuilt.generated_count !== 40 || rebuilt.handtrap_count !== 20) throw new Error('manifest_scenario_mismatch');
  for (const base of new Set(manifest.entries.map((e) => e.base_id))) if (new Set(manifest.entries.filter((e) => e.base_id === base).map((e) => e.split)).size !== 1) throw new Error('cluster_leak');
  if (manifest.entries.filter((e) => e.split === 'dev').length !== 30 || manifest.entries.filter((e) => e.split === 'heldout').length !== 30) throw new Error('split_size');
}
