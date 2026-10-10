# Slice 110b — THE TIME BREAKDOWN PAGE ON THE INVOICE PDF (Phase 4 step 4's second half; founder decisions C80 (d), C81)

*Draft 2026-10-10, before the design review.*

## 0. What was decided

- **C80 (d)** — an OPTIONAL hours page on the invoice's PDF: a tick on the draft, OFF by default, adds a page listing each day's hours and what they were for — tasks the client cannot see as "Other work", never who did the work — FIXED AT ISSUE like the rest of the invoice.
- **C81 (a)** (2026-10-10, with the recommendation) — **no notes**: each row is the day, the task (or "Other work") and the hours, ONE ROW PER DAY PER TASK. A time entry's note is never printed (the client time report's rule: notes are written for the team).
- **C81 (b)** (with the recommendation) — hours written as **hours and minutes** ("1:30"), adding up exactly; each line's total also carries the decimal hours ("12:30 (12,5 h)").

Readings this design takes (each a question for the review, §9):

1. **"What they were for" is the task.** An hour with no task (project-level) and an hour of a task the client may not see both print as "Other work", merged per day — the client learns nothing about which internal tasks exist.
2. **The page is grouped by invoice LINE** — the line's text as on page 1 heads its hours, so the client can check each line against them. Every line made from hours is one project's (`hoursLines` splits by project), so no project column is needed. A PERSON line's heading carries a person's name because page 1 does (the issuer chose Person lines, with the warning); the page itself adds no name.
3. **"Adds up exactly"** (C81 (b)): rows are `h:mm` when every row and total on the page is a whole number of minutes — always, when the line's project rounds (any step is whole minutes). A project with rounding OFF bills raw seconds; then the whole page prints `h:mm:ss`, so it still adds up. The "(12,5 h)" is the HOURS' own decimal (`hoursQuantity` of the line's summed billed seconds — what the line said when it was made); if a member edited the line's quantity since (slice 110 allows it), page 1 says the edited figure and the breakdown says what was worked. Truthful, and the client can see the difference.
4. **The DATABASE writes the page** (§1.3), as it writes the seller's and buyer's snapshots: what a client reads about tasks is held by the database, not by app code alone (AGENTS.md: visibility is safety-critical). ONE implementation — a SQL function — serves the guard at issue, the draft's preview and the issue fingerprint, so what the issuer saw is what is frozen.
5. **Never on a credit note** (CHECK). The CORRECTED COPY (C77 (c)) carries its original's tick — it bills the same hours.
6. **No tick without hours**: the control shows on an INVOICE draft that holds hours, or whose tick is on (so it can be turned off). A tick on a draft with no hours left prints nothing (the page is NULL) — never a refusal.

## 1. Data — migration `20261010210000_invoice_hours_page` (DDL only)

### 1.1 `invoice` gains two columns

- `include_hours BOOLEAN NOT NULL DEFAULT false` — the draft's tick (C80 (d)); fixed at issue by `invoice_guard`'s existing frozen-row diff (it is not in `mutable`).
- `hours_page JSONB NULL` — the frozen page, written at issue BY THE GUARD (§1.3), NULL otherwise.
- CHECK `invoice_include_hours_kind`: `NOT include_hours OR kind = 'INVOICE'`.
- CHECK `invoice_hours_page_issued`: `hours_page IS NULL OR (include_hours AND status <> 'DRAFT')` — a draft never carries one; an INSERT never does.

`invoice` is class B (slice 109): a main contact's RLS reads the whole sent row. Both columns are what the client's PDF prints, so neither joins `PORTAL_NEVER_SELECTED`; no portal projection selects them (the PDF is the client's copy, `invoice_line` stays class A).

### 1.2 `work_item_named_to_client(p_tenant text, p_item text) RETURNS boolean` — STABLE, SQL

The SQL twin of `namedTaskShared` (`src/modules/time/reports.ts`) as `sharedTasks` (`hours-record.ts`) applies it: CLIENT_VISIBLE, and — if soft-deleted — its parent (when it has one) and its root (when it is not its own) are CLIENT_VISIBLE; an ancestor that no longer exists counts as INTERNAL; an id that does not exist is false. A dbtest builds the matrix as real rows (live/deleted × own visibility × parent and root visibility, the tree trigger's legal states) and holds both answers equal.

### 1.3 `invoice_hours_page(p_tenant text, p_invoice text) RETURNS jsonb` — STABLE, SQL

From the invoice's RECORD (`invoice_line_time_entry` — the snapshot of each hour as it was added: day, task id, billed seconds), never the live entries:

```
{ "version": 1,
  "lines": [ { "lineId": "<invoice_line.id>",
               "rows": [ { "date": "YYYY-MM-DD", "task": "<title>" | null, "seconds": <int> }, … ] }, … ] }
```

- `task` is the task's title (trimmed, at most 500 characters; empty → null) when `work_item_named_to_client` holds NOW, else null ("Other work" — printed in the invoice's language by the drawing).
- Rows grouped by (line, day, task text), seconds summed; ordered by day, named tasks before "Other work", then title (`COLLATE "C"`, deterministic). Lines in their position order; lines without hours left out.
- NULL when the invoice records no hours.
- SECURITY INVOKER: it runs as the issuing member (tenant isolation, as every other read in the issue); no contact can call it usefully (class A record).

### 1.4 `invoice_billed_hours_guard` replaced (still its own trigger, still BEFORE `invoice_guard` by name)

Its trigger stays `BEFORE UPDATE OF status, currency` (every exit from DRAFT names `status`; §10, NIT 9). Added:

- **Leaving DRAFT**: after the existing mismatch check, `NEW.hours_page := CASE WHEN NEW.include_hours THEN invoice_hours_page(NEW.tenant_id, NEW.id) END` — whatever the application sent is overwritten (the snapshots' rule).
- **While a draft**: `hours_page` stays NULL (the CHECK also says so); `include_hours` changes freely (a member's draft edit — `invoice_guard`'s draft branch already requires a member).
- After issue: `invoice_guard`'s frozen-row diff holds both columns (neither is in `mutable`) — the trigger needs nothing more there.

No DML; the CHECKs validate against `false`/NULL on every existing row. No `neon-smoke` owed.

## 2. App

### 2.1 Service (`src/modules/invoicing`)

- `DraftDetailsPatch.includeHours` (boolean) — `updateDraftDetails`; an INVOICE's only (not in `CREDIT_NOTE_FIELDS`, so a credit note refuses it); audited `invoice.draft_edited` with the field, as every detail.
- `hours-page.ts` (new, pure): `HoursPagePrint` types; `readHoursPage(raw, lineIds)` — STRICT validation of the stored/returned JSON (version, every `lineId` one of the invoice's lines, ISO dates, `task` string-or-null, whole non-negative seconds; any failure → `SnapshotUnreadable`); `hoursPageWithSeconds(page)`; `printHoursMinutes(seconds, withSeconds)` → "12:30" / "12:30:05".
- `readHoursPageLive(tx, tenantId, invoiceId)` → the function's TEXT and its parsed page (one statement, `::text` — the fingerprint hashes what Postgres returned, never a re-serialisation).
- `readIssueFingerprint`: when `include_hours`, appends `["hoursPage", <the function's text>]` (appended only then, so every existing canonical form keeps its prefix — the Pay-now precedent). A task renamed or made private between the page and the click is INVOICE_CHANGED.
- `issueLocked`: unchanged writes (the guard writes the page); `invoice.issued`'s metadata gains `hoursPage: { lines, rows }` (counts only) when one was written — read from the update's `RETURNING` (`select: { hoursPage: true }`).
- `readIssuedInvoice` → `InvoicePrint.hoursPage: HoursPagePrint | null` (each line's description and the decimal quantity of its hours joined from the frozen lines); unreadable → `SnapshotUnreadable` in both modes (as the parties' snapshots).
- `getInvoice` → `includeHours`, `hoursAvailable` (the draft records hours), `hoursPage` (a draft with the tick: the live function; issued: the frozen page) for the page's card.
- `writeCorrectedCopy` copies `includeHours`.
- `INVOICE_PDF_TEMPLATE_VERSION` 2 → 3.

### 2.2 The PDF (`pdf/invoice-pdf.tsx`)

When `hoursPage` is set (an INVOICE only), a SECOND `<Page>` after the invoice's: a fixed head on every page of it — "Time breakdown" / "Tidsspecifikation" and "Invoice 1042" / "Faktura 1042" — and the same fixed foot (who issued it). Then, per line: its text (semi-bold) and a table — Date · Work · Hours (`YYYY-MM-DD`, the task or "Other work", `h:mm` right-aligned) — and a total row "Total 12:30 (12,5 h)". Rows never split (`wrap={false}`); a line's heading keeps its first rows with it (`minPresenceAhead`). Arbitrarily many rows flow over as many pages as they need.

### 2.3 The draft and the issued invoice (`/invoices/[id]`)

- **Details card**: a switch "Time breakdown in the PDF" with its one-line consequence ("Adds a page listing each day's hours and tasks. Tasks the client can't see show as “Other work”; nobody's name is printed."), on an INVOICE draft with hours (or with the tick on); `invoice:edit`; the portal tab's switch pattern (`run`, pending, not optimistic — the page re-renders with the card). On an issued invoice with hours: read-only "Included" / "Not included".
- **A "Time breakdown" card** below the lines when the tick is on (draft) or the page was printed (issued): "What the client sees on the PDF" — per line its text, then Date · Work · Hours, then the total — drawn from the same function the guard runs (draft) or the frozen page (issued). At most 300 rows shown; past that, "N more rows are on the PDF".
- **The issue dialog**: one line, "The PDF includes a time breakdown page.", when the tick is on and there are hours.

### 2.4 Out of scope

The portal's invoice page (the PDF is the client's copy and carries it); a per-client default for the tick; notes (C81 (a)); a breakdown on credit notes.

## 3. Permissions, audit, catalogue

No new code, no seed owed by this slice (TV13/TV14 still are). The tick is `invoice:edit` (a draft field); the card is `invoice:view` (it shows only what the client will). Audit: `invoice.draft_edited` (field `includeHours`), `invoice.issued` (`hoursPage` counts). No new action.

## 4. What reaches the client (SECURITY §9.7.3 gains a sentence)

The page prints, per line: the line's text (already printed), each day, the TITLE of a task the client may see by the time report's one rule — decided by the DATABASE at issue —, "Other work" for every other hour, and hours. Never a member, a note, a rate, a project key or an internal title. The residual is slice 110's: a task made private in the instant an issue commits is printed by that issue (the guard reads it unlocked inside the issue's transaction — the same snapshot the whole issue sees).

## 5. Tests

- **Unit** (`hours-page.test.ts`): `printHoursMinutes` (0, minutes, hours ≥ 100, seconds mode), `hoursPageWithSeconds`, `readHoursPage` (every refusal: version, unknown line, bad date, non-integer/negative seconds, non-string task, extra junk ignored); `print.test.ts`: the PDF renders with a breakdown in sv and en, multi-page (500 rows), and the page count grows; a credit note with a `hoursPage` is not drawn with one.
- **dbtest** (`hours-page.dbtest.ts`, prefix `invp`, registered in `DBTEST_PREFIXES`): the twin matrix; the function's grouping (two entries same day same task → one row; an internal task and a no-task hour → one "Other work" row; order; lines without hours left out; NULL without hours; no member name or note anywhere in the JSON); issue with the tick → page written by the guard, matching the function's output, the app's value overwritten; without the tick → NULL; frozen after issue (an UPDATE of either column refused); a draft's `hours_page` refused (CHECK); `include_hours` on a credit note refused (CHECK + service); a task made private after its hour was added prints "Other work"; renamed → the new title; the fingerprint changes with the tick and with a rename (INVOICE_CHANGED); the corrected copy carries the tick; `readIssuedInvoice` strict reads it; `issue.dbtest.ts`'s template version 3.
- **e2e** (`invoice-hours.spec.ts`, extended): on the draft made from hours, turn on "Time breakdown" → the card lists the hours; off → gone. (The harness has no file storage — the PDF itself is the unit test's.)

## 6. Docs

DATA_MODEL §6.7 (the two columns, the function, the guard), SECURITY §9.7.3 (§4 above), PLAN (Phase 4 item + §0), OPEN_QUESTIONS C81, the design doc's review sections.

## 9. Questions for the design review

1. Readings 1–6 — especially 3 (`h:mm:ss` when a page has raw seconds) and 4 (the database writing the page vs. the app).
2. The twin rule in SQL — is the matrix enough, and does the function read the right ancestor rows (parent and root only, as `sharedTasks` does)?
3. The trigger's widened column list — any write path that changes `include_hours`/`hours_page` without firing it, or the CHECKs alone being relied on wrongly?
4. Fingerprint: is hashing the function's text inside the issue's lock correct, given the function reads `work_item` unlocked (slice 110's accepted residual)?
5. Anything on the page a client must never read.

## 10. The design review's findings and what was done (2026-10-10)

One fresh reviewer, read-only, on the design and the draft code. **No HIGH; two MEDIUM, six LOW, seven NIT. This section overrides §1–§5 where they differ.**

- **M1 — the reader was stricter than the database writes** (a title of only Unicode spaces, or long in UTF-16 units, is legal SQL output; refusing it would have made that invoice's PDF impossible, its page a 500 and the draft unopenable). **Taken:** `readHoursPage` checks the SHAPE only — `task` a string or null, a title blank to JavaScript reads as "Other work", no length test; the issued page reads a broken page TOLERANTLY (no card, a caution: `hoursPageUnreadable`), the PDF still strictly. A dbtest sends NBSP/ideographic-space, tab, 450-emoji, quotes, backslash, newline and right-to-left titles through the real function, the strict reader and the jobs sweep's drawing.
- **M2 — no cap, and a page that cannot render is permanent.** **Taken after measuring** (react-pdf 4.9, 2026-10-10): 1 000 rows ≈ 2–4 s / 30 pages, 2 000 rows ≈ 25 s — layout grows faster than the rows (splitting into separate `<Page>`s of 200 rows helped, 9 s, but not enough to lift the cap). `HOURS_PAGE_ROWS_MAX = 1000`: past it the issue is refused (`hoursPageTooLong`, in the app — the issue's own check under the lock — with a sentence: untick it or split the invoice), and the draft's card says so. A unit test draws the longest page allowed.
- **L3 — a concurrent Add hours could crash the draft page.** Taken: the preview reads the page against the lines the page already shows and leaves out a line it does not know (`dropUnknownLines`); the record is never read that way.
- **L4 — "what the issuer saw is what is frozen" had a window** between the fingerprint's statement and the guard's. Taken: `issueLocked` keeps the page text the fingerprint hashed (read under the draft's lock) and, after the UPDATE, compares it with `hours_page::text` as stored — both from Postgres; a difference is INVOICE_CHANGED and the rollback returns the number.
- **L5 — a line's quantity can differ from its hours' total.** Taken as a caution in the issue dialog (`hoursPageDiffers`, the lines named). The reviewer's corrected-copy case is unreachable: `creditInFull` refuses once any part was credited, and hours are returned by hand only after a part credit — so the copy's comment stands; the reachable case is a member editing a line's quantity, which the dbtest pins.
- **L6 — a belt so no other client's task is ever named.** Taken: `invoice_hours_page` names a task only when `work_item.client_id` is the record's (the invoice's) client.
- **L7 — the issue's own UPDATE could change the tick.** Taken: `invoice_billed_hours_guard` refuses an `include_hours` change in the statement that leaves DRAFT (the pay link's precedent).
- **L8 — a task made private after issue stays on the frozen page.** Accepted (C80 (d): fixed at issue); the send dialog does not re-check. Recorded in SECURITY §9.7.3.
- **NITs:** 9 taken (the trigger's column list unchanged; `issue.dbtest.ts`'s census comment now says the guard writes `hours_page`, still before the number and never NULL); 10 accepted (line ids in a column a main contact's RLS reads — `invoice_line` is class A, nothing selects it, the ids say nothing); 11 taken (an issued invoice's "Included" follows whether a page was printed); 12 taken (the migration's name); 13 taken (the card says when a page prints seconds — a project that does not round); 14 accepted (a shared task titled "Other work" prints beside the real "Other work" row); 15 accepted (column heads are not repeated when one line's table crosses a page; the fixed head is).
- **Tests added for the review:** the odd-title round trip and the sweep's drawing as SYSTEM (`templateVersion: 3`), the byte-for-byte frozen text, the tick refused in the issue's own statement, the quantity caution, the worst-case render, the blocker in `issue.test.ts`.


## 11. The migration's pre-apply review, and the code and security reviews (2026-10-10)

**Pre-apply (one fresh reviewer, read-only, before `20261010210000_invoice_hours_page` was applied): no HIGH, no MEDIUM; nothing fails at apply or run time.** Its four nits were taken BEFORE the apply: the date is printed with `to_char(local_date::timestamp, …)` (no session time zone in a hashed text); a title is trimmed of spaces, tabs, line breaks, no-break and ideographic spaces, cut to 500 and trimmed again (`chr()`-built, no escapes); the rule runs after the client join, inside a CASE (only on the tasks the record names); and `issueLocked` checks the row cap on the very page text the fingerprint read (the one the stored page must equal). Its low — a shared task is named even when its project's portal is off (the PDF is emailed) — was already slice 110's rule and is now stated in SECURITY §9.7.3. The changed expressions were evaluated read-only against the dev database first; then applied with `prisma migrate deploy`, the ledger checksum verified equal to the file's sha-256, `migrate status` up to date.

**Code and security (two fresh reviewers in parallel, read-only): no HIGH, no MEDIUM, no forward migration needed.**

- **Code L1 — the switch went `disabled` while saving**, dropping keyboard focus to `<body>` for the ~2 s the revalidating transition stays pending. Taken: `aria-busy` and a refused press instead (`vault-switch.tsx`'s precedent), `aria-describedby` to its hint; the e2e waits for `aria-busy="false"` before its second press.
- **Code L2 / Security L2 — the cap was measured with short titles.** Taken in the drawing: `printedTask` makes every run of whitespace one space and prints at most 120 characters with "…" (the PDF and the card alike; the record keeps the whole title). Re-measured: 1 000 rows of 500-character two-line titles draw in ≈ 5 s (`print.test.ts`'s worst case).
- **Security L1 — task titles bypassed slice 109's payment-text caution** (anyone who edits a task — a client's own requests are CLIENT_VISIBLE — could put "Betala till bankgiro …" on the breakdown). Taken: with the tick on, `readDraftPaymentText` also reads the page's titles; a dbtest pins it.
- **Nits taken:** the fingerprint parts are read in `issueLocked` only when a fingerprint was sent or the draft is ticked (a credit note's issue inside `creditInFull` no longer hashes for nothing); `invoice.draft_edited` records which way the tick went (`includeHours: true|false`); an issued invoice whose page cannot be read says "Included" beside the caution, not "Not included"; the read-only row has no dangling `label for`; the card leaves out a line none of whose rows fit, and its docstring says its words are in the member's language; the Swedish "Visas med sekunder"; a dbtest comment; SECURITY's "nothing beyond what their PDF prints, plus the invoice's own line ids", and its Contact (portal) line now names the invoice (person lines, the breakdown's daily hours) as a channel — on a one-person engagement those daily totals are that person's.
- **Accepted:** nothing exercises the post-UPDATE text comparison itself (it needs a change landing between two statements of one transaction; the fingerprint's refusal is pinned); the line ids in the client-readable column (design NIT 10).
