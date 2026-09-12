-- ── Schema belts under the item panel: the feed stops re-tokenising,
--    history cannot claim a field it is not allowed to show, the
--    checklist counters cannot lie, and a milestone stays in its
--    project ──────────────────────────────────────────────────────────
--
-- The third slice of the 2W item-panel work, and the second of its
-- migrations (PLAN §0; the panel foundation between them carried none).
-- DDL only — one
-- trigger re-created, two CHECK constraints, one new guard. NO DML: not
-- a row is written. But `VALIDATE CONSTRAINT` twice below READS every
-- existing row and aborts on one that violates, and CI — which migrates
-- from EMPTY — structurally cannot see that. What was audited instead:
-- the only writer of work_item_activity is `writeActivity`, which
-- derives visibility from the same five-field list, so no row it wrote
-- can violate; `checklist_total`/`checklist_done` have no writer at all
-- and sit at their 0 defaults. A `neon-smoke.yml` dispatch is what would
-- PROVE that against the real rows (it is already owed for
-- 20260906150000), rather than resting on this audit.
--
-- 1. search_feed_work_item fires on `UPDATE OF` the columns it actually
--    reads, not on EVERY update. It reads tenant/client/project, the
--    visibility pair, title, number, description_text, state_category
--    and the assignee; `deleted_at` is in the list because a soft delete
--    must still EVICT the row. Today every write re-runs it: a drag
--    across the board writes only `rank`, and the feed still re-reads
--    the project, rebuilt the row and re-tokenised the whole
--    description — which is a 100k-character tsvector per reorder once
--    the description editor ships (the next slice). `state_id` is in the
--    list even though the function never reads it: `state_category` is
--    derived by the BEFORE trigger work_item_state_sync, and an
--    `UPDATE OF` list is matched against the columns the STATEMENT sets,
--    not against what a BEFORE trigger then changes — so a writer that
--    set only `state_id` would leave the index holding the old category.
--    (`transitionState` sets both today; the belt is for the next writer.)
--
-- 2. work_item_activity gets the portal-safe field list as a CHECK. The
--    rule is pinned in the work-management plan §3.2 and lives in
--    src/modules/work/activity.ts, where it has always been application
--    code: a history row may be CLIENT_VISIBLE only for stateCategory,
--    title, targetDate, milestoneId or assigneeContactId. A row about a
--    label, an estimate, a priority, a description or an internal
--    comment is INTERNAL by construction — and now by constraint. Be
--    precise about what that buys: the list stops living only in a
--    TypeScript Set, so a RAW insert, an import, or a second writer that
--    never imports `writeActivity` cannot mint a client-visible row
--    about a field the portal does not show. It does NOT catch a
--    forgotten `forceInternal` on a field that IS on the list — that is
--    per-field semantics the constraint cannot see, and it is exactly
--    the bug the states.ts half of this slice fixes by hand.
--    NOT VALID + VALIDATE: the scan proves the existing rows, and the
--    table is small (history of one tenant's items).
--
-- 3. work_item's checklist counters are denormalised from the Tiptap
--    description by a service that does not exist yet. The CHECK states
--    what the panel renders as "n of m": neither counter is negative and
--    done never exceeds total. Cheaper to state now than to discover
--    from a progress bar past 100%.
--
-- 4. work_item_milestone_guard: a milestone must belong to the item's
--    project. The composite FK only binds the TENANT (20260820170000
--    :496), so any milestone of any project of the tenant is accepted
--    today — and a milestone carries its own visibility, so a task
--    borrowed into another project's milestone would appear under a
--    heading its client never shares. No service writes milestone_id
--    yet; the guard lands before the picker (the M slice) rather than
--    after it, and its token stays unmapped until that slice maps it.

-- ── 1. the feed's column list ───────────────────────────────────────
DROP TRIGGER IF EXISTS search_feed_work_item ON work_item;
CREATE TRIGGER search_feed_work_item
  AFTER INSERT OR DELETE OR UPDATE OF
    client_id, project_id, visibility, portal_enabled, title, number,
    description_text, state_category, state_id, assignee_member_id, deleted_at
  ON work_item
  FOR EACH ROW EXECUTE FUNCTION search_feed_work_item();

-- ── 2. history may only be client-visible about a portal-safe field ──
ALTER TABLE work_item_activity
  ADD CONSTRAINT work_item_activity_portal_safe_field
  CHECK (
    visibility = 'INTERNAL'
    OR field IN ('stateCategory', 'title', 'targetDate', 'milestoneId', 'assigneeContactId')
  ) NOT VALID;
ALTER TABLE work_item_activity VALIDATE CONSTRAINT work_item_activity_portal_safe_field;

-- ── 3. the checklist counters ───────────────────────────────────────
ALTER TABLE work_item
  ADD CONSTRAINT work_item_checklist_bounds
  CHECK (checklist_total >= 0 AND checklist_done >= 0 AND checklist_done <= checklist_total) NOT VALID;
ALTER TABLE work_item VALIDATE CONSTRAINT work_item_checklist_bounds;

-- ── 4. a milestone belongs to the item's project ────────────────────
CREATE OR REPLACE FUNCTION work_item_milestone_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_project text;
BEGIN
  IF NEW.milestone_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT m.project_id INTO v_project
    FROM milestone m
   WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.milestone_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WORK_MILESTONE_PROJECT: milestone not found in tenant';
  END IF;
  IF v_project <> NEW.project_id THEN
    RAISE EXCEPTION 'WORK_MILESTONE_PROJECT: a milestone must belong to the item''s project';
  END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS work_item_milestone_guard ON work_item;
CREATE TRIGGER work_item_milestone_guard
  BEFORE INSERT OR UPDATE OF milestone_id, project_id ON work_item
  FOR EACH ROW EXECUTE FUNCTION work_item_milestone_guard();
