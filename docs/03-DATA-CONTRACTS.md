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
- `holds` (session IDs only, at most 200) tells every solver what this member does not want to change. `reason` is `declined` (the member rejected a proposal that adds this session, or that removes or replaces it) or `pinned` (the member marked it as untouchable). Solvers never propose adding a `declined` session to this member, and never propose removing or replacing a `pinned` one. A hold drops out when the member clears it or after 24 hours via a new manifest that no longer lists it. Allowed at every share level.
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
