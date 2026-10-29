import { unzipSync, zipSync } from 'fflate';
import { readDocumentXml } from '../supabase/functions/_shared/fillkit/gate/xmlTokens.ts';
import { writeDocx } from '../supabase/functions/_shared/docx/writeDocx.ts';
import { buildBundle } from '../supabase/functions/_shared/fillkit/bundle.ts';
import { approvedDownload } from '../supabase/functions/_shared/rulings/approvals.ts';
import { createAnthropicProvider } from '../supabase/functions/_shared/providers/anthropic.ts';
import { DurableBudget } from './budget.ts';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MatterState } from '../supabase/functions/_shared/fillkit/matter.ts';
import type { GoldScenario } from '../supabase/functions/_shared/evalkit/types.ts';

/** These deterministic security checks are reported independently of model quality. Budget/expiry/retry
 * conformance is intentionally handled by injected transport tests, never by spending a live retry here. */
export async function checkSecurity(scenario: GoldScenario, state: MatterState): Promise<{ ok: boolean; reason: string }> {
  if (scenario.security === 'docx_hidden') {
    const bytes = writeDocx([{ style: 'Normal', segments: [{ kind: 'clause_text', clause_id: 'synthetic', text: 'Synthetic visible text.' }] }]);
    const parts = unzipSync(bytes), decoder = new TextDecoder();
    parts['word/document.xml'] = new TextEncoder().encode(decoder.decode(parts['word/document.xml']).replace('<w:r>', '<w:r><w:rPr><w:vanish/></w:rPr>'));
    // Exercise the gate's XML reader on actual altered final DOCX content, with no test-only parser.
    const altered = unzipSync(zipSync(parts));
    try { readDocumentXml(decoder.decode(altered['word/document.xml'])); return { ok: false, reason: 'hidden_text_accepted' }; } catch { return { ok: true, reason: 'hidden_text_rejected' }; }
  }
  if (scenario.security === 'stale_approval') {
    const result = buildBundle(state, { matterId: scenario.id });
    if (!result.ok) return { ok: false, reason: 'stale_approval_prerequisite_blocked' };
    const bundle = result.bundle;
    const store = { getState: async () => ({ ...state, revision: state.revision + 1 }), appendApproval: async () => {}, listApprovals: async () => [{ matter_id: scenario.id, revision: state.revision, bundle_digest: bundle.digest, library_hash: bundle.manifest.library_hash, approver: 'synthetic', approved_at: '2026-10-24T00:00:00Z' }] };
    try { await approvedDownload(store, scenario.id, bundle, 'agreement.docx'); return { ok: false, reason: 'stale_approval_accepted' }; }
    catch (error) { return { ok: error instanceof Error && error.message === 'stale_revision', reason: error instanceof Error && error.message === 'stale_revision' ? 'stale_approval_rejected' : 'stale_approval_other_failure' }; }
  }
  if (scenario.security === 'expiry_retry_budget') {
    // Synthetic local conformance only; never changes the paid evaluator's ledger or sends a request.
    const controller = new AbortController(); controller.abort(); let dispatches = 0;
    const adapter = createAnthropicProvider({ apiKey: 'synthetic-never-dispatched', fetchImpl: async () => { dispatches++; throw new Error('unexpected_dispatch'); } });
    const expired = await adapter.complete({ model: 'synthetic', system: 'Synthetic expiry check.', messages: [{ role: 'user', content: 'Synthetic fixture.' }], maxTokens: 1, timeoutMs: 1, signal: controller.signal });
    if (expired.ok || expired.dispatched || dispatches !== 0) return { ok: false, reason: 'expired_attempt_dispatched' };
    const directory = await mkdtemp(join(tmpdir(), 's30-eval-budget-conformance-'));
    // Retain synthetic audit files; no cleanup/reset of the paid ledger is available through this check.
    const budget = new DurableBudget(directory, 0.10, 0.15), hash = 'a'.repeat(64);
    const first = await budget.reserve(hash, 0.10); await budget.settle(first, null, true);
    try { await budget.reserve(hash, 0.10, first); return { ok: false, reason: 'retry_ignored_unknown_charge' }; } catch (error) { if (!(error instanceof Error) || error.message !== 'budget_cumulative_cap') throw error; }
    const retry = await budget.reserve(hash, 0.05, first); await budget.settle(retry, 0, false);
    try { await budget.reserve(hash, 0.01, retry); return { ok: false, reason: 'second_retry_accepted' }; } catch (error) { if (!(error instanceof Error) || error.message !== 'retry_limit') throw error; }
    return { ok: (await budget.snapshot()).charged_usd === 0.10, reason: 'synthetic_expiry_retry_budget_conformance' };
  }
  return { ok: true, reason: 'not_applicable' };
}
