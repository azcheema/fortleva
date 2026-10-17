# Slice 127 — repeating tasks (founder decision C103)

*2026-10-17. The third of the three Basecamp-comparison slices (mentions → a bin for deleted tasks → repeating tasks; C101–C103). This document is the build plan: the settled parts are C103's (a)–(f), and everything marked **(reading)** is the implementing session's choice, named so a reviewer can push on it.*

## 1. What the founder decided

- **(a) A "Repeat" setting on a task**, e.g. "every month on the 1st". On each repeat day a fresh copy appears with the same title, description (checklist unticked), labels, estimate and subtasks. To change future copies, edit the newest one (over a separate routines list per project).
- **(b) On schedule, always.** A copy appears on its day even if the previous one is still open; a missed period stays visible as late.
- **(c) The same person, told as usual.** Each copy goes to the task's assignee, told like any task handed to them. If that person can no longer take it, the copy arrives unassigned.
- **(d) Due before the next copy** (asked 2026-10-17). Each copy is due the day before the next one appears.
- **(e) Week to year** (asked 2026-10-17). Every week or every 2 weeks on a weekday; every month, every 3 months or every year on a day. The 31st in a shorter month means its last day.
- **(f) Copies start hidden** (asked 2026-10-17). Every copy starts hidden from the client, like tasks from a template or an import.

## 2. What already exists (read, not assumed)

- **Every task service runs as a member.** `WorkCtx` is `{ tenantId, actor: MemberActor }` and `principalOf` always builds a member principal (`states.ts`). `createItem`, `assignItem`, `writeActivity` and `notifyItemMembers` all need `ctx.actor.memberId`.
- **The precedent for a task nobody at the agency made** is `createRequest` (`requests.ts`). It takes a bare transaction, writes `createdByMemberId: null` and writes its history row raw, with no member actor. The history panel renders a row that names nobody as **"System"** (`ActivityActor.kind = "system"`, `activity-section.tsx`).
- **The template copier** (`templates/service.ts` `makeTasks`):
  - It locks `lockCounter` → `lockProjectRanks` → `nextCounters(n)`.
  - It inserts **a level at a time** so the tree trigger finds each parent.
  - It writes `visibility: "INTERNAL"` explicitly and `source: "IN_APP"`, and puts each task in its starting stage.
  - It writes labels with `createMany`, history with `writeActivityMany`, and audit with `recordMany`.
  - It does **not** carry priority.
- **The template helpers** (`templates/definition.ts`):
  - `untickChecklists` is a pure copy with every `taskItem` unchecked.
  - `normalizeDescription` (`src/lib/rich-text/normalize.ts`) is the one gate for a stored description.
  - `takeTasks` is the rule for which tasks a copy takes: none deleted, none archived, no client request, nothing in Triage or Cancelled, and no task whose parent was left out.
- **THE ONE ORDER** (`rank-lock.ts`): the project's `work_states:` key → the task counter → the rank queue → row locks. Never call `ensureProjectStates` after the counter or the queue. `lockItemRow(…, "SHARE")` is the lock of a writer of another table's row that must hold a task still. The parent is locked before the child.
- **The month math with an anchor day** is `addIntervals` / `anchorOf` in `src/services/renewal-dates.ts`, the agreements' rule. A 31st lands on 28 February and returns to 31 March, never drifting to the 28th for good.
- **Who can take a task.**
  - The assignee picker and `assignItem` check ACTIVE only (`items.ts:1300`).
  - The full rule is `mentionableMembers` (`mentions.ts`): ACTIVE, holding `work_item:view`, and reaching the project. `mentions.dbtest.ts` pins it equal to `hasAccess` + `assertInScope` asked as each member. It works under SYSTEM.
- **Telling an assignee.** `work_item.assigned` carries reason `ASSIGNEE` and is debounced by 2 minutes for mail. `emit`'s actor is optional; a system job calls it with none, as the renewal drafts do. The mail's words ("A task was assigned to you") name no actor.
- **The job shape** is `src/jobs/report-drafts.ts` + `src/documents/report-drafts.ts`:
  - Discovery runs under `withPlatform`, ids only, over sending tenants (`DIGEST_SENDING_TENANT_STATUSES`).
  - Each tenant then runs in its own system transactions.
  - Each tenant checks `moduleOpenUnderSystem` and reads `readPreferences().timezone` → `localDateString`.
  - The run has a 45 s budget; tenants go in a shuffled order and each is isolated by its own try/catch.
- **The data export** builds its manifest from `MODEL_CLASSES` (`src/export/manifest.ts`), so a registered model is exported.
- **Teardown.** The harness's `removeTenant` deletes work items before the tenant, so tables that cascade from `work_item` need no teardown line. The dbtest fixture's `cleanup()` does not delete work items; each suite deletes its own before calling it (`bin.dbtest.ts`), so `repeat.dbtest.ts` does too (corrected by the pre-apply review, N2).

## 3. The design

### 3.1 Where the setting lives (reading)

**Two new class-A tables. The task row is untouched.**

- **`work_item_repeat`** holds one row per repeating series:
  - `work_item_id` is **the task the next copy is made from** (the "holder", always the newest; UNIQUE).
  - `rhythm` (`WEEKLY | BIWEEKLY | MONTHLY | QUARTERLY | YEARLY`, TEXT + CHECK, as `import_job.status` is).
  - `anchor_day` (1–31 for the month rhythms, NULL for the week ones).
  - `next_on` (the next repeat day, a workspace-local date).
  - `created_by_member_id` (attribution, no foreign key) and the timestamps.
- **`work_item_repeat_item`** holds one row per task of the series:
  - The task the repeat was set on has `made_for` NULL; each copy has the day it was made for.
  - The primary key is `(tenant_id, work_item_id)`, so a task is in at most one series.
  - `UNIQUE (tenant_id, repeat_id, made_for)` is **the database's belt against a second copy for the same day**, whoever writes.
  - A partial UNIQUE allows one `made_for IS NULL` per series.

**Why tables and not columns on `work_item`:**

- `portal_deny` closes both tables to a contact outright. The repeat setting is the agency's routine and no portal projection can ever name it.
- Moving the setting to the copy is one UPDATE of one small row.
- The job's discovery reads a small table, not `work_item`.

Both tables cascade from the task (and so from its project). Stopping a repeat **deletes the series row**; its membership rows go with it, and older copies become plain tasks.

**No `project_id` column.** The holder's own row says which project it is in, and a task cannot move between projects (the 2W trigger). A second copy of that fact would only be something to keep consistent.

### 3.2 The rhythm and the next day (C103 (e); reading)

A member picks a **rhythm** and the **next copy's day**. Everything else derives from that day:

- **Weekly:** next = day + 7.
- **Every 2 weeks:** next = day + 14. The weekday never changes.
- **Monthly, every 3 months, yearly:** next = `addIntervals(day, MONTHLY|QUARTERLY|YEARLY, 1, anchor)`, where the anchor is the day of the month that was picked. A yearly rhythm keeps the month too, because it steps 12 months.

A CHECK holds that a month rhythm's `next_on` lands on its anchor, or on its month's last day when the month is shorter. The rules are ONE pure module, `src/lib/repeat-rules.ts`, unit-tested and shared by the service, the job and the panel.

- **Starting** a repeat on a task that has none: the next day is **one period from today** in the workspace's zone (same weekday next week; same day next month, clamped). The member moves it with the Next copy row.
- **The next day must be after today and at most two years ahead** (`REPEAT_DAY_INVALID`).
- **Changing the rhythm keeps the next day.** A monthly series next on Sat 1 Nov switched to weekly repeats on Saturdays from 1 Nov.
- **The anchor** (amended by the pre-apply review, L2):
  - A month rhythm STARTED today anchors on **today's** day of the month. A repeat started on 31 January is next on 28 February and on 31 March again; it does not drift to the 28th.
  - A change between two month rhythms keeps the stored anchor.
  - A change from a week rhythm anchors on the kept day.
  - Only a picked Next copy day re-anchors.
- **Stop repeating** deletes the series (§3.1).

### 3.3 What a copy is (C103 (a), (d), (f))

The copy is made from **the holder as it is when the job runs**. That is how "edit the newest one" changes future copies.

- **Copied:**
  - The title.
  - The description with every checkbox unticked (`untickChecklists` → `normalizeDescription`). The checklist counters come from the normalized document.
  - `type` and `kind`, the labels and the estimate.
  - The **subtasks** (and an epic's tasks and their subtasks): the holder's live descendants by `takeTasks`' rule, re-rooted at the holder — except that an ARCHIVED subtask is taken (§8, L4), and a task of another series is not (§7, M2). Each carries its title, unticked description, type, kind, labels, estimate and assignee (§3.4), and **no dates**.
- **Dates (C103 (d)):** a copy made for day X has **start date X** and **due date = the day before the repeat day after X**. A monthly copy made for 1 Nov is due 30 Nov. The task the repeat was set on keeps its own dates.
- **Never copied:** priority (as templates, reading), the milestone, comments, files, time, followers and collaborators, a contact hand-over, and the stage (the copy starts **where new tasks start**). Visibility is never copied either: it is **always INTERNAL**, the subtasks too (C103 (f)).
- **Where it goes:** the project's bottom rank (`createItem`'s rule) via `bottomRanks`, with its subtasks after it. Its parent is **the holder's parent** when the holder has one (a repeating subtask repeats inside its task).
- **Provenance:** `source` stays `IN_APP` and `createdByMemberId` is NULL, as `createRequest` does. The series membership row is the record that a copy is one.
- **Size (reading):** at most **100 tasks under** the holder.
  - Setting a repeat on a task with more is refused (`REPEAT_TOO_BIG`).
  - If the subtree grows past 100 later, a copy takes the first 100 (by depth, then rank), and its audit says how many were left out.

### 3.4 Who gets it, who is told (C103 (c))

- **The copy's assignee** is the holder's **member** assignee if that member can still take it: ACTIVE, holding `work_item:view`, and reaching the project.
  - This is `mentionableMembers(tx, tenantId, project, [id])`, the stricter rule. The picker's ACTIVE-only check would hand a task to someone who can no longer open it.
  - Otherwise the copy is unassigned, and its audit says `assigneeDropped: true`.
  - A **contact** assignee never travels: a copy is private, and the database refuses a contact assignee on an INTERNAL task.
  - Each subtask gets its own assignee by the same rule.
- **Telling:** `work_item.assigned`, reason `ASSIGNEE`, no actor (the inbox and history say System), with the usual dedupe key `assigned:<id>`.
  - **A person is told once per copy** (reading): about the top copy if they hold it, else about the first subtask they hold. A person given a copy and four of its subtasks hears once.
  - The mail is the ordinary one, at the ordinary level, debounced and cancelled if read.

### 3.5 When (C103 (b); reading)

The jobs route runs hourly in production (Vercel Cron). Each kick:

1. **Finds** the sending workspaces (TRIALING / ACTIVE / PAST_DUE) holding a series whose `next_on` is at most tomorrow in UTC. That covers every zone's today; each workspace then decides with its own zone.
2. **For each workspace**, in a system transaction, closes on the work module being shut. It computes today in the workspace's zone and reads the due series: `next_on` ≤ today, holder not deleted, project not archived, completed, cancelled or **paused**, client not archived (the last two added by the pre-apply review, L1). It takes at most 200 a kick, the least recently touched first (§8, M-1), within its own 15 s slice. Discovery leaves out a series whose holder is deleted, or whose project makes no copies (M3, §8 L-1).
3. **For each series**, in its own system transaction, makes **ONE copy, for the latest repeat day on or before today**. The series then moves: the holder becomes the copy, and `next_on` becomes the first repeat day after today. This happens even when earlier copies are still open (on schedule, always).

**Missed days are not made later.** A day that passed while no kick ran (an outage, a suspended workspace, a holder in the bin, a project archived for a month) does not come back as a pile of backdated copies. There is one copy, for the latest day. So a copy is never born late: its due date is at least today. "A missed period stays visible as late" is the previous copy, still open past its due date.

**No copy is made while:**

- the holder is deleted. In the bin, the series waits; brought back, it resumes with one copy on the next kick.
- the project is archived, completed, cancelled or paused, or its client is archived (the panel says so).
- the workspace is not sending, or its work module is closed.

**Copies are still made when:**

- the holder is **archived**. Archiving finished tasks is housekeeping, and Stop repeating is the explicit verb.
- the holder is done or cancelled.

### 3.6 Concurrency and failure (reading)

**One system transaction per series, in THE ONE ORDER:**

1. `ensureProjectStates` (the stage key, only on a first seed).
2. The task counter (`lockCounter`).
3. The rank queue.
4. **The project's bottom row, FOR UPDATE** (`lockPredecessor`, the lock `bottomRank` takes). It is taken right after the queue, as `createItem` does, so a holder that IS the bottom row is locked once at the stronger mode and never upgraded under a colleague's share. Added while building.
5. The holder's parent (FOR SHARE), then the holder (FOR SHARE).
6. **The series row FOR UPDATE, re-read.** It must still name this holder and still be due. Otherwise nothing is written: another kick did it, or a person changed or stopped it.
7. **The holder and its project re-read** after those locks. A delete that committed meanwhile is seen, because its NO KEY UPDATE conflicts with the share (the pre-apply review, M1). A project archive racing this read is the same residual `createItem` has. No project-row lock is taken, because the portal fan-out holds that row while it writes task rows, which would close a cycle.
8. **A copy for the day already exists** (L3: a workspace's zone moved west, and a person set the next day to one already made). Then the series only moves `next_on` on.
9. Read the start stage, the subtree and the labels.
10. The inserts, a level at a time, then the membership row, then the series UPDATE.

**Every lock wait is bounded** (M4): `lockTimeoutMs` 5 s and a 30 s transaction under `retryOnContention`, which retries both a deadlock and a lock timeout. When the retries are spent, the failure is logged and the series stays due.

**A person's set, change or stop** takes the holder row (`loadItemInScope`, NO KEY UPDATE), then the series row. Item before series in both, so no cycle closes. Two kicks at once queue on the counter, and the second finds the series moved. The UNIQUE on `(repeat_id, made_for)` is the belt.

**Failure:** `retryOnDeadlock` around each series. One series' failure is logged (ids, error name and code, never a message) and the next runs. One workspace's failure never stops the rest. 45 s a kick across all workspaces.

### 3.7 Who may set it (reading)

**`work_item:edit` AND `work_item:create`**, with the task's project in scope, each asked in sequence. The setting is an instruction to create tasks. No new permission code, so no TEMPLATE_VERSION change. Refused:

- a client's request (`kind = REQUEST`): `REPEAT_NOT_ALLOWED`.
- a task in a series that is not its newest: `REPEAT_NOT_NEWEST`. The row links to the newest instead of offering the picker. **One exception (M3):** while the newest is deleted, an older copy may *stop* the series. Otherwise a newest copy deleted for good would strand it, with every task of it answering NOT_NEWEST.
- a task inside a repeating task, or with one inside it (its parent or grandparent, or any live task under it, belongs to a series): `REPEAT_NESTED` (M2). The outer copy would take the inner one's copies, more each period. As a belt, the copier leaves out any descendant that belongs to a series, with its children.
- a next day outside §3.2's bounds: `REPEAT_DAY_INVALID`.
- more than 100 tasks under it, or more than 2 MiB of descriptions, its own and theirs together: `REPEAT_TOO_BIG` (the byte budget is §8's).
- a deleted task: `NOT_FOUND`, as every task verb answers it.

### 3.8 Audit and history

- **A person's set, change or stop** audits **`work_item.repeat_changed`** with `{ projectId, from: {rhythm, nextOn} | null, to: … | null }`. This is a new catalogue action. A standing instruction to make tasks is not one of AGENTS.md's routine-edit carve-outs, so it is audited. It also writes an INTERNAL history row, field `repeat`, with old and new values `RHYTHM:YYYY-MM-DD`.
- **Each copy and each copied subtask** audits `work_item.created` as SYSTEM: `{ number, projectId, type, visibility: "INTERNAL", repeatId, repeatedFromId, madeFor, assigneeDropped?, leftOut? }`.
- **History rows, all System and INTERNAL:**
  - on the copy: `created`, `repeatedFrom` (the holder's number), and `assignee` when it has one;
  - on the old holder: `repeatCopied` (the copy's number).

### 3.9 The panel (reading)

The Repeat row sits after Due date and is seen by everyone who can open the task.

- **For a task that may take a repeat** (§3.7's codes):
  - a PropertyPicker lists "Doesn't repeat" or the current rhythm, then the five rhythms, each with the next day it would start on; and "Stop repeating" when set.
  - Then a **Next copy** row while it repeats: a picker with a CalendarGrid footer and a typed date, the Due date field's shape. Under it, one muted line: "Each copy is due the day before the next one appears. Copies start hidden from the client."
- **On an older copy:** "Repeats from KEY-14", a link to the newest. While the newest is deleted, it reads "Paused: KEY-14 is deleted" with a **Stop repeating** button (M3).
- **On a holder whose project makes no copies:** a muted line says why.
- **Read-only viewers** see the words without the picker.

There is no marker on the board or the backlog in this slice. Both the panel and the actions go through the existing `usePanelCommit`, `ActionResult` and toast path.

### 3.10 The portal

Nothing changes there. Both tables are class A. Copies and their history rows are INTERNAL, and no portal projection reads anything new.

### 3.11 Not built

- A board or backlog marker for repeating tasks.
- Every weekday, every N weeks or months (C103 (e)).
- A repeat carried by a project template.
- A "routines" list per project (C103 (a) chose against it).

## 4. The migration (reviewed BEFORE it is applied)

`20261031090000_repeating_tasks`, DDL only, so no DML and no `neon-smoke.yml` dispatch. It creates:

- the two tables, with their CHECKs, the UNIQUEs (§3.1) and the index `(tenant_id, next_on)`;
- foreign keys to the tenant (RESTRICT, as every table) and to `work_item` (CASCADE). The series table also gets one to itself as the target of `(tenant_id, id)`;
- grants to `app_runtime`;
- `ENABLE` + `FORCE ROW LEVEL SECURITY` with `tenant_isolation` and `portal_deny` on both.

It first takes `work_item` in SHARE ROW EXCLUSIVE with a 10 s `lock_timeout`, so the foreign keys never upgrade under a running dev server.

## 5. Tests

- **Unit:** `src/lib/repeat-rules.test.ts`:
  - the next day for every rhythm, and month-end clamping (31 Jan → 28/29 Feb → 31 Mar);
  - a yearly 29 February;
  - the latest-day rule across gaps, and the due date;
  - the default first day, and the bounds.
- **dbtest** `src/modules/work/repeat.dbtest.ts` (`setupTenant("repeat")`, prefix registered in `DBTEST_PREFIXES`):
  - **Setting:** the gates and refusals.
  - **What a copy is:** a copy's fields; INTERNAL from a CLIENT_VISIBLE holder; the unticked checklist and its counters; labels; subtasks; dates; the start stage; the bottom rank.
  - **The assignee:** kept; dropped for a suspended member, a member without the project, and a contact.
  - **Telling:** each person once.
  - **The series:** it moves; the latest-day rule after a gap; idempotent within a day; two kicks at once make ONE copy; the UNIQUE refuses a duplicate written raw.
  - **No copy while:** the holder is deleted (resumes when restored), or the project is archived. A copy is still made from an archived holder.
  - **Records and isolation:** the audit rows as SYSTEM; a contact principal reads nothing from either table.
- **e2e** `e2e/repeat.spec.ts`, in the owner's second workspace: set a repeat in the panel, see Next copy, plant the series due (fixture CLI), run the copier for that workspace (CLI), and find the copy in the backlog, assigned and private.

## 6. Docs amended with the build

- **AGENTS.md:** the jobs paragraph now says the route MAKES TASKS.
- **DATA_MODEL:** the two tables.
- **AUTHZ:** who may set a repeat.
- **UI.md:** the Repeat and Next copy rows.
- **SECURITY:** nothing new for a contact.
- **PLAN §0.**
- **OPEN_QUESTIONS:** C103 (d)–(f), already recorded.

## 7. The pre-apply review (a fresh agent, read-only: design, migration, schema, registry) — dispositions

**No HIGH.** The migration applies on PG18 and matches Prisma's names, types and actions. No path lets a client see anything (copies and every history row INTERNAL; class A on both tables; the notice to members only). No new lock cycle against `createItem`, the import, `deleteItem`, the bin, a stage removal, `moveItem`, the bulk verbs or the comment and label writers. The portal fan-out and `releaseContactAssignments` can deadlock with the copier exactly as they already can with `createItem`, and the retry covers it.

**Four MEDIUM, all TAKEN:**

- **M1 — the holder's and project's state are read again AFTER the locks.** The holder is read after its FOR SHARE, so a delete that committed meanwhile is seen. The project race is `createItem`'s residual (§3.6 step 7).
- **M2 — nested series would multiply subtasks.** `REPEAT_NESTED` at set time checks the parent, the grandparent and every live task under it. The copier leaves out any series member under the holder, with its children (§3.7).
- **M3 — a newest copy deleted for good would strand its series.** An older copy may stop the series while the newest is deleted. The line reads "Paused: KEY-14 is deleted" with Stop beside it, and discovery leaves such series out.
- **M4 — lock waits had no bound.** `lockTimeoutMs` 5 s, a 30 s transaction, `retryOnContention`.

**LOW:**

- **L1 — TAKEN.** A paused project, or an archived client, makes no copies.
- **L2 — TAKEN.** The anchor is today's day on a start and is kept between month rhythms; only a picked day re-anchors.
- **L3 — TAKEN.** A day already copied moves `next_on` on instead of failing on the UNIQUE every kick.
- **L4 — ACCEPTED as the service's invariant, pinned by the dbtest:** "the holder is a member of its own series". The copy test reads the membership list and the series' holder together. A deferred foreign key would be drift Prisma cannot model.

**NIT:**

- **N1 — TAKEN.** The migration comment no longer claims an upgrade; the lock's value is the bounded wait.
- **N2 — TAKEN.** §2's teardown line was corrected.
- **N3 — already so.** The copy is an explicit allow-list: no source pair, no `portalEnabled`, no triage or contact fields.
- **N4 — already so.** The start stage is read after the counter and queue.
- **N5 — already so.** `findFirst` is used for the origin row, and Prisma `update` for every write.
- **N6 — already so.** `REPEAT_TOO_BIG` counts through `copyableSubtree` (the `takeTasks` rule).
- **N7 — TAKEN.** The copy's `work_item.created` audit carries `nextOn`, the series' move.

## 8. The slice reviews (fresh agents, read-only: code + security, in parallel) — dispositions

### Security review

**No HIGH.** It found no path by which a contact reads a repeat row, a copy, or a copy's history, audit or notification, or learns that a copy exists beyond the number gap every internal task leaves. No cross-tenant mixing. No action beyond a member's codes or scope.

**M-1 — a series that keeps failing would head the list every kick, and a huge subtree could be built that fails every kick. TAKEN.**
- **Order:** the due read is least-recently-touched first (`updated_at`). A copy touches its series, and a failure touches it in its own small transaction, so a failing series goes to the back.
- **Time:** each workspace gets its own slice of a kick (`REPEAT_TENANT_SLICE_MS` 15 s) inside the caller's deadline.
- **Size:** descriptions have a **byte budget**, `REPEAT_MAX_DESCRIPTION_BYTES` (2 MiB) for the task's and its subtasks' stored JSON together. It is measured in SQL (`descriptionBytes`) before any description is read. Starting a repeat over it is refused (`REPEAT_TOO_BIG`). A copy of a tree that grew past it takes descriptions in order while each still fits the remaining budget — one that does not is copied without its description — and its audit row says `descriptionsLeftOut`.
- **Inserts:** chunking the `createMany` was not needed once the bytes are bounded.

**LOW:**
- **L-1 — TAKEN.** Discovery applies the project rule, so a series in a closed project no longer opens its workspace every hour.
- **L-2 — TAKEN.** The older-copy stop share-locks the newest task and reads it again before the series row, in the copier's order (tasks before series).

**NIT:**
- **TAKEN.** The L3 move is now audited (`work_item.repeat_changed`, SYSTEM, `reason: "day_already_made"`), and the fixture's misplaced JSDoc was moved.
- **ACCEPTED, bounded by the tree.** The subtree head read.
- **FOR THE FOUNDER:** a series outlives the person who set it up. Copies keep coming, as System, after that member leaves, until someone presses Stop.

### Code review

**H1 — "Stop repeating" on an older copy did nothing. TAKEN.**
- **Cause:** the panel hook's no-op guard compared rhythm and day, which are both "none" for an older copy and for a stopped task, so the request never left. That was the pre-apply review's M3 escape, unreachable from the UI.
- **Fix:** the shown value carries `copyOf`, and the copy branch is drawn from what is shown.
- **Pinned:** the e2e now deletes the newest copy, opens the older one, presses Stop and checks the row goes, after a reload too.

**No MEDIUM.**

**LOW:**
- **L1 — TAKEN, new tests:**
  - a repeating subtask's copy goes under its task, after the project's last row;
  - a task of another series under the holder is left out with its children (the M2 belt);
  - 101 tasks are cut to 100 (`leftOut: 1`), and descriptions past the budget are left out (`descriptionsLeftOut: 1`, 21 described);
  - an archived subtask is copied.
- **L2 — TAKEN.** The belts test names each constraint off `e.meta` (`brokenConstraint`, the templates suite's helper).
- **L3 — TAKEN.** Same as the security review's L-1.
- **L4 — TAKEN, as a reading.** An **archived** subtask stays a step of every later copy, because archiving finished steps is housekeeping, as for the holder. A **cancelled** one drops out, because the step is not done any more. Said in `copyableSubtree`.
- **L5 — TAKEN.** The e2e expects at least one copy and counts its own on the backlog, so a retry's leftover series cannot fail it.
- **L6 — ACCEPTED.** A member's set or stop has no lock bound of its own. Behind a copier holding the task, it waits up to the copy's 30 s and fails with the field's ordinary "did not save" toast, which is the known trade at today's copy sizes.

**NIT — all TAKEN:**
- The copier's lock-order comment now states `createItem`'s real order, and the header lists the bottom row.
- `copyOne`'s null comment.
- `from` and `to` in one shape in the audit.
- The stale sentence count.
- Swedish "skapade" and "Inget matchande intervall".
- A past day is refused in the panel before any request (typed rows are filtered, a picked day toasts the service's sentence).
- `NIL_UUID` is exported from `rank-lock.ts`, not copied.

## 9. The narrow re-check of the fix round (one fresh agent, read-only) — dispositions

**No HIGH, no MEDIUM.** Every §8 fix does what it says. The e2e's Stop path and the archived-subtask assertion would fail on the old code.

- **L-a — TAKEN.** The byte budget's refusal said "more than 100 tasks". `REPEAT_TOO_BIG`'s sentence now names both limits, in both languages.
- **L-b — TAKEN.** A dbtest pins "least recently touched first": two due series, `cap: 1`, and the older-touched one is copied. The discovery filter cannot be dbtested; AGENTS.md says never to run the job from a test.
- **LOW/NIT — TAKEN.** The panel's "today" is now the **workspace's** zone (`workspaceTimeZone`, passed down from the three pages), the day the service decides by. Before, a member whose zone is ahead could be refused, near midnight, a day the service would take.
- **NIT — TAKEN:**
  - The failure touch has a lock bound.
  - Every `work_item.repeat_changed` has one shape (`{ rhythm, nextOn, anchorDay }`, and `number` on the SYSTEM row).
  - The catalogue comment lists every key.
  - The budget is first-fit and §8 says so.
  - The stale lines in §3.3, §3.5 and §3.7 and in the job's header are fixed.
  - Swedish "Gör nästa kopia den …".
- **ACCEPTED:**
  - A long-lived LOCAL second workspace's leftover due series could crowd this run's copy out of its slice in the e2e. CI's workspace is fresh.
  - A residual deadlock between the older-copy stop and a Bring back of a newest that someone moved under that older copy. Postgres detects it: the restore retries (`BIN_BUSY` at worst) and the stop toasts.

The rounds converged on wording and tests, so no further round was run.
