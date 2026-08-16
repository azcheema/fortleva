import Link from "next/link";

import { withTenant } from "@/db";
import { effectivePermissions, isAuthorized } from "@/authz/authorize";
import { requireTenantContext } from "@/members/tenant-context";

import { InviteForm } from "./invite-form";
import { MemberRolesForm, MemberStatusForm, RevokeInviteForm } from "./member-admin";

export default async function MembersPage() {
  const { membership, actor } = await requireTenantContext();

  const data = await withTenant(
    membership.tenantId,
    { type: "member", id: membership.memberId },
    async (tx) => {
      const [members, invites, roles, canInvite, canRemove, held] = await Promise.all([
        tx.member.findMany({
          include: {
            user: { select: { name: true, email: true } },
            memberRoles: { include: { role: { select: { id: true, name: true } } } },
          },
          orderBy: { joinedAt: "asc" },
        }),
        tx.memberInvite.findMany({
          where: { status: "PENDING", expiresAt: { gt: new Date() } },
          orderBy: { createdAt: "desc" },
        }),
        tx.role.findMany({ orderBy: [{ isSystem: "desc" }, { name: "asc" }] }),
        isAuthorized(tx, actor, "member:invite"),
        isAuthorized(tx, actor, "member:remove"),
        // member:manage_roles is ✦: the editor shows for holders of the
        // permission; a stale factor is handled at save time by the
        // step-up redirect (AUTHZ.md §7.5), not by hiding the control.
        effectivePermissions(tx, actor.memberId),
      ]);
      return {
        members,
        invites,
        roles,
        canInvite,
        canRemove,
        canManageRoles: held.has("member:manage_roles"),
        canViewRoles: held.has("role:view"),
      };
    },
  );

  const roleOptions = data.roles.map((r) => ({ id: r.id, name: r.name }));

  return (
    <main className="mx-auto max-w-3xl p-8">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">{membership.tenantName} — members</h1>
        {data.canViewRoles ? (
          <Link href="/settings/roles" className="text-sm hover:underline">
            Manage roles →
          </Link>
        ) : null}
      </div>

      <ul className="mt-6 flex flex-col gap-2">
        {data.members.map((m) => (
          <li key={m.id} className="rounded border border-neutral-200 px-4 py-3">
            <div className="flex items-baseline justify-between gap-4">
              <span className="font-medium">
                {m.user.name}
                {m.id === membership.memberId ? (
                  <span className="ml-2 text-xs text-neutral-500">(you)</span>
                ) : null}
                {m.status === "SUSPENDED" ? (
                  <span className="ml-2 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600">
                    suspended
                  </span>
                ) : null}
              </span>
              <span className="text-sm text-neutral-500">{m.user.email}</span>
            </div>
            <MemberRolesForm
              memberId={m.id}
              roles={roleOptions}
              heldRoleIds={m.memberRoles.map((r) => r.role.id)}
              canManage={data.canManageRoles}
            />
            {data.canRemove ? (
              <div className="mt-2">
                <MemberStatusForm
                  memberId={m.id}
                  status={m.status}
                  isSelf={m.id === membership.memberId}
                />
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {data.invites.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-lg font-medium">Pending invitations</h2>
          <ul className="mt-2 flex flex-col gap-1 text-sm text-neutral-600">
            {data.invites.map((i) => (
              <li key={i.id} className="flex items-center gap-3">
                <span>
                  {i.email} — expires {i.expiresAt.toISOString().slice(0, 10)}
                </span>
                {data.canInvite ? <RevokeInviteForm inviteId={i.id} /> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {data.canInvite ? (
        <section className="mt-8">
          <h2 className="text-lg font-medium">Invite a member</h2>
          <InviteForm roles={roleOptions} />
        </section>
      ) : null}
    </main>
  );
}
