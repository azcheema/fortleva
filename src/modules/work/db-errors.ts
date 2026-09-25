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
 *
 * WORK_MILESTONE_PROJECT (20260912120000) stays unmapped for the same
 * reason, and the M slice looked before deciding: `setItemMilestone`
 * reads the target milestone BOUND to the item's own project and
 * answers NOT_FOUND when there is none, nothing in the app moves a
 * milestone between projects or an item between them, and no service
 * deletes a milestone at all — so a member cannot reach the trigger,
 * and a raise that got through would be a bug worth seeing raw.
 *
 * `work_item_contact_assignee_visible` (2W) joins that list in slice 6c
 * and is worth naming, because it went from UNREACHABLE to reachable in
 * one commit: it says a contact-assigned row must be CLIENT_VISIBLE,
 * and until `assigneeContactId` got its first writer nothing could
 * violate it. Two writers can now, and both close the door themselves
 * rather than relying on a mapping — `assignItemToContact` writes the
 * visibility in the same statement as the assignment, and
 * `changeItemVisibility` ENDS the assignment when it goes private,
 * because the make-private lever must never fail (both fresh reviews of
 * this slice found the version that could). So the token stays unmapped
 * by this file's own rule: a member cannot reach it, and a raise that
 * got through would be a bug worth seeing raw rather than a sentence
 * inviting them to try something else.
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
  // The two label-name indexes (labels.ts): the schema's composite one
  // decides for a project-scoped name, and the partial expression index
  // on `(tenant_id, lower(name)) WHERE project_id IS NULL`
  // (20260915180000) decides for a tenant-wide one, case-insensitively —
  // NULL project ids are distinct to the composite index, so without the
  // second two tenant-wide labels named alike were both accepted.
  ["label_tenant_id_project_id_name_key", "LABEL_TAKEN"],
  ["label_tenant_wide_name_key", "LABEL_TAKEN"],
  // project_update_immutable / project_update_no_delete_published
  // (20260925200000): every service in `updates.ts` checks the status
  // and the retraction clock before it writes, so a raise here is the
  // belt catching a race — two members acting on one post in the same
  // second — and it is worth a sentence rather than a stack.
  ["UPDATE_IMMUTABLE", "UPDATE_IMMUTABLE"],
]);
