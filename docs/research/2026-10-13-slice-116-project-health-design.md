# Slice 116 — THE PROJECT HEALTH TABLE (Phase 6 step 2; founder decision C92)

*Design written 2026-10-13 by the building session, before any code. C92's answers are in `docs/OPEN_QUESTIONS.md`; this document is how they are built. No schema change, so no pre-apply review: the code and security reviews run on the finished tree (§8).*

## 0. What C92 decided, and the readings this design takes

| C92 | Decision | Reading taken here |
|---|---|---|
| — | The project health table next (PLAN Phase 6's "Project health" portfolio line) | `/reports` — UI.md §3.1's reserved rail row — on `report:view_portfolio` (AUTHZ §3.2's reserved row, C M, scoped). |
| (a) | **Running projects**: planned, active, paused; the rest behind "Show finished" | Default: `status IN (PLANNED, ACTIVE, PAUSED) AND archived_at IS NULL`. `?finished=1` lists every project in scope, the finished ones (completed, cancelled, archived) AFTER the running ones. |
| (b) | **% done counts tasks**: done out of all, internal included, cancelled left out | §2.3 states which rows are a "task" for this count. |
| (c) | **Most worrying first**, one table, a client filter | §2.5's order; `?client=` with `/invoices`' native select. |
| (d) | **"Update missing" only on a schedule** | The slice-102 rule itself (`updateScheduleAt`, `update-schedule.ts`) — the project header's "Update late" badge, so the table and the project page can never disagree. |

**Read by the design, not asked (stated to the founder when the slice is reported):**

- **The page is titled "Reports"** (the rail's word); the table is its one card, "Project health". The website speed charts join the same page later.
- **Each column is gated by the code that gates its own source**, as the update's internal snapshot is: health by the project page's rule (anyone who can open the project sees its header's health chip); the last update's date and "late" by `project_update:view` (the date is otherwise only on the Updates tab; "late" is the header's badge rule — §8 L1); % done by `work_item:view`; the budget by `budget:view` — shown as a PERCENT only, so no amount is drawn and `rate:view_bill` is never needed (the percent of a money budget is what `getProjectBudget` already shows a `budget:view` holder without it). Owners and managers hold all of these by default. **Nothing here reads a cost rate** — PLAN's "never exposes cost without `rate:view_cost`" is met by never reading cost at all.
- **Epics are not counted** in % done — an epic is a container, and counting it beside its own tasks counts the same work twice. Tasks and subtasks are.
- **Read-only.** No verb, no server action, no audit row: reading a list the member could already assemble project by project is not an event.

## 1. Who may see it

- **Rail entry "Reports"** (`/reports`, icon a bar chart), after Contracts, on `report:view_portfolio` across all four gates — so it goes with the `reports` module, and a workspace that turned Reports off loses it.
- **The page** asks `requireAccess(report:view_portfolio)` AND `requireAccess(project:view)` (a custom role holding the first but not the second must not read project names it cannot open), then reads only projects in the member's scope (`scopeWhere(PROJECT_SCOPE)`, `listProjects`' rule — a manager kept to some clients sees only theirs). Refused → the forbidden empty state (`/contracts`' shape).
- **New code `report:view_portfolio`**, module `reports`, C M, not ✦ → **catalogue 117 → 118, TEMPLATE_VERSION 18 — TV18 SEED OWED**: until `prisma/seed.ts` runs, nobody's role holds it and the rail entry stays hidden (nothing breaks). Dev needs `scripts/seed-catalog.ts` for the local dbtests (CI seeds from empty).

## 2. The service — `src/modules/reports/portfolio.ts`

`readPortfolio(ctx, { finished, clientId }, now = new Date())` → `{ rows, clients, capped, show: { updates, tasks, budget } }`, ONE member transaction, every read in SEQUENCE (AGENTS.md's `Promise.all` trap), none per project:

1. the two gates, then `accessibleCodes` once for `project_update:view`, `work_item:view`, `budget:view` (never a leg);
2. the clients the list spans (the filter's options), then the projects in scope (+ the client filter): the RUNNING ones first, up to `PORTFOLIO_LIMIT` (300) shown — one more is read only to know there are more — and with "Show finished" the finished ones only into the room left — so the cap never drops a running project for a finished one;
3. the workspace's time zone (`readPreferences`);
4. **the newest published post per project** — `DISTINCT ON (project_id) … ORDER BY project_id, published_at DESC, seq DESC` (`latestPublishedHealth`'s order) — its health and date; and, for the late flag only, the newest CLIENT-VISIBLE published post per project whose portal is on (`lastCountingPostAt`'s rule, C70 (g));
5. **the task counts** (only with `work_item:view`) — one grouped count;
6. **the active budgets and their burn** (only with `budget:view`) — one read of the budgets, one batched burn (§2.4).

### 2.1 Health and the last update

The newest PUBLISHED post's health and `published_at` — drafts and archived posts never count (status `PUBLISHED` only). No post: no chip, a muted dash ("No update yet"), as the project header draws nothing: health is chosen, never computed.

### 2.2 Late

`updateScheduleAt(scheduleInputOf(project, lastCounting, timeZone), now)` — `due` or `late` drawn as the header's two badges ("Update due today", "Update late") beside the date. Only an ACTIVE project with a cadence has a schedule (the rule's own clause).

### 2.3 % done

```sql
SELECT project_id,
       count(*) FILTER (WHERE state_category = 'DONE')::int AS done,
       count(*)::int AS total
  FROM work_item
 WHERE tenant_id = $1 AND project_id = ANY($2::text[])
   AND deleted_at IS NULL
   AND type <> 'EPIC'
   AND state_category NOT IN ('CANCELLED', 'TRIAGE')
   AND (archived_at IS NULL OR state_category = 'DONE')
 GROUP BY project_id
```

TRIAGE is a client's request nobody has accepted yet — not planned work. An ARCHIVED task counts only if it was done (done work put away is still done; an open task put away was taken off the plan). A project with no tasks shows the meter at zero ("0 of 0"), the Projects page's rule: one shape per column.

### 2.4 The budget — `budgetBurns`, one definition of burn

`budgets.ts` gains `budgetBurns(tx, tenantId, rows, today)`: each budget's window computed in JS (`currentPeriod`, the anchor), then ONE statement over `unnest(ids, projectIds, includeNonBillable, starts, ends)` LEFT JOINed to `time_entry`, with `'-infinity'`/`'infinity'` for an open window (no NULLs in an array parameter). **`budgetBurn` becomes `budgetBurns` of one**, so the alert job, the Time tab, the update's snapshot and the table share one SQL; `activeBudgetBurns(tx, tenantId, projectIds, today, { money })` reads the ACTIVE budgets and burns them in two statements, nulling a MONEY burn's amount unless `money` (§8 L2). The cell is the percent alone ("37 %", floored — a row stays one line, and the amounts live on the Time tab); at or over 100 % it is a caution badge. No active budget: a muted dash.

### 2.5 Order (C92 (c))

`portfolioOrder` (pure, `portfolio-order.ts`, unit-tested): running before finished; then the ATTENTION rank — 0 Off track, 1 At risk, 2 update late (only when the viewer may see "late"), 3 the rest; ties keep the database's order, client name then project name (the sort is stable). A late project that is also Off track is rank 0 — it is already at the top.

## 3. The screen — `/reports`

`Page width="wide"`, header "Reports" with "Show finished" / "Hide finished" (`/projects`' archive toggle, a link) and the client filter (shown when the rows span more than one client; a client the list does not span reads as every client — `/invoices`' rule). One `SectionCard` "Project health" with a legend line ("Most worrying first: off track, then at risk, then a late update, then the rest."), then ONE fixed table, **one-line rows at the row token** (the visual walk's audit), columns joining as the TABLE widens: always Project (chip → `/projects/KEY`; the client's name after it while its own column is hidden) and Health (`HealthChip`, or the dash; a 14 px caution clock icon beside it, with its words for a screen reader, while Last update is hidden — §8 M1); from `medium` Key (mono, 10ch) and Last update (the date + the "Late" / "Due today" badge); from `low` Done (`ProgressMeter`, "62 %", or "None"); from `lower` Budget used and Client (chip). Columns the viewer's codes hide are not rendered at all. Empty: "No running projects" with Show finished, or "No projects" with Go to Projects. Capped: a caution line "Showing the first 300 projects — choose a client to see the rest."

## 4. Catalogue, rail, i18n

`catalog.ts` (+1, the comment block, v18 note), `catalog.test.ts` (118), AUTHZ §3.2's row (reserved → landed), `nav.ts` + `nav-icon.tsx` (`reports`), en/sv `nav.reports` and `reports.health.*`.

## 5. Tests

- **Unit**: `portfolio-order.test.ts` (the rank, finished last, late ignored when unseen, ties by client then name); the catalogue count. `budgetBurns`' windows are the dbtest's (a whole project, a month, an anchor, non-billable hours in or out).
- **dbtest** `src/modules/reports/portfolio.dbtest.ts`, prefix `pfo-` (registered in `DBTEST_PREFIXES`): refused without the code / with the reports module off / without `project:view`; a manager scoped to one client sees only it; running vs `finished`; health from the newest PUBLISHED post (a newer draft and an archived post ignored); late at a fixed `now` (cadence set, no post) and the portal-on rule (an internal post does not count); % done's five exclusions; the last update, the schedule, tasks and budget hidden without their codes; a member assigned to ONE project sees it alone; the batched burn's four windows; the output carries no key naming cost.
- **e2e** `e2e/project-health.spec.ts`: the owner's rail entry, the seeded At-risk project above the project with no post (which its name would also give — the rank is the dbtest's), Show finished appended last, the client filter; an employee has no rail entry and `/reports` shows the forbidden state.
- **Visual walk**: a new stop `project-health` (+4 shots), checked locally on the walk's four legs + the Swedish width walk before pushing.

## 6. Docs

PLAN Phase 6's line ticked; UI.md §3.1's Reports row; AUTHZ §3.2 and its running count; DATA_MODEL none (no schema); AGENTS.md the screenshot count (94 stops).

## 7. Order of work

Catalogue + seed-catalog on dev → `budgetBurns` (+ its dbtest parity) → service + order → page + rail + i18n → dbtest → e2e + visual stop → gates → reviews → commit, push, read CI.

## 8. Reviews

Code and security reviews ran in parallel on the finished tree, two fresh read-only agents, after the gates (typecheck, lint, build 0; the dbtest 13/13; the budget callers' dbtests 33/33; the e2e 2/2). **Neither found a correctness or security bug.**

**Security** (no HIGH/MEDIUM): **L1** the last update's DATE showed without `project_update:view`, although the project header draws only the chip — TAKEN: the date and its column now go with `project_update:view` (`show.updates`), health stays the header's. **L2** `activeBudgetBurns` returned money amounts unredacted under a comment saying the caller nulls them — TAKEN: it takes `{ money }` and redacts itself. **L3** no test of a member assigned to ONE project — TAKEN (`onOneProject`). **N1** the doc's `show` and codes had drifted — TAKEN (§2, §5). **N2** = code review's LOW 1.

**Code** (one MEDIUM): **M1** a "Late" / "Due today" badge could overflow its fixed cell (Swedish "Enligt plan" + "Försenad" ≈ 155 px in a 112 px health cell below `medium`; "13 okt. 2026" + "Försenad" ≈ 159 px in a 144 px last-update cell), and the walk cannot see it — no seeded project can be late (`project_update_schedule_stamp` stamps the schedule's start at insert, so a seed cannot plant a past one) — TAKEN BY CONSTRUCTION: below `medium` the late cue is a 14 px icon (with its words for a screen reader), the last update is `w-44` with the year only when it is not this one, and its date TRUNCATES before the badge, which never shrinks. **LOW 1** the cap was applied in name order before the rank, and with "Show finished" could drop running projects for finished ones — TAKEN in part: running projects are read first and the finished fill what room is left; past 300 RUNNING projects the rank is over the first 300 by client and name, and the page says so — RECORDED, not worth a database-side rank at an agency's project count. **LOW 2** the rail entry asks one code, the page two — RECORDED: a custom role holding the table but not projects sees the entry and the forbidden state (UX only; `/settings/invoicing`'s precedent). **LOW 3** the e2e order assertion also holds by name — TAKEN as a comment (the rank is the dbtest's). **LOW 4** the dbtest's parity loop compared the batched burn with itself — TAKEN: removed, and the anchor and non-billable windows added (Echo). **NITs** the docs' drift (taken), AGENTS.md's screenshot count (taken), a tooltip on a late date whose newest post is internal (RECORDED: the header says the same), `checkBudgetAlerts` still burning one budget a statement (RECORDED: outside this slice).

**Found by eyes on the screenshots, after both reviews: `HIDE_FROM` never reached the page.** The desktop shot showed the client's name after every project name although the Client column was showing. A throwaway browser probe (computed styles, deleted after one run) found the stand-in's class list without its rung: `HIDE_FROM` lived in `src/components/ui/table.tsx`, a `"use client"` module, and read from this SERVER page it was a client reference — `HIDE_FROM.lower` evaluated to nothing, `cn` dropped it, no error, no warning (AGENTS.md's standing trap, in a form that does not throw). Neither review, the typecheck, the build nor the walk's audits could see it: the walk measures overflow and row pitch, and a stand-in that never hides overflows nothing. FIXED AT THE ROOT: `PRIORITY`, `SHOW_FROM`, `HIDE_FROM` and `ColumnPriority` moved verbatim into the plain module `src/components/ui/table-rungs.ts` (no directive, a header saying why), `table.tsx` imports from it, and every importer reads the maps from there (UI.md §10.12 updated). Re-probed on the rebuilt app: at 1440 px the suffix is `display:none` beside the Client column; at 390 px it shows in the room the project's name leaves (now `basis-0`, so the name keeps its width — the phone shot had cut both); rows 36 px.

**Gates on the final tree:** typecheck 0; ESLint 0; `pnpm build` 0; unit 182 files / 2 862 passed / 1 skipped, plus the two known load timeouts (`client-graph`, `ratelimit/local`), 17/17 alone; `portfolio.dbtest.ts` 14/14 on dev; `e2e/project-health.spec.ts` 2/2 on the rebuilt app. The full visual walk ran on the tree BEFORE the review fixes: zero findings on `project-health` on all four legs (row pitch, overflow at every rung width, traces); the four walks then ran out of the local 5-minute budget later in the stop list over the remote dev link — CI runs them.

**Re-check** of every fix by a fresh read-only agent: no HIGH, MEDIUM or LOW — the move to `table-rungs.ts` verbatim (diffed), no server import of a client module's value left, every dbtest expectation re-derived from the fixture. Its four NITs TAKEN: three stale sentences here (§2, §2.4, §3), two comments still naming `PRIORITY` in `table.tsx` (`backlog-table.tsx`, `data-table.tsx`), and AGENTS.md's standing trap widened to the SILENT form this slice met.
