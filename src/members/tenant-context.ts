import { redirect } from "next/navigation";

import { requireMemberSession } from "@/auth/session";

import { listMembershipsForUser, type Membership } from "./service";

/**
 * Resolve the active tenant for a member request. Session
 * activeTenantId is a UX pointer only — membership is ALWAYS
 * re-derived from the database (DATA_MODEL §6.1).
 */
export async function requireTenantContext(): Promise<{
  userId: string;
  userEmail: string;
  membership: Membership;
  memberships: Membership[];
}> {
  const session = await requireMemberSession();
  const memberships = await listMembershipsForUser(session.user.id);
  const active = memberships.filter((m) => m.status === "ACTIVE");
  if (active.length === 0) redirect("/dashboard");

  const pointer = (session.session as { activeTenantId?: string | null }).activeTenantId;
  const membership = active.find((m) => m.tenantId === pointer) ?? active[0]!;

  return {
    userId: session.user.id,
    userEmail: session.user.email,
    membership,
    memberships,
  };
}
