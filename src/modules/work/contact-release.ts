import type { TenantDb } from "@/db";

import { writeActivityMany } from "./activity";
import type { WorkCtx } from "./states";

/**
 * TAKE BACK EVERY TASK A CONTACT WAS HOLDING — the work module's half of
 * "remove this person's portal access" (Phase 3, the invite slice).
 *
 * **THE FOUNDER'S ANSWER, 2026-09-23**: when a client contact loses
 * access, the tasks they held come back to the agency UNASSIGNED. An
 * assignment to somebody who cannot see the task is not an assignment —
 * which is not a new rule here, it is the one `changeItemVisibility`
 * already applies when making a task private ends a client assignment
 * rather than refusing the flip.
 *
 * **IT IS ALSO AN ERASURE CONTROL, and that is why it is not optional.**
 * `work_item.assignee_contact_id` has an FK to `contact` with ON DELETE
 * RESTRICT, and `deleteContact` permits deletion only of a contact with
 * no live access. Without this sweep a removed contact would still hold
 * rows, the FK would refuse the delete, and a person's record would be
 * undeletable because of a task nobody can see — the residue slice 6c's
 * review named, closed here by the slice that first writes the column
 * this depends on.
 *
 * **A CALLER-SUPPLIED TRANSACTION, never its own.** Removing access and
 * releasing the work are one act: a sweep that committed separately
 * could leave a contact revoked with tasks still named to them, or tasks
 * released for a revoke that then failed. The caller (`src/clients/
 * contact-access.ts`) already holds `client:manage_contacts` and has
 * asserted scope on the contact's client; this function authorizes
 * nothing and must never be called from anywhere that has not.
 *
 * ON THE BARREL, unlike `requests.ts`'s row shaper, because its one safe
 * caller is in ANOTHER module — the contact lifecycle belongs to
 * `clients/`, the work-item write belongs here, and ARC-16 routes the
 * import through the barrel exactly as `projects/portal-preview.ts`
 * already reaches `listPortalTasks`.
 *
 * **WHAT IT DOES NOT DO: it does not notify, AND NEITHER DOES ITS
 * CALLER — that is a decision, not an oversight.** The first version of
 * this docblock deferred the telling to `setContactPortalAccess`, which
 * tells nobody; a fresh code review caught the claim. Removing one
 * person's access is a single act the member is performing deliberately,
 * on a screen that says how many tasks come back (`releasedTasks`), so
 * mailing the project leads would be telling them about a decision they
 * watched somebody make. The trail is a `WorkItemActivity` row per task
 * and a count on the audit event; the tasks reappear unassigned on the
 * board, which is where work is noticed. If that proves wrong in use,
 * the notification belongs in the CALLER, which holds the member
 * context — never here, per task.
 */
export async function releaseContactAssignments(
  tx: TenantDb,
  ctx: WorkCtx,
  /**
   * **THE CLIENT IS A PARAMETER so the blast radius is bounded by the
   * ARGUMENT rather than by the caller's discipline** (a fresh security
   * review's note). The filter was `{ tenantId, assigneeContactId }` —
   * tenant-wide — and this function takes a caller-supplied transaction
   * and authorizes nothing, so a future caller under
   * `withTenant(tenantId, { type: 'system' })` that forgot its scope
   * assertion would unassign across clients with nothing below it to
   * stop the write. A contact belongs to exactly one client, so naming
   * it costs the caller nothing and makes the over-reach unrepresentable.
   */
  target: { readonly contactId: string; readonly clientId: string },
): Promise<{ readonly released: readonly { id: string; projectId: string; number: number }[] }> {
  // EVERY row, not only live ones. A task in a DONE or CANCELLED state
  // can still name the contact (the state machine clears the CLAIM on
  // arrival, never the assignment), and it is exactly those forgotten
  // rows that would block the erasure this sweep exists to unblock.
  // Soft-deleted rows too, for the same reason: the FK does not care
  // that `deleted_at` is set, and a 30-day window is long enough to
  // strand a deletion request.
  const held = await tx.workItem.findMany({
    where: { tenantId: ctx.tenantId, clientId: target.clientId, assigneeContactId: target.contactId },
    // INLINE, never select-less: a work item carries a 512 KB
    // ProseMirror document and this reads every row the contact holds.
    select: { id: true, number: true, projectId: true, clientId: true, visibility: true },
  });
  if (held.length === 0) return { released: [] };

  await tx.workItem.updateMany({
    where: { tenantId: ctx.tenantId, clientId: target.clientId, assigneeContactId: target.contactId },
    data: {
      assigneeContactId: null,
      // THE CLAIM GOES WITH THE ASSIGNMENT IT ANSWERS, and
      // `work_item_contact_completed_has_assignee` makes that a
      // requirement rather than a courtesy: leaving it behind writes a
      // row the CHECK refuses and the whole revoke would roll back.
      contactCompletedAt: null,
    },
  });

  // **THE VISIBILITY IS LEFT ALONE, deliberately.** Taking a person's
  // access away is not a decision to hide the work from their COMPANY —
  // a colleague of theirs may still be reading it, and `portal_gate` is
  // client-scoped (the founder's 2026-09-22 decision). A member who
  // wants it private says so with `V`.
  //
  // ONE HISTORY ROW PER TASK, so the trail says where the work went. It
  // is written against the item as it stands AFTER the update in every
  // respect the guard reads — `work_item_activity_denorm_guard`
  // re-reads the item's LIVE visibility, which this sweep does not
  // touch, so the rows below are safe by construction rather than by
  // ordering. (Slice 6c's own fix learned that the hard way.)
  // **ONE STATEMENT, NOT ONE PER TASK, and the transaction budget is
  // why.** `held` is deliberately unbounded — every state, soft-deleted
  // rows included — and the caller opens `withTenant` on the default 5 s
  // interactive budget. A two-year client contact with sixty tasks cost
  // sixty sequential inserts on a transatlantic link, and when the budget
  // ran out the WHOLE removal rolled back: access not revoked and the
  // erasure still blocked, for exactly the contacts most likely to need
  // removing. Found by a fresh code review.
  await writeActivityMany(
    tx,
    ctx,
    held.map((item) => ({
      item,
      change: { field: "assigneeContactId" as const, oldRef: target.contactId, newRef: null },
    })),
  );

  return { released: held.map((i) => ({ id: i.id, projectId: i.projectId, number: i.number })) };
}
