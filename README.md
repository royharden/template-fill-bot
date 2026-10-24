# Template-Filling Bot (tenancy-agreement style)

> **Illustrative jurisdiction.** Every rule, limit and notice period in this app is an *invented example value,
> not any real law*. Output is a **draft, not legal advice**: have any agreement reviewed by a qualified lawyer
> before anyone relies on it.

## Status

**Source written in Dirty Mode; nothing has been installed, built, tested or run.**

- No `npm install` has happened, so there is no lockfile and no dependency has been verified.
- The clause library lock (`supabase/functions/_shared/content/library.lock.ts`) is an UNLOCKED sentinel, so
  rendering is blocked (fail-closed, reason `library_unlocked`) until `npm run lock` is run once and reviewed.
- Tests are written but have never been executed; there are no measured results.
- Every deferred check, with the exact later command, is listed in
  [docs/DEFERRED-VALIDATION.md](docs/DEFERRED-VALIDATION.md).

## What it is (planned design)

Being built milestone by milestone; see `STATUS` notes in the outer shell and
[docs/DEFERRED-VALIDATION.md](docs/DEFERRED-VALIDATION.md). None of the behaviour below has ever run.

A React + TypeScript web app. You paste up to 12 messages about a tenancy; code finds candidate values, an extractor
proposes values with verbatim quotes, and code re-derives every value from its quote. Anything missing, conflicting,
ambiguous or invalid becomes a fixed question. Clauses are chosen deterministically from a small, self-authored,
hash-locked library, and the agreement is rendered to Markdown and DOCX. An independent gate re-checks the final
files, a human approves a bundle digest, and downloads serve exactly the approved bytes. Requests the library cannot
express (for example "the landlord can enter without notice") are listed as *not included*, never drafted.

Licence: MIT (see [LICENSE](LICENSE) and [NOTICE](NOTICE)).
