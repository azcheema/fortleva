-- Slice 135 (founder decision C112): a progress update can be SCHEDULED to
-- publish at a chosen hour (design docs/research/2026-10-18-slice-135-
-- scheduled-updates-design.md). Three columns on the existing class-B table —
-- no new table, so no new grant, RLS class or policy: `project_update`'s
-- `tenant_isolation`, `portal_gate` (a contact reads PUBLISHED posts only, and
-- a scheduled update is a DRAFT) and contact-write deny are unchanged.
--
-- DDL only, no DML: every existing row is unscheduled (all three NULL), so the
-- CHECKs hold on add. No neon-smoke run owed.

ALTER TABLE "project_update"
  ADD COLUMN "scheduled_for" TIMESTAMPTZ(6),
  ADD COLUMN "scheduled_by_member_id" TEXT,
  ADD COLUMN "scheduled_visibility" "Visibility";

ALTER TABLE "project_update"
  -- All or none: a time without a scheduler (or an audience) is nothing a
  -- job could publish, and an audience without a time is a stale choice.
  ADD CONSTRAINT project_update_schedule_whole
    CHECK ((scheduled_for IS NULL) = (scheduled_by_member_id IS NULL)
       AND (scheduled_for IS NULL) = (scheduled_visibility IS NULL)),
  -- Only a DRAFT waits to be published. Publishing (by hand or by the job)
  -- clears the three in the same statement, so no member id lingers on a row
  -- a client's contact can read.
  ADD CONSTRAINT project_update_schedule_draft_only
    CHECK (scheduled_for IS NULL OR status = 'DRAFT');

-- ── Locked while scheduled (C112 (a)) ───────────────────────────────
-- A scheduled draft's CONTENT cannot change: the person who scheduled it
-- (who holds `project_update:publish`) decided what the client reads, and
-- `project_update:create` — which any employee holds — may edit any draft.
-- The service refuses first (`updateUpdateDraft`); this is the belt for the
-- race it cannot close: an edit read before the schedule and written after
-- it. Unscheduling clears `scheduled_for` in a statement of its own (an
-- UPDATE that unschedules AND edits is refused, because OLD is scheduled).
-- Publishing moves the row out of DRAFT, which this does not judge — the
-- immutable trigger owns a published row.
--
-- No DELETE guard: a trigger refusing to delete a scheduled draft would
-- also refuse the project's cascade delete (the 2026-08-21 review's lesson);
-- discarding is refused in the service.
CREATE OR REPLACE FUNCTION project_update_schedule_lock() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.scheduled_for IS NOT NULL AND NEW.status = 'DRAFT' AND (
       NEW.health IS DISTINCT FROM OLD.health
    OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.period_start IS DISTINCT FROM OLD.period_start
    OR NEW.period_end IS DISTINCT FROM OLD.period_end
    OR NEW.body IS DISTINCT FROM OLD.body
    OR NEW.body_text IS DISTINCT FROM OLD.body_text
  ) THEN
    RAISE EXCEPTION 'UPDATE_SCHEDULED: a scheduled update cannot be edited — unschedule it first';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER project_update_schedule_lock
  BEFORE UPDATE ON project_update
  FOR EACH ROW EXECUTE FUNCTION project_update_schedule_lock();

-- The hourly job's discovery reads every workspace's due posts by time; only
-- scheduled rows are ever in it, so it stays tiny. Prisma has no syntax for
-- the predicate, so the model does not declare it (schema.prisma's note).
CREATE INDEX "project_update_scheduled_for_idx"
  ON "project_update"("scheduled_for")
  WHERE scheduled_for IS NOT NULL;
