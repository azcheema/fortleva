-- ═══════════════════════════════════════════════════════════════════
-- Phase 4 slice 114b — THE NIGHTLY SEND TO FORTNOX, the engine (founder
-- decision C89 (b), (c)). DATA_MODEL.md §6.7; the design and its reviews:
-- docs/research/2026-10-12-slice-114-fortnox-connection-design.md (§5 as
-- amended by §10–§12). Slice 114 connected a workspace's Fortnox company;
-- this migration lets the nightly send book what the bookkeeping file holds
-- in it — each entry a voucher, its invoice's PDF attached — and nothing
-- else in Fortnox changes.
--
-- 1. `invoice_export` gains WHERE IT GOES: `destination` (DOWNLOAD, as every
--    file so far; FORTNOX — sent by the nightly send, never downloaded as an
--    SIE) and the `connection_id` it goes to; `created_by_member_id` may be
--    NULL — a file the nightly send made. A file of no member's is a Fortnox
--    file and never a year end; a member's Fortnox file is a year end (the
--    year end is a person's act — §10.3; every other entry of the connected
--    company is the night's).
--
-- 2. `invoice_export_lock(tenant)` re-created: a member, as before, OR the
--    nightly send — `app.principal` exactly 'system' (a platform admin also
--    carries an empty id) with `app.fortnox_sending` on. Every maker and both
--    guards still take this one key.
--
-- 3. `invoice_export_guard` re-created from 20261011090100's body, every rule
--    kept, plus (marked "114b"): the nightly send's branch beside the
--    member's, and a Fortnox file goes to the workspace's LIVE connection
--    (read FOR SHARE) — the night's only under its own live lease, and never
--    to one stopped for a reason only a person's reconnect mends
--    (CONSENT_GONE, NO_LICENCE, COMPANY_CHANGED).
--
-- 4. `invoice_org_digits(text)` — an org. number as ten digits (a 12-digit
--    form's century dropped), or NULL; the SQL twin of the app's
--    `orgDigitsOf`, held equal by a dbtest matrix.
--
-- 5. `invoice_export_entry_guard` re-created from 20261011090200's body,
--    every rule kept, plus (marked "114b"): the nightly send as an entry's
--    maker, and EACH COMPANY'S SALES ONLY INTO ITS OWN BOOKS (§10.3, the
--    design review's R3): an entry whose document's seller is the live
--    connection's company goes only into a Fortnox file to that connection;
--    any other seller's only into a download file — "never both", per seller.
--
-- 6. `invoice_export_delivery` (new, CLASS A) — one row per entry WITH A
--    VOUCHER in a Fortnox file, made QUEUED with the file in its transaction
--    by its maker (a deferred constraint trigger holds that none is missing
--    at commit — a voucher owed nothing would be in a file, never sent, and
--    never downloadable). The nightly send moves it QUEUED → SENDING (asked
--    of Fortnox; the series' next number kept, where a reconcile looks) →
--    BOOKED (Fortnox's year, series and number, set once) → DONE (every PDF
--    connected), or SENDING → QUEUED (refused for certain, or reconciled and
--    not found) — ONLY under its LEASE: `app.fortnox_run` equal to the
--    connection's live `send_run_id`, the connection not disconnected, read
--    FOR SHARE (the design review's §10.1). A member who may export invoices
--    moves one BY_HAND ("it is in Fortnox's books", from QUEUED or BOOKED),
--    and — only once the connection is DISCONNECTED (§10.2; while it lives,
--    an unanswered voucher is the sender's to reconcile: the pre-apply
--    review's medium) — a SENDING one BY_HAND or back to QUEUED ("it is not
--    in Fortnox"), and QUEUED → DOWNLOADED; never while a lease is live on a
--    connection that is not disconnected (slice 114c builds those acts; the
--    rules are here so the guard is written once). DONE, BY_HAND
--    and DOWNLOADED are history. One Fortnox voucher is one entry (a partial
--    UNIQUE). DELETE: platform maintenance only.
--
-- Every GUC is read through `coalesce(…, '')` where it decides — an unset
-- one reads NULL, and `NOT NULL` refuses nothing (memory
-- `plpgsql-null-guc-trap`). The re-created functions keep their predecessors'
-- own lines as they were; `src/modules/invoicing/fortnox-send-migration.test.ts`
-- diffs each against its previous migration and allows only hunks marked
-- "114b" (the design review's Q8).
--
-- DDL only — no DML, no `neon-smoke.yml` dispatch owed. Existing rows: every
-- file has a member and takes DOWNLOAD with no connection, so the new CHECKs
-- hold; the delivery table is new; the guards run on writes only. Left out of
-- Prisma's generated diff, as every migration since they appeared has: the
-- drift it always reports (`document_tenant_id_tags_idx`, `search_index`, the
-- `work_item` index name) — hand-written objects Prisma does not model.
-- ═══════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "invoice_export_destination" AS ENUM ('DOWNLOAD', 'FORTNOX');

-- CreateEnum
CREATE TYPE "invoice_export_delivery_state" AS ENUM ('QUEUED', 'SENDING', 'BOOKED', 'DONE', 'BY_HAND', 'DOWNLOADED');

-- AlterTable
ALTER TABLE "invoice_export" ADD COLUMN     "connection_id" TEXT,
ADD COLUMN     "destination" "invoice_export_destination" NOT NULL DEFAULT 'DOWNLOAD',
ALTER COLUMN "created_by_member_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "invoice_export_delivery" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "entry_id" TEXT NOT NULL,
    "export_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "state" "invoice_export_delivery_state" NOT NULL DEFAULT 'QUEUED',
    "fortnox_year" INTEGER,
    "fortnox_series" TEXT,
    "fortnox_number" INTEGER,
    "fortnox_next_before" INTEGER,
    "files" JSONB NOT NULL DEFAULT '[]',
    "attempted_at" TIMESTAMPTZ(6),
    "booked_at" TIMESTAMPTZ(6),
    "done_at" TIMESTAMPTZ(6),
    "handled_by_member_id" TEXT,
    "handled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_export_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invoice_export_delivery_tenant_id_connection_id_state_idx" ON "invoice_export_delivery"("tenant_id", "connection_id", "state");

-- CreateIndex
CREATE INDEX "invoice_export_delivery_tenant_id_export_id_idx" ON "invoice_export_delivery"("tenant_id", "export_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_export_delivery_tenant_id_id_key" ON "invoice_export_delivery"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_export_delivery_tenant_id_entry_id_key" ON "invoice_export_delivery"("tenant_id", "entry_id");

-- AddForeignKey
ALTER TABLE "invoice_export" ADD CONSTRAINT "invoice_export_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "integration_connection"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_export_delivery" ADD CONSTRAINT "invoice_export_delivery_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_export_delivery" ADD CONSTRAINT "invoice_export_delivery_tenant_id_entry_id_fkey" FOREIGN KEY ("tenant_id", "entry_id") REFERENCES "invoice_export_entry"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_export_delivery" ADD CONSTRAINT "invoice_export_delivery_tenant_id_export_id_fkey" FOREIGN KEY ("tenant_id", "export_id") REFERENCES "invoice_export"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_export_delivery" ADD CONSTRAINT "invoice_export_delivery_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "integration_connection"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── 1. Where a file goes ────────────────────────────────────────────
ALTER TABLE invoice_export
  -- A Fortnox file names its connection, and only a Fortnox file does.
  ADD CONSTRAINT invoice_export_destination_connection CHECK ((destination = 'FORTNOX') = (connection_id IS NOT NULL)),
  -- A file of no member's is the nightly send's: a Fortnox file, never a year end…
  ADD CONSTRAINT invoice_export_night_file CHECK (created_by_member_id IS NOT NULL OR (destination = 'FORTNOX' AND year_end IS NULL)),
  -- …and a member's Fortnox file is a year end (the connected company's other
  -- entries are the night's; a member makes download files of the others').
  ADD CONSTRAINT invoice_export_member_fortnox_year_end CHECK (created_by_member_id IS NULL OR destination = 'DOWNLOAD' OR year_end IS NOT NULL);


-- ── 2. The one lock ─────────────────────────────────────────────────
-- Re-created from 20261010230000: the nightly send takes it too.
CREATE OR REPLACE FUNCTION invoice_export_lock(p_tenant text) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF p_tenant IS DISTINCT FROM current_setting('app.tenant_id', true)
     -- 114b: a member — or the nightly send: SYSTEM exactly (a platform admin
     -- also carries an empty id), behind its GUC (`fortnox-send.ts` alone).
     OR (current_setting('app.principal', true) IS DISTINCT FROM 'member'
         AND NOT (coalesce(current_setting('app.principal', true), '') = 'system'
                  AND coalesce(current_setting('app.fortnox_sending', true), '') = 'on')) THEN
    RAISE EXCEPTION 'INVOICE_EXPORT_LOCK: only a member or the nightly send, for the workspace in hand';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('invoice_export:' || p_tenant));
END
$fn$;

-- (CREATE OR REPLACE keeps 20261010230000's EXECUTE grants: app_runtime only.)


-- ── 3. A file ───────────────────────────────────────────────────────
-- Re-created from 20261011090100 (the newest body); 114b's hunks marked.
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
  -- 114b: the nightly send — SYSTEM exactly, behind its GUC (set by
  -- `src/modules/invoicing/fortnox-send.ts` alone); never NULL.
  sender boolean := coalesce(current_setting('app.principal', true), '') = 'system'
                    AND coalesce(current_setting('app.fortnox_sending', true), '') = 'on';
  conn record;
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
  -- 114b: …or THE NIGHTLY SEND: a Fortnox file of no member's, never a year
  -- end (a year end is a person's act).
  IF sender THEN
    IF NEW.created_by_member_id IS NOT NULL OR NEW.destination IS DISTINCT FROM 'FORTNOX' OR NEW.year_end IS NOT NULL THEN
      RAISE EXCEPTION 'INVOICE_EXPORT_GUARD: the nightly send makes a Fortnox file of its own, never a year end';
    END IF;
  ELSE
    IF who IS DISTINCT FROM 'member' OR NEW.created_by_member_id IS DISTINCT FROM who_id THEN
      RAISE EXCEPTION 'INVOICE_EXPORT_GUARD: a member makes a bookkeeping file, as themselves';
    END IF;
    IF NOT invoice_member_holds(NEW.tenant_id, who_id, 'invoice:export') THEN
      RAISE EXCEPTION 'INVOICE_EXPORT_GUARD: only a member who may export invoices makes a bookkeeping file';
    END IF;
  END IF; -- 114b: the member's branch ends
  IF NEW.created_at < at - slack OR NEW.created_at > at + slack THEN
    RAISE EXCEPTION 'INVOICE_EXPORT_GUARD: a bookkeeping file is made now';
  END IF;
  -- The workspace's day: within a day of the UTC date (every zone's today).
  IF NEW.made_on < utc_today - 1 OR NEW.made_on > utc_today + 1 THEN
    RAISE EXCEPTION 'INVOICE_EXPORT_GUARD: a bookkeeping file is dated the day it is made';
  END IF;

  PERFORM invoice_export_lock(NEW.tenant_id);
  -- 114b: a Fortnox file goes to the workspace's LIVE connection, read FOR
  -- SHARE (a disconnect — which takes the lock above too — or the sender's
  -- upkeep waits for this file). A member's (a year end) to any live one: it
  -- goes once Fortnox answers. The nightly send's only under its own live
  -- LEASE (`app.fortnox_run`, the pre-apply review's nit: each file delivered
  -- before the next is made), and never to one stopped for a reason only a
  -- person's reconnect mends (`integration_connection_guard`'s list) — a stop
  -- it retries (a PDF not attached, a year missing) holds no file: the night
  -- makes one only when nothing else is owed.
  IF NEW.destination = 'FORTNOX' THEN
    SELECT c.status, c.broken_reason, c.send_run_id, c.send_lease_until
      INTO conn
      FROM integration_connection c
     WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.connection_id AND c.provider = 'FORTNOX'
       FOR SHARE;
    IF NOT FOUND OR conn.status = 'DISCONNECTED'
       OR (sender AND conn.status = 'BROKEN'
           AND coalesce(conn.broken_reason ->> 'kind', '') IN ('CONSENT_GONE', 'NO_LICENCE', 'COMPANY_CHANGED'))
       OR (sender AND (coalesce(current_setting('app.fortnox_run', true), '') = ''
                       OR conn.send_run_id IS DISTINCT FROM coalesce(current_setting('app.fortnox_run', true), '')
                       OR conn.send_lease_until IS NULL OR conn.send_lease_until <= at)) THEN
      RAISE EXCEPTION 'INVOICE_EXPORT_GUARD: a Fortnox file goes to the workspace''s live connection';
    END IF;
  END IF;
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


-- ── 4. An org. number as ten digits ─────────────────────────────────
-- The digits of a Swedish organisation (or personal identity) number, with a
-- 12-digit form's century (16, 18, 19, 20) dropped; NULL for anything that is
-- not ten digits then — so two missing numbers are never "the same company"
-- (the design review's S6). The app's twin is `orgDigitsOf`
-- (`src/modules/invoicing/org-digits.ts`); a dbtest holds them equal.
CREATE OR REPLACE FUNCTION invoice_org_digits(raw text) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT CASE
           WHEN s.d ~ '^(16|18|19|20)[0-9]{10}$' THEN substr(s.d, 3)
           WHEN s.d ~ '^[0-9]{10}$' THEN s.d
         END
    FROM (SELECT regexp_replace(coalesce(raw, ''), '[^0-9]', '', 'g') AS d) s
$fn$;

REVOKE EXECUTE ON FUNCTION invoice_org_digits(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invoice_org_digits(text) TO app_runtime;


-- ── 5. A booked event ───────────────────────────────────────────────
-- Re-created from 20261011090200 (the newest body); 114b's hunks marked.
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
  -- 114b: the nightly send (as in `invoice_export_guard`; never NULL), and the
  -- per-seller destination's facts.
  sender boolean := coalesce(current_setting('app.principal', true), '') = 'system'
                    AND coalesce(current_setting('app.fortnox_sending', true), '') = 'on';
  live_conn record;
  v_connected boolean;
  v_seller text;
  v_ours boolean;
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

  IF who IS DISTINCT FROM 'member' AND NOT sender THEN -- 114b: or the nightly send
    RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: a member makes a bookkeeping file';
  END IF;
  -- Its file was made IN THIS TRANSACTION, by this member: a file never grows
  -- after it is made.
  -- 114b: by its maker — the member, or the nightly send (a file of no
  -- member's); and where the file goes.
  SELECT f.method, f.made_on, f.year_end, f.created_by_member_id, (f.xmin = pg_current_xact_id()::xid) AS fresh,
         f.destination, f.connection_id
    INTO file_row
    FROM invoice_export f
   WHERE f.tenant_id = NEW.tenant_id AND f.id = NEW.export_id;
  IF NOT FOUND OR NOT file_row.fresh
     OR file_row.created_by_member_id IS DISTINCT FROM (CASE WHEN sender THEN NULL ELSE who_id END) THEN -- 114b
    RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: an entry joins a file made in its own transaction, by its maker';
  END IF;

  PERFORM invoice_export_lock(NEW.tenant_id);

  -- FOR SHARE (the pre-apply review's 2): a Mark as paid / unpaid in flight
  -- is waited for and its committed row read, so "paid on that day" holds at
  -- commit, not only at this read (`invoice_line_time_entry_guard`'s precedent).
  -- 114b: and its seller's org. number (the destination is per seller).
  SELECT i.kind, i.status, i.issue_date, i.paid_on, i.seller_snapshot ->> 'orgNr' AS seller_org
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
  -- 114b: EACH COMPANY'S SALES ONLY INTO ITS OWN BOOKS (the design review's
  -- R3, §10.3). The workspace's live Fortnox connection, read FOR SHARE (a
  -- disconnect waits for this file): an entry of the seller whose org. number
  -- is that connection's goes ONLY into a Fortnox file to it, any other
  -- seller's ONLY into a download file — never both. Ten digits on each side
  -- (`invoice_org_digits`); none on either side is never a match (S6).
  SELECT c.id, invoice_org_digits(c.company_org_nr) AS org
    INTO live_conn
    FROM integration_connection c
   WHERE c.tenant_id = NEW.tenant_id AND c.provider = 'FORTNOX' AND c.status <> 'DISCONNECTED'
     FOR SHARE;
  v_connected := FOUND;
  v_seller := invoice_org_digits(doc.seller_org);
  v_ours := v_connected AND v_seller IS NOT NULL AND live_conn.org IS NOT DISTINCT FROM v_seller;
  IF file_row.destination = 'FORTNOX' THEN
    IF NOT v_ours OR live_conn.id IS DISTINCT FROM file_row.connection_id THEN
      RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: a Fortnox file holds its connected company''s entries only';
    END IF;
  ELSIF v_ours THEN
    RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_GUARD: the connected company''s entries go to Fortnox, never into a download file';
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


-- ── 6. A voucher owed to Fortnox ────────────────────────────────────
-- What `files` may hold: at most a hundred PDFs (the app reports a voucher owing more —
-- `FILES_MAX`, fortnox-send.ts — rather than write past it), each { invoiceId, fileId,
-- connected } — Fortnox's file id as it came back (letters, digits and
-- hyphens; the design review's S14) and whether it is connected to the
-- voucher. A PDF is listed once uploaded; nothing else is ever in it.
CREATE OR REPLACE FUNCTION invoice_export_delivery_files_ok(v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
DECLARE
  e jsonb;
BEGIN
  IF jsonb_typeof(v) IS DISTINCT FROM 'array' OR jsonb_array_length(v) > 100 THEN
    RETURN false;
  END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(v) AS t(x) LOOP
    IF jsonb_typeof(e) IS DISTINCT FROM 'object'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(e) AS k(kname) WHERE k.kname NOT IN ('invoiceId', 'fileId', 'connected'))
       OR jsonb_typeof(e -> 'invoiceId') IS DISTINCT FROM 'string'
       OR jsonb_typeof(e -> 'fileId') IS DISTINCT FROM 'string'
       OR coalesce(e ->> 'fileId', '') !~ '^[A-Za-z0-9-]{1,64}$'
       OR jsonb_typeof(e -> 'connected') IS DISTINCT FROM 'boolean' THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END
$fn$;

ALTER TABLE invoice_export_delivery
  -- Fortnox's voucher: all three or none, well formed…
  ADD CONSTRAINT invoice_export_delivery_voucher_triple
    CHECK (num_nonnulls(fortnox_year, fortnox_series, fortnox_number) IN (0, 3)),
  ADD CONSTRAINT invoice_export_delivery_voucher_shape
    CHECK (fortnox_number IS NULL OR (fortnox_year > 0 AND fortnox_number > 0 AND fortnox_series ~ '^[A-Z0-9]{1,10}$')),
  -- …known exactly when BOOKED or DONE (either way when booked by hand), and dated then.
  ADD CONSTRAINT invoice_export_delivery_voucher_state
    CHECK (CASE state
             WHEN 'BOOKED' THEN fortnox_number IS NOT NULL
             WHEN 'DONE' THEN fortnox_number IS NOT NULL
             WHEN 'BY_HAND' THEN true
             ELSE fortnox_number IS NULL
           END),
  ADD CONSTRAINT invoice_export_delivery_booked_at CHECK ((booked_at IS NULL) = (fortnox_number IS NULL)),
  -- While SENDING: when it was asked, and the number a reconcile starts from.
  ADD CONSTRAINT invoice_export_delivery_sending
    CHECK ((fortnox_next_before IS NOT NULL) = (state = 'SENDING') AND (fortnox_next_before IS NULL OR fortnox_next_before > 0)),
  ADD CONSTRAINT invoice_export_delivery_attempted CHECK (state NOT IN ('SENDING', 'BOOKED', 'DONE') OR attempted_at IS NOT NULL),
  ADD CONSTRAINT invoice_export_delivery_done CHECK ((done_at IS NOT NULL) = (state = 'DONE')),
  -- A person's act, theirs and dated: booked by hand, or downloaded.
  ADD CONSTRAINT invoice_export_delivery_handled
    CHECK ((handled_by_member_id IS NULL) = (handled_at IS NULL)
           AND (handled_by_member_id IS NOT NULL) = (state IN ('BY_HAND', 'DOWNLOADED'))),
  ADD CONSTRAINT invoice_export_delivery_files CHECK (invoice_export_delivery_files_ok(files));

-- One Fortnox voucher is one entry.
CREATE UNIQUE INDEX invoice_export_delivery_one_voucher
  ON invoice_export_delivery (tenant_id, connection_id, fortnox_year, fortnox_series, fortnox_number)
  WHERE fortnox_number IS NOT NULL;

CREATE OR REPLACE FUNCTION invoice_export_delivery_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  who text := coalesce(current_setting('app.principal', true), '');
  who_id text := coalesce(current_setting('app.principal_id', true), '');
  at timestamptz := statement_timestamp();
  maintenance boolean := coalesce(current_setting('app.invoice_maintenance', true), '') = 'on' AND current_user = 'app_platform';
  -- The nightly send: SYSTEM exactly, behind its GUC — and, for any change, its run.
  sender boolean := coalesce(current_setting('app.principal', true), '') = 'system'
                    AND coalesce(current_setting('app.fortnox_sending', true), '') = 'on';
  run text := coalesce(current_setting('app.fortnox_run', true), '');
  ent record;
  file_row record;
  conn record;
  leased boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF maintenance THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'INVOICE_EXPORT_DELIVERY_GUARD: a delivery is never deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- QUEUED, with nothing sent, for a voucher of a Fortnox file made in THIS
    -- transaction — by its maker: the member (a year end) or the nightly send.
    NEW.created_at := at;
    IF NEW.state IS DISTINCT FROM 'QUEUED'
       OR num_nonnulls(NEW.fortnox_year, NEW.fortnox_series, NEW.fortnox_number, NEW.fortnox_next_before,
                       NEW.attempted_at, NEW.booked_at, NEW.done_at, NEW.handled_by_member_id, NEW.handled_at) <> 0
       OR NEW.files IS DISTINCT FROM '[]'::jsonb THEN
      RAISE EXCEPTION 'INVOICE_EXPORT_DELIVERY_GUARD: a delivery starts QUEUED, with nothing sent';
    END IF;
    SELECT x.export_id, (x.voucher IS NOT NULL) AS booked
      INTO ent
      FROM invoice_export_entry x
     WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.entry_id;
    SELECT f.destination, f.connection_id, f.created_by_member_id, (f.xmin = pg_current_xact_id()::xid) AS fresh
      INTO file_row
      FROM invoice_export f
     WHERE f.tenant_id = NEW.tenant_id AND f.id = NEW.export_id;
    IF ent.export_id IS DISTINCT FROM NEW.export_id OR ent.booked IS NOT TRUE
       OR file_row.destination IS DISTINCT FROM 'FORTNOX'
       OR file_row.connection_id IS DISTINCT FROM NEW.connection_id
       OR file_row.fresh IS NOT TRUE THEN
      RAISE EXCEPTION 'INVOICE_EXPORT_DELIVERY_GUARD: a delivery is made for a voucher of a Fortnox file, with the file';
    END IF;
    IF NOT ((who = 'member' AND who_id <> '' AND file_row.created_by_member_id IS NOT DISTINCT FROM who_id)
            OR (sender AND file_row.created_by_member_id IS NULL)) THEN
      RAISE EXCEPTION 'INVOICE_EXPORT_DELIVERY_GUARD: a delivery is made by its file''s maker';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE. What it is for never changes; Fortnox's voucher, once known,
  -- never changes; a delivery done, booked by hand or downloaded is history.
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.entry_id IS DISTINCT FROM OLD.entry_id OR NEW.export_id IS DISTINCT FROM OLD.export_id
     OR NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'INVOICE_EXPORT_DELIVERY_GUARD: a delivery''s entry, file and connection never change';
  END IF;
  IF OLD.fortnox_number IS NOT NULL
     AND (NEW.fortnox_year IS DISTINCT FROM OLD.fortnox_year OR NEW.fortnox_series IS DISTINCT FROM OLD.fortnox_series
          OR NEW.fortnox_number IS DISTINCT FROM OLD.fortnox_number OR NEW.booked_at IS DISTINCT FROM OLD.booked_at) THEN
    RAISE EXCEPTION 'INVOICE_EXPORT_DELIVERY_GUARD: Fortnox''s voucher, once known, never changes';
  END IF;
  IF OLD.state IN ('DONE', 'BY_HAND', 'DOWNLOADED') THEN
    RAISE EXCEPTION 'INVOICE_EXPORT_DELIVERY_GUARD: a delivery done, booked by hand or downloaded is history';
  END IF;

  -- Its connection, FOR SHARE: the lease and the status hold until this commits
  -- (a disconnect, or a run claiming the lease, waits for it).
  SELECT c.status, c.send_run_id, c.send_lease_until
    INTO conn
    FROM integration_connection c
   WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.connection_id
     FOR SHARE;
  leased := conn.send_lease_until IS NOT NULL AND conn.send_lease_until > at;

  IF sender THEN
    -- THE NIGHTLY SEND, under its own live lease, to a connection not disconnected.
    IF run = '' OR conn.send_run_id IS DISTINCT FROM run OR NOT leased
       OR conn.status IS NOT DISTINCT FROM 'DISCONNECTED' THEN
      RAISE EXCEPTION 'INVOICE_EXPORT_DELIVERY_GUARD: the nightly send writes under its own live lease, to a live connection';
    END IF;

    IF OLD.state = 'QUEUED' AND NEW.state = 'SENDING' THEN
      -- Asked of Fortnox now; the series' next number kept for a reconcile.
      NEW.attempted_at := at;
      IF (to_jsonb(NEW) - 'state' - 'attempted_at' - 'fortnox_next_before')
         IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'attempted_at' - 'fortnox_next_before') THEN
        RAISE EXCEPTION 'INVOICE_EXPORT_DELIVERY_GUARD: a delivery is asked of Fortnox with nothing else changed';
      END IF;
      RETURN NEW;
    END IF;

    IF OLD.state = 'SENDING' AND NEW.state = 'QUEUED' THEN
      -- Refused for certain, or reconciled and not found: to be asked again.
      IF (to_jsonb(NEW) - 'state' - 'fortnox_next_before')
         IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'fortnox_next_before') THEN
        RAISE EXCEPTION 'INVOICE_EXPORT_DELIVERY_GUARD: a delivery goes back to the queue with nothing else changed';
      END IF;
      RETURN NEW;
    END IF;

    IF OLD.state = 'SENDING' AND NEW.state = 'BOOKED' THEN
      -- Fortnox's voucher, in the file's own series, dated now.
      IF NEW.fortnox_number IS NULL
         OR NEW.fortnox_series IS DISTINCT FROM (SELECT f.series FROM invoice_export f
                                                  WHERE f.tenant_id = NEW.tenant_id AND f.id = NEW.export_id) THEN
        RAISE EXCEPTION 'INVOICE_EXPORT_DELIVERY_GUARD: a booked delivery names its voucher in its file''s series';
      END IF;
      NEW.booked_at := at;
      IF (to_jsonb(NEW) - 'state' - 'fortnox_year' - 'fortnox_series' - 'fortnox_number' - 'fortnox_next_before' - 'booked_at')
         IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'fortnox_year' - 'fortnox_series' - 'fortnox_number' - 'fortnox_next_before' - 'booked_at') THEN
        RAISE EXCEPTION 'INVOICE_EXPORT_DELIVERY_GUARD: a delivery is booked with nothing else changed';
      END IF;
      RETURN NEW;
    END IF;

    IF OLD.state = 'BOOKED' AND NEW.state = 'BOOKED' THEN
      -- Its PDFs' progress: only `files`.
      IF (to_jsonb(NEW) - 'files') IS DISTINCT FROM (to_jsonb(OLD) - 'files') THEN
        RAISE EXCEPTION 'INVOICE_EXPORT_DELIVERY_GUARD: a booked delivery records its PDFs only';
      END IF;
      RETURN NEW;
    END IF;

    IF OLD.state = 'BOOKED' AND NEW.state = 'DONE' THEN
      -- Every PDF it owes connected: its own document's and, for a payment,
      -- each credit note it deducted (the entry's `detail.deductedIds`).
      SELECT x.invoice_id, x.detail
        INTO ent
        FROM invoice_export_entry x
       WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.entry_id;
      IF EXISTS (SELECT 1
                   FROM (SELECT ent.invoice_id AS id
                         UNION
                         SELECT d.id FROM jsonb_array_elements_text(coalesce(ent.detail -> 'deductedIds', '[]'::jsonb)) AS d(id)) owed
                  WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.files) AS e(f)
                                     WHERE e.f ->> 'invoiceId' = owed.id AND (e.f ->> 'connected') = 'true'))
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.files) AS e(f) WHERE (e.f ->> 'connected') IS DISTINCT FROM 'true') THEN
        RAISE EXCEPTION 'INVOICE_EXPORT_DELIVERY_GUARD: a delivery is done when every PDF it owes is attached';
      END IF;
      NEW.done_at := at;
      IF (to_jsonb(NEW) - 'state' - 'files' - 'done_at') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'files' - 'done_at') THEN
        RAISE EXCEPTION 'INVOICE_EXPORT_DELIVERY_GUARD: a delivery is done with nothing else changed';
      END IF;
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'INVOICE_EXPORT_DELIVERY_GUARD: the nightly send moves a delivery forward only';
  END IF;

  IF who = 'member' AND who_id <> '' THEN
    -- A PERSON (slice 114c's acts): one who may export invoices, as themselves,
    -- never while the nightly send holds a live lease on a live connection.
    IF NOT invoice_member_holds(NEW.tenant_id, who_id, 'invoice:export') THEN
      RAISE EXCEPTION 'INVOICE_EXPORT_DELIVERY_GUARD: only a member who may export invoices marks a delivery';
    END IF;
    IF leased AND conn.status IS DISTINCT FROM 'DISCONNECTED' THEN
      RAISE EXCEPTION 'INVOICE_EXPORT_DELIVERY_GUARD: Fortleva is sending to Fortnox right now';
    END IF;

    -- A voucher asked of Fortnox with no answer (SENDING) is the sender's to
    -- reconcile by number while the connection lives — a person's "not in
    -- Fortnox" then would have it asked again, and twice if the first was made
    -- (the pre-apply review's medium; §10.1 R11). Only once it is DISCONNECTED
    -- (§10.2) does a person decide it.
    IF OLD.state = 'SENDING' AND conn.status IS DISTINCT FROM 'DISCONNECTED' THEN
      RAISE EXCEPTION 'INVOICE_EXPORT_DELIVERY_GUARD: a voucher whose answer is not known is decided by a person only after a disconnect';
    END IF;

    IF NEW.state = 'BY_HAND' AND OLD.state IN ('QUEUED', 'SENDING', 'BOOKED') THEN
      -- "It is in Fortnox's books" (or dealt with there): theirs, now.
      IF NEW.handled_by_member_id IS DISTINCT FROM who_id THEN
        RAISE EXCEPTION 'INVOICE_EXPORT_DELIVERY_GUARD: a member marks a delivery as themselves';
      END IF;
      NEW.handled_at := at;
      IF (to_jsonb(NEW) - 'state' - 'handled_by_member_id' - 'handled_at' - 'fortnox_next_before')
         IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'handled_by_member_id' - 'handled_at' - 'fortnox_next_before') THEN
        RAISE EXCEPTION 'INVOICE_EXPORT_DELIVERY_GUARD: booked by hand changes nothing else';
      END IF;
      RETURN NEW;
    END IF;

    IF OLD.state = 'SENDING' AND NEW.state = 'QUEUED' THEN
      -- "It is not in Fortnox": to be sent again (or downloaded, once disconnected).
      IF (to_jsonb(NEW) - 'state' - 'fortnox_next_before') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'fortnox_next_before') THEN
        RAISE EXCEPTION 'INVOICE_EXPORT_DELIVERY_GUARD: not in Fortnox changes nothing else';
      END IF;
      RETURN NEW;
    END IF;

    IF OLD.state = 'QUEUED' AND NEW.state = 'DOWNLOADED' THEN
      -- Handed over in an SIE of the entries never sent — only once the
      -- connection is gone (§10.2): theirs, now.
      IF conn.status IS DISTINCT FROM 'DISCONNECTED' THEN
        RAISE EXCEPTION 'INVOICE_EXPORT_DELIVERY_GUARD: an entry never sent is downloaded only after a disconnect';
      END IF;
      IF NEW.handled_by_member_id IS DISTINCT FROM who_id THEN
        RAISE EXCEPTION 'INVOICE_EXPORT_DELIVERY_GUARD: a member marks a delivery as themselves';
      END IF;
      NEW.handled_at := at;
      IF (to_jsonb(NEW) - 'state' - 'handled_by_member_id' - 'handled_at')
         IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'handled_by_member_id' - 'handled_at') THEN
        RAISE EXCEPTION 'INVOICE_EXPORT_DELIVERY_GUARD: downloaded changes nothing else';
      END IF;
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'INVOICE_EXPORT_DELIVERY_GUARD: a member marks a delivery booked by hand, not in Fortnox, or downloaded';
  END IF;

  RAISE EXCEPTION 'INVOICE_EXPORT_DELIVERY_GUARD: a delivery is moved only by the nightly send or by a member who may export invoices';
END
$fn$;

CREATE TRIGGER invoice_export_delivery_guard
  BEFORE INSERT OR UPDATE OR DELETE ON invoice_export_delivery
  FOR EACH ROW EXECUTE FUNCTION invoice_export_delivery_guard();

-- Every voucher of a Fortnox file is OWED a delivery, made with it: checked
-- at COMMIT (deferred), so the file's maker inserts its entries, then their
-- deliveries, in one transaction. Without it an entry could sit in a file —
-- never offered again — and in no queue: never sent, never downloadable.
CREATE OR REPLACE FUNCTION invoice_export_entry_owed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NEW.voucher IS NOT NULL
     AND EXISTS (SELECT 1 FROM invoice_export f
                  WHERE f.tenant_id = NEW.tenant_id AND f.id = NEW.export_id AND f.destination = 'FORTNOX')
     AND NOT EXISTS (SELECT 1 FROM invoice_export_delivery d
                      WHERE d.tenant_id = NEW.tenant_id AND d.entry_id = NEW.id) THEN
    RAISE EXCEPTION 'INVOICE_EXPORT_ENTRY_OWED: a Fortnox file''s voucher is owed a delivery, made with it';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER invoice_export_entry_owed
  AFTER INSERT ON invoice_export_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION invoice_export_entry_owed();


-- ── Grants (deny-default, explicit per table) ───────────────────────
-- Written and moved forward; never deleted by the app.
GRANT SELECT, INSERT, UPDATE ON invoice_export_delivery TO app_runtime;
-- app_platform already covers new tables via ALTER DEFAULT PRIVILEGES.

-- ── RLS: invoice_export_delivery — class A (portal_deny) ────────────
ALTER TABLE invoice_export_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_export_delivery FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON invoice_export_delivery
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON invoice_export_delivery
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');
