# Slice 113 — RENEWALS THAT DRAFT AN INVOICE (Phase 4 step 7; founder decision C88)

*Design written 2026-10-12 by the building session, before any code; reviewed by a fresh agent before the first migration is written (§9 records the review and what was done). C88's six answers are in `docs/OPEN_QUESTIONS.md`; this document is how they are built.*

## 0. What C88 decided, and the readings this design takes

| C88 | Decision | Reading taken here |
|---|---|---|
| (a) | Fortleva makes the draft **by itself, 14 days before** the renewal date; nothing reaches the client until a person issues it; the database gets a narrow right for the background job to make this one kind of draft | The job runs under the tenant's SYSTEM principal (the reminders' shape). The database's invoice guards gain ONE system path: a draft of origin `RENEWAL`, made by nobody, with no pay link and no free text, and lines that each name an agreement of the invoice's client at no more than its price (§3.2). A member's path is unchanged; issuing still needs a member holding `invoice:issue`, as themselves. |
| (b) | The **coming** period, in advance; the invoice prints the period | The line bills `[renewal day, the day before the next renewal]`; the invoice's own period (`period_start`/`period_end`, already printed on the PDF) is the span of its renewal lines. |
| (c) | **One invoice per client**: added to that client's renewal draft still unissued **in the same currency**; each line names its agreement and period | "That client's renewal draft" = a `DRAFT` of origin `RENEWAL` for the client in the agreement's currency; the oldest if (by a person's doing) there are several. A person may edit it freely — it stays a renewal draft and keeps receiving renewals until it is issued or deleted. |
| (d) | **People who can issue invoices** are told: owners and admins who reach that client, in the inbox, **no email** | Receivers: every ACTIVE member holding `invoice:view` AND `invoice:issue` on all four gates, with the client in DIRECT scope (the invoice page's own rule), checked as themselves — the reminders' `whoResolver` shape. A new kind `invoice.renewal_drafted`, COALESCED with no `email` (§3.5). |
| (e) | **Every** running monthly / quarterly / yearly agreement **with a price**, from its NEXT renewal (never a period already started); an **"Invoice each renewal"** switch per agreement, ON by default | `service.invoice_renewals boolean NOT NULL DEFAULT true`. "A period already started" = its first day is before the tenant's today: such a period is never drafted, at go-live or after a pause. |
| (f) | An end date **inside** a period charges **only the days until it ends** | Price × (days covered ÷ days in the period), to the öre, half away from zero (`money.ts`); the line's period ends on the end date. Quarterly and yearly alike. |

**Stated to the founder with the second round, not asked:** agreements become editable (name, price, currency, interval, renewal date, end date) and can be paused and resumed; the renewal date moves on by itself once its day has passed; a draft or line a person deletes is not made again for that period; the draft takes the price as it stands when it is made; a paused or ended agreement, or an archived client, drafts nothing.

**Read by the design, not asked:**

- **The renewal date moves on the day AFTER it is reached** (C88's record says why: Renewals keeps "renews today" on the day). Whether or not the agreement invoices — a renewal date is a fact about the agreement, and today nothing moves it, so Renewals drops a monthly agreement after its first date and never shows it again.
- **A month-end renewal keeps its day.** An agreement renewing on the 31st renews on 28/29 February and on 31 March again: the anchor day is kept (`service.renewal_day`, §2.1).
- **An agreement whose end date falls before its next renewal is not moved on** — the date stays where it was, passed, and Renewals shows its end instead (`agreementEnds`, C55).
- **A deleted draft or line is not made again**: what was drafted is recorded on the agreement (`service.invoiced_through`, the last day of the last period drafted), never inferred from the invoice lines that happen to exist.
- **End agreement** acts today on ONE click: its row action carries a `confirm` but no `tone: "danger"`, which AGENTS.md's standing trap says is dead string. Ending is final in the UI (there is no "un-end"), so it gets the danger tone and its question back.

## 1. The build in two slices

| Slice | What | Why it is its own |
|---|---|---|
| **113** | Agreements editable read-first (the Assets tab's row: name, billing, price and currency, renews on, ends on), Pause / Resume / End / Delete in the row menu; the renewal date moved on by a daily job; migration `service.renewal_day`. | Useful alone (Renewals finally shows a monthly agreement's next date), no invoice or RLS change, and the drafting slice needs correctable agreements before it can be trusted. |
| **113b** | "Invoice each renewal"; the drafting (the job, the database's system path for renewal drafts, the period and proration, one draft per client and currency); the inbox notice; Renewal drafts marked on Invoices and explained on the draft. | The safety-relevant half: a new writer of invoices. `/security-review` territory (a migration replacing `invoice_guard` and `invoice_line_guard`). |

Each slice is reviewed (`/code-review`; `/security-review` for both — 113 adds a column to `service`, a class-B table the portal reads, and server actions; 113b replaces two invoice guards) by fresh agents before its commit.

## 2. Slice 113 — agreements editable, and the renewal date moving on

### 2.1 Schema — migration `20261017090000_agreement_renewal_day` (DDL only)

```sql
ALTER TABLE service ADD COLUMN renewal_day smallint;
ALTER TABLE service ADD CONSTRAINT service_renewal_day_range CHECK (renewal_day IS NULL OR renewal_day BETWEEN 1 AND 31);
```

`renewal_day` is the day of the month the agreement renews on. NULL means "the day of `renews_at`" — the meaning every existing row has, so there is no backfill (no DML: nothing for `neon-smoke.yml` to rehearse). The job writes it as it moves a date on (the anchor it moved from); a person setting `renews_at` resets it to NULL (their date is the new anchor). Internal: never selected by the portal (§2.6). No grant change (the column inherits the table's).

### 2.2 The dates — `src/services/renewal-dates.ts`, pure

```ts
type Interval = "MONTHLY" | "QUARTERLY" | "YEARLY";      // 1, 3, 12 months
addIntervals(day: string, interval, steps: number, anchorDay: number): string
  // `steps` intervals after `day`'s month, on `anchorDay` or that month's last day
nextRenewal(current: string, today: string, interval, anchorDay): { next: string; steps: number } | null
  // the first renewal STRICTLY after `today` reached from `current`; null if `current` is not before today
periodOf(start: string, interval, anchorDay): { start: string; end: string }
  // [start, the day before the next renewal]   — 113b
```

Days are `YYYY-MM-DD` strings throughout, as `reminder-bands.ts`. `renews_at` is a `timestamptz` written as UTC midnight by every form, so its UTC day (`utcDayOf`) is the agreement's day; the tenant's today is `localDateString(now, prefs.timezone)`. A step bound (600 — fifty years of months) refuses an absurd catch-up rather than looping.

### 2.3 The job — `src/jobs/agreement-renewals.ts` + `src/services/renewals.ts`

Discovery under `withPlatform` (the one audited cross-tenant read, ids only): tenants with an agreement `status ACTIVE, kind RECURRING, billing_interval NOT NULL, renews_at < now + 1 day`. 113b widens the window to `now + 16 days` (14 days plus a day either side for zones).

Per tenant, under the tenant's SYSTEM principal (`moveRenewalDatesOn(tenantId, now)`):

1. One read: the tenant's today; then the candidates (`ACTIVE`, `RECURRING`, interval set, `renews_at` before today's UTC midnight, no end already passed), paged by id in 250s, at most 1 000 a run per workspace and a minute a run across every workspace, workspaces in a random order (the rest next run — §9.2).
2. **One transaction per agreement:** `SELECT … FROM service WHERE id = … FOR UPDATE`, re-checked (still ACTIVE, RECURRING, same `renews_at`); `nextRenewal`; if the agreement has an end date and the next renewal is after its UTC day → nothing (the end stands; §0). Else `UPDATE service SET renews_at = <next 00:00Z>, renewal_day = <anchor>` (a `select`ed update — AGENTS.md: an update without one returns the whole row), and `audit.record` `service.renewed` `{ clientId, from, to, steps }` as SYSTEM. No notification (C55: a renewal is not news).
3. One tenant's failure is counted and logged by id and error name only, and the next tenant runs (the reminders job's rule).

`POST /api/jobs/run` gains the job (its result counts: tenants, moved, failed). It writes data in every tenant of the database it runs against — AGENTS.md's paragraph on the route gains a sentence; a dbtest calls `moveRenewalDatesOn(<its own tenant>)`, never the job.

**Why a job and not a read-time computation:** the date is shown in four places (Agreements, Renewals, Home, the portal) and is the drafting trigger (113b); one stored value moved by one writer keeps them equal.

### 2.4 The service module (`src/services/service.ts`)

- `updateService` keeps its shape (`service:edit`, scope, changed field names in `service.updated`) and gains: the kind's rules on update as on create (ONE_TIME clears the interval and the renewal date; RECURRING without an interval takes MONTHLY); a set `renewsAt` resets `renewalDay` to NULL; years outside 2000–2199 refused for `renewsAt`, `endsAt`, `startedAt` (the form's typo guard, as invoices and assets).
- `setServiceStatus` already does Pause / Resume (`PAUSED` ↔ `ACTIVE`, `service.updated` with from/to) and End (`service.ended`). Resuming an agreement whose date passed while paused needs nothing: the next run moves it on, and (113b) a period already started is never drafted.
- `ServiceRow` gains nothing visible: `renewalDay` is the job's, not the page's.

### 2.5 The Agreements tab (`/clients/[id]/agreements`)

The `DataTable` becomes a list of **`AgreementRow`**, the Assets tab's read-first row (UI.md §5.11/§5.12; `asset-row.tsx` is the model, including its reset-on-refusal and its `has()`-guarded action):

- Line 1: the name (`InlineEdit` text), the project key badge when it is a project's, the status badge, the row menu.
- Properties (`dl`, two columns from `sm`): **Billing** (One-time / Recurring — TEXT, set when the agreement is added: §9.2), **Interval** (Monthly / Quarterly / Yearly — select, recurring only), **Price** (text, ex. VAT) with its **currency** beside it (select of `CURRENCIES` plus the stored one — `withCurrentOption`; shown only with a price, as an asset's cost), **Renews on** (date, recurring only), **Ends on** (date), and read-only **Bill rate** (with `rate:view_bill`, exactly as today: absent without it) and **This month** (hours).
- Menu: **Pause** / **Resume** (one click — reversible), **End agreement…** (danger, its question — §0), **Delete** (danger, as today; `service:delete`).
- A reader without `service:edit` sees the same row with every value as text (`readOnly`).
- `updateAgreementAction(formData)` parses only (`clientId`, `serviceId` UUIDs; `dayOf` for the dates, refusing a malformed one rather than clearing); `pauseAgreementAction`, `resumeAgreementAction`; End and Delete keep their actions. Revalidates the tab's own path.
- The add form at the foot stays as it is (it is a form — rule 1's inline card), and gains **Ends on**.

The e2e (`settings.spec.ts`'s agreements tests, which look for `role=row`) moves to the list's `data-testid="agreement-item"`; `agreement-rate` stays. A new `agreements.spec.ts`: edit a price and a renewal date inline and see them after a reload (the database's value, not the DOM), pause and resume, end asks first.

### 2.6 The portal

`service` is class B: the portal's agreements projection (`src/services/portal.ts`) selects named columns, never `renewal_day` (nor 113b's two). The column goes on the portal tripwire's lists in `src/authz/portal-projections.test.ts` — `PORTAL_FORBIDDEN_COLUMNS` and `PORTAL_NEVER_SELECTED`, each with its pinned copy — as `invoiceRounding*` and `bookRateToSek` did for their class-B tables. (113b: `invoiceRenewals` and `invoicedThrough` likewise; `origin` cannot go on the text list and needs `origin: ["Contract"]` in `PORTAL_NEVER_SELECTED_EXCEPT`, because the portal's contract projection selects `Contract.origin`.)

**Touchpoints found by the sweep (2026-10-12):** the jobs route has no registry — import, await in sequence (own try/catch), add to the JSON and the header comment; `src/audit/catalog.ts` gains `service.renewed` (no test enumerates actions); AGENTS.md's paragraph on `POST /api/jobs/run` gains the move (113) and the drafting (113b).

### 2.7 Tests (113)

- `renewal-dates.test.ts` (unit): monthly / quarterly / yearly; the 31st through February and back; 29 February yearly; a catch-up of many steps; `today` equal to the date (not moved); the step bound.
- `agreement-renewals.dbtest.ts` (prefix `agren-`, registered in `DBTEST_PREFIXES`): a passed monthly date moves to the next after today, with `renewal_day` and one `service.renewed` row as SYSTEM; today's date stays; PAUSED, ENDED, ONE_TIME and interval-less stay; an end date before the next renewal stays; the 31st keeps its day across two runs; a person's new date resets `renewal_day`; a second run changes nothing; another tenant's agreement is never touched.
- `service.dbtest.ts` (or the existing services dbtest): the kind rules on update; the year guard.

## 3. Slice 113b — renewal drafts

### 3.1 Schema — migration `20261018090000_renewal_invoices` (DDL only)

```sql
-- service: the switch and the record of what was drafted
ALTER TABLE service ADD COLUMN invoice_renewals boolean NOT NULL DEFAULT true;
ALTER TABLE service ADD COLUMN invoiced_through date;            -- the last day of the last period drafted

-- invoice: who made it
CREATE TYPE invoice_origin AS ENUM ('MEMBER', 'RENEWAL');
ALTER TABLE invoice ADD COLUMN origin invoice_origin NOT NULL DEFAULT 'MEMBER';
ALTER TABLE invoice ALTER COLUMN created_by_member_id DROP NOT NULL;
ALTER TABLE invoice ADD CONSTRAINT invoice_origin_maker
  CHECK ((origin = 'RENEWAL') = (created_by_member_id IS NULL));
ALTER TABLE invoice ADD CONSTRAINT invoice_origin_kind
  CHECK (origin = 'MEMBER' OR kind = 'INVOICE');

-- invoice_line: which agreement a renewal line bills (a snapshot id, no FK)
ALTER TABLE invoice_line ADD COLUMN service_id text;
```

`invoiced_through` is written by the job only. `service_id` has **no foreign key**: an issued invoice's lines are its record for good and must not change or block when an agreement is deleted, as `invoice_line_time_entry`'s snapshot ids (DATA_MODEL §6.7). The existing `created_by_member_id` length CHECK passes NULL. `DEFAULT 'MEMBER'` makes every existing invoice a member's, which is what they are.

### 3.2 The database's system path (replacing `invoice_guard` and `invoice_line_guard`)

Both functions are replaced **byte-identical but for the branches below** (the 112c3 precedent; the pre-apply review diffs them against the live definitions).

`invoice_guard`:

- **INSERT** — `who = 'system'` is accepted ONLY with: `origin = 'RENEWAL'`, `created_by_member_id IS NULL`, `status = 'DRAFT'`, `kind = 'INVOICE'`, created now (the existing slack), `pay_link_url`, `note`, `buyer_reference`, `our_reference`, `project_id` all NULL, `include_hours = false`. A member's INSERT must have `origin = 'MEMBER'` (a member cannot make a draft that looks like the job's). Every other principal is refused as today.
- **UPDATE** — `origin` joins the never-changes list. A DRAFT→DRAFT update by `who = 'system'` is accepted ONLY on an origin-`RENEWAL` draft and ONLY when nothing but `period_start`, `period_end` and `updated_at` differ. Leaving DRAFT stays a member's, as themselves, holding `invoice:issue` — unchanged.
- **DELETE** — unchanged.

`invoice_line_guard`:

- `who = 'system'` may only INSERT, onto a DRAFT of origin `RENEWAL`, a line whose `service_id` names an agreement of THE INVOICE'S CLIENT that is `ACTIVE`, `RECURRING`, `invoice_renewals`, with a price; `quantity = 1`; `0 < unit_price_ex_vat <= that price`; the agreement's currency (or, NULL, any) equal to the invoice's. A system UPDATE or DELETE of a line is refused.
- A member may not set or change `service_id` (NULL on a member's INSERT; immutable on UPDATE): a line names an agreement only when the job drafted it.
- Everything else unchanged (the rate fits the treatment, a line stays on its invoice, a non-draft's lines never change).

**Also owed by the replacement:** `src/modules/invoicing/series-census.test.ts` pins every migration whose `invoice_guard` holds the series allocation's `UPDATE invoice_series` — the new migration joins its list. `service_id` gets no foreign key for a second reason the sweep found: `invoice_line_guard` refuses ANY change to an issued invoice's line, so an `ON DELETE SET NULL` from `service` would make an agreement with issued renewal lines undeletable by error instead of by rule; `deleteService`'s comment ("no invoice lines yet") is corrected.

**What the narrowing buys:** a bug or a misuse anywhere else that runs as SYSTEM cannot make an invoice that says anything but "these agreements of this client, at no more than their prices"; it cannot put a pay link, a note or a reference on one, touch a member's draft, or move any invoice out of DRAFT. What reaches a client still passes a person who sees the whole invoice and holds `invoice:issue`.

### 3.3 The drafting — `src/modules/invoicing/renewals.ts`

`draftRenewalInvoices(tenantId, now)`, run by the same job BEFORE `moveRenewalDatesOn` (so a period starting today is drafted before its date moves; with the move on the day after, the order matters only for a run that missed a day):

1. **Plan** (one SYSTEM read): the tenant's today and default currency; the due agreements — `ACTIVE`, `RECURRING`, interval set, `invoice_renewals`, `price_ex_vat > 0`, `renews_at` with UTC day `D` where `today <= D <= today + 14`, `invoiced_through IS NULL OR invoiced_through < D`, its client `ACTIVE`, and no end date before `D`. Grouped by (client, currency — the agreement's, or the default when NULL).
2. **Receivers per client** (short reads of their own, as the reminders): ACTIVE members with `invoice:view` and `invoice:issue` on all four gates (`accessibleCodes`) whose scope reaches the client DIRECTLY (`resolveScope`). Nobody → the draft is still made (it is the product; it waits on Invoices).
3. **One transaction per group:** `pg_advisory_xact_lock` on (tenant, client) — two runs never make two drafts for one client; each agreement re-read `FOR UPDATE` and re-checked against the plan (still due, still not drafted); the client's oldest RENEWAL DRAFT in that currency `FOR UPDATE`, or a new one (`writeDraft`'s derivations — VAT treatment from the client, payment terms from its last invoice or the workspace's default — with origin RENEWAL, no member, no reference); per agreement, in renewal-date order, one line at the end (§3.4) and `invoiced_through` set to the period's last day; the invoice's period widened to cover every line; `invoice.created` `{ clientId, origin: 'RENEWAL' }` when made and one `invoice.renewal_drafted` `{ clientId, serviceId, periodStart, periodEnd, lineId, prorated }` per line, as SYSTEM; ONE `emit` of `invoice.renewal_drafted` for the group (params: `clientId`, `invoiceId`, `count` — ids and a count only).
4. A draft at the line limit (200) is left and a new one started.

### 3.4 The line

- **Description**, in the client's invoice language (`invoiceLocaleFor`, the language a draft follows until issue): `<agreement name>, <period>` — the period as the PDF writes the invoice's own (`periodRange` over ISO days), e.g. "Hosting, 2026-11-01 – 2026-11-30". Capped at the line's 2 000 characters.
- **Quantity** 1, **unit** NULL, **unit price** the agreement's price — or, with an end date inside the period (C88 (f)), price × covered days ÷ period days, rounded to the öre (`money.ts`, half away from zero), and the period's end is the end date.
- **VAT rate** the treatment's default (`defaultRateFor`) — 25 % domestic, 0 % reverse charge or outside scope.
- `service_id` the agreement.

### 3.5 The notice — kind `invoice.renewal_drafted`

MEMBER, **`COALESCED`, no `email`** (C88 (d): no email every month) — the catalog's idiom for a system-emitted, inbox-only notice (`budget.threshold_reached` is the precedent, emitted by a job under SYSTEM); `emit` returns before the outbox for a non-INSTANT kind, and `isPushKind` is false, so no phone push either. (The team's summary email counts every kind — C68 (h) — so it appears there as a count, which is what "no email every month" can mean.) Inbox copy: "Renewal invoice for {client} ready to check" ("Förnyelsefaktura till {client} att granska"). Its subject — title and link `/invoices/<id>` — comes from a new resolver, `src/modules/invoicing/subjects.ts` (modelled on `contracts/subjects.ts`: `invoice:view` on all four gates, the client in scope, under the READER's principal), wired into `resolveSubjects` in `src/notify/inbox.ts`; `notificationTarget` (the open route) reuses it. Every kind needs: the catalog entry, `kind-copy.ts` (a `KindCopyKey` and the map), `kind-icon.ts`, `templates.ts` (en + sv copy even for a kind that never mails), `digest.ts` (a summary line — `summarisedKinds()` must equal every kind), and `inbox.kind` in both message files.

### 3.6 The UI

- **Agreements**: the row gains **Invoice each renewal** (a switch — a toggle is its own value in a row, UI.md's MANDATE 1 exception), drawn from the server's answer, never optimistic (the 112c3 switch's rule); `service:edit`; audited in `service.updated`'s field names. Off shows "Not invoiced" beside the billing line when the agreement has a price.
- **Invoices list**: a "Renewal" badge beside a renewal invoice's client.
- **A renewal draft's page**: a note above the lines — "Fortleva made this draft for the agreements renewing below. Check it, then issue it." — and, on each line that names an agreement, its name as a quiet link to the client's Agreements tab.
- A **corrected copy** or a **credit note** of a renewal invoice is a member's (origin MEMBER; its lines name no agreement — §3.2).

### 3.7 Tests (113b)

- `renewal-invoices.dbtest.ts` (prefix `rinv-`): the guards (system: a MEMBER-origin draft refused, a pay link / note / reference / project / hours refused, a member's draft's line refused, a line over the price, of another client's agreement, of a paused or switched-off agreement, quantity 2, refused; a system update of anything but the period refused; a system issue refused; a member: `origin = 'RENEWAL'` refused, `service_id` refused on insert and update, origin immutable); the job (14 days before, not 15; one draft per client and currency, a second agreement joining it; another currency its own draft; paused, ended, switched off, no price, archived client, a period already started: nothing; proration; a deleted line not drafted again; the line limit; the receivers — owner and admin with direct scope yes, a manager without `invoice:issue` no, an admin scoped elsewhere no; the period widened; a second run changes nothing; the move on runs after).
- `renewal-dates.test.ts` gains `periodOf` and the proration.
- e2e: a renewal draft planted through `seed-cli` (`plant-renewal-draft <tenantId> <clientId>`, which calls `draftRenewalInvoices` for that tenant on a tenant-only agreement) shows its badge on Invoices and its note on the draft; the agreement's switch turns off and stays off after a reload.

## 9. Review

### 9.1 The design review (2026-10-12, a fresh agent, read-only; slice 113's code drafted, 113b design only)

No high finding: no path found that lets a client see internal data or bills twice. Fifteen items; each dispositioned below. Two went to the founder as questions — C88 (g) and (h), both answered WITH the recommendation.

| # | Sev. | Finding | Done |
|---|---|---|---|
| 1 | M | 113b's system path keys on `who = 'system'` — ~55 files hold that principal, the portal brokers among them; the INSERT rule was a deny-list; DELETE of any DRAFT is open to any non-contact principal | **113b:** the system branch also requires `app.renewal_drafting = 'on'`, set by `renewals.ts` only and pinned by a census test (the `app.invoice_copy_of` precedent); the INSERT is an ALLOW-LIST — `to_jsonb(NEW)` less the allowed keys compared to a row of defaults, failing closed on a column added later; the client must be ACTIVE; a DRAFT's DELETE becomes a member's or maintenance only (`drafts.ts` is the one deleter). |
| 2 | M | No database backstop against the same agreement-period drafted twice | **113b:** `invoice_line.service_period_start` / `service_period_end` (NULL unless `service_id`; CHECK both-or-neither), a partial UNIQUE `(tenant_id, service_id, service_period_start) WHERE service_id IS NOT NULL`, and the system INSERT requires the agreement's row written in the same transaction with `invoiced_through = service_period_end` (`xmin = pg_current_xact_id()`, the hours guard's trick). The draft page reads the period from the columns, never the text. |
| 3 | M | **113 bug:** the row posts every field, so a page loaded before a move posts the OLD date with any save — the date goes back and its anchor is lost | **Fixed in 113:** the row posts the date it was drawn with (`renewsAtWas`) and `updateAgreementAction` patches the date only when the member changed it. |
| 4 | M | Drafting ignores the invoicing module switch: a workspace with invoicing off gets drafts nobody is told of | **113b:** a tenant is drafted for only while the `invoicing` module is open to it (the vault's `moduleOpenUnderSystem` shape), checked at the top of `draftRenewalInvoices`. |
| 5 | M | `invoiced_through < D` under-bills after an interval or date edit (monthly drafted to 30 Nov, made quarterly → Dec–Jan never billed) | **113b:** when `invoiced_through` falls inside D's period, the REMAINDER is drafted (`invoiced_through + 1` to the period's end), prorated by C88 (f)'s rule; a line never repeats a day already drafted. |
| 6 | M | Moving dates on fills Home's 5-row card with monthly renewals | **Asked — C88 (g): Renewals page only.** Built in 113: `expirationsGlance` reads no agreement renewals (`agreementRenewals: false`); the dbtest and `expirations.spec.ts` say so. |
| 7 | L–M | The job down for a renewal's whole window → that period never billed | **113b:** a LATE period is drafted when the agreement was continuously drafted (`invoiced_through = D − 1`); running an agreement again clears an `invoiced_through` in the past, so a paused time is still never billed. |
| 8 | L | The anchor reset read an unlocked `renewalDay` | **Fixed in 113:** cleared unconditionally whenever the date changes. |
| 9 | L | The plan's first 500 by id could be starved by rows the move never touches; one failing agreement stopped its tenant | **Fixed in 113:** the plan pages by id (to a cap the security review then lowered to 1 000 — §9.2), skips agreements whose end has passed (and discovery does too), and one agreement's failure is counted and logged by id and error name. |
| 10 | L | The join target: `ORDER BY … LIMIT 1 FOR UPDATE` can return nothing under a concurrent issue; lock order; re-derive from the locked row; a 0.00 proration; the period's widening; the currency rule | **113b:** pick the id unlocked, lock it by id, re-check, loop; never lock `client` before `invoice`; every plan fact re-derived from the locked agreement row and a mismatched agreement skipped (never the group); a line rounding to 0.00 skipped; the period widened with `least`/`greatest`; drafts with a person's `project_id` or at the line limit not joined; the guard's currency rule is the agreement's currency, or the invoice's when the agreement has none (the workspace default is the app's — the database cannot read it). |
| 11 | L | §0 said INSTANT, §3.5 COALESCED; no `dedupeKey`; the summary email counts kinds | **113b:** COALESCED (§0 corrected); `dedupeKey` `invoice.renewal_drafted:<invoiceId>`; the founder is told the team summary counts it. |
| 12 | L | End kept a stored future end (an ENDED agreement "ending" in November); an end on a renewal day | **Fixed in 113:** End sets the end to TODAY (the workspace's day) unless an earlier end is stored. The renewal-day end was **asked — C88 (h): it is the last day; one day is billed.** |
| 13 | L | Go-live: everything renewing in 14 days drafts at once, some perhaps already invoiced in Fortnox | **To tell the founder** with 113b, before it is pushed: check each agreement's "Invoice each renewal" first. |
| 14 | L | A paused agreement's passed date shows in the portal as "Renews <past date>" | **Fixed in 113:** the portal's agreements state a renewal date only while the agreement runs (`renewsAt` NULL otherwise). |
| 15 | nit | Stale comments in `expirations.ts` | **Fixed in 113.** |

**Checked and sound (the reviewer's list, abridged):** the date arithmetic and its tests; zones; the move's lock-and-re-read and idempotency; the kind rules against `service_interval_recurring_only`; the migration (DDL only, no backfill, table-level grants, the export takes the column, the portal's projection is a named select); every reader of `renews_at`; credit notes and corrected copies copy lines through a named select (so `service_id` never travels); the hours guards keep SYSTEM out; the issue fingerprint covers lines and the period (a line added between view and issue → `INVOICE_CHANGED`); `invoice:issue` is not ✦, so `accessibleCodes` is the right receivers' check.

### 9.2 The code and security reviews of slice 113 (2026-10-12, two fresh agents in parallel, read-only), then a narrow re-check

Neither found a high finding in the product; the code review found one HIGH in a test. Every item was fixed before the commit:

| Review | Sev. | Finding | Done |
|---|---|---|---|
| Code | **H** | `agreements.spec.ts` never saved the date — `fill` neither blurs nor submits, and the row's form saves a date on blur — so it would hang, and the agreement it left (a retry adds a second) would break `settings.spec.ts`'s option count | Enter after `fill` (AutoForm blurs and saves); the spec's own agreement lives on the seed's long-named client, which nothing counts. |
| Code | L–M | An ENDED agreement's end date stayed editable, and a stale page posted the old (empty) date back over the day it ended | Ends on is TEXT on an ended row; the row posts `endsAtWas` and the date is patched only when changed; `updateService` refuses an end-date change on an ended agreement (`AGREEMENT_ENDED`), and its write re-checks the status in the same statement (the re-check's low: the read is not locked). |
| Code | L | The Billing select saved on change: one arrow key turned a recurring agreement one-time, clearing its interval and date | Billing is TEXT (set when the agreement is added); the action no longer reads `kind`. |
| Code | L | The currency printed twice in an editable row | The page passes the amount only; the row draws the currency once — its select, or text when read-only. |
| Code | L | Swedish: "Debiteringspris" (the product says Timpris), a mixed passive/active sentence, "Förnyas varje" + "Månadsvis" | "Timpris"; "kan inte pausas, startas igen eller få ett nytt slutdatum"; the interval's label is the existing `clients.services.interval` ("Intervall"). |
| Code | L | The dbtest's title promised an interval-less case | Added. |
| Security | M | The job had no time budget: one workspace with thousands of agreements dated back to 2000 could hold `POST /api/jobs/run` for its whole life, so the backstops after it never ran, and starve other workspaces | A minute a run across every workspace (`RENEWALS_BUDGET_MS`), at most 1 000 agreements per workspace (pages of 250), workspaces in a random order each run, and the job now runs AFTER the PDF backstops. |
| Security | L | End overwrote a stored end date with no trace; edits audited field names only | `service.ended` keeps an end it overwrote (`endsAt: { from, to }`); `service.updated` keeps `values` `{ from, to }` for name, kind, interval, price, currency and the dates — never the notes or the description. |
| Security | L | No server-side limit on an agreement's name (it reaches the portal and reminder mails) | `SERVICE_NAME_MAX` 200 on create and update (`INVALID_INPUT`). |
| Security | doc | AGENTS.md's sentence said "every tenant" | Sending tenants only, the anchor written, the old date kept only as the audit row's `from`, the bounds. |
| Re-check | L | The currency select draws the workspace default for an agreement with none, so any save wrote a currency nobody chose (and a shared agreement's price then appeared in the portal) | The row posts `currencyWas`; the currency is patched only when the member picked one. |
| Re-check | L | Doc drift (§2.3's cap, §2.5's Billing, two comments) | Corrected. The promised "another tenant is never touched" dbtest case is NOT added: the job's every read and write is under the tenant's own principal with RLS live and a `tenant_id` filter — the cross-tenant seam is discovery's, which reads ids only. |

**Gates (the implementing session, once):** typecheck 0; ESLint on the touched files 0; `pnpm test` 167 files / 2 742 passed / 1 skipped; `pnpm build` 0. The new and changed dbtests (`agreement-renewals`, `expirations`) and e2e (`agreements`, `settings`, `expirations`) run first in CI — locally the dev database's permission catalogue is not seeded (TV16, owed).
