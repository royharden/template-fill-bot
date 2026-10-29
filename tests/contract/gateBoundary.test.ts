import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('M4 independent gate import boundary',()=>{
  it('imports no selection, segments, Markdown renderer or DOCX writer, including type imports',()=>{
    const root=resolve('supabase/functions/_shared/fillkit/gate');
    for(const file of readdirSync(root).filter((f)=>f.endsWith('.ts'))){
      const source=readFileSync(resolve(root,file),'utf8');
      const imports=[...source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)].map((m)=>m[1]);
      expect(imports.filter((p)=>/(?:^|\/)(?:select|segments|renderMarkdown|writeDocx)\.ts$/.test(p)),file).toEqual([]);
    }
  });
});
