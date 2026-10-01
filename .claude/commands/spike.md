---
description: Run Spike 0 (or one item of it) against the real Events API and record findings
argument-hint: [item number 1-12, optional]
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

Run Spike 0 from `docs/04-EVENTS-API-NOTES.md`. If `$ARGUMENTS` is a number, run only that checklist item; otherwise run all twelve in order.

Rules:
- Scripts go under `spikes/` and are never imported by `packages/`.
- I authenticate in the browser. Tell me exactly when to do so. Never read `~/.junction/**` or print tokens.
- Save redacted raw responses to `fixtures/private/` (git-ignored). Never commit catalog content.
- Append dated results to `docs/FINDINGS.md` using the template in docs/04. State what was observed, not what was expected.
- Stop and ask me for anything that needs my phone, the portal, or a decision.

Finish with a list of assumptions in docs/01, 03 and 04 that the findings contradict.
