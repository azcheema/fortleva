-- ═══════════════════════════════════════════════════════════════════
-- Phase 5 slice 105 — PROGRESS-UPDATE LAYOUTS AND QUIET HOURS (PLAN Phase 5
-- "`/settings/notifications` (… quiet hours)" and "`ProjectUpdateTemplate`";
-- founder decision C73; DATA_MODEL.md §6.16 and §6.18).
--
-- WHAT IT ADDS.
--   1. `notification_preference.quiet_weekends` — "all weekend" beside the
--      quiet hours (C73 (f)). The hours themselves (`quiet_hours_from`,
--      `quiet_hours_to`) have been columns since 2W and nothing has ever
--      written them, so every existing row is NULL/NULL and the new CHECK
--      below holds on every row there is.
--   2. `email_outbox.quiet_held` — a work email its receiver's quiet hours
--      held. At its release the drain SKIPS it when every notification
--      behind it was read (or is snoozed) in the inbox meanwhile (C73 (e),
--      (h)); a row never held keeps today's behaviour. A constant default:
--      no rewrite of the table.
--   3. `project_update_template` (class A) — a workspace's named LAYOUTS
--      for new progress updates (C73 (c), (d), (g)): the headings a new
--      update opens with, in order, and the numbers it starts with ticked;
--      at most one is the default (partial UNIQUE); names unique per
--      workspace whatever their case (expression UNIQUE — not expressible
--      in schema.prisma, like `notification_dedupe_unread`).
--   4. `project.update_template_id` — the layout a project picked; NULL =
--      the workspace's default, else Fortleva standard. Composite FK to the
--      layout ON DELETE RESTRICT — the `default_service_id` precedent:
--      Prisma cannot express `SET NULL (column)` on a composite key whose
--      tenant column is required, so deleting a layout first points its
--      projects back at the default, in the deleting transaction
--      (src/modules/work/update-templates.ts). An FK check bypasses RLS, so
--      the key alone refuses another workspace's layout id.
--
-- DDL ONLY — no DML, no backfill: no `neon-smoke` dispatch is owed.
--
-- NEVER THE CLIENT. `project` is class B and granted table-wide (the
-- portal's projections read it under the contact principal and select
-- their columns explicitly), so `update_template_id` is kept off the contact
-- plane by `PORTAL_NEVER_SELECTED` (src/authz/portal-projections.test.ts),
-- as the schedule fields are. The layout table is class A: a contact
-- principal reads zero rows of it.
--
-- `project` TRIGGERS. The new column is in no trigger's column list:
-- `project_update_schedule_stamp` (BEFORE … OF update_cadence,
-- update_weekday, update_schedule_since, status, portal_enabled), the
-- portal switch's fan-out (AFTER UPDATE OF portal_enabled) and the hours
-- fan-out (AFTER UPDATE OF hours_sharing_mode) do not fire for a change of
-- layout; `search_feed_project` (AFTER INSERT OR UPDATE OR DELETE)
-- re-upserts the project's search row from columns this migration does not
-- touch, as any project edit does.
-- ═══════════════════════════════════════════════════════════════════

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "update_template_id" TEXT;

-- AlterTable
ALTER TABLE "notification_preference" ADD COLUMN     "quiet_weekends" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "email_outbox" ADD COLUMN     "quiet_held" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "project_update_template" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sections" JSONB NOT NULL,
    "metrics_included" JSONB NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_update_template_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_update_template_tenant_id_id_key" ON "project_update_template"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "project_tenant_id_update_template_id_idx" ON "project"("tenant_id", "update_template_id");

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_tenant_id_update_template_id_fkey" FOREIGN KEY ("tenant_id", "update_template_id") REFERENCES "project_update_template"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_update_template" ADD CONSTRAINT "project_update_template_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── The layout's own shape ──────────────────────────────────────────
-- The app's rules (`update-layout.ts`: the fixed keys, DONE always, three
-- custom at most, eight in all) live in TypeScript and are checked on write
-- and on read; the database holds the outline a later writer must meet too.
-- CASE, not AND: Postgres does not promise to evaluate `jsonb_typeof` before
-- `jsonb_array_length`, which RAISES on a non-array instead of failing the
-- CHECK (the design review's nit).
ALTER TABLE project_update_template
  ADD CONSTRAINT project_update_template_name
    CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 80),
  ADD CONSTRAINT project_update_template_sections
    CHECK (CASE WHEN jsonb_typeof(sections) = 'array'
                THEN jsonb_array_length(sections) BETWEEN 1 AND 8
                ELSE false END),
  ADD CONSTRAINT project_update_template_metrics
    CHECK (jsonb_typeof(metrics_included) = 'object');

-- Names unique per workspace, whatever their case; one default at most.
CREATE UNIQUE INDEX project_update_template_name_key
  ON project_update_template (tenant_id, lower(name));
CREATE UNIQUE INDEX project_update_template_one_default
  ON project_update_template (tenant_id) WHERE is_default;

-- ── Quiet hours: both or neither, in range, never the same hour ─────
ALTER TABLE notification_preference
  ADD CONSTRAINT notification_preference_quiet_hours
    CHECK ((quiet_hours_from IS NULL) = (quiet_hours_to IS NULL)
           AND (quiet_hours_from IS NULL
                OR (quiet_hours_from BETWEEN 0 AND 23
                    AND quiet_hours_to BETWEEN 0 AND 23
                    AND quiet_hours_from <> quiet_hours_to)));

-- ── Grants (deny-default, explicit per table) ───────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON project_update_template TO app_runtime;
-- app_platform already covers new tables via ALTER DEFAULT PRIVILEGES.

-- ── RLS — class A (portal_deny) ─────────────────────────────────────
ALTER TABLE project_update_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_update_template FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON project_update_template
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON project_update_template
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');
