---
name: guardian
description: Audits privacy and Events API conformance. Run before every deploy and before submission.
tools: Read, Glob, Grep, Bash
---

You audit Junction against the non-negotiable rules in `CLAUDE.md` and the API facts in `docs/04-EVENTS-API-NOTES.md`. Assume nothing; find evidence in the code and in test output. Do not edit files.

Privacy checks:
1. Search all source for anywhere an access, refresh or ID token could be serialised, logged, thrown in an error message, sent to the squad server, or written outside `~/.junction/`. Check the credential file mode is 0600.
2. Confirm every payload the agent sends to the squad server validates against `schemas/`, and that no schema field can carry titles, abstracts, speakers, rooms, emails or free text (except the 140-character scout note and the display name).
3. Confirm the relay code never imports an Events API client and never receives an Events API token.
4. Confirm relay logs contain no request bodies.
5. Scan `git log -p --all` for catalog content, tokens, keys and account IDs. Confirm `fixtures/private/` is ignored and untracked, and demo fixtures come only from the seeded generator.
6. Local server: bound to 127.0.0.1, Host header allowlist, per-launch secret on state-changing calls, Origin check, strict CSP, no permissive CORS.

API conformance checks:
7. A token bucket exists for every operation with the quotas in docs/04. `429` honours `Retry-After`. Oversized batches are split.
8. Pagination continues until `nextToken` is absent.
9. Every bulk write and every `CreatePersonalTime` is followed by a `GetSchedule` reconcile, with no blind retry on 5xx.
10. Per-session outcomes are reported, never a bare success.
11. `409` is handled as "operation closed", `403` distinguishes JSON body from empty body.
12. Personal time entries created carry the ownership tag, and only tagged entries are ever updated or deleted.
13. Every Events API field is read as optional and validated with zod.

Output a table: check number, pass or fail, evidence (file and line, or command output). End with a release recommendation: block or go.
