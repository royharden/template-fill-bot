import { describe, expect, it } from 'vitest';
import { readScenarios } from '../../eval/dataset.ts';
import { checkSecurity } from '../../eval/security.ts';
import { runExtraction } from '../../supabase/functions/_shared/fillkit/pipeline.ts';
import { regexExtractor } from '../../supabase/functions/_shared/fillkit/extractors/regex.ts';
describe('extra handtrap security conformance source', () => {
  it('exercises expiry/no-dispatch, unknown-charge retry caps, and hidden final-DOCX markup without live calls', async () => {
    const state = await runExtraction([{ id: 'm1', text: 'Synthetic fixture only.' }], regexExtractor);
    if (!state.ok) throw new Error('synthetic_intake_invalid');
    const traps = await readScenarios('eval/gold/handtraps');
    for (const key of ['expiry_retry_budget', 'docx_hidden'] as const) {
      const trap = traps.find((s) => s.security === key); expect(trap, key).toBeDefined();
      expect((await checkSecurity(trap!, state.state)).ok, key).toBe(true);
    }
  });
  it('retains stale-approval prerequisite failures instead of counting a blocked render as a stale-approval pass', async () => {
    const state = await runExtraction([{ id: 'm1', text: 'Synthetic fixture only.' }], regexExtractor);
    if (!state.ok) throw new Error('synthetic_intake_invalid');
    const trap = (await readScenarios('eval/gold/handtraps')).find((s) => s.security === 'stale_approval');
    expect(await checkSecurity(trap!, state.state)).toEqual({ ok: false, reason: 'stale_approval_prerequisite_blocked' });
  });
});
