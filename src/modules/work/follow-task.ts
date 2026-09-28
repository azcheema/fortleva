import { recordMany, type AuditInput } from "@/audit/record";
import type { TenantDb } from "@/db";

import { writeActivityMany } from "./activity";
import type { WorkCtx } from "./states";

/**
 * A CLIENT'S OWN COMMENTS FOLLOW THEIR TASK (founder decision C37,
 * 2026-09-28). Making a task private takes its whole thread out of the
 * client's view with it — `makePrivateWithChildren` lowers them, the
 * contact's words included — and sharing the task again brings the
 * client's own comments back. This is the second half: every path that
 * raises a task to CLIENT_VISIBLE calls it, in the same transaction,
 * after the task's own UPDATE (the comment trigger checks the subject's
 * LIVE visibility, so the task must already be shared):
 * `changeItemVisibility`'s raise, `bulkShare`, and `assignItemToContact`
 * when the hand-over is what shares it. Any future path that UPDATEs an
 * existing task to CLIENT_VISIBLE joins this list or the promise breaks.
 * CREATION IS NOT A RAISE: a new row has no comments to bring back, which
 * covers `createItem`'s inheritance from a shared parent today and the
 * composer's create-as-shared (slice 73) tomorrow.
 *
 * WHICH comments, and why the predicate is not simply "private and
 * written by a contact". Today those two sets are the same set, but only
 * because three facts hold together and nothing enforces all of them:
 * (a) a contact's comment is born CLIENT_VISIBLE (the census WITH CHECK,
 * under the contact principal only); (b) no member verb lowers one —
 * `setCommentVisibility` refuses, `comments.ts`; (c) the only other
 * lowering is a task make-private, which is what this undoes. A later
 * path that hides a client's comment for another reason (moderation, an
 * email intake writing as system) must revisit this function, and the
 * refusal in `setCommentVisibility` says so where that path would be
 * written. The belt the predicate CAN carry is the author's client: the
 * database ties `author_contact_id` to nothing (no foreign key, and the
 * only binding is the contact-principal WITH CHECK a system writer
 * bypasses), so a comment attributed to a contact of ANOTHER client is
 * never published to this one — the join below demands the author be a
 * contact of the comment's own client, which `comment_denorm_guard`
 * stamps from the task.
 *
 * ONLY COMMENTS ON THE TASK ITSELF. A client's comment on a file
 * attached to it went private with the file (the document's downgrade
 * guard requires it) and does not come back here, because the file does
 * not: files keep their own visibility and are shared again one at a
 * time. Raising the client's comments with a re-shared FILE belongs to
 * the slice that lets clients comment on files — a residual recorded in
 * PLAN §0's slice-72 entry; latent, because no contact comment writer
 * exists yet.
 *
 * LOCKED, THEN WRITTEN, THEN RECORDED FROM WHAT THE WRITE RETURNED. The
 * comment rows are locked after the task row the caller already holds —
 * item before comment, the order every comment writer keeps
 * (rank-lock.ts) — and the UPDATE's own RETURNING is the list the
 * history and the audit trail are built from, so a comment a colleague
 * deleted in the gap is neither raised nor claimed.
 */
export async function raiseClientCommentsWithTask(
  tx: TenantDb,
  ctx: WorkCtx,
  items: readonly {
    readonly id: string;
    readonly clientId: string;
    readonly projectId: string;
  }[],
  via: "share" | "bulk_share" | "contact_assignment",
): Promise<number> {
  if (items.length === 0) return 0;
  const ids = items.map((i) => i.id);
  const candidates = await tx.$queryRaw<{ id: string }[]>`
    SELECT c.id FROM comment c
      JOIN contact k
        ON k.tenant_id = c.tenant_id AND k.id = c.author_contact_id AND k.client_id = c.client_id
     WHERE c.tenant_id = ${ctx.tenantId}
       AND c.subject_type = 'WORK_ITEM'
       AND c.subject_id = ANY(${ids}::text[])
       AND c.author_contact_id IS NOT NULL
       AND c.visibility = 'INTERNAL'
       AND c.deleted_at IS NULL
     FOR NO KEY UPDATE OF c`;
  if (candidates.length === 0) return 0;
  const raised = await tx.comment.updateManyAndReturn({
    where: {
      tenantId: ctx.tenantId,
      id: { in: candidates.map((c) => c.id) },
      visibility: "INTERNAL",
      deletedAt: null,
    },
    data: { visibility: "CLIENT_VISIBLE" },
    select: { id: true, subjectId: true },
  });
  if (raised.length === 0) return 0;
  const itemOf = new Map(items.map((i) => [i.id, i]));
  // The task is shared by now (the caller's UPDATE ran first), so a
  // `commentVisibility` row could be client-visible by the item — but
  // the field is not on the portal-safe list, so every row is INTERNAL,
  // exactly as `setCommentVisibility` writes it.
  await writeActivityMany(
    tx,
    ctx,
    raised.map((c) => ({
      item: { ...itemOf.get(c.subjectId)!, visibility: "CLIENT_VISIBLE" as const },
      change: { field: "commentVisibility", oldValue: "INTERNAL", newValue: "CLIENT_VISIBLE", commentId: c.id },
    })),
  );
  await recordMany(
    tx,
    raised.map(
      (c): AuditInput => ({
        action: "comment.visibility_changed",
        targetType: "Comment",
        targetId: c.id,
        // Ids and flags, never words (SECURITY.md §7). `via` tells an
        // operator nobody pressed "show to client" on the comment: it
        // followed its task (C37).
        metadata: {
          from: "INTERNAL",
          to: "CLIENT_VISIBLE",
          workItemId: c.subjectId,
          projectId: itemOf.get(c.subjectId)!.projectId,
          via: "follows_task",
          cause: via,
        },
      }),
    ),
  );
  return raised.length;
}
