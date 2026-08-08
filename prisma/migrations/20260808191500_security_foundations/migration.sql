-- ═══════════════════════════════════════════════════════════════════
-- Security foundations (TENANCY.md §6–§9, SECURITY.md §7).
-- Runs as the owner role (DIRECT_URL). Hand-written, reviewed SQL —
-- policies drifting outside migrations is a named failure mode.
-- ═══════════════════════════════════════════════════════════════════

-- ── Roles (TENANCY.md §9.2) ─────────────────────────────────────────
-- Created via SQL, never the Neon console (console roles join
-- neon_superuser and silently carry BYPASSRLS — the §6.1 trap).
-- Passwords are set OUT OF BAND (scripts/set-role-passwords.mjs);
-- LOGIN with no password means the role cannot connect until then.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_platform') THEN
    CREATE ROLE app_platform LOGIN;
  END IF;
END
$$;

ALTER ROLE app_runtime NOBYPASSRLS NOCREATEDB NOCREATEROLE;
-- Deliberate, audited bypass for the platform plane (TENANCY.md §12).
-- Loaded only by platform route-group code; verified settable on Neon.
ALTER ROLE app_platform BYPASSRLS NOCREATEDB NOCREATEROLE;

GRANT USAGE ON SCHEMA public TO app_runtime, app_platform;

-- ── Grants: deny-default, explicit per table ────────────────────────
-- app_runtime gets exactly what the tenant/portal/auth planes need.
-- Future migrations grant new tables explicitly — no default privilege
-- for app_runtime, so a forgotten grant fails closed.

-- Auth layer (runs before tenant context; RLS below still gates portal)
GRANT SELECT, INSERT, UPDATE, DELETE
  ON "user", session, account, verification, two_factor, passkey
  TO app_runtime;

-- Tenant root: read own row, update own row; provisioning is platform-only
GRANT SELECT, UPDATE ON tenant TO app_runtime;

-- Tenant-plane domain tables
GRANT SELECT, INSERT, UPDATE, DELETE
  ON member, member_invite, role, role_permission, member_role,
     tenant_preference, tenant_counter, document, file_version, file_object
  TO app_runtime;

-- Global catalogs: read-only for the app; writes are seed/platform paths
GRANT SELECT ON permission, feature_flag TO app_runtime;

-- Audit: append-only — INSERT + SELECT, never UPDATE/DELETE (§7)
GRANT SELECT, INSERT ON audit_event TO app_runtime;

-- Platform plane: full DML everywhere, current and future tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_platform;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_platform;

-- ── RLS helpers ─────────────────────────────────────────────────────
-- GUCs are set transaction-locally by withTenant() (set_config(..., true)).
-- Policies use the (SELECT current_setting(...)) InitPlan form — evaluated
-- once per statement, not per row — and fail CLOSED on an unset GUC:
-- NULL comparison yields no rows, WITH CHECK rejects writes.

-- ── Class T: tenant root (TENANCY.md §6, DATA_MODEL §2.3) ───────────
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_self_select ON tenant
  FOR SELECT TO app_runtime
  USING (id = (SELECT current_setting('app.tenant_id', true)));

-- permissionsVersion bumps and storage metering run in-tenant-transaction
CREATE POLICY tenant_self_update ON tenant
  FOR UPDATE TO app_runtime
  USING (id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON tenant
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

-- ── Class A: tenant-strict tables (§6.2 template + §7.2 portal_deny) ─
-- member, member_invite, role, role_permission, member_role,
-- tenant_preference, tenant_counter, file_object, file_version
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'member', 'member_invite', 'role', 'role_permission', 'member_role',
    'tenant_preference', 'tenant_counter', 'file_object', 'file_version'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        AS PERMISSIVE FOR ALL TO app_runtime
        USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
        WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)))
    $p$, t);
    EXECUTE format($p$
      CREATE POLICY portal_deny ON %I
        AS RESTRICTIVE FOR ALL TO app_runtime
        USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact')
    $p$, t);
  END LOOP;
END
$$;

-- ── Class B: document — tenant policy + portal GATE (§7.2) ──────────
-- A contact sees only CLIENT_VISIBLE rows of their own client; INTERNAL
-- rows of their own client are invisible; NULL client_id is invisible.
-- Contacts never write document directly (uploads are brokered via the
-- system principal), but the WITH CHECK still pins any write to the
-- contact's own client as defense in depth.
ALTER TABLE document ENABLE ROW LEVEL SECURITY;
ALTER TABLE document FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON document
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_gate ON document
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR (
      client_id = (SELECT current_setting('app.client_id', true))
      AND visibility = 'CLIENT_VISIBLE'
    )
  )
  WITH CHECK (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR client_id = (SELECT current_setting('app.client_id', true))
  );

-- The worst-bug guard in the schema itself (DATA_MODEL §6.8): a
-- client-visible document with no client is unrepresentable.
ALTER TABLE document
  ADD CONSTRAINT document_client_visible_requires_client
  CHECK (visibility <> 'CLIENT_VISIBLE' OR client_id IS NOT NULL);

-- ── Global/auth tables: allow runtime, deny portal (§6.3) ───────────
-- Auth flows run before tenant context exists (no GUCs set → allowed);
-- a contact-context query sees nothing. Catalogs (permission,
-- feature_flag) get the same treatment — contacts have no business
-- reading either.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'user', 'session', 'account', 'verification', 'two_factor', 'passkey',
    'permission', 'feature_flag'
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

-- ── Class AU: audit_event (§6.3, SECURITY.md §7) ────────────────────
-- Append-only, two audiences. INSERT is allowed for every principal in
-- tenant context (portal actions are audited too); SELECT is tenant
-- members only, TENANT-visibility only. Platform events (tenant_id IS
-- NULL) are invisible to the runtime role entirely.
ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_event FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_tenant_select ON audit_event
  FOR SELECT TO app_runtime
  USING (
    tenant_id = (SELECT current_setting('app.tenant_id', true))
    AND visibility = 'TENANT'
  );

CREATE POLICY audit_tenant_insert ON audit_event
  FOR INSERT TO app_runtime
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY audit_portal_select_deny ON audit_event
  AS RESTRICTIVE FOR SELECT TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

-- Belt two: even roles that hold UPDATE/DELETE grants (owner, platform)
-- cannot mutate audit rows outside sanctioned maintenance. The escape
-- GUC exists for exactly two flows (SECURITY.md §7): the retention
-- cron's DELETE and GDPR pseudonymization's UPDATE of actor fields.
CREATE OR REPLACE FUNCTION audit_event_immutable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF current_setting('app.audit_maintenance', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'audit_event is append-only (%_ blocked; SECURITY.md §7)', TG_OP;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER audit_event_guard
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_immutable();
