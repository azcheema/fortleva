# Slice 124 — project templates (founder decision C100)

*2026-10-15 (the file name says 10-16 by a slip; the applied migration names this path, so it stays). Decided under C98 (f) → C100 (a) and (b), both with the recommendation. This document is the build plan: the settled parts are C100's, and the rest are the implementing session's choices, named as such so a reviewer can push on them.*

## 1. What the founder decided

- **(a) Tasks + milestones.** A template brings every task with its description, checklist, labels, estimate, subtasks and starting stage, plus the project's milestones. Due dates are counted from the new project's start ("start + 14 days").
- **(b) Made by saving a project.** "Save as template" sits on a project. Settings → Templates lists the templates for renaming and deleting. To change a template's tasks, change a project and save it again. There is no template editor in Settings.

## 2. What already exists (read, not assumed)

- **`project_template`** (§6.14, migration `20260820170000`) has `id, tenant_id, name, description?, locale?, definition jsonb, created_by_member_id?, created_at, updated_at`, and is unique on `(tenant_id, name)`, case-sensitively.
  - It is class A (`tenant_isolation` + `portal_deny`), granted to `app_runtime`, and registered in `MODEL_CLASSES` / `RLS_CLASSES.A`.
  - **Nothing reads or writes it.** `seed-cli` only deletes it on teardown.
- **The code `project_template:manage`** already exists ("Create/edit/delete ProjectTemplates; save project as template"; owner, manager, admin; module `work`). **The audit action `project_template.applied`** exists too.
- **A task's checklist lives inside its description**: `taskList`/`taskItem` nodes, with `checklist_total`/`checklist_done` derived by `normalizeDescription`. A description holds StarterKit + checklists only (no images, no mentions, no files), so copying one carries no reference to another client's files.
- **Stages** (slice 123):
  - Each project has its own `workflow_state` rows.
  - `ensureProjectStates` copies the workspace default (`workflow_preset 'default'`, an ordered `PresetStage[]`, parsed and checked on every read) into a project on its first work read.
- **Labels** are all workspace-wide (`project_id` NULL); nothing makes a project label.
- **A milestone** is `{name, description?, status, dueAt timestamptz (UTC midnight of the chosen day), rank, visibility}`. It is written under `project:manage_versions`, queued on `milestone_rank:<projectId>`, and audited `milestone.created`.
- **`createProject`** (`src/projects/service.ts`, core) is `project:create` with the client directly in scope. The forms:
  - `/projects`: client · key · name.
  - A client's Projects tab: key · name.
- **The import's batch create** (`modules/work/import/service.ts`, slice 121) is the set-based precedent:
  - THE ONE ORDER: stage key → counter → rank queue → rows.
  - One `nextCounters`, one `createMany` of tasks, of labels, of history rows (`writeActivityMany`), and of audits (`recordMany`).

## 3. What a template holds (version 1)

ONE JSON document, written only by Fortleva and **parsed with zod on every read, never trusted** (the workflow preset's rule). A row that fails to parse cannot be used: applying it is refused with `TEMPLATE_INVALID`. The picker still lists it, because it reads only the count columns and never a document. Saving parses its own output before it writes, so the only way such a row can exist is by hand.

```
{ v: 1,
  stages:     [{ key, name|null, seedKey|null, category, isDefault, requiresApproval }],   // PresetStage, no Triage
  milestones: [{ key, name, description|null, dueDay|null }],                             // in rank order
  labels:     [{ key, id, name, color|null }],
  tasks:      [{ key, parent|null, type, kind, title, description|null, estimateMinutes|null,
                 stage, milestone|null, labels: [key], startDay|null, targetDay|null }] }  // parents first, then rank order
```

- **Keys** are short strings (`s0`, `m0`, `l0`, `t0`, …). Every reference must name a key that exists:
  - a task's `stage` is a stage that may be started in (§4.3);
  - a task's `parent` is an EARLIER task of a strictly higher level (Epic > Task > Subtask), at most two levels deep, which matches `parent_guard`.
- **`…Day`** is a whole number of days from the anchor (§4.4), within ±3 650.
- **Limits** (`modules/work/templates/definition.ts`): 1 000 tasks, 100 milestones, 500 labels, and **3 MiB** for the whole document as `JSON.stringify` writes it. A bigger project is refused (`TEMPLATE_TOO_LARGE`), with a sentence that says so. The database holds **4 MiB** in jsonb's own text form (CHECK, §7). jsonb prints a space after every `:` and `,`, so the same document is up to about a fifth longer there; the gap is that margin. The service refuses first; the CHECK is the belt.

## 4. Saving a project as a template

**Where:** a **"Template" card** in the right-hand column of the project's Overview, under Status, with one sentence and a **Save as template…** button. It is shown to holders of `project_template:manage`, the code the action asks. The button opens a dialog that holds:
- **Name**, prefilled with the project's name.
- One line saying what comes along: "24 tasks, 3 milestones and the board's stages".
- When the name matches an existing template (ignoring case), a line "A template called “Website” already exists. Saving replaces it." The button then reads **Replace template**.
- An empty project (no task and no milestone to take) shows a sentence instead of the button.

The service, `saveProjectAsTemplate(ctx, {projectId, name, replace})`:
- **Gates:** `requireAccess(project_template:manage)` → `assertInScope({projectId})`. An archived project may be saved: a finished project is the most natural template.
- **Reads** (sequential, never a `Promise.all` leg):
  - the project's stages (`ensureProjectStates` first, before anything else is locked);
  - its milestones;
  - its tasks, without the description column;
  - their labels;
  - and then the descriptions of the tasks that are taken.
- **Which tasks** (the implementing session's choice, from (a)'s "every task"):
  - **Taken:** every live task.
  - **Left out:**
    - a deleted or archived task;
    - a client's request (`kind = REQUEST`): those are the client's own words;
    - a task in Triage or Cancelled;
    - a task whose parent is left out, together with its own subtasks.
- **Its starting stage:** a task in a Backlog or To do stage that needs no approval keeps that stage. Any other task starts where the project's new tasks start: one in progress, done, or in a stage that needs approval. A template is the beginning of a project, so a finished project gives a fresh one.
- **Checklists come back unticked:** every `taskItem.checked` is set to false, and the description passes `normalizeDescription` again.
- **The anchor for dates** is the project's start date. If it has none, the anchor is the day it was created, in the workspace's zone. The dialog names the anchor: "Dates are counted from 3 March 2026, this project's start."
  - **Tasks:** `startDay`/`targetDay` = the task's date minus the anchor, in days.
  - **Milestones:** `dueDay` the same way, from `dueAt`'s UTC day.
- **Milestones:** every milestone except a cancelled one. On a new project each one starts Planned and private.
- **Labels:** each label's id, name and colour at the moment of saving.
- **Not taken:**
  - assignees, priority, comments, files, time and history;
  - the client, and the project's own settings (portal, rates, update cadence);
  - visibility: everything in a new project starts private.
- **Name rules:** trimmed, one line, no control characters, 1–80 characters. Unique in the workspace ignoring case, decided by the database's `lower()` (§6), never by JavaScript's.
- **Replace:**
  - **Name taken, `replace` false:** `TEMPLATE_NAME_TAKEN`. Someone saved that name meanwhile; the dialog says so, and the member can choose to replace.
  - **Name taken, `replace` true:** the row is locked `FOR UPDATE` and its `definition` and `source_project_id` are overwritten. Its name keeps its stored spelling.
  - **`replace` true and no row:** a new template is created.
- **Audit:** `project_template.created` or `project_template.replaced`, with `{name, projectId, tasks, milestones}`.

## 5. Settings → Templates

**Page:** `/settings/templates`, on `project_template:manage`, with a nav entry under Settings on the same code (between Labels and Rates). It holds a table:
- **Name:** an `InlineEdit` in its own `AutoForm`; the labels page's pattern.
- **Tasks** and **Milestones:** counts read in SQL with `jsonb_array_length`, never by loading the JSON into the page.
- **Saved:** the date, plus "from KEY" linking to the source project when it still exists and is in the member's scope. When it is not, the column shows only the date.
- **Row menu:** **Delete**, danger-toned, asking "Delete the template “Website”? Projects already made from it keep their tasks."

Empty state: "No templates yet. Open a project and choose Save as template on its Overview."

- **Rename:** the name rules above; `TEMPLATE_NAME_TAKEN`. Audited `project_template.renamed {from, to}`.
- **Delete:** a hard delete. Nothing points at a template, and a project made from one keeps no link to it. Audited `project_template.deleted {name}`.

## 6. Using a template: New project

**The forms.** Both create forms gain a **Template** select ("No template", then each template as "Website (24 tasks)"). It offers exactly the templates applying would let this member use: `project:create`, `work_item:create` and `work_item:edit`, plus `project:manage_versions` for a template with milestones. Choosing a template shows a **Start date** field (`type=date`), which defaults to today in the workspace's zone; it is required while a template is chosen. The toast then says "Project WEB2 created with 24 tasks and 3 milestones."

**The service:** `createProjectFromTemplate(ctx, {clientId, key, name, templateId, startDate})` in the WORK module, which imports core's `insertProject(tx, ctx, input)`. That keeps ARC-16's direction: work → core, never core → work. The whole project is ONE transaction, with a 60 s budget (the import's):

1. **Gates, in sequence:**
   - `project:create`, then the client directly in scope and not archived (the existing body, now `insertProject`);
   - `work_item:create`, then `work_item:edit`, as the import asks: a template makes tasks AND sets their stage, labels, estimate and dates;
   - `project:manage_versions`, only when the template has milestones.
   - Owners and managers hold them all. **No new permission code**, so there is **no `TEMPLATE_VERSION` change**.
2. **The template:** read, parsed and checked (§3). It must still exist: a template deleted meanwhile is `NOT_FOUND`.
3. **The project row:** `start_date` = the given day, and `project.created` is audited as today.
4. **Stages, THE ONE ORDER's first key:** `lockProjectStages`, then the template's stages and Triage as one `createMany`. They are re-checked with `parsePreset` and `namesDistinctToDb`, the preset's own gates. **The template's stages REPLACE the workspace default for this project**: the stage a task starts in must exist, and a project's stages are what the source project was saved with. `ensureProjectStates` is never reached, because the project already has states.
5. **Milestones:** the `milestone_rank:` key (a new project, uncontended), then ranks `ranksBetween(null, null, n)` and one `createMany`. Each is `PLANNED` and `INTERNAL`, with `due_at` = start + `dueDay` at UTC midnight. `milestone.created` is audited for each, with `recordMany`.
6. **Labels:**
   - Each template label resolves to the workspace label with its **id** if that still exists. Otherwise it resolves to the one with its **name**, by Postgres `lower()`.
   - Otherwise, for a member holding `label:manage`, it is **made again** with its colour, sorted and with `skipDuplicates`, the import's rule, and audited `label.created`.
   - Otherwise it is left off.
7. **Tasks:**
   - **Locks and numbers:** `lockCounter` → `nextCounters(n)` → `lockProjectRanks` → `ranksBetween(null, null, n)`, in the template's order: parents first, then rank.
   - **Inserts:** one `createMany` per LEVEL (depth 0, then 1, then 2), so `parent_guard` always finds the parent committed in the statement before. Each row has:
     - `type` and `kind` (TASK or BUG);
     - the title, plus a description that passes `normalizeDescription` HERE (never trusted), with `checklist_done = 0`;
     - `estimate_minutes`;
     - `start_date`/`target_date` = start + the day offsets;
     - the stage and its category, with no stamps, since a starting stage is Backlog or To do;
     - the milestone;
     - `visibility = INTERNAL`, written out;
     - `source = IN_APP` (a new enum value would be an `ALTER TYPE` for a column nothing reads);
     - `created_by_member_id`.
   - **Labels:** the label joins in one `createMany`.
   - **History and audit:** a `created` history row for each task (`forceInternal`), plus the birth row into a non-default stage, as the import writes. `work_item.created` is audited for each task with `templateId`, and `work_item.state_changed` for a birth outside the default, with `recordMany`.
8. **`project_template.applied`** `{templateId, name, projectId, tasks, milestones}`.

**Nobody is told.** No task has an assignee, so no notification is due. The search feed follows the rows through its triggers.

**A stage a task names that needs approval**, or that is not Backlog or To do, is refused at parse (`TEMPLATE_INVALID`). Saving never writes one; a tampered row is not trusted.

## 7. The migration (small; a fresh agent reviews it BEFORE it is applied)

`20261028090000_project_templates`, DDL only:

1. **The table lock first** (`ACCESS EXCLUSIVE`, `lock_timeout 10s`), then guards under `row_security = off`, refusing to run if an existing row breaks a rule below. None exists, because nothing has ever written the table.
2. **`project_template_name_ok`:** `CHECK (btrim(name) <> '' AND name !~ '[[:cntrl:]]' AND char_length(name) <= 80)`.
3. **`project_template_name_ci_key`:** a UNIQUE on `(tenant_id, lower(name))`.
4. **`project_template_definition_object`:** `CHECK (jsonb_typeof(definition) = 'object')`. **`project_template_definition_size`:** `CHECK (octet_length(definition::text) <= 4194304)`. These are two CHECKs so that only the size maps to `TEMPLATE_TOO_LARGE`.
5. **`task_count` / `milestone_count`** (int, NOT NULL, CHECK 0–1 000 / 0–100): the document's list lengths, written with it, so the New project form and Settings never read a document.
6. **`saved_at`** (timestamptz): when the document was last written, made or replaced. A rename does not move it, unlike `updated_at`.
7. **`source_project_id text NULL`:** attribution, no FK (the project may be deleted; the template stays). Prisma: `sourceProjectId String? @map("source_project_id")`.

There is no new table and no RLS change. **It carries a migration**, so production needs `migrate deploy` before Promote.

**New audit actions:** `project_template.created`, `.replaced`, `.renamed`, `.deleted` (all TENANT).

**New domain errors:** `TEMPLATE_NAME_TAKEN`, `TEMPLATE_TOO_LARGE`, `TEMPLATE_EMPTY` (nothing to save), `TEMPLATE_INVALID` (a stored definition that does not parse).

## 7b. The migration's pre-apply review (a fresh agent) — dispositions

- **No HIGH or MEDIUM.**
- **LOW, the size comments:** the comments said the 4 MB CHECK was the service's own cap. Fixed before apply: the service measures 3 MiB with `JSON.stringify`, and the database 4 MiB in jsonb text. The CHECK is split so only `_size` maps to `TEMPLATE_TOO_LARGE`.
- **LOW, both unique indexes:** both are mapped to `TEMPLATE_NAME_TAKEN`. Replace looks up by `lower(name)`, never by Prisma's exact unique or an upsert.
- **LOW, scope:** a template carries one client's task titles into a project for another. The default seeds are safe: `project:create` is owner and manager, and both see every client. A custom role with `project:create` but a narrow scope could still read another client's task list by applying a template. **Accepted, and said plainly in the Save dialog:** "Anyone who can create projects in this workspace can use it." Saving is the act that publishes the task list to the workspace, and only `project_template:manage` holders can do it.
- **NIT, read cost:** taken. `task_count` / `milestone_count` columns, so no list reads a document.
- **NIT, "saved" date:** taken. `saved_at`, which a rename does not move.
- **NIT, trimmed:** taken. The name CHECK adds `name = btrim(name)`.
- **NIT, a rename re-checks the document's size:** accepted. One CHECK per rename.

## 8. Tests

- **Unit** (`template-rules.test.ts`):
  - the definition schema (keys resolve, parent levels, depth, the starting-stage rule, the limits);
  - the checklist reset;
  - the day arithmetic across a month and a DST change (UTC days, so none);
  - which tasks are taken.
- **dbtest** `templates.dbtest.ts`, with its own prefix `tpl-` registered in `DBTEST_PREFIXES`:
  - **Save:** stages, milestones, labels, the tree, the dates and the reset checklist all arrive in the definition. Left out: requests, cancelled and archived tasks, and a cancelled parent's subtree.
  - **Apply:**
    - the new project has the template's stages, milestones (INTERNAL, PLANNED, dates moved) and tasks (INTERNAL, numbered 1…n, ranks in order, parents and depths right, labels and estimates kept, checklist unticked);
    - the audits are written;
    - a label deleted since the save is made again for an owner and left off for a member without `label:manage`.
  - **Refusals:**
    - replace refused without `replace`;
    - a name alike ignoring case refused by the index;
    - rename and delete audited;
    - an employee refused at save;
    - a tampered definition refused at apply;
    - the size CHECK.
- **e2e** `templates.spec.ts`: save a project as a template, rename it in Settings, create a project from it, and the new board shows the tasks.
- **Visual stops:** `settings-templates`, plus the Overview's card in the existing `project-overview` stop.

## 9. What the build changed (record)

- **Two count columns and `saved_at`** (the migration review's NITs, §7b), so no list reads a document and a rename never moves "saved".
- **`insertProject`** (`src/projects/service.ts`) is `createProject`'s body inside the caller's transaction. The work module calls core, never the reverse.
- **The shared e2e workspace gets one template at provision** ("Webbplats – standard", saved from the shared project through the real service), so the `settings-templates` stop photographs a row and `/projects` its Template field. `templates.spec.ts` works in the second workspace, with its own `template-source` and `clear-templates` fixtures.
- **The dates:** this document's file name says 2026-10-16 by a slip; the work is of 2026-10-15. The applied migration names the path, so it stays.

## 10. The slice review (two fresh agents, code + security) — dispositions

**Security: no HIGH, no MEDIUM.** Code: one MEDIUM, no HIGH.

- **MEDIUM (code) / LOW (security), the same finding: saving never checked its own output.** A milestone name past the schema's 200, more than 100 milestones or more than 500 labels was either an unmapped CHECK error or a template saved that could never be applied. **Fixed:**
  - Milestone bounds are widened to 2 000 / 100 000, since nothing upstream bounds them and the document cap governs.
  - Saving refuses more than 100 milestones, more than 500 labels, or an over-long milestone as `TEMPLATE_TOO_LARGE`. The sentence now names all three caps.
  - Saving then runs `parseDefinition` on what it built, and refuses as `TEMPLATE_INVALID` if it fails.
  - `project_template_counts_range` is mapped.
  - The dialog's "too large" also counts milestones.
  - A dbtest saves a project with 101 milestones.
- **LOW (both), the picker offered templates the create would refuse.** **Fixed:** it asks `work_item:edit` too, and offers a template with milestones only to a `project:manage_versions` holder.
- **LOW (code), the picker's reset listener was registered once,** on mount, when the client tab can mount it with no select. **Fixed:** it is keyed on whether the select exists. The reviewer confirmed React 19's automatic reset fires the native `reset` event.
- **LOW (code), the dialog's fold could disagree with Postgres's** (a Turkish browser's `toLocaleLowerCase`). **Fixed:** plain `toLowerCase`, and a `TEMPLATE_NAME_TAKEN` refusal now tells the dialog (`nameTaken`), which then offers Replace whatever its own fold says.
- **LOW (code), label creation could deadlock** with another apply or an import making case-variant names. **Fixed:** new labels are sorted by the folded name, and the whole apply retries a deadlock (`retryOnDeadlock`).
- **LOW (security), the dialog did not say descriptions travel.** **Fixed:** "Descriptions come along word for word, so read them before you share a task with a client." The accepted scope LOW (§7b) stands, and the reviewer agreed.
- **NIT (security), saving did not ask the task view.** **Taken:** `work_item:view` is asked after the manage code.
- **NIT (security), applying seeds the template's stages without `workflow:manage`.** **Accepted, deliberately.** The stage set was chosen by whoever saved the template (`project_template:manage`, owners, managers and admins), and making a project is not editing a workflow. The default holders of `project:create` hold `workflow:manage` anyway.
- **NIT (security), no dbtest pinned scope.** **Taken:** a custom "Template keeper" with the manage code and no reach cannot save a project out of scope, and Settings never names the source to them.
- **NIT (security), a task's labels were unbounded.** **Taken:** 50 per task in a template (`TEMPLATE_MAX_TASK_LABELS`), the first 50 in the labels' order.
- **NIT (code), label keys followed the read order.** **Taken:** labels are read in name order, and a task's own keys follow that order.
- **NIT (code), a test case named the wrong rule.** It is renamed "a Task under a Task".
- **NIT (code), weak asserts.** **Taken:** the dbtest pins each CHECK and index by name through `e.meta` (never the message: the Prisma code-frame trap), and the e2e reads the Tasks cell, not the whole row.
- **NIT (code), a stale comment** (`_shape`, "a third"). Fixed.
- **Also on the way:** applying asks `project:create` before it reads the template, so a member who may not make projects learns nothing of the templates.

### 10b. The re-check of the fixes (a fresh agent) — dispositions

No HIGH, no MEDIUM.
- **LOW, the Save dialog could hang.** A thrown action (not a typed refusal) left it on "Saving…" or "Counting…". **Fixed:** both now end in a sentence, and the button comes back.
- **LOW, labels past a task's 50 still entered the document.** **Fixed:** only the labels a task keeps are counted and stored, and the unit test asserts it.
- **NIT, the import and the apply sorted new label names differently.** **Fixed in the import** (one comparator): both fold.
- **NIT, the cheap milestone refusals ran after the description reads.** **Fixed:** they come first.
- **NIT, two stale comments.** Fixed.
- **NIT, a deadlock spent three times reaches the member as an error page.** **Accepted:** the precedent is split, and three deadlocks in a row on a project nobody else can see is not a real path.
- **NIT, copy edge cases.** `TEMPLATE_INVALID` on a save is circular, and `TEMPLATE_TOO_LARGE` does not name the milestone length bounds. **Accepted:** both are rare by construction.
