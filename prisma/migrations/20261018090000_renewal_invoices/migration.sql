-- ═══════════════════════════════════════════════════════════════════
-- Phase 4 slice 113b — RENEWALS THAT DRAFT AN INVOICE (founder decision
-- C88, 2026-10-12). DATA_MODEL.md §6.6, §6.7; the design and its reviews:
-- docs/research/2026-10-12-slice-113-renewal-invoices-design.md §3, §9.
--
-- 14 days before a running recurring agreement renews, the renewal job
-- (`src/modules/invoicing/renewals.ts`) drafts the COMING period's invoice
-- line onto its client's renewal draft in that currency, or a new one —
-- under the tenant's SYSTEM principal. Nothing reaches a client until a
-- member holding `invoice:issue` issues it, as themselves (unchanged).
--
-- 1. `service.invoice_renewals boolean NOT NULL DEFAULT true` — "Invoice each
--    renewal" (C88 (e): ON for every agreement, today's included);
--    `service.invoiced_through date NULL` — the last day of the last period
--    drafted, written by the renewal job as it drafts, and cleared by a
--    member's "Run again" when it names a day already past (so paused time is
--    never billed); a draft or line a person deletes is not drafted again.
--    No guard holds this column — the line guard below reads it only as
--    written in the job's own transaction. Both INTERNAL: on the portal
--    tripwire's lists (`service` is class B).
-- 2. `invoice_origin` ('MEMBER' | 'RENEWAL') and `invoice.origin NOT NULL
--    DEFAULT 'MEMBER'` (every existing invoice is a member's — no backfill:
--    the default fills it); `invoice.created_by_member_id` becomes NULLable —
--    CHECK `invoice_origin_maker`: a RENEWAL draft is made by nobody, a
--    MEMBER's by someone; CHECK `invoice_origin_kind`: a renewal is an
--    INVOICE, never a credit note. `invoice` is class B, so a main contact's
--    row carries `origin` once an invoice is sent: the portal's named-select
--    projection never reads it (on the tripwire's never-selected list).
-- 3. `invoice_line.service_id text` — the agreement a renewal line bills, a
--    SNAPSHOT id with NO foreign key (an issued invoice's lines are its record
--    for good, and `invoice_line_guard` refuses any change to them, so an
--    ON DELETE action from `service` would make an agreement with issued
--    renewal lines undeletable by error) — with `service_period_start` /
--    `service_period_end` (the days it bills; CHECK `invoice_line_service_period`:
--    all three or none, end ≥ start) and the EXCLUDE constraint
--    `invoice_line_no_day_twice` (the pre-apply review's suggestion, the rate
--    cards' pattern): no day of one agreement on two lines at once — while
--    the lines exist (a deleted line frees its days; `invoiced_through` is
--    what keeps the job from drafting them again).
-- 4. `invoice_guard` REPLACED — 20261010120000's word for word, plus:
--    a `drafting` flag (`app.renewal_drafting = 'on'`, coalesced — an unset
--    setting reads NULL, which `NOT` would not refuse: the pre-apply review's
--    high; set by the renewal module alone — `renewal-census.test.ts`);
--    INSERT under SYSTEM only with it, of origin RENEWAL, for an ACTIVE
--    client, now, with every column but the client's terms and the period
--    NULL or its default (`jsonb_strip_nulls(…)` against a fixed object — an
--    allow-list, failing closed on a column added later); a member's INSERT is
--    origin MEMBER; `origin` joins what never changes; a DRAFT→DRAFT update
--    under SYSTEM with the flag only on a RENEWAL draft and only of its period;
--    SYSTEM never DELETEs (the design review's M1 — no job deletes a draft;
--    a person and the platform role's teardowns still do). Leaving DRAFT is
--    unchanged: a member, as themselves, holding `invoice:issue`.
-- 5. `invoice_line_guard` REPLACED — 20261009120000's word for word, plus:
--    SYSTEM may only INSERT, with the flag, onto a RENEWAL draft, a line naming
--    an ACTIVE RECURRING agreement of the invoice's client with renewal
--    invoices on and a price, in the invoice's currency (or the agreement has
--    none), quantity 1, 0 < unit price ≤ the agreement's price, no unit, its
--    text exactly the agreement's name and its days (no free text rides on a
--    renewal line — the pre-apply review's low), its period's end the
--    agreement's `invoiced_through` as WRITTEN IN THIS TRANSACTION
--    (`xmin = pg_current_xact_id()::xid` — inside a subtransaction it fails
--    closed); a person's line never names an agreement (INSERT), and a
--    renewal line's agreement and period never change (UPDATE). The facts it
--    checks live on `service`, which members with `service:edit` write: it
--    holds an honest job to account, the flag's one setter does the rest.
-- 6. `notification_reason_known` WIDENED by one reason, `INVOICE_ACCESS` —
--    "Invoices you can issue": a tenant-wide member told that a renewal draft
--    is ready (C88 (d)); dropped and re-added, validating every existing row.
--
-- `series-census.test.ts` gains this migration (its `invoice_guard` keeps the
-- number allocation, unchanged). New guard sentences only; no new
-- error token. DDL only, no DML — no `neon-smoke.yml` dispatch owed: the
-- DEFAULTs fill the new NOT NULL columns, and every constraint validates the
-- existing rows (no renewal invoice, no line with an agreement yet).
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE service ADD COLUMN invoice_renewals BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE service ADD COLUMN invoiced_through DATE;

CREATE TYPE invoice_origin AS ENUM ('MEMBER', 'RENEWAL');
ALTER TABLE "invoice" ADD COLUMN "origin" invoice_origin NOT NULL DEFAULT 'MEMBER';
ALTER TABLE "invoice" ALTER COLUMN "created_by_member_id" DROP NOT NULL;
ALTER TABLE "invoice"
  ADD CONSTRAINT invoice_origin_maker CHECK ((origin = 'RENEWAL') = (created_by_member_id IS NULL)),
  ADD CONSTRAINT invoice_origin_kind CHECK (origin = 'MEMBER' OR kind = 'INVOICE');

ALTER TABLE "invoice_line" ADD COLUMN "service_id" TEXT,
ADD COLUMN "service_period_start" DATE,
ADD COLUMN "service_period_end" DATE;
ALTER TABLE "invoice_line"
  ADD CONSTRAINT invoice_line_service_period CHECK (
        num_nonnulls(service_id, service_period_start, service_period_end) IN (0, 3)
    AND (service_period_end IS NULL OR service_period_end >= service_period_start)
    AND (service_id IS NULL OR char_length(service_id) BETWEEN 1 AND 64));
-- btree_gist is installed (20260820220000, the rate cards' EXCLUDE).
ALTER TABLE "invoice_line" ADD CONSTRAINT invoice_line_no_day_twice
  EXCLUDE USING gist (
    tenant_id WITH =,
    service_id WITH =,
    daterange(service_period_start, service_period_end, '[]') WITH &&
  ) WHERE (service_id IS NOT NULL);

-- One statement: the swap is atomic whether or not the runner wraps the file.
ALTER TABLE notification
  DROP CONSTRAINT notification_reason_known,
  ADD CONSTRAINT notification_reason_known CHECK (
    reason IS NULL OR (receiver_type = 'MEMBER' AND reason IN (
      'ASSIGNEE',
      'REQUESTER',
      'PROJECT_LEAD',
      'PROJECT_MEMBER',
      'CLIENT_MEMBER',
      'BUDGET_WATCHER',
      'VAULT_ACCESS',
      'INVOICE_ACCESS',
      'OWNER'
    ))
  );

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
  -- (113b) The renewal job's narrow right (founder decision C88 (a)): set by
  -- `src/modules/invoicing/renewals.ts` alone (`renewal-census.test.ts`).
  -- coalesce: an unset setting reads NULL, and NOT NULL refuses nothing (the
  -- pre-apply review's high — the 2T `time_lock_bypass` idiom).
  drafting boolean := coalesce(current_setting('app.renewal_drafting', true), '') = 'on';
  -- What an ISSUED invoice may still change. (109) + the send and the payment.
  mutable constant text[] := ARRAY['status', 'updated_at', 'pdf_file_id', 'sent_at', 'paid_on'];
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
    -- (113b) Never the SYSTEM principal: no job deletes a draft — the renewal
    -- job's right is to MAKE them (the design review's M1).
    IF who = 'system' AND maintenance IS NOT TRUE THEN
      RAISE EXCEPTION 'INVOICE_GUARD: a draft is deleted by a person';
    END IF;
    IF OLD.status = 'DRAFT' OR maintenance THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'INVOICE_NOT_DRAFT: an issued invoice is never deleted — it is credited';
  END IF;

  -- Class B now (109) — its census denies give a contact nothing to write;
  -- the guard says so too.
  IF who = 'contact' THEN
    RAISE EXCEPTION 'INVOICE_GUARD: a contact writes no invoice';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- (113b) A RENEWAL DRAFT, made by the renewal job (founder decision C88
    -- (a)): SYSTEM, under its own GUC, for an ACTIVE client, now — and
    -- NOTHING else set: every column but the few the job derives from the
    -- client and the period is NULL or its default (an allow-list, so a
    -- column added later fails closed; no pay link, note, reference,
    -- project or hours page can ride on one).
    IF who = 'system' THEN
      IF NOT drafting THEN
        RAISE EXCEPTION 'INVOICE_GUARD: a member makes a draft, as themselves';
      END IF;
      IF jsonb_strip_nulls(to_jsonb(NEW) - ARRAY['id', 'tenant_id', 'client_id', 'vat_profile', 'currency',
                                                  'payment_terms_days', 'period_start', 'period_end',
                                                  'created_at', 'updated_at'])
         IS DISTINCT FROM jsonb_build_object('kind', 'INVOICE', 'status', 'DRAFT', 'origin', 'RENEWAL', 'include_hours', false) THEN
        RAISE EXCEPTION 'INVOICE_GUARD: a renewal draft carries nothing but its client''s terms and its period';
      END IF;
      IF NEW.created_at < at - slack OR NEW.created_at > at + slack THEN
        RAISE EXCEPTION 'INVOICE_GUARD: a draft is made now';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM client c
                      WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.client_id AND c.status = 'ACTIVE') THEN
        RAISE EXCEPTION 'INVOICE_GUARD: a renewal draft is for an active client';
      END IF;
      RETURN NEW;
    END IF;
    -- A DRAFT, made now by a member as themselves — a MEMBER's (113b).
    IF who IS DISTINCT FROM 'member' OR NEW.created_by_member_id IS DISTINCT FROM who_id THEN
      RAISE EXCEPTION 'INVOICE_GUARD: a member makes a draft, as themselves';
    END IF;
    IF NEW.origin IS DISTINCT FROM 'MEMBER' THEN
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
     OR NEW.origin IS DISTINCT FROM OLD.origin
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
    -- (113b) The renewal job widens a RENEWAL draft's period as it adds a
    -- renewal to it — and changes nothing else, on no other draft.
    IF who = 'system' AND drafting AND OLD.origin = 'RENEWAL'
       AND (to_jsonb(NEW) - ARRAY['period_start', 'period_end', 'updated_at'])
           IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['period_start', 'period_end', 'updated_at']) THEN
      RETURN NEW;
    END IF;
    -- A draft is a member's to edit; its project stays its client's. (109)
    -- Its pay link is a draft field like any other (the CHECK holds its
    -- shape); the issue takes the code when one is there (C79 (g) — the app).
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
    -- (109) Sent and paid come AFTER the issue, by their own rules below —
    -- never in the issue's own statement (the design review's medium).
    IF NEW.sent_at IS NOT NULL OR NEW.paid_on IS NOT NULL THEN
      RAISE EXCEPTION 'INVOICE_GUARD: an invoice is sent and paid after it is issued';
    END IF;
    -- (109) The pay link is the DRAFT's: the issue's code and the owners' mail
    -- are decided from it (C79 (g)), so the issue itself never sets or changes
    -- it (the pre-apply review's low).
    IF NEW.pay_link_url IS DISTINCT FROM OLD.pay_link_url THEN
      RAISE EXCEPTION 'INVOICE_GUARD: a pay link is the draft''s, never set by the issue';
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
      -- Never more than is left, at any rate (signed — see 108b's header).
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

  -- AN ISSUED INVOICE: its content never changes, and its status moves forward
  -- — or (109) a payment is undone.
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

  -- (109) SENT — once, now, by a member who may send, as themselves, and only
  -- with this transaction's record of the send by that member.
  IF NEW.sent_at IS DISTINCT FROM OLD.sent_at THEN
    IF OLD.sent_at IS NOT NULL THEN
      RAISE EXCEPTION 'INVOICE_ALREADY_SENT: an invoice is first sent once';
    END IF;
    IF who IS DISTINCT FROM 'member' THEN
      RAISE EXCEPTION 'INVOICE_GUARD: a member sends an invoice';
    END IF;
    IF NOT invoice_member_holds(NEW.tenant_id, who_id, 'invoice:send') THEN
      RAISE EXCEPTION 'INVOICE_GUARD: only a member who may send invoices sends one';
    END IF;
    IF NEW.sent_at < at - slack OR NEW.sent_at > at + slack THEN
      RAISE EXCEPTION 'INVOICE_GUARD: an invoice is sent now';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM invoice_delivery d
                    WHERE d.tenant_id = NEW.tenant_id AND d.invoice_id = NEW.id
                      AND d.sent_by_member_id = who_id
                      AND d.xmin = pg_current_xact_id()::xid) THEN
      RAISE EXCEPTION 'INVOICE_GUARD: a send is recorded in the same transaction';
    END IF;
  END IF;

  -- (108b → 109) A credit note's status moves once: it is sent.
  IF NEW.kind = 'CREDIT_NOTE' AND NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'ISSUED' AND NEW.status = 'SENT') THEN
    RAISE EXCEPTION 'INVOICE_GUARD: a credit note is sent, nothing else';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (   (OLD.status = 'ISSUED' AND NEW.status IN ('SENT', 'PAID', 'CREDITED'))
              OR (OLD.status = 'SENT' AND NEW.status IN ('PAID', 'CREDITED'))
              -- (109) PAID → CREDITED, or the payment undone (C79 (h)): back
              -- to SENT or ISSUED, which one the CHECK decides by sent_at.
              OR (OLD.status = 'PAID' AND NEW.status IN ('CREDITED', 'SENT', 'ISSUED'))) THEN
    RAISE EXCEPTION 'INVOICE_GUARD: an issued invoice''s status only moves forward, or a payment is undone';
  END IF;

  -- (109) A payment is recorded with a move TO paid, or undone with a move
  -- FROM it — never rewritten in place (its note is `invoice_payment_note`'s,
  -- never changed either).
  IF NEW.paid_on IS DISTINCT FROM OLD.paid_on
     AND NOT (   (NEW.status = 'PAID' AND OLD.status <> 'PAID')
              OR (OLD.status = 'PAID' AND NEW.status IN ('SENT', 'ISSUED'))) THEN
    RAISE EXCEPTION 'INVOICE_GUARD: a payment is recorded or undone, never rewritten';
  END IF;
  -- The day the money arrived: not after tomorrow (UTC — every zone's today),
  -- not more than a year before the invoice's date.
  IF NEW.status = 'PAID' AND OLD.status <> 'PAID'
     AND (   NEW.paid_on > (statement_timestamp() AT TIME ZONE 'UTC')::date + 1
          OR NEW.paid_on < NEW.issue_date - 366) THEN
    RAISE EXCEPTION 'INVOICE_GUARD: the day a payment arrived is not in the future nor long before the invoice';
  END IF;

  -- Moving an issued invoice on is a member's act, as themselves, holding the
  -- code for that step — (109) keyed on where it comes from AND goes: sent —
  -- `invoice:send`; paid, and a payment undone — `invoice:record_payment`;
  -- credited — `invoice:credit`.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF who IS DISTINCT FROM 'member' THEN
      RAISE EXCEPTION 'INVOICE_GUARD: a member moves an issued invoice on';
    END IF;
    IF NOT invoice_member_holds(NEW.tenant_id, who_id,
                                CASE
                                  WHEN NEW.status = 'CREDITED' THEN 'invoice:credit'
                                  WHEN NEW.status = 'PAID' OR OLD.status = 'PAID' THEN 'invoice:record_payment'
                                  ELSE 'invoice:send'
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
    -- (109) The move to PAID marks this transaction for its note's guard
    -- (a note is written with its payment, never added to an old one).
    IF NEW.status = 'PAID' THEN
      PERFORM set_config('app.invoice_paid_now', NEW.id, true);
    END IF;
    -- (109) A payment undone takes its note with it (the delta re-check's
    -- nit): never left on an unpaid invoice for the next payment to inherit.
    -- The note's guard admits a delete from inside this trigger (depth > 1).
    IF OLD.status = 'PAID' AND NEW.status IN ('SENT', 'ISSUED') THEN
      DELETE FROM invoice_payment_note n
       WHERE n.tenant_id = NEW.tenant_id AND n.client_id = NEW.client_id AND n.invoice_id = NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION invoice_line_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  row_tenant text;
  row_invoice text;
  parent_status invoice_status;
  parent_profile "VatProfile";
  -- (113b) The renewal job and the draft it adds to.
  who text := current_setting('app.principal', true);
  drafting boolean := coalesce(current_setting('app.renewal_drafting', true), '') = 'on';
  parent_origin invoice_origin;
  parent_currency text;
  agreement record;
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
  -- (113b) The agreement a renewal line bills, and its period, never change.
  IF TG_OP = 'UPDATE'
     AND (   NEW.service_id IS DISTINCT FROM OLD.service_id
          OR NEW.service_period_start IS DISTINCT FROM OLD.service_period_start
          OR NEW.service_period_end IS DISTINCT FROM OLD.service_period_end) THEN
    RAISE EXCEPTION 'INVOICE_GUARD: a renewal line keeps its agreement and its period';
  END IF;

  -- The invoice, held: an issue waits for this write, or this write for it.
  SELECT i.status, i.vat_profile, i.origin, i.currency
    INTO parent_status, parent_profile, parent_origin, parent_currency
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

  -- (113b) THE RENEWAL JOB only ADDS, only to a RENEWAL draft, under its own
  -- GUC, a line billing ONE period of a running agreement of the invoice's
  -- client that switched renewal invoices on, in the invoice's currency, at
  -- no more than its price — the period the agreement's row was recorded as
  -- drafted to IN THIS TRANSACTION (its xmin, `invoiced_through`), saying its
  -- agreement and its days and nothing else; and no day of an agreement is
  -- on two lines at once (`invoice_line_no_day_twice`). A person's line
  -- never names an agreement.
  IF who = 'system' THEN
    IF TG_OP <> 'INSERT' OR NOT drafting OR parent_origin IS DISTINCT FROM 'RENEWAL' THEN
      RAISE EXCEPTION 'INVOICE_GUARD: the renewal job only adds a renewal line to a renewal draft';
    END IF;
    SELECT s.client_id, s.status::text AS status, s.kind::text AS kind, s.invoice_renewals, s.price_ex_vat, s.name,
           s.currency, s.invoiced_through, (s.xmin = pg_current_xact_id()::xid) AS written_now
      INTO agreement
      FROM service s
     WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.service_id;
    IF NOT FOUND
       OR agreement.client_id IS DISTINCT FROM NEW.client_id
       OR agreement.status <> 'ACTIVE' OR agreement.kind <> 'RECURRING' OR NOT agreement.invoice_renewals
       OR agreement.price_ex_vat IS NULL OR agreement.price_ex_vat <= 0
       OR coalesce(agreement.currency, parent_currency) IS DISTINCT FROM parent_currency THEN
      RAISE EXCEPTION 'INVOICE_GUARD: a renewal line bills a running agreement of the invoice''s client, in its currency';
    END IF;
    IF NEW.quantity <> 1 OR NEW.unit_price_ex_vat <= 0 OR NEW.unit_price_ex_vat > agreement.price_ex_vat THEN
      RAISE EXCEPTION 'INVOICE_GUARD: a renewal line bills one period at no more than its agreement''s price';
    END IF;
    IF NEW.unit IS NOT NULL
       OR NEW.description IS DISTINCT FROM agreement.name || ', ' || to_char(NEW.service_period_start, 'YYYY-MM-DD')
                                           || ' – ' || to_char(NEW.service_period_end, 'YYYY-MM-DD') THEN
      RAISE EXCEPTION 'INVOICE_GUARD: a renewal line says its agreement and its days, nothing else';
    END IF;
    IF NOT agreement.written_now OR agreement.invoiced_through IS DISTINCT FROM NEW.service_period_end THEN
      RAISE EXCEPTION 'INVOICE_GUARD: a renewal line is the period its agreement was just recorded as drafted';
    END IF;
  ELSIF TG_OP = 'INSERT' AND NEW.service_id IS NOT NULL THEN
    RAISE EXCEPTION 'INVOICE_GUARD: a line names an agreement only when the renewal job drafted it';
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
