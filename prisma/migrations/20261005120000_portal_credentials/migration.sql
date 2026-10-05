-- ═══════════════════════════════════════════════════════════════════
-- Phase 3V slice 91 — THE CLIENT SIDE OF THE EVERYDAY VAULT (founder
-- decisions C52 (d) and (k), C59): a client's main contact sees the
-- logins the agency marks "client can see", only while the agency has
-- `vault.allowPortalCredentials` switched on, and opens them with their
-- portal password AND a six-digit code mailed each time.
-- DATA_MODEL.md §6.17; TENANCY.md §7.2; SECURITY.md §6; AUTHZ.md §8.
--
-- THREE CHANGES, each the smallest the decision needs.
--
-- 1. `credential_item_internal_only` GOES, by name — the visible DROP
--    the vault core (20261001120000) promised the slice that builds
--    portal-persistent credentials. `portal_gate` is unchanged: the
--    standard two-term gate (`client_id = app.client_id AND visibility
--    = 'CLIENT_VISIBLE'`), clientScoped, no `portal_enabled` — a login is
--    never a project surface on the portal (TENANCY.md §7.2). The
--    `credential_item_client_visible_needs_client` CHECK still refuses a
--    CLIENT_VISIBLE row with no client (C49's agency-own logins can never
--    be shown).
--
-- 2. THE SWITCH LIVES IN THE DATABASE (`portal_vault_switch`): a
--    RESTRICTIVE SELECT policy that gives a CONTACT principal no row of
--    `credential_item` unless the tenant's `vault.allowPortalCredentials`
--    preference is literally `true` — and, as belts for rules the
--    application also keeps, only while the contact is a MAIN contact
--    (`portal_profile = 'CONTACT_PRIMARY'`, C59 (a); read from their own
--    `contact` row under their own RLS, as `authorizePortal` reads it) and
--    only for a login that is neither binned nor archived. The service
--    also un-marks every login when the switch goes off (C59 (b): hidden
--    for good — the preference service, under an advisory lock that
--    marking takes SHARED), so in the steady state a switched-off tenant
--    has no CLIENT_VISIBLE row at all; this policy is what makes
--    "switched off ⇒ zero rows" true at every instant for every
--    CONTACT-PRINCIPAL read, present or future, without trusting that
--    protocol or any projection. IT DOES NOT BIND A SYSTEM-PRINCIPAL READ:
--    the portal's reveal broker reads the secret as SYSTEM after the
--    contact's own proof, and must — and does — restate the switch, the
--    client, CLIENT_VISIBLE and the bin itself
--    (`src/modules/vault/portal-writes.ts`). It ANDs with `portal_gate`
--    (both RESTRICTIVE), so it can only narrow — the posture test
--    (`isolation.dbtest.ts`) needs no declaration for it.
--
--    `tenant_preference` is class A (`portal_deny`), so a contact cannot
--    read the preference itself; `vault_portal_credentials_on()` reads it
--    as its OWNER (SECURITY DEFINER), the pattern `search_lang` set in
--    20260820170000: one fixed key, for `app.tenant_id` only, and the
--    only fact returned is a boolean — no row, no value, no other key.
--    search_path pinned; EXECUTE for `app_runtime` only. It FAILS CLOSED:
--    a missing row, a value that is not the JSON literal `true`, an unset
--    tenant GUC — all `false`. It relies on its owner (the migration role)
--    bypassing row security, as `search_lang` does: an owner that did not
--    would get zero rows of the FORCE-RLS `tenant_preference` (its
--    policies are all `TO app_runtime`), which is `false` again — zero
--    rows, never more, and a feature that silently shows clients nothing;
--    `portal-logins.dbtest.ts` proves the positive case (switch on ⇒ the
--    contact sees the row) on the database the migrations ran on. Both
--    subqueries are uncorrelated `(SELECT …)`s, so the planner evaluates
--    each once per statement (an initplan), not once per row.
--
-- 3. `contact_vault_unlock` — THE CLIENT'S DOOR (class A). One row per
--    time a contact opens their logins: created only after their portal
--    password was checked, carrying the first mailed code (HMAC-SHA256
--    of `<id>:<code>` under the server-held `shareCodeKey`, slice 90's
--    keying, so a dump plus a row reverses nothing), then marked open for
--    the vault's step-up window (`vault.stepUpMinutes`, at most fifteen —
--    C59 (c)) when the right code comes back. It is bound to the portal
--    SESSION it was opened in (`session_id`, the `contact_session` row's
--    id — no FK: an auth table, and a row for a dead session opens
--    nothing because nobody can present that session), so a second
--    device, or the same password signed in again, opens nothing without
--    its own code.
--
--    WHO WRITES IT: only the SYSTEM principal of the portal's vault
--    broker (`src/modules/vault/portal-writes.ts`, after
--    `authorizePortal` under the contact's own principal — AUTHZ.md §8's
--    brokered shape). No contact ever reads or writes it (class A:
--    `tenant_isolation` + `portal_deny`), and no member writes it (the
--    guard); a member's transaction can read it, as the tenant's own data
--    export does — which leaves `code_hash` out.
--
--    WHAT THE DATABASE REFUSES, so no writer can loosen what the broker
--    promises: more than five codes or five code checks on one door —
--    five guesses at six digits per opening, the per-contact budget
--    upstream bounding the openings; a new code that is not a counted
--    send; a code that lives past ten minutes; an opening that is not one
--    counted check of a code still live, or that is held open past
--    fifteen minutes from its statement, or that happens twice; counters
--    that go down; a stamp at any time but its own statement's (five
--    minutes of slack); any change to whose door it is. A door is never
--    closed early (no writer shortens `open_until`; it simply lapses).
--    Granted SELECT, INSERT, UPDATE — no DELETE: a row goes with its
--    contact (FK cascade, as the contact's sessions and credentials do);
--    the lasting evidence is the audit trail (`portal.logins_*`,
--    `credential.revealed|copied` with a CONTACT actor).
--
-- DDL only, no DML — no `neon-smoke.yml` dispatch owed.
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. Portal-persistent credentials become possible ────────────────
ALTER TABLE credential_item DROP CONSTRAINT credential_item_internal_only;


-- ── 2. The switch, in the database ──────────────────────────────────
CREATE OR REPLACE FUNCTION vault_portal_credentials_on() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT COALESCE(
    (SELECT p.value = 'true'::jsonb
       FROM tenant_preference p
      WHERE p.tenant_id = current_setting('app.tenant_id', true)
        AND p.key = 'vault.allowPortalCredentials'),
    false)
$fn$;
REVOKE EXECUTE ON FUNCTION vault_portal_credentials_on() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vault_portal_credentials_on() TO app_runtime;

-- The contact branch: the switch on, the reader a MAIN contact (their own
-- row, read under their own RLS — `contact`'s portal_gate admits a
-- contact's own client's rows), the login neither binned nor archived.
CREATE POLICY portal_vault_switch ON credential_item
  AS RESTRICTIVE FOR SELECT TO app_runtime
  USING (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR (
      (SELECT vault_portal_credentials_on())
      AND (SELECT EXISTS (
            SELECT 1 FROM contact c
             WHERE c.id = current_setting('app.principal_id', true)
               AND c.portal_profile = 'CONTACT_PRIMARY'))
      AND deleted_at IS NULL
      AND archived_at IS NULL
    )
  );


-- ── 3. The client's door ────────────────────────────────────────────
-- CreateTable
CREATE TABLE "contact_vault_unlock" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "code_hash" TEXT,
    "code_expires_at" TIMESTAMPTZ(6),
    "code_sent_at" TIMESTAMPTZ(6) NOT NULL,
    "codes_sent" INTEGER NOT NULL DEFAULT 1,
    "code_attempts" INTEGER NOT NULL DEFAULT 0,
    "opened_at" TIMESTAMPTZ(6),
    "open_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_vault_unlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contact_vault_unlock_tenant_id_contact_id_session_id_create_idx" ON "contact_vault_unlock"("tenant_id", "contact_id", "session_id", "created_at");

-- AddForeignKey
ALTER TABLE "contact_vault_unlock" ADD CONSTRAINT "contact_vault_unlock_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_vault_unlock" ADD CONSTRAINT "contact_vault_unlock_tenant_id_contact_id_fkey" FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contact"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── CHECKs — the row's own shape ────────────────────────────────────
ALTER TABLE contact_vault_unlock
  ADD CONSTRAINT contact_vault_unlock_session_id_length
    CHECK (char_length(session_id) BETWEEN 1 AND 64),
  ADD CONSTRAINT contact_vault_unlock_code_hash_shape
    CHECK (code_hash IS NULL OR code_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT contact_vault_unlock_code_pair
    CHECK ((code_hash IS NULL) = (code_expires_at IS NULL)),
  -- A door is made with its first code (the password was checked first),
  -- and never has more than five, or more than five checks of them.
  ADD CONSTRAINT contact_vault_unlock_codes_sent_range
    CHECK (codes_sent BETWEEN 1 AND 5),
  ADD CONSTRAINT contact_vault_unlock_code_attempts_range
    CHECK (code_attempts BETWEEN 0 AND 5),
  -- A live code lives ten minutes from its send.
  ADD CONSTRAINT contact_vault_unlock_code_lifetime
    CHECK (code_expires_at IS NULL OR code_expires_at <= code_sent_at + interval '10 minutes'),
  -- Open = a code was checked; open for at most fifteen minutes (the
  -- step-up window's ceiling, VAULT_STEP_UP_MINUTES_RANGE); no live code
  -- left behind; both stamps or neither.
  ADD CONSTRAINT contact_vault_unlock_open_pair
    CHECK ((opened_at IS NULL) = (open_until IS NULL)),
  ADD CONSTRAINT contact_vault_unlock_opened_with_a_code
    CHECK (opened_at IS NULL OR code_attempts >= 1),
  ADD CONSTRAINT contact_vault_unlock_open_window
    CHECK (open_until IS NULL OR (open_until > opened_at AND open_until <= opened_at + interval '15 minutes')),
  ADD CONSTRAINT contact_vault_unlock_opened_holds_no_code
    CHECK (opened_at IS NULL OR code_hash IS NULL);


-- ── The guard: only the broker writes; born now with its first code;
-- whose door it is never changes; what it has spent is never given back;
-- an opening is once, and stamped now ───────────────────────────────
-- SECURITY INVOKER (the default): it reads nothing but its own row and
-- the transaction's GUCs. Every refusal raises `CONTACT_VAULT_UNLOCK_GUARD`,
-- never a value. Unset GUCs (a platform or owner connection) are
-- NULL/'' and match no rule that writes. (Both FKs say ON UPDATE CASCADE,
-- Prisma's default; a tenant's or contact's id never changes, so the
-- guard turning such a cascade into an error costs nothing.)
CREATE OR REPLACE FUNCTION contact_vault_unlock_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  who text := current_setting('app.principal', true);
BEGIN
  IF who IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'CONTACT_VAULT_UNLOCK_GUARD: only the portal''s vault broker writes a client''s door';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.created_at < statement_timestamp() - interval '5 minutes'
       OR NEW.created_at > statement_timestamp() + interval '5 minutes'
       OR NEW.code_sent_at < statement_timestamp() - interval '5 minutes'
       OR NEW.code_sent_at > statement_timestamp() + interval '5 minutes' THEN
      RAISE EXCEPTION 'CONTACT_VAULT_UNLOCK_GUARD: a door is made now';
    END IF;
    -- Fresh: its first code only, nothing checked, not open.
    IF NEW.codes_sent <> 1 OR NEW.code_attempts <> 0 OR NEW.code_hash IS NULL
       OR NEW.opened_at IS NOT NULL OR NEW.open_until IS NOT NULL THEN
      RAISE EXCEPTION 'CONTACT_VAULT_UNLOCK_GUARD: a new door carries its first code and nothing else';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE. Whose door it is never changes.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'CONTACT_VAULT_UNLOCK_GUARD: a door''s identity cannot change';
  END IF;
  -- What it has spent is never given back.
  IF NEW.codes_sent < OLD.codes_sent OR NEW.code_attempts < OLD.code_attempts
     OR NEW.code_sent_at < OLD.code_sent_at THEN
    RAISE EXCEPTION 'CONTACT_VAULT_UNLOCK_GUARD: a door''s counters only go forward';
  END IF;
  -- Opened once, and never changed after (never closed early either: an
  -- open door simply lapses).
  IF OLD.opened_at IS NOT NULL
     AND (NEW.opened_at IS DISTINCT FROM OLD.opened_at OR NEW.open_until IS DISTINCT FROM OLD.open_until) THEN
    RAISE EXCEPTION 'CONTACT_VAULT_UNLOCK_GUARD: a door is opened once';
  END IF;
  -- One check at a time: every check is counted, singly.
  IF NEW.code_attempts > OLD.code_attempts + 1 THEN
    RAISE EXCEPTION 'CONTACT_VAULT_UNLOCK_GUARD: a door''s checks are counted one at a time';
  END IF;
  -- A new code, a new send stamp or a new expiry is a counted send, and a
  -- send is all three: one more, stamped anew, never on an open door — so
  -- the five-codes bound counts every code a door ever had, and no code's
  -- ten minutes can be renewed without spending a send. (The new hash may
  -- EQUAL the old one: six digits drawn again can repeat, and a counted
  -- repeat is harmless — the second review.)
  IF (NEW.codes_sent IS DISTINCT FROM OLD.codes_sent
        OR NEW.code_sent_at IS DISTINCT FROM OLD.code_sent_at
        OR (NEW.code_hash IS NOT NULL AND NEW.code_hash IS DISTINCT FROM OLD.code_hash)
        OR (NEW.code_expires_at IS NOT NULL AND NEW.code_expires_at IS DISTINCT FROM OLD.code_expires_at))
     AND NOT (NEW.codes_sent = OLD.codes_sent + 1
              AND NEW.code_hash IS NOT NULL
              AND NEW.code_sent_at IS DISTINCT FROM OLD.code_sent_at
              AND OLD.opened_at IS NULL AND NEW.opened_at IS NULL) THEN
    RAISE EXCEPTION 'CONTACT_VAULT_UNLOCK_GUARD: a new code is one counted send';
  END IF;
  -- A code is dropped only by the opening it was checked for.
  IF NEW.code_hash IS NULL AND OLD.code_hash IS NOT NULL AND NEW.opened_at IS NULL THEN
    RAISE EXCEPTION 'CONTACT_VAULT_UNLOCK_GUARD: a door''s code goes only when it opens';
  END IF;
  -- THE OPENING is one counted check of a code that was still live — on
  -- the transaction's clock, the one the broker compared it on — and it
  -- holds the door open at most fifteen minutes past its statement (the
  -- window CHECK alone, measured from a stamp with five minutes' slack,
  -- would allow twenty; the migration's pre-apply review).
  IF OLD.opened_at IS NULL AND NEW.opened_at IS NOT NULL
     AND NOT (OLD.code_hash IS NOT NULL
              AND OLD.code_expires_at > now()
              AND NEW.code_attempts = OLD.code_attempts + 1
              AND NEW.codes_sent = OLD.codes_sent
              AND NEW.open_until <= statement_timestamp() + interval '15 minutes') THEN
    RAISE EXCEPTION 'CONTACT_VAULT_UNLOCK_GUARD: a door opens on one check of a live code, for fifteen minutes at most';
  END IF;
  -- A send and an opening are stamped when they happen — the CHECKs that
  -- bound a code's life and the open window compare these stamps.
  IF (NEW.code_sent_at IS DISTINCT FROM OLD.code_sent_at
        AND (NEW.code_sent_at < statement_timestamp() - interval '5 minutes'
             OR NEW.code_sent_at > statement_timestamp() + interval '5 minutes'))
     OR (NEW.opened_at IS DISTINCT FROM OLD.opened_at
        AND (NEW.opened_at < statement_timestamp() - interval '5 minutes'
             OR NEW.opened_at > statement_timestamp() + interval '5 minutes')) THEN
    RAISE EXCEPTION 'CONTACT_VAULT_UNLOCK_GUARD: a door''s send and opening are stamped now';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER contact_vault_unlock_guard
  BEFORE INSERT OR UPDATE ON contact_vault_unlock
  FOR EACH ROW EXECUTE FUNCTION contact_vault_unlock_guard();


-- ── Grants (deny-default, explicit per table) ───────────────────────
GRANT SELECT, INSERT, UPDATE ON contact_vault_unlock TO app_runtime;
-- app_platform already covers new tables via ALTER DEFAULT PRIVILEGES.

-- ── RLS — class A (portal_deny) ─────────────────────────────────────
ALTER TABLE contact_vault_unlock ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_vault_unlock FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON contact_vault_unlock
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON contact_vault_unlock
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');
