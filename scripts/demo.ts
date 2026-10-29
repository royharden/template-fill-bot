// Source-only keyless demonstration. Do not execute while Dirty Mode is active.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  AGREEMENT_FILES, ApprovalError, applyAnswer, approveBundle, approvedDownload,
  buildBundle, createMockExtractor, deriveView, runExtraction,
} from '../src/core/index.ts';
import type { BundleFilename, IntakeMessageInput, MockFixture } from '../src/core/index.ts';
import { MemoryStore } from '../src/store/MemoryStore.ts';

interface DemoFixture extends MockFixture {
  readonly messages: readonly IntakeMessageInput[];
  readonly expected: { readonly answers: readonly { readonly question_id: string; readonly answer: unknown }[] };
}
const clock = (): string => '2026-10-24T12:00:00Z';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !['--scenario=demo-01', '--scenario=demo-02'].includes(args[0]!))) {
    throw new Error('demo_usage');
  }
  const scenario = args[0]?.slice('--scenario='.length) ?? 'demo-01';
  const fixture = JSON.parse(await readFile(resolve(import.meta.dirname, '../fixtures', scenario + '.json'), 'utf8')) as DemoFixture;
  const store = new MemoryStore({ idGen: () => scenario + '-local', clock });
  const matter = await store.createMatter({ title: 'Synthetic keyless demonstration' });
  const extracted = await runExtraction(fixture.messages, createMockExtractor(fixture, scenario));
  if (!extracted.ok) throw new Error('demo_intake_failed');
  let state = extracted.state;
  await store.saveState(matter.id, state);
  for (const item of fixture.expected.answers) {
    const answered = applyAnswer(state, item.question_id, item.answer, { clock });
    if (!answered.ok) throw new Error('demo_answer_failed');
    state = answered.state;
    await store.saveState(matter.id, state);
  }
  if (deriveView(state).questions.length !== 0) throw new Error('demo_questions_remain');
  // Uses the committed lock only. No computeLock/substitute lock is available to this demo.
  const built = buildBundle(state, { matterId: matter.id });
  if (!built.ok) {
    process.stdout.write(JSON.stringify({
      mode: 'mock demonstration, not a measurement', status: 'blocked', reasons: built.reasons,
      next: 'After authorized activation generate/review the content lock; see docs/DEFERRED-VALIDATION.md',
    }, null, 2) + '\n');
    process.exitCode = 2;
    return;
  }
  await approveBundle(store, matter.id, built.bundle, 'Synthetic demo reviewer', { clock });
  const names: readonly BundleFilename[] = [...AGREEMENT_FILES, 'bundle.json'];
  const bytes: Record<string, number> = {};
  for (const name of names) bytes[name] = (await approvedDownload(store, matter.id, built.bundle, name)).byteLength;
  const edited = applyAnswer(state, 'q.monthly_rent.v1', { kind: 'text', text: 'GBP 1300' }, { clock });
  if (!edited.ok) throw new Error('demo_edit_failed');
  await store.saveState(matter.id, edited.state);
  let staleBlocked = false;
  try { await approvedDownload(store, matter.id, built.bundle, 'agreement.md'); }
  catch (error) {
    if (!(error instanceof ApprovalError) || error.code !== 'stale_revision') throw error;
    staleBlocked = true;
  }
  if (!staleBlocked) throw new Error('demo_stale_approval_accepted');
  // Summaries only: no raw intake/quotes, real credentials, network or agreement-file writes.
  process.stdout.write(JSON.stringify({
    mode: 'mock demonstration, not a measurement', status: 'synthetic flow completed',
    approved_revision: built.bundle.manifest.revision, digest: built.bundle.digest,
    gate: built.bundle.gate.ok, checked_download_bytes: bytes, stale_approval_blocked: staleBlocked,
  }, null, 2) + '\n');
}
void main().catch((error: unknown) => {
  const code = error instanceof ApprovalError ? error.code : 'demo_failed';
  process.stderr.write(code + '\n');
  process.exitCode = 1;
});
