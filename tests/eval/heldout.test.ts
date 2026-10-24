import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claimHeldout } from '../../eval/dataset.ts';
import { canonicalJson } from '../../supabase/functions/_shared/fillkit/canonicalJson.ts';
import { sha256Hex } from '../../supabase/functions/_shared/fillkit/hash.ts';
import type { Manifest } from '../../supabase/functions/_shared/evalkit/split.ts';
const protocol = { synthetic_test: true };
const manifest: Manifest = { version: 1, state: 'frozen', seed: 3007, generated_count: 40, handtrap_count: 20, entries: [], sources: {}, protocol_hash: sha256Hex(canonicalJson(protocol)), frozen_at: '2026-10-24T00:00:00Z', digest: 'a'.repeat(64) };
describe('held-out one-attempt guard', () => {
  it('requires an explicitly frozen protocol and refuses config edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 's30-heldout-test-'));
    await expect(claimHeldout(root, { ...manifest, state: 'generated' }, protocol, 'run')).rejects.toThrow('heldout_requires_frozen_protocol');
    await expect(claimHeldout(root, manifest, { synthetic_test: false }, 'run')).rejects.toThrow('heldout_requires_frozen_protocol');
  });
  it('claims exactly once before any work, including concurrent and crashed attempts', async () => {
    const root = await mkdtemp(join(tmpdir(), 's30-heldout-test-'));
    const attempts = await Promise.allSettled([claimHeldout(root, manifest, protocol, 'one'), claimHeldout(root, manifest, protocol, 'two')]);
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    await expect(claimHeldout(root, manifest, protocol, 'retry-after-crash')).rejects.toThrow('heldout_already_attempted_manual_audit_required');
  });
});
