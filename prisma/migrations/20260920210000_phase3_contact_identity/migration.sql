-- ═══════════════════════════════════════════════════════════════════
-- Phase 3, slice 1 — the CONTACT IDENTITY STACK.
--
-- Three AUTH-class tables (DATA_MODEL.md §6.4, TENANCY.md §6.3), plus
-- the two policies and one trigger that let the portal Better Auth
-- instance reach `contact` at all.
--
-- THE PROBLEM THIS MIGRATION SOLVES, because it is not obvious and the
-- spec pins did not notice it. The portal instance maps Better Auth's
-- `user` model onto `contact` (DATA_MODEL.md §6.4). But `contact` is a
-- class-B tenant-scoped table whose `tenant_isolation` policy reads
-- `tenant_id = current_setting('app.tenant_id', true)`, and sign-in
-- happens BEFORE any tenant is known — the contact's email is the only
-- thing the request carries, and the tenant is what we are trying to
-- find. With the GUC unset that comparison is NULL, so the auth path
-- would have read ZERO rows and no contact could ever have signed in.
--
-- The member plane does not have this problem because `user` is a
-- global table with a blanket `allow_runtime USING (true)`. The fix
-- here is deliberately NOT that, and deliberately not a BYPASSRLS
-- connection either: it is the `withUser()` pattern that already
-- solves the same problem for "my tenants" (migration
-- 20260808200000_member_self_visibility) — a transaction-local GUC
-- naming exactly the row the caller already identified, and an RLS
-- policy that admits that row and nothing else. An unset GUC is NULL
-- and matches nothing, so deny-default survives.
--
-- INVITE-ONLY IS ENFORCED HERE, not only in configuration. The auth
-- path gets SELECT and UPDATE policies and NO INSERT policy, so the
-- portal instance structurally cannot create a contact: a signup
-- endpoint, if one were ever mounted by accident, hits RLS. Contacts
-- are created by members through the tenant path, under
-- `client:manage_contacts`, where `tenant_isolation` governs as usual.
-- ═══════════════════════════════════════════════════════════════════

-- ── Tables ──────────────────────────────────────────────────────────

CREATE TABLE "contact_session" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "contact_session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "contact_account" (
    "id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "password" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "contact_account_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "contact_verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "contact_verification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "contact_session_token_key" ON "contact_session"("token");
CREATE INDEX "contact_session_contact_id_idx" ON "contact_session"("contact_id");
CREATE INDEX "contact_session_expires_at_idx" ON "contact_session"("expires_at");

CREATE UNIQUE INDEX "contact_account_provider_id_account_id_key"
  ON "contact_account"("provider_id", "account_id");
CREATE INDEX "contact_account_contact_id_idx" ON "contact_account"("contact_id");

CREATE INDEX "contact_verification_identifier_idx" ON "contact_verification"("identifier");
CREATE INDEX "contact_verification_expires_at_idx" ON "contact_verification"("expires_at");

-- FKs into a tenant-scoped, RLS-FORCED table from AUTH-class tables.
-- Sound by construction: PostgreSQL performs referential-integrity
-- checks as the table owner and they always bypass row security, so
-- these do not need — and must not be given — tenant context. CASCADE
-- is the revocation backstop: deleting the Contact record takes its
-- credentials and every live session with it.
ALTER TABLE "contact_session" ADD CONSTRAINT "contact_session_contact_id_fkey"
  FOREIGN KEY ("contact_id") REFERENCES "contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contact_account" ADD CONSTRAINT "contact_account_contact_id_fkey"
  FOREIGN KEY ("contact_id") REFERENCES "contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Grants (deny-default: nothing is granted wholesale) ─────────────
GRANT SELECT, INSERT, UPDATE, DELETE
  ON contact_session, contact_account, contact_verification
  TO app_runtime;

-- ── RLS: the AUTH-class template (see 20260808191500) ───────────────
-- allow_runtime is blanket because these tables have no tenant column
-- and the auth flow precedes tenant context; portal_deny is what stops
-- a CONTACT-principal transaction — i.e. anything reached through the
-- portal itself — from reading the session and credential tables.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'contact_session', 'contact_account', 'contact_verification'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY allow_runtime ON %I
        AS PERMISSIVE FOR ALL TO app_runtime
        USING (true) WITH CHECK (true)
    $p$, t);
    EXECUTE format($p$
      CREATE POLICY portal_deny ON %I
        AS RESTRICTIVE FOR ALL TO app_runtime
        USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact')
    $p$, t);
  END LOOP;
END
$$;

-- ── Invite-only, for the CREDENTIAL and not just the contact row ────
-- The three refusals above all defend an INSERT into `contact`. None
-- of them defends `contact_account`, and Better Auth will create a
-- credential on its own: `/reset-password` does
--   if (!findAccounts(userId).find(a => a.providerId === "credential"))
--     createAccount({ providerId: "credential", password, … })
-- (better-auth/dist/api/routes/password.mjs), and merely CONFIGURING
-- `sendResetPassword` is what mounts the unauthenticated
-- `/request-password-reset` that issues the token. So a contact a
-- member merely RECORDED — portalStatus NO_ACCESS, never invited —
-- could have set themselves a portal password, and the invitation
-- flow, its single-use token, its expiry and its audit trail would all
-- have been bypassed. Nothing would have been visible until the day
-- that contact was activated and the pre-planted credential became a
-- live login. Found by the security review of this slice.
--
-- The rule is therefore stated where it cannot be bypassed by an
-- endpoint nobody in this repository wrote: a credential may exist
-- only for a contact somebody deliberately invited. INVITED is allowed
-- because that is the state invite acceptance runs in; ACTIVE because
-- a re-issued credential for an existing contact is legitimate.
-- NO_ACCESS, SUSPENDED and REVOKED are refused.
CREATE OR REPLACE FUNCTION contact_account_requires_invite() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_status text;
BEGIN
  SELECT portal_status::text INTO v_status FROM contact WHERE id = NEW.contact_id;
  -- Reads `contact` with RLS active under the caller's own principal.
  -- On the auth path the row is admitted by contact_auth_lookup only
  -- when a GUC names it; NOT FOUND therefore also covers "this write
  -- did not identify the contact it claims to be for", and refuses.
  IF v_status IS NULL OR v_status NOT IN ('INVITED', 'ACTIVE') THEN
    RAISE EXCEPTION 'CONTACT_ACCOUNT_REQUIRES_INVITE: a portal credential may only exist for an invited contact';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS contact_account_requires_invite ON contact_account;
CREATE TRIGGER contact_account_requires_invite
  BEFORE INSERT ON contact_account
  FOR EACH ROW EXECUTE FUNCTION contact_account_requires_invite();

-- ── The portal auth path's reach into `contact` ─────────────────────
-- ONE PERMISSIVE policy, which ORs with `tenant_isolation` rather than
-- replacing it: in a normal tenant transaction neither GUC is set, its
-- qual is NULL, and nothing changes for any existing caller.
--
-- Set ONLY by src/db/portal-identity.ts, transaction-locally, from a
-- value the request already supplied. `app.auth_contact_email` admits
-- exactly the row whose address was typed into the sign-in form — not
-- a scan, not a tenant, one row — and `app.auth_contact_id` admits the
-- row a validated session already names.
--
-- READ ONLY, AND THAT IS NOT AN OVERSIGHT. There is no UPDATE policy
-- to go with it. WHY, stated in the right tense, because an earlier
-- draft of this comment got it wrong and the review caught it: the
-- FIRST version of this migration DID add one, and every auth-path
-- update then failed with `42501 new row violates row-level security
-- policy for table "search_index"` — `contact` carries an AFTER
-- trigger feeding the search index, whose own RLS is the ordinary
-- `tenant_id = app.tenant_id`, and there is no tenant on this path.
-- Widening the search index to an unauthenticated plane to make that
-- pass would have been a far worse trade than the one it solved, so
-- the UPDATE policy was dropped instead.
--
-- With the policy set as SHIPPED, that 42501 is no longer reachable:
-- an auth-path UPDATE matches zero rows (this policy is SELECT-only,
-- and `tenant_isolation`'s qual is NULL with no tenant) and dies on
-- `contact` itself, long before any trigger. The search-index failure
-- is the REASON for the design, not its current behaviour. Auth-path
-- writes instead run
-- through `withTenant(..., {type:'system'})` in the tenancy this
-- policy just proved — the brokered seam AUTHZ.md §8 already requires
-- for contact-caused writes — and the trigger below is what keeps them
-- honest there.
--
-- The RESTRICTIVE portal_gate already on `contact` still applies and
-- still passes here, because `app.principal` is unset on the auth path
-- (IS DISTINCT FROM 'contact'). A contact-principal transaction can
-- never reach this: withTenant() does not set either GUC, and GUCs are
-- transaction-local.
-- `nullif(…, '')` is not decoration. src/db/portal-identity.ts emits the
-- EMPTY STRING for whichever key it was not given, so without it the
-- qual for the absent key is `email = ''` — which admits any row whose
-- column really is empty, in EVERY tenant, on every auth-path
-- transaction. `contact.email` is `TEXT NOT NULL` with no non-empty
-- constraint, so that is a property of the data rather than of the
-- schema; the dbtest that proves "an EMPTY guc is not a wildcard"
-- passes today only because no such row exists. NULL compares to
-- nothing, so this closes it structurally instead.
--
-- The comparison is also exact and case-SENSITIVE, and that is a
-- dependency worth naming: Better Auth lowercases before it looks up
-- (`findUserByEmail` → `email.toLowerCase()`), and src/clients/service.ts
-- lowercases on create and update. A contact whose address is ever
-- stored with capitals would simply be unable to sign in, with no error
-- anywhere to say why.
CREATE POLICY contact_auth_lookup ON contact
  FOR SELECT TO app_runtime
  USING (
    email = (SELECT nullif(current_setting('app.auth_contact_email', true), ''))
    OR id  = (SELECT nullif(current_setting('app.auth_contact_id', true), ''))
  );

-- THE GUARD ON THE BROKERED WRITE. A system-principal transaction can
-- write any column of any row in its tenant — that is what the system
-- principal is for — so the fact that a write ORIGINATED on the auth
-- path has to travel with it. src/db/portal-identity.ts re-asserts
-- `app.auth_contact_id` inside that transaction, and this trigger
-- turns it into a rule: a write the portal's unauthenticated surface
-- caused may not change which tenant a contact belongs to, which
-- client, which profile, or whether the portal is open to it. Those
-- decide what a login can reach, and they belong to the tenant path,
-- under `client:manage_contacts`, where the GUC is unset and this
-- trigger returns immediately.
CREATE OR REPLACE FUNCTION contact_auth_path_immutable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  -- Not the auth path: the GUC is unset (NULL) or empty. Every member
  -- write to `contact` lands here and returns immediately.
  IF coalesce(current_setting('app.auth_contact_id', true), '') = '' THEN
    RETURN NEW;
  END IF;
  IF NEW.id               IS DISTINCT FROM OLD.id
     OR NEW.tenant_id      IS DISTINCT FROM OLD.tenant_id
     OR NEW.client_id      IS DISTINCT FROM OLD.client_id
     OR NEW.portal_profile IS DISTINCT FROM OLD.portal_profile
     OR NEW.portal_status  IS DISTINCT FROM OLD.portal_status
  THEN
    RAISE EXCEPTION 'CONTACT_AUTH_IMMUTABLE: tenancy, client, portal profile and portal status cannot be changed on the auth path';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS contact_auth_path_immutable ON contact;
-- Deliberately not `UPDATE OF <columns>`: that fires on the columns
-- NAMED by the statement, and the point is to catch a write naming a
-- column this path has no business naming at all.
CREATE TRIGGER contact_auth_path_immutable
  BEFORE UPDATE ON contact
  FOR EACH ROW EXECUTE FUNCTION contact_auth_path_immutable();
