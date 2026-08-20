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
  "issues", // deprecated alias (2026-08-16: absorbed by `work`) — codes stay, unseeded from TEMPLATE_VERSION 2
  "documentation",
  "continuity_box",
  "portal",
  "work", // 2W
  "time", // 2T
  "vault", // 3V
] as const;

export type Module = (typeof MODULES)[number];

export type TemplateKey = "owner" | "manager" | "admin" | "employee";

export type PermissionDef = {
  readonly code: string;
  readonly module: Module;
  readonly description: string;
  readonly requiresMfa: boolean;
  /** Which role templates seed this permission (owner always does,
   * except deprecated codes — those seed nowhere from their
   * deprecation's TEMPLATE_VERSION on). */
  readonly seeded: readonly TemplateKey[];
  /** Immutable-forever codes are deprecated, never renamed or removed
   * (AUTHZ.md §3.1 — first use: issue:* at TEMPLATE_VERSION 2). */
  readonly deprecated?: true;
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
  // DEPRECATED 2026-08-16 (work-management plan; the first §3.1
  // deprecation): Issue was absorbed by WorkItem(kind=REQUEST) +
  // polymorphic Comment. Codes are immutable so the rows stay, but they
  // seed NOWHERE from TEMPLATE_VERSION 2 (B3 propagation is additive —
  // existing grants survive until a tenant revokes them).
  { ...p("issue:view", "issues", "DEPRECATED — absorbed by work_item:view", []), deprecated: true },
  { ...p("issue:create", "issues", "DEPRECATED — absorbed by work_item:create", []), deprecated: true },
  { ...p("issue:edit", "issues", "DEPRECATED — absorbed by work_item:edit / work_item:triage", []), deprecated: true },
  { ...p("issue:comment", "issues", "DEPRECATED — absorbed by comment:create", []), deprecated: true },
  { ...p("issue:delete", "issues", "DEPRECATED — absorbed by work_item:delete", []), deprecated: true },
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
  // ── Phase 2W (module `work`, +17; catalog 63 → 80; TEMPLATE_VERSION
  // 2026-08-20 per AUTHZ.md §3.2.1) ─────────────────────────────────
  p("work_item:view", "work", "View Tasks/Epics/Subtasks incl. activity, labels, collaborators, subtree", CMAE),
  p("work_item:create", "work", "Create work items of any kind (portal REQUEST intake is brokered)", CMAE),
  p("work_item:edit", "work", "Edit fields, state, rank, assignee, parent, milestone, archive/restore — scope-checked", CMAE),
  p("work_item:delete", "work", "Hard-delete work items (subtree)", CM),
  p("work_item:change_visibility", "work", "Flip INTERNAL/CLIENT_VISIBLE incl. bulk make-private — audited, the worst-bug surface", CMA),
  p("work_item:triage", "work", "Accept / Decline / Duplicate / Snooze a REQUEST out of TRIAGE", CME),
  p("workflow:manage", "work", "Edit a project's WorkflowStates and tenant WorkflowPresets (category immutable)", CMA),
  p("label:manage", "work", "Create/rename/delete tenant labels", CMA),
  p("comment:create", "work", "Comment on any commentable subject; edit/delete own comments", CMAE),
  p("comment:edit_any", "work", "Edit other members' comments", CM),
  p("comment:delete", "work", "Delete comments (any author)", CM),
  p("comment:change_visibility", "work", "Flip comment visibility (child <= parent rule) — audited", CMA),
  p("project_update:view", "work", "View ProjectUpdates incl. drafts and the internal snapshot", CMAE),
  p("project_update:create", "work", "Draft and edit unpublished updates", CME),
  p("project_update:publish", "work", "Publish (freezes seq + snapshots), archive", CM),
  p("project_update:change_visibility", "work", "Flip update visibility — audited", CMA),
  p("project_template:manage", "work", "Create/edit/delete ProjectTemplates; save project as template", CMA),
  // ── Phase 2T (module `time`, +16; catalog 80 → 96; TEMPLATE_VERSION 3
  // 2026-08-20 per AUTHZ.md §3.2.1 as amended by decision 14) ──────
  p("time:track", "time", "Start/stop own timer; create/edit/delete/split own unlocked entries; clock own shift in/out, record own breaks", CMAE),
  p("time:view_team", "time", "See other members' entries and totals within scope; per-member shift/worked/break day totals — closed rows only, never live presence", CM),
  p("time:edit_any", "time", "Edit other members' unlocked entries, shifts and breaks (audited edited_by_other)", CM),
  p("time:delete_any", "time", "Delete other members' unlocked entries and shifts", CM),
  p("time:manage_locks", "time", "Set lock date; lock/unlock entries (app.time_lock_bypass, always audited)", CA),
  p("time:reprice", "time", "Run the reprice command (FROM_DATE or ALL_UNBILLED) on unlocked entries — audited", CA),
  p("time:export", "time", "CSV export of entries/rollups — cost columns never by default", CMA),
  p("rate:view_bill", "time", "See BILL rate cards, billRate snapshots and billable amounts", CM),
  p("rate:manage_bill", "time", "Create/close BILL RateCard rows (immutable rows; close + insert)", CA),
  p("rate:view_cost", "time", "Decrypt COST cards; margin/profit views (step-up)", C, true),
  p("rate:manage_cost", "time", "Create/close COST RateCard rows (step-up)", C, true),
  p("budget:view", "time", "See ProjectBudget and burn", CM),
  p("budget:manage", "time", "Create/edit budgets, thresholds, notify list", CMA),
  p("time_report:manage", "time", "Create/generate/edit/archive TimeReport drafts", CM),
  p("time_report:publish", "time", "Publish/unpublish a TimeReport to the portal — immutable snapshot, audited", CM),
  p("work_type:manage", "time", "Create/edit/archive tenant WorkType rows", CMA),
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
 * template change so B3 additive propagation knows what to reconcile.
 * v2 (2026-08-20): +17 `work` codes; issue:* unseeded (deprecated).
 * v3 (2026-08-20): +16 `time` codes (2T; rate:view_cost / rate:manage_cost ✦). */
export const TEMPLATE_VERSION = 3;

export const permissionsForTemplate = (key: TemplateKey): readonly PermissionDef[] =>
  PERMISSIONS.filter((perm) => perm.seeded.includes(key));
