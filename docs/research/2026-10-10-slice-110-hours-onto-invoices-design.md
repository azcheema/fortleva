# Slice 110 — HOURS ONTO INVOICES (Phase 4 step 4; founder decisions C75 (a), (b) and C80)

*Draft 2026-10-10, before the design review. The hours PAGE on the PDF (C80 (d)) is slice 110b — §7.*

## 0. What was decided, and the readings this design takes

- **C75 (a)** — billed hours are **never locked, only marked**: a tracked hour put on an invoice leaves the not-yet-invoiced list and stays editable by whoever could edit it. The issued invoice — its frozen lines, and the record of which entries it billed — is the bookkeeping record, never the live entries. `lockedReason`'s `INVOICE_DRAFT`/`INVOICED` are not set by invoicing; the lock trigger is untouched.
- **C75 (b)** — rounding per project, off by default: a step (1/6/10/15/30/60 min), a direction (up/nearest/down), a minimum; applied to the invoice line only.
- **C80 (a)** — two ways in: a **ready-to-invoice list** on Invoices (each client's billable hours not yet invoiced, what they are worth; pick a client and a period → Create invoice), and **Add hours…** on any open draft.
- **C80 (b)** — lines chosen each time, **per project by default**; per task, per agreement, per person; a different hourly rate always its own line; text editable before issuing; a task the client cannot see is "Other work".
- **C80 (c)** — rounding rounds **each time entry**.
- **C80 (d)** — an optional hours page on the PDF, frozen at issue → **slice 110b**.
- **C80 (e)** — editing or deleting an hour on an issued invoice shows **a warning only**; nothing on the invoice.
- **C80 (f)** — a credit **in full frees** the hours (or moves them onto the corrected copy); a credit **in part keeps** them, and particular hours can be freed by hand.
- **C80 (g)** — **"Billed elsewhere"** and **"Won't invoice"** marks, owners and admins (`time:write_off`), undoable; marked hours still count in reports.

Readings this design takes (each is a question for the review, §8):

1. **"Marked" is one column per kind of mark.** `time_entry.invoice_line_id` (already in the schema since 2T, never written) is the CURRENT invoice mark; `billed_externally_at` and `written_off_at` (likewise) are the other two. At most one of the three is set (CHECK). The history of which entries an issued invoice billed is a new table (§1.2), never rewritten — a freed or re-billed hour leaves it standing.
2. **Hours on a DRAFT move only with their line.** An hour joins a draft as part of a line made from hours, and leaves it when that line is removed or the draft deleted. There is no "take this one hour off the line" — remove the line and add again. This keeps the draft's links and marks in step structurally.
3. **A split of an invoiced or marked hour is refused** (`ENTRY_INVOICED`): the second half would be a new, unmarked row — billable again — and the issued record cannot gain a row. Editing and deleting stay open, with the warning (C80 (e)). *This is the one place the design restricts what a member can do to a billed hour; the review should say whether it reads as the "lock" C75 (a) refused.*
4. **"Free by hand" (C80 (f)) is offered only on an invoice that has an issued credit note** (partly credited) — freeing an hour from an invoice nobody corrected would be billing it twice.
5. **The warning (C80 (e)) in the week grid**, which edits inline and has no form: the row wears a badge ("Invoiced", "On a draft invoice", "Billed elsewhere", "Won't invoice") whose tooltip carries the sentence; an edit or delete of an invoiced row toasts "Saved. Invoice 1042 doesn't change."; Delete on such a row asks first, with the sentence. The number is shown only to a member holding `invoice:view` — otherwise "an invoice".

## 1. Data — migration `20261010180000_hours_onto_invoices`

### 1.1 `project` gains its rounding (C75 (b))

`invoice_rounding_step` SMALLINT NULL (NULL = off) · `invoice_rounding_mode` enum `InvoiceRoundingMode {UP, NEAREST, DOWN}` NULL · `invoice_rounding_minimum` SMALLINT NULL (minutes). CHECK: step IN (1,6,10,15,30,60); off ⇒ mode and minimum NULL; on ⇒ mode NOT NULL; minimum NULL or 1–480. INTERNAL-ONLY: `project` is class B, so the three join `PORTAL_NEVER_SELECTED`. No trigger lists them. Edited on the project's Overview beside the billing currency (`project:edit`, audited `project.updated` with the fields — the billing currency's precedent).

### 1.2 `invoice_line_time_entry` (new, class A) — which entries a line billed

`tenant_id, client_id, invoice_id, invoice_line_id, time_entry_id, project_id, work_item_id (nullable), local_date, raw_seconds, billed_seconds, bill_rate (nullable — an hour with no rate), created_at`. PK `(tenant_id, invoice_line_id, time_entry_id)`. FKs: the line `(tenant_id, invoice_line_id)` ON DELETE CASCADE; the invoice `(tenant_id, client_id, invoice_id)` ON DELETE CASCADE; the entry `(tenant_id, time_entry_id)` RESTRICT (an entry is only ever soft-deleted; teardown frees first). Indexes: `(tenant_id, invoice_id)` (the invoice's hours card), `(tenant_id, time_entry_id)` (an entry's billing history). CHECKs: seconds ≥ 0, `billed_seconds ≤ 2 × 86 400`.

The snapshot columns (`project_id`, `work_item_id`, `local_date`, `raw_seconds`) are what the hour WAS when it was added — the record (and slice 110b's hours page) reads them, never the live entry.

**`invoice_line_time_entry_guard`** (BEFORE INSERT OR UPDATE OR DELETE):
- a contact writes nothing; UPDATE never;
- DELETE: only its line's cascade (`pg_trigger_depth() > 1` AND the line gone — the line guard's own test) or platform maintenance; a link row is never deleted on its own — an issued invoice's record never shrinks, and a draft's hours leave with their line;
- INSERT: a member, as themselves, holding `invoice:generate_from_time`; the line on THIS invoice and client; the invoice (FOR SHARE, the line guard's lock) a DRAFT of kind INVOICE; the entry of the same client, billable, finished, not deleted, carrying NO mark of any kind (the app takes it off whatever it was on first); `raw_seconds` and `local_date` and `project_id` the entry's own; `created_at` now (± 5 min).

### 1.3 `time_entry` — the marks, held by the database

- FK `(tenant_id, invoice_line_id) → invoice_line (tenant_id, id)` **ON DELETE RESTRICT** — Prisma cannot express `SET NULL (column)` on a composite key with a required tenant column (the `update_template_id` / `default_service_id` precedent), so removing a line or deleting a draft clears its hours' marks first, in the same transaction; a line still holding hours cannot be deleted.
- CHECK `time_entry_one_billing_mark`: at most one of `invoice_line_id`, `billed_externally_at`, `written_off_at`.
- The partial index `time_entry_uninvoiced (tenant_id, project_id, member_id) WHERE invoice_line_id IS NULL AND billable AND deleted_at IS NULL` (2T, unused) is REPLACED by `time_entry_ready (tenant_id, client_id, local_date) WHERE invoice_line_id IS NULL AND billed_externally_at IS NULL AND written_off_at IS NULL AND billable AND deleted_at IS NULL` — the ready list's read.
- **`time_entry_billing_guard`** (BEFORE INSERT OR UPDATE OF `invoice_line_id`, `billed_externally_at`, `written_off_at`; a no-op unless one of them actually changes):
  - INSERT: none of the three set (a new row — copy-last-week, a split's second half — is never born billed);
  - platform maintenance (`app.invoice_maintenance` or `app.time_maintenance` on, as `app_platform`): anything;
  - otherwise a member as themselves;
  - **the other two marks**: set (NULL → now ± 5 min) or cleared (→ NULL), never moved; by a holder of `time:write_off`; setting needs the entry billable, finished, not deleted, on a project;
  - **leaving a line** (`invoice_line_id` X → NULL), by the line's invoice (FOR SHARE): a DRAFT → a holder of `invoice:edit` or `invoice:delete` (the line's removal, the draft's deletion); CREDITED → a holder of `invoice:credit` or `invoice:generate_from_time` (the full credit frees); an issued invoice with an ISSUED credit note naming it → a holder of `invoice:generate_from_time` (freed by hand); any other issued invoice → refused, `INVOICE_HOURS_KEPT`;
  - **joining a line** (NULL → Y; X → Y directly is refused — the app frees first): a holder of `invoice:generate_from_time`; Y's invoice (FOR SHARE) a DRAFT INVOICE of the entry's client; the entry billable, finished, not deleted; a link row `(Y, entry)` already written.
- **`invoice_hours_guard`** on `invoice` (BEFORE UPDATE OF status, when leaving DRAFT) — a SEPARATE trigger, so `invoice_guard` is not replaced again: every link row of the invoice names an entry whose mark is that link's line, and every entry marked with one of its lines has a link row. An issue never freezes a record that disagrees with the marks.

### 1.4 RLS and grants

`invoice_line_time_entry`: `GRANT SELECT, INSERT, DELETE TO app_runtime`; ENABLE + FORCE RLS; `tenant_isolation` + `portal_deny` (class A); registered in `MODEL_CLASSES` and `RLS_CLASSES.A`. `time_entry` is unchanged in class (A). DDL only — no DML, no `neon-smoke` owed. Tenant teardown (`e2e/fixtures/seed-cli.ts`, `src/members/dbtest-fixture.ts`) clears `time_entry.invoice_line_id` under maintenance before deleting invoices.

## 2. Rounding and the line arithmetic (pure — `src/modules/invoicing/hours-lines.ts`)

- `billedSeconds(raw, rule)`: off → raw. `raw = 0` → 0. Otherwise step `s = step × 60`; UP `⌈raw/s⌉·s`, DOWN `⌊raw/s⌋·s`, NEAREST `⌊(raw + s/2)/s⌋·s` (half up); then `max(that, minimum × 60)` when a minimum is set. Integers only.
- A line's quantity: the SUM of its entries' billed seconds, converted ONCE to hours at three decimals, half away from zero (`money.ts`'s rule; `quantity = round(seconds / 3.6)` thousandths). Unit `h`. Unit price: the entries' bill rate. Amount: `lineAmount(quantity, price)` — the existing exact arithmetic.
- **Grouping** (C80 (b)) — the key always includes the bill rate (hours with no rate are their own line, at price 0, and the dialog says so); when the selection spans more than one project, every grouping also splits by project and appends " — ‹project›" to the text:
  - PROJECT: the project's name;
  - TASK: the task's title when the client may see it (`namedTaskShared`, the time report's ONE rule — exported from `reports.ts`), else "Other work" (an entry without a task too);
  - AGREEMENT: the agreement's name when CLIENT_VISIBLE (the report's rule), else the project's name;
  - PERSON: the member's name.
  - Generated text is in the INVOICE's language (the draft's choice, else the client's); lines are ordered project, text, rate (highest first), appended after the draft's existing lines; the VAT rate is the draft's default. The 200-line limit holds.
- The same module runs on the client page (the preview) and in the action (authoritative); the server recomputes everything from the entries it locks.

## 3. App — the member side

### 3.1 The ready-to-invoice list (`/invoices`, a card above the list)

For `invoice:view` + `invoice:generate_from_time`: each client in the member's DIRECT client scope with billable, finished, unmarked hours on a project — billed hours and value per currency (per-project lines' arithmetic, from one SQL aggregate per `(client, project, rate, currency)` using `time_billed_seconds()` — a SQL twin of `billedSeconds`, held equal by a dbtest over a matrix), the oldest day, "N h without a rate". Each row links to the client's page. Archived clients are listed with their tag.

### 3.2 The client's hours page (`/invoices/ready/[clientId]`)

Same gates + `assertInScope({ clientId })`. Filters: period (from/to, local dates), project, currency (when there are several). A table grouped by project — date, task (or the entry's own note), person, tracked, billed, amount — every row selected by default; at most 1 000 rows ("narrow the period" past it). Below: **Lines** (Project · Task · Agreement · Person, Project by default) and the preview of the lines the selection makes. Actions:
- **Create invoice** (`invoice:create` too): ONE transaction — the draft (`createDraft`'s rules: its currency the selection's, its project the selection's one project or none, its period the hours' first and last day), the lines, the links, the marks; audited `invoice.created` + `invoice.hours_added`; opens the draft.
- With `?draft=<id>` (from the draft's **Add hours…**): the page keeps to the draft's currency and starts on its project; the button is **Add to draft** (`invoice:edit`; an INVOICE draft only) — lines appended, the draft's period set to the hours' span if it has none; back to the draft.
- **Billed elsewhere** / **Won't invoice** (`time:write_off`): the selected hours marked; audited `time_entry.marked_billed_elsewhere` / `time_entry.marked_written_off` (one row per action: the count, the entry ids — at most 1 000 —, the client).
- A **Marked** section: hours carrying either mark (and their value — "written off" for Won't invoice), each selectable, **Undo** (`time:write_off`; audited `time_entry.billing_mark_cleared`).

Write order (every action): the invoice locked FOR UPDATE first (when there is one), then the entries `FOR UPDATE` ordered by id, each re-checked (still billable, finished, unmarked, this client, this currency) — any that changed → `HOURS_CHANGED` ("some of these hours changed — look again"), nothing written. Then lines, then link rows, then marks. Bounded lock wait (the issue's).

### 3.3 The draft and the issued invoice

- A line made from hours shows "From N hours" under its text. **Remove** on it clears its hours' marks, then deletes the line (its links cascade); the hours are back on the list (a toast says so).
- **Delete draft** clears every mark of its lines first.
- An **Hours** card (both): the hours behind each line — date, person, task, tracked, billed — and, on an issued invoice, where each one is now ("On this invoice", "Returned", "On invoice N", "On a draft", "Billed elsewhere", "Won't invoice", "Deleted"). On an invoice with an issued credit note, for `invoice:generate_from_time`: select → **Return to not invoiced** (audited `invoice.hours_returned`, with the entry ids).
- The issue dialog gains a **caution** (never a blocker): "N hours changed since they were added" — deleted, another length, another project, no longer billable — with the advice to remove the line and add them again. The fingerprint is unchanged (lines are what print; 110b adds the hours page to it).

### 3.4 Crediting (C80 (f))

- When an invoice becomes CREDITED — `issueLocked`'s covered branch, the one place both `creditInFull` and a completing part credit pass — its lines' hours are freed in the same transaction (`invoice_line_id → NULL`), counted into `invoice.credited`'s metadata (`hoursFreed`).
- `creditInFull` with the corrected copy: after the issue, the freed hours join the copy's matching lines (the copy's lines are the original's, in order): link rows copied from the original's (the same raw and billed seconds, rate, task and day — the copy bills exactly what the original did), then the marks. Needs `invoice:generate_from_time`; without it the hours stay freed and the result says so. Counted in the copy's `invoice.created` (`hoursMoved`).
- A part credit that does not complete the credit touches no hour.

### 3.5 The time grid (C80 (e))

- `listMyEntries` reads each entry's mark (the line's invoice status and number) → the row's badge and tooltip; Delete on an invoiced row confirms with the sentence; an edit or delete of one toasts after it saves.
- `splitEntry` refuses a marked entry (`ENTRY_INVOICED`); the menu hides Split on such rows, as on locked ones.
- `updateEntry` and `deleteEntry` are otherwise unchanged — the marks stay whatever is edited (a moved or un-billable hour stays marked: it was billed).

## 4. Permissions, audit, catalogue

- **+2 codes, catalogue 112 → 114, TEMPLATE_VERSION 14** (AUTHZ §3.2's reserved rows, landing with their enforcement): `invoice:generate_from_time` (C A — "Put tracked hours on invoice drafts, and return hours from a credited invoice") and `time:write_off` (C A — "Mark hours billed elsewhere or not to be invoiced, and undo it"). Neither ✦. Seed OWED (TV13 already is; the founder runs `prisma/seed.ts` at the vault's production release — C78 (b)).
- Audit actions (new, TENANT): `invoice.hours_added`, `invoice.hours_returned`, `time_entry.marked_billed_elsewhere`, `time_entry.marked_written_off`, `time_entry.billing_mark_cleared`. Metadata: counts, entry ids, line ids, grouping, the rounding rule used — never names or text.
- No portal surface; nothing a contact reads changes (`invoice_line` stays class A; the PDF is unchanged in 110).

## 5. Tests

- Unit: `billedSeconds` (every mode × steps × minimum, 0, a half), the quantity conversion, grouping (each key, the rate split, the multi-project suffix, "Other work", no-rate lines), the descriptions in sv/en.
- dbtest `hours.dbtest.ts`: the SQL twin equals the TS function over a matrix; create from hours → lines, links, marks, totals; add to a draft; a concurrent add of the same hours to two drafts (one wins, the other `HOURS_CHANGED`); remove line / delete draft frees; issue freezes (link insert/delete refused after, mark clear refused while uncredited); `invoice_hours_guard` refuses a disagreeing record; full credit frees; corrected copy moves; part credit keeps; free by hand only when partly credited; marks + undo; every guard refusal by a member without the code (each code mutation-checked); scope (a member outside the client sees and does nothing); split refused; a cross-tenant id refused.
- e2e `invoice-hours.spec.ts`: ready list → client page → Lines by task → Create invoice → the draft's lines; the time grid's badge; Billed elsewhere → Undo. A visual stop for the client page (`invoices-ready`).

## 6. Docs

DATA_MODEL §6.7 / §6.15 as-built notes; AUTHZ §3.2 rows landed + the count chain; PLAN Phase 4's bridge items; SECURITY (nothing new crosses to the client — a line). AGENTS.md's carve-outs: none (every new write is audited).

## 7. Out of scope

- **Slice 110b — the hours page (C80 (d)):** `invoice.include_hours`, the frozen page written at issue from the link rows (task names by the shared rule at issue, no names of who worked), the fingerprint extended, the PDF template version 3.
- A per-hour "take off this line" on a draft (reading 2), re-deriving a line from changed hours ("update hours"), a report of written-off value per project (Phase 6), retainers (C75 (c)).

## 8. Questions for the design review

1. Readings 1–5 in §0 — especially 3 (refusing a split of a billed hour) against C75 (a).
2. The `time_entry` FK as RESTRICT with app-side clearing, versus a hand-written `ON DELETE SET NULL (invoice_line_id)` the Prisma schema would not describe.
3. Is `invoice_hours_guard`'s two-way check enough to keep the issued record and the marks consistent, and is a separate trigger on `invoice` safe beside `invoice_guard` (order, recursion — `issueLocked`'s CREDITED update)?
4. The guard's permission split for leaving a line (draft: `invoice:edit`/`delete`; credited: `credit` or `generate_from_time`; partly credited: `generate_from_time`) — too loose, too tight?
5. Lock order and deadlocks: invoice → entries (by id) → lines → links → marks; the full credit frees inside the issue transaction after the series row is taken — acceptable, or free before the issue's last step?
6. The ready list's SQL aggregate with a SQL twin of the rounding — or read per entry in TypeScript (one implementation, a row cap)?
7. Anything a client could ever read: a line's generated text (task titles by the shared rule, agreement names CLIENT_VISIBLE only, member names only when the issuer picks Person).

## 9. The design review's findings and what was done (2026-10-10)

One fresh reviewer, read-only. **One HIGH, eight MEDIUM**, lows and nits — every one taken unless said otherwise. **This section overrides §1–§3 where they differ.**

- **H1 — the corrected copy failed or double-billed once a billed hour had been edited** (the link guard required live values the copy cannot have; skipping such hours would leave them on the list while the copied lines still bill them). **Taken, reshaped:** the copy no longer frees-then-rejoins. `creditInFull` with a copy tells `issueLocked` to KEEP the hours, then MOVES every mark on the original's lines directly onto the copy's matching lines (X → Y) under a transaction-local `app.invoice_copy_of = <original>`. The guards accept that move only then: the original CREDITED in this transaction (its `xmin`), the copy a DRAFT INVOICE made in this transaction, the same client, a holder of `invoice:credit`; and where the hour has a link on the original's line, a link on the copy's line with the SAME snapshot (raw, billed, day, project, task, rate) must already be written. The live-entry conditions are waived in that mode: an edited, deleted or no-longer-billable hour moves too — the copy bills exactly what the original did. The copy is audited `invoice.hours_added` (`op: "corrected_copy"`), not in its `invoice.created` (written before the issue — M2's second half).
- **M1 — copy without `invoice:generate_from_time`** — closed by H1: the move runs under `invoice:credit`, the code the credit already needs.
- **M2 — freeing ran after the series row was taken.** Taken: issuing a credit note locks, right after its original, every entry marked on the original's lines (`FOR UPDATE`, by id); the free (or the move) then never waits.
- **M3 — a draft holding hours could change its currency.** Taken: refused in `updateDraftDetails` (`INVOICE_HAS_HOURS`) and in the database (the new invoice trigger also fires on `currency`); the link guard requires the entry's currency to be the invoice's (or none — no rate).
- **M4 — zero-quantity lines.** Taken: the ready list leaves out 0-second entries (predicate and index); a line whose billed time rounds to nothing (DOWN / NEAREST, or a few seconds) is not written — its hours stay on the list and the page says so.
- **M5 — the link DELETE guard depended on cascade order.** Taken both ways: the link → invoice FK is `NO ACTION` (one cascade path, through the line), and the guard accepts "line OR invoice gone".
- **M6 — refusing a split is a narrow lock that does not achieve its aim.** Taken as the reviewer recommended: a split is refused only while the hour is on a DRAFT line (not billed yet — remove the line first, reading 2); on an issued invoice, or with either other mark, **the second half inherits the mark** (an INSERT carrying a mark is accepted only under `app.time_split_of = <first half>`, written in this transaction, by the same member, with the same marks, never onto a draft line). The second half has no link row — the issued record still says what the first billed, whole. `invoice_billed_hours_guard`'s check is therefore links ⊆ marks only (every link names an entry marked on that line); the reverse is held where it matters by the join rule (a join needs its link).
- **M7 — the issued invoice's Hours card showed live-entry states** C80 (e) declined. Taken: it shows the link rows as billed (the snapshot) and only mark-derived states ("On this invoice", "Returned", "On invoice N", "On a draft", "Billed elsewhere", "Won't invoice"); never "Deleted" or changed values.
- **M8 — a task made private after its line was written would still be printed.** Taken as a BLOCKER (the time report's `REPORT_NAMES_PRIVATE_TASK` precedent): issuing refuses while a line holding hours of a task no longer shared contains that task's title — "change the line's text".
- **Lows, all taken:** a credit note counts once `status <> 'DRAFT'` (it moves ISSUED → SENT); the invoice trigger is named `invoice_billed_hours_guard` so it fires BEFORE `invoice_guard` takes the number, and its check is mirrored as an issue blocker; reprice's `updateMany` re-checks all three marks under the row lock and never reprices a marked hour; every writer that sets or clears marks locks the entries by id first, a deadlock maps to `HOURS_CHANGED`; marks on a LOCKED entry (no lock ships yet) are documented as to-be-exempt when locks ship (DATA_MODEL); SECURITY.md, AUTHZ.md and `enforcement.test.ts`'s stale `lockedReason` wording corrected; needs-review (auto-stopped) hours start UNSELECTED and flagged; the seed is owed WHEN 110 SHIPS (the founder is told — `invoice_member_holds` refuses without the codes); links UNIQUE per (invoice, entry), the link's line written in this transaction (`xmin`), no DELETE grant (cascades run as the owner); the issue caution lists "another rate" too.
- **Nits, all taken:** the invoice number in the badge's text (a tooltip is unreachable on touch); undo-stop (`timer.ts`'s resume) refuses a marked entry; entries are locked by id and the count compared, never `FOR UPDATE` with predicates; the teardown wording; the founder told that the written-off value in reports waits for Phase 6 and that the hours page is 110b; Person lines warn that they print your people's names; the hours code implies seeing bill rates (an admin without `rate:view_bill` sees them here, as on any invoice line) — documented in AUTHZ.
- **§8 answers adopted:** RESTRICT FK with app-side clearing; leaving a CREDITED invoice's line takes `invoice:credit` only; freeing by hand takes `invoice:generate_from_time` AND `invoice:credit`; the SQL twin stays (IMMUTABLE, boundary-tested); CLIENT_VISIBLE task names reach the client by email even with a project's portal off — stated in SECURITY.
- **The billed seconds are checked by the database** (normal mode): the link guard recomputes `time_billed_seconds(raw, the project's rule)`.

## 10. The migration's pre-apply review (2026-10-10)

One fresh reviewer, read-only, then a delta re-check of the fixes, then two of its nits taken — all BEFORE `20261010180000_hours_onto_invoices` was applied.

- **HIGH — every link insert would have failed at run time** (42702, "column reference is ambiguous"): the link guard declared a record `e` and queried `FROM time_entry e`; `CREATE FUNCTION` does not parse embedded SQL, so the migration would have applied and the first Create invoice would have failed. Fixed: the record is `ent`, the alias `t`; every variable checked against every alias in both guards.
- **MEDIUM — the link → invoice FK as NO ACTION** depended on RI trigger firing order (by name, i.e. by OID as text — a long-lived database's OID counter crossing a digit would flip it). Fixed: CASCADE on both keys; the guard already accepts "line OR invoice gone".
- **Lows, all taken:** `issue.dbtest.ts`'s census pin now expects `invoice_billed_hours_guard` before `invoice_guard`, with why it cannot burn a number; a split racing a credit in full could leave its second half marked on a CREDITED invoice → `splitEntry` takes the hour's invoice FOR SHARE before writing (invoice, then hour) and re-reads the hour, the guard refuses CREDITED (and a re-read naming ANOTHER invoice fails closed, `HOURS_CHANGED` — the delta's nit); the currency rule keyed on the rate, not the currency column; `app.time_split_of` holds the second half to the same project and billability; the model registered (tenant + A).
- **Nits taken:** `time_billed_seconds(integer, integer, …, integer)`; the seconds CHECK widened to 31 days (no real hour is kept off an invoice by a raw constraint error); the index comment reworded; the split branch's own record variable and its own label for the (impossible) missing line.
- **Token rename (mine, before the review landed):** the issue's mismatch token is `INVOICE_HOURS_MISMATCH` — the app's token mapper refuses a token containing another (`HOURS_CHANGED`).
- Applied to dev with `prisma migrate deploy` after the dev database was checked read-only (no time entry carried any mark; the dropped index existed); status up to date. The catalogue's two codes upserted on dev with `scripts/seed-catalog.ts` (no tenant's roles touched).

## 11. The code and security reviews (2026-10-10)

Two fresh reviewers in parallel, read-only, on the working tree after the migration was applied. **No HIGH; nothing needing a forward migration.**

- **Security M1 — a project's rounding was changeable by anyone with `project:edit`, employees included** (an UP-60 with a 480-minute minimum bills every entry eight hours). **Asked → C80 (h): owners and admins.** Built as its OWN verb, `setProjectRounding` (`rate:manage_bill`; audited with the rule from and to), never a field of `updateProject` — an admin holds no `project:edit` — and on the Overview OUTSIDE the auto-saving form (its native select would also have submitted the form an admin may not save).
- **Security M2 — admins see each colleague's time entries (notes included) on the hours page**, which `time:view_team` withholds from them. **Asked → C80 (i), AGAINST the recommendation: everything, notes included.** Recorded as deliberate in AUTHZ §3.2 and SECURITY §9.7.3.
- **Code M1 — a split racing a put or a mark** left the second half unmarked (billable twice, or half a write-off undone): `splitEntry` now takes the hour's invoice FOR SHARE (when it has one), then the hour itself FOR UPDATE, re-reads, and refuses (`HOURS_CHANGED`) if a mark changed since its first read. A dbtest races a split against a put three times and checks the invariant.
- **Code M2 — the private-task blocker substring-matched**, so the default per-project text ("Website design") read as an internal task ("Design"): it now matches only the text the builder writes for a task — its title, or "title — project". A dbtest pins both directions.
- **Lows taken:** the corrected-copy move resets its setting on success only (a `finally` masked the guard's error with 25P02 — both reviews); the issue's hours facts are one SQL statement (no unbounded id list), the page's currencies a grouped read; the Marked card's written-off total per currency, its selection pruned to rows still drawn; a split's second half listed on the Hours card (`splitHere`) so a part credit can return it; another client's invoice never named on the card (`otherClient`); the SECURITY sentence on what an hours line can print; Create invoice also takes `invoice:edit`; the time grid's invoice number gated on `hasAccess` (the module's switch too).
- **Nits taken:** the empty-after-filter sentence; Create invoice's caution when hours stayed behind; the Swedish "Fakturerad på annat sätt" everywhere; the unused `columns.amount` key; DATA_MODEL says what "made in this transaction" (xmin) does and does not prove.
- **Accepted, documented:** a task renamed and then made private, or an agreement made internal, after its line was written is not re-checked (the time report's own residual); up to 1 000 ids in a mark's audit row (the marks' only history); an entry with a rate but no currency (never written by the time module) fails closed at the database.

**The fix-pass re-check (one fresh reviewer, read-only):** one MEDIUM — the security low's FOR SHARE on the hours' tasks at issue bypassed the work module's rank-lock queue (`rank-lock.ts`) and could deadlock a bulk edit, which has no retry. **Taken by removing the lock** (it fixed a LOW): the issue reads the tasks unlocked, the residual recorded in SECURITY §9.7.3 (a task made private in the instant an issue commits is printed by that issue); and a deadlock on any issue now reads INVOICE_ISSUE_BUSY ("try again"), not a 500. Lows taken: Create invoice shown only with `invoice:edit` too; a refused rounding save snaps back (`resetKey`) and the controls are read-only while a save is in flight; the rounding control closes with the `time` module (`rate:manage_bill` through the module-aware caps); SECURITY's retention row counts a split's second half on an issued invoice as invoiced. Nits taken: the private-task match compares the title cut as the builder cuts it (2 000), the Swedish "tidspost". Accepted: a PROJECT/PERSON line whose whole text equals a hidden task's title is still flagged (fails safe); a returned split half leaves the card (it has no record); the split's lock waits are bounded by the holders, not a `lockTimeoutMs`; the race dbtest is timing-dependent (a deterministic version would need a side transaction holding the hour).
