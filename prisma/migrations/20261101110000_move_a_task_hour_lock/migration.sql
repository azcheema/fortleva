-- ═══════════════════════════════════════════════════════════════════
-- Slice 131's narrow re-check — `time_entry_scope_guard`'s task lock,
-- narrowed (founder decision C108; design
-- docs/research/2026-10-17-slice-131-move-a-task-design.md §7). Forward,
-- never an edit of 20261101100000 (applied).
--
-- 20261101100000 made the guard read the entry's task `FOR KEY SHARE OF wi`
-- on EVERY insert and update, so an hour saved while a move holds its task
-- waits and is then refused (the review round's fix). But an EDIT of an
-- hour that keeps its task already holds that hour's row before the guard
-- runs (Postgres locks the old tuple first), and the move holds the task
-- and then wants the hour: a deadlock, and a member's ordinary edit lost to
-- it with no retry (the re-check's LOW). Such an edit never needed the lock:
-- its hour is already in the move's set, which the move locks and reads
-- after — whichever commits first, the other sees it.
--
-- So the lock is taken only where an hour JOINS a task: an INSERT, or an
-- UPDATE that changes `work_item_id`. That is the case the review round was
-- about (a timer started, an entry saved, onto a task being moved), and the
-- only one where the entry's foreign key takes the same KEY SHARE a moment
-- later anyway (an unchanged key skips the RI check). The comment in
-- 20261101100000 claimed it conflicted with no ordinary task edit; a rank
-- change is a key update of `(tenant_id, project_id, rank)` — such an hour
-- now queues briefly behind a drag of its task, with no cycle (a drag never
-- waits on an hour).
--
-- Function body only — no DDL on tables, no DML, no `neon-smoke.yml`
-- dispatch owed.
-- ═══════════════════════════════════════════════════════════════════

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
    IF TG_OP = 'INSERT' OR NEW.work_item_id IS DISTINCT FROM OLD.work_item_id THEN
      -- An hour JOINING a task waits for a move of it (slice 131).
      SELECT wi.project_id INTO v_wi_project
        FROM work_item wi
       WHERE wi.tenant_id = NEW.tenant_id AND wi.id = NEW.work_item_id
         FOR KEY SHARE OF wi;
    ELSE
      SELECT wi.project_id INTO v_wi_project
        FROM work_item wi
       WHERE wi.tenant_id = NEW.tenant_id AND wi.id = NEW.work_item_id;
    END IF;
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
