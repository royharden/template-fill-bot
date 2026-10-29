import { FIELD_KEYS, FIELD_KIND_OF, UTILITY_CATEGORIES, METHOD_TOKENS } from '../../content/types.ts';
import type { FieldKey, LibraryContent, Predicate } from '../../content/types.ts';
import { canonicalJson } from '../canonicalJson.ts';
import { groundQuote } from '../cited.ts';
import { findAllCandidates, classifyUtilities, parseRelativeDepositText } from '../candidates/index.ts';
import { FIELD_SPECS, partyKey } from '../fields.ts';
import type { FieldValue } from '../fields.ts';
import { groundFields } from '../grounding.ts';
import type { Provenance } from '../provenance.ts';
import { GateReadError } from './xmlTokens.ts';

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
export function gatePredicate(p: Predicate, fields: Provenance['fields']): boolean {
  if (p === true) return true;
  if ('all' in p) return p.all.every((s) => gatePredicate(s, fields));
  if ('any' in p) return p.any.some((s) => gatePredicate(s, fields));
  if ('not' in p) return !gatePredicate(p.not, fields);
  if ('eq' in p) return fields[p.eq[0]].state === 'valid' && fields[p.eq[0]].value === p.eq[1];
  if ('present' in p) return fields[p.present].state === 'valid';
  if ('countGte' in p) { const f = fields[p.countGte[0]]; return f.state === 'valid' && Array.isArray(f.value) && f.value.length >= p.countGte[1]; }
  if ('nonEmpty' in p) { const f = fields[p.nonEmpty]; return f.state === 'valid' && Array.isArray(f.value) && f.value.length > 0; }
  if ('complementNonEmpty' in p) { const f = fields[p.complementNonEmpty]; return f.state === 'valid' && Array.isArray(f.value) && UTILITY_CATEGORIES.some((v) => !(f.value as string[]).includes(v)); }
  return false;
}
function fail(code: string): never { throw new GateReadError(code); }
function equalField(k: FieldKey, actual: unknown, expected: unknown): void { if (!same(actual, expected)) fail(`field_evidence_mismatch:${k}`); }
function endDate(start: string, months: number): string {
  const [y, m, d] = start.split('-').map(Number);
  const total = y * 12 + m - 1 + months, yy = Math.floor(total / 12), mm = total % 12;
  // Date.UTC handles years 0..99 specially; validated dates are restricted to 1900..2100.
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(yy, mm, Math.min(d, last)) - 86400000).toISOString().slice(0, 10);
}

/** Re-ground EVERY contributing span. Parsers/validators are shared; selection and cross-field rules are not. */
export function validateProvenanceValues(p: Provenance, content: LibraryContent): void {
  const ctx = { jurisdiction: content.jurisdiction }, intake = { messages: p.intake };
  const found = findAllCandidates(intake);
  // Candidate inventory supplies option-button semantics only, never selected document values.
  const inventory = groundFields({ intake, candidates: found.candidates, proposals: [], method: p.extractor_method, ctx }).fields;
  const codeCheck = groundFields({ intake, candidates: found.candidates, proposals: found.candidates.flatMap((c) => c.field === undefined ? [] : [{ field: c.field, quote: c.quote, pointer: c.pointer }]), method: p.extractor_method, ctx }).fields;
  const enumValues: Partial<Record<FieldKey, readonly string[]>> = { pets: ['none', 'with_consent'], smoking: ['prohibited', 'permitted_outside'], furnished: ['furnished', 'unfurnished'] };
  for (const k of FIELD_KEYS) {
    const f = p.fields[k], spec = FIELD_SPECS[k];
    const optional = k === 'guarantor' || k === 'break_month';
    if (!(f.state === 'valid' || (optional && f.state === 'none_confirmed'))) fail(`field_unresolved:${k}`);
    if (f.state === 'valid') {
      const r = spec.validate(f.value, ctx);
      if (!r.ok || !same(r.value, f.value)) fail(`field_invalid:${k}`);
    } else if (f.value !== undefined) fail(`none_has_value:${k}`);
    if (k !== 'end_date' && !(METHOD_TOKENS as readonly unknown[]).includes(f.method)) fail(`field_method:${k}`);
    const evidence = [...(f.evidence ?? [])];
    if (f.quote !== undefined || f.pointer !== undefined) {
      if (f.quote === undefined || f.pointer === undefined) fail(`field_span:${k}`);
      evidence.unshift({ quote: f.quote, pointer: f.pointer });
    }
    for (const e of evidence) if (!groundQuote(intake, e.quote, e.pointer).ok) fail(`field_ungrounded:${k}`);
    if (f.method === 'user_answer' || f.method === 'none_confirmed') {
      const a = f.answer;
      if (a === undefined || f.question_id === undefined || f.answered_at === undefined || evidence.length || f.relative_months !== undefined) fail(`answer_missing:${k}`);
      if (f.question_id !== spec.questionTemplate.id && !(optional && f.question_id === 'q.optional_terms.v1')) fail(`answer_question:${k}`);
      if (f.question_id === 'q.optional_terms.v1' && !['none','option','optional_terms'].includes(a.kind)) fail(`answer_kind:${k}`);
      let value: unknown;
      if (a.kind === 'none' || (a.kind === 'option' && a.option_id === 'none')) value = null;
      else if (a.kind === 'text') { const r = spec.parse(a.text, ctx); if (!r.ok) fail(`answer_parse:${k}`); value = r.value; }
      else if (a.kind === 'value') { const r = spec.validate(a.value, ctx); if (!r.ok) fail(`answer_parse:${k}`); value = r.value; }
      else if (a.kind === 'optional_terms') {
        if (!optional || f.question_id !== 'q.optional_terms.v1') fail(`answer_kind:${k}`);
        const v = a[k as 'guarantor' | 'break_month'];
        if (v === null) value = null;
        else { const r = typeof v === 'string' ? spec.parse(v, ctx) : spec.validate(v, ctx); if (!r.ok) fail(`answer_parse:${k}`); value = r.value; }
      } else if (a.kind === 'option') {
        let options: readonly FieldValue[] = enumValues[k] ?? inventory[k].candidates.map((c) => c.value);
        if (k === 'utilities') {
          const u = inventory.utilities.utilities;
          if (u === undefined) fail('answer_option:utilities');
          const tenant = UTILITY_CATEGORIES.filter((v) => u.tenant_pays.includes(v) && !u.included.includes(v));
          const unclassified = UTILITY_CATEGORIES.filter((v) => !u.tenant_pays.includes(v) && !u.included.includes(v));
          options = unclassified.length ? [tenant, UTILITY_CATEGORIES.filter((v) => tenant.includes(v) || unclassified.includes(v))] : [tenant];
        }
        if (k === 'end_date') options = [endDate(String(p.fields.start_date.value), Number(p.fields.term_months.value)), ...options];
        const unique = options.filter((v, i) => options.findIndex((o) => same(o, v)) === i);
        if (!/^o[1-9][0-9]*$/.test(a.option_id)) fail(`answer_option:${k}`);
        value = unique[Number(a.option_id.slice(1)) - 1];
        if (value === undefined) fail(`answer_option:${k}`);
      } else fail(`answer_kind:${k}`);
      if (value === null) {
        if (!optional || f.state !== 'none_confirmed' || f.method !== 'none_confirmed') fail(`answer_none:${k}`);
      } else {
        if (f.state !== 'valid' || f.method !== 'user_answer') fail(`answer_state:${k}`);
        equalField(k, f.value, value);
      }
      continue;
    }
    if (f.answer !== undefined || f.question_id !== undefined || f.answered_at !== undefined) fail(`unexpected_answer:${k}`);
    if (k === 'end_date' && f.method === 'computed') {
      for (const e of evidence) { const r = spec.parse(e.quote, ctx); if (!r.ok) fail(`field_parse:${k}`); equalField(k, f.value, r.value); }
      if (codeCheck.end_date.candidates.some((c) => c.ambiguous === true || !same(c.value, f.value)) || ['ambiguous','invalid','conflict'].includes(codeCheck.end_date.state)) fail('end_date_omitted_evidence');
      continue;
    }
    if (f.method !== p.extractor_method) fail(`field_method_mismatch:${k}`);
    if (!evidence.length || f.quote === undefined || f.pointer === undefined || f.method === 'computed') fail(`field_evidence_missing:${k}`);
    if (k === 'utilities') {
      const paid = new Set<string>(), included = new Set<string>();
      for (const e of evidence) {
        const r = classifyUtilities(e.quote);
        if (r === null || r.ambiguous) fail('utilities_evidence');
        r.tenant_pays.forEach((v) => paid.add(v)); r.included.forEach((v) => included.add(v));
      }
      if (found.candidates.some((c) => c.field === 'utilities' && !evidence.some((e) => e.pointer === c.pointer && e.quote === c.quote))) fail('utilities_omitted_evidence');
      if (UTILITY_CATEGORIES.some((v) => paid.has(v) === included.has(v))) fail('utilities_incomplete_or_conflicting');
      equalField(k, f.value, UTILITY_CATEGORIES.filter((v) => paid.has(v)));
    } else if (k === 'deposit' && f.relative_months !== undefined) {
      for (const e of evidence) {
        const r = parseRelativeDepositText(e.quote);
        if (r === null || r.months !== f.relative_months) fail('deposit_relative_evidence');
      }
      equalField(k, f.value, f.relative_months * Number(p.fields.monthly_rent.value));
    } else {
      if (f.relative_months !== undefined) fail(`unexpected_relative:${k}`);
      for (const e of evidence) {
        if (['name','nameList','address'].includes(FIELD_KIND_OF[k]) && !found.candidates.some((c) => c.field === k && c.kind === 'role' && c.pointer === e.pointer && c.quote === e.quote && !(c.flags ?? []).includes('ambiguous'))) fail(`field_role_payload:${k}`);
        const r = spec.parse(e.quote, ctx);
        if (!r.ok) fail(`field_parse:${k}`);
        equalField(k, f.value, r.value);
      }
    }
    // Code-found conflicting or ambiguous evidence must not disappear by editing provenance.
    const code = codeCheck[k];
    if (code.candidates.some((c) => c.ambiguous === true || !same(c.value, f.value)) && k !== 'utilities' && !(k === 'deposit' && f.relative_months !== undefined)) fail(`field_omitted_conflict:${k}`);
    if (['ambiguous','invalid','conflict'].includes(code.state)) fail(`field_omitted_problem:${k}`);
  }
  const get = (k: FieldKey): unknown => p.fields[k].value;
  if (get('end_date') !== endDate(String(get('start_date')), Number(get('term_months')))) fail('end_date_mismatch');
  if (Number(get('deposit')) * 52 > content.jurisdiction.deposit_cap_weeks * Number(get('monthly_rent')) * 12) fail('deposit_over_cap');
  const landlord = partyKey(String(get('landlord'))), tenants = (get('tenants') as string[]).map(partyKey);
  if (tenants.includes(landlord)) fail('tenant_is_landlord');
  if (p.fields.guarantor.state === 'valid' && [landlord, ...tenants].includes(partyKey(String(get('guarantor'))))) fail('guarantor_is_party');
  if (p.fields.break_month.state === 'valid' && (Number(get('break_month')) < 1 || Number(get('break_month')) >= Number(get('term_months')))) fail('break_month_out_of_range');
}

export function expectedClauses(p: Provenance, content: LibraryContent): readonly { id: string; version: number }[] {
  const accepted = new Set<string>(), ids = new Set<string>();
  for (const r of p.requests.accepted) {
    if (ids.has(r.id)) fail('request_duplicate'); ids.add(r.id);
    const c = content.clauses.find((c) => c.id === r.clause_id);
    if (c === undefined || c.category !== 'requestable' || !gatePredicate(c.applies, p.fields) || !groundQuote({ messages: p.intake }, r.quote, r.pointer).ok) fail('request_invalid');
    accepted.add(c.id);
  }
  for (const r of p.requests.not_included) {
    if (ids.has(r.id) || !groundQuote({ messages: p.intake }, r.quote, r.pointer).ok) fail('not_included_invalid');
    ids.add(r.id);
  }
  const clauses = content.clauses.filter((c) => gatePredicate(c.applies, p.fields) && (c.category !== 'requestable' || accepted.has(c.id))).slice().sort((a,b) => a.order - b.order).map((c) => ({ id: c.id, version: c.version }));
  if (!same(clauses, p.clauses)) fail('clause_selection_mismatch');
  return clauses;
}
