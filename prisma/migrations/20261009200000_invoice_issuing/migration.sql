-- ═══════════════════════════════════════════════════════════════════
-- Phase 4 slice 108 — ISSUING AN INVOICE (founder decision C76, 2026-10-09:
-- (a) plain numbers that never restart, (b) a first number the workspace
-- sets before its first invoice, (c) credit notes from the same series,
-- (e) the invoice's language). DATA_MODEL.md §6.7, §9; PLAN Phase 4.
--
-- ONE NUMBER SERIES PER WORKSPACE — `invoice_series`, class A. Its
-- `next_number` is a counter ROW, never a SEQUENCE: a sequence is not
-- transactional, so a rolled-back issue would burn a number and break the
-- series Skatteverket expects unbroken (ställningstagande 2023-06-26).
--
-- THE DATABASE ALLOCATES THE NUMBER. `invoice_guard`'s leaving-DRAFT branch,
-- as its LAST step, increments the series row and writes the number into the
-- invoice it is issuing — whatever the app sent is overwritten. The increment
-- is the only change `invoice_series_guard` accepts from inside another
-- trigger (`pg_trigger_depth() > 1`: no application statement runs at that
-- depth); from the application it accepts only setting the first number, by a
-- member holding `invoice:manage_series`, while no invoice holds a number
-- from the series. So a number exists only on an issued invoice, which is
-- never deleted (107), and the series has no gaps and no repeats:
--   - a refused or rolled-back issue rolls the counter back with it;
--   - concurrent issues serialise on the series row (READ COMMITTED's UPDATE
--     re-reads the committed row after the wait); every issuer locks its
--     invoice FIRST (`lockDraft`), then the guard takes the series — and
--     nothing takes them the other way round, so no deadlock;
--   - the unique (tenant_id, series_id, number) from 107 is the backstop.
--
-- THE GUARD ALSO WRITES WHAT THE INVOICE SAYS ABOUT ITS PARTIES — the seller
-- (from the tenant row), the bank details (the tenant's v2 CIPHERTEXTS,
-- copied verbatim: still decryptable under the tenant row's AAD; the
-- database cannot read them and the application cannot forge them) and the
-- buyer (from the client row). The company and bank details are protected by
-- a code typed in the form, a mail to every owner and a backstop (C75 (h)–(j));
-- a snapshot the application assembled would be a way round all three. Before
-- it builds them it requires what an invoice must carry: the seller's legal
-- name, org. number, VAT number, address and a way to pay (and the registered
-- office of an aktiebolag, ABL 28 kap. 5 §); the buyer's name and address, a
-- country when the sale is not domestic, and a VAT number on a reverse charge.
--
-- VAT IN SEK (mervärdesskattelagen 2023:200): an invoice in another currency
-- that carries VAT states it in SEK too, at the European Central Bank's rate
-- (`src/modules/invoicing/fx.ts`). The rate, its date and the SEK VAT are set
-- together or not at all; the SEK VAT is each rate's VAT × the rate, rounded
-- to the öre, summed — recomputed here. The rate's date is the ECB file's,
-- at most ten days before the invoice date (the ECB publishes on TARGET
-- days; Easter is a four-day gap).
--
-- AN ISSUED INVOICE'S PDF is made after the issue commits and recorded ONCE
-- (`pdf_file_id` — a committed INVOICE_PDF file of the tenant); the issued
-- row's mutable list becomes {status, updated_at, pdf_file_id}.
--
-- DDL only, no DML — no `neon-smoke.yml` dispatch owed.
-- ═══════════════════════════════════════════════════════════════════

-- CreateTable
CREATE TABLE "invoice_series" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "first_number" INTEGER NOT NULL,
    "next_number" INTEGER NOT NULL,
    "created_by_member_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invoice_series_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — ONE series per workspace (C76 (a)–(c)); dropped the day a second is wanted.
CREATE UNIQUE INDEX "invoice_series_tenant_id_key" ON "invoice_series"("tenant_id");

-- CreateIndex — the composite-FK target.
CREATE UNIQUE INDEX "invoice_series_tenant_id_id_key" ON "invoice_series"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "invoice_series" ADD CONSTRAINT "invoice_series_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "invoice" ADD COLUMN "locale" TEXT,
ADD COLUMN "seller_snapshot" JSONB,
ADD COLUMN "payment_snapshot" JSONB,
ADD COLUMN "buyer_snapshot" JSONB,
ADD COLUMN "fx_rate_to_sek" DECIMAL(12,6),
ADD COLUMN "fx_rate_date" DATE,
ADD COLUMN "vat_total_sek" DECIMAL(16,2),
ADD COLUMN "pdf_file_id" TEXT;

-- CreateIndex — one PDF belongs to one invoice.
CREATE UNIQUE INDEX "invoice_tenant_id_pdf_file_id_key" ON "invoice"("tenant_id", "pdf_file_id");

-- AddForeignKey — 107 left `series_id` without one on purpose (no table yet).
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_tenant_id_series_id_fkey" FOREIGN KEY ("tenant_id", "series_id") REFERENCES "invoice_series"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey — the archived rendering (R1): its file is never deleted while the invoice stands.
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_tenant_id_pdf_file_id_fkey" FOREIGN KEY ("tenant_id", "pdf_file_id") REFERENCES "file_object"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── CHECKs ──────────────────────────────────────────────────────────
ALTER TABLE invoice_series
  ADD CONSTRAINT invoice_series_numbers
    CHECK (first_number BETWEEN 1 AND 999999999 AND next_number BETWEEN first_number AND 1000000000),
  ADD CONSTRAINT invoice_series_id_lengths
    CHECK (char_length(created_by_member_id) BETWEEN 1 AND 64);

ALTER TABLE invoice
  ADD CONSTRAINT invoice_locale CHECK (locale IS NULL OR locale IN ('sv', 'en')),
  -- A draft has none of what issuing writes (its language may be chosen);
  -- an issued invoice has its snapshots and its language.
  ADD CONSTRAINT invoice_issued_record
    CHECK (CASE WHEN status = 'DRAFT'
                THEN num_nonnulls(seller_snapshot, payment_snapshot, buyer_snapshot,
                                  fx_rate_to_sek, fx_rate_date, vat_total_sek, pdf_file_id) = 0
                ELSE num_nulls(seller_snapshot, payment_snapshot, buyer_snapshot, locale) = 0
           END),
  ADD CONSTRAINT invoice_snapshot_shapes
    CHECK (    (seller_snapshot IS NULL OR jsonb_typeof(seller_snapshot) = 'object')
           AND (payment_snapshot IS NULL OR jsonb_typeof(payment_snapshot) = 'object')
           AND (buyer_snapshot IS NULL OR jsonb_typeof(buyer_snapshot) = 'object')),
  -- The rate, its date and the SEK VAT: all or none; a rate is positive and
  -- never NaN (a numeric accepts 'NaN' and Postgres reads NaN > 0 as true).
  ADD CONSTRAINT invoice_sek_vat
    CHECK (    num_nonnulls(fx_rate_to_sek, fx_rate_date, vat_total_sek) IN (0, 3)
           AND (fx_rate_to_sek IS NULL OR (fx_rate_to_sek <> 'NaN' AND fx_rate_to_sek > 0))
           AND (vat_total_sek IS NULL OR vat_total_sek <> 'NaN')),
  ADD CONSTRAINT invoice_pdf_id_length CHECK (pdf_file_id IS NULL OR char_length(pdf_file_id) BETWEEN 1 AND 64);


-- ── Does a member hold a permission? (`effectivePermissions`' join, 107's) ──
-- SECURITY INVOKER: it reads the member's rows under the writer's own RLS.
CREATE OR REPLACE FUNCTION invoice_member_holds(p_tenant text, p_member text, p_code text) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT EXISTS (SELECT 1
                   FROM member m
                   JOIN member_role mr ON mr.tenant_id = m.tenant_id AND mr.member_id = m.id
                   JOIN role_permission rp ON rp.tenant_id = mr.tenant_id AND rp.role_id = mr.role_id
                   JOIN permission p ON p.id = rp.permission_id
                  WHERE m.tenant_id = p_tenant AND m.id = p_member AND m.status = 'ACTIVE'
                    AND rp.source <> 'TENANT_REVOKE' AND p.code = p_code)
$fn$;


-- ── The series' guard ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION invoice_series_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  who text := current_setting('app.principal', true);
  who_id text := current_setting('app.principal_id', true);
  maintenance boolean := current_setting('app.invoice_maintenance', true) = 'on' AND current_user = 'app_platform';
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF maintenance THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'INVOICE_SERIES_GUARD: a numbering series is never deleted';
  END IF;

  IF who = 'contact' THEN
    RAISE EXCEPTION 'INVOICE_SERIES_GUARD: a contact writes no numbering series';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.next_number IS DISTINCT FROM NEW.first_number THEN
      RAISE EXCEPTION 'INVOICE_SERIES_GUARD: a new series starts at its first number';
    END IF;
    -- On the application's runtime role, a member who may set the numbering,
    -- as themselves. The platform and owner roles — the harness's fixture
    -- command, test setup — are not judged (`tenant_payment_details_guard`'s
    -- rule); they still start a series at its first number.
    IF current_user = 'app_runtime'
       AND (who IS DISTINCT FROM 'member' OR NEW.created_by_member_id IS DISTINCT FROM who_id
            OR NOT invoice_member_holds(NEW.tenant_id, who_id, 'invoice:manage_series')) THEN
      RAISE EXCEPTION 'INVOICE_SERIES_GUARD: only a member who may set the numbering makes a series, as themselves';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.created_by_member_id IS DISTINCT FROM OLD.created_by_member_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'INVOICE_SERIES_GUARD: a series keeps its workspace and its origin';
  END IF;
  IF NEW.first_number = OLD.first_number AND NEW.next_number = OLD.next_number THEN
    RETURN NEW;
  END IF;

  -- The issue guard's allocation: the one change made from inside another
  -- trigger, and exactly one step.
  IF pg_trigger_depth() > 1 THEN
    IF NEW.first_number = OLD.first_number AND NEW.next_number = OLD.next_number + 1 THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'INVOICE_SERIES_GUARD: an issue takes exactly the next number';
  END IF;

  -- Setting the first number, while nothing is numbered from the series:
  -- `next_number` still equals `first_number` exactly then, because the
  -- allocation above is the only thing that ever moves it past — no read of
  -- `invoice` needed, and true whatever a teardown deleted (the design
  -- review's low). OLD is the row as locked: an issue that got there first
  -- has moved it, one that came second waits for this.
  IF OLD.next_number IS DISTINCT FROM OLD.first_number THEN
    RAISE EXCEPTION 'INVOICE_SERIES_IN_USE: the first number is fixed once an invoice holds a number';
  END IF;
  IF NEW.next_number IS DISTINCT FROM NEW.first_number THEN
    RAISE EXCEPTION 'INVOICE_SERIES_GUARD: the numbering starts again at its first number';
  END IF;
  IF current_user = 'app_runtime'
     AND (who IS DISTINCT FROM 'member' OR NOT invoice_member_holds(NEW.tenant_id, who_id, 'invoice:manage_series')) THEN
    RAISE EXCEPTION 'INVOICE_SERIES_GUARD: only a member who may set the numbering changes it';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER invoice_series_guard
  BEFORE INSERT OR UPDATE OR DELETE ON invoice_series
  FOR EACH ROW EXECUTE FUNCTION invoice_series_guard();


-- ── The invoice's guard, replaced: issuing numbers, snapshots, SEK VAT, the PDF ──
-- Everything 107 held is held unchanged (its header is the reference); the
-- leaving-DRAFT branch gains steps 1–6 and 8, the issued branch the PDF.
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
  mutable constant text[] := ARRAY['status', 'updated_at', 'pdf_file_id'];
  line_count int;
  sub numeric;
  vat numeric;
  vat_sek numeric;
  allocated int;
  seller record;
  buyer record;
  buyer_found boolean;
  buyer_country text;
  -- The EU's member states by country code (`src/modules/invoicing/vat.ts`'s
  -- EU_COUNTRIES, restated — change both together; Greece's VAT prefix is EL).
  eu constant text[] := ARRAY['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
                              'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];
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
    -- 108b's, and widen this.)
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
    IF NOT invoice_member_holds(NEW.tenant_id, who_id, 'invoice:issue') THEN
      RAISE EXCEPTION 'INVOICE_GUARD: only a member who may issue invoices issues one';
    END IF;
    IF NEW.issued_at < at - slack OR NEW.issued_at > at + slack THEN
      RAISE EXCEPTION 'INVOICE_GUARD: an invoice is issued now';
    END IF;
    -- Its date is today wherever the workspace is (a day either side of
    -- the UTC date covers every zone), and it falls due its payment terms
    -- later — never backdated, never a due date of its own.
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

    -- (108) 1. A series to number it from (the FK proves it is this tenant's).
    IF NEW.series_id IS NULL THEN
      RAISE EXCEPTION 'INVOICE_NO_SERIES: set the first invoice number before issuing';
    END IF;

    -- (108) 2. The seller: what every invoice must say about it.
    SELECT t.legal_name, t.org_nr, t.vat_number, t.seat, t.f_skatt_approved,
           t.address_line1, t.address_line2, t.postal_code, t.city, t.country_code,
           t.invoice_footer_note, t.bankgiro, t.plusgiro, t.iban, t.bic
      INTO seller
      FROM tenant t
     WHERE t.id = NEW.tenant_id;
    IF NOT FOUND
       OR coalesce(seller.legal_name, '') !~ '[^[:space:]]'
       OR coalesce(seller.org_nr, '') !~ '[^[:space:]]'
       OR coalesce(seller.vat_number, '') !~ '[^[:space:]]'
       OR coalesce(seller.address_line1, '') !~ '[^[:space:]]'
       OR coalesce(seller.postal_code, '') !~ '[^[:space:]]'
       OR coalesce(seller.city, '') !~ '[^[:space:]]'
       OR num_nonnulls(nullif(seller.bankgiro, ''), nullif(seller.plusgiro, ''), nullif(seller.iban, '')) = 0
       -- An aktiebolag's registered office (ABL 28 kap. 5 §): the org.
       -- number's group digit 5 and a third digit of 2 or more, as
       -- `isAktiebolagOrgNr` reads it.
       OR (regexp_replace(seller.org_nr, '[^0-9]', '', 'g') ~ '^5[0-9][2-9]'
           AND coalesce(seller.seat, '') !~ '[^[:space:]]') THEN
      RAISE EXCEPTION 'INVOICE_SELLER_INCOMPLETE: the workspace''s invoice details are missing something an invoice must carry';
    END IF;

    -- (108) 3. The buyer. A blank country is no country (the migration
    -- review's nit: a CHAR(2) of spaces is not NULL, and the app reads it as
    -- missing).
    SELECT c.name, c.org_nr, c.vat_number, c.address_line1, c.address_line2, c.postal_code, c.city, c.country_code
      INTO buyer
      FROM client c
     WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.client_id;
    buyer_found := FOUND;
    buyer_country := nullif(upper(trim(buyer.country_code)), '');
    IF NOT buyer_found
       OR coalesce(buyer.name, '') !~ '[^[:space:]]'
       OR coalesce(buyer.address_line1, '') !~ '[^[:space:]]'
       OR coalesce(buyer.city, '') !~ '[^[:space:]]'
       OR (NEW.vat_profile <> 'SE_DOMESTIC' AND buyer_country IS NULL)
       OR (NEW.vat_profile = 'EU_REVERSE_CHARGE' AND coalesce(buyer.vat_number, '') !~ '[^[:space:]]') THEN
      RAISE EXCEPTION 'INVOICE_BUYER_INCOMPLETE: the client''s details are missing something an invoice must carry';
    END IF;
    -- The VAT treatment fits the buyer's country (the design review's low —
    -- not a VIES check, C76 (h)): a reverse charge is to a business in ANOTHER
    -- EU country whose VAT number carries that country's prefix; outside the
    -- scope is a buyer outside the EU.
    IF (NEW.vat_profile = 'EU_REVERSE_CHARGE'
        AND (NOT (buyer_country = ANY (eu)) OR buyer_country = 'SE'
             OR left(regexp_replace(upper(buyer.vat_number), '[^A-Z0-9]', '', 'g'), 2)
                IS DISTINCT FROM CASE buyer_country WHEN 'GR' THEN 'EL' ELSE buyer_country END))
       OR (NEW.vat_profile = 'OUTSIDE_SCOPE' AND buyer_country = ANY (eu)) THEN
      RAISE EXCEPTION 'INVOICE_BUYER_INCOMPLETE: the VAT treatment does not fit the client''s country';
    END IF;

    -- (108) 4. What the invoice says about its parties, written here and
    -- nowhere else (whatever the application sent is overwritten).
    NEW.seller_snapshot := jsonb_build_object(
      'legalName', seller.legal_name, 'orgNr', seller.org_nr, 'vatNumber', seller.vat_number,
      'seat', seller.seat, 'fSkattApproved', seller.f_skatt_approved,
      'addressLine1', seller.address_line1, 'addressLine2', seller.address_line2,
      'postalCode', seller.postal_code, 'city', seller.city, 'countryCode', seller.country_code,
      'footerNote', seller.invoice_footer_note);
    NEW.payment_snapshot := jsonb_build_object(
      'bankgiro', nullif(seller.bankgiro, ''), 'plusgiro', nullif(seller.plusgiro, ''),
      'iban', nullif(seller.iban, ''), 'bic', nullif(seller.bic, ''));
    NEW.buyer_snapshot := jsonb_build_object(
      'name', buyer.name, 'orgNr', buyer.org_nr, 'vatNumber', buyer.vat_number,
      'addressLine1', buyer.address_line1, 'addressLine2', buyer.address_line2,
      'postalCode', buyer.postal_code, 'city', buyer.city, 'countryCode', buyer.country_code);

    -- (108) 5. Its language, fixed now.
    IF NEW.locale IS NULL THEN
      RAISE EXCEPTION 'INVOICE_GUARD: an issued invoice has its language';
    END IF;

    -- (108) 6. VAT in SEK — on another currency carrying VAT, and only then.
    IF NEW.currency = 'SEK' OR vat = 0 THEN
      IF num_nonnulls(NEW.fx_rate_to_sek, NEW.fx_rate_date, NEW.vat_total_sek) <> 0 THEN
        RAISE EXCEPTION 'INVOICE_GUARD: VAT in SEK only on another currency carrying VAT';
      END IF;
    ELSE
      IF num_nulls(NEW.fx_rate_to_sek, NEW.fx_rate_date, NEW.vat_total_sek) <> 0 THEN
        RAISE EXCEPTION 'INVOICE_GUARD: an invoice in another currency states its VAT in SEK';
      END IF;
      IF NEW.fx_rate_date < NEW.issue_date - 10 OR NEW.fx_rate_date > NEW.issue_date THEN
        RAISE EXCEPTION 'INVOICE_GUARD: the exchange rate is the latest published';
      END IF;
      SELECT coalesce(sum(round(round(g.net * g.rate * 0.01, 2) * NEW.fx_rate_to_sek, 2)), 0)
        INTO vat_sek
        FROM (SELECT l.vat_rate_pct AS rate, sum(l.amount_ex_vat) AS net
                FROM invoice_line l
               WHERE l.tenant_id = NEW.tenant_id AND l.invoice_id = NEW.id
               GROUP BY l.vat_rate_pct) g;
      IF NEW.vat_total_sek IS DISTINCT FROM vat_sek THEN
        RAISE EXCEPTION 'INVOICE_GUARD: the VAT in SEK is each rate''s VAT at the rate, summed';
      END IF;
    END IF;

    -- (108) 7. No PDF yet: it is made from the issued record, after it commits.
    IF NEW.pdf_file_id IS NOT NULL THEN
      RAISE EXCEPTION 'INVOICE_GUARD: an invoice''s PDF is made after it is issued';
    END IF;

    -- (108) 8. LAST — the number: the series' next, taken under its row lock.
    -- Last, so a refusal above never holds the series.
    UPDATE invoice_series s
       SET next_number = s.next_number + 1,
           updated_at = statement_timestamp()
     WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.series_id
    RETURNING s.next_number - 1 INTO allocated;
    IF allocated IS NULL THEN
      RAISE EXCEPTION 'INVOICE_NO_SERIES: set the first invoice number before issuing';
    END IF;
    NEW.number := allocated;
    NEW.display_number := allocated::text;
    RETURN NEW;
  END IF;

  -- AN ISSUED INVOICE: its content never changes, and its status moves forward.
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'INVOICE_NOT_DRAFT: an issued invoice never changes';
  END IF;
  -- Its PDF is recorded once: a committed INVOICE_PDF file of the tenant.
  IF NEW.pdf_file_id IS DISTINCT FROM OLD.pdf_file_id THEN
    IF OLD.pdf_file_id IS NOT NULL THEN
      RAISE EXCEPTION 'INVOICE_NOT_DRAFT: an issued invoice''s PDF is made once';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM file_object f
                    WHERE f.tenant_id = NEW.tenant_id AND f.id = NEW.pdf_file_id
                      AND f.kind = 'INVOICE_PDF' AND f.status = 'COMMITTED') THEN
      RAISE EXCEPTION 'INVOICE_GUARD: an invoice''s PDF is a committed invoice PDF of its workspace';
    END IF;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (   (OLD.status = 'ISSUED' AND NEW.status IN ('SENT', 'PAID', 'CREDITED'))
              OR (OLD.status = 'SENT' AND NEW.status IN ('PAID', 'CREDITED'))
              OR (OLD.status = 'PAID' AND NEW.status = 'CREDITED')) THEN
    RAISE EXCEPTION 'INVOICE_GUARD: an issued invoice''s status only moves forward';
  END IF;
  -- Moving an issued invoice on is a member's act, as themselves, holding the
  -- code for that step: sent — `invoice:send`; paid — `invoice:record_payment`;
  -- credited — `invoice:credit`.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF who IS DISTINCT FROM 'member' THEN
      RAISE EXCEPTION 'INVOICE_GUARD: a member moves an issued invoice on';
    END IF;
    IF NOT invoice_member_holds(NEW.tenant_id, who_id,
                                CASE NEW.status
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


-- ── An invoice's PDF file never changes (R1; the design review's low) ──
-- The FK above stops its row being DELETED while the invoice stands; this
-- stops it being re-pointed, re-hashed or marked deleted, and stops another
-- file being re-kinded INTO an invoice PDF. (Its scan status may move.)
CREATE OR REPLACE FUNCTION file_object_invoice_pdf_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF (OLD.kind = 'INVOICE_PDF' OR NEW.kind = 'INVOICE_PDF')
     AND (   NEW.kind IS DISTINCT FROM OLD.kind
          OR NEW.id IS DISTINCT FROM OLD.id
          OR NEW.original_filename IS DISTINCT FROM OLD.original_filename
          OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
          OR NEW.r2_key IS DISTINCT FROM OLD.r2_key
          OR NEW.sha256 IS DISTINCT FROM OLD.sha256
          OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
          OR NEW.content_type IS DISTINCT FROM OLD.content_type
          OR NEW.status IS DISTINCT FROM OLD.status) THEN
    RAISE EXCEPTION 'FILE_INVOICE_PDF_GUARD: an invoice''s PDF file never changes';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER file_object_invoice_pdf_guard
  BEFORE UPDATE ON file_object
  FOR EACH ROW EXECUTE FUNCTION file_object_invoice_pdf_guard();

-- An invoice's PDF is written COMMITTED, never PENDING (the migration review's
-- nit): a PENDING one would be frozen by the guard above and stop the pending-
-- upload sweep, one updateMany across every tenant, on every run.
ALTER TABLE file_object
  ADD CONSTRAINT file_object_invoice_pdf_committed CHECK (kind <> 'INVOICE_PDF' OR status = 'COMMITTED');


-- ── Grants (deny-default, explicit per table) ───────────────────────
-- No DELETE: a series is never deleted (teardown runs as app_platform).
GRANT SELECT, INSERT, UPDATE ON invoice_series TO app_runtime;
-- app_platform already covers new tables via ALTER DEFAULT PRIVILEGES.

-- ── RLS — class A (portal_deny) ─────────────────────────────────────
ALTER TABLE invoice_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_series FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON invoice_series
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON invoice_series
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');
