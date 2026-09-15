import { assertInScope, type MemberActor } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import type { TenantDb } from "@/db";

import { lockItemRow, type RowLockMode } from "./rank-lock";

/**
 * A work item WITHOUT its description pair — what every writer that
 * diffs a row reads. The document can be 512 KB, and none of these
 * writers touches it (`states.ts` carries the same shape for the same
 * reason); `updateItemDescription` (description.ts) is the one that
 * does, with a read and a compare-and-set of its own. An inline `omit`
 * at the read, never a global one: `src/export/service.ts` dumps every
 * model select-less and would silently lose the column.
 */
export type ItemRow = Omit<
  NonNullable<Awaited<ReturnType<TenantDb["workItem"]["findFirst"]>>>,
  "description" | "descriptionText"
>;

type Ctx = { readonly tenantId: string; readonly actor: MemberActor };

/**
 * THE module's read of one live item for a writer: the row LOCKED, then
 * read, then the actor's scope asserted on its project — in that order,
 * because the lock is what makes the read the version the writer's
 * UPDATE replaces (rank-lock.ts). Read before the lock, a diff that
 * waited at its UPDATE described a row version the UPDATE never
 * replaced: `changed` for a no-op, a history row from a value the row
 * no longer held, an audit event for a transition never made, a mail to
 * a member who already held the task (slices 6 and 7, PLAN §0).
 *
 * Since slice 7 the lock is the DEFAULT, so an unlocked read is an
 * explicit, reviewable opt-out (`lock: false`) that only two kinds of
 * caller make: the PROBE a writer takes before it can know whether it
 * must queue on the project's rank lock (moveItem always queues;
 * changeItemVisibility queues only for a subtask's raise, so it probes
 * in every branch) — the queue key is the row's own `projectId`, and the
 * queue precedes any row lock (rank-lock.ts), so the row cannot be
 * locked yet — and a writer whose UPDATE is its own compare-and-set
 * (deleteItem). `updateItemDescription` reads outside this function
 * altogether, behind its own compare-and-set on the document, and
 * `createItem` reads no item it will write — only, for a subtask, its
 * PARENT under FOR SHARE (`lockItemRow(…, "SHARE")`). A writer whose
 * UPDATE writes `rank` or `number` asks for `"UPDATE"`, the mode that
 * UPDATE takes, so the lock never upgrades under it. A writer of
 * ANOTHER table's row that must hold the item still — a comment's task
 * (comments.ts, slice 10) — asks for `"SHARE"`: locked, read live and
 * scoped, then the child row, the order deleteItem takes them in.
 *
 * Not in the barrel: a service reads through it, a page never does.
 * A caller outside the project holds the lock only until `assertInScope`
 * refuses and the transaction rolls back — the same answer a row that
 * does not exist gets (AUTHZ §4).
 */
export async function loadItemInScope(
  tx: TenantDb,
  ctx: Ctx,
  itemId: string,
  opts: { lock?: RowLockMode | false } = {},
): Promise<ItemRow> {
  const lock = opts.lock ?? "NO KEY UPDATE";
  if (lock) await lockItemRow(tx, ctx.tenantId, itemId, lock);
  const item = await tx.workItem.findFirst({
    where: { tenantId: ctx.tenantId, id: itemId, deletedAt: null },
    omit: { description: true, descriptionText: true },
  });
  if (!item) deny("NOT_FOUND");
  await assertInScope(tx, ctx.actor, { projectId: item!.projectId });
  return item!;
}
