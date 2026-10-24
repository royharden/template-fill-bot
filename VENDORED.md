# Vendored code

Nothing is vendored in this repository.

## TS shared-contract modules re-checked: none found

Check performed 2026-10-24 (milestone M1, read-only, directory names only, no `.thinking` folder opened):
every `C:\Users\Roy Harden\OneDrive\PJ-OD\Bolt.New\<project>\<child>\src` and `...\supabase` tree was
walked (skipping dot-folders and `node_modules`) for `callledger` / `evalkit` names.

- Found: `shared/callledger` and/or `shared/evalkit` packages in 10 sibling projects
  (changelog-upgrade-advisor, content-strategy-agent, dev-logs-mcp, entity-matcher, firewall-traffic-analyst,
  github-issue-triage, hiring-signal-tracker, llm-router-eval, receipt-field-review, screenshot-memory).
- All are Python packages (`src/<python_package>/shared/...`; files are `.py`, `.json`, `.md`, `.sql`);
  no `.ts` file exists in any of them.
- Result: there is no TypeScript shared-contract module to vendor. This project's `callledger/` and `evalkit/`
  (milestones M6/M7) are written fresh in TypeScript and copy no code or text from those projects.

If a TypeScript callledger/evalkit contract later appears in a sibling project, re-run this check and record
the source path, commit and licence here before copying anything.
