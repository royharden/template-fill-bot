import { FIELD_SPECS, OPTIONAL_TERMS_QUESTION_ID, approvalMatches, deriveView, groundQuote, parsePointer, runExtraction } from '../core/index.ts';
import type { Bundle, BundleApproval, Extractor, GroundedField, IntakeMessageInput, MatterState, NormalisedMessage, Question } from '../core/index.ts';
import type { Store } from '../store/Store.ts';

export interface EvidenceSpan { readonly quote: string; readonly pointer: string; }
export interface HighlightPart { readonly text: string; readonly highlighted: boolean; }

export function fieldEvidence(field: GroundedField): EvidenceSpan[] {
  const spans: EvidenceSpan[] = [...field.candidates, ...(field.evidence ?? [])];
  if (field.quote !== undefined && field.pointer !== undefined) spans.push({ quote: field.quote, pointer: field.pointer });
  if (field.relative) spans.push(field.relative);
  return spans.filter((span, index) => spans.findIndex((other) => other.pointer === span.pointer && other.quote === span.quote) === index);
}

/** UTF-16 offsets from validated pointers; no HTML interpretation, substring search or quote replacement. */
export function highlightParts(message: NormalisedMessage, spans: readonly EvidenceSpan[]): HighlightPart[] {
  const ranges = spans.flatMap((span) => {
    if (!groundQuote({ messages: [message] }, span.quote, span.pointer).ok) return [];
    const p = parsePointer(span.pointer);
    return p ? [{ start: p.start, end: p.end }] : [];
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const prior = merged.at(-1);
    if (prior && range.start <= prior.end) prior.end = Math.max(prior.end, range.end);
    else merged.push({ ...range });
  }
  const out: HighlightPart[] = [];
  let cursor = 0;
  for (const range of merged) {
    if (range.start > cursor) out.push({ text: message.text_normalised.slice(cursor, range.start), highlighted: false });
    out.push({ text: message.text_normalised.slice(range.start, range.end), highlighted: true });
    cursor = range.end;
  }
  if (cursor < message.text_normalised.length) out.push({ text: message.text_normalised.slice(cursor), highlighted: false });
  return out;
}

/** Past answers remain editable through the same core applyAnswer API. No synthetic option ids. */
export function answeredQuestions(state: MatterState): Question[] {
  const view = deriveView(state);
  const ids = [...new Set(state.answers.map((a) => a.question_id))];
  return ids.filter((id) => !view.questions.some((q) => q.id === id)).map((id) => {
    const answer = state.answers.filter((a) => a.question_id === id).at(-1)!;
    const optional = id === OPTIONAL_TERMS_QUESTION_ID;
    return {
      id, kind: optional ? 'optional_terms' : 'field', fields: answer.fields,
      text: optional ? 'Review the guarantor and break-clause terms you confirmed.' : FIELD_SPECS[answer.fields[0]].questionTemplate.text,
      reasons: [], options: [], manual_entry: true, blocking: true,
    };
  });
}

export function canDownload(bundle: Bundle | null, approval: BundleApproval | null, matterId: string | null, state: MatterState | null, dirty: boolean): boolean {
  return !dirty && bundle !== null && bundle.gate.ok && approval !== null && matterId !== null && state !== null && approvalMatches(approval, bundle, matterId, state.revision);
}

/** Intake edits retain the matter and advance its persisted revision; New matter starts revision 1. */
export async function extractMatter(store: Store, messages: readonly IntakeMessageInput[], extractor: Extractor, existingId: string | null = null): Promise<{ matterId: string; state: MatterState }> {
  const extracted = await runExtraction(messages, extractor);
  if (!extracted.ok) throw new Error(extracted.error.code);
  const matterId = existingId ?? (await store.createMatter({ title: `Tenancy draft · ${extractor.method}` })).id;
  const latest = await store.getState(matterId);
  const state = { ...extracted.state, revision: (latest?.revision ?? 0) + 1 };
  await store.saveState(matterId, state);
  return { matterId, state };
}
