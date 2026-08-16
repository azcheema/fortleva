import { withTenant } from "@/db";
import { effectivePermissions, isAuthorized } from "@/authz/authorize";
import { MODULES, PERMISSIONS, ROLE_TEMPLATES } from "@/authz/catalog";
import { AuthzError } from "@/authz/errors";
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

export default async function RolesPage() {
  const { membership, actor } = await requireTenantContext();

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
      <main className="mx-auto max-w-3xl p-8">
        <h1 className="text-2xl font-semibold">Roles</h1>
        <p className="mt-4 text-sm text-neutral-600">You do not have permission to view roles.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">{membership.tenantName} — roles</h1>
      <p className="mt-1 text-sm text-neutral-600">
        System roles follow the platform templates and are read-only. Custom roles can be
        edited within the permissions you hold; ✦ marks permissions that require two-factor
        authentication.
      </p>

      <ul className="mt-6 flex flex-col gap-4">
        {data.roles.map((role) => (
          <li key={role.id} className="rounded border border-neutral-200 px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">
                {role.name}
                <span className="ml-2 text-xs text-neutral-500">
                  {role.isSystem
                    ? `system · template ${role.templateKey}`
                    : role.clonedFromKey
                      ? `custom · cloned from ${role.clonedFromKey}`
                      : "custom"}
                  {" · "}
                  {role.holderCount} member{role.holderCount === 1 ? "" : "s"}
                  {" · "}
                  {role.codes.length} permission{role.codes.length === 1 ? "" : "s"}
                </span>
              </span>
              {data.canDelete && !role.isSystem && role.holderCount === 0 ? (
                <DeleteRoleForm roleId={role.id} name={role.name} />
              ) : null}
            </div>
            {role.description ? (
              <p className="mt-1 text-sm text-neutral-600">{role.description}</p>
            ) : null}
            <details className="mt-2">
              <summary className="cursor-pointer text-sm text-neutral-700">Permissions</summary>
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
          </li>
        ))}
      </ul>

      {data.canCreate ? (
        <section className="mt-8">
          <h2 className="text-lg font-medium">Create a role</h2>
          <CreateRoleForm
            templates={ROLE_TEMPLATES.map((t) => ({
              templateKey: t.templateKey,
              displayName: t.displayName,
            }))}
          />
        </section>
      ) : null}
    </main>
  );
}
