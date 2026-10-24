# Bolt infrastructure handoff: Accord / Template-Filling Bot

## Target and readiness

- Repository: inner `template-fill-bot` local Git repository; no remote; do not push or import under this construction grant. Use the owner-selected reviewed revision in a future authorized import.
- App root: repository root (the outer shell with planning/agent records is not application source).
- Database: **Bolt Database**, Supabase-compatible. Do not provision a separate Supabase project first.
- Target: intended fresh app; actual connection and applied baseline **Unknown**. Inspect existing history/schema before proposing any change; preserve any existing populated connection.
- Hosting: proposed Bolt hosting; publication **prepare only**. Bolt action **INSPECT AND PREPARE ONLY**.
- Status: source authored in Dirty Mode; implementation/runtime readiness unverified; infrastructure pending. No install, build, tests, provider call, migration or deployment has run. Package pins are proposals; no lockfile yet. Committed library lock is deliberately UNLOCKED, so agreement rendering/download remains blocked until deliberate activation.
- Owner prerequisites: authorize import/provisioning separately; provide intended account/connection, email settings, provider accounts/keys, exact supported model IDs, current verified billing rates and tokenizer/reservation bounds. No real personal data is required for validation.

## Build and connection

| Item | Command or configuration |
|---|---|
| Runtime/package manager | Node >=22.13.0, npm; Deno-compatible edge runtime; exact deployment versions pending |
| Install/dev | Initial authorized `npm install` creates/reviews package-lock.json; thereafter `npm ci`; `npm run dev` only in an allocated agent-ports lane |
| Build/output | `npm run build` → `dist/`; unexecuted |
| Type/lint/tests | `npm run typecheck`, `npm run lint`, `npm test`; all pending; edge additionally `deno check --config supabase/functions/extract-fields/deno.json supabase/functions/extract-fields/index.ts` |
| Client/public configuration | `src/lib/supabase.ts`; `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` only |
| Missing configuration | Default demo works in memory without initializing a client/auth/network; explicit Live shows setup guidance; missing live configuration fails without fabricated output |
| Content activation | Authorized `npm run lock`, review/commit generated lock; never auto-relock at runtime |

## Database

| Order | Migration | Resources/dependencies | Applied status |
|---|---|---|---|
| 1 | `supabase/migrations/202610240001_matters.sql` | matters, messages, fields, immutable matter_state; ownership RLS; UTF-16 caps/revision guards; authenticated `save_matter_state` | Pending; baseline Unknown |
| 2 | `supabase/migrations/202610240002_approvals.sql` | append-only approvals; authenticated `approve_bundle`, `delete_matter`; deletion detaches audit links | Pending |
| 3 | `supabase/migrations/202610240003_usage.sql` | call_ledger, call_reservations, quota_windows, quota_install; service-only `reserve_attempt`, `settle_attempt`; immutable redacted ledger | Pending |

- Private per-user data. Authenticated clients read own matter and parent-owned child rows through RLS. Atomic snapshot RPC writes canonical state and projections together. No anonymous matter access. Approval identity/time are assigned by SQL, never trusted from browser input.
- Browser clients never use service-role credentials or quota RPCs. Edge reads intake with the caller JWT/RLS; service client is limited to quota admission/settlement and ledger insertion.
- Snapshot hashes record actual content hashes even while rendering is UNLOCKED; a hash calculation never authorizes a render. Historical snapshots are insert-only; current projection changes invalidate prior approval.
- Required extensions: no application-created extension; verify platform UUID/auth/PostgreSQL facilities. Realtime and seeds not required; bundled synthetic fixtures are separate from schema.
- Retry rule: inspect migration tracking and schema/RPC/policy drift; apply only pending migrations after separate authorization. Do not replay destructive changes, drop/recreate data, or repair the migration ledger to conceal drift. Verify a timeout outcome before retrying.

## Functions

| Name/source | Caller/auth | Input/output | Resources | Deploy config |
|---|---|---|---|---|
| `extract-fields`; `supabase/functions/extract-fields/index.ts` | Signed-in user JWT; gateway verify_jwt=true plus auth.getUser; RLS-scoped intake read | Strict `{request_id,matter_id,revision,method:'llm'|'jev',fields?}`; ≤16 KiB bytes. Returns grounded state at revision+1, fields/requests and redacted ledger receipt; error envelope `{error:{code,message,retryable},request_id}` | tables/RPCs above; server provider secrets below | `supabase/config.toml`; per-function `deno.json` pins zod@3.23.8, fflate@0.8.2, supabase-js@2.45.4; verify bundling of `_shared/` |

- CORS: exact comma-separated `ALLOWED_ORIGINS`; POST/OPTIONS; authorization, apikey, content-type, x-client-info headers. No wildcard. CORS is not auth.
- Intake is re-normalized (≤12 messages, ≤8,000 normalized UTF-16 code units); invalid input, cross-user/nonexistent matter, stale revision and extra DTO keys fail closed. Revision/intake rechecked after provider call. No free-draft or generation route exists in the product function.
- Paid call: price exact provider/model against dated verified table; reserve full serialized wire-body byte bound plus framing allowance and capped output before dispatch; atomic per-minute/per-user/day/install limits. Dispatch only on `dispatch === true`; duplicate/conflicting request IDs never redispatch. Zero automatic retries. Unknown costs/outcomes retain full reservation; ledger stores IDs/hashes/numeric usage only. Operator must verify the conservative tokenizer/billing bound before enabling paid rates.
- **Paid models currently fail `price_missing`**: the committed table has only an explicitly labelled mock row. Do not insert guessed rates or bypass caps for deployment. API shapes, models and prices need DV-PROVIDERS verification. TypeSafe wire shape remains an explicit local-guide assumption.
- Platform credentials: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` must be platform-injected/verified; never expose service role to browser.
- Webhooks not required.

## Server configuration/secrets through settings (names only)

| Names | Consumer | Requirement/owner source |
|---|---|---|
| `ANTHROPIC_API_KEY` | extract-fields, anthropic adapter | Required only for selected Anthropic LLM; owner provider account |
| `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL` | extract-fields, compatible adapter | Required only for selected HTTPS compatible endpoint; owner verifies receiver/API compatibility |
| `TYPESAFE_API_KEY` | extract-fields, TypeSafe adapter | Optional Jev feature; required when Jev is used |
| `EXTRACT_PROVIDER_LLM` | server selector | `anthropic` (default) or `openai_compatible`; not browser-controlled |
| `EXTRACT_MODEL_LLM`, `EXTRACT_MODEL_JEV` | server selector | Exact configured IDs; no default guessed model. Proposed Jev ID jev-1.13.0 is unverified |
| `RATE_PER_MIN_USER`, `MAX_ATTEMPT_USD`, `DAILY_USER_USD`, `DAILY_INSTALL_USD` | trusted admission configuration | Defaults 5 / 0.10 / 0.50 / 2.00 USD; confirm intended budget |
| `PROVIDER_TIMEOUT_MS`, `ALLOWED_ORIGINS` | handler/provider | Timeout defaults 20000 ms; origins must name intended frontend URLs |

Missing secrets/configuration produce explicit 503 errors. Backend secrets never receive public `VITE_` prefixes. Provider receiver disclosure names server-configured candidates (Anthropic or operator-compatible endpoint; TypeSafe for Jev); operator must confirm the actual compatible endpoint before personal data is entered.

## Auth, storage and external steps

- Email/password signup/signin/logout/session verification/recovery/reset UI is implemented in `AuthScreens.tsx`, mounted only by explicit Live activation. Configure email confirmation/delivery, Site URL and exact frontend root URL in redirect allowlist. Recovery returns to that URL; select Live and set the new password. Confirm real flows after hosting choice.
- Buckets/storage: **Not required**. No file upload feature.
- Realtime: **Not required**. Schedules/background workers/long jobs: **Not required**.
- Outside services: selected LLM account and optional TypeSafe account; owner enters secrets through server settings. Verify current structured-output and Jev Choice contracts and model billing before enabling.
- Real adapter source: Anthropic, OpenAI-compatible, TypeSafe. Explicit offline demos: mock fixture replay and deterministic regex; neither is live measurement.

## Acceptance checks and receipts

| Check | Expected result | Outcome |
|---|---|---|
| Install/pins/type/lint/build | reviewed lockfile; frontend and edge checks pass | Pending |
| Library lock/demo/DOCX | reviewed lock hashes; deterministic bundle; Word/LibreOffice compatibility; independent gate | Pending; UNLOCKED blocks rendering |
| Schema/RPCs | migration order, immutable snapshots/approvals, quota concurrency and deletion audit preservation | Pending |
| Auth/two-user isolation | anonymous rejected; B cannot read/change A data; signup/signin/logout/recovery correct | Pending |
| Function/UI round trip | intake saved first; JWT caller; grounded next snapshot saved; stale results rejected | Pending |
| Missing secrets/prices | actionable bounded failure with no prompt/secret disclosure and zero paid dispatch | Pending |
| Provider/budget cases | verified API/models/rates; caps; duplicate no redispatch; unknown holds reservation; no retries | Pending |
| CORS/boundaries | allowed preflight only; provider/ledger excluded from browser graph; pinned Deno dependencies | Pending |
| Deployment/_shared bundling | deploy package resolves shared imports and per-function deno.json | Pending |
| Storage/webhooks/jobs | Not required | Not applicable |
| Publish | separately authorized final URL/auth checks | Pending; not authorized by this handoff |

All checks are pending; source tests are specifications until executed after Dirty Mode closes. See `docs/DEFERRED-VALIDATION.md` for the project-wide activation ledger.

## One prompt after a future authorized GitHub import

> **INSPECT AND PREPARE ONLY.** Read BOLT-HANDOFF.md and inspect the owner-selected reviewed source revision. Target **Bolt Database**; do not provision a separate Supabase project. Compare the implemented inventory with the imported files, inspect authorized read-only migration history/schema to resolve the Unknown baseline, and report deployment gaps and owner blockers. Preserve app design, existing connections and data. Prepare a reviewable setup plan using the exact migrations, function, auth/configuration and pending checks listed here. Paid providers remain blocked until exact current models, API contracts, billing rates and conservative request bounds are verified. Do not create/change cloud resources, apply migrations, deploy functions, enter secrets, enable schedules, push, or publish. Do not present authored source or unexecuted checks as completed infrastructure.
