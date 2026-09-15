-- ── The comment guard locks and liveness-checks its subject, and the
--    activity history gets the index its keyset pages on ─────────────
--
-- The tenth slice of the 2W item-panel work — the Comments section —
-- and the first code that writes a comment outside a dbtest (PLAN §0,
-- 2026-09-15). DDL only: one function replaced, one index created. No
-- statement here reads or rewrites a row, so `neon-smoke.yml` is not
-- required before push; CI's from-empty `migrate deploy` plus the full
-- db suite prove it.
--
-- 1. comment_denorm_guard reads its subject FOR SHARE and refuses a
--    soft-deleted one for every write EXCEPT the one that can break
--    nothing: an UPDATE that leaves the row INTERNAL on the subject it
--    already had — the safety lever, which must never wait on its
--    subject (the parent guard's rule). An INSERT, a raise to
--    CLIENT_VISIBLE, and a change of subject (a column the trigger fires
--    on; no service moves a comment, but the trigger is the belt for raw
--    writers) all take the lock and the liveness check. THE WRITE-SKEW,
--    recorded as a standing trap since 2026-09-11: under READ COMMITTED
--    a CLIENT_VISIBLE comment insert and a concurrent make-private of
--    its task each passed their own guard blind to the other's
--    uncommitted row (the item's downgrade guard scans comments without
--    a lock; this guard read the item without one), so both committed
--    and a client-visible comment sat on a private task. The share lock
--    conflicts with the downgrade's row lock in both orders: comment
--    first, the downgrade waits and then sees the committed comment;
--    downgrade first, the comment waits and re-reads the item as
--    INTERNAL. It is exactly the fix work_item_parent_guard
--    (20260911200000) and document_anchor_guard v2 (20260831160000)
--    made for subtasks and attachments. A comment inserted while its
--    task is being deleted waits the same way and then finds the row
--    dead — refused, not orphaned outside the delete cascade
--    (comments/cascade.ts takes only the comments that exist when it
--    runs, and the search feed would otherwise keep the orphan's row).
--    LOCK ORDER, stated once. A comment write locks at most ONE
--    work_item row, and always BEFORE it touches a comment row: the
--    service share-locks the task first (rows.ts, lock "SHARE"), so the
--    trigger's FOR SHARE is re-entrant, and only then inserts or updates
--    the comment. deleteItem locks the task and then its thread — the
--    same order — so no cycle closes between them; a body edit, a
--    member's delete and a flip to INTERNAL lock only the comment row
--    and never take the task's share lock (their history row's foreign
--    key still takes FOR KEY SHARE on the task, as every activity
--    writer's does, so they can wait behind a rank move's FOR UPDATE —
--    never behind a make-private or a delete, which is what the share
--    lock would have added); an INSERT holds no comment row while it
--    waits. No work service that queues on the project's rank lock ever
--    locks a comment row (rank-lock.ts), so a comment writer never joins
--    that queue. The trigger's own lock is the belt for raw writers, the
--    contact's own INSERT included: FOR SHARE under a contact principal
--    must pass work_item's UPDATE USING, and `portal_gate` is RESTRICTIVE
--    FOR ALL, so it does — the contact-INSERT positive control in
--    work.dbtest.ts now exercises it.
--    Every RAISE gains a stable leading token (the 2T convention);
--    src/modules/work/db-errors.ts maps the ones a service can reach.
--    PROJECT_VERSION stays unlocked and un-liveness-checked, as in
--    comment_restore_guard: nothing refuses un-shipping a version under
--    its comments yet, so there is no concurrent guard to be blind to.
--
-- 2. work_item_activity (tenant_id, work_item_id, id): the panel's
--    Activity section pages by keyset on the UUIDv7 id (slice 8) and the
--    only per-item index was on created_at, so each page was a prefix
--    scan plus a top-N sort over the item's whole history. Three review
--    finders asked for it with slice 8; it was dispositioned to land
--    with this migration. The created_at index stays: the description's
--    coalescing read (description.ts — the newest row of one item within
--    ten minutes) still uses it.

CREATE OR REPLACE FUNCTION comment_denorm_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_client  text;
  v_project text;
  v_visible boolean;
  v_live    boolean;
  lock_it   boolean;
  par       comment%ROWTYPE;
BEGIN
  -- Everything locks and checks liveness except the one write that can
  -- break nothing: a row left INTERNAL on the subject it already had.
  lock_it := NOT (
    TG_OP = 'UPDATE'
    AND NEW.visibility = 'INTERNAL'
    AND NEW.subject_type = OLD.subject_type
    AND NEW.subject_id = OLD.subject_id
  );
  IF NEW.subject_type = 'WORK_ITEM' THEN
    IF lock_it THEN
      SELECT wi.client_id, wi.project_id, (wi.visibility = 'CLIENT_VISIBLE'), (wi.deleted_at IS NULL)
        INTO v_client, v_project, v_visible, v_live
        FROM work_item wi
       WHERE wi.tenant_id = NEW.tenant_id AND wi.id = NEW.subject_id
       FOR SHARE OF wi;
    ELSE
      SELECT wi.client_id, wi.project_id, (wi.visibility = 'CLIENT_VISIBLE'), (wi.deleted_at IS NULL)
        INTO v_client, v_project, v_visible, v_live
        FROM work_item wi
       WHERE wi.tenant_id = NEW.tenant_id AND wi.id = NEW.subject_id;
    END IF;
  ELSIF NEW.subject_type = 'DOCUMENT' THEN
    IF lock_it THEN
      SELECT d.client_id, d.project_id, (d.visibility = 'CLIENT_VISIBLE'), (d.deleted_at IS NULL)
        INTO v_client, v_project, v_visible, v_live
        FROM document d
       WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.subject_id
       FOR SHARE OF d;
    ELSE
      SELECT d.client_id, d.project_id, (d.visibility = 'CLIENT_VISIBLE'), (d.deleted_at IS NULL)
        INTO v_client, v_project, v_visible, v_live
        FROM document d
       WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.subject_id;
    END IF;
  ELSIF NEW.subject_type = 'PROJECT_VERSION' THEN
    SELECT pv.client_id, pv.project_id, (pv.status = 'SHIPPED'), true
      INTO v_client, v_project, v_visible, v_live
      FROM project_version pv
     WHERE pv.tenant_id = NEW.tenant_id AND pv.id = NEW.subject_id;
  ELSIF NEW.subject_type = 'FILE_VERSION' THEN
    -- A file version lives and dies with its document, which is also
    -- where its visibility is; the lock goes on the document.
    IF lock_it THEN
      SELECT d.client_id, d.project_id, (d.visibility = 'CLIENT_VISIBLE'), (d.deleted_at IS NULL)
        INTO v_client, v_project, v_visible, v_live
        FROM file_version fv
        JOIN document d ON d.tenant_id = fv.tenant_id AND d.id = fv.document_id
       WHERE fv.tenant_id = NEW.tenant_id AND fv.id = NEW.subject_id
       FOR SHARE OF d;
    ELSE
      SELECT d.client_id, d.project_id, (d.visibility = 'CLIENT_VISIBLE'), (d.deleted_at IS NULL)
        INTO v_client, v_project, v_visible, v_live
        FROM file_version fv
        JOIN document d ON d.tenant_id = fv.tenant_id AND d.id = fv.document_id
       WHERE fv.tenant_id = NEW.tenant_id AND fv.id = NEW.subject_id;
    END IF;
  ELSE
    RAISE EXCEPTION 'COMMENT_SUBJECT_TYPE: comment subject type % not available yet', NEW.subject_type;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COMMENT_SUBJECT_GONE: comment subject not found in tenant';
  END IF;
  IF lock_it AND NOT v_live THEN
    RAISE EXCEPTION 'COMMENT_SUBJECT_GONE: comment subject is deleted';
  END IF;
  NEW.client_id := v_client;
  NEW.project_id := v_project;
  IF NEW.visibility = 'CLIENT_VISIBLE' AND NOT v_visible THEN
    RAISE EXCEPTION 'COMMENT_NOT_VISIBLE: a comment cannot be CLIENT_VISIBLE on a subject the client cannot see';
  END IF;
  IF NEW.parent_id IS NOT NULL THEN
    SELECT * INTO par FROM comment
     WHERE tenant_id = NEW.tenant_id AND id = NEW.parent_id;
    IF NOT FOUND OR par.subject_type <> NEW.subject_type OR par.subject_id <> NEW.subject_id THEN
      RAISE EXCEPTION 'COMMENT_REPLY_SUBJECT: a reply must share its parent''s subject';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

-- The trigger itself is unchanged (BEFORE INSERT OR UPDATE OF
-- subject_type, subject_id, parent_id, visibility — 20260820170000): a
-- body edit or a soft delete never fires it, so neither waits on the
-- subject.

-- ── 2. the activity keyset index ────────────────────────────────────
CREATE INDEX "work_item_activity_tenant_id_work_item_id_id_idx"
  ON "work_item_activity"("tenant_id", "work_item_id", "id");
