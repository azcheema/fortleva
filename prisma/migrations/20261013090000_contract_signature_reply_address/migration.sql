-- ═══════════════════════════════════════════════════════════════════
-- Phase 4 slice 112b2 — THE AGENCY'S SIGNATURE NAMES THE WORKSPACE'S REPLY
-- ADDRESS, NEVER A MEMBER'S LOGIN (founder decision C85 (e), 2026-10-11).
-- docs/research/2026-10-10-slice-112-contracts-design.md §13 item 1.
--
-- Until now `contract_signature_guard` copied the SENDER'S LOGIN EMAIL onto
-- the agency's signature row (`"user".email`), and a client reads that row
-- (`portal_gate` on `contract_signature`) and its printed copy. C85 (e): the
-- signed copy prints the workspace's REPLY ADDRESS beside the agency's
-- signature — the one Settings → Preferences confirms and the client mails
-- already use — and the sender's name alone when none is set; a member's own
-- login email is never shown to a client.
--
-- 1. `contract_signature.signer_email` becomes NULLABLE — on a TENANT row only:
--    a CHECK keeps the client signer's address, which the guard copies from
--    `contact`, NOT NULL.
-- 2. `contract_signature_guard` REPLACED, equivalent to what 20261012090000
--    wrote (every RAISE, every forced column, the DELETE / INSERT / UPDATE
--    paths; the not-found check is now `IF NOT FOUND` after each branch's
--    read, and the client's address is lower-cased in its read) but for the
--    TENANT row's address: the workspace's CONFIRMED reply address
--    (`tenant_preference` `mail.replyTo`, an object with a string `email`, a
--    string `confirmedAt` and a `requestedByMemberId` key —
--    `parseConfirmedReplyAddress`'s shape), lower-cased and trimmed; else
--    NULL. NEVER the owner fallback
--    `resolveReplyAddress` uses when none is confirmed: that fallback IS a
--    member's login email. The pending address (`mail.replyToPending`) is not
--    confirmed and is never read. Frozen at sending, like every other value
--    the guard copies: a later change of the reply address does not rewrite a
--    sent contract.
--
-- DDL only, no DML — no `neon-smoke.yml` dispatch owed. Rows written before
-- this would keep the login email they were given; there are none — counted
-- read-only on dev before applying (2026-10-11: no TENANT signature row in
-- any tenant; the harness tears its tenants down), and contracts are
-- unreleased elsewhere (the TV16 seed is owed).
-- (The pre-apply review's items are taken: this header, the
-- `requestedByMemberId` term, and the tests of a pending, an unconfirmed and
-- an owner-only workspace — `contract-portal.dbtest.ts`.)
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. The column ───────────────────────────────────────────────────
ALTER TABLE contract_signature ALTER COLUMN signer_email DROP NOT NULL;

ALTER TABLE contract_signature
  ADD CONSTRAINT contract_signature_client_email CHECK (party = 'TENANT' OR signer_email IS NOT NULL);


-- ── 2. contract_signature_guard, replaced ───────────────────────────
CREATE OR REPLACE FUNCTION contract_signature_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  who text := current_setting('app.principal', true);
  who_id text := current_setting('app.principal_id', true);
  maintenance boolean := current_setting('app.contract_maintenance', true) = 'on' AND current_user = 'app_platform';
  k record;
  person record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Only with its contract (a draft's — none has any — or a tenant's
    -- teardown), never on its own.
    IF maintenance OR pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'CONTRACT_SIGNATURE_GUARD: a signature is never deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- During the send that marked this transaction, by its sender.
    IF who IS DISTINCT FROM 'member' OR current_setting('app.contract_sent_now', true) IS DISTINCT FROM NEW.contract_id THEN
      RAISE EXCEPTION 'CONTRACT_SIGNATURE_GUARD: signatures are written by the send';
    END IF;
    SELECT c.status, c.sent_by_member_id, c.signer_contact_id, c.content_sha256 INTO k
      FROM contract c
     WHERE c.tenant_id = NEW.tenant_id AND c.client_id = NEW.client_id AND c.id = NEW.contract_id;
    IF NOT FOUND OR k.status <> 'SENT' OR k.sent_by_member_id IS DISTINCT FROM who_id THEN
      RAISE EXCEPTION 'CONTRACT_SIGNATURE_GUARD: signatures are written by the send';
    END IF;
    NEW.content_sha256 := k.content_sha256;
    NEW.level := 'SES';
    NEW.ip := NULL;
    NEW.user_agent := NULL;
    NEW.created_at := clock_timestamp();
    IF NEW.party = 'TENANT' THEN
      -- The sender's own signature, made as they send (C84 (b)).
      IF NEW.signer_member_id IS DISTINCT FROM who_id OR NEW.signer_contact_id IS NOT NULL
         OR NEW.status <> 'SIGNED' OR NEW.typed_name IS NULL OR NEW.decline_reason IS NOT NULL THEN
        RAISE EXCEPTION 'CONTRACT_SIGNATURE_GUARD: the agency signs as the sender, as they send';
      END IF;
      -- The sender's NAME, and the WORKSPACE'S confirmed reply address — never
      -- the sender's login email (C85 (e)); NULL when none is confirmed.
      SELECT u.name AS name,
             (SELECT NULLIF(lower(btrim(p.value ->> 'email')), '')
                FROM tenant_preference p
               WHERE p.tenant_id = NEW.tenant_id AND p.key = 'mail.replyTo'
                 AND jsonb_typeof(p.value -> 'email') = 'string'
                 AND jsonb_typeof(p.value -> 'confirmedAt') = 'string'
                 AND p.value ? 'requestedByMemberId') AS email
        INTO person
        FROM member m JOIN "user" u ON u.id = m.user_id
       WHERE m.tenant_id = NEW.tenant_id AND m.id = who_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'CONTRACT_SIGNATURE_GUARD: a signer is a person of the record';
      END IF;
      NEW.decided_at := clock_timestamp();
    ELSE
      -- The client's row, waiting for the signer the contract names.
      IF NEW.signer_contact_id IS DISTINCT FROM k.signer_contact_id OR NEW.signer_member_id IS NOT NULL
         OR NEW.status <> 'PENDING' OR NEW.typed_name IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.decline_reason IS NOT NULL THEN
        RAISE EXCEPTION 'CONTRACT_SIGNATURE_GUARD: the client''s signature waits for the contract''s signer';
      END IF;
      SELECT c.name AS name, lower(c.email) AS email INTO person
        FROM contact c
       WHERE c.tenant_id = NEW.tenant_id AND c.client_id = NEW.client_id AND c.id = NEW.signer_contact_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'CONTRACT_SIGNATURE_GUARD: a signer is a person of the record';
      END IF;
    END IF;
    -- Names and addresses from the record, never the app's.
    NEW.signer_name := person.name;
    NEW.signer_email := person.email;
    RETURN NEW;
  END IF;

  -- UPDATE: only a contact deciding their own pending row (the census's
  -- policy and column trigger say which row and which columns; this says the
  -- move). Nobody else changes a signature.
  IF who IS DISTINCT FROM 'contact' THEN
    RAISE EXCEPTION 'CONTRACT_SIGNATURE_GUARD: only the signer decides, in the portal';
  END IF;
  IF OLD.party <> 'CLIENT' OR OLD.status <> 'PENDING' OR NEW.status NOT IN ('SIGNED', 'DECLINED')
     OR OLD.signer_contact_id IS DISTINCT FROM who_id THEN
    RAISE EXCEPTION 'CONTRACT_SIGNATURE_GUARD: a pending signature is decided once, by its signer';
  END IF;
  -- Dated by the DATABASE, whatever the signer's request said (the pre-apply
  -- review's low: a contact could otherwise backdate their own evidence).
  NEW.decided_at := clock_timestamp();
  IF NEW.status = 'SIGNED' AND NEW.decline_reason IS NOT NULL THEN
    RAISE EXCEPTION 'CONTRACT_SIGNATURE_GUARD: a signature gives no reason to decline';
  END IF;
  RETURN NEW;
END
$fn$;
