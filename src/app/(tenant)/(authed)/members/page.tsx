import type { Metadata } from "next";
import { MailIcon } from "lucide-react";
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
import { cn } from "@/lib/utils";

import { InviteForm } from "./invite-form";
import { MemberRolesForm, MemberStatusForm, RevokeInviteForm } from "./member-admin";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("members") };
}

/**
 * /members: who is in the workspace, what they may do, and who has been
 * asked to join.
 *
 * The two populations are deliberately two cards, not one table with a
 * mixed status column — a pending invitation is not a member, and
 * conflating them is how someone ends up counting seats wrong. Invites
 * additionally show their expiry the way a person reads it ("in 5
 * days") with the exact date beside it in tabular figures.
 */
export default async function MembersPage() {
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("members");
  const tCommon = await getTranslations("common");
  const format = await getFormatter();
  const now = new Date();

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
        description={t("description")}
        actions={
          data.canViewRoles ? (
            <Button asChild variant="outline" size="sm">
              <Link href="/settings/roles">{t("manageRoles")}</Link>
            </Button>
          ) : null
        }
      />

      <div className="mt-6 flex flex-col gap-6">
        <SectionCard
          title={t("active.title")}
          description={tCommon("members", { count: data.members.length })}
          contentClassName="p-0"
        >
          <DataTable flush>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.member")}</TableHead>
                  <TableHead>{t("columns.email")}</TableHead>
                  <TableHead>{t("columns.roles")}</TableHead>
                  <TableHead>{t("columns.status")}</TableHead>
                  <TableHead className="w-0 text-right">
                    <span className="sr-only">{tCommon("actions")}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.members.map((m) => {
                  const isSelf = m.id === membership.memberId;
                  const suspended = m.status === "SUSPENDED";
                  return (
                    <TableRow key={m.id} data-status={m.status}>
                      <TableCell className="max-w-64">
                        <span className="flex min-w-0 items-center gap-2">
                          <MemberAvatar id={m.id} name={m.user.name} />
                          <span
                            className={cn(
                              "truncate",
                              suspended ? "text-muted-foreground" : "font-medium",
                            )}
                          >
                            {m.user.name}
                          </span>
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
                      <TableCell className="max-w-80">
                        <MemberRolesForm
                          memberId={m.id}
                          memberName={m.user.name}
                          roles={roleOptions}
                          heldRoleIds={m.memberRoles.map((r) => r.role.id)}
                          canManage={data.canManageRoles}
                        />
                      </TableCell>
                      <TableCell>
                        <StatusBadge domain="memberStatus" value={m.status} />
                      </TableCell>
                      <TableCell className="text-right">
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
        </SectionCard>

        {data.invites.length > 0 ? (
          <SectionCard
            title={t("pending.title")}
            description={t("pending.description")}
            contentClassName="p-0"
          >
            <DataTable density="compact" flush>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("columns.email")}</TableHead>
                    <TableHead>{t("columns.status")}</TableHead>
                    <TableHead>{t("pending.expires")}</TableHead>
                    <TableHead className="w-0 text-right">
                      <span className="sr-only">{tCommon("actions")}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.invites.map((i) => (
                    <TableRow key={i.id}>
                      <TableCell className="max-w-64">
                        <span className="flex min-w-0 items-center gap-2">
                          <MailIcon
                            aria-hidden="true"
                            className="size-3.5 shrink-0 text-muted-foreground"
                          />
                          <span className="truncate">{i.email}</span>
                        </span>
                      </TableCell>
                      <TableCell>
                        <StatusBadge domain="inviteStatus" value="PENDING" />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <span>{format.relativeTime(i.expiresAt, now)}</span>
                        <span className="num ml-2">
                          {format.dateTime(i.expiresAt, { dateStyle: "medium" })}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        {data.canInvite ? <RevokeInviteForm inviteId={i.id} /> : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </DataTable>
          </SectionCard>
        ) : null}

        {data.canInvite ? (
          <SectionCard title={t("invite.title")} description={t("invite.description")}>
            <InviteForm roles={roleOptions} />
          </SectionCard>
        ) : null}
      </div>
    </Page>
  );
}
