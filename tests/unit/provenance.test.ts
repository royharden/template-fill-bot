// M3 provenance contracts. Authored in Dirty Mode; execution is deferred to DV-TESTS.
import { describe, expect, it } from 'vitest';
import { FIELD_KEYS } from '../../supabase/functions/_shared/content/types.ts';
import {
  buildDraft, canonicalJson, groundQuote, parseProvenance, provenanceBytes, provenanceField,
  provenanceJson, sha256Hex, utf8Encode,
} from '../../supabase/functions/_shared/fillkit/index.ts';
import { TEST_LOCK, answerAll, extractScenario, ground, intakeOf, loadJson, ptr } from './m3Helpers.ts';
import type { DemoFixture } from './m3Helpers.ts';

const fixture = loadJson<DemoFixture>('demo-01.json');

async function resolvedDraft() {
  const state = answerAll(await extractScenario(fixture), fixture.expected.answers);
  const draft = buildDraft(state, { lock: TEST_LOCK, matterId: 'matter-demo' });
  if (!draft.ok) throw new Error(draft.reasons.join(','));
  return draft;
}

describe('provenance', () => {
  it('includes all 15 fields, canonical intake, current revision, clause versions and lock hashes', async () => {
    const draft = await resolvedDraft();
    const p = draft.provenance;
    expect(Object.keys(p.fields)).toEqual(FIELD_KEYS);
    expect(p.matter_id).toBe('matter-demo');
    expect(p.revision).toBe(5);
    expect(p.intake).toEqual(fixture.messages.map(({ id, text }) => ({ id, text_normalised: text })));
    expect(p.clauses).toEqual(draft.clauses);
    expect(p.library_hash).toBe(TEST_LOCK.overall);
    expect(p.jurisdiction_hash).toBe(TEST_LOCK.jurisdiction);
    expect(p.content_hash).toBe(draft.contentHash);
    expect(p.fields.end_date).toMatchObject({ state: 'valid', value: '2028-02-29', method: 'computed' });
    expect(p.fields.deposit).toMatchObject({ value: 120000, relative_months: 1, quote: "one month's rent" });
  });

  it('every quote/pointer resolves against provenance.intake and user answers carry their question and timestamp', async () => {
    const p = (await resolvedDraft()).provenance;
    const intake = { messages: p.intake };
    for (const f of Object.values(p.fields)) {
      if (f.pointer !== undefined) {
        expect(typeof f.quote).toBe('string');
        expect(groundQuote(intake, f.quote ?? '', f.pointer).ok).toBe(true);
      }
      for (const e of f.evidence ?? []) expect(groundQuote(intake, e.quote, e.pointer).ok).toBe(true);
      if (f.method === 'user_answer' || f.method === 'none_confirmed') {
        expect(f.question_id).toMatch(/^q\./);
        expect(f.answer).toBeDefined();
        expect(f.answered_at).toMatch(/^2026-10-24T12:/);
        expect(f.quote).toBeUndefined();
        expect(f.pointer).toBeUndefined();
      }
    }
    for (const request of [...p.requests.accepted, ...p.requests.not_included]) {
      expect(groundQuote(intake, request.quote, request.pointer).ok).toBe(true);
    }
  });

  it('raw source phrasing and unsupported terms stay in provenance and never enter agreement Markdown', async () => {
    const draft = await resolvedDraft();
    for (const raw of ["one month's rent", 'a small cat', 'enter without notice', 'It comes furnished']) {
      expect(provenanceJson(draft.provenance)).toContain(raw);
      expect(draft.markdown).not.toContain(raw);
    }
    expect(draft.markdown).toContain('msg:m2:85-101');
    expect(draft.markdown).toContain('q.monthly\\_rent.v1');
  });

  it('retains every utilities source needed to independently re-ground a value assembled across messages', () => {
    const texts = ['Tenants pay electricity and gas.', 'Water and internet are included.'];
    const f = ground(texts, [{ field: 'utilities', quote: 'Tenants pay electricity and gas' }]).fields.utilities;
    expect(f.state).toBe('valid');
    expect(f.value).toEqual(['electricity', 'gas']);
    const p = provenanceField(f);
    expect(p.evidence).toEqual([
      { quote: 'Tenants pay electricity and gas', pointer: ptr(texts[0] ?? '', 'Tenants pay electricity and gas') },
      { quote: 'Water and internet are included', pointer: 'msg:m2:0-31' },
    ]);
    const intake = intakeOf(...texts);
    for (const e of p.evidence ?? []) expect(groundQuote(intake, e.quote, e.pointer).ok).toBe(true);
  });

  it('canonical bytes are UTF-8 with no BOM and parse back through the closed provenance schema', async () => {
    const p = (await resolvedDraft()).provenance;
    const json = provenanceJson(p);
    expect(json).toBe(canonicalJson(p));
    expect(provenanceBytes(p)).toEqual(utf8Encode(json));
    expect(provenanceBytes(p).slice(0, 3)).not.toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
    expect(parseProvenance(JSON.parse(json))).toEqual({ ok: true, value: p });
    expect(sha256Hex(provenanceBytes(p))).toBe(sha256Hex(json));
  });

  it('rejects omitted fields, extra keys and invalid hashes without echoing payload text', async () => {
    const p = (await resolvedDraft()).provenance;
    const { landlord: omitted, ...fields } = p.fields;
    expect(omitted).toBeDefined();
    expect(parseProvenance({ ...p, fields }).ok).toBe(false);
    expect(parseProvenance({ ...p, extra: 'model-generated clause' }).ok).toBe(false);
    expect(parseProvenance({ ...p, library_hash: 'wrong' })).toEqual({ ok: false, error: 'provenance failed schema validation' });
  });

  it('regenerates identical bytes from a JSON copy of canonical matter state without extracting again', async () => {
    const state = answerAll(await extractScenario(fixture), fixture.expected.answers);
    const a = buildDraft(state, { lock: TEST_LOCK });
    const b = buildDraft(JSON.parse(JSON.stringify(state)), { lock: TEST_LOCK });
    if (!a.ok || !b.ok) throw new Error('expected drafts');
    expect(a.markdown).toBe(b.markdown);
    expect(a.provenanceBytes).toEqual(b.provenanceBytes);
  });
});
