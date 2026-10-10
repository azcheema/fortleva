-- ═══════════════════════════════════════════════════════════════════
-- Phase 4 slice 110 — HOURS ONTO INVOICES (founder decisions C75 (a), (b)
-- and C80 (a)–(g)). DATA_MODEL.md §6.7 / §6.15; the design and its review:
-- docs/research/2026-10-10-slice-110-hours-onto-invoices-design.md (§9 is
-- the review's dispositions and overrides the body).
--
-- Billed hours are NEVER LOCKED, only MARKED (C75 (a)): an hour put on an
-- invoice leaves the ready-to-invoice list and stays editable; the issued
-- invoice — its frozen lines, and the record of which entries it billed — is
-- the bookkeeping record, never the live entries. `time_entry.locked_reason`
-- and `time_entry_lock_guard` are untouched.
--
-- 1. `project` gains its ROUNDING (C75 (b), C80 (c)): a step, a direction, an
--    optional minimum; off by default. `time_billed_seconds()` is the rule —
--    the SQL twin of `billedSeconds` in src/modules/invoicing/hours-lines.ts
--    (a dbtest runs both over one matrix). INTERNAL-ONLY: `project` is class B
--    and table-wide granted, so the three columns are on
--    `PORTAL_NEVER_SELECTED` (src/authz/portal-projections.test.ts).
--
-- 2. `invoice_line_time_entry` (new, CLASS A) — which entries a line billed,
--    as a SNAPSHOT of the hour when it was added (day, project, task, tracked
--    and billed seconds, rate). Written only with a line made for it in the
--    same transaction, on a DRAFT INVOICE, by a holder of
--    `invoice:generate_from_time`, of an hour that is finished, billable,
--    unmarked, of the invoice's client and currency, billed at its project's
--    rounding — or, for THE CORRECTED COPY of an invoice credited in full in
--    this transaction (C77 (c), C80 (f)), as an exact copy of that invoice's
--    record by a holder of `invoice:credit` (the design review's H1: a billed
--    hour may have been edited since, and the copy bills what the original
--    did). Never changed; never deleted except with its line (a draft's) or
--    by platform maintenance — an issued invoice's record never shrinks.
--
-- 3. `time_entry`: the marks, held by the database.
--      - FK `(tenant_id, invoice_line_id)` → `invoice_line` ON DELETE RESTRICT
--        (Prisma cannot express `SET NULL (column)` on a composite key with a
--        required tenant column — the `default_service_id` /
--        `update_template_id` precedent): removing a line or deleting a draft
--        clears its hours' marks first, in the same transaction.
--      - CHECK `time_entry_one_billing_mark`: at most one of the three marks.
--      - `time_entry_billing_guard` (BEFORE INSERT OR UPDATE OF the three):
--        who may set, clear or move each mark, and when (its header).
--      - The 2T partial index `time_entry_uninvoiced` (never read) is replaced
--        by `time_entry_ready` — the ready list's read — which also leaves out
--        the other two marks and 0-second rows (the review's M4: a line of
--        nothing is refused by `invoice_line_quantity_positive`), and
--        `time_entry_billing_marked` for the list's Marked section.
--
-- 4. `invoice_billed_hours_guard` on `invoice` (BEFORE UPDATE OF status,
--    currency) — its OWN trigger, so `invoice_guard` is not replaced again,
--    and named to fire BEFORE it (same timing → name order), i.e. before the
--    number is taken: a draft holding hours keeps its currency (the review's
--    M3), and an invoice leaves DRAFT only when every hour its record names is
--    marked on that line (the issued record never disagrees with the marks).
--
-- LOCK ORDER (the design's §3.2 and the review's M2): every writer that sets
-- or clears a mark takes its invoice FIRST (FOR UPDATE — the draft verbs'
-- `openDraft`, a credit's original), then the entries FOR UPDATE ordered by
-- id, then writes lines, link rows and marks. The guards' `FOR SHARE` on the
-- invoice is that same row, already held. Issuing a credit note locks its
-- original's marked entries right after the original, before the series is
-- taken, so freeing them never waits behind a member's edit.
--
-- DDL only — no DML, no `neon-smoke.yml` dispatch owed. The new CHECK on
-- `time_entry` is validated on existing rows: the three columns had no
-- writer before this slice (checked read-only on dev before applying).
-- ═══════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "invoice_rounding_mode" AS ENUM ('UP', 'NEAREST', 'DOWN');

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "invoice_rounding_minimum" SMALLINT,
ADD COLUMN     "invoice_rounding_mode" "invoice_rounding_mode",
ADD COLUMN     "invoice_rounding_step" SMALLINT;

-- CreateTable
CREATE TABLE "invoice_line_time_entry" (
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "invoice_line_id" TEXT NOT NULL,
    "time_entry_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "work_item_id" TEXT,
    "local_date" DATE NOT NULL,
    "raw_seconds" INTEGER NOT NULL,
    "billed_seconds" INTEGER NOT NULL,
    "bill_rate" DECIMAL(12,2),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_line_time_entry_pkey" PRIMARY KEY ("tenant_id","invoice_line_id","time_entry_id")
);

-- CreateIndex
CREATE INDEX "invoice_line_time_entry_tenant_id_time_entry_id_idx" ON "invoice_line_time_entry"("tenant_id", "time_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_line_time_entry_tenant_id_invoice_id_time_entry_id_key" ON "invoice_line_time_entry"("tenant_id", "invoice_id", "time_entry_id");

-- AddForeignKey
ALTER TABLE "invoice_line_time_entry" ADD CONSTRAINT "invoice_line_time_entry_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line_time_entry" ADD CONSTRAINT "invoice_line_time_entry_tenant_id_client_id_invoice_id_fkey" FOREIGN KEY ("tenant_id", "client_id", "invoice_id") REFERENCES "invoice"("tenant_id", "client_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line_time_entry" ADD CONSTRAINT "invoice_line_time_entry_tenant_id_invoice_line_id_fkey" FOREIGN KEY ("tenant_id", "invoice_line_id") REFERENCES "invoice_line"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line_time_entry" ADD CONSTRAINT "invoice_line_time_entry_tenant_id_time_entry_id_fkey" FOREIGN KEY ("tenant_id", "time_entry_id") REFERENCES "time_entry"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_tenant_id_invoice_line_id_fkey" FOREIGN KEY ("tenant_id", "invoice_line_id") REFERENCES "invoice_line"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── 1. A project's rounding ─────────────────────────────────────────
-- Off: all three NULL. On: a step the product offers, a direction, and a
-- minimum of 1 minute to a working day, or none.
ALTER TABLE project
  ADD CONSTRAINT project_invoice_rounding
    CHECK (    (invoice_rounding_step IS NULL AND invoice_rounding_mode IS NULL AND invoice_rounding_minimum IS NULL)
           OR (    invoice_rounding_step IN (1, 6, 10, 15, 30, 60)
               AND invoice_rounding_mode IS NOT NULL
               AND (invoice_rounding_minimum IS NULL OR invoice_rounding_minimum BETWEEN 1 AND 480)));

-- One entry's billed seconds under a rule (C80 (c): EACH ENTRY is rounded).
-- Off, or an entry of nothing: the tracked seconds. Integer arithmetic only:
-- for non-negative integers `/` floors, so UP is (raw + s − 1) / s, DOWN raw /
-- s, NEAREST (raw + s/2) / s — a half rounds up, and s = step × 60 is even, so
-- s/2 is exact. Then the minimum. MUST equal `billedSeconds` in
-- src/modules/invoicing/hours-lines.ts (the dbtest's matrix holds them equal).
-- `integer` parameters (the review's nit): a smallint column widens to them,
-- and a call with plain literals finds the function.
CREATE OR REPLACE FUNCTION time_billed_seconds(p_raw integer, p_step integer, p_mode invoice_rounding_mode, p_minimum integer)
RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $fn$
  SELECT CASE
           WHEN p_raw IS NULL THEN NULL
           WHEN p_step IS NULL OR p_mode IS NULL OR p_raw = 0 THEN p_raw
           ELSE greatest(
                  CASE p_mode
                    WHEN 'UP'   THEN ((p_raw + p_step * 60 - 1) / (p_step * 60)) * (p_step * 60)
                    WHEN 'DOWN' THEN (p_raw / (p_step * 60)) * (p_step * 60)
                    ELSE             ((p_raw + p_step * 30) / (p_step * 60)) * (p_step * 60)
                  END,
                  coalesce(p_minimum, 0) * 60)
         END
$fn$;


-- ── 2. The record of the hours a line billed ────────────────────────
ALTER TABLE invoice_line_time_entry
  -- Never negative; at most 31 days each — far past any entry the time
  -- module writes (24 h edits, a 48 h auto-stop), so no real hour is ever
  -- kept off an invoice by a raw constraint error (the review's nit).
  ADD CONSTRAINT invoice_line_time_entry_seconds
    CHECK (raw_seconds BETWEEN 0 AND 2678400 AND billed_seconds BETWEEN 0 AND 2678400),
  ADD CONSTRAINT invoice_line_time_entry_rate
    CHECK (bill_rate IS NULL OR bill_rate >= 0);

CREATE OR REPLACE FUNCTION invoice_line_time_entry_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  who text := current_setting('app.principal', true);
  who_id text := current_setting('app.principal_id', true);
  at timestamptz := statement_timestamp();
  slack constant interval := interval '5 minutes';
  maintenance boolean := current_setting('app.invoice_maintenance', true) = 'on' AND current_user = 'app_platform';
  copy_of text := nullif(current_setting('app.invoice_copy_of', true), '');
  ln record;
  inv record;
  orig record;
  -- NOT `e`: a record variable named like the query's table alias makes every
  -- `e.col` ambiguous at run time (42702 — the pre-apply review's HIGH).
  ent record;
  rule record;
BEGIN
  IF who = 'contact' THEN
    RAISE EXCEPTION 'INVOICE_HOURS_GUARD: a contact writes no invoice''s hours';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'INVOICE_HOURS_GUARD: the hours a line billed are recorded once and never changed';
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- Only its line's cascade (a draft's line removed, a draft deleted — the
    -- line guard has already refused an issued invoice's) or teardown. "Gone"
    -- is confirmed by trigger depth AND an unlocked read of the line or the
    -- invoice (the line guard's own test; the review's M5: either suffices,
    -- so the order two cascades fire in never matters).
    IF maintenance THEN
      RETURN OLD;
    END IF;
    IF pg_trigger_depth() > 1
       AND (   NOT EXISTS (SELECT 1 FROM invoice_line l WHERE l.tenant_id = OLD.tenant_id AND l.id = OLD.invoice_line_id)
            OR NOT EXISTS (SELECT 1 FROM invoice i WHERE i.tenant_id = OLD.tenant_id AND i.id = OLD.invoice_id)) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'INVOICE_HOURS_GUARD: the hours a line billed leave only with their line';
  END IF;

  -- INSERT. A member, as themselves, now.
  IF who IS DISTINCT FROM 'member' OR who_id IS NULL THEN
    RAISE EXCEPTION 'INVOICE_HOURS_GUARD: a member puts hours on an invoice';
  END IF;
  IF NEW.created_at < at - slack OR NEW.created_at > at + slack THEN
    RAISE EXCEPTION 'INVOICE_HOURS_GUARD: hours are recorded when they are put on a line';
  END IF;
  -- The line: on this invoice and its client, and MADE IN THIS TRANSACTION
  -- (its xmin — slice 98's probe): hours join a line written for them, never
  -- an existing one (reading 2 of the design: a draft's hours move only with
  -- their line). No savepoint may sit between the line and this row.
  SELECT l.invoice_id, l.client_id, (l.xmin = pg_current_xact_id()::xid) AS fresh
    INTO ln
    FROM invoice_line l
   WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.invoice_line_id;
  IF NOT FOUND OR ln.invoice_id IS DISTINCT FROM NEW.invoice_id OR ln.client_id IS DISTINCT FROM NEW.client_id THEN
    RAISE EXCEPTION 'INVOICE_HOURS_GUARD: the hours of a line of this invoice';
  END IF;
  IF NOT ln.fresh THEN
    RAISE EXCEPTION 'INVOICE_HOURS_GUARD: hours join a line made for them, in the same transaction';
  END IF;
  -- The invoice: a DRAFT INVOICE, held against its issue (the line guard's
  -- lock — the writer already holds it FOR UPDATE).
  SELECT i.status, i.kind, i.currency, (i.xmin = pg_current_xact_id()::xid) AS fresh
    INTO inv
    FROM invoice i
   WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.invoice_id
     FOR SHARE;
  IF NOT FOUND OR inv.status <> 'DRAFT' OR inv.kind <> 'INVOICE' THEN
    RAISE EXCEPTION 'INVOICE_NOT_DRAFT: hours go on a draft invoice';
  END IF;
  SELECT t.client_id, t.project_id, t.work_item_id, t.local_date, t.duration_seconds, t.billable, t.stopped_at,
         t.deleted_at, t.invoice_line_id, t.billed_externally_at, t.written_off_at, t.currency, t.bill_rate
    INTO ent
    FROM time_entry t
   WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.time_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVOICE_HOURS_GUARD: an hour of this workspace';
  END IF;

  IF copy_of IS NOT NULL THEN
    -- THE CORRECTED COPY (C77 (c), C80 (f); the design review's H1). The
    -- invoice named by `app.invoice_copy_of` was credited in full IN THIS
    -- TRANSACTION, this invoice was made in it too, and this row is an exact
    -- copy of that invoice's record of the hour, which is still marked on one
    -- of its lines (the move comes next). The live hour is NOT consulted: it
    -- may have been edited, moved or deleted since it was billed, and the
    -- copy bills exactly what the original did.
    IF NOT invoice_member_holds(NEW.tenant_id, who_id, 'invoice:credit') THEN
      RAISE EXCEPTION 'INVOICE_HOURS_GUARD: only a member who may credit invoices moves hours onto a corrected copy';
    END IF;
    SELECT o.status, o.client_id, (o.xmin = pg_current_xact_id()::xid) AS fresh
      INTO orig
      FROM invoice o
     WHERE o.tenant_id = NEW.tenant_id AND o.id = copy_of;
    IF NOT FOUND OR orig.status <> 'CREDITED' OR NOT orig.fresh OR NOT inv.fresh
       OR orig.client_id IS DISTINCT FROM NEW.client_id THEN
      RAISE EXCEPTION 'INVOICE_HOURS_GUARD: a corrected copy takes the hours of the invoice credited in full now';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM invoice_line_time_entry h
                    WHERE h.tenant_id = NEW.tenant_id AND h.invoice_id = copy_of AND h.time_entry_id = NEW.time_entry_id
                      AND h.project_id = NEW.project_id AND h.work_item_id IS NOT DISTINCT FROM NEW.work_item_id
                      AND h.local_date = NEW.local_date AND h.raw_seconds = NEW.raw_seconds
                      AND h.billed_seconds = NEW.billed_seconds AND h.bill_rate IS NOT DISTINCT FROM NEW.bill_rate)
       OR NOT EXISTS (SELECT 1 FROM invoice_line l
                       WHERE l.tenant_id = NEW.tenant_id AND l.id = ent.invoice_line_id AND l.invoice_id = copy_of) THEN
      RAISE EXCEPTION 'INVOICE_HOURS_GUARD: a corrected copy bills an hour as its invoice did';
    END IF;
    RETURN NEW;
  END IF;

  -- An hour put on a draft (C80 (a)): by a member who may, of the invoice's
  -- client, finished, billable, of some length, carrying no mark, in the
  -- invoice's currency or with no rate at all — recorded as it is now, and
  -- billed at its project's rounding (C80 (c)). The tokens a race can reach
  -- are HOURS_CHANGED ("some of these hours changed — look again").
  IF NOT invoice_member_holds(NEW.tenant_id, who_id, 'invoice:generate_from_time') THEN
    RAISE EXCEPTION 'INVOICE_HOURS_GUARD: only a member who may put hours on invoices does';
  END IF;
  IF ent.client_id IS DISTINCT FROM NEW.client_id THEN
    RAISE EXCEPTION 'HOURS_CHANGED: an hour of the invoice''s client';
  END IF;
  IF NOT ent.billable OR ent.stopped_at IS NULL OR ent.deleted_at IS NOT NULL OR coalesce(ent.duration_seconds, 0) <= 0
     OR ent.invoice_line_id IS NOT NULL OR ent.billed_externally_at IS NOT NULL OR ent.written_off_at IS NOT NULL THEN
    RAISE EXCEPTION 'HOURS_CHANGED: only a finished, billable hour not yet invoiced goes on an invoice';
  END IF;
  -- Keyed on the RATE, not the currency column (the pre-apply review's low):
  -- no CHECK pairs them, and a priced hour belongs on its currency's invoice.
  IF ent.bill_rate IS NOT NULL AND ent.currency IS DISTINCT FROM inv.currency THEN
    RAISE EXCEPTION 'HOURS_CHANGED: an hour priced in another currency';
  END IF;
  IF NEW.project_id IS DISTINCT FROM ent.project_id
     OR NEW.work_item_id IS DISTINCT FROM ent.work_item_id
     OR NEW.local_date IS DISTINCT FROM ent.local_date
     OR NEW.raw_seconds IS DISTINCT FROM ent.duration_seconds
     OR NEW.bill_rate IS DISTINCT FROM ent.bill_rate THEN
    RAISE EXCEPTION 'HOURS_CHANGED: an hour is recorded as it is';
  END IF;
  SELECT p.invoice_rounding_step, p.invoice_rounding_mode, p.invoice_rounding_minimum
    INTO rule
    FROM project p
   WHERE p.tenant_id = NEW.tenant_id AND p.id = ent.project_id;
  IF NOT FOUND
     OR NEW.billed_seconds IS DISTINCT FROM
        time_billed_seconds(NEW.raw_seconds, rule.invoice_rounding_step, rule.invoice_rounding_mode, rule.invoice_rounding_minimum) THEN
    RAISE EXCEPTION 'HOURS_CHANGED: an hour bills its project''s rounding of it';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER invoice_line_time_entry_guard
  BEFORE INSERT OR UPDATE OR DELETE ON invoice_line_time_entry
  FOR EACH ROW EXECUTE FUNCTION invoice_line_time_entry_guard();


-- ── 3. The marks on `time_entry` ────────────────────────────────────
ALTER TABLE time_entry
  ADD CONSTRAINT time_entry_one_billing_mark
    CHECK (num_nonnulls(invoice_line_id, billed_externally_at, written_off_at) <= 1);

-- Who may set, clear or move a mark, and when.
--   - A NEW row carries none — except a SPLIT's second half (the review's
--     M6), which inherits its first half's marks exactly, under
--     `app.time_split_of = <first half>` (updated in this transaction, the
--     same member's hour), never onto a DRAFT's line (refused by the app
--     first: such an hour is not billed yet — remove its line).
--   - "Billed elsewhere" / "Won't invoice" (C80 (g)): set (now) or cleared,
--     never moved, by a holder of `time:write_off`; set only on a finished,
--     billable hour on a project.
--   - LEAVING a line (X → NULL), by the line's invoice: a DRAFT → a holder of
--     `invoice:edit` or `invoice:delete` (the line removed, the draft
--     deleted); CREDITED → `invoice:credit` (a credit in full frees, in its
--     own transaction — C80 (f)); an issued invoice with an issued credit note
--     (`status <> 'DRAFT'` — a credit note moves on to SENT) →
--     `invoice:generate_from_time` AND `invoice:credit` (freed by hand,
--     asserting what the credit covered); any other issued invoice →
--     INVOICE_HOURS_KEPT.
--   - JOINING a line (NULL → Y): a holder of `invoice:generate_from_time`, Y a
--     DRAFT INVOICE of the hour's client, the hour finished, billable, not
--     deleted, its record on Y already written.
--   - MOVING (X → Y): only onto THE CORRECTED COPY, under
--     `app.invoice_copy_of`: X's invoice credited in full in this
--     transaction, Y a draft invoice of the same client made in it, a holder
--     of `invoice:credit`, and — where the hour has a record on X — the same
--     record on Y.
--   - Platform maintenance (teardown) does anything.
CREATE OR REPLACE FUNCTION time_entry_billing_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  who text := current_setting('app.principal', true);
  who_id text := current_setting('app.principal_id', true);
  at timestamptz := statement_timestamp();
  slack constant interval := interval '5 minutes';
  maintenance boolean := (   current_setting('app.invoice_maintenance', true) = 'on'
                          OR current_setting('app.time_maintenance', true) = 'on')
                         AND current_user = 'app_platform';
  copy_of text := nullif(current_setting('app.invoice_copy_of', true), '');
  split_of text := nullif(current_setting('app.time_split_of', true), '');
  src record;
  split_inv record;
  old_inv record;
  new_inv record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.invoice_line_id IS NULL AND NEW.billed_externally_at IS NULL AND NEW.written_off_at IS NULL THEN
      RETURN NEW;
    END IF;
    IF split_of IS NULL OR who IS DISTINCT FROM 'member' THEN
      RAISE EXCEPTION 'TIME_BILLING_GUARD: a new hour is not yet billed';
    END IF;
    -- The first half: shortened in this transaction, the same member's, on
    -- the same project, as billable — the split's other half, not any new row
    -- of that member's (the pre-apply review's L4).
    SELECT s.member_id, s.project_id, s.billable, s.invoice_line_id, s.billed_externally_at, s.written_off_at,
           (s.xmin = pg_current_xact_id()::xid) AS fresh
      INTO src
      FROM time_entry s
     WHERE s.tenant_id = NEW.tenant_id AND s.id = split_of;
    IF NOT FOUND OR NOT src.fresh OR src.member_id IS DISTINCT FROM NEW.member_id
       OR src.project_id IS DISTINCT FROM NEW.project_id
       OR src.billable IS DISTINCT FROM NEW.billable
       OR src.invoice_line_id IS DISTINCT FROM NEW.invoice_line_id
       OR src.billed_externally_at IS DISTINCT FROM NEW.billed_externally_at
       OR src.written_off_at IS DISTINCT FROM NEW.written_off_at THEN
      RAISE EXCEPTION 'TIME_BILLING_GUARD: a split''s second half carries its first half''s mark, and nothing else';
    END IF;
    IF NEW.invoice_line_id IS NOT NULL THEN
      -- Its invoice, held (the app took it FOR SHARE before the first half's
      -- update — invoice, then hour): never a draft's line (not billed yet),
      -- never a line a credit in full has just freed (the pre-apply review's
      -- L2: the half would stay marked on a credited invoice, freed by nothing).
      SELECT i.status
        INTO split_inv
        FROM invoice_line l
        JOIN invoice i ON i.tenant_id = l.tenant_id AND i.id = l.invoice_id
       WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.invoice_line_id
         FOR SHARE OF i;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'TIME_BILLING_GUARD: the line a split''s second half carries';
      END IF;
      IF split_inv.status = 'DRAFT' THEN
        RAISE EXCEPTION 'ENTRY_INVOICED: an hour on a draft invoice is split once its line is removed';
      END IF;
      IF split_inv.status = 'CREDITED' THEN
        RAISE EXCEPTION 'HOURS_CHANGED: the hour''s invoice was credited meanwhile';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: nothing to judge unless a mark actually changes (the trigger's
  -- column list fires on any SET of them).
  IF NEW.invoice_line_id IS NOT DISTINCT FROM OLD.invoice_line_id
     AND NEW.billed_externally_at IS NOT DISTINCT FROM OLD.billed_externally_at
     AND NEW.written_off_at IS NOT DISTINCT FROM OLD.written_off_at THEN
    RETURN NEW;
  END IF;
  IF maintenance THEN
    RETURN NEW;
  END IF;
  IF who IS DISTINCT FROM 'member' OR who_id IS NULL THEN
    RAISE EXCEPTION 'TIME_BILLING_GUARD: a member marks an hour, as themselves';
  END IF;

  -- "Billed elsewhere" and "Won't invoice".
  IF NEW.billed_externally_at IS DISTINCT FROM OLD.billed_externally_at
     OR NEW.written_off_at IS DISTINCT FROM OLD.written_off_at THEN
    IF NOT invoice_member_holds(NEW.tenant_id, who_id, 'time:write_off') THEN
      RAISE EXCEPTION 'TIME_BILLING_GUARD: only a member who may write off hours marks them';
    END IF;
    IF (    OLD.billed_externally_at IS NOT NULL AND NEW.billed_externally_at IS NOT NULL
        AND NEW.billed_externally_at IS DISTINCT FROM OLD.billed_externally_at)
       OR (    OLD.written_off_at IS NOT NULL AND NEW.written_off_at IS NOT NULL
           AND NEW.written_off_at IS DISTINCT FROM OLD.written_off_at) THEN
      RAISE EXCEPTION 'TIME_BILLING_GUARD: a mark is set or cleared, never moved';
    END IF;
    IF (OLD.billed_externally_at IS NULL AND NEW.billed_externally_at IS NOT NULL)
       OR (OLD.written_off_at IS NULL AND NEW.written_off_at IS NOT NULL) THEN
      IF coalesce(NEW.billed_externally_at, NEW.written_off_at) < at - slack
         OR coalesce(NEW.billed_externally_at, NEW.written_off_at) > at + slack THEN
        RAISE EXCEPTION 'TIME_BILLING_GUARD: an hour is marked when it is marked';
      END IF;
      IF NOT NEW.billable OR NEW.stopped_at IS NULL OR NEW.deleted_at IS NOT NULL OR NEW.project_id IS NULL THEN
        RAISE EXCEPTION 'HOURS_CHANGED: only a finished, billable hour on a project is marked';
      END IF;
    END IF;
  END IF;

  IF NEW.invoice_line_id IS DISTINCT FROM OLD.invoice_line_id THEN
    -- The invoices of the line it leaves and the line it joins, held (the
    -- writer already holds each FOR UPDATE — the lock order).
    IF OLD.invoice_line_id IS NOT NULL THEN
      SELECT i.id, i.status, i.kind, i.client_id, (i.xmin = pg_current_xact_id()::xid) AS fresh
        INTO old_inv
        FROM invoice_line l
        JOIN invoice i ON i.tenant_id = l.tenant_id AND i.id = l.invoice_id
       WHERE l.tenant_id = OLD.tenant_id AND l.id = OLD.invoice_line_id
         FOR SHARE OF i;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'TIME_BILLING_GUARD: the line an hour leaves';
      END IF;
    END IF;
    IF NEW.invoice_line_id IS NOT NULL THEN
      SELECT i.id, i.status, i.kind, i.client_id, (i.xmin = pg_current_xact_id()::xid) AS fresh
        INTO new_inv
        FROM invoice_line l
        JOIN invoice i ON i.tenant_id = l.tenant_id AND i.id = l.invoice_id
       WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.invoice_line_id
         FOR SHARE OF i;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'TIME_BILLING_GUARD: the line an hour joins';
      END IF;
    END IF;

    IF OLD.invoice_line_id IS NOT NULL AND NEW.invoice_line_id IS NOT NULL THEN
      -- MOVING: only onto the corrected copy of an invoice credited now.
      IF copy_of IS NULL OR old_inv.id IS DISTINCT FROM copy_of
         OR old_inv.status <> 'CREDITED' OR NOT old_inv.fresh
         OR new_inv.status <> 'DRAFT' OR new_inv.kind <> 'INVOICE' OR NOT new_inv.fresh
         OR new_inv.client_id IS DISTINCT FROM old_inv.client_id
         OR NOT invoice_member_holds(NEW.tenant_id, who_id, 'invoice:credit') THEN
        RAISE EXCEPTION 'TIME_BILLING_GUARD: an hour moves between invoices only onto the corrected copy of one credited now';
      END IF;
      IF EXISTS (SELECT 1 FROM invoice_line_time_entry h
                  WHERE h.tenant_id = NEW.tenant_id AND h.invoice_line_id = OLD.invoice_line_id AND h.time_entry_id = NEW.id)
         AND NOT EXISTS (SELECT 1 FROM invoice_line_time_entry h
                          WHERE h.tenant_id = NEW.tenant_id AND h.invoice_line_id = NEW.invoice_line_id AND h.time_entry_id = NEW.id) THEN
        RAISE EXCEPTION 'TIME_BILLING_GUARD: an hour moves onto a corrected copy with its record';
      END IF;
    ELSIF OLD.invoice_line_id IS NOT NULL THEN
      -- LEAVING.
      IF old_inv.status = 'DRAFT' THEN
        IF NOT (   invoice_member_holds(NEW.tenant_id, who_id, 'invoice:edit')
                OR invoice_member_holds(NEW.tenant_id, who_id, 'invoice:delete')) THEN
          RAISE EXCEPTION 'TIME_BILLING_GUARD: only a member who may edit or delete the draft takes hours off it';
        END IF;
      ELSIF old_inv.status = 'CREDITED' THEN
        IF NOT invoice_member_holds(NEW.tenant_id, who_id, 'invoice:credit') THEN
          RAISE EXCEPTION 'TIME_BILLING_GUARD: only a member who may credit invoices frees a credited invoice''s hours';
        END IF;
      ELSIF old_inv.kind = 'INVOICE'
            AND EXISTS (SELECT 1 FROM invoice c
                         WHERE c.tenant_id = NEW.tenant_id AND c.kind = 'CREDIT_NOTE'
                           AND c.credits_invoice_id = old_inv.id AND c.status <> 'DRAFT') THEN
        IF NOT (    invoice_member_holds(NEW.tenant_id, who_id, 'invoice:generate_from_time')
                AND invoice_member_holds(NEW.tenant_id, who_id, 'invoice:credit')) THEN
          RAISE EXCEPTION 'TIME_BILLING_GUARD: only a member who may put hours on invoices and credit them returns a partly credited invoice''s hours';
        END IF;
      ELSE
        RAISE EXCEPTION 'INVOICE_HOURS_KEPT: an issued invoice keeps its hours until it is credited';
      END IF;
    ELSE
      -- JOINING.
      IF NOT invoice_member_holds(NEW.tenant_id, who_id, 'invoice:generate_from_time') THEN
        RAISE EXCEPTION 'TIME_BILLING_GUARD: only a member who may put hours on invoices does';
      END IF;
      IF new_inv.status <> 'DRAFT' OR new_inv.kind <> 'INVOICE' THEN
        RAISE EXCEPTION 'INVOICE_NOT_DRAFT: hours go on a draft invoice';
      END IF;
      IF new_inv.client_id IS DISTINCT FROM NEW.client_id
         OR NOT NEW.billable OR NEW.stopped_at IS NULL OR NEW.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'HOURS_CHANGED: a finished, billable hour of the invoice''s client joins it';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM invoice_line_time_entry h
                      WHERE h.tenant_id = NEW.tenant_id AND h.invoice_line_id = NEW.invoice_line_id AND h.time_entry_id = NEW.id) THEN
        RAISE EXCEPTION 'TIME_BILLING_GUARD: an hour joins a line with its record';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER time_entry_billing_guard
  BEFORE INSERT OR UPDATE OF invoice_line_id, billed_externally_at, written_off_at ON time_entry
  FOR EACH ROW EXECUTE FUNCTION time_entry_billing_guard();

-- The ready list's read (replacing 2T's never-read `time_entry_uninvoiced`):
-- a client's billable, unmarked, live hours of some length, by day — a
-- running row has no length yet, so it is never in it.
DROP INDEX IF EXISTS time_entry_uninvoiced;
CREATE INDEX time_entry_ready ON time_entry (tenant_id, client_id, local_date)
  WHERE invoice_line_id IS NULL AND billed_externally_at IS NULL AND written_off_at IS NULL
    AND billable AND deleted_at IS NULL AND duration_seconds > 0;
-- …and its Marked section.
CREATE INDEX time_entry_billing_marked ON time_entry (tenant_id, client_id, local_date)
  WHERE billed_externally_at IS NOT NULL OR written_off_at IS NOT NULL;


-- ── 4. The invoice: its hours' currency, and the record at issue ────
CREATE OR REPLACE FUNCTION invoice_billed_hours_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  -- A draft holding tracked hours keeps their currency: its lines are priced
  -- in it (the review's M3).
  IF NEW.currency IS DISTINCT FROM OLD.currency
     AND EXISTS (SELECT 1 FROM invoice_line_time_entry h WHERE h.tenant_id = NEW.tenant_id AND h.invoice_id = NEW.id) THEN
    RAISE EXCEPTION 'INVOICE_HAS_HOURS: a draft holding tracked hours keeps their currency';
  END IF;
  -- Leaving DRAFT: every hour the invoice's record names is marked on that
  -- very line now. The reverse (every hour marked on its lines has a record)
  -- is the join rule's; a split's second half is the one mark without one.
  IF OLD.status = 'DRAFT' AND NEW.status <> 'DRAFT'
     AND EXISTS (SELECT 1
                   FROM invoice_line_time_entry h
                   JOIN time_entry e ON e.tenant_id = h.tenant_id AND e.id = h.time_entry_id
                  WHERE h.tenant_id = NEW.tenant_id AND h.invoice_id = NEW.id
                    AND e.invoice_line_id IS DISTINCT FROM h.invoice_line_id) THEN
    RAISE EXCEPTION 'INVOICE_HOURS_MISMATCH: the hours this invoice records are not all on it';
  END IF;
  RETURN NEW;
END
$fn$;

-- Named to sort BEFORE `invoice_guard` (same timing fires in name order), so
-- it refuses before the number is taken.
CREATE TRIGGER invoice_billed_hours_guard
  BEFORE UPDATE OF status, currency ON invoice
  FOR EACH ROW EXECUTE FUNCTION invoice_billed_hours_guard();


-- ── Grants (deny-default, explicit per table) ───────────────────────
-- A line's record of hours is written and read; never changed, never
-- deleted by the app (its line's cascade runs as the table's owner).
GRANT SELECT, INSERT ON invoice_line_time_entry TO app_runtime;
-- app_platform already covers new tables via ALTER DEFAULT PRIVILEGES.

-- ── RLS: invoice_line_time_entry — class A (portal_deny) ─────────────
ALTER TABLE invoice_line_time_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_time_entry FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON invoice_line_time_entry
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON invoice_line_time_entry
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');
