# Junction: cover re:Invent as a team without sharing accounts

*Draft for the AWS Builder Center project page. Paste into the editor, add the two screenshots from `design/current/`, and link the repository.*

---

Every year my team flies to Las Vegas with the same plan: "let's split up and cover more". And every year we plan alone. Three of us end up in the same chalk talk, nobody goes to the security session we actually needed, and someone books MGM Grand at 2:00 and Wynn at 2:15.

When AWS opened the re:Invent 2026 session catalog through the new **AWS Events API**, I wanted to fix that. **Junction** is a squad-coordination tool. A group of attendees decides together what to cover. Junction shows them, day by day, where the squad is exposed and proposes small changes to each person's own schedule.

**Try it without signing in:** https://junction.gerardo.dev/demo/ (fictional data, runs entirely in your browser)
**Source:** https://github.com/codecr/junction-hackhaton (MIT)

## The constraint that became the design

The Events API is personal by design. It acts only for the signed-in attendee, sign-in uses OAuth with PKCE on a loopback port, and the guide is explicit: there is no hosted redirect, "it has to run locally". So the obvious architecture is out: a web app that collects everyone's credentials and merges their schedules on a server.

I took the constraint literally:

- **Each member runs a small local agent** (Node.js). It signs in with their AWS Builder ID, reads only their own schedule, keeps the catalog in a local SQLite file, and serves the UI at `127.0.0.1`. Tokens never leave the machine and the browser never sees them.
- **Members exchange signed session codes, nothing else.** The agent turns `GetSchedule` into a small manifest of session ids and codes and signs it with the member's Ed25519 key. No titles, no rooms, no emails, no tokens. The re:Invent catalog is not public, so each machine resolves titles from its own copy.
- **No coordinator.** Every agent runs the same deterministic solver on the same inputs: the squad rules, everyone's signed picks and the catalog snapshot. It uses integer arithmetic, no clock, no randomness and code-point ordering. Five laptops compute byte-identical proposals without asking anybody. Property tests (fast-check) check determinism under any arrival order, feasibility, and that every proposal stands on its own.
- **A serverless mailbox, not a backend.** The squad server is API Gateway, Lambda (Node 22, arm64) and DynamoDB with TTL, deployed with CDK. It stores only the signed envelopes, verifies every request signature against the leader-signed squad rules, and never calls the Events API. If it is down, members paste a `junction1:` block into chat instead.

## What a squad sees

The main screen is a Marey chart, the old railway timetable: time runs left to right, venues run top to bottom spaced by walking minutes, and each person is a line. A session is a thick run and a walk is a slope. The geometry does the arithmetic. A walk that can't be made is a line that stops short with "Luis needs 28 min, has 15". A session two people booked by accident gets a yellow underlay labelled *Duplicate*. A session the squad must cover that nobody holds is hatched.

Below the chart are coverage for the week (topic by day against the target the squad set) and **proposals for you**:

- **SWAP:** move to a repeat of the same session on another day, with the differences shown first. Repeats are not identical; some change format from community-led to customer story.
- **CLAIM:** take a must-cover or newly added session nobody holds. A deterministic claim rule picks the owner, so three agents seeing a new launch session all name the same person.
- **DROP:** release an unplanned duplicate.

Accepting changes only *your* schedule. Declining writes a "hold" into your next signed picks, so no other agent proposes it again.

There is also a **local MCP server**. In Claude Code or Kiro you can ask "who covers security on Wednesday?" or "what should I change tomorrow?", and `squad_accept` applies a change only with an explicit `confirm: true`. It complements the official `awsevents` MCP server rather than wrapping it.

## How it uses the API

Junction uses all 12 operations of the REST API, paced per operation with token buckets at the published per-attendee quotas:

| Operation | Use |
|---|---|
| ListEvents, GetEvent | Health check, and the event timezone to place sessions on local days |
| ListSessions | Full catalog walk (`includeAbstracts=false`), diffed between walks to spot new sessions for CLAIM |
| GetSession | Abstract and seat availability on demand |
| GetSchedule | Source of truth for signed picks, and the confirmation read after every write |
| AssociateFavorites, DisassociateFavorite | Applying SWAP, CLAIM and DROP, and undo |
| ReserveSessions, CancelReservation | The same, when the member chooses reservations |
| Create/Update/DeletePersonalTime | Squad meeting points, tagged so Junction only ever touches its own entries |

## What was hard (and what the API taught me)

I ran a spike against my own account before building on assumptions:

- **No idempotency key.** Junction never retries a write blindly. A 5xx on a write is an "unknown outcome" and is reconciled with `GetSchedule`. Before creating personal time, it reads the schedule and skips if its tag is already there.
- **Bulk writes succeed per session.** A 200 can hide a refusal. Each session gets its own line ("Reserved", "Full, try its repeat", "Clashes with SEC301"), confirmed from `GetSchedule`. In a swap the new session is added first, and the old one is released only if the add held.
- **A 204 is not proof either.** In my spike, one `DeletePersonalTime` answered 204 and the entry was still there minutes later. Deletes are confirmed too.
- **Personal time is wall-clock time in the event's timezone**, with no `Z`. A description starting with `[` was refused, so the ownership tag is plain `jn1-meet-…`.
- **The real catalog shapes the model.** It has 2476 sessions in 10 pages (under 9 seconds within quota). There are five venues this year: Wynn/Encore, Venetian, Caesars Forum, Caesars Palace and MGM Grand, with no Mandalay Bay. Caesars Forum and Caesars Palace are six minutes apart and easy to confuse. Codes come in `-R`, `-R1`, `-S` and `-D1` variants, and a few sessions have no venue or are all-day. Every field is treated as optional and pagination stops only when `nextToken` is absent.
- **`409` is a closed operation, not a bug**, and a `403` without a body is the edge refusing the network, not a missing registration. The edge can answer with HTML, so nothing assumes JSON.

## Privacy by construction

| Leaves your machine | Never leaves your machine |
|---|---|
| Signed session ids and codes, priorities, holds | Tokens (access, refresh, ID) |
| Busy blocks or current venue, only at the sharing level you pick | Titles, abstracts, speakers, rooms |
| Squad name, display names, topic labels | The catalog and your email |

The hosted demo is the same UI compiled with fictional data and a `connect-src 'none'` Content Security Policy, so the browser itself blocks any network request.

## Try it

```bash
git clone https://github.com/codecr/junction-hackhaton.git && cd junction-hackhaton
npm ci && npm run build:web
npm run junction -- login
npm run junction -- catalog refresh
npm run junction -- squad create "My squad" --topics topics.json
npm run junction -- sync && npm run dev
```

The README covers joining a squad, the MCP server and deploying your own squad server.

## What's next

- A meeting-point proposal: find a window and venue where at least three members are free, and write it to everyone's schedule as tagged personal time.
- Scout notes: a member who attended a session posts a 140-character verdict, and members holding its repeat get a keep-or-release proposal.
- A reservation watcher that polls seat availability within quota and proposes the backup to the right person.

*Junction is an unofficial community project built for the re:Invent Event Catalog API Hackathon. It is not affiliated with or endorsed by Amazon Web Services.*
