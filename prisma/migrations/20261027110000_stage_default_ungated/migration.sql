-- ═══════════════════════════════════════════════════════════════════
-- Slice 123 (founder decision C99 (a)), part 3 — WHERE NEW TASKS START IS
-- NEVER GATED.
--
-- `createItem` and the import put a new task STRAIGHT into the project's
-- default stage, never through the state machine, so they never ask
-- `work_item:approve`. 20261027090000's `workflow_state_default_kind` closed
-- that for a Done default; a Backlog or To do stage marked "needs approval"
-- and made the default left the same hole open — anyone who may create a
-- task could put it into a gated stage (the slice's security review, LOW).
-- The stage editors refuse the pair first (`canStartHere`); this is the
-- database's copy, mapped to a sentence (`STAGE_DEFAULT_GATED`).
--
-- Both columns are mutable, so this is a plain row CHECK on the pair — any
-- write that would leave a row both default and gated is refused, whichever
-- column it changes. A separate migration from 20261027090000 only because
-- that one was already applied to dev when the review found this (an
-- applied migration is never edited — its checksum).
--
-- CONTACT WRITES: none — class A (`portal_deny`). DDL only — no DML, no
-- `neon-smoke.yml` dispatch owed. The guard refuses to run where a row
-- already breaks the rule, so the CHECK is never half-added.
-- ═══════════════════════════════════════════════════════════════════

-- The CHECK takes ACCESS EXCLUSIVE; taken at once with a bounded wait (the
-- imports migration's lesson, 20261026090000), never upgraded from the
-- guard's read.
SET LOCAL lock_timeout = '10s';
LOCK TABLE workflow_state IN ACCESS EXCLUSIVE MODE;

-- `row_security = off` IS LOAD-BEARING (20260906150000): a migrating role
-- without BYPASSRLS would otherwise see no rows and pass having looked at
-- nothing.
SET LOCAL row_security = off;
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM workflow_state WHERE is_default AND requires_approval) THEN
    RAISE EXCEPTION 'slice 123: a default workflow state needs approval; fix it before this migration';
  END IF;
END
$guard$;

ALTER TABLE workflow_state
  ADD CONSTRAINT workflow_state_default_ungated
  CHECK (NOT (is_default AND requires_approval));
