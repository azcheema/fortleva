-- ═══════════════════════════════════════════════════════════════════
-- Slice 126 — A BIN FOR DELETED TASKS (founder decision C102;
-- docs/research/2026-10-17-slice-126-task-bin-design.md §3.4).
--
-- A deleted task can now be brought back — from the project's "Deleted
-- tasks" page or the Undo on "Task deleted" — and it comes back PRIVATE
-- (C102 (b)): a task the client could see returns hidden from them, and
-- sharing it again is a fresh decision.
--
--   `work_item_restore_guard()` REPLACED: a task restored from deletion
--   (the trigger's WHEN: OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS
--   NULL — unchanged, so a soft delete is never refused by it) must land
--   INTERNAL, or the write is refused with `RESTORE_NOT_PRIVATE`. Checked
--   FIRST, before the parent: the function returns early for a task with
--   no parent, and C102 (b) holds for every task.
--
--   The service (`src/modules/work/bin.ts`) writes INTERNAL itself, in the
--   same UPDATE as `deleted_at = NULL`, so this is the belt for every
--   writer — present (the import's Bring back and its undo's reclaim
--   already restore INTERNAL rows only; `restoreImport` filters on it, the
--   undo bins nothing else) and future. The token stays UNMAPPED in
--   `src/modules/work/db-errors.ts`: reaching it is a bug worth seeing raw.
--
--   The task's comments and files need no rule of their own: with the task
--   INTERNAL, `comment_restore_guard` and `document_restore_guard`
--   (20260911200000) already refuse restoring a client-visible one onto it.
--
--   What is DROPPED from this function: its `RESTORE_VISIBILITY` branch (a
--   CLIENT_VISIBLE task under an INTERNAL parent), unreachable once every
--   restored task is INTERNAL. The comment and document functions keep
--   theirs. The parent rule is unchanged, word for word: a restore needs a
--   LIVE parent, share-locked (the write-skew reason in 20260911200000's
--   header), so a restore still takes the project's rank lock first.
--
-- DDL only: one function replaced, the trigger itself untouched, no row
-- read or written. Every row restored before this migration was restored
-- INTERNAL (the only restore paths are the import's), so nothing that
-- exists contradicts the rule.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION work_item_restore_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.visibility IS DISTINCT FROM 'INTERNAL' THEN
    RAISE EXCEPTION 'RESTORE_NOT_PRIVATE: a deleted work item comes back INTERNAL';
  END IF;
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM 1
    FROM work_item p
   WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.parent_id AND p.deleted_at IS NULL
   FOR SHARE OF p;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESTORE_PARENT_GONE: restore the parent work item first';
  END IF;
  RETURN NEW;
END
$fn$;
