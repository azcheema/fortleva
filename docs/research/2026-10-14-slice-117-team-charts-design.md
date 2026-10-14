# Slice 117 — THE TEAM CHARTS (Phase 6 step 3; founder decision C93)

*Design written 2026-10-14 by the building session, before any code. C93's answers are in `docs/OPEN_QUESTIONS.md`; this document is how they are built. No schema change, so no pre-apply review: the code and security reviews run on the finished tree (§9). The method is the dataviz skill's (form first, colour by job, the palette VALIDATED by its script, thin marks, a table twin for every chart).*

## 0. What C93 decided, and the readings this design takes

| C93 | Decision | Reading taken here |
|---|---|---|
| — | Continue, with the team charts (PLAN Phase 6's "fixed set … no builders") | Four fixed views under Project health on `/reports`; nothing configurable but the period and the client. |
| (e) | *(asked after the security review)* **No hours per person on Reports** | `readTeamCharts` reads no member's hours; a person's hours stay on `/time/team` (§9 S1). |
| (a) | **On the Reports page**, below Project health, over every project the member can see, narrowed by the same client filter | Same gates and scope as the table (`report:view_portfolio` + `project:view`, `scopeWhere`), the header's `?client=` scoping both. |
| (b) | **Calendar months** — this month by default, last month, the last 3 months | `?period=this|last|3m`, a select in the charts' own heading row (it scopes only what is below it — the table has no period). Ranges are LOCAL dates in the workspace's zone; "this month" runs to today. |
| (c) | **"Late" = open and past its due date** | A task in Backlog, To do or In progress whose `target_date` is before today (workspace zone). |
| (d) | **"How long tasks take" = started to done**, the median per month | `completed_at − started_at` in days, over tasks DONE now whose `completed_at` falls in the month; a task that never went through In progress (`started_at` NULL) has no start and is left out of the median (it still counts as done). |

**Read by the design, not asked (stated to the founder when the slice is reported):**

- **Which projects each view covers.** Open and late tasks, the open-tasks bars and the budget meters: the RUNNING projects (the table's default set). Done tasks, time to done and hours: EVERY project in scope, finished ones included — work done and hours logged this month happened whether or not the project has since been closed. "Show finished" changes the table only.
- **Hours include time on no project** (the "internal" hours `/time/team` already shows any `time:view_team` holder) as a "No project" bar — only while no client is chosen, since such time belongs to no client.
- **Each view is gated by its source's code**, as the table's columns are: the task views by `work_item:view`, the hours by `time:view_team` (the team view's own rule), the budget meters by `budget:view` (percent only, so never `rate:view_bill`). Nothing reads a cost.
- **No Recharts in this slice (ARC-24 amended).** Every view here is a bar, a column or a meter, which plain HTML draws on the design tokens, server-rendered, as readable text, with no client-side chart code. Recharts stays the choice for a chart that needs a drawn axis over time (the website speed charts' lines).
- **Top eight, then "Other".** The project bars show the eight largest and fold the rest into one "Other" bar (the dataviz series-count ladder); the table twin lists every row. (People are never ranked — there is no people chart, C93 (e).)

## 1. The views (form first — `choosing-a-form.md`)

| View | Job | Form |
|---|---|---|
| **The numbers** — Open tasks · Late · Done in the period · Typical time to done | headline numbers | a KPI row of `MetricTile`s (no chart: "the number is the chart") |
| **Open tasks by project** | part-to-whole per project | horizontal STACKED bars: To do · In progress · Late, top 8 + Other |
| **How long tasks take** | trend over time | COLUMNS, the median days per month for the 6 months ending with the period's last month; the period's months in the active colour, the others in the neutral (the *emphasis* form); the value on each cap |
| **Hours by project** | compare magnitude, two parts | horizontal STACKED bars: Billable · Non-billable, top 8 + Other; the total at each bar's end |
| **Budget used** | a ratio against a limit | METERS, one per project with an active budget, highest first: the fill carries severity (brand < 80 %, caution 80–99 %, danger from 100 % with an icon and "Over"), the track a muted step |

Every chart carries a legend (≥ 2 series), selective direct labels (the bar's total, the column's value), and **a table twin** — a "Show as a table" disclosure under it listing every row and every part. Values are reachable without hover; a segment's `title` names its part and value for a mouse (an enhancement, never the only way).

## 2. Colour (validated, not eyeballed)

Three new tokens in `globals.css`, the SAME primitive steps in both themes, their hue hard-coded (the `--chart-*` rule: a tenant's brand hue must never re-colour a series):

| Token | Role | Value | Steps |
|---|---|---|---|
| `--chart-neutral` | To do · Non-billable · months outside the period | `oklch(0.535 0.014 268)` | slate-600 |
| `--chart-active` | In progress · Billable · the period's months | `oklch(0.575 0.205 268)` | indigo-600 |
| `--chart-late` | Late (with an icon and its word) | `oklch(0.589 0.215 25)` | red-600 |

`validate_palette.js` on the resolved hex (`#6a6d76,#466af0,#e02a33`), light on `#ffffff` and dark on `#15171c`, adjacent AND `--pairs all`: lightness band PASS both modes; CVD worst ΔE 10.0 (≥ 8 target); normal-vision worst ΔE 19.5 (≥ 15); contrast ≥ 3:1 for all three on both surfaces. The one FAIL is the neutral's chroma floor — by design: it is the de-emphasis role, never an identity hue. (Rejected on the way: the board's own amber "In progress" beside red "Late" — deutan ΔE 2.8, indistinguishable; and the dark theme's -400 tone steps — above the dark band.) `contrast.test.ts` gains the three: ≥ 3:1 on every non-text surface, and ≥ 0.10 apart for every vision type.

## 3. The service — `src/modules/reports/charts.ts`

`readTeamCharts(ctx, { period, clientId }, now = new Date())` → `{ range, months, show: { tasks, hours, budget }, tasks?, hours?, budgets? }`, ONE member transaction, every read in SEQUENCE, none per project: the two gates; `accessibleCodes` once (`work_item:view`, `time:view_team`, `budget:view`); the scope and the clients it spans (the filter's rule: a client the list does not span is every client); the workspace zone; then, each only with its code:

1. **open tasks per running project** — one grouped statement, `count(*) FILTER (…)` for to do / in progress / late (the % done exclusions: not deleted, not archived, not an epic, never Triage, Cancelled or Done);
2. **done tasks and time to done** — per month of `completed_at` in the zone, over the 6-month window (which covers the period): the count and `percentile_cont(0.5)` of the days started → done;
3. **hours** — one grouped statement over `time_entry` in the period's LOCAL dates (stopped, not deleted): by project and billable; projects in scope (+ no project while unfiltered). Never by member (C93 (e));
4. **budgets** — `activeBudgetBurns(…, { money: false })` for the running projects.

Pure helpers in `src/modules/reports/chart-shapes.ts` (unit-tested): the period's range and its 6-month window from a local date; folding a ranked list into top 8 + Other.

## 4. The screen

Below the Project health card: a heading row **"Team"** with the **Period** select (`This month` · `Last month` · `Last 3 months`, a link like the client filter, which it keeps; shown only when a view with a period is drawn), then the KPI row, then a two-column grid (one column below `lg`): Open tasks by project · How long tasks take · Hours by project · Budget used. A view the member's codes do not reach is not drawn. Each empty view says so in a line ("No open tasks", "No hours logged in this period", "No active budgets", and for How long tasks take when no month has a timed task — never an empty plot). The charts' components: `src/components/semantic/bar-list.tsx` (stacked horizontal bars + legend), `column-chart.tsx`, `chart-table.tsx` (the twin) — server components, no directive, tokens only.

## 5. Tests

- **Unit**: `chart-shapes.test.ts` — periods across a year end, the window, the fold; `contrast.test.ts` — the three tokens.
- **dbtest**: `portfolio.dbtest.ts` gains a describe for `readTeamCharts` on its fixture (planted done tasks with known starts — one at 23:30 UTC on last month's last day, which is THIS month in Stockholm —, a late task, hours by two members): the counts, the medians by month, the zone's month boundary, the period ranges, hours by project with billable split and the no-project bar only unfiltered, NO per-person read, the client filter, scope (a scoped member never sees another client's hours), each view hidden without its code AND with its module off.
- **e2e**: `project-health.spec.ts` — the views render, the period select navigates and keeps the client.
- **Visual walk**: the existing `project-health` stop now photographs the charts too.

## 6. Docs

UI.md §3.1's Reports row; ARC-24 amended (no Recharts for bars); PLAN Phase 6's charts line; AUTHZ none (no new code); DATA_MODEL none.

## 7. Order of work

Tokens + contrast test → chart-shapes (+ unit) → service → components + page + i18n → dbtest → e2e → gates → reviews → commit, push, read CI.

## 8. Not built

The per-workflow-state breakdown (states are per project and tenant-named; the categories are what compare across projects); lead time from creation; any chart a member can configure.

## 9. Reviews

Code and security reviews ran in parallel on the finished tree, two fresh read-only agents, after the gates (typecheck, lint, build 0; unit 183 files / 2 880; the dbtest 20/20; the e2e 3/3; a screenshot probe with no overflow). Neither found a wrong number or a scope leak.

**Security — S1 (HIGH), TAKEN BY THE FOUNDER'S DECISION C93 (e):** "Hours by person" ranked people by hours (most first, top eight, the rest "Other") — an HOUR RANKING, on SECURITY.md §9.7.2's never-list ("leaderboards or hour rankings", in any tier; T10 names "rank by hours") and against the staff notice every member acknowledges ("no … leaderboards or rankings"); the dbtest even pinned the ranking as a contract. Asked in one plain-language question, WITH the recommendation: **removed** — no per-member read in `charts.ts`, a comment saying why, the dbtest pinning that `hours` has no per-person key, the e2e that no such heading renders. The building session had written "hours by person" into the option it offered without the never-list in view. Noted for the record: §9.7.3's per-member dashboard opt-in (9.7.7) does not exist anywhere; `/time/team` predates this slice. **NIT** no module-off test — TAKEN (time off and work off).

**Code — H1 (HIGH):** the table twin's bordered `DataTable` inside a padded card was a double hairline the walk refuses even closed — TAKEN: `flush`, bleeding to the card's edges under its own hairline (`project-hours.tsx`'s pattern). **L1** the twin's name column neither took the spare width nor showed a truncated name — TAKEN (`w-full max-w-0`, a `title`). **L2** nothing pinned the zone's month bucketing — TAKEN (the 23:30 UTC task). **NITs** "1 day" compared the raw float (TAKEN: the formatted value); the Period select drawn for a budget-only member (TAKEN: only with a period view); "on the projects shown" and "Done in 3 months" (TAKEN: the first went with the person chart, the second reads "Done in the last 3 months"); a screen reader heard "Oct 4.5" with no unit (TAKEN: `ColumnChart`'s `unit`); a refusal between the table's transaction and the charts' would hit the error boundary (TAKEN: caught, the charts left out); cards' `h2` under the Team `h2` (RECORDED: `SectionCard` has no level prop — cosmetic).

**Re-check** of every fix by a fresh read-only agent: no HIGH or MEDIUM — the person chart gone from every layer, the flush twin passing `doubleHairlines`, every dbtest expectation re-derived from the fixture (the 23:30 UTC task lands on the 1st in Stockholm in CET and CEST, the clock-change Sunday included), no server import of a client module's value. Its LOW TAKEN: `ChartTable`'s doc comment states its contract (the last child of a default-size card — the bleed is that padding). Its NIT TAKEN: the column chart's spoken unit is per column (`unitText`), so a median of 1 is "1 day", by the same formatted-value test as the number tile.

**Gates on the final tree:** typecheck 0; ESLint 0; unit 183 files / 2 880 passed / 1 skipped; `portfolio.dbtest.ts` 21/21 on dev; `pnpm build` 0; `e2e/project-health.spec.ts` 3/3; a throwaway probe (deleted) with every table twin OPEN: no page or table overflow at 1440 and 390. The visual walk's `project-health` stop now photographs the charts — CI runs it (local walks time out over the dev link).

**CI, first run ([38547997418](https://github.com/azcheema/fortleva/actions/runs/38547997418)) — ONE red test, the Swedish width walk:** at 390 px the table twins of "Öppna uppgifter per projekt" (10 px) and "Timmar per projekt" (14 px) overflowed a phone's 356 px box with all their Swedish headings (every other leg green: 281 passed). FIX: `ChartTable` columns may carry a priority, and a column whose values are reachable another way waits for a 38rem box — the twins' Total (the sum of the parts beside it) and, by the fix's fresh review (MEDIUM, an estimate — CI's seed never draws that twin), the speed twin's median (printed on every month's column). The review's LOWs taken (the comment no longer claims every row's total is on the chart; in the two-column grid a card is under 38rem up to ~1520 px, so these columns wait on most laptops too) and its NIT (the first column honours a priority); RECORDED: `DataTable flush`'s `:last-child` padding still matches a hidden last cell (an existing pattern). Verified locally on the rebuilt app: `zz-swedish-widths.spec.ts` + `project-health.spec.ts` 5 passed.
