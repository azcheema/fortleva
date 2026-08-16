import { withTenant, type TenantDb } from "@/db";
import { PERMISSIONS, ROLE_TEMPLATES, TEMPLATE_VERSION, type TemplateKey } from "@/authz/catalog";
import type { MemberActor } from "@/authz/authorize";
import { AuthzError, deny } from "@/authz/errors";
import { requireAccess } from "@/entitlements/resolver";
import { record } from "@/audit/record";

import {
  assertActorHoldsAll,
  bumpPermissionsVersion,
  roleEffectiveCodes,
  runGuarded,
} from "./guards";
import { cloneCodesForTemplate } from "./templates";

/**
 * Role administration (AUTHZ.md §3.5, §7.1–§7.2). System roles are
 * read-only rows — their sets change only via template propagation.
 * Custom roles are edited under the subset rules; on clones, a revoke
 * leaves a TENANT_REVOKE tombstone (B3) so the next propagation does not
 * silently re-grant the code.
 */

export type RoleSummary = {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  templateKey: string | null;
  clonedFromKey: string | null;
  /** Effective codes (tombstones excluded). */
  codes: string[];
  /** TENANT_REVOKE tombstones (B3). */
  revokedCodes: string[];
  holderCount: number;
};

const TEMPLATE_KEYS = new Set<string>(ROLE_TEMPLATES.map((t) => t.templateKey));
const KNOWN_CODES = new Set(PERMISSIONS.map((p) => p.code));

const summarize = (r: {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  templateKey: string | null;
  clonedFromKey: string | null;
  rolePermissions: { source: string; permission: { code: string } }[];
  _count: { memberRoles: number };
}): RoleSummary => ({
  id: r.id,
  name: r.name,
  description: r.description,
  isSystem: r.isSystem,
  templateKey: r.templateKey,
  clonedFromKey: r.clonedFromKey,
  codes: r.rolePermissions
    .filter((rp) => rp.source !== "TENANT_REVOKE")
    .map((rp) => rp.permission.code)
    .sort(),
  revokedCodes: r.rolePermissions
    .filter((rp) => rp.source === "TENANT_REVOKE")
    .map((rp) => rp.permission.code)
    .sort(),
  holderCount: r._count.memberRoles,
});

/** role:view — every role with its effective set. Runs in the caller's tx. */
export async function listRoles(
  tx: TenantDb,
  tenantId: string,
  actor: MemberActor,
): Promise<RoleSummary[]> {
  await requireAccess(tx, tenantId, actor, "role:view");
  const roles = await tx.role.findMany({
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
    include: {
      rolePermissions: { select: { source: true, permission: { select: { code: true } } } },
      _count: { select: { memberRoles: true } },
    },
  });
  return roles.map(summarize);
}

const loadCustomRole = async (tx: TenantDb, roleId: string) => {
  const role = await tx.role.findFirst({
    where: { id: roleId },
    select: { id: true, tenantId: true, name: true, isSystem: true, clonedFromKey: true },
  });
  if (!role) throw new AuthzError("NOT_FOUND", "unknown role");
  if (role.isSystem) throw new AuthzError("FORBIDDEN", "system roles are read-only (AUTHZ.md §7.2)");
  return role;
};

/**
 * role:create — clone a template (its codes minus ✦, AUTHZ.md §3.5) or
 * start blank. All granted codes must be held by the actor.
 */
export async function createRole(input: {
  tenantId: string;
  actor: MemberActor;
  name: string;
  description?: string;
  templateKey?: TemplateKey | null;
}): Promise<{ roleId: string }> {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 60) deny("FORBIDDEN", "role name must be 2-60 characters");
  const templateKey = input.templateKey ?? null;
  if (templateKey !== null && !TEMPLATE_KEYS.has(templateKey)) deny("NOT_FOUND", "unknown template");

  return runGuarded(input.tenantId, input.actor, async (tx) => {
    await requireAccess(tx, input.tenantId, input.actor, "role:create");
    await bumpPermissionsVersion(tx, input.tenantId);

    const codes = templateKey ? cloneCodesForTemplate(templateKey) : [];
    await assertActorHoldsAll(tx, input.actor, codes, {
      rule: "grant_subset",
      targetType: "Role",
      targetId: "new",
      detail: `cannot clone "${templateKey}" - you do not hold`,
    });

    const clash = await tx.role.findFirst({ where: { name }, select: { id: true } });
    if (clash) deny("FORBIDDEN", "a role with that name already exists");

    const role = await tx.role.create({
      data: {
        tenantId: input.tenantId,
        name,
        description: input.description?.trim() || null,
        isSystem: false,
        clonedFromKey: templateKey,
        templateVersion: templateKey ? TEMPLATE_VERSION : null,
      },
    });
    if (codes.length > 0) {
      const perms = await tx.permission.findMany({
        where: { code: { in: [...codes] } },
        select: { id: true },
      });
      await tx.rolePermission.createMany({
        data: perms.map((p) => ({
          tenantId: input.tenantId,
          roleId: role.id,
          permissionId: p.id,
          source: "TENANT_GRANT" as const,
        })),
      });
    }
    await record(tx, {
      action: "role.created",
      targetType: "Role",
      targetId: role.id,
      metadata: { name, clonedFromKey: templateKey, codeCount: codes.length },
    });
    return { roleId: role.id };
  });
}

/**
 * Apply grants and revokes to a custom role inside an open tx.
 * Precondition: role:edit authorised, tenant row locked. Enforces §7.1
 * rule 2 (current set and resulting set both ⊆ actor set — with grants
 * ⊆ actor set this also rules out self-escalation) and writes one
 * permission.granted / permission.revoked per code.
 */
async function applyRoleChanges(
  tx: TenantDb,
  actor: MemberActor,
  roleId: string,
  grants: readonly string[],
  revokes: readonly string[],
): Promise<void> {
  for (const c of [...grants, ...revokes]) {
    if (!KNOWN_CODES.has(c)) deny("NOT_FOUND", `unknown permission code ${c}`);
  }
  const role = await loadCustomRole(tx, roleId);
  const current = await roleEffectiveCodes(tx, roleId);
  await assertActorHoldsAll(tx, actor, new Set([...current, ...grants, ...revokes]), {
    rule: "role_edit_subset",
    targetType: "Role",
    targetId: roleId,
    detail: `cannot edit role "${role.name}" - you do not hold`,
  });

  const permIds = await tx.permission.findMany({
    where: { code: { in: [...grants, ...revokes] } },
    select: { id: true, code: true },
  });
  const idByCode = new Map(permIds.map((p) => [p.code, p.id]));
  const key = (permissionId: string) => ({
    tenantId_roleId_permissionId: { tenantId: role.tenantId, roleId, permissionId },
  });

  for (const code of grants) {
    if (current.has(code)) continue;
    const permissionId = idByCode.get(code)!;
    // A tombstone flips back to a deliberate grant; else insert.
    await tx.rolePermission.upsert({
      where: key(permissionId),
      create: { tenantId: role.tenantId, roleId, permissionId, source: "TENANT_GRANT" },
      update: { source: "TENANT_GRANT" },
    });
    await record(tx, {
      action: "permission.granted",
      targetType: "Role",
      targetId: roleId,
      metadata: { code },
    });
  }
  for (const code of revokes) {
    if (!current.has(code)) continue;
    const permissionId = idByCode.get(code)!;
    if (role.clonedFromKey) {
      // B3: clones keep a tombstone so propagation never re-grants.
      await tx.rolePermission.update({ where: key(permissionId), data: { source: "TENANT_REVOKE" } });
    } else {
      await tx.rolePermission.delete({ where: key(permissionId) });
    }
    await record(tx, {
      action: "permission.revoked",
      targetType: "Role",
      targetId: roleId,
      metadata: { code, tombstone: Boolean(role.clonedFromKey) },
    });
  }
}

/** role:edit ✦ — set a custom role's effective codes to exactly `codes`. */
export async function setRolePermissions(input: {
  tenantId: string;
  actor: MemberActor;
  roleId: string;
  codes: readonly string[];
}): Promise<{ granted: string[]; revoked: string[] }> {
  return runGuarded(input.tenantId, input.actor, async (tx) => {
    await requireAccess(tx, input.tenantId, input.actor, "role:edit");
    await bumpPermissionsVersion(tx, input.tenantId);
    const wanted = new Set(input.codes);
    const current = await roleEffectiveCodes(tx, input.roleId);
    const granted = [...wanted].filter((c) => !current.has(c));
    const revoked = [...current].filter((c) => !wanted.has(c));
    await applyRoleChanges(tx, input.actor, input.roleId, granted, revoked);
    return { granted, revoked };
  });
}

/** role:edit ✦ — grant one code to a custom role. */
export async function grantPermission(input: {
  tenantId: string;
  actor: MemberActor;
  roleId: string;
  code: string;
}): Promise<void> {
  await runGuarded(input.tenantId, input.actor, async (tx) => {
    await requireAccess(tx, input.tenantId, input.actor, "role:edit");
    await bumpPermissionsVersion(tx, input.tenantId);
    await applyRoleChanges(tx, input.actor, input.roleId, [input.code], []);
  });
}

/** role:edit ✦ — revoke one code from a custom role (tombstone on clones). */
export async function revokePermission(input: {
  tenantId: string;
  actor: MemberActor;
  roleId: string;
  code: string;
}): Promise<void> {
  await runGuarded(input.tenantId, input.actor, async (tx) => {
    await requireAccess(tx, input.tenantId, input.actor, "role:edit");
    await bumpPermissionsVersion(tx, input.tenantId);
    await applyRoleChanges(tx, input.actor, input.roleId, [], [input.code]);
  });
}

/** role:delete — custom, unassigned roles only (§7.2). */
export async function deleteRole(input: {
  tenantId: string;
  actor: MemberActor;
  roleId: string;
}): Promise<void> {
  await withTenant(input.tenantId, { type: "member", id: input.actor.memberId }, async (tx) => {
    await requireAccess(tx, input.tenantId, input.actor, "role:delete");
    await bumpPermissionsVersion(tx, input.tenantId);
    const role = await loadCustomRole(tx, input.roleId);
    const holders = await tx.memberRole.count({ where: { roleId: role.id } });
    if (holders > 0) deny("FORBIDDEN", `role "${role.name}" is assigned to ${holders} member(s)`);
    // RolePermission rows cascade on the composite FK.
    await tx.role.delete({ where: { id: role.id } });
    await record(tx, {
      action: "role.deleted",
      targetType: "Role",
      targetId: role.id,
      metadata: { name: role.name },
    });
  });
}
