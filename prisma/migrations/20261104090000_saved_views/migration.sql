-- ═══════════════════════════════════════════════════════════════════
-- Slice 136 — SAVED VIEWS (founder decision C113; design
-- docs/research/2026-10-19-slice-136-saved-views-design.md).
--
-- WHAT IT ADDS. `saved_view` — one member's named set of filters for the
-- Tasks page (`TASKS`) or one project's backlog (`BACKLOG`), listed under
-- Tasks in their left menu. ONLY THEIRS (C113 (a)): class A (`portal_deny`)
-- plus a RESTRICTIVE `own_view` policy — no colleague, owner, admin or job
-- reads, changes or removes another member's views; nothing in the product
-- acts on one for someone else. The data export runs as the exporting member,
-- so it carries their own views and nobody else's (the push devices'
-- precedent, 20261008220000).
--
-- Member FK ON DELETE CASCADE (a view means nothing without its member);
-- project FK ON DELETE CASCADE (a backlog's view goes with the backlog);
-- tenant FK RESTRICT (the convention). Referential actions bypass row
-- security, so `own_view` never stands in a cascade's way.
--
-- The service refuses every bad value first (`src/modules/work/saved-views.ts`
-- with `src/lib/saved-view-plan.ts`); these are the database's own copies of
-- the rules a later writer could forget:
--   · a name is one line of at most 60 characters with something in it, and
--     unique per member IGNORING CASE — Postgres's `lower()`, which the
--     service maps to VIEW_NAME_TAKEN;
--   · `query` is the canonical form's outline: only `[A-Za-z0-9=&,_-]`, at
--     most 4000 characters — nothing a link built from it could misread;
--   · a BACKLOG view names its project and a TASKS view names none.
--
-- DDL AND GRANTS ONLY — a new table, no row touched: `neon-smoke` is not owed.
-- ═══════════════════════════════════════════════════════════════════

-- ── The table locks, FIRST ──────────────────────────────────────────
-- The foreign keys below take `member` and `project` in SHARE ROW EXCLUSIVE
-- (the repeating-tasks migration's rule, 20261031090000). Taken here, before
-- anything else, with a BOUNDED wait: behind a dev server or a test run
-- writing either table the migration gets them within ten seconds and holds
-- them for its few milliseconds, or fails clean. (`tenant` is taken in the
-- same mode by its foreign key, under the same bound.)
SET LOCAL lock_timeout = '10s';
LOCK TABLE member, project IN SHARE ROW EXCLUSIVE MODE;

-- CreateEnum
CREATE TYPE "saved_view_kind" AS ENUM ('TASKS', 'BACKLOG');

-- CreateTable
CREATE TABLE "saved_view" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "kind" "saved_view_kind" NOT NULL,
    "project_id" TEXT,
    "name" TEXT NOT NULL,
    "query" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "saved_view_pkey" PRIMARY KEY ("id")
);

-- No plain (tenant_id, member_id) index: `saved_view_name_ci_key` below leads
-- with both columns and serves the per-member reads (the review's NIT).

-- CreateIndex
CREATE INDEX "saved_view_tenant_id_project_id_idx" ON "saved_view"("tenant_id", "project_id");

-- AddForeignKey
ALTER TABLE "saved_view" ADD CONSTRAINT "saved_view_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_view" ADD CONSTRAINT "saved_view_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "member"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_view" ADD CONSTRAINT "saved_view_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── The row's own shape ─────────────────────────────────────────────
-- One line, ≤ 60, not blank, no space at either end — the service's
-- `savedViewName` (it collapses any whitespace run to a space, trims, and
-- refuses a control character). `char_length` counts code points, as the
-- service does, and `btrim` strips less than JavaScript's `trim`, so this can
-- never refuse what the service accepted (the templates' rule, 20261028090000).
ALTER TABLE saved_view
  ADD CONSTRAINT saved_view_name_ok
    CHECK (btrim(name) <> '' AND name = btrim(name) AND name !~ '[[:cntrl:]]' AND char_length(name) <= 60),
  ADD CONSTRAINT saved_view_query_ok
    CHECK (query ~ '^[A-Za-z0-9=&,_-]*$' AND char_length(query) <= 4000),
  ADD CONSTRAINT saved_view_kind_project
    CHECK ((kind = 'BACKLOG') = (project_id IS NOT NULL));

-- Unique per member IGNORING CASE (the labels', stages' and templates'
-- precedent). Mapped to VIEW_NAME_TAKEN.
CREATE UNIQUE INDEX saved_view_name_ci_key
  ON saved_view (tenant_id, member_id, lower(name));

-- ── Grants (deny-default, explicit per table) ───────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON saved_view TO app_runtime;
-- app_platform already covers new tables via ALTER DEFAULT PRIVILEGES.

-- ── RLS — class A (portal_deny) + own_view ──────────────────────────
ALTER TABLE saved_view ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_view FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON saved_view
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON saved_view
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

-- A member's views are THEIRS (C113 (a)): only the member principal, and only
-- on its own rows. Not even the tenant's SYSTEM principal — no job reads a
-- view. An impersonating operator, who runs as the member's own principal,
-- may see the member's menu as the member does; the service refuses them
-- every write (`src/modules/work/saved-views.ts`). `platform_admin` gets
-- nothing.
CREATE POLICY own_view ON saved_view
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (
    (SELECT current_setting('app.principal', true)) = 'member'
    AND member_id = (SELECT current_setting('app.principal_id', true))
  )
  WITH CHECK (
    (SELECT current_setting('app.principal', true)) = 'member'
    AND member_id = (SELECT current_setting('app.principal_id', true))
  );
