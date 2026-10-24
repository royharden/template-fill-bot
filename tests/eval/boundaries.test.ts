import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
function walkImports(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen; seen.add(file);
  for (const match of readFileSync(file, 'utf8').matchAll(/(?:from\s*|import\s*\(?\s*)['"](\.[^'"]+)['"]/g)) {
    const next = resolve(dirname(file), match[1]); if (/\.tsx?$/.test(next)) walkImports(next, seen);
  }
  return seen;
}
describe('evaluation isolation', () => {
  it('makes free-draft adapters unreachable from browser and every deployed function entry', () => {
    const entries = ['src/ui/main.tsx', 'src/core/index.ts', ...readdirSync('supabase/functions', { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== '_shared').map((e) => `supabase/functions/${e.name}/index.ts`)];
    for (const entry of entries) for (const path of walkImports(resolve(entry))) expect(path.replaceAll('\\', '/')).not.toMatch(/\/eval\/|\/evalkit\//);
  });
  it('keeps filesystem, credentials and paid providers out of the reusable pure metrics/split module', () => {
    for (const name of readdirSync('supabase/functions/_shared/evalkit').filter((s) => s.endsWith('.ts'))) {
      const text = readFileSync(`supabase/functions/_shared/evalkit/${name}`, 'utf8');
      expect(text).not.toMatch(/node:|process\.env|Deno\.env|fetch\(/);
    }
  });
  it('does not derive gold labels using the extraction or renderer being assessed', () => {
    const source = readFileSync('eval/generator.ts', 'utf8');
    expect(source).not.toMatch(/from ['"].*(?:extractors|pipeline|renderMarkdown|select|grounding|gate)\//);
    expect(source).not.toContain('runExtraction('); expect(source).not.toContain('buildDraft(');
  });
});
