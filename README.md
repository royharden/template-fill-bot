# Accord / Template-Filling Bot

> Illustrative jurisdiction: every legal rule and notice period is an invented example, not any real law. Agreements are drafts, not legal advice.

## Construction status

The source implementation is complete for the Dirty Mode construction phase. It has received separate static milestone reviews. No dependency install, application/demo execution, generator, evaluation, test suite, build, provider request, migration or deployment has run. Construction used source inspection and parse-only checks; JSX and SQL received manual inspection.

Two deliberate activation barriers remain:

- The committed library lock is UNLOCKED. Field extraction/review source is present, but agreement rendering and bundle approval fail closed until the lock is deliberately generated, reviewed and committed.
- The dated price table contains no verified paid-model entries. Paid calls refuse price_missing until current provider/model prices and conservative request bounds are reviewed.

There is no package-lock.json yet, no generated forty-scenario corpus, no frozen held-out manifest and no measured result. See [deferred validation](docs/DEFERRED-VALIDATION.md).

## Implemented source

Paste up to twelve messages, totaling 8,000 normalized UTF-16 code units. Code finds candidate spans; regex, fixture replay or a server extractor proposes quoted values. Code grounds and reparses them, retains conflicts, checks cross-field rules and asks fixed questions. Optional guarantor/break terms require explicit confirmation.

The review workbench includes source highlighting, editable answers, unsupported requests, clause selection, provenance and previews. Deterministic Markdown and seven-part DOCX output pass an independent final-byte gate. An approval binds the exact bundle digest and persisted revision; downloads regenerate and re-gate that revision. Intake edits, answer drafts and account changes invalidate active approval state.

Demo persistence is in memory with validated JSON interchange that never restores approvals. Live source supplies email/password authentication and recovery, owner-scoped Supabase persistence, ordered RLS migrations, an authenticated extraction function and atomic paid-attempt reservations. Default demo mode does not initialize live authentication or network traffic.

The clause library and synthetic data are authored here. No external tenancy template or contract corpus was copied.

## Later activation

These are future steps after Roy closes Dirty Mode and authorizes the relevant setup. They have not been performed.

1. Install the pinned dependencies, review the resulting package lock and confirm licenses against NOTICE.

       npm install
       npm ls --depth=0

2. Generate the content lock deliberately; review the source diff and commit it. Runtime code never relocks itself.

       npm run lock
       npm run lock -- --check

3. Perform the deferred frontend and separate edge checks.

       npm run typecheck
       npm run lint
       npm test
       npm run build
       deno check --config supabase/functions/extract-fields/deno.json supabase/functions/extract-fields/index.ts

4. Run the keyless synthetic CLI demonstration and both browser journeys. An agent must claim an agent-ports lane before starting a server.

       npm run demo
       npm run demo -- --scenario=demo-02
       npm run dev -- --port <claimed-port>

   The CLI uses fixture answers and a clearly synthetic local approval. It prints a summary, checks stale-approval rejection and writes no agreement files. It intentionally stops with library_unlocked before content activation. Use the browser downloads for Word/LibreOffice compatibility checks.

5. For live activation, follow [BOLT-HANDOFF.md](BOLT-HANDOFF.md). Inspect the actual database baseline first. All schema, two-user isolation, JWT, CORS, quota, session/recovery and provider checks remain pending. Only VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are public browser configuration. Provider and service-role secrets belong in server settings.

## Evaluation

[Evaluation instructions](eval/README.md) describe the generator, frozen protocol, cache and persistent local budget. Twenty hand traps and separate adversarial fixtures are authored; forty scenarios remain generator source. After activation:

    npm run gen-gold -- --generate
    npm run eval -- --offline --split=dev

Offline/mock output is not a model measurement. Later authorized live dev work requires verified prices, exact models and local non-browser credentials. Freeze only after dev tuning, then make the single authorized held-out attempt:

    npm run gen-gold -- --freeze
    npm run eval -- --live --split=heldout

An interrupted or incomplete held-out attempt consumes the grant. Do not delete the budget journal or surviving locks to retry. Run the evaluator on one machine. New provider charge, reserved volume, settled spend, retained exposure and replay history are separate; unavailable predictions and timing do not become zero-valued quality observations. Jev remains optional and unpromoted pending matched eligible-field held-out evidence.

[Results](results/results.md) currently say NOT MEASURED.

## Documentation

- [Architecture and boundaries](docs/ARCHITECTURE.md)
- [Spec-to-source acceptance map](docs/SPEC-ACCEPTANCE.md)
- [Limitations and generated failure-list region](docs/LIMITATIONS.md)
- [Deferred validation and exact follow-up checks](docs/DEFERRED-VALIDATION.md)
- [Bolt inspection-only inventory](BOLT-HANDOFF.md)

Node >=22.13.0 is declared; exact dependency/runtime compatibility remains unverified. License: [MIT](LICENSE); dependency license verification remains pending in [NOTICE](NOTICE).
