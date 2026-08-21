-- ═══════════════════════════════════════════════════════════════════
-- Follow-up to 20260821120000_review_guards (found by the review OF the
-- review fixes): project_budget_summary_fanout is AFTER DELETE as well,
-- and during a project cascade-delete the project_budget rows go before
-- the project_time_summary rows (FK creation order), so the fan-out
-- UPDATEd still-present summary rows of a project that was already gone
-- — and project_time_summary_stamp_visibility RAISEd "project not found".
-- No product path hard-deletes a project today (teardowns empty both
-- tables first); closed before it can bite. Runs as the owner.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION project_budget_summary_fanout() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_tenant  text := COALESCE(NEW.tenant_id, OLD.tenant_id);
  v_project text := COALESCE(NEW.project_id, OLD.project_id);
BEGIN
  -- A cascade from the project itself: nothing left to restamp.
  IF NOT EXISTS (SELECT 1 FROM project p WHERE p.tenant_id = v_tenant AND p.id = v_project) THEN
    RETURN NULL;
  END IF;
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
