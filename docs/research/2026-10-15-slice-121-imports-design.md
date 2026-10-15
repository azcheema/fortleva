# Slice 121 — IMPORTS AND THE FIRST-RUN LIST (Phase 6's last item; founder decision C97)

*Design written 2026-10-15 by the building session, before any code. The migration is reviewed by a fresh agent before it is applied (§10 records that review and what was done about it). C97's answers are in `docs/OPEN_QUESTIONS.md`; this document is how they get built. The original research is `2026-08-16-research-digest.md` AREA B and `2026-08-16-work-management-synthesis.md` §4.7. This design keeps what they got right (an idempotent `sourceSystem:sourceId`, a preview before anything is written, matching people by email) and drops what this product no longer needs (R2 upload, a resumable server-side job, a cron re-drive). See R1.*

## 0. What C97 decided, and the readings this design takes

| C97 | Decision | Reading taken here |
|---|---|---|
| pick | **Imports + first-run list next**, over a per-client report switch, starting Phase 7 proper, and stopping | Phase 6's last unchecked line ("generic CSV/Trello import; first-run onboarding polish"). The PDF-exports part of that line was C95/C96. |
| (a) | **A spreadsheet file (CSV) with a column-matching step, and Trello's own export.** Not Excel `.xlsx` read directly | §2. One importer and two readers. The CSV reader handles `,`, `;` and TAB, quoted cells, embedded newlines, a BOM, UTF-8 or Windows-1252. Trello's board JSON needs no column matching. |
| (b) | **Basics + checklists.** Name, description, status, due date, who it's assigned to, labels. Trello checklists become checklists inside the task. A link to the original card is kept. Old comments are left behind | §2.3–§2.5. Priority, estimates, start dates, subtasks, attachments and custom fields are left behind too. "Basics" is the six fields the founder named. |
| (c) | **Undo for 7 days.** One button moves every task the import made to the bin, and importing the same file again updates those tasks instead of making copies | §4 (re-import) and §5 (undo). Two readings sit inside this answer, R7 and R10. |
| (d) | **A checklist on Home.** For owners: details, first client, first project, invite your team, import your tasks. Each step ticks itself off, and the whole list can be hidden | §7. There is NO logo step, because the product has no logo upload yet (Phase 7 "branding basics"). See R13. |

**Readings taken by the design, not asked (said to the founder when the slice is reported):**

- **R1 — THE FILE IS READ IN THE BROWSER AND NEVER LEAVES IT.** The member's browser parses the file, shows the matching and the check, and sends the server only the rows it will write: plain values, in batches of at most 100 rows and about 700 KB. The server trusts nothing in a row and checks every field again (§3.2). The reasons:
  - Next's server-action body limit is 1 MB and a Vercel request is capped at 4.5 MB, while a Trello board export runs to tens of MB.
  - The browser harness has no file storage (slices 115–120).
  - A spreadsheet holds columns the import never uses (client names, prices, personal notes), and this way none of them is ever stored.

  No `file_object`, no R2, no server-side parse, no cron re-drive. What the server keeps is a small `import_job` row and one `import_job_item` per task written (§1).
- **R2 — ONE PROJECT, TOP-LEVEL TASKS, PRIVATE.** An import starts from a project's own Import page and writes into that project only. Every task it makes is:
  - top-level `type TASK`, `kind TASK`, `source IMPORT`;
  - `INTERNAL`, the worst-bug default; the founder's question said so, and sharing happens afterwards through the usual levers;
  - `createdByMemberId` = the importer.

  No epics or subtasks are built from Asana's "Parent task" or Jira's hierarchy. An ARCHIVED project refuses imports (`PROJECT_ARCHIVED`).
- **R3 — WHAT A ROW BRINGS.**
  - Name: required, trimmed, at most 400 characters (`MAX_TITLE_LENGTH`). A row without one is skipped and counted.
  - Description: text, drawn as paragraphs, bullet and numbered lists, `- [ ]` and `- [x]` checklist lines, `#`–`###` headings and links (§2.4). At most 50 000 characters; a longer one is cut and the check step says how many were.
  - Status: one of the project's states (R5).
  - Due date: a date only.
  - Assignee: one person (R4).
  - Labels: at most 20 per task (R6).

  Trello adds the card's checklists, drawn under their own names, and a closing line "Imported from Trello: <link>" pointing at the card's `shortUrl`, an `https://trello.com/c/…` address that carries no board name. That line is written in the importer's language. Left behind:
  - old comments (C97 (b));
  - attachments, custom fields and Power-Up data;
  - a card's second and later members;
  - archived cards, and cards in archived lists (counted in the check step).
- **R4 — PEOPLE.** Each distinct person in the file is matched:
  - by email, exactly and case-insensitively, when the file has an email column (Asana's "Assignee Email", Jira's), against the ACTIVE members' sign-in addresses;
  - otherwise by full name, exactly, with case and accents folded.

  Trello's export carries no email, so it is always the name. Every match is shown and can be changed. One left unmatched is **Nobody**. Only ACTIVE members are offered, which is `assignItem`'s own rule. **NOBODY IS TOLD.** No notification and no email: a 300-task import would be 300 assignment emails, the reason bulk-assign was never built (`bulk.ts`). Assigned tasks simply appear in the person's My work.
- **R5 — STATUSES.** Each distinct status (CSV) or list (Trello) is matched to one of the project's states:
  1. the state's resolved name, case-insensitively;
  2. otherwise common words for a category, in English and Swedish ("done", "klar", "complete" → the first DONE state; "doing", "in progress", "pågår" → IN_PROGRESS; "backlog"; "to do", "att göra" → TODO; "cancelled", "avbruten" → CANCELLED);
  3. otherwise the project's default state.

  Every mapping is shown and can be changed. TRIAGE is never offered, because entering it is the triage verb's job (`transitionState`). An empty status lands in the default state. **A STATE THAT NEEDS APPROVAL** (the seeded Done) needs `work_item:approve`, exactly as dragging a task there does. For an importer without it, those states are not offered, and the check step says why. The server refuses such a row anyway (`APPROVAL_REQUIRED`).
- **R6 — LABELS.** A label name is matched, case-insensitively, against the labels this project offers: the workspace's plus the project's own (`labels.ts`). A new name is created as a WORKSPACE label, exactly as the picker's "Create “…”" row makes one, when the importer holds `label:manage`. Each new label is audited `label.created`. Without the code, new names are left off and the check step counts them. A label longer than 40 characters is cut.
- **R7 — "UPDATES INSTEAD OF COPIES".** A written task remembers where it came from in `(source_system, source_id)`: the Trello card's id, or the value in the file's ID column. That column is picked automatically from common headers (ID, Task ID, Issue key, Item ID, Card ID) and can be changed. Importing again into the SAME project, a row whose id matches a LIVE task there is handled as follows:
  - **Updated** to the file's values: title, description, status, due date and assignee are replaced, and labels are ADDED (never removed). This happens only while the task is still private AND nobody has changed it in Fortleva since an import last wrote it. "Not changed" is the row's `updated_at` still equal to what that import recorded, compared in SQL (§4).
  - **Kept as it is**, when someone has changed it. The result counts it as "kept your changes".
  - **Unchanged**, when the values are identical: nothing is written.

  A task in the bin is never matched, so after an undo a re-import makes new tasks. A file without an ID column cannot be recognised a second time, so it always makes new tasks, and the check step warns of exactly that. A partial UNIQUE index keeps one live task per (project, source, id) (§1.3). Updates are written through the state machine, so stamps, history and audit are exactly a drag's.
- **R8 — WHO.**
  - Importing needs `work_item:create` + `work_item:edit`, the project in the member's scope, and the work module. That is C M A E today, the same people who can create and edit tasks by hand. Add `work_item:approve` for an approval-gated state and `label:manage` for new labels.
  - Undo and Bring back need `work_item:delete` (owner, manager), the code that deleting a task by hand needs. So an employee can import, and a manager or owner undoes it.
  - **No new permission code**, so no catalogue seed is owed.
- **R9 — UNDO, FOR 7 DAYS AFTER THE IMPORT'S LAST WRITE.** Undo soft-deletes the tasks that import MADE, all with ONE stamp. It **keeps** any task that has since:
  - gained a live comment, an attached file, logged hours or a subtask;
  - been handed to a client's contact;
  - been shared with the client.

  Removing those would erase people's work, or pull a row off a client's portal with nothing said. They are counted as "kept — someone has worked on them; delete those by hand". Updates a re-import made are NOT undone (there is no "before" to go back to). Each removed task is audited `work_item.deleted` with `reason: "import_undone"` (the hand delete's action, so a log reader finds it), plus one `import_job.undone`.
- **R10 — "BRING BACK", BECAUSE THE PRODUCT HAS NO BIN TO RESTORE FROM.** The founder's question said the undo moves tasks "to the bin, where they can still be restored". Checking the code: a task deleted by hand today cannot be restored by anyone, because no restore path exists. So the import's own row offers **Bring back** for 30 days after an undo. It restores exactly the tasks THAT undo removed (same stamp), except one whose (source, id) has a live twin by then, which is counted. Each restored task is audited `work_item.restored`, plus one `import_job.restored`. A general bin for tasks deleted by hand is NOT built here.
- **R11 — LIMITS.** At most 2 000 rows per import: a bigger file is refused whole, with "split it". At most 100 rows per batch, and a file of at most 50 MB. Concurrent batches into one project serialise on the project's rank lock, the lock every create already takes. An import the browser stopped part-way (closed tab, lost network) shows on the page as **stopped part-way**: its tasks stay, Undo works, and importing the file again finishes it (R7) when the file has IDs.
- **R12 — THE TRAIL.**
  - `import_job.started`: source, rows, project.
  - Per task `work_item.created`, with `importJobId` in its metadata.
  - Per task born outside the default state, `work_item.state_changed`, with the history row INTERNAL: `createItem`'s birth-into-a-column shape.
  - `label.created`.
  - `import_job.finished`: the counts.
  - `import_job.undone`, `import_job.restored` and `work_item.restored`.

  The FILE NAME is kept only on `import_job` (members only, class A) and never in an audit row, because a file name can say anything.
- **R13 — THE FIRST-RUN LIST** (§7). It sits on Home for members who hold `settings:edit` (owner, admin). It has five steps, each ticked from the workspace's own data:
  1. **company details**: the legal name is set (Settings → Invoicing; shown only while the invoicing module is open);
  2. **first client**;
  3. **first project**;
  4. **invite your team**: a second member, or a pending invite;
  5. **add or import tasks**: any task.

  A step links to where it is done only when the viewer may do it there. The list disappears once every step is done. **Hide** turns it off for the whole workspace, and Settings → Preferences has the switch to show it again. The new key, `onboarding.checklist`, is ON by default, so an existing workspace sees the list only while a step is still undone. On dev, Naxdor sees it if, say, nobody has been invited. **No logo step:** there is no logo upload yet.
- **R14 — THE BROWSER HARNESS CAN RUN THE WHOLE IMPORT**, because nothing needs file storage (R1). `import.spec.ts` uploads a CSV and a Trello JSON made in the test with `setInputFiles` (a buffer), matches, checks, imports, finds the tasks, re-imports, undoes and brings back. The first-run list is walked in a fresh second workspace of the e2e owner (`seed-cli first-run-workspace`), so the shared tenant's Home, which the visual walk photographs, never changes. The seed turns the list OFF for the shared tenant.

## 1. Schema — migration `20261026090000_imports` (DDL only)

### 1.1 `import_job`, class A: one row per import

```sql
CREATE TABLE import_job (
  id                    text NOT NULL,
  tenant_id             text NOT NULL,
  project_id            text NOT NULL,
  source                text NOT NULL,                 -- CSV | TRELLO
  file_name             varchar(200) NOT NULL,         -- shown on the page only; never audited
  row_count             integer NOT NULL,              -- the rows the browser said it would send
  status                text NOT NULL DEFAULT 'RUNNING', -- RUNNING | DONE | UNDONE
  created_count         integer NOT NULL DEFAULT 0,
  updated_count         integer NOT NULL DEFAULT 0,
  kept_count            integer NOT NULL DEFAULT 0,    -- matched, changed in Fortleva since → left alone
  unchanged_count       integer NOT NULL DEFAULT 0,    -- matched, identical → nothing written
  started_by_member_id  text NOT NULL,                 -- attribution, no FK (the made_report precedent)
  started_at            timestamptz(6) NOT NULL,
  last_write_at         timestamptz(6) NOT NULL,       -- the undo window runs from here
  finished_at           timestamptz(6),
  undone_at             timestamptz(6),                -- THE stamp the undo wrote on every task it removed
  undone_by_member_id   text,
  undone_count          integer,
  restored_at           timestamptz(6),
  restored_by_member_id text,
  ...
);
```

CHECKs:
- `source IN ('CSV','TRELLO')`;
- `status IN ('RUNNING','DONE','UNDONE')`;
- every count ≥ 0;
- `row_count BETWEEN 1 AND 2000`;
- `(status = 'UNDONE') = (undone_at IS NOT NULL AND (restored_at IS NULL OR restored_at < undone_at))`. A restore returns the status to DONE, and a second undo after a restore is refused by the service (one undo per import: §5);
- `undone_at IS NULL OR (undone_by_member_id IS NOT NULL AND undone_count IS NOT NULL)`;
- `restored_at IS NULL OR (undone_at IS NOT NULL AND restored_by_member_id IS NOT NULL AND restored_at >= undone_at)`;
- `char_length(btrim(file_name)) BETWEEN 1 AND 200`.

UNIQUE `(tenant_id, id)` (the composite-FK target); index `(tenant_id, project_id, started_at DESC)` for the page's list. FKs: `tenant` RESTRICT; `(tenant_id, project_id) → project` CASCADE (the harness hard-deletes projects; the product archives them).

### 1.2 `import_job_item`, class A: one row per task an import wrote

```sql
CREATE TABLE import_job_item (
  id             text NOT NULL,
  tenant_id      text NOT NULL,
  import_job_id  text NOT NULL,
  work_item_id   text NOT NULL,
  action         text NOT NULL,              -- CREATED | UPDATED
  written_at     timestamptz(6) NOT NULL,    -- work_item.updated_at as this write left it
  created_at     timestamptz(6) NOT NULL DEFAULT now(),
  ...
);
```

CHECK `action IN ('CREATED','UPDATED')`; UNIQUE `(tenant_id, import_job_id, work_item_id)`, so one job writes a task once; index `(tenant_id, work_item_id, created_at DESC)` for "the last import write of this task". FKs: job CASCADE, `(tenant_id, work_item_id) → work_item` CASCADE.

### 1.3 `work_item`: the reserved columns get their rules

- `work_item_source_live_key`: UNIQUE `(tenant_id, project_id, source_system, source_id) WHERE source_id IS NOT NULL AND deleted_at IS NULL`. It refuses a second live task for one source id in a project; a binned one does not count (R7, R10). Every existing row has `source_id` NULL, so creating it cannot fail.
- `work_item_source_pair`: CHECK `(source_system IS NULL) = (source_id IS NULL)`.
- `work_item_source_system_known`: CHECK `source_system IS NULL OR source_system IN ('csv','trello')`.
- `work_item_source_id_length`: CHECK `source_id IS NULL OR char_length(source_id) BETWEEN 1 AND 200`.
- `work_item_import_job_is_import`: CHECK `import_job_id IS NULL OR source = 'IMPORT'`.
- FK `(tenant_id, import_job_id) → import_job (tenant_id, id) ON DELETE SET NULL (import_job_id)` (PG ≥ 15 column list).

Every existing row satisfies every CHECK (all NULL), so they are added VALID. The table is small on dev, and the scan is one pass.

### 1.4 Registration

`importJob` and `importJobItem` go in `MODEL_CLASSES.tenant` and `RLS_CLASSES.A`. Both get grants (`SELECT, INSERT, UPDATE, DELETE` to `app_runtime`), `ENABLE` + `FORCE` RLS, `tenant_isolation` and `portal_deny`. The export picks both up by registration.

## 2. The browser side: reading, matching, checking

All of it is pure TypeScript in `src/modules/work/import/` (no React), unit-tested, plus one client component tree under `/projects/[key]/import`.

### 2.1 `csv-parse.ts`

`decodeCsv(bytes)` strips a UTF-8 BOM, decodes UTF-8 *fatally*, and on failure decodes Windows-1252 (Swedish Excel's "CSV"). `detectDelimiter(text)` counts `,` `;` TAB outside quotes on the first line and takes the most frequent; ties go to `,`. `parseCsv(text, delimiter)` follows RFC 4180: quoted cells, a doubled `""`, CR/LF/CRLF, newlines inside quotes, a trailing newline. Wholly empty lines are dropped. At most 2 001 lines are kept (header + 2 000); beyond that it reports `tooMany`. Every cell is NFC-normalised and has NUL and lone surrogates stripped (`UNSTORABLE`'s set).

### 2.2 `trello.ts`

`readTrelloBoard(json)` validates the shape with zod; anything missing is "not a Trello board export". It returns cards in board order:
- open lists by `pos`;
- each list's open cards by `pos`;
- per card: id, name, desc, list id, due (an ISO instant → its UTC calendar date), the first member id, label names (an empty name is dropped), checklists by `pos` (name, then items by `pos` with `state === "complete"`), and `shortUrl` (kept only when it is `https://trello.com/…`).

Also the lists (id, name) and the members (id, fullName). Archived cards and cards in archived lists are counted, not returned.

### 2.3 `mapping.ts`

`guessColumns(headers)` maps known header words (English and Swedish) to name / description / status / due / assignee / assigneeEmail / labels / id. `guessDateFormat(values)` returns ISO, `D/M/Y` or `M/D/Y`, or "ambiguous" when no value has a part above 12. The member then picks: day/month or month/day. `parseDateCell(value, format)` accepts `YYYY-MM-DD` (with or without a time), `YYYY/MM/DD`, `D.M.YYYY`, and `D/M/YYYY` or `M/D/YYYY` per the format. A year outside 1970–2100 is refused. An unreadable date is left empty and counted. `splitLabels(cell, delimiter)` splits on `,` (or `;` when the file's delimiter is `,`), trims, de-duplicates case-insensitively and keeps at most 20. `guessState(value, states)` and `guessMember(person, members)` are R5 and R4. `buildRows(...)` produces the normalised `ImportRow[]` the server receives (§3.2), plus the counts the check step shows.

### 2.4 `description.ts`: plain text to the description document

`textToDescription({ text, checklists, link })` returns a ProseMirror JSON document in the DESCRIPTION schema (`extensions.ts`):
- blank-line-separated blocks become paragraphs, with a single newline drawn as a hard break;
- a run of `- `/`* `/`• ` lines becomes a bulletList, and `1. ` lines an orderedList;
- `- [ ] ` and `- [x] ` lines become a taskList;
- `#`/`##`/`###` become headings;
- an `http(s)://` URL in the text becomes a link mark;
- each Trello checklist becomes a heading-3 with its name (the default name "Checklist" is dropped) and a taskList;
- the Trello link is a closing paragraph.

Nothing else is interpreted: `**bold**` stays as typed. Run on the SERVER from the row's plain values (never trusted from the browser as a document), then `normalizeDescription`, the one gate. So the browser never sends ProseMirror JSON, and the standing null-prototype trap cannot arise.

### 2.5 The check step

Shown before anything is written:
- how many tasks will be made, and how many rows match tasks already in the project (a server read, `previewImportMatches`: §3.4) that will be updated or kept;
- rows skipped without a name, cut descriptions, unreadable dates, labels that cannot be made, archived Trello cards left out;
- with no ID column: "importing this file again will make copies";
- the first ten rows as they will be written.

The Import button says the number.

## 3. The server side

### 3.1 Files

- `src/modules/work/import/service.ts`: `startImport`, `importBatch`, `finishImport`, `previewImportMatches`, `listImports`, `undoImport`, `restoreImport`.
- `src/modules/work/import/rules.ts`: pure. The zod row shape, the limits, the undo windows, `stampsOnBirth`.
- `src/db/counters.ts`: gains `nextCounters(tx, key, n)`, one upsert of `value + n`, RETURNING the last value. The numbers are `last − n + 1 … last`.

### 3.2 `importBatch(ctx, jobId, rows)`: one transaction, set-based

The gates, in sequence and never as a batch leg (`authz-batches.test.ts`):
1. `requireAccess(work_item:create)`;
2. `requireAccess(work_item:edit)`;
3. the job read: same tenant, `status = 'RUNNING'`, `started_by_member_id = actor` (a member cannot write into a colleague's import), within its row count;
4. `assertInScope({ projectId: job.projectId })`;
5. the project not archived;
6. `isAuthorized(work_item:approve)` only if a row targets a gated state;
7. `isAuthorized(label:manage)` only if a label name is new.

Each `ImportRow` is zod-checked:
- `sourceId`: ≤ 200 chars, unique within the batch;
- `title`: 1–400 after trim;
- `text`: ≤ 50 000;
- `checklists`: ≤ 20 groups and ≤ 200 items in all, each ≤ 500 chars;
- `link`: `https://trello.com/` only, ≤ 300;
- `stateId`: must be a state of THIS project, not TRIAGE;
- `targetDate`: `YYYY-MM-DD` in 1970–2100;
- `assigneeMemberId`: an ACTIVE member of the tenant, or null;
- `labels`: ≤ 20 names, each ≤ 40.

A batch is 1–100 rows. Then, under the project's rank lock (`lockProjectRanks`, the queue every create takes):
- **Match.** The live rows of this project with this `source_system` and `source_id = ANY(…)` are locked `FOR UPDATE` (the queue precedes every row lock: `rank-lock.ts`, THE ONE ORDER). For each, the last `import_job_item.written_at` of that task, compared in SQL (`w.updated_at = i.written_at`), plus `w.visibility = 'INTERNAL'`, decides "updatable".
  - Matched by THIS job already: skipped. The browser de-duplicates ids, so this is the belt.
  - Updatable and different: updated. The scalar fields go in one `update` with an inline `select`. The state goes through `transitionState(tx, ctx, item, state)`, so stamps, the INTERNAL history row, `work_item.state_changed` and the approval gate are a drag's. The description goes through the same compare-and-set UPDATE `updateItemDescription` uses (`IS NOT DISTINCT FROM` the row's document). The assignee is set directly and writes the `assignee` history row; no notification (R4). Labels are added. `updated_at` is re-read after all of it and an `UPDATED` item row recorded.
  - Updatable and identical: `unchanged`.
  - Not updatable: `kept`.
- **Create** the rest:
  - `nextCounters(work_item:<projectId>, n)`;
  - `ranksBetween(lastRank, null, n)` below the project's last row (live or binned: `bottomRank`'s rule);
  - one `createMany`: state and category, stamps from `stampsOnBirth(category)` (IN_PROGRESS → `startedAt`; DONE → `completedAt`; the state machine's birth), the description document, `description_text` and checklist counters from `normalizeDescription`, `source IMPORT`, `source_system`/`source_id`, `import_job_id`, `visibility INTERNAL`, `createdByMemberId`, and an explicit `updatedAt` = the batch's one `now`;
  - the labels via `createMany` on `work_item_label`;
  - history via `writeActivityMany`: `created` for each (forceInternal), plus the `stateCategory` birth row (forceInternal) for one not in the default state;
  - audit via `recordMany`: `work_item.created` with `{ number, projectId, type: "TASK", visibility: "INTERNAL", importJobId }`, and `work_item.state_changed` `{ from: <default category>, to, projectId }` for one born elsewhere;
  - `import_job_item` `CREATED` rows with `written_at` = that same `now`.
- **New labels**: `INSERT … ON CONFLICT DO NOTHING` on the tenant-wide name index, then a re-read by `lower(name)`. One `label.created` audit row for each label this statement actually inserted.
- **The job's counts** are incremented, and `last_write_at = now`.

Budget: `timeoutMs: 60_000`, the bulk verbs' budget. About 20 statements for a batch of new tasks, plus about 5 per changed row on a re-import. The unique index and a deadlock are retried by a wrapper, as the rank writers do.

### 3.3 `startImport` and `finishImport`

- `startImport({ projectId, source, fileName, rowCount })` runs the same gates (create, edit, scope, not archived) and inserts the job, audited `import_job.started` `{ projectId, source, rows }`.
- `finishImport(jobId)`: the starter only. It sets `DONE` and `finished_at`, audited `import_job.finished` with the four counts. It is idempotent on an already-DONE job (no second audit row).

### 3.4 Reads

- `previewImportMatches(projectId, source, sourceIds)` needs view + create + edit + scope. It returns the counts only (`willUpdate`, `willKeep`, `inBin` — never titles), up to 2 000 ids.
- `listImports(projectId)` needs the same codes. It returns the project's imports, newest first, 50 at most: who, when, the file name, the source, the counts, the status, and whether Undo or Bring back is possible for THIS viewer (`work_item:delete`) right now.

## 4. Re-import, said once

The rule is R7. The safety argument:
1. Only a task still private and untouched since the import is ever overwritten. "Touched" is any Prisma write (`@updatedAt`) or a description save (`updated_at = now()`). Raw SQL writers that leave `updated_at` alone (the rank rebalance, the portal fan-out) do not count, and neither changes a field an import writes.
2. Labels are added and never removed.
3. Everything is under the project's queue and row locks, so a member's edit either commits first (and the task is kept) or waits.

## 5. Undo and Bring back

- `undoImport(jobId)` checks `work_item:delete`, scope, a job DONE or RUNNING, never undone, and `now − last_write_at ≤ 7 days`. Under the project's rank lock:
  1. One UPDATE soft-deletes every task with an `import_job_item` `CREATED` row of this job that is still live, INTERNAL, with no contact assignee, no live child, no live comment (`comment` on WORK_ITEM), no live attached document and no time entry. `deleted_at` = ONE stamp, RETURNING ids and numbers.
  2. The job's `undone_at` (= that stamp), `undone_by_member_id`, `undone_count`, and `status UNDONE`.
  3. Audit: `recordMany` of `work_item.deleted` `{ number, projectId, reason: "import_undone", importJobId }`, plus `import_job.undone` `{ removed, kept }`.

  It answers `{ removed, kept }`.
- `restoreImport(jobId)` checks `work_item:delete`, scope, `status UNDONE`, and `now − undone_at ≤ 30 days`. Under the rank lock, one UPDATE clears `deleted_at` on this job's created tasks whose `deleted_at = undone_at` and which have NO live twin with their (source, id) in the project (`NOT EXISTS`, under the lock, so the unique index cannot fire). Then `restored_at`, `restored_by_member_id`, `status DONE`. Audit `work_item.restored` per task plus `import_job.restored` `{ restored, skipped }`. One undo per import: a restored import is not undone again (the row says "delete by hand").
- **Why no cascade.** `deleteItem` takes a task's attachments and thread with it. Undo removes only tasks that have neither (R9), so nothing cascades, and Bring back has nothing to bring back but the rows.

## 6. The pages

- **`/projects/[key]/import`** (Backlog tab highlighted: `also`).
  - **Choose a file:** a file field, `.csv,.json,.txt`, ≤ 50 MB, with how to get one from Trello and the others.
  - **Match:** CSV gets the column pickers, then a status → state table and a person → member table; Trello gets lists → states and members → people. Selects are `Select` components, not native ones inside a form (React 19 resets a `<form action>`).
  - **Check:** §2.5.
  - **Import N tasks:** batches in sequence with a progress bar. Each batch's typed `ActionResult` is toasted on failure, and the run stops there: the job stays RUNNING and the page says "stopped part-way". Then a summary with a link to the backlog.
  - **Earlier imports:** `listImports`, with Undo (a danger `RowAction` with a question, because the count and "kept" rule are said) and Bring back.
- **Backlog:** "Import tasks" beside "Show archived" in the footer line, plus a second action in the empty state. Shown when the member holds create + edit and the project is not archived.
- **Copy:** every string in `en.json` and `sv.json` (`projects.import.*`), idiomatic Swedish ("Importera uppgifter", "Ångra importen", "Ta tillbaka").

## 7. The first-run list (Home)

- **`src/onboarding/checklist.ts`:** `readFirstRunList(ctx)` answers `null` unless the viewer holds `settings:edit` and `onboarding.checklist` is on. Otherwise it reads, in sequence, existence only:
  - the tenant's `legal_name`, and whether the invoicing module is open;
  - any client, any project;
  - the member count and any pending invite;
  - any work item.

  It answers `null` when every shown step is done. Each step carries `href` only when the viewer holds its verb (`invoice:manage_details`-or-whatever the invoicing card checks; `client:create`; `project:create`; `member:invite`; `work_item:create`), and the import step links to the first project's Import page, or to Projects when there is none. Reads only: no audit.
- **`hideFirstRunList()`** writes `onboarding.checklist = false` through `updatePreferences` (its `settings:edit` gate and audit, the existing `settings.updated`). The Preferences page gets a "Getting-started list" card with the switch.
- **The card** comes first on Home, above the inbox card, because a new workspace has nothing else. It is a `SectionCard` with a checked/unchecked glyph per step, "3 of 5 done", and a Hide button. Its tokens are UI.md's.

## 8. Tests

- **Unit:** the CSV parser (quotes, newlines, delimiters, BOM, 1252, limits); the date guesser and parser; the header guesser; the label split; the state and member guesses; `textToDescription` through `normalizeDescription` (lists, checklists, headings, links, an unsafe href dropped); Trello board reading (order, archived, checklists, shortUrl host); the row shape; `nextCounters`.
- **`import.dbtest.ts`** (prefix `imp-`, registered in `DBTEST_PREFIXES`):
  - the gates (an employee imports and cannot undo; a member outside scope; an archived project; a colleague's job);
  - a CSV batch writes tasks in order with numbers, ranks, states, stamps, assignee, labels, a description with a checklist, INTERNAL, source columns, history and audit rows, and NO notification;
  - an approval state refused without the code;
  - new labels made or left off;
  - re-import: updated, kept after an edit, unchanged, a shared task kept, a binned task not matched;
  - the partial unique index;
  - undo (with kept: a comment, a file, hours, a subtask, shared) and the 7-day window;
  - Bring back (with a twin) and the 30-day window;
  - finish is idempotent;
  - the job and item rows unreadable to a contact principal.
- **`isolation.dbtest.ts`** covers the two tables by registration. `first-run.dbtest.ts` (prefix `frun-`) checks the steps, the gate, the hide and the auto-gone.
- **e2e `import.spec.ts`:** a CSV with an ID column, `;`-delimited, in Swedish headers, gets imported, its tasks are found on the backlog, a second import updates one and keeps an edited one, then undo and bring back. A Trello JSON imports lists, checklists and the link. **`first-run.spec.ts`** works in the second workspace: the list, a step's link, Hide, and the Preferences switch.

## 9. Order of work

1. This document; record C97 (OPEN_QUESTIONS, PLAN §0); commit.
2. The migration, reviewed by a fresh read-only agent BEFORE it is applied; `migrate status` first; apply to dev; verify the checksum.
3. The pure modules and their unit tests.
4. The services and the dbtests.
5. The pages, copy, the e2e specs and the seed.
6. Gates once each: typecheck, ESLint, unit, the new dbtests plus `isolation`, the build, and the two e2e specs on port 3457.
7. `/code-review` + `/security-review` by fresh read-only agents. The security pass is owed: a server action writing many rows, untrusted input, RLS on two new tables, a restore path.
8. Commit, push, read CI, then update PLAN §0.

*This slice suits Opus at high. Nothing here is client-visible until a person shares a task.*

## 10. Pre-apply migration review

*(To be filled in by the building session.)*

## 11. Code and security reviews

*(To be filled in by the building session.)*
