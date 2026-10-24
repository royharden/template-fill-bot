// Do not execute in Dirty Mode. Explicit later commands: --generate, then --freeze after dev tuning.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { generateGold, GOLD_SEED } from '../eval/generator.ts';
import { freezeDataset, readScenarios, sourceHashes } from '../eval/dataset.ts';
import { makeManifest } from '../supabase/functions/_shared/evalkit/split.ts';

const root = resolve(import.meta.dirname, '..');
const mode = process.argv.slice(2);
if (mode.length !== 1 || !['--generate', '--freeze'].includes(mode[0])) throw new Error('usage: npm run gen-gold -- --generate | --freeze');
const path = join(root, 'eval/gold/manifest.json');
if (mode[0] === '--generate') {
  const previous = JSON.parse(await readFile(path, 'utf8')) as { state: string };
  if (previous.state !== 'pending') throw new Error('dataset_already_generated_no_overwrite');
  const { scenarios, split } = generateGold(await readScenarios(join(root, 'eval/gold/handtraps')), GOLD_SEED);
  const directory = join(root, 'eval/gold/generated'); await mkdir(directory, { recursive: true });
  for (const scenario of scenarios.filter((s) => s.origin === 'generated')) await writeFile(join(directory, `${scenario.id}.json`), JSON.stringify(scenario, null, 2) + '\n', { flag: 'wx' });
  const manifest = makeManifest(scenarios, GOLD_SEED, split, await sourceHashes(root));
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
} else {
  const protocol: unknown = JSON.parse(await readFile(join(root, 'eval/protocol.json'), 'utf8'));
  await writeFile(path, JSON.stringify(await freezeDataset(root, protocol), null, 2) + '\n');
}
