-- ═══════════════════════════════════════════════════════════════════
-- Phase 3V slice 1 — THE VAULT CORE: `credential_item` (class B,
-- clientScoped), `credential_secret` and `credential_version` (class A).
-- DATA_MODEL.md §6.17; SECURITY.md §6.1–§6.3; plan §3.4 (spec pins).
--
-- THE SHAPE, IN ONE PARAGRAPH. A credential is two rows. Its METADATA —
-- name, username, url, tags, non-secret notes, which secret fields exist
-- (their keys, never their values), whether a TOTP seed exists — sits on
-- `credential_item`, which is what every list and detail read touches.
-- Its SECRET sits on `credential_secret`, 1:1, as v2 envelope ciphertext
-- under the tenant's DEK with AAD `tenantId:credential_secret:<id>:secret`
-- (and `…:totp_secret` for the seed), and only the vault's own module
-- reads it. The split is the design, not a normalisation: the secret
-- table is CLASS A, so `portal_deny` refuses a contact principal every
-- row of it even if the metadata row were ever CLIENT_VISIBLE — the
-- non-negotiable "contact principal ⇒ 0 rows on credential_secret".
-- `credential_version` keeps the last ten previous secrets, each
-- re-encrypted under the VERSION row's own AAD, so a history ciphertext
-- cannot be swapped back onto the live row.
--
-- WHAT THE DATABASE REFUSES, beyond RLS:
--   * anything in a ciphertext column that is not v2 ciphertext — the
--     CHECKs below pin the six-segment v2 shape, so no code path,
--     present or future, can store a secret in the clear (the "DB dump
--     contains no plaintext" test's belt);
--   * a credential on a project of ANOTHER client
--     (`credential_item_client_match`): scope is computed as "client in
--     my clients OR project in my projects", so a mismatched pair would
--     show one client's login to a member of the other client's project;
--   * a project anchor without a client, and a CLIENT_VISIBLE row
--     without a client (DATA_MODEL §6.17's two CHECKs).
--
-- `client_id` NULL is the agency's OWN login (C49, 2026-10-01: only a
-- member who sees every client may see it — enforced in the service,
-- `src/modules/vault/scope.ts`; RLS stays tenant + client + visibility).
-- `project_id` is a filter, never a portal gate: credentials are never a
-- project surface on the portal, so the table is clientScoped and has no
-- `portal_enabled` (TENANCY.md §7.2).
--
-- CONTACT WRITES: none. The metadata row's `portal_gate` WITH CHECK
-- denies contacts outright and the three named `portal_no_*` policies
-- repeat it, so the census (`src/portal/census.dbtest.ts`) reads the
-- table as closed by name; the two class-A tables are closed by
-- `portal_deny`, which as a FOR ALL policy with USING alone is also the
-- WITH CHECK of every INSERT and UPDATE. Portal credential SUBMISSION
-- (a later slice) is a brokered write under the system principal.
--
-- Visibility is INTERNAL in v1, and the database says so
-- (`credential_item_internal_only`): CP4 settled "no portal-persistent
-- credentials" (`vault.allowPortalCredentials`, default OFF). The gate is
-- still the standard two-term gate, so the slice that builds that
-- preference drops one named CHECK and changes no policy.
--
-- DDL only, no DML — no `neon-smoke.yml` dispatch owed.
-- ═══════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "credential_type" AS ENUM ('LOGIN', 'SECURE_NOTE', 'API_KEY', 'SSH_KEY', 'DATABASE', 'SERVER', 'WIFI', 'SOFTWARE_LICENSE', 'OTHER');

-- CreateTable
CREATE TABLE "credential_item" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT,
    "project_id" TEXT,
    "type" "credential_type" NOT NULL,
    "name" TEXT NOT NULL,
    "username" TEXT,
    "url" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "secret_field_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "has_totp" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMPTZ(6),
    "rotate_every_days" INTEGER,
    "last_rotated_at" TIMESTAMPTZ(6),
    "needs_rotation" BOOLEAN NOT NULL DEFAULT false,
    "compromised_at" TIMESTAMPTZ(6),
    "visibility" "Visibility" NOT NULL DEFAULT 'INTERNAL',
    "created_by_member_id" TEXT,
    "updated_by_member_id" TEXT,
    "archived_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "credential_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credential_secret" (
    "credential_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "secret_ciphertext" TEXT NOT NULL,
    "totp_secret_ciphertext" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by_member_id" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "credential_secret_pkey" PRIMARY KEY ("credential_id")
);

-- CreateTable
CREATE TABLE "credential_version" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "secret_ciphertext" TEXT NOT NULL,
    "changed_by_member_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credential_version_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "credential_item_tenant_id_client_id_visibility_idx" ON "credential_item"("tenant_id", "client_id", "visibility");

-- CreateIndex
CREATE INDEX "credential_item_tenant_id_project_id_idx" ON "credential_item"("tenant_id", "project_id");

-- CreateIndex
CREATE INDEX "credential_item_tenant_id_expires_at_idx" ON "credential_item"("tenant_id", "expires_at");

-- CreateIndex
CREATE INDEX "credential_item_tenant_id_needs_rotation_idx" ON "credential_item"("tenant_id", "needs_rotation");

-- CreateIndex
CREATE UNIQUE INDEX "credential_item_tenant_id_id_key" ON "credential_item"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "credential_secret_tenant_id_credential_id_key" ON "credential_secret"("tenant_id", "credential_id");

-- CreateIndex
CREATE UNIQUE INDEX "credential_version_tenant_id_credential_id_version_key" ON "credential_version"("tenant_id", "credential_id", "version");

-- AddForeignKey
ALTER TABLE "credential_item" ADD CONSTRAINT "credential_item_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_item" ADD CONSTRAINT "credential_item_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_item" ADD CONSTRAINT "credential_item_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_secret" ADD CONSTRAINT "credential_secret_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_secret" ADD CONSTRAINT "credential_secret_tenant_id_credential_id_fkey" FOREIGN KEY ("tenant_id", "credential_id") REFERENCES "credential_item"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_version" ADD CONSTRAINT "credential_version_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_version" ADD CONSTRAINT "credential_version_tenant_id_credential_id_fkey" FOREIGN KEY ("tenant_id", "credential_id") REFERENCES "credential_item"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── CHECKs — the row's own shape (DATA_MODEL.md §6.17) ──────────────
ALTER TABLE credential_item
  ADD CONSTRAINT credential_item_client_visible_needs_client
    CHECK (visibility <> 'CLIENT_VISIBLE' OR client_id IS NOT NULL),
  ADD CONSTRAINT credential_item_project_needs_client
    CHECK (project_id IS NULL OR client_id IS NOT NULL),
  ADD CONSTRAINT credential_item_name_length
    CHECK (char_length(name) BETWEEN 1 AND 200),
  ADD CONSTRAINT credential_item_rotate_every_days_range
    CHECK (rotate_every_days IS NULL OR rotate_every_days BETWEEN 1 AND 3650),
  -- The service's bounds (src/modules/vault/fields.ts), restated so a
  -- later writer — the brokered portal submission, an import — meets
  -- them too. The url is rendered as a link: http(s) or nothing.
  ADD CONSTRAINT credential_item_url_http
    CHECK (url IS NULL OR url ~* '^https?://'),
  ADD CONSTRAINT credential_item_text_lengths
    CHECK (char_length(username) <= 320 AND char_length(url) <= 2048 AND char_length(notes) <= 5000),
  ADD CONSTRAINT credential_item_list_sizes
    CHECK (cardinality(tags) <= 20 AND cardinality(secret_field_keys) <= 10);

-- INTERNAL ONLY IN V1 — CP4 (founder, 2026-09-30): a client cannot see a
-- login after handing it over (`vault.allowPortalCredentials`, default
-- OFF, not yet built). The service never writes CLIENT_VISIBLE; this is
-- the belt, and the census's pattern: the slice that builds portal-
-- persistent credentials opens it with a visible DROP CONSTRAINT by name,
-- together with the gate test that a CLIENT_VISIBLE row needs.
ALTER TABLE credential_item
  ADD CONSTRAINT credential_item_internal_only
    CHECK (visibility = 'INTERNAL');

-- Ciphertext columns hold v2 ciphertext and nothing else:
-- `v2.<rootKeyId>.<tenantKeyId>.<iv>.<ct>.<tag>` (src/crypto/field-
-- encryption.ts): the two key ids are any dot-free run (a KMS alias may
-- carry `:` or `/` — SECURITY.md §6.1's next step re-wraps keys only),
-- and the AES-GCM parts are base64url with the IV at exactly 12 bytes (16
-- chars) and the tag at exactly 16 (22 chars). A plaintext secret cannot
-- satisfy it; the service never encrypts an empty string (the payload is
-- always a JSON object), so a non-empty ct segment is required.
ALTER TABLE credential_secret
  ADD CONSTRAINT credential_secret_is_v2
    CHECK (secret_ciphertext ~ '^v2\.[^.]+\.[^.]+\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$'),
  ADD CONSTRAINT credential_secret_totp_is_v2
    CHECK (totp_secret_ciphertext IS NULL OR totp_secret_ciphertext ~ '^v2\.[^.]+\.[^.]+\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$'),
  ADD CONSTRAINT credential_secret_version_positive
    CHECK (version >= 1);

ALTER TABLE credential_version
  ADD CONSTRAINT credential_version_is_v2
    CHECK (secret_ciphertext ~ '^v2\.[^.]+\.[^.]+\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$'),
  ADD CONSTRAINT credential_version_version_positive
    CHECK (version >= 1);

-- ── A project anchor must be a project OF THIS CLIENT ───────────────
-- SECURITY INVOKER (the default): the read of `project` runs under the
-- writer's own RLS, so a project the writer cannot see is NOT FOUND and
-- refused like any other mismatch (whatever `client_id` says). Projects never change client (no
-- service moves one), so checking the credential side is sufficient.
CREATE OR REPLACE FUNCTION credential_item_client_match() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  project_client text;
BEGIN
  IF NEW.project_id IS NOT NULL THEN
    SELECT p.client_id INTO project_client
      FROM project p
     WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.project_id;
    IF NOT FOUND OR project_client IS DISTINCT FROM NEW.client_id THEN
      RAISE EXCEPTION 'CREDENTIAL_CLIENT_MISMATCH: a credential''s project must belong to its client';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER credential_item_client_match
  BEFORE INSERT OR UPDATE OF client_id, project_id ON credential_item
  FOR EACH ROW EXECUTE FUNCTION credential_item_client_match();

-- ── Grants (deny-default, explicit per table) ───────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE
  ON credential_item, credential_secret, credential_version
  TO app_runtime;
-- app_platform already covers new tables via ALTER DEFAULT PRIVILEGES.

-- ── RLS — class A: the secret and its history (portal_deny) ─────────
ALTER TABLE credential_secret ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_secret FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON credential_secret
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON credential_secret
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

ALTER TABLE credential_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_version FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON credential_version
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON credential_version
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

-- ── RLS — class B clientScoped: credential_item (two-term gate) ─────
ALTER TABLE credential_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_item FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON credential_item
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

-- Read gate: the standard two terms; the WITH CHECK denies contacts
-- outright (no contact ever writes here — submission will be brokered).
CREATE POLICY portal_gate ON credential_item
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
  );

-- The census's three named denies (20260920230000 / 20260920233000):
-- INSERT and UPDATE through WITH CHECK, DELETE through USING.
CREATE POLICY portal_no_insert ON credential_item
  AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

CREATE POLICY portal_no_update ON credential_item
  AS RESTRICTIVE FOR UPDATE TO app_runtime
  WITH CHECK ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

CREATE POLICY portal_no_delete ON credential_item
  AS RESTRICTIVE FOR DELETE TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');
