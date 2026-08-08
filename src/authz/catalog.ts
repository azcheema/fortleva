/**
 * The permission catalog and role templates — AUTHZ.md §3.1–§3.3 is the
 * normative source; this file only encodes it. Codes are immutable
 * `resource:verb` identifiers, forever. Three namespaces, deliberately
 * distinct: permission codes `resource:verb`, audit actions
 * `entity.verb`, portal capabilities `portal.area.verb`.
 *
 * The seeded matrix is the B6-approved default template seed
 * (2026-08-08): C = owner ("CEO"), M = manager, A = admin, E = employee.
 * requiresMfa is the ✦ set (§7.5): drives enrollment enforcement,
 * step-up gating, and the §3.5 rule that ✦ codes never auto-propagate
 * to custom clones.
 */

export const MODULES = [
  "core",
  "invoicing",
  "contracts",
  "reports",
  "issues",
  "documentation",
  "continuity_box",
  "portal",
] as const;

export type Module = (typeof MODULES)[number];

export type TemplateKey = "owner" | "manager" | "admin" | "employee";

export type PermissionDef = {
  readonly code: string;
  readonly module: Module;
  readonly description: string;
  readonly requiresMfa: boolean;
  /** Which role templates seed this permission (owner always does). */
  readonly seeded: readonly TemplateKey[];
};

const CMAE: readonly TemplateKey[] = ["owner", "manager", "admin", "employee"];
const CMA: readonly TemplateKey[] = ["owner", "manager", "admin"];
const CME: readonly TemplateKey[] = ["owner", "manager", "employee"];
const CM: readonly TemplateKey[] = ["owner", "manager"];
const CA: readonly TemplateKey[] = ["owner", "admin"];
const C: readonly TemplateKey[] = ["owner"];

const p = (
  code: string,
  module: Module,
  description: string,
  seeded: readonly TemplateKey[],
  requiresMfa = false,
): PermissionDef => ({ code, module, description, requiresMfa, seeded });

/** AUTHZ.md §3.2, row for row. Order follows the doc. */
export const PERMISSIONS: readonly PermissionDef[] = [
  p("client:view", "core", "View client records", CMAE),
  p("client:view_all", "core", "Scope override: see every client in the tenant", CMA),
  p("client:create", "core", "Create clients", CMA),
  p("client:edit", "core", "Edit client details, internal notes", CMA),
  p("client:delete", "core", "Delete/archive a client", C),
  p("client:manage_assignments", "core", "Assign/unassign members to clients", CMA),
  p("client:manage_contacts", "portal", "Invite, deactivate portal contacts; set contact profile", CMA),
  p("project:view", "core", "View projects, timeline, versions", CMAE),
  p("project:create", "core", "Create projects", CM),
  p("project:edit", "core", "Edit project fields, environments, links", CME),
  p("project:delete", "core", "Delete/archive a project", CM),
  p("project:manage_versions", "core", "Publish project versions and release notes, manage milestones", CME),
  p("project:manage_assignments", "core", "Assign members to projects", CM),
  p("service:view", "core", "View services/products", CMAE),
  p("service:create", "core", "Create services", CMA),
  p("service:edit", "core", "Edit services, renewal dates", CMA),
  p("service:delete", "core", "Delete services", CM),
  p("contract:view", "contracts", "View contracts", CMA),
  p("contract:create", "contracts", "Draft/upload contracts", CMA),
  p("contract:edit", "contracts", "Edit draft contracts (sent/signed are immutable)", CMA),
  p("contract:send", "contracts", "Send for signature (client-facing act)", CMA),
  p("contract:delete", "contracts", "Delete draft contracts only", CM),
  p("invoice:view", "invoicing", "View invoices", CMA),
  p("invoice:create", "invoicing", "Create draft invoices (unnumbered)", CMA),
  p("invoice:edit", "invoicing", "Edit draft invoices", CMA),
  p("invoice:issue", "invoicing", "Issue: allocate gap-free number — irreversible", CA),
  p("invoice:send", "invoicing", "Send an issued invoice", CA),
  p("invoice:record_payment", "invoicing", "Register payment / mark paid", CA),
  p("invoice:credit", "invoicing", "Issue a credit note (never delete issued invoices)", CA),
  p("invoice:delete", "invoicing", "Delete draft invoices only", CA),
  p("invoice:manage_series", "invoicing", "Configure invoice series (legal numbering config)", C, true),
  p("document:view", "documentation", "View documents/files (internal + client-visible)", CMAE),
  p("document:upload", "documentation", "Upload files, create documents and versions", CMAE),
  p("document:edit", "documentation", "Rename, move, tag, upload new version", CMAE),
  p("document:delete", "documentation", "Delete documents", CMA),
  p("document:change_visibility", "documentation", "Flip internal/client-visible — audited", CMA),
  p("issue:view", "issues", "View issues", CMAE),
  p("issue:create", "issues", "Create issues (also on behalf of a contact)", CMAE),
  p("issue:edit", "issues", "Triage: type, priority, status, assignee, link to release", CME),
  p("issue:comment", "issues", "Comment on issues", CMAE),
  p("issue:delete", "issues", "Delete issues", CM),
  p("report:view", "reports", "View performance reports / CrUX charts", CMAE),
  p("report:upload", "reports", "Upload report data files", CMA),
  p("report:delete", "reports", "Delete reports", CM),
  p("continuity_box:view", "continuity_box", "See box status, reseal dates, open requests", CMA, true),
  p("continuity_box:edit", "continuity_box", "Author, update, reseal box contents", C, true),
  p("continuity_box:configure", "continuity_box", "Trigger conditions, veto window, trustee, fallback contact", C, true),
  p("continuity_box:veto", "continuity_box", "Respond to a continuity open request (veto/approve)", CMA, true),
  p("role:view", "core", "List roles and their permission sets", CMA),
  p("role:create", "core", "Clone a template / create a custom role", CA),
  p("role:edit", "core", "Grant/revoke permissions on non-system roles (subset-guarded)", CA, true),
  p("role:delete", "core", "Delete non-system, unassigned roles", CA),
  p("member:view", "core", "See the member list", CMAE),
  p("member:invite", "core", "Invite members", CA),
  p("member:remove", "core", "Remove/suspend members (last-owner-guarded)", CA),
  p("member:manage_roles", "core", "Assign/revoke roles (escalation-guarded)", CA, true),
  p("billing:view", "core", "See plan, platform invoices, usage vs limits", CA),
  p("billing:manage", "core", "Change plan, payment method, cancel", C, true),
  p("settings:view", "core", "View tenant settings", CMA),
  p("settings:edit", "core", "Edit tenant profile, branding, locale", CA),
  p("settings:manage_modules", "core", "Toggle tenant module switches", C, true),
  p("audit:view", "core", "View the tenant's own audit log", CA),
  p("tenant:export", "core", "Full tenant data export", C, true),
];

export type RoleTemplate = {
  readonly templateKey: TemplateKey;
  /** Seeded display name; "CEO" is a name, the identity is templateKey. */
  readonly displayName: string;
  readonly description: string;
};

/** AUTHZ.md §3.3 — the last-owner invariant pins to templateKey 'owner'. */
export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    templateKey: "owner",
    displayName: "CEO",
    description: "Owner-equivalent: every permission, deliberately — no code path needs an owner bypass.",
  },
  {
    templateKey: "manager",
    displayName: "Manager",
    description: "Delivery lead: full client/project/service/contract work; no money-final acts, no member/role admin.",
  },
  {
    templateKey: "admin",
    displayName: "Admin",
    description: "Back office: full invoice lifecycle, member and role management, settings, audit log.",
  },
  {
    templateKey: "employee",
    displayName: "Employee",
    description: "Works assigned clients: projects, documents, issues. No invoicing, no contracts, no admin.",
  },
] as const;

/** Current template generation (Role.templateVersion) — bump on any
 * template change so B3 additive propagation knows what to reconcile. */
export const TEMPLATE_VERSION = 1;

export const permissionsForTemplate = (key: TemplateKey): readonly PermissionDef[] =>
  PERMISSIONS.filter((perm) => perm.seeded.includes(key));
