"use server";

import { revalidatePath } from "next/cache";

import { switchActiveTenant } from "@/auth/active-tenant";
import { requireMemberSession } from "@/auth/session";
import { isUuid } from "@/db/context";
import { requireTenantContext } from "@/members/tenant-context";
import { markRead, notificationTarget } from "@/notify/inbox";

/**
 * A tap on a phone or browser notification (Phase 5 slice 106; C74 (a)):
 * find the notification among the signed-in person's OWN rows — in the
 * workspace they are in first, then in the others they are an active member
 * of (a push carries no workspace; the design review's L1) — mark it read
 * there, as pressing Enter on its inbox row does, and answer where to go: the
 * inbox's own link for it (scope-filtered by `notificationTarget`), else the
 * inbox.
 *
 * A notification of ANOTHER workspace moves the session's workspace pointer
 * there first (`switchActiveTenant` — the picker's own write, which matches the
 * id against the person's memberships before writing anything): the tap was a
 * choice of that workspace. Nothing is said about an id that is not theirs —
 * it lands on the inbox like any other.
 */
export async function openNotificationAction(id: unknown): Promise<{ href: string; switched: boolean }> {
  const inbox = { href: "/inbox", switched: false };
  if (typeof id !== "string" || !isUuid(id)) return inbox;
  const ctx = await requireTenantContext();
  const order = [
    ctx.membership,
    ...ctx.memberships.filter((m) => m.status === "ACTIVE" && m.tenantId !== ctx.membership.tenantId),
  ];
  for (const m of order) {
    // In turn: each workspace's read is its own transaction, as that workspace's member.
    const where = { tenantId: m.tenantId, actor: { ...ctx.actor, memberId: m.memberId } };
    const target = await notificationTarget(where, id);
    if (target === null) continue;
    let switched = false;
    if (m.tenantId !== ctx.membership.tenantId) {
      if (ctx.actor.impersonated) return inbox;
      const session = await requireMemberSession();
      const result = await switchActiveTenant({ sessionId: session.session.id, userId: ctx.userId, tenantId: m.tenantId });
      if (result !== "ok") return inbox;
      revalidatePath("/", "layout");
      switched = true;
    }
    await markRead(where, [id]);
    revalidatePath("/inbox");
    return { href: target.href ?? "/inbox", switched };
  }
  return inbox;
}
