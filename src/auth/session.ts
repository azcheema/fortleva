import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { auth } from "./index";
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

export const getPlatformSession = cache(async () => {
  const session = await platformAuth.api.getSession({ headers: await headers() });
  if (!session) return null;
  const plane = (session.session as { plane?: string }).plane;
  if (plane !== "PLATFORM") return null;
  // The authoritative platform flag (AUTHZ.md §9): User.platformRole —
  // never the admin-plugin `role` mirror, never a tenant Role.
  const platformRole = (session.user as { platformRole?: string | null }).platformRole;
  if (platformRole !== "SUPERADMIN") return null;
  return session;
});

export async function requirePlatformAdmin() {
  const session = await getPlatformSession();
  if (!session) redirect("/ops/login");
  return session;
}
