-- ── Work-tree guards: they serialise, explain themselves, and a
--    restore can never bring a hidden row back into view ─────────────
--
-- The first slice of the 2W item-panel work (PLAN §0, 2026-09-11). DDL
-- only — two function replacements, plus three new functions and their
-- three triggers. No statement here reads or rewrites a row, so
-- `neon-smoke.yml` is not required before push: CI's from-empty
-- `migrate deploy` plus the full db suite prove it.
--
-- 1. work_item_parent_guard reads the parent FOR SHARE whenever the
--    write could break child ≤ parent: an insert or a changed parent_id,
--    or a row that is CLIENT_VISIBLE after the write. THE WRITE-SKEW:
--    under READ COMMITTED a CLIENT_VISIBLE child insert and a concurrent
--    downgrade of its parent each passed their own guard blind to the
--    other's uncommitted row — the parent FK takes only FOR KEY SHARE,
--    which does not conflict with a no-key UPDATE of `visibility` — so
--    both committed, leaving a client-visible child under a private
--    parent. The share lock conflicts with the downgrade's row lock in
--    both orders: child first, the downgrade waits and then sees the
--    committed child; downgrade first, the child waits and then re-reads
--    the parent as INTERNAL. It is the fix document_anchor_guard v2 made
--    for attachments (20260831160000).
--    A NEW parent must also be LIVE: with the lock, a child racing its
--    parent's soft delete re-reads the dead row and is refused instead of
--    orphaned (deleteItem closes the other ordering by counting children
--    AFTER it holds the row).
--    Every other write — above all an existing child going (or staying)
--    INTERNAL, the safety lever — takes the plain, unlocked lookup: it
--    can break nothing, so it must never wait on its parent.
--    THE LOCK MAKES A WRITER OF TWO ROWS. A subtask insert holds the
--    project's bottom row (bottomRank) and a raise holds its own row (an
--    UPDATE locks its row before BEFORE triggers run) when this lock asks
--    for the parent — and the other multi-row writers (moves, rebalance,
--    bulk edits) lock rows by rank or scan order, never tree order, so no
--    lock ORDER can be imposed on them. The work services therefore
--    SERIALISE: each of them that locks more than one work_item row of a
--    project takes the project's rank advisory lock before its first row
--    lock (src/modules/work/rank-lock.ts, which also lists the older
--    lockers outside that queue). Among queued writers this lock never
--    closes a cycle; it waits only on single-row writers of the parent —
--    above all the parent's downgrade, the one writer it exists to wait
--    for. For raw writers it is the belt.
--    Every RAISE gains a stable leading token (the 2T convention,
--    src/modules/time/ctx.ts); the text after it is unchanged.
--    src/modules/work/db-errors.ts maps the ones a service can reach and
--    leaves the rest unmapped on purpose, so they surface as bugs.
--
-- 2. work_item_visibility_downgrade_guard: the leading token only. The
--    body is copied verbatim from its latest definition,
--    20260831150000_document_work_item_anchor:72-97.
--
-- 3. work_item / comment / document _restore_guard. Soft delete is an
--    application filter (DATA_MODEL §6.14), so the downgrade guard
--    rightly ignores dead rows — which means a CLIENT_VISIBLE subtask,
--    comment or attachment deleted under a visible item survives the
--    item's flip to INTERNAL still CLIENT_VISIBLE. Restoring it
--    (deleted_at := NULL) fired no guard at all: the row came back live,
--    gate-admitted, and re-indexed for the client's search. No restore
--    path exists in the app yet (the undo UI.md §5 promises is future
--    work), which is exactly why it is closed here rather than
--    remembered later — the note in 20260831150000 asked for this. A
--    restore needs a LIVE parent / subject / anchor; given one, a
--    CLIENT_VISIBLE row also needs it to be client-visible, and an
--    INTERNAL row is always accepted. Each trigger fires ONLY on a
--    restore (its WHEN clause), so a soft delete — a safety-positive
--    write — can never be blocked by it. The parent is share-locked for
--    the same write-skew reason as (1), which makes a restore a writer of
--    two rows: a future undo must take the project's rank lock first, as
--    the services in (1) do.
--    Chosen over flipping dead rows to INTERNAL inside the downgrade
--    guard, which would turn make-private — today a write of ONE row —
--    into a writer of many: it would have to join the rank-lock queue
--    (the lever would then wait behind creates, moves and bulk edits) or
--    risk cycles with them, and it would rewrite deleted rows' history
--    without an audit trail.
--
-- NOT here, deliberately, and recorded as a standing trap in PLAN §0:
-- comment_denorm_guard still reads its subject WITHOUT a lock and
-- without a liveness check, so the same write-skew is open for comments.
-- Nothing in the app writes a comment yet; the first comment writer (the
-- panel's comments slice, or the portal) must close it first. Whether a
-- reply may be more visible than its parent comment is an open founder
-- decision (PLAN §0).

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
    IF EXISTS (SELECT 1 FROM work_item c
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
      RAISE EXCEPTION 'WORK_ITEM_VISIBLE_CHILDREN: cannot make the item private while client-visible children exist';
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

-- ── Restore guards (3) ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION work_item_restore_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_visible boolean;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT (p.visibility = 'CLIENT_VISIBLE') INTO v_visible
    FROM work_item p
   WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.parent_id AND p.deleted_at IS NULL
   FOR SHARE OF p;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESTORE_PARENT_GONE: restore the parent work item first';
  END IF;
  IF NEW.visibility = 'CLIENT_VISIBLE' AND NOT v_visible THEN
    RAISE EXCEPTION 'RESTORE_VISIBILITY: a CLIENT_VISIBLE item cannot be restored under an INTERNAL parent';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER work_item_restore_guard
  BEFORE UPDATE OF deleted_at ON work_item
  FOR EACH ROW
  WHEN (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL)
  EXECUTE FUNCTION work_item_restore_guard();

-- Subject visibility is read exactly as comment_denorm_guard reads it;
-- liveness is the subject's own deleted_at (a FILE_VERSION lives and
-- dies with its document; a PROJECT_VERSION has no soft delete). Replies
-- are not re-checked against their parent comment: whether a reply may
-- out-see its parent is still an open decision (see the header).
CREATE OR REPLACE FUNCTION comment_restore_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_visible boolean;
BEGIN
  IF NEW.subject_type = 'WORK_ITEM' THEN
    SELECT (wi.visibility = 'CLIENT_VISIBLE') INTO v_visible
      FROM work_item wi
     WHERE wi.tenant_id = NEW.tenant_id AND wi.id = NEW.subject_id AND wi.deleted_at IS NULL
     FOR SHARE OF wi;
  ELSIF NEW.subject_type = 'DOCUMENT' THEN
    SELECT (d.visibility = 'CLIENT_VISIBLE') INTO v_visible
      FROM document d
     WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.subject_id AND d.deleted_at IS NULL
     FOR SHARE OF d;
  ELSIF NEW.subject_type = 'FILE_VERSION' THEN
    SELECT (d.visibility = 'CLIENT_VISIBLE') INTO v_visible
      FROM file_version fv
      JOIN document d ON d.tenant_id = fv.tenant_id AND d.id = fv.document_id
     WHERE fv.tenant_id = NEW.tenant_id AND fv.id = NEW.subject_id AND d.deleted_at IS NULL
     FOR SHARE OF d;
  ELSIF NEW.subject_type = 'PROJECT_VERSION' THEN
    -- No lock: nothing refuses un-shipping a version under its comments
    -- yet, so there is no concurrent guard to be blind to.
    SELECT (pv.status = 'SHIPPED') INTO v_visible
      FROM project_version pv
     WHERE pv.tenant_id = NEW.tenant_id AND pv.id = NEW.subject_id;
  ELSE
    RAISE EXCEPTION 'RESTORE_SUBJECT_GONE: comment subject type % cannot be restored', NEW.subject_type;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESTORE_SUBJECT_GONE: restore the comment''s subject first';
  END IF;
  IF NEW.visibility = 'CLIENT_VISIBLE' AND NOT v_visible THEN
    RAISE EXCEPTION 'RESTORE_VISIBILITY: a CLIENT_VISIBLE comment cannot be restored on a subject the client cannot see';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER comment_restore_guard
  BEFORE UPDATE OF deleted_at ON comment
  FOR EACH ROW
  WHEN (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL)
  EXECUTE FUNCTION comment_restore_guard();

-- A free-standing document (no anchor) has no parent to outlive. An
-- anchored one follows document_anchor_guard's rules for its item.
CREATE OR REPLACE FUNCTION document_restore_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_visible boolean;
BEGIN
  IF NEW.attached_to_type IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.attached_to_type <> 'WORK_ITEM' THEN
    RAISE EXCEPTION 'RESTORE_ANCHOR_GONE: document anchor type % cannot be restored', NEW.attached_to_type;
  END IF;
  SELECT (wi.visibility = 'CLIENT_VISIBLE') INTO v_visible
    FROM work_item wi
   WHERE wi.tenant_id = NEW.tenant_id AND wi.id = NEW.attached_to_id AND wi.deleted_at IS NULL
   FOR SHARE OF wi;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESTORE_ANCHOR_GONE: restore the document''s work item first';
  END IF;
  IF NEW.visibility = 'CLIENT_VISIBLE' AND NOT v_visible THEN
    RAISE EXCEPTION 'RESTORE_VISIBILITY: a CLIENT_VISIBLE document cannot be restored on an item the client cannot see';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER document_restore_guard
  BEFORE UPDATE OF deleted_at ON document
  FOR EACH ROW
  WHEN (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL)
  EXECUTE FUNCTION document_restore_guard();
