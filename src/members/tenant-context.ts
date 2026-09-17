import { redirect } from "next/navigation";
import { cache } from "react";

import { getMemberSession, requireMemberSession } from "@/auth/session";
import type { MemberActor, MfaState } from "@/authz/authorize";

import { listMembershipsForUser, type Membership } from "./service";

/**
 * Resolve the active tenant for a member request. Session
 * activeTenantId is a UX pointer only — membership is ALWAYS
 * re-derived from the database (DATA_MODEL §6.1).
 */
export type TenantContext = {
  userId: string;
  userEmail: string;
  membership: Membership;
  memberships: Membership[];
  /** MFA posture of THIS session (AUTHZ.md §7.5): enrolment + last factor. */
  mfa: MfaState;
  /** Ready-made actor for authorize()/requireAccess() — carries mfa. */
  actor: MemberActor;
};

/** Better Auth returns Date for date fields; a serialized string is tolerated. */
const asDate = (v: unknown): Date | null => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
};

type MemberSession = NonNullable<Awaited<ReturnType<typeof getMemberSession>>>;

/**
 * Per-request memoised membership list (the layout, pages and locale
 * resolution all ask). Exported because the shell needs the COUNT to
 * decide whether the workspace picker is offered at all (UI.md rule 8)
 * and the picker page needs the rows. The picker page used to re-query
 * what `getActiveMembership` had already fetched under this same cache,
 * and no longer does; the layout's count is new, and free for the same
 * reason — it reads the entry that is already there.
 *
 * React's request-scoped `cache`, never `unstable_cache` — nothing here
 * survives a request. The caller must pass the SESSION's own user id:
 * this argument is the input to the RLS gate (`withUser` sets
 * `app.user_id` from it), not its subject.
 */
export const membershipsFor = cache((userId: string) => listMembershipsForUser(userId));

/**
 * The active membership for a session: the session's activeTenantId
 * pointer when it names an ACTIVE membership, else the first ACTIVE one;
 * null when the user has no active membership at all.
 */
export const getActiveMembership = cache(
  async (session: MemberSession): Promise<Membership | null> => {
    const memberships = await membershipsFor(session.user.id);
    const active = memberships.filter((m) => m.status === "ACTIVE");
    const pointer = (session.session as { activeTenantId?: string | null }).activeTenantId;
    return active.find((m) => m.tenantId === pointer) ?? active[0] ?? null;
  },
);

/** MFA posture of a session (AUTHZ.md §7.5): enrolment + last factor. */
export const mfaStateOf = (session: MemberSession): MfaState => ({
  enrolled: (session.user as { twoFactorEnabled?: boolean }).twoFactorEnabled === true,
  verifiedAt: asDate((session.session as { mfaVerifiedAt?: unknown }).mfaVerifiedAt),
});

export async function requireTenantContext(): Promise<TenantContext> {
  const session = await requireMemberSession();
  const memberships = await membershipsFor(session.user.id);
  const membership = await getActiveMembership(session);
  if (!membership) redirect("/dashboard");

  const mfa = mfaStateOf(session);

  return {
    userId: session.user.id,
    userEmail: session.user.email,
    membership,
    memberships,
    mfa,
    actor: { memberId: membership.memberId, mfa },
  };
}
