# 07. Submission

Verify every requirement on the hackathon About tab. What follows is a working outline, not the official rules.

## Builder Center project page

1. **Title and one-line pitch.** "Junction: cover re:Invent as a team without sharing accounts."
2. **The problem** (3 sentences). Teams plan alone, duplicate sessions, miss what matters, and stampede for new launches.
3. **The constraint we turned into the design.** The Events API only acts for the signed-in attendee and only supports local sign-in. So each member runs a local agent and exchanges signed session codes.
4. **How it works.** The architecture diagram from docs/02, then four short paragraphs: local agent, signed manifests, deterministic consensus, optional squad server.
5. **Demo you can open.** Link to `/demo`, fictional data, no sign-in, empty network tab.
6. **API surface used, and why.** Table with all 12 operations and the reason each is used. Note REST and MCP.
7. **What was hard.** No idempotency key, per-session partial success, closed operations, personal-time timezone, repeats that are not identical, catalog that is not public. One sentence each on how it was handled.
8. **Privacy by construction.** What leaves a machine (signed session codes), what never does (tokens, titles, catalog).
9. **Real results.** What the real squad dry run found. Screenshots. Numbers: duplicates removed, gaps closed, sessions claimed.
10. **What is next.** Roadmap in three bullets.

## API coverage table (fill from real usage)

| Operation | Used for |
|---|---|
| ListEvents, GetEvent | Discover the event and its dates |
| ListSessions | Catalog snapshot, diffs, launch reactor |
| GetSession | Fullness and abstract on demand, seat watcher |
| GetSchedule | Source of truth for picks, reconciliation after every write |
| ReserveSessions, CancelReservation | Applying accepted proposals, reservation orchestration |
| AssociateFavorites, DisassociateFavorite | Soft picks, scout keep or release |
| CreatePersonalTime, UpdatePersonalTime, DeletePersonalTime | Squad meeting points, tagged so Junction only edits its own |

## 3-minute video script

| Time | Screen | Voice |
|---|---|---|
| 0:00 to 0:15 | Five browser tabs of five different schedules | "Five of us are going to re:Invent. We each planned alone." |
| 0:15 to 0:40 | Junction day view unfolds | "This is Tuesday. Each line is a person walking between venues. Two sessions nobody covers, a duplicate nobody planned, a walk Luis can't make." |
| 0:40 to 1:10 | Accept the swap, phone shows the change | "Ana accepts one proposal. It moves her to the Wednesday repeat. The official app shows it." |
| 1:10 to 1:45 | Launch session appears, three terminals | "A new session shows up. Three agents, no coordinator, the same answer. The squad server confirms the first claim." |
| 1:45 to 2:10 | Lunch proposal | "Lunch is proposed where three of us can actually be at 12:30." |
| 2:10 to 2:40 | Architecture diagram, then the network capture | "Nothing but signed session codes leaves a machine. Tokens and titles stay home." |
| 2:40 to 3:00 | Demo URL and repo | "Try it without signing in." |

Record with real squad data where possible, but blur titles and any catalog content. Show only what the rules allow.

## Checklist

- [ ] About tab rules read and recorded
- [ ] Public repository per the rules, license chosen, README with architecture diagram
- [ ] No catalog data anywhere in git history (`git log -p` grep, `guardian` pass)
- [ ] No tokens, keys or account IDs in git history
- [ ] Demo live, runs with an empty network tab
- [ ] Squad server live, budget alarm set
- [ ] Video under the length limit, captions on, catalog content blurred
- [ ] Disclaimer in README and on the site
- [ ] Project page proofread by a second person
- [ ] Submitted with a day of buffer, confirmation saved

## Disclaimer (README and site footer)

> Junction is an unofficial community project built for the re:Invent Event Catalog API Hackathon. It is not affiliated with or endorsed by Amazon Web Services. It uses the AWS Events API on behalf of each signed-in attendee and stores no catalog content.

## Trademark note

"re:Invent" and "AWS" are AWS trademarks. Use them descriptively, never in the product name or logo. Keep "Junction" in one constants file so the name is easy to change.
