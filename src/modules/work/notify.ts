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

/**
 * WHO AT THE AGENCY HEARS ABOUT A CLIENT'S REQUEST — the receiver rule
 * for `work_item.request_received` (Phase 3 slice 6a).
 *
 * It lives beside the other fan-out helper rather than in `requests.ts`
 * because it IS one, and because a code review found the alternative
 * placement carried a real cost: `requests.ts` is scanned by the portal
 * tripwire's AST tier, and `Project.leadMemberId` is on the list of
 * columns no portal select may name. A receiver rule reading it belongs
 * on the member plane's own side of the wall.
 *
 * **The people assigned to the project, plus its lead.** That is the
 * narrowest honest answer: a `MemberProject` row is the product's own
 * statement that this member works on this project, and the lead is the
 * one name a project carries by itself. SUSPENDED members are excluded
 * — a notification to somebody who cannot sign in is an unread row for
 * ever — and the lead gets the same liveness check as the assignees,
 * since it is attribution with no foreign key and can name a member who
 * has since been removed.
 *
 * **IT CAN BE EMPTY, AND THAT IS NOT SILENTLY FINE.** A tenant whose
 * members all reach projects through a tenant-wide role has no
 * `MemberProject` rows at all, so a request there notifies nobody and is
 * visible only in the triage lane. The row is still created, still
 * audited and still on the board — nothing is lost — but the agency is
 * not TOLD. Widening this to "every member who could read the project"
 * means resolving scope for the whole tenant inside an intake
 * transaction, which is the triage-lane slice's problem to solve
 * properly (PLAN §0 carries it as owed). Until then the narrow set is
 * the honest one: it never mails somebody who has nothing to do with
 * the project.
 */
export async function requestReceivers(
  tx: TenantDb,
  tenantId: string,
  projectId: string,
): Promise<string[]> {
  // SEQUENTIAL, NOT `Promise.all`: these run on ONE interactive
  // transaction, which is ONE connection, so the parallel form is a
  // queue wearing concurrency's clothes.
  const assigned = await tx.memberProject.findMany({
    where: { tenantId, projectId },
    select: { memberId: true },
  });
  const project = await tx.project.findFirst({
    where: { tenantId, id: projectId },
    select: { leadMemberId: true },
  });
  const candidates = new Set(assigned.map((row) => row.memberId));
  if (project?.leadMemberId) candidates.add(project.leadMemberId);
  if (candidates.size === 0) return [];
  // One statement decides liveness for both sets.
  const active = await tx.member.findMany({
    where: { tenantId, id: { in: [...candidates] }, status: "ACTIVE" },
    select: { id: true },
  });
  return active.map((row) => row.id);
}
