import type { Metadata } from "next";
import { ChevronRightIcon, LockIcon, PlusIcon, ShieldIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { effectivePermissions, isAuthorized } from "@/authz/authorize";
import { MODULES, PERMISSIONS, ROLE_TEMPLATES } from "@/authz/catalog";
import { AuthzError } from "@/authz/errors";
import { EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { withTenant } from "@/db";
import { listRoles, type RoleSummary } from "@/members/roles";
import { requireTenantContext } from "@/members/tenant-context";

import { CreateRoleForm, DeleteRoleForm, RolePermissionsForm, type PermissionGroup } from "./role-forms";

const GROUPS: PermissionGroup[] = MODULES.map((module) => ({
  module,
  permissions: PERMISSIONS.filter((p) => p.module === module).map((p) => ({
    code: p.code,
    description: p.description,
    requiresMfa: p.requiresMfa,
  })),
})).filter((g) => g.permissions.length > 0);

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("roles");
  return { title: t("shortTitle") };
}

export default async function RolesPage() {
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("roles");
  const tCommon = await getTranslations("common");

  const data = await withTenant(
    membership.tenantId,
    { type: "member", id: membership.memberId },
    async (tx) => {
      let roles: RoleSummary[] | null = null;
      try {
        roles = await listRoles(tx, membership.tenantId, actor);
      } catch (e) {
        if (!(e instanceof AuthzError)) throw e;
      }
      const [canCreate, canDelete, held] = await Promise.all([
        isAuthorized(tx, actor, "role:create"),
        isAuthorized(tx, actor, "role:delete"),
        // role:edit is ✦: show the editor to holders; a stale factor is
        // handled by the step-up redirect on save (AUTHZ.md §7.5).
        effectivePermissions(tx, actor.memberId),
      ]);
      return { roles, canCreate, canDelete, canEdit: held.has("role:edit") };
    },
  );

  if (!data.roles) {
    return (
      <Page width="form">
        <PageHeader title={t("shortTitle")} />
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

  // The badge directly above already says "System" / "Custom"; the meta
  // line names only what the badge cannot — which template it came from.
  const metaOf = (role: RoleSummary): string | null =>
    role.isSystem
      ? t("meta.template", { template: role.templateKey ?? "" })
      : role.clonedFromKey
        ? t("meta.cloned", { template: role.clonedFromKey })
        : null;

  return (
    // Form width, like every other settings page: Roles rendered a
    // ~1030px column while its siblings rendered ~670px, so moving
    // between two adjacent sub-nav items jumped the content column
    // 180px wider and 180px left (UI.md §10.8).
    <Page width="form">
      <PageHeader
        title={t("shortTitle")}
        description={t("intro")}
        actions={
          data.canCreate ? (
            <Button asChild size="sm">
              <Link href="#new-role">
                <PlusIcon />
                {t("create.title")}
              </Link>
            </Button>
          ) : null
        }
      />

      <ul className="mt-6 flex flex-col gap-4">
        {data.roles.map((role) => (
          <li key={role.id}>
            <SectionCard
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {role.name}
                  {/* System vs custom is the first thing to know about a role:
                      one is the platform template and read-only, the other is
                      this workspace's own. Badge shape and glyph say which. */}
                  {role.isSystem ? (
                    <Badge variant="neutral">
                      <LockIcon aria-hidden="true" />
                      {t("badge.system")}
                    </Badge>
                  ) : (
                    <Badge variant="outline">
                      <ShieldIcon aria-hidden="true" />
                      {t("badge.custom")}
                    </Badge>
                  )}
                </span>
              }
              description={
                <>
                  {metaOf(role) ? (
                    <>
                      {metaOf(role)}
                      {" · "}
                    </>
                  ) : null}
                  <span className="num">{tCommon("members", { count: role.holderCount })}</span>
                  {" · "}
                  <span className="num">
                    {tCommon("permissions", { count: role.codes.length })}
                  </span>
                </>
              }
              actions={
                data.canDelete && !role.isSystem && role.holderCount === 0 ? (
                  <DeleteRoleForm roleId={role.id} name={role.name} />
                ) : null
              }
              contentClassName="flex flex-col gap-2"
            >
              {role.description ? (
                <p className="text-sm text-muted-foreground">{role.description}</p>
              ) : null}
              <details className="group/details">
                {/* This is the card's only interaction, so it is a real
                    28px trigger with a hover surface and a rotating
                    chevron — not a grey word at the bottom of the card.
                    `display: inline-flex` removes the native marker. */}
                <summary className="inline-flex h-7 cursor-pointer list-none items-center gap-1.5 rounded-md border border-transparent px-2 text-sm text-muted-foreground transition-[color,background-color,border-color] duration-(--dur-instant) ease-out select-none hover:border-input hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                  <ChevronRightIcon
                    aria-hidden="true"
                    className="size-3.5 shrink-0 transition-transform duration-(--dur-instant) ease-out group-open/details:rotate-90"
                  />
                  {t("permissions")}
                </summary>
                <RolePermissionsForm
                  role={{
                    id: role.id,
                    isSystem: role.isSystem,
                    codes: role.codes,
                    revokedCodes: role.revokedCodes,
                  }}
                  groups={GROUPS}
                  canEdit={data.canEdit}
                />
              </details>
            </SectionCard>
          </li>
        ))}
      </ul>

      {data.canCreate ? (
        <div className="mt-6">
          <SectionCard id="new-role" className="scroll-mt-16" title={t("create.title")}>
            <CreateRoleForm
              templates={ROLE_TEMPLATES.map((tpl) => ({
                templateKey: tpl.templateKey,
                displayName: tpl.displayName,
              }))}
            />
          </SectionCard>
        </div>
      ) : null}
    </Page>
  );
}
