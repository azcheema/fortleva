# Slice 123 — the workspace's own stages and labels (founder decision C99)

*2026-10-15. Decided under C98 (f) → C99 (a) and (b), both with the recommendation. This document is the build plan; the settled parts are C99's, the rest are the implementing session's choices, named as such so a reviewer can push on them.*

## 1. What the founder decided

- **(a) Stages: a workspace default, then each project its own.** Settings → Stages holds the workspace's default set (rename, add, reorder, remove). A NEW project copies it. Each project can then change its own. Every stage still belongs to one of the fixed kinds (Backlog, To do, In progress, Done, Cancelled), so the reports and the clients' portal keep working.
- **(b) Labels: rename, colour, delete, merge** on a labels page.

## 2. What already exists (read, not assumed)

- `workflow_state` (§6.14). A NULL `name` with a `seed_key` means "still the seeded default", shown in the viewer's language. Writing a name IS the rename, one way. `category` is immutable (trigger `workflow_state_category_immutable`). It has three uniques: `(tenant, project, name)` (case-sensitive), `(tenant, project, seed_key)` and `(tenant, project, rank)`, plus the CHECK `workflow_state_name_or_seed_key`. `work_item.state_id` → RESTRICT.
- `ensureProjectStates` seeds `DEFAULT_STATE_SHAPE` lazily on a project's first work read or write; the core cannot import the work module (ARC-16). Board and backlog order the states by `rank` alone, so the ranks must stay grouped by kind.
- What the logic keys on: the **category** and `isDefault`, never a seed key.
  - The triage Accept uses `isDefault`, and Decline the first `CANCELLED` state.
  - The portal's intake uses the first `TRIAGE` state.
  - Imports use `isDefault`.
  - `requiresApproval` gates entry with `work_item:approve`.
- History rows for a state move hold **categories**, with the state ids as refs. A removed state leaves no dangling name in history.
- `workflow_preset {id, tenant, name, states jsonb, isDefault}` is class A, has RLS and grants, and has **no reader or writer**. Codes `workflow:manage` and `label:manage` exist (owner, manager, admin). The audit action `workflow.changed` exists.
- `label`: tenant-wide (`project_id` NULL; nothing makes a project label), with `color` text that nothing writes. The case-insensitive unique `label_tenant_wide_name_key` maps to `LABEL_TAKEN`. Deleting a label cascades through `work_item_label`. History rows hold the label id as a ref and resolve it at read, so a renamed label shows its new name and a deleted one reads as gone. Audit actions `label.created` and `label.deleted` exist.
- **The chip pin (UI.md §5.2 / §10.4):** a label chip is a NEUTRAL outline `Badge`, because a filled coloured chip next to the visibility badge would give a second meaning to the one warm pill that means "Client can see". **So a label's colour is a DOT inside the outline chip**, never a filled chip.

## 3. Stages — the rules

**One rule set for both editors** (the workspace default and a project's own), in `src/modules/work/stage-rules.ts`. It is pure and unit-tested, and the services and the UI share it.

1. **The kinds stay in order.** Backlog → To do → In progress → Done → Cancelled. Triage is fixed, hidden, never listed and never edited, and is always seeded last. Reordering moves a stage **up or down within its own kind**. A new stage goes **at the end of its kind**: its rank lies between the last stage of its kind (or the last stage of the kind before) and the first stage of the next kind (`ranksBetween`).
2. **Every kind but Backlog keeps at least one stage.** Removing the last To do, In progress, Done or Cancelled stage is refused (`STAGE_LAST_OF_KIND`). The reason: the triage Decline needs a Cancelled stage, reports need Done, and new tasks need a To do-or-Backlog default. The last Backlog stage may be removed **only when it is empty**.
3. **Removing a stage moves its tasks into another stage of the SAME kind**, which the member picks; the first one of that kind is suggested. A same-kind move changes no category, so it changes nothing a client sees (the portal reads categories), no `startedAt`/`completedAt`, and touches neither triage nor a request's decline. That is why the move can be one set-based UPDATE and not N runs of the state machine. A stage with **more than 2 000 tasks** is refused (`STAGE_TOO_FULL`: "move some first").
   - **Implementing session's choice, for review:** each moved task gets an INTERNAL history row (`stateCategory`, from = to, refs old → new; `forceInternal`, the within-category precedent). Each also gets a `work_item.state_changed` audit row with the transition's own metadata shape `{from, to, projectId}`, written with `recordMany`. "State is never routine" (AGENTS.md) is then kept literally, and a reader of one task's audit trail sees the move.
4. **"New tasks start here"** (`isDefault`) is exactly one stage, of kind Backlog or To do. Choosing another stage moves the mark. Removing the marked stage moves the mark to the stage its tasks went into, which is the same kind and so still allowed.
5. **"Needs approval"** (`requiresApproval`) can be switched on any stage. A new stage is added with it OFF, except a new Done stage, which takes it ON (the seeded Done's rule). Switching it is audited.
6. **Names.**
   - A name is trimmed; it can never be blank and never cleared. NULL ("still the default") can become a name, and a name can never go back to NULL.
   - At most 40 characters (the label bound).
   - Unique per project, case-insensitively, against the other stages' STORED names. A stored name equal to a seeded default's translation is NOT refused; the member sees it and can rename it.
7. **At most 20 stages** per project or preset, Triage not counted (`STAGE_LIMIT`).

## 4. Stages — the workspace default

- **Storage:** ONE `workflow_preset` row per tenant: `name = 'default'` (never shown), `is_default = true`, `states` = an ordered JSON array of `{key, name|null, seedKey|null, category, isDefault, requiresApproval}`. There is no Triage entry, because Triage is appended at copy time. `key` is a uuid that identifies an entry to the editor's actions. The untouched defaults keep `name: null` + `seedKey`, so a new project's board is still in each viewer's language until somebody renames it.
- **No row = Fortleva's built-in set** (`DEFAULT_STATE_SHAPE`). The editor shows the built-in set and writes the row on the first change (`INSERT … ON CONFLICT (tenant_id, name) DO NOTHING`, then `SELECT … FOR UPDATE`). **"Restore the original stages"** deletes the row; it touches only projects made afterwards. It is audited.
- **Reading it is defensive.** It is parsed with zod and checked against §3's rules. Anything that fails, a tampered or old row, falls back to the built-in set. It is never trusted.
- **Copying it:** `ensureProjectStates` reads the preset only when the project has no states, and only then takes the advisory key `work_states:<projectId>` and re-counts. Two concurrent first seeds once relied on the uniques alone to collapse into one set; that still holds with a custom preset (deterministic ranks + the rank unique), and the key covers the gap where the preset changed between them. The ordering argument is in §6.
- **Edits apply to NEW projects only.** An existing project keeps its stages. A project never opened since it was made copies the CURRENT default when it is first opened, which is what "a new project" means for a lazily seeded one.
- **The preset's actions:** rename / add / move up / move down / remove (there are no tasks, so there is no target) / choose "new tasks start here" / switch "needs approval" / restore. Each one reads, changes and writes the JSON under the row's `FOR UPDATE`. They are all `workflow:manage` and audit `workflow.changed` with `{scope: "workspace", change}`.

## 5. Stages — a project's own

- **Page:** `/projects/[key]/stages`, reached from an "Edit stages" link in the board's toolbar (shown to `workflow:manage` holders only), listed under the Board tab with `also` (the Import page's precedent). It has the same table and the same actions as the workspace page, plus the remove dialog's "Move its N tasks to …".
- **Every action:** `requireAccess(workflow:manage)` → the project in the member's scope (`assertInScope`, as the board's own read does) → `ensureProjectStates` → the mutex `work_states:<projectId>` → (for a removal) the removed state `FOR UPDATE` → change → `workflow.changed` audit `{scope: "project", projectId, change, stateId, category, movedTasks?}`. **No stage names in audit metadata** (the state-change pin's rule: categories, never names).
- **An archived project** refuses (`ARCHIVED`), as the board's writes do.

## 6. Locks (THE ONE ORDER, extended)

- **The `work_states:<projectId>` advisory key** is held by the stage editors and by a FIRST seed. Nothing that holds it waits on a counter, the rank queue, or a work-item row EXCEPT the removal's set UPDATE.
  - The removal takes the key, then the removed state's row `FOR UPDATE`, then UPDATEs `work_item WHERE state_id = removed`.
  - A concurrent move **into** the removed stage holds its task row and waits on the FK's `KEY SHARE` of the removed state. The removal's UPDATE never waits on that task, because the row's committed version is in another state and does not match. The removal commits, the stage is gone, and the mover's FK check fails. That is a refusal, not a deadlock: the stage the task was moved into no longer exists.
  - A concurrent move **out of** the removed stage holds its task and takes `KEY SHARE` on its target, which nothing here conflicts with. The removal's UPDATE waits on that task, re-checks it, skips it, and the moved task is not counted.
  - **The target state is never locked beyond the UPDATE's own `KEY SHARE`.** Locking ALL of a project's states `FOR UPDATE`, the first idea, deadlocks against a bulk change that holds a task and waits on its target state's FK.
- **A first seed under `importBatch`** runs after the counter and rank queue. That is safe because no editor ever takes those two.
- The key is registered in `rank-lock.ts`'s key-space note, beside `work_rank:` and `milestone_rank:`.

## 7. Labels

- **Page:** `/settings/labels` (`label:manage`; the nav entry is hidden without it). It is a table of the workspace's labels: name (inline edit), colour (inline select), the number of tasks wearing it, and a row menu with **Merge into…** and **Delete**. A create form is underneath.
- **Rename:** trimmed, never blank, ≤ 40. The index decides `LABEL_TAKEN`. Audited `label.renamed {from, to}`; label names are tenant vocabulary and `label.created` already records `name`.
- **Colour:** a closed palette of seven plus "no colour", stored as the TOKEN NAME (`red`, `orange`, `olive`, `teal`, `blue`, `purple`, `pink`), which maps to seven of the twelve `--entity-*` identity hues (entity-0, 1, 3, 5, 7, 9, 11 — hues 15°, 45°, 105°, 168°, 225°, 285°, 345°), which globals.css already anchors at 3:1 against every surface and which are, by DESIGN SPEC §2.6, identity and never status. The value is never a hex literal. The chips show it as a small dot inside the neutral outline chip, on the board card, the backlog row, the panel's rail and the picker. Audited `label.color_changed`.
- **Delete:** a danger confirm ("It comes off N tasks"). The cascade removes the joins, and no per-task history rows are written: old rows read as "a label that is gone" (the existing read). Audited `label.deleted {name, tasks}`.
- **Merge A into B:** both labels are locked `FOR UPDATE` in id order (two opposite merges cannot deadlock; the second finds its source gone, `NOT_FOUND`). Then `INSERT … SELECT … ON CONFLICT DO NOTHING` gives every task with A the label B, A is deleted (the cascade), and it is audited `label.merged {from, into, tasks}`. No per-task rows, for the reason Delete has none. A concurrent "put A on a task" waits on A's lock and then fails its FK. That failure is mapped to `NOT_FOUND`, because the label is gone.
- **Project-scoped labels** do not exist yet; the page lists and acts on tenant-wide labels only.

## 8. The migration (small; a fresh agent reviews it BEFORE it is applied)

1. `workflow_state_name_not_blank CHECK (name IS NULL OR btrim(name) <> '')`.
2. Trigger `workflow_state_name_one_way`: a non-NULL name may not be set back to NULL. This is the seed-key migration's "the editor must refuse to clear a name", now held by the database.
3. `workflow_state_one_default`: a partial UNIQUE on `(tenant_id, project_id) WHERE is_default`. Moving the mark clears the old row before setting the new one. A guard DO block refuses the migration if any project already has two defaults.
4. `label_name_not_blank CHECK (btrim(name) <> '')` and `label_color_token CHECK (color IS NULL OR color IN (…the seven…))`. A guard refuses the migration if any existing row breaks either.
5. `workflow_preset_states_is_array CHECK (jsonb_typeof(states) = 'array')`.

No new table and no RLS change. No new permission code, so **no `TEMPLATE_VERSION` change** (RUNBOOK §12). **It carries a migration**, so production needs `migrate deploy` before Promote.

New audit actions: `label.renamed`, `label.color_changed`, `label.merged` (all TENANT). New domain errors: `STAGE_LAST_OF_KIND`, `STAGE_TOO_FULL`, `STAGE_LIMIT`, `STAGE_NAME_TAKEN`, `STAGE_DEFAULT_KIND`, `STAGE_NOT_EMPTY`.

## 9. Tests

- **Unit:** `stage-rules.test.ts` (placement ranks, the order rule, last-of-kind, default kind, the limit, name checks, the preset parse falling back to the built-in set).
- **dbtest** `stages.dbtest.ts`, prefix `stg-`:
  - the preset is copied into a new project, with Triage appended and seeds kept NULL-named;
  - an existing project is untouched;
  - rename one way (the trigger refuses NULL);
  - add places within kind;
  - move within kind;
  - remove moves the tasks, with history rows and audits;
  - the default follows a removal;
  - last-of-kind is refused;
  - the one-default unique;
  - an employee is refused.
- **dbtest** `labels.dbtest.ts`, extended: rename / colour / delete / merge, with audits; an employee is refused; the colour CHECK.
- **e2e** `stages.spec.ts`: rename a stage on the project page and the board shows it; add one; remove one into another. Plus the workspace default reaching a new project, and labels: rename, colour dot visible, merge.
- **Visual stops:** `settings-stages`, `settings-labels`, `project-stages`.

## 10. What the build changed (record)

- **The migration's pre-apply review** (a fresh agent):
  - **HIGH:** `work.dbtest.ts`'s one-way-door test reset a renamed state to NULL in its `finally`, which the new trigger refuses. It now runs on a throwaway project and asserts the refusal, reading `meta` (the Prisma code-frame trap).
  - **MEDIUM:** the default's kind is now held by the database, `workflow_state_default_kind`. This is load-bearing: create and import put a task straight into the default without the state machine, so a Done default would have skipped the approval gate.
  - **LOWs, all taken:**
    - Stage names are unique per project ignoring case (`workflow_state_name_ci_key`).
    - Both name CHECKs refuse control characters and more than 40 characters.
    - A unit test pins the colour list to the CHECK.
  - **NIT:** the first seed no longer uses `skipDuplicates`. Under the key nothing can clash, so a clash is a bug rather than a silently missing stage.
- **The import's label names** fold a cell's newlines and tabs to spaces and drop other control characters, so the new CHECK never fails a batch.
- **The import batch now seeds BEFORE the counter and the rank queue.** The order is the stage key → counter → rank queue → rows, everywhere.
- **The board's freshness token** now also reads the stage COUNT (an empty stage removed moves no task) and the workspace's newest label change. The latter needed `label.updated_at`: a second migration, `20261027100000`, applied to dev. It is a separate migration only because the first was already applied. The read happens in sequence after the batch, never as a fourth leg.
- **A removal's target is required only when something moves** (the bin counts). A removed default passes its mark to the target, or else to the first other stage of its kind.
- **`STAGE_IS_DEFAULT`** is a new refusal: the empty last Backlog stage while new tasks start there.
- **Not in e2e:** the removal dialog's "move N tasks" path. The dbtest covers the move; the browser test covers an empty stage's removal and a refused one.

## 11. The slice review (two fresh agents, code + security) — dispositions

**Security: no HIGH or MEDIUM.**
- **LOW-1, the case fold:** JavaScript's lower-casing and Postgres's `lower()` disagree on a few letters, so a workspace default could pass the service and then fail every new project's first seed. **Fixed:** `namesDistinctToDb` checks with the database's own fold, on the preset's write and on its read; a set it calls alike reads as the built-in set. `workflow_state_name_ci_key` is mapped to `STAGE_NAME_TAKEN`.
- **LOW-2, a gated start stage:** a "needs approval" stage could be the default, and a create skips the state machine. **Fixed:**
  - the rules (`canStartHere` / `defaultRefusal` / `defaultHeir`);
  - both editors (making a gated stage the default, or gating the default, is refused `STAGE_DEFAULT_GATED`, and a removed default's mark skips a gated stage);
  - `setIsValid`;
  - a third migration, `20261027110000` (CHECK `workflow_state_default_ungated`), applied to dev.

  AUTHZ.md now says `workflow:manage` includes the approval gate.
- **NITs:**
  - Count before reading: fixed.
  - Narrating only the moved rows: fixed with the locked read below.
  - The bin's tasks: they now get a history row and an audit row too.
  - The workspace audit row: it now names the entry's key, its kind and on/off.
  - Bidi and zero-width characters in names: refused.
  - `STAGE_GONE` on a stage's own delete: unreachable, kept.

**Code: two HIGH, both in the e2e spec, both fixed.**
- The inline edit's button is "Edit {label}, currently …". The label is now the column's name ("Name", "Colour"), and the helper types into the focused input.
- The add forms answer in a `FormMessage`, not a toast. The spec now reads the message.

**Code: MEDIUMs, both fixed.**
- The removal narrated a read taken before its wait. It now reads the stage's tasks `FOR NO KEY UPDATE` after the queue and the stage lock, and moves and narrates exactly those ids.
- The removal now has a 60-second budget, and a dbtest moves 400 tasks inside it.

**Code: LOWs, all fixed.**
- The four state writers (`changeState`, `moveItem`, `bulkChangeState`, `triageItem`) are wrapped in `guarded`, so `STAGE_GONE` is a sentence.
- The merge's target lock is `FOR NO KEY UPDATE` (a deadlock with a concurrent add).
- Restore racing an edit is handled by an `INSERT … ON CONFLICT DO UPDATE … RETURNING` upsert.
- The case fold (as security LOW-1).
- The lock-order comment is corrected. The rule: never seed after the counter or the queue.
- The last Backlog stage holding only deleted tasks gets its own answer, `STAGE_IN_BIN`.
- Two tests passed for the wrong reason. There is now a name sentinel in the removal's audit check, and the preset cases each break one property.

**Code: NITs.**
- Taken:
  - Workspace no-ops write and audit nothing (and take back a row they had just made).
  - The toast counts live tasks.
  - The stale comments (schema, `requests.ts`, `labels.ts`, AUTHZ's count) are corrected.
  - `listWorkspaceLabels` is off the barrel.
  - The board toolbar is re-indented.
- Not taken: none.

**The re-check of the fixes (a third fresh agent): no HIGH or MEDIUM.**
- **LOW:** a create or move into a just-removed stage usually fails in the BEFORE trigger `work_item_state_sync` ("state does not belong to the item's project"), not at the foreign key. **Fixed:** the message is mapped to `STAGE_GONE`. The guarded callers pre-check every stage against the item's project, so only a vanished stage reaches it.
- **LOW:** no test covered a no-op on an EXISTING preset row (the branch that must keep it). **Fixed:** a dbtest makes a real change, then two no-ops, and asserts the row, its content and the audit count.
- **NITs, all taken:**
  - The editor reads a stored set with the database's fold too, so an invalid row is edited as the built-in set and is never stuck.
  - The import strips the invisible characters the labels page refuses.
  - Two comments that named index tokens beside a database call are reworded. Prisma copies those lines into a dev error message, which `mapDbError` scans.
  - The `guarded` comments on the two queued writers now say they are belts.

**A last check of that round (a fourth agent): no HIGH or MEDIUM.**
- **LOW:** a label that was ONLY invisible characters failed a whole import batch. **Fixed:** it is now dropped.
- **LOW:** a stripped zero-width character left a double space that renders like an existing label. **Fixed:** spaces are folded again after the strip; the case is in `rules.test.ts`.
- **NITs:**
  - A comment in the import service that named an index above its call: reworded.
  - `custom` on a no-op against an invalid row: fixed.
  - The zero-width JOINER: a decision. It is now ALLOWED, because it holds multi-part emoji together, and refusing it refused real names.
