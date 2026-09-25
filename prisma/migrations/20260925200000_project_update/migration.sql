-- ═══════════════════════════════════════════════════════════════════
-- Phase 3 — PROGRESS UPDATES: `project_update` (class B, projectScoped,
-- FOUR-term gate) and `project_update_internal_snapshot` (class A).
-- DATA_MODEL.md §6.16; the portal centrepiece; rides on entitlement
-- `work` (`project_update:*`, AUTHZ.md §3.1).
--
-- THE SHAPE, IN ONE PARAGRAPH. A member drafts a status post — a
-- human-chosen health, a title, a period, five rich-text sections —
-- and PUBLISHES it. Publishing allocates the post's number from the
-- tenant counter, freezes two snapshots of the machine numbers, and
-- from then on the row is immutable: the client reads exactly what was
-- published, forever. The two snapshots are two TABLES and not two
-- columns, and that is the whole security argument of this migration
-- (SECURITY.md §T9, "ProjectUpdate snapshots"): `portal_snapshot` on
-- the class-B row carries only aggregates a client may read — tasks
-- done / total, milestones, versions, requests, hours only when the
-- project shares them — while per-member hours, cost, margin and budget
-- burn sit on the class-A twin, under `portal_deny`, so no bug in a
-- projection can ever hand a contact a member's name or a cost figure
-- from a published post. A forbidden-keys unit test walks the portal
-- snapshot as the belt; this table split is the braces.
--
-- THE GATE IS FOUR TERMS, like `time_report`'s: client match AND
-- CLIENT_VISIBLE AND portal_enabled AND status = 'PUBLISHED'. A draft
-- is therefore unreachable by a contact whatever its `visibility`
-- column says — but the CHECK below keeps a draft INTERNAL anyway,
-- because the publish dialog is where the audience is chosen and a row
-- that claimed to be client-visible before anybody chose would be a lie
-- waiting for a policy edit to believe it.
--
-- IMMUTABILITY IS A TRIGGER, with ONE deliberate exception. Once
-- `published_at` is set, only `status` (PUBLISHED → ARCHIVED),
-- `visibility`, `edit_note`, `pdf_document_id` and the stamped columns
-- may change. The exception is §6.16's fifteen-minute grace window: a
-- post may go BACK to DRAFT within fifteen minutes of publishing, and
-- when it does it must give up its number, its snapshots and its
-- audience — a typo seen a minute after publishing is not a correction
-- post. The service applies the same clock (`retractUpdate`); the
-- trigger is the belt, so a service that forgot the clock could not
-- silently widen the window. After the window, the only text that
-- changes is `edit_note`, which is client-readable and audited.
--
-- DELETE is refused for a published row everywhere but under the
-- maintenance GUC (`app.work_maintenance`, transaction-local, set only
-- by test teardown and platform maintenance — the `app.time_maintenance`
-- shape, and for the same reason: tenant offboarding and test teardown
-- must be able to remove a whole tenant, and a project cascade-delete
-- runs this trigger).
--
-- CONTACT WRITES: none. `portal_gate`'s WITH CHECK denies contacts
-- outright, and the three named `portal_no_*` policies repeat it so the
-- census (`src/portal/census.dbtest.ts`) reads the table as closed by
-- name, the way every other class-B table is.
--
-- DDL only, no DML — no `neon-smoke.yml` dispatch owed.
-- ═══════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "project_health" AS ENUM ('ON_TRACK', 'AT_RISK', 'OFF_TRACK', 'ON_HOLD', 'COMPLETE');

-- CreateEnum
CREATE TYPE "project_update_status" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "project_update" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "seq" INTEGER,
    "health" "project_health" NOT NULL,
    "title" VARCHAR(200),
    "period_start" DATE,
    "period_end" DATE,
    "body" JSONB NOT NULL,
    "body_text" TEXT,
    "portal_snapshot" JSONB,
    "changes_since_last" JSONB,
    "status" "project_update_status" NOT NULL DEFAULT 'DRAFT',
    "visibility" "Visibility" NOT NULL DEFAULT 'INTERNAL',
    "portal_enabled" BOOLEAN NOT NULL DEFAULT false,
    "author_member_id" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "published_by_member_id" TEXT,
    "edit_note" VARCHAR(500),
    "pdf_document_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_update_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_update_internal_snapshot" (
    "update_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "by_member" JSONB,
    "cost" JSONB,
    "budget" JSONB,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_update_internal_snapshot_pkey" PRIMARY KEY ("update_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_update_tenant_id_id_key" ON "project_update"("tenant_id", "id");

-- CreateIndex — Postgres treats NULLs as distinct here, so every draft
-- (seq NULL) coexists and only PUBLISHED numbers are unique per project.
CREATE UNIQUE INDEX "project_update_tenant_id_project_id_seq_key" ON "project_update"("tenant_id", "project_id", "seq");

-- CreateIndex
CREATE INDEX "project_update_tenant_id_project_id_status_published_at_idx" ON "project_update"("tenant_id", "project_id", "status", "published_at" DESC);

-- CreateIndex
CREATE INDEX "project_update_tenant_id_client_id_visibility_published_at_idx" ON "project_update"("tenant_id", "client_id", "visibility", "published_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "project_update_internal_snapshot_tenant_id_update_id_key" ON "project_update_internal_snapshot"("tenant_id", "update_id");

-- AddForeignKey
ALTER TABLE "project_update" ADD CONSTRAINT "project_update_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_update" ADD CONSTRAINT "project_update_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_update" ADD CONSTRAINT "project_update_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_update_internal_snapshot" ADD CONSTRAINT "project_update_internal_snapshot_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_update_internal_snapshot" ADD CONSTRAINT "project_update_internal_snapshot_tenant_id_update_id_fkey" FOREIGN KEY ("tenant_id", "update_id") REFERENCES "project_update"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Invariants the application relies on, stated where the row lives ─
ALTER TABLE project_update
  ADD CONSTRAINT project_update_period_order
    CHECK (period_start IS NULL OR period_end IS NULL OR period_end >= period_start),
  -- A draft has no number; a published or archived post always has one.
  ADD CONSTRAINT project_update_draft_unnumbered
    CHECK ((status = 'DRAFT') = (seq IS NULL)),
  ADD CONSTRAINT project_update_draft_unpublished
    CHECK ((status = 'DRAFT') = (published_at IS NULL)),
  ADD CONSTRAINT project_update_publisher_iff_published
    CHECK ((published_at IS NULL) = (published_by_member_id IS NULL)),
  -- The frozen portal metrics exist exactly when the post is published.
  ADD CONSTRAINT project_update_snapshot_iff_published
    CHECK ((published_at IS NULL) = (portal_snapshot IS NULL)),
  -- Only a PUBLISHED post can be client-visible: a draft has no audience
  -- yet, and an archived post has given its audience up.
  ADD CONSTRAINT project_update_visible_only_published
    CHECK (visibility = 'INTERNAL' OR status = 'PUBLISHED');

-- ── Immutable after publish, with the fifteen-minute retraction ─────
CREATE OR REPLACE FUNCTION project_update_immutable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_old jsonb;
  v_new jsonb;
BEGIN
  IF OLD.published_at IS NULL THEN
    RETURN NEW;
  END IF;
  -- The grace window: back to DRAFT, within fifteen minutes, giving up
  -- everything publishing granted. Measured against the clock of the
  -- statement, so the service and the database agree to the second.
  IF NEW.status = 'DRAFT' THEN
    IF OLD.status <> 'PUBLISHED' OR OLD.published_at < now() - interval '15 minutes' THEN
      RAISE EXCEPTION 'UPDATE_IMMUTABLE: a published update can be retracted only within 15 minutes of publishing';
    END IF;
    IF NEW.published_at IS NOT NULL
       OR NEW.published_by_member_id IS NOT NULL
       OR NEW.seq IS NOT NULL
       OR NEW.portal_snapshot IS NOT NULL
       OR NEW.changes_since_last IS NOT NULL
       OR NEW.visibility <> 'INTERNAL' THEN
      RAISE EXCEPTION 'UPDATE_IMMUTABLE: a retracted update must give up its number, its snapshots and its audience';
    END IF;
    RETURN NEW;
  END IF;
  v_old := to_jsonb(OLD) - 'status' - 'visibility' - 'edit_note' - 'pdf_document_id' - 'portal_enabled' - 'updated_at';
  v_new := to_jsonb(NEW) - 'status' - 'visibility' - 'edit_note' - 'pdf_document_id' - 'portal_enabled' - 'updated_at';
  IF v_new IS DISTINCT FROM v_old THEN
    RAISE EXCEPTION 'UPDATE_IMMUTABLE: a published update cannot be edited — retract it within 15 minutes, or add a note';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'PUBLISHED' AND NEW.status = 'ARCHIVED') THEN
    RAISE EXCEPTION 'UPDATE_IMMUTABLE: a published update may only move to ARCHIVED';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER project_update_immutable
  BEFORE UPDATE ON project_update
  FOR EACH ROW EXECUTE FUNCTION project_update_immutable();

CREATE OR REPLACE FUNCTION project_update_no_delete_published() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.published_at IS NOT NULL
     AND current_setting('app.work_maintenance', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'UPDATE_IMMUTABLE: a published update cannot be deleted — archive it';
  END IF;
  RETURN OLD;
END
$fn$;
CREATE TRIGGER project_update_no_delete_published
  BEFORE DELETE ON project_update
  FOR EACH ROW EXECUTE FUNCTION project_update_no_delete_published();

-- ── Grants (deny-default, explicit per table) ───────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE
  ON project_update, project_update_internal_snapshot
  TO app_runtime;
-- app_platform already covers new tables via ALTER DEFAULT PRIVILEGES.

-- ── RLS — class A: the internal snapshot (portal_deny, no visibility) ─
ALTER TABLE project_update_internal_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_update_internal_snapshot FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON project_update_internal_snapshot
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON project_update_internal_snapshot
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

-- ── RLS — class B projectScoped: project_update (FOUR-term gate) ────
ALTER TABLE project_update ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_update FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON project_update
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

-- Read gate: the standard three terms plus `status = 'PUBLISHED'`; the
-- WITH CHECK denies contacts outright (no contact ever writes here).
CREATE POLICY portal_gate ON project_update
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR (
      client_id = (SELECT current_setting('app.client_id', true))
      AND visibility = 'CLIENT_VISIBLE'
      AND portal_enabled
      AND status = 'PUBLISHED'
    )
  )
  WITH CHECK (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
  );

-- The census's three named denies (20260920230000 / 20260920233000):
-- INSERT and UPDATE through WITH CHECK, DELETE through USING.
CREATE POLICY portal_no_insert ON project_update
  AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

CREATE POLICY portal_no_update ON project_update
  AS RESTRICTIVE FOR UPDATE TO app_runtime
  WITH CHECK ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

CREATE POLICY portal_no_delete ON project_update
  AS RESTRICTIVE FOR DELETE TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

-- ── portal_enabled maintenance: stamp the new projectScoped table and
--    extend the project fan-out (TENANCY.md §7.2; the trigger name is
--    pinned by the posture dbtest as <table>_stamp_portal_enabled) ───
CREATE TRIGGER project_update_stamp_portal_enabled
  BEFORE INSERT OR UPDATE OF project_id, portal_enabled ON project_update
  FOR EACH ROW EXECUTE FUNCTION stamp_portal_enabled();

CREATE OR REPLACE FUNCTION project_portal_enabled_fanout() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.portal_enabled IS DISTINCT FROM OLD.portal_enabled THEN
    UPDATE milestone            SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE project_version      SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE service              SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE document             SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE work_item            SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE work_item_activity   SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE comment              SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE search_index         SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE project_time_summary SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE time_report          SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE project_update       SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
  END IF;
  RETURN NULL;
END
$fn$;
