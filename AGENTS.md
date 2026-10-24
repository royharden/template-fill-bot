# Agent instructions: template-fill-bot (inner product repo)

Product rules (always):
- Agreement files (Markdown, DOCX) contain only locked library text and validated values. No model-written
  document text, ever. Raw source quotes live only in `provenance.json` and the review UI.
- Clause, frame and jurisdiction content is self-authored and illustrative ("invented example values, not any real
  law"; "draft, not legal advice"). Never copy template or clause text from other repos or publications.
- `content/library.lock.ts` is regenerated only by `npm run lock` after a deliberate content change; nothing
  auto-relocks at runtime. The committed UNLOCKED sentinel makes rendering fail closed (`library_unlocked`).
- Source stays erasable TypeScript: no `enum`, `namespace` or parameter properties; `import type` for types;
  explicit `.ts`/`.tsx` extensions on every relative import.
- Browser code imports the core only through `src/core/index.ts`; never `providers/` or `callledger/`. The gate
  (`fillkit/gate/`) never imports `select.ts`, `segments.ts`, `renderMarkdown.ts` or `docx/writeDocx.ts`.
- Only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` carry the `VITE_` prefix. No real personal data in fixtures.

Dirty Mode (2026-10-24, this app only): source is written but nothing is installed, built, tested, run, migrated or
deployed. Static checks only: `node scripts/syntax-check.mjs [files]`. Every unverified item is recorded in
`docs/DEFERRED-VALIDATION.md`. The integrator commits; this repo has no remote and is never pushed.

Layout: the authoritative plan is the outer shell's `PLAN.md` (section 3.2). Canonical pure TS lives in
`supabase/functions/_shared/` (`content/`, `fillkit/`, later `docx/`, `evalkit/`, `providers/`, `callledger/`,
`rulings/`); `src/core/index.ts` is the browser facade; tests are in `tests/{unit,gate,contract,eval}`.
