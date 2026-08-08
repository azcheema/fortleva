/**
 * Classification of every Prisma model for tenancy enforcement
 * (TENANCY.md §11: an unclassified model fails the build — see
 * model-registry.test.ts, which cross-checks this list against
 * prisma/schema.prisma and fails on any model missing here).
 *
 * Prisma 7 removed runtime DMMF, so the census is a checked constant:
 * the test parses the schema and verifies (a) every model is listed,
 * (b) every model listed as tenant-scoped really has tenant_id,
 * (c) nothing tenant-scoped is misfiled as global.
 */

/** Prisma client property names (camelCase model names). */
export const MODEL_CLASSES = {
  // Tenant root: RLS keys on id, not tenant_id
  tenantRoot: ["tenant"],
  // Tenant-scoped: carry tenantId; where-injection + tenant_isolation RLS
  tenant: [
    "member",
    "memberInvite",
    "role",
    "rolePermission",
    "memberRole",
    "tenantPreference",
    "tenantCounter",
    "document",
    "fileVersion",
    "fileObject",
  ],
  // Audit: tenantId nullable, append-only, reads injected, writes via audit.record()
  audit: ["auditEvent"],
  // Global/auth/catalog: no tenantId by design (TENANCY.md §6.3 allowlist)
  global: [
    "user",
    "session",
    "account",
    "verification",
    "twoFactor",
    "passkey",
    "permission",
    "featureFlag",
  ],
} as const;

export type ModelClass = keyof typeof MODEL_CLASSES;

const lookup = new Map<string, ModelClass>();
for (const [cls, models] of Object.entries(MODEL_CLASSES) as [ModelClass, readonly string[]][]) {
  for (const m of models) lookup.set(m, cls);
}

export const classOf = (model: string): ModelClass | undefined =>
  lookup.get(model.charAt(0).toLowerCase() + model.slice(1));

export const allClassifiedModels = (): string[] => [...lookup.keys()];
