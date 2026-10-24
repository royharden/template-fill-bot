# Evaluation results

**NOT MEASURED.** Construction source only; no generator, evaluator, mock replay, tests or model calls have run.

Method | Scope | Status
--- | --- | ---
regex | all; matched Jev-eligible fields | NOT MEASURED
llm | all; matched Jev-eligible fields | NOT MEASURED
jev | eligible candidate fields only | NOT MEASURED
free_draft_blind | paragraph equality and full gate | NOT MEASURED
free_draft_library | paragraph equality and full gate | NOT MEASURED
mock | offline fixture path; nonmeasurement | NOT MEASURED

Proposal: 40 generated scenarios from 20 bases with two phrasing variants each, plus 20 independently authored hand traps. Seeded stratification splits bases before variants into 30 dev / 30 held-out scenarios. `eval/gold/manifest.json` is pending, ungenerated and unfrozen. No held-out run has been attempted. Jev is not promoted.

No accuracy, wrong-fill, abstention, coverage, question, clause, unsupported-request, gate, strict paragraph mismatch, legal-content invention, boilerplate mismatch, render-blocking, provenance, injection, bootstrap, financial observation or latency measurements exist yet. Verified live prices are intentionally absent; missing prices/configuration refuse dispatch and produce incomplete rows. Unavailable predictions have no quality denominators; independently available conformance observations are separate. Financial reports distinguish observed charges, total reserved volume, settled spend and outstanding retained exposure; unknown values remain unavailable. Latency reports use observed-attempt and fully observed-matter denominators, with explicit missing, undispatched and replay counts. Default evaluation is offline. Live execution needs explicit later authorization, configured local non-VITE provider keys and reviewed prices. The cumulative persisted budget is at most USD 2, with at most USD 0.10 reserved per attempt; unknown charges remain reserved.

Runtime validation, gold generation/label review/freeze, actual provider contracts/prices, budget crash/concurrency behavior, and one frozen held-out evaluation remain deferred. Synthetic wording can overstate extraction quality. See the evaluator's generated failure-list markers in docs/LIMITATIONS.md after activation.
