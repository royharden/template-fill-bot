import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const relativeImports = (source: string): string[] => [...source.matchAll(/(?:from\s*|import\s*\(?\s*)['"]([^'"]+)['"]/g)].map((match) => match[1]).filter((path) => path.startsWith('.'));
function graph(entry: string): string[] {
  const seen = new Set<string>(), pending = [resolve(entry)];
  while (pending.length) {
    const file = pending.pop()!; if (seen.has(file)) continue; seen.add(file);
    for (const imported of relativeImports(readFileSync(file, 'utf8'))) {
      const next = resolve(dirname(file), imported); expect(existsSync(next), `${file} -> ${imported}`).toBe(true);
      if (/\.tsx?$/.test(next)) pending.push(next);
    }
  }
  return [...seen];
}
describe('deployed product dependency boundaries', () => {
  it('keeps provider keys, metering, model extractors and eval-only generation out of the transitive browser graph', () => {
    for (const entry of ['src/ui/main.tsx', 'src/core/index.ts']) {
      const files = graph(entry).map((file) => file.split(sep).join('/'));
      expect(files.filter((file) => /\/(providers|callledger|eval)\//.test(file) || /\/extractors\/(llm|jev)\.ts$/.test(file))).toEqual([]);
      for (const file of files) expect(readFileSync(file, 'utf8')).not.toMatch(/(?:SUPABASE_SERVICE_ROLE_KEY|ANTHROPIC_API_KEY|OPENAI_COMPATIBLE_API_KEY|TYPESAFE_API_KEY)/);
    }
  });
  it('keeps independent gate source free of renderer/writer/selection imports', () => {
    const root = resolve('supabase/functions/_shared/fillkit/gate');
    for (const name of readdirSync(root).filter((file) => file.endsWith('.ts'))) {
      expect(relativeImports(readFileSync(resolve(root, name), 'utf8')).filter((path) => /(?:^|\/)(select|segments|renderMarkdown|writeDocx)\.ts$/.test(path))).toEqual([]);
    }
  });
  it('has only extraction as a product edge route and no free-draft code in that graph', () => {
    expect(readdirSync(resolve('supabase/functions'), { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('_')).map((entry) => entry.name)).toEqual(['extract-fields']);
    for (const file of graph('supabase/functions/extract-fields/index.ts')) expect(file.replaceAll('\\', '/')).not.toMatch(/\/eval\/|free.?draft/i);
  });
  it('initializes auth only inside the explicitly mounted live subtree', () => {
    const main = readFileSync(resolve('src/ui/LiveWorkbench.tsx'), 'utf8');
    expect(main).toContain('useState(false)'); expect(main).toContain('authContent: active ? <AuthScreens');
    expect(main).not.toContain('getSupabaseClient(');
    const auth = readFileSync(resolve('src/ui/AuthScreens.tsx'), 'utf8');
    expect(auth.indexOf('useEffect(() => {')).toBeLessThan(auth.indexOf('const next = getSupabaseClient()'));
  });
});
