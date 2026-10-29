// Explicit future activation only. Default is offline; merely having keys never selects live mode.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { loadDataset, claimHeldout } from '../eval/dataset.ts';
import { evaluate } from '../eval/run.ts';
import { ProtocolSchema } from '../eval/protocol.ts';
import { writeReport } from '../eval/report.ts';
import { adversarialRows } from '../eval/adversarial.ts';
import type { PriceTable } from '../supabase/functions/_shared/callledger/types.ts';

const args = process.argv.slice(2);
if (args.some((arg) => !['--live', '--offline', '--split=dev', '--split=heldout'].includes(arg)) || (args.includes('--live') && args.includes('--offline')) || (args.includes('--split=dev') && args.includes('--split=heldout'))) throw new Error('usage: npm run eval -- [--offline|--live] [--split=dev|--split=heldout]');
const root = resolve(import.meta.dirname, '..'), live = args.includes('--live'), split = args.includes('--split=heldout') ? 'heldout' : 'dev';
const protocol = ProtocolSchema.parse(JSON.parse(await readFile(join(root, 'eval/protocol.json'), 'utf8')));
const { scenarios, manifest } = await loadDataset(root), runId = randomUUID();
// No secret env is copied into a report. Prices require a deliberate current review; no paid defaults are fabricated.
const prices: PriceTable | undefined = live && process.env.EVAL_PRICE_TABLE_PATH ? JSON.parse(await readFile(process.env.EVAL_PRICE_TABLE_PATH, 'utf8')) as PriceTable : undefined;
if (live) process.stderr.write(`LIVE evaluation sends synthetic intake to configured ${protocol.llm_provider}/TypeSafe providers, under the persisted USD 2 cumulative cap.\n`);
if (split === 'heldout') await claimHeldout(root, manifest, protocol, runId);
const selected = scenarios.filter((scenario) => manifest.entries.find((e) => e.id === scenario.id)?.split === split);
const rows = await evaluate(selected, { root, live, split, protocol, manifest, prices, env: process.env });
rows.push(...await adversarialRows(root, split));
await writeReport(root, rows, { manifest, protocol, live, run_id: runId, at: new Date().toISOString(), split });
process.stdout.write(`Wrote results/results.md and results/results.jsonl; ${rows.filter((r) => r.status === 'incomplete').length} incomplete rows.\n`);
