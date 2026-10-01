# Junction starter kit

Everything Claude Code needs to build **Junction** (working name), a squad-coordination tool for AWS re:Invent 2026, for the *re:Invent Event Catalog API Hackathon*.

Junction lets a group of attendees cover the conference as a team without any of them seeing each other's accounts. Each person's local agent reads their own schedule through the AWS Events API, shares only signed session codes, and every agent computes the same proposals: who takes which session, which repeat to skip, who claims a new launch session, where the squad meets for lunch.

## What is in this kit

| Path | What it is |
|---|---|
| `CLAUDE.md` | Project memory. Claude Code loads it automatically. Rules that never bend. |
| `docs/00-BRIEF.md` | Product brief, hackathon criteria mapping, competitor landscape, open questions to verify. |
| `docs/01-SPEC.md` | Testable functional requirements with IDs and priorities. |
| `docs/02-ARCHITECTURE.md` | Components, trust boundaries, AWS infrastructure, decision records, threat model. |
| `docs/03-DATA-CONTRACTS.md` | Manifest, charter, signal and claim formats. Signing. Solver and claim-rule algorithms. Relay API. |
| `docs/04-EVENTS-API-NOTES.md` | What is verified about the Events API, what is not, and the Spike 0 checklist. |
| `docs/05-DESIGN.md` | Visual direction, component rules, copy rules, banned patterns, review checklist. |
| `docs/06-PLAN.md` | Phases, dated milestones to Nov 6, task list, cut list, risks. |
| `docs/07-SUBMISSION.md` | Builder Center write-up outline, 3-minute video script, submission checklist. |
| `docs/08-KICKOFF-PROMPTS.md` | Prompts to paste into Claude Code, one per phase. |
| `design/` | `tokens.css`, a self-contained hi-fi `reference.html`, and desktop and mobile screenshots. |
| `schemas/` | JSON Schemas for the signed message types. |
| `.claude/` | Permissions, slash commands (`/spike`, `/verify`, `/design-review`, `/phase`) and two review subagents. |

## How to start

1. Create a repo and copy this kit into its root (keep the `.claude/` folder).
   ```bash
   mkdir junction && cd junction && git init
   unzip ../junction-kit.zip -d . && git add -A && git commit -m "chore: add starter kit"
   ```
2. Prerequisites on your machine: Node 22, npm 10, an AWS account with a profile configured (`aws sso login`), the CDK CLI, and a browser signed in to your AWS Builder ID.
3. Open `design/reference.html` in a browser once. That is the visual bar.
4. Start Claude Code in the repo root: `claude`
5. Paste **Prompt 0** from `docs/08-KICKOFF-PROMPTS.md`. Claude will read the docs, enter plan mode and propose a scaffold. Approve it, then continue prompt by prompt.

## Two things to know before you begin

- **Nothing can call the Events API from AWS.** The guide says the app "has to run locally" and only registers `localhost` ports 8484 to 8489 for sign-in. Junction therefore has a local agent (runs on each attendee's machine, serves the web UI at `127.0.0.1:4848`) and a hosted part on AWS that never sees Events API credentials: the landing site and a fictional-data demo (Amplify Hosting), and the squad server (API Gateway, Lambda, DynamoDB, CDK). See `docs/02-ARCHITECTURE.md` (ADR-012).
- **The re:Invent catalog is not public.** Never commit it, never derive demo data from it, never send it to the squad server. Demo data is generated from a seeded script with invented titles.
