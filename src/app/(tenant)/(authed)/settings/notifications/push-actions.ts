"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { getMemberSession, requireMemberSession } from "@/auth/session";
import { runAction, type ActionResult } from "@/lib/server-actions";
import { membershipsFor, requireTenantContext } from "@/members/tenant-context";
import {
  endpointHeldElsewhere,
  registerPushDevice,
  removePushDevice,
  resumePushDevices,
  type PushSubscriptionInput,
} from "@/push/devices";

/**
 * Phone and browser notifications' verbs (Phase 5 slice 106; founder decision
 * C74). The tenant, the member and the SESSION always come from the request —
 * never from the arguments, which carry only what the browser's
 * `PushSubscription.toJSON()` holds (or a device row's id), and are checked as
 * hostile in `src/push/devices.ts`.
 */

/** The browser's `PushSubscription.toJSON()`, read defensively — it crossed the wire. */
function subscriptionOf(json: unknown): PushSubscriptionInput {
  const s = json !== null && typeof json === "object" ? (json as { endpoint?: unknown; keys?: unknown }) : {};
  const keys = s.keys !== null && typeof s.keys === "object" ? (s.keys as { p256dh?: unknown; auth?: unknown }) : {};
  return { endpoint: s.endpoint, p256dh: keys.p256dh, auth: keys.auth };
}

const PAGE = "/settings/notifications";

/** "Turn on for this device." */
export async function registerPushDeviceAction(subscription: unknown): Promise<ActionResult<{ id: string }>> {
  const { membership, actor } = await requireTenantContext();
  const session = await requireMemberSession();
  const userAgent = (await headers()).get("user-agent");
  const r = await runAction(PAGE, () =>
    registerPushDevice(
      { tenantId: membership.tenantId, actor, sessionId: session.session.id, userAgent },
      subscriptionOf(subscription),
    ),
  );
  if (r.ok) revalidatePath(PAGE);
  return r;
}

/**
 * "Remove", and "Turn off for this device". `stillInUse`: the same browser is
 * still turned on in another of this person's workspaces — the page then leaves
 * the browser's subscription alone (one origin, one subscription, every
 * workspace).
 */
export async function removePushDeviceAction(id: unknown): Promise<ActionResult<{ removed: boolean; stillInUse: boolean }>> {
  const { membership, memberships, actor } = await requireTenantContext();
  const r = await runAction(PAGE, async () => {
    const endpoint = await removePushDevice({ tenantId: membership.tenantId, actor }, id);
    if (endpoint === null) return { removed: false, stillInUse: false };
    const others = memberships
      .filter((m) => m.status === "ACTIVE" && m.tenantId !== membership.tenantId)
      .map((m) => ({ tenantId: m.tenantId, memberId: m.memberId }));
    return { removed: true, stillInUse: await endpointHeldElsewhere(others, endpoint) };
  });
  if (r.ok) revalidatePath(PAGE);
  return r;
}

/**
 * The quiet re-link on every full page load of the member plane (C74 (d);
 * `PwaRegister`): this browser had notifications on, so the signed-in person's
 * OWN row for it — in every workspace they are active in — follows them to
 * this sign-in. Never `requireTenantContext`: its redirect would reject the
 * caller's promise on a page with nothing to say about it. It answers nothing
 * and throws nothing; a failure is logged by name and code.
 */
export async function resumePushDevicesAction(subscription: unknown): Promise<void> {
  try {
    const session = await getMemberSession();
    if (session === null) return;
    const memberships = (await membershipsFor(session.user.id)).filter((m) => m.status === "ACTIVE");
    await resumePushDevices(
      {
        sessionId: session.session.id,
        impersonated: Boolean((session.session as { impersonatedBy?: string | null }).impersonatedBy),
        memberships: memberships.map((m) => ({ tenantId: m.tenantId, memberId: m.memberId })),
      },
      subscriptionOf(subscription),
    );
  } catch (e) {
    const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
    console.error(`push: re-linking a device failed: ${e instanceof Error ? e.name : typeof e}${code}`);
  }
}
