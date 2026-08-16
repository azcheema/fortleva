import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { effectivePermissions, isAuthorized } from "@/authz/authorize";
import { MODULES, PERMISSIONS, ROLE_TEMPLATES } from "@/authz/catalog";
import { AuthzError } from "@/authz/errors";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Page, PageHeader } from "@/components/page-header";
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
      <Page>
        <PageHeader title={t("shortTitle")} />
        <p className="mt-4 text-sm text-muted-foreground">{t("noPermission")}</p>
      </Page>
    );
  }

  const metaOf = (role: RoleSummary): string =>
    role.isSystem
      ? t("meta.system", { template: role.templateKey ?? "" })
      : role.clonedFromKey
        ? t("meta.cloned", { template: role.clonedFromKey })
        : t("meta.custom");

  return (
    <Page>
      <PageHeader title={t("title", { tenant: membership.tenantName })} description={t("intro")} />

      <ul className="mt-6 flex flex-col gap-3">
        {data.roles.map((role) => (
          <li key={role.id}>
            <Card size="sm">
              <CardContent className="flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {role.name}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {metaOf(role)}
                      {" · "}
                      {tCommon("members", { count: role.holderCount })}
                      {" · "}
                      {tCommon("permissions", { count: role.codes.length })}
                    </span>
                  </span>
                  {data.canDelete && !role.isSystem && role.holderCount === 0 ? (
                    <DeleteRoleForm roleId={role.id} name={role.name} />
                  ) : null}
                </div>
                {role.description ? (
                  <p className="text-sm text-muted-foreground">{role.description}</p>
                ) : null}
                <details>
                  <summary className="cursor-pointer text-sm">{t("permissions")}</summary>
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
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>

      {data.canCreate ? (
        <Card size="sm" className="mt-6">
          <CardHeader>
            <CardTitle>{t("create.title")}</CardTitle>
          </CardHeader>
          <CardContent>
            <CreateRoleForm
              templates={ROLE_TEMPLATES.map((tpl) => ({
                templateKey: tpl.templateKey,
                displayName: tpl.displayName,
              }))}
            />
          </CardContent>
        </Card>
      ) : null}
    </Page>
  );
}
