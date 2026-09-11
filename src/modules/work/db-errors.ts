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
]);
