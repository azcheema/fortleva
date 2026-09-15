import type { TenantDb } from "@/db";
import { emit } from "@/notify/emit";
import type { NotificationKind } from "@/notify/catalog";

import type { WorkCtx } from "./states";

/**
 * A notification about ONE work item, to members (assignment, a comment):
 * the deep link's two ids — the project key and the item number — are
 * read and packed here, once, so `assignItem` and `createComment` cannot
 * drift into two shapes of the same link (`src/notify/templates.ts`
 * builds it from exactly these params). `emit` drops the actor from the
 * receivers itself.
 */
export async function notifyItemMembers(
  tx: TenantDb,
  ctx: WorkCtx,
  item: { readonly id: string; readonly number: number; readonly clientId: string; readonly projectId: string },
  kind: NotificationKind,
  memberIds: readonly string[],
  dedupePrefix: string,
): Promise<void> {
  if (memberIds.length === 0) return;
  const project = await tx.project.findFirst({
    where: { tenantId: ctx.tenantId, id: item.projectId },
    select: { key: true },
  });
  await emit(tx, ctx.tenantId, {
    kind,
    entity: { type: "WorkItem", id: item.id },
    actorMemberId: ctx.actor.memberId,
    clientId: item.clientId,
    projectId: item.projectId,
    memberIds,
    params: { projectKey: project?.key ?? "", itemNumber: String(item.number) },
    dedupeKey: `${dedupePrefix}:${item.id}`,
  });
}
