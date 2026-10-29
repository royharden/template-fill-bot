import { join } from 'node:path';
import { FIELD_KEYS } from '../supabase/functions/_shared/content/types.ts';
import { buildBundle } from '../supabase/functions/_shared/fillkit/bundle.ts';
import { runExtraction } from '../supabase/functions/_shared/fillkit/pipeline.ts';
import { regexExtractor } from '../supabase/functions/_shared/fillkit/extractors/regex.ts';
import { createLlmExtractor } from '../supabase/functions/_shared/fillkit/extractors/llm.ts';
import { createJevExtractor, JEV_ELIGIBLE_FIELDS } from '../supabase/functions/_shared/fillkit/extractors/jev.ts';
import type { Extractor } from '../supabase/functions/_shared/fillkit/extractors/types.ts';
import { writeDocx } from '../supabase/functions/_shared/docx/writeDocx.ts';
import { readMarkdown } from '../supabase/functions/_shared/fillkit/gate/mdRead.ts';
import { LIBRARY_CONTENT } from '../supabase/functions/_shared/fillkit/library.ts';
import { LIBRARY_LOCK } from '../supabase/functions/_shared/content/library.lock.ts';
import { gateBundle } from '../supabase/functions/_shared/fillkit/gate/gate.ts';
import { emptyCounts, METHODS, noEligibility } from '../supabase/functions/_shared/evalkit/types.ts';
import type { EvalRow, GoldScenario } from '../supabase/functions/_shared/evalkit/types.ts';
import type { Manifest } from '../supabase/functions/_shared/evalkit/split.ts';
import type { PriceTable } from '../supabase/functions/_shared/callledger/types.ts';
import { DurableBudget } from './budget.ts';
import { ResponseCache } from './cache.ts';
import { meteredCompletion, meteredChoice, newObservation } from './providers/metered.ts';
import type { MeterOptions } from './providers/metered.ts';
import { freeDraftRequest, countFreeDraft } from './providers/freeDraft.ts';
import type { Protocol } from './protocol.ts';
import { scoreState } from './score.ts';
import { renderedWhitelist, knownBoilerplate } from './reference.ts';
import { checkSecurity } from './security.ts';

export interface RunOptions { readonly root: string; readonly live: boolean; readonly split: 'dev' | 'heldout'; readonly protocol: Protocol; readonly manifest: Manifest; readonly prices?: PriceTable; readonly env: Readonly<Record<string, string | undefined>> }
export async function evaluate(scenarios: readonly GoldScenario[], options: RunOptions): Promise<EvalRow[]> {
  const rows: EvalRow[] = [], { protocol } = options;
  const budget = new DurableBudget(join(options.root, 'eval/budget'), Number(options.env.EVAL_MAX_ATTEMPT_USD ?? 0.10), Number(options.env.EVAL_MAX_RUN_USD ?? 2));
  const cache = new ResponseCache(join(options.root, 'results/cache'));
  for (const scenario of scenarios) for (const method of METHODS.filter((m) => protocol.methods.includes(m))) {
    const observation = newObservation(); let reason: string | undefined;
    const metering: MeterOptions = { budget, cache, prices: options.prices, retries: protocol.retries, observation,
      identity: { thresholds: protocol.thresholds, config: { protocol, prices: options.prices ?? null, manifest: options.manifest.digest, endpoint: options.env.OPENAI_COMPATIBLE_BASE_URL ?? null }, fixture: scenario, input: scenario.messages } };
    const completion = () => meteredCompletion(protocol.llm_provider, { apiKey: options.env[protocol.llm_provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_COMPATIBLE_API_KEY'], baseUrl: options.env.OPENAI_COMPATIBLE_BASE_URL }, metering);
    const base = { scenario_id: scenario.id, base_id: scenario.base_id, split: options.split, method, counts: emptyCounts(), failures: [], eligibility: noEligibility(), ...observation };
    const pushFailure = (failureReason: string) => {
      const row: EvalRow = { ...base, ...observation, scope: method === 'jev' ? 'jev_eligible' : 'all', status: 'incomplete', reason: failureReason, failures: [{ scenario_id: scenario.id, kind: 'incomplete', item: failureReason }] };
      rows.push(row); if (method === 'regex' || method === 'llm') rows.push({ ...row, scope: 'jev_eligible' });
    };
    try {
      if (!options.live && method !== 'regex' && method !== 'mock') { pushFailure('offline_live_method_not_dispatched'); continue; }
      if (method.startsWith('free_draft')) {
        const whitelist = renderedWhitelist(scenario);
        const request = freeDraftRequest(scenario, protocol.llm_model, method === 'free_draft_blind' ? 'blind' : 'library', whitelist, protocol.max_output_tokens, protocol.timeout_ms);
        const output = await completion().complete(request); if (!output.ok) { pushFailure(observation.error ?? `provider_${output.code}`); continue; }
        const counted = countFreeDraft(output.text, whitelist, knownBoilerplate()), counts = emptyCounts();
        counts.free_paragraphs = counted.paragraphs; counts.foreign_paragraphs = counted.unmatched; counts.legal_content_paragraphs = counted.legal_content; counts.legal_inventions = counted.invented; counts.boilerplate_mismatches = counted.boilerplate_mismatches; counts.headings = counted.headings; counts.provenance_paragraphs = counted.provenance;
        // Run generated text through the SAME final-byte gate. A regex-derived reference supplies the
        // companion provenance only when it can render; absent canonical provenance is rejected by the gate.
        const extracted = await runExtraction(scenario.messages, regexExtractor);
        const bundle = extracted.ok ? buildBundle(extracted.state) : null;
        const provenanceBytes = bundle?.ok ? bundle.bundle.files['provenance.json'] : new Uint8Array();
        const markdownBytes = new TextEncoder().encode(output.text + (output.text.endsWith('\n') ? '' : '\n'));
        let docxBytes = new Uint8Array();
        try { docxBytes = writeDocx(readMarkdown(markdownBytes).map((p) => ({ style: p.style === 'Title' ? 'Title' : p.style === 'Heading1' ? 'Heading1' : 'Normal', segments: [{ kind: 'clause_text', clause_id: 'eval-only-untrusted', text: p.text }] }))); } catch { /* The independent gate will report invalid final bytes. */ }
        const checked = gateBundle({ content: LIBRARY_CONTENT, lock: LIBRARY_LOCK, provenanceBytes, markdownBytes, docxBytes });
        counts.gate_failures = Number(!checked.ok);
        counts.pipeline_rendered = 1;
        const failures = [...counted.invented_indices.map((index) => ({ scenario_id: scenario.id, kind: 'legal_content_invention', item: String(index) })),
          ...counted.boilerplate_indices.map((index) => ({ scenario_id: scenario.id, kind: 'boilerplate_clause_mismatch', item: String(index) })),
          ...(!checked.ok ? [{ scenario_id: scenario.id, kind: 'gate_failure', item: checked.failures.map((failure) => failure.code).join(',') }] : [])];
        rows.push({ ...base, ...observation, counts, failures, eligibility: { ...noEligibility(), free_draft: true, conformance: true }, scope: 'all', status: !bundle?.ok ? 'incomplete' : observation.replay ? 'nonmeasurement' : 'complete', ...(!bundle?.ok ? { reason: 'gate_reference_unrenderable_paragraph_counts_available' } : observation.replay ? { reason: 'cache_replay_not_new_measurement' } : {}) });
        continue;
      }
      let extractor: Extractor = regexExtractor;
      if (method === 'mock') extractor = { method: 'mock', extract: async () => ({ fields: [], requests: [] }) };
      if (method === 'llm') extractor = createLlmExtractor(completion(), { model: protocol.llm_model, timeoutMs: protocol.timeout_ms, maxTokens: protocol.max_output_tokens });
      if (method === 'jev') extractor = createJevExtractor(meteredChoice({ apiKey: options.env.TYPESAFE_API_KEY }, metering), { model: protocol.jev_model, timeoutMs: protocol.timeout_ms, shuffleSeed: protocol.option_order_seed });
      const result = await runExtraction(scenario.messages, extractor);
      if (!result.ok) { pushFailure(`intake_${result.error.code}`); continue; }
      const predictionAvailable = method !== 'llm' && method !== 'jev' || observation.dispatched_attempts > 0 || observation.replay;
      reason = observation.error ?? result.state.diagnostics.extractor_error ?? (!predictionAvailable ? 'model_not_dispatched_no_candidates' : undefined);
      const scope = method === 'jev' ? JEV_ELIGIBLE_FIELDS : FIELD_KEYS;
      const scored = scoreState(scenario, result.state, scope, { predictionAvailable });
      if (reason) scored.failures.push({ scenario_id: scenario.id, kind: 'incomplete', item: reason });
      const security = await checkSecurity(scenario, result.state);
      scored.eligibility = { ...scored.eligibility, security: !!scenario.security };
      if (scenario.security) { scored.counts.security_cases = 1; scored.counts.security_pass = Number(security.ok); }
      if (!security.ok) { reason = reason ?? security.reason; scored.failures.push({ scenario_id: scenario.id, kind: 'security', item: security.reason }); }
      const status = reason ? 'incomplete' : !options.live || method === 'mock' || observation.replay ? 'nonmeasurement' : 'complete';
      const row: EvalRow = { ...base, ...observation, ...scored, scope: method === 'jev' ? 'jev_eligible' : 'all', status,
        ...(reason ? { reason } : status === 'nonmeasurement' ? { reason: observation.replay ? 'cache_replay_not_new_measurement' : 'offline_or_mock_not_model_measurement' } : {}) };
      rows.push(row);
      // Matched denominators for Jev promotion: same model call, rescored fields only; no extra hidden fallback/cost.
      if (method === 'regex' || method === 'llm') {
        const eligible = scoreState(scenario, result.state, JEV_ELIGIBLE_FIELDS, { predictionAvailable });
        eligible.eligibility = { ...eligible.eligibility, security: scored.eligibility.security };
        eligible.counts.security_cases = scored.counts.security_cases; eligible.counts.security_pass = scored.counts.security_pass;
        if (reason) eligible.failures.push({ scenario_id: scenario.id, kind: 'incomplete', item: reason });
        if (!security.ok) eligible.failures.push({ scenario_id: scenario.id, kind: 'security', item: security.reason });
        rows.push({ ...row, ...eligible, scope: 'jev_eligible' });
      }
    } catch (error) {
      pushFailure(observation.error ?? (error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'evaluation_error'));
    }
  }
  return rows;
}
