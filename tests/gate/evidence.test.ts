import { describe, expect, it } from 'vitest';
import { FIELD_SPECS, buildDraft, canonicalJson, findAllCandidates, groundFields, utf8Encode, writeDocx } from '../../src/core/index.ts';
import type { FieldKey, ProvenanceField } from '../../src/core/index.ts';
import { gateBundle } from '../../supabase/functions/_shared/fillkit/gate/gate.ts';
import { TEST_LOCK } from '../unit/m3Helpers.ts';
import { gateFixture, mutateProvenance, rejected, resolvedDemo } from './helpers.ts';

describe('M4 grounding and independent cross-field checks (source only)', () => {
  it('re-grounds all contributing utilities evidence, including a redundant span', async () => {
    const initial = await resolvedDemo();
    const intake = [...initial.intake,{id:'m5',text_normalised:'Tenants pay electricity and gas.'},{id:'m6',text_normalised:'Water and internet are included.'}];
    const found = findAllCandidates({messages:intake});
    const quote = 'Tenants pay electricity and gas';
    const grounded = groundFields({intake:{messages:intake},candidates:found.candidates,proposals:[{field:'utilities',quote,pointer:`msg:m5:0-${quote.length}`}],method:'mock'}).fields.utilities;
    expect(grounded.state).toBe('valid');
    const state = {...initial,intake,fields:{...initial.fields,utilities:grounded}};
    const draft = buildDraft(state,{lock:TEST_LOCK}); if (!draft.ok) throw new Error(draft.reasons.join(','));
    const {input:base} = await gateFixture();
    const input = {...base,provenanceBytes:draft.provenanceBytes,markdownBytes:utf8Encode(draft.markdown),docxBytes:writeDocx(draft.paragraphs)};
    expect(gateBundle(input).ok).toBe(true);
    const evidence = draft.provenance.fields.utilities.evidence!;
    expect(evidence.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < evidence.length; i++) {
      const bad = mutateProvenance(input,(p)=>({...p,fields:{...p.fields,utilities:{...p.fields.utilities,evidence:p.fields.utilities.evidence!.map((e,n)=>n===i?{...e,quote:'forged'}:e)}}}));
      expect(rejected(bad)).toContain('field_ungrounded:utilities');
    }
    // Dropping redundant tenant-paid evidence still fails even though the remaining categories classify fully.
    const missing = mutateProvenance(input,(p)=>({...p,fields:{...p.fields,utilities:{...p.fields.utilities,evidence:p.fields.utilities.evidence!.filter((e)=>!e.pointer.startsWith('msg:m3:'))}}}));
    expect(rejected(missing)).toContain('utilities_omitted_evidence');
  });
  it('rejects grounded text quoted from outside a role payload and role payload truncation', async () => {
    const {input} = await gateFixture();
    expect(rejected(mutateProvenance(input,(p)=>{
      const start=p.intake[0].text_normalised.indexOf('Sam Patel');
      return {...p,fields:{...p.fields,landlord:{...p.fields.landlord,quote:'Sam',pointer:`msg:m1:${start}-${start+3}`,value:'Sam'}}};
    }))).toContain('field_role_payload:landlord');
  });
  it.each([
    ['tenants',['Sam Patel'],'tenant_is_landlord'],
    ['guarantor','Sam Patel','guarantor_is_party'],
    ['break_month',12,'break_month_out_of_range'],
    ['deposit',600000,'deposit_over_cap'],
  ] as const)('independently rejects cross-field violation %s',async(key,value,code)=>{
    const {input}=await gateFixture();
    const field=key as FieldKey;
    const answerValue=typeof value==='object'?Array.from(value):value;
    const record:ProvenanceField={state:'valid',value:answerValue,method:'user_answer',question_id:FIELD_SPECS[field].questionTemplate.id,answer:{kind:'value',value:answerValue},answered_at:'2026-10-24T12:00:00.000Z'};
    expect(rejected(mutateProvenance(input,(p)=>({...p,fields:{...p.fields,[field]:record}})))).toContain(code);
  });
  it('accepts only the documented whitespace normalization',async()=>{
    const {input}=await gateFixture();
    const bytes=new TextDecoder().decode(input.markdownBytes);
    expect(gateBundle({...input,markdownBytes:utf8Encode(bytes.replace('Residential Tenancy','Residential  Tenancy'))}).ok).toBe(true);
    expect(rejected({...input,markdownBytes:utf8Encode(bytes.replace('Residential Tenancy','Residential\u00a0Tenancy'))})).toContain('md_paragraph_mismatch');
    const p=JSON.parse(new TextDecoder().decode(input.provenanceBytes));
    expect(rejected({...input,provenanceBytes:utf8Encode(canonicalJson({...p,fields:{...p.fields,utilities:{...p.fields.utilities,value:['gas','electricity']}}}))})).toContain('field_invalid:utilities');
  });
});
