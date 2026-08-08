import { withPlatform } from "@/db";
import {
  PERMISSIONS,
  ROLE_TEMPLATES,
  TEMPLATE_VERSION,
  permissionsForTemplate,
} from "@/authz/catalog";

/**
 * Tenant provisioning (platform plane). Stamps the four system role
 * templates as rows (isSystem=true, templateKey canonical, B3 lineage
 * columns), grants their permission sets with source=TEMPLATE, and
 * seats the owner. The owner template carries ALL codes — no code path
 * ever needs an owner bypass (AUTHZ.md §7.4).
 */
export async function provisionTenant(input: {
  name: string;
  slug: string;
  ownerUserId: string;
}): Promise<{ tenantId: string; ownerMemberId: string }> {
  return withPlatform(
    { type: "system", job: "tenant-provisioning" },
    `provision tenant ${input.slug}`,
    async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: input.name,
          slug: input.slug,
          entitlements: {}, // resolves to everything-on defaults (Phase 1)
        },
      });

      const permissionRows = await tx.permission.findMany({
        select: { id: true, code: true },
      });
      const idByCode = new Map(permissionRows.map((p) => [p.code, p.id]));
      if (idByCode.size < PERMISSIONS.length) {
        throw new Error("permission catalog not seeded — run prisma/seed.ts first");
      }

      let ownerRoleId: string | null = null;
      for (const template of ROLE_TEMPLATES) {
        const role = await tx.role.create({
          data: {
            tenantId: tenant.id,
            name: template.displayName,
            description: template.description,
            isSystem: true,
            templateKey: template.templateKey,
            templateVersion: TEMPLATE_VERSION,
          },
        });
        if (template.templateKey === "owner") ownerRoleId = role.id;
        await tx.rolePermission.createMany({
          data: permissionsForTemplate(template.templateKey).map((perm) => {
            const permissionId = idByCode.get(perm.code);
            if (!permissionId) throw new Error(`catalog missing ${perm.code}`);
            return {
              tenantId: tenant.id,
              roleId: role.id,
              permissionId,
              source: "TEMPLATE" as const,
            };
          }),
        });
      }
      if (!ownerRoleId) throw new Error("owner template missing");

      const owner = await tx.member.create({
        data: { tenantId: tenant.id, userId: input.ownerUserId },
      });
      await tx.memberRole.create({
        data: { tenantId: tenant.id, memberId: owner.id, roleId: ownerRoleId },
      });

      await tx.auditEvent.create({
        data: {
          tenantId: tenant.id,
          actorType: "SYSTEM",
          action: "tenant.provisioned",
          targetType: "Tenant",
          targetId: tenant.id,
          metadata: { slug: input.slug },
          visibility: "PLATFORM",
        },
      });

      return { tenantId: tenant.id, ownerMemberId: owner.id };
    },
    { readOnly: false, targetTenantId: undefined },
  );
}
