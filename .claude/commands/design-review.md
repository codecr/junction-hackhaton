---
description: Screenshot the demo build and review it against the design reference and rules
argument-hint: [screen name, optional]
allowed-tools: Read, Bash, Glob, Grep, Task
---

1. Build and serve the demo (`npm run demo`) and run `npm run shots` to capture `design/current/` at 1440 and 390 px. If a screen name is given in `$ARGUMENTS`, capture that screen only.
2. Open `design/reference-desktop.png`, `design/reference-mobile.png` and the new screenshots and look at them yourself.
3. Delegate a second opinion to the `design-reviewer` subagent with the paths of the screenshots and the changed files.
4. Report defects by severity (blocking, should fix, polish), each with the file to change and the concrete fix. Check specifically: tokens only, banned patterns in docs/05, chart geometry rules, member colour plus shape plus name, focus rings, reduced motion, contrast, 390 px layout.
5. Fix the blocking and should-fix items, re-capture, and repeat until clean. Finish by naming one thing you removed.
