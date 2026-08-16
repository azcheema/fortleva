import type { Metadata } from "next";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { effectivePermissions, isAuthorized } from "@/authz/authorize";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Page, PageHeader } from "@/components/page-header";
import { withTenant } from "@/db";
import { requireTenantContext } from "@/members/tenant-context";

import { InviteForm } from "./invite-form";
import { MemberRolesForm, MemberStatusForm, RevokeInviteForm } from "./member-admin";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("members") };
}

export default async function MembersPage() {
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("members");
  const tCommon = await getTranslations("common");
  const format = await getFormatter();

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
    <Page>
      <PageHeader
        title={t("title", { tenant: membership.tenantName })}
        actions={
          data.canViewRoles ? (
            <Button asChild variant="outline" size="sm">
              <Link href="/settings/roles">{t("manageRoles")}</Link>
            </Button>
          ) : null
        }
      />

      <ul className="mt-6 flex flex-col gap-2">
        {data.members.map((m) => {
          const isSelf = m.id === membership.memberId;
          return (
            <li key={m.id}>
              <Card size="sm">
                <CardContent className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="flex items-center gap-2 font-medium">
                      {m.user.name}
                      {isSelf ? (
                        <span className="text-xs font-normal text-muted-foreground">
                          {"("}
                          {tCommon("you")}
                          {")"}
                        </span>
                      ) : null}
                      {m.status === "SUSPENDED" ? (
                        <Badge variant="outline">{tCommon("suspended")}</Badge>
                      ) : null}
                    </span>
                    <span className="text-sm text-muted-foreground">{m.user.email}</span>
                  </div>
                  <MemberRolesForm
                    memberId={m.id}
                    roles={roleOptions}
                    heldRoleIds={m.memberRoles.map((r) => r.role.id)}
                    canManage={data.canManageRoles}
                  />
                  {data.canRemove ? (
                    <MemberStatusForm memberId={m.id} status={m.status} isSelf={isSelf} />
                  ) : null}
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ul>

      {data.invites.length > 0 ? (
        <Card size="sm" className="mt-6">
          <CardHeader>
            <CardTitle>{t("pending.title")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1.5 text-sm text-muted-foreground">
              {data.invites.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-3">
                  <span>
                    {i.email}
                    {" — "}
                    {tCommon("expires", { date: format.dateTime(i.expiresAt, { dateStyle: "medium" }) })}
                  </span>
                  {data.canInvite ? <RevokeInviteForm inviteId={i.id} /> : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {data.canInvite ? (
        <Card size="sm" className="mt-6">
          <CardHeader>
            <CardTitle>{t("invite.title")}</CardTitle>
          </CardHeader>
          <CardContent>
            <InviteForm roles={roleOptions} />
          </CardContent>
        </Card>
      ) : null}
    </Page>
  );
}
