import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { auth } from "./index";
import { platformGateDecision, type PlatformGate } from "./platform-gate";
import { platformAuth } from "./platform";

/**
 * Server-side session guards — the authoritative checks behind the
 * thin cookie gate in proxy.ts. Each plane accepts only its own
 * cookie AND its own Session.plane value (SECURITY.md §3.3).
 */

export const getMemberSession = cache(async () => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  // Plane check on the row: a PLATFORM session replayed against the
  // member plane is rejected even if cookie handling ever regresses.
  const plane = (session.session as { plane?: string }).plane ?? "MEMBER";
  if (plane !== "MEMBER") return null;
  return session;
});

export async function requireMemberSession() {
  const session = await getMemberSession();
  if (!session) redirect("/login");
  return session;
}

/** The gate's verdict for the current request, session included. */
export const getPlatformGate = cache(async () => {
  const session = await platformAuth.api.getSession({ headers: await headers() });
  const user = session?.user as
    | { platformRole?: string | null; twoFactorEnabled?: boolean | null }
    | undefined;
  const row = session?.session as
    | { plane?: string; mfaVerifiedAt?: Date | string | null }
    | undefined;
  const gate = platformGateDecision({
    hasSession: Boolean(session),
    plane: row?.plane ?? null,
    platformRole: user?.platformRole ?? null,
    twoFactorEnabled: user?.twoFactorEnabled ?? null,
    mfaVerifiedAt: row?.mfaVerifiedAt ?? null,
  });
  return { gate, session } as const;
});

/**
 * The session, or null. Deliberately null for EVERY non-"ok" verdict,
 * including the two MFA ones: a caller that only asks "is there a
 * platform session?" must not be handed one that has not presented a
 * second factor.
 */
export const getPlatformSession = cache(async () => {
  const { gate, session } = await getPlatformGate();
  return gate === "ok" ? session : null;
});

/**
 * THE platform guard. Call it first in every console page AND in every
 * console Server Action — a layout is NOT a boundary here: Next's own
 * documentation says a layout "does not control whether the rest of the
 * route renders", that the pattern is "not recommended since Next.js
 * applications have multiple entry points, which will not prevent
 * nested route segments and Server Actions from being accessed", and
 * that layouts do not re-render and may be cached
 * (node_modules/next/dist/docs/01-app/02-guides/authentication.md).
 * A Server Action is a POST addressed by action id; it never runs the
 * layout of the page that rendered it. This function is the boundary,
 * and React `cache()` is what makes calling it everywhere cheap.
 *
 * Every denial lands on /ops/login, which is in proxy.ts's PUBLIC_PATHS
 * — the one console route this gate structurally cannot block, which
 * is what makes the enrolment ramp reachable instead of a redirect
 * loop. The `reason` tells that page which remedy to present.
 */
export async function requirePlatformAdmin() {
  const { gate, session } = await getPlatformGate();
  if (gate === "ok" && session) return session;
  if (gate === "not_enrolled") redirect("/ops/login?reason=enrol");
  if (gate === "unverified") redirect("/ops/login?reason=verify");
  redirect("/ops/login");
}

export type { PlatformGate };
