-- ═══════════════════════════════════════════════════════════════════
-- Phase 4 slice 111 — THE BOOKKEEPING FILE FOR FORTNOX (founder decision
-- C82 (a)–(f)). DATA_MODEL.md §6.7; the design and its reviews:
-- docs/research/2026-10-10-slice-111-fortnox-file-design.md (§10 overrides
-- the body).
--
-- A member who may (`invoice:export`) makes a FILE of what is new: under the
-- workspace's INVOICE method (fakturametoden) each invoice and credit note
-- on its issue date; under its CASH method (kontantmetoden, C82 (e) — Naxdor)
-- each payment marked in Fortleva on the day it arrived, a payment marked as
-- unpaid since its file reversed, and each credit note listed. The file is an
-- SIE 4I import (Fortnox: Bokföring → Importera SIE-fil) plus a list; both are
-- REGENERATED from what this migration's two tables freeze.
--
-- 1. `invoice` gains its BOOKING RATE (C82 (d), (f)): SEK per unit at which
--    the file converts an invoice in another currency — the ECB's on the
--    invoice date, or its VAT's rate when it carries Swedish VAT; a credit
--    note its original's (written HERE, whatever the app sent). Set at issue
--    on every invoice in another currency, NULL otherwise (CHECK); frozen by
--    `invoice_guard`'s row diff (not in its `mutable`). Its own trigger,
--    `invoice_book_rate_guard`, so `invoice_guard` is not replaced again —
--    named to fire after `invoice_billed_hours_guard` and before
--    `invoice_guard` (same timing → name order).
--
-- 2. `invoice_export_lock(tenant)` — THE one advisory-lock key every maker
--    of a file and both guards take (the review's nit): "what is new" is read
--    under it, and every count the entry guard makes is serialised by it.
--
-- 3. `invoice_export` (new, CLASS A) — one row per file. Written only by a
--    member, as themselves, holding `invoice:export`, now; NUMBERED HERE (1,
--    2, 3… per workspace, whatever was sent); the METHOD every earlier file
--    of the workspace has (the re-check's 6: the method is frozen by the
--    database, not only the app — a flip would book one invoice twice).
--    Never changed; deleted only by platform maintenance (teardown).
--
-- 4. `invoice_export_entry` (new, CLASS A) — one row per BOOKED EVENT, its
--    voucher frozen as it went out. Written only in the transaction that made
--    its file, by the file's maker (`xmin`), for an issued invoice of the
--    workspace; the event of the file's method; dated as its event says;
--    a voucher that is well formed, at most 50 characters of text (Fortnox's
--    limit — the review's H1), no row of nothing, balancing to zero. ISSUE
--    and CREDIT_NOTED once per document (partial UNIQUEs); a PAYMENT only
--    for an invoice paid on that day with no payment booked; a
--    PAYMENT_UNDONE only for a booked payment whose day is no longer the
--    invoice's, on the file's day, the exact negation of what was booked.
--    Never changed; deleted only by platform maintenance.
--
-- DDL only — no DML, no `neon-smoke.yml` dispatch owed. The new CHECKs on
-- `invoice` are validated on existing rows: no invoice anywhere on dev has
-- left DRAFT (read-only probe, 2026-10-10), and a draft holds no rate.
-- Left out of Prisma's generated diff, as every migration since they appeared
-- has: the drift it always reports (`document_tenant_id_tags_idx`,
-- `search_index`, the `work_item` index name) — hand-written objects Prisma
-- does not model.
-- ═══════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "invoice_export_method" AS ENUM ('INVOICE', 'CASH');

-- CreateEnum
CREATE TYPE "invoice_export_event" AS ENUM ('ISSUE', 'PAYMENT', 'PAYMENT_UNDONE', 'CREDIT_NOTED');

-- AlterTable
ALTER TABLE "invoice" ADD COLUMN     "book_rate_date" DATE,
ADD COLUMN     "book_rate_to_sek" DECIMAL(12,6);

-- CreateTable
CREATE TABLE "invoice_export" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "method" "invoice_export_method" NOT NULL,
    "series" TEXT NOT NULL,
    "made_on" DATE NOT NULL,
    "created_by_member_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_export_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_export_entry" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "export_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "event" "invoice_export_event" NOT NULL,
    "booked_on" DATE NOT NULL,
    "voucher" JSONB,
    "detail" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_export_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoice_export_tenant_id_id_key" ON "invoice_export"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_export_tenant_id_number_key" ON "invoice_export"("tenant_id", "number");

-- CreateIndex
CREATE INDEX "invoice_export_entry_tenant_id_invoice_id_idx" ON "invoice_export_entry"("tenant_id", "invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_export_entry_tenant_id_id_key" ON "invoice_export_entry"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_export_entry_tenant_id_export_id_position_key" ON "invoice_export_entry"("tenant_id", "export_id", "position");

-- AddForeignKey
ALTER TABLE "invoice_export" ADD CONSTRAINT "invoice_export_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_export_entry" ADD CONSTRAINT "invoice_export_entry_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_export_entry" ADD CONSTRAINT "invoice_export_entry_tenant_id_export_id_fkey" FOREIGN KEY ("tenant_id", "export_id") REFERENCES "invoice_export"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_export_entry" ADD CONSTRAINT "invoice_export_entry_tenant_id_invoice_id_fkey" FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "invoice"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── 1. The booking rate ─────────────────────────────────────────────
-- Both set or neither, and positive; set exactly on an issued invoice (or
-- credit note) in another currency.
ALTER TABLE invoice
  ADD CONSTRAINT invoice_book_rate_pair
    CHECK ((book_rate_to_sek IS NULL) = (book_rate_date IS NULL)
           -- NaN is above every number in Postgres: refused by name (the
           -- pre-apply review's 1; `invoice_sek_vat`'s precedent).
           AND (book_rate_to_sek IS NULL OR (book_rate_to_sek <> 'NaN' AND book_rate_to_sek > 0))),
  ADD CONSTRAINT invoice_book_rate_when
    CHECK (CASE WHEN status = 'DRAFT' OR currency = 'SEK'
                THEN book_rate_to_sek IS NULL
                ELSE book_rate_to_sek IS NOT NULL END);

CREATE OR REPLACE FUNCTION invoice_book_rate_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  orig record;
BEGIN
  -- Only the move out of DRAFT is this guard's: a draft holds no rate (the
  -- CHECK), and an issued invoice's is frozen by `invoice_guard`.
  IF NOT (OLD.status = 'DRAFT' AND NEW.status IS DISTINCT FROM 'DRAFT') THEN
    RETURN NEW;
  END IF;

  IF NEW.kind = 'CREDIT_NOTE' THEN
    -- Its ORIGINAL's, whatever was sent: it reverses that booking exactly
    -- (the design's reading 5), as its VAT is stated at the original's rate.
    SELECT o.book_rate_to_sek, o.book_rate_date
      INTO orig
      FROM invoice o
     WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.credits_invoice_id;
    NEW.book_rate_to_sek := orig.book_rate_to_sek;
    NEW.book_rate_date := orig.book_rate_date;
    RETURN NEW;
  END IF;

  IF NEW.currency = 'SEK' THEN
    RETURN NEW; -- the CHECK refuses a rate
  END IF;

  IF NEW.fx_rate_to_sek IS NOT NULL THEN
    -- C82 (f): it carries Swedish VAT (`invoice_guard` holds the VAT's rate
    -- to exactly that) — booked at the VAT's own rate, so the VAT return adds
    -- up: the taxable amount and its VAT converted at one rate.
    IF NEW.book_rate_to_sek IS DISTINCT FROM NEW.fx_rate_to_sek
       OR NEW.book_rate_date IS DISTINCT FROM NEW.fx_rate_date THEN
      RAISE EXCEPTION 'INVOICE_BOOK_RATE_GUARD: an invoice carrying VAT in another currency is booked at its VAT''s rate';
    END IF;
  ELSIF NEW.book_rate_date IS NULL
        OR NEW.book_rate_date > NEW.issue_date
        OR NEW.book_rate_date < NEW.issue_date - 10 THEN
    -- C82 (d): the ECB's latest rate on or before the invoice date, at most
    -- ten days earlier (FX_MAX_AGE_DAYS — Easter is a four-day gap).
    RAISE EXCEPTION 'INVOICE_BOOK_RATE_GUARD: an invoice in another currency is booked at the ECB rate of its date';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER invoice_book_rate_guard
  BEFORE UPDATE OF status ON invoice
  FOR EACH ROW EXECUTE FUNCTION invoice_book_rate_guard();


-- ── 2. The one lock ─────────────────────────────────────────────────
-- A maker of a file calls it first; both guards call it again (re-entrant
-- within a transaction). Only for the workspace the transaction is in.
CREATE OR REPLACE FUNCTION invoice_export_lock(p_tenant text) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF p_tenant IS DISTINCT FROM current_setting('app.tenant_id', true)
     OR current_setting('app.principal', true) IS DISTINCT FROM 'member' THEN
    RAISE EXCEPTION 'INVOICE_EXPORT_LOCK: only a member, for the workspace in hand';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('invoice_export:' || p_tenant));
END
$fn$;

REVOKE EXECUTE ON FUNCTION invoice_export_lock(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invoice_export_lock(text) TO app_runtime;


-- ── 3. A file ───────────────────────────────────────────────────────
ALTER TABLE invoice_export
  ADD CONSTRAINT invoice_export_number_positive CHECK (number > 0),
  ADD CONSTRAINT invoice_export_series_shape CHECK (series ~ '^[A-Z0-9]{1,10}$');

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
  -- Numbered here, under the lock: the next of the workspace's.
  NEW.number := (SELECT coalesce(max(e.number), 0) + 1 FROM invoice_export e WHERE e.tenant_id = NEW.tenant_id);
  RETURN NEW;
END
$fn$;

CREATE TRIGGER invoice_export_guard
  BEFORE INSERT OR UPDATE OR DELETE ON invoice_export
  FOR EACH ROW EXECUTE FUNCTION invoice_export_guard();


-- ── 4. A booked event ───────────────────────────────────────────────
-- ISSUE once per invoice or credit note; CREDIT_NOTED once per credit note.
CREATE UNIQUE INDEX invoice_export_entry_issue_once
  ON invoice_export_entry (tenant_id, invoice_id) WHERE event = 'ISSUE';
CREATE UNIQUE INDEX invoice_export_entry_noted_once
  ON invoice_export_entry (tenant_id, invoice_id) WHERE event = 'CREDIT_NOTED';

ALTER TABLE invoice_export_entry
  ADD CONSTRAINT invoice_export_entry_position_positive CHECK (position > 0),
  ADD CONSTRAINT invoice_export_entry_detail_object CHECK (jsonb_typeof(detail) = 'object'),
  ADD CONSTRAINT invoice_export_entry_noted_unbooked CHECK (event <> 'CREDIT_NOTED' OR voucher IS NULL);

-- A voucher as the file writes it: { text, rows: [{ account, amount }] } —
-- text 1–50 characters (Fortnox's limit) with no double quote and no control
-- character (the design's H1: nothing the file must escape), at least one
-- row, each a four-digit account and a non-zero amount of exactly two
-- decimals, summing to zero; no other key (a date would be a second truth
-- beside `booked_on`). Shape first, amounts cast only once every one is known
-- to be a number.
CREATE OR REPLACE FUNCTION invoice_export_voucher_ok(v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
DECLARE
  r jsonb;
  total numeric := 0;
BEGIN
  IF jsonb_typeof(v) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(v -> 'text') IS DISTINCT FROM 'string'
     OR jsonb_typeof(v -> 'rows') IS DISTINCT FROM 'array'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(v) AS k(kname) WHERE k.kname NOT IN ('text', 'rows')) THEN
    RETURN false;
  END IF;
  IF char_length(v ->> 'text') NOT BETWEEN 1 AND 50
     OR (v ->> 'text') ~ '["[:cntrl:]]'
     OR jsonb_array_length(v -> 'rows') = 0 THEN
    RETURN false;
  END IF;
  FOR r IN SELECT x FROM jsonb_array_elements(v -> 'rows') AS t(x) LOOP
    IF jsonb_typeof(r) IS DISTINCT FROM 'object'
       OR coalesce(r ->> 'account', '') !~ '^[0-9]{4}$'
       OR coalesce(r ->> 'amount', '') !~ '^-?[0-9]{1,15}[.][0-9]{2}$' THEN
      RETURN false;
    END IF;
    IF (r ->> 'amount')::numeric = 0 THEN
      RETURN false;
    END IF;
    total := total + (r ->> 'amount')::numeric;
  END LOOP;
  RETURN total = 0;
END
$fn$;

-- Whether `b`'s rows are `a`'s, row by row, with every amount negated (both
-- already shown well formed by `invoice_export_voucher_ok`).
CREATE OR REPLACE FUNCTION invoice_export_rows_negated(a jsonb, b jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT jsonb_array_length(a -> 'rows') = jsonb_array_length(b -> 'rows')
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(a -> 'rows') WITH ORDINALITY AS ra(r, n)
         JOIN jsonb_array_elements(b -> 'rows') WITH ORDINALITY AS rb(r, n) ON rb.n = ra.n
        WHERE (ra.r ->> 'account') IS DISTINCT FROM (rb.r ->> 'account')
           OR (ra.r ->> 'amount')::numeric <> -((rb.r ->> 'amount')::numeric))
$fn$;

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
  SELECT f.method, f.made_on, f.created_by_member_id, (f.xmin = pg_current_xact_id()::xid) AS fresh
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

  IF NEW.event = 'ISSUE' THEN
    IF NEW.booked_on IS DISTINCT FROM doc.issue_date THEN
      RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: an issue is booked on its date';
    END IF;
  ELSIF NEW.event = 'CREDIT_NOTED' THEN
    IF doc.kind <> 'CREDIT_NOTE' OR NEW.booked_on IS DISTINCT FROM doc.issue_date THEN
      RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: a credit note is listed on its date';
    END IF;
  ELSE
    -- PAYMENT or PAYMENT_UNDONE — an invoice's, counted under the lock (this
    -- transaction's own earlier entries included).
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
    ELSE
      SELECT x.booked_on, x.voucher
        INTO last_paid
        FROM invoice_export_entry x
        JOIN invoice_export f ON f.tenant_id = x.tenant_id AND f.id = x.export_id
       WHERE x.tenant_id = NEW.tenant_id AND x.invoice_id = NEW.invoice_id AND x.event = 'PAYMENT'
       ORDER BY f.number DESC, x.position DESC
       LIMIT 1;
      IF booked_count <> 1
         OR last_paid.booked_on IS NOT DISTINCT FROM doc.paid_on
         OR NEW.booked_on IS DISTINCT FROM file_row.made_on THEN
        RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: a booked payment no longer marked is reversed on the file''s day';
      END IF;
      IF (last_paid.voucher IS NULL) IS DISTINCT FROM (NEW.voucher IS NULL)
         OR (NEW.voucher IS NOT NULL AND NOT invoice_export_rows_negated(last_paid.voucher, NEW.voucher)) THEN
        RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: a reversal negates what was booked, row by row';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER invoice_export_entry_guard
  BEFORE INSERT OR UPDATE OR DELETE ON invoice_export_entry
  FOR EACH ROW EXECUTE FUNCTION invoice_export_entry_guard();


-- ── Grants (deny-default, explicit per table) ───────────────────────
-- Written and read; never changed, never deleted by the app.
GRANT SELECT, INSERT ON invoice_export TO app_runtime;
GRANT SELECT, INSERT ON invoice_export_entry TO app_runtime;
-- app_platform already covers new tables via ALTER DEFAULT PRIVILEGES.

-- ── RLS: invoice_export — class A (portal_deny) ─────────────────────
ALTER TABLE invoice_export ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_export FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON invoice_export
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON invoice_export
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

-- ── RLS: invoice_export_entry — class A (portal_deny) ───────────────
ALTER TABLE invoice_export_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_export_entry FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON invoice_export_entry
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON invoice_export_entry
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');
