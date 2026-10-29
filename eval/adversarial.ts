import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runExtraction, deriveView } from '../supabase/functions/_shared/fillkit/pipeline.ts';
import { FIELD_KEYS } from '../supabase/functions/_shared/content/types.ts';
import type { FieldKey } from '../supabase/functions/_shared/content/types.ts';
import type { IntakeMessageInput } from '../supabase/functions/_shared/fillkit/normalize.ts';
import type { EvalRow } from '../supabase/functions/_shared/evalkit/types.ts';
import { emptyCounts, noEligibility } from '../supabase/functions/_shared/evalkit/types.ts';
import { newObservation } from './providers/metered.ts';

export interface AdversarialFixture { id: string; messages: IntakeMessageInput[]; output: unknown; expected: { field?: FieldKey; not_valid?: boolean; diagnostic: 'rejected_proposals' | 'field_invalid' | 'not_included' | 'dropped_keys' | 'request_drops' } }
export async function checkAdversarial(fixture: AdversarialFixture): Promise<boolean> {
  const result = await runExtraction(fixture.messages, { method: 'mock', extract: async () => fixture.output }); if (!result.ok) return false;
  const view = deriveView(result.state), d = result.state.diagnostics;
  if (fixture.expected.field && (!FIELD_KEYS.includes(fixture.expected.field) || (fixture.expected.not_valid && view.fields[fixture.expected.field].state === 'valid'))) return false;
  switch (fixture.expected.diagnostic) {
    case 'rejected_proposals': return d.rejected_proposals.length > 0;
    case 'field_invalid': return !!fixture.expected.field && view.fields[fixture.expected.field].state === 'invalid';
    case 'not_included': return view.requests.notIncluded.length > 0 && view.requests.accepted.length === 0;
    case 'dropped_keys': return d.dropped_keys.length > 0;
    case 'request_drops': return d.request_drops.length > 0 && view.requests.accepted.length === 0;
  }
}
export async function adversarialRows(root: string, split: 'dev' | 'heldout'): Promise<EvalRow[]> {
  const rows: EvalRow[] = [];
  for (const name of (await readdir(join(root, 'eval/adversarial'))).filter((s) => s.endsWith('.json')).sort()) {
    const fixture = JSON.parse(await readFile(join(root, 'eval/adversarial', name), 'utf8')) as AdversarialFixture;
    let ok = false; try { ok = await checkAdversarial(fixture); } catch { /* Retain a failed row. */ }
    const counts = emptyCounts(); counts.security_cases = 1; counts.security_pass = Number(ok);
    rows.push({ scenario_id: fixture.id, base_id: fixture.id, split, method: 'mock', scope: 'all', status: 'nonmeasurement', reason: 'adversarial_fixture_conformance_not_model_quality', counts,
      failures: ok ? [] : [{ scenario_id: fixture.id, kind: 'adversarial_rejection', item: fixture.expected.diagnostic }], ...newObservation(), eligibility: { ...noEligibility(), security: true } });
  }
  return rows;
}
