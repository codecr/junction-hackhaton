---
description: Execute one phase of docs/06-PLAN.md task by task with checks
argument-hint: <phase number 0-5>
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task
---

Read `docs/06-PLAN.md` and take Phase `$ARGUMENTS`. Also read the matching prompt in `docs/08-KICKOFF-PROMPTS.md`.

1. Enter plan mode. List the tasks, their "done when" criteria, dependencies and what needs me (phone, portal, deploy approval, decisions). Wait for approval.
2. Work one task at a time. Tests first. Small Conventional Commits.
3. After each task run `/verify`. After each UI task run `/design-review`. After the phase run the `guardian` subagent.
4. Update `docs/FINDINGS.md` and the decision records in docs/02 as you learn things.
5. End with the phase gate from the plan: state whether it is met and show the evidence.
