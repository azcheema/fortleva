# Slice 119 — THE MONTHLY REPORT FORTLEVA MAKES (Phase 7 step 1; founder decision C95)

*Design written 2026-10-15 by the building session, before any code; the migration is reviewed by a fresh agent before it is applied (§10 records the review and what was done). C95's answers are in `docs/OPEN_QUESTIONS.md`; this document is how they are built. Slice 115 (`2026-10-13-slice-115-report-files-design.md`) built the report files this slice makes one of.*

## 0. What C95 decided, and the readings this design takes

| C95 | Decision | Reading taken here |
|---|---|---|
| (a) | **A button you press** — "Make a report" on the client's Reports tab, the month picked (last month by default); private until published, then the same publish dialog, email and Monday-summary count as an uploaded report | A **Make a report** card on the Reports tab, above the upload card: the month, the language, the projects, the two texts, one button. The result is a REPORT document like any uploaded one (§1), so publish, hide, edit, delete, the mails, the portal page and the weekly summary are slice 115's unchanged — except that publishing a MADE report checks it first (§3). Nothing runs on the 1st. |
| (b) | **What got done and the progress updates only** — the tasks finished that month that the client can see, by project, and the updates published that month with each project's health; NOT the website speed, milestones or files | §2: per ticked project, the DONE tasks whose finish fell in the month and the PUBLISHED updates whose publish fell in the month, each update drawn with its health and its words. A project's health is the newest of its updates in the month. Nothing else is read — no milestone name reaches the PDF (a task's "phase" is a milestone's name, so it is left off the task line too), no file, no speed row. |
| (c) | **No hours** | The update's frozen numbers strip is not drawn at all (it counts hours, and milestones). The task line carries no duration. The report is read as the NARROWEST profile (§2.1), which holds no `portal.hours.view` anyway. |
| (d) | **A summary and a "Coming next"** — the team's own words, both optional | Plain text, at most 2 000 characters each, newlines kept as lines; stored on the made report's own row (§1.2), drawn at the top and the end (§4). Never in an audit row. |
| (e) | **All the client's projects, untick any** | The card lists every project of the client whose portal is on and which is not archived, all ticked. The ticked set is stored (§1.2) and the report is made for it alone; a ticked project the client cannot see when the report is made is refused (§2.3). |
| (f) | **The client's invoice language**, changeable when making it | A language select, sv / en, starting at `invoiceLocaleFor(client)` (C76 (e)); stored on the row; the PDF's labels, dates and month names follow it. |
| (g) | **Only months that have ended** | The month select offers months strictly before the workspace's current month (its zone); the service refuses the current month and later (`INVALID_INPUT`). |

**Read by the design, not asked (stated to the founder when the slice is reported):**

- **R1 — A report is made AS ONE OF THE CLIENT'S OWN PEOPLE.** The content is read through the portal's projections under a synthesised contact principal (`synthesiseContactPrincipal`, the weekly summary's and View-as's builder), so "only what the client can already see" is decided by `portal_gate` and the projections' own terms, never by this slice's filters. The person it is read as is the contact with the **narrowest** profile among those who could sign in now (ACTIVE, invited, verified — the Portal tab's audience rule, `readPortalPreview`). **A client with nobody who can use the portal gets no made report**: the form says so and offers Contacts; the service refuses `MADE_REPORT_NO_AUDIENCE`. There is nobody to read it as, and nobody who could open it once published.
- **R2 — A made report IS a REPORT document** (kind `REPORT`, same list, same verbs), with a row of its own beside it, `made_report` (class A), which is the "made in Fortleva" marker and the record of what was made (§1). Slice 115's design review (M3) said a generated PDF takes a NEW kind; that was about the progress-update PDF and the tidrapport, which are per project or monthless and which the REPORT CHECKs refuse. The monthly report is exactly what the kind is for: the client's, for one month, on the Reports page. DATA_MODEL's enum note is amended either way (§8).
- **R3 — A made PDF freezes names, so PUBLISHING CHECKS IT AGAIN** (§3): the content is derived once more, as the client, and compared by fingerprint to what was made; any difference — a task made private or re-opened, an update unpublished or retracted, a project's portal or a section switched off, a project archived — refuses `MADE_REPORT_STALE` ("make it again") and nothing is published. Every publish checks, the first and every one after a hide. The rows the report names are share-locked for the check (the time report's precedent, slice 72), so a change cannot slip between the check and the flip. After publish the PDF is the client's; a later change is the agency's to answer by hiding it and making it again, as with an uploaded report.
- **R4 — No name field.** The document is named in the report's language ("Monthly report September 2026" / "Månadsrapport september 2026"); the Reports tab's Edit changes it afterwards, as for any report.
- **R5 — The agency's name is on the PDF, Fortleva's is not.** An uploaded report would carry the agency's name; the client's monthly report is the agency's document. "Made in Fortleva" is the TEAM's marker on the Reports tab. The PDF's foot carries the agency, the client and the month.
- **R6 — Size has a ceiling, and it refuses rather than trims**: the projections' caps (200 tasks, 50 updates per project read) and the report's own (25 projects, 500 task lines, 60 updates in all) refuse `MADE_REPORT_TOO_LARGE` — "untick some projects". A silently shortened report would be a report that lies by omission.
- **R7 — The browser harness has no file storage**, so the e2e cannot press Make (the production build's local-disk transport refuses) — and `@react-pdf/renderer` does not load under the seed's `tsx` runner either (`ERR_PACKAGE_PATH_NOT_EXPORTED`, measured), so the seed plants the rows directly: a placeholder PDF in its temp dir and the REAL fingerprint, derived by the shared function as the contact. The tab, the marker, the publish check's path and the portal page are walked; the drawing, the upload, the row and the check's judgement are the dbtest's.

## 1. Schema — migration `20261024090000_made_reports` (DDL only)

### 1.1 The decision: a REPORT plus a row, not a new kind

A made report is a `document` of kind `REPORT` (R2) with version 1 pointing at a COMMITTED `file_object` of kind `GENERAL` holding the PDF — the same shape an upload commits, so every existing path (the download broker, the portal's version read, the Files cascade on delete, the export) works unchanged. What is new is the record of the making:

### 1.2 `made_report` — class A, one row per made report

```sql
CREATE TABLE made_report (
  document_id       text NOT NULL,                 -- the REPORT document; PK
  tenant_id         text NOT NULL,
  locale            varchar(2) NOT NULL,           -- 'sv' | 'en' — the PDF's language
  summary           text,                          -- the team's words, ≤ 2000 chars
  coming_next       text,                          -- the team's words, ≤ 2000 chars
  project_ids       text[] NOT NULL,               -- the projects ticked, in the order made
  task_ids          text[] NOT NULL,               -- every task the PDF names
  update_ids        text[] NOT NULL,               -- every update the PDF draws
  as_contact_id     text NOT NULL,                 -- whose view it was read as (attribution, no FK)
  content_sha256    char(64) NOT NULL,             -- the fingerprint of what was drawn (§3.1)
  template_version  smallint NOT NULL,             -- which drawing the bytes are
  made_at           timestamptz(6) NOT NULL,
  made_by_member_id text,                          -- attribution, no FK
  CONSTRAINT made_report_pkey PRIMARY KEY (document_id),
  CONSTRAINT made_report_tenant_id_document_id_key UNIQUE (tenant_id, document_id),
  CONSTRAINT made_report_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenant(id) ON DELETE RESTRICT,
  CONSTRAINT made_report_tenant_id_document_id_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES document(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT made_report_locale CHECK (locale IN ('sv', 'en')),
  CONSTRAINT made_report_summary_length CHECK (summary IS NULL OR char_length(summary) <= 2000),
  CONSTRAINT made_report_coming_next_length CHECK (coming_next IS NULL OR char_length(coming_next) <= 2000),
  CONSTRAINT made_report_projects_bounded CHECK (cardinality(project_ids) BETWEEN 1 AND 25),
  CONSTRAINT made_report_tasks_bounded CHECK (cardinality(task_ids) <= 500),
  CONSTRAINT made_report_updates_bounded CHECK (cardinality(update_ids) <= 60),
  CONSTRAINT made_report_sha256_shape CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT made_report_template_version_positive CHECK (template_version >= 1)
);
```

- **Class A** (`tenant_isolation` + `portal_deny`, no `visibility`, no `portal_enabled`): the client reads the PDF, never this row. It is registered in `MODEL_CLASSES.tenant` and `RLS_CLASSES.A`, so `isolation.dbtest.ts`' posture loop covers it.
- **Written once**, by `makeReport` alone, in the transaction that creates the document. A trigger `made_report_frozen` refuses UPDATE (the row is the record of what was made; a different report is a different document). DELETE follows the document's hard delete (the harness's teardown; the product soft-deletes, and the row stays with the soft-deleted document as its versions do).
- **A trigger `made_report_kind_guard`** (BEFORE INSERT) refuses a row whose document is not a live `REPORT` of the same tenant — the belt for a writer that forgets.
- `project_ids`, `task_ids`, `update_ids` hold ids only: what the publish check share-locks (§3.2). The content itself is not stored twice (an update's body is up to 128 KB; sixty of them is not a column).
- No DML, so no `neon-smoke.yml` dispatch is owed. The tenant export dumps the table with the rest (`src/export/service.ts` is select-less per model; the texts are the tenant's own words).

### 1.3 Prisma

```prisma
model MadeReport {
  documentId      String   @id @map("document_id")
  tenantId        String   @map("tenant_id")
  locale          String   @db.VarChar(2)
  summary         String?
  comingNext      String?  @map("coming_next")
  projectIds      String[] @map("project_ids")
  taskIds         String[] @map("task_ids")
  updateIds       String[] @map("update_ids")
  asContactId     String   @map("as_contact_id")
  contentSha256   String   @map("content_sha256") @db.Char(64)
  templateVersion Int      @map("template_version") @db.SmallInt
  madeAt          DateTime @map("made_at") @db.Timestamptz(6)
  madeByMemberId  String?  @map("made_by_member_id")
  tenant   Tenant   @relation(fields: [tenantId], references: [id])
  document Document @relation(fields: [tenantId, documentId], references: [tenantId, id], onDelete: Cascade)
  @@unique([tenantId, documentId])
  @@map("made_report")
}
```

`Document` gains `madeReport MadeReport?`; `Tenant` gains `madeReports MadeReport[]`.

## 2. The content — read as the client, by the portal's own projections

### 2.1 Whose view

`src/documents/made-reports.ts` reads, under the MEMBER's transaction, the client's contacts who could sign in now — `portalStatus ACTIVE`, `invitedAt` set, `emailVerified` — exactly `readPortalPreview`'s audience query (`src/projects/portal-preview.ts`), and picks the one whose profile holds the FEWEST capabilities (`PORTAL_CAPABILITIES` filtered by `profileHolds`, the preview's `width` inverted; ties by `invitedAt`, then id). Every profile holds `portal.report.view` (C91 (b)), so every profile can read what the report reads; the narrowest is chosen so the report never shows more than the least-seeing reader's portal. Today that is `CONTACT_COLLABORATOR` when the client has one, else `CONTACT_PRIMARY` — and since the report draws no numbers strip and no hours (c), the two see the same report; the rule is what holds when a narrower profile arrives. With no such contact: `MADE_REPORT_NO_AUDIENCE` (R1).

The principal is `synthesiseContactPrincipal(tenantId, contact)` — the member plane's one builder, which resolves the gates from the contact's own tenant. This slice adds NO builder (`portal-view-as.test.ts`' set stays two) and no projection: it is a caller, like the weekly summary and the outbox.

### 2.2 What is read — `deriveMadeReportContent(principal, { month, timezone, projectIds })`

In SEQUENCE (each projection opens its own contact-principal transaction):

1. `listPortalProjects(principal, "portal.report.view")` — the projects the client can see now (portal on, not archived, under `portal_gate`). Every ticked id must be in it, else `MADE_REPORT_PROJECT_HIDDEN` (§2.3). The names come from here.
2. For each ticked project, in the ticked order:
   - `listPortalTasks(principal, { projectId, followSectionSwitches: true, doneWithin: { from, to } })` — a NEW narrowing option on the projection (the shape `publishedSince` has): `stateCategory = DONE AND completedAt >= from AND completedAt < to`, inside the same `where`, so it can only return FEWER of the rows the list returns. The section switch is followed (C47): a project whose Tasks section is hidden yields the client's own requests alone — what their portal shows. `truncated` → `MADE_REPORT_TOO_LARGE`. Sorted here by `completedAt`, then id.
   - `listPortalUpdates(principal, { projectId, followSectionSwitches: true, publishedSince: from, publishedBefore: to })` — `publishedBefore` is the NEW narrowing twin of `publishedSince`. Fifty back is the cap; a project with fifty updates in a month is refused rather than cut. Sorted here oldest first (`publishedAt`, then `seq`); the project's health is the newest one's.
3. `from` / `to` are the month's first instant and the next month's first instant IN THE WORKSPACE'S ZONE (`startOfLocalDay`, `src/lib/duration.ts`): "finished in September" is September where the agency works.

What leaves a projection is what the PDF draws, and nothing more is selected: a task's `id`, `title`, `completedAt`; an update's `id`, `seq`, `health`, `title`, `publishedAt`, `body` (`readUpdateBody` → its sections: key, custom title, ProseMirror document). NOT drawn, though the projection returns them: a task's `targetDate`, `phase` (a milestone's name — (b)), `assignedToYou`, `markedDoneAt`, `reply`; an update's `periodStart`/`periodEnd` (drawn — a period is the update's own words about when), `metrics` (never — (c)), `editNote` (drawn: the agency's note after publishing is part of what the client reads).

The result, `MadeReportContent`, is `{ month, projects: [{ id, name, health, tasks: [{ id, title, completedOn }], updates: [{ id, seq, health, title, publishedOn, period, editNote, sections }] }] }` — dates already as `YYYY-MM-DD` in the workspace's zone, so the fingerprint (§3.1) and the drawing read one shape.

### 2.3 Refusals, all the member's

`MADE_REPORT_NO_AUDIENCE` (nobody could read it), `MADE_REPORT_PROJECT_HIDDEN` (a ticked project the client cannot see — a race with the portal switch, the form offers only what the member's read says is on), `MADE_REPORT_TOO_LARGE`, `INVALID_INPUT` (a month not ended, a language not sv/en, a text over 2 000 characters, no project ticked), `ARCHIVED` (the client), `REPORT_PDF_UNAVAILABLE` (the drawing or the upload failed — try again). Each is a `DomainError` with its own sentence (`domainErrors.*`), toasted by the form.

## 3. Making and publishing

### 3.1 `makeReport(ctx, { clientId, month, locale, projectIds, summary, comingNext })`

`document:upload` + `report:upload` (the upload's codes — PLAN §0: no new code), all four gates, awaited in turn; the client DIRECTLY in scope and ACTIVE; `project:view` is asked too, because the form shows the client's project names and the service reads them (the card is drawn on `uploadReports && project:view`).

1. **Member transaction**: the gates; the client (name, `invoiceLocale`, `countryCode`, archived); the month (`parseReportMonth`, strictly before the workspace's current month); the locale; the texts (trimmed, `\r\n` → `\n`, at most 2 000 chars); the ticked projects ⊆ the client's projects with `portalEnabled` and no `archivedAt` (the member's read — a project outside this set is `INVALID_INPUT`); the audience contact (§2.1); the workspace's timezone and the tenant's name.
2. **As the contact**: `deriveMadeReportContent` (§2.2) — outside any member transaction.
3. **The fingerprint**: `sha256(canonicalJson(content))` — keys sorted recursively, so a jsonb body read back twice hashes the same (it comes from Postgres both times; the hash is never taken over anything that has not been through it — AGENTS.md's trap).
4. **The drawing**: `renderMadeReportPdf(print)` (§4), imported lazily (ESM-only); failure → `REPORT_PDF_UNAVAILABLE`, nothing stored.
5. **The upload**: `getStorage().putObject(key, bytes, "application/pdf")`, key `${tenantId}/${fileObjectId}`; failure → `REPORT_PDF_UNAVAILABLE`.
6. **Member transaction**: `enforceStorageQuota(tx, tenantId, bytes.length)` (a made file counts as an upload would); the `file_object` (GENERAL, COMMITTED, sha256, size, `application/pdf`, the file name, `createdByMemberId`); the `document` (REPORT, INTERNAL, `reportMonth`, the localised name, version 1); the `made_report` row; `tenant.storageUsedBytes += size`; audit `document.created` with `{ name, kind: "REPORT", visibility: "INTERNAL", fileObjectId, clientId, projectId: null, reportMonth, made: true, locale, projectIds, asContactId, contentSha256, templateVersion }` — never the two texts. If this transaction fails, the blob is deleted (best effort) and the error rethrown.

Two makes at once make two reports; nothing is set-once.

### 3.2 `publishReport` — the check, for a made report only

`publishReport` (`src/documents/reports.ts`) gains one step between the gates and the flip, taken only when `made_report` has a row for the document (an uploaded report publishes exactly as today):

1. **Member transaction A**: the gates and `reportInScope` as today; the `made_report` row (ids, `asContactId`, `contentSha256`); the audience (§2.1) — the SAME contact if still eligible, else the narrowest now; none → `MADE_REPORT_NO_AUDIENCE`. The workspace's timezone.
2. **Member transaction B — the flip, with the check inside it**, `lockTimeoutMs` bounded and `retryOnDeadlock` around it (the time report's `publishReport`, slice 72):
   - `SELECT id FROM project WHERE tenant_id = $1 AND id = ANY($2) ORDER BY id FOR SHARE`, then the same over `work_item` (`task_ids`) and `project_update` (`update_ids`) — the rows the PDF names, so a make-private, an unpublish, a retraction, an archive, a section switch or the portal switch (all UPDATEs of these rows) wait for this transaction or have already committed before it reads. A `SELECT … FOR SHARE` consults the UPDATE policies; the member principal holds them on these tables.
   - `deriveMadeReportContent` as the contact (§2.2) — its own contact-principal transactions, plain SELECTs that no FOR SHARE blocks — and its fingerprint; `≠ content_sha256` → `MADE_REPORT_STALE`, the transaction rolls back, nothing audited (nothing changed). A projection's refusal (the person paused meanwhile) is `MADE_REPORT_NO_AUDIENCE`.
   - Then slice 115's compare-and-set flip, mails and audit, unchanged — the audit's metadata gains `made: true, contentSha256`.
   - A deadlock on every attempt, or a lock wait spent: `MADE_REPORT_BUSY` ("someone is changing this client's projects right now — try again"). So is a spent connection pool (Prisma's P2024): the check's contact reads borrow a SECOND connection while the flip's holds its own with the locks, so N publishes at once in one process need 2N connections — fine for an agency, said here so nobody is surprised at scale (the code review's low).
   - Every named row MUST lock: a locking SELECT under RLS leaves out a row a policy hides rather than refusing, and a deleted id returns nothing, so a row count short of the ids is `MADE_REPORT_STALE` (the code review's medium) — a future member-side UPDATE policy would fail closed here, never un-lock the check.
   - BEHIND EACH NAMED PROJECT'S RANK QUEUE first (`lockProjectRanks`, projects in sorted order), as `rank-lock.ts` requires of every multi-row `work_item` locker and as the time report's check does — unqueued, the id-order share-locks could cycle with a bulk edit (scan order) or the make-private cascade, and a bulk edit that lost that deadlock has no retry (the security review's medium).
   - THE HOLD IS LONG, and that is recorded, not solved (the security review's low): the share-locks on the named projects, tasks and updates are held across the whole derivation — one contact transaction per read, up to the budget — so a `setPortalEnabled` (the "stop showing this client our data" lever) pressed during a publish check waits behind it and, past its three bounded waits, is refused `PORTAL_SWITCH_BUSY` once; a switch that committed first makes the check STALE, so the lever still wins. Deriving once unlocked and again locked would halve nothing and double the reads; the honest answer is the hold, measured in seconds.
3. What is NOT closed, said plainly: a task that becomes DONE and shared between the make and the publish is not named by the PDF — the fingerprint catches it (the task list differs) and refuses, which is the conservative direction; a NEW such task committed in the milliseconds between the derive and the flip is not locked and not caught — the PDF then omits one line the client could see on their portal. Omission is safe. The dangerous direction — a named row going private — is locked.

`hideReport`, `editReport`, `deleteReport`: unchanged. A hidden made report that is published again is checked again (R3).

## 4. The PDF — `src/documents/pdf/made-report-pdf.tsx`

`@react-pdf/renderer`, the invoice's and the contract's tooling and traps: `"use no memo"`; loaded with a dynamic `import()` from the service, never re-exported from a module index; Inter through `registerPdfFonts`; no `lineHeight` on the page (the foot's `render` page number); a hard break drawn as a line of its own, never a newline (a newline is laid out in Helvetica); `next.config.ts` traces the fonts into `/clients/**` (the action runs under the client's Reports route). Labels from a `reportPdf` namespace in `en.json` / `sv.json` through `createTranslator`, in the REPORT's language.

**The page (A4):** an eyebrow ("Monthly report" / "Månadsrapport"), the month as the title ("September 2026" / "september 2026"), the client's name and, under it, "From {agency}" / "Från {agency}" and the day it was made (the workspace's zone). Then:

- **Summary** — the team's words, each line a `Text` (R4's trap), when given.
- **Per project, in the ticked order**: the project's name as a heading with its health in words ("On track" / "Enligt plan" — `reportPdf.health.*`) when it has an update in the month; **"What got done"** — a bullet per task: the title and the day it was finished ("12 Sep" in the report's language); **"Progress updates"** — each update as a block: "Update #4 · 12 September 2026 · On track", its title, its period when it has one, its note when it has one, then its sections each under its heading (the five fixed keys in the report's language — the portal's `updates.sections.*` words — or the custom title) with the body walked. A project with neither in the month: one line, "Nothing finished or published this month".
- **Coming next** — the team's words, when given.
- **The foot**, fixed: "{agency} · {client} · Monthly report September 2026" and "Page x of y".

**The body walker** draws the description schema a section is normalised to (`normalizeUpdateSection` → `descriptionExtensions`): paragraph, heading 1–3 (drawn two sizes under the project's), bullet and numbered lists (markers as the editor shows them — the contract's `listMarker`), **task lists** (`[x]` / `[ ]` before the item — ASCII, never a glyph Inter may lack), blockquote, code block (as text on a band), rule, hard break; marks bold, italic, underline, strike, code (plain) and link (underlined, the href as the link). An unknown node is drawn as its text, never dropped. The contract's walker stays its own (its archive drawing is frozen under `CONTRACT_PDF_TEMPLATE_VERSION`); this one is `src/documents/pdf/rich-text.tsx`, the report's.

`MADE_REPORT_TEMPLATE_VERSION = 1`, recorded on the row and in the audit; raised whenever the drawing changes.

**No numbers strip** (c), no milestone, no file, no speed, no member's name, no task number ("ACME-347" says how many tasks the agency keeps — the slice-102 review), no hours.

## 5. The team's side

**Client → Reports tab**, a **Make a report** card (`make-report.tsx`), drawn on `canMake = uploadReports && project:view` and above "Add a report":

- the month (the existing `MonthPicker`, `latest` = the month before the workspace's current one — a report covers an ENDED month (g)), starting there;
- the language (`NativeSelect`: Svenska / English), starting at `invoiceLocaleFor(client)`;
- the projects (`NativeCheckbox` per project the client can see — portal on, not archived — all ticked; "The client sees these projects in their portal"); none ticked disables the button;
- Summary and Coming next (`Textarea`, 2 000 characters each, counted);
- the standing lines: "The report shows only what the client can already see in their portal: the tasks finished in the month and the progress updates published, for the projects you tick. No hours, no files." and "Only your team can see it until you publish it.";
- **Make report** → `makeReportAction` in a transition ("Making…"); success toasts "Report made. Only your team can see it until you publish it." and refreshes; a refusal is toasted and the form keeps its values (an action failure never looks like a revert).
- With nobody at the client who could sign in: a `Callout` instead of the form — "Nobody at the client can use the portal yet. Invite someone under Contacts, then make a report." — and no button.

**The table**: a made report's row carries "Made in Fortleva" after its name, muted (`data-testid="report-made"`). Publish… is the same dialog; its refusal (`MADE_REPORT_STALE` et al.) is the toast, and the row stays private. The empty state's action points at the Make card when `canMake`, else at the upload card.

`listClientReports` returns `made: boolean` (the relation's presence). `ClientDetail.caps` gains `makeReports`.

## 6. Catalogue changes

- Domain errors: `MADE_REPORT_NO_AUDIENCE`, `MADE_REPORT_PROJECT_HIDDEN`, `MADE_REPORT_TOO_LARGE`, `MADE_REPORT_STALE`, `MADE_REPORT_BUSY`, `REPORT_PDF_UNAVAILABLE` — each with its sentence in both locales.
- Audit: no new action — `document.created` with `made: true` and the fingerprint; `document.visibility_changed` with `made: true` and the fingerprint. Never the texts.
- Permission codes: none (making = `document:upload` + `report:upload`; the form also wants `project:view`). No seed.
- Portal capabilities: none.

## 7. Tests

**`src/documents/made-reports.dbtest.ts`** (prefix `mrpt-`, registered in `DBTEST_PREFIXES`; `LocalDiskTransport` for the bytes, as `reports.dbtest.ts`):

- fixture: Acme with a main contact and a collaborator (English), Beta with none who can sign in; three projects — P1 (portal on), P2 (portal on, Tasks hidden), P3 (portal off); on P1 shared tasks DONE in August, DONE in July, DONE in August but INTERNAL (a sentinel title), one re-opened; on P2 a shared DONE task and a DONE request; updates on P1: PUBLISHED + shared in August (a sentinel-free body with a heading, a list, a checklist and a link), PUBLISHED but INTERNAL in August (a sentinel), PUBLISHED in September, a DRAFT;
- **making**: a REPORT document, INTERNAL, the month, the localised name; a GENERAL COMMITTED `application/pdf` object whose bytes begin `%PDF-` and whose sha256 is the row's; the `made_report` row (locale, texts, the ids, `asContactId` = the collaborator, the fingerprint, template 1); `storageUsedBytes` grew by the size; the `document.created` audit carries `made: true` and never a text; the content names P1's August shared DONE tasks only (not July, not INTERNAL, not re-opened), P2's request alone, the August shared update alone; the sentinel walk over the content and the row;
- **refusals**: the current month; `de`; a 2 001-character summary; no project; P3 ticked; Beta (no audience); an employee (`FORBIDDEN`); an archived client (`ARCHIVED`);
- **publishing**: unchanged → published, stamped, mailed, audited with `made: true`; a task made private → `MADE_REPORT_STALE`, still INTERNAL, no audit; shared again → published; hide → unpublish the update → publish → STALE; the project's portal off → STALE; the as-contact paused with the main contact still there → published; both paused → `MADE_REPORT_NO_AUDIENCE`; an UPLOADED report with a private task on the client → publishes (no check);
- **the database**: the locale CHECK; the lengths; the hash shape; the kind guard (a `made_report` on a GENERAL document); the frozen trigger (an UPDATE refused); the posture loop (`isolation.dbtest.ts`) covers the table by registration;
- **the portal**: a published made report is listed and its PDF resolves for download (`resolvePortalDownload`) under the collaborator; an INTERNAL one is not.

**Unit**: `made-report-content.test.ts` (the canonical hash is key-order independent; the month's window in a zone); `made-report-pdf.test.ts` (sv and en render, Inter embedded, every node of the section schema, a long report over several pages); the last ended month is `defaultReportMonth` (already tested); the i18n parity test covers the new keys.

**e2e `reports.spec.ts`** gains: the owner's tab shows the Make card (last month, the language select at Swedish for a Swedish client, the fixture's project ticked, the two text fields, the two standing lines) and the seeded MADE report's row with "Made in Fortleva"; Publish… on it → the dialog → "Published." → the contact's Reports page lists it → Hide (put back). Pressing Make is `test.skip(!HAS_R2)`. `seed-cli` makes one (INTERNAL) through `makeReport`, in-process. The `client-reports` visual stop now photographs the card (no new stop).

## 8. Docs

DATA_MODEL §6.8 (the enum note: the monthly report Fortleva makes is a REPORT with a `made_report` row; the progress-update PDF and the tidrapport still take a new kind; the `MadeReport` model); AUTHZ.md §3 notes (making = the upload's two codes + `project:view` for the form; publishing a made report checks it); UI.md (the client page's Reports tab: the Make card, the marker); SECURITY.md §5.1 (the publish check as a tripwire of the "frozen names" kind); PLAN §0 and Phase 7's first line; OPEN_QUESTIONS C95 → built; `next.config.ts`'s tracing comment.

## 9. Order of work

1. Migration (pre-apply review by a fresh agent; `migrate status` first; apply with `migrate deploy`; verify the ledger checksum).
2. Prisma schema + generate; the registry; the two projection options; `made-report-content.ts`; the PDF; `made-reports.ts`; the publish check in `reports.ts`; the domain errors and messages.
3. The card, the marker, the action; en + sv.
4. Tests (dbtest, unit, e2e, the seed).
5. Gates once each (typecheck, ESLint, unit, build, the new dbtest + `reports.dbtest.ts` + `isolation` locally, the e2e `reports` locally on port 3457); then `/code-review` + `/security-review` by fresh read-only agents; fix or disposition; commit; push; read CI.

## 10. Migration review (pre-apply)

A fresh agent (read-only, no implementation context) reviewed this document and the draft migration against the code on 2026-10-15, BEFORE the migration was applied. **Its bottom line: no way found for a contact principal to read or write the table, nor a tenant another's rows; the SQL and the Prisma model match; safe to apply once the MEDIUM is fixed.** One MEDIUM, two LOW, three NIT — each taken or recorded:

| # | Finding | Disposition |
|---|---|---|
| M1 | The triggers' `CONSTRAINT = '…'` never reaches Prisma's error meta — the pg adapter forwards a constraint name for a foreign-key violation only — so the design's two trigger dbtests, written in the `meta(...).toContain(name)` shape, would fail | TAKEN — the token is the message's first word (`made_report_kind_guard: …`, `made_report_frozen: …`), as every other guard in the schema does it; the two tokens do not contain one another; the migration's comment says why |
| L1 | `made_report_kind_guard()` set no `search_path`, so a temp table named `document` on the connection would be read instead (the invoice guards pin theirs) | TAKEN — `SET search_path = public, pg_temp` |
| L2 | "The document's kind never changes after insert" is an app convention, not a database fact (nothing freezes `document.kind`) | TAKEN — reworded: nothing in the app changes it, and slice 115's search feed relies on the same |
| NIT | `UPDATE` granted on a frozen table — a second belt would be to drop it | RECORDED — the precedent (slice 118) grants all four; the trigger is the belt, and a dbtest proves it |
| NIT | The FK's name differs from this document's §1.2 | TAKEN — §1.2 now says Prisma's name |
| NIT | `ON UPDATE CASCADE` on both FKs meets the frozen trigger — a cascaded key change would be refused | RECORDED in the migration's comment (ids never change) |

Checked and found clean, by the reviewer's own list: contact and cross-tenant access (the policy pair byte-for-byte the class-A precedent; a portal `include` runs a separate SELECT under the contact principal and returns null); SQL vs Prisma (every column, type, nullability, FK action; the composite target exists); the triggers' fail-closed shape; the CHECKs (`cardinality('{}')` is 0; CHAR padding is spaces, which the regex rejects); precedent parity (grant, ENABLE + FORCE, the posture loop by registration); the hard-delete cascade (the harness and `reports.dbtest.ts` delete `document` as `app_platform`; nothing in the product hard-deletes one; the export derives from `MODEL_CLASSES.tenant`, so the table is dumped by itself); hygiene (DDL only, identifiers under 63 characters).

Applied to dev with `migrate deploy`; the ledger's checksum verified equal to the file's (`4f69bf8f…972a`).

## 11. Code and security reviews

Two fresh agents, read-only, in parallel, on the finished tree (every gate already green): **neither found a HIGH, nor any path by which a contact sees, downloads or is told about anything their portal would not show them** — every drawn value traces to a portal projection under the synthesised contact principal, the named rows are share-locked through the flip, and the one open window (a named row made private AFTER the publish commits) is an uploaded report's too. Every finding taken or recorded:

| Review | # | Finding | Disposition |
|---|---|---|---|
| code | M1 | The check never confirmed its locks landed: a locking SELECT under RLS leaves a hidden row out rather than refusing, so the "named rows are locked" invariant rested on nothing | TAKEN — the row count must equal the ids, else `MADE_REPORT_STALE` (§3.2) |
| security | M1 | The check is a multi-row `work_item` locker outside the project's rank queue, which `rank-lock.ts` forbids and the cited time-report precedent does not do: a bulk edit (scan order) could cycle with the id-order share-locks and, as the victim, has no retry | TAKEN — `lockProjectRanks` for each named project in sorted order before the first row lock; the ledger in `rank-lock.ts` names the new queued writer (§3.2) |
| code | L1 | Two "last month" assertions in UTC against a Stockholm workspace fail for two hours on a month's last day | TAKEN — the e2e reads the month in Europe/Stockholm; the dbtest refuses the month AFTER the workspace's current one and the current one |
| code | L2 | The nested contact transactions borrow a second pool connection while the flip's holds its locks — N publishes at once need 2N; a spent pool is a raw Prisma error | TAKEN in part — P2024 is `MADE_REPORT_BUSY`; the cost recorded (§3.2) |
| security | L2 | The share-locks are held across the whole derivation (seconds), so `setPortalEnabled` pressed meanwhile waits and can be refused `PORTAL_SWITCH_BUSY` once | RECORDED (§3.2) — a switch that commits first makes the check STALE; the lever wins |
| both | L3 | The e2e's planted made report names no rows (the fixture's finished tasks and update land in the current month), so the browser walks the check's path, not its judgement | RECORDED — planting last month's rows on the fixture project moves other specs' counts (the portal timeline's 8 events, the updates page's 2 posts, the health table's "none to Done"); the spec's title and the seed's comment now say what is proved; the content cases are the dbtest's 14 |
| security | NIT-4 | `editReport` could move a MADE report's month after publish, to one its PDF contradicts | TAKEN — the service refuses a month change on a made report; the edit dialog offers the name alone; dbtested |
| security | NIT-5 | `synthesise.ts`'s caller list did not name the two new callers | TAKEN |
| security | NIT-6 | The quota is enforced after the upload (the blob is then deleted) | RECORDED — the size is known only after the drawing; the blob goes on refusal |
| code | NIT | "The ticked order" is the form's name order; "fifty or more"; the card's reset re-ticked from a stale closure; the design named a `lastEndedMonth` that does not exist; R7 said the seed draws the PDF | TAKEN — comments and the design say so; the card keeps the UNTICKED set, so a project that appears after a refresh starts ticked |

A narrow re-check of the fixes by a fresh agent followed: all eight correct, no HIGH or MEDIUM (the queue → project → task → update order matches the time report's; two publishes over overlapping projects queue in one sorted order and FOR SHARE never conflicts with FOR SHARE; the switch takes the project row first, the same order; the dedupe cannot refuse a legitimate publish; the two month computations hold on every day of the year, December and January included). Its one LOW — the edit dialog's description still promised a month change on a made report — TAKEN (`clients.reports.edit.descriptionMade`); its NIT, a tautological e2e count, TAKEN.

Checked and found clean, by the reviewers' own lists: every AGENTS.md trap (no `Promise.all` in a transaction, no `<form action>`, no module `let` in a component, the fingerprint over bodies read back from Postgres, one line per react-pdf Text, no plural branch starting with a word, en/sv key parity); the month agreement between the picker, the service and the window; the narrowings compose without overriding a key; the lock shape and its retries; the write path (blob first, one transaction, blob deleted on failure, quota, gates re-asked); what is drawn versus what the portal shows (nothing on the never-list — no phase, target date, reply, metrics, member id, task number, label, estimate); the frozen-names race (every writer that could hide a named row UPDATEs a locked row; the fan-out's `SKIP LOCKED` legs skip a locked row and the reconcile heals; omission the only unlocked direction); whose view (the audience query byte-identical to the preview's, `preferId` bound to the client's eligible list); the member-side gates in sequence; the two texts in no audit row, log, outbox or notification; the download through the existing broker; `made_report` under `portal_deny`, selected by no portal projection; the builder set and the system-principal pins unchanged.
