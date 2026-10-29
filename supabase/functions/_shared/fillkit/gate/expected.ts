// Independent paragraph reconstruction. Never imports renderer/selection/segment/writer modules.
import { FIELD_KEYS, FIELD_KIND_OF, UTILITY_CATEGORIES } from '../../content/types.ts';
import type { FieldKey, LibraryContent, LockedLibraryLock, PlaceholderSpec } from '../../content/types.ts';
import { canonicalJson } from '../canonicalJson.ts';
import { sha256Hex } from '../hash.ts';
import type { Provenance } from '../provenance.ts';
import type { ReadParagraph } from './xmlTokens.ts';
import { GateReadError } from './xmlTokens.ts';
import { expectedClauses } from './rules.ts';

export function expectedParagraphs(p: Provenance, content: LibraryContent, lock: LockedLibraryLock): ReadParagraph[] {
  const frame = (id: string): string => { const f = content.frame.find((f) => f.id === id); if (!f) throw new GateReadError('frame_missing'); return f.text; };
  const join = (items: readonly string[]): string => items.reduce((s,v,i) => s + (i ? frame(i === items.length - 1 ? 'join-list-final' : 'join-list-separator') : '') + v, '');
  const scalar = (key: FieldKey): string => {
    const value = p.fields[key].value;
    if (value === undefined) return '';
    const kind = FIELD_KIND_OF[key];
    if (kind === 'nameList' || kind === 'enumSet') return join(value as string[]);
    if (kind === 'money') {
      const n = Number(value), pounds = String(Math.floor(n / 100));
      const grouped = pounds.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      return `${content.jurisdiction.currency.symbol}${grouped}.${String(n % 100).padStart(2, '0')}`;
    }
    if (kind === 'date' || kind === 'computed') {
      const [y,m,d] = String(value).split('-');
      return `${Number(d)} ${['January','February','March','April','May','June','July','August','September','October','November','December'][Number(m)-1]} ${y}`;
    }
    return String(value);
  };
  const replacement = (spec: PlaceholderSpec): string => {
    if (spec.source === 'field') return scalar(spec.name as FieldKey);
    if (spec.source === 'jurisdiction') return String(content.jurisdiction[spec.name as keyof typeof content.jurisdiction]);
    if (spec.name === 'tenants_list') return scalar('tenants');
    if (spec.name === 'rent_due_day_ordinal') {
      const n = Number(p.fields.rent_due_day.value), last = n % 100;
      return `${n}${last >= 11 && last <= 13 ? 'th' : ['th','st','nd','rd'][n % 10] ?? 'th'}`;
    }
    const paid = p.fields.utilities.value as string[];
    if (spec.name === 'utilities_tenant_list') return join(UTILITY_CATEGORIES.filter((v) => paid.includes(v)));
    if (spec.name === 'utilities_included_list') return join(UTILITY_CATEGORIES.filter((v) => !paid.includes(v)));
    throw new GateReadError('unknown_placeholder');
  };
  const fill = (text: string, specs: readonly PlaceholderSpec[]): string => {
    let out = '', pos = 0;
    const re = /\{\{([a-z_][a-z0-9_]*)\}\}/g;
    for (const m of text.matchAll(re)) {
      out += text.slice(pos, m.index);
      const spec = specs.find((s) => s.name === m[1]);
      if (!spec) throw new GateReadError('placeholder_unbound');
      out += replacement(spec); pos = (m.index ?? 0) + m[0].length;
    }
    out += text.slice(pos);
    if (out.includes('{{') || out.includes('}}') || /[\r\n]/.test(out)) throw new GateReadError('leftover_placeholder');
    return out;
  };
  const clauses = expectedClauses(p, content).map((ref) => content.clauses.find((c) => c.id === ref.id)!);
  const body: ReadParagraph[] = [{ style: 'Title', text: frame('title') }, { style: 'Normal', text: frame('draft-notice') }, { style: 'Normal', text: frame('jurisdiction-notice') }];
  const headings = content.frame.filter((f) => f.kind === 'heading').slice().sort((a,b) => (a.from_order ?? 0) - (b.from_order ?? 0));
  let previous = '';
  for (const c of clauses) {
    const h = headings.filter((h) => (h.from_order ?? Infinity) <= c.order).at(-1);
    if (h && h.id !== previous) { body.push({ style: 'Heading1', text: h.text }); previous = h.id; }
    body.push({ style: 'Normal', text: fill(c.text, c.placeholders) });
  }
  const n = p.requests.not_included.length;
  if (n === 1) body.push({ style: 'Normal', text: frame('requests-not-included-one') });
  else if (n > 1) {
    const t = frame('requests-not-included-many').split('{{n}}');
    if (t.length !== 2) throw new GateReadError('request_count_template');
    body.push({ style: 'Normal', text: t[0] + String(n) + t[1] });
  }
  const hash = sha256Hex(canonicalJson(body.map((b) => [b.style, b.text])));
  if (p.content_hash !== hash) throw new GateReadError('content_hash_mismatch');
  const out = [...body, { style: 'Heading1', text: frame('appendix-heading') }, { style: 'Appendix', text: frame('appendix-label-field-values') }];
  const row = (cells: readonly string[]): void => { out.push({ style: 'Appendix', text: cells.join(frame('join-list-separator')) }); };
  row(['appendix-label-field','appendix-label-value','appendix-label-method','appendix-label-pointer'].map(frame));
  for (const k of FIELD_KEYS) if (k !== 'end_date') {
    const f = p.fields[k];
    row([k, scalar(k), String(f.method), (f.method === 'user_answer' || f.method === 'none_confirmed' ? f.question_id : f.pointer) ?? '']);
  }
  row([frame('appendix-label-clauses'), frame('appendix-label-clause-version')]);
  for (const c of clauses) row([c.id, String(c.version)]);
  row([frame('appendix-label-library-hash'), lock.overall]);
  row([frame('appendix-label-jurisdiction-hash'), lock.jurisdiction]);
  row([frame('appendix-label-content-hash'), hash]);
  return out;
}
