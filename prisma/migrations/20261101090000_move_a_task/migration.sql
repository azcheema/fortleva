-- ═══════════════════════════════════════════════════════════════════
-- Slice 131 — MOVE A TASK TO ANOTHER PROJECT OF ITS CLIENT (founder
-- decision C108 (a)–(c); docs/research/2026-10-17-slice-131-move-a-task-design.md
-- §3.1).
--
-- Until now the database refused ANY change of a task's project
-- (`work_item_no_move`: "a service operation — renumber, restate, re-rank,
-- re-client — never a column update"). This migration lets exactly that
-- service operation through, and nothing else:
--
--   1. `work_item_no_move`, replaced. A change of `client_id` is refused
--      ALWAYS — C108 (a): a task never leaves its client. A change of
--      `project_id` is refused unless the transaction has set
--      `app.work_item_move` to 'on' (the move service, `move.ts`, sets it
--      with `set_config(..., true)` — transaction-local), and then only to a
--      project of the SAME client. The flag is read with `coalesce(..., '')`:
--      a GUC never set in the session reads as NULL, and `IF NOT NULL`
--      refuses nothing (the NULL-GUC trap, slice 113b).
--
--   2. `work_item_parent_guard`, replaced — the 2026-09-11 body
--      (20260911200000_work_tree_guards) with ONE change: re-parenting a row
--      that has children (`WORK_TREE_REPARENT`) is waived only under the
--      same flag AND only when the row is taken to the TOP (`parent_id`
--      NULL). The move detaches the task it moves from its parent; nothing
--      else re-parents, under the flag or not. Every other check is
--      unchanged, and a child's project still must equal its parent's
--      (`WORK_TREE_PROJECT`) — the move writes the parent first.
--
--   3. `work_item_alias` (C108 (c)) — a moved task's OLD key: one row per
--      `(project, number)` it had before, pointing at the task. Class A
--      (tenant_isolation + portal_deny): the agency's bookkeeping, never a
--      contact's. Cascades with the project and with the task; RESTRICTs the
--      tenant, as every table does.
--
-- Every other row a moved task carries — its history, comments, files and
-- hours — already accepts a new project through its own guards once the
-- task is there (the design's §2), and `stamp_portal_enabled` re-derives
-- each one's `portal_enabled` from the new project whenever `project_id` is
-- in the statement's SET list (the move names it in every UPDATE).
--
-- CONTACT WRITES AND READS: none new. A contact principal never moves a
-- task; `work_item_alias` is closed to it outright.
--
-- DDL and function bodies only — no DML, no `neon-smoke.yml` dispatch owed.
-- ═══════════════════════════════════════════════════════════════════

-- ── The table lock, FIRST ───────────────────────────────────────────
-- The new foreign keys take `work_item` and `project` in SHARE ROW
-- EXCLUSIVE. Taken here, before anything else, with a BOUNDED wait (the
-- repeating-tasks migration's rule).
SET LOCAL lock_timeout = '10s';
LOCK TABLE work_item IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE project IN SHARE ROW EXCLUSIVE MODE;

-- ── 1. A task's project changes only in a move, and only within its client ──
CREATE OR REPLACE FUNCTION work_item_no_move() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  target_client text;
BEGIN
  IF NEW.client_id IS DISTINCT FROM OLD.client_id THEN
    RAISE EXCEPTION 'WORK_MOVE_CLIENT: a work item never moves to another client';
  END IF;
  IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    IF coalesce(current_setting('app.work_item_move', true), '') <> 'on' THEN
      RAISE EXCEPTION 'moving a work item across projects is a service operation';
    END IF;
    SELECT p.client_id INTO target_client
      FROM project p
     WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.project_id;
    IF target_client IS DISTINCT FROM NEW.client_id THEN
      RAISE EXCEPTION 'WORK_MOVE_CLIENT: a work item moves only to a project of its own client';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

-- ── 2. The tree guard: a move may take a task with children to the top ──
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
    -- the row it moves to the top of the other project. Its children follow
    -- it in the same transaction, each still under it.
    IF NOT (NEW.parent_id IS NULL
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

-- ── 3. A moved task's old key ───────────────────────────────────────
-- CreateTable
CREATE TABLE "work_item_alias" (
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_item_alias_pkey" PRIMARY KEY ("tenant_id","project_id","number")
);

-- CreateIndex: every old key of one task (the cascade, and a second move).
CREATE INDEX "work_item_alias_tenant_id_work_item_id_idx" ON "work_item_alias"("tenant_id", "work_item_id");

-- AddForeignKey
ALTER TABLE "work_item_alias" ADD CONSTRAINT "work_item_alias_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: with the project the key belonged to.
ALTER TABLE "work_item_alias" ADD CONSTRAINT "work_item_alias_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: with the task it names.
ALTER TABLE "work_item_alias" ADD CONSTRAINT "work_item_alias_tenant_id_work_item_id_fkey" FOREIGN KEY ("tenant_id", "work_item_id") REFERENCES "work_item"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- An old key is a real number: the project's counter starts at 1.
ALTER TABLE work_item_alias
  ADD CONSTRAINT work_item_alias_number_positive CHECK (number > 0);

-- ── Grants ──────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON work_item_alias TO app_runtime;

-- ── RLS — class A (portal_deny; no visibility) ──────────────────────
ALTER TABLE work_item_alias ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_item_alias FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON work_item_alias
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON work_item_alias
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');
