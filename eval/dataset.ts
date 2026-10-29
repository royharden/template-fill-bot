import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { canonicalJson } from '../supabase/functions/_shared/fillkit/canonicalJson.ts';
import { sha256Hex } from '../supabase/functions/_shared/fillkit/hash.ts';
import type { GoldScenario } from '../supabase/functions/_shared/evalkit/types.ts';
import type { Manifest } from '../supabase/functions/_shared/evalkit/split.ts';
import { verifyManifest, manifestDigest } from '../supabase/functions/_shared/evalkit/split.ts';
import { parseGoldScenario } from '../supabase/functions/_shared/evalkit/schema.ts';

export async function readScenarios(directory: string): Promise<GoldScenario[]> {
  return Promise.all((await readdir(directory)).filter((name) => name.endsWith('.json')).sort().map(async (name) => {
    return parseGoldScenario(JSON.parse(await readFile(join(directory, name), 'utf8')));
  }));
}
export async function sourceHashes(root: string): Promise<Record<string, string>> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['gold', 'budget', 'node_modules'].includes(entry.name)) continue;
      const path = join(directory, entry.name); if (entry.isDirectory()) await visit(path);
      else if (/\.(?:ts|json|txt)$/.test(entry.name) && entry.name !== 'protocol.json') files.push(path);
    }
  }
  for (const folder of ['eval', 'supabase/functions/_shared', 'scripts']) await visit(join(root, folder));
  return Object.fromEntries(await Promise.all(files.sort().map(async (file) => [relative(root, file).replaceAll('\\', '/'), sha256Hex(await readFile(file))])));
}
export async function loadDataset(root: string): Promise<{ manifest: Manifest; scenarios: GoldScenario[] }> {
  const manifest = JSON.parse(await readFile(join(root, 'eval/gold/manifest.json'), 'utf8')) as Manifest;
  if (manifest.state === 'pending') throw new Error('gold_not_generated_or_frozen');
  const scenarios = [...await readScenarios(join(root, 'eval/gold/generated')), ...await readScenarios(join(root, 'eval/gold/handtraps'))];
  verifyManifest(manifest, scenarios, await sourceHashes(root)); return { manifest, scenarios };
}
export async function freezeDataset(root: string, protocol: unknown): Promise<Manifest> {
  const { manifest } = await loadDataset(root); if (manifest.state !== 'generated') throw new Error('gold_already_frozen');
  const { digest: _digest, ...body } = manifest;
  const frozen = { ...body, state: 'frozen' as const, protocol_hash: sha256Hex(canonicalJson(protocol)), frozen_at: new Date().toISOString() };
  return { ...frozen, digest: manifestDigest(frozen) };
}
/** Create ONCE before held-out work, including offline runs. A crash consumes the grant; no automatic reset. */
export async function claimHeldout(root: string, manifest: Manifest, protocol: unknown, runId: string): Promise<void> {
  if (manifest.state !== 'frozen' || !manifest.frozen_at || manifest.protocol_hash !== sha256Hex(canonicalJson(protocol))) throw new Error('heldout_requires_frozen_protocol');
  const directory = resolve(root, 'eval/budget'); await mkdir(directory, { recursive: true });
  const file = await open(join(directory, 'heldout-once.json'), 'wx').catch(() => { throw new Error('heldout_already_attempted_manual_audit_required'); });
  try { await file.writeFile(canonicalJson({ run_id: runId, manifest_digest: manifest.digest, at: new Date().toISOString(), status: 'claimed_before_work' })); await file.sync(); } finally { await file.close(); }
}
