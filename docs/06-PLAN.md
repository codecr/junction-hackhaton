# 06. Plan

Today is Tuesday, Sept 29, 2026. Reported deadline: **Friday, Nov 6, 2026, 11:59 PM PT** (confirm). Plan to submit **Thursday, Nov 5** and keep Nov 6 for fixes only. The AWS CDS hackathon deadline (Oct 28) shares the calendar, so the plan has two heavy stretches and one light one.

```
Sep 29 Tue   today: verify rules, start recruiting the squad
Oct  1-4     Phase 0  spike, scaffold, fixtures                       (heavy)
Oct  5-11    Phase 1  core and agent                                  (heavy)   Oct 6 seats open in the portal, Oct 8 reserve/cancel via API
Oct 12-18    Phase 2  solver and UI                                   (heavy)   squad confirmed by Oct 12
Oct 19-28    Phase 3  squad server, AWS deploy, site and demo         (light)   Oct 28 CDS deadline
Oct 29-Nov 2 Phase 4  launch reactor, scouts, MCP, real squad dry run (heavy)
Nov  3-5     Phase 5  submission assets, submit Nov 5                 (heavy)
Nov  6 Fri   deadline, fixes only
Nov 28 Sat   fly to Las Vegas, stay off-Strip
Nov 30-Dec 4 re:Invent
```

Effort estimate: 45 to 55 hours in total with Claude Code doing most of the typing. About 10 hours a week in the heavy stretches, about 3 in the light one.

## Phase 0. Oct 1 to 4: spike, scaffold, fixtures

| Task | What | Done when |
|---|---|---|
| T0.1 | Read the About tab of the hackathon. Record dates, eligibility, deliverables, video length, repo rules, judging in `docs/00-BRIEF.md`. | Open questions 1 and 2 answered. |
| T0.2 | Scaffold the monorepo, scripts, CI (typecheck, lint, test, audit), tokens, `.claude` in place. | `npm test` and `npm run typecheck` pass on an empty core. |
| T0.3 | Spike 0 (docs/04 checklist) with real sign-in. | `docs/FINDINGS.md` filled, private fixtures saved. |
| T0.4 | Seeded demo fixture generator: 5 members, about 120 invented sessions across 5 venues, repeats with `-R` and `-R1` codes, invented titles. | Same seed gives byte-identical output. Reference data in `design/reference.html` is reproducible from it. |
| T0.5 | Recruit the squad (message below). | Three to five people confirmed by Oct 12. |

## Phase 1. Oct 5 to 11: core and agent

| Task | What | Done when |
|---|---|---|
| T1.1 | Core: zod schemas, RFC 8785 canonical JSON, Ed25519 sign and verify, envelope. | Round-trip and tamper tests pass. |
| T1.2 | Core: code parser, repeat groups with differences, venue graph and normaliser (from FINDINGS). | Golden tests on generated fixtures and on a redacted real sample. |
| T1.3 | Core: coverage, duplicates (planned or not), infeasible hops, must-cover gaps. | Acceptance scenarios 1 and 2 pass. |
| T1.4 | Agent: PKCE sign-in with port fallback, 0600 storage, serialised refresh, sign-out with revocation. | Sign in, wait past expiry or force it, refresh works, sign-out revokes. |
| T1.5 | Agent: Events client, pacer, error model, reconcile-before-retry. | Simulated 429, 409 and partial failure covered by tests. |
| T1.6 | Agent: SQLite catalog store, snapshots, diff, `catalogHash`. | Full catalog walk within quota, diff detects an injected change. |
| T1.7 | Agent: `GetSchedule` to signed manifest, export and import by file and paste. | Two simulated members and one real member see the same coverage. |
| T1.8 | **Oct 8**: real reserve, cancel, favorite and personal-time writes on two or three sessions. | Results and any surprises in `docs/FINDINGS.md`. |

Gate: CLI shows the coverage of a three-member squad from exchanged files.

## Phase 2. Oct 12 to 18: solver and UI

| Task | What | Done when |
|---|---|---|
| T2.1 | Solver, claim rule, property tests, golden fixture. | Determinism tests pass across Linux and macOS CI. |
| T2.2 | Web shell, tokens, first-run (sign in, create or join, sharing level). | Works against the real agent and in demo mode. |
| T2.3 | Marey chart component matching `design/reference.html`. | `/design-review` shows no meaningful deviation at 1440 and 390. |
| T2.4 | Coverage table, proposals list, accept flow with writes, reconcile and undo. | Acceptance scenario 5 passes against a real account. |
| T2.5 | Demo build (fictional fixtures, no network). | Network tab is empty in the demo. |
| T2.6 | Accessibility: keyboard, focus, table alternative for the chart, reduced motion, contrast. | Axe clean, manual keyboard pass. |

Gate: recorded 60-second screen capture of the full accept flow on the real agent.

## Phase 3. Oct 19 to 28: squad server, AWS, site (light)

Mostly delegated to Claude Code; you review and approve deploys.

| Task | What | Done when |
|---|---|---|
| T3.1 | Relay handlers with signature verification, nonce store, conditional claims, plus tests against a DynamoDB adapter. | Signed envelopes round-trip, unsigned and stale ones rejected. |
| T3.2 | CDK stacks, deploy to the dedicated account. | `cdk deploy` succeeds, smoke tests pass. |
| T3.3 | Agent transport to the server, join requests, leader approval, leave and purge. | Two machines exchange through the server. |
| T3.4 | Landing page, short docs, `/demo`, custom domain if wanted. | Site loads, demo runs with an empty network tab. |
| T3.5 | `guardian` audit of privacy and API conformance. | No findings, or all fixed. |

Gate: public URL and two real machines coordinating through the squad server.

## Phase 4. Oct 29 to Nov 2: launch reactor, scouts, MCP, dry run

| Task | What | Done when |
|---|---|---|
| T4.1 | Launch reactor: diff, classify, claim rule, server claims with grace periods, notifications. | Acceptance scenario 4 passes with three simulated agents. |
| T4.2 | Scout notes and repeat advisories. | A note posted on one machine appears on the others with a keep or release proposal. |
| T4.3 | Local MCP server. | Claude Code answers "who covers security on Wednesday?" from local state. |
| T4.4 | Meeting points (cut first if behind). | A lunch proposal names who can and cannot make it. |
| T4.5 | **Real dry run** with at least three real members for at least two days. | Results, screenshots and fixes recorded. |

## Phase 5. Nov 3 to 5: submission

| Task | What | Done when |
|---|---|---|
| T5.1 | Builder Center project page from docs/07, README, architecture diagram, API coverage table. | Reads well cold. |
| T5.2 | Record and edit the 3-minute video. | Uploaded, captions checked. |
| T5.3 | Final `/verify`, `guardian` and `design-review`. Tag a release. Publish the repository as the rules require. | All clean. |
| T5.4 | **Submit on Nov 5.** | Confirmation saved. |

## Cut list, in order, if behind

1. Meeting points (H1). 2. Local MCP (J1). 3. Scout notes (G). 4. Reservation watcher (I1, I2). 5. Autonomy modes (E5). 6. Launch reactor notifications (keep the claim rule).

Never cut: signed manifests, coverage, solver, the day chart, server claims, demo mode, privacy rules.

## Risks

| Risk | Likelihood | Impact | Response |
|---|---|---|---|
| Personal time does not show on the phone | Medium | Weakens the "official app" moment | Spike 0 item 8. Fall back to favorites and reservations as the visible effect. |
| Hackathon rules differ from the reports | Medium | Could change eligibility or format | T0.1 first. |
| Real catalog structure differs from assumptions | Medium | Parser and topic matching rework | Spike 0 before any core code. |
| Cannot recruit enough real squad members | Medium | No real dry run | Start now, ask by Oct 12. Offer a 15-minute setup. Fall back to two real plus simulated members and say so honestly. |
| Port 8484 taken | High | Sign-in fails | Fallback through 8489, tested in Spike 0. |
| Bandwidth collision with CDS | High | Slips Phase 3 | Phase 3 is light and delegable. Cut list ready. |
| Reservations closed until Oct 8 | Certain | Cannot test earlier | Read-only and favorites until then. |
| Another entry ships the same idea | Low | Loses novelty | Check the gallery weekly. Stress the local-first consensus design. |
| Squad server abused | Low | Cost or noise | Throttling, payload cap, budget alarm, TTL. |

## Recruiting message (Spanish, ready to send)

> Estoy armando una herramienta para el hackathon de AWS re:Invent que ayuda a un grupo a repartirse las sesiones sin pisarse: quién cubre qué tema, qué repeticiones vale la pena y quién toma las sesiones nuevas que salen a mitad de semana. Necesito 3 o 4 personas que ya estén registradas en re:Invent 2026 para probarla en serio. Toma unos 15 minutos instalarla. Cada quien la corre en su propia computadora, solo se comparten códigos de sesión (nada de cuentas ni contraseñas), y todo se borra al terminar el evento. ¿Te sumas?
