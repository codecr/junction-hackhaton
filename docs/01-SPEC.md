# 01. Functional specification

Priorities: **M** must (core demo), **S** should, **C** could. Phases refer to docs/06-PLAN.md.

## A. Sign-in and Events API client

| ID | Pri | Requirement |
|---|---|---|
| A1 | M | Sign in with AWS Builder ID using OAuth 2.0 authorization code with PKCE. Listen at `/callback` on `localhost` port 8484, falling back through 8485 to 8489 if taken (Claude Code's MCP setup also uses 8484). Scope `openid email events/access`. Store tokens in `~/.junction/credentials.json` mode 0600. Refresh before expiry (access token 60 min, refresh token 30 days). |
| A2 | M | Sign out revokes the refresh token, deletes stored tokens, and offers to end the Builder ID session (explain that this signs the attendee out of Builder ID in that browser). |
| A3 | M | Typed client for all 12 operations. Validate responses with zod, treating every session field as optional. Prefer generating types from an OpenAPI document if one is published (Spike 0). |
| A4 | M | Per-operation token-bucket pacer using the published per-attendee quotas. Honour `429` with `Retry-After`. Split batches larger than remaining quota. |
| A5 | M | Error model: `400` fix the request, `403` with JSON body means not registered for the event, `403` without body means the edge refused this address, `404` missing resource, `409` operation closed, `429` throttled, `5xx` reconcile before retry. |
| A6 | M | Write safety: after any bulk write or `CreatePersonalTime`, read `GetSchedule`, compare with intent, and report per-session outcomes. No blind retries. |
| A7 | S | Read-only fallback path through the official MCP server (`https://api.awsevents.com/mcp`) for users who prefer it, sharing the same domain types. |

## B. Catalog

| ID | Pri | Requirement |
|---|---|---|
| B1 | M | Download the catalog with `includeAbstracts=false`, paginating until `nextToken` is absent, fetch abstracts lazily for sessions shown. Cache in SQLite under `~/.junction/`. |
| B2 | M | `catalogHash`: sha256 over the sorted list of (sessionId, start, end, venue, room). Included in every manifest. |
| B3 | M | Snapshot diff: added, removed, changed (time, venue, room, title), and fullness band changes. |
| B4 | M | Session code parser and repeat groups. Codes look like `COM302-R` and `COM302-R1` (base, suffix letters, optional index). Discover the real suffix patterns from the catalog before trusting the regex. Group key is base code plus normalised title. Repeats are not identical (one card showed a community-led format, its repeat a customer story), so compute and surface differences in type, features, speakers, level and time. |
| B5 | M | Venue normaliser and walking-minutes graph as a configurable JSON file, with the chart's venue order derived from it. Ship a default graph marked as approximate. |
| B6 | S | Polling loop for catalog changes with adaptive cadence within quota (default every 10 minutes, faster in configured keynote windows). |

## C. Squad

| ID | Pri | Requirement |
|---|---|---|
| C1 | M | Create a squad: name, event, topics with weight and target, must-cover sessions, protected lunch window, per-day cap. Produces a signed charter. |
| C2 | M | Join by invite code. The leader approves each join request by publishing an updated signed charter listing the member's public key. |
| C3 | M | Per-member sharing level: L0 session IDs and codes only, L1 plus busy blocks, L2 plus current venue. Changeable at any time. Leaving removes the member's manifest from the squad server. |
| C4 | M | Manifests are signed (Ed25519), carry a monotonically increasing `seq`, and are rejected if stale, unsigned or from a non-member. |
| C5 | M | Offline-first exchange: export and import as file and as a pasted base64url block. The squad server is an optional transport that stores the same signed envelopes. |
| C6 | S | Purge: the leader can delete the squad and all its data. Everything expires automatically 14 days after the event ends. |

## D. Coverage

| ID | Pri | Requirement |
|---|---|---|
| D1 | M | Coverage matrix by topic and day against targets. States: covered, under target (n of target), none. |
| D2 | M | Duplicates classified as planned (attendees at most the topic target) or unplanned. |
| D3 | M | Infeasible connections per member: walking time between consecutive sessions greater than the gap. Report needed and available minutes. |
| D4 | M | Must-cover sessions nobody holds, including those that collide with the protected lunch window. |

## E. Proposals

| ID | Pri | Requirement |
|---|---|---|
| E1 | M | Deterministic solver (docs/03) producing proposals of four kinds: SWAP (move to a repeat or alternative), CLAIM (take an uncovered or new session), DROP (release an unplanned duplicate), MEET (shared personal time). Each carries the squad-value delta, the personal-value delta and a plain-language reason. |
| E2 | M | Proposals are marked provisional when members' `catalogHash` values differ. |
| E3 | M | Accepting a proposal applies it to the member's own schedule only, confirms with `GetSchedule`, reports per-session results, and can be undone. |
| E4 | M | Personal-time entries created by Junction carry the ownership tag and are the only entries Junction edits or deletes. |
| E5 | S | Autonomy modes per member: propose only (default), or auto-apply proposals within guardrails the member set (never remove a locked session, never leave a day below a minimum, never touch reservations). |

## F. Launch reactor

| ID | Pri | Requirement |
|---|---|---|
| F1 | S | On a catalog diff that adds sessions, classify launch-like sessions by type, title and features, evaluate against squad topics, and run the claim rule. |
| F2 | S | Claim rule (docs/03) ranks eligible members deterministically. Rank r may claim after a grace period of r times 5 minutes. The squad server confirms the first claim with a conditional write, and a claim that loses returns the winner. |
| F3 | S | Notify in the UI and optionally as an OS notification. |

## G. Scout notes

| ID | Pri | Requirement |
|---|---|---|
| G1 | S | A member who attended a session posts a note of at most 140 characters with a verdict: worth it, skip the repeat, crowded, wrong level, moved. |
| G2 | S | Members holding a later repeat of that session see the note and a proposal to keep or release it. |

## H. Meeting points

| ID | Pri | Requirement |
|---|---|---|
| H1 | C | Find windows when at least three members are free and within a configurable walking time of one venue, and propose a MEET with a plain explanation of who can and cannot make it. |

## I. Reservation orchestration

| ID | Pri | Requirement |
|---|---|---|
| I1 | S | When reserved seating opens (portal Oct 6, API Oct 8 for re:Invent 2026), order each member's reservations by scarcity times value, assign contested seats to different members with distinct backups, and report per-session results. |
| I2 | C | Watcher for full sessions polling `GetSession` fullness bands within quota. |

## J. Local MCP server

| ID | Pri | Requirement |
|---|---|---|
| J1 | S | stdio MCP server exposing `squad_coverage`, `squad_gaps`, `squad_proposals`, `squad_accept` and `squad_note`. Reads only from local state. `squad_accept` requires an explicit confirmation argument. It complements the official `awsevents` MCP server rather than wrapping it. |

## K. Web UI (served by the local agent at 127.0.0.1)

| ID | Pri | Requirement |
|---|---|---|
| K1 | M | Screens: first-run (sign in, create or join a squad, choose sharing level), squad day view (per `design/reference.html`), coverage for the week, proposals, scout notes, settings (sharing, autonomy, sign out). |
| K2 | M | Marey-style day chart: time on x, venues on y spaced by walking minutes, one line per person, thick runs for sessions and slopes for walks. Shared, uncovered and impossible states as in the reference. |
| K3 | M | Meets `docs/05-DESIGN.md`: tokens only, keyboard reachable, visible focus, reduced motion respected, WCAG 2.2 AA contrast, no colour-only encoding, responsive to 390 px. |
| K4 | M | Empty, loading, offline, error and provisional states designed, not defaulted. |

## L. Hosted on AWS

| ID | Pri | Requirement |
|---|---|---|
| L1 | M | Static site on S3 and CloudFront: landing, short docs, downloads, and `/demo` running the same UI client-side with fictional data and no network. |
| L2 | M | Squad server: API Gateway HTTP API, Lambda, DynamoDB on-demand with TTL. Stores only signed envelopes. Verifies every request signature against the squad's signed charter. |
| L3 | S | Alarms, log retention, a monthly budget alert, throttling, reserved concurrency cap. |

## Non-functional

- **Privacy.** Rules 1 to 3 of CLAUDE.md are release blockers. A `guardian` review must pass before every deploy.
- **Determinism.** Byte-identical solver output for identical inputs, tested with property tests and a cross-platform golden fixture.
- **Resilience.** Everything works with file exchange only. The squad server being down never blocks a member's own schedule.
- **Accessibility.** WCAG 2.2 AA. The chart has a table alternative listing the same sessions per person.
- **Performance.** Day chart with 30 members and 300 sessions renders in under 200 ms after data load.
- **Cost.** Under 5 USD a month for the hosted parts during the hackathon.

## Acceptance scenarios (write these as tests)

1. **Duplicate.** Given Ana and Luis both hold OPS305-R and the topic target is 1, the coverage view flags an unplanned duplicate and the solver proposes moving one of them to the repeat `OPS305-R1` if it fits their schedule.
2. **Impossible walk.** Given Luis ends at MGM Grand at 2:00 PM and starts at Mandalay Bay at 2:15 PM with a 28-minute walk, the chart draws a dashed line ending in a cross and states the needed and available minutes.
3. **Determinism.** Given the same charter, manifests and catalog on two machines, the proposal lists are byte-identical.
4. **Launch claim.** Given a new session that three members could take, all agents name the same owner. A second member claiming before their grace period is refused by the server, and after it succeeds only if the owner has not claimed.
5. **Partial failure.** Given ten sessions to reserve where two are full, the UI reports eight reserved and two full, confirmed from `GetSchedule`, and offers backups.
6. **Privacy.** A network capture of a full session shows no request to the squad server containing titles, tokens, or catalog content.
7. **Provisional.** Given one member's `catalogHash` differs, proposals show a provisional notice and no auto-apply happens.
