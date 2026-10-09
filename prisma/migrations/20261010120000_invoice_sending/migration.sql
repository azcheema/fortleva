-- ═══════════════════════════════════════════════════════════════════
-- Phase 4 slice 109 — SENDING, THE CLIENT'S PORTAL VIEW, PAY NOW, PAID BY
-- HAND (founder decision C79 (a)–(h)). DATA_MODEL.md §6.7; the design and its
-- review: docs/research/2026-10-09-slice-109-sending-design.md.
--
-- 1. `invoice` gains:
--      pay_link_url   a draft's "Pay now" link — an INVOICE's only; Stripe's
--                     or PayPal's own hosts, exactly (CHECK `invoice_pay_link`;
--                     `src/config`'s `payLinkUrl` is the same list); frozen at
--                     issue like every other column (it is not "mutable").
--      sent_at        the FIRST time it was sent — emailed, or marked as sent.
--                     THE CLIENT PORTAL'S GATE (C79 (b)): a contact reads an
--                     invoice or credit note of their own client once IT has
--                     been sent. Set once, never changed or cleared.
--      paid_on        the day the money arrived, marked by hand (C79 (d)).
--    The CHECKs make the status and these facts agree: for an unpaid invoice
--    ISSUED means unsent and SENT means sent; PAID has its day; a day only on
--    PAID or CREDITED (a refund keeps its history); a credit note never has a
--    link or a payment.
--    The agency's NOTE on a payment is NOT a column here (the pre-apply
--    review's medium): `invoice` becomes a client's to read once sent, a
--    column grant cannot tell a member from a contact (both `app_runtime`),
--    and a projection's select is not a database rule — so the note lives on
--    its own CLASS-A row, `invoice_payment_note` (2b).
--
-- 2. `invoice_delivery` (new, class A): one row per send — emailed, to which
--    addresses (the ones that took it), or marked as sent — by whom, when.
--    Written only by a member holding `invoice:send`, of an issued invoice,
--    never changed (`invoice_delivery_guard`). The agency's record: a contact
--    never reads it.
--
-- 2b. `invoice_payment_note` (new, class A): the agency's own note on a
--    payment marked by hand — "USD 15 short, bank fee". One per invoice;
--    written only by a member holding `invoice:record_payment` right after
--    THIS TRANSACTION moved the invoice to PAID — the move sets a
--    transaction-local marker (`app.invoice_paid_now` = the invoice's id) and
--    the invoice's row must be this transaction's (its xmin); the delta
--    re-check's low: xmin alone proves only that the row was WRITTEN here, and
--    a no-op UPDATE of an old paid invoice writes it too. Deleted by the
--    invoice's own guard when a payment is undone (so it is never inherited by
--    the next payment), or by its invoice's cascade; never changed
--    (`invoice_payment_note_guard`). The marker is a belt against an app bug,
--    not against raw SQL (anyone with raw SQL can set it).
--
-- 3. `invoice_guard`, replaced. Everything 108b held is held; what changes
--    is marked (109):
--      - Leaving DRAFT never sets sent_at or paid_on (the design review's
--        medium: the issue branch returned before the send rules ran, so an
--        issue could have opened the portal with no send behind it), nor sets
--        or changes the pay link (the pre-apply review's low: the issue's code
--        and the owners' mail are decided from the link the draft held).
--      - sent_at: set once, now, by a member as themselves holding
--        `invoice:send`, and only with a delivery row by that member for this
--        invoice written IN THIS TRANSACTION (`xmin = pg_current_xact_id()`,
--        slice 98's probe) — "sent" is always backed by a record of the send.
--      - A credit note's status moves once: ISSUED → SENT.
--      - PAID needs its day (CHECK), no later than tomorrow (UTC) and no earlier
--        than a year before the invoice date; MARK AS UNPAID (C79 (h)) moves
--        PAID back to SENT or ISSUED — which one is the CHECK's, by sent_at —
--        clearing the day. A recorded payment is never rewritten in place.
--      - The code for a status move is keyed on WHERE IT COMES FROM AND GOES
--        (the review's low): ISSUED → SENT `invoice:send`; → PAID and PAID →
--        SENT|ISSUED `invoice:record_payment`; → CREDITED `invoice:credit`.
--
-- 4. `invoice` BECOMES CLASS B (client-scoped, status-structural —
--    `PORTAL_GATE_VARIANTS.invoice`): `portal_deny` is dropped and
--      portal_gate             a contact reads a row iff its client is theirs,
--                              it is not a draft and it has been sent; WITH
--                              CHECK denies contacts outright (the
--                              `credential_item` precedent);
--      portal_no_insert/update/delete — the census's named denies;
--      portal_invoice_primary  RESTRICTIVE SELECT: only while the contact is a
--                              MAIN contact (`portal_profile =
--                              'CONTACT_PRIMARY'`, read from their own row
--                              under their own RLS — `portal_vault_switch`'s
--                              belt): AUTHZ §8's "no money" for a client's
--                              collaborators, held by the database.
--    `invoice_line` STAYS CLASS A: the client's copy of the lines is the PDF.
--    Nothing else changes for members: `portal_gate` and the new denies bind
--    only `app.principal = 'contact'`.
--
-- LOCKS (corrected by the pre-apply review): every new write takes ONE invoice
-- row, FOR UPDATE, FIRST (`send.ts`'s `lockInvoice`). Inserting a delivery
-- row or a payment note then takes FOR KEY SHARE on that invoice through its
-- composite FK — already covered by the FOR UPDATE this transaction holds. The
-- other order (insert, then FOR UPDATE) would let two concurrent sends each
-- hold KEY SHARE and both wait to upgrade: a deadlock. So the order is the
-- rule: the invoice locked, then the record inserted, then the invoice
-- updated (the guard's xmin check needs the record first). No new lock order
-- beyond that. And NO SAVEPOINT between the record and the invoice's update:
-- inside a subtransaction a row's xmin is the subtransaction's id, not
-- `pg_current_xact_id()`, and the send is refused — failing closed
-- (`credential_ask`'s precedent, slice 98).
--
-- DDL only, no DML — no `neon-smoke.yml` dispatch owed. The CHECKs are
-- validated on existing rows: checked read-only on dev across EVERY tenant
-- before applying (the design review's low — a stale fixture tenant holding a
-- PAID row from an older dbtest would fail them).
-- ═══════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "invoice_delivery_method" AS ENUM ('EMAIL', 'MARKED');

-- AlterTable
ALTER TABLE "invoice" ADD COLUMN     "paid_on" DATE,
ADD COLUMN     "pay_link_url" TEXT,
ADD COLUMN     "sent_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "invoice_delivery" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "method" "invoice_delivery_method" NOT NULL,
    "recipients" TEXT[],
    "sent_by_member_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_payment_note" (
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "created_by_member_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_payment_note_pkey" PRIMARY KEY ("tenant_id","client_id","invoice_id")
);

-- CreateIndex
CREATE INDEX "invoice_delivery_tenant_id_invoice_id_created_at_idx" ON "invoice_delivery"("tenant_id", "invoice_id", "created_at");

-- CreateIndex
CREATE INDEX "invoice_delivery_tenant_id_created_at_idx" ON "invoice_delivery"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "invoice_delivery" ADD CONSTRAINT "invoice_delivery_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_delivery" ADD CONSTRAINT "invoice_delivery_tenant_id_client_id_invoice_id_fkey" FOREIGN KEY ("tenant_id", "client_id", "invoice_id") REFERENCES "invoice"("tenant_id", "client_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payment_note" ADD CONSTRAINT "invoice_payment_note_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payment_note" ADD CONSTRAINT "invoice_payment_note_tenant_id_client_id_invoice_id_fkey" FOREIGN KEY ("tenant_id", "client_id", "invoice_id") REFERENCES "invoice"("tenant_id", "client_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── 1. The invoice's new facts, held by CHECKs ──────────────────────
ALTER TABLE invoice
  -- The Pay now link (C79 (c), (f)): Stripe's or PayPal's own hosts, the
  -- host followed by a path or nothing (so `https://buy.stripe.com@evil…` and
  -- `https://buy.stripe.com.evil…` match nothing), printable ASCII without a
  -- backslash (the app stores a parsed URL's href, which is ASCII — the
  -- review's nit: no bidi or control character can ride in), at most 500
  -- characters; an INVOICE's only.
  ADD CONSTRAINT invoice_pay_link
    CHECK (    pay_link_url IS NULL
           OR (    kind = 'INVOICE'
               AND char_length(pay_link_url) <= 500
               AND pay_link_url ~ '^https://(buy\.stripe\.com|invoice\.stripe\.com|www\.paypal\.com|paypal\.com|paypal\.me|www\.paypal\.me)(/[\x21-\x5b\x5d-\x7e]*)?$')),
  -- Sent: never a draft; SENT is sent and, for an unpaid invoice, ISSUED is
  -- not (the review's nit: the reversal's target is then this CHECK's).
  ADD CONSTRAINT invoice_sent
    CHECK (    (sent_at IS NULL OR status <> 'DRAFT')
           AND (status <> 'SENT' OR sent_at IS NOT NULL)
           AND (status <> 'ISSUED' OR sent_at IS NULL)),
  -- Paid by hand (C79 (d)): PAID has its day; a day only on PAID or CREDITED
  -- (PAID → CREDITED keeps it); an invoice's only.
  ADD CONSTRAINT invoice_paid
    CHECK (    (status <> 'PAID' OR paid_on IS NOT NULL)
           AND (paid_on IS NULL OR (status IN ('PAID', 'CREDITED') AND kind = 'INVOICE')));

-- The note's own shape: some text, at most 500 characters.
ALTER TABLE invoice_payment_note
  ADD CONSTRAINT invoice_payment_note_text
    CHECK (char_length(note) BETWEEN 1 AND 500 AND note ~ '[^[:space:]]');


-- ── 2. A send's record ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION invoice_delivery_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  who text := current_setting('app.principal', true);
  who_id text := current_setting('app.principal_id', true);
  at timestamptz := statement_timestamp();
  slack constant interval := interval '5 minutes';
  n int;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'INVOICE_DELIVERY_GUARD: a send is recorded once and never changed';
  END IF;
  -- A member, as themselves, who may send invoices.
  IF who IS DISTINCT FROM 'member' OR NEW.sent_by_member_id IS DISTINCT FROM who_id THEN
    RAISE EXCEPTION 'INVOICE_DELIVERY_GUARD: a member records a send, as themselves';
  END IF;
  IF NOT invoice_member_holds(NEW.tenant_id, who_id, 'invoice:send') THEN
    RAISE EXCEPTION 'INVOICE_DELIVERY_GUARD: only a member who may send invoices records a send';
  END IF;
  IF NEW.created_at < at - slack OR NEW.created_at > at + slack THEN
    RAISE EXCEPTION 'INVOICE_DELIVERY_GUARD: a send is recorded when it happens';
  END IF;
  -- Of an issued invoice (the composite FK already makes it this client's).
  IF NOT EXISTS (SELECT 1 FROM invoice i
                  WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.invoice_id
                    AND i.client_id = NEW.client_id AND i.status <> 'DRAFT') THEN
    RAISE EXCEPTION 'INVOICE_DELIVERY_GUARD: only an issued invoice is sent';
  END IF;
  -- Emailed: one to three distinct lower-cased addresses, each one address;
  -- marked: none.
  n := coalesce(cardinality(NEW.recipients), 0);
  -- One dimension (the pre-apply review's nit): `{{a},{b}}` has a
  -- cardinality and unnests flat, and Prisma cannot read it back.
  IF coalesce(array_ndims(NEW.recipients), 1) <> 1 THEN
    RAISE EXCEPTION 'INVOICE_DELIVERY_GUARD: a send''s addresses are a plain list';
  END IF;
  IF NEW.method = 'EMAIL' THEN
    IF n NOT BETWEEN 1 AND 3
       OR (SELECT count(DISTINCT r) FROM unnest(NEW.recipients) r) <> n
       OR EXISTS (SELECT 1 FROM unnest(NEW.recipients) r
                   WHERE r IS NULL OR char_length(r) NOT BETWEEN 3 AND 254 OR r <> lower(r)
                      OR r !~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+$') THEN
      RAISE EXCEPTION 'INVOICE_DELIVERY_GUARD: an email goes to one to three addresses';
    END IF;
  ELSIF n <> 0 THEN
    RAISE EXCEPTION 'INVOICE_DELIVERY_GUARD: a send marked by hand names no address';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER invoice_delivery_guard
  BEFORE INSERT OR UPDATE ON invoice_delivery
  FOR EACH ROW EXECUTE FUNCTION invoice_delivery_guard();


-- ── 2b. A payment's note ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION invoice_payment_note_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  who text := current_setting('app.principal', true);
  who_id text := current_setting('app.principal_id', true);
  at timestamptz := statement_timestamp();
  slack constant interval := interval '5 minutes';
  maintenance boolean := current_setting('app.invoice_maintenance', true) = 'on' AND current_user = 'app_platform';
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'INVOICE_PAYMENT_NOTE_GUARD: a payment''s note is never changed — undo the payment and mark it again';
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- Its invoice's deletion (platform maintenance only) cascades: inside the
    -- cascade's own trigger the depth is above one (slice 99's probe).
    IF pg_trigger_depth() > 1 OR maintenance THEN
      RETURN OLD;
    END IF;
    IF who IS DISTINCT FROM 'member' OR NOT invoice_member_holds(OLD.tenant_id, who_id, 'invoice:record_payment') THEN
      RAISE EXCEPTION 'INVOICE_PAYMENT_NOTE_GUARD: only a member who may record payments removes a payment''s note';
    END IF;
    -- Only once the payment is undone: a paid (or paid-then-credited) invoice
    -- keeps its note.
    IF EXISTS (SELECT 1 FROM invoice i
                WHERE i.tenant_id = OLD.tenant_id AND i.id = OLD.invoice_id
                  AND i.status IN ('PAID', 'CREDITED') AND i.paid_on IS NOT NULL) THEN
      RAISE EXCEPTION 'INVOICE_PAYMENT_NOTE_GUARD: a paid invoice keeps its payment''s note';
    END IF;
    RETURN OLD;
  END IF;
  -- INSERT: by a member as themselves who may record payments, now, right
  -- after THIS transaction moved the invoice to PAID — the move's marker
  -- (`invoice_guard` sets `app.invoice_paid_now`) and the row's xmin both — a
  -- note is written with its payment, never added to an old one.
  IF who IS DISTINCT FROM 'member' OR NEW.created_by_member_id IS DISTINCT FROM who_id THEN
    RAISE EXCEPTION 'INVOICE_PAYMENT_NOTE_GUARD: a member writes a payment''s note, as themselves';
  END IF;
  IF NOT invoice_member_holds(NEW.tenant_id, who_id, 'invoice:record_payment') THEN
    RAISE EXCEPTION 'INVOICE_PAYMENT_NOTE_GUARD: only a member who may record payments writes a payment''s note';
  END IF;
  IF NEW.created_at < at - slack OR NEW.created_at > at + slack THEN
    RAISE EXCEPTION 'INVOICE_PAYMENT_NOTE_GUARD: a note is written when its payment is';
  END IF;
  IF current_setting('app.invoice_paid_now', true) IS DISTINCT FROM NEW.invoice_id
     OR NOT EXISTS (SELECT 1 FROM invoice i
                     WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.invoice_id AND i.client_id = NEW.client_id
                       AND i.kind = 'INVOICE' AND i.status = 'PAID'
                       AND i.xmin = pg_current_xact_id()::xid) THEN
    RAISE EXCEPTION 'INVOICE_PAYMENT_NOTE_GUARD: a note is written with its payment, in the same transaction';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER invoice_payment_note_guard
  BEFORE INSERT OR UPDATE OR DELETE ON invoice_payment_note
  FOR EACH ROW EXECUTE FUNCTION invoice_payment_note_guard();


-- ── 3. The invoice's guard, replaced ───────────────────────────────
-- Everything 108b held is held unchanged (its header and 108's are the
-- reference); what is new is marked (109).
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


-- ── Grants (deny-default, explicit per table) ───────────────────────
-- A send is recorded and read; never changed, never deleted (an invoice's
-- deletion — platform maintenance only — cascades).
GRANT SELECT, INSERT ON invoice_delivery TO app_runtime;
-- app_platform already covers new tables via ALTER DEFAULT PRIVILEGES.

-- ── RLS: invoice_delivery — class A (portal_deny) ───────────────────
ALTER TABLE invoice_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_delivery FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON invoice_delivery
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON invoice_delivery
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

-- ── RLS: invoice_payment_note — class A (portal_deny) ───────────────
-- Written with a payment, deleted when it is undone (its guard); never changed.
GRANT SELECT, INSERT, DELETE ON invoice_payment_note TO app_runtime;

ALTER TABLE invoice_payment_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_payment_note FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON invoice_payment_note
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON invoice_payment_note
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');


-- ── 4. RLS: invoice becomes CLASS B (status-structural) ─────────────
DROP POLICY portal_deny ON invoice;

-- A contact reads an invoice or credit note of their own client once it is
-- issued AND sent (C79 (b)); a contact writes none (WITH CHECK, the
-- `credential_item` precedent).
CREATE POLICY portal_gate ON invoice
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR (
      client_id = (SELECT current_setting('app.client_id', true))
      AND status <> 'DRAFT'
      AND sent_at IS NOT NULL
    )
  )
  WITH CHECK (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
  );

-- The census's three named denies (20260920230000): INSERT and UPDATE through
-- WITH CHECK, DELETE through USING.
CREATE POLICY portal_no_insert ON invoice
  AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

CREATE POLICY portal_no_update ON invoice
  AS RESTRICTIVE FOR UPDATE TO app_runtime
  WITH CHECK ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

CREATE POLICY portal_no_delete ON invoice
  AS RESTRICTIVE FOR DELETE TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

-- Money is a MAIN contact's (AUTHZ §8; `portal.invoice.view` is
-- CONTACT_PRIMARY's): a contact principal reads no invoice while their own row
-- says otherwise — read under their own RLS, as `authorizePortal` reads it, so
-- a demotion bites at once. ANDs with `portal_gate`; it can only narrow, and
-- `isolation.dbtest.ts` pins it by name.
CREATE POLICY portal_invoice_primary ON invoice
  AS RESTRICTIVE FOR SELECT TO app_runtime
  USING (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR (SELECT EXISTS (
          SELECT 1 FROM contact c
           WHERE c.id = current_setting('app.principal_id', true)
             AND c.portal_profile = 'CONTACT_PRIMARY'))
  );
