-- ═══════════════════════════════════════════════════════════════════
-- Phase 3V slice 87 — THE ASSET REGISTRY: `client_asset` (class B,
-- clientScoped). DATA_MODEL.md §6.17; PLAN Phase 3V's `ClientAsset`
-- line; founder decision C52 (l) (assets + expirations come first in
-- the rest of 3V).
--
-- WHAT IT IS. The things an agency looks after for a client — domains,
-- hosting, DNS zones, SSL certificates, mailboxes, CMS/apps, third-party
-- services, licences — with who provides them, an identifier, a renewal
-- date, whether it renews by itself, and what a renewal costs. NON-SECRET
-- by contract: a password or a licence KEY belongs in the vault
-- (`credential_item` and its secret), never here, and the table carries
-- no ciphertext. The expirations feed (slice 88) reads `expires_at`;
-- nothing here derives a status from it — "expiring" and "expired" are
-- computed where they are shown, so `status` is only what a person set
-- (ACTIVE, RETIRED).
--
-- WHAT THE DATABASE REFUSES, beyond RLS:
--   * an asset on a project of ANOTHER client (`client_asset_client_match`)
--     — scope is "client-level rows for directly assigned members, a
--     project's rows on the project axis", so a mismatched pair would
--     show one client's asset to a member of the other client's project
--     (the credential table's trigger, restated);
--   * CLIENT_VISIBLE (`client_asset_internal_only`): no portal surface
--     shows assets in v1, so the standard two-term gate below is the
--     whole of what a contact could ever read — and this CHECK keeps that
--     at zero rows. The slice that gives assets a portal surface drops it
--     by name, with the gate test that a CLIENT_VISIBLE row needs;
--   * a renewal cost without its currency or a currency without a cost
--     (`client_asset_cost_currency`), a negative cost, a currency that is
--     not three capital letters, a non-http(s) url, over-long text, more
--     than twenty tags, and a `fields` value that is not a small object.
--
-- `project_id` is an anchor and a filter, never a portal gate: the table
-- is clientScoped with no `portal_enabled` (TENANCY.md §7.2), as
-- `credential_item` is.
--
-- CONTACT WRITES: none. `portal_gate`'s WITH CHECK denies contacts
-- outright and the three named `portal_no_*` policies repeat it, so the
-- census (`src/portal/census.dbtest.ts`) reads the table as closed by name.
--
-- DDL only, no DML — no `neon-smoke.yml` dispatch owed.
-- ═══════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "asset_type" AS ENUM ('DOMAIN', 'HOSTING', 'DNS_ZONE', 'SSL_CERT', 'EMAIL', 'CMS_APP', 'THIRD_PARTY_SERVICE', 'LICENSE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "asset_status" AS ENUM ('ACTIVE', 'RETIRED');

-- CreateTable
CREATE TABLE "client_asset" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "project_id" TEXT,
    "type" "asset_type" NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT,
    "url" TEXT,
    "identifier" TEXT,
    "status" "asset_status" NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMPTZ(6),
    "auto_renew" BOOLEAN,
    "renewal_cost" DECIMAL(12,2),
    "currency" CHAR(3),
    "fields" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "visibility" "Visibility" NOT NULL DEFAULT 'INTERNAL',
    "created_by_member_id" TEXT,
    "updated_by_member_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "client_asset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "client_asset_tenant_id_client_id_visibility_idx" ON "client_asset"("tenant_id", "client_id", "visibility");

-- CreateIndex
CREATE INDEX "client_asset_tenant_id_project_id_idx" ON "client_asset"("tenant_id", "project_id");

-- CreateIndex
CREATE INDEX "client_asset_tenant_id_expires_at_idx" ON "client_asset"("tenant_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "client_asset_tenant_id_id_key" ON "client_asset"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "client_asset" ADD CONSTRAINT "client_asset_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_asset" ADD CONSTRAINT "client_asset_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_asset" ADD CONSTRAINT "client_asset_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── CHECKs — the row's own shape ────────────────────────────────────
-- The service's bounds (src/modules/vault/asset-fields.ts and fields.ts),
-- restated so a later writer — an import, the continuity box — meets them
-- too. The url is rendered as a link: http(s) or nothing — and never with
-- a user or password before the host (`https://admin:pw@host`), the
-- likeliest way a secret would land in this non-secret table (the
-- pre-apply review). The `@` is matched only before the first `/`, `?` or
-- `#`, so `https://medium.com/@acme` still passes.
ALTER TABLE client_asset
  ADD CONSTRAINT client_asset_name_length
    CHECK (char_length(name) BETWEEN 1 AND 200),
  ADD CONSTRAINT client_asset_url_http
    CHECK (url IS NULL OR (url ~* '^https?://' AND url !~ '^[A-Za-z]+://[^/?#]*@')),
  ADD CONSTRAINT client_asset_text_lengths
    CHECK (
      char_length(provider) <= 200
      AND char_length(identifier) <= 255
      AND char_length(url) <= 2048
      AND char_length(notes) <= 5000
    ),
  ADD CONSTRAINT client_asset_list_sizes
    CHECK (cardinality(tags) <= 20),
  ADD CONSTRAINT client_asset_cost_nonnegative
    CHECK (renewal_cost IS NULL OR renewal_cost >= 0),
  ADD CONSTRAINT client_asset_currency_iso
    CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  -- A cost means nothing without its currency, and a currency alone is a
  -- leftover: the two are set and cleared together.
  ADD CONSTRAINT client_asset_cost_currency
    CHECK ((renewal_cost IS NULL) = (currency IS NULL)),
  -- The service caps the encoded object at 8 KiB of UTF-8; jsonb's text
  -- form adds a space after every `:` and `,`, so the belt sits at twice
  -- that and is never the tighter side (the pre-apply review).
  ADD CONSTRAINT client_asset_fields_object
    CHECK (jsonb_typeof(fields) = 'object' AND octet_length(fields::text) <= 16384);

-- INTERNAL ONLY IN V1 — nothing shows assets on the portal yet. The
-- service never writes CLIENT_VISIBLE; this is the belt, and the census's
-- pattern: the slice that builds a portal surface for assets opens it
-- with a visible DROP CONSTRAINT by name.
ALTER TABLE client_asset
  ADD CONSTRAINT client_asset_internal_only
    CHECK (visibility = 'INTERNAL');

-- ── A project anchor must be a project OF THIS CLIENT ───────────────
-- SECURITY INVOKER (the default): the read of `project` runs under the
-- writer's own RLS, so a project the writer cannot see is NOT FOUND and
-- refused like any other mismatch. Projects never change client (no
-- service moves one), so checking the asset side is sufficient. The
-- token is mapped by the service (`src/modules/vault/assets.ts`).
CREATE OR REPLACE FUNCTION client_asset_client_match() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  project_client text;
BEGIN
  IF NEW.project_id IS NOT NULL THEN
    SELECT p.client_id INTO project_client
      FROM project p
     WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.project_id;
    IF NOT FOUND OR project_client IS DISTINCT FROM NEW.client_id THEN
      RAISE EXCEPTION 'ASSET_CLIENT_MISMATCH: an asset''s project must belong to its client';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER client_asset_client_match
  BEFORE INSERT OR UPDATE OF client_id, project_id ON client_asset
  FOR EACH ROW EXECUTE FUNCTION client_asset_client_match();

-- ── Grants (deny-default, explicit per table) ───────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON client_asset TO app_runtime;
-- app_platform already covers new tables via ALTER DEFAULT PRIVILEGES.

-- ── RLS — class B clientScoped (two-term gate) ──────────────────────
ALTER TABLE client_asset ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_asset FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON client_asset
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

-- Read gate: the standard two terms; the WITH CHECK denies contacts
-- outright (no contact ever writes here).
CREATE POLICY portal_gate ON client_asset
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
CREATE POLICY portal_no_insert ON client_asset
  AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

CREATE POLICY portal_no_update ON client_asset
  AS RESTRICTIVE FOR UPDATE TO app_runtime
  WITH CHECK ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

CREATE POLICY portal_no_delete ON client_asset
  AS RESTRICTIVE FOR DELETE TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');
