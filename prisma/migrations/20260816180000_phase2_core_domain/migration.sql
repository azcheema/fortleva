-- ═══════════════════════════════════════════════════════════════════
-- Phase 2 — core domain (PLAN.md Phase 2; DATA_MODEL.md §6.3–§6.6 as
-- amended 2026-08-16; TENANCY.md §7.2 portal_enabled amendment).
--   * Client, Contact (record only), MemberClient, MemberProject,
--     Project, ProjectVersion, Milestone, Service.
--   * Document: kind, composite FKs to client/project, portal_enabled.
--   * AttachableType += WORK_ITEM, COMMENT, PROJECT_UPDATE, CREDENTIAL, ASSET.
--   * RLS: class A (member_client, member_project); class B clientScoped
--     structural (client, contact); class B projectScoped (project,
--     project_version, milestone, service, document) with the trigger-
--     maintained portal_enabled column and the three-term portal_gate.
-- Hand-written: Prisma-expressible DDL from `migrate diff`, then the
-- collation, CHECKs, GRANTs, RLS posture and triggers appended by hand
-- (security_foundations template). Runs as the owner role.
-- ═══════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "ClientStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "VatProfile" AS ENUM ('SE_DOMESTIC', 'EU_REVERSE_CHARGE', 'OUTSIDE_SCOPE');
CREATE TYPE "ContactPortalProfile" AS ENUM ('CONTACT_PRIMARY', 'CONTACT_COLLABORATOR');
CREATE TYPE "ContactPortalStatus" AS ENUM ('NO_ACCESS', 'INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED');
CREATE TYPE "ProjectStatus" AS ENUM ('PLANNED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED', 'ARCHIVED');
CREATE TYPE "HoursSharingMode" AS ENUM ('NONE', 'HOURS', 'BILLABLE_AMOUNT');
CREATE TYPE "UpdateCadence" AS ENUM ('NONE', 'WEEKLY', 'BIWEEKLY', 'MONTHLY');
CREATE TYPE "ProjectVersionStatus" AS ENUM ('DRAFT', 'SHIPPED');
CREATE TYPE "ApprovalStatus" AS ENUM ('NOT_REQUESTED', 'PENDING', 'APPROVED', 'CHANGES_REQUESTED');
CREATE TYPE "MilestoneStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'PAUSED', 'DONE', 'CANCELLED');
CREATE TYPE "ServiceKind" AS ENUM ('ONE_TIME', 'RECURRING');
CREATE TYPE "BillingInterval" AS ENUM ('MONTHLY', 'QUARTERLY', 'YEARLY');
CREATE TYPE "ServiceStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ENDED');
CREATE TYPE "DocumentKind" AS ENUM ('GENERAL', 'DELIVERABLE', 'REPORT', 'EXPORT');

-- AlterEnum (additive; ISSUE stays, deprecated)
ALTER TYPE "AttachableType" ADD VALUE 'WORK_ITEM';
ALTER TYPE "AttachableType" ADD VALUE 'COMMENT';
ALTER TYPE "AttachableType" ADD VALUE 'PROJECT_UPDATE';
ALTER TYPE "AttachableType" ADD VALUE 'CREDENTIAL';
ALTER TYPE "AttachableType" ADD VALUE 'ASSET';

-- Document: kind + portal_enabled; (tenant_id, project_id) index widens to include kind
DROP INDEX "document_tenant_id_project_id_idx";

ALTER TABLE "document" ADD COLUMN     "kind" "DocumentKind" NOT NULL DEFAULT 'GENERAL',
ADD COLUMN     "portal_enabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "client" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "org_nr" TEXT,
    "vat_number" TEXT,
    "vat_number_validated_at" TIMESTAMPTZ(6),
    "vat_profile" "VatProfile",
    "country_code" CHAR(2),
    "address_line1" TEXT,
    "address_line2" TEXT,
    "postal_code" TEXT,
    "city" TEXT,
    "billing_email" TEXT,
    "invoice_locale" TEXT,
    "status" "ClientStatus" NOT NULL DEFAULT 'ACTIVE',
    "internal_notes" TEXT,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "title" TEXT,
    "phone" TEXT,
    "portal_profile" "ContactPortalProfile" NOT NULL DEFAULT 'CONTACT_COLLABORATOR',
    "portal_status" "ContactPortalStatus" NOT NULL DEFAULT 'NO_ACCESS',
    "invited_at" TIMESTAMPTZ(6),
    "invited_by_id" TEXT,
    "activated_at" TIMESTAMPTZ(6),
    "locale" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_client" (
    "tenant_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "assigned_by_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_client_pkey" PRIMARY KEY ("tenant_id","member_id","client_id")
);

-- CreateTable
CREATE TABLE "member_project" (
    "tenant_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "assigned_by_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_project_pkey" PRIMARY KEY ("tenant_id","member_id","project_id")
);

-- CreateTable
CREATE TABLE "project" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "key" VARCHAR(8) NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT,
    "scope_summary" TEXT,
    "status" "ProjectStatus" NOT NULL DEFAULT 'PLANNED',
    "start_date" TIMESTAMPTZ(6),
    "launch_date" TIMESTAMPTZ(6),
    "production_url" TEXT,
    "staging_url" TEXT,
    "repo_url" TEXT,
    "hosting_notes" TEXT,
    "internal_notes" TEXT,
    "portal_enabled" BOOLEAN NOT NULL DEFAULT false,
    "hours_sharing_mode" "HoursSharingMode" NOT NULL DEFAULT 'NONE',
    "billing_currency" CHAR(3),
    "default_billable" BOOLEAN NOT NULL DEFAULT true,
    "lead_member_id" TEXT,
    "update_cadence" "UpdateCadence" NOT NULL DEFAULT 'NONE',
    "auto_archive_months" INTEGER,
    "auto_start_parent" BOOLEAN NOT NULL DEFAULT false,
    "auto_complete_parent" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_version" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "title" TEXT,
    "release_notes" TEXT,
    "status" "ProjectVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "shipped_at" TIMESTAMPTZ(6),
    "portal_enabled" BOOLEAN NOT NULL DEFAULT false,
    "approval_status" "ApprovalStatus" NOT NULL DEFAULT 'NOT_REQUESTED',
    "approval_requested_at" TIMESTAMPTZ(6),
    "approval_decided_at" TIMESTAMPTZ(6),
    "approval_by_contact_id" TEXT,
    "approval_note" TEXT,
    "created_by_member_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "milestone" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "MilestoneStatus" NOT NULL DEFAULT 'PLANNED',
    "due_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "rank" TEXT NOT NULL,
    "visibility" "Visibility" NOT NULL DEFAULT 'INTERNAL',
    "portal_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "milestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "project_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" "ServiceKind" NOT NULL,
    "billing_interval" "BillingInterval",
    "price_ex_vat" DECIMAL(12,2),
    "currency" CHAR(3),
    "status" "ServiceStatus" NOT NULL DEFAULT 'ACTIVE',
    "started_at" TIMESTAMPTZ(6),
    "renews_at" TIMESTAMPTZ(6),
    "ends_at" TIMESTAMPTZ(6),
    "internal_notes" TEXT,
    "visibility" "Visibility" NOT NULL DEFAULT 'INTERNAL',
    "portal_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "service_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "client_tenant_id_status_idx" ON "client"("tenant_id", "status");
CREATE INDEX "client_tenant_id_name_idx" ON "client"("tenant_id", "name");
CREATE UNIQUE INDEX "client_tenant_id_id_key" ON "client"("tenant_id", "id");
CREATE UNIQUE INDEX "contact_email_key" ON "contact"("email");
CREATE INDEX "contact_tenant_id_client_id_idx" ON "contact"("tenant_id", "client_id");
CREATE UNIQUE INDEX "contact_tenant_id_email_key" ON "contact"("tenant_id", "email");
CREATE UNIQUE INDEX "contact_tenant_id_id_key" ON "contact"("tenant_id", "id");
CREATE INDEX "member_client_tenant_id_client_id_idx" ON "member_client"("tenant_id", "client_id");
CREATE INDEX "member_project_tenant_id_project_id_idx" ON "member_project"("tenant_id", "project_id");
CREATE INDEX "project_tenant_id_client_id_status_idx" ON "project"("tenant_id", "client_id", "status");
CREATE INDEX "project_tenant_id_status_idx" ON "project"("tenant_id", "status");
CREATE UNIQUE INDEX "project_tenant_id_id_key" ON "project"("tenant_id", "id");
CREATE UNIQUE INDEX "project_tenant_id_key_key" ON "project"("tenant_id", "key");
CREATE INDEX "project_version_tenant_id_client_id_shipped_at_idx" ON "project_version"("tenant_id", "client_id", "shipped_at");
CREATE UNIQUE INDEX "project_version_tenant_id_project_id_version_key" ON "project_version"("tenant_id", "project_id", "version");
CREATE UNIQUE INDEX "project_version_tenant_id_id_key" ON "project_version"("tenant_id", "id");
CREATE INDEX "milestone_tenant_id_client_id_visibility_idx" ON "milestone"("tenant_id", "client_id", "visibility");
CREATE UNIQUE INDEX "milestone_tenant_id_id_key" ON "milestone"("tenant_id", "id");
CREATE UNIQUE INDEX "milestone_tenant_id_project_id_rank_key" ON "milestone"("tenant_id", "project_id", "rank");
CREATE INDEX "service_tenant_id_client_id_status_idx" ON "service"("tenant_id", "client_id", "status");
CREATE INDEX "service_tenant_id_renews_at_idx" ON "service"("tenant_id", "renews_at");
CREATE UNIQUE INDEX "service_tenant_id_id_key" ON "service"("tenant_id", "id");
CREATE INDEX "document_tenant_id_project_id_kind_idx" ON "document"("tenant_id", "project_id", "kind");

-- AddForeignKey (composite FKs: the anti-cross-tenant-connect constraint, DATA_MODEL §2.3)
ALTER TABLE "client" ADD CONSTRAINT "client_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contact" ADD CONSTRAINT "contact_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contact" ADD CONSTRAINT "contact_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "member_client" ADD CONSTRAINT "member_client_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "member_client" ADD CONSTRAINT "member_client_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "member"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "member_client" ADD CONSTRAINT "member_client_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "member_project" ADD CONSTRAINT "member_project_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "member_project" ADD CONSTRAINT "member_project_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "member"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "member_project" ADD CONSTRAINT "member_project_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project" ADD CONSTRAINT "project_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project" ADD CONSTRAINT "project_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_version" ADD CONSTRAINT "project_version_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_version" ADD CONSTRAINT "project_version_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_version" ADD CONSTRAINT "project_version_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "milestone" ADD CONSTRAINT "milestone_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "milestone" ADD CONSTRAINT "milestone_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "milestone" ADD CONSTRAINT "milestone_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service" ADD CONSTRAINT "service_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service" ADD CONSTRAINT "service_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service" ADD CONSTRAINT "service_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document" ADD CONSTRAINT "document_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document" ADD CONSTRAINT "document_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Hand-written from here on.
-- ═══════════════════════════════════════════════════════════════════

-- ── Collation + CHECKs ──────────────────────────────────────────────
-- Milestone.rank: fractional-indexing keys compare bytewise (DATA_MODEL
-- §6.5 amendment) — Prisma cannot express COLLATE, so it lives here.
ALTER TABLE milestone ALTER COLUMN rank TYPE text COLLATE "C";

-- Project.key: the human WorkItem prefix — <= 8 chars, [A-Z][A-Z0-9]*.
ALTER TABLE project
  ADD CONSTRAINT project_key_format CHECK (key ~ '^[A-Z][A-Z0-9]{0,7}$');

-- Service: billing_interval only meaningful for RECURRING services.
ALTER TABLE service
  ADD CONSTRAINT service_interval_recurring_only
  CHECK (kind = 'RECURRING' OR billing_interval IS NULL);

-- Milestone: DONE ⇔ completed_at set (kept honest for the timeline).
ALTER TABLE milestone
  ADD CONSTRAINT milestone_done_has_completed_at
  CHECK ((status = 'DONE') = (completed_at IS NOT NULL));

-- ProjectVersion: SHIPPED ⇔ shipped_at set.
ALTER TABLE project_version
  ADD CONSTRAINT project_version_shipped_has_shipped_at
  CHECK ((status = 'SHIPPED') = (shipped_at IS NOT NULL));

-- ── Grants (deny-default, explicit per table) ───────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE
  ON client, contact, member_client, member_project,
     project, project_version, milestone, service
  TO app_runtime;
-- app_platform already covers new tables via ALTER DEFAULT PRIVILEGES.

-- ── RLS — class A (TENANCY.md §6.2 template + §7.2 portal_deny) ─────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['member_client', 'member_project'] LOOP
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

-- ── RLS — class B: tenant_isolation on every class-B table ──────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'client', 'contact', 'project', 'project_version', 'milestone', 'service'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        AS PERMISSIVE FOR ALL TO app_runtime
        USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
        WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)))
    $p$, t);
  END LOOP;
END
$$;

-- ── portal_gate: client (the client-root — its own id IS the client) ─
-- Structural row: client match only, no visibility term. A contact
-- reads exactly one client row: its own. Column-level rules
-- (internal_notes) are the portal projection's job (DATA_MODEL §2.3).
CREATE POLICY portal_gate ON client
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR id = (SELECT current_setting('app.client_id', true))
  )
  WITH CHECK (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR id = (SELECT current_setting('app.client_id', true))
  );

-- ── portal_gate: contact (structural — client match only) ───────────
CREATE POLICY portal_gate ON contact
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR client_id = (SELECT current_setting('app.client_id', true))
  )
  WITH CHECK (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR client_id = (SELECT current_setting('app.client_id', true))
  );

-- ── portal_gate: project (structural projectScoped row) ─────────────
-- A project row has no visibility column; the visibility term is
-- replaced by portal_enabled — the project's own master switch.
CREATE POLICY portal_gate ON project
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR (
      client_id = (SELECT current_setting('app.client_id', true))
      AND portal_enabled
    )
  )
  WITH CHECK (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR (
      client_id = (SELECT current_setting('app.client_id', true))
      AND portal_enabled
    )
  );

-- ── portal_gate: project_version (status-structural projectScoped) ──
-- No visibility column (DATA_MODEL §6.5): SHIPPED ⇒ client-visible.
-- The visibility term is status = 'SHIPPED'; portal_enabled is ANDed.
CREATE POLICY portal_gate ON project_version
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR (
      client_id = (SELECT current_setting('app.client_id', true))
      AND status = 'SHIPPED'
      AND portal_enabled
    )
  )
  WITH CHECK (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR (
      client_id = (SELECT current_setting('app.client_id', true))
      AND status = 'SHIPPED'
      AND portal_enabled
    )
  );

-- ── portal_gate: three-term form (TENANCY.md §7.2 amendment) ────────
-- milestone, service: client match AND CLIENT_VISIBLE AND portal_enabled.
-- document: same three terms — its portal_enabled is TRUE when it has
-- no project (client-level document, no switch to honour), else the
-- project's switch (trigger below), so one policy shape covers both.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['milestone', 'service'] LOOP
    EXECUTE format($p$
      CREATE POLICY portal_gate ON %I
        AS RESTRICTIVE FOR ALL TO app_runtime
        USING (
          (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
          OR (
            client_id = (SELECT current_setting('app.client_id', true))
            AND visibility = 'CLIENT_VISIBLE'
            AND portal_enabled
          )
        )
        WITH CHECK (
          (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
          OR (
            client_id = (SELECT current_setting('app.client_id', true))
            AND visibility = 'CLIENT_VISIBLE'
            AND portal_enabled
          )
        )
    $p$, t);
  END LOOP;
END
$$;

-- document: replace the Phase-1 two-term gate with the three-term one.
DROP POLICY portal_gate ON document;
CREATE POLICY portal_gate ON document
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR (
      client_id = (SELECT current_setting('app.client_id', true))
      AND visibility = 'CLIENT_VISIBLE'
      AND portal_enabled
    )
  )
  WITH CHECK (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR (
      client_id = (SELECT current_setting('app.client_id', true))
      AND visibility = 'CLIENT_VISIBLE'
      AND portal_enabled
    )
  );

-- ── portal_enabled maintenance (TENANCY.md §7.2 amendment) ──────────
-- The column is derived, never app-written:
--   * BEFORE INSERT / UPDATE OF project_id, portal_enabled on every
--     projectScoped child: portal_enabled := project.portal_enabled
--     (TRUE when project_id IS NULL — document/service without a
--     project; fail-closed FALSE when the project row is not visible).
--     Because it also fires on UPDATE OF portal_enabled, a direct write
--     to the column is overwritten with the derived value.
--   * AFTER UPDATE OF portal_enabled ON project: fan out to every child
--     in the same transaction (bounded per project).
-- The SELECT on project runs under the caller's RLS (SECURITY INVOKER):
-- members and the system principal see the project; a contact never
-- inserts these rows (brokered writes run as system).
CREATE OR REPLACE FUNCTION stamp_portal_enabled() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  enabled boolean;
BEGIN
  IF NEW.project_id IS NULL THEN
    NEW.portal_enabled := true;
    RETURN NEW;
  END IF;
  SELECT p.portal_enabled INTO enabled
    FROM project p
   WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.project_id;
  NEW.portal_enabled := COALESCE(enabled, false);
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION project_portal_enabled_fanout() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.portal_enabled IS DISTINCT FROM OLD.portal_enabled THEN
    UPDATE milestone       SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE project_version SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE service         SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE document        SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
  END IF;
  RETURN NULL;
END
$fn$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['milestone', 'project_version', 'service', 'document'] LOOP
    EXECUTE format($t$
      CREATE TRIGGER %I_stamp_portal_enabled
        BEFORE INSERT OR UPDATE OF project_id, portal_enabled ON %I
        FOR EACH ROW EXECUTE FUNCTION stamp_portal_enabled()
    $t$, t, t);
  END LOOP;
END
$$;

CREATE TRIGGER project_portal_enabled_fanout
  AFTER UPDATE OF portal_enabled ON project
  FOR EACH ROW EXECUTE FUNCTION project_portal_enabled_fanout();

-- Existing documents: none carry a project yet in Phase 1 data, but be
-- exact — derive the column for every row once.
UPDATE document d
   SET portal_enabled = COALESCE((SELECT p.portal_enabled FROM project p WHERE p.tenant_id = d.tenant_id AND p.id = d.project_id), d.project_id IS NULL);
