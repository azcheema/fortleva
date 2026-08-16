import type { Metadata } from "next";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { effectivePermissions, isAuthorized } from "@/authz/authorize";
import {
  DataTable,
  MemberAvatar,
  Page,
  PageHeader,
  SectionCard,
  StatusBadge,
} from "@/components/semantic";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
    <Page width="wide">
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

      <section className="mt-6">
        <DataTable>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("columns.member")}</TableHead>
                <TableHead>{t("columns.email")}</TableHead>
                <TableHead>{t("columns.roles")}</TableHead>
                <TableHead>{t("columns.status")}</TableHead>
                <TableHead className="w-0">
                  <span className="sr-only">{tCommon("actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.members.map((m) => {
                const isSelf = m.id === membership.memberId;
                return (
                  <TableRow key={m.id}>
                    <TableCell className="max-w-64">
                      <span className="flex min-w-0 items-center gap-2">
                        <MemberAvatar id={m.id} name={m.user.name} />
                        <span className="truncate font-medium">{m.user.name}</span>
                        {isSelf ? (
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {"("}
                            {tCommon("you")}
                            {")"}
                          </span>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-64 truncate text-muted-foreground">
                      {m.user.email}
                    </TableCell>
                    <TableCell>
                      <MemberRolesForm
                        memberId={m.id}
                        roles={roleOptions}
                        heldRoleIds={m.memberRoles.map((r) => r.role.id)}
                        canManage={data.canManageRoles}
                      />
                    </TableCell>
                    <TableCell>
                      <StatusBadge domain="memberStatus" value={m.status} />
                    </TableCell>
                    <TableCell>
                      {data.canRemove ? (
                        <MemberStatusForm memberId={m.id} status={m.status} isSelf={isSelf} />
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </DataTable>
      </section>

      {data.invites.length > 0 ? (
        <div className="mt-6">
          <SectionCard title={t("pending.title")} contentClassName="p-0">
            <DataTable density="compact" className="rounded-none border-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("columns.email")}</TableHead>
                    <TableHead>{t("columns.status")}</TableHead>
                    <TableHead>{t("pending.expires")}</TableHead>
                    <TableHead className="w-0">
                      <span className="sr-only">{tCommon("actions")}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.invites.map((i) => (
                    <TableRow key={i.id}>
                      <TableCell className="max-w-64 truncate">{i.email}</TableCell>
                      <TableCell>
                        <StatusBadge domain="inviteStatus" value="PENDING" />
                      </TableCell>
                      <TableCell className="num text-muted-foreground">
                        {format.dateTime(i.expiresAt, { dateStyle: "medium" })}
                      </TableCell>
                      <TableCell>
                        {data.canInvite ? <RevokeInviteForm inviteId={i.id} /> : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </DataTable>
          </SectionCard>
        </div>
      ) : null}

      {data.canInvite ? (
        <div className="mt-6">
          <SectionCard title={t("invite.title")}>
            <InviteForm roles={roleOptions} />
          </SectionCard>
        </div>
      ) : null}
    </Page>
  );
}
