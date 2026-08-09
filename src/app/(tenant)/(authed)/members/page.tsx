import { withTenant } from "@/db";
import { isAuthorized } from "@/authz/authorize";
import { requireTenantContext } from "@/members/tenant-context";

import { InviteForm } from "./invite-form";

export default async function MembersPage() {
  const { membership } = await requireTenantContext();

  const data = await withTenant(
    membership.tenantId,
    { type: "member", id: membership.memberId },
    async (tx) => {
      const actor = { memberId: membership.memberId };
      const [members, invites, roles, canInvite] = await Promise.all([
        tx.member.findMany({
          include: {
            user: { select: { name: true, email: true } },
            memberRoles: { include: { role: { select: { name: true } } } },
          },
          orderBy: { joinedAt: "asc" },
        }),
        tx.memberInvite.findMany({
          where: { status: "PENDING", expiresAt: { gt: new Date() } },
          orderBy: { createdAt: "desc" },
        }),
        tx.role.findMany({ orderBy: { name: "asc" } }),
        isAuthorized(tx, { memberId: membership.memberId }, "member:invite"),
      ]);
      void actor;
      return { members, invites, roles, canInvite };
    },
  );

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">{membership.tenantName} — members</h1>

      <ul className="mt-6 flex flex-col gap-2">
        {data.members.map((m) => (
          <li key={m.id} className="rounded border border-neutral-200 px-4 py-3">
            <div className="flex items-baseline justify-between">
              <span className="font-medium">{m.user.name}</span>
              <span className="text-sm text-neutral-500">{m.user.email}</span>
            </div>
            <div className="mt-1 text-sm text-neutral-600">
              {m.memberRoles.map((r) => r.role.name).join(", ") || "no roles"}
              {m.status === "SUSPENDED" ? " · suspended" : ""}
            </div>
          </li>
        ))}
      </ul>

      {data.invites.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-lg font-medium">Pending invitations</h2>
          <ul className="mt-2 flex flex-col gap-1 text-sm text-neutral-600">
            {data.invites.map((i) => (
              <li key={i.id}>
                {i.email} — expires {i.expiresAt.toISOString().slice(0, 10)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {data.canInvite ? (
        <section className="mt-8">
          <h2 className="text-lg font-medium">Invite a member</h2>
          <InviteForm
            roles={data.roles.map((r) => ({ id: r.id, name: r.name }))}
          />
        </section>
      ) : null}
    </main>
  );
}
