# Slice 130 — every task in one list, and all projects on one timeline (founder decision C107)

*2026-10-17. The founder chose both pages, built together, on "continue" — the recommendation from the open own-use list (PLAN §0). All four follow-up answers were WITH the recommendation. Settled parts are C107's; everything marked **(reading)** is the implementing session's choice, named so a reviewer can push on it.*

## 1. What the founder decided

- **(a) Where.** A **Tasks** entry in the left menu, beside Calendar. The timeline is a **List · Timeline** switch at the top of the Projects page.
- **(b) A task opens beside the list.** The task panel over the list, as on a project's backlog, so the member keeps their place and their filters.
- **(c) By due date, with a group-by switch.** One list: overdue first, undated last, each row naming its project and its person. "Group by" project or person. Quick filters: **Overdue**, **Due this week**, **Nobody assigned**, **Mine**, plus a project picker and a person picker.
- **(d) Bars, milestones, today.** Each project a bar from its start date to its launch date, its milestones as dots on the bar, a line for today, about 13 weeks across with earlier and later. A bar opens its project. Projects missing a date are listed underneath with a link to set one.

## 2. What already exists (read, not assumed)

- **`listMyWork`** (`src/modules/work/my-work.ts`) and **`readCalendar`** (`src/modules/work/calendar.ts`) are the cross-project reads to copy. Each:
  - asks `work_item:view` (`requireAccess`, all four gates) and then `project:view` (`isAuthorized`), because every row links into a project; either refused → `null`, and the page draws its forbidden state;
  - composes `scopeWhere(...)` into the query with `AND`, never by spreading it (the inbox's page-2 bug);
  - leaves out deleted and archived tasks and archived projects; `listMyWork`'s OPEN is BACKLOG, TODO, IN_PROGRESS (Triage is the lane's, Done and Cancelled are finished).
- **Home's rows** (`home/queue-rows.tsx`) are the row look: a link per row, the state icon, the key, the title, the project, the state name, the priority glyph and the due date, collapsing below `sm`/`md`.
- **The peek** is `?item=KEY-N` on the board and the backlog: `PeekShell` (a right sheet the server renders into; closing navigates to the surface's own URL) around `ItemPanel`, loaded by `loadPanelItem` (one scope-checked read) and `loadPanelTimer`. The panel's `surface` (`"board" | "backlog" | "page"`) decides two things: the MFA step-up return address (`panelSurfaceOf` → `itemReturnTo`) and where its in-panel links go (`panelItemHref`, `copyLandingHref` — any non-page surface re-addresses its own `returnTo` with `?item=`). Its field actions do not revalidate the item's surface by path; the client's `router.refresh()` re-reads whatever page is open.
- **The calendar's filter** (`calendar/calendar-filter.tsx`) is a native select that writes one parameter and keeps the rest; `parseCalendarParams` reads every parameter strictly.
- **`weekContaining(today, weekStart)`** (`src/lib/week.ts`) gives the workspace's week; today is `todayIn(resolveTimeZone())`.
- **Projects** carry `startDate` and `launchDate` (UTC midnight of the day, set on the Overview) and `status` (PLANNED, ACTIVE, PAUSED, COMPLETED, CANCELLED, ARCHIVED). `listProjects` asks `project:view` (`requireAccess`) and scopes with `{ clientField: "clientId", projectField: "id" }`.
- **Milestones** carry `dueAt`, `completedAt`, `status` (cancelled ones are not counted anywhere on the member plane — `listProjects`' meter).
- **The identity colour** is `entityStyle(id, name)` → `--entity` (`src/lib/entity-color.ts`), twelve hues at the 3:1 non-text threshold; `BarList` is the chart precedent (plain HTML on tokens, server-rendered, positions as inline style, words in `title` for a mouse, the text carrying the meaning).
- **The skip list** refuses "Gantt with dependency auto-scheduling", and the project Timeline tab is "deliberately not a Gantt" (decision #7). A lineup of whole projects — no tasks, no dependencies, no scheduling — is neither, and the founder chose it.

## 3. The design

### 3.1 The Tasks page (C107 (a); reading)

`/tasks` is a new rail entry **after Projects, before Calendar**, gated on `work_item:view` (the code its read asks first; it also asks `project:view`, as the calendar does). Icon `ListTodoIcon` (`ListChecksIcon` is the board card's checklist badge). No `G` key (none fits; the calendar's precedent). Not a phone tab; it is in More.

Search parameters, each read strictly — an unknown value is the default and is never echoed:

- `due` = `overdue` | `week`;
- `person` = `me` | `none` | a member id;
- `project` = a project key;
- `group` = `project` | `person`;
- `item` = `KEY-N`, the peek.

Every link on the page is built from the PARSED values (`tasksHref`), never from the raw query.

### 3.2 What is on it (C107 (c))

Every **open** task (BACKLOG, TODO, IN_PROGRESS) in the member's scope, not deleted, not archived, in a project that is not archived — subtasks included, since they carry people and dates too. Done and Cancelled are finished; Triage is the lane's. The order is Home's: due day ascending with undated last, then priority (urgent first), then project key, then number. At most **500**; past that the page says so and suggests a filter.

Each row is a link that opens the peek (§3.5) and shows:
- the state icon, the key, the title;
- the project's name (not when grouped by project);
- the person — the member's avatar and name, or the client contact's name, or "Nobody" (not when grouped by person);
- the state name, the priority glyph;
- the due date, in the danger tone with an "overdue" word for a screen reader when it is before today.

### 3.3 The filters (C107 (c); reading)

- **Overdue** = due before today. **Due this week** = due on any day of the workspace's week containing today — a passed day of it included, drawn overdue. The two are one parameter: choosing one clears the other.
- **Mine** = assigned to me. **Nobody assigned** = no member and no contact. The person picker sets the same parameter, so Mine, Nobody and a named person are one choice.
- **The person picker** offers Anyone, Me, Nobody, then every MEMBER assigned to at least one open task in scope, by name. The names come from the tasks the member could already open, so the picker shows no one the list could not. A member id that is not among them is no filter (no oracle). Client contacts are not offered (their tasks show with the contact's name).
- **The project picker** offers every not-archived project in scope; an unknown or out-of-scope key is no filter (the calendar's rule). *(Superseded for the Tasks page by slice 136: such a key, or such a member id, matches nothing — saved views.)*
- The chips are links that toggle; the pickers are the calendar's native select. When the filters leave nothing, the empty state says so with a "Clear filters" link.

### 3.4 Group by (C107 (c); reading)

`group=project`: a heading per project (its chip and count), projects in name order, each keeping the due-date order inside. `group=person`: **Nobody first**, then members by name, then client contacts by name. No grouping is the default.

### 3.5 The task beside the list (C107 (b))

`?item=KEY-N` opens the task panel over the list (`PeekShell` + `ItemPanel`), with the backlog page's loads: the project by key (`getProjectByKey`, scope-checked; refused → no peek), `loadPanelItem`, `loadPanelTimer`, the documents when the project allows. A task that cannot be opened is no peek, silently — the backlog's rule for a foreign `item`.

The panel gets a fourth surface, **`tasks`** (`PanelSurface`), whose action surface is **`tasks-peek`**: the MFA step-up returns to `/tasks?item=KEY-N` (the filters dropped — the accepted cost the other surfaces carry). Its in-panel links (parent, subtasks, a repeat's newest task, a copy in the same project) re-address `/tasks` like any peek. Closing navigates to the list with its filters. Focus returns to the row that opened it (a list effect: when `item` goes away, the row's link is focused if nothing else holds focus) — or, when that row is not drawn, to the list's own region (§7, L2).

### 3.6 The timeline on Projects (C107 (a), (d); reading)

`/projects?view=timeline` (the list is the default; `view` read strictly). The header gains a **List · Timeline** switch (links); "Show archived" belongs to the list only.

**The read** (`readProjectLineup`, `src/projects/lineup.ts`) asks what `listProjects` asks: `project:view` (`requireAccess`) and the same scope. It takes the projects that are **PLANNED, ACTIVE or PAUSED** and not archived — a finished or cancelled project is not on anyone's lineup — with their milestones that are not cancelled.

**The window.** 13 weeks (91 days), starting on the workspace's week start; by default two weeks before the week containing today, so today sits near the left with eleven weeks ahead. `from` = any ISO day, snapped to its week start. Earlier and Later move it by four weeks; Today returns to the default. Bounded to 1970–2100 (`MIN_YEAR`/`MAX_YEAR`).

**The rows.** Every project with both dates, start ≤ launch, ordered by start, launch, then name:
- a label: the project chip and key, the client's name muted, the dates in words, its status badge when it is not ACTIVE, and **"Launch date passed"** (danger tone, icon and words) when the launch is before today;
- a track: hairline week lines; the **bar** from start to launch in the project's identity colour (12 px, rounded at a data end and square where the window cuts it), faded for a paused project; **milestones** as 10 px dots with a 2 px surface ring at their due day (their completion day when done and undated) — filled when done, hollow when not, so shape and not colour says which; a **today line** across every row;
- a project wholly outside the window still has its row, with "← launch 3 Mar" or "starts 4 Jun →" at the edge in muted text, so paging never makes rows jump in and out.

**Reading it.** The row's label link (to `/projects/KEY`) is the accessible content: its name, then the dates and the milestones in words for a screen reader. The bar is a second link to the same page for a mouse, `aria-hidden` and out of the tab order; each part carries its words in `title`. The month names head the track; on a phone the label stacks above the track, which keeps the 13 weeks across the full width without sideways scrolling.

**Underneath**, "Without dates": every listed project missing a start or a launch date, or whose launch is before its start, each a link to its Overview where the dates are set, saying which is missing.

## 4. Authorisation and portal

| Act | What it needs |
|---|---|
| `/tasks` | `work_item:view` (`requireAccess`, all four gates) + `project:view` (`isAuthorized`); otherwise the forbidden empty state |
| Rail entry | `work_item:view` |
| The peek | `getProjectByKey` (`project:view` + scope) and `getItemDetail` (the panel's own read) — exactly the backlog's peek |
| Every change made in the peek | the panel's existing actions, each asking its own code and the task's scope |
| The timeline | `project:view` (`requireAccess`) + scope — exactly `/projects` |

- No new permission code, no migration, no new audit action.
- Member-only: no portal read, projection or route is touched. Milestones are read on the member plane, where every one of a project's is shown on its Timeline tab already.
- The person picker's names come only from tasks in scope.

## 5. Tests

- **Unit** — `src/lib/task-list-plan.test.ts`: the params' strict parsing and falling back; `tasksHref`; the due filter's days; the grouping (Nobody first, names, contacts after). `src/lib/lineup-plan.test.ts`: the window and its snapping, earlier/later; a bar's geometry (inside, cut at either edge, wholly before or after); the today line inside and outside; a milestone's position; reversed dates.
- **dbtest** `src/modules/work/all-tasks.dbtest.ts` (own prefix, registered): scope (a project out of reach is absent, a `MemberProject` seat never sees the sibling project's tasks, key or assignee names); each filter; exclusions (done, cancelled, triage, deleted, archived, an archived project's); the person options; a stray member id and a stray key are no filter. `src/projects/lineup.dbtest.ts`: scope, the three statuses, cancelled milestones left out, the undated list.
- **e2e** `e2e/tasks.spec.ts`: the list across two projects; the chips and the pickers; group by; a row opens the peek beside the list, a change made there shows in the list after closing, and closing keeps the filters; the timeline draws a dated project's bar and lists an undated one.
- **Visual stops** `tasks` and `projects-timeline` (both volatile: dates are relative to the run).

## 6. Not built

- Editing in the row itself (the backlog's inline cells) — the peek does it.
- `J K` and `T` on the list's rows (Home's) — a later slice if the founder wants them.
- Saved views of the list (still on the own-use list).
- Dragging a bar's ends (C107 (d)'s third option).
- Done tasks in the list, and finished projects on the timeline.

## 7. The slice reviews (fresh agents, read-only: code + security, in parallel) — dispositions

### Security review

**No HIGH, no MEDIUM.** Every read composes scope with `AND`; both filters are resolved inside it (no oracle); the person picker's names come from in-scope tasks only; the peek is never looser than the backlog's; every link is built from parsed values; no migration, code, audit action or portal path was touched.

- **LOW-1 — free text from `?error=` shown in the panel's danger callout. ACCEPTED.** Content spoofing, not script (React escapes it), and only over a task the reader can open. The board, the backlog and the item page read `error` the same way since Phase 2; this slice adds a fourth surface of the same contract. Turning the bounce into an error CODE looked up by key is a change to all four surfaces and the file actions together — recorded as its own small item, not done here.
- **LOW-2 — the timeline read milestones without a cap. TAKEN.** `LINEUP_MILESTONE_CAP` = 100 a project, in rank order.
- **NIT-3 — the dbtest never put a person on the sibling project. TAKEN.** A seat reaching only the sibling project now holds its task: the project-only seat is never offered that name, and filtering by it is no filter.
- **NIT-4 — AUTHZ.md had no entry. TAKEN** (§3, beside the calendar's).

### Code review

**MEDIUM-1 — a fresh load of the timeline put focus in the New project form. TAKEN.** On `?view=timeline` the list's read is skipped, so `groups` was always empty and the form's empty-state `autoFocus` fired, scrolling the chart away. Now only the list view passes it. Pinned: the e2e loads `/projects?view=timeline` directly and asserts the Key field is not focused.

**LOW:**
- **L2 — closing the peek still fell to `<body>` when the row was gone. TAKEN.** `PeekFocusReturn` now wraps the list AND its empty states as a script-focusable region ("Tasks"); when the row is not drawn — the change took it out of the filter, emptied the list, or the peek named a task the list does not hold — the region takes focus. Pinned: the e2e asserts focus on the region after the assignment that removes the row.
- **L3 — an undated done milestone was drawn on its UTC day. TAKEN.** `completedAt` is an instant: its day is taken in the reader's zone (`localDateString`), the zone the page's "today" is in. **Kept, stated:** a done milestone with a due date sits on its DUE day here, while the project's Timeline tab orders by the day it was done — the lineup is the plan across projects; the dot is filled and its words say done.

**NIT — all TAKEN:**
- A month name starting past 92 % of the track is not drawn (it ran off the card); unit-pinned.
- Earlier / Later are not drawn when they would leave 1970–2100 (they jumped to today).
- The dot is 10 px (`size-2.5`); the docs said 8.
- The project-key copy is pinned to `PROJECT_KEY_RE` by source (the vault's way); `dayOf` uses `isoDateOf`; the person list is sorted once, by the page's collator.
- The edge text is "← launch 3 Mar" / "starts 4 Jun →" everywhere.

**Test gaps — TAKEN:** the timeline's fresh load (above); "my own id is Me" moved into `withSelfAsMe`, unit-pinned; the priority tie-break (an URGENT task on the same day sorts first, dbtest); focus after a removing change (above). **ACCEPTED:** `TASK_LIST_CAP`'s truncation is not exercised by a dbtest (501 tasks over the Neon link for one boolean; the cap is the calendar's shape).

## 8. The narrow re-check of the fix round (one fresh agent, read-only) — dispositions

**No HIGH, no MEDIUM, no LOW.** Every §7 fix does what it says, and each new test fails on the old code (the timeline's fresh-load focus, the region focus, the Stockholm day of an undated done milestone, the dropped last month name).

**NIT — all TAKEN:**
- The region takes focus with `preventScroll`: a partly visible region would otherwise nudge the page the member was keeping (C107 (b)). A row still scrolls into view, as a row should.
- UI.md (the Tasks row, §6's recorded exception) and §3.5 above now say "or the list's region when the row is gone".
- The person picker's sort breaks a name tie by id, so two people with one name keep their places between loads.
- **ACCEPTED, recorded:** `LINEUP_MILESTONE_CAP`'s `take` is not exercised by a test — the `TASK_LIST_CAP` precedent (§7).
