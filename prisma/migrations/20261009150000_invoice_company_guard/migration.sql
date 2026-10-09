-- ═══════════════════════════════════════════════════════════════════
-- Phase 4 slice 107, its fix-pass — THE COMPANY DETAILS PRINTED ON EVERY
-- INVOICE GET THE PAYMENT DETAILS' PROTECTION (founder decision C75 (j),
-- 2026-10-09, asked after the security review found that an address line
-- could say "pay only to Bankgiro …" with no code and no owner mail —
-- the same gap C75 (i) closed for the invoice note).
--
-- `tenant_payment_details_guard` (migration 20261009120000) is REPLACED in
-- place, under the same name and trigger, to judge ten more columns: the
-- legal name, org. number, VAT number, registered office, F-tax approval and
-- the address (two lines, postal code, city, country) — everything the
-- company card writes and every invoice prints. On the application's runtime
-- role a change to any of the fifteen needs an ACTIVE member, as the
-- principal, holding `settings:edit` through a role (read as
-- `effectivePermissions` reads it). The application adds the code typed in
-- the form (a one-minute window) and the mail to every owner
-- (`src/modules/invoicing/seller.ts`). The platform and owner roles —
-- support scripts, test fixtures — are not judged (unchanged; the security
-- review's low about the role test is dispositioned in PLAN §0: the runtime
-- connects as `app_runtime` in every environment we provision).
--
-- The refusal's token becomes `TENANT_INVOICE_DETAILS_GUARD` (it covers more
-- than payment now); nothing maps it — a refusal is a bug, not a sentence.
--
-- No new table, no grant, no policy, no data change — a function body only.
-- DDL only, no DML — no `neon-smoke.yml` dispatch owed.
-- ═══════════════════════════════════════════════════════════════════

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
  AND NEW.invoice_footer_note IS NOT DISTINCT FROM OLD.invoice_footer_note
  AND NEW.legal_name IS NOT DISTINCT FROM OLD.legal_name
  AND NEW.org_nr IS NOT DISTINCT FROM OLD.org_nr
  AND NEW.vat_number IS NOT DISTINCT FROM OLD.vat_number
  AND NEW.seat IS NOT DISTINCT FROM OLD.seat
  AND NEW.f_skatt_approved IS NOT DISTINCT FROM OLD.f_skatt_approved
  AND NEW.address_line1 IS NOT DISTINCT FROM OLD.address_line1
  AND NEW.address_line2 IS NOT DISTINCT FROM OLD.address_line2
  AND NEW.postal_code IS NOT DISTINCT FROM OLD.postal_code
  AND NEW.city IS NOT DISTINCT FROM OLD.city
  AND NEW.country_code IS NOT DISTINCT FROM OLD.country_code THEN
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
    RAISE EXCEPTION 'TENANT_INVOICE_DETAILS_GUARD: only a member who may edit the workspace''s settings changes what its invoices say about it';
  END IF;
  RETURN NEW;
END
$fn$;
