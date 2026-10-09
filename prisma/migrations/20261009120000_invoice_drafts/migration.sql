-- ═══════════════════════════════════════════════════════════════════
-- Phase 4 slice 107 — THE WORKSPACE'S INVOICE DETAILS AND INVOICE DRAFTS
-- (founder decision C75, 2026-10-09: CP5 and C19 answered, the build order
-- "invoices first", (h) and (i) below). DATA_MODEL.md §6.7, §9; PLAN Phase 4.
--
-- TWO TABLES, `invoice` and `invoice_line`, both CLASS A (`portal_deny`) for
-- now: no client reads an invoice until slice 109 builds the portal's view,
-- which reclasses both to class B with a status gate — the line carries
-- `client_id` (composite-FK-bound to its invoice's) so that reclass needs no
-- backfill through the frozen rows (the design review's medium).
--
-- AN INVOICE IS A DRAFT UNTIL IT IS ISSUED, THEN NEVER CHANGES. A draft has
-- no number, is edited freely by a member and may be deleted. Issuing (slice
-- 108 builds the path; this guard already holds its generic rules) gives it a
-- number, its dates and its totals, and from then on:
--   - its content never changes — `to_jsonb(NEW) - <mutable>` must equal
--     `to_jsonb(OLD) - <mutable>`, the mutable list being `status` and
--     `updated_at` now (slice 109 widens it by CREATE OR REPLACE). A column a
--     later migration adds is FROZEN BY DEFAULT on an issued row;
--   - its status moves only forward: ISSUED → SENT | PAID | CREDITED,
--     SENT → PAID | CREDITED, PAID → CREDITED (an invoice may be sent outside
--     the app, so ISSUED → PAID is allowed — the review's low). Never back
--     to DRAFT;
--   - it is never deleted (corrections are credit notes, slice 108), except
--     under `app.invoice_maintenance` AND the platform role (`current_user =
--     'app_platform'` — test teardown and the harness's `removeTenant`; the
--     application's runtime role can never delete an issued invoice, even
--     with the GUC set);
--   - its lines are never written, added or removed.
--
-- LEAVING DRAFT (the issue's generic rules, the review's medium): only to
-- ISSUED; by a MEMBER as themselves (`issued_by_member_id` = the principal),
-- ACTIVE and holding `invoice:issue` through a role, read as
-- `effectivePermissions` reads it (credential_ask's join); issued "now"
-- (±5 minutes of the statement); with at least one line; every line's VAT
-- rate allowed for the invoice's VAT treatment AT THAT MOMENT (a treatment
-- changed after the lines were written is caught here); and the totals equal
-- to what the lines say — the subtotal their sum, the VAT once per rate on
-- that rate's sum (EN 16931 BR-CO-17), multiplied by 0.01 rather than divided
-- by 100 (a numeric division keeps ~16 significant digits, so a large sum
-- divided could be rounded twice before `round`), the total their sum; a
-- total never below zero. The database is the last word on what an issued
-- invoice says.
--
-- WHAT NEVER CHANGES IN ANY STATE: the invoice's id, tenant, client, kind,
-- the invoice it credits, who made it and when. A draft's project may change,
-- always to a project of the same client.
--
-- THE LINE GUARD reads its invoice `FOR SHARE`: a line written while the
-- invoice is being issued either commits before the issue reads the lines,
-- or waits for the issue to commit and then sees ISSUED and is refused.
-- LOCK ORDER: every writer takes the INVOICE before its lines (the services
-- lock the invoice `FOR UPDATE` first; a line UPDATE/DELETE locks the line
-- tuple and then this guard takes the invoice — compatible with the writer's
-- own lock). A writer that touched lines without locking the invoice first
-- could deadlock against one that did (the review's low): do not write one.
-- The race's guarantee is READ COMMITTED's — each statement in the guard
-- reads a fresh snapshot after its lock — which is what `withTenant` runs
-- (it sets no isolation level). Under REPEATABLE READ the issue's line read
-- would use the transaction's first snapshot; never issue in one.
--
-- FOR THE NEXT SLICES (the migration review's nits): a CREDIT NOTE (108) is
-- written as a DRAFT and issued like an invoice — the line guard refuses
-- lines on anything but a draft — so 108 widens the INSERT branch (kind
-- CREDIT_NOTE) and, if its lines are negative, the "total never below zero"
-- rule; both are function changes. Issuing must also set `issue_date` to
-- today and `due_date` to it plus the payment terms (checked below). The
-- line guard lets any non-contact principal write a draft's lines (the
-- invoice guard is what keeps drafts a member's). A future owner-run
-- backfill that UPDATEs `invoice` is refused by the guard (no principal on a
-- draft, frozen issued rows): it must `ALTER TABLE invoice DISABLE TRIGGER
-- invoice_guard` inside its own transaction and say why.
--
-- MONEY: a line's amount is quantity × unit price rounded to the öre, half
-- away from zero — Postgres's `round`, and `src/modules/invoicing/money.ts`'s
-- BigInt arithmetic, which must agree (CHECK `invoice_line_amount`). No
-- per-line discount percentage: a negative line is a discount.
--
-- THE WORKSPACE'S PAYMENT DETAILS (C75 (h), (i)): Bankgiro, PlusGiro, IBAN,
-- BIC (existing `tenant` columns, envelope-encrypted by the app) and the NEW
-- `tenant.invoice_footer_note`, the note printed on every invoice. The app
-- asks a fresh second factor and mails every owner; THIS migration adds the
-- database's backstop (the review's low): on the application's runtime role,
-- a change to any of the five needs a MEMBER principal, active, holding
-- `settings:edit` through a role. (The second factor cannot be checked here.)
-- The platform and owner roles — support scripts, test fixtures — are not
-- judged.
--
-- DDL only, no DML — no `neon-smoke.yml` dispatch owed.
-- ═══════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "invoice_kind" AS ENUM ('INVOICE', 'CREDIT_NOTE');

-- CreateEnum
CREATE TYPE "invoice_status" AS ENUM ('DRAFT', 'ISSUED', 'SENT', 'PAID', 'CREDITED');

-- AlterTable
ALTER TABLE "tenant" ADD COLUMN "invoice_footer_note" TEXT;

-- CreateTable
CREATE TABLE "invoice" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "project_id" TEXT,
    "kind" "invoice_kind" NOT NULL DEFAULT 'INVOICE',
    "credits_invoice_id" TEXT,
    "status" "invoice_status" NOT NULL DEFAULT 'DRAFT',
    "series_id" TEXT,
    "number" INTEGER,
    "display_number" TEXT,
    "vat_profile" "VatProfile" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "payment_terms_days" INTEGER NOT NULL,
    "period_start" DATE,
    "period_end" DATE,
    "buyer_reference" TEXT,
    "our_reference" TEXT,
    "note" TEXT,
    "issue_date" DATE,
    "due_date" DATE,
    "issued_at" TIMESTAMPTZ(6),
    "issued_by_member_id" TEXT,
    "subtotal_ex_vat" DECIMAL(16,2),
    "vat_total" DECIMAL(16,2),
    "total" DECIMAL(16,2),
    "created_by_member_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_line" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit" TEXT,
    "unit_price_ex_vat" DECIMAL(14,2) NOT NULL,
    "vat_rate_pct" DECIMAL(5,2) NOT NULL,
    "amount_ex_vat" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invoice_line_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoice_tenant_id_id_key" ON "invoice"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_tenant_id_client_id_id_key" ON "invoice"("tenant_id", "client_id", "id");

-- CreateIndex — the gap-free series' backstop (slice 108); NULL numbers (drafts) are distinct.
CREATE UNIQUE INDEX "invoice_tenant_id_series_id_number_key" ON "invoice"("tenant_id", "series_id", "number");

-- CreateIndex
CREATE INDEX "invoice_tenant_id_client_id_status_idx" ON "invoice"("tenant_id", "client_id", "status");

-- CreateIndex
CREATE INDEX "invoice_tenant_id_status_created_at_idx" ON "invoice"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "invoice_tenant_id_project_id_idx" ON "invoice"("tenant_id", "project_id");

-- CreateIndex
CREATE INDEX "invoice_tenant_id_credits_invoice_id_idx" ON "invoice"("tenant_id", "credits_invoice_id");

-- CreateIndex — the composite-FK target for `time_entry.invoice_line_id` (slice 4 of C75 (f)).
CREATE UNIQUE INDEX "invoice_line_tenant_id_id_key" ON "invoice_line"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_line_tenant_id_invoice_id_position_key" ON "invoice_line"("tenant_id", "invoice_id", "position");

-- CreateIndex — the FK's own index (a draft's cascade delete).
CREATE INDEX "invoice_line_tenant_id_client_id_invoice_id_idx" ON "invoice_line"("tenant_id", "client_id", "invoice_id");

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey — clients and projects are archived, never deleted; an invoice holds its own.
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey — composite, so a credit note can never name another
-- tenant's invoice (an FK check bypasses RLS) nor another CLIENT's (the
-- migration review's low); NO ACTION, checked at the end of the statement,
-- so a teardown deleting a credit note and its invoice in one statement is
-- not refused row by row (the design review's low).
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_tenant_id_client_id_credits_invoice_id_fkey" FOREIGN KEY ("tenant_id", "client_id", "credits_invoice_id") REFERENCES "invoice"("tenant_id", "client_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey — the line's client IS its invoice's.
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_tenant_id_client_id_invoice_id_fkey" FOREIGN KEY ("tenant_id", "client_id", "invoice_id") REFERENCES "invoice"("tenant_id", "client_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── CHECKs — the rows' own shapes ───────────────────────────────────
ALTER TABLE "tenant"
  ADD CONSTRAINT tenant_invoice_footer_note_length
    CHECK (invoice_footer_note IS NULL
           OR (char_length(invoice_footer_note) BETWEEN 1 AND 500 AND invoice_footer_note ~ '[^[:space:]]'));

ALTER TABLE invoice
  ADD CONSTRAINT invoice_currency_shape CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT invoice_payment_terms CHECK (payment_terms_days BETWEEN 0 AND 120),
  ADD CONSTRAINT invoice_period CHECK (period_start IS NULL OR period_end IS NULL OR period_start <= period_end),
  ADD CONSTRAINT invoice_text_lengths
    CHECK (    (buyer_reference IS NULL OR (char_length(buyer_reference) BETWEEN 1 AND 100 AND buyer_reference ~ '[^[:space:]]'))
           AND (our_reference IS NULL OR (char_length(our_reference) BETWEEN 1 AND 100 AND our_reference ~ '[^[:space:]]'))
           AND (note IS NULL OR (char_length(note) BETWEEN 1 AND 1000 AND note ~ '[^[:space:]]'))
           AND (display_number IS NULL OR char_length(display_number) BETWEEN 1 AND 40)),
  ADD CONSTRAINT invoice_id_lengths
    CHECK (    char_length(created_by_member_id) BETWEEN 1 AND 64
           AND (issued_by_member_id IS NULL OR char_length(issued_by_member_id) BETWEEN 1 AND 64)
           AND (series_id IS NULL OR char_length(series_id) BETWEEN 1 AND 64)),
  -- A draft has none of an issued invoice's facts; an issued one has all of
  -- them. (`series_id` is not paired: a draft may pre-select its series.)
  ADD CONSTRAINT invoice_issued_facts
    CHECK (CASE WHEN status = 'DRAFT'
                THEN num_nonnulls(number, display_number, issue_date, due_date, issued_at, issued_by_member_id,
                                  subtotal_ex_vat, vat_total, total) = 0
                ELSE num_nulls(number, display_number, issue_date, due_date, issued_at, issued_by_member_id,
                               subtotal_ex_vat, vat_total, total, series_id) = 0
           END),
  ADD CONSTRAINT invoice_number_positive CHECK (number IS NULL OR number > 0),
  ADD CONSTRAINT invoice_due_after_issue CHECK (due_date IS NULL OR issue_date IS NULL OR due_date >= issue_date),
  -- A credit note names the invoice it credits; an invoice names none.
  ADD CONSTRAINT invoice_credit_pair
    CHECK ((kind = 'CREDIT_NOTE') = (credits_invoice_id IS NOT NULL) AND credits_invoice_id IS DISTINCT FROM id);

ALTER TABLE invoice_line
  -- 0 is the swap's transient slot (a move passes through it in one
  -- transaction — the unique on position is checked per row).
  ADD CONSTRAINT invoice_line_position CHECK (position BETWEEN 0 AND 10000),
  ADD CONSTRAINT invoice_line_description
    CHECK (char_length(description) BETWEEN 1 AND 2000 AND description ~ '[^[:space:]]'),
  ADD CONSTRAINT invoice_line_unit
    CHECK (unit IS NULL OR (char_length(unit) BETWEEN 1 AND 20 AND unit ~ '[^[:space:]]')),
  ADD CONSTRAINT invoice_line_quantity_positive CHECK (quantity > 0),
  -- A numeric column accepts 'NaN', and Postgres reads NaN > 0 and NaN = NaN
  -- as true, so without this a NaN line would pass every other CHECK and an
  -- issued invoice could total NaN (the migration review's low).
  ADD CONSTRAINT invoice_line_finite CHECK (quantity <> 'NaN' AND unit_price_ex_vat <> 'NaN'),
  ADD CONSTRAINT invoice_line_vat_rate CHECK (vat_rate_pct IN (0, 6, 12, 25)),
  -- The app's BigInt arithmetic restated: quantity × price, to the öre,
  -- half away from zero. A multiplication — exact in numeric.
  ADD CONSTRAINT invoice_line_amount CHECK (amount_ex_vat = round(quantity * unit_price_ex_vat, 2));


-- ── The rates each VAT treatment allows (`src/modules/invoicing/vat.ts`'s
--    VAT_RATES, restated — change both together) ─────────────────────
CREATE OR REPLACE FUNCTION invoice_rate_allowed(profile "VatProfile", rate numeric) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT CASE profile
           WHEN 'SE_DOMESTIC' THEN rate IN (25, 12, 6)
           ELSE rate = 0
         END
$fn$;


-- ── The invoice's guard ─────────────────────────────────────────────
-- SECURITY INVOKER (the default): it reads the transaction's GUCs and the
-- member's, project's and lines' rows under the writer's own RLS, which for a
-- member of this tenant admits this tenant's rows.
CREATE OR REPLACE FUNCTION invoice_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  who text := current_setting('app.principal', true);
  who_id text := current_setting('app.principal_id', true);
  at timestamptz := statement_timestamp();
  slack constant interval := interval '5 minutes';
  maintenance boolean := current_setting('app.invoice_maintenance', true) = 'on' AND current_user = 'app_platform';
  -- What an ISSUED invoice may still change. Slice 109 widens this list.
  mutable constant text[] := ARRAY['status', 'updated_at'];
  line_count int;
  sub numeric;
  vat numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'DRAFT' OR maintenance THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'INVOICE_NOT_DRAFT: an issued invoice is never deleted — it is credited';
  END IF;

  -- Class A already gives a contact nothing to write; the guard says so too.
  IF who = 'contact' THEN
    RAISE EXCEPTION 'INVOICE_GUARD: a contact writes no invoice';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A DRAFT, made now by a member as themselves. (Credit notes are slice
    -- 108's, and widen this.)
    IF who IS DISTINCT FROM 'member' OR NEW.created_by_member_id IS DISTINCT FROM who_id THEN
      RAISE EXCEPTION 'INVOICE_GUARD: a member makes a draft, as themselves';
    END IF;
    IF NEW.status <> 'DRAFT' OR NEW.kind <> 'INVOICE' THEN
      RAISE EXCEPTION 'INVOICE_GUARD: a new invoice is a draft';
    END IF;
    IF NEW.created_at < at - slack OR NEW.created_at > at + slack THEN
      RAISE EXCEPTION 'INVOICE_GUARD: a draft is made now';
    END IF;
    IF NEW.project_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM project p
                        WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.project_id AND p.client_id = NEW.client_id) THEN
      RAISE EXCEPTION 'INVOICE_GUARD: a project of the invoice''s client';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE. What never changes, in any state.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.credits_invoice_id IS DISTINCT FROM OLD.credits_invoice_id
     OR NEW.created_by_member_id IS DISTINCT FROM OLD.created_by_member_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'INVOICE_GUARD: an invoice keeps its client, its kind and its origin';
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' THEN
    -- A draft is a member's to edit; its project stays its client's.
    IF who IS DISTINCT FROM 'member' THEN
      RAISE EXCEPTION 'INVOICE_GUARD: a member edits a draft';
    END IF;
    IF NEW.project_id IS NOT NULL AND NEW.project_id IS DISTINCT FROM OLD.project_id
       AND NOT EXISTS (SELECT 1 FROM project p
                        WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.project_id AND p.client_id = NEW.client_id) THEN
      RAISE EXCEPTION 'INVOICE_GUARD: a project of the invoice''s client';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'DRAFT' THEN
    -- LEAVING DRAFT: only to ISSUED, by a member as themselves who may issue.
    IF NEW.status <> 'ISSUED' THEN
      RAISE EXCEPTION 'INVOICE_GUARD: a draft is issued, never anything else';
    END IF;
    IF who IS DISTINCT FROM 'member' OR NEW.issued_by_member_id IS DISTINCT FROM who_id THEN
      RAISE EXCEPTION 'INVOICE_GUARD: a member issues an invoice, as themselves';
    END IF;
    IF NOT EXISTS (SELECT 1
                     FROM member m
                     JOIN member_role mr ON mr.tenant_id = m.tenant_id AND mr.member_id = m.id
                     JOIN role_permission rp ON rp.tenant_id = mr.tenant_id AND rp.role_id = mr.role_id
                     JOIN permission p ON p.id = rp.permission_id
                    WHERE m.tenant_id = NEW.tenant_id AND m.id = who_id AND m.status = 'ACTIVE'
                      AND rp.source <> 'TENANT_REVOKE' AND p.code = 'invoice:issue') THEN
      RAISE EXCEPTION 'INVOICE_GUARD: only a member who may issue invoices issues one';
    END IF;
    IF NEW.issued_at < at - slack OR NEW.issued_at > at + slack THEN
      RAISE EXCEPTION 'INVOICE_GUARD: an invoice is issued now';
    END IF;
    -- Its date is today wherever the workspace is (a day either side of
    -- the UTC date covers every zone), and it falls due its payment terms
    -- later — never backdated, never a due date of its own (the migration
    -- review's low: an issued row is frozen for good, so this is the one
    -- moment to hold it).
    IF NEW.issue_date < (statement_timestamp() AT TIME ZONE 'UTC')::date - 1
       OR NEW.issue_date > (statement_timestamp() AT TIME ZONE 'UTC')::date + 1 THEN
      RAISE EXCEPTION 'INVOICE_GUARD: an invoice is dated the day it is issued';
    END IF;
    IF NEW.due_date IS DISTINCT FROM NEW.issue_date + NEW.payment_terms_days THEN
      RAISE EXCEPTION 'INVOICE_GUARD: an invoice falls due its payment terms after its date';
    END IF;
    IF NEW.project_id IS NOT NULL AND NEW.project_id IS DISTINCT FROM OLD.project_id
       AND NOT EXISTS (SELECT 1 FROM project p
                        WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.project_id AND p.client_id = NEW.client_id) THEN
      RAISE EXCEPTION 'INVOICE_GUARD: a project of the invoice''s client';
    END IF;
    SELECT count(*), coalesce(sum(l.amount_ex_vat), 0)
      INTO line_count, sub
      FROM invoice_line l
     WHERE l.tenant_id = NEW.tenant_id AND l.invoice_id = NEW.id;
    IF line_count = 0 THEN
      RAISE EXCEPTION 'INVOICE_GUARD: an issued invoice has at least one line';
    END IF;
    IF EXISTS (SELECT 1 FROM invoice_line l
                WHERE l.tenant_id = NEW.tenant_id AND l.invoice_id = NEW.id
                  AND NOT invoice_rate_allowed(NEW.vat_profile, l.vat_rate_pct)) THEN
      RAISE EXCEPTION 'INVOICE_RATE_NOT_ALLOWED: a line''s VAT rate does not fit the invoice''s VAT treatment';
    END IF;
    SELECT coalesce(sum(round(g.net * g.rate * 0.01, 2)), 0)
      INTO vat
      FROM (SELECT l.vat_rate_pct AS rate, sum(l.amount_ex_vat) AS net
              FROM invoice_line l
             WHERE l.tenant_id = NEW.tenant_id AND l.invoice_id = NEW.id
             GROUP BY l.vat_rate_pct) g;
    IF NEW.subtotal_ex_vat IS DISTINCT FROM sub
       OR NEW.vat_total IS DISTINCT FROM vat
       OR NEW.total IS DISTINCT FROM sub + vat THEN
      RAISE EXCEPTION 'INVOICE_GUARD: an issued invoice''s totals are what its lines say';
    END IF;
    IF NEW.total < 0 THEN
      RAISE EXCEPTION 'INVOICE_GUARD: an invoice''s total is never below zero';
    END IF;
    RETURN NEW;
  END IF;

  -- AN ISSUED INVOICE: its content never changes, and its status moves forward.
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'INVOICE_NOT_DRAFT: an issued invoice never changes';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (   (OLD.status = 'ISSUED' AND NEW.status IN ('SENT', 'PAID', 'CREDITED'))
              OR (OLD.status = 'SENT' AND NEW.status IN ('PAID', 'CREDITED'))
              OR (OLD.status = 'PAID' AND NEW.status = 'CREDITED')) THEN
    RAISE EXCEPTION 'INVOICE_GUARD: an issued invoice''s status only moves forward';
  END IF;
  -- Moving an issued invoice on is a member's act, as themselves, holding the
  -- code for that step (the migration review's low): sent — `invoice:send`;
  -- paid — `invoice:record_payment`; credited — `invoice:credit`. Whether a
  -- payment can be taken back is slice 109's to decide (a function change).
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF who IS DISTINCT FROM 'member' THEN
      RAISE EXCEPTION 'INVOICE_GUARD: a member moves an issued invoice on';
    END IF;
    IF NOT EXISTS (SELECT 1
                     FROM member m
                     JOIN member_role mr ON mr.tenant_id = m.tenant_id AND mr.member_id = m.id
                     JOIN role_permission rp ON rp.tenant_id = mr.tenant_id AND rp.role_id = mr.role_id
                     JOIN permission p ON p.id = rp.permission_id
                    WHERE m.tenant_id = NEW.tenant_id AND m.id = who_id AND m.status = 'ACTIVE'
                      AND rp.source <> 'TENANT_REVOKE'
                      AND p.code = CASE NEW.status
                                     WHEN 'SENT' THEN 'invoice:send'
                                     WHEN 'PAID' THEN 'invoice:record_payment'
                                     ELSE 'invoice:credit'
                                   END) THEN
      RAISE EXCEPTION 'INVOICE_GUARD: only a member who may take that step moves an issued invoice on';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER invoice_guard
  BEFORE INSERT OR UPDATE OR DELETE ON invoice
  FOR EACH ROW EXECUTE FUNCTION invoice_guard();


-- ── The line's guard ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION invoice_line_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  row_tenant text;
  row_invoice text;
  parent_status invoice_status;
  parent_profile "VatProfile";
BEGIN
  IF current_setting('app.principal', true) = 'contact' THEN
    RAISE EXCEPTION 'INVOICE_GUARD: a contact writes no invoice line';
  END IF;

  IF TG_OP = 'DELETE' THEN
    row_tenant := OLD.tenant_id;
    row_invoice := OLD.invoice_id;
  ELSE
    row_tenant := NEW.tenant_id;
    row_invoice := NEW.invoice_id;
  END IF;

  IF TG_OP = 'UPDATE'
     AND (   NEW.id IS DISTINCT FROM OLD.id
          OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
          OR NEW.client_id IS DISTINCT FROM OLD.client_id
          OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
          OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'INVOICE_GUARD: a line stays on its invoice';
  END IF;

  -- The invoice, held: an issue waits for this write, or this write for it.
  SELECT i.status, i.vat_profile
    INTO parent_status, parent_profile
    FROM invoice i
   WHERE i.tenant_id = row_tenant AND i.id = row_invoice
     FOR SHARE;
  IF NOT FOUND THEN
    -- A DELETE whose invoice is already gone is that invoice's own cascade (a
    -- draft deleted, or teardown under maintenance) — confirmed by the
    -- trigger depth AND an unlocked read, never by the locked read alone: a
    -- `FOR SHARE` consults UPDATE policies, and a row one of them withheld
    -- would read as gone (the review's low).
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1
       AND NOT EXISTS (SELECT 1 FROM invoice i WHERE i.tenant_id = row_tenant AND i.id = row_invoice) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'INVOICE_GUARD: a line belongs to an invoice';
  END IF;

  IF parent_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'INVOICE_NOT_DRAFT: an issued invoice''s lines never change';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NOT invoice_rate_allowed(parent_profile, NEW.vat_rate_pct) THEN
    RAISE EXCEPTION 'INVOICE_RATE_NOT_ALLOWED: the rate does not fit the invoice''s VAT treatment';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER invoice_line_guard
  BEFORE INSERT OR UPDATE OR DELETE ON invoice_line
  FOR EACH ROW EXECUTE FUNCTION invoice_line_guard();


-- ── The workspace's payment details: the database's backstop ────────
-- (C75 (h), (i).) Only the application's runtime role is judged: there a
-- change to a bank column or the invoice note needs an ACTIVE member, as the
-- principal, holding `settings:edit` through a role. The fresh second factor
-- and the owners' mail are the application's (`src/modules/invoicing/
-- seller.ts`); this keeps any OTHER code path in the app from rewriting where
-- clients pay.
CREATE OR REPLACE FUNCTION tenant_payment_details_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  who text := current_setting('app.principal', true);
  who_id text := current_setting('app.principal_id', true);
BEGIN
  IF  NEW.bankgiro IS NOT DISTINCT FROM OLD.bankgiro
  AND NEW.plusgiro IS NOT DISTINCT FROM OLD.plusgiro
  AND NEW.iban IS NOT DISTINCT FROM OLD.iban
  AND NEW.bic IS NOT DISTINCT FROM OLD.bic
  AND NEW.invoice_footer_note IS NOT DISTINCT FROM OLD.invoice_footer_note THEN
    RETURN NEW;
  END IF;
  IF current_user IS DISTINCT FROM 'app_runtime' THEN
    RETURN NEW;
  END IF;
  IF who IS DISTINCT FROM 'member'
     OR NOT EXISTS (SELECT 1
                      FROM member m
                      JOIN member_role mr ON mr.tenant_id = m.tenant_id AND mr.member_id = m.id
                      JOIN role_permission rp ON rp.tenant_id = mr.tenant_id AND rp.role_id = mr.role_id
                      JOIN permission p ON p.id = rp.permission_id
                     WHERE m.tenant_id = NEW.id AND m.id = who_id AND m.status = 'ACTIVE'
                       AND rp.source <> 'TENANT_REVOKE' AND p.code = 'settings:edit') THEN
    RAISE EXCEPTION 'TENANT_PAYMENT_GUARD: only a member who may edit the workspace''s settings changes where clients pay';
  END IF;
  RETURN NEW;
END
$fn$;
-- Every UPDATE, not `UPDATE OF <the five>`: a column list does not fire when
-- an earlier BEFORE trigger is what changed the value (the migration review's
-- low); the function answers at once when none of the five changed.
CREATE TRIGGER tenant_payment_details_guard
  BEFORE UPDATE ON tenant
  FOR EACH ROW EXECUTE FUNCTION tenant_payment_details_guard();


-- ── Grants (deny-default, explicit per table) ───────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON invoice, invoice_line TO app_runtime;
-- app_platform already covers new tables via ALTER DEFAULT PRIVILEGES.

-- ── RLS — class A (portal_deny) ─────────────────────────────────────
ALTER TABLE invoice ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON invoice
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON invoice
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

ALTER TABLE invoice_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON invoice_line
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON invoice_line
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');
