-- ═══════════════════════════════════════════════════════════════════
-- Phase 4 slice 108b — CREDIT NOTES (founder decisions C76 (c), (f), C77)
-- and THE DAY OF THE EXCHANGE RATE (C78 (a)). DATA_MODEL.md §6.7; PLAN Phase 4.
--
-- A CREDIT NOTE is an `invoice` row of kind CREDIT_NOTE naming the invoice it
-- credits (`credits_invoice_id`; 107's composite FK binds it to an invoice of
-- the SAME tenant and client). It is written as a DRAFT and issued like an
-- invoice, from the same series (C76 (c)). Its amounts are stored POSITIVE —
-- quantities, prices, totals — exactly as an invoice's (EN 16931's credit note,
-- type 381, so a Peppol adapter maps it 1:1); every rule 107 and 108 hold on
-- amounts holds unchanged. The PRINT negates them (C77 (a); `print.ts`).
--
-- WHAT THIS GUARD ADDS (`invoice_guard`, replaced; everything 108 held is held):
--   - A credit-note DRAFT is made by a member as themselves holding
--     `invoice:credit` AND `invoice:issue`, for an ISSUED/SENT/PAID INVOICE
--     (never a credit note, a draft or a CREDITED one); it carries the
--     original's VAT treatment, currency, language, project, work period and
--     series, and no payment terms — and keeps them while a draft. Its reason,
--     note, references and lines are what a draft edits, by a member holding
--     `invoice:credit`. (Deleting its draft is any draft's delete — slice 107
--     checks no code there, and deleting a draft credits nothing; the app
--     asks `invoice:delete` AND `invoice:credit`.)
--   - ISSUING a credit note: by a member holding both codes; its reason set;
--     its total above zero; dated no earlier than the original; the ORIGINAL
--     locked `FOR UPDATE` and still an ISSUED/SENT/PAID invoice; and — THE
--     OVER-CREDIT RULE (`invoice_credit_within`) — at every VAT rate, signed
--     (a discount is a negative line, 107): this credit note's own net lies
--     between zero and the original's net there (so it never "un-credits" a
--     rate), the nets of the original's issued credit notes, this one
--     included, lie between zero and the original's too, and it has no line at
--     a rate the original lacks. Its seller and buyer snapshots are the
--     ORIGINAL's (it corrects that document, naming the parties as it did);
--     its payment snapshot is '{}' (it asks no one to pay); it records the
--     original's number and date (`credits_display_number`,
--     `credits_issue_date` — ML's unambiguous reference, kept in the record
--     itself, not only as a join). Its VAT in SEK is at the original's rate
--     and date. Then the number, last, as for an invoice.
--   - An issued credit note's status never moves (slice 109 decides sending).
--   - An invoice reaches CREDITED only when its issued credit notes' nets equal
--     its own at every rate — "partly credited" is not a status, the page
--     derives it.
--
-- VAT ROUNDING (the design review's low, accepted): VAT is computed once per
-- rate on EACH document (EN 16931 BR-CO-17), so two part credits can between
-- them credit an öre more VAT at a rate than the invoice charged (100,02 +
-- 100,02 at 25 %: 25,01 + 25,01 against 50,01). The rule is on NETS, which
-- are exact; the drift is at most an öre per rate per part credit, and a
-- remainder-VAT credit note would break BR-CO-17 on that document.
--
-- LOCK ORDER (one order, no cycle — the design review's low): issuing a
-- credit note takes its ORIGINAL first, then itself (`issueLocked`), then the
-- series (the guard's last step); crediting in full and making a credit draft
-- take the original first too (the credit note is a row nobody else can see).
-- The guard's own `FOR UPDATE` of the original is then already held. A
-- regular issue takes its own row then the series; a draft edit, the line
-- writers, the PDF writer and slice 109's status moves take one invoice row
-- each. Nothing IN THE APPLICATION takes the series and then an invoice, nor a
-- credit note and then its original (a raw UPDATE issuing a credit note — a
-- dbtest's — takes the credit note first and the original in this guard; run
-- against the app's order on the same rows, Postgres detects the deadlock and
-- aborts one: nothing unsafe). Two credit notes on one original serialise on the
-- original's row; the second's over-credit read is a fresh statement after
-- the wait (READ COMMITTED; a VOLATILE plpgsql or SQL function takes a new
-- snapshot per statement), so it sees the first.
--
-- THE RATE'S DAY (C78 (a)): an invoice's VAT in SEK is at the ECB rate of the
-- day the WORK ENDED — `least(coalesce(period_end, issue_date), issue_date)` —
-- so the rate's date is held to the ten days before THAT day (slice 108 held it
-- to the ten before the issue date). A credit note takes its original's.
--
-- DDL only, no DML — no `neon-smoke.yml` dispatch owed.
-- ═══════════════════════════════════════════════════════════════════

-- AlterTable
ALTER TABLE "invoice" ADD COLUMN "credit_reason" TEXT,
ADD COLUMN "credits_display_number" TEXT,
ADD COLUMN "credits_issue_date" DATE;

-- ── CHECKs ──────────────────────────────────────────────────────────
ALTER TABLE invoice
  -- The reason: a short text, on a credit note only, required once issued (C77 (b)).
  ADD CONSTRAINT invoice_credit_reason
    CHECK (    (credit_reason IS NULL OR (char_length(credit_reason) BETWEEN 1 AND 500 AND credit_reason ~ '[^[:space:]]'))
           AND (kind = 'CREDIT_NOTE' OR credit_reason IS NULL)
           AND (kind <> 'CREDIT_NOTE' OR status = 'DRAFT' OR credit_reason IS NOT NULL)),
  -- A credit note asks no one to pay: it falls due the day it is dated.
  ADD CONSTRAINT invoice_credit_note_terms CHECK (kind <> 'CREDIT_NOTE' OR payment_terms_days = 0),
  -- What it credits, by number and date: written at issue, on an issued
  -- credit note only.
  ADD CONSTRAINT invoice_credits_reference
    CHECK (    (credits_display_number IS NULL OR char_length(credits_display_number) BETWEEN 1 AND 40)
           AND CASE WHEN kind = 'CREDIT_NOTE' AND status <> 'DRAFT'
                    THEN num_nulls(credits_display_number, credits_issue_date) = 0
                    ELSE num_nonnulls(credits_display_number, credits_issue_date) = 0
               END
           -- …and it is dated no earlier than what it credits (the guard
           -- checks it first; the record holds it too — the review's nit).
           AND (credits_issue_date IS NULL OR credits_issue_date <= issue_date));


-- ── What a credit note may credit, per VAT rate ─────────────────────
-- Over the original `p_original`'s lines, its ISSUED credit notes' lines plus
-- — when given — those of `p_issuing`, the credit note being issued (still a
-- DRAFT in the table while its own guard runs), all netted per rate:
--   - `p_exact` false (the issue): TRUE when the credited nets lie between
--     zero and the original's net at every rate, AND `p_issuing`'s own net
--     does too, AND `p_issuing` has no line at a rate the original lacks;
--   - `p_exact` true (the move to CREDITED): TRUE only when the credited nets
--     EQUAL the original's at every rate.
-- SECURITY INVOKER: it reads under the writer's own RLS. VOLATILE on purpose:
-- a STABLE function reads with its CALLER's snapshot, and this one must see a
-- credit note committed while the caller waited for the original's lock.
CREATE OR REPLACE FUNCTION invoice_credit_within(p_tenant text, p_original text, p_issuing text, p_exact boolean) RETURNS boolean
LANGUAGE sql VOLATILE
SET search_path = public, pg_temp
AS $fn$
  WITH o AS (
    SELECT l.vat_rate_pct AS rate, sum(l.amount_ex_vat) AS net
      FROM invoice_line l
     WHERE l.tenant_id = p_tenant AND l.invoice_id = p_original
     GROUP BY l.vat_rate_pct
  ), c AS (
    SELECT l.vat_rate_pct AS rate, sum(l.amount_ex_vat) AS net
      FROM invoice_line l
      JOIN invoice cn ON cn.tenant_id = l.tenant_id AND cn.id = l.invoice_id
     WHERE l.tenant_id = p_tenant
       AND cn.kind = 'CREDIT_NOTE' AND cn.credits_invoice_id = p_original
       AND (cn.status <> 'DRAFT' OR cn.id = p_issuing)
     GROUP BY l.vat_rate_pct
  ), m AS (
    SELECT l.vat_rate_pct AS rate, sum(l.amount_ex_vat) AS net
      FROM invoice_line l
     WHERE l.tenant_id = p_tenant AND l.invoice_id = p_issuing
     GROUP BY l.vat_rate_pct
  )
  SELECT CASE
    WHEN p_exact THEN
      NOT EXISTS (SELECT 1 FROM o FULL JOIN c ON c.rate = o.rate
                   WHERE coalesce(c.net, 0) <> coalesce(o.net, 0))
    ELSE
          NOT EXISTS (SELECT 1 FROM o FULL JOIN c ON c.rate = o.rate
                       WHERE coalesce(c.net, 0) NOT BETWEEN least(0, coalesce(o.net, 0)) AND greatest(0, coalesce(o.net, 0)))
      AND NOT EXISTS (SELECT 1 FROM m LEFT JOIN o ON o.rate = m.rate
                       WHERE o.rate IS NULL OR m.net NOT BETWEEN least(0, o.net) AND greatest(0, o.net))
  END
$fn$;


-- ── The invoice's guard, replaced ───────────────────────────────────
-- Everything 108 held is held unchanged (its header is the reference); what
-- is new is marked (108b).
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
  rate_day date;
  seller record;
  buyer record;
  orig record;
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
    -- A DRAFT, made now by a member as themselves.
    IF who IS DISTINCT FROM 'member' OR NEW.created_by_member_id IS DISTINCT FROM who_id THEN
      RAISE EXCEPTION 'INVOICE_GUARD: a member makes a draft, as themselves';
    END IF;
    IF NEW.status <> 'DRAFT' THEN
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
    -- (108b) A credit note: by a member who could finish it, for an issued
    -- INVOICE not yet credited in full, carrying that invoice's terms.
    IF NEW.kind = 'CREDIT_NOTE' THEN
      IF NOT invoice_member_holds(NEW.tenant_id, who_id, 'invoice:credit')
         OR NOT invoice_member_holds(NEW.tenant_id, who_id, 'invoice:issue') THEN
        RAISE EXCEPTION 'INVOICE_GUARD: only a member who may credit and issue invoices makes a credit note';
      END IF;
      SELECT o.kind, o.status, o.vat_profile, o.currency, o.locale, o.project_id, o.period_start, o.period_end, o.series_id
        INTO orig
        FROM invoice o
       WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.credits_invoice_id;
      IF NOT FOUND OR orig.kind <> 'INVOICE' OR orig.status NOT IN ('ISSUED', 'SENT', 'PAID') THEN
        RAISE EXCEPTION 'INVOICE_NOT_CREDITABLE: only an issued invoice not yet credited in full is credited';
      END IF;
      IF NEW.vat_profile IS DISTINCT FROM orig.vat_profile
         OR NEW.currency IS DISTINCT FROM orig.currency
         OR NEW.locale IS DISTINCT FROM orig.locale
         OR NEW.project_id IS DISTINCT FROM orig.project_id
         OR NEW.period_start IS DISTINCT FROM orig.period_start
         OR NEW.period_end IS DISTINCT FROM orig.period_end
         OR NEW.series_id IS DISTINCT FROM orig.series_id THEN
        RAISE EXCEPTION 'INVOICE_GUARD: a credit note carries its invoice''s terms';
      END IF;
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

  -- (108b) A credit note keeps its invoice's terms in every state.
  IF NEW.kind = 'CREDIT_NOTE'
     AND (   NEW.vat_profile IS DISTINCT FROM OLD.vat_profile
          OR NEW.currency IS DISTINCT FROM OLD.currency
          OR NEW.locale IS DISTINCT FROM OLD.locale
          OR NEW.project_id IS DISTINCT FROM OLD.project_id
          OR NEW.period_start IS DISTINCT FROM OLD.period_start
          OR NEW.period_end IS DISTINCT FROM OLD.period_end
          OR NEW.series_id IS DISTINCT FROM OLD.series_id) THEN
    RAISE EXCEPTION 'INVOICE_GUARD: a credit note carries its invoice''s terms';
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' THEN
    -- A draft is a member's to edit; its project stays its client's.
    IF who IS DISTINCT FROM 'member' THEN
      RAISE EXCEPTION 'INVOICE_GUARD: a member edits a draft';
    END IF;
    -- (108b) A credit note's draft, only by a member who may credit.
    IF NEW.kind = 'CREDIT_NOTE' AND NOT invoice_member_holds(NEW.tenant_id, who_id, 'invoice:credit') THEN
      RAISE EXCEPTION 'INVOICE_GUARD: only a member who may credit invoices edits a credit note';
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

    IF NEW.kind = 'CREDIT_NOTE' THEN
      -- (108b) A CREDIT NOTE — what differs from an invoice.
      IF NOT invoice_member_holds(NEW.tenant_id, who_id, 'invoice:credit') THEN
        RAISE EXCEPTION 'INVOICE_GUARD: only a member who may credit invoices issues a credit note';
      END IF;
      IF NEW.total <= 0 THEN
        RAISE EXCEPTION 'INVOICE_OVER_CREDIT: a credit note credits something';
      END IF;
      -- Its reason (C77 (b)), here and not only in the CHECK — before the
      -- number is taken (the migration review's low).
      IF coalesce(NEW.credit_reason, '') !~ '[^[:space:]]' THEN
        RAISE EXCEPTION 'INVOICE_GUARD: a credit note says why';
      END IF;
      -- The original, held (the app took it first — the one lock order): two
      -- credit notes on one invoice serialise on it, and the second's read
      -- below, a statement of its own, sees the first.
      SELECT o.kind, o.status, o.vat_profile, o.currency, o.locale, o.series_id,
             o.seller_snapshot, o.buyer_snapshot, o.fx_rate_to_sek, o.fx_rate_date,
             o.display_number, o.issue_date
        INTO orig
        FROM invoice o
       WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.credits_invoice_id
         FOR UPDATE;
      IF NOT FOUND OR orig.kind <> 'INVOICE' OR orig.status NOT IN ('ISSUED', 'SENT', 'PAID') THEN
        RAISE EXCEPTION 'INVOICE_NOT_CREDITABLE: only an issued invoice not yet credited in full is credited';
      END IF;
      IF NEW.vat_profile IS DISTINCT FROM orig.vat_profile
         OR NEW.currency IS DISTINCT FROM orig.currency
         OR NEW.locale IS DISTINCT FROM orig.locale
         OR NEW.series_id IS DISTINCT FROM orig.series_id THEN
        RAISE EXCEPTION 'INVOICE_GUARD: a credit note carries its invoice''s terms';
      END IF;
      IF NEW.issue_date < orig.issue_date THEN
        RAISE EXCEPTION 'INVOICE_GUARD: a credit note is dated no earlier than its invoice';
      END IF;
      -- Never more than is left, at any rate (signed — see the header).
      IF NOT invoice_credit_within(NEW.tenant_id, NEW.credits_invoice_id, NEW.id, false) THEN
        RAISE EXCEPTION 'INVOICE_OVER_CREDIT: a credit note credits no more than is left of its invoice at each VAT rate';
      END IF;
      -- The parties as the original named them; nothing to pay.
      NEW.seller_snapshot := orig.seller_snapshot;
      NEW.buyer_snapshot := orig.buyer_snapshot;
      NEW.payment_snapshot := '{}'::jsonb;
      -- …and what it credits, by number and date, in its own record.
      NEW.credits_display_number := orig.display_number;
      NEW.credits_issue_date := orig.issue_date;
      IF NEW.locale IS NULL THEN
        RAISE EXCEPTION 'INVOICE_GUARD: an issued invoice has its language';
      END IF;
      -- VAT in SEK at the ORIGINAL's rate and date (the VAT it reverses was
      -- stated at that rate), on another currency carrying VAT only.
      IF NEW.currency = 'SEK' OR vat = 0 THEN
        IF num_nonnulls(NEW.fx_rate_to_sek, NEW.fx_rate_date, NEW.vat_total_sek) <> 0 THEN
          RAISE EXCEPTION 'INVOICE_GUARD: VAT in SEK only on another currency carrying VAT';
        END IF;
      ELSE
        IF orig.fx_rate_to_sek IS NULL OR orig.fx_rate_date IS NULL
           OR NEW.fx_rate_to_sek IS DISTINCT FROM orig.fx_rate_to_sek
           OR NEW.fx_rate_date IS DISTINCT FROM orig.fx_rate_date THEN
          RAISE EXCEPTION 'INVOICE_GUARD: a credit note states its VAT in SEK at its invoice''s rate';
        END IF;
      END IF;
    ELSE
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
        -- (108b) At the rate of the day the WORK ENDED (C78 (a)): the work
        -- period's last day, the invoice date without one, never after it —
        -- the latest file on or before that day, at most ten days earlier.
        rate_day := least(coalesce(NEW.period_end, NEW.issue_date), NEW.issue_date);
        IF NEW.fx_rate_date < rate_day - 10 OR NEW.fx_rate_date > rate_day THEN
          RAISE EXCEPTION 'INVOICE_GUARD: the exchange rate is the one of the day the work ended';
        END IF;
      END IF;
    END IF;

    -- (108) VAT in SEK, both kinds: the trio all set or none (CHECK), and the
    -- SEK VAT each rate's VAT at the rate, rounded, summed.
    IF NEW.currency <> 'SEK' AND vat <> 0 THEN
      IF num_nulls(NEW.fx_rate_to_sek, NEW.fx_rate_date, NEW.vat_total_sek) <> 0 THEN
        RAISE EXCEPTION 'INVOICE_GUARD: an invoice in another currency states its VAT in SEK';
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
  -- (108b) An issued credit note stays ISSUED (slice 109 decides sending one).
  IF NEW.kind = 'CREDIT_NOTE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'INVOICE_GUARD: a credit note''s status does not move';
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
    -- (108b) Credited only once its issued credit notes cover all of it, at
    -- every rate — and at least one does.
    IF NEW.status = 'CREDITED'
       AND (NOT EXISTS (SELECT 1 FROM invoice cn
                         WHERE cn.tenant_id = NEW.tenant_id AND cn.kind = 'CREDIT_NOTE'
                           AND cn.credits_invoice_id = NEW.id AND cn.status <> 'DRAFT')
            OR NOT invoice_credit_within(NEW.tenant_id, NEW.id, NULL, true)) THEN
      RAISE EXCEPTION 'INVOICE_GUARD: an invoice is credited only once credit notes cover all of it';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
