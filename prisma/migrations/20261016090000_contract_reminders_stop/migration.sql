-- ═══════════════════════════════════════════════════════════════════
-- Phase 4 slice 112c3 — "REMIND BEFORE IT ENDS", A SWITCH ON A SIGNED
-- CONTRACT (founder decision C87 (a), 2026-10-11). DATA_MODEL.md §6.6, §6.17;
-- the design: docs/research/2026-10-10-slice-112-contracts-design.md §16.
--
-- A signed contract with an end date is reminded at 60 / 30 / 14 / 7 / 1 days
-- and listed on Renewals (slice 112c2). One that has been renewed — or will
-- not be — can now be told to stop: `reminders_stopped_at`, when it was
-- stopped (NULL = reminding). The reminder job, the send's re-read, the
-- job's discovery and Renewals all read only contracts with it NULL.
--
-- 1. `contract.reminders_stopped_at timestamptz NULL` — the table's grants
--    are table-level, so it is covered.
-- 2. CHECK `contract_reminders_stop_signed`: only a SIGNED contract carries a
--    stop (SIGNED is terminal, so a stop can never strand). No other CHECK's
--    name contains it, nor it another's (`dbErrorMapper`'s rule).
-- 3. `contract_guard` REPLACED — every branch of 20261014090000 word for word,
--    plus: an INSERT carries no stop (both origins); and a NEW UPDATE act,
--    after "a member's act, as themselves" and before the uploaded branches —
--    a statement that changes `reminders_stopped_at` and nothing else (but the
--    guard's own `updated_at`), by a member holding `contract:edit`, on a
--    SIGNED contract, a stop stamped NOW (± five minutes), a resume NULL.
--    Every other act compares the whole row less its own columns, none of
--    which is the new one, so no send, signature, withdrawal, PDF write or
--    uploaded edit can change it.
--
-- New token `CONTRACT_NOT_SIGNED` (mapped by `src/modules/contracts/db-errors.ts`
-- — the service asks first, so it is the belt for a race); no token contains
-- another.
--
-- DDL only, no DML — no `neon-smoke.yml` dispatch owed. The CHECK validates
-- every existing row: the column is new and NULL.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE contract ADD COLUMN reminders_stopped_at TIMESTAMPTZ(6);

ALTER TABLE contract
  ADD CONSTRAINT contract_reminders_stop_signed CHECK (reminders_stopped_at IS NULL OR status = 'SIGNED');


CREATE OR REPLACE FUNCTION contract_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  who text := current_setting('app.principal', true);
  who_id text := current_setting('app.principal_id', true);
  at timestamptz := statement_timestamp();
  slack constant interval := interval '5 minutes';
  maintenance boolean := current_setting('app.contract_maintenance', true) = 'on' AND current_user = 'app_platform';
  -- The signature trigger's own move (§4): its marker, AND this function
  -- running as that trigger function's owner — which `app_runtime` never is.
  decided boolean := current_setting('app.contract_decided', true) = COALESCE(NEW.id, OLD.id)
                     AND current_user = (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p
                                          WHERE p.oid = 'contract_signature_decided()'::regprocedure);
  -- What a DRAFT may change (slice 112's seven; `updated_at` is now the
  -- guard's own, so it is in no list the app's value could ride on).
  editable constant text[] := ARRAY['title', 'body', 'language', 'signer_contact_id', 'starts_on', 'ends_on', 'updated_at'];
  -- What a send writes.
  sending constant text[] := ARRAY['status', 'sent_at', 'sent_by_member_id', 'parties', 'content_sha256', 'updated_at'];
  -- What a withdrawal writes.
  withdrawing constant text[] := ARRAY['status', 'withdrawn_at', 'withdrawn_by_member_id', 'updated_at'];
  -- What the signature's move writes.
  deciding constant text[] := ARRAY['status', 'signed_on', 'updated_at'];
  pdfs constant text[] := ARRAY['pdf_file_id', 'signed_pdf_file_id', 'updated_at'];
  -- Slice 112c: an UPLOADED contract's two acts (C86 (a), (b)).
  uploaded_details constant text[] := ARRAY['title', 'signed_on', 'starts_on', 'ends_on', 'updated_at'];
  uploaded_showing constant text[] := ARRAY['shown_to_client', 'updated_at'];
  -- Slice 112c3: a SIGNED contract's reminders stopped or turned back on (C87 (a)).
  reminding constant text[] := ARRAY['reminders_stopped_at', 'updated_at'];
  prev record;
  t record;
  cl record;
  fo record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF maintenance THEN
      RETURN OLD;
    END IF;
    IF who = 'contact' THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a contact deletes no contract';
    END IF;
    -- A draft, or a contract signed elsewhere (C86 (b): a wrong one is deleted
    -- and put in again); a written contract past DRAFT never.
    IF OLD.status <> 'DRAFT' AND OLD.origin <> 'UPLOADED' THEN
      RAISE EXCEPTION 'CONTRACT_NOT_DRAFT: only a draft is deleted';
    END IF;
    IF who IS DISTINCT FROM 'member' OR NOT invoice_member_holds(OLD.tenant_id, who_id, 'contract:delete') THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a contract is deleted by a member holding contract:delete';
    END IF;
    RETURN OLD;
  END IF;

  -- A contact writes no contract — except through the signature's move.
  IF who = 'contact' AND NOT decided THEN
    RAISE EXCEPTION 'CONTRACT_GUARD: a contact writes no contract';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF who IS DISTINCT FROM 'member' OR NEW.created_by_member_id IS DISTINCT FROM who_id THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a member starts a contract, as themselves';
    END IF;
    IF NOT invoice_member_holds(NEW.tenant_id, who_id, 'contract:create') THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a contract is started by a member holding contract:create';
    END IF;
    IF NEW.created_at < at - slack OR NEW.created_at > at + slack THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a contract is started now';
    END IF;
    -- Slice 112c3: a contract is born reminding.
    IF NEW.reminders_stopped_at IS NOT NULL THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a contract is put in or started with its reminders on';
    END IF;

    IF NEW.origin = 'UPLOADED' THEN
      -- SIGNED ELSEWHERE (C84 (f)): born signed, never shown, with its file.
      IF NEW.status <> 'SIGNED' OR NEW.version <> 1 OR NEW.supersedes_id IS NOT NULL OR NEW.shown_to_client THEN
        RAISE EXCEPTION 'CONTRACT_GUARD: a contract signed elsewhere is put in signed, version 1, not shown';
      END IF;
      IF NEW.signed_on IS NULL OR NEW.signed_on > (clock_timestamp() AT TIME ZONE 'UTC')::date + 1 THEN
        RAISE EXCEPTION 'CONTRACT_GUARD: a contract signed elsewhere was signed on a day that has come';
      END IF;
      SELECT f.kind, f.status, f.created_by_member_id, f.r2_key, f.content_type INTO fo
        FROM file_object f
       WHERE f.tenant_id = NEW.tenant_id AND f.id = NEW.signed_pdf_file_id;
      IF NOT FOUND OR fo.kind <> 'CONTRACT_PDF' OR fo.status <> 'COMMITTED' OR fo.content_type <> 'application/pdf'
         OR fo.created_by_member_id IS DISTINCT FROM who_id
         OR left(fo.r2_key, char_length(NEW.tenant_id) + 1) <> NEW.tenant_id || '/' THEN
        RAISE EXCEPTION 'CONTRACT_GUARD: a contract signed elsewhere is its own uploaded PDF';
      END IF;
      IF EXISTS (SELECT 1 FROM contract o
                  WHERE o.tenant_id = NEW.tenant_id
                    AND (o.pdf_file_id = NEW.signed_pdf_file_id OR o.signed_pdf_file_id = NEW.signed_pdf_file_id)) THEN
        RAISE EXCEPTION 'CONTRACT_GUARD: a contract''s PDF is its own';
      END IF;
      NEW.updated_at := clock_timestamp();
      RETURN NEW;
    END IF;

    IF NEW.status <> 'DRAFT' OR NEW.origin <> 'WRITTEN' THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a new contract is a written draft';
    END IF;
    IF NEW.supersedes_id IS NULL THEN
      IF NEW.version <> 1 THEN
        RAISE EXCEPTION 'CONTRACT_GUARD: a first contract is version 1';
      END IF;
    ELSE
      -- A NEW VERSION of a declined or withdrawn contract of the same client.
      SELECT c.status, c.version INTO prev FROM contract c
       WHERE c.tenant_id = NEW.tenant_id AND c.client_id = NEW.client_id AND c.id = NEW.supersedes_id;
      IF NOT FOUND OR prev.status NOT IN ('DECLINED', 'WITHDRAWN') THEN
        RAISE EXCEPTION 'CONTRACT_NOT_REPLACEABLE: only a declined or withdrawn contract gets a new version';
      END IF;
      IF NEW.version <> prev.version + 1 THEN
        RAISE EXCEPTION 'CONTRACT_GUARD: a new version is the next number';
      END IF;
    END IF;
    IF NEW.signer_contact_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM contact c
                        WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.signer_contact_id
                          AND c.client_id = NEW.client_id) THEN
      RAISE EXCEPTION 'CONTRACT_SIGNER_INVALID: the signer is a contact of the contract''s client';
    END IF;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;

  -- UPDATE. The database's own clock, whatever the app sent.
  NEW.updated_at := clock_timestamp();

  -- The signature's move: SENT → SIGNED | DECLINED, nothing else.
  IF decided THEN
    IF OLD.status <> 'SENT' OR NEW.status NOT IN ('SIGNED', 'DECLINED')
       OR (to_jsonb(NEW) - deciding) IS DISTINCT FROM (to_jsonb(OLD) - deciding)
       OR (NEW.status = 'DECLINED' AND NEW.signed_on IS NOT NULL) THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a signature moves a sent contract to signed or declined only';
    END IF;
    RETURN NEW;
  END IF;

  IF who IS DISTINCT FROM 'member' AND who IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'CONTRACT_GUARD: a member or the system writes a contract';
  END IF;

  -- The PDFs, set once: no status move, nothing else changed.
  IF NEW.status = OLD.status
     AND (NEW.pdf_file_id IS DISTINCT FROM OLD.pdf_file_id OR NEW.signed_pdf_file_id IS DISTINCT FROM OLD.signed_pdf_file_id) THEN
    IF (to_jsonb(NEW) - pdfs) IS DISTINCT FROM (to_jsonb(OLD) - pdfs) THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a PDF is set on its own';
    END IF;
    IF who = 'member' AND NOT invoice_member_holds(OLD.tenant_id, who_id, 'contract:view') THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a PDF is made by a member who may view the contract';
    END IF;
    -- One file is one contract's, in one column: never another contract's PDF
    -- pointed at (that would show one client another's contract — the
    -- pre-apply review's low), nor the same file as both.
    IF NEW.pdf_file_id IS NOT NULL AND NEW.pdf_file_id IS NOT DISTINCT FROM NEW.signed_pdf_file_id THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: the PDF as sent and the signed copy are two files';
    END IF;
    IF EXISTS (SELECT 1 FROM contract o
                WHERE o.tenant_id = NEW.tenant_id AND o.id <> NEW.id
                  AND (   (NEW.pdf_file_id IS DISTINCT FROM OLD.pdf_file_id
                           AND (o.pdf_file_id = NEW.pdf_file_id OR o.signed_pdf_file_id = NEW.pdf_file_id))
                       OR (NEW.signed_pdf_file_id IS DISTINCT FROM OLD.signed_pdf_file_id
                           AND (o.pdf_file_id = NEW.signed_pdf_file_id OR o.signed_pdf_file_id = NEW.signed_pdf_file_id)))) THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a contract''s PDF is its own';
    END IF;
    -- (An UPLOADED contract's file is set at its INSERT and never again: both
    -- tests below refuse any origin but WRITTEN.)
    IF NEW.pdf_file_id IS DISTINCT FROM OLD.pdf_file_id
       AND (OLD.pdf_file_id IS NOT NULL OR OLD.origin <> 'WRITTEN' OR OLD.status = 'DRAFT') THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: the PDF as sent is set once, on a sent contract';
    END IF;
    IF NEW.signed_pdf_file_id IS DISTINCT FROM OLD.signed_pdf_file_id
       AND (OLD.signed_pdf_file_id IS NOT NULL OR OLD.origin <> 'WRITTEN' OR OLD.status <> 'SIGNED') THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: the signed copy is set once, on a signed contract';
    END IF;
    IF (NEW.pdf_file_id IS NOT NULL AND NEW.pdf_file_id IS DISTINCT FROM OLD.pdf_file_id
        AND NOT EXISTS (SELECT 1 FROM file_object f WHERE f.tenant_id = NEW.tenant_id AND f.id = NEW.pdf_file_id AND f.kind = 'CONTRACT_PDF'))
       OR (NEW.signed_pdf_file_id IS NOT NULL AND NEW.signed_pdf_file_id IS DISTINCT FROM OLD.signed_pdf_file_id
        AND NOT EXISTS (SELECT 1 FROM file_object f WHERE f.tenant_id = NEW.tenant_id AND f.id = NEW.signed_pdf_file_id AND f.kind = 'CONTRACT_PDF')) THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a contract''s PDF is a contract PDF of its workspace';
    END IF;
    RETURN NEW;
  END IF;

  -- Everything else is a member's act, as themselves.
  IF who IS DISTINCT FROM 'member' THEN
    RAISE EXCEPTION 'CONTRACT_GUARD: only a contract''s PDF is the system''s to write';
  END IF;

  -- A SIGNED CONTRACT'S REMINDERS (slice 112c3, C87 (a)): stopped — stamped
  -- now — or turned back on (NULL), by a holder of `contract:edit`, and
  -- nothing else in the same statement. Written or signed elsewhere alike.
  IF NEW.reminders_stopped_at IS DISTINCT FROM OLD.reminders_stopped_at THEN
    IF (to_jsonb(NEW) - reminding) IS DISTINCT FROM (to_jsonb(OLD) - reminding) THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a contract''s reminders change on their own';
    END IF;
    IF OLD.status <> 'SIGNED' THEN
      RAISE EXCEPTION 'CONTRACT_NOT_SIGNED: only a signed contract''s reminders are stopped';
    END IF;
    IF NOT invoice_member_holds(OLD.tenant_id, who_id, 'contract:edit') THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a contract''s reminders are changed by a member holding contract:edit';
    END IF;
    IF NEW.reminders_stopped_at IS NOT NULL
       AND (NEW.reminders_stopped_at < at - slack OR NEW.reminders_stopped_at > at + slack) THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a contract''s reminders are stopped now';
    END IF;
    RETURN NEW;
  END IF;

  -- A CONTRACT SIGNED ELSEWHERE (slice 112c): its details, or its showing —
  -- one act per statement; nothing else of it ever changes.
  IF OLD.origin = 'UPLOADED' THEN
    IF (to_jsonb(NEW) - uploaded_details) IS NOT DISTINCT FROM (to_jsonb(OLD) - uploaded_details) THEN
      IF NOT invoice_member_holds(OLD.tenant_id, who_id, 'contract:edit') THEN
        RAISE EXCEPTION 'CONTRACT_GUARD: a contract signed elsewhere is edited by a member holding contract:edit';
      END IF;
      IF NEW.signed_on IS NULL OR NEW.signed_on > (clock_timestamp() AT TIME ZONE 'UTC')::date + 1 THEN
        RAISE EXCEPTION 'CONTRACT_GUARD: a contract signed elsewhere was signed on a day that has come';
      END IF;
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - uploaded_showing) IS NOT DISTINCT FROM (to_jsonb(OLD) - uploaded_showing) THEN
      IF NOT invoice_member_holds(OLD.tenant_id, who_id, 'contract:send') THEN
        RAISE EXCEPTION 'CONTRACT_GUARD: a contract is shown to the client by a member holding contract:send';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'CONTRACT_GUARD: a contract signed elsewhere changes its details or its showing, one at a time';
  END IF;

  -- A DRAFT's edit.
  IF OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' THEN
    IF NOT invoice_member_holds(OLD.tenant_id, who_id, 'contract:edit') THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a draft is edited by a member holding contract:edit';
    END IF;
    IF (to_jsonb(NEW) - editable) IS DISTINCT FROM (to_jsonb(OLD) - editable) THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: only a draft''s title, text, language, signer and dates change';
    END IF;
    IF NEW.signer_contact_id IS DISTINCT FROM OLD.signer_contact_id
       AND NEW.signer_contact_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM contact c
                        WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.signer_contact_id
                          AND c.client_id = NEW.client_id) THEN
      RAISE EXCEPTION 'CONTRACT_SIGNER_INVALID: the signer is a contact of the contract''s client';
    END IF;
    RETURN NEW;
  END IF;

  -- THE SEND.
  IF OLD.status = 'DRAFT' AND NEW.status = 'SENT' THEN
    IF NOT invoice_member_holds(OLD.tenant_id, who_id, 'contract:send') THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a contract is sent by a member holding contract:send';
    END IF;
    IF NEW.sent_by_member_id IS DISTINCT FROM who_id OR NEW.sent_at IS NULL
       OR NEW.sent_at < at - slack OR NEW.sent_at > at + slack THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a member sends a contract as themselves, now';
    END IF;
    IF OLD.origin <> 'WRITTEN' OR OLD.body IS NULL
       OR NOT jsonb_path_exists(OLD.body, '$.** ? (@.type == "text")') THEN
      RAISE EXCEPTION 'CONTRACT_NOT_READY: a contract to send has its text';
    END IF;
    IF OLD.body::text ~ '[{][{](client_name|client_org_nr|client_address|signer_name|agency_name|agency_org_nr|agency_address|today)[}][}]' THEN
      RAISE EXCEPTION 'CONTRACT_FILL_INS_LEFT: a fill-in is still in the text';
    END IF;
    IF OLD.signer_contact_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM contact c
                       WHERE c.tenant_id = OLD.tenant_id AND c.id = OLD.signer_contact_id AND c.client_id = OLD.client_id
                         AND c.portal_status = 'ACTIVE' AND c.portal_profile = 'CONTACT_PRIMARY') THEN
      RAISE EXCEPTION 'CONTRACT_SIGNER_INVALID: the signer is a main contact of the client, in the portal';
    END IF;
    -- Every column a send does not write is as the draft left it.
    NEW.parties := OLD.parties; -- rebuilt below; the app's value never counts
    NEW.content_sha256 := OLD.content_sha256;
    IF (to_jsonb(NEW) - sending) IS DISTINCT FROM (to_jsonb(OLD) - sending) THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a send writes only what a send writes';
    END IF;
    SELECT tn.name, tn.legal_name, tn.org_nr, tn.address_line1, tn.address_line2, tn.postal_code, tn.city, tn.country_code
      INTO t FROM tenant tn WHERE tn.id = OLD.tenant_id;
    SELECT c.name, c.org_nr, c.address_line1, c.address_line2, c.postal_code, c.city, c.country_code
      INTO cl FROM client c WHERE c.tenant_id = OLD.tenant_id AND c.id = OLD.client_id;
    NEW.parties := jsonb_build_object(
      'agency', jsonb_build_object(
        'name', COALESCE(NULLIF(btrim(t.legal_name), ''), t.name),
        'orgNr', NULLIF(btrim(t.org_nr), ''),
        'addressLine1', NULLIF(btrim(t.address_line1), ''),
        'addressLine2', NULLIF(btrim(t.address_line2), ''),
        'postalCode', NULLIF(btrim(t.postal_code), ''),
        'city', NULLIF(btrim(t.city), ''),
        'countryCode', t.country_code),
      'client', jsonb_build_object(
        'name', cl.name,
        'orgNr', NULLIF(btrim(cl.org_nr), ''),
        'addressLine1', NULLIF(btrim(cl.address_line1), ''),
        'addressLine2', NULLIF(btrim(cl.address_line2), ''),
        'postalCode', NULLIF(btrim(cl.postal_code), ''),
        'city', NULLIF(btrim(cl.city), ''),
        'countryCode', cl.country_code));
    -- THE FINGERPRINT both signatures attest to: the frozen record, as
    -- Postgres writes it (jsonb's text form is canonical), hashed HERE.
    NEW.content_sha256 := encode(sha256(convert_to(jsonb_build_object(
      'id', NEW.id,
      'version', NEW.version,
      'client_id', NEW.client_id,
      'title', NEW.title,
      'language', NEW.language,
      'starts_on', NEW.starts_on,
      'ends_on', NEW.ends_on,
      'signer_contact_id', NEW.signer_contact_id,
      'parties', NEW.parties,
      'body', NEW.body)::text, 'UTF8')), 'hex');
    -- The signature rows' guard admits their INSERT during THIS send only.
    PERFORM set_config('app.contract_sent_now', NEW.id, true);
    RETURN NEW;
  END IF;

  -- WITHDRAW.
  IF OLD.status = 'SENT' AND NEW.status = 'WITHDRAWN' THEN
    IF NOT invoice_member_holds(OLD.tenant_id, who_id, 'contract:send') THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a contract is withdrawn by a member holding contract:send';
    END IF;
    IF NEW.withdrawn_by_member_id IS DISTINCT FROM who_id OR NEW.withdrawn_at IS NULL
       OR NEW.withdrawn_at < at - slack OR NEW.withdrawn_at > at + slack
       OR (to_jsonb(NEW) - withdrawing) IS DISTINCT FROM (to_jsonb(OLD) - withdrawing) THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a member withdraws a contract as themselves, now, and changes nothing else';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'DRAFT' AND NEW.status = OLD.status THEN
    RAISE EXCEPTION 'CONTRACT_NOT_DRAFT: a sent contract never changes';
  END IF;
  RAISE EXCEPTION 'CONTRACT_NOT_OPEN: that contract cannot move from % to %', OLD.status, NEW.status;
END
$fn$;
