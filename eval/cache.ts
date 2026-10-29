import { mkdir, readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../supabase/functions/_shared/fillkit/canonicalJson.ts';
import { sha256Hex } from '../supabase/functions/_shared/fillkit/hash.ts';

export interface CacheIdentity {
  readonly provider: string; readonly model: string; readonly prompt: unknown; readonly schema: unknown;
  readonly option_order: unknown; readonly thresholds: unknown; readonly config: unknown; readonly fixture: unknown; readonly input: unknown;
}
export const cacheKey = (identity: CacheIdentity): string => sha256Hex(canonicalJson(identity));
export interface Cached<T> { readonly version: 1; readonly key: string; readonly result: T; readonly original_paid_usd: number | null; readonly original_latency_ms: number | null; readonly content_hash: string }
export class ResponseCache {
  readonly directory: string;
  constructor(directory: string) { this.directory = directory; }
  async read<T>(key: string): Promise<Cached<T> | null> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('invalid_cache_key');
    let raw: string;
    try { raw = await readFile(join(this.directory, `${key}.json`), 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const value = JSON.parse(raw) as Cached<T>; const { content_hash, ...body } = value;
    if (value.version !== 1 || value.key !== key || sha256Hex(canonicalJson(body)) !== content_hash) throw new Error('cache_corrupt');
    return value;
  }
  async write<T>(key: string, result: T, originalPaidUsd: number | null, originalLatencyMs: number | null): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('invalid_cache_key');
    await mkdir(this.directory, { recursive: true });
    const body = { version: 1 as const, key, result, original_paid_usd: originalPaidUsd, original_latency_ms: originalLatencyMs };
    const file = await open(join(this.directory, `${key}.json`), 'wx');
    try { await file.writeFile(canonicalJson({ ...body, content_hash: sha256Hex(canonicalJson(body)) })); await file.sync(); } finally { await file.close(); }
  }
}
