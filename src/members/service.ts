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
  status: "ACTIVE" | "SUSPENDED";
};

export async function listMembershipsForUser(userId: string): Promise<Membership[]> {
  return withUser(userId, async (tx) => {
    const rows = await tx.member.findMany({
      where: { userId },
      include: { tenant: { select: { name: true, slug: true, defaultLocale: true } } },
      orderBy: { joinedAt: "asc" },
    });
    return rows.map((m) => ({
      memberId: m.id,
      tenantId: m.tenantId,
      tenantName: m.tenant.name,
      tenantSlug: m.tenant.slug,
      defaultLocale: m.tenant.defaultLocale,
      status: m.status,
    }));
  });
}
