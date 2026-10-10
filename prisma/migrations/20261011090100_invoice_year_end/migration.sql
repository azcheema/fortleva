-- ═══════════════════════════════════════════════════════════════════
-- Phase 4 slice 111b — THE CASH METHOD'S YEAR END (founder decision C83,
-- on C82 (e)), part 2 of 2. DATA_MODEL.md §6.7; the design and its review:
-- docs/research/2026-10-10-slice-111b-year-end-design.md (§13 overrides its
-- body).
--
-- Under the CASH method every invoice still unpaid on the financial year's
-- last day E is booked as a receivable on E (`YEAR_END` — receivables
-- debited, sales and VAT credited: the invoice less its credit notes dated
-- by then) and reversed on E + 1 (`YEAR_END_REVERSED`), after which its
-- payment books as every cash-method payment does (BFL 5 kap. 2 §; C82 (e)).
-- The person books it with a button once every payment that came in by E is
-- marked (C83 (a)): ONE year-end FILE per year, holding only those entries.
-- A payment that came in by E but is marked after the year end was booked
-- WITHDRAWS the invoice from it (C83 (b)): the year end on E
-- (`YEAR_END_UNDONE`, filed with the payment) and its reversal, if already
-- filed, on the file's day in E + 1's year (`YEAR_END_REVERSAL_UNDONE`) —
-- both years then as if it had never been in the year end.
--
-- 1. `invoice_export.year_end` — "this file books the year end of that
--    day": the CASH method's only, made after the day, on a month's last
--    day, one per workspace and year, each after every earlier one.
-- 2. `invoice_export_entry.year_end` — the year end a year-end event belongs
--    to (set on exactly the four); each once per invoice and year; always
--    with a voucher.
-- 3. `invoice_export_guard` and `invoice_export_entry_guard` re-created
--    WHOLE — every rule of `20261010230000_invoice_bookkeeping_export` kept,
--    plus the year end's, and two changes to slice 111's own (marked "111b"):
--    a PAYMENT waits while the invoice's year end of its own year stands; a
--    PAYMENT_UNDONE may be dated on a month's last day inside an ended year
--    (the design review's M3, its re-check's R3–R5 — a date corrected inside
--    an ended year stays in it, and so does an unmark there until its year
--    end is booked).
--    The year-end file itself is made from the SECOND day after its year.
-- 4. `invoice_closed_year_guard` — nothing is issued dated on or before a
--    booked year end (the review's L5). Named to fire BEFORE `invoice_guard`
--    ('c' < 'g'): it only raises or returns NEW, and `invoice_guard` stays the
--    last BEFORE trigger on `invoice` (`issue.dbtest.ts`'s census).
--
-- DDL only — no DML, no `neon-smoke.yml` dispatch owed. Existing rows: no
-- file has a `year_end` and no entry one (both columns are new), and no
-- entry is one of the four events (the values are new), so every new CHECK
-- holds on them. Left out of Prisma's generated diff, as every migration
-- since they appeared has: the drift it always reports
-- (`document_tenant_id_tags_idx`, `search_index`, the `work_item` index
-- name) — hand-written objects Prisma does not model.
-- ═══════════════════════════════════════════════════════════════════

-- AlterTable
ALTER TABLE "invoice_export" ADD COLUMN     "year_end" DATE;

-- AlterTable
ALTER TABLE "invoice_export_entry" ADD COLUMN     "year_end" DATE;


-- ── 1. A year-end file ──────────────────────────────────────────────
ALTER TABLE invoice_export
  ADD CONSTRAINT invoice_export_year_end_cash CHECK (year_end IS NULL OR method = 'CASH'),
  -- From the SECOND day after it: an invoice issued on the year's last evening
  -- is never still in flight when the year end reads (the re-check's NIT).
  ADD CONSTRAINT invoice_export_year_end_passed CHECK (year_end IS NULL OR made_on > year_end + 1),
  -- A financial year ends on a month's last day.
  ADD CONSTRAINT invoice_export_year_end_month_end CHECK (year_end IS NULL OR extract(day FROM year_end + 1) = 1);

CREATE UNIQUE INDEX invoice_export_year_end_once
  ON invoice_export (tenant_id, year_end) WHERE year_end IS NOT NULL;

CREATE OR REPLACE FUNCTION invoice_export_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  who text := current_setting('app.principal', true);
  who_id text := current_setting('app.principal_id', true);
  at timestamptz := statement_timestamp();
  slack constant interval := interval '5 minutes';
  maintenance boolean := current_setting('app.invoice_maintenance', true) = 'on' AND current_user = 'app_platform';
  utc_today date := (statement_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF maintenance THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'INVOICE_EXPORT_GUARD: a bookkeeping file is never deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'INVOICE_EXPORT_GUARD: a bookkeeping file never changes';
  END IF;

  -- INSERT: a member, as themselves, who may make the file, now.
  IF who IS DISTINCT FROM 'member' OR NEW.created_by_member_id IS DISTINCT FROM who_id THEN
    RAISE EXCEPTION 'INVOICE_EXPORT_GUARD: a member makes a bookkeeping file, as themselves';
  END IF;
  IF NOT invoice_member_holds(NEW.tenant_id, who_id, 'invoice:export') THEN
    RAISE EXCEPTION 'INVOICE_EXPORT_GUARD: only a member who may export invoices makes a bookkeeping file';
  END IF;
  IF NEW.created_at < at - slack OR NEW.created_at > at + slack THEN
    RAISE EXCEPTION 'INVOICE_EXPORT_GUARD: a bookkeeping file is made now';
  END IF;
  -- The workspace's day: within a day of the UTC date (every zone's today).
  IF NEW.made_on < utc_today - 1 OR NEW.made_on > utc_today + 1 THEN
    RAISE EXCEPTION 'INVOICE_EXPORT_GUARD: a bookkeeping file is dated the day it is made';
  END IF;

  PERFORM invoice_export_lock(NEW.tenant_id);
  -- One method per workspace, for good (the re-check's 6).
  IF EXISTS (SELECT 1 FROM invoice_export e
              WHERE e.tenant_id = NEW.tenant_id AND e.method <> NEW.method) THEN
    RAISE EXCEPTION 'INVOICE_EXPORT_GUARD: a workspace''s files keep the method of its first';
  END IF;
  -- 111b: year ends are booked in order — a new one after every earlier one
  -- of the workspace (the CHECKs hold the rest; the unique index one per year).
  IF NEW.year_end IS NOT NULL
     AND EXISTS (SELECT 1 FROM invoice_export e
                  WHERE e.tenant_id = NEW.tenant_id AND e.year_end >= NEW.year_end) THEN
    RAISE EXCEPTION 'INVOICE_EXPORT_GUARD: a year end is booked after every earlier one';
  END IF;
  -- Numbered here, under the lock: the next of the workspace's.
  NEW.number := (SELECT coalesce(max(e.number), 0) + 1 FROM invoice_export e WHERE e.tenant_id = NEW.tenant_id);
  RETURN NEW;
END
$fn$;


-- ── 2. The year end's entries ───────────────────────────────────────
ALTER TABLE invoice_export_entry
  ADD CONSTRAINT invoice_export_entry_year_end_set
    CHECK ((year_end IS NOT NULL)
           = (event IN ('YEAR_END', 'YEAR_END_REVERSED', 'YEAR_END_UNDONE', 'YEAR_END_REVERSAL_UNDONE'))),
  ADD CONSTRAINT invoice_export_entry_year_end_booked
    CHECK (year_end IS NULL OR voucher IS NOT NULL);

-- Each year-end event once per invoice and year end.
CREATE UNIQUE INDEX invoice_export_entry_year_end_once
  ON invoice_export_entry (tenant_id, invoice_id, event, year_end) WHERE year_end IS NOT NULL;

-- Whether a payment stands in the BOOKS of an invoice on a day: payments
-- booked by then less reversals booked by then. A payment booked by a year
-- end and reversed only after it still holds the sale in that year (the
-- design's §2.2). VOLATILE (the default) on purpose: a fresh snapshot per
-- call, so the rows inserted before it in the same statement are counted.
CREATE OR REPLACE FUNCTION invoice_export_paid_in_books(p_tenant text, p_invoice text, p_day date) RETURNS boolean
LANGUAGE sql
SET search_path = public, pg_temp
AS $fn$
  SELECT coalesce(sum(CASE x.event WHEN 'PAYMENT' THEN 1 WHEN 'PAYMENT_UNDONE' THEN -1 ELSE 0 END), 0) > 0
    FROM invoice_export_entry x
   WHERE x.tenant_id = p_tenant AND x.invoice_id = p_invoice
     AND x.event IN ('PAYMENT', 'PAYMENT_UNDONE') AND x.booked_on <= p_day
$fn$;

REVOKE EXECUTE ON FUNCTION invoice_export_paid_in_books(text, text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invoice_export_paid_in_books(text, text, date) TO app_runtime;

CREATE OR REPLACE FUNCTION invoice_export_entry_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  who text := current_setting('app.principal', true);
  who_id text := current_setting('app.principal_id', true);
  maintenance boolean := current_setting('app.invoice_maintenance', true) = 'on' AND current_user = 'app_platform';
  file_row record;
  doc record;
  booked_count bigint;
  last_paid record;
  -- 111b. Named apart from every column they meet (42702).
  v_end date;
  v_paid_by boolean;
  v_withdrawn boolean;
  ye_row record;
  rev_row record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF maintenance THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: what a file booked is never deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: what a file booked never changes';
  END IF;

  IF who IS DISTINCT FROM 'member' THEN
    RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: a member makes a bookkeeping file';
  END IF;
  -- Its file was made IN THIS TRANSACTION, by this member: a file never grows
  -- after it is made.
  SELECT f.method, f.made_on, f.year_end, f.created_by_member_id, (f.xmin = pg_current_xact_id()::xid) AS fresh
    INTO file_row
    FROM invoice_export f
   WHERE f.tenant_id = NEW.tenant_id AND f.id = NEW.export_id;
  IF NOT FOUND OR NOT file_row.fresh OR file_row.created_by_member_id IS DISTINCT FROM who_id THEN
    RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: an entry joins a file made in its own transaction, by its maker';
  END IF;

  PERFORM invoice_export_lock(NEW.tenant_id);

  -- FOR SHARE (the pre-apply review's 2): a Mark as paid / unpaid in flight
  -- is waited for and its committed row read, so "paid on that day" holds at
  -- commit, not only at this read (`invoice_line_time_entry_guard`'s precedent).
  SELECT i.kind, i.status, i.issue_date, i.paid_on
    INTO doc
    FROM invoice i
   WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.invoice_id
     FOR SHARE;
  IF NOT FOUND OR doc.status = 'DRAFT' THEN
    RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: a file books issued invoices only';
  END IF;
  IF NEW.voucher IS NOT NULL AND NOT invoice_export_voucher_ok(NEW.voucher) THEN
    RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: a voucher is well formed and balances';
  END IF;
  -- The file's method decides its events.
  IF (NEW.event = 'ISSUE') IS DISTINCT FROM (file_row.method = 'INVOICE') THEN
    RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: an event of the file''s method';
  END IF;
  -- 111b: a year-end file holds its year end only, and a year end goes only
  -- in the year-end file of its day.
  IF (NEW.event = 'YEAR_END') IS DISTINCT FROM (file_row.year_end IS NOT NULL) THEN
    RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: a year end goes in its own file, and nothing else does';
  END IF;

  IF NEW.event = 'ISSUE' THEN
    IF NEW.booked_on IS DISTINCT FROM doc.issue_date THEN
      RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: an issue is booked on its date';
    END IF;

  ELSIF NEW.event = 'CREDIT_NOTED' THEN
    IF doc.kind <> 'CREDIT_NOTE' OR NEW.booked_on IS DISTINCT FROM doc.issue_date THEN
      RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: a credit note is listed on its date';
    END IF;

  ELSIF NEW.event IN ('PAYMENT', 'PAYMENT_UNDONE') THEN
    -- An invoice's, counted under the lock (this transaction's own earlier
    -- entries included).
    IF doc.kind <> 'INVOICE' THEN
      RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: only an invoice is paid';
    END IF;
    SELECT count(*) FILTER (WHERE x.event = 'PAYMENT') - count(*) FILTER (WHERE x.event = 'PAYMENT_UNDONE')
      INTO booked_count
      FROM invoice_export_entry x
     WHERE x.tenant_id = NEW.tenant_id AND x.invoice_id = NEW.invoice_id;

    IF NEW.event = 'PAYMENT' THEN
      IF booked_count <> 0 OR doc.paid_on IS NULL OR NEW.booked_on IS DISTINCT FROM doc.paid_on THEN
        RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: a payment is booked once, on the day it arrived';
      END IF;
      -- 111b: the payment's own year — closed by the workspace's EARLIEST
      -- booked year end on or after the day. While the invoice's year end
      -- there still books it as unpaid, the payment waits for that
      -- withdrawal (filed with it): the sale would otherwise stand twice in
      -- that year. Later year ends of the invoice are withdrawn after it, by
      -- what the books then hold (the design review's M1, its re-check's R2).
      SELECT min(e.year_end)
        INTO v_end
        FROM invoice_export e
       WHERE e.tenant_id = NEW.tenant_id AND e.year_end >= NEW.booked_on;
      IF v_end IS NOT NULL
         AND EXISTS (SELECT 1
                       FROM invoice_export_entry y
                      WHERE y.tenant_id = NEW.tenant_id AND y.invoice_id = NEW.invoice_id
                        AND y.event = 'YEAR_END' AND y.year_end = v_end)
         AND NOT EXISTS (SELECT 1
                           FROM invoice_export_entry u
                          WHERE u.tenant_id = NEW.tenant_id AND u.invoice_id = NEW.invoice_id
                            AND u.event = 'YEAR_END_UNDONE' AND u.year_end = v_end) THEN
        RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: a payment by a booked year end waits for that year end''s withdrawal';
      END IF;

    ELSE
      -- PAYMENT_UNDONE: of the newest booked payment, no longer the mark.
      SELECT x.booked_on, x.voucher
        INTO last_paid
        FROM invoice_export_entry x
        JOIN invoice_export f ON f.tenant_id = x.tenant_id AND f.id = x.export_id
       WHERE x.tenant_id = NEW.tenant_id AND x.invoice_id = NEW.invoice_id AND x.event = 'PAYMENT'
       ORDER BY f.number DESC, x.position DESC
       LIMIT 1;
      IF booked_count <> 1 OR last_paid.booked_on IS NOT DISTINCT FROM doc.paid_on THEN
        RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: a booked payment no longer marked is reversed';
      END IF;
      -- On the file's day — or, inside an ended year (111b; the design
      -- review's M3, its re-check's R3–R5), on a month's last day before the
      -- file's: re-marked, on or after both days and never past a booked year
      -- end after them; unmarked, on or after the booked day, only while no
      -- year end on or after it is booked. Every test spelled out against
      -- NULL — an `IF NOT (… NULL …)` would never raise.
      IF NEW.booked_on IS DISTINCT FROM file_row.made_on THEN
        IF NOT (NEW.booked_on < file_row.made_on AND extract(day FROM NEW.booked_on + 1) = 1 AND NEW.booked_on >= last_paid.booked_on) THEN
          RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: a payment is reversed on the file''s day, or at a month''s end inside the year it was corrected in';
        END IF;
        IF doc.paid_on IS NOT NULL THEN
          IF NEW.booked_on < doc.paid_on
             OR EXISTS (SELECT 1 FROM invoice_export e
                         WHERE e.tenant_id = NEW.tenant_id
                           AND e.year_end >= greatest(last_paid.booked_on, doc.paid_on)
                           AND e.year_end < NEW.booked_on) THEN
            RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: a corrected payment''s reversal stays inside the year of both days';
          END IF;
        ELSIF EXISTS (SELECT 1 FROM invoice_export e
                       WHERE e.tenant_id = NEW.tenant_id AND e.year_end >= last_paid.booked_on) THEN
          RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: an unmarked payment of a closed year is reversed on the file''s day';
        END IF;
      END IF;
      IF (last_paid.voucher IS NULL) IS DISTINCT FROM (NEW.voucher IS NULL)
         OR (NEW.voucher IS NOT NULL AND NOT invoice_export_rows_negated(last_paid.voucher, NEW.voucher)) THEN
        RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: a reversal negates what was booked, row by row';
      END IF;
    END IF;

  ELSIF NEW.event IN ('YEAR_END', 'YEAR_END_REVERSED', 'YEAR_END_UNDONE', 'YEAR_END_REVERSAL_UNDONE') THEN
    -- ── 111b: the year end ───────────────────────────────────────────
    -- Every one an invoice's, of the year end in `year_end` (CHECKs hold it
    -- set and the voucher present). "Paid by E": marked paid on or before E,
    -- or a payment standing in the books at E.
    IF doc.kind <> 'INVOICE' THEN
      RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: only an invoice is unpaid at a year end';
    END IF;
    v_end := NEW.year_end;
    v_paid_by := (doc.paid_on IS NOT NULL AND doc.paid_on <= v_end)
                 OR invoice_export_paid_in_books(NEW.tenant_id, NEW.invoice_id, v_end);

    IF NEW.event = 'YEAR_END' THEN
      -- Unpaid on E: in E's own file, booked on E, issued by then, not paid by then.
      IF v_end IS DISTINCT FROM file_row.year_end OR NEW.booked_on IS DISTINCT FROM v_end THEN
        RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: a year end is booked on its year''s last day, in its own file';
      END IF;
      IF doc.issue_date > v_end THEN
        RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: only an invoice issued by the year end is unpaid at it';
      END IF;
      IF v_paid_by THEN
        RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: an invoice paid by the year end is not unpaid at it';
      END IF;

    ELSE
      -- A reversal or a withdrawal: of the invoice's year end at E.
      SELECT x.voucher
        INTO ye_row
        FROM invoice_export_entry x
       WHERE x.tenant_id = NEW.tenant_id AND x.invoice_id = NEW.invoice_id
         AND x.event = 'YEAR_END' AND x.year_end = v_end;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: no year end to reverse or withdraw';
      END IF;
      v_withdrawn := EXISTS (SELECT 1
                               FROM invoice_export_entry x
                              WHERE x.tenant_id = NEW.tenant_id AND x.invoice_id = NEW.invoice_id
                                AND x.event = 'YEAR_END_UNDONE' AND x.year_end = v_end);

      IF NEW.event = 'YEAR_END_REVERSED' THEN
        -- The day after, while it stands and its invoice was not paid by E.
        IF NEW.booked_on IS DISTINCT FROM v_end + 1 THEN
          RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: a year end is reversed the day after';
        END IF;
        IF v_withdrawn OR v_paid_by THEN
          RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: only a year end that stands is reversed';
        END IF;
        IF NOT invoice_export_rows_negated(ye_row.voucher, NEW.voucher) THEN
          RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: a reversal negates what was booked, row by row';
        END IF;

      ELSIF NEW.event = 'YEAR_END_UNDONE' THEN
        -- Withdrawn on E: the invoice was paid by then after all (C83 (b)).
        IF NEW.booked_on IS DISTINCT FROM v_end THEN
          RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: a year end is withdrawn on its own day';
        END IF;
        IF NOT v_paid_by THEN
          RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: a year end is withdrawn only for a payment by then';
        END IF;
        IF NOT invoice_export_rows_negated(ye_row.voucher, NEW.voucher) THEN
          RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: a withdrawal negates what was booked, row by row';
        END IF;

      ELSIF NEW.event = 'YEAR_END_REVERSAL_UNDONE' THEN
        -- The reversal of a withdrawn year end, withdrawn on a day of its own
        -- year up to the file's (the design review's L1).
        SELECT x.voucher
          INTO rev_row
          FROM invoice_export_entry x
         WHERE x.tenant_id = NEW.tenant_id AND x.invoice_id = NEW.invoice_id
           AND x.event = 'YEAR_END_REVERSED' AND x.year_end = v_end;
        IF NOT FOUND OR NOT v_withdrawn THEN
          RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: only the reversal of a withdrawn year end is withdrawn';
        END IF;
        -- Never past the next booked year end (the re-check's R7).
        IF NEW.booked_on < v_end + 1 OR NEW.booked_on > file_row.made_on
           OR EXISTS (SELECT 1 FROM invoice_export e
                       WHERE e.tenant_id = NEW.tenant_id AND e.year_end > v_end AND e.year_end < NEW.booked_on) THEN
          RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: a reversal is withdrawn inside its own year, by the file''s day';
        END IF;
        IF NOT invoice_export_rows_negated(rev_row.voucher, NEW.voucher) THEN
          RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: a withdrawal negates what was booked, row by row';
        END IF;

      ELSE
        RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: an event this guard does not know';
      END IF;
    END IF;

  ELSE
    RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: an event this guard does not know';
  END IF;
  RETURN NEW;
END
$fn$;


-- ── 4. Nothing is issued into a booked year ─────────────────────────
-- An invoice or credit note leaving DRAFT dated on or before a booked year
-- end would be missed by it (a time-zone change, or an issue in flight at
-- midnight; the design review's L5). Fires BEFORE `invoice_guard` ('c' < 'g')
-- and only raises or returns NEW, so `invoice_guard` stays the last BEFORE
-- trigger and no number is ever burnt.
CREATE OR REPLACE FUNCTION invoice_closed_year_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF OLD.status = 'DRAFT' AND NEW.status IS DISTINCT FROM 'DRAFT'
     AND EXISTS (SELECT 1 FROM invoice_export e
                  WHERE e.tenant_id = NEW.tenant_id AND e.year_end >= NEW.issue_date) THEN
    RAISE EXCEPTION 'INVOICE_CLOSED_YEAR_GUARD: nothing is issued dated on or before a booked year end';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER invoice_closed_year_guard
  BEFORE UPDATE OF status ON invoice
  FOR EACH ROW EXECUTE FUNCTION invoice_closed_year_guard();
