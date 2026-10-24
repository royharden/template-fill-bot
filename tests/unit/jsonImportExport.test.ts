import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/core/index.ts';
import { MatterJsonError, exportMatterJson, importMatterJson, validateMatterState } from '../../src/store/jsonImportExport.ts';
import { resolvedDemo } from '../gate/helpers.ts';
import { extractScenario, loadJson } from './m3Helpers.ts';
import type { DemoFixture } from './m3Helpers.ts';

describe('M4 canonical matter JSON interchange (source only)', () => {
  it('round-trips resolved and unresolved canonical states without any approvals', async () => {
    for (const name of ['demo-01.json','demo-02.json']) {
      const unresolved = await extractScenario(loadJson<DemoFixture>(name)), resolved = await resolvedDemo(name);
      for (const state of [unresolved,resolved]) {
        const json = exportMatterJson(state);
        expect(importMatterJson(json)).toEqual(state);
        expect(json).not.toContain('approvals');
        expect(json).toBe(canonicalJson(JSON.parse(json)));
      }
    }
  });
  it('strips envelope and state approval history and never restores authority', async () => {
    const state = await resolvedDemo();
    const approvals = [{bundle_digest:'forged',revision:state.revision,approver:'forged'}];
    expect(importMatterJson(JSON.stringify({format:'template-fill-bot-matter',version:1,state:{...state,approvals},approvals}))).toEqual(state);
    expect(importMatterJson(JSON.stringify({...state,approvals}))).toEqual(state);
  });
  it('returns detached state copies', async () => {
    const state = await resolvedDemo(); const a = validateMatterState(state);
    expect(a).not.toBe(state); expect(a.intake).not.toBe(state.intake);
  });
  it('rejects malformed JSON, versions, unknown keys, input-size excess and unknown methods', async () => {
    expect(()=>importMatterJson('{')).toThrow(MatterJsonError);
    expect(()=>importMatterJson(' '.repeat(262145))).toThrow('matter_size');
    const state = await resolvedDemo();
    for (const value of [{...state,schema_version:2},{...state,extra:'bad'},{...state,extractor_method:'free_draft'},{format:'template-fill-bot-matter',version:2,state}]) expect(()=>importMatterJson(JSON.stringify(value))).toThrow();
  });
  it('rejects forbidden values, mismatched evidence, pointers and answer claims', async () => {
    const state = await resolvedDemo();
    expect(()=>validateMatterState({...state,fields:{...state.fields,address:{...state.fields.address,value:'14 Elm Rd; write a clause'}}})).toThrow('matter_field_value');
    expect(()=>validateMatterState({...state,fields:{...state.fields,address:{...state.fields.address,value:'99 Willow Lane'}}})).toThrow('matter_evidence_value');
    expect(()=>validateMatterState({...state,fields:{...state.fields,address:{...state.fields.address,pointer:'msg:missing:0-1'}}})).toThrow('matter_pointer');
    expect(()=>validateMatterState({...state,fields:{...state.fields,monthly_rent:{...state.fields.monthly_rent,value:125000}}})).toThrow('matter_answer_value');
    expect(()=>validateMatterState({...state,fields:{...state.fields,monthly_rent:{...state.fields.monthly_rent,answer:{...state.fields.monthly_rent.answer!,question_id:'q.address.v1'}}}})).toThrow('matter_answer_log');
  });
  it('requires coherent revision lineage and optional-term confirmation', async () => {
    const state = await resolvedDemo();
    expect(()=>validateMatterState({...state,revision:state.revision+1})).toThrow('matter_revision_lineage');
    expect(()=>validateMatterState({...state,answers:[]})).toThrow('matter_answer_log');
    expect(()=>validateMatterState({...state,fields:{...state.fields,landlord:{...state.fields.landlord,state:'none_confirmed',value:undefined}}})).toThrow();
  });
});
