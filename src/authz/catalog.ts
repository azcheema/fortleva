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
  // The description widened with C48 (2026-09-29): the code alone gates the
  // contact RECORDS too, portal on or off — the role editor shows this
  // text as each code's hover title (English only).
  p("client:manage_contacts", "portal", "Add, edit and delete a client's contacts; invite them to the portal, pause or end their access; set contact profile", CMA),
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
  p("work_item:delete", "work", "Delete a work item (soft; no live children) with its attachments and comments", CM),
  p("work_item:change_visibility", "work", "Flip INTERNAL/CLIENT_VISIBLE incl. bulk make-private — audited, the worst-bug surface", CMA),
  p("work_item:triage", "work", "Accept / Decline / Duplicate / Snooze a REQUEST out of TRIAGE", CME),
  // ── 2W-R (+1; catalog 96 → 97; TEMPLATE_VERSION 4, 2026-08-31) ───
  p("work_item:approve", "work", "Move a task into an approval-gated state (the seeded Done) — supplements work_item:edit, never replaces it", CMA),
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
  // ── Phase 3 (module `portal`, +1; catalog 97 → 98; TEMPLATE_VERSION 5,
  // 2026-09-21) — AUTHZ.md §3.2's row, which has named this code since
  // 2026-08-16 while only `client:manage_contacts` existed in the
  // catalogue (Phase 3 memo §2.5). It lands in the slice that gives the
  // portal switch its own surface, and it lands ENFORCED: the equality
  // in `enforcement.test.ts` refuses a code that merely exists.
  //
  // C M, NOT C M E — and this NARROWS who may flip the switch. The two
  // controls it takes over (`setPortalEnabled`, `setHoursSharingMode`)
  // ran on `project:edit`, which is C M E, so an employee could switch a
  // client's portal on. Deciding what a client can reach is a delivery
  // lead's call in every other row of §3.2's portal column, and the
  // narrowing is the point of giving the control its own code rather
  // than leaving it on the one that also renames the project.
  p("project:manage_portal", "portal", "Portal master switch, hours sharing mode, view as client — audited", CM),
  // ── Phase 3 slice 6b (module `work`, +1; catalog 98 → 99;
  // TEMPLATE_VERSION 6, 2026-09-22) ──────────────────────────────────
  //
  // **C M, NOT C M E, AND THE NARROWING IS THE WHOLE POINT** (founder
  // decision, 2026-09-22). `work_item:triage` is C M E, so an employee
  // may answer a client's request — Accept it onto the board, or Snooze
  // it — and that is right: the people doing the work are the people
  // who know what is already in hand.
  //
  // Declining is different in kind, not in degree. It ENDS something a
  // client asked for AND publishes the agency's words to them verbatim,
  // on the one surface a client reads as a promise. That is the same
  // judgement every other row of AUTHZ §3.2's portal column reserves for
  // a delivery lead, and this product has exactly one other code that
  // puts member-written prose in front of a client — `project_update:publish`,
  // which is also C M.
  //
  // DUPLICATE IS COVERED TOO, because from the client's side it IS a
  // decline: `portal.ts` renders both as an answered request with the
  // reason — "Declined", or "Cancelled" when the agency had accepted it
  // first (C31) — and a permission that guarded only one of the two
  // verbs would guard nothing. The code's name follows the client's view
  // rather than the member's menu, deliberately.
  //
  // It supplements `work_item:triage`, never replaces it — both are
  // required, exactly as `work_item:approve` supplements
  // `work_item:edit` (2W-R).
  p(
    "work_item:triage_decline",
    "work",
    "Decline a client's REQUEST or mark it a duplicate — publishes the agency's reply to the client's portal; supplements work_item:triage, never replaces it",
    CM,
  ),
  // ── Phase 3V slice 1 (module `vault`, +5; catalog 99 → 104;
  // TEMPLATE_VERSION 7, 2026-10-01) — AUTHZ.md §3.2's rows, landing with
  // the services that enforce them (`enforcement.test.ts` refuses a code
  // that merely exists). The other six vault codes — share, export,
  // change_visibility and the three `asset:*` — land with their slices.
  //
  // `credential:reveal` is C M A, NOT C M A E (decision 13, CP4): seeding
  // it on the employee template would make the vault silently force MFA
  // enrolment on every employee. A tenant that wants employees revealing
  // grants it to a clone, which forces enrolment for exactly those
  // holders. ✦ — and the vault's own window (`vault.stepUpMinutes`,
  // default 10) is checked on every Reveal, Copy and code, on top.
  p("credential:view", "vault", "List/detail credential metadata (masked; ciphertext never selected)", CMAE),
  p("credential:create", "vault", "Create credential items (incl. the secret)", CMAE),
  p("credential:edit", "vault", "Edit credential metadata; replace the secret (the old one is kept as a version)", CMA),
  p("credential:delete", "vault", "Delete credential items", CM),
  p("credential:reveal", "vault", "Reveal / Copy / TOTP code — one field per call, step-up + reveal budget, audited per call", CMA, true),
  // ── Slice 84 (module `core`, +1; catalog 104 → 105; TEMPLATE_VERSION 8,
  // 2026-10-02) — founder decision C50: an owner resets a teammate's
  // two-factor (the answer for a lost phone with no backup codes left) or
  // signs them out everywhere (`src/auth/member-reset.ts`). C only, ✦: it
  // lets the holder put a teammate's account back on the password alone,
  // so it asks the owner's own fresh factor, and it is grant-subset-guarded
  // against a custom role it is later granted to.
  p(
    "member:reset_two_factor",
    "core",
    "Reset a teammate's two-factor or sign them out on every device — confirm who is asking by phone or in person first",
    C,
    true,
  ),
  // ── Phase 3V slice 87 (module `vault`, +3; catalog 105 → 108;
  // TEMPLATE_VERSION 9, 2026-10-03) — AUTHZ.md §3.2's `asset:*` rows,
  // landing with the client's Assets tab that enforces them. Assets are
  // NON-SECRET records (a domain, its registrar, its renewal date), so
  // none is ✦ and none is behind the vault's door: a login is the vault's,
  // never an asset's. Scoped like credentials (`src/modules/vault/scope.ts`).
  p("asset:view", "vault", "View a client's asset registry (domains, hosting, certificates, licences) and its renewal dates", CMAE),
  p("asset:manage", "vault", "Add and edit assets, their renewal dates and costs, and retire them", CMA),
  p("asset:delete", "vault", "Delete assets", CM),
  // ── Phase 3V slice 90 (module `vault`, +1; catalog 108 → 109;
  // TEMPLATE_VERSION 10, 2026-10-04) — AUTHZ.md §3.2's `credential:share`
  // row, landing with the share links that enforce it
  // (`src/modules/vault/share-links.ts`). ✦, and ALWAYS a fresh factor
  // (AUTHZ.md §7.5, CP4: "always step-up for share"): the share form
  // carries the member's authenticator code. Making a link also needs
  // `credential:reveal` — a link to oneself would otherwise be a reveal
  // that the reveal code never granted.
  p("credential:share", "vault", "Create and revoke view-once share links to one secret field — always a fresh factor, audited", CMA, true),
  // ── Phase 3V slice 91 (module `vault`, +1; catalog 109 → 110;
  // TEMPLATE_VERSION 11, 2026-10-05) — AUTHZ.md §3.2's
  // `credential:change_visibility` row, landing with the client side of
  // the everyday vault (founder decisions C52 (d), C59;
  // `src/modules/vault/visibility.ts`). C A, ✦: showing a login to a
  // client is a privilege decision, and ALWAYS a fresh factor (AUTHZ.md
  // §7.5, CP4 — the dialog carries the member's authenticator code);
  // hiding it again asks only the vault's window, as revoking a share link
  // does. Showing also needs `vault.allowPortalCredentials` on.
  p("credential:change_visibility", "vault", "Show a login to the client's main contacts, or hide it again — showing always asks a fresh factor, audited", CA, true),
  // ── Phase 3V slice 92 (module `vault`, +1; catalog 110 → 111;
  // TEMPLATE_VERSION 12, 2026-10-05) — the sealed layer's staff side
  // (founder decisions C52 (e), C60; `src/modules/vault/seal.ts`). Anyone
  // who can edit a login SEALS it (`credential:edit`); only an OWNER
  // unseals one or deletes a sealed one (C52 (e), C60 (b)) — taking away
  // the client's right to ask for it. C only, ✦: an owner's act, and the
  // owner role holds every code. It asks the vault's window, no fresh
  // authenticator code: it takes access away, as hiding a login does.
  p("credential:unseal", "vault", "Unseal a login sealed for its client, or delete a sealed one — the client can then no longer ask for it, audited", C, true),
  // ── Phase 3V slice 95 (module `vault`, +1; catalog 111 → 112;
  // TEMPLATE_VERSION 13, 2026-10-06) — AUTHZ.md §3.2's `credential:export`
  // row, landing with the export that enforces it (founder decision C63;
  // `src/modules/vault/export.ts`). C only, ✦, and ALWAYS a fresh factor
  // (AUTHZ.md §7.5, CP4: "always step-up for export") — the export dialog
  // carries the member's authenticator code. Exporting also needs
  // `credential:reveal`: a file of every secret is every reveal at once,
  // which a role holding export without reveal was never granted.
  p("credential:export", "vault", "Export logins with their secrets in plain text, as a file for a password manager — always a fresh factor, every holder is emailed, audited", C, true),
  // ── Phase 4 slice 110 (+2; catalog 112 → 114; TEMPLATE_VERSION 14,
  // 2026-10-10) — AUTHZ.md §3.2's two reserved bridge rows, landing with the
  // hours they guard (founder decisions C75 (a), C80; `src/modules/invoicing/
  // hours.ts`). C A, as the rest of the invoice lifecycle; neither ✦.
  // Billed hours are NEVER LOCKED (C75 (a)): neither code sets `locked_reason`
  // — an hour is MARKED, and stays editable. The database holds both
  // (`invoice_line_time_entry_guard`, `time_entry_billing_guard`, migration
  // 20261010180000). Holding `invoice:generate_from_time` shows the bill rates
  // of the hours it lists, as any invoice line shows its price — an admin
  // without `rate:view_bill` sees them there.
  p(
    "invoice:generate_from_time",
    "invoicing",
    "Put tracked hours on invoice drafts (the ready-to-invoice list, Add hours); with invoice:credit, return a partly credited invoice's hours",
    CA,
  ),
  p("time:write_off", "time", "Mark hours billed elsewhere or not to be invoiced, and undo it — they leave the ready-to-invoice list", CA),
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
 * v3 (2026-08-20): +16 `time` codes (2T; rate:view_cost / rate:manage_cost ✦).
 * v4 (2026-08-31): +1 `work` code (work_item:approve — the 2W-R review gate).
 * v5 (2026-09-21): +1 `portal` code (project:manage_portal — Phase 3
 *     slice 4). Propagation is ADDITIVE, so a tenant whose owner and
 *     manager roles predate this bump GAIN the code and nobody LOSES
 *     `project:edit`; the narrowing below therefore takes effect for
 *     employees the moment this deploys, which is the intent.
 * v6 (2026-09-22): +1 `work` code (work_item:triage_decline — Phase 3
 *     slice 6b). Additive as ever: owners and managers GAIN it, nobody
 *     loses `work_item:triage`, so an employee keeps Accept and Snooze
 *     and loses Decline and Duplicate the moment this deploys — which is
 *     the founder's decision, not a side effect. **A release carrying
 *     this bump MUST run `prisma/seed.ts`**: a catalogue entry reaches
 *     an existing tenant's roles only through B3 propagation, and
 *     without it owners and managers would hold a code the code path
 *     requires and the database has never granted.
 * v7 (2026-10-01): +5 `vault` codes (Phase 3V slice 1 — credential:view,
 *     create, edit, delete, and credential:reveal ✦). Additive; the ✦
 *     code reaches the owner/manager/admin SYSTEM roles only, never a
 *     clone (AUTHZ.md §3.5). The same rule as v6: a release carrying this
 *     bump MUST run `prisma/seed.ts`.
 * v8 (2026-10-02): +1 `core` code (member:reset_two_factor ✦ — slice 84,
 *     founder decision C50). Owner template only; additive. The same rule
 *     as v6: a release carrying this bump MUST run `prisma/seed.ts`.
 * v9 (2026-10-03): +3 `vault` codes (asset:view, asset:manage,
 *     asset:delete — Phase 3V slice 87, the Assets tab). None is ✦, so
 *     clones gain them too; additive. The same rule as v6: a release
 *     carrying this bump MUST run `prisma/seed.ts`.
 * v10 (2026-10-04): +1 `vault` code (credential:share ✦ — Phase 3V
 *     slice 90, share links). C M A; as a ✦ code it reaches the
 *     owner/manager/admin SYSTEM roles only, never a clone (AUTHZ.md
 *     §3.5). The same rule as v6: a release carrying this bump MUST run
 *     `prisma/seed.ts`.
 * v11 (2026-10-05): +1 `vault` code (credential:change_visibility ✦ —
 *     Phase 3V slice 91, the client side of the everyday vault). C A; as
 *     a ✦ code it reaches the owner/admin SYSTEM roles only, never a
 *     clone (AUTHZ.md §3.5). The same rule as v6: a release carrying this
 *     bump MUST run `prisma/seed.ts`.
 * v12 (2026-10-05): +1 `vault` code (credential:unseal ✦ — Phase 3V
 *     slice 92, the sealed layer's staff side). Owner template only;
 *     additive. The same rule as v6: a release carrying this bump MUST run
 *     `prisma/seed.ts`.
 * v13 (2026-10-06): +1 `vault` code (credential:export ✦ — Phase 3V
 *     slice 95, the plaintext export, founder decision C63). Owner
 *     template only; additive. The same rule as v6: a release carrying
 *     this bump MUST run `prisma/seed.ts` — until it runs, nobody can
 *     export.
 * v14 (2026-10-10): +2 codes (invoice:generate_from_time `invoicing`,
 *     time:write_off `time` — Phase 4 slice 110, hours onto invoices,
 *     founder decision C80). C A, neither ✦, so clones gain them too;
 *     additive. The same rule as v6: a release carrying this bump MUST run
 *     `prisma/seed.ts` — until it runs, the database's guards refuse every
 *     hour put on an invoice and every mark (`invoice_member_holds`). */
export const TEMPLATE_VERSION = 14;

export const permissionsForTemplate = (key: TemplateKey): readonly PermissionDef[] =>
  PERMISSIONS.filter((perm) => perm.seeded.includes(key));
