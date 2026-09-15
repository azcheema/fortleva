import { dbErrorMapper } from "@/lib/db-error-map";

/**
 * The work-tree triggers' tokens (20260911200000_work_tree_guards) that a
 * member can reach through a service. Unmapped on purpose, so they
 * surface as bugs: WORK_TREE_REPARENT and WORK_TREE_PROJECT (no service
 * reparents or crosses projects — the services pre-check both),
 * WORK_TREE_PARENT_GONE (createItem share-locks and re-reads the parent
 * first, so a vanished parent is its NOT_FOUND) and the RESTORE_* family
 * (nothing in the app restores a soft-deleted row yet; the undo that
 * does maps them then).
 */
export const { mapDbError, guarded } = dbErrorMapper([
  ["WORK_ITEM_VISIBLE_CHILDREN", "HAS_VISIBLE_CHILDREN"],
  ["WORK_TREE_CHILD_VISIBILITY", "PARENT_NOT_VISIBLE"],
  ["WORK_TREE_NESTING", "CANNOT_NEST"],
  // comment_denorm_guard (20260915120000): a client-visible comment on a
  // task the client cannot see — reachable when the task is made private
  // between the composer's render and the post. COMMENT_SUBJECT_GONE is
  // unmapped: the comment services share-lock the task and re-read it
  // live before any write, so the trigger cannot find a subject they
  // did not.
  ["COMMENT_NOT_VISIBLE", "SUBJECT_NOT_VISIBLE"],
]);
