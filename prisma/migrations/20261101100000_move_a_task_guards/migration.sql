-- ═══════════════════════════════════════════════════════════════════
-- Slice 131's review round — three guards the MOVE meets (founder decision
-- C108; docs/research/2026-10-17-slice-131-move-a-task-design.md §6).
-- Forward, never an edit of 20261101090000 (an applied migration's
-- checksum is fixed — AGENTS.md / the applied-migration rule).
--
--   1. `document_anchor_guard` (v2, 20260831160000 + one branch). A task in
--      the bin keeps its files, soft-deleted and still anchored to it
--      (`deleteItem`). Moving its parent moves that binned task too — and
--      its files with it — but the guard looked the anchor up with
--      `deleted_at IS NULL`, found nothing, and refused because the project
--      changed: a task whose binned subtask ever had a file could never move
--      (both reviews' HIGH/MEDIUM). Now, UNDER THE MOVE'S FLAG only, an
--      UPDATE of a dangling anchor may change `project_id` when it keeps the
--      anchor and the client, does not raise visibility, and the anchored
--      task — binned or not — is ALREADY in the new project (the move writes
--      the tasks first). Everything else is unchanged.
--
--   2. `time_entry_scope_guard` (20260820220000 + one lock). It read the
--      entry's task UNLOCKED: an hour saved while a move held the task
--      passed against the task's old project, then its foreign key waited
--      for the move and committed — an hour in the old project on a task in
--      the new one (the review's MEDIUM/LOW). The read is now `FOR KEY
--      SHARE OF wi`: it waits for a move (FOR UPDATE) and then re-reads the
--      moved row and refuses; it conflicts with nothing else an ordinary
--      task edit takes (FOR NO KEY UPDATE), and the entry's foreign key
--      takes the same lock a moment later anyway.
--
--   3. `work_item_parent_guard` (20261101090000 + one term). The move's
--      waiver of WORK_TREE_REPARENT now also requires the row's project to
--      CHANGE in the same statement: a re-parent to the top inside the
--      move's transaction that is not the move itself is refused as before
--      (the security review's NIT).
--
-- Function bodies only — no DDL on tables, no DML, no `neon-smoke.yml`
-- dispatch owed.
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. A binned task's file follows the move ────────────────────────
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
       AND NOT (NEW.visibility = 'CLIENT_VISIBLE' AND OLD.visibility = 'INTERNAL') THEN
      IF OLD.project_id IS NOT DISTINCT FROM NEW.project_id THEN
        RETURN NEW; -- the restrict lever on a dangling anchor
      END IF;
      -- Slice 131: a MOVE carrying a binned task's file, and only to the
      -- project that task is already in.
      IF coalesce(current_setting('app.work_item_move', true), '') = 'on'
         AND EXISTS (SELECT 1 FROM work_item wi
                      WHERE wi.tenant_id = NEW.tenant_id AND wi.id = NEW.attached_to_id
                        AND wi.client_id = NEW.client_id
                        AND wi.project_id = NEW.project_id) THEN
        RETURN NEW;
      END IF;
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

-- ── 2. An hour waits for a move of its task ─────────────────────────
CREATE OR REPLACE FUNCTION time_entry_scope_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_client     text;
  v_wi_project text;
  v_s_client   text;
  v_s_project  text;
BEGIN
  IF NEW.project_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT p.client_id INTO v_client
    FROM project p
   WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'time_entry: project not found in tenant';
  END IF;
  NEW.client_id := v_client;
  IF NEW.work_item_id IS NOT NULL THEN
    SELECT wi.project_id INTO v_wi_project
      FROM work_item wi
     WHERE wi.tenant_id = NEW.tenant_id AND wi.id = NEW.work_item_id
       FOR KEY SHARE OF wi;
    IF NOT FOUND OR v_wi_project <> NEW.project_id THEN
      RAISE EXCEPTION 'time_entry: work item must belong to the entry''s project';
    END IF;
  END IF;
  IF NEW.service_id IS NOT NULL THEN
    SELECT s.client_id, s.project_id INTO v_s_client, v_s_project
      FROM service s
     WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.service_id;
    IF NOT FOUND OR v_s_client <> NEW.client_id
       OR (v_s_project IS NOT NULL AND v_s_project <> NEW.project_id) THEN
      RAISE EXCEPTION 'SERVICE_CLIENT_MISMATCH: agreement must belong to the entry''s client (and project, when project-scoped)';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

-- ── 3. The re-parent waiver: only in the move's own statement ───────
CREATE OR REPLACE FUNCTION work_item_parent_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  p work_item%ROWTYPE;
  rank_new int;
  rank_parent int;
  new_parent boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    new_parent := true;
  ELSE
    new_parent := NEW.parent_id IS DISTINCT FROM OLD.parent_id;
  END IF;
  IF TG_OP = 'UPDATE' AND new_parent THEN
    -- Slice 131: the one waiver — a MOVE (its transaction-local flag) taking
    -- the row it moves to the top of ANOTHER project in this very statement.
    -- Its children follow it in the same transaction, each still under it.
    IF NOT (NEW.parent_id IS NULL
            AND NEW.project_id IS DISTINCT FROM OLD.project_id
            AND coalesce(current_setting('app.work_item_move', true), '') = 'on')
       AND EXISTS (SELECT 1 FROM work_item c
                    WHERE c.tenant_id = NEW.tenant_id AND c.parent_id = NEW.id) THEN
      RAISE EXCEPTION 'WORK_TREE_REPARENT: reparenting an item with children is a service operation';
    END IF;
  END IF;
  IF NEW.parent_id IS NULL THEN
    NEW.depth := 0;
    NEW.root_id := NEW.id;
  ELSE
    IF new_parent OR NEW.visibility = 'CLIENT_VISIBLE' THEN
      SELECT * INTO p FROM work_item
       WHERE tenant_id = NEW.tenant_id AND id = NEW.parent_id
       FOR SHARE;
    ELSE
      SELECT * INTO p FROM work_item
       WHERE tenant_id = NEW.tenant_id AND id = NEW.parent_id;
    END IF;
    IF NOT FOUND OR (new_parent AND p.deleted_at IS NOT NULL) THEN
      RAISE EXCEPTION 'WORK_TREE_PARENT_GONE: parent work item not found in tenant';
    END IF;
    IF p.project_id <> NEW.project_id THEN
      RAISE EXCEPTION 'WORK_TREE_PROJECT: parent must belong to the same project';
    END IF;
    rank_new := CASE NEW.type WHEN 'EPIC' THEN 0 WHEN 'TASK' THEN 1 ELSE 2 END;
    rank_parent := CASE p.type WHEN 'EPIC' THEN 0 WHEN 'TASK' THEN 1 ELSE 2 END;
    IF rank_parent >= rank_new THEN
      RAISE EXCEPTION 'WORK_TREE_NESTING: parent type must be strictly higher (EPIC > TASK > SUBTASK)';
    END IF;
    NEW.depth := p.depth + 1;
    NEW.root_id := p.root_id;
    IF NEW.depth > 2 THEN
      RAISE EXCEPTION 'WORK_TREE_NESTING: work item tree is at most three levels deep';
    END IF;
    IF NEW.visibility = 'CLIENT_VISIBLE' AND p.visibility <> 'CLIENT_VISIBLE' THEN
      RAISE EXCEPTION 'WORK_TREE_CHILD_VISIBILITY: a child cannot be CLIENT_VISIBLE under an INTERNAL parent';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
