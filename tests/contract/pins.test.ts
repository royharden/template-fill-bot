import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('frontend/edge dependency pins (source contract)', () => {
  it('uses identical exact dependency versions for every Deno npm import', () => {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { dependencies: Record<string, string> };
    const deno = JSON.parse(readFileSync(resolve('supabase/functions/extract-fields/deno.json'), 'utf8')) as { imports: Record<string, string> };
    expect(Object.keys(deno.imports).sort()).toEqual(['@supabase/supabase-js', 'fflate', 'zod']);
    for (const [name, specifier] of Object.entries(deno.imports)) {
      expect(pkg.dependencies[name]).toMatch(/^\d+\.\d+\.\d+$/);
      expect(specifier).toBe(`npm:${name}@${pkg.dependencies[name]}`);
    }
    expect(readFileSync(resolve('supabase/config.toml'), 'utf8')).toMatch(/\[functions\.extract-fields\][\s\S]*verify_jwt\s*=\s*true/);
  });
});
