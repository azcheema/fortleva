import type { TenantDb } from "@/db";
import type { WorkCtx } from "./states";

/**
 * Field-level history rows (§6.14). The PORTAL-SAFE LIST is the whole
 * portal story for activity: a row is CLIENT_VISIBLE only when its
 * field is on this list AND the item is CLIENT_VISIBLE at write time —
 * the service decides, the row carries it, portal_gate enforces it.
 * Everything else (labels, estimates, priority, assigneeMemberId,
 * internal comments) is INTERNAL by construction.
 */

const PORTAL_SAFE_FIELDS: ReadonlySet<string> = new Set([
  "stateCategory",
  "title",
  "targetDate",
  "milestoneId",
  "assigneeContactId",
]);

type ItemRef = {
  readonly id: string;
  readonly clientId: string;
  readonly projectId: string;
  readonly visibility: "INTERNAL" | "CLIENT_VISIBLE";
};

export async function writeActivity(
  tx: TenantDb,
  ctx: WorkCtx,
  item: ItemRef,
  change: {
    readonly field: string;
    readonly oldValue?: string | null;
    readonly newValue?: string | null;
    readonly oldRef?: string | null;
    readonly newRef?: string | null;
    /** visibility flips: only the flip TO CLIENT_VISIBLE is portal-safe. */
    readonly forceInternal?: boolean;
  },
): Promise<void> {
  const portalSafe =
    !change.forceInternal &&
    PORTAL_SAFE_FIELDS.has(change.field) &&
    item.visibility === "CLIENT_VISIBLE";
  await tx.workItemActivity.create({
    data: {
      tenantId: ctx.tenantId,
      clientId: item.clientId,
      projectId: item.projectId,
      workItemId: item.id,
      actorMemberId: ctx.actor.memberId,
      field: change.field,
      oldValue: change.oldValue ?? null,
      newValue: change.newValue ?? null,
      oldRef: change.oldRef ?? null,
      newRef: change.newRef ?? null,
      visibility: portalSafe ? "CLIENT_VISIBLE" : "INTERNAL",
    },
  });
}
