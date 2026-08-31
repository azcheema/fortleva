-- ── 2W-A: documents anchored to work items (DATA_MODEL §10, §6.8) ────
-- The Document.attached_to_type/attached_to_id columns have existed
-- since the file layer shipped, with zero writers. This migration adds
-- the guards the spec pins before the first writer lands:
--
--  1. document_anchor_guard — DB-side anchor consistency: an anchored
--     document's authorization columns (client_id, project_id) must
--     EQUAL its work item's (refused, never silently rewritten — the
--     anchor is a display pointer, the columns are the authority, and a
--     writer that disagrees is a bug worth hearing about), and a
--     document cannot be CLIENT_VISIBLE under an item the client cannot
--     see (the child ≤ parent rule). Anchor types other than WORK_ITEM
--     are refused until their slice ships.
--  2. work_item_visibility_downgrade_guard re-created with the missing
--     `deleted_at IS NULL` on its document branch (the item and comment
--     branches always had it) — found by the 2026-08-31 review: a
--     soft-deleted CLIENT_VISIBLE attachment would have blocked the
--     item's downgrade for its whole 30-day window. NOTE for a future
--     undelete feature: restoring a document must re-check child ≤
--     parent (no undelete path exists today).
--
-- No new table: grants are table-level, document is already class
-- B_projectScoped with the portal_enabled stamp + fan-out. BEFORE
-- INSERT/UPDATE only — cascade deletes are untouched (the trap a past
-- review caught).

-- Alphabetical trigger order on document:
--   document_anchor_guard < document_stamp_portal_enabled — fine, the
--   two read/write disjoint columns.
CREATE OR REPLACE FUNCTION document_anchor_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_client  text;
  v_project text;
  v_visible boolean;
BEGIN
  IF NEW.attached_to_type IS NULL AND NEW.attached_to_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.attached_to_type IS NULL OR NEW.attached_to_id IS NULL THEN
    RAISE EXCEPTION 'document anchor: attached_to_type and attached_to_id come together';
  END IF;
  IF NEW.attached_to_type <> 'WORK_ITEM' THEN
    RAISE EXCEPTION 'document anchor type % is not available yet', NEW.attached_to_type;
  END IF;
  SELECT wi.client_id, wi.project_id, (wi.visibility = 'CLIENT_VISIBLE')
    INTO v_client, v_project, v_visible
    FROM work_item wi
   WHERE wi.tenant_id = NEW.tenant_id AND wi.id = NEW.attached_to_id
     AND wi.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document anchor: work item not found in tenant';
  END IF;
  IF NEW.client_id IS DISTINCT FROM v_client
     OR NEW.project_id IS DISTINCT FROM v_project THEN
    RAISE EXCEPTION 'an attached document must carry its work item''s client and project';
  END IF;
  IF NEW.visibility = 'CLIENT_VISIBLE' AND NOT v_visible THEN
    RAISE EXCEPTION 'a document cannot be CLIENT_VISIBLE on an item the client cannot see';
  END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS document_anchor_guard ON document;
CREATE TRIGGER document_anchor_guard
  BEFORE INSERT OR UPDATE OF attached_to_type, attached_to_id, visibility, client_id, project_id
  ON document
  FOR EACH ROW EXECUTE FUNCTION document_anchor_guard();

-- The full function body from 20260821120000_review_guards, with ONE
-- change: `d.deleted_at IS NULL` joins the document branch.
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
                  AND d.attached_to_id = NEW.id AND d.visibility = 'CLIENT_VISIBLE'
                  AND d.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'cannot make the item private while client-visible children exist';
    END IF;
    -- History rows written while the item was client-visible follow it
    -- back behind the gate (the activity guard admits the flip).
    UPDATE work_item_activity
       SET visibility = 'INTERNAL'
     WHERE tenant_id = NEW.tenant_id AND work_item_id = NEW.id AND visibility = 'CLIENT_VISIBLE';
  END IF;
  RETURN NEW;
END
$fn$;
