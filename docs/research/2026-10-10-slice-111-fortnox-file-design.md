# Slice 111 — THE BOOKKEEPING FILE FOR FORTNOX (Phase 4 step 5; founder decision C82)

*Draft 2026-10-10, before the design review.*

## 0. What was decided

- **C82 (a)** — the download is **an SIE import file plus a list**: each invoice and credit note a booked voucher Fortnox imports (Bokföring → Importera SIE-fil — native, no add-on; the person links the file's voucher series to one of theirs and may pick which vouchers to take), and a plain list of the same invoices that opens in Excel, to check against.
- **C82 (b)** — **invoices and credit notes only**; payments are booked in Fortnox from the bank.
- **C82 (c)** — **each invoice goes into ONE file only**: "Download new" makes a file of everything issued and not yet in one; earlier files can be downloaded again.
- **C82 (d)** — a foreign-currency invoice is booked in kronor at the **ECB's rate on the invoice date, fixed at issue**.
- *Stated when asking:* the file is downloaded by owners and admins — those who issue invoices.

**This overrides an older line.** DATA_MODEL's skip list says "SIE export / verifikationer / bookkeeping — skip … drags in systemdokumentation and audit expectations", and the 2026-08-16 research digest recommended "defer SIE, ship CSV". The founder chose the SIE file (C82 (a), with my recommendation — which did not cite that line; the final report says so). The reasoning that it is sound: decision #3's line — Fortleva is a *försystem* that issues invoices and the tenant's accounting program is the bookkeeping — holds unchanged: the vouchers become Fortnox's when imported, Fortnox remains the books, and the tenant's duty to describe its system (BFL 5 kap. 11 §, systemdokumentation) exists whether the accountant books from a PDF, a list or an SIE file. What the export adds to that description is written on the page itself (which accounts, which rates) and recorded per file (who made it, when, which invoices) — the *behandlingshistorik* of the transfer. The skip-list line is amended, not deleted.

Readings this design takes (each a question for the review, §9):

1. **The list is an .xlsx, not a CSV.** The founder was told "opens in Excel". The product's CSV convention (`src/lib/csv.ts`: comma, dot decimal — "a CSV is for other programs") opens as ONE column in Excel with Swedish regional settings, where the list separator is `;` — exactly the accountant's Excel. A minimal SpreadsheetML workbook (`fflate` is already a dependency) opens correctly in every locale, keeps amounts as numbers that sum, and has no formula-injection surface (cells are inline strings or numbers, never formulas).
2. **One voucher per invoice/credit note**, dated its issue date; receivables debited, sales credited per VAT treatment and rate, output VAT credited per rate. A credit note is the same voucher with every sign reversed.
3. **Accounts are a workspace setting with BAS defaults** (the accounts Fortnox's standard chart already has): receivables 1510; sales in Sweden 25/12/6 % → 3001/3002/3003; services to another EU country (reverse charge) → 3308; services outside the EU → 3305; output VAT 25/12/6 % → 2611/2621/2631; and the voucher series, default `B` (Fortnox's customer-invoice series; the import asks which series to use anyway). Not a payment-redirect vector (nothing printed, nothing paid), so an ordinary `settings:edit` edit, audited with what changed.
4. **Foreign currency:** each rate group's net × the invoice's BOOKING rate, to the öre; the VAT in kronor exactly as the invoice states it (its per-rate VAT × the VAT rate of C78 (a)) when it has one; receivables = the sum of the credits, so every voucher balances by construction. A SEK invoice's amounts are its own.
5. **A credit note is booked at its ORIGINAL's booking rate** (copied by the database at issue, as the VAT rate already is): it reverses that booking exactly, and the receivable nets to zero in kronor.
6. **A voucher that would be all zeros is left out of the SIE file** (an invoice of 0,00 — lines that cancel); the invoice is still in the file's record and on the list, marked "no entry". Rows of 0,00 are left out of any voucher.
7. **The file is regenerated on every download from frozen facts**: the invoices (frozen at issue), and what the export row froze when it was made (the accounts, the series, the company name and org. number, the day). A re-download is byte-identical. No file storage — the browser harness has none.
8. **The whole workspace or nothing:** the file is every client's invoices, so making or downloading one needs a TENANT-WIDE client scope (`resolveScope(...).all`), as `/vault/exports` does — a member scoped to some clients would otherwise either see others' invoices or leave them behind in "new".

## 1. Data — migration `20261011090000_invoice_bookkeeping_export` (DDL only)

### 1.1 `invoice` gains the booking rate (C82 (d))

- `book_rate_to_sek NUMERIC(12,6) NULL` — SEK per one unit of the invoice's currency, the ECB's (the `fx_rate_to_sek` scale); `book_rate_date DATE NULL` — the ECB file's date.
- CHECK `invoice_book_rate_pair`: both NULL or both set; `book_rate_to_sek > 0`.
- CHECK `invoice_book_rate_when`: `CASE WHEN status = 'DRAFT' OR currency = 'SEK' THEN book_rate_to_sek IS NULL ELSE book_rate_to_sek IS NOT NULL END` — every issued invoice in another currency has one, nothing else does. *Validated on existing rows: dev holds no issued invoice at all (read-only probe, 2026-10-10).*
- **`invoice_book_rate_guard`** (BEFORE INSERT OR UPDATE OF status, currency, book_rate_to_sek, book_rate_date — its own trigger, named to fire after `invoice_billed_hours_guard` and before `invoice_guard`, so `invoice_guard` is not replaced again):
  - INSERT, or a draft staying a draft: nothing (the CHECK holds NULL).
  - LEAVING DRAFT, an INVOICE in another currency: the rate's date between the issue date minus `FX_MAX_AGE_DAYS` (10) and the issue date — "the latest ECB rate on or before the invoice date".
  - LEAVING DRAFT, a CREDIT NOTE: the guard WRITES its original's rate and date (whatever the app sent is overwritten — the snapshots' precedent).
  - After issue, `invoice_guard`'s frozen-row diff already covers the two columns (they are not in `mutable`).
- `invoice` is class B (slice 109): both columns join `PORTAL_NEVER_SELECTED` (internal bookkeeping; a public ECB figure, but the default is internal).

### 1.2 `invoice_export` (new, CLASS A) — one row per file

`id uuid(7)`, `tenant_id`, `number INT` (1, 2, 3… per workspace — "File 3"), `created_at`, `created_by_member_id` (attribution, no FK), `made_on DATE` (the workspace's day — `#GEN`), `company JSONB` (`{legalName, orgNr}` — `#FNAMN`, `#ORGNR`), `accounts JSONB` (the ten accounts and the series, as used). UNIQUE `(tenant_id, number)`.

**`invoice_export_guard`** (BEFORE INSERT OR UPDATE OR DELETE):
- INSERT: by a MEMBER, as themselves, holding `invoice:export` (`invoice_member_holds`); made now (±5 min); the number ALLOCATED here — `pg_advisory_xact_lock(hashtext('invoice_export:' || tenant_id))`, then `max(number) + 1` (whatever the app sent is overwritten); `accounts` and `company` of the right shape (jsonb keys present, each account four digits, the series 1–10 letters/digits).
- UPDATE: never. DELETE: only platform maintenance (`app.invoice_maintenance` as `app_platform` — dbtest/e2e teardown).

### 1.3 `invoice_export_entry` (new, CLASS A) — which invoices a file holds

`tenant_id`, `export_id`, `invoice_id`; **PRIMARY KEY `(tenant_id, invoice_id)`** — the database's "each invoice in one file only" (C82 (c)); FK `(tenant_id, export_id)` → `invoice_export`, FK `(tenant_id, invoice_id)` → `invoice` ON DELETE RESTRICT; index `(tenant_id, export_id)`.

**`invoice_export_entry_guard`** (BEFORE INSERT OR UPDATE OR DELETE):
- INSERT: by a member as themselves; the export row was written IN THIS TRANSACTION by that member (`xmin = pg_current_xact_id()::xid` — slice 98's probed pattern), so no file ever grows after it is made; the invoice issued (`status <> 'DRAFT'`), of this tenant (FK).
- UPDATE never; DELETE only maintenance.

Grants: `SELECT, INSERT` on both to `app_runtime`. RLS on both: `tenant_isolation` + `portal_deny` (class A). Both registered in `MODEL_CLASSES` + `RLS_CLASSES` (A). Teardown (`dbtest-fixture.ts` `deleteInvoices`, `seed-cli.ts`): entries, then exports, before invoices, under the maintenance GUC.

## 2. App

### 2.1 The booking rate at issue (`issue.ts`)

Before the transaction, an INVOICE in another currency fetches the ECB rate for the ISSUE DATE (`sekRateFor(currency, { rateDay: today, issueDate: today })`) — reused as the VAT rate when the VAT's rate day is today too (one fetch), a second fetch when the work ended earlier. `issueLocked` takes `bookRate`: required exactly when the draft is an INVOICE in another currency (else INVOICE_CHANGED, as for the VAT rate), its date within the guard's window (else INVOICE_FX_UNAVAILABLE); written as `bookRateToSek`/`bookRateDate`; in `invoice.issued`'s metadata. A credit note sends nothing (the guard copies). **Behaviour change:** issuing a USD/EUR invoice WITHOUT VAT now also needs the ECB reachable (it is refused "try again" otherwise, as a VAT-carrying one already is).

### 2.2 Pure modules (`src/modules/invoicing/`, `src/lib/`)

- `bookkeeping-accounts.ts` — the ten account roles + series, BAS defaults, `normalizeAccount` (`^[1-8]\d{3}$`), `normalizeSeries` (`^[A-Za-z0-9]{1,10}$`), `accountFor(profile, rate)`, `vatAccountFor(rate)`.
- `vouchers.ts` — `voucherFor(invoice, accounts)` → `{ date, text, rows: [{account, amount}] } | null` (null = all zeros). Text `Faktura 10001 Acme AB` / `Kreditfaktura 10005 Acme AB`, Swedish always (the books), ≤ 100 characters (the client's name cut). Rows merged by account, zero rows dropped, order receivables → sales → VAT. Pure BigInt arithmetic (`divRoundHalfAway`, `vatInSek`).
- `sie.ts` — `sieFile({ company, madeOn, series, vouchers })` → `Uint8Array` in **CP437** (spec 4C §5.8): `#FLAGGA 0`, `#PROGRAM "Fortleva" 1.0`, `#FORMAT PC8`, `#GEN yyyymmdd`, `#SIETYP 4`, `#FNAMN`, `#ORGNR nnnnnn-nnnn` (when known), then per voucher `#VER "<series>" "" <date> "<text>"` `{` `#TRANS <account> {} <amount>` `}`. No `#KONTO` (optional in 4I; declaring names would warn on every chart that names them differently — the accounts are the workspace's own choice and exist in its chart), no `#KSUMMA` (optional), no vernr (4I: "kan lämnas tomma … åsätts av redovisningsprogrammet"). Text fields: control characters removed, `"` → `\"`, a backslash → `/` (a trailing one would escape the closing quote), characters outside CP437 transliterated (NFKD, marks stripped) or `?`. CRLF line ends. Amounts `-1234.50`.
- `src/lib/xlsx.ts` — `xlsxWorkbook({ sheet, columns, rows })` → `Uint8Array`: `[Content_Types].xml`, `_rels/.rels`, `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/styles.xml` (bold header, `#,##0.00`, a date format, `0.000000`), `xl/worksheets/sheet1.xml` (frozen header row, inline strings, numbers as text of the exact decimal, dates as serials). XML-escaped; characters XML 1.0 forbids removed.
- `invoice-list.ts` — the list's columns and rows (pure): number, type, credits (number), date, due date, client, org. no., VAT no., country, VAT treatment, currency, net, VAT, total (credit notes negative), booking rate, net SEK, VAT SEK, total SEK, "in the file" (yes / no entry). Headers in the downloading member's language.

### 2.3 Service — `src/modules/invoicing/bookkeeping.ts`

Every verb: `requireAccess(invoice:export)` → tenant-wide scope or `deny("FORBIDDEN")` → work → audit, in one transaction.

- `readBookkeeping(ctx)` — the page: what is new (counts of invoices and credit notes not in a file, the first and last issue dates, how many are in another currency) and the files (newest first, at most 50: number, made on, by whom, counts, number range).
- `createExport(ctx)` — the per-workspace advisory lock first (the guard's own key — so the app's read of "what is new" is serialised with any other maker); read issued invoices with no entry, ordered by issue date then number, at most `EXPORT_MAX` (1 000 — the rest go in the next file, and the page says so); none → `INVOICE_EXPORT_EMPTY`; read the company (tenant row; the newest invoice's seller snapshot when blank) and the accounts (preference, defaults); insert the export (the guard numbers it), the entries; audit `invoice_export.created` (`exportId`, `number`, `invoices`, `creditNotes`, first/last number).
- `exportFile(ctx, exportId, format: "sie" | "xlsx", locale)` — read the export and its invoices (frozen columns + per-rate nets from `invoice_line`), build, audit `invoice_export.downloaded` (`exportId`, `number`, `format`). Bytes + filename (`fortleva-fakt-<n>.si` / `fortleva-fakturor-<n>.xlsx`).
- Settings: `readBookkeepingAccounts(tx, tenantId)`, `updateBookkeepingAccounts(ctx, patch)` — `settings:edit` + `invoice:view` (the terms card's gates); TenantPreference `invoice.bookkeeping`; blank field → its default; audit `invoice_settings.bookkeeping_changed` with each changed field's old and new value.

### 2.4 UI

- **`/invoices/bookkeeping`** ("Bookkeeping" / "Bokföring"), linked from `/invoices`' header for holders of `invoice:export`. Card 1 "New since the last file": "7 invoices and 1 credit note, 1 Oct – 10 Oct 2026" + **Make file**, or "Nothing new — every issued invoice is in a file." Card 2 "Files": a flush DataTable — File, Made, By, Invoices (count, number range), and two download links per row (**Fortnox file**, **List**). A short help line: in Fortnox, Bokföring → Importera SIE-fil; link the series; each file once. After Make file the new row appears first with a toast "File 3 is ready".
- **Settings → Invoicing**, a new card **"Bookkeeping"**: the ten accounts and the series, InlineEdit per field (the terms card's pattern; `resetKey` on refusal), each showing its default as the placeholder.
- Routes `GET /invoices/bookkeeping/[id]/sie` and `/xlsx` — `crossSiteRefusal`, `downloadFailure`, attachment + `no-store` (`src/lib/http-download.ts`); `application/octet-stream` for the `.si`, the xlsx MIME for the list.

## 3. Permissions, audit, catalogue

- **`invoice:export`** (`invoicing`, C A, not ✦, tenant-wide scope) — "Download the bookkeeping file and the invoice list — every client's invoices". Catalogue 114 → **115**, **TEMPLATE_VERSION 15** (seed owed at release, with TV13/TV14; `scripts/seed-catalog.ts` on dev for the tests). AUTHZ §2/§3.2.1 rows; `enforcement.test.ts` sees its site.
- Audit (catalog): `invoice_export.created`, `invoice_export.downloaded`, `invoice_settings.bookkeeping_changed`.

## 4. What reaches the client

Nothing. Both new tables are class A; the two booking-rate columns are on `PORTAL_NEVER_SELECTED`; no portal projection, no mail.

## 5. Tests

- **Unit:** `sie.test.ts` (CP437 bytes for å ä ö Å Ä Ö é ü; quoting, `\"`, backslash, control characters; amounts; a voucher's layout; a file's header order); `vouchers.test.ts` (SE 25+12 %, EU reverse charge, USD outside the EU at a booking rate, EUR with Swedish VAT at two different rates, a credit note reversed, rows merged when two rates share an account, zero rows dropped, every voucher balances — a property over random groups); `xlsx.test.ts` (unzip → each part present and well-formed, escaping, forbidden characters gone, numbers/dates); `bookkeeping-accounts.test.ts`; `invoice-list.test.ts`.
- **dbtest** `bookkeeping.dbtest.ts` (own prefix `bkx-`, registered in `DBTEST_PREFIXES`): the booking-rate guard (required for USD at issue, refused outside the window, NULL for SEK, a credit note gets its original's whatever it sent, frozen after issue); the export guards (a member without the code refused; the number allocated whatever was sent; an entry for a draft refused; an entry into an export made in an EARLIER transaction refused; the same invoice twice refused; UPDATE/DELETE refused); `createExport` (only new, ordered, counts; the second call `INVOICE_EXPORT_EMPTY`; two at once → one gets them, the other empty — no invoice in both; a scoped manager refused); `exportFile` (SIE decodes from CP437, every voucher sums to zero, a USD invoice's rows at its booking rate; re-download identical bytes; audit rows).
- **e2e:** `invoice-bookkeeping.spec.ts` — issue (a fixture invoice), Bookkeeping → Make file → the row → both downloads (`#FLAGGA 0` / a zip with `xl/workbook.xml`) → "Nothing new"; the settings card saves an account. **Visual stop** `invoices-bookkeeping` (+4 screenshots).

## 6. Docs

DATA_MODEL §6.7 as-built note + the skip-list line amended (C82); AUTHZ (code, count, TV15); PLAN §0 + Phase 4 (step 5 `[x]`, the "CSV fakturajournal" bullet); OPEN_QUESTIONS C82 (the skip-list note); AGENTS.md's screenshot count; SECURITY §5 (a download of every client's invoices: attachment, no-store, tenant-wide scope).

## 9. Questions for the design review

1. XLSX instead of the product's CSV for the list (reading 1) — right call, and is the minimal workbook (§2.2) complete enough for Excel, LibreOffice and Numbers?
2. The booking rate on `invoice` (class B, never selected) versus a class-A side row (slice 109 moved the payment NOTE out for a reason — is a public ECB rate different enough?).
3. SIE: series `B` by default and no vernr; no `#KONTO`; no `#KSUMMA`; `#SIETYP 4` in a `.si`. Anything Fortnox's importer is known to need that this leaves out?
4. The voucher arithmetic (reading 4): rate-group nets at the booking rate, VAT at the invoice's stated SEK VAT, receivable = sum. Any case where that misstates the books?
5. A credit note at its original's booking rate (reading 5).
6. Zero vouchers left out but the invoice still recorded as exported (reading 6).
7. A new code `invoice:export` (C A) versus reusing `invoice:issue`; tenant-wide scope required.
8. Concurrency: the advisory lock + the PK; anything that lets one invoice reach two files, or a file change after it is made?
9. `EXPORT_MAX` = 1 000 per file.

## 10. Revised after the design review and C82 (e)–(f) (2026-10-10) — OVERRIDES the body where they differ

The review (one fresh agent): no redesign of the database or concurrency; **H1** Fortnox refuses a voucher text over 50 characters; **H2** the design silently assumed the INVOICE method. Asked the founder (C82 (e), (f)): **Naxdor books invoices when PAID (the cash method)**, and an invoice in another currency carrying Swedish VAT is booked at its VAT's rate. So:

### 10.1 The method is a setting; the record is of BOOKED EVENTS

- Settings gain **the method** (`invoice` | `cash`, NO default — the page asks for it before the first file) and **the month the financial year starts** (default January). The method is FIXED once a file exists (`updateBookkeepingAccounts` refuses a change; switching methods is an accountant's year-turn job, outside the product for now).
- Accounts gain **`bank`** (default 1930, the cash method's debit). Each role is held to its class (L3): receivables and bank `1xxx`, the five sales accounts `3xxx`, the three VAT accounts `26xx`. The series default becomes **`F`** (L2: a series of Fortleva's own, so a mistaken import can be undone — Fortnox: "Du kan inte ångra om verifikationer bokförts i samma serie efter importen"; its import links the file's series to one of the company's anyway). The preference's read-modify-write takes the tenant row `FOR NO KEY UPDATE` first (L3).
- `invoice_export_entry` is no longer "one row per invoice" but **one row per booked EVENT**: `(tenant_id, id)` PK; `export_id`, `invoice_id`, **`event`** (`ISSUE` | `PAYMENT` | `PAYMENT_UNDONE` | `CREDIT_NOTED`), **`booked_on DATE`**, **`voucher JSONB NULL`** (`{text, rows:[{account, amount}]}` — what the file books, frozen; NULL = nothing to book), **`detail JSONB`** (the list's frozen amounts and, for a payment, the credit notes deducted). The file is regenerated from these rows (+ the export row), so a re-download is identical whatever code or setting changes later, and the rows ARE the transfer's processing history (L7: R1, seven years).
- The invoice method books `ISSUE` events (each invoice and credit note once, on its issue date — §0 as before). The cash method books:
  - **`PAYMENT`** — an INVOICE marked paid (`paid_on` set) with no payment currently booked: bank debited, sales and VAT credited, dated `paid_on`; the amounts are the invoice's LESS every credit note of it issued on or before `paid_on` (per rate, document by document — each document's own VAT and kronor), named in `detail`. Text `Inbetalning faktura 10001 Acme AB`.
  - **`PAYMENT_UNDONE`** — a booked payment whose invoice no longer has that `paid_on` (Mark as unpaid, C79 (h)): the booked voucher's rows negated, dated the file's day. A re-mark on another day is then a new `PAYMENT` in the same file (UNDONE first).
  - **`CREDIT_NOTED`** — each credit note once, NO voucher: on the list ("deducted from payment" or "after payment — book any refund from the bank"), so the accountant hears of every credit note.
  - **Year end** (C82 (e): unpaid invoices at the financial year's end, reversed the next day) — **slice 111b**, before Naxdor's first year end (31 Dec 2026); this slice's page says year-end booking is still to come.
- DB guard on entries (under the same advisory lock the export guard takes; `invoice_export_lock(tenant)` — ONE SQL function for the key, the app calls it first): the event matches the export's method; `ISSUE` once per invoice (partial UNIQUE), the invoice issued; `CREDIT_NOTED` once per credit note (partial UNIQUE); `PAYMENT` only for an INVOICE whose `paid_on` = `booked_on` and with no payment currently booked (PAYMENTs − UNDONEs = 0); `PAYMENT_UNDONE` only with one booked and the invoice's `paid_on` no longer the booked day; the voucher's accounts four digits and its rows summing to zero; the export made in this transaction by this member (xmin). Entries inserted ONE AT A TIME (a row trigger sees the earlier rows of its own statement, but one statement per row keeps the order beyond doubt).
- `createExport`: the lock → read candidates → lock the candidate invoices `FOR SHARE` in id order (a concurrent Mark as paid/unpaid then waits or has committed — the guard's `paid_on` check never refuses a file mid-way) → compute → keep only the events of ONE financial year (the earliest's; M1) and ONE seller (the invoices' frozen `seller_snapshot` legal name + org. number — `#FNAMN`/`#ORGNR` come from there, never the live tenant row; L1; the export's `company` column is dropped) → `EXPORT_MAX` (injectable) → insert. `lockTimeoutMs`/`timeoutMs` bounded; a lock timeout, deadlock or the guard's refusal → `INVOICE_EXPORT_BUSY` ("try again").

### 10.2 The other dispositions

- **H1** — a voucher text is at most **50 characters** after CP437 spelling, the client's name cut; double quotes in it become `'` (no `\"` in vouchers at all — the review's unverified escaping). Unit test with a 60-character name.
- **M2** — a REAL IMPORT is a release gate: File 1 imported into a Fortnox test company (or Naxdor's, with "Ångra SIE"), the result recorded in PLAN §0 — the founder's step; the page's help says to link the series and check the first import.
- **C82 (f)** — the booking-rate guard: an INVOICE in another currency WITH VAT takes its VAT's rate as its booking rate (`book_rate_to_sek = fx_rate_to_sek`, same date — no second fetch); without VAT, the ECB rate of the invoice date (fetched only for those, AFTER the VAT checks — L5: a work period too old still answers "too old").
- **L4** — every verb also requires `invoice:view`; the tenant-wide scope is app-only (the DB holds the code), recorded in AUTHZ.
- **L6** — explicit signed rows per case in the unit tests and the dbtest (an invoice's receivable/bank positive, a credit note's and an undo's negative).
- **L8** — the page says the first file holds everything issued (invoice method) or paid (cash method) in Fortleva so far.
- **L9** — client name, org. no., VAT no. and country from `buyer_snapshot`, never the live row.
- **L10** — files paginated (50 a page, "Older files").
- **L12** — the help says the list's VAT-number column is the source for the EU sales list; per-rate columns: not now.
- **NITs taken:** nine accounts + bank + series (wording); `#ORGNR` normalised (done); header fields unquoted and braces on their own lines, pinned in `sie.test`; Ø/Ł/đ table (done); the xlsx zip time fixed (done); "count, first and last" not a range; `made_on` held to ±1 day of UTC today by the guard; narrow reads, in sequence; plural branches start with `#`; `invoice_export.downloaded` records the bytes' SHA-256.
- **Not taken:** reshaping the ledger for a later Fortnox API push (step 8 will add its own event source when it exists).

### 10.3 The narrow re-check of §10 (the same reviewer, 2026-10-10) and what was done

Cash-method booking confirmed correct (bank debited, sales and VAT credited per rate on `paid_on`, net of the credit notes before it — a prepayment dated before the issue date is VAT on an advance, also correct); the state machine checked against `invoice_guard` (PAID → CREDITED keeps `paid_on` and is terminal; a CREDITED invoice is never marked paid); no lock cycle; year end safely 111b's. Findings:

1. **MEDIUM — the year cut could stall for good** (a December payment undone in January and re-marked in December: the PAYMENT waits on its UNDONE, the cut keeps picking December). TAKEN: the year is chosen from FILEABLE events only — a PAYMENT on an invoice whose booked payment is not yet reversed is not fileable until its UNDONE is filed (in this file or an earlier one); then events whose dependency joined this file and are of the same year are added. A dbtest walks that exact sequence (January file: the UNDONE alone; the next file: the December PAYMENT).
2. **MEDIUM — a credit note's label depended on when the file was made.** TAKEN: (a) a CREDIT_NOTED row's remark comes from the FROZEN record — "deducted" only when a booked, not undone, PAYMENT names it in its `detail` (with that payment's day and file); (b) four states: deducted from the payment of ⟨day⟩ (file N) · invoice not yet paid — will be deducted from its payment · after payment — book any refund from the bank · invoice credited in full, never paid — nothing to book; (c) THE TIE made deterministic without a new column: a payment deducts a credit note dated ON OR BEFORE `paid_on` that EXISTED WHEN THE PAYMENT WAS MARKED (its `issued_at` before the newest `invoice.paid` audit row's time for that invoice — written in the mark's own transaction; the credit note that came first is the one the client could have paid net of). Frozen into the PAYMENT's `detail` at file time, so nothing later changes it.
3. **LOW** — TAKEN: an UNDONE's `detail` names what it reverses (the day and the file); the guard holds its voucher to the exact negation of the booked PAYMENT's and its `booked_on` to the export's `made_on`; the page says an undo after the year's turn lands in the new year.
4. **LOW** — TAKEN: `booked_on` checked for every event (ISSUE = issue date, CREDIT_NOTED = the credit note's issue date, PAYMENT = `paid_on`, UNDONE = `made_on`); amounts at most two decimals, no zero row, at most 50 characters of text.
5. **LOW** — TAKEN: only a lock timeout or deadlock is `INVOICE_EXPORT_BUSY`; the guards' tokens stay UNMAPPED (`db-errors.ts`'s rule — a write no service makes surfaces as a bug, never a "try again" loop).
6. **LOW** — TAKEN: the export guard requires a new export's method to equal every earlier export's of the workspace (the method frozen by the database, not only the app).
7. **LOW** — TAKEN: status, `paid_on` and the credit notes are re-read AFTER the `FOR SHARE` locks; the compute uses only that read.
8. **For the accountant** (recorded in PLAN §0 with M2's real import): EU reverse-charge sales under the cash method — box 39 and the EU sales list may be due in the period of supply, not payment (verify before the first EU client); the help says to MATCH the bank line to the imported payment in Fortnox, never book it again; a foreign-currency payment debits the bank at the invoice's rate (C82 (e)'s accepted reconciliation).
9. **NIT** — TAKEN: an invoice in another currency whose per-rate VAT sums to 0 has no VAT rate (`needsSekVat` false) yet VAT rows — converted at the booking rate (`vatRate ?? bookRate`), tested. The "pre-existing 500" on a partial credit of such an invoice does not happen: `checkCreditIssue` already blocks it (`noRate`, `issue-check.ts:234`) before `issueLocked`'s throw — a refusal, not a crash.
10. **NIT** — for 111b: year-end entries list the invoices they cover in `detail`, so a payment marked late into a closed year is caught; and a caution for a file whose events date before the previous file's newest (a late marking into a reported month).

## 11. The migration's pre-apply review, and the code and security reviews (2026-10-10)

**Pre-apply (1 agent; no HIGH/MEDIUM; all taken BEFORE the apply):** NaN refused by name in `invoice_book_rate_pair` (Postgres orders NaN above every number); the entry guard reads its invoice `FOR SHARE` (a Mark as paid/unpaid in flight is waited for — `invoice_line_time_entry_guard`'s precedent); the existing-rows probe re-run immediately before `migrate deploy` (the probing role bypasses RLS — one tenant, no invoice at all); teardown order entries → files → invoices in both fixtures, `bkx-`/`bkxc-` registered; `issue.dbtest`'s BEFORE-trigger census widened to three and its raw EUR issues given their booking rate; nits — the lock function only for a member, a voucher with no quote or control character and no key beyond `text`/`rows`, `jsonb_array_length` only behind an `array` check. Applied with `prisma migrate deploy`; ledger checksum = the file (`5012a2a5…`).

**Code review (1 agent): one MEDIUM, four LOW.** **Security review (1 agent, in parallel): no HIGH/MEDIUM, three LOW.** Both found the same race:

1. **MEDIUM (code) = LOW (security) — the method could be split between the setting and the files**, wedging the workspace for good (a change read "no file yet" while the first was being made; every later file then refused by the guard, unmapped). TAKEN: `updateBookkeepingSettings` takes `invoice_export_lock` FIRST (the makers' order), then the tenant row; a method change also wants `invoice:export` (security nit 4); once a file exists only the files' method is accepted; `createExport` and the page take the method from the files when there are any — the setting decides only the first.
2. **LOW (code) — the deduction tie compared `issued_at` (taken before the issue's transaction waits for the original's lock) with the mark's audit time.** TAKEN: both sides are AUDIT rows (`invoice.issued` of the credit note, `invoice.paid` of the invoice), each written while holding the original's row lock; a member's rows only (security nit 5).
3. **LOW (code) = NIT (security) — a decomposed "A + ring" spelled "A?".** TAKEN: NFC first, a lone combining mark dropped.
4. **LOW (code) — a 1 000-entry file was a thousand statements, past the transaction's budget over a slow link.** TAKEN: `createMany` — the reversals first, then the rest in chunks of 250 (a row trigger sees the rows before it in its statement; only a re-marked payment depends on another entry, its reversal, which is in an earlier statement).
5. **LOW (both) — tests that would stay green with a fix removed, and rules never exercised.** TAKEN: the scope rule (a custom role holding both codes, kept to one client → FORBIDDEN on all three verbs); another workspace's file (NOT_FOUND) and lock (refused); an entry into a file committed earlier, a file "made" as someone else (refused); the booking-rate window (−12, +2 days, NaN) and the VAT-rate equality (raw); the deduction tie (a credit note issued after the mark, the same day, not deducted); `selectForFile` moved to a pure module with its unit test (dependencies, the cap, one group). `bookkeeping.dbtest.ts` 14 → 21.
6. **NITs taken:** the zip's time in local components (fflate writes DOS time with local getters — bytes otherwise differ by server zone); `sheetName` cuts before escaping; the e2e spec survives a CI retry; wording ("waiting" neutral, "credited and not paid", "Finns inte längre"); the /invoices link only where the page opens (scope too); no Fortnox link for a file with nothing to book.
7. **Not taken, recorded:** `#ORGNR` after `#FNAMN` — SIE 4C §5.13: the order within a group is free; the "filtered" EmptyState (precedent); `same-site` downloads (every existing download route; the file id is a UUIDv7 and nothing is readable cross-origin); no cap on the candidates read before `EXPORT_MAX` (an agency's volumes); a `quotePrefix` style (inline strings are never evaluated).
