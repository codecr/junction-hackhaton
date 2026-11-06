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

## Spike 0 (real sign-in)

Pending the first real sign-in. Record here: catalog total, pages and walk time; field presence; venue strings and whether `defaultVenueGraph` aliases match; code suffix patterns; `GetSchedule` shape; favorites round trip.
