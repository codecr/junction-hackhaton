# 00. Brief

## One sentence

Junction turns a group of re:Invent attendees into a team that covers the conference, without any of them seeing each other's accounts.

## The problem

Companies, consultancies and user groups send several people to re:Invent. Each person plans alone. The result is predictable: the same session is attended twice, the session that mattered has nobody in it, a launch session appears mid-week and five people run for the same seat, and nobody knows which repeat of a talk was worth attending.

Every planner built for this hackathon so far is single-player. The Events API makes team tools hard on purpose: it acts only for the signed-in attendee, exposes no other attendee's data, and has no hosted option. Junction treats that as the design brief, not the obstacle.

## The idea

- Each member runs a **local agent**. It reads and writes only that member's own schedule.
- Members exchange **signed manifests**: session IDs and codes, an optional priority, optional busy blocks. No titles, no tokens, no catalog content.
- Every agent runs the **same deterministic solver** on the same inputs, so all agents arrive at the same proposals with no coordinator and no shared account.
- Each member **accepts or declines** proposals for themselves. Nobody ever writes into someone else's schedule.
- Transport is optional infrastructure: a file, a pasted block, or a small AWS-hosted squad server that is only a mailbox.

## What it does (feature families)

1. Coverage: who is covering which topic on which day, against targets the squad set. Gaps, under-target topics, planned versus unplanned duplicates, impossible connections.
2. Divide and conquer: proposals to swap, drop, or claim sessions so the squad covers more with the same people.
3. Repeats: recognises repeats of the same talk, shows how they differ, and lets a scout attend the first and leave a note for the rest.
4. Launch reactor: when a new session appears in the catalog, decides deterministically who should take it and confirms the claim atomically so two people never take one seat.
5. Meeting points: finds windows when several people are free and near each other, and adds them as personal time to each member's own schedule.
6. Reservation orchestration: when seats open, orders each member's reservations by scarcity and value and assigns contested seats.
7. Local MCP server so an assistant can answer "who covers security on Wednesday?" using only what members chose to share.

## Hackathon criteria (verify on the About tab)

Reported by another participant's public plan: four equally weighted criteria at 25 percent each. Not confirmed by the official page, which could not be read when this kit was prepared.

| Criterion | How Junction answers |
|---|---|
| Creativity and novelty of the integration | Team coordination under a single-attendee API. Signed manifests, deterministic consensus, no coordinator. |
| Utility for re:Invent attendees | Teams are a large share of attendees and nobody serves them. Fewer duplicates, fewer gaps, launch sessions handled fairly. |
| Technical depth and use of the API surface | All 12 operations used for real reasons, both REST and MCP surfaces, OAuth PKCE with refresh and revocation, quotas, per-session partial failures, closed operations, no-idempotency reconciliation. |
| Quality of the Builder Center project | Clear problem, architecture diagram, live demo that judges can open without signing in, real squad results in the video. |

## The landscape (Sept 29, 2026)

All single-player planners:

- **re:Plan** (Binod231): constraint solver, travel graph, cloud watcher for seats.
- **Reinvent:Match**: person-to-session matching with explanations, walking times, reservation plan, calendar export.
- **reinvent-planner** (barroei1981): scoring, greedy scheduler, browser automation for registration.
- **reinvent26-planner** (chasko-labs): maps a real AWS footprint to topics, checks double bookings, has a Claude skill.

Junction is complementary by construction: a squad member can use any of them to plan. Junction reads the resulting schedule from `GetSchedule`.

## Demo story (3 minutes)

1. A five-person squad opens Junction. Tuesday shows on one chart: lines walking between venues.
2. Two sessions nobody covers, one duplicate nobody planned, one walk Luis cannot make.
3. Ana accepts a proposal: the Wednesday repeat replaces Tuesday's. Her official schedule updates.
4. A launch session appears. Every agent independently names the same owner. The squad server confirms the first claim.
5. Lunch is proposed where three people can actually be at 12:30.
6. Close on the architecture: nothing but session codes ever leaves a machine.

## Open questions to verify (do this first)

1. Official hackathon rules: dates, required deliverables, video length, repository visibility, licensing, judging weights. **Eligibility confirmed 2026-09-30:** Community Builders can take part.
2. Whether a hosted demo with fictional data and a hosted squad server (that never touches Events API credentials) is within the rules. Decided 2026-10-01 (ADR-012): sign-in and Events API calls run in the local agent, because `auth-signing-in` says "it has to run locally". The UI is still a web UI, served by the agent at `127.0.0.1:4848`. Browser-side sign-in on a hosted site stays unbuilt unless the organizers or AWS confirm it in writing.
3. Whether other participants' proposals overlap with squad coordination. Re-check the Builder Center gallery weekly.
4. Whether the AWS Events mobile app shows personal-time titles and descriptions (Spike 0). This decides how much of the "proposals appear in the official app" idea can be used.
