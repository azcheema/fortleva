-- ═══════════════════════════════════════════════════════════════════
-- Phase 5 slice 102 — PROGRESS-UPDATE REMINDERS (PLAN Phase 5
-- "`ProjectUpdateSchedule` (cadence, owner, auto-draft pre-fill, +1/+2
-- working-day reminders, 'update missing' badge)"; founder decision C70;
-- DATA_MODEL.md §6.16).
--
-- WHAT IT ADDS.
--   1. `project.update_weekday` — the day a project's update is due, ISO
--      1 = Monday … 5 = Friday, Friday by default (C70 (b)). The cadence
--      itself has been on `project` since Phase 2 (`update_cadence`).
--   2. `project.update_schedule_since` — the moment the schedule last
--      (re)started: the due rule (`src/modules/work/update-schedule.ts`)
--      never puts a due day on or before it. NULL exactly when the cadence
--      is NONE (CHECK). ONLY THE TRIGGER BELOW WRITES IT — a direct write
--      is put back — and it restarts the schedule when the cadence or the
--      day changes, when the project becomes ACTIVE (a project whose
--      cadence was set while it was PLANNED would otherwise be "late" from
--      the day it starts, and past its reminders — the design review's
--      high), and when its client portal is switched on (from then on only
--      an update the client can see counts, C70 (g), so the old internal
--      ones stop counting at once).
--   3. `project_update_reminder_sent` (class A) — the reminders' dedupe:
--      one row per reminder that went out (the project, the scheduled day
--      whose round it belongs to, the step 0/1/2). The job (run by every
--      `POST /api/jobs/run` until a cron exists; it sends only 09:00–17:00
--      workspace time) INSERTs …
--      ON CONFLICT DO NOTHING in the transaction that writes the inbox rows
--      and the audit row, so the primary key IS the dedupe.
--
-- THE ORDER MATTERS (the design review): columns → backfill → CHECKs →
-- trigger. With the trigger in place first, it would put the backfill's
-- write back (a direct write of `update_schedule_since` is ignored) and
-- the CHECK would then abort the migration.
--
-- THE BACKFILL IS DML: every project that already has a cadence starts its
-- schedule NOW, so none of them is "late" the moment this lands. On an
-- empty database (CI) it touches nothing; the real rows it is for live on
-- Neon. AGENTS.md's rule for a migration carrying DML applies: a
-- `neon-smoke.yml` dispatch, read for its result, recorded in PLAN §0. It
-- runs with `row_security` off for this transaction (`project` is FORCE
-- RLS and its policies are `TO app_runtime`; under a role subject to them
-- the UPDATE would match nothing and the CHECK would then abort on rows it
-- never saw) — the precedent of every earlier backfill. Applied by hand
-- (Smart App Control), the file goes as ONE script: splitting it on `;`
-- breaks the function's `$$` body and its atomicity. It fires `search_feed_project`
-- (AFTER INSERT OR UPDATE OR DELETE ON project) once per such project,
-- which re-upserts that project's search row from columns this migration
-- does not touch — the same text, a fresh `updated_at`, as any project edit.
-- `@updatedAt` is Prisma's, not the database's: `project.updated_at` does
-- not move.
--
-- NEVER THE CLIENT. `project` is class B and granted table-wide (the
-- portal's projections read the row under the contact principal — see
-- 20260930120000_portal_sections), so the new columns are kept off the
-- contact plane by the projections' explicit selects, and the three
-- schedule fields (`updateCadence`, `updateWeekday`, `updateScheduleSince`)
-- are pinned in `PORTAL_NEVER_SELECTED` (src/authz/portal-projections.test.ts).
-- They say when the agency writes updates; nothing secret, but staff-only.
--
-- THE FIRST BEFORE TRIGGER ON `project`. 20260928180000_portal_switch_gate's
-- third premise is that the switch moves only through its fan-out, which
-- is `AFTER UPDATE OF portal_enabled` — and a change a BEFORE trigger makes
-- to NEW.portal_enabled would move it WITHOUT the fan-out.
-- `project_update_schedule_stamp` LISTENS to the switch and assigns only
-- NEW.update_schedule_since: it never writes `portal_enabled`, runs no
-- statement and takes no lock, so the premise holds. src/db/isolation.dbtest.ts
-- pinned "no BEFORE trigger on project"; it now pins this one by name and the
-- premise by meaning (no BEFORE trigger's function assigns NEW.portal_enabled).
-- ═══════════════════════════════════════════════════════════════════

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "update_schedule_since" TIMESTAMPTZ(6),
ADD COLUMN     "update_weekday" SMALLINT NOT NULL DEFAULT 5;

-- CreateTable
CREATE TABLE "project_update_reminder_sent" (
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "due_on" DATE NOT NULL,
    "step" SMALLINT NOT NULL,
    "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_update_reminder_sent_pkey" PRIMARY KEY ("tenant_id","project_id","due_on","step")
);

-- CreateIndex
CREATE INDEX "project_update_reminder_sent_tenant_id_due_on_idx" ON "project_update_reminder_sent"("tenant_id", "due_on");

-- AddForeignKey
ALTER TABLE "project_update_reminder_sent" ADD CONSTRAINT "project_update_reminder_sent_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_update_reminder_sent" ADD CONSTRAINT "project_update_reminder_sent_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── The backfill (DML) — BEFORE the CHECK and the trigger ───────────
SET LOCAL row_security = off;

UPDATE project SET update_schedule_since = now() WHERE update_cadence <> 'NONE';


-- ── CHECKs — the row's own shape ────────────────────────────────────
-- The service's closed sets (`UPDATE_WEEKDAYS`, `UPDATE_REMINDER_LAST_STEP`
-- in src/modules/work/update-schedule.ts), restated so a later writer
-- meets them too.
ALTER TABLE project
  ADD CONSTRAINT project_update_weekday_range
    CHECK (update_weekday BETWEEN 1 AND 5),
  ADD CONSTRAINT project_update_schedule_since_iff_cadence
    CHECK ((update_cadence = 'NONE') = (update_schedule_since IS NULL));

ALTER TABLE project_update_reminder_sent
  ADD CONSTRAINT project_update_reminder_sent_step
    CHECK (step BETWEEN 0 AND 2);


-- ── The stamp: the only writer of `update_schedule_since` ───────────
-- BEFORE, so it shapes the row being written: on INSERT a cadence starts
-- its schedule now; on UPDATE it restarts on the four events above and is
-- otherwise PUT BACK, so a direct write of the column changes nothing (the
-- column is in the trigger's list for exactly that reason). NONE always
-- clears it. `now()` is the transaction's start: one statement, one moment.
--
-- SECURITY INVOKER (the default): it reads nothing but the row it is
-- given. It does not touch `portal_enabled` or any column the portal
-- fan-out (`project_portal_enabled_fanout`, AFTER UPDATE OF portal_enabled)
-- reads, so it changes nothing about the switch — it only listens to it.
CREATE OR REPLACE FUNCTION project_update_schedule_stamp() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.update_cadence = 'NONE' THEN
    NEW.update_schedule_since := NULL;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.update_schedule_since := now();
    RETURN NEW;
  END IF;
  IF NEW.update_cadence IS DISTINCT FROM OLD.update_cadence
     OR NEW.update_weekday IS DISTINCT FROM OLD.update_weekday
     OR (NEW.status = 'ACTIVE' AND OLD.status IS DISTINCT FROM 'ACTIVE')
     OR (NEW.portal_enabled AND NOT OLD.portal_enabled) THEN
    NEW.update_schedule_since := now();
  ELSE
    NEW.update_schedule_since := OLD.update_schedule_since;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER project_update_schedule_stamp
  BEFORE INSERT OR UPDATE OF update_cadence, update_weekday, update_schedule_since, status, portal_enabled
  ON project
  FOR EACH ROW EXECUTE FUNCTION project_update_schedule_stamp();


-- ── Grants (deny-default, explicit per table) ───────────────────────
-- Never UPDATE: a dedupe row is written once and swept.
GRANT SELECT, INSERT, DELETE ON project_update_reminder_sent TO app_runtime;
-- app_platform already covers new tables via ALTER DEFAULT PRIVILEGES.

-- ── RLS — class A (portal_deny) ─────────────────────────────────────
ALTER TABLE project_update_reminder_sent ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_update_reminder_sent FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON project_update_reminder_sent
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON project_update_reminder_sent
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');
