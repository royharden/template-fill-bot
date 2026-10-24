// Core orchestrator (PLAN sections 4.4-4.6, M3). Pure apart from awaiting the extractor.
//
//   runExtraction(messages, extractor)  -> MatterState (revision 1)       normalise, find candidates, extract,
//                                                                          zod-parse, ground, collect requests
//   deriveView(state)                   -> effective fields, open questions, accepted / Not-included requests
//   applyAnswer(state, questionId, answer, {clock}) -> new state (revision + 1)      (questions.ts)
//   confirmRequest(state, requestId, {clock})       -> new state (revision + 1)
//   buildDraft(state, {lock})           -> {ok:true, paragraphs, markdown, provenance, ...} | RenderBlocked
//
// buildDraft takes the library lock as a parameter defaulting to the COMMITTED lock, which is the UNLOCKED
// sentinel until DV-LOCK, so by default every draft is RenderBlocked{reasons:['library_unlocked', ...]}.
// Tests that need a successful render compute a lock in-test with computeLock(LIBRARY_CONTENT).
// The model is never re-called after extraction; the state alone regenerates the same draft bytes.
import { LIBRARY_LOCK } from '../content/library.lock.ts';
import type { FieldKey, LibraryContent, LibraryLock } from '../content/types.ts';
import { findAllCandidates } from './candidates/index.ts';
import { FIELD_SPEC_LIST } from './fields.ts';
import type { FieldContext } from './fields.ts';
import { groundFields } from './grounding.ts';
import type { GroundedField } from './grounding.ts';
import { LIBRARY_CONTENT } from './library.ts';
import { MATTER_STATE_VERSION } from './matter.ts';
import type { MatterDiagnostics, MatterState } from './matter.ts';
import { normaliseIntake } from './normalize.ts';
import type { IntakeError, IntakeMessageInput } from './normalize.ts';
import { buildProvenance, provenanceBytes } from './provenance.ts';
import type { Provenance } from './provenance.ts';
import { applyAnswer, buildQuestions } from './questions.ts';
import type { Question } from './questions.ts';
import { renderAgreement } from './renderMarkdown.ts';
import type { RenderBlocked } from './renderMarkdown.ts';
import { collectRequestItems, evaluateRequests, findResiduals } from './requests.ts';
import type { AcceptedRequest, NotIncludedItem, RequestOutcome } from './requests.ts';
import { parseExtractorOutput } from './schema.ts';
import type { FieldProposal, RequestProposal } from './schema.ts';
import type { Paragraph } from './segments.ts';
import { validateFields } from './validate.ts';
import type { Extractor } from './extractors/types.ts';
import { MockFixtureError } from './extractors/mock.ts';

export { applyAnswer };

export interface PipelineOptions {
  /** Library content; defaults to the committed content. */
  readonly content?: LibraryContent;
  /** Field context; defaults to the content's jurisdiction. */
  readonly ctx?: FieldContext;
}

function contentOf(opts: PipelineOptions): LibraryContent {
  return opts.content ?? LIBRARY_CONTENT;
}

export function contextOf(opts: PipelineOptions): FieldContext {
  return opts.ctx ?? { jurisdiction: contentOf(opts).jurisdiction };
}

export type RunExtractionResult =
  | { readonly ok: true; readonly state: MatterState }
  | { readonly ok: false; readonly error: IntakeError };

/** Normalise + limit-check the intake, run the extractor once, ground everything. */
export async function runExtraction(
  messages: readonly IntakeMessageInput[],
  extractor: Extractor,
  opts: PipelineOptions = {},
): Promise<RunExtractionResult> {
  const norm = normaliseIntake(messages);
  if (!norm.ok) return { ok: false, error: norm.error };
  const intake = { messages: norm.messages };
  const candidates = findAllCandidates(intake);

  let fieldProposals: FieldProposal[] = [];
  let requestProposals: RequestProposal[] = [];
  let droppedKeys: string[] = [];
  let droppedItems: string[] = [];
  let extractorError: string | null = null;
  try {
    const raw = await extractor.extract(intake, FIELD_SPEC_LIST, candidates);
    const parsed = parseExtractorOutput(raw);
    if (parsed.ok) {
      fieldProposals = parsed.value.fields;
      requestProposals = parsed.value.requests;
      droppedKeys = parsed.droppedKeys;
      droppedItems = parsed.droppedItems;
    } else {
      extractorError = 'output_schema';
    }
  } catch (error) {
    extractorError = error instanceof MockFixtureError ? `extract_failed:${error.code}` : 'extract_failed';
  }

  const grounding = groundFields({
    intake,
    candidates: candidates.candidates,
    proposals: fieldProposals,
    method: extractor.method,
    ctx: contextOf(opts),
  });
  const { items, drops } = collectRequestItems(intake, candidates.requests, requestProposals);
  const residuals = findResiduals(intake, candidates.candidates, fieldProposals);
  const diagnostics: MatterDiagnostics =
    extractorError === null
      ? { dropped_keys: droppedKeys, dropped_items: droppedItems, rejected_proposals: grounding.rejected, request_drops: drops }
      : {
          dropped_keys: droppedKeys,
          dropped_items: droppedItems,
          rejected_proposals: grounding.rejected,
          request_drops: drops,
          extractor_error: extractorError,
        };
  const state: MatterState = {
    schema_version: MATTER_STATE_VERSION,
    revision: 1,
    extractor_method: extractor.method,
    intake: norm.messages,
    fields: grounding.fields,
    request_items: items,
    residuals,
    confirmations: [],
    answers: [],
    diagnostics,
  };
  return { ok: true, state };
}

export interface MatterView {
  readonly revision: number;
  /** Effective field records (cross-field rules applied). */
  readonly fields: Readonly<Record<FieldKey, GroundedField>>;
  /** Open questions; every one blocks render. */
  readonly questions: readonly Question[];
  readonly requests: RequestOutcome;
}

export function deriveView(state: MatterState, opts: PipelineOptions = {}): MatterView {
  const content = contentOf(opts);
  const ctx = contextOf(opts);
  const fields = validateFields(state.fields, ctx);
  const questions = buildQuestions(fields, ctx);
  const requests = evaluateRequests({
    intake: { messages: state.intake },
    items: state.request_items,
    residuals: state.residuals,
    fields,
    confirmations: state.confirmations.map((c) => c.request_id),
    content,
  });
  return { revision: state.revision, fields, questions, requests };
}

export type ConfirmRequestResult =
  | { readonly ok: true; readonly state: MatterState }
  | { readonly ok: false; readonly error: { readonly code: 'not_confirmable' } };

export interface ConfirmRequestOptions extends PipelineOptions {
  readonly clock?: () => string;
}

/** Confirm a request item (only a `not_confirmed` + confirmable item); revision + 1. */
export function confirmRequest(state: MatterState, requestId: string, opts: ConfirmRequestOptions = {}): ConfirmRequestResult {
  const view = deriveView(state, opts);
  const item = view.requests.notIncluded.find((r) => r.id === requestId && r.confirmable && r.reason === 'not_confirmed');
  if (item === undefined) return { ok: false, error: { code: 'not_confirmable' } };
  const revision = state.revision + 1;
  const confirmedAt = (opts.clock ?? (() => new Date().toISOString()))();
  return {
    ok: true,
    state: {
      ...state,
      revision,
      confirmations: [...state.confirmations, { request_id: requestId, confirmed_at: confirmedAt, revision }],
    },
  };
}

export interface DraftOptions extends PipelineOptions {
  /** Library lock; defaults to the committed lock (the UNLOCKED sentinel until DV-LOCK). */
  readonly lock?: LibraryLock;
  readonly matterId?: string | null;
}

export interface Draft {
  readonly ok: true;
  readonly revision: number;
  readonly paragraphs: readonly Paragraph[];
  /** agreement.md text (canonical LF, no BOM). */
  readonly markdown: string;
  readonly provenance: Provenance;
  /** provenance.json bytes (canonical JSON, UTF-8, no BOM). */
  readonly provenanceBytes: Uint8Array;
  readonly contentHash: string;
  readonly clauses: readonly { readonly id: string; readonly version: number }[];
  readonly accepted: readonly AcceptedRequest[];
  readonly notIncluded: readonly NotIncludedItem[];
}

export type DraftResult = Draft | RenderBlocked;

/** Build the agreement Markdown + provenance for the current revision, or RenderBlocked with every reason. */
export function buildDraft(state: MatterState, opts: DraftOptions = {}): DraftResult {
  const content = contentOf(opts);
  const view = deriveView(state, opts);
  const r = renderAgreement({
    content,
    lock: opts.lock ?? LIBRARY_LOCK,
    fields: view.fields,
    questions: view.questions,
    acceptedClauseIds: view.requests.accepted.map((a) => a.clause_id),
    notIncludedCount: view.requests.notIncluded.length,
  });
  if (!r.ok) return r;
  let provenance: Provenance;
  try {
    provenance = buildProvenance({
      state,
      matterId: opts.matterId ?? null,
      fields: view.fields,
      clauses: r.clauses,
      accepted: view.requests.accepted,
      notIncluded: view.requests.notIncluded,
      lock: r.lock,
      contentHash: r.contentHash,
    });
  } catch {
    return { ok: false, reasons: ['provenance_invalid'] };
  }
  return {
    ok: true,
    revision: state.revision,
    paragraphs: r.paragraphs,
    markdown: r.markdown,
    provenance,
    provenanceBytes: provenanceBytes(provenance),
    contentHash: r.contentHash,
    clauses: r.clauses.map((c) => ({ id: c.id, version: c.version })),
    accepted: view.requests.accepted,
    notIncluded: view.requests.notIncluded,
  };
}
