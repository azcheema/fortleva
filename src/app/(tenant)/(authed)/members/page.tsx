import type { Metadata } from "next";
import { MailIcon, UserPlusIcon } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { isConsolePrincipal } from "@/auth/member-recovery";
import { resolvePermissions } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { requireAccess } from "@/entitlements/resolver";
import {
  Callout,
  DataTable,
  EmptyState,
  MemberAvatar,
  Page,
  PageHeader,
  SectionCard,
  StatusBadge,
  UndeliverableNote,
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
import { undeliverableAmong } from "@/notify/undeliverable";

import { InviteForm } from "./invite-form";
import { MemberRolesForm, MemberRowActions, RevokeInviteForm } from "./member-admin";

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
      // THE PAGE'S OWN GATE, and it was missing until 2026-09-20.
      // `member:view` existed, the rail honoured it (`nav.ts`), and this
      // page did not — it ran on `requireTenantContext()` alone, so a
      // member of a custom role WITHOUT the permission got the full
      // roster and every pending invite's email by typing the URL. The
      // four seeded templates all carry `member:view`, which is why it
      // went unnoticed: only a hand-built role could reach it, and only
      // within its own tenant (RLS never wavered). Found by the
      // enforcement audit in `src/authz/enforcement.test.ts` — this was
      // the ONE code in the catalogue whose only occurrence anywhere was
      // a nav entry that hides a link, which is the exact false negative
      // that test's docstring warns a string match cannot see.
      //
      // Shaped like `/settings/roles`: the read is refused, the page
      // catches and renders the forbidden state rather than 404ing, so a
      // member who lands here is told why.
      try {
        await requireAccess(tx, membership.tenantId, actor, "member:view");
      } catch (e) {
        if (!(e instanceof AuthzError)) throw e;
        return null;
      }
      // Four legs, and it was six: two `isAuthorized` calls, each
      // resolving the member's roles again, beside a raw read of them.
      // ONE `resolvePermissions` leg answers all four codes now. A single
      // resolution as one leg is the `listItems` shape; checks fanned out
      // as legs are AGENTS.md's `Promise.all` trap (`authz-batches.test.ts`).
      const [members, invites, roles, perms] = await Promise.all([
        tx.member.findMany({
          include: {
            // twoFactorEnabled and platformRole decide which of an owner's
            // security verbs a row offers (slice 84); the service decides
            // again, so these only shape the menu.
            user: {
              select: {
                name: true,
                email: true,
                twoFactorEnabled: true,
                platformRole: true,
                // A PENDING factor (a row, the flag unset) is resettable too —
                // it is the half-applied state the reset exists to clear.
                twoFactor: { select: { id: true } },
              },
            },
            memberRoles: { include: { role: { select: { id: true, name: true } } } },
          },
          orderBy: { joinedAt: "asc" },
        }),
        tx.memberInvite.findMany({
          where: { status: "PENDING", expiresAt: { gt: new Date() } },
          orderBy: { createdAt: "desc" },
        }),
        tx.role.findMany({ orderBy: [{ isSystem: "desc" }, { name: "asc" }] }),
        resolvePermissions(tx, actor, [
          "member:invite",
          "member:remove",
          "member:manage_roles",
          "role:view",
          "member:reset_two_factor",
        ]),
      ]);
      // "Emails to this address aren't being delivered" (slice 103, C71 (d)):
      // after the batch, never a leg of it (AGENTS.md's Promise.all trap).
      const undeliverable = await undeliverableAmong(tx, [
        ...members.map((m) => m.user.email),
        ...invites.map((i) => i.email),
      ]);
      return {
        members,
        invites,
        roles,
        undeliverable,
        canInvite: perms.allowed.has("member:invite"),
        canRemove: perms.allowed.has("member:remove"),
        // member:manage_roles is ✦: the editor shows for anyone the
        // step-up would let through; a stale or missing factor is handled
        // at save time by the step-up redirect (AUTHZ.md §7.5), not by
        // hiding the control. It used to read the raw set, which an
        // impersonating admin's view-only limit never touched.
        canManageRoles:
          perms.allowed.has("member:manage_roles") || perms.afterStepUp.has("member:manage_roles"),
        canViewRoles: perms.allowed.has("role:view"),
        // ✦ like member:manage_roles, and shown on the same rule: the
        // step-up is asked at the click, not by hiding the verb.
        canSecure:
          perms.allowed.has("member:reset_two_factor") || perms.afterStepUp.has("member:reset_two_factor"),
      };
    },
  );

  if (!data) {
    return (
      <Page width="wide">
        <PageHeader title={t("heading")} />
        <div className="mt-6">
          <SectionCard>
            <EmptyState
              variant="forbidden"
              title={tCommon("forbiddenTitle")}
              body={t("noPermission")}
            />
          </SectionCard>
        </div>
      </Page>
    );
  }

  const roleOptions = data.roles.map((r) => ({ id: r.id, name: r.name }));

  // A WORKSPACE WITH ONE OWNER (slice 84, C50): if that owner loses their
  // phone AND their backup codes, nobody in the workspace can reset them —
  // only the operator. Said to whoever can actually make a second owner:
  // an owner (holding the owner-only reset code stands in for it — an admin
  // with `member:manage_roles` cannot grant the owner role, §7.1).
  const ownerRole = data.roles.find((r) => r.isSystem && r.templateKey === "owner");
  const activeOwners = ownerRole
    ? data.members.filter((m) => m.status === "ACTIVE" && m.memberRoles.some((r) => r.role.id === ownerRole.id)).length
    : 0;
  const soleOwner = data.canManageRoles && data.canSecure && activeOwners === 1;

  return (
    <Page width="wide">
      {/* The h1 is the page noun. The tenant name is in the header and
          in <title>; saying it a third time here is not context. */}
      <PageHeader
        title={t("heading")}
        description={t("description")}
        actions={
          data.canInvite ? (
            <Button asChild size="sm">
              <Link href="#new-member">
                <UserPlusIcon />
                {t("invite.title")}
              </Link>
            </Button>
          ) : null
        }
      />

      <div className="mt-6 flex flex-col gap-6">
        {soleOwner ? (
          <Callout tone="caution" title={t("soleOwner.title")}>
            {t("soleOwner.body")}
          </Callout>
        ) : null}
        <SectionCard
          title={t("active.title")}
          description={tCommon("members", { count: data.members.length })}
          contentClassName="p-0"
          actions={
            data.canViewRoles ? (
              // A plain link, not a button with a trailing arrow — that
              // shape appears nowhere else in the product.
              <Link
                href="/settings/roles"
                className="rounded-sm text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {t("manageRoles")}
              </Link>
            ) : null
          }
        >
          <DataTable flush scrollLabel={t("active.title")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.member")}</TableHead>
                  <TableHead priority="low">{t("columns.email")}</TableHead>
                  <TableHead>{t("columns.roles")}</TableHead>
                  {/* medium: at 390px this column pushed a row's actions
                      34px past the table's visible box the moment the
                      table held a member who was not the viewer (the
                      self row renders no actions, which is why a
                      one-member fixture never saw it). A suspended
                      member still reads on a phone — the name is muted
                      — and the badge returns once the table's box reaches
                      the `medium` rung (38rem; ~642px on a phone, ~882px
                      with the rail open). */}
                  <TableHead priority="medium">{t("columns.status")}</TableHead>
                  <TableHead pinned className="w-0 text-right">
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
                      {/* Capped per viewport so a long name can never
                          push this row's actions off a 390px screen. */}
                      <TableCell className="max-w-36 sm:max-w-64">
                        <span className="flex min-w-0 items-center gap-2">
                          <MemberAvatar id={m.id} name={m.user.name} />
                          <span className="min-w-0">
                            <span className="flex min-w-0 items-center gap-2">
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
                            {/* Under the NAME, not the address: the email
                                column is the first to go on a phone, and a
                                member who gets no mail misses invitations,
                                resets and every notice (C71 (d)). */}
                            {data.undeliverable.has(m.user.email.trim().toLowerCase()) ? (
                              <UndeliverableNote slot="member-undeliverable" text={t("undeliverable")} />
                            ) : null}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell priority="low" className="max-w-64 truncate text-muted-foreground">
                        {m.user.email}
                      </TableCell>
                      <TableCell className="max-w-32 sm:max-w-80">
                        <MemberRolesForm
                          memberId={m.id}
                          memberName={m.user.name}
                          roles={roleOptions}
                          heldRoleIds={m.memberRoles.map((r) => r.role.id)}
                          canManage={data.canManageRoles}
                        />
                      </TableCell>
                      <TableCell priority="medium">
                        <StatusBadge domain="memberStatus" value={m.status} />
                      </TableCell>
                      <TableCell pinned className="text-right">
                        <MemberRowActions
                          memberId={m.id}
                          memberName={m.user.name}
                          status={m.status}
                          isSelf={isSelf}
                          canRemove={data.canRemove}
                          canSecure={data.canSecure}
                          // Only for somebody who can act on them: the row
                          // is a client component, so these reach the page
                          // data — and who has no factor, or who is the
                          // operator, is not every member's business (the
                          // security review's low).
                          console={data.canSecure && isConsolePrincipal(m.user.platformRole)}
                          enrolled={data.canSecure && (m.user.twoFactorEnabled || m.user.twoFactor !== null)}
                        />
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
            <DataTable density="compact" flush scrollLabel={t("pending.title")}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("columns.email")}</TableHead>
                    <TableHead>{t("columns.status")}</TableHead>
                    <TableHead priority="low">{t("pending.expires")}</TableHead>
                    <TableHead pinned className="w-0 text-right">
                      <span className="sr-only">{tCommon("actions")}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.invites.map((i) => (
                    <TableRow key={i.id}>
                      <TableCell className="max-w-36 sm:max-w-64">
                        <span className="flex min-w-0 items-center gap-2">
                          <MailIcon
                            aria-hidden="true"
                            className="size-3.5 shrink-0 text-muted-foreground"
                          />
                          <span className="min-w-0">
                            <span className="block truncate">{i.email}</span>
                            {/* The invitation itself never arrived (C71 (d)):
                                revoke it and invite the right address. */}
                            {data.undeliverable.has(i.email.trim().toLowerCase()) ? (
                              <UndeliverableNote slot="invite-undeliverable" text={t("undeliverable")} />
                            ) : null}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell>
                        <StatusBadge domain="inviteStatus" value="PENDING" />
                      </TableCell>
                      <TableCell priority="low" className="text-muted-foreground">
                        <span>{format.relativeTime(i.expiresAt, now)}</span>
                        <span className="num ml-2">
                          {format.dateTime(i.expiresAt, { dateStyle: "medium" })}
                        </span>
                      </TableCell>
                      <TableCell pinned className="text-right">
                        {data.canInvite ? (
                          <RevokeInviteForm inviteId={i.id} email={i.email} />
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </DataTable>
          </SectionCard>
        ) : null}

        {data.canInvite ? (
          <SectionCard
            id="new-member"
            className="scroll-mt-16"
            title={t("invite.title")}
            description={t("invite.description")}
          >
            <InviteForm roles={roleOptions} />
          </SectionCard>
        ) : null}
      </div>
    </Page>
  );
}
