-- ═══════════════════════════════════════════════════════════════════
-- Phase 4 slice 111b — THE CASH METHOD'S YEAR END, part 3: a payment's
-- reversal dated back is held to EXACTLY the day the rules name (its code
-- review's 1 and security review's L1; docs/research/2026-10-10-slice-111b-
-- year-end-design.md §15). Corrects `20261011090100_invoice_year_end` forward
-- — an applied migration is never edited.
--
-- `invoice_export_entry_guard` re-created WHOLE, every rule of 20261011090100
-- kept but one: a PAYMENT_UNDONE not on its file's day was admitted on ANY
-- month's last day before the file's, on or after both days, with no booked
-- year end between — wider than the app ever writes, so a planning bug could
-- have dated a reversal back into filed VAT periods unnoticed; and it refused
-- the one day a payment MOVED TO ANOTHER YEAR needs (its booked day's month
-- end, the new day being later). Now exactly two days, before the file's:
--   - re-marked within its ended year: the last day of the LATER day's month,
--     no booked year end between the later day and it;
--   - unmarked, or moved to another year: the last day of the BOOKED day's
--     month, only while no year end on or after the booked day is booked.
-- The app (`paymentUndoDay`) picks between them — the database cannot tell
-- the financial year.
--
-- DDL only — no DML, no `neon-smoke.yml` dispatch owed. No CHECK, column or
-- index changes; existing rows are untouched (a guard runs on INSERT only).
-- ═══════════════════════════════════════════════════════════════════

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
  v_booked_end date;
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
      -- On the file's day — or EXACTLY one day back, before the file's
      -- (111b: the design review's M3, its re-check's R3–R5, its code review's
      -- 1, its security review's L1 — migration 20261011090200):
      --   re-marked in the same ended year: the last day of the LATER day's
      --     month, with no booked year end between the later day and it;
      --   unmarked, or moved to another year: the last day of the BOOKED
      --     day's month, only while no year end on or after the booked day is
      --     booked.
      -- (The database cannot tell the financial year — the app picks between
      -- the two; nothing else is admitted.) Every test spelled out against
      -- NULL — an `IF NOT (… NULL …)` would never raise.
      IF NEW.booked_on IS DISTINCT FROM file_row.made_on THEN
        v_booked_end := (date_trunc('month', last_paid.booked_on::timestamp) + interval '1 month - 1 day')::date;
        IF NOT (NEW.booked_on < file_row.made_on) THEN
          RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: a payment''s reversal is never dated after its file''s day';
        END IF;
        IF doc.paid_on IS NOT NULL
           AND NEW.booked_on = (date_trunc('month', greatest(last_paid.booked_on, doc.paid_on)::timestamp) + interval '1 month - 1 day')::date
           AND NOT EXISTS (SELECT 1 FROM invoice_export e
                            WHERE e.tenant_id = NEW.tenant_id
                              AND e.year_end >= greatest(last_paid.booked_on, doc.paid_on)
                              AND e.year_end < NEW.booked_on) THEN
          NULL; -- re-marked within the year: its later day's month end
        ELSIF NEW.booked_on = v_booked_end
              AND NOT EXISTS (SELECT 1 FROM invoice_export e
                               WHERE e.tenant_id = NEW.tenant_id AND e.year_end >= last_paid.booked_on) THEN
          NULL; -- unmarked, or moved to another year, while its year is open: its booked day's month end
        ELSE
          RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: a payment''s reversal dated back is on the month end the rules name';
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
