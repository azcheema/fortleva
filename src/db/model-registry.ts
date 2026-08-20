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
    "client",
    "contact",
    "memberClient",
    "memberProject",
    "project",
    "projectVersion",
    "milestone",
    "service",
    "document",
    "fileVersion",
    "fileObject",
    // 2W — work + notifications core:
    "workflowState",
    "workflowPreset",
    "workItem",
    "workItemActivity",
    "label",
    "workItemLabel",
    "workItemCollaborator",
    "workItemSubscriber",
    "comment",
    "mention",
    "projectTemplate",
    "notification",
    "subscription",
    "notificationPreference",
    "emailOutbox",
    // 2T — time (DATA_MODEL.md §6.15):
    "timeEntry",
    "rateCard",
    "projectBudget",
    "budgetAlert",
    "projectTimeSummary",
    "staffNotice",
    "staffNoticeAcknowledgment",
    "shift",
    "shiftBreak",
    "timeReport",
    "workType",
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
    // Platform-owned suppression list (no tenant column by design —
    // SES reputation is shared; DATA_MODEL §6.18):
    "emailSuppression",
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
 *   B_projectScoped — + portal_enabled; portal_gate (three-term, qual
 *                     contains portal_enabled)
 *   principalScoped — per-principal carve-out (Notification, later)
 * model-registry.test.ts asserts every MODEL_CLASSES.tenant model is in
 * exactly one subclass. Structural exceptions to the visibility term are
 * declared in PORTAL_GATE_VARIANTS — never implied.
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
    "memberClient",
    "memberProject",
    "fileVersion",
    "fileObject",
    // 2W:
    "workflowState",
    "workflowPreset",
    "label",
    "workItemLabel",
    "workItemCollaborator",
    "workItemSubscriber",
    "mention",
    "projectTemplate",
    "subscription",
    "notificationPreference",
    "emailOutbox",
    // 2T (never portal-reachable; the never-list is enforced by
    // absence of columns AND by portal_deny here):
    "timeEntry",
    "rateCard",
    "projectBudget",
    "budgetAlert",
    "staffNotice",
    "staffNoticeAcknowledgment",
    "shift",
    "shiftBreak",
    "workType",
  ],
  B_clientScoped: ["client", "contact"],
  B_projectScoped: [
    "project",
    "projectVersion",
    "milestone",
    "service",
    "document",
    // 2W (comment: nullable projectId — the stamp trigger derives
    // portal_enabled TRUE when projectId is NULL, like document):
    "workItem",
    "workItemActivity",
    "comment",
    // 2T — the ONLY portal time surfaces (member-free by construction):
    // project_time_summary (visibility derived from hoursSharingMode)
    // and time_report (4-term gate: + status = PUBLISHED).
    "projectTimeSummary",
    "timeReport",
  ],
  // Receiver-bound rows: tenant_isolation + a RESTRICTIVE principal_scope
  // policy binding SELECT/UPDATE to the receiver (member => own MEMBER
  // rows, contact => own CONTACT rows of its client, system passes);
  // INSERT is any non-contact principal (notify.emit fans out — and must
  // use createMany: INSERT..RETURNING would trip the SELECT binding).
  principalScoped: ["notification"],
} as const satisfies Record<string, readonly string[]>;

export type RlsClass = keyof typeof RLS_CLASSES;

/**
 * Class-B rows whose portal_gate does NOT use the `visibility` column
 * (TENANCY.md §7.1 "structural rows"; DATA_MODEL.md §2.3/§6.5). Every
 * other class-B model carries `visibility` and the standard term. The
 * posture test requires these tables to have NO visibility column (a
 * structural row that grows one must move out of this map, deliberately)
 * and, for projectScoped ones, still checks portal_enabled + gate qual.
 *   client         — the client-root: gate is `id = app.client_id`
 *   contact        — client match only
 *   project        — client match AND its own portal_enabled
 *   projectVersion — client match AND status = 'SHIPPED' AND portal_enabled
 */
export const PORTAL_GATE_VARIANTS = {
  client: { clientColumn: "id", term: "structural" },
  contact: { clientColumn: "client_id", term: "structural" },
  project: { clientColumn: "client_id", term: "portal_enabled" },
  projectVersion: { clientColumn: "client_id", term: "status" },
} as const satisfies Record<
  string,
  { clientColumn: "id" | "client_id"; term: "structural" | "portal_enabled" | "status" }
>;

/**
 * Tables the `project.portal_enabled` fan-out trigger must reach: every
 * B_projectScoped model except `project` itself. The trigger body in the
 * migration is checked against this list by the posture dbtest so a new
 * projectScoped table cannot be forgotten (TENANCY.md §7.2).
 */
export const PORTAL_ENABLED_FANOUT_TARGETS = RLS_CLASSES.B_projectScoped.filter(
  (m) => m !== "project",
);

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
