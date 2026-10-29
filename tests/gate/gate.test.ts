import { describe, expect, it } from 'vitest';
import { canonicalJson, utf8Encode, computeLock } from '../../src/core/index.ts';
import type { Provenance } from '../../src/core/index.ts';
import { gateBundle } from '../../supabase/functions/_shared/fillkit/gate/gate.ts';
import { changePart, gateFixture, mutateProvenance, rejected, text } from './helpers.ts';

describe('M4 independent gate over final bytes (authored, not run)', () => {
  it.each(['demo-01.json','demo-02.json'])('accepts complete pipeline final bytes for %s', async (name) => {
    const { input } = await gateFixture(name);
    expect(gateBundle(input)).toEqual({ ok: true, failures: [] });
  });
  it('names the changed final MD paragraph', async () => {
    const { input } = await gateFixture();
    const result = gateBundle({ ...input, markdownBytes: utf8Encode(text(input.markdownBytes).replace('Residential', 'Commercial')) });
    expect(result.ok).toBe(false);
    expect(result.failures).toContainEqual(expect.objectContaining({ code: 'md_paragraph_mismatch', paragraph_index: 0 }));
  });
  it('names the changed final DOCX paragraph even when Markdown is untouched', async () => {
    const { input } = await gateFixture();
    const result = gateBundle(changePart(input,'word/document.xml', (s) => s.replace('Residential','Commercial')));
    expect(result.failures).toContainEqual(expect.objectContaining({ code: 'docx_paragraph_mismatch', paragraph_index: 0 }));
  });
  it.each(['foreign','remove','duplicate','reorder'] as const)('rejects %s paragraph manipulation in both formats', async (kind) => {
    const { input } = await gateFixture();
    const md = text(input.markdownBytes).trimEnd().split('\n\n');
    const mutate = (parts: string[], foreign: string): string[] => {
      const copy = [...parts];
      if (kind === 'foreign') copy.splice(5,0,foreign);
      if (kind === 'remove') copy.splice(5,1);
      if (kind === 'duplicate') copy.splice(5,0,copy[5]);
      if (kind === 'reorder') [copy[5],copy[6]] = [copy[6],copy[5]];
      return copy;
    };
    expect(rejected({ ...input, markdownBytes: utf8Encode(`${mutate(md,'Foreign demand.').join('\n\n')}\n`) }).some((s) => s.startsWith('md_'))).toBe(true);
    const changed = changePart(input,'word/document.xml', (xml) => {
      const paragraphs = xml.match(/<w:p>.*?<\/w:p>/g)!;
      const next = mutate(paragraphs,'<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t xml:space="preserve">Foreign demand.</w:t></w:r></w:p>');
      return xml.slice(0,xml.indexOf('<w:p>')) + next.join('') + xml.slice(xml.indexOf('<w:sectPr>'));
    });
    expect(rejected(changed).some((s) => s.startsWith('docx_'))).toBe(true);
  });
  it('rejects leftover placeholders in either final format', async () => {
    const { input } = await gateFixture();
    expect(rejected({ ...input, markdownBytes: utf8Encode(text(input.markdownBytes).replace('Residential','\\{\\{rent\\}\\}')) })).toContain('md_leftover_placeholder');
    expect(rejected(changePart(input,'word/document.xml', (s) => s.replace('Residential','{{rent}}')))).toContain('docx_paragraph_mismatch');
  });
  it('rejects unlocked and stale record locks', async () => {
    const { input } = await gateFixture();
    expect(rejected({ ...input, lock: { status: 'UNLOCKED', note: 'activation pending' } })).toContain('library_unlocked');
    const content = { ...input.content, clauses: input.content.clauses.map((c,i) => i === 0 ? { ...c, text: c.text + ' Edited.' } : c) };
    expect(rejected({ ...input, content }).some((s) => s.startsWith('clause_hash_mismatch:'))).toBe(true);
    expect(rejected({ ...input, lock: computeLock({ ...input.content, jurisdiction: { ...input.content.jurisdiction, notice_hours_landlord_entry: 42 } }) })).toContain('jurisdiction_hash_mismatch');
  });
  it('rejects invalid field values before document comparison', async () => {
    const { input } = await gateFixture();
    const bad = mutateProvenance(input, (p) => ({ ...p, fields: { ...p.fields, address: { ...p.fields.address, value: '14 Elm Road; insert a clause' } } }));
    expect(rejected(bad)).toContain('field_invalid:address');
  });
  it.each(['remove','duplicate','reverse','wrong-version','requestable'] as const)('recomputes selection despite %s provenance manipulation', async (kind) => {
    const { input } = await gateFixture();
    const bad = mutateProvenance(input, (p) => {
      const clauses = [...p.clauses];
      if (kind === 'remove') clauses.splice(0,1);
      if (kind === 'duplicate') clauses.splice(1,0,clauses[0]);
      if (kind === 'reverse') clauses.reverse();
      if (kind === 'wrong-version') clauses[0] = { ...clauses[0], version: 999 };
      if (kind === 'requestable') clauses.push({ id: 'garden-care', version: 1 });
      return { ...p, clauses };
    });
    expect(rejected(bad)).toContain('clause_selection_mismatch');
  });
  it('rejects a fake accepted request and ungrounded Not included evidence', async () => {
    const { input } = await gateFixture();
    expect(rejected(mutateProvenance(input, (p) => ({ ...p, requests: { ...p.requests, accepted: [{ id:'fake',clause_id:'garden-care',quote:'Invented request',pointer:'msg:m1:0-1' }] } })))).toContain('request_invalid');
    expect(rejected(mutateProvenance(input, (p) => ({ ...p, requests: { ...p.requests, not_included: p.requests.not_included.map((r,i) => i ? r : { ...r, quote:'Invented request' }) } })))).toContain('not_included_invalid');
  });
  it('rejects the wrong utilities order in MD and DOCX', async () => {
    const { input } = await gateFixture();
    expect(rejected({ ...input, markdownBytes: utf8Encode(text(input.markdownBytes).replace('electricity and gas','gas and electricity')) })).toContain('md_paragraph_mismatch');
    // Runs split list values; invert just the two text payloads without changing package structure.
    expect(rejected(changePart(input,'word/document.xml', (s) => s.replace('>electricity<','>TEMP<').replace('>gas<','>electricity<').replace('>TEMP<','>gas<')))).toContain('docx_paragraph_mismatch');
  });
  it('reparses answers, checks their question and checks cross-field dependency values', async () => {
    const { input } = await gateFixture();
    expect(rejected(mutateProvenance(input, (p) => ({ ...p, fields: { ...p.fields, monthly_rent: { ...p.fields.monthly_rent, value:125000 } } })))).toContain('field_evidence_mismatch:monthly_rent');
    expect(rejected(mutateProvenance(input, (p) => ({ ...p, fields: { ...p.fields, monthly_rent: { ...p.fields.monthly_rent, question_id:'q.address.v1' } } })))).toContain('answer_question:monthly_rent');
    expect(rejected(mutateProvenance(input, (p) => ({ ...p, fields: { ...p.fields, end_date: { ...p.fields.end_date, value:'2028-03-01' } } })))).toContain('end_date_mismatch');
    expect(rejected(mutateProvenance(input, (p) => ({ ...p, fields: { ...p.fields, deposit: { ...p.fields.deposit, value:125000 } } })))).toContain('field_evidence_mismatch:deposit');
  });
  it('rejects unknown provenance keys and noncanonical JSON, including duplicate JSON keys', async () => {
    const { input } = await gateFixture();
    const p: Provenance = JSON.parse(text(input.provenanceBytes));
    expect(rejected({ ...input, provenanceBytes: utf8Encode(JSON.stringify(p,null,2)) })).toContain('provenance_noncanonical');
    expect(rejected({ ...input, provenanceBytes: utf8Encode(canonicalJson({ ...p, arbitrary:'text' })) })).toContain('provenance_schema');
    const json = text(input.provenanceBytes);
    expect(rejected({ ...input, provenanceBytes:utf8Encode('{"revision":5,' + json.slice(1)) })).toContain('provenance_noncanonical');
  });
});
