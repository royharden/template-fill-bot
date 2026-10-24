import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { checkAdversarial } from '../../eval/adversarial.ts';
import type { AdversarialFixture } from '../../eval/adversarial.ts';
describe('self-authored adversarial model outputs', () => {
  it('rejects every declared malicious result through the actual schema/grounding/request path', async () => {
    const names = (await readdir('eval/adversarial')).filter((name) => name.endsWith('.json')); expect(names.length).toBeGreaterThanOrEqual(6);
    for (const name of names) {
      const fixture = JSON.parse(await readFile(`eval/adversarial/${name}`, 'utf8')) as AdversarialFixture;
      expect(await checkAdversarial(fixture), fixture.id).toBe(true);
    }
  });
});
