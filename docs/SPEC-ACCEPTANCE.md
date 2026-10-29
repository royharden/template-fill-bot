# Spec-to-source acceptance map

All rows mean authored and statically reviewed construction source, not executed acceptance. No install, test, typecheck, lint, build, application, generator, evaluator, provider, database or deployment check has run. The final operational status is recorded outside the product repository after the M8 review and local commit.

## MVP items 1–16

| Spec item | Source / authored tests | Construction disposition and deferred check |
|---|---|---|
| 1. Typed schema and fifteen fields | _shared/content/types.ts; fillkit/fields.ts, schema.ts; tests/unit/{fields,schema}.test.ts | Authored; type/runtime checks DV-TESTS |
| 2. Illustrative jurisdiction | content/jurisdiction.ts; README; tests/unit/content.test.ts | Authored, invented values; real law out of scope |
| 3. Authored fixed clause library and lock | content/{clauses,frame,library.lock}.ts; fillkit/library.ts; scripts/lock.ts; tests/unit/{content,lock}.test.ts | Twenty-seven clauses; lock deliberately UNLOCKED; DV-LOCK pending |
| 4. Code candidates and bounded intake | fillkit/normalize.ts, cited.ts, candidates/*; tests/unit/{normalize,cited,candidates}.test.ts | Twelve / 8,000 normalized UTF-16 units; source-only DV-M3 |
| 5. Regex/mock/LLM/Jev interface | fillkit/extractors/*; tests/unit/extractors.test.ts; tests/contract/modelExtractors.test.ts | Authored; Jev optional/eligible-only; DV-PROVIDERS |
| 6. Quote grounding and conflicts | fillkit/grounding.ts; tests/unit/{grounding,adversarial,optionalCuePipeline}.test.ts | Authored; no observed model score |
| 7. Cross-field validation | fillkit/validate.ts; tests/unit/validate.test.ts | Inclusive end date, deposit cap, distinct parties, break/due bounds; unexecuted |
| 8. Fixed questions and stored answers | fillkit/questions.ts; ui/QuestionPanel.tsx; tests/unit/{questions,demo01,demo02}.test.ts | Authored; all open questions block; UI/runtime pending |
| 9. Unsupported requests | fillkit/requests.ts; ui/ReviewScreen.tsx; tests/unit/requests.test.ts | Grounded, applicable requestables require confirmation; unsupported text stays out of agreement files |
| 10. Deterministic select/render | fillkit/{select,segments,renderMarkdown}.ts; tests/unit/{select,segments,renderMarkdown}.test.ts | Authored; default rendering blocked by DV-LOCK |
| 11. Independent final-file gate | fillkit/gate/*; docx/writeDocx.ts; tests/gate/*; tests/contract/gateBoundary.test.ts | Authored negative cases; ZIP/XML/Word compatibility/runtime pending |
| 12. Provenance | fillkit/provenance.ts; tests/unit/provenance.test.ts; tests/gate/evidence.test.ts | Source quotes in companion provenance JSON/UI; agreement appendix has validated values, pointers and hashes |
| 13. Review, approval and downloads | ui/*; rulings/approvals.ts; src/store/*; tests/unit/{approvals,uiReviewModel,uiDownload,jsonImportExport}.test.ts | Exact persisted revision/digest; human UI approval, keyless CLI synthetic approval only; DV-UI/DV-AUTH-BUFFERS |
| 14. Providers, ledger and authenticated function | providers/*; callledger/*; extract-fields/*; migrations/*; tests/contract/{handler,providers,supabaseStore,liveExtraction}.test.ts | Authored; no paid rates, secrets, DB or cloud readiness verified |
| 15. Evaluation and report | eval/*; _shared/evalkit/*; scripts/{gen-gold,eval}.ts; tests/eval/* | Source plus twenty hand traps; forty generated artifacts absent; manifest pending; NOT MEASURED |
| 16. Keyless mock path | fixtures/*; extractors/mock.ts; scripts/demo.ts; tests/unit/{demo01,demo02,adversarial}.test.ts | Authored; even mock execution deferred |

Paths beginning content/, fillkit/, providers/, callledger/ or docx/ are under supabase/functions/_shared. UI paths are under src; migration/function paths are under supabase. These shorthand paths identify actual files, not additional copies.

## Every static checklist line

| Static requirement | Actual source / test evidence | Status |
|---|---|---|
| tsc and eslint clean | tsconfig*.json, eslint.config.js; npm run typecheck/lint | Not run; DV-TESTS |
| Parser/validator/selection/renderer/grounding suites | tests/unit/* | Authored, not run |
| Adversarial fixtures and three final-byte gate negatives | fixtures/adversarial/*; tests/gate/{gate,docxSecurity,evidence}.test.ts | Authored, not run |
| Library lock hashes match content | scripts/lock.ts, library.ts, tests/unit/lock.test.ts | Deferred DV-LOCK; UNLOCKED sentinel intentionally fails closed |
| Ordered migrations with every-table RLS | migrations/202610240001_matters.sql, 202610240002_approvals.sql, 202610240003_usage.sql; tests/contract/sqlContracts.test.ts | SQL manually reviewed, not applied |
| No public-prefixed server secret | .env.example; lazy src/lib/supabase.ts; tests/contract/boundaries.test.ts | Only URL/anon key public; no real credentials authored |
| Intake limits in code and function | normalize.ts; extract-fields/handler.ts; tests/contract/handler.test.ts | Authored; raw byte and UTF-16 cap execution pending |
| Question for every unresolved field | questions.ts; optionalCuePipeline/demo/question tests | Authored; pending-dependency questions follow the planned coalescing policy |
| Provenance appendix and ledger tests | tests/unit/{provenance,callledger}.test.ts; gate/evidence.test.ts | Authored, not run |
| Dry-run default, no model until live | ui/{App,LiveWorkbench,AuthScreens}.tsx; liveExtraction.ts; boundaries/handler tests | Static flow reviewed; browser/network behavior unexecuted |
| Bolt inventory names target/function/secrets/checks | BOLT-HANDOFF.md; config.toml; function deno.json | Inventory complete for inspection only; all infrastructure checks pending |
| README opens with illustrative/not-legal-advice notice | README.md | Authored |
| Synthetic fixtures | fixtures/*, eval/gold/handtraps/*, eval/foreign/* | Self-authored fictional data; no real-person dataset used |
| No restrictive/unlicensed copied code or contract text | LICENSE, NOTICE, VENDORED.md; authored content | No copied templates; dependency license verification DV-INSTALL |

## Live checklist and plan deviations

The CLI demo, evaluation regeneration, frozen held-out run, UI blocking/download flow, actual gate pass/failure behavior, JWT rejection and cross-user isolation are all unexecuted. Exact steps are in DEFERRED-VALIDATION.md and BOLT-HANDOFF.md.

Accepted plan choices: canonical shared core with browser facade; typed content modules instead of JSON; handwritten minimal OOXML; pure synchronous SHA-256; an UNLOCKED sentinel until deliberate activation; raw quotes in the companion file; explicit optional-term confirmation; no optional Noul battery. None is a measured result or a reduction of the DOCX/gate/grounding/approval requirements.
