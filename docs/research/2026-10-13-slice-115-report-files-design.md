# Slice 115 — CLIENT REPORT FILES (Phase 6 step 1; founder decision C91)

*Design written 2026-10-13 by the building session, before any code; reviewed by a fresh agent before the migration is written (§9 records the review and what was done). C91's answers are in `docs/OPEN_QUESTIONS.md`; this document is how they are built.*

## 0. What C91 decided, and the readings this design takes

| C91 | Decision | Reading taken here |
|---|---|---|
| (a) | Phase 6 next, and **client report files first** | Phase 6's first scope line (PLAN): uploaded report files, published to the client, listed on a per-client reports surface. CrUX charts and the portfolio table are later slices. |
| (b) | Clients find reports on **their own Reports page** in the portal, shown once there is one, newest month first; reports **leave the Files page** | `/portal/reports` (+ its View-as twin), a nav entry drawn only when this contact can see at least one report (the Logins/Invoices/Contracts shape). `listPortalDocuments` stops returning `REPORT`, so the Files page's "Reports" group goes. |
| (c) | **Everyone with portal access** sees reports (main contacts and the others) | A new portal capability `portal.report.view`, held by BOTH profiles (`CONTACT_COLLABORATOR` written out, `CONTACT_PRIMARY` derived) — it is AUTHZ.md §8's row, until now "v2", brought forward with the feature. |
| (d) | Publishing **emails** the people who can see it ("Your September report is ready", a link), and the **Monday summary counts it** | One outbox row per person per report, made in the publish's own transaction; **checked again AT SEND, as the person** — a report hidden or deleted, a person paused, the portal or the reports module switched off since, sends nothing. A new "reports" line in the weekly summary, counted as the person. |
| (e) | A report covers **a month** | `document.report_month` (a `date`, the month's first day). The team picks month and year; the client sees "September 2026". |

**Read by the design, not asked (stated to the founder when the slice is reported):**

- **A report belongs to the CLIENT, never a project.** The founder's question was about a monthly report for a client; a project's report can be named so ("SEO — September"). The database holds it (§2). Per-project reports can come with the speed charts, which ARE per project.
- **No new versions of a report.** A mistake is fixed by hiding (or deleting) it and uploading the corrected file. A corrected report is a new report, so its people are emailed again, which is right: what they were told about changed.
- **The team's side is a Reports tab on the client page** (beside Files), the only place a report is listed, uploaded, published, hidden, edited or deleted. Reports leave the team's Files lists too, so a file never appears in two places with two sets of controls.
- **Reports are not in search** (the feed skips them, §2.3) — a document hit links to a Files tab, where a report is not. Searchable reports can come when someone asks.
- **Publishing asks first**: a dialog says who will see it and that they get an email. Hiding acts at once (it takes access away — never the dangerous direction).

## 1. The storage decision: a report IS a document

DATA_MODEL §6.10 designed a `PerformanceReport` row pointing at a `Document`, each with its own `visibility` ("this row's visibility gates the chart/listing; the file's applies to the file"). **Not built that way.** Two visibilities for one report are two places to get the worst bug wrong, and a listing row visible over a private file (or the reverse) is a state the product would have to explain. A report file is a `Document` of `kind = REPORT` — the kind the enum has carried since Phase 2 for exactly this — with its month as a column. So:

- the portal reaches a report through `portal_gate` on `document`, unchanged — the same gate, policy, download broker, budget and audit every shared file has;
- publishing is the document's own visibility flip, audited `document.visibility_changed` as every flip is;
- `PerformanceReport` remains the CrUX slice's table (kind `CRUX_SNAPSHOT`, `metrics` JSON); its `MANUAL_UPLOAD` kind and `documentId` are dropped from the design. DATA_MODEL §6.10 is amended in this slice.

## 2. Schema — migration `20261022090000_report_files` (DDL only)

### 2.1 Two columns

```sql
ALTER TABLE document ADD COLUMN report_month date;
ALTER TABLE document ADD COLUMN report_published_at timestamptz(6);
```

- `report_month` — the month a report covers, as its first day. NULL on every other kind.
- `report_published_at` — when the report was last made visible to the client (stamped by the publish, every time it goes INTERNAL → CLIENT_VISIBLE). The portal shows it; the weekly summary counts a report as new by it (a file's "new" is its newest version's date — DATA_MODEL §6.18 item 9 — which for a report uploaded on the 30th and published on the 6th would miss it).

No backfill: no row has `kind = REPORT` today (nothing writes the kind — `UploadKind` refuses it; checked against dev before applying, §8). No DML, so no `neon-smoke.yml` dispatch is owed.

### 2.2 The shape, held by the database

```sql
ALTER TABLE document ADD CONSTRAINT document_report_month_shape
  CHECK ((kind = 'REPORT') = (report_month IS NOT NULL));
ALTER TABLE document ADD CONSTRAINT document_report_month_first
  CHECK (report_month IS NULL OR (extract(day FROM report_month) = 1
         AND report_month >= DATE '2000-01-01' AND report_month < DATE '2100-01-01'));
ALTER TABLE document ADD CONSTRAINT document_report_company_level
  CHECK (kind <> 'REPORT' OR (client_id IS NOT NULL AND project_id IS NULL AND attached_to_type IS NULL));
ALTER TABLE document ADD CONSTRAINT document_report_published_shape
  CHECK (report_published_at IS NULL OR kind = 'REPORT');
ALTER TABLE document ADD CONSTRAINT document_report_published_when_shared
  CHECK (kind <> 'REPORT' OR visibility = 'INTERNAL' OR report_published_at IS NOT NULL);
```

The last one makes any writer that shares a report stamp it — the app has one writer (§3.2); the CHECK is the belt for the writer that forgets. `portal_enabled` needs nothing: a client-level document's stamp trigger already sets it TRUE.

A contact can write none of it: `document_portal_columns` (`portal_contact_columns_only`) refuses any column a contact changes outside its named list, which new columns are not on.

### 2.3 Reports out of the search feed

`search_feed_document()` re-created with one added term — a `REPORT` row is treated as deleted (`DELETE FROM search_index …`, `RETURN NULL`) — and nothing else changed (the contact early-return, the upsert's arguments and the trigger's column list are copied from `20260927140000`, verbatim; the trigger itself is not dropped). The kind never changes after insert, so the insert-time decision holds.

### 2.4 Prisma

`reportMonth DateTime? @map("report_month") @db.Date` and `reportPublishedAt DateTime? @map("report_published_at") @db.Timestamptz(6)` on `Document`. No model added, so `MODEL_CLASSES` / `RLS_CLASSES` are untouched (document is already class B); no grant changes (grants are table-level).

## 3. The team's side

### 3.1 Who may do what — every report verb is BOTH a document verb and a report verb

The catalog has carried `report:view` (CMAE), `report:upload` (CMA) and `report:delete` (CM) since Phase 1, declared ahead (`enforcement.test.ts` lists them; this slice moves them to real guards). A report is a document AND a report, so each verb needs both — no new codes, no seed:

| Verb | Codes (all four gates each) | Scope |
|---|---|---|
| See the Reports tab, download a report | `document:view` + `report:view` | the client DIRECTLY (the Files tab's rule) |
| Upload a report | `document:upload` + `report:upload` | direct; client ACTIVE |
| Publish / hide | `document:change_visibility` + `report:upload` | direct |
| Edit name and month | `document:edit` + `report:upload` | direct |
| Delete | `document:delete` + `report:delete` | direct |

Templates: the owner and a manager do everything; an admin all but delete; an employee sees and downloads. `requireAccess` is awaited for each code in turn (AGENTS.md: never a `Promise.all` leg). The client page's caps (`CAP_CODES` in `src/clients/service.ts`) gain the three `report:*` codes and answer the table above.

### 3.2 The service — `src/documents/reports.ts`

- `listClientReports(ctx, clientId)` — the client's live reports, month newest first, then name; each with its newest version's size and type, visibility and `reportPublishedAt`.
- `commitReportUpload(ctx, { fileObjectId, clientId, month, name? })` — the existing presign hop (`createUpload`, `document:upload`), then this commit: `report:upload` too, direct scope, client ACTIVE, month validated (a real month, not after the workspace's current month — a report for next month is a typo); creates `kind REPORT`, `INTERNAL`, `report_month`, version 1, audited `document.created` with `{ kind: "REPORT", reportMonth }`. Reuses `commitFileObject` — no second copy of the HEAD-verify.
- `publishReport(ctx, documentId)` — the gates; the flip is a compare-and-set (`updateManyAndReturn` … `WHERE visibility = 'INTERNAL'` — two publishes at once flip it once); if already CLIENT_VISIBLE, nothing (idempotent, no second mail); else `visibility = CLIENT_VISIBLE`, `report_published_at = now()`, audit `document.visibility_changed` `{ from, to, kind: "REPORT", mailed: n }`, and the mails (§4.1) — all ONE transaction. Returns `n`, so the toast can say "Published — 3 people will get an email" (or "Published — nobody at Acme has portal access yet").
- `hideReport(ctx, documentId)` — back to INTERNAL; audit `document.visibility_changed`. Mails still queued for it are dropped at send (§4.2).
- `editReport(ctx, documentId, { name, month })` — audited `document.report_edited` `{ from: { name, month }, to: { name, month } }` (new catalog action: one row for one edit; `document.renamed` stays the Files path's).
- `deleteReport(ctx, documentId)` — `softDeleteDocumentsInTx`, the existing cascade; audited `document.deleted`.

Each verb restates `kind: "REPORT"` in its `where`, so a report verb can never act on another kind.

### 3.3 The Files paths stop touching reports

- `listDocuments` adds `kind: { not: "REPORT" }` — the /files page, the client's and project's Files tabs and a task's attachments never list one.
- `renameDocument`, `changeVisibility`, `softDeleteDocument`, `addVersion` answer NOT_FOUND for a REPORT row (`requestDocumentSignoff` already refuses anything but a DELIVERABLE) — one writer for a report's name, visibility, life and bytes, which is also what keeps `report_published_at` honest.
- `getDownloadUrl` asks `report:view` as well when the row is a REPORT (the Reports tab downloads through it).

### 3.4 Screens

**Client → Reports tab** (`/clients/[id]/reports`, after Files; drawn on `viewReports`):

- A table (the Assets tab's family): **Month** ("September 2026"), **Report** (name + type and size), **Status** — `Only your team` (the INTERNAL chip every Files row wears) or `Published 6 Oct` — and a row menu: Download · Publish… / Hide from client · Edit · Delete (danger, with its question).
- **Publish…** opens a dialog: "Publish the September 2026 report? Everyone at Acme with portal access can see it, and they'll get an email." `Publish` / `Cancel`. Called in a transition with a typed `ActionResult` and a toast (AGENTS.md: a failure never looks like a revert).
- **Add a report** card: month + year selects (two `NativeSelect`s, defaulting to LAST month — a report covers a finished month), an optional name (defaults to the file's name), the file drop field, and the standing line "Only your team can see it until you publish it." Upload is the existing three hops; the commit is `commitReportUploadAction`.
- Empty state: "No reports yet" + "Upload a monthly report and publish it when it's ready. The client finds it under Reports in their portal."
- An archived client: read-only (no Add, no Publish), as the Files tab.

## 4. The client's side

### 4.1 The publish mail — made in the publish's transaction

`enqueueReportMails(tx, tenantId, clientId, documentId)` (`src/documents/report-mail.ts`): every contact of the client with `portalStatus ACTIVE`, invited, at a client not archived, whose address is not suppressed — the weekly summary's admission — gets one outbox row: key `report:<documentId>:CONTACT:<contactId>` (`skipDuplicates`: a person is told about a report ONCE, however often it is hidden and published again), kind `report.published`, the person's locale (else the workspace's), `params: { documentId }` only. The row names nothing; the month is read at send.

### 4.2 Checked again at send, as the person

The outbox claims a `report.published` row like a client summary: the person's standing re-read in the claim (active, invited, client not archived, the address the row was made for, the workspace sending); then, AFTER the claim and outside its transaction, as the person (`synthesiseContactPrincipal`), `portalReportMonth(principal, documentId)` — the portal's own projection — answers the report's month or null. Null (hidden, deleted, the person paused, the portal or reports module off, a profile without the capability) → `SKIPPED`. Otherwise the mail:

> **Subject:** Your September 2026 report is ready
> Your agency published your report for September 2026 in your client portal.
> Open it: <portal>/portal/reports

Swedish: "Din rapport för september 2026 finns nu" / "Din byrå har publicerat din rapport för september 2026 i kundportalen." — no agency, client or file name (C68 (e)); the month is the reader's own and names nothing of the agency's. No unsubscribe link: a report is a single event the agency chose to send, like a contract's mail (the design review's L6 — a person who does not want them can only report the mail as spam, which then blocks their contract mails too; accepted, and said to the founder). The renderer THROWS without a month checked at send (L1: a row that reached the generic path would go FAILED, never out). A mail the outbox DROPS unsent is tagged (`report_unwanted` at the claim, `report_not_visible` at the check) and a later publish deletes and makes it again, at the person's address now (L2). The window between the check and the send — at most the send budget, eight minutes — is the one the summaries accept (L7). And one race fails CLOSED (the security review's LOW-1, recorded): a publish that lands in the milliseconds between a drain's NOT-visible check and its finalise finds that person's row still SENDING, so it neither deletes nor re-makes it, and the drain then drops it — that person is not emailed about the re-published report (they still see it in the portal and the Monday summary). The outbox's existing summary "recount" pass becomes a pass over two kinds of item (`summary` | `report`), sharing its budget, its lease rules and its error handling.

### 4.3 The projection — `src/documents/portal.ts`

- `listPortalReports(principal)` — `portal.report.view` AND `portal.document.view`, both through `authorizePortal`; documents of the contact's client, `kind REPORT`, `CLIENT_VISIBLE`, `portal_enabled`, not deleted (the gate's terms restated), selecting id, name, `reportMonth`, `reportPublishedAt` only; the newest committed version through `readPortalFileVersions` (no committed bytes → dropped, the Files rule); month newest first, then published newest first, then name. Cap 200.
- `portalReportMonth(principal, documentId)` — the same gate on one id; the month or null; never throws an AuthzError (refused → null).
- `listPortalDocuments` adds `REPORT` to the excluded kinds; `PortalDocumentKind` loses `REPORT`.
- `resolvePortalDownload` (`portal-writes.ts`): when the proven row is a REPORT, `portal.report.view` is asked too, under the contact's principal (one `select: { kind }` on the id the gate already admitted).

### 4.4 Screens

- **Nav**: "Reports" after Files, drawn when this contact can see at least one report (`reports-shown.ts`, a count under their principal, once per request — `invoices-shown.ts`' shape).
- **`/portal/reports`** + **`/view-as/reports`** (one `PortalReportsView`, as Files; the twin is gated, like `/view-as/files`, by View-as's own permission, not `report:view` — it shows only what the agency already published to that client; the design review's L5): month groups newest first ("September 2026"), each report a row with its name, "Published 6 Oct 2026", type and size, and Download (the existing `downloadDocumentAction`, `returnTo=/portal/reports`). Empty state for a direct visit: "No reports yet — your agency hasn't published any reports." A refused download returns with the Files page's two words.
- **Weekly summary**: a new NEW line, `reports` — "1 new report from your agency" / "# new reports from your agency" (sv "1 ny rapport från din byrå" / "# nya rapporter från din byrå"), counted as the person by `reportPublishedAt` inside the window.

## 5. Catalogue changes

- Portal capability `portal.report.view` (modules `portal`, `reports`), both profiles; `capabilities.test.ts`' pins; AUTHZ.md §8's row → v1 (slice 115).
- Audit action `document.report_edited` (TENANT).
- No permission codes, no seed (the three `report:*` exist; `enforcement.test.ts`' DECLARED_AHEAD loses them).

## 6. Tests

**`src/documents/reports.dbtest.ts`** (prefix `rpt-`, registered in `DBTEST_PREFIXES`):

- the CHECKs: REPORT without a month; a month on another kind; a mid-month day; a project or an anchor on a REPORT; `report_published_at` on another kind; a CLIENT_VISIBLE REPORT without it — each refused by the database;
- the feed: a REPORT leaves no `search_index` row;
- upload → INTERNAL REPORT with its month; an employee refused (no `report:upload`); a member not directly on the client refused; an archived client refused;
- publish → visible, stamped, audited, ONE outbox row per admitted person — none for a paused, an uninvited or a suppressed one, none for another client's; publish twice → still one row each; hide → publish → no second row; a person invited between → gets theirs;
- edit audited; delete needs `report:delete` (an admin refused);
- the Files paths: `listDocuments` omits reports; `changeVisibility`, `renameDocument`, `softDeleteDocument`, a new version → NOT_FOUND on a report;
- the portal: a published report listed for a main contact AND a collaborator; an INTERNAL one not; another client's contact sees none; `listPortalDocuments` omits reports; the reports module off → refused; download of a REPORT refused without `portal.report.view` (the module off) while a GENERAL file still downloads;
- the outbox: a queued report mail drained → SENT (dev transport) with the month in its text; hidden before the drain → SKIPPED; the person paused before the drain → SKIPPED;
- the weekly summary counts a report published in the window, as the person.

**Unit**: the mail's render (en/sv, no name); the client summary's new line; `capabilities.test.ts`; the month validation.

**e2e `e2e/reports.spec.ts`** (after the design review's M2 — CI has no R2, so the bytes cannot move there): the fixture SEEDS last month's report published and a draft INTERNAL (`seed-cli`, through the real services); the owner's tab shows both with their chips, the Files tab neither; Publish… on the draft → the dialog → the toast → the contact's Reports page shows it; Hide → gone again (the draft is put back as found); the contact's nav offers Reports, the page shows the published report under its month and never the draft, the Files page neither. The upload and the download are `test.skip(!HAS_R2)`, as `portal-files.spec.ts`'s download is. `/view-as/reports` joins `e2e/view-as.spec.ts`'s byte comparison and `src/authz/portal-view-as.test.ts`'s pins.

**Visual walk**: two stops — `client-reports` (one published, one draft) and `portal-reports` — eight screenshots.

## 7. Docs

DATA_MODEL §6.8 (`Document` — the two columns, the five CHECKs) and §6.10 (amended: MANUAL_UPLOAD is a document); AUTHZ.md §8 (`portal.report.view` v1) and the report verbs' conjunction (§3 notes); UI.md (the client page's tab list, the portal nav); PLAN §0 and Phase 6's first line; OPEN_QUESTIONS C91.

## 8. Order of work

1. Migration (pre-apply review by a fresh agent; check dev has no REPORT row; apply with `migrate deploy`; verify the ledger checksum).
2. Prisma schema + generate; catalog changes; the generic paths' REPORT refusals; `reports.ts`, `report-mail.ts`; the projection; the outbox pass.
3. Screens (staff tab, portal page, nav, View-as), messages en + sv.
4. Tests (dbtest, unit, e2e, visual stops).
5. Gates once each (typecheck, ESLint, unit, build, the new dbtest locally, the new e2e locally on port 3457); then `/code-review` + `/security-review` by fresh read-only agents; fix or disposition; commit; push; read CI.

## 9. Design review

A fresh agent (read-only, no implementation context) reviewed this document and the draft migration against the code on 2026-10-13, BEFORE the migration was applied. **Its bottom line: no way found for a contact to see an INTERNAL report, another client's report, or any part of either; no HIGH.** Three MEDIUM, seven LOW, eight NIT — each taken or recorded:

| # | Finding | Disposition |
|---|---|---|
| M1 | The download's `select: { kind }` by bare id breaks `portal-switch-belts.test.ts` (every `document.findFirst` in `portal-writes.ts` restates `documentGate`) | TAKEN — `where: { id, ...documentGate(principal) }` |
| M2 | The e2e plan cannot run in CI: no R2, so no upload or download | TAKEN — seeded reports, upload/download skipped without R2, View-as comparison and pins added (§6) |
| M3 | REPORT was earmarked for generated PDFs (progress-update PDF, tidrapport — DATA_MODEL's enum comment, `pdfDocumentId`, R1); the CHECKs close that | TAKEN — DATA_MODEL's enum note, §6.16's `pdfDocumentId`, R1 and §6.10 amended: a generated PDF takes a NEW kind when built (two migrations) |
| L1 | The mail's fallback rendered without a month — fail-open if a row ever reached the generic path | TAKEN — the renderer throws; unit-tested |
| L2 | A mail dropped unsent (hidden before the drain, person paused) would never be sent on a later publish — the key refuses it | TAKEN — dropped rows tagged, re-made by the next publish at the person's current address; dbtested |
| L3 | Months in UTC everywhere; "last month" in the workspace's zone | Already so (every label `timeZone: "UTC"`; the page and the service read the workspace's zone) |
| L4 | The toast's zero case must be its own message (the ICU parity trap) | Already so (`publishedNobody`, `publishedToldBefore`, `alreadyPublished` are their own keys) |
| L5 | `/view-as/reports` is gated by View-as's permission, not `report:view` | RECORDED — the Files twin's precedent; AUTHZ §3 notes and the page's comment |
| L6 | No opt-out from report mails | RECORDED (§4.2), said to the founder |
| L7 | A report hidden after the send-time check can still be mailed within the send budget | RECORDED (§4.2) — the summaries' accepted window; the mail names only the month |
| NIT | §3.3's version function names; §3.2's "FOR UPDATE"; `editReport`'s update not restating the kind; §4.2's subject; `report:upload`'s description now also covers publishing; `seed-cli set-visibility` on a REPORT; AGENTS.md's stop count; report mails share the recount budget with Monday's summaries | TAKEN (text, the kind restated, AGENTS.md's count) or RECORDED (the description is the seed's to widen at a release — AUTHZ §3.1; `set-visibility` is never used on a report; the shared budget is harmless — a mail slips to the next drain) |

## 10. Code and security reviews

Two fresh agents, read-only, in parallel, on the finished tree (every gate already green): **neither found a HIGH or MEDIUM, nor any path by which a contact sees, downloads, counts or is emailed about a report that is INTERNAL, hidden, deleted, another client's or tenant's, or behind a switched-off module or a paused person.** Every finding taken or recorded:

| Review | # | Finding | Disposition |
|---|---|---|---|
| code | L1 | A failed upload commit (`DocumentError` — no bytes, wrong size, not pending) escaped `runAction` unmapped and left the form at "Finishing…" for ever | TAKEN — the action maps it to the Files page's words; the form catches any other rejection (letting a server-action redirect pass silently) and says `add.failed` |
| code | L2 | "Everyone with portal access was already emailed" could be said when every address is suppressed, or the mails are only queued | TAKEN — `mailable` (non-suppressed) beside `reachable`; its own toast `publishedUndeliverable`; `publishedToldBefore` reworded ("…has already been sent one, or will be shortly") |
| code | L3 | The dbtest's `getDownloadUrl` assertion was vacuous (scope refused it, and employees hold `report:view`) | TAKEN — the module-off test now proves a member's REPORT download is `DISABLED_BY_TENANT` while a GENERAL file still resolves |
| code | L4 | `editReport`'s update would throw a raw P2025 on a concurrent delete | TAKEN — `updateMany` + NOT_FOUND on zero rows |
| code | NIT | Publish racing a delete toasted "already published"; a no-op hide toasted "Hidden." | TAKEN — `stillThere()` answers NOT_FOUND for a deleted report; `alreadyHidden` |
| both | NIT | The report mail's render sat outside a try — a throw would abort the whole drain | TAKEN — inside a try; a throw fails that row (`finaliseUnsent`) |
| both | LOW/NIT | A publish in the milliseconds between a drain's not-visible check and its finalise loses that person's mail | RECORDED (§4.2) — fails closed |
| security | NIT-2 | `requestDocumentSignoff` answered "not a deliverable" for a report id — an existence oracle to a member without `report:view` | TAKEN — NOT_FOUND, as every Files path; dbtested |
| security | NIT-3 | `documentation` switched off leaves published reports on the portal with nobody able to hide them | RECORDED (AUTHZ §3's note) — the shared files' existing behaviour |
| security | NIT-4 | Reports' absence from search lives only in the trigger | RECORDED (DATA_MODEL §6.19) — a future rebuild must skip `kind = 'REPORT'` |
| code | NIT | Test gaps: the CHECK's anchor half; "a person invited between publishes gets theirs" | TAKEN — an anchored REPORT is refused (the anchor guard answers before the CHECK, which is its belt); the invited-between case is dbtested |
| code | NIT | Swedish: "Vilken månad rapporten gäller"; the mail's subject "… är klar"; `rpt-` placed out of order | TAKEN |

A narrow re-check of the fixes by a fresh agent followed: all correct, no new bug; its one LOW — the anchored-REPORT test passed on any error — TAKEN (it now asserts the guard's own refusal, read from the error's meta).
