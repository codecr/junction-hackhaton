# 05. Visual direction

The bar is `design/reference.html` (open it in a browser, then compare against `reference-desktop.png` and `reference-mobile.png`). This document explains why it looks the way it does, so new screens extend the language instead of drifting into a generic dashboard.

## Subject and job

**Subject:** a small team coordinating which of them attends what at a conference that spans five hotels along the Las Vegas Strip. **Audience:** engineers and architects in the middle of a busy week, on a laptop between sessions and on a phone in a corridor. **Job of the main screen:** in one glance, show where everyone is and where the squad is exposed.

## The idea: a timetable, not a calendar

Calendars are grids of boxes. The right precedent here is the printed railway timetable and the Marey chart: time runs left to right, places run top to bottom, and each traveller is a line. Walking between venues is a slope; a session is a flat run. The geometry does the arithmetic for you: a person who cannot make a connection is a line that dies before it arrives.

That chart is the one memorable thing. Everything else on the page is deliberately quiet.

## Design plan, and what was rejected

Plan first, then reviewed against the common defaults so the result is a choice rather than a habit.

| Axis | Chosen | Rejected because it is a default |
|---|---|---|
| Ground | Cool mist grey `#F3F6F7` | Warm cream with a terracotta accent |
| Ink | Marine blue-black `#0E2233` | Neutral near-black with a neon accent |
| Accent | Railway signal yellow `#FFC800`, used only where lines meet | Accent used as decoration on every heading |
| Structure | Hairlines, whitespace and one big figure | Identical rounded cards with soft shadows |
| Type | One variable family, two axes carry hierarchy | Serif display plus sans body pairing, mono for data |
| Motion | The day unfolds once on load. Everything else responds to an action | Fade-and-slide on every section, hover lift on every card |

## Tokens

Source of truth: `design/tokens.css`. Do not introduce colours, sizes or radii outside it without adding a token and a reason.

- **Ground and lines:** `--ground`, `--ground-sunk` (protected time bands, selected column), `--rule`, `--rule-strong`.
- **Ink:** `--ink`, `--ink-2` (secondary text, 6.0:1 on ground), `--ink-3` (strokes and disabled only, never text), `--ink-hover`, and `--on-ink`, `--on-ink-2` for text on ink surfaces such as tooltips.
- **Signal:** `--signal`, `--signal-soft`. Reserved for shared sessions and meeting points. If yellow appears anywhere else, remove it.
- **State:** `--conflict` for impossible connections and errors only.
- **Members:** `--m1` cobalt, `--m2` berry, `--m3` pine, `--m4` violet, `--m5` ochre. Every member is colour **plus** marker shape (circle, square, diamond, triangle, cross) **plus** name. For squads larger than five, add shapes and lightness steps; never reuse a pair.

## Typography

One family: **Archivo Variable** (weight 100 to 900, width 62 to 125). Self-host with `@fontsource-variable/archivo`; never load fonts from a CDN. The width axis creates the roles:

| Role | Width | Weight | Notes |
|---|---|---|---|
| Wordmark, page title | 112 (slightly extended) | 700, 650 | Title 30 px, tracking −0.012em |
| Reading text | 100 | 400 | 15 px, line height 1.5, lines under 70 characters |
| Times, codes, chart labels, table cells | 82 (semi-condensed) | 500 | Tabular figures where numbers align |
| Section headings | 104 | 650 | 18 px |
| Small and captions | 100 | 400 | 13 px, `--ink-2` |

Do not add a second family. Do not use monospace for data. Do not use all-caps or tracked-out labels.

## Layout

Left-aligned throughout, max width 1280 px, generous side padding (`clamp(16px, 4vw, 48px)`), 4 px spacing scale.

```
top bar:   brand ............................................ sync status, Share my picks
title:     Tuesday, 1 December
           one plain sentence stating what needs attention
           one quiet notice (provisional catalog, offline)
days:      Mon 30   Tue 1 (4 issues)   Wed 2   Thu 3   Fri 4
chart:     who is where (legend chips, key)
           [ Marey chart, full width, the hero ]
below:     Coverage this week (7/12)      |   Proposals for you (5/12)
footer:    one line that says what stays on this machine
```

No cards. Structure comes from hairline rules, alignment and the whitespace between sections. Rules that carry information (the table header rule, the selected-day underline) are allowed; rules that only decorate are not.

## The chart

- **x:** time, hourly gridlines, labels like `9 AM` in semi-condensed figures. The protected squad lunch is a sunk band with a label.
- **y:** venues in Strip order. Vertical spacing is proportional to walking minutes between neighbours (`kY` px per minute), so every walk has the same slope. Walking minutes are printed between rows. Venue order and distances come from the venue graph file, never hard-coded in components.
- **Lanes:** each member has a fixed vertical lane offset (9 px apart), so lines stay parallel across venues like a real timetable.
- **Session:** a 7 px rounded stroke from start to end with a marker at the start. Code above the bar in `--ink-2`.
- **Walk:** 1.6 px line in the member's colour. If the person arrives early, a thin flat run shows the wait.
- **Shared session:** a `--signal` underlay behind the bars with a pill. Filled with the label "Duplicate" when unplanned. Outlined with the label "Planned overlap" when the topic target asks for it.
- **Nobody covers it:** dashed outline with a diagonal hatch, code and reason above. A new session suggested for someone is the same shape stroked in that person's colour.
- **Impossible connection:** dashed `--conflict` line that stops short of the next session with a cross and the text "Luis needs 28 min, has 15".
- **People:** name printed at the end of each line in the member's colour, with a paper halo so it stays legible over other lines.
- **Interaction:** hover or focus on a person dims the others. Bars are focusable with a visible ring and show a tooltip with title, code, time, venue and who. Chips toggle people on and off (`aria-pressed`).
- **Motion:** on load, a clip reveals the chart left to right once in about 1.1 s. Skip it when `prefers-reduced-motion` is set.
- **Table alternative:** provide the same content as a per-person list for screen readers and for users who prefer it.

Use `d3-scale` and hand-written SVG. Do not use a charting library.

## Other components

- **Day tabs:** text with a 2 px underline on the selected day and a second line stating the issue count. Not pills.
- **Chips (people):** outlined, 6 px radius, marker shape plus name plus count. Off state: dashed border, muted marker.
- **Coverage table:** topic, five days, target. Cells hold marker shapes for who covers it. `none` is a hatched cell with the word. Under target shows a red count such as `1 of 2`. The selected day column sits on `--ground-sunk`.
- **Proposals:** a plain list separated by rules. Title, one sentence, a "Why this" disclosure, then the actions. After accepting, the actions are replaced by a confirmation with Undo. The primary button is solid ink, the secondary is an underlined text button.
- **Buttons:** primary solid ink, quiet outlined. 6 px radius, weight 600, sentence case. No trailing arrows or icons.
- **Focus:** 2 px `--ink` outline, 3 px offset, always visible for keyboard users.

## States that must be designed

First run (sign in, create or join a squad, choose sharing level, each explained in one sentence). Loading (skeleton lines in `--ground-sunk`, no spinners over the chart). Empty squad (an invitation to invite someone, with the invite code and a copy button). Offline or server down (state that file exchange still works). Provisional proposals (quiet notice, as in the reference). Partial write failure (per-session list: reserved, full, clashed, with the next action). Signed out (one button, one sentence). Token expired mid-action (re-sign-in without losing the pending proposal).

## Copy rules

Words are design content. Plain verbs, sentence case, active voice, no filler, no apologies in errors. A button says exactly what happens: "Accept", and the toast that follows says "Accepted". Errors say what happened and what to do next. Empty states invite an action.

| Say this in the UI | Never this (internal term) |
|---|---|
| picks | manifest |
| squad server | relay |
| squad rules | charter |
| scout note | signal |
| claim | lease, lock |
| Nobody covers it | uncovered, gap (in chart labels) |
| Can't make the walk | infeasible hop |
| Duplicate, Planned overlap | redundancy violation |
| catalog is one update behind | catalogHash mismatch |

Avoid meta strings joined with middle dots, labels built as "WORD — fragment", and numbered markers unless the content really is a sequence.

## Banned patterns (review checklist)

1. All-caps or tracked eyebrow labels above headings.
2. `A · B · C` middle-dot strings and spaced em-dash label constructions.
3. `→` appended to link or button text.
4. Numbered 01 / 02 / 03 markers on content that is not a sequence.
5. Gradient washes, glassmorphism, blurred blobs, glow. (Diagonal hatching that encodes "nobody covers it" is information, not decoration, and is allowed.)
6. Identical rounded cards with the same soft grey shadow.
7. Fade-up entrance on every section, hover lift on every card.
8. Cream background with a terracotta accent, or near-black with an acid accent.
9. Emoji as icons. Icon packs with their default look.
10. Colour as the only carrier of meaning.
11. Accenting a single word in a headline with italic or a colour.
12. Monospace for small data labels.
13. Any yellow that is not "lines meet".

## Quality floor

Responsive from 390 px to 1440 px and up (the chart scrolls horizontally on narrow screens with a 860 px minimum). Visible keyboard focus. `prefers-reduced-motion` respected. WCAG 2.2 AA contrast for all text (verify `--ink-2` on `--ground` and on `--ground-sunk`). Touch targets at least 44 px. No layout shift when data loads.

## How to review your own work

`/design-review` runs the app in demo mode, screenshots it at 1440 and 390 into `design/current/`, and compares against the reference. Look at the screenshots, do not trust the code. Before finishing any screen, remove one thing.
