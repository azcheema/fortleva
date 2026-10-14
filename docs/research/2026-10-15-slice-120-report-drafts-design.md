# Slice 120 — REPORTS DRAFTED BY THEMSELVES ON THE 1ST (Phase 7 step 2; founder decision C96)

*Design written 2026-10-15 by the building session, before any code; the migration is reviewed by a fresh agent before it is applied (§10 records the review and what was done). C96's answers are in `docs/OPEN_QUESTIONS.md`; this document is how they are built. Slice 119 (`2026-10-15-slice-119-monthly-report-design.md`) built the report this slice drafts by itself — C95 (a) said "a report drafted by itself on the 1st can come later, on top of the button"; this is that.*

## 0. What C96 decided, and the readings this design takes

| C96 | Decision | Reading taken here |
|---|---|---|
| (a) | **Every client who could read one, unless the month was empty** — every client with someone who can use the portal and at least one project shown there; a month with nothing finished and no update published gets no draft; a month that already has a report (drafted, made by hand or uploaded) gets no second one | §2: per sending workspace, for the month that just ended, every ACTIVE client is CONSIDERED once (§1's ledger): a live REPORT for the month → `EXISTS`; nobody who could sign in → `NO_AUDIENCE`; no project with a finished task or a published update in the month (or no portal project at all) → `EMPTY`; else a draft, made exactly as the button makes one (§3). |
| (b) | **One workspace switch, on by default** — Settings → Preferences, "Draft a monthly report for every client on the 1st" | `reports.draftMonthly`, a `TenantPreference` (§4), `settings:edit` as every behavioural key; a new **Monthly reports** card on `/settings/preferences`, shown whenever the plan includes reports. OFF: the drafter considers nobody (no ledger row either — switching it on later drafts the month that then just ended). |
| (c) | **Inbox note to the people who may publish that client's reports** — no email; the team's summary email counts it; "Made in Fortleva" on the Reports tab | A new kind `report.drafted` (COALESCED, no `email`, no push — the renewal draft's shape, C88 (d)), to every ACTIVE member who, checked as themselves, holds the publish verb's and the tab's codes and reaches the client DIRECTLY (§5). The row's marker reads **"Drafted by Fortleva"** for one the job made (`made_by_member_id` NULL) and "Made in Fortleva" for one a person pressed the button for (§6). |
| (d) | **Make a report again with your words; it replaces the draft** — a published one is never replaced | §3.3: `makeReport` (the button) for a month that holds a live, NEVER-published, job-drafted report of the client soft-deletes that draft in the transaction that files the new one, audited `document.deleted` with `{ reason: "replaced_draft", replacedBy }` and the new `document.created` carrying `replacedDraftId`. The card says so under the month (§6). The job itself never replaces anything (`EXISTS`). |

**Read by the design, not asked (stated to the founder when the slice is reported):**

- **R1 — WHEN "the 1st" is.** The drafter runs with every kick of `POST /api/jobs/run` (hourly on Vercel). For a workspace it drafts THE MONTH THAT JUST ENDED in the workspace's zone (`defaultReportMonth(today)`, the button's own default) — so the first kick after local midnight on the 1st is when the drafts appear, and a kick missed (an outage, the budget) is made good by the next, any day of the month. Only that one month: a month the job missed entirely is the button's. Deploying this slice mid-month drafts the month that just ended for every client who could read one — on dev, Naxdor's included — which is the feature doing its job (AGENTS.md's jobs paragraph says so).
- **R2 — WHOSE VIEW, WHICH LANGUAGE, WHICH PROJECTS: the button's defaults.** The content is read AS the client's narrowest contact who could sign in (slice 119's R1, `audienceContact`); the language is the client's invoice language (`invoiceLocaleFor`, C95 (f)'s start); the projects are every one the client sees in their portal (portal on, not archived), in name order (C95 (e)'s "all ticked"). No summary, no "Coming next" — those are the team's words (C96 (d)). A client with more than 25 portal projects, or a month over the drawing's ceilings (slice 119's R6), is `TOO_LARGE` — the button, with fewer projects ticked, is the way.
- **R3 — A DRAFT IS A MADE REPORT, MADE BY NOBODY.** The same `file_object`, REPORT document (INTERNAL, its month, its localised name) and `made_report` row the button writes (slice 119 §3.1), with `created_by_member_id`, `uploaded_by_member_id` and `made_by_member_id` NULL — "NULL = drafted by the job", as a renewal invoice's `created_by_member_id` is. `document.created` is audited as SYSTEM with `made: true, drafted: true`. Everything after — publish (with the check, R3 of slice 119), hide, edit, delete, the mails, the portal page, the Monday count — is slice 115's and 119's, unchanged. The making itself asks no member permission (there is no member); the WRITE transaction asks the workspace's gates instead — the reports module open to the tenant (`moduleOpenUnderSystem`), the switch on, the client still ACTIVE — and the storage quota as any upload (`enforceStorageQuota`).
- **R4 — CONSIDERED ONCE: a ledger, not a re-derivation.** Deciding `EMPTY` costs a derivation as the contact (several transactions); doing that for every client of every workspace every hour would be the cost of nothing. So every (client, month) the drafter looks at gets ONE row in `monthly_report_draft` (§1) with its outcome, and is never looked at again for that month — except `FAILED` (the drawing, the upload or the write threw), which is tried again on later kicks up to three times and then left. The ledger is the job's own record, written as SYSTEM and NOT audited — the fan-out's legs' precedent: the draft's creation IS audited (`document.created`), and a row saying "nothing to draft" is nothing anyone sees. The Reports tab reads it for one sentence (§6).
- **R5 — REPLACING NEEDS THE MAKE CODES, NOT THE DELETE CODES.** The button's replacement (C96 (d)) removes a document the member is RE-MAKING: a never-published, system-drafted PDF for the same client and month, with no words of anyone's in it, which the button regenerates on demand. So it is part of MAKING — `document:upload` + `report:upload` + `project:view` — and an admin (every verb but delete) can replace a draft though they cannot delete a report. Said plainly to the founder; the audit row says `reason: "replaced_draft"` so a log reader sees why a member without `document:delete` removed one. A draft that was EVER published (`report_published_at` set, even if hidden since) is never replaced: a client has read it; two reports for the month then, the team's to tidy.
- **R6 — WHO IS TOLD, EXACTLY.** The members the Reports tab would open for AND who could publish: `document:view` + `report:view` + `document:change_visibility` + `report:upload`, all four gates each, checked as the member (`accessibleCodes`, one call per member, in sequence — the renewals' `receiverResolver`), reaching the client DIRECTLY (tenant-wide scope, or assigned to the client itself — the tab's rule; through a project is not told). Reason `CLIENT_MEMBER` for one assigned to the client, else the NEW reason `REPORT_ACCESS` ("they can publish that client's reports") — a closed set the database holds, so the migration widens `notification_reason_known` (the renewals' precedent). Nobody qualifying → the draft is still made (it waits on the tab). Entity: the DOCUMENT; the inbox names the client and links to the client's Reports tab under the READER's own `document:view` + `report:view` and direct reach (`reportSubjects`, §5), never the fall-through's Files link.
- **R7 — BOUNDED.** 45 seconds a kick across every workspace, workspaces in a fresh random order; at most 100 clients considered per workspace per kick (the rest next kick — the ledger makes it resumable); the drawing's own ceilings. A workspace's failure is logged (its id, the error's name and code — never the message) and the next runs. The drafter sits AFTER the website speed fetch and BEFORE the pushes in the route — it adds files, deletes nothing.
- **R8 — THE BROWSER HARNESS CANNOT RUN THE DRAFTER END TO END** (no file storage, slice 119's R7); the seed plants one job-drafted report (`made_by_member_id` NULL, two months back) and the e2e walks the marker, the card's sentence and the settings switch. The drafter's judgement — every outcome, the replace, the notice, the audit — is the dbtest's.

## 1. Schema — migration `20261025090000_report_drafts` (DDL only)

### 1.1 `monthly_report_draft` — class A, one row per client per month considered

```sql
CREATE TABLE monthly_report_draft (
  id            text NOT NULL,
  tenant_id     text NOT NULL,
  client_id     text NOT NULL,
  month         date NOT NULL,                        -- the first of the month drafted
  outcome       text NOT NULL,                        -- DRAFTED | EXISTS | NO_AUDIENCE | EMPTY | TOO_LARGE | FAILED
  document_id   text,                                 -- the draft, when DRAFTED (attribution, no FK)
  attempts      smallint NOT NULL DEFAULT 1,          -- FAILED is tried again up to 3
  decided_at    timestamptz(6) NOT NULL,
  CONSTRAINT monthly_report_draft_pkey PRIMARY KEY (id),
  CONSTRAINT monthly_report_draft_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT monthly_report_draft_tenant_id_client_id_month_key UNIQUE (tenant_id, client_id, month),
  CONSTRAINT monthly_report_draft_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenant(id) ON DELETE RESTRICT,
  CONSTRAINT monthly_report_draft_tenant_id_client_id_fkey FOREIGN KEY (tenant_id, client_id) REFERENCES client(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT monthly_report_draft_month_first CHECK (month = date_trunc('month', month)::date),
  CONSTRAINT monthly_report_draft_outcome_known CHECK (outcome IN ('DRAFTED','EXISTS','NO_AUDIENCE','EMPTY','TOO_LARGE','FAILED')),
  CONSTRAINT monthly_report_draft_document_when_drafted CHECK ((outcome = 'DRAFTED') = (document_id IS NOT NULL)),
  CONSTRAINT monthly_report_draft_attempts_bounded CHECK (attempts BETWEEN 1 AND 3)
);
```

- **Class A** (`tenant_isolation` + `portal_deny`): the job's ledger; the client never reads it. Registered in `MODEL_CLASSES.tenant` and `RLS_CLASSES.A`, so `isolation.dbtest.ts`'s posture loop covers it by registration.
- Written by the drafter alone, as SYSTEM: INSERT on a decision; UPDATE only of a `FAILED` row (`attempts`, `decided_at`, and the outcome when a retry succeeds). `document_id` is attribution (no FK): the product soft-deletes documents, the harness hard-deletes them, and the row is the record that a decision was taken either way.
- With the client (`ON DELETE CASCADE`): a client hard-deleted (the harness) takes its ledger.
- No DML; no `neon-smoke.yml` dispatch owed.

### 1.2 `notification_reason_known` widened by `REPORT_ACCESS`

The same one-statement DROP + ADD as `20261018090000_renewal_invoices` did for `INVOICE_ACCESS`, with `REPORT_ACCESS` after it; `NOTIFICATION_REASONS` in `src/notify/reasons.ts` gains it in the same place (the order is the precedence: more specific than OWNER, less than CLIENT_MEMBER).

### 1.3 Prisma

```prisma
model MonthlyReportDraft {
  id         String   @id
  tenantId   String   @map("tenant_id")
  clientId   String   @map("client_id")
  month      DateTime @db.Date
  outcome    String
  documentId String?  @map("document_id")
  attempts   Int      @default(1) @db.SmallInt
  decidedAt  DateTime @map("decided_at") @db.Timestamptz(6)
  tenant Tenant @relation(fields: [tenantId], references: [id])
  client Client @relation(fields: [tenantId, clientId], references: [tenantId, id], onDelete: Cascade)
  @@unique([tenantId, id])
  @@unique([tenantId, clientId, month])
  @@map("monthly_report_draft")
}
```

`Tenant` gains `monthlyReportDrafts`, `Client` gains `monthlyReportDrafts`. `MadeReport.madeByMemberId`'s comment gains "NULL = drafted by the job (slice 120)".

## 2. The drafter — `src/documents/report-drafts.ts`, run by `src/jobs/report-drafts.ts`

### 2.1 Discovery (the job file)

`runReportDrafts(now, { budgetMs })`: ONE audited cross-tenant read (`withPlatform`, ids only) — SENDING tenants (`DIGEST_SENDING_TENANT_STATUSES`) holding a contact with `portalStatus ACTIVE` (an audience exists somewhere) — shuffled; each tenant then runs `draftMonthlyReports(tenantId, now, { deadline })` under its OWN system principal, RLS live. Failures counted and logged per tenant; `outOfTime` when the deadline cuts the loop. Returns `{ tenants, considered, drafted, failed, outOfTime }` to the route's JSON.

### 2.2 Per tenant — `draftMonthlyReports(tenantId, now, { deadline, clientCap = 100 })`

1. **System transaction — the gates and the list.** `moduleOpenUnderSystem(tx, tenantId, "reports")` else `{ closed: true }`; `readPreferences` → `reports.draftMonthly` else `{ off: true }`; `timezone` → `today` → `month = defaultReportMonth(today)`; the tenant's name. The candidates: ACTIVE, unarchived clients (`status ACTIVE`, `archivedAt null`) with NO ledger row for the month, or a `FAILED` one with `attempts < 3` — in id order, at most `clientCap`. (A client that joins the ledger as anything but FAILED is never listed again for the month: the UNIQUE key is the whole guard against two kicks drafting twice — a second kick's INSERT of the same (client, month) is a P2002, caught and counted as "someone else decided".)
2. **Per client, in sequence, while time remains:**
   - **System transaction — the facts.** A live REPORT document of the client for the month (any — uploaded, made, drafted) → `EXISTS`. Else `audienceContact(tx, tenantId, clientId)` → none → `NO_AUDIENCE`. Else the client's portal projects (portal on, not archived, by name then id); none → `EMPTY`; more than 25 → `TOO_LARGE`. Plus the client's name and invoice language.
   - **As the contact** (outside any transaction): `synthesiseContactPrincipal` + `deriveAsAudience` (slice 119's path, by the same functions). `MADE_REPORT_TOO_LARGE` → `TOO_LARGE`; `MADE_REPORT_NO_AUDIENCE` (the person paused meanwhile) → `NO_AUDIENCE`. Every project without a task and without an update → `EMPTY`.
   - **The draft:** `fileMadeReport(…)` — slice 119's steps 3–5 lifted into a shared function (§3.1) — under the SYSTEM principal with `madeBy: null`; its write transaction re-asks the tenant gates (module, switch, client ACTIVE) and the quota, writes the four rows, the audit (SYSTEM) and the inbox notice (§5), all in the one transaction.
   - **The ledger row** — its own short system transaction AFTER the outcome is known: INSERT (or the FAILED row's UPDATE). A draft filed and a ledger INSERT that then fails (P2002 from a parallel kick) leaves two drafts for the month — two kicks of one route in one minute, which Vercel does not do; said, not solved (the ledger is written after the draft so a crash between them re-tries and finds `EXISTS`).
   - A throw anywhere above that is not one of the named outcomes → `FAILED` (attempts +1), logged with the client's id and the error's name and code.
3. Returns `{ considered, drafted, byOutcome, failed, closed, off, outOfTime }`.

Reads in SEQUENCE on every transaction (AGENTS.md's `Promise.all` trap); the receivers resolved per member in their own transactions (the renewals' resolver, verbatim in shape).

## 3. The shared making, and the replace

### 3.1 `fileMadeReport` — slice 119's steps 3–5, for two callers

`src/documents/made-reports.ts` keeps `makeReport` (the button; its member gates unchanged) and gains the internal `fileMadeReport(input)`:

```ts
{
  tenantId, principal,                 // { type: "member", id } | { type: "system" }
  madeBy: string | null,               // the member, or null = the job
  clientId, clientName, agencyName, month, locale, timezone, today,
  summary, comingNext, projectIds, contact, content, now,
  beforeWrite: (tx) => Promise<void>,  // the caller's gates, re-asked in the write transaction
  afterWrite?: (tx, documentId) => Promise<void>,  // the job's notice; the button's replace
}
```

It draws (`renderMadeReportPdf`), uploads, then in ONE transaction: `beforeWrite`, the quota, the `file_object` / `document` / `made_report` rows (`createdByMemberId: madeBy`, `uploadedByMemberId: madeBy`, `madeByMemberId: madeBy`), the storage count, `document.created` with `{ …slice 119's metadata, drafted: madeBy === null }`, then `afterWrite`. The blob is deleted on failure, as today. `makeReport`'s `beforeWrite` is `assertMayUploadReport`; the drafter's is the tenant gates (§2.2).

### 3.2 Audit under SYSTEM

`record` names the transaction's principal: a draft's `document.created` is `actorType: SYSTEM`, as a renewal draft's `invoice.created` is. The notice is `emit` under the same transaction (the renewals' precedent).

### 3.3 The replace (C96 (d)) — `makeReport` only

In `makeReport`'s prep transaction: the client's live REPORT documents for the month with a `made_report` row whose `madeByMemberId IS NULL`, `visibility INTERNAL` and `reportPublishedAt IS NULL` → `replaceIds` (normally one; every such draft goes). In the write transaction (`afterWrite`): `softDeleteDocumentsInTx(tx, tenantId, replaceIds, now, { reason: "replaced_draft", replacedBy: documentId })` — the function's `why` widened from `WorkItemDeletedReason` to a union with this shape, so the `document.deleted` row carries it; the comments cascade runs as for any delete (a draft has none). The new `document.created` metadata carries `replacedDraftIds`. A draft that was deleted or published between the read and the write is simply not in the UPDATE's result (the function's own compare-and-set) — then two reports, the team's to tidy. Returns `{ documentId, replaced: number }`; the card's toast says "Report made — it replaced Fortleva's draft." when one was.

## 4. The switch — `reports.draftMonthly`

`src/preferences/config.ts`: `ReportPreferences { draftMonthly: boolean }`, `REPORT_PREF_KEYS`, `REPORT_DEFAULTS = { draftMonthly: true }`, `TenantPreferences.reports`; `materializePreferences` reads it with `bool`. `src/preferences/service.ts`: `reports: z.object({ draftMonthly: z.boolean() }).partial()` on the patch, the upsert loop as `MAIL_PREF_KEYS`' — `settings:edit`, audited `preference.changed` by the existing path. The action reads `reports.draftMonthlyMarker` / `reports.draftMonthly` (the mail switch's marker convention). The page: a **Monthly reports** card (`settings.preferences.reports.*`) after "Emails to your clients", shown when `entitled.reports`: one checkbox — "Draft a monthly report for every client on the 1st" with the hint "For every client with someone in the portal: what got done and the progress updates of the month that just ended, in the client's language, private until someone on your team publishes it. A month with nothing to show gets no draft."

## 5. The notice — `report.drafted`

- `src/notify/catalog.ts`: `"report.drafted": { audience: "MEMBER", class: "COALESCED" }` — no `email` (C96 (c)), so no push either (`isPushKind` wants INSTANT); the team's summary counts it (C68 (h)).
- `kind-copy.ts` `reportDrafted` → `inbox.kinds.reportDrafted` "A monthly report is drafted and waiting" / "En månadsrapport är utkast och väntar"; `kind-icon.ts` → `FileChartColumnIcon` (the Reports tab's glyph); `templates.ts` (never mailed; copy carried): "Fortleva drafted a client's monthly report. Read it, add your words if you like, then publish it."; `digest.ts` `SUMMARY_LINES`: "1 monthly report is drafted and waiting to be published" / "# monthly reports are drafted and waiting to be published", sv "1 månadsrapport väntar på att publiceras" / "# månadsrapporter väntar på att publiceras".
- `emit` with `entity: { type: "Document", id }`, `clientId`, `params: { clientId, documentId, month }` (ids and a month — never a name), `dedupeKey: report.drafted:${documentId}`.
- **The subject** — `src/documents/report-subjects.ts`: `REPORT_SUBJECT_KINDS = ["report.drafted"]`, `reportSubjects(tx, tenantId, actor, refs)`: ONE `accessibleCodes` for `document:view` + `report:view`; without both → nothing; `resolveScope` → direct reach (all, or the client among `directClientIds`); the documents live (`deletedAt null`, kind REPORT) with their client's name → `{ title: client.name, href: /clients/${clientId}/reports }`. Hooked into `inbox.ts`'s `resolveSubjects` after the Fortnox block and before the fall-through (which would otherwise name the client and link the FILES tab, which lists no report).

## 6. The team's side

- **Reports tab, the table**: `ClientReport.made` stays; `drafted: boolean` (the `made_report` row's `madeByMemberId === null`) draws "Drafted by Fortleva" (`clients.reports.table.drafted`) in the marker's place, same `data-testid="report-made"`.
- **The Make a report card**: `readMakeReportForm` returns `draftMonths` (months `YYYY-MM-01` holding a live, never-published, job-drafted report) and `emptyMonths` (ledger `EMPTY` rows, the last 12 months). Under the month picker: for a month in `draftMonths`, a `Callout` (info, `data-testid="make-report-replaces"`) "Fortleva drafted this month's report on the 1st. Making one here replaces that draft — the client has not seen it." ; for one in `emptyMonths`, a muted line (`data-testid="make-report-empty-month"`) "Nothing was finished or published for this client that month, so Fortleva drafted no report. You can still make one." The submit's success toast varies on `replaced`.
- **Settings → Preferences**: the card of §4.

## 7. Catalogue changes

- Audit: no new action. `document.created` gains `drafted: boolean` and, from the button, `replacedDraftIds`; `document.deleted` gains the `{ reason: "replaced_draft", replacedBy }` shape.
- Notification kinds: `report.drafted`. Reasons: `REPORT_ACCESS` (migration).
- Permission codes: none. Portal capabilities: none. Domain errors: none new (the drafter maps slice 119's to outcomes).
- Preferences: `reports.draftMonthly`.
- `src/portal/synthesise.ts`'s caller list names the drafter (slice 119's review NIT-5's rule).

## 8. Tests

**`src/documents/report-drafts.dbtest.ts`** (prefix `rdft-`, registered in `DBTEST_PREFIXES`; `LocalDiskTransport`; a fixed `NOW` of 2026-09-03 so the month drafted is August 2026):

- fixture: Acme — a main contact and a collaborator, a portal project with a shared DONE task and a published shared update in August, one INTERNAL task (a sentinel), a `countryCode` that invoices in English; Beta — no one who can sign in, a project with August work; Gamma — an audience, a portal project with nothing in August; Delta — an audience and an UPLOADED report for August; Echo — ARCHIVED with an audience; Foxtrot — an audience and 26 portal projects;
- **the run**: `draftMonthlyReports(tenant, NOW)` → Acme DRAFTED (a REPORT document, INTERNAL, August, the English name; the file `%PDF-`; `made_report` with `madeByMemberId null`, locale `en`, both texts null, every portal project; the ledger row DRAFTED naming the document; `document.created` as SYSTEM with `made: true, drafted: true`; ONE `report.drafted` notice to the owner and the manager assigned to Acme (reasons REPORT_ACCESS / CLIENT_MEMBER), none to the employee; the sentinel walk over the content and every row); Beta NO_AUDIENCE; Gamma EMPTY; Delta EXISTS; Echo not considered (no row); Foxtrot TOO_LARGE; `considered` 5, `drafted` 1;
- **again**: a second run changes nothing (`considered` 0); a FAILED row (planted, attempts 1) is tried again and becomes DRAFTED; one at attempts 3 is not;
- **the switch and the module**: `reports.draftMonthly` off → `{ off: true }`, no rows; the reports module off → `{ closed: true }`;
- **the day**: `NOW` on 31 August 23:30 Stockholm → drafts JULY (the workspace's month); 1 September 00:30 → August;
- **the cap and the deadline**: `clientCap: 1` considers one; a spent deadline considers none and reports `outOfTime`;
- **the replace**: the owner makes August for Acme by hand → the draft soft-deleted (`document.deleted` with `reason: "replaced_draft"`), the new one present with `replacedDraftIds`, `replaced: 1`; the ADMIN (no delete codes) can replace too; a draft published then hidden (flip via the platform client, `reportPublishedAt` set) is NOT replaced; an uploaded report for the month is never replaced;
- **the ledger's database**: the outcome CHECK; `document_id` iff DRAFTED; attempts 0 and 4 refused; a month not on the 1st refused; the posture loop covers it by registration;
- **the subject**: `reportSubjects` under the owner names Acme and links `/clients/<acme>/reports`; under the employee (no `report:view`) nothing; after the draft is deleted, nothing;
- **the form**: `readMakeReportForm` for Acme lists August in `draftMonths` before the replace and not after; Gamma's lists August in `emptyMonths`.

**Unit**: `report-drafts.test.ts` — `outcomeOf(content)` (EMPTY iff every project is empty); the catalogue tests pick the new kind up by enumeration (copy key, template, summary line, icon); `reasons.test.ts`'s order; the i18n parity test.

**e2e** `reports.spec.ts`: the seeded job-drafted report (two months back) shows "Drafted by Fortleva"; with that month picked, the card shows the replace callout; `settings.spec.ts`: the Monthly reports card's switch is visible and checked for the owner. The `client-reports` and `settings-preferences` visual stops photograph the new elements (no new stop).

## 9. Docs

DATA_MODEL (§6.8: `MonthlyReportDraft`, `MadeReport.madeByMemberId`'s NULL; §6.18: the kind and the reason); AUTHZ.md §3 notes (the drafter asks the tenant gates, not a member's; the replace under the make codes — R5); UI.md (the Reports tab's marker and the card's two sentences; the Preferences card); SECURITY.md §5.1 (the drafter is a SYSTEM writer of INTERNAL documents only — nothing it writes is client-visible until a person publishes with the check); AGENTS.md (the jobs route paragraph: it now DRAFTS REPORTS; the mutation-rule carve-out: the ledger rows are unaudited); OPEN_QUESTIONS C96 → built; PLAN §0 and Phase 7's line.

## 10. Migration review (pre-apply)

*(filled in after the fresh agent's review)*

## 11. Code and security reviews

*(filled in after the reviews)*
