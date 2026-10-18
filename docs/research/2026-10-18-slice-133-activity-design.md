# Slice 133 — the Activity page: what happened, across projects (founder decision C110)

*2026-10-18. Shown the open own-use list and asked which to build next (the calendar in Google/Apple Calendar recommended), the founder picked "a 'what happened today' feed" (own-use item 8). Then four answers: (a) **show who did it** — AGAINST the recommendation, after being told plainly that UI.md's rule 14 forbids a feed of colleagues' activity; (b) work and client events, (c) its own page in the menu, (d) scroll back day by day — all three WITH it. Everything marked **(reading)** is the implementing session's choice.*

## 1. What the founder decided

- **(a) Show who did it.** The page names the teammate (or the client's person) behind each event. UI.md rule 14 and §12 are amended in place (dated, C110): a page of WORK events may name who did each — the cross-project view of the history every task's panel already shows. **Still forbidden:** any view BY person (a filter, a page, a count, a ranking), presence, and hours. SECURITY.md §9.7.2's never-list is unchanged: nothing here is time, idle state, location or anything a member did not do as work in the product.
- **(b) Work and client events:** tasks finished; new tasks and client requests; client comments and approvals; files added; updates sent; milestones reached; versions shipped. No contracts, invoices or time.
- **(c) Its own page in the menu:** "Activity", newest first, grouped by day, with a project and a client filter.
- **(d) Scroll back day by day**, as far as the history goes.

## 2. What already exists (read, not assumed — two read-only maps, 2026-10-18)

- **`work_item_activity`** (class B, project-scoped) records every task change with an actor (member, contact, or none = the system): `created`, `stateCategory` (to `DONE` = finished), and more. Nothing reads it across projects; the panel reads one task's (`readItemActivity`).
- **The other events have their own timestamps:** a comment's `createdAt` (its author a member or a contact; subject a task, a file, a file version, an update or a version), a file's `createdAt` and each later `file_version`, a file's approval (`approvalDecidedAt`, `approvalByContactId`), an update's `publishedAt`/`publishedByMemberId`, a milestone's `completedAt` (no actor), a version's `shippedAt` (no actor) and its sign-off (`approvalDecidedAt`, `approvalByContactId`).
- **Scope is the application's** (`scopeWhere`, composed with `AND`); the Tasks page's read (`listAllTasks`) is the model: `work_item:view` on all four gates and `project:view`, a project filter found among the projects in scope or no filter at all.
- **No index** leads with `(tenant_id, created_at)` on `work_item_activity`, `document` or `comment`.

## 3. The design

### 3.1 The read (`src/modules/work/activity-feed.ts`, `readActivityFeed`)

- **Who:** `work_item:view` on all four gates and `project:view` (the Tasks page's pair) — else null, the page's forbidden state. Then, in sequence, `document:view` and `project_update:view` on all four gates (`accessibleCodes`): without the first, no file events and no comments on files; without the second, no update events and no comments on updates.
- **Where:** every event table's `clientId`/`projectId` under `scopeWhere`, composed with `AND`. The filters are found among the projects in scope (not archived) and those projects' clients — else no filter, never an error.
- **What (reading):** one query per kind, each over the WINDOW and ordered newest first:
  - a task added (`created`) — "sent a request" when its actor is a client's person; finished (`stateCategory` → `DONE`); the task not deleted (a task in the bin takes its events with it until it comes back);
  - a comment by a client's person, on a task, a file, a file version, an update or a version (each by its own code above), not deleted;
  - a file added (not deleted; data exports left out), and each later version of one;
  - a file approved or sent back by a client's person;
  - an update published (and still published or archived since);
  - a milestone done; a version shipped; a version approved or sent back by a client's person.
- **The window (reading):** seven days of the reader's own time zone (`resolveTimeZone`) ending at "until" (today by default). Each query takes at most 301 rows (a continued page: 301 + the day's events already drawn; the task kind up to four reads of that); merged newest first and cut at 300 — a cut page goes on inside its last day (§5a). **Earlier:** the newest event BEFORE the window, across the same queries (within a year — §5a), names the next window's last day — so empty weeks are skipped, and when there is none, the history has ended.
- **Names:** a member by their user name (a suspended one too) — the READER themselves as "You"; a client's person by name with their client; no actor as "Fortleva". A task by key and title, a file by name, an update by number and title, a milestone by name, a version by its label.
- Sequential reads on one transaction (AGENTS.md's `Promise.all` trap). No audit: a read. Member plane only — no portal projection reads it.

### 3.2 The page (`/activity`)

- A rail entry **Activity** after Calendar, on `work_item:view` (the rail's precedent for Tasks and Calendar); no `G` key.
- Days newest first — "Today", "Yesterday", then the weekday and date — each event one line: an icon for its kind, the sentence (who, what, a link to it), and under it the project (or client) — no clock time (§5a). Links: a task opens in its project's backlog peek; a file goes to its project's (or client's) Files; an update to its page; a milestone or a version to the project's timeline.
- Filters: **Project** and **Client** (native selects, as the Tasks page's), each drawn when there are two or more to choose from; a change goes back to today. **Show earlier** at the foot; **Back to today** once earlier (one filter at a time, §5a).
- Server-rendered throughout, every date and time formatted on the server in the reader's zone — no hydration difference.
- Parameters read strictly (`src/lib/activity-plan.ts`): `project` a key, `client` a uuid, `until` a `YYYY-MM-DD` not after today.

### 3.3 The indexes (migration `20261102090000_activity_feed_indexes`)

`(tenant_id, created_at)` on `work_item_activity`, `document` and `comment` — the window and the "newest before" probe read by time across a workspace. No other schema change.

### 3.4 Not built

- A filter or a page by person, counts, rankings — C110 and the never-list.
- Contracts, invoices, time (C110 (b)); team comments (the founder chose client comments); triage decisions, assignments, due-date and other field changes.
- Live updates (the page is read when opened); an Activity tab on each project or client (C110 (c)).

## 4. Authorisation and portal

| Act | What it needs |
|---|---|
| Open the page | `work_item:view` (all four gates) + `project:view` |
| File events, comments on files | + `document:view` (all four gates) |
| Update events, comments on updates | + `project_update:view` (all four gates) |

- Every event inside the reader's scope, by `scopeWhere` on each table's own client and project.
- No permission code, no audit action. The portal reads nothing new.

## 5a. Changed by the reviews (§6)

- **No report, no export** is ever "a file added" (a report is behind `report:view` and the reports module everywhere else).
- **The day, never the clock:** each line shows its project or client only; the day heading is the only time. With a teammate named on each line, times would read as when each person worked and was "last active", which SECURITY.md §9.7.3 rules out.
- **Paging inside a day:** a page cut at 300 goes on INSIDE its last day (`until` + `skip`, the count of that day's events already drawn), so nothing is out of reach; past 3 000 into one day (only a huge import) it moves to the day before.
- **"Earlier" looks back a year at a time:** within the year before the window, the newest event's day; an empty year jumps a year back; the history ends at the workspace's creation.
- **A birth into Done is "added", not "finished":** a Done row within five seconds of the task's first `created` row (an import's or a template's same statement, `createItem` straight into a Done column).
- **A client's person is named only within the event's client**; otherwise "Someone".
- Links underlined at rest; one of the two filters at a time.

## 5. Tests

- **Unit** `activity-plan.test.ts`: the parameters, the window, the merge and its cap, the links.
- **dbtest** `activity-feed.dbtest.ts` (`setupTenant("af")`, prefix registered): all nine kinds appear, named (a request, comments on a task and on a file, a file approval, a version sent back); a task in the bin, a deleted file, an export and a report never appear; a task made straight into Done is only "added"; a client's person on another client's event is not named; a member reaching one project sees none of another project's events of ANY kind; one without `document:view` / `project_update:view` sees no file or update events nor comments on files; the filters; the window and the "earlier" day (computed from the newest event's own day — no midnight flake); a member without `work_item:view` is refused.
- **e2e** `activity.spec.ts`: a task added appears under Today naming "You", its link opens it; the project filter.

## 6. The slice reviews (fresh agents, read-only: code + security in parallel) — dispositions

### Security review — no HIGH
- **MEDIUM — REPORT documents reached the feed without `report:view` or the reports module.** TAKEN: `NOT_FILE_EVENTS` (EXPORT, REPORT) in every document and file-version read, the comment subjects included; dbtest.
- **LOW — the "earlier" probe walked the whole history on every load.** TAKEN: a year at a time, ending at the workspace's creation (§5a).
- **LOW — a plain CREATE INDEX blocks writes for its build.** ACCEPTED, as the migration says (no `CONCURRENTLY` inside Prisma's transaction); harmless at today's sizes, noted for production.
- **NIT — events past the cap could not be reached.** TAKEN (paging inside a day, §5a).
- **NIT — workspace-level files (no client) are hidden from scoped members.** ACCEPTED: it errs toward showing less.

### Code review — no HIGH
- **M1 — reports, as above.** TAKEN.
- **M2 — clock times beside named colleagues are a "last active" timeline SECURITY.md §9.7.3 still forbids.** TAKEN the conservative way: no times on the page (§5a). Showing them would need the founder's word and an amendment of §9.7.3 and the staff notice — offered to the founder, not built.
- **L1 — truncation lost events.** TAKEN (§5a).
- **L2 — imports and templates made false "finished" lines.** TAKEN (§5a). A task finished and reopened keeps its "finished" line — what happened; ACCEPTED.
- **L3 — contacts not bound to the event's client.** TAKEN.
- **L4 — client comments whose subject is gone still count toward the cap.** ACCEPTED: they are dropped after the merge, so such a page can draw a few fewer lines; the paging counts positions before naming, so nothing is skipped by it. Rare (a client comment on a task later binned).
- **L5 — the probe, unbounded.** TAKEN (§5a).
- **L6 — links not told apart from text.** TAKEN: underlined at rest.
- **L7 — "före detta" means "former".** TAKEN: "Det var allt – inget hände tidigare."
- **L8 — tests claimed more.** TAKEN: the dbtest above (every kind, every kind out of scope, the midnight flake).
- **NITs:** the filtered empty state with `until` set (fixed: it shows the window's "nothing" line and Back to today); the two filters (one at a time now); workspace-level files (as above); a client ticking their task done (`contactCompletedAt`) is not shown — not in C110 (b), recorded; `NOT` with a NULL `oldValue` (every writer sets it — ACCEPTED); the project-key pattern (now imported from `task-list-plan`); the design's §6 (this) and AGENTS.md's stop tally (updated); an update's line uses its CURRENT visibility, not the one it was published with — ACCEPTED (it says where the update is now).

## 7. The narrow re-check of the fixes (a fresh agent, read-only) — dispositions

Every §6 fix confirmed in code, none leaking anything. Its findings, all TAKEN:
- **MEDIUM — the "earlier" probe hid an import's day.** An import writes a batch's `created` rows and then their births into Done in ONE statement — one instant, the Done rows newest by id — so the probe's four one-row reads all met births and dropped them; "Show earlier" skipped the day or said the history had ended. The probe now skips the birth rule (a birth's `created` twin is the same day). dbtest: six such births 40 days ahead; the probe names their day, and that day's page shows six "added", none "finished".
- **LOW — the birth window had a few round trips of margin** (`createItem` straight into Done runs the audit, an approval check and the update between its two rows; over the transatlantic dev link that can pass a second). Now five seconds; the dbtest's finishes wait 5.1 s.
- **LOW — the paging inside a day had no test.** dbtest: one task and 310 more `created` rows on one day (its own client, so it crowds no other test); page one draws 300 and names `{ until: today, skip: 300 }`, page two the other 11 — 311 distinct events, in order.
- **NITs:** a row read twice across the task kind's offset rounds (an event committed in between) is dropped by id; a page that goes on inside TODAY keeps `until` + `skip` (and Back to today); the button says **Show earlier** (it may stay within the day); the stale comments (`activity-feed.ts` WHEN/EARLIER, `activity-plan.ts`, `page.tsx`) and §3's lines now point at §5a. Comments on a report or an export still count as positions (dropped at naming) — ACCEPTED with L4.

## 8. The second narrow re-check — product code clean

It found the round's product code sound (the probe cannot land on an empty page while `BIRTH_ROUNDS × (ACTIVITY_PAGE_CAP + 1)` stays above a template's 1 000 births — now said beside `BIRTH_ROUNDS`; `seen` hides no legitimate row; the links and empty states hold). TAKEN, test- and comment-only, with no further pass: the two new dbtests took their day from the CLOCK, so a run between 00:00 and 01:00 before a DST change (or across midnight) failed — both now take it from the data (`localDateString` of the instant); the stale comments ("Show earlier days", "only on a past window", "a few milliseconds", "an import of thousands", "no person finishes within five seconds") and §3.1's row bound corrected.
