# 04. AWS Events API notes

Legend: **[docs]** verified from the official developer guide on Sept 29, 2026. **[report]** reported by another hackathon participant's public repository, not verified. **[unknown]** must be found in Spike 0. Official guide: `https://docs.aws.amazon.com/events/latest/devguide/what-is-events-api.html`.

## Surfaces

- REST base `https://api.awsevents.com/v1`. MCP server `https://api.awsevents.com/mcp` (streamable HTTP). Same 12 operations on both. [docs]
- `ListEvents` and `GetEvent` need no credentials for any event. Events that require registration still appear in the list. [docs]
- For events that require registration (re:Invent), the session catalog and the attendee's schedule need a signed-in attendee registered for that event. The MCP server requires sign-in for every call. [docs]
- It does **not** register anyone, expose other attendees, search or filter the catalog, or guarantee a reservation. [docs]
- Event ID for re:Invent 2026 appears in examples as `reinvent2026`. Confirm with `ListEvents`. [docs, confirm]

## Operations

`ListEvents`, `GetEvent`, `ListSessions`, `GetSession`, `GetSchedule`, `ReserveSessions`, `CancelReservation`, `AssociateFavorites`, `DisassociateFavorite`, `CreatePersonalTime`, `UpdatePersonalTime`, `DeletePersonalTime`. [docs]

- `ListSessions`: `GET /v1/events/{eventId}/sessions`. Page size set by the service and can vary. Every page reports `totalCount`. Stop only when `nextToken` is absent. `includeAbstracts=false` omits the abstract, the largest field. Optional `locale`, default `en-US`. [docs]
- Session fields: `sessionId`, title, abstract, short session code, type, level, taxonomy lists (tracks, topics, industries, roles, services), start, end, room, venue, all-day flag, reservable flag and when, a coarse fullness indication, speaker names. A field is present only when the event provides it. [docs]
- `GetSchedule`: `GET /v1/events/{eventId}/schedule`. Returns reserved sessions, favorites and personal time. It is the source of truth and the only place new IDs appear. [docs]
- `CreatePersonalTime`: `POST /v1/events/{eventId}/personal-time`. Fields: `title` (1 to 128), `description` (1 to 250), `startDateTime` and `endDateTime` (`YYYY-MM-DDTHH:mm:ss`, documented as UTC, no offset, no `Z`), duration a whole number of 5-minute increments, `location` (optional, up to 255). Returns no body. [docs]
- Reservations: reserved seating for re:Invent 2026 opens Oct 6, 2026 in the portal and Oct 8 through the API. Until then reserve and cancel return `409`. Reading and favorites work. [docs]

## Quotas (per attendee, per minute) [docs]

| Operation | Quota |
|---|---|
| GetSession | 120 |
| ListSessions | 60 |
| GetSchedule | 60 |
| ReserveSessions | 30 sessions |
| CancelReservation | 30 |
| AssociateFavorites | 30 sessions |
| DisassociateFavorite | 30 |
| CreatePersonalTime | 30 |
| UpdatePersonalTime | 30 |
| DeletePersonalTime | 30 |

`ReserveSessions` and `AssociateFavorites` count each session, so batching saves round trips, not quota. A `429` carries `Retry-After` (seconds left in the current minute). A refused request spends no quota, so a batch larger than what remains can be made smaller and retried at once.

## Errors [docs]

`400` fix the request (also a `nextToken` the API did not issue). `403` with a JSON body: signed in but not registered for the event. `403` with no body: the edge refused this address. `404` event, session or personal-time entry missing. `409` operation closed for now, not a bug. `5xx` unknown outcome for writes. **There is no idempotency key.** Reserve, favorite and `CreatePersonalTime` can partially succeed or duplicate; reconcile from `GetSchedule` before retrying. The edge can answer with HTML, so never assume the body is JSON.

## Authentication [docs]

- OAuth 2.0 authorization code with PKCE. Authorization endpoint `https://oauth.awsevents.com/oauth2/authorize`, token endpoint `https://oauth.awsevents.com/oauth2/token`, revoke `https://oauth.awsevents.com/oauth2/revoke`, logout `https://oauth.awsevents.com/logout`.
- Shared public client ID `7vmom55m1qstvq8i71ph127bfq`. Scope `openid email events/access`.
- The app **must run on the attendee's machine**. Redirect is `http://localhost:<port>/callback` with port 8484 to 8489, both `localhost` and `127.0.0.1` forms registered, matched exactly. The authorization request and the token exchange must send the identical `redirect_uri` string. No hosted redirect exists.
- Access token: JWT valid 60 minutes, the only token sent to the API. ID token: for the app's own use, not accepted by the API. Refresh token: opaque, valid 30 days, used only at the token endpoint.
- Sign-out: revoke the refresh token (it does not invalidate an already issued access token, which is accepted until it expires), delete both tokens, then end the Builder ID session at `https://profile.aws.amazon.com` if the user wants a full sign-out. Skipping the Builder ID step signs the attendee straight back in.
- Claude Code's documented MCP setup uses callback port 8484. Junction must fall back through 8485 to 8489 if 8484 is taken.

## MCP configuration examples [docs]

Kiro: `oauth.clientId` as above, `redirectUri: "http://127.0.0.1:8976"` (end at the port), scopes as above. Claude Code: `claude mcp add --transport http --scope user awsevents https://api.awsevents.com/mcp --callback-port 8484 --client-id 7vmom55m1qstvq8i71ph127bfq`. Always set the port; a random port cannot sign in.

## Verified by probe, 2026-10-01 (no credentials, public requests)

- `GET https://api.awsevents.com/v1/events` returns `200` with `Access-Control-Allow-Origin: *`. re:Invent 2026 is `eventId: "reinvent2026"`, `authenticationRequired: true`, `timezone: "America/Los_Angeles"`, `startDate` 2026-11-30, `endDate` 2026-12-04, `timeFormat: "12 hour"`. The event ID is confirmed.
- `OPTIONS https://oauth.awsevents.com/oauth2/token` returns `200` echoing the request `Origin` in `Access-Control-Allow-Origin`, allowing `POST`, `authorization` and `content-type`, with `Access-Control-Allow-Credentials: true`. A browser can exchange the authorization code and refresh tokens.
- `OPTIONS` on `/v1/events`, `/v1/events/reinvent2026/schedule` and `/v1/events/reinvent2026/sessions` returns `404 MissingAuthenticationTokenException` with no CORS headers. A browser cannot send `Authorization` to the REST routes, because the preflight fails. Unauthenticated `GET` returns `401 "Sign in to continue"` with `Access-Control-Allow-Origin: *`.
- `OPTIONS https://api.awsevents.com/mcp` returns `200` with `Access-Control-Allow-Origin: *`, allowing `POST` and the headers `authorization`, `content-type`, `mcp-protocol-version`. `POST /mcp` without a token returns `401` with a `WWW-Authenticate: Bearer ... resource_metadata` header and a JSON-RPC error. So the MCP endpoint is the browser-usable surface.
- Read from the guide the same day: `auth-signing-in` says "Your application must run on the attendee's machine. It listens at `/callback` on one of six reserved loopback ports, `8484` through `8489`. […] `redirect_uri` is matched exactly, with no wildcards. […] There is no hosted redirect URI, so you can distribute an application that signs attendees in, but it has to run locally." `auth-handling-tokens` says "In a browser application, keep both tokens in memory only." and "Send the access token only to `https://api.awsevents.com`." `auth-endpoints` lists the Builder ID sign-out endpoint `https://idp.awsevents.com/oidc/logout`, and says to always send `identity_provider=AWSBuilderID`. `rest-api` says the full OpenAPI is served at `https://api.awsevents.com/v1/openapi.json`.
- Decision (ADR-012): the local agent is primary. A browser-side sign-in is possible technically but contradicts `auth-signing-in`, so it is only a Spike 0 experiment (item 13) and is adopted only with written confirmation.

## Reported by other participants (verify)

- Personal time entries display as local time in the official app even though the reference says UTC. [report]
- A valid token for someone not registered for re:Invent returns 403. [report]
- Catalog data must not be committed because the re:Invent catalog is not public. [report, treat as a rule]

## Spike 0 checklist (do first, about two hours, with real sign-in)

Record each result in `docs/FINDINGS.md` with the date. Save redacted raw responses under `fixtures/private/` (git-ignored).

1. Sign in with Builder ID on 8484, then again with 8484 occupied to prove the fallback. `ListEvents` and confirm the re:Invent 2026 event ID (done 2026-10-01: `reinvent2026`).
2. Walk the whole catalog. Compare the count with `totalCount`. Record page sizes. Time it against the 60 per minute quota. Decide the polling cadence.
3. Field inventory: which session fields are present, their exact names and types, the taxonomy labels for topics, tracks, services, roles, industries. Save the label lists to build the topic picker.
4. Session codes: list every suffix pattern with counts. Confirm `-R`, `-R1` and any others. For twenty repeat groups, diff the fields that differ.
5. Venue and room strings: list distinct values and build the venue normaliser and a first walking-time graph.
6. Fullness: which values exist, and how they relate to reservable, and to reservation opening.
7. `GetSchedule` shape with an empty schedule, after a favorite, after a personal-time entry. Save fixtures.
8. Personal time on the phone: create a test entry (title, description with a tag, location) and open the official AWS Events mobile app and the portal. Does it show title, description, location? At what time? Does creating one trigger a notification? Decide `personalTimeMode`. Delete it.
9. Favorites round trip: favorite on the phone, then `GetSchedule`. How long until it appears? Same the other way.
10. OpenAPI: published at `https://api.awsevents.com/v1/openapi.json` (found 2026-10-01). Generate types from it and diff it against the real responses seen in items 2 to 7.
11. Bulk favorite of ten sessions where one ID is invalid. Record the response shape for partial failure.
12. Unregistered or edge 403 behaviour if reproducible.
13. Optional experiment, only if time allows and never as a base for features: from a throwaway local page, run PKCE, exchange the code in the browser, and call `/mcp` (`initialize`, `tools/list`, `GetSchedule`) to learn whether the 12 operations and structured results are available there. Tokens in memory only. Keep the result in `docs/FINDINGS.md`; adopting it needs written confirmation from the organizers or AWS.

## FINDINGS.md template

```
# Findings
## <date> Spike 0
- Event ID:
- Catalog: total, pages, page size, walk time:
- Session fields present:
- Taxonomy labels (topics / tracks / services / roles / industries): saved in fixtures/private/labels.json
- Code suffix patterns and counts:
- Repeat groups: differing fields observed:
- Venues and rooms:
- Fullness values:
- GetSchedule shape:
- Personal time on phone (title/description/location shown? time shown as? notification?): 
- personalTimeMode decision:
- Favorites latency:
- OpenAPI available:
- Partial failure shape:
- Surprises:
```
