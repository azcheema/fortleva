# Slice 126 — a bin for deleted tasks (founder decision C102)

*2026-10-17. The second of the three Basecamp-comparison slices (mentions → a bin for deleted tasks → repeating tasks; C101–C103, asked together, all with the recommendation). This document is the build plan: the settled parts are C102's, and everything marked **(reading)** is the implementing session's choice, named so a reviewer can push on it.*

## 1. What the founder decided

- **(a) In each project.** A "Deleted tasks" page linked at the foot of the project's backlog beside Import, listing that project's tasks deleted in the last 30 days with "Bring back"; and an **Undo** on the "Task deleted" message (UI.md's reversible-action rule — §2 "every toast with an undo path has one", §5.9 "Undo toast where reversible").
- **(b) It comes back private.** A task the client could see returns hidden from the client; sharing it again is a fresh decision.
- **(c) After 30 days it leaves the bin but is kept in the database for now.** Actually erasing old deleted tasks, their comments and attached files is its own later piece.

## 2. What already exists (read, not assumed)

- **The delete** (`deleteItem`, `src/modules/work/items.ts`): `work_item:delete` (C M) + scope; an ANSWERED client request is refused (C29); ONE stamp `deletedAt` for the task, its attached files (`softDeleteDocumentsInTx`, one `document.deleted {reason: "work_item_deleted", workItemId}` each, which also takes the comments on each file and each of its versions — `comment.deleted {reason: "document_deleted", documentId, workItemId}`) and the task's thread (`softDeleteCommentsOn`, `comment.deleted {reason: "work_item_deleted", workItemId}`); live subtasks refuse it (`HAS_CHILDREN`); `work_item.deleted {number, projectId}`. No history row. Nothing else is touched: labels, time, mentions, subscribers, rank and number (tombstones keep both, so a restored task returns to its old place with no collision — `ordering.dbtest.ts`), the stage (a stage removal moves deleted tasks too, so `state_id` stays valid).
- **The stamp is not the undo key, by the code's own word** (`comments/cascade.ts`, `documents/service.ts`): "a timestamp cannot tell this cascade's comments from another delete in the same millisecond, and the per-comment audit row is the record that can." The audit row is indexed `(tenant_id, target_type, target_id)`.
- **The database's restore guards** (`20260911200000_work_tree_guards`): `work_item_restore_guard`, `comment_restore_guard`, `document_restore_guard`, each `BEFORE UPDATE OF deleted_at … WHEN (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL)`. A restore needs a LIVE parent / subject / anchor (share-locked), and a CLIENT_VISIBLE row needs it client-visible; an INTERNAL row is always accepted. The header says a restore is a writer of two rows, so "a future undo must take the project's rank lock first". `db-errors.ts` leaves `RESTORE_*` unmapped "until the undo that does maps them".
- **The downgrade guard** (`BEFORE UPDATE OF visibility`): a CLIENT_VISIBLE → INTERNAL flip is refused while a LIVE child (subtask, comment, attached file) is still client-visible, and it flips the task's history rows to INTERNAL. Dead children neither block nor move.
- **The hand-over CHECK** `work_item_contact_assignee_visible`: a task handed to someone at the client must be CLIENT_VISIBLE — so making one private ends the hand-over in the same statement (`changeItemVisibility`, `makePrivateWithChildren`).
- **C37** (`follow-task.ts`): a client's own comments on a task follow it — lowered by a make-private, raised again by the next share (`raiseClientCommentsWithTask`, which raises every INTERNAL contact-authored comment on the task). A client's comment on a FILE is not raised back (the slice-72 residual).
- **The import's Bring back** (slice 121, `restoreImport`): `work_item:delete` + scope + the project's queue; refuses an archived project; restores only INTERNAL, never-handed-over rows (the undo bins only those), so "Bring back can therefore never publish anything". `work_item.restored {reason: "import_restored"}` exists in the catalog; an undo writes `work_item.deleted {reason: "import_undone", importJobId}`.
- **The partial unique index** `work_item_source_live_key` (one LIVE task per project, source system and source id): restoring an imported task whose card was imported again since would violate it.
- **Callers of the delete**: the backlog row's menu and the board card's menu (`run(() => deleteItemAction(…))`, a plain success toast). No bulk delete, no delete in the item panel.
- **The backlog's foot** (`backlog-table.tsx`): "Show archived" and, for `canCreate && canEdit`, "Import tasks". The layout lights the Backlog tab for `/items` and `/import` (`also`).
- **Copy that C102 (c) makes false**: `STAGE_IN_BIN` ("Fortleva clears them 30 days after they were deleted", twice, both languages — the code itself is gone since slice 126b, C104), `deleteItem`'s doc comment and `schema.prisma`'s `deletedAt` comment ("then hard delete by a later sweep").

## 3. The design

### 3.1 What is in the bin (reading)

The project's tasks whose `deleted_at` is within the last **30 days** (`BIN_DAYS`), **except** those removed by undoing an import **that can still be brought back** — the newest `work_item.deleted` audit row for the task says `reason: "import_undone"` and its `importJobId` is still `UNDONE`. Those come back from the import's own row ("Bring back the tasks"), which restores the whole import at once; listing them here would bury a hand-deleted task under a few hundred imported ones, and a second door for the same rows would split the import's record. *(Narrowed by the pre-apply review, §9: once the import has been brought back, a task its Bring back SKIPPED — a card imported again meanwhile — has no other door, so it IS in the bin.)* Newest first, the **200** most recent (a line says so when there are more).

Each row: the task's key and title, when it was deleted (date and time, the viewer's zone), who deleted it (the audit row's member, "A former member" when the name no longer resolves), and Bring back. A row's Bring back is **drawn disabled with the reason** (the panel never offers a verb the service refuses):

- a subtask whose parent is deleted too: "Bring back {KEY-N} first" — or, when the parent was removed by undoing an import that can still be brought back, "Its parent task was removed by undoing an import…" (§9), or, when the parent left the bin more than 30 days ago, "Its parent task can no longer be brought back";
- the project is archived: "The project is archived".

### 3.2 Who (reading)

*(Widened by the security review, §10: `work_item:view` is asked too.)* The page, its list and Bring back — from the page or from the toast — need **`work_item:delete`** with the project in scope: the code that deleted the task, as the import's Bring back already reads it (AUTHZ.md "Undo and Bring back need `work_item:delete`"). **No new permission code**, so no TEMPLATE_VERSION change. The backlog's foot link is drawn for `caps.canDelete`. Coming back private is a visibility change only in the safe direction, so `work_item:change_visibility` is not asked (as `makePrivateWithChildren`'s files and comments are not asked their own module's codes).

### 3.3 Bring back — the service (`restoreDeletedItem`, `src/modules/work/bin.ts`)

One transaction. **The order, which is THE ONE ORDER's:** the gate and scope → the project's rank queue (`lockProjectRanks`) → the task row `FOR NO KEY UPDATE` (no key column changes), then read again → its files → its comments, each taken by its own UPDATE. Under a bounded lock wait (5 s) with the contention retry (`retryOnContention`, three attempts), a spent retry told as `BIN_BUSY` — the queue can be held by a long bulk edit, and three writers lock the other way round (the portal switch's fan-out, `releaseContactAssignments`, the search-language restamp — all touch dead rows), so a deadlock is possible and is retried.

**Refusals**, in this order, each one a sentence:

| Case | Answer |
|---|---|
| no `work_item:delete` | forbidden (the gate) |
| the task is not in this workspace, or its project is out of the member's scope | `NOT_FOUND` |
| the task is LIVE (a second Undo, another tab, a colleague got there first) | **no write, `changed: false`** — "This task is already back." |
| an Undo whose deletion no longer stands (brought back and deleted again since) | **no write, `superseded: true`** — told as information, never a success: "This deletion was already undone, so nothing was changed. If the task was deleted again since, it's in Deleted tasks." (§9, §10) |
| deleted more than 30 days ago | `BIN_CLOSED` |
| removed by undoing an import that is still UNDONE | `BIN_FROM_IMPORT` — "bring it back from the import's history" |
| the project is archived | `ARCHIVED` |
| its parent is deleted | `BIN_PARENT_DELETED` (the trigger's `RESTORE_PARENT_GONE` maps to the same code — a parent deleted between the read and the write) |
| a task imported from the same card is live in the project | `BIN_SOURCE_TWIN` (the partial index's name maps to the same code) |

**The writes**, parents before children so each restore guard finds its subject live:

1. **The task**: `deleted_at = NULL`, `visibility = INTERNAL`, and — when it was handed to someone at the client — `assignee_contact_id = NULL`, `contact_completed_at = NULL` (the CHECK; `changeItemVisibility`'s 6c rule). The downgrade trigger fires on a CLIENT_VISIBLE → INTERNAL restore and flips the task's history rows to INTERNAL; its children are all still dead, so it refuses nothing.
2. **Its files** — the ones THIS deletion took: attached to the task, `deleted_at` equal to the task's stamp, AND the file's NEWEST `document.deleted` audit row is the cascade's — `metadata.workItemId` = the task and `reason: "work_item_deleted"`. `deleted_at = NULL`, `visibility = INTERNAL`. A pending sign-off is hidden with the file, never withdrawn (make-private's rule). A file deleted by hand before the task was deleted has its own stamp and stays deleted.
3. **Its comments** — the ones THIS deletion took: on the task, on a file restored in step 2, or on one of those files' versions; `deleted_at` equal to the stamp, AND the comment's NEWEST `comment.deleted` audit row is the cascade's — `metadata.workItemId` = the task and `reason` `work_item_deleted` or `document_deleted`. `deleted_at = NULL`, `visibility = INTERNAL` — the client's own words included. **Both keys, deliberately:** the stamp alone could take a comment deleted by hand in the same millisecond — and a hand delete names its task too (`removed_by_author` / `removed_by_member`), so it is the REASON on the newest record that tells them apart (§9, finding 1); the audit row alone could take a comment an EARLIER deletion of the same task took, which was brought back with it and then deleted by hand (its old cascade row still names the task).
4. **History** (when the task was shared — make-private's shape, written after the UPDATE against the post-update row so the activity guard accepts it): the ended hand-over row, the visibility row, one `commentVisibility` row per task comment that came back lowered.
5. **Audit**, ids and flags only: `work_item.restored {number, projectId, reason: "bin" | "undo", madePrivate?, endedContactAssignment?, files, comments}`; one **`document.restored`** per file and one **`comment.restored`** per comment, `{workItemId, projectId, documentId?, madePrivate?}` — every row a deletion recorded gets a row saying it came back. **Two new catalog actions.** No separate `*.visibility_changed` rows: nothing became LESS visible to the client than it was while deleted (a deleted task is shown to no one), so the restore is the event; `madePrivate` says what it did.

Nobody is told (the delete tells nobody either). The search feeds re-index the task, its comments and its files from their triggers (`deleted_at` → NULL takes the upsert branch, with the new visibility). The inbox's rows for the task get their link back (read-time). Time entries were never touched. Mentions were never deleted.

**A client's own comments come back with the task's next share** — `raiseClientCommentsWithTask` raises every INTERNAL contact-authored comment on a task when it is shared, whatever lowered it. Their comments on a FILE stay private until that file is shared and something raises them: the slice-72 residual, unchanged.

### 3.4 The database's belt (the migration — reviewed BEFORE it is applied)

`work_item_restore_guard()` is replaced: **a task restored from deletion must land INTERNAL** (`RESTORE_NOT_PRIVATE`), checked first, before the parent. C102 (b) then holds for every writer, present and future — the import's Bring back and its undo's "reclaim" already restore INTERNAL rows only. Its files and comments need no rule of their own: with the task private, the existing `comment_restore_guard` and `document_restore_guard` already refuse a client-visible one. The old `RESTORE_VISIBILITY` branch of THIS function becomes unreachable (an INTERNAL child is always accepted) and is dropped; the comment and document functions keep theirs.

`RESTORE_NOT_PRIVATE` stays **unmapped** in `db-errors.ts`: the service writes INTERNAL itself, so reaching it is a bug worth seeing raw.

DDL only (a function replaced; the trigger itself is unchanged). No `neon-smoke.yml` dispatch owed. Production: `migrate deploy` before Promote.

### 3.5 Undo on "Task deleted" (reading)

`deleteItem` now returns its one stamp and `deleteItemAction` returns it with the sentence (`DeletedView`). One client hook, `useDeletedToast` (`backlog/deleted-toast.tsx`), shows the toast for the backlog row and the board card: "Task deleted" with **Undo for 30 seconds** (the timer's window; sonner's 4 s default is shorter than a refresh). Undo calls `restoreDeletedItemAction(itemId, projectKey, "undo", deletedAt)` — the same service, `reason: "undo"`, **naming the deletion it undoes** (§9, finding 3) — and toasts its answer: "Task brought back." or, when it was shared, a longer sentence on a 12 s toast saying what sharing it again shows (§9, finding 4). **An Undo is never ignored** (it is not guarded by the delete's pending refresh) and **acts once** (sonner keeps the button mounted through its exit). A refusal is an error toast with the reason (the action-failure rule), and the bin page is where it can be tried again.

### 3.6 The page (`/projects/[key]/deleted`, reading)

Not a tab: reached from the backlog's foot ("Deleted tasks", beside "Import tasks"), with the Backlog tab lit (`also`). A member without `work_item:delete` gets the `forbidden` state. A heading, a back link to the backlog, and one card whose description says the task comes back hidden from the client with its files and comments, and that sharing it again shows the task and the client's own comments while files and replies are shared one by one. Then the table (§3.1) with each row's actions in the pinned actions column (`RowActions`, one item "Bring back", no confirm — it is the safe direction and one click, as the import's Bring back is). Empty: "Nothing was deleted in the last 30 days." After a Bring back the row leaves (a refresh) and the toast offers "Open" to the task. One line per row (the width walk's row-pitch audit).

### 3.7 Copy C102 (c) corrects

`STAGE_IN_BIN` (both namespaces, both languages): "Deleted tasks still belong to this stage, so the last Backlog stage stays. Fortleva keeps deleted tasks for now." — the stage can never be removed while one is there, which C102 (c) makes lasting; recorded, not changed here, and put to the founder (§9, finding 5) — answered C104 and built in slice 126b, which removed the code. Every "30 days, then hard delete" comment the review listed now says the task is kept (§9, finding 8).

### 3.8 Not built

Erasing old deleted tasks (C102 (c)); a workspace-wide bin; bringing back several at once; bringing back a parent together with its deleted subtasks (each comes back on its own, parent first); a bin for deleted files or comments on a live task; Undo by keyboard while a modal layer is open (UI.md §5.4's standing "not yet").

## 4. Tests

- **dbtest** — `src/modules/work/bin.dbtest.ts` (prefix `bin-`, registered in `DBTEST_PREFIXES`): the list (in the window, not an import's, not another project's, not one deleted 31 days ago; who deleted it; a subtask under a deleted parent flagged); bring back an INTERNAL task with the comments and files its deletion took, and NOT a comment or file deleted by hand before; a shared task comes back INTERNAL with its files and comments INTERNAL, a handed-over one loses the hand-over, history rows written, audits written; the client cannot read it afterwards (`readPortalTask` as the contact) and a share raises the contact's own comment again (C37); the search finds it for a member and not for the contact; the refusals (an employee — no code; out of scope; 31 days; an import's undo; the parent deleted; an archived project; a live twin); a second Bring back is `changed: false`; the delete → bring back → delete-a-comment-by-hand → delete → bring back cycle brings back exactly the second deletion's set; the DB belt: a raw restore of a CLIENT_VISIBLE row is refused `RESTORE_NOT_PRIVATE`. `tree-guards.dbtest.ts`: the child-task restore now expects `RESTORE_NOT_PRIVATE`.
- **unit** — `bin-rules.test.ts`: the window, the row's disabled reason.
- **e2e** — `e2e/task-bin.spec.ts`: delete a task from the backlog, Undo in the toast brings it back; delete again, open Deleted tasks from the backlog's foot, Bring back, the task is in the backlog. The board's Undo shares the hook (one board check in the same spec).
- **visual** — one new stop, `project-deleted` (a seeded deleted task in the shared workspace), both walks.

## 5. Docs amended with the build

UI.md (the bin page; the delete's Undo); DATA_MODEL §6.14 (restore and the new guard rule; the 30 days and C102 (c)) and the audit table; AUTHZ.md (`work_item:delete` covers Bring back); the catalog comment; AGENTS.md's stop count; PLAN §0; OPEN_QUESTIONS C102's status.

## 9. The pre-apply review (a fresh agent, read-only, design + migration) — dispositions

**No HIGH, no MEDIUM.** No path found by which a client sees anything a restore brings back (portal reads, `portal_gate` on every table, the three search feeds, history rows, sign-off lists, `portal_enabled` on dead rows); the migration does what its header says, no existing writer restores a non-INTERNAL task, and dropping the guard's `RESTORE_VISIBILITY` branch loses nothing. Applied to dev after the review (`prisma migrate deploy`, 2026-10-17).

1. **LOW — the comment key did not exclude a hand delete** (a hand delete's `comment.deleted` names its task too, `comments.ts`). TAKEN: the NEWEST record must be the cascade's, by reason, for comments and files; a dbtest plants the same-millisecond race and the rule was mutation-checked (removing the reason filter turns it red).
2. **LOW — the import exclusion could strand a task** (one an import's Bring back skipped; a subtask under a parent the undo removed). TAKEN: excluded only while the import is still UNDONE; the parent's case has its own reason. Both in the dbtest.
3. **LOW — Undo was keyed on the task, not its deletion.** TAKEN: the delete returns its stamp, the Undo sends it, a mismatch answers `superseded` and writes nothing (dbtest).
4. **LOW — "share it again" over-promised:** a share brings back the task and the client's own comments only (C37); files and the team's replies to the client are shared one by one, and an unanswered client request comes back hidden from the client who wrote it. TAKEN in the copy (toast and page) — it follows from C102 (b) — and told to the founder.
5. **LOW — the last Backlog stage can never be removed once a task in it was deleted** (C102 (c) keeps deleted tasks). Pre-existing since slice 123; NOT changed here (the stage editor is another slice's reviewed code) — put to the founder with a recommendation. *(Answered C104 with the recommendation and BUILT in slice 126b, 2026-10-17: removing the last Backlog stage moves its deleted tasks to where new tasks start; `STAGE_IN_BIN` is gone.)*
6. **LOW — tests:** history rows the client could read before the delete are unreadable after Bring back; a client's comment on a FILE stays private after a re-share; the same-millisecond case. TAKEN, all three.
7. **NIT — lock wording** (`FOR NO KEY UPDATE`, three attempts). TAKEN in §3.3.
8. **NIT — docs:** `rank-lock.ts`' ledger names the restore; `follow-task.ts`' list of lowering paths gains the restore; every "30 days, then hard delete" comment amended. TAKEN.

## 10. The slice reviews (fresh agents, read-only) — dispositions

**Security review** — no HIGH, no MEDIUM, no LOW; no path by which a contact reads anything a restore brings back, no cross-tenant path, no existence oracle (another tenant's id and an out-of-scope id answer alike, `NOT_FOUND`). Three NITs, all TAKEN: (1) the bin's page and verb also ask `work_item:view` (`requireBinCodes`), so a custom role holding only the delete code reads no titles it could not list live; (2) an Undo must name its deletion — the action refuses `via: "undo"` without the stamp; (3) SECURITY.md §7 records that `work_item.deleted`, `document.deleted` and `comment.deleted` rows must outlive the bin's 30 days (pruning sooner fails closed, except that an import's undone task would show in the bin).

**Code review** — one MEDIUM, four LOW, four NIT.
1. **MEDIUM — the bin table broke UI.md §10.12**: no pinned actions column, no column priorities, `max-w` cells (a MINIMUM in Chromium) — the visual walk would have failed `project-deleted` and a phone had to scroll to Bring back. TAKEN: actions pinned, "Deleted" medium and "By" low priority, the title in the contained wrapper (`contain-inline-size`, `min-w-56`); the stop's comment corrected (earlier specs delete tasks in the shared project, so the page holds more than the seeded row; not volatile — the contained title keeps rows from widening it). The local walk cannot be run for one stop (it times out); CI's walk is the check.
2. **LOW — a task with a live twin was not drawn disabled.** TAKEN: `has_twin` in the list, a `source_twin` block and sentence; the dbtest asserts the row.
3. **LOW — a superseded Undo was a green success with a sentence implying the task was back.** TAKEN: `toast.info`, and the sentence says it may be in Deleted tasks.
4. **LOW — the employee's refusal could not fail if the code check were removed** (the employee had no scope, so the scope refused). TAKEN: the employee now reaches acme and the test asserts `authz:FORBIDDEN`.
5. **LOW — `schema.prisma` still said "then hard delete".** TAKEN.
6. **NIT — `useRun`'s comment named delete as a `FormResult`.** TAKEN.
7. **NIT — a hand-written row lock instead of `lockItemRow`.** TAKEN.
8. **NIT — the action does not check the task belongs to `projectKey`'s project.** ACCEPTED: the service gates and scopes on the task's own project; only the revalidated paths would be another project's.
9. **NIT — the board's delete caught a redirect as "Something went wrong".** TAKEN: a redirect passes through, as in the toast and the bin table.

**Narrow review of the fix round** (one fresh agent) — no HIGH, MEDIUM or LOW; every fix does what it says, the table's widths worked through at every rung in both languages (overflow 0, one-line rows), the stop sound as not volatile. Three NITs, all TAKEN: the docs named the view code and the twin reason late (AUTHZ.md, UI.md §5.9, §3.2/§3.3 here); the "Deleted" and "By" columns get fixed widths so the spare width goes to the title, which carries its full text as a `title`, and the table its own scroll label; and the backlog's shared `useRun` now lets a redirect pass too (it had turned one into a "failed" toast for every row verb, before this slice). The rounds converged on cosmetic items; no further round run.

