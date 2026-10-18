# Slice 131 — move a task to another project (founder decision C108)

*2026-10-17. Asked with a recommendation, the founder picked moving a task over the calendar in Google/Apple Calendar, a small polish item and going live; then four answers, all WITH the recommendation. Settled parts are C108's; everything marked **(reading)** is the implementing session's choice, named so a reviewer can push on it.*

## 1. What the founder decided

- **(a) Same client only.** A task moves only between projects of its own client. One put under the wrong client is copied instead (slice 129).
- **(b) The hours move with it.** They count toward the new project from then on. A move is **refused, saying why,** while any of them is on an invoice.
- **(c) Old links still work.** A link with the old number (an email, a comment, a bookmark) opens the task in its new place.
- **(d) Built here, now**, with the same independent reviews before the commit.

## 2. What already exists (read, not assumed — three read-only maps, 2026-10-17)

- **The database refuses a move today.** `work_item_no_move` (phase-2W migration) raises on ANY update of `work_item.project_id` or `client_id`: "a service operation — renumber, restate, re-rank, re-client — never a column update". The tree guard (`work_item_parent_guard`, 20260911200000) raises `WORK_TREE_REPARENT` when a row with children gets a new parent, and `WORK_TREE_PROJECT` when a parent is in another project. The milestone guard requires the milestone in the same project; `state_id` is checked only when it is SET.
- **Rows that carry the project** and must follow a moved task: `work_item_activity` (its guard re-derives `project_id` from the task), `comment` on the task and on its attached documents and their file versions (no guard on `project_id`), `document` attached to it (the anchor guard requires the task's own project — so the task first), `time_entry` (`time_entry_scope_guard`: the task must already be in the entry's project; a service scoped to another project raises `SERVICE_CLIENT_MISMATCH`). `search_index` follows by its feeds. Labels have no guard: a label is the workspace's (`project_id` NULL) or one project's.
- **Client visibility is stamped by triggers.** `stamp_portal_enabled` runs BEFORE INSERT OR UPDATE OF `project_id` on `work_item`, `work_item_activity`, `comment`, `document`: it derives the row's `portal_enabled` from the NEW project, failing CLOSED (false) when the portal gate is busy, with a commit-time heal (slice 74). It fires only when `project_id` is in the statement's SET list, at depth 0. Portal access is per CLIENT (no contact-to-project table); the gate is `client_id = app.client_id AND visibility = 'CLIENT_VISIBLE' AND portal_enabled`.
- **Copy (slice 129, `copy.ts`)** is the machine to mirror: three codes in sequence, the probe then scope on both projects, the lock order (stage key → counter → rank queue → bottom row → rows), `nextCounters`, `ranksBetween`, `labelFits`, `mentionableMembers`, `writeActivityMany` with refs, `recordMany`, `retryOnContention` → a BUSY code.
- **Hours:** billing MARKS an hour (`invoiceLineId`, `billedExternallyAt`, `writtenOffAt`); nothing in the database locks or refuses a project change for a marked hour — the app must. `lockedReason` refuses every update (no app code sets it). Rates are SNAPSHOTS on the entry; `repriceRateCard` re-picks them in memory (`pickSnapshot`) and writes one `updateMany` per snapshot. `ProjectTimeSummary` is recomputed by the app (`recomputeTouched`); money, budgets, the ready-to-invoice list and spent time read live entries. Published time reports and issued invoices are snapshots and never change.
- **Links by number:** the item page and the peeks (`?item=KEY-N`) resolve `(project, number)` and 404 / show nothing for a moved task; e-mails carry `/projects/KEY/backlog?item=KEY-N` frozen at send; the inbox resolves a task by id but its PROJECT from the notification row's stored project — so a moved task's notice would lose its title and link. The portal (by id) and search (by id, subtitle re-derived) survive.

## 3. The design

### 3.1 The migration (`20261101090000_move_a_task`, reading)

1. **`work_item_no_move`, replaced.** A change of `client_id` is refused ALWAYS (C108 (a), now in the database). A change of `project_id` is refused unless the transaction set `app.work_item_move` to `on` (read with `coalesce(..., '') = 'on'` — the NULL-GUC trap), and then only to a project of the SAME client (`project.client_id = NEW.client_id`, read in the trigger).
2. **`work_item_parent_guard`, replaced** (the 2026-09-11 body, one change): `WORK_TREE_REPARENT` is waived only under the same flag AND only for a row taken to the TOP (`NEW.parent_id IS NULL`) — the move detaches its holder; nothing else re-parents.
3. **`work_item_alias`** — a new class-A table (tenant_isolation + portal_deny; grants to `app_runtime`): `(tenant_id, project_id, number) → work_item_id`, primary key on the first three, cascading with the project and with the task. One row per moved task, for its OLD key. A task moved twice has two; each points at the task, so every old key finds where it is NOW.

### 3.2 The move (`src/modules/work/move.ts`, `moveItemToProject`)

**Who (reading).** `work_item:view` + `work_item:create` + `work_item:edit` in sequence (copy's three: a move takes the task out of one project and creates it in another), the source's project and the target's in scope, the same client, neither archived. **And `work_item:change_visibility` when anything moved is shared with the client** — a task, a subtask, a comment or a file attached to one: carrying shared work into another project can put it in front of the client where it was not (the target's portal may be on where the source's was off), which is what that code gates (C38). *(The review round, §6:)* and `time:edit_any` when any moved hour is a colleague's, and `work_item:approve` when a live task lands in an approval-gated stage from one that was not.

**What moves.** The task and EVERY task under it — live, archived and in the bin alike (a row left behind would break the tree) — with: their comments (and those on their attached files), their attached files, their history, their hours, their repeat. A subtask moved on its own becomes a TASK at the top of the target (copy's rule).

**Refused (each a domain code with words):**
- the target is the source, another client's, archived, or not reachable → NOT_FOUND (the dialog never offers one);
- more than 100 tasks under it → `MOVE_TOO_BIG`;
- a client's request still waiting in Triage, at any level → `MOVE_IN_TRIAGE` ("accept or decline it first");
- any of its hours on an invoice, billed elsewhere or written off → `MOVE_HOURS_BILLED` (C108 (b): the billed record must keep its project); a locked hour → the same code;
- more than 5 000 hours → `MOVE_TOO_BIG`;
- an imported task whose source key the target already holds → `MOVE_SOURCE_TAKEN`;
- contention after three tries → `MOVE_BUSY`.

**In the target, each moved task gets (reading):**
- a new number from the target's counter, in tree order; ranks at the bottom, in order;
- its stage: the target's stage with the same NAME (case-insensitive), else the target's first stage of the same KIND, else where new tasks start;
- no milestone and no "fixed in version" (both the old project's);
- its labels minus the old project's own (the workspace's stay) — counted;
- its person kept if they can take tasks in the target (`mentionableMembers`), else cleared — counted, with a history row; a client's contact kept (same client); collaborators and subscribers who cannot reach the target removed;
- its visibility unchanged; `portal_enabled` re-derived by the stamp (every UPDATE names `project_id`).

**Hours (C108 (b)):** every entry on the moved tasks (deleted ones too) takes the target project; a service scoped to the old project is cleared; the rate is re-picked for the target exactly as `repriceRateCard` does (cards once, `pickSnapshot`, one update per snapshot); both projects' summaries are recomputed (`recomputeTouched`). A running timer moves with its task.

**Old links (C108 (c)):** an alias row for each moved task's old `(project, number)`.

**The record.** History on each moved task: `moved` naming the old project by REF (`oldRef` = project id) and the old number — the panel shows "Moved from KEY-N" only when the reader can see that project, else "Moved from another project" (copy's L-1 rule). Audit `work_item.moved` per task (new catalog entry, TENANT): `{fromProjectId, fromNumber, toProjectId, toNumber}`, and on the moved task the counts — `subtasks`, `entries`, `seconds`, `labelsLeftOff`, `assigneesLeftOff`, `milestoneCleared`. The hours' project change is inside this audit row, not one `time_entry.*` per hour.

**Order (reading).** In one READ COMMITTED transaction (30 s, 5 s lock wait), as copy: `ensureProjectStates(target)` → the target's counter → BOTH projects' rank queues in id order → the target's bottom row FOR UPDATE → the moved rows FOR UPDATE (id order) → their hours FOR UPDATE (id order), marks re-checked under the lock → `set_config('app.work_item_move','on', true)` → the holder, then each level → files → comments → history rows' project → hours → summaries → aliases → history → audit. Taking both queues closes the cycle copy's design accepted (a move cannot meet a copy or a reorder in either project with a queue in hand).

### 3.3 Where it is offered (reading)

**Move…** beside **Copy…** in the task panel's header (peek and page), and in the backlog row menu and the board card menu — for a member holding create + edit (the panel's and the lists' existing caps; the move asks view too). When the client has no other project the member reaches, the dialog says so — cheaper than a read on every panel. A dialog (`move-task-dialog.tsx`):
- the project — the client's other projects in scope, not archived;
- what will happen, read for that project (`moveFactsAction`): "N tasks under it move with it", "X h of time moves", "These labels are left off: …", "Not given to anyone there: …", "Its milestone is cleared", the visibility sentence when something is shared ("Shared with the client — they will see it in PROJECT" when its portal is on) — and every refusal in words, the Move button disabled;
- **Move** → the task opens in its new place: on `/tasks` the peek re-addressed to the new key, elsewhere the task's page in the new project. A toast: "Moved to KEY-N".

### 3.4 Old links (C108 (c))

When a task is not found by `(project, number)`, the alias is asked: the item page, the board's and the backlog's `?item=` and the Tasks page's `?item=` redirect to the task's place NOW — **only when the reader can open it there** (project in scope, `work_item:view`); otherwise the old address behaves as before (404 / no peek): an alias never names a project the reader cannot see.

### 3.5 The inbox

A task notice's project is the task's CURRENT one (loaded with the page's other projects, the same scope), so a moved task's notices keep their title and link.

### 3.6 Not built

- Moving to another client (C108 (a)); moving several tasks at once; dragging a task onto another project.
- Rewriting old e-mails (the alias answers them) or old notices' stored project (the inbox reads the task's).
- A draft time report in the old project that names a moved task must be made again before it can be published (`assertNamesStillShared` no longer finds it there) — recorded, not changed.

## 4. Authorisation and portal

| Act | What it needs |
|---|---|
| Move | `work_item:view` + `work_item:create` + `work_item:edit` (each on all four gates, in sequence), both projects in scope, same client, neither archived; + `work_item:change_visibility` when anything moved is CLIENT_VISIBLE |
| The dialog's reads | the same codes as the move (it shows the task's tree, hours and labels) |
| Following an old link | the reader's own scope and `work_item:view` on the task's current project |

- One new audit action (`work_item.moved`); no new permission code.
- The database now permits a project change ONLY under the move's flag, ONLY within the client; the client never changes.
- Portal: nothing a contact reads changes shape; `portal_enabled` on every moved row is the target project's, derived by the stamp — fail-closed under contention, healed at commit.

## 5. Tests

- **Unit** — the stage mapping (name, kind, default) and the refusal reasons' wording keys (`move-plan.ts`).
- **dbtest** `src/modules/work/move.dbtest.ts` (`setupTenant("mv")`, prefix registered): a task with subtasks, comments, a file, history, labels (workspace + project), a milestone, hours (one running), a repeat — moved: numbers, ranks, stages, labels, milestone, people, aliases, hours re-priced and summaries both sides, `portal_enabled` per the target's switch, the audit row; refusals (another client, archived, Triage, billed hour, too big, scope, no change_visibility for shared work); the database refusing a bare `UPDATE project_id`, a client change even under the flag, and a re-parent outside a move; the inbox naming a moved task; an alias resolved only for a reader in scope.
- **e2e** `e2e/move-task.spec.ts`: Move… from the panel to the client's other project; the old link opens it; the history says "Moved from".

## 6. The slice reviews (fresh agents, read-only: code + security in parallel) — dispositions

### Security review

**No HIGH.** A move cannot make internal data client-visible, cross a client, or leave the member's scope; every moved row's stamp is re-derived; the flag is transaction-local and reset; the new table is class A with FORCE RLS.

- **MEDIUM-1 — the move edited and re-priced COLLEAGUES' hours on work-item codes alone, and kept no record of what they were. TAKEN.** A moved hour that is another member's asks `time:edit_any` (in sequence), as editing it always has (`updateEntry`); every moved hour writes its own audit row — `time_entry.updated`, or `time_entry.edited_by_other` for a colleague's — ids only: `movedWith`, `fromProjectId`, `projectId`, and, where they changed, `fromServiceId`, `fromRateSource`, `fromBillRateCardId`, `fromCostRateCardId`. `time:reprice` is NOT asked: re-pricing is what any change of an entry's project does (`updateEntry`), and C108 (b) is that the hours count toward the new project. The dialog says it in advance (`refuse.othersHours`).
- **MEDIUM-2 — a task whose binned subtask ever had a file could never move. TAKEN** (the code review's HIGH-1, same finding). A second, forward migration (`20261101100000_move_a_task_guards` — the first was already applied to dev and is never edited) adds ONE branch to `document_anchor_guard`: under the move's flag, a dangling anchor's UPDATE may change `project_id` when it keeps the anchor and the client, raises no visibility, and the anchored task (binned or not) is already in the new project. The move keeps the flag on through the files' update. Pinned: the dbtest's binned subtask now has a file, which moves.
- **LOW-1 — an hour saved during a move landed in the old project. TAKEN** (the code review's MEDIUM-2): `time_entry_scope_guard` reads the task `FOR KEY SHARE OF wi` — it waits for a move's FOR UPDATE, re-reads, and refuses; it conflicts with no ordinary task edit, and the entry's foreign key takes the same lock a moment later anyway.
- **LOW-2 — a moved task's history named the OLD project's milestones and labels to a reader of the new one. TAKEN.** `readItemActivity` takes the task's project now; milestone names resolve only within it, labels only the workspace's and its own. A moved task's older milestone/label rows read as gone, for every reader — the safe direction.
- **LOW-3 — the stage mapping could cross kinds and skip the approval gate. TAKEN** (the code review's LOW-4). `stageInTarget` matches name and seed only WITHIN the kind; a task lands in another kind only when the target has none of its kind (then `completedAt` is cleared if it leaves Done/Cancelled for an open kind). A live task landing in an approval-gated stage from one that was not asks `work_item:approve` (in sequence), as entering it would. Unit- and dbtest-pinned.
- **LOW-4 — the dialog showed the team's hours without `time:view_team`. TAKEN.** It shows the team's hours with that code, else the reader's own — the board's rule (`spent.ts`); the refusal counts all of them, and says only that colleagues' time is there.
- **NIT — TAKEN:** the re-parent waiver also requires the project to change in the same statement (the second migration); the portal tripwire lists `aliases`, `workItemAlias`, `workItemAliases`; a sentence when the client sees hours on either project ("their totals change, past months included"); a unique violation after the source-key pre-check (an import racing it) is told as `MOVE_SOURCE_TAKEN`.
- **NIT — ACCEPTED:** an old link followed by a reader scoped ONLY to the new project is a 404 — the old project is resolved first, and its existence is not theirs to learn (fails closed). Children are not checked by the database to follow their moved parent within the transaction (only the service writes under the flag; a deferred check is not worth its cost here). `createItem` under a node a concurrent move just took surfaces as `WORK_TREE_PROJECT` (fails closed).

### Code review

- **HIGH-1 — the binned subtask's file. TAKEN** (as security MEDIUM-2).
- **MEDIUM-2 — the hour saved during a move. TAKEN** (as security LOW-1).
- **LOW-3 — the list menus offered Move… without `work_item:edit`. TAKEN:** the backlog's and the board's menus ask create AND edit, as the panel's button.
- **LOW-4 — the stage mapping across kinds. TAKEN** (as security LOW-3).
- **LOW-5 — test gaps. TAKEN:** pA's summary is computed before the move and asserted to lose the hour; `MOVE_SOURCE_TAKEN`, the flag's refusal of a re-parent to another parent and of a top-move without a project change, ranks (bottom, parents first), the hour's audit row, `time:edit_any` and `work_item:approve`. **ACCEPTED:** `MOVE_TOO_BIG` is not exercised (101 tasks over the Neon link for one bound — the copy's and Tasks page's precedent).
- **NIT — TAKEN:** the history row's own glyph (`FolderInputIcon`); the dialog names only live subtasks and live assignees, and says separately how many deleted tasks move too; the Swedish copy (`MOVE_HOURS_BILLED` names the time entries; "flyttade den hit från …"); the needless `Math.min`.
- **NIT — ACCEPTED:** the old-link redirect drops the old surface's filters — they name the OLD project's stages and people, which mean nothing in the new one, and an e-mail's link carries none. A suspended member's assignment is cleared by a move (`mentionableMembers` is ACTIVE-only — copy's and the repeat copier's rule), counted, audited and written to the history.

## 7. The narrow re-checks of the fix rounds (fresh agents, read-only) — dispositions

**First re-check** (of §6's fixes): every fix does what it says; no data-safety regression.
- **LOW — the review round's `FOR KEY SHARE` on EVERY hour write deadlocked an hour EDIT against a move** (the edit holds its hour's row before its guard runs; the move holds the task and then wants the hour). **TAKEN** — a third forward migration, `20261101110000_move_a_task_hour_lock`: the lock is taken only where an hour JOINS a task (an INSERT, or a change of `work_item_id`); an edit that keeps its task is already in the move's set. Its comment corrects 20261101100000's two wrong claims (an unchanged key skips the RI lock; a rank change is a key update — an hour joining a task now queues briefly behind a drag of it, with no cycle).
- **NIT — TAKEN:** the move's WHO and ORDER comments; the board's `onMove` prop docs; the source-key refusal matched BY CONSTRAINT NAME (`guardedMove`, the bin's way) instead of every unique violation; the dialog shows the reader's own hours when it cannot show the team's (`facts.hoursOwn`); the old project's milestone name is now pinned to read as gone after a move (set through `setItemMilestone`, so its history row exists); `hoursShared` is asserted both ways.
- **NIT — ACCEPTED:** the `completedAt` clear on a kind change is unreachable today (every project keeps To do, In progress, Done and Cancelled) — kept as the belt; the new lock has no concurrency test.

**Second re-check** (of the delta above): nothing lost; the edit's deadlock is gone; an hour joining a moving task still waits and is refused.
- **LOW — that refusal reached the member raw. TAKEN:** the time module maps `work item must belong to the entry` to `TARGET_MISMATCH` ("That task is not in the chosen project.").
- **LOW/NIT — the move re-read its hours by id only. TAKEN:** the re-read under the lock also asks `workItemId` in the moved set — an hour put on another task in the gap stays where it is.
- **NIT — TAKEN:** the dialog's own-hours figure counts live hours only (the board's rule).
- **NIT — ACCEPTED:** a few cycles remain that the entry foreign key's own `KEY SHARE` closes (a split's insert, a timer start that stops a running hour, `copyWeek` across two tasks of the tree, an hour moved onto the target's bottom row): Postgres's deadlock detector ends each; a move that loses retries (`MOVE_BUSY` when spent), a time write that loses answers with its error — rare, never wrong.

