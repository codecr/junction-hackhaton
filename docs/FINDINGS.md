# Findings

Source of truth for real Events API behaviour. Each entry is dated. Catalog content is never copied here (CLAUDE.md rule 3); only shapes, counts and patterns.

## 2026-11-06 OpenAPI re-read (public, no credentials)

Source: `https://api.awsevents.com/v1/openapi.json`, fetched today. Changes against what docs/04 recorded on 2026-10-01:

- **Personal time is event-local wall clock, not UTC.** `PersonalTimeInput.startDateTime` is now documented as "`YYYY-MM-DDTHH:MM:SS` as wall-clock time in the event's own timezone (the event's `timezone`), not UTC". A trailing `Z` or an offset is still rejected, seconds must be `00`, and the end must be on the same date. This settles `personalTimeMode`: **event-local**. The agent sends local times (`packages/agent/src/app.ts`, `personalTimeBody`).
- **Bulk requests take at most 10 session ids** (`AssociateFavoritesRequestContent.sessionIds` and `ReserveSessionsRequestContent.sessionIds`: `maxItems: 10`, `uniqueItems: true`). The client splits larger batches (`BULK_MAX`).
- **Responses are wrapped:** `GetSchedule` returns `{ schedule }`, `GetSession` `{ session }`, `GetEvent` `{ event }`, bulk writes `{ result: { successful, failed } }`. `ListSessions` and `ListEvents` return `{ items, ... }`.
- `CreatePersonalTime`, `UpdatePersonalTime`, `DeletePersonalTime`, `CancelReservation` and `DisassociateFavorite` return `204` with no body. Create still returns no id: the agent finds its entry by tag in `GetSchedule`.
- `BulkFailureCode` values: `sessionNotReservable`, `scheduleConflict`, `alreadyScheduled`, `sessionFull`, `insufficientAccess`, `timePassed`, `alreadyFavorited`, `notFavorited`, `other`. The spec says to treat unknown values as a generic refusal; the client keeps codes as plain strings.
- `409` is `OperationUnavailableException`: "intentionally disabled … Retrying will not help until it is re-enabled."
- `429` carries `Retry-After` in seconds.
- `ListEvents` and `GetEvent` need no credentials. Verified live today with `junction doctor`: `reinvent2026` is listed.

## 2026-11-06 Spike 0 (real sign-in, one registered attendee)

- **Sign-in:** PKCE with `identity_provider=AWSBuilderID` on `http://127.0.0.1:8484/callback` worked on the first try. Tokens in `~/.junction/credentials.json`.
- **Catalog walk:** 2476 sessions in 10 pages, `totalCount` 2476, 8.8 s end to end with `includeAbstracts=false`, well inside the 60 per minute quota. Page size 250 except the last.
- **Field presence (of 2476):** always `sessionId`, `abbreviation`, `isAllDaySession`, `isReservable`, `title`, `type`; nearly always `room`, `sessionTime`, `level`; `venue` 2438; `topics` 2358; `features` 2307; `speakers` 2125; `areasOfInterest` 1914; `roles` 1900; `services` 1664; `seatAvailability` 1482; `industries` 215. **`tracks` is never present.** Charter topic matching uses `topics` and `services`.
- **Venues:** five strings: `MGM Grand`, `Wynn/Encore`, `Caesars Forum`, `Caesars Palace`, `Venetian`. **No Mandalay Bay.** `defaultVenueGraph` mapped Caesars Palace to Caesars Forum through the alias `caesars`; fixed with `reinvent2026VenueGraph` (core), which the agent uses. The demo uses it too (ADR-022).
- **Placed on the chart:** 2352. Skipped: 84 all-day, 21 without venue, 4 without time, 15 with codes the parser rejects: double suffixes (`XXX000-S-R`, `XXX000-S-R1`) and a few `abbreviation` values that are record ids (`rec...`) rather than codes.
- **Code suffixes:** none 1002, `R<n>` 593, `R` 552, `S` 308, `D<n>` 21.
- **Levels** use an en dash: `300 – Advanced`. **Types:** Chalk talk, Breakout session, Workshop, Lightning talk, Builders' session, Code talk and others. **Features** include `Community-led` and `Customer story`, confirming that repeats can differ in format.
- **Fullness:** `seatAvailability` is `unavailable` for 1471 of 1482 reservable sessions in November; `limited` 4, `veryLimited` 7.
- **GetSchedule:** `{ schedule: { reserved, favorites, personalTime } }`, all three present. This attendee: 0 reserved, 18 favorites, all 18 placed on the chart.
- **Favorites round trip:** `AssociateFavorites` with one valid and one invalid id returned 200 with `successful: [valid]` and `failed: [{ code: "other" }]` for the invalid one. The favorite appeared in `GetSchedule` immediately. Favoriting it again gave `failed: [{ code: "alreadyFavorited" }]`. `DisassociateFavorite` removed it at once; a second call returned 404 "This session is not among your favorites."
- **Personal time:** create with a plain description at event-local times returned 204 and the entry appeared in `GetSchedule` with its `personalTimeId`. **A description starting with `[jn1:meet:...]` was refused with 400 "The personal time entry could not be applied."** The ownership tag is now `jn1-<kind>-<squad8>-<hash6>` (letters, digits, hyphens), confirmed below.
- **DeletePersonalTime returned 204 but one entry stayed** in `GetSchedule` for more than 5 minutes after two deletes; two other entries from the same run were deleted normally. A 204 on delete is therefore not proof; Junction confirms every delete from `GetSchedule` (`deleteMeet` returns whether the entry is gone). The leftover test entry was removed by hand in the portal.
- **Existing entries made by another tool earlier appear 8 hours late**, consistent with having been written in UTC before the API documented event-local wall clock.

## 2026-11-06 Squad server deployed

- `JunctionRelayStack` in us-east-1, custom domain `https://api.junction.gerardo.dev` (ACM certificate validated through the Route 53 zone in the same account). Deployed in 203 s.
- The account's Lambda concurrency limit is 10, so the stack runs with `reservedConcurrency: 0` (ADR-019); API Gateway throttling (20/40) is the cap.
- Smoke tests: `GET /v1/health` 200 on both URLs; an unsigned request to an existing squad gets 401 `unsigned`; a `Bearer` header gets 401 `bearer-refused`; `junction squad server` published the charter and `junction sync` stored the signed picks.
- Stored items checked with a table scan: the charter, one manifest whose session entries carry only `sessionId`, `code` and `status`, and nonces. No titles, rooms or tokens.

## 2026-11-06 Personal time with the new tag (real account)

`junction meet add`, then the same command again, `meet move`, `meet delete`, each confirmed from `GetSchedule`:

- Create with description `jn1-meet-…  Squad meeting point, set by Junction.` and location `Venetian`: 204, the entry appeared with its `personalTimeId`, start `2026-12-01T07:00:00` echoed as sent (event-local).
- The second identical `meet add` found the tag in `GetSchedule` and created nothing.
- `UpdatePersonalTime` to 07:15: 204, and `GetSchedule` showed the new start.
- `DeletePersonalTime`: 204, and the entry was gone from `GetSchedule`. The attendee's other entries were untouched.
