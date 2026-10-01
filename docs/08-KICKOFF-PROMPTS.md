# 08. Kickoff prompts

Paste these into Claude Code one at a time, in order. Each ends with an acceptance list. Do not move on until it passes. Use `/verify` between prompts.

## Prompt 0: kickoff (plan mode)

```text
You are the lead engineer on Junction, a squad-coordination tool for AWS re:Invent 2026 built for the re:Invent Event Catalog API Hackathon. I am Gerardo, a cloud architect and AWS Community Builder. Talk to me in Spanish; write code, docs and UI copy in English.

Read, in order: CLAUDE.md, docs/00-BRIEF.md, 01-SPEC.md, 02-ARCHITECTURE.md, 03-DATA-CONTRACTS.md, 04-EVENTS-API-NOTES.md, 05-DESIGN.md, 06-PLAN.md. Open design/reference.html and design/reference-desktop.png and look at them.

Then enter plan mode and give me:
1. Your understanding of the product in five sentences, and the three riskiest assumptions in it.
2. Anything in the docs that is inconsistent, unverified or that you would decide differently. Be direct.
3. A proposed monorepo scaffold (packages, scripts, CI) that matches CLAUDE.md, with the libraries you would choose and why.
4. The exact order you would work in for Phase 0.

Do not write any code until I approve the plan.
```

## Prompt 1: scaffold and fixtures (T0.2, T0.4)

```text
Implement the approved scaffold: npm workspaces (core, agent, web, mcp, relay, infra), TypeScript strict and ESM on Node 22, vitest, eslint, prettier, and the scripts named in CLAUDE.md. Add CI that runs typecheck, lint, test and npm audit. Copy design/tokens.css into packages/web and wire it in.

Then write the seeded demo fixture generator in fixtures/generate.ts: 5 members, about 120 invented sessions across the five venues in docs/05, session codes in the AAA### form with -R and -R1 repeats, invented titles, topics from the reference (Agentic AI, Security and compliance, Data and analytics, Containers, Cost and FinOps, Serverless), and one member schedule each, so that the data in design/reference.html is reproducible. Never use or resemble real catalog content.

Done when: npm test, typecheck and lint pass; the generator is byte-identical for the same seed (add a test); a README section explains how to run everything. Commit in small Conventional Commits.
```

## Prompt 2: Spike 0 with real sign-in (T0.3)

```text
Run Spike 0 from docs/04-EVENTS-API-NOTES.md. Write throwaway scripts under spikes/ (never imported by packages). Guide me through the sign-in step by step: I will authenticate in the browser. Use loopback port 8484, then prove the fallback to 8485 with 8484 occupied.

Walk the whole catalog within quota, save redacted raw responses to fixtures/private/ (git-ignored), and fill docs/FINDINGS.md using the template. Pay special attention to: exact session field names, taxonomy labels, every code suffix pattern with counts, how repeats differ, venue and room strings, fullness values, the GetSchedule shape, and partial-failure response shapes.

For the personal-time test, create one entry with a tagged description and ask me to look at the AWS Events app on my phone and the portal, then report what I see. Delete it afterwards.

Finish by listing what in docs/01, 03 and 04 must change because of what we learned, and update those docs after I agree.
```

## Prompt 3: core (T1.1 to T1.3)

```text
Implement packages/core exactly as specified in docs/03-DATA-CONTRACTS.md, adjusted by docs/FINDINGS.md: zod schemas for charter, manifest, signal, claim and envelope (also generate JSON Schemas into schemas/); RFC 8785 canonical JSON; Ed25519 keys, signing and verification; session code parser and repeat groups with differences; venue graph and normaliser; coverage, duplicates (planned or unplanned), infeasible hops and must-cover gaps.

Rules: pure functions only, no I/O, no clock, no randomness, no locale-dependent sorting, integer milli-units for anything compared. Tests first for each module. Include tamper tests for signatures, and golden tests using the generated fixtures. Add the acceptance scenarios 1 and 2 from docs/01 as tests.

Done when: all tests pass; coverage of core above 90 percent; /verify is clean; a short docs/03 addendum lists any deviation you made and why.
```

## Prompt 4: agent (T1.4 to T1.8)

```text
Implement packages/agent: PKCE sign-in with port fallback, 0600 credential storage under ~/.junction, serialised refresh, sign-out with revocation; the Events API client with zod-validated responses, per-operation token buckets from the quotas in docs/04, Retry-After handling, closed-operation handling, and reconcile-before-retry for writes; the SQLite catalog store with snapshots, diff and catalogHash; sync from GetSchedule to a signed manifest; file and paste export and import; the CLI commands in docs/02.

Never log tokens. Add a test that greps captured logs for token patterns. Simulate 429, 409, partial failures and duplicate personal-time creation.

Then, on Oct 8 or later, run a real write test with me on two or three sessions: favorite, reserve, cancel, personal time create and delete. Record what happens in docs/FINDINGS.md.

Done when: two simulated members and one real member exchange manifests by file and the CLI prints the same coverage for all three; /verify is clean.
```

## Prompt 5: solver and UI (T2.1 to T2.6)

```text
Part A, solver: implement propose() and the claim rule in packages/core per docs/03. Add fast-check property tests: order independence, locked sessions never move, feasibility always holds, strictly positive squad delta on each applied step, idempotence, and a golden fixture that must be byte-identical across Linux and macOS CI.

Part B, UI: build packages/web to match design/reference.html at 1440 and 390 px, using only design/tokens.css and hand-written SVG with d3-scale. No Tailwind, no component kit, no icon pack. Screens per docs/01 section K and the states in docs/05. Build the Marey chart as a component driven by data, not hard-coded coordinates. Wire the accept flow to the agent: writes, reconcile with GetSchedule, per-session results, undo. Add the demo build with fixtures and no network.

After every visible change run /design-review, look at the screenshots yourself, and fix deviations before continuing. Before you finish each screen, remove one thing.

Done when: the demo matches the reference, the accept flow works against my real account for my own schedule only, keyboard and screen reader paths work, /verify and /design-review are clean.
```

## Prompt 6: squad server, AWS and site (T3.1 to T3.5)

```text
Implement packages/relay and infra per docs/02 and docs/03: one Lambda with a small router, signature verification with a timestamp window and nonce store, membership from the latest signed charter, conditional-write claims and announcements, payload cap, TTL on everything. CDK v2 stacks JunctionSiteStack and JunctionRelayStack as specified, with the CSP headers, alarms, budget, throttling and reserved concurrency. Optional custom domain through context values.

Then add the agent transport to the server, join requests and leader approval, leave and purge. Build the landing page and short docs in the design language of docs/05 (a page, not a template), and deploy /demo.

Run npm run infra:diff and show me the diff before any deploy. I will approve the deploy. After deploying run the smoke tests in docs/02 and then the guardian subagent.

Done when: the public URL works, /demo runs with an empty network tab, two real machines coordinate through the server, unsigned and stale envelopes are rejected, guardian reports no findings.
```

## Prompt 7: launch reactor, scouts, MCP, meeting points (T4.1 to T4.4)

```text
Implement, in this order and stopping if I say we are behind: launch reactor (diff, classify, claim rule, server claims with grace periods, notifications); scout notes and repeat advisories; the local MCP server with the tools in docs/03; meeting points.

Every feature needs its acceptance scenario from docs/01 as a test. Run three simulated agents against the deployed or local squad server for the launch claim scenario and show me the transcript.

Done when: scenario 4 passes with three agents naming the same owner and only one claim winning; a scout note posted on one machine appears on the others with a keep-or-release proposal; Claude Code can answer "who covers security on Wednesday?" through the MCP server; /verify and guardian are clean.
```

## Prompt 8: submission (T5.1 to T5.4)

```text
Prepare the submission from docs/07: the Builder Center page draft, README with the architecture diagram and API coverage table, the disclaimer, and a shot list and script for the 3-minute video using real dry-run results. Run a history scan for catalog content, tokens and account IDs across all commits. Run /verify, /design-review and guardian. Tag a release. Give me a checklist of what only I can do (record, upload, submit) with times.
```
