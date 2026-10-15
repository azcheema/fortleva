-- ═══════════════════════════════════════════════════════════════════
-- Phase 6 slice 121 — IMPORTS (founder decision C97;
-- docs/research/2026-10-15-slice-121-imports-design.md §1).
--
-- A member brings tasks into ONE project from a spreadsheet file (CSV) or
-- a Trello board export. The FILE is read in the member's browser and never
-- reaches the server (design R1): the server receives plain rows in batches,
-- checks every field again, and keeps only what is below.
--
--   `import_job` — class A (tenant_isolation + portal_deny): one row per
--   import — who, when, the file's NAME (shown on the Import page, never in
--   an audit row), the counts, and the undo / "Bring back" stamps. The
--   undo's `undone_at` is THE stamp it wrote on every task it removed, which
--   is what a Bring back restores by.
--
--   `import_job_item` — class A: one row per task an import WROTE (CREATED
--   it, or UPDATED it on a re-import), with the task's `updated_at` exactly
--   as that write left it. A re-import overwrites a task only while its
--   `updated_at` still equals SOME import write's `written_at` (design R7);
--   an undo removes only tasks a job CREATED (R9).
--
--   `work_item` — the import columns reserved since 2W (20260820170000:
--   `source_system`, `source_id`, `import_job_id`) get their rules: a
--   partial UNIQUE that keeps ONE LIVE task per (project, source, id) — a
--   binned task does not count, so a re-import after an undo makes new
--   tasks and a Bring back skips a task whose id has a live twin — and four
--   CHECKs on the columns' shape. `import_job_id` stays attribution (no FK),
--   as `created_by_member_id` is: the links with FKs are `import_job_item`'s.
--
-- CONTACT WRITES: none. `portal_deny` closes both new tables to a contact
-- principal outright; `work_item`'s policies are unchanged.
--
-- DDL only — no DML, no `neon-smoke.yml` dispatch owed. The guard below
-- refuses to run against a database where any task already carries import
-- provenance, so a CHECK can never be half-added. Left out of Prisma's
-- generated diff, as every migration since they appeared has: the drift it
-- always reports (`document_tenant_id_tags_idx`, `search_index`, the
-- `work_item` contact-assignee index name) — hand-written objects Prisma
-- does not model. This migration adds one more such object, the partial
-- `work_item_source_live_key`, and the CHECKs (Prisma models neither).
-- ═══════════════════════════════════════════════════════════════════

-- ── The table lock, FIRST ───────────────────────────────────────────
-- The statements below take `work_item` from ACCESS SHARE (the guard's read)
-- through SHARE ROW EXCLUSIVE (the FK into it) to ACCESS EXCLUSIVE (the
-- CHECKs): an upgrade that a dev server or a test run reading-then-updating
-- `work_item` meanwhile would turn into a deadlock (the pre-apply review).
-- Taken at the strongest level at once, with a bounded wait, so the
-- migration either holds the table for its few milliseconds or fails clean.
SET LOCAL lock_timeout = '10s';
LOCK TABLE work_item IN ACCESS EXCLUSIVE MODE;

-- ── Guard: nothing has written the reserved columns yet ─────────────
-- Every writer of `work_item` until this slice leaves the three columns NULL
-- and `source` short of IMPORT (the 2W migration reserved them; no service
-- sets them). Checked FIRST, so a surprise stops the migration before any
-- object exists.
--
-- `row_security = off` IS LOAD-BEARING (20260906150000's reasoning):
-- `work_item` is FORCE ROW LEVEL SECURITY with policies `TO app_runtime`, so
-- a migrating role without BYPASSRLS would see NO rows and the guard would
-- pass having looked at nothing. Off, such a role FAILS the read instead.
SET LOCAL row_security = off;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM work_item
    WHERE source_system IS NOT NULL OR source_id IS NOT NULL OR import_job_id IS NOT NULL
       OR source = 'IMPORT'
  ) THEN
    RAISE EXCEPTION 'import provenance already present on work_item — inspect before applying 20261026090000_imports';
  END IF;
END
$$;

-- CreateTable
CREATE TABLE "import_job" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "file_name" VARCHAR(200) NOT NULL,
    "row_count" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "created_count" INTEGER NOT NULL DEFAULT 0,
    "updated_count" INTEGER NOT NULL DEFAULT 0,
    "kept_count" INTEGER NOT NULL DEFAULT 0,
    "unchanged_count" INTEGER NOT NULL DEFAULT 0,
    "started_by_member_id" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "last_write_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),
    "undone_at" TIMESTAMPTZ(6),
    "undone_by_member_id" TEXT,
    "undone_count" INTEGER,
    "restored_at" TIMESTAMPTZ(6),
    "restored_by_member_id" TEXT,

    CONSTRAINT "import_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_job_item" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "import_job_id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "written_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_job_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: the Import page's list, newest first.
CREATE INDEX "import_job_tenant_id_project_id_started_at_idx" ON "import_job"("tenant_id", "project_id", "started_at" DESC);

-- CreateIndex: the composite-FK target.
CREATE UNIQUE INDEX "import_job_tenant_id_id_key" ON "import_job"("tenant_id", "id");

-- CreateIndex: the re-import's test — "an import write of this task left
-- exactly its current `updated_at`" (an EXISTS on `written_at`, never an
-- order by `created_at`, which is a transaction's START and not the order
-- writes took the lock: the pre-apply review).
CREATE INDEX "import_job_item_tenant_id_work_item_id_written_at_idx" ON "import_job_item"("tenant_id", "work_item_id", "written_at");

-- CreateIndex: one job writes a task once.
CREATE UNIQUE INDEX "import_job_item_tenant_id_import_job_id_work_item_id_key" ON "import_job_item"("tenant_id", "import_job_id", "work_item_id");

-- AddForeignKey
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: with the project — a project hard-deleted (the harness's
-- teardown) takes its imports; the product archives projects.
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_job_item" ADD CONSTRAINT "import_job_item_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_job_item" ADD CONSTRAINT "import_job_item_tenant_id_import_job_id_fkey" FOREIGN KEY ("tenant_id", "import_job_id") REFERENCES "import_job"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: with the task — a task is soft-deleted by the product and
-- hard-deleted only by the harness, which takes the row with it.
ALTER TABLE "import_job_item" ADD CONSTRAINT "import_job_item_tenant_id_work_item_id_fkey" FOREIGN KEY ("tenant_id", "work_item_id") REFERENCES "work_item"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── CHECKs — import_job's own shape ─────────────────────────────────
-- ONE UNDO PER IMPORT is the SERVICE's rule (it refuses an undo once
-- `undone_at` is set). These CHECKs back it only against a careless writer:
-- a Bring back returns the status to DONE and leaves both stamps, so a
-- second undo that wrote a NEWER `undone_at` with the old `restored_at`
-- still set is refused (`restored_at >= undone_at`) — but one that also
-- cleared `restored_at` would pass. No trigger freezes the stamps.
ALTER TABLE import_job
  ADD CONSTRAINT import_job_source_known
    CHECK (source IN ('CSV', 'TRELLO')),
  ADD CONSTRAINT import_job_status_known
    CHECK (status IN ('RUNNING', 'DONE', 'UNDONE')),
  ADD CONSTRAINT import_job_row_count_bounded
    CHECK (row_count BETWEEN 1 AND 2000),
  ADD CONSTRAINT import_job_file_name_present
    CHECK (char_length(btrim(file_name)) BETWEEN 1 AND 200),
  ADD CONSTRAINT import_job_counts_nonnegative
    CHECK (created_count >= 0 AND updated_count >= 0 AND kept_count >= 0 AND unchanged_count >= 0
           AND (undone_count IS NULL OR undone_count >= 0)),
  -- Every row the browser sends is counted exactly once, so an import can
  -- never process more rows than it declared at its start.
  ADD CONSTRAINT import_job_counts_within_rows
    CHECK (created_count + updated_count + kept_count + unchanged_count <= row_count),
  ADD CONSTRAINT import_job_undone_within_created
    CHECK (undone_count IS NULL OR undone_count <= created_count),
  ADD CONSTRAINT import_job_times_ordered
    CHECK (last_write_at >= started_at AND (finished_at IS NULL OR finished_at >= started_at)),
  ADD CONSTRAINT import_job_running_unfinished
    CHECK (status <> 'RUNNING' OR (finished_at IS NULL AND undone_at IS NULL)),
  ADD CONSTRAINT import_job_undone_shape
    CHECK ((undone_at IS NULL) = (undone_by_member_id IS NULL)
           AND (undone_at IS NULL) = (undone_count IS NULL)),
  ADD CONSTRAINT import_job_restored_shape
    CHECK ((restored_at IS NULL) = (restored_by_member_id IS NULL)
           AND (restored_at IS NULL OR (undone_at IS NOT NULL AND restored_at >= undone_at))),
  ADD CONSTRAINT import_job_undone_status
    CHECK ((status = 'UNDONE') = (undone_at IS NOT NULL AND restored_at IS NULL));

ALTER TABLE import_job_item
  ADD CONSTRAINT import_job_item_action_known
    CHECK (action IN ('CREATED', 'UPDATED'));

-- ── work_item: the reserved import columns get their rules ──────────
-- ONE LIVE TASK PER (project, source, id). Partial on `deleted_at IS NULL`,
-- so a task in the bin never blocks a re-import, and a Bring back that
-- would collide is skipped by the service's NOT EXISTS under the project's
-- rank lock rather than refused here. Every existing row has `source_id`
-- NULL (the guard above), so this cannot fail to build.
CREATE UNIQUE INDEX work_item_source_live_key
  ON work_item (tenant_id, project_id, source_system, source_id)
  WHERE source_id IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE work_item
  ADD CONSTRAINT work_item_source_pair
    CHECK ((source_system IS NULL) = (source_id IS NULL)),
  ADD CONSTRAINT work_item_source_system_known
    CHECK (source_system IS NULL OR (source_system IN ('csv', 'trello') AND source = 'IMPORT')),
  ADD CONSTRAINT work_item_source_id_length
    CHECK (source_id IS NULL OR char_length(source_id) BETWEEN 1 AND 200),
  -- Both ways: an IMPORT task always names the import that made it, and
  -- nothing else ever does (the guard above proved no row is either today).
  ADD CONSTRAINT work_item_import_job_is_import
    CHECK ((source = 'IMPORT') = (import_job_id IS NOT NULL));

-- ── Grants ──────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON import_job TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON import_job_item TO app_runtime;

-- ── RLS — class A (portal_deny; no visibility) ──────────────────────
ALTER TABLE import_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_job FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON import_job
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON import_job
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

ALTER TABLE import_job_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_job_item FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON import_job_item
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON import_job_item
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');
