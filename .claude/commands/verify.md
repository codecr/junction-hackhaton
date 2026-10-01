---
description: Typecheck, lint, test, and scan for secrets and catalog content before committing
allowed-tools: Read, Bash, Glob, Grep
---

Run these in order and report a table of pass or fail with the first failing output for each:

1. `npm run typecheck`
2. `npm run lint`
3. `npm test`
4. Secret scan: search tracked and staged files for token-like strings (`eyJ` JWT prefixes, `refresh_token`, `access_token`, `Authorization: Bearer`, `AKIA`, private key blocks, `7vmom55m1qstvq8i71ph127bfq` appearing anywhere except docs and the auth module).
5. Catalog scan: confirm `git ls-files` contains nothing under `fixtures/private/` and no `*.catalog.json`; grep tracked fixtures for anything that does not come from `fixtures/generate.ts`.
6. Log scan: run the agent tests with log capture on and confirm no token pattern appears.
7. `git status` must show no unintended files.

Do not fix anything silently. List findings, then propose fixes and wait.
