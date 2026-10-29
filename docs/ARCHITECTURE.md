# Architecture

This describes authored source, not an executed or deployed system. The product repository is self-contained; outer planning, reviews, transcripts and backups are private coordination records.

## Canonical core

The canonical runtime-neutral code is under supabase/functions/_shared. Browser consumers import its public surface through src/core/index.ts. Content, grounding, validation, questions, deterministic rendering and the gate have one source copy. Server LLM/Jev factories and provider/ledger modules are outside the browser import graph.

    normalized messages -> candidates -> extractor proposals -> schema/grounding
        -> cross-field validation -> questions/answers -> canonical revision
        -> clause selection -> typed paragraphs -> Markdown + DOCX
        -> independent final-byte gate -> bundle digest -> approval -> checked download

Normalization uses NFC and explicit UTF-16 offsets, strips the specified zero-width characters and rejects other control/bidi/format inputs. Code derives values from cited spans and retains distinct conflicting values. User answers use the same parsers and validators. Aggregated utility classifications retain all contributing evidence. Relative deposit and inclusive end-date arithmetic stay in code.

## Content and export

content/ contains the fifteen-field inventory, illustrative jurisdiction, twenty-seven self-authored clauses, fixed frame records and an UNLOCKED library.lock.ts sentinel. scripts/lock.ts is the deliberate activation/change tool. Hashes cover canonical full records, frame and jurisdiction; runtime never regenerates the lock.

fillkit/segments.ts creates typed paragraph segments. renderMarkdown.ts escapes values; docx/writeDocx.ts emits seven fixed-order parts with deterministic metadata/timestamps. Raw quotes and normalized intake belong in provenance.json and the review UI, not agreement files.

fillkit/gate/ imports neither the selector, segment builder, Markdown renderer nor DOCX writer. It owns predicate evaluation, expected paragraph reconstruction and a bounded closed-vocabulary ZIP/XML reader. It revalidates field/answer/evidence semantics, cross-field rules and requested clauses, then compares the final Markdown and DOCX paragraphs. ZIP local/central metadata, declared and counted expansion, CRCs, relationship/part vocabulary and hidden-text constructs are checked in source. Execution and compatibility remain deferred.

bundle.ts hashes agreement.md, agreement.docx and provenance.json into a canonical manifest; its digest binds the whole bundle. rulings/approvals.ts verifies retained bytes, regenerates from the current persisted state, re-gates and checks the exact revision/digest before returning byte copies. New revisions require new approval.

## Workbench and state

src/ui/App.tsx owns the active matter, source draft, epoch guards and mode. ReviewScreen, QuestionPanel, SourceHighlight and ApprovalBar implement the review journey; AdversarialDemo uses detached synthetic samples. Source evidence is rendered as text nodes. Unsaved edits invalidate active bundle/approval eligibility; same-matter re-extraction appends a higher revision.

Store.ts has MemoryStore and SupabaseStore implementations. Snapshots are immutable. JSON interchange validates canonical state and strips approvals; legitimate intake revision gaps do not imply missing answer events. Auth/mode scope resets clear tenant-sensitive buffers and suppress stale async results.

LiveWorkbench initializes authentication only after explicit Live activation. AuthScreens implements signup, signin, logout, session verification and recovery/password reset. A server-provider disclosure and user confirmation precede extraction. Actual auth, browser lifecycle and account-boundary behavior are unverified.

## Database and extraction boundary

Three ordered migrations provide matters/messages/fields/matter_state, approvals and usage/quota tables. Every table has RLS. save_matter_state atomically projects a canonical snapshot; approve_bundle attributes actor/time in SQL; delete_matter removes facts while detaching retained hash-only audit links. Quota and ledger mutations use service-only authority.

The extraction function has verify_jwt=true and independent auth.getUser validation. Reads use the caller's JWT/RLS, while service authority is confined to quota/ledger operations. It checks raw request bytes, strict DTOs, ownership, normalized intake and revisions. It reserves a full serialized-wire bound before dispatch, requires dispatch===true, settles conservatively and retains unknown outcomes. Automatic retries are disabled. No deployed free-draft route exists.

The live client persists an intake snapshot first; the function returns grounded state at the next revision; the client validates identity/intake/revision/session before appending that state. Current paid prices are absent, so live paid extraction fails price_missing until reviewed activation.

## Evaluation

Pure evalkit modules hold labels, splits, metric families and bootstrap logic. Node-only eval/ modules handle files, frozen manifests, hash-verified caches and a local exclusive-lock/hash-chained budget journal. The journal is authoritative; state.json is disposable. Caller-known attempt IDs allow reconciliation after reserve/finalization failure. Unobservable financial state remains null; it never authorizes another dispatch.

Base scenarios are partitioned before phrasing variants. Manifest/protocol freezing and an exclusive held-out claim prevent silent reuse. The committed manifest is pending and generated scenarios do not exist yet.

Quality eligibility is distinct from independently observed conformance/security checks. Reports separate unknown/observed timing, new provider charge, reserved volume, settled spend, retained exposure and cache history. Free-draft adapters are eval-only: strict clause-equality diagnostics remain alongside exact known boilerplate mismatch and legal-content invention counts. Missing configuration/budget/results remain explicit incomplete rows.

The future report writer updates only the marked failure-list region of LIMITATIONS.md. No measurements have been produced. See eval/README.md and DEFERRED-VALIDATION.md for activation and audit constraints.
