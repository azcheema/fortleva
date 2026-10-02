"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { signOutOtherDevices, signOutOwnDevice } from "@/auth/account-security";
import { onSessionsRevoked } from "@/auth/audit-hooks";
import { requireMemberSession } from "@/auth/session";
import type { ActionResult } from "@/lib/server-actions";

const sessionId = z.uuid();

/**
 * "Your devices" (slice 84, C50): sign one of the member's OWN sessions
 * out. The session id is the only input, and it is answered for the
 * caller's account alone — `signOutOwnDevice` deletes by the id AND the
 * session's user, so somebody else's id ends nothing and reads like an
 * unknown one. Never the current session: the ordinary sign-out does that.
 */
export async function signOutDeviceAction(id: unknown): Promise<ActionResult> {
  const t = await getTranslations("account.devices");
  // A string first: a server action's argument can decode into an object.
  const parsed = sessionId.safeParse(typeof id === "string" ? id : null);
  if (!parsed.success) return { ok: false, message: t("gone") };
  const session = await requireMemberSession();
  const ended = await signOutOwnDevice(session.user.id, parsed.data, session.session.id);
  if (!ended) return { ok: false, message: t("gone") };
  try {
    await onSessionsRevoked(session.user.id, "one", 1, (session.user as { platformRole?: unknown }).platformRole);
  } catch (error) {
    console.error("[auth-audit] sessions_revoked failed", error);
  }
  revalidatePath("/account");
  return { ok: true, value: undefined };
}

/**
 * "Sign out everywhere else": every other session of the member's
 * account, with every trusted-device mark and every sign-in waiting for a
 * code (`signOutOtherDevices`). The answer is how many sessions ended.
 */
export async function signOutOtherDevicesAction(): Promise<ActionResult<number>> {
  const session = await requireMemberSession();
  const ended = await signOutOtherDevices(session.user.id, session.session.id);
  // Nothing ended, nothing to record (the code review's nit).
  if (ended > 0) {
    try {
      await onSessionsRevoked(session.user.id, "others", ended, (session.user as { platformRole?: unknown }).platformRole);
    } catch (error) {
      console.error("[auth-audit] sessions_revoked failed", error);
    }
  }
  revalidatePath("/account");
  return { ok: true, value: ended };
}
