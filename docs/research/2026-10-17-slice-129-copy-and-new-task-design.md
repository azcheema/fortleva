# Slice 129 — copy a task, and a fuller "New task" (founder decision C106)

*2026-10-17. The founder picked both on "suggest me more features". (a) and (b) were AGAINST the recommendation, and (c) was WITH it. Settled parts are C106's. Everything marked **(reading)** is the implementing session's choice, named so a reviewer can push on it.*

## 1. What the founder decided

- **(a) Let me tick what to copy each time.** A small dialog with checkboxes: description, subtasks, labels, the person, the dates.
- **(b) I pick the project.** "Copy to…" asks which project, with the current one chosen. Labels that belong only to the old project are left off.
- **(c) A button and a fuller form.** A "New task" button at the top of every project page opens the add box with the project already chosen. In that box the person, due date, priority and description can be set before saving.
- **Mine, stated and theirs to overturn:** a copy always starts **hidden from the client** (C103 (f)'s rule for a repeat's copy).

## 2. What already exists (read, not assumed)

- **`createItem`** (`items.ts`):
  - takes a title only and lands in the default state at the bottom;
  - follows the visibility-at-birth rules (C38/C39);
  - writes the `created` history row and audits `work_item.created`.
- **The global `C` dialog** (`quick-create.tsx`) is title-only:
  - Enter = create and start the next;
  - ⌘⇧Enter = create the next keeping the pick;
  - ⌘Enter = create and open.
  - The project comes from the route, or from a picker.
  - It has no button: a mouse user could not see how to save.
- **A project page has no create control** except on its Backlog (the add row at the foot of the list) and Board (the column "+").
- **The repeat copier** (`repeat-copies.ts`, slice 127) already copies a task with its subtree:
  - `copyableSubtree`, the template rule;
  - descriptions within a 2 MiB budget, measured in SQL (`descriptionBytes`), unticked (`untickChecklists`);
  - assignees kept only if `mentionableMembers` says they can still take the task;
  - written a level at a time;
  - a lock order: counter → rank queue → bottom row FOR UPDATE → parent SHARE → source SHARE.
- **`textBlocks`** (`import/description-doc.ts`, slice 121) turns plain text into ProseMirror blocks on the SERVER. It handles paragraphs, `#` headings, lists, `- [ ]` checklists and links, and is safe against quadratic regex. `normalizeDescription` is the one gate.

## 3. The design

### 3.1 New task (C106 (c))

**The button.** `projects/[key]/layout.tsx` draws a **New task** button (`PlusIcon`) in the header's actions on every tab. It is shown when:
- the member holds `work_item:create` on all four gates (`hasAccess`), and
- the project is not archived.

It dispatches a window event the shell's `QuickCreate` listens for, so there is **one** create dialog, not two. The dialog takes the project from the route, as `C` does. **(reading)**

**The form.** The same dialog gains, under the title:
- **Description** — a plain text box. It becomes a document on the server through `textBlocks` → `normalizeDescription`. The browser never sends a document, which also sidesteps the ProseMirror-across-actions trap.
- **Person**, **Due date** and **Priority** — the panel's own pickers (`PropertyPicker`, `CalendarGrid` and the due tokens), holding a local value instead of committing.

These are offered only to a member who also holds **`work_item:edit`**. The service asks for that code whenever any of them is set: setting fields is editing, and `setItemRepeat` set the precedent of edit + create. **(reading)**

The person list is the panel's: ACTIVE members (`activeMembers`). The service accepts any ACTIVE member, which is `assignItem`'s rule.

**Saving:**
- A **Create task** button creates the task and closes the dialog.
- **Enter** in the title creates it and starts the next. Rule 2's "next" starts fresh: the person, date, priority, description and visibility all reset.
- **⌘⇧Enter** creates the next keeping the person, date, priority and visibility.
- **⌘Enter** creates the task and opens it.
- In the description box, Enter is a new line and ⌘Enter is the same create and open.

**Written.** The task is born with the fields, in the one `createItem` transaction. Alongside it:
- one `assignee` history row (forced INTERNAL) when someone is assigned, plus the usual `created` row;
- the assignee is told (`work_item.assigned`; `emit` drops the actor themself);
- the audit row `work_item.created` gains `fields: [...]`, the names of the fields set at birth and never their values.

### 3.2 Copy (C106 (a), (b))

**Where.** "Copy…" appears in the task panel's header (peek and full page, beside "Open full page"), in the backlog row's ⋯ menu and in the board card's ⋯ menu. It is shown when the member holds `work_item:create` and `work_item:edit`.

**The dialog** (`copy-task-dialog.tsx`). On open it reads the source (`copySourceAction`) and the project list (the quick-create list: scoped, `project:view`, not archived). It shows:
- **Title**, filled in with the original's and editable.
- **Project**, a native select with the current project chosen.
- **Bring along:**
  - **Description** — shown when there is one;
  - **Subtasks (N)** — shown when there are any. Disabled, with a reason, past 100 tasks or 2 MiB of descriptions;
  - **Labels (N)**;
  - **Person (name)**;
  - **Dates** — start and due, shown when either is set.

  All are ticked except **Dates**, which usually need changing. **(reading)** Under them: "The copy starts hidden from the client. Comments, files and time stay with the original."
- **Copy task** — copies, closes the dialog, says "Copied as KEY-N", and opens the copy:
  - in the same project's peek when the dialog was opened from the backlog or the board and the copy is in that project;
  - its full page otherwise.

**What always comes:** the title (as typed), the type (a SUBTASK copied to another project becomes a TASK), the kind (a client's REQUEST becomes a TASK — it is no longer the client's ask), the priority and the estimate.

**What never comes:** visibility (always INTERNAL, written out), comments, files, time, history, followers, a contact hand-over, the milestone, the stage (the copy starts where new tasks start) and any repeat.

**Where it lands:** at the bottom of the chosen project. In the same project, a subtask's copy goes under the same parent — locked FOR SHARE and read live, else `NOT_FOUND`. In another project it is a top-level task. **(reading)**

**Subtasks** use `copyableSubtree`, the template rule: no deleted ones, no Cancelled or Triage, no client requests; archived ones are taken. Unlike a repeat, a subtask that is itself part of a repeat series IS copied, as a plain task, because the member ticked "Subtasks" and a missing one would be a silent drop. They are bounded like a repeat — at most 100, descriptions together at most 2 MiB — and past either the copy is refused `COPY_TOO_BIG`, never cut short.

**What each ticked part does:**
- **Description:** every copied row keeps its description with the checkboxes unticked (a copy is new work, the templates' and repeats' rule).
- **Labels:** each row keeps its workspace-wide labels and, in the same project, the project's own. Labels belonging only to another project are left off and counted.
- **Person:** each row keeps its member assignee when that member can take tasks in the target project (`mentionableMembers`); otherwise it is unassigned and counted. A contact assignee is never copied.
- **Dates:** each row keeps its start and due dates.

**Who:**
- `work_item:view` + `work_item:create` + `work_item:edit` (in sequence, never a batch leg; view because the copy and its dialog read the task — the security review's L-2);
- the SOURCE's project in scope;
- the TARGET project in scope and not archived — the projects `createItem` creates in, which the dialog's list (`listProjects`) offers; a paused or finished project included.
- The source is not deleted.

**Lock order:** the copier's, on the TARGET project — stage seed → counter → rank queue → bottom row FOR UPDATE → (same project) the parent FOR SHARE → the source FOR SHARE. The subtree is read, not locked, as the copier does.

A source in ANOTHER project is share-locked while the target's queue is held. No ordinary writer closes a cycle with that: none moves a task between projects, and every queued writer takes its own project's queue before any row. **Corrected by both reviews:** two cross-project copies in OPPOSITE directions can. A→B holds B's bottom row and wants its source in A; B→A holds A's bottom row and wants its source in B. When each source IS the other's bottom row, that is a cycle. Postgres ends it, `retryOnContention` runs the loser again, and three losses say `COPY_BUSY`: a retry, never a hang. This is accepted rather than ordered away, because taking both projects' queues in id order would serialise every copy against every create in both. The transaction has 30 s and a 5 s lock wait.

The subtree is read, not locked, so the reads after the measure filter deleted rows again (a subtask deleted meanwhile is skipped, with its own subtasks), and the descriptions are weighed as they are read, so one grown meanwhile cannot carry the copy past the budget (the security review's NIT-2).

**Written:**
- each row's `created` history row;
- on the copy, `copiedFrom` with `oldRef` the source's id;
- on the source, `copiedTo` with `newRef` the copy's id.

All of these are forced INTERNAL, because a copy must never reach a shared task's history. The panel resolves a ref to its CURRENT key only for a task of the same project, and otherwise says "another project". A reader of one project never learns another project's key from a history row (the security review's L-1; the first cut stored `KEY-N` text, which also went stale on a key change). The audit row `work_item.created` for each row carries:
- on the copy: `copiedFromId`, `brought: [...]`, and `labelsLeftOff` / `assigneesLeftOff` when non-zero;
- on a copied subtask: `copyOf`.

Each assignee other than the actor is told once per copy, about the first task they hold in it. There is no new audit action and no migration.

## 4. Review dispositions

Two fresh, read-only agents reviewed the slice: code and security. Neither found a HIGH or MEDIUM.

**Security.**
- **L-1, another project's key in history.** Taken: refs, resolved for the same project only (above).
- **L-2, the dialog's read never asked `work_item:view`.** Taken: the read and the copy both ask it.
- **L-3, the description parsed before any gate.** Taken: `createItem` takes the TEXT and parses it after create and edit were asked.
- **L-4, the form's person is ACTIVE-only while the copy's is `mentionableMembers`.** Kept, deliberately. The form offers the panel's list, and `assignItem`'s rule is documented in AUTHZ. Stated there.
- **NIT-1, opposite copies can deadlock.** Taken: the docblock and this design now say so.
- **NIT-2, unlocked subtree reads.** Taken: deleted rows are filtered again, and descriptions are weighed as read.

**Code.**
- **L-1, an archived source project defaulted the select to an unrelated project.** Taken: "Choose a project…" and no default.
- **L-2, a copy answered after close still navigated and closed a later dialog.** Taken: a mounted guard, and a toast only.
- **L-3, the deadlock claim.** Taken, as security's NIT-1.
- **L-4, Subtasks not refused past the description budget.** Taken: `descriptionsTooBig`. Subtasks starts unticked, with a line while both are ticked.
- **L-5, parse before the gate.** Taken, as security's L-3.
- **L-6, a redirect read as a failure in the dialog's reads.** Taken.
- **L-7, focus not on the title after load.** Taken.
- **L-8, missing tests.** Taken in part. The dbtest now covers shared subtasks born private, a client request made a task, a repeat-series subtask copied, the description-budget refusal, the view code, and the history refs within and across projects. The e2e now covers the backlog menu's Copy… and Enter versus ⌘⇧Enter. `COPY_BUSY` is not forced in a test, since it needs two transactions racing on Neon; the shape is the bin's.
- **NITs.**
  - The over-100 label: taken.
  - The misplaced docblock: taken.
  - Stale text in UI.md and `createItemAnywhereAction`: taken.
  - A stale key after a rename: fixed by the refs.
  - "Ansvarig" in Swedish and "Assignee" in English: taken.
  - One message for every parse failure: kept. The form's bounds make the other failures unreachable.
  - Three transactions per open: kept. They run once per opening, before any typing.

**A narrow re-check of the fixes** (one fresh agent): no HIGH or MEDIUM.
- **LOW, taken.** The copy-key lookup sat inside `readItemActivity`, which is one leg of `getItemDetail`'s `Promise.all`: two more statements on the batch's one connection, the standing trap. It is now its own step, `nameCopyRefs`, called by `getItemDetail` after the batch, in sequence, given the project the panel already holds. The dbtest now also reads through `getItemDetail`.
- **NIT, taken.** The description weigh counted UTF-16 units; it now counts UTF-8 bytes, as the measure and the gate do.
- **NIT, taken.** The Assignee hint rendered an empty key before a project was chosen.
- **NIT, taken.** A stale docblock on `readCopySource`.

The rounds converged, so no further round was run.

## 5. Gates and tests

- **dbtests:** `copy.dbtest.ts` (prefix `cpy-`, registered in `DBTEST_PREFIXES`), and `createItem`'s fields in the same file.
- **Unit:** the history sentences, the description text, and the copy's navigation href.
- **e2e:** `copy-and-new-task.spec.ts`.
