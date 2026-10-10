# Slice 111b — THE CASH METHOD'S YEAR END (Phase 4 step 5b; founder decision C83)

*Draft 2026-10-10, before the design review. Builds on slice 111 (`docs/research/2026-10-10-slice-111-fortnox-file-design.md`, §10 overriding its body) — read that first; this document only says what changes.*

## 0. What was decided

- **C82 (e)** (already settled): under the CASH method Fortleva books "the invoices still unpaid at the financial year's end (with the reversal the next day)".
- **C83 (a) — A BUTTON, WHEN READY.** After the financial year ends, the bookkeeping page offers **Book the year end**; the person presses it once every payment that came in by the year's last day is marked. A reminder stays on the invoice pages (`/invoices`, `/invoices/bookkeeping`) until it is done. Files of the new year can still be made meanwhile.
- **C83 (b) — FORTLEVA CORRECTS A LATE PAYMENT.** A payment that came in by the year's last day but is marked after the year end was booked: the next file books the payment on its real day in the old year, plus a matching correction of the year end (and of its reversal). This only works while the accountant still has the old year open in Fortnox; the page warns when it happens.
- *Stated when asking:* each unpaid invoice is its own voucher on the year's last day and its own reversal on the next; the page says to book the year end before the VAT return for the year's last period is filed.

The law (researched for C83): under kontantmetoden / bokslutsmetoden, every invoice unpaid on the balance-sheet day must be booked (BFL 5 kap. 2 §), so the sale and its VAT land in the right year; the VAT on them is reported in the return for the financial year's LAST period.

Only the CASH method has a year end. The INVOICE method already books every invoice on its date — nothing changes for it.

## 1. What a year end books

Let **E** be the financial year's last day (`yearStart` − 1 day, in the setting's months).

For each invoice **in the year end** (§2), ONE voucher dated **E**:

    receivables (1510)       debit   A in kronor
    sales (3001…/3308/3305)  credit  A's net per treatment and rate
    output VAT (2611…)       credit  A's VAT per rate

where **A** = the invoice LESS every credit note of it dated on or before E (rate by rate, each document's own figures — `lessCredits`, as a payment's). In kronor at the invoice's BOOKING rate (C82 (d), (f)) — the rate the payment would have used, so the reversal and the later payment cancel to the öre. This is `rowsFor(s.receivables, A, …)` — the INVOICE method's issue voucher with A in place of the invoice. A voucher of nothing (A = 0: credited in full by E) is no entry at all — the invoice is simply not in the year end.

And its **reversal**, dated **E + 1**: the year-end voucher with every row negated (`reversalOf`). After it, the new year knows nothing of the year end: the payment books bank / sales / VAT as every cash-method payment does (C82 (e)), a credit note issued in the new year is deducted from it, and the sums come out right:

| invoice | old year | new year |
|---|---|---|
| unpaid at E, paid in the new year | +A (year end) | −A (reversal) + payment |
| unpaid at E, credited further in the new year, then paid | +A | −A + (A − the new credit) = −the new credit |
| unpaid at E, credited in full in the new year, never paid | +A | −A |
| unpaid at E and still unpaid at the next year end E2 | +A | −A + A (year end E2) = 0, reversed in the year after |

Why the reversal and not "book the later payment against 1510": C82 (e) settled it, and it keeps every new-year payment the ordinary cash-method voucher — no second kind of payment, no payment that must know whether its invoice was in a year end. Its one cost: an invoice unpaid at E and NOT paid in January shows a negative VAT figure in January's period until it is paid; over the year it nets to what it should. Accountants do this (the common "vändning"); the page's deadline (§3) puts the reversal before any new-year VAT return.

**Voucher texts** (Swedish, the books; ≤ 50 characters after CP437 — `voucherText` cuts the client's name):

- year end: `Bokslut obetald faktura 10001 Acme AB`
- reversal: `Återföring bokslut faktura 10001 Acme AB`
- year end withdrawn (§4): `Rättelse bokslut faktura 10001 Acme AB`
- reversal withdrawn (§4): `Rättelse återföring faktura 10001 Acme AB`

## 2. Which invoices are in the year end E

An invoice (kind `INVOICE`, issued) is in the year end E iff **all** of:

1. `issue_date ≤ E` — it existed in the old year. (The database holds `issue_date` to the UTC day of issue ± 1, so no invoice dated E can appear after the workspace's day has passed E — §8 notes the zone edge.)
2. **No payment stands in the BOOKS at E**: (PAYMENT entries with `booked_on ≤ E`) − (PAYMENT_UNDONE entries with `booked_on ≤ E`) = 0. This reads the FILES, not the current mark, on purpose: the old year's books already hold the sale of an invoice whose payment was booked in the old year, even if that payment was unmarked after the year turned (its reversal is dated the day of the file that made it, in the new year — slice 111's accepted "an undo after the year's turn lands in the new year"). Booking a receivable for it too would book the sale twice in the old year.
3. The current mark agrees: `paid_on IS NULL OR paid_on > E`. With rule §3.2 (nothing of the year waiting), a `paid_on ≤ E` always has a payment filed (so 2 already excluded it); this is the database's safety net against a payment marked a moment before the year end is booked.
4. A ≠ 0.

Every case:

| state when the year end is booked | in it? | why |
|---|---|---|
| never paid | yes | unpaid at E |
| paid on a day ≤ E, filed | no | the old year's books hold its sale |
| paid on a day > E (filed or not) | yes | it was unpaid at E |
| paid ≤ E and filed, then unmarked in the new year | no | the books still hold the sale in the old year (2) |
| paid ≤ E and filed, then unmarked and re-marked to a day > E | no | same — the new-year UNDONE and PAYMENT net to 0 in the new year |
| issued in an EARLIER year, still unpaid | yes | it is unpaid at E too; the earlier year end was reversed |
| credited in full by E | no | A = 0 |
| credited in full after E, never paid | yes | it was owed at E; the credit is the new year's |

## 3. When

### 3.1 The year end that is due

- `lastYE` = the newest year end already booked (the workspace's newest year-end file, §5), or none.
- `from` = `lastYE + 1` — or, before the first, the issue date of the workspace's EARLIEST issued invoice (nothing before it can be unpaid). No invoice → nothing is ever due.
- **E** = the last day of the financial year containing `from` (under the CURRENT `yearStart` — a changed financial year then yields a shortened transition year, the common case; an 18-month extended one is not offered — §8).
- **Due** iff the method is CASH and E < the workspace's today.

Year ends are booked in order, one at a time; a workspace that missed one books the older first (the reminder stays until the newest ended year is booked). A year with nothing unpaid still gets its year-end FILE, with no entries — the record that the year end was looked at, by whom and when, and what makes the next year due (otherwise the reminder could never be dismissed).

### 3.2 Nothing of the year may be waiting

**Book the year end is refused while any event dated on or before E waits for a file** (`INVOICE_YEAR_END_WAITING`; the card says how many and offers Make file). So the year-end file is the old year's last regular word, rule §2.2 reads complete books, and a December payment marked in January but not yet filed can never be mistaken for an unpaid invoice. The year cut (slice 111's `selectForFile`, earliest group first) already makes Make file produce the old year's files before the new year's — except where an old-year payment waits on a reversal dated today, which the year cut files first (re-check 1); the card's count then says one more Make file.

### 3.3 The deadline the page states

"Book it before you file the VAT return for the year's last period — the VAT on these invoices belongs there." Computed deadlines (12 February after a calendar year for a monthly or quarterly filer; 17 August after a June year; the annual filer's own date) are not shown: the product does not know the workspace's VAT period. Booking it by then also puts the reversal (E + 1) before any new-year VAT return (a January return is due 12 March).

## 4. A payment marked late (C83 (b))

After the year end E is booked, an invoice IN it (its year-end entry stands) gets `paid_on ≤ E`. The year end was wrong about it. The next files withdraw the invoice from the year end — exactly, on the year end's own days — and book the payment as any payment:

| event | dated | voucher | file |
|---|---|---|---|
| `YEAR_END_UNDONE` | E | the year-end voucher negated | the old year's |
| `PAYMENT` | `paid_on` (≤ E) | the ordinary payment voucher | the old year's — after the UNDONE |
| `YEAR_END_REVERSAL_UNDONE` — only if the reversal was already filed | E + 1 | the reversal negated | the new year's |

If the reversal has NOT been filed yet, it is simply no longer due (its year end no longer stands) and there is nothing to withdraw.

Result: both years exactly as if the invoice had never been in the year end — old year: the payment; new year: 0. Dating the withdrawal of the reversal at E + 1 (not the file's day, as `PAYMENT_UNDONE` is) is what makes it exact per year (even across a second year end: §8); its cost is a voucher in January's period after the fact, which the founder accepted with the old year's own correction ("the page warns").

**The warning** — on the next-file card when the next file books any event dated on or before the newest booked year end: "This file books into {the year ending E}, whose year end is already booked — a payment that came in by then was marked since, and the file corrects the year end. Before you import it, check with your accountant that this year is still open in Fortnox." (Generic: a re-mark of an already-booked old-year payment to another old-year day books into the closed year too.)

**Order.** A `PAYMENT` dated `p` waits (`dependsOn`) for the `YEAR_END_UNDONE` of every standing year end with E ≥ p; a `YEAR_END_REVERSAL_UNDONE` waits for its `YEAR_END_UNDONE`. In the same file, the UNDONEs go in the first INSERT statement (with `PAYMENT_UNDONE`), so the payment's guard sees them.

**Unmarked again** before the corrections are filed: nothing to correct (the plan reads the current mark). After they are filed: an ordinary `PAYMENT_UNDONE` in the new year — slice 111's accepted behaviour; the year end is never re-instated (one year-end file per year).

## 5. Data — two migrations (DDL only)

Postgres refuses a new enum value in the transaction that adds it ("unsafe use of new value") — and this slice's index and CHECKs use them. So:

**`20261011090000_invoice_year_end_events`** — only:

    ALTER TYPE invoice_export_event ADD VALUE 'YEAR_END';
    ALTER TYPE invoice_export_event ADD VALUE 'YEAR_END_REVERSED';
    ALTER TYPE invoice_export_event ADD VALUE 'YEAR_END_UNDONE';
    ALTER TYPE invoice_export_event ADD VALUE 'YEAR_END_REVERSAL_UNDONE';

**`20261011090100_invoice_year_end`**:

1. `invoice_export.year_end DATE NULL` — "this file books the year end E". CHECKs: `year_end IS NULL OR method = 'CASH'`; `year_end IS NULL OR made_on > year_end`; `year_end IS NULL OR extract(day FROM year_end + 1) = 1` (a year ends on a month's last day). UNIQUE `(tenant_id, year_end) WHERE year_end IS NOT NULL`. `invoice_export_guard` (replaced) adds, under the lock: a new year-end file's `year_end` is after every earlier one of the workspace.
2. `invoice_export_entry`: UNIQUE `(tenant_id, invoice_id, event, booked_on) WHERE event IN (the four)` — each year-end event once per invoice and year (the reversal pair is keyed by E + 1, the date it is booked on). CHECK: the four always carry a voucher.
3. `invoice_export_entry_guard` (replaced; everything slice 111's does, plus):
   - a year-end file holds `YEAR_END` entries only, and a `YEAR_END` entry only goes in the year-end file of its year: `(NEW.event = 'YEAR_END') = (file.year_end IS NOT NULL)` and `booked_on = file.year_end`;
   - **`YEAR_END`** (E = `booked_on`): an INVOICE; `issue_date ≤ E`; `paid_on IS NULL OR paid_on > E`; no payment standing in the books at E (§2.2's count, this transaction's earlier entries included);
   - **`YEAR_END_REVERSED`** (E = `booked_on − 1`): a `YEAR_END` of the invoice at E, not withdrawn; `paid_on IS NULL OR paid_on > E`; its voucher the exact row-by-row negation of the year end's (`invoice_export_rows_negated`);
   - **`YEAR_END_UNDONE`** (E = `booked_on`): a `YEAR_END` at E; `paid_on ≤ E` (the reason it is withdrawn); the negation of the year end's voucher;
   - **`YEAR_END_REVERSAL_UNDONE`** (E = `booked_on − 1`): a `YEAR_END_REVERSED` at `booked_on` and a `YEAR_END_UNDONE` at E; the negation of the reversal's voucher;
   - **`PAYMENT`** gains: refused while a `YEAR_END` of the invoice at any E ≥ `booked_on` stands (not withdrawn);
   - the existing method check `(event = 'ISSUE') = (method = 'INVOICE')` already keeps all four out of an INVOICE-method file.

No new table, no new permission (the codes of slice 111: `invoice:export` + `invoice:view` + a tenant-wide scope), no catalogue or template version change. Prisma: `InvoiceExport.yearEnd DateTime? @db.Date`, the enum's four values. Existing rows: no `year_end` (NULL) and no such event — the CHECKs hold on them trivially (dev: one tenant has files at most; probed before apply as slice 111's were).

## 6. App

### 6.1 Pure modules

- `bookkeeping-accounts.ts`: `financialYearEndOf(day, yearStart)` — the last day of the financial year a day falls in.
- `bookkeeping-year-end.ts` (new, pure): `dueYearEnd({ method, yearStart, today, lastYearEnd, firstIssue })` → E | null; `yearEndCorrections(state)` → which of `YEAR_END_REVERSED` / `YEAR_END_UNDONE` / `YEAR_END_REVERSAL_UNDONE` an invoice's standing year end needs now, from (the year end, whether withdrawn, the reversal and whether withdrawn, the current `paid_on`). Unit-tested on every row of §2 and §4.
- `vouchers.ts`: `yearEndVoucher(inv, A, E, s)`; `reversalOf` takes its text's word (`Återförd inbetalning` / `Återföring bokslut faktura` / `Rättelse bokslut faktura` / `Rättelse återföring faktura`).
- `invoice-list.ts`: the four events; remarks `reversesYearEnd` (day E, the year-end file), `paidByYearEnd` (day = `paid_on`, the year-end file), `undoesReversal` (day E + 1, the reversal's file). A year-end row's `relates` = the credit notes deducted.

### 6.2 The service (`bookkeeping.ts`)

- `yearEndStates(tx, tenantId)` — ONE statement: per (invoice, E) with a `YEAR_END` entry that still needs something (§4 / reversal due): the year end's voucher, detail and file number, whether withdrawn, the reversal (voucher, file number) and whether withdrawn, the invoice's `paid_on`.
- `plan()` (CASH) adds the corrections and reversals as candidates (keys `event:invoice:E`), `PAYMENT`'s new dependencies, and the year-end invoices to `stateIds` (locked `FOR SHARE` by a maker, re-read under the lock — slice 111's loop).
- `build()` handles the four events (detail amounts signed as booked: year end +, reversal −, withdrawal −, reversal withdrawn +). `createExport` puts `YEAR_END_UNDONE` in the first INSERT with `PAYMENT_UNDONE`. A regular file never holds `YEAR_END` (only `bookYearEnd` writes it).
- `planYearEnd(tx, tenantId, E, settings)` — §2's set: one SQL read of the candidate invoices (§2.1–2.3), `loadDocs`, their credit notes dated ≤ E, `lessCredits`, `yearEndVoucher`; A = 0 dropped. Sorted by invoice number.
- **`bookYearEnd(ctx, { yearEnd, now })`** — the gates (`openBookkeeping`); `invoice_export_lock`; the method (the files', else the setting's) must be CASH; E = `dueYearEnd(…)` and must equal the `yearEnd` the person saw (`INVOICE_YEAR_END_NOT_DUE` otherwise — booked meanwhile, or not ended); `plan()` → any candidate dated ≤ E → `INVOICE_YEAR_END_WAITING`; `planYearEnd` → lock its invoices `FOR SHARE` in id order → read again (until nothing new to lock); more than one seller (the frozen `seller_snapshot`'s org. number) → `INVOICE_YEAR_END_SELLERS`; the file (`year_end` = E, numbered by the database) and its entries (`createMany`, chunks of 250); audit `invoice_export.year_end_booked` {number, yearEnd, invoices, totalSek}. Lock timeout/deadlock → `INVOICE_EXPORT_BUSY`. Returns {id, number, count}.
- `readBookkeeping` gains: `yearEnd` (when due: E, how many events dated ≤ E wait, and the preview — count, total in kronor, the first 50 rows: number, client, invoice date, total SEK); `next.intoBookedYear` (E of the newest booked year end when the next file books on or before it); each file's `yearEnd`.
- `readYearEndReminder(ctx)` → E | null — for `/invoices`; called only where the page already showed the Bookkeeping link (`canExport`); two aggregates and the method.

### 6.3 UI

- **`/invoices/bookkeeping`** — a **Year end** card (CASH, when due), above "New since the last file":
  - title "Year end: 31 December 2026"; "These invoices weren't paid on 31 December 2026. Booking the year end puts them in your books on that day and takes them out again on 1 January 2027, so their payments book as usual.";
  - while events dated ≤ E wait: a caution — "N entries from that year still go in a file — make files until none is left." — and the button disabled;
  - else the preview table (number, client, invoice date, amount SEK; "and N more"), the total, "Mark every payment that came in by 31 December 2026 first." and **Book the year end** → a dialog: "Book the year end for 31 December 2026? N invoices, X kr. A payment marked later corrects it in a later file." [Cancel] [Book the year end] → toast "The year end is booked in file N." (none unpaid: "Nothing was unpaid on 31 December 2026 — recorded in file N.");
  - a line: "Book it before you file the VAT return for the year's last period — the VAT on these invoices belongs there."; and "A credit note issued after its invoice was paid isn't part of the year end — if the refund wasn't paid by then, tell your accountant."
- The next-file card: counts for the new events ("N year-end entries reversed on 1 January 2027", "N invoices taken out of the year end — paid by then", "N reversals taken back"), and the warning of §4.
- The files table: a year-end file's name reads "File 7 · Year end 2026".
- Help: the CASH line "Invoices still unpaid when the year ends aren't in these files yet…" becomes "When the financial year ends, book the invoices still unpaid on its last day here — Book the year end."
- **`/invoices`** — a caution Callout under the header for a member who sees the Bookkeeping link, while a year end is due: "The financial year ended on 31 December 2026. Book the invoices still unpaid then. [Book the year end]" (a link to `/invoices/bookkeeping#year-end`).
- `book-year-end.tsx` — the client dialog (`paid-dialog.tsx`'s shape: `Dialog` + `DialogTrigger`, busy as plain state, `ActionResult` toasted, `isActionRedirect`); `bookYearEndAction(yearEnd)` in `actions.ts`, tenant and actor from `requireTenantContext()`.

## 7. Permissions, audit, errors

- No new permission. `bookYearEnd` takes `openBookkeeping`'s gates (`invoice:view`, `invoice:export`, the tenant-wide scope) — the same people who make files.
- Audit: `invoice_export.year_end_booked` (TENANT) — catalogue entry with what its metadata holds. Regular files keep `invoice_export.created` (its byEvent counts gain the new events).
- Errors (`domain-error.ts` + both message files): `INVOICE_YEAR_END_NOT_DUE`, `INVOICE_YEAR_END_WAITING`, `INVOICE_YEAR_END_SELLERS`.
- Nothing reaches a client: both tables are class A; no portal projection changes.

## 8. Edges, and what this slice does not do

- **An 18-month transition year** (a changed financial year extended rather than shortened): not offered — the next year end is always the end of the financial year containing `lastYE + 1` under the current `yearStart`.
- **A workspace's time zone changed across the year turn** could let an invoice be issued dated E after the year end was booked; it would be missed by the year end (and booked as a new-year sale when paid). Not guarded; noted in DATA_MODEL.
- **Two sellers in one year end** (the frozen org. number changed mid-year — a different company's books): refused with `INVOICE_YEAR_END_SELLERS`; the reminder stays; the accountant books it by hand.
- **A re-mark of an old-year payment to another old-year day after the year turn** books an UNDONE in the new year and the PAYMENT in the old one (slice 111's behaviour, unchanged; the §4 warning now names it).
- **Foreign-currency receivables at the balance-sheet day** are booked at the invoice's booking rate; revaluing them at the closing rate (K2/K3) is the accountant's — on the list for the accountant (§11).
- **Credit notes issued after payment** (a refund owed at E) are not booked by Fortleva — the card says so (§6.3).
- **Multi-year correction exactness:** an invoice in year ends E1 and E2 then marked paid on a day ≤ E1: withdrawals of both year ends and both reversals, each on its own day — exact per year. Unit-tested in the pure planner; the dbtest walks the one-year case.

## 9. Tests

- **Unit:** `financialYearEndOf`; `dueYearEnd` (first year from the earliest invoice, the next after `lastYE`, a transition year, not due on E itself, INVOICE method); `yearEndCorrections` (every row of §4, the multi-year case); `yearEndVoucher` signed rows and texts ≤ 50 characters with a 60-character name; `selectForFile` with a PAYMENT waiting on a YEAR_END_UNDONE of the same year and a REVERSAL_UNDONE waiting on one of the year before; the list's new events and remarks.
- **dbtest, local (`bookkeeping.dbtest.ts`, its CASH workspace — no planting):** nothing due while every invoice is of the current year (`readBookkeeping().yearEnd` null, `bookYearEnd` → `INVOICE_YEAR_END_NOT_DUE`); raw writes the database refuses: a year-end file under the INVOICE method, one dated on or before its year end, one not ending a month, a second for the same year, an older one after a newer; a `YEAR_END` entry in a regular file and any other event in a year-end file; a `YEAR_END` for an invoice issued after E (every invoice here is — today); a `YEAR_END_REVERSED` / `YEAR_END_UNDONE` / `YEAR_END_REVERSAL_UNDONE` with no year end.
- **dbtest, CI only (`year-end.dbtest.ts`):** past-dated invoices are PLANTED — issued through the real services, then their `issue_date`/`due_date` moved back through the superuser OWNER connection with `session_replication_role = replica` for that one statement (`sealed-time.dbtest.ts`'s and `retention.dbtest.ts`'s precedent; it skips locally, FAILS in CI if the owner is not a superuser). A CASH workspace with `yearStart` = this month (so E = the last day of last month), then the walk: an unpaid invoice, one paid before E, one paid after E, one part-credited before E, one credited in full before E → `bookYearEnd` refused while the paid-before-E payment waits → Make file → the preview names exactly the right three with the right amounts → `bookYearEnd` → the year-end file's vouchers (1510 debit, sales and VAT credit; signs pinned; the credit deducted) → booked again → `NOT_DUE` → Make file → the new year's file: the reversals (dated E + 1, exact negations) and the after-E payment → a late payment on E − 1 of an invoice whose reversal is filed: the old year's file `YEAR_END_UNDONE` then `PAYMENT`, the new year's `YEAR_END_REVERSAL_UNDONE` at E + 1 → a late payment of one whose reversal is NOT yet filed: only the withdrawal and the payment, no reversal ever → the warning (`next.intoBookedYear`) → the SIE and the list of the year-end file (texts, remarks); and the database's refusals that need a past date: a `PAYMENT` ≤ E while its year end stands, a `YEAR_END` for an invoice paid ≤ E, a reversal of a withdrawn year end.
- **e2e, CI only (`invoices-year-end.spec.ts`):** the fixture owner's empty SECOND workspace (`seed-cli.ts`) readied by a new CI-only seed command `year-end-workspace` (company and payment details, a client, two SEK invoices issued through the services, CASH, `yearStart` = this month, the invoices' dates planted back through the owner connection; prints `planted:false` and the spec skips where the owner is not a superuser): switch to it, `/invoices` shows the reminder, `/invoices/bookkeeping` the card with both invoices, Book the year end → the dialog → the toast and "File 1 · Year end", the next-file card names the two reversals; switch back in `afterEach` (`account.spec.ts`'s precedent — the session's workspace pointer is shared). No visual stop: the state exists only where planting does (CI), and CI writes no screenshots.

## 10. Docs

DATA_MODEL §6.7 (the year end, the events, the guard's rules, the edges), PLAN §0, AUTHZ (the year end under `invoice:export`), the audit catalogue comment, the page's help, the accountant's list in PLAN §0 (§11).

## 11. For the accountant (PLAN §0, beside slice 111's)

- The reversal method (vändning) and its January VAT figure for invoices still unpaid then.
- Foreign-currency receivables at the balance-sheet day: revalue at the closing rate if the company's framework (K2/K3) asks.
- Refunds owed at year end on credit notes issued after payment.
- A late correction into a year already closed in Fortnox cannot be imported there — book it by hand.

## 12. Questions for the design review

1. Is rule §2.2 (the BOOKS at E, not the current mark) right in every case of the table, and is any invoice booked twice or never in either year?
2. §3.2 refuses the year end while anything dated ≤ E waits. Can it ever stall (an event dated ≤ E that can never be filed)?
3. §4's withdrawal of the reversal at E + 1 rather than the file's day — exact per year, but it lands in January's VAT period after the fact. Better the other way?
4. The guard's `PAYMENT` rule "refused while a year end at any E ≥ `booked_on` stands" — too strict, too loose?
5. Concurrency: `bookYearEnd` against Mark as paid / unpaid, against `createExport`, against a settings save changing `yearStart` (it takes the export lock first).
6. The CI-only e2e in the second workspace — worth its weight, or does the shared session pointer make it a flake source?
7. Anything a reviewer of slice 111's guard would see broken by replacing `invoice_export_entry_guard` and `invoice_export_guard` (both re-created whole).

## 13. Revised after the design review (2026-10-10) — OVERRIDES the body where they differ

One fresh agent, read-only. **H1, M1–M3, L1–L10 and the NITs all taken** as below.

### 13.1 The year end is the CURRENT company's — it never refuses (H1)

`INVOICE_YEAR_END_SELLERS` is gone: a refused year never got a file, so `lastYE` never moved and no later year end could ever be due — a permanent wedge (an org. number fixed with the code mid-year is enough). Now the year end books only the invoices whose frozen `seller_snapshot` org. number (digits only) is the workspace's CURRENT one (`tenant.org_nr`; before one is set, the newest issued invoice's seller). Unpaid invoices of another org. number are LEFT OUT and named on the card ("N unpaid invoices name organisation number X — another company's books, not in this year end; if it is the same company, book them by hand with your accountant"). The year-end file is always made.

### 13.2 A withdrawal never goes without the payment that justifies it (M1, M2)

- **Units.** `selectForFile` gains `companion`: candidates linked by it (union-find) are taken together — all in one file, or none — when they share a group (else each stands alone, its dependencies still holding). The plan links to a `PAYMENT` its `YEAR_END_UNDONE` (the invoice's year end at the SMALLEST E ≥ the payment day) and its `PAYMENT_UNDONE` when that is dated in the payment's own year (13.3). So the reviewer's paths (a), (b), (c) — the withdrawal filed alone, then the payment unmarked — cannot occur: Y1 = +A − A + A, or nothing withdrawn.
- **Later year ends.** A `YEAR_END_UNDONE` at a LATER E2 waits (`dependsOn`) for the payment, and is due by the BOOKS: `paidByE` = `paid_on ≤ E` OR a payment stands in the books at E (§2.2's count). The guard matches: `PAYMENT` is refused only while the year end at the smallest `year_end ≥ booked_on` stands; `YEAR_END_UNDONE` allowed when `paid_on ≤ E` OR a payment stands at E; `YEAR_END_REVERSED` refused when the year end is withdrawn, or `paid_on ≤ E`, or a payment stands at E.
- **M2** (already true of the code, wrong in §4's text): a reversal's withdrawal is due whenever its year end is withdrawn and the reversal filed and not withdrawn — whatever the current mark. Unit-tested.

### 13.3 A payment's date corrected inside an ended year stays in that year (M3)

Slice 111 dated every `PAYMENT_UNDONE` on the file's day: a December payment corrected in January to another December day booked Y1 = 2A (its VAT twice in the year's last return), Y2 = −A. Now, when the booked day and the new `paid_on` lie in the SAME ENDED financial year, the undo is dated that year's LAST DAY; otherwise (moved across a year, or unmarked) the file's day, as before (exact: Y1 = A, Y2 = −A + A). Guard: `booked_on = made_on`, OR `booked_on < made_on`, a month's last day, on or after both the booked payment's day and the new `paid_on`.

### 13.4 Dates and keys (L1, L2, L5)

- **L1:** the reversal's withdrawal is dated the FILE'S DAY — clamped to the last day of E + 1's financial year once that has ended — not E + 1: same yearly total, and it never reopens January's VAT period (usually filed, and locked in Fortnox, by the time a late payment turns up). Guard: E + 1 ≤ `booked_on` ≤ `made_on`.
- So `booked_on` no longer names the year end: **`invoice_export_entry.year_end DATE NULL`** — set exactly on the four events (CHECK), the unique key `(tenant_id, invoice_id, event, year_end)`; YEAR_END and YEAR_END_UNDONE booked on it, YEAR_END_REVERSED on it + 1.
- **L2:** changing `yearStart` now also wants `invoice:export` (it decides what a file holds and when a year end falls — as the method); and the year cut ALSO splits at booked year ends (group key = financial year | how many booked year ends precede the day | seller), so no file straddles a booked year end after a changed financial year. The settings card's help says the next year end follows the setting.
- **L5:** `invoice_year_end_issue_guard` — leaving DRAFT with an `issue_date` on or before a booked year end is refused (a time-zone change, or an issue in flight at midnight, would otherwise be missed by the year end and its credit note deducted in Y2). Its own trigger (BEFORE UPDATE OF status), so `invoice_guard` is not replaced again; `issue.dbtest`'s BEFORE-trigger census widened.

### 13.5 The press and the plan (L3, L4, L6, NITs)

- **L3:** credit-note listings (no voucher) do not hold the year end back — the year end deducts credit notes by their date anyway. `plan()` throws on a dependency that is no candidate (a stranded event is a bug). The card counts "entries dated on or before {day}".
- **L4:** `bookYearEnd` locks the invoices the year end reads FIRST, then makes the §3.2 check under those locks; and the press carries what the dialog showed (count and total) — anything else is `INVOICE_YEAR_END_CHANGED` ("look again").
- **L6:** an invoice whose amount LEFT in its own currency is 0 is not in the year end (a kronor remainder of two partial credits in USD would book −0,01 kr); nor one whose voucher is empty.
- **NIT:** the entry guard branches on every event by NAME and raises on an unknown one (the old `ELSE`s were catch-alls). Consecutive year ends and "a year end at E2 needs every earlier one reversed" stay app-held.

### 13.6 Tests, copy, the accountant (L7–L10)

- **L7:** planting order — the ORIGINAL's dates before its credit note is issued (`invoice_credits_reference` is a CHECK: `credits_issue_date ≤ issue_date`, copied at issue), then the credit note's `issue_date` and `due_date` together; the walk reordered (the "reversal not yet filed" late payment before the new year's first file); the M1, M2, M3 sequences; prefix `bkye-` registered; the local raw year-end tests are rolled back (they are).
- **L8:** the e2e's seed command RESETS the second workspace first (entries, files, invoices under the maintenance setting) and plants again, so a CI retry finds the card; "this month" from the workspace's Stockholm day; the second workspace's "deliberately empty" note updated.
- **L9:** the `/invoices` reminder carries the condition ("…once every payment that came in by then is marked"); Mark as paid says so when the chosen day is on or before the newest booked year end ("…the next bookkeeping file corrects it").
- **L10:** for the accountant, also: prepayments (a payment dated up to 366 days before its invoice, booked as the old year's sale, is an advance at year end) and work done in the old year but invoiced in the new.

## 14. The narrow re-check of §13 (the same reviewer, 2026-10-10) and what was done

Closes M1 (a)(b)(c) and M2; H1 no longer a wedge. Findings:

1. **MEDIUM R1 — the group chosen from a member that cannot go would stall Make file for good.** Already so in the code: `selectForFile` decides fileability per UNIT (every member's outside dependencies filed or in this file) and takes the group from the earliest member of the earliest ready unit; the exact set (a January payment corrected to 30 December) is pinned in `bookkeeping-select.test.ts` — files: the undo (Y2), then the unit (Y1), then the reversal's withdrawal (Y2).
2. **MEDIUM R2 — "the invoice's year end at the smallest E ≥ p" (13.2's words) differed from the guard.** TAKEN: the companion is the invoice's year end at the WORKSPACE's earliest booked year end on or after the payment day, if it stands — and the guard tests exactly that (`min(invoice_export.year_end) ≥ booked_on`); every other withdrawal of the invoice at E ≥ p waits on the payment; `plan()` throws on a dependency or companion that is no candidate. No cycle: the payment lists only its companion (internal to the unit).
3. **LOW R3 — the guard's weak form must not accept an unmark dated back.** TAKEN: the backdated branch spells every test out (no `IF NOT (… NULL …)`); re-marked: a month's last day before the file's, on or after both days, and no booked year end between the later day and it; unmarked: only while no year end on or after the booked day is booked. Raw tests in both dbtests.
4. **LOW R4 — unmark, file, re-mark into the same ended year booked it twice.** TAKEN for the year not yet closed: an unmark of a payment of an ENDED year whose year end is not booked is dated the last day of the booked day's month (the year end then sees it unpaid; a re-mark into that year books it once). After the year end is booked an unmark stays on the file's day (right for "still unpaid"); a re-mark into the closed year then books it twice — named in Mark as paid's warning and the file's warning ("…and that nothing in it was already booked there by hand"), and on the accountant's list.
5. **LOW R5 — the month, not the year.** TAKEN: a corrected payment's reversal is dated the last day of the LATER day's month (`paymentUndoDay`), so each VAT period is as exact as one voucher can make it.
6. **LOW R6 — a changed `yearStart` cut through a booked year.** TAKEN: `periodEndOf` — on or before the newest booked year end the booked year ends mark the years (before the first, the years ending where it ends); after it, the setting's financial year. Used for the group, "the same ended year", and the clamp.
7. **LOW R7 — the reversal's withdrawal not held to its clamp.** TAKEN: the guard refuses one dated after the next booked year end.
8. **LOW R8 — the company by the card now.** TAKEN: the seller of the newest invoice issued on or before E. A typo fixed before E still leaves invoices out (named on the card, for the accountant); a "same company — include them" choice: not now.
9. **NITs taken:** "precede" is moot (the period's last day is the key); an empty file takes its first unit whole past a small cap; the issue guard's token mapped (`INVOICE_YEAR_CLOSED`, a sentence: a zone change can reach it); the year end becomes due — and the database admits its file — from the SECOND day after the year (`made_on > year_end + 1`), so no issue dated E can still be in flight; the file's warning ignores credit-note listings.

**Accepted, written down:** a prepayment dated before its invoice's issue, in an earlier year than the year end it is in, marked late — its withdrawal and payment fall in different years, so they cannot share a file; an unmark between those two files would leave the later year short until the next year end accrues it again. The design's §8 multi-year case with every mark in between: the same.

## 15. The migration's pre-apply review, and the code and security reviews (2026-10-10)

**Pre-apply (1 agent; no HIGH/MEDIUM):** the enum migration's comment on the reversal's withdrawal was stale (E + 1 → the file's day) — fixed BEFORE the apply (the schema's too); a note that the payment-reversal date was held only in a weaker form by the database — superseded below. NOT taken: mapping a payment day before the first booked year end into that year end's group (it would put a voucher of an earlier Fortnox year in the same file — slice 111's M1; §14's accepted edge stands). Applied with `prisma migrate deploy`; both ledger checksums = the files (`fbaea2e8…`, `9f8e643b…`).

**Code review (1 agent): no HIGH/MEDIUM.** **Security review (1 agent, in parallel): no HIGH/MEDIUM.** Taken:

1. **LOW (code) — a payment's day MOVED TO ANOTHER YEAR, its booked year ended and not closed, misstated two years** (the undo on the file's day: the booked year kept the payment). TAKEN: dated the last day of the BOOKED day's month (`paymentUndoDay`) — the booked year as if it never held the payment, the new day's year booking it once; unit-tested both ways.
2. **LOW (security) = the forward half of 1 — the database admitted any month's last day in a wide window, and refused the one day a forward move needs.** TAKEN as ONE forward migration, `20261011090200_invoice_year_end_exact_dates` (the applied one is never edited): `invoice_export_entry_guard` re-created whole, every rule kept but the backdated PAYMENT_UNDONE, now EXACTLY one of two days before the file's — re-marked within its year: the later day's month end, no booked year end between; unmarked or moved to another year: the booked day's month end, only while no year end on or after it is booked. `date_trunc` on `::timestamp` (no session-zone arithmetic).
3. **LOW (code) = NIT (security) — the CI-only e2e could go green unrun.** TAKEN: the seed throws in CI without a superuser; the spec skips only outside CI and asserts `planted` in CI.
4. **LOW (code) — the card stale after a refused press.** TAKEN: the action revalidates the page on every outcome.
5. **LOW (security) — the seed's superuser write gated by `rolsuper` alone.** TAKEN: CI or `DBTEST_ALLOW_REPLICA=1` first, the throwaway-tenant check BEFORE the connection is opened.
6. **LOW (security) — no ceiling on a year end.** Recorded (DATA_MODEL): one transaction for every unpaid invoice of the year; thousands are far beyond an agency's — not split, not capped.
7. **NITs taken:** `scroll-mt-16` on the card (the reminder's anchor); the settings card's financial-year hint (13.4's promise); the left-out list keyed by the number's digits; the M2 test's "file's day" read from the file's own `made_on` (a CI run crossing midnight); the seed's orphaned comment moved back.
8. **NITs not taken:** the closed-year issue guard takes no lock (E + 2 and the workspace's own day close the window — §14); a YEAR_END voucher's amounts are app-trusted (slice 111's PAYMENT precedent); `readNewestYearEnd` on `invoice:view` alone (intended — Mark as paid's hint).
