# Slice 128 — a calendar of tasks (founder decision C105)

*2026-10-17. The founder chose it on "suggest me something else", over forwarding an email to make a task, due dates in Google/Apple Calendar, and saved filters. All four follow-up answers were WITH the recommendation. Settled parts are C105's; everything marked **(reading)** is the implementing session's choice, named so a reviewer can push on it.*

## 1. What the founder decided

- **(a) One page in the left menu.** A "Calendar" page beside Home and Projects, showing all projects together, with a project filter.
- **(b) Everything I can see.** Every task with a due date in the projects the member reaches, with an "Only mine" switch.
- **(c) Upcoming repeat copies, faint, on their future days.** Every copy a repeating task will make, drawn faintly on its due date in the months ahead.
- **(d) Drag to change the due date,** with a keyboard way to do the same. Clicking a task still opens it.

## 2. What already exists (read, not assumed)

- **`listMyWork`** (`src/modules/work/my-work.ts`) is the cross-project read to copy:
  - It asks `work_item:view` (`requireAccess`), then `project:view` (`isAuthorized`), because every row links into a project.
  - It composes `scopeWhere(...)` into the query with `AND`, never by spreading it.
  - It filters out deleted and archived tasks and archived projects.
- **`monthGrid(yearMonth, weekStart)`** (`src/lib/calendar.ts`) returns 6 rows × 7 ISO days for the workspace's week start (`ui.weekStart`). `weekContaining`, `addDays` and `isoWeekOf` live in `src/lib/week.ts`.
- **Today** is the member's day in the zone the request resolved: `resolveTimeZone()`, then `todayIn`.
- **Dates are formatted on the server** with `formatDay` / `dateFormat(..., { timeZone: "UTC" })`. A label the browser reformats can differ between Node's and the browser's ICU, which is the hydration trap.
- **The board's drag-and-drop** uses `@atlaskit/pragmatic-drag-and-drop`:
  - typed drag data with a guard;
  - one `monitorForElements` per surface;
  - `dropTargetForElements` targets;
  - drag only on a fine pointer (ARC-17: no touch drag);
  - an optimistic move inside a transition, a toast on failure, then `router.refresh()`.
- **The board's keyboard twin** is a RowActions "Move to…" item that opens `MovePicker`, a `CommandDialog`.
- **`updateItemFields(ctx, id, { targetDate })`** is the one due-date writer. It needs `work_item:edit` and the item's scope, and writes a routine history row with no audit (AGENTS.md's carve-out for `updateItemFields`).
- **The repeat rules** are `owedCopy`, `repeatAfter` and `copyDueDate` (`src/lib/repeat-rules.ts`). A copy for day X is due the day before the next repeat day.
- **Item links** use `itemReturnTo("page", KEY, n)`, which gives `/projects/KEY/items/N`.
- **The rail** is `NAV` in `nav.ts`. An entry with `permission` is drawn only when the code is held on all four gates; icons come from `nav-icon.tsx`, one glyph per concept.

## 3. The design

### 3.1 The page (reading)

`/calendar` is a new rail entry **after Projects**, gated on `work_item:view`. Its icon is `CalendarDaysIcon` (`CalendarClockIcon` is Renewals'). It has no `G` key: D, E and L are refused by the keymap test, and none of the others fits. Search parameters:

- `view` = `month` (default) or `week`;
- `date` = any day inside the period shown (default: today);
- `project` = a project key in the member's scope;
- `mine` = `1`.

Every parameter is read strictly. An unknown value falls back to the default and is never echoed.

**The header** holds "Today", previous and next links (a month or a week), a Month / Week switch, the project filter (a native select, the reports filter's pattern) and an "Only mine" link that toggles. All are links or GET navigation, so the server renders the period.

**Month view:**
- A 7-column grid of the period's 6 rows. Days outside the month are muted.
- Today is marked.
- Each day shows up to **3** entries, then "+N more", which links to that day's week view.

**Week view:** 7 columns showing every entry.

**On a phone** (below `md`), the period is an **agenda**: the days that have entries, each under its date heading, in a list. A 7-column grid does not fit 390 px. Both are server-rendered, and CSS shows one.

### 3.2 What is on it (C105 (b); reading)

**Real tasks** with a due date (`target_date`) in the visible range:
- in the member's scope (`scopeWhere`);
- not deleted, not archived, in a project that is not archived;
- not Cancelled, and not in Triage (an unaccepted request is the triage lane's).

A Done task is drawn struck through and muted, so the week shows what was finished.

"Only mine" narrows to `assignee_member_id = me`. The project filter narrows to one project in scope; an unknown key is ignored.

They are ordered by day, then project key, then number. At most **500** per period; past that the page says so and suggests the project filter.

Each entry is a link to the task's page (`itemReturnTo("page")`), showing:
- the key and the title (truncated);
- the repeat marker when it holds a repeat;
- an **overdue** cue (danger tone) when it is open and its day is before today.

### 3.3 Upcoming repeat copies (C105 (c); reading)

**Which series:** every series whose holder is in scope, not deleted, and in a project that makes copies (`PROJECT_MAKES_COPIES_WHERE`). The same filters apply: "Only mine" means the holder's assignee is me, since copies go to the same person.

**Which copies.** For each series, walk the copy days X:
- **The first X:**
  - if `next_on` is after today, it is `next_on`;
  - otherwise the copier owes one now, and the first X is `owedCopy`'s `madeFor`, a copy that will exist within the hour.
- **Each later X:** `repeatAfter`.
- **The due date:** each copy is due on `copyDueDate(X)`. Copies whose due date falls in the visible range are drawn on that day.
- **The walk stops** at the range's end, or at 60 copies a series.
- **Total cap:** 500 projected entries.

**How they look.** A projected copy is drawn **faint**: muted text, a dashed outline and the repeat icon. It reads "Next copy of KEY-12 · appears Mon 3 Nov", with the date formatted on the server. It links to the series' newest task (its holder). It is **never draggable and has no menu**, since it does not exist yet.

**Never twice.** A copy that already exists is a real task, and its own day was at or before today, so the walk never draws it again.

### 3.4 Moving a task (C105 (d))

**Who.** The member holds `work_item:edit` (asked once for the page, `isAuthorized`), and the task is a real one with a number. The action asks again, with scope.

**Mouse.** On a fine pointer an entry is draggable and every day cell is a drop target. Dropping on another day moves the due date:
- the entry moves at once (`useOptimistic`, inside a transition);
- a refusal is a toast and the entry goes back;
- then `router.refresh()`.

A drop on the same day is a no-op. Dropping on a day outside the month moves it there.

**Keyboard and touch.** Each real entry has ONE small **Move…** button (the due date's `CalendarIcon`) — one verb, so no menu. It opens a `CommandDialog` (MovePicker's shape) listing Today, Tomorrow and the 13 days after, each labelled with its date, plus a typed ISO date (any real date the server accepts) as a derived row. Choosing one moves the task. Focus returns to the moved task's own Move… button (§6, M2).

**The action** is `moveCalendarTaskAction({ itemId, projectKey, targetDate })` (`calendar/actions.ts`):
- it takes the context from `requireTenantContext`;
- the zod shape is strict, the key regex-checked and the date `isIsoDate`;
- it calls `updateItemFields`;
- its fixed return path is `/calendar` (no open redirect);
- it revalidates `/calendar`, and the task's project's board and backlog.

The history row is the ordinary routine one; nothing new is audited. It returns the stored due date.

### 3.5 Not built

- Start-to-due spans.
- Dragging on touch screens (ARC-17).
- Milestones on the calendar.
- An ICS feed (C105's other option).
- Drag between weeks while the week view is scrolled.
- Saved calendar filters.

## 4. Authorisation and portal

| Act | What it needs |
|---|---|
| Page | `work_item:view` (`requireAccess`, all four gates) + `project:view` (`isAuthorized`); otherwise the page shows the forbidden empty state |
| Rail entry | `work_item:view` |
| Moving a task | `work_item:edit` + the task's scope, both asked by `updateItemFields` |

- No new permission code, no migration.
- Member-only: no portal read, projection or route is touched.
- The projected copies come only from series whose holder passes the same scope fragment.

## 5. Tests

- **Unit**, `src/lib/calendar-plan.test.ts` (the pure half):
  - the period for month and week, and the params' parsing and falling back;
  - the projection walk: the first X when owed and when not; due dates in the range; the stop at the range end; the cap; never today's or earlier made copies;
  - the per-day grouping and "+N more".
- **dbtest** `src/modules/work/calendar.dbtest.ts` (`setupTenant("cal")`, prefix registered):
  - **Scope:** a project out of the member's reach is absent; "Only mine"; the project filter.
  - **Range and exclusions:** the range edges; cancelled, triage, archived and deleted tasks are excluded; Done is included.
  - **Projected copies:** they respect scope and the filters; an owed copy is drawn; no projection for a deleted holder or a paused project.
  - **Moving:** the move action's service path is `updateItemFields`, already pinned.
- **e2e** `e2e/calendar.spec.ts`, in the second workspace, with fixture tasks due this week:
  - the week view shows them;
  - "Move to…" → Tomorrow moves one (after a reload too);
  - a mouse drag moves one;
  - a repeating task shows a faint next copy;
  - the project filter and "Only mine".
- **Visual stop** `calendar` (month view). It is listed volatile if its contents depend on the run date (the seeded due dates are relative to today).

## 6. The slice reviews (fresh agents, read-only: code + security, in parallel) — dispositions

### Security review

**No HIGH, no MEDIUM.** No path shows a contact anything. No tenant mixing. No title, project or series from outside the member's scope. The project filter is no existence oracle. The move action has no IDOR: a missing task, one out of scope and one in another tenant all answer NOT_FOUND.

**LOW-1 — the projection walk's CPU was set by `?date=`. TAKEN.**
- **Horizon:** copies are projected only for periods starting within `CALENDAR_PROJECTION_HORIZON_DAYS` (three years) of today. Past it none are drawn, and the page says so (`copiesBeyondHorizon`, dbtest-pinned).
- **Loop:** the outer loop stops once the copy cap is reached.

**NIT:**
- **NIT-1 — TAKEN.** A dbtest seat reaches ONE project of a client through `MemberProject`. It never sees the sibling project's tasks, copies or key, even when it names that key.
- **NIT-2 — ACCEPTED.** The action's project key is the caller's, used only to revalidate (backlog actions' precedent).
- **NIT-3 — TAKEN.** A redirect is passed silently (`isActionRedirect`).
- **NIT-4 — ACCEPTED.** The project list is unbounded and there is no `target_date` index; both are performance only.

### Code review

**H1 — dragging from the title did nothing. TAKEN.**
- **Cause:** a link is natively draggable, so a drag started on the title made the `<a>` the drag source, which the library's registry (keyed on the `<li>`) never saw.
- **Fix:** the link is `draggable={false}`.
- **Why the e2e passed:** today is a Saturday, so its target fell back to the task's own day.
- **Pinned:** the e2e now drags from the title link onto a day of the task's week that is NOT its own, asserts it left the old day, and reloads.

**MEDIUM:**
- **M1 — the e2e failed on Sundays. TAKEN.** After "Move…" it opens tomorrow's week before asserting.
- **M2 — focus fell to `<body>` after "Move…". TAKEN.**
  - **Cause:** the moved chip is a new node, committed with the dialog's close.
  - **Fix:** after that commit the moved task's visible Move… button takes focus (grid or agenda), and Radix's later restore leaves it alone, because whatever already has focus keeps it. The first cut also told the dialog's close not to place focus; that branch never ran (§7) and is gone.
  - **Pinned:** the e2e asserts focus when tomorrow is in the week shown.

**LOW:**
- **L1 — TAKEN.** The redirect, as the security review's NIT-3.
- **L2 — TAKEN.** The fixture makes a second, empty project, so the filter is drawn. The e2e uses it both ways: the run's project, then the empty one.
- **L3 — TAKEN.** The horizon, as the security review's LOW-1.
- **L4 — TAKEN.** `truncated` takes `{count}`.
- **L5 — TAKEN.** `aria-pressed` was dropped from the "Only mine" link.
- **L6 — TAKEN.** A copy's accessible name now carries its visible title ("Weekly check — next copy of KEY-12, appears …"), per WCAG 2.5.3.

**NIT:**
- **TAKEN:**
  - `copiesTruncated` now reads "may not be shown", since it means not every series was looked at.
  - This document no longer names a RowActions menu or a "Next week" row (one Move… button; today, tomorrow and 13 days), and says `md`, not `sm`.
  - The stale comments (`preferences.dbtest.ts`, `first-run.spec.ts`, AGENTS.md's stop count: 100 stops, 400 shots) are fixed.
  - A unit test pins the 60-copy cap per series.
  - A dbtest pins that an archived project's tasks are left out.
- **ACCEPTED:**
  - An owed copy is projected by the member's today, not the workspace's. Near midnight, a member ahead of the workspace may briefly see one copy the copier has not owed yet.
  - The 1970-01 and 2100-12 edge weeks.

## 7. The narrow re-check of the fix round (one fresh agent, read-only) — dispositions

**No HIGH, no MEDIUM.** Every §6 fix does what it says. The drag and focus assertions would fail on the old code.

**LOW — focus fell to `<body>` after some moves. TAKEN.**
- **When:** a Move… to a day the view does not draw (outside the week or month shown), or a refused move, whose reverted chip is a new node.
- **Fix:** the calendar's body is a script-focusable region (`tabIndex={-1}`, "Calendar") that takes focus when the moved task is not drawn. A refused move from the dialog asks the next commit — the chip back in its old cell — to focus that chip's Move… button.

**NIT — the dialog's `onCloseAutoFocus` → `preventDefault` never ran. TAKEN.** Radix fires it from a timeout after the board's effect has already cleared the ref. The prop and its comments are removed, and §6 corrected.
