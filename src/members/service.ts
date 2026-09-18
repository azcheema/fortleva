import { withUser } from "@/db";

/**
 * Membership queries for the session layer. Identity is global,
 * membership is tenant-scoped (§3): these run under withUser() and are
 * RLS-scoped to the caller's own rows by member_self_select.
 */
export type Membership = {
  memberId: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  /** Tenant.defaultLocale — the second step of locale resolution (UI.md §8). */
  defaultLocale: string;
  /** Member.timezone — overrides the tenant's `ui.timezone` preference when set. */
  timezone: string | null;
  status: "ACTIVE" | "SUSPENDED";
};

export async function listMembershipsForUser(userId: string): Promise<Membership[]> {
  return withUser(userId, async (tx) => {
    const rows = await tx.member.findMany({
      where: { userId },
      include: { tenant: { select: { name: true, slug: true, defaultLocale: true } } },
      // A SECOND key, because the first is NOT UNIQUE — and the tie is
      // structural, not a coincidence. `joined_at` is
      // `TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP`, and Postgres'
      // CURRENT_TIMESTAMP is the TRANSACTION's start time, so every
      // member row seated in ONE transaction gets a byte-identical
      // value. A tied sort is arbitrary per query, and this list decides
      // which workspace `getActiveMembership` falls back to when the
      // session carries no pointer — so a member's default workspace
      // could differ between two requests. `id` makes the order total
      // and STABLE (that is the whole fix); it is a v7 uuid, but it is a
      // `text` column compared by collation, so do not read the result
      // as creation order.
      orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
    });
    return rows.map((m) => ({
      memberId: m.id,
      tenantId: m.tenantId,
      tenantName: m.tenant.name,
      tenantSlug: m.tenant.slug,
      defaultLocale: m.tenant.defaultLocale,
      timezone: m.timezone,
      status: m.status,
    }));
  });
}
