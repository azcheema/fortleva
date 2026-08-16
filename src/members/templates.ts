import type { PrismaClient } from "@/generated/prisma/client";
import type { TenantDb } from "@/db";
import {
  PERMISSIONS,
  ROLE_TEMPLATES,
  TEMPLATE_VERSION,
  permissionsForTemplate,
  type TemplateKey,
} from "@/authz/catalog";

/**
 * B3 template propagation (AUTHZ.md §3.5, decided: additive-only).
 * A template generation bump (TEMPLATE_VERSION) reaches every role that
 * derives from a template — system rows (templateKey) and custom clones
 * (clonedFromKey) — by INSERTING the codes it now lacks:
 *   - never removes anything (removals never propagate);
 *   - skips any code the tenant tombstoned (source = TENANT_REVOKE);
 *   - ✦ (requiresMfa) codes never reach custom clones — tenants grant
 *     those deliberately;
 *   - propagated rows carry source = TEMPLATE, actor = SYSTEM in the
 *     audit log, one role.updated per touched role (codes listed).
 * Idempotent: a role already at TEMPLATE_VERSION is skipped.
 *
 * Kept free of value imports from "@/db" so prisma/seed.ts (owner
 * client, no tenant context) can drive it for every tenant.
 */

/** The withTenant() tx surface this needs (type-only import: no client is built). */
export type PropagationDb = Pick<
  TenantDb,
  "role" | "rolePermission" | "permission" | "tenant" | "auditEvent"
>;

const TEMPLATE_KEYS = new Set<string>(ROLE_TEMPLATES.map((t) => t.templateKey));
const isTemplateKey = (k: string | null): k is TemplateKey => k !== null && TEMPLATE_KEYS.has(k);

/** Codes a custom clone of `key` starts with / receives: the template minus ✦. */
export const cloneCodesForTemplate = (key: TemplateKey): readonly string[] =>
  permissionsForTemplate(key)
    .filter((p) => !p.requiresMfa)
    .map((p) => p.code);

export type PropagationResult = {
  rolesTouched: number;
  codesGranted: number;
};

export async function propagateTemplates(
  tx: PropagationDb,
  tenantId: string,
): Promise<PropagationResult> {
  const roles = await tx.role.findMany({
    where: {
      tenantId,
      OR: [{ templateKey: { not: null } }, { clonedFromKey: { not: null } }],
    },
    select: {
      id: true,
      isSystem: true,
      templateKey: true,
      clonedFromKey: true,
      templateVersion: true,
      rolePermissions: { select: { permissionId: true, source: true } },
    },
  });
  const stale = roles.filter((r) => (r.templateVersion ?? 0) < TEMPLATE_VERSION);
  if (stale.length === 0) return { rolesTouched: 0, codesGranted: 0 };

  const permissionRows = await tx.permission.findMany({ select: { id: true, code: true } });
  const idByCode = new Map(permissionRows.map((p) => [p.code, p.id]));
  const codeById = new Map(permissionRows.map((p) => [p.id, p.code]));
  if (idByCode.size < PERMISSIONS.length) {
    throw new Error("permission catalog not seeded — run prisma/seed.ts first");
  }

  let codesGranted = 0;
  for (const role of stale) {
    const key = role.isSystem ? role.templateKey : role.clonedFromKey;
    if (!isTemplateKey(key)) continue;
    const target = role.isSystem
      ? permissionsForTemplate(key).map((p) => p.code)
      : cloneCodesForTemplate(key);
    const present = new Set(role.rolePermissions.map((rp) => codeById.get(rp.permissionId)));
    // Tombstones AND live rows are both "present": nothing to insert.
    const missing = target.filter((code) => !present.has(code));
    if (missing.length > 0) {
      await tx.rolePermission.createMany({
        data: missing.map((code) => {
          const permissionId = idByCode.get(code);
          if (!permissionId) throw new Error(`catalog missing ${code}`);
          return { tenantId, roleId: role.id, permissionId, source: "TEMPLATE" as const };
        }),
        skipDuplicates: true,
      });
      codesGranted += missing.length;
    }
    await tx.role.update({
      where: { id: role.id, tenantId },
      data: { templateVersion: TEMPLATE_VERSION },
    });
    await tx.auditEvent.create({
      data: {
        tenantId,
        actorType: "SYSTEM",
        action: "role.updated",
        targetType: "Role",
        targetId: role.id,
        metadata: {
          reason: "template_propagation",
          templateKey: key,
          from: role.templateVersion ?? 0,
          to: TEMPLATE_VERSION,
          granted: missing,
        },
        visibility: "TENANT",
      },
    });
  }
  await tx.tenant.update({
    where: { id: tenantId },
    data: { permissionsVersion: { increment: 1 } },
  });
  return { rolesTouched: stale.length, codesGranted };
}

/**
 * Seed/maintenance entry point: propagate for every tenant, one
 * transaction per tenant, on a client that bypasses RLS (owner or
 * app_platform). Used by prisma/seed.ts after the catalog upsert.
 */
export async function runTemplatePropagation(
  client: Pick<PrismaClient, "tenant" | "$transaction">,
): Promise<PropagationResult & { tenants: number }> {
  const tenants = await client.tenant.findMany({ select: { id: true } });
  let rolesTouched = 0;
  let codesGranted = 0;
  for (const t of tenants) {
    // The plain client's delegates are the same runtime API as the
    // extended runtime client's but Prisma types them distinctly — the
    // same cast withTenant() itself makes (src/db/with-tenant.ts).
    const r = await client.$transaction((tx) =>
      propagateTemplates(tx as unknown as PropagationDb, t.id),
    );
    rolesTouched += r.rolesTouched;
    codesGranted += r.codesGranted;
  }
  return { tenants: tenants.length, rolesTouched, codesGranted };
}
