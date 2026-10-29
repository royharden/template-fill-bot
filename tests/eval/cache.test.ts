import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { cacheKey, ResponseCache } from '../../eval/cache.ts';
import type { CacheIdentity } from '../../eval/cache.ts';
const identity: CacheIdentity = { provider: 'synthetic', model: 'synthetic', prompt: 'fixed prompt', schema: { v: 1 }, option_order: ['a', 'none'], thresholds: { min: .9 }, config: { timeout: 20 }, fixture: 'fixture-hash', input: 'Synthetic text' };
describe('cache context and replay economics', () => {
  it('invalidates each provider/model/prompt/schema/order/threshold/config/fixture/input dimension', () => {
    const key = cacheKey(identity);
    for (const name of Object.keys(identity) as (keyof CacheIdentity)[]) expect(cacheKey({ ...identity, [name]: { changed: identity[name] } })).not.toBe(key);
    expect(cacheKey({ ...identity, option_order: ['none', 'a'] })).not.toBe(key);
  });
  it('preserves original paid cost and detects modified or partially written response content', async () => {
    const path = await mkdtemp(join(tmpdir(), 's30-cache-test-')), cache = new ResponseCache(path), key = cacheKey(identity);
    expect(await cache.read(key)).toBeNull();
    await cache.write(key, { answer: 'a' }, .03, 123);
    expect(await cache.read(key)).toMatchObject({ result: { answer: 'a' }, original_paid_usd: .03, original_latency_ms: 123 });
    const file = join(path, `${key}.json`), text = await readFile(file, 'utf8'); await writeFile(file, text.replace('"answer":"a"', '"answer":"none"'));
    await expect(cache.read(key)).rejects.toThrow('cache_corrupt');
  });
});
