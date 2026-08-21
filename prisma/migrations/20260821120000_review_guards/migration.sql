-- ═══════════════════════════════════════════════════════════════════
-- 2W/2T follow-up — the independent review of 2026-08-21 (PLAN.md §0)
-- found two places where the DATABASE gate — the stated enforcement
-- point for "a client never sees internal data" — admitted rows the
-- application had already stopped sharing, plus one self-containment
-- gap. Nothing here changes what a member sees; every change is
-- fail-closed on the portal side. Runs as the owner.
--
--  1. work_item_activity: the field-history of a task keeps the
--     visibility it was WRITTEN with. Flipping the task back to INTERNAL
--     left its CLIENT_VISIBLE history rows passing the portal_gate (the
--     downgrade guard only looked at child items / comments / documents),
--     and nothing refused a CLIENT_VISIBLE history row on an INTERNAL
--     task (comment has comment_denorm_guard; activity had nothing).
--     History follows the item: the downgrade FLIPS the rows (history is
--     tenant-owned; refusing would make every downgrade after a safe-
--     field edit impossible), and a new BEFORE INSERT/UPDATE guard
--     derives client_id / project_id from the item and refuses
--     CLIENT_VISIBLE on an item the client cannot see.
--  2. project_time_summary: the hours-sharing fan-out nulled
--     billable_amount when the project left BILLABLE_AMOUNT but left
--     budget_amount (and budget_seconds for NONE) standing until the
--     next time-entry write recomputed that month — the trigger comment
--     said "the app recomputes the amounts afterwards", which was not
--     true for the mode-change path. The fan-out now re-derives all four
--     shared columns with the SAME expressions recomputeProjectMonth
--     uses, the per-row stamp nulls the budget columns fail-closed too,
--     and a budget change (new / archived / amount) restamps the
--     project's summary rows.
--  3. unaccent: the 2W text-search configurations depend on the
--     extension the Neon spike installed by hand; the 2W migration now
--     declares it (idempotent) so a from-scratch replay is
--     self-contained. Recorded here for the history; see PLAN.md §0.
-- ═══════════════════════════════════════════════════════════════════

-- ── 1a. work_item_activity denorm guard ──────────────────────────────
-- Sorts before work_item_activity_stamp_portal_enabled (alphabetical
-- trigger order), so the stamp sees the derived project_id.
CREATE OR REPLACE FUNCTION work_item_activity_denorm_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_client  text;
  v_project text;
  v_visible boolean;
BEGIN
  SELECT wi.client_id, wi.project_id, (wi.visibility = 'CLIENT_VISIBLE')
    INTO v_client, v_project, v_visible
    FROM work_item wi
   WHERE wi.tenant_id = NEW.tenant_id AND wi.id = NEW.work_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work_item_activity: work item not found in tenant';
  END IF;
  NEW.client_id := v_client;
  NEW.project_id := v_project;
  IF NEW.visibility = 'CLIENT_VISIBLE' AND NOT v_visible THEN
    RAISE EXCEPTION 'an activity row cannot be CLIENT_VISIBLE on an item the client cannot see';
  END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS work_item_activity_denorm_guard ON work_item_activity;
CREATE TRIGGER work_item_activity_denorm_guard
  BEFORE INSERT OR UPDATE OF visibility, work_item_id, client_id, project_id ON work_item_activity
  FOR EACH ROW EXECUTE FUNCTION work_item_activity_denorm_guard();

-- ── 1b. downgrade guard: refuse visible children, FLIP history ───────
CREATE OR REPLACE FUNCTION work_item_visibility_downgrade_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.visibility = 'CLIENT_VISIBLE' AND NEW.visibility = 'INTERNAL' THEN
    IF EXISTS (SELECT 1 FROM work_item c
                WHERE c.tenant_id = NEW.tenant_id AND c.parent_id = NEW.id
                  AND c.visibility = 'CLIENT_VISIBLE' AND c.deleted_at IS NULL)
       OR EXISTS (SELECT 1 FROM comment c
                WHERE c.tenant_id = NEW.tenant_id AND c.subject_type = 'WORK_ITEM'
                  AND c.subject_id = NEW.id
                  AND c.visibility = 'CLIENT_VISIBLE' AND c.deleted_at IS NULL)
       OR EXISTS (SELECT 1 FROM document d
                WHERE d.tenant_id = NEW.tenant_id AND d.attached_to_type = 'WORK_ITEM'
                  AND d.attached_to_id = NEW.id AND d.visibility = 'CLIENT_VISIBLE') THEN
      RAISE EXCEPTION 'cannot make the item private while client-visible children exist';
    END IF;
    -- History rows written while the item was client-visible follow it
    -- back behind the gate (the activity guard above admits the flip).
    UPDATE work_item_activity
       SET visibility = 'INTERNAL'
     WHERE tenant_id = NEW.tenant_id AND work_item_id = NEW.id AND visibility = 'CLIENT_VISIBLE';
  END IF;
  RETURN NEW;
END
$fn$;

-- ── 2a. per-row stamp: budget columns fail-closed as well ────────────
CREATE OR REPLACE FUNCTION project_time_summary_stamp_visibility() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  mode "HoursSharingMode";
BEGIN
  SELECT p.hours_sharing_mode INTO mode
    FROM project p
   WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project_time_summary: project not found in tenant';
  END IF;
  NEW.visibility := CASE WHEN mode <> 'NONE' THEN 'CLIENT_VISIBLE'::"Visibility" ELSE 'INTERNAL'::"Visibility" END;
  IF mode <> 'BILLABLE_AMOUNT' THEN
    NEW.billable_amount := NULL;
    NEW.budget_amount   := NULL;
  END IF;
  IF mode = 'NONE' THEN
    NEW.budget_seconds := NULL;
  END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS project_time_summary_stamp_visibility ON project_time_summary;
CREATE TRIGGER project_time_summary_stamp_visibility
  BEFORE INSERT OR UPDATE OF project_id, visibility, billable_amount, budget_amount, budget_seconds
  ON project_time_summary
  FOR EACH ROW EXECUTE FUNCTION project_time_summary_stamp_visibility();

-- ── 2b. mode change: re-derive every shared column of every month ────
-- Same expressions as recomputeProjectMonth (src/modules/time/summary.ts):
-- the amount only in BILLABLE_AMOUNT, the hours budget unless NONE, the
-- money budget only in BILLABLE_AMOUNT — so both directions are right
-- immediately, not on the next entry write.
CREATE OR REPLACE FUNCTION project_hours_sharing_fanout() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.hours_sharing_mode IS DISTINCT FROM OLD.hours_sharing_mode THEN
    UPDATE project_time_summary s
       SET visibility = CASE WHEN NEW.hours_sharing_mode <> 'NONE'
                             THEN 'CLIENT_VISIBLE'::"Visibility" ELSE 'INTERNAL'::"Visibility" END,
           billable_amount = CASE WHEN NEW.hours_sharing_mode = 'BILLABLE_AMOUNT'
             THEN (SELECT round(sum(CASE WHEN e.billable THEN e.duration_seconds::numeric / 3600 * e.bill_rate END), 2)
                     FROM time_entry e
                    WHERE e.tenant_id = s.tenant_id AND e.project_id = s.project_id
                      AND e.deleted_at IS NULL AND e.stopped_at IS NOT NULL
                      AND e.local_date >= s.period_month
                      AND e.local_date <  (s.period_month + interval '1 month'))
             ELSE NULL END,
           budget_seconds = CASE WHEN NEW.hours_sharing_mode <> 'NONE'
             THEN (SELECT round(b.amount * 3600)::int FROM project_budget b
                    WHERE b.tenant_id = s.tenant_id AND b.project_id = s.project_id
                      AND b.status = 'ACTIVE' AND b.kind = 'HOURS')
             ELSE NULL END,
           budget_amount = CASE WHEN NEW.hours_sharing_mode = 'BILLABLE_AMOUNT'
             THEN (SELECT b.amount FROM project_budget b
                    WHERE b.tenant_id = s.tenant_id AND b.project_id = s.project_id
                      AND b.status = 'ACTIVE' AND b.kind = 'MONEY')
             ELSE NULL END,
           computed_at = now()
     WHERE s.tenant_id = NEW.tenant_id AND s.project_id = NEW.id;
  END IF;
  RETURN NULL;
END
$fn$;

-- ── 2c. budget change: restamp the budget columns of the summary ─────
CREATE OR REPLACE FUNCTION project_budget_summary_fanout() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_tenant  text := COALESCE(NEW.tenant_id, OLD.tenant_id);
  v_project text := COALESCE(NEW.project_id, OLD.project_id);
BEGIN
  UPDATE project_time_summary s
     SET budget_seconds = (SELECT CASE WHEN p.hours_sharing_mode <> 'NONE'
             THEN (SELECT round(b.amount * 3600)::int FROM project_budget b
                    WHERE b.tenant_id = s.tenant_id AND b.project_id = s.project_id
                      AND b.status = 'ACTIVE' AND b.kind = 'HOURS')
             ELSE NULL END
             FROM project p WHERE p.tenant_id = s.tenant_id AND p.id = s.project_id),
         budget_amount = (SELECT CASE WHEN p.hours_sharing_mode = 'BILLABLE_AMOUNT'
             THEN (SELECT b.amount FROM project_budget b
                    WHERE b.tenant_id = s.tenant_id AND b.project_id = s.project_id
                      AND b.status = 'ACTIVE' AND b.kind = 'MONEY')
             ELSE NULL END
             FROM project p WHERE p.tenant_id = s.tenant_id AND p.id = s.project_id),
         computed_at = now()
   WHERE s.tenant_id = v_tenant AND s.project_id = v_project;
  RETURN NULL;
END
$fn$;
DROP TRIGGER IF EXISTS project_budget_summary_fanout ON project_budget;
CREATE TRIGGER project_budget_summary_fanout
  AFTER INSERT OR DELETE OR UPDATE OF status, amount, kind ON project_budget
  FOR EACH ROW EXECUTE FUNCTION project_budget_summary_fanout();

-- ── One-off repair: rows the old fan-out left stale ──────────────────
-- Restamp every existing summary row through the corrected stamp (a
-- no-op UPDATE OF budget_amount fires it); nothing a member sees changes.
UPDATE project_time_summary SET budget_amount = budget_amount;
-- History rows of items that are INTERNAL today follow their item.
UPDATE work_item_activity a
   SET visibility = 'INTERNAL'
  FROM work_item wi
 WHERE wi.tenant_id = a.tenant_id AND wi.id = a.work_item_id
   AND wi.visibility = 'INTERNAL' AND a.visibility = 'CLIENT_VISIBLE';
