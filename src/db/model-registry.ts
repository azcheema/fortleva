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
    "tenantKey",
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

/**
 * RLS subclass of every tenant-scoped model (TENANCY.md §1 amendment,
 * DATA_MODEL.md §2.3). Each subclass implies a column set and policy
 * names that the posture dbtest (isolation.dbtest.ts) checks against
 * pg_policies / information_schema:
 *   A               — portal_deny; NEVER a visibility column
 *   B_clientScoped  — client_id + visibility; portal_gate (two-term)
 *   B_projectScoped — + portal_enabled; portal_gate (three-term); Phase 2
 *   principalScoped — per-principal carve-out (Notification, later)
 * model-registry.test.ts asserts every MODEL_CLASSES.tenant model is in
 * exactly one subclass.
 */
export const RLS_CLASSES = {
  A: [
    "member",
    "memberInvite",
    "role",
    "rolePermission",
    "memberRole",
    "tenantPreference",
    "tenantCounter",
    "tenantKey",
    "fileVersion",
    "fileObject",
  ],
  B_clientScoped: ["document"],
  B_projectScoped: [],
  principalScoped: [],
} as const satisfies Record<string, readonly string[]>;

export type RlsClass = keyof typeof RLS_CLASSES;

/** Physical table name of a Prisma model (all models @@map to snake_case). */
export const tableNameOf = (model: string): string =>
  model.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace(/^_/, "");

const lookup = new Map<string, ModelClass>();
for (const [cls, models] of Object.entries(MODEL_CLASSES) as [ModelClass, readonly string[]][]) {
  for (const m of models) lookup.set(m, cls);
}

export const classOf = (model: string): ModelClass | undefined =>
  lookup.get(model.charAt(0).toLowerCase() + model.slice(1));

export const allClassifiedModels = (): string[] => [...lookup.keys()];
