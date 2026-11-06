# 03. Data contracts and algorithms

Everything here is implemented in `packages/core` and covered by tests. JSON Schemas are in `schemas/`.

## Identifiers

- `memberId` = `m_` + first 16 characters of lower-case base32 of sha256(raw Ed25519 public key).
- `squadId` = `sq_` + first 16 characters of lower-case base32 of sha256(leader public key ‖ 16-byte random nonce).
- `sessionId` is the opaque ID from the Events API. `code` is the short session code (for example `OPS305-R`). Both are carried; `sessionId` is canonical, `code` is for people.

## Signed envelope

All messages are wrapped in the same envelope.

```json
{ "kid": "m_abc...", "alg": "Ed25519", "payload": "<base64url of canonical JSON>", "sig": "<base64url signature over the payload bytes>" }
```

Canonical JSON is RFC 8785 (JCS), implemented with the `json-canonicalize` package. The signature covers the UTF-8 bytes of the canonical payload. Verification order: decode, check `kid` is in the latest verified charter (or the payload is the charter itself, signed by the leader), verify signature, validate with zod, check `seq`.

## Charter (signed by the leader)

```json
{
  "v": 1, "type": "charter", "squadId": "sq_...", "name": "Demo squad", "eventId": "reinvent2026",
  "leader": "m_...", "seq": 3, "issuedAt": "2026-10-05T18:00:00Z", "expiresAt": "2026-12-18T00:00:00Z",
  "inviteVerifier": "<base64url sha256 of the invite secret>",
  "members": [ { "memberId": "m_...", "name": "Ana", "publicKey": "<base64url raw Ed25519>", "role": "leader", "joinedAt": "..." } ],
  "topics": [ { "id": "agentic", "label": "Agentic AI", "weight": 5, "target": 2,
                "match": { "topics": ["..."], "services": ["..."], "tracks": ["..."] } } ],
  "mustCover": [ { "sessionId": "..." } ],
  "lunch": { "start": "12:00", "end": "13:00", "protected": true },
  "caps": { "maxPerDay": 5 },
  "travel": { "bufferMin": 5 },
  "tolerance": 0.2
}
```

`match` values are taxonomy labels as they appear in the real catalog. Discover them in Spike 0 (`junction catalog stats`) and build the topic picker from real labels.

## Manifest (signed by each member)

```json
{
  "v": 1, "type": "manifest", "squadId": "sq_...", "memberId": "m_...", "seq": 12,
  "issuedAt": "2026-10-08T15:04:05Z", "eventId": "reinvent2026", "catalogHash": "sha256:...",
  "share": "L0",
  "sessions": [ { "sessionId": "...", "code": "OPS305-R", "status": "reserved", "priority": 3, "locked": false, "role": "attendee" } ],
  "holds": [ { "sessionId": "...", "reason": "declined" } ],
  "busy": [ { "start": "2026-12-01T18:30:00Z", "end": "2026-12-01T19:30:00Z" } ],
  "at": { "venue": "venetian", "since": "2026-12-01T18:00:00Z" }
}
```

- `status`: `reserved`, `favorite`, `maybe`.
- `priority` 1 to 5, default 3. `locked` marks sessions the solver may never move (for example the member is a speaker). `role` is `attendee` or `speaker`.
- `holds` (session IDs only, at most 200) tells every solver what this member does not want to change. `reason` is `declined` (the member rejected a proposal that adds this session, or that removes or replaces it) or `pinned` (the member marked it as untouchable). Solvers never propose adding a `declined` session to this member, and never propose removing or replacing a `pinned` one. UI convention that makes this work: declining a proposal that **adds** a session writes `declined` on the added session ids; declining a proposal that **removes** a session writes `pinned` on the removed ones. A hold drops out when the member clears it or after 24 hours via a new manifest that no longer lists it. Allowed at every share level.
- `busy` only at share level L1 or higher, `at` only at L2. The schema rejects these fields at lower levels.
- The manifest never contains titles, abstracts, speakers, rooms or free text.

## Signal (scout note)

```json
{ "v": 1, "type": "signal", "squadId": "sq_...", "memberId": "m_...", "sessionId": "...", "code": "OPS305-R",
  "verdict": "worth-it", "note": "Bring a laptop, hands-on from minute 10.", "issuedAt": "..." }
```

`verdict`: `worth-it`, `skip-repeat`, `crowded`, `wrong-level`, `moved`. `note` at most 140 characters, plain text, rendered escaped.

## Claim

```json
{ "v": 1, "type": "claim", "squadId": "sq_...", "memberId": "m_...", "sessionId": "...", "rank": 0, "issuedAt": "..." }
```

## Session code parsing and repeat groups

> **Provisional until Spike 0.** The regex, the meaning of suffixes and the repeat grouping below are implemented in `packages/core/src/codes.ts` and `repeats.ts` and tested on invented data only. Nothing here has been checked against the real catalog. Spike 0 item 4 decides.

Observed code shapes: `COM302-R` and `COM302-R1`. Working regex:

```
^([A-Z]{2,6}\d{2,4}[A-Z]?)(?:-([A-Z]+)(\d*))?$   →  base, suffixLetters, suffixIndex
```

Do not trust the meaning of suffixes until Spike 0 lists every suffix present in the real catalog with counts. Grouping:

1. Group by `base` and normalised title (lower-case, Unicode NFKC, punctuation stripped, whitespace collapsed). Same base but different normalised title means **not** a repeat group; flag it.
2. Confidence `high` when base and title match. Confidence `probable` when only normalised title, level and type match across different bases. Solver uses only `high` unless the charter says otherwise.
3. For every group compute `differences`: type, features, level, speakers, start, venue. Repeats can differ (one observed pair differed in its features: community-led versus customer story). The UI always shows the differences before a swap between repeats is accepted.

## Coverage

For every topic `t`, day `d`: `count(t,d)` = number of distinct members holding at least one session in `t` on `d` (statuses reserved or favorite, plus maybe when the member's view includes maybes). States: `none` (0), `under` (0 < count < target), `ok`. Topic membership of a session comes from the charter's `match` against the session's taxonomy lists.

Duplicates: a session held by more than one member. Planned when attendees at most the topic target, otherwise unplanned. If a session matches several topics, the target is the highest `target` among them, ties broken by lowest topic `id`.

Infeasible hop: consecutive sessions of a member where `need = walking minutes (venue graph) + travel.bufferMin` is greater than `have = start of next minus end of previous`. The UI shows both numbers ("needs 28 min, has 15"); the buffer is part of `need`.

## Solver (pure function)

```ts
export interface SolverInput {
  charter: Charter; manifests: Manifest[];      // verified, latest per member, sorted by memberId
  catalog: CatalogSnapshot; venueGraph: VenueGraph;
  firstSeen?: Record<string, string>;           // sessionId -> ISO time, only for the claim rule. Supplied by the caller; core never reads a clock.
}
export interface Proposal {
  id: string;                                   // sha256 of canonical JSON of the proposal without id
  kind: 'SWAP' | 'CLAIM' | 'DROP' | 'MEET';
  memberId: string;                             // who is asked to act
  add?: string[]; remove?: string[];            // sessionIds
  meet?: { start: string; end: string; venue: string; members: string[] };
  squadDelta: number; personalDelta: number;    // integers in milli-units
  reasons: ReasonCode[];                        // machine codes, the UI turns them into plain sentences
  differences?: string[];                       // for repeat swaps
  provisional: boolean;                         // catalog hashes differ
}
export function propose(input: SolverInput): Proposal[];
```

**Arithmetic.** Use integer milli-units everywhere. No floating point in comparisons. Sort strings with a locale-independent comparison (`a < b` on code points).

**Squad value** `V`:
- coverage: sum over topic and day of `weight × 1000 × min(count, target) / target`, rounded down to an integer with integer division
- must-cover: 3000 for every must-cover session held by at least one member
- unplanned duplicates: −500 each
- infeasible hops: −2000 each

**Personal value** `P` for member `i`: sum over their sessions of `priority × 200`.

**Independence (ADR-013).** Proposals are computed against the **current** manifests, never against the result of earlier proposals. Each proposal is valid on its own, so accepting or declining one never invalidates another. Two proposals that would break a shared constraint together (the same uncovered session offered to two members, for instance) are not both emitted: the one that wins the order below is emitted, the other is dropped until the next sync. `holds` are respected as described above.

**Moves** are generated per member: SWAP to a session in the same repeat group, or in the same topic and day within a level of the original (if the charter allows); CLAIM an uncovered must-cover or newly added session; DROP a session that is an unplanned duplicate; MEET as in section H of the spec.

**Feasibility** for a candidate: no time overlap with the member's other sessions, walking time plus buffer fits, per-day cap respected, protected lunch window not overlapped unless the member already holds that session, target session not marked `full`, member's `locked` sessions untouched.

**Acceptance** of a move: `ΔV ≥ 50` and `ΔP ≥ −floor(tolerance_milli × P_current / 1000)`, where `P_current` is the member's personal value before the move and `tolerance_milli` is the charter `tolerance` times 1000 as an integer (0.2 becomes 200). The member never loses more than that share of their own value for the squad's gain. (The earlier per-session form accepted every drop, since dropping a session of priority `p` costs exactly `200 × p`.)

**Search.** Deterministic hill climb, at most 50 iterations, used only to **rank** moves. Each iteration sorts all feasible accepted moves by (−ΔV, −ΔP, canonical string of the move) and takes the first, to find the order and to detect conflicts between moves. The emitted proposals are the selected moves, each re-evaluated against the current state (see Independence), in that order.

**Properties to test** (fast-check): same inputs give identical output in any manifest arrival order; never moves a locked session; never touches a `pinned` hold nor adds a `declined` one; never violates feasibility; each proposal stands alone (applying any one leaves the others still valid or cleanly dropped); ΔV strictly positive for every proposal; output is stable under re-run with the applied moves already reflected (idempotence); golden fixture identical on Linux, macOS and Windows CI.

## Launch claim rule

For a session newly added to the catalog:

1. `eligible` = members with a feasible slot for it (no overlap, walking fits, cap respected, not locked out) and whose topics match.
2. Rank eligible members by (topic sessions that day ascending, total sessions that day ascending, lower-case hex of sha256(`memberId` + `:` + `sessionId`) ascending). Rank 0 is the owner.
3. Rank `r` may claim after `announceTime + r × 5 min`. `announceTime` is the earliest announcement the squad server recorded for that session (a conditional put), or the local first-seen time when offline. Either value is an input (`firstSeen`); the rule itself never reads a clock.
4. A claim is a conditional write on `CLAIM#<sessionId>` with `attribute_not_exists`. The first wins. A losing call returns the winner's `memberId` and the loser removes the proposal.

## Personal-time ownership tag

Description starts with a tag so Junction can find its own entries after the API returns no IDs on create:

```
[jn1:<kind>:<squad8>:<hash6>] <plain text>
```

- `kind`: `meet`, `walk`, `buf`. `squad8` first 8 characters of the squad ID without the prefix. `hash6` first 6 hex of sha256(kind | squadId | proposalId), the proposal's stable ID, so the tag still matches after an `UpdatePersonalTime` changes times or location.
- Title at most 128 characters. Description at most 250 including the tag. Start and end in 5-minute increments.
- Before creating, read `GetSchedule` and skip if an entry with the same tag exists. After creating, read `GetSchedule` and store the returned ID against the tag. Update and delete only entries whose description matches the tag pattern.
- **Timezone:** the reference says start and end are UTC with no offset or `Z`; another participant reports the official app displays them as local time. Spike 0 decides and stores `personalTimeMode` (`utc` or `event-local`) in config. Never guess.

## Squad server API

All routes are signed. Header: `Authorization: Junction kid=<memberId>, ts=<unix seconds>, nonce=<random 16 bytes base64url>, sig=<base64url>` where the signed string is `METHOD\nPATH\nts\nnonce\nhex(sha256(body))`. Timestamp window 120 seconds. Payload cap 64 KB.

| Route | Who | Behaviour |
|---|---|---|
| `POST /v1/squads` | leader | Create from a signed charter. 201, or 409 if the ID exists. |
| `PUT /v1/squads/{id}/charter` | leader | Replace with a higher `seq`. |
| `GET /v1/squads/{id}` | member | Returns the charter and the latest envelope per member. Supports `If-None-Match`. |
| `PUT /v1/squads/{id}/members/{mid}/manifest` | that member | Store if `seq` is higher than stored. |
| `POST /v1/squads/{id}/signals` | member | Append. |
| `GET /v1/squads/{id}/signals?since=` | member | Page of signals. |
| `POST /v1/squads/{id}/announcements` | member | Conditional put of the earliest announcement per session. |
| `POST /v1/squads/{id}/claims` | member | Conditional write. 201 winner, or 409 with the winner. |
| `POST /v1/squads/{id}/join-requests` | anyone with the invite | Body carries member public key, name and the invite secret. Server checks sha256(secret) equals the charter's verifier. |
| `GET /v1/squads/{id}/join-requests` | leader | Pending requests. |
| `DELETE /v1/squads/{id}/members/{mid}` | that member or the leader | Removes the member's data. |
| `DELETE /v1/squads/{id}` | leader | Purges the squad. |
| `GET /v1/health` | anyone | 200. |

DynamoDB single table: `pk=SQUAD#<id>` with `sk` values `CHARTER`, `MANIFEST#<mid>`, `SIGNAL#<iso>#<mid>#<sessionId>`, `ANNOUNCE#<sessionId>`, `CLAIM#<sessionId>`, `JOIN#<mid>`, `NONCE#<nonce>`. Every item has `ttl` = the charter's `expiresAt` as epoch seconds (nonces: 10 minutes). `expiresAt` itself is the event end plus 14 days, set once by the leader, so nothing counts the 14 days twice.

## Local MCP tools

| Tool | Input | Output |
|---|---|---|
| `squad_coverage` | `day?` | Coverage matrix as structured data plus a short text summary. |
| `squad_gaps` | `day?` | Uncovered must-cover sessions, under-target topics, infeasible hops. |
| `squad_proposals` | `memberId?` | Current proposals with reasons and provisional flags. |
| `squad_accept` | `proposalId`, `confirm: true` | Applies the proposal to the signed-in member's own schedule and returns per-session results. Refuses without `confirm: true`. |
| `squad_note` | `sessionId`, `verdict`, `note` | Posts a scout note. |

Tools return titles from the signed-in member's own local catalog only, and never expose another member's fields above the sharing level that member chose.

## Addendum: what was built and where it differs (2026-10-01)

Everything above is implemented in `packages/core`. These are the places where the code does something the text does not say, or does it differently. Each one has a test.

### Schemas and messages

- **Parity instead of generation.** `schemas/*.json` stay hand-maintained, because they carry rules zod cannot express in JSON Schema (the sharing-level `allOf` in the manifest). `packages/core/test/schema-parity.test.ts` compares them with the zod schemas (properties, required, enums, constants, bounds, patterns, `additionalProperties`) and fails on drift. It already found one: `mustCover[].sessionId` had no bounds in `charter.schema.json`; it now has 1 to 128 like every other session id.
- A manifest is also rejected when the same `sessionId` appears twice in `sessions` or in `holds`. The text does not say it, and duplicate rows would make solver input ambiguous.
- `openCharter` and `openMessage` follow the verification order of "Signed envelope". A charter is checked for one leader, unique members, member ids that match their public keys, and `expiresAt` after `issuedAt`. A signed payload that is not canonical JSON is rejected (`non-canonical`).
- `core` never generates randomness. Key pairs come from a caller-supplied 32-byte seed (`keyPairFromSeed`), squad ids from a caller-supplied 16-byte nonce.

### Time and catalog

- No `Date`, `Intl` or time zone database in core. Instants are epoch seconds or minutes, and the event's local day comes from a fixed `utcOffsetMin` on the catalog snapshot (Las Vegas in December: -480). The lint rule in `eslint.config.js` enforces this for `packages/core`.
- Core works on a normalised `CatalogSession` (epoch-minute start and end, a normalised venue id). `toCatalogSession` maps an Events API session into it, converting the local `sessionTime` of the OpenAPI, and skips with a reason when a session has no code, time or known venue. Field names for `type`, `level` and `features` are provisional until Spike 0.
- `catalogHash` hashes the canonical JSON of the sorted rows `[sessionId, startMin, endMin, venue, room]`, prefixed `sha256:`.
- The venue graph gives each venue a position `at` (walking minutes along the Strip). Explicit edges override it for the solver. The default graph is the one drawn in `design/reference.html` and is marked approximate.

### Coverage

- A hop needs `walk + travel.bufferMin` and has `end of next - start of previous` minutes. The buffer applies within a venue as well. An overlap is reported as a hop with a negative gap. A hop with an unknown venue is **not judged** and is listed in `unjudgedHops` instead of being guessed.
- The report also carries `offered` (sessions available per topic and day), `unknownSessions` (held but missing from this catalog, a sign the catalogs differ) and `collidesWithLunch` on must-cover gaps.

### Solver

- **No MEET proposals yet.** MEET is a "could" item (H1) and is cut first. The `Proposal` type reserves it.
- **SWAP** is only to another session in the same high-confidence repeat group. "Same topic and day within a level" needs a charter flag that does not exist, so it is not built.
- **DROP** is only for unplanned duplicates, as the text says. An impossible connection is fixed by a SWAP to a repeat that fits, never by a DROP.
- **CLAIM** is only for a must-cover session or a session in `SolverInput.newSessions` that nobody holds, and it is proposed to the owner under the claim rule only, not to everybody.
- **ΔP** for a SWAP is 0 (the repeat inherits the priority), for a DROP it is minus the dropped value, for a CLAIM it is plus priority 3 times 200. The acceptance limit is `floor(tolerance_milli x P_current / 1000)` of the member's own value, with the charter's 0.2 as the default.
- **Acceptance is stricter than the text.** Besides `squad delta >= 50`, no component of V (coverage, must-cover, duplicates, hops) may fall, and a must-cover session is never released by its sole holder, not even for its own repeat. Property tests found why: without this the solver asked a member to claim a must-cover session and then, next round, to swap it for its repeat (also must-cover) and claim it again.
- **Each proposal stands alone.** Candidates are ranked by `(-squad delta, -personal delta, canonical move)` and taken in that order. One is kept only if it is still accepted after the earlier ones, **and** every earlier one is still doable if only this one is applied. This closes a case the property tests found: a DROP that made a CLAIM stop fitting because the dropped session was the claim's neighbour. Pairwise independence is guaranteed and checked; three-way interplay is not.
- `MIN_SQUAD_GAIN` (50) is never the deciding factor with the schema limits (weight at least 1, target at most 5 make the smallest positive change 200). It is kept because the text asks for it.
- Ties go to the lowest member id (it is part of the canonical move string). The demo keys were chosen so Ana sorts before Luis, which addresses the OPS305-R1 swap to Ana as in the reference.
- **Claim rule.** Members carry no personal topic list, so eligibility does not filter by topic: it is "can fit it and has not declined it". The session's topics only drive the ranking. `rankClaimants` and `mayClaim` take the clock as an argument.
- `provisional` is true when the manifests do not all carry the same `catalogHash`.

### What the tests prove

`solver.property.test.ts` runs the checks of "Properties to test" on random squads, with the rules re-implemented independently in `test/world.ts`: order independence, locked and pinned never moved, declined never added, feasibility, delta at least 50 and equal to an independent recomputation, tolerance, proposals standing alone, no repeated move across rounds with the value always rising, and at most 50 proposals. The golden fixture hash for the demo squad is pinned in `fixtures/generate.test.ts` and must match on Linux, macOS and Windows CI (not yet run: the repository has no remote CI result).

## Addendum: squad server as built (2026-11-06)

Implemented in `packages/relay` (`handler.ts`, `store.ts`, `client.ts`), tests in `packages/relay/src/*.test.ts`.

- **Order of checks.** Body cap (64 KB, 413) then route, then the stored charter (404 if missing or past `expiresAt`), then the request signature against the charter member key, then the nonce (conditional put of `NONCE#<nonce>`, 10 minute TTL; a replay is 401), then the envelope with `openCharter` or `openMessage`. `POST /v1/squads` verifies the request against the leader key inside the submitted charter. A join request verifies against the public key in its body and checks `sha256(utf8(inviteSecret))` against `inviteVerifier` in constant time.
- **`Authorization: Bearer` is refused** with 401 `bearer-refused` and never echoed.
- **What an item holds.** The envelope as received (`env`) plus bookkeeping: `mid` (writer, for leave), `seq` (for the conditional seq-increasing put), `at` (server receive time), `ttl`. Join requests hold `publicKey`, `name` (1 to 40 characters, no control characters) and `at`; the invite secret is never stored. Announcements hold `mid` and `at` only.
- **Announcement body** is exactly `{ "sessionId": "<id>" }`. 201 for the first, 200 with the earliest `memberId` and `announcedAt` for later calls.
- **Claims.** 201 to the winner, 200 when the winner repeats its claim, 409 `already-claimed` with `winner` and the winning envelope otherwise.
- **Signals** are keyed by server receive time, not the signed `issuedAt`, so `since` paging cannot be skipped by a backdated note. `GET .../signals?since=` takes an ISO instant or the `cursor` from the previous page; pages hold 100 and say `more`.
- **`GET /v1/squads/{id}`** returns `{ charter, manifests }`, only manifests of current charter members, with a strong `ETag` (sha256 of the body). `If-None-Match` gives 304.
- **Leave** (`DELETE .../members/{mid}`) deletes every item that member wrote. **Purge** deletes everything except nonces, which expire on their own so a recorded create request cannot be replayed.
- A charter must expire in the future and at most 400 days ahead. At most 50 pending join requests per squad (429).
- Logs carry `route`, `status` and `squadId` only.
