// Requests (PLAN section 4.5): code detector candidates + extractor requests -> accepted / Not included.
// Pure. Request text NEVER enters the agreement files; only the count of Not-included items does (a locked
// frame sentence). Quotes live in provenance and the review UI.
//
// collectRequestItems: every extractor request must ground (quote at its pointer, or unique occurrence); an
// ungrounded one is dropped (index + reason only; its text is model-authored and is not kept). A grounded
// proposal that overlaps a code-detected sentence is merged into it: same clause id -> one item; a code item
// with no clause id takes the model's clause claim (once); otherwise a separate item.
// evaluateRequests: an item is ACCEPTED only if its clause id exists, the clause is `requestable`, its
// `applies` holds for the current effective fields, the quote still grounds, and the user confirmed the item
// (confirmation is matter state, per revision). Everything else is Not included with a reason. Residuals that
// the agreement cannot express are always Not included: the qualifier of an ambiguous pets cue ("a small
// cat") and the "for <name> only" part of a guarantor cue (K20).
import type { LibraryContent } from '../content/types.ts';
import { groundQuote, parsePointer } from './cited.ts';
import { classifyPets } from './candidates/index.ts';
import { trimSpan } from './candidates/text.ts';
import type { EvidenceSource, FieldRecords } from './grounding.ts';
import { comparePointers } from './grounding.ts';
import type { IntakeLike } from './normalize.ts';
import type { Candidate, FieldProposal, RequestCandidate, RequestProposal } from './schema.ts';
import { evaluatePredicate } from './select.ts';

export interface RequestItem {
  readonly id: string;
  readonly quote: string;
  readonly pointer: string;
  readonly clause_id: string | null;
  readonly sources: readonly EvidenceSource[];
  readonly detectors: readonly string[];
}

export interface RequestDrop {
  /** Index into the parsed extractor request list. */
  readonly index: number;
  readonly reason: string;
}

export const NOT_INCLUDED_REASONS = [
  'no_supported_clause',
  'unknown_clause',
  'not_requestable',
  'not_applicable',
  'not_confirmed',
  'quote_not_grounded',
  'pets_qualifier',
  'guarantor_partial',
] as const;
export type NotIncludedReason = (typeof NOT_INCLUDED_REASONS)[number];

export interface NotIncludedItem {
  readonly id: string;
  readonly reason: NotIncludedReason;
  readonly clause_id: string | null;
  readonly quote: string;
  readonly pointer: string;
  /** True when the user could include it by confirming (requestable, applicable, grounded). */
  readonly confirmable: boolean;
}

export interface AcceptedRequest {
  readonly id: string;
  readonly clause_id: string;
  readonly quote: string;
  readonly pointer: string;
}

export interface RequestOutcome {
  readonly accepted: AcceptedRequest[];
  readonly notIncluded: NotIncludedItem[];
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function overlaps(a: string, b: { message_id: string; start: number; end: number }): boolean {
  const p = parsePointer(a);
  return p !== null && p.message_id === b.message_id && p.start < b.end && b.start < p.end;
}

/** Merge code detector candidates and extractor request proposals into grounded request items. */
export function collectRequestItems(
  intake: IntakeLike,
  codeRequests: readonly RequestCandidate[],
  proposals: readonly RequestProposal[],
): { items: RequestItem[]; drops: RequestDrop[] } {
  const items: Mutable<RequestItem>[] = [];
  const modelClaimed = new Set<string>();
  for (const c of codeRequests) {
    const g = groundQuote(intake, c.quote, c.pointer);
    if (!g.ok) continue;
    items.push({ id: c.id, quote: c.quote, pointer: g.pointer, clause_id: c.clause_id, sources: ['code'], detectors: [...c.detectors] });
  }
  const drops: RequestDrop[] = [];
  proposals.forEach((p, index) => {
    const g = groundQuote(intake, p.quote, p.pointer ?? null);
    if (!g.ok) {
      drops.push({ index, reason: `ungrounded:${g.reason}` });
      return;
    }
    const over = items.filter((it) => overlaps(it.pointer, g));
    const addSource = (it: Mutable<RequestItem>): void => {
      if (!it.sources.includes('extractor')) it.sources = [...it.sources, 'extractor'];
    };
    const same = over.find((it) => it.clause_id === p.clause_id);
    if (same !== undefined) {
      addSource(same);
      return;
    }
    const open = over.find((it) => it.clause_id === null && it.sources.includes('code') && !modelClaimed.has(it.id));
    if (open !== undefined && p.clause_id !== null) {
      open.clause_id = p.clause_id;
      modelClaimed.add(open.id);
      addSource(open);
      return;
    }
    let id = `request:${g.message_id}:${g.start}-${g.end}${p.clause_id === null ? '' : `#${p.clause_id}`}`;
    if (items.some((it) => it.id === id)) id = `${id}#x${index}`;
    items.push({ id, quote: p.quote, pointer: g.pointer, clause_id: p.clause_id, sources: ['extractor'], detectors: [] });
  });
  items.sort((a, b) => comparePointers(intake, a.pointer, b.pointer) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { items, drops };
}

/** "for" / "only" in a guarantor payload marks a partial guarantee (same rule as candidates/roles.ts). */
const PARTIAL_GUARANTEE_RE = /(?<!\p{L})(?:for|only)(?!\p{L})/iu;

function residual(id: string, reason: NotIncludedReason, quote: string, pointer: string): NotIncludedItem {
  return { id, reason, clause_id: null, quote, pointer, confirmable: false };
}

/**
 * Residual text that the agreement cannot express (always Not included): the qualifier of an ambiguous pets
 * cue and the partial part of a guarantor cue. From code candidates and grounded pets proposals.
 */
export function findResiduals(
  intake: IntakeLike,
  candidates: readonly Candidate[],
  fieldProposals: readonly FieldProposal[] = [],
): NotIncludedItem[] {
  const out = new Map<string, NotIncludedItem>();
  const add = (reason: NotIncludedReason, messageId: string, text: string, start: number, end: number): void => {
    const span = trimSpan(text, start, end);
    if (span.end <= span.start) return;
    const pointer = `msg:${messageId}:${span.start}-${span.end}`;
    if (!out.has(pointer)) out.set(pointer, residual(`residual:${pointer}`, reason, text.slice(span.start, span.end), pointer));
  };
  const textOf = (messageId: string): string | null => intake.messages.find((m) => m.id === messageId)?.text_normalised ?? null;

  for (const c of candidates) {
    const p = parsePointer(c.pointer);
    if (p === null) continue;
    const text = textOf(p.message_id);
    if (text === null) continue;
    if (c.field === 'pets' && c.residual !== undefined) {
      const rp = parsePointer(c.residual.pointer);
      if (rp !== null && rp.message_id === p.message_id) add('pets_qualifier', p.message_id, text, rp.start, rp.end);
    } else if (c.field === 'guarantor' && c.kind === 'role' && c.value === null) {
      const m = PARTIAL_GUARANTEE_RE.exec(c.quote);
      if (m !== null) add('guarantor_partial', p.message_id, text, p.start + m.index, p.end);
    }
  }
  for (const fp of fieldProposals) {
    if (fp.field !== 'pets' || fp.quote === undefined) continue;
    const g = groundQuote(intake, fp.quote, fp.pointer ?? null);
    if (!g.ok) continue;
    const cls = classifyPets(fp.quote);
    const text = textOf(g.message_id);
    if (cls === null || cls.residual === null || text === null) continue;
    add('pets_qualifier', g.message_id, text, g.start + cls.residual.start, g.start + cls.residual.end);
  }
  return [...out.values()].sort((a, b) => comparePointers(intake, a.pointer, b.pointer) || (a.id < b.id ? -1 : 1));
}

export interface RequestEvaluationInput {
  readonly intake: IntakeLike;
  readonly items: readonly RequestItem[];
  readonly residuals: readonly NotIncludedItem[];
  /** EFFECTIVE field records (validate.ts). */
  readonly fields: FieldRecords;
  /** Request item ids the user confirmed (MatterState.confirmations). */
  readonly confirmations: readonly string[];
  readonly content: LibraryContent;
}

export function evaluateRequests(input: RequestEvaluationInput): RequestOutcome {
  const confirmed = new Set(input.confirmations);
  const accepted: AcceptedRequest[] = [];
  const notIncluded: NotIncludedItem[] = [];
  const ni = (it: RequestItem, reason: NotIncludedReason, confirmable = false): void => {
    notIncluded.push({ id: it.id, reason, clause_id: it.clause_id, quote: it.quote, pointer: it.pointer, confirmable });
  };
  for (const it of input.items) {
    const g = groundQuote(input.intake, it.quote, it.pointer);
    if (!g.ok) {
      ni(it, 'quote_not_grounded');
      continue;
    }
    if (it.clause_id === null) {
      ni(it, 'no_supported_clause');
      continue;
    }
    const clause = input.content.clauses.find((c) => c.id === it.clause_id);
    if (clause === undefined) {
      ni(it, 'unknown_clause');
      continue;
    }
    if (clause.category !== 'requestable') {
      ni(it, 'not_requestable');
      continue;
    }
    if (!evaluatePredicate(clause.applies, input.fields)) {
      ni(it, 'not_applicable');
      continue;
    }
    if (!confirmed.has(it.id)) {
      ni(it, 'not_confirmed', true);
      continue;
    }
    accepted.push({ id: it.id, clause_id: clause.id, quote: it.quote, pointer: it.pointer });
  }
  notIncluded.push(...input.residuals);
  notIncluded.sort((a, b) => comparePointers(input.intake, a.pointer, b.pointer) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { accepted, notIncluded };
}
