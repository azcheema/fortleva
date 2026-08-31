-- ── 2W-A follow-up: two review findings on document_anchor_guard ─────
--  1. FOR SHARE on the item lookup closes the write-skew the review
--     demonstrated analytically: under READ COMMITTED a CLIENT_VISIBLE
--     attachment commit and a concurrent item downgrade could each pass
--     their own guard blind to the other's uncommitted write. The share
--     lock conflicts with the downgrade's row UPDATE in both orderings.
--  2. An UPDATE that keeps the anchor and its authorization columns and
--     does NOT raise visibility no longer requires a live item: the
--     SAFETY-POSITIVE flip to INTERNAL must always work, even for an
--     attachment whose item is gone (the 30-day hard-delete sweep; §10
--     calls dangling anchors cosmetic — the v1 guard made them
--     functional write-blockers on the worst-bug lever). deleteItem now
--     soft-deletes anchored documents with the item, so this path is
--     maintenance-only — but the lever must work regardless.
-- INSERT semantics unchanged: a new anchor always needs a live item.

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
     AND wi.deleted_at IS NULL
     FOR SHARE OF wi;
  IF NOT FOUND THEN
    IF TG_OP = 'UPDATE'
       AND OLD.attached_to_type IS NOT DISTINCT FROM NEW.attached_to_type
       AND OLD.attached_to_id IS NOT DISTINCT FROM NEW.attached_to_id
       AND OLD.client_id IS NOT DISTINCT FROM NEW.client_id
       AND OLD.project_id IS NOT DISTINCT FROM NEW.project_id
       AND NOT (NEW.visibility = 'CLIENT_VISIBLE' AND OLD.visibility = 'INTERNAL') THEN
      RETURN NEW; -- the restrict lever on a dangling anchor
    END IF;
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
