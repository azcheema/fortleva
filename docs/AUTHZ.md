# AUTHZ.md — Roles, Permissions, Entitlements

**Status:** Phase 0 specification. Covers brief §2, §3, §4, and the authorization-relevant parts of §7 and §9. Companion docs: TENANCY.md (row-level isolation this model sits on), DATA_MODEL.md (table definitions for the entities named here), SECURITY.md (auth vendor configuration, MFA mechanics, session design). **Amended 2026-08-16 (work-management plan, decisions 11–13):** three new entitlement modules (`work`, `time`, `vault`), 42 new catalog codes across Phases 2W/2T/3/3V (+4 reserved for Phases 4/6), the first deprecation (`issue:*`), project-axis scoping helpers, an extended ✦ set with a step-up helper, and new portal capabilities. Amendments are marked inline; superseded text is struck, never deleted.

**Design invariants (summary):**

1. Permissions are the atomic unit; roles are named bundles. Business logic never checks a role name (§3).
2. Three principal types — Member, Contact, Platform admin — with three physically separate authorization paths. A portal principal can never enter the member permission machinery, by construction.
3. Deny by default, fail closed, everywhere. Zero assignments ⇒ zero visibility (settled decision #5).
4. Additive-only model: an actor's effective permission set is the union of their roles' grants. There are **no negative/deny permissions** — deny rules would break the subset math that the escalation guards depend on, and are the classic source of "why can't I see this" support tickets.
5. Every gate is one function call, evaluated server-side. UI hiding is cosmetics (§4).
6. No bypass branches. Not for CEOs, not for the platform. Special-case `return true` paths are where escalation bugs live.

---

## 1. Three principals, three code paths (§2, §3)

| Principal | Identity record | Authz entry point | Permission source | Session |
|---|---|---|---|---|
| **Member** (tenant staff) | `User` (global) + `Member` (per tenant) | `authorize(actor, action, resource)` | Tenant-scoped `Role` → `Permission` catalog, plus `MemberClient` / `MemberProject` scoping | Member cookie namespace |
| **Contact** (portal) | `Contact` (per client, per tenant) | `authorizePortal(contact, capability, resource)` | **Hardcoded capability allowlist in code** — no DB-driven permissions, not customizable | Portal cookie namespace, distinct name + audience |
| **Platform admin** | `User` flagged with a platform role | `authorizePlatform(user, action)` | Hardcoded platform action set | Platform cookie namespace, own host from day 1 — `ops.naxdor.com` in v1, separate registered apex from Phase 7 (see ARCHITECTURE.md ARC-11) |

These are three separate functions in three separate modules, not one function with a `type` switch. The point (§2): "a role check must never be the only thing between a portal contact and platform data." Separation is layered:

- **Route groups + middleware**: each plane has its own route group; middleware rejects a session token by cookie name/audience before any handler runs. A portal token on a tenant route is rejected without consulting any table.
- **Type separation**: `authorize()` accepts only a `Member` actor; `authorizePortal()` accepts only a `Contact`. Passing the wrong principal is a compile error, not a runtime policy decision.
- **Data layer**: the portal path additionally sits behind the `visibility = 'CLIENT_VISIBLE'` RESTRICTIVE RLS policy (TENANCY.md; enum values are canonical per DATA_MODEL.md §1.3), so even a bug in `authorizePortal()` cannot surface internal rows.

Contacts never appear in `Role`, `Permission`, `MemberRole`, or any related table. The `Permission` catalog contains no portal codes. This makes "can a portal session reach an internal document" a type-level impossibility rather than a policy hope — the strongest version of the brief's "physically separate" requirement.

## 2. Global identity, tenant-scoped membership (§3)

- **`User`** is the global identity for members: one person, one login, credentials, MFA enrollment. A `User` holds **no permissions** and belongs to no tenant.
- **`Member`** is the join of a `User` and a `Tenant`: per-tenant profile, status (invited / active / suspended), and the anchor for all role and assignment rows. One `User` → many `Member` rows, a different role set in each tenant.
- Every member authorization answers exactly: *does this User, via their Member record in this Tenant, hold permission P — and is the target resource within their scope?* Never "is this user an admin."
- **Contacts have separate identity** (settled decision #6): a `Contact` is both principal and identity — its own table, own credentials/session handling, own cookie namespace, even when the same email exists as a `User`. A person who is a portal contact for clients of two different tenants has two `Contact` logins. Accepted trade-off: no global identity for contacts in v1; cross-tenant contact SSO is **skip** (it would couple tenants through a shared identity, against the isolation grain).
- **Boundary rule** (from the auth research): the auth vendor (Better Auth — see ARCHITECTURE.md/SECURITY.md) owns identity, sessions, and invitation delivery **only**. All membership, roles, permissions, and assignments live in our own Prisma schema. Rationale: vendor org models are weak exactly here — [Clerk allows one role per org membership](https://clerk.com/docs/guides/organizations/control-access/roles-and-permissions), and [Better Auth's own org plugin stores roles as a comma-separated string](https://better-auth.com/docs/plugins/organization) — and authorization must stay vendor-independent. Invite-only for both members and contacts is enforced in our code, not assumed from the vendor.

## 3. The permission catalog (§3)

### 3.1 Catalog rules

- A `Permission` is a row in a **global, seeded table** (no `tenantId`): `code`, `module`, `description`, `requiresMfa`. Seeded by migration; append-only in practice.
- Codes follow **`resource:verb`** (the brief's own style: `invoice:create`, `client:delete`, `continuity_box:edit`). Codes are **immutable identifiers, forever**. Renaming one means migrating `RolePermission` rows across every tenant plus every call site — so we never rename; we deprecate and add.
- Every code carries a `module` linking it to the entitlement system (§4 of the brief): `core` (never toggleable) or one of `invoicing`, `contracts`, `reports`, `issues`, `documentation`, `continuity_box`, `portal`. This makes gate composition mechanical (see §6): resolve the permission → its module → run the module gates automatically. **Amended 2026-08-16 (work-management plan):** the module set gains exactly three keys — **`work`**, **`time`**, **`vault`** — and `issues` becomes a *deprecated alias* (see §5). Notifications and search are **`core`** (never entitlement-gated; channels are toggled by preference). `project_update:*` codes ride on `work`; `project:manage_portal` sits under `portal`. No other module keys are added (no `intake`, `budgets`, `assets` — nobody will sell those separately, and each key costs a folder, a preference and a gate).
- Mirrored as a TypeScript union type in one module so call sites are compile-checked; the seed migration and the type are generated from a single source list.
- `authorize()` **fails closed on unknown codes**: deny + alert (it's a config error, not a user error).

**The first deprecation — `issue:*` *(added 2026-08-16 — work-management plan)*.** The `Issue` entity is absorbed: a client request is a `WorkItem(kind = REQUEST)` (Phase 2W schema, Phase 3 portal intake) and `IssueComment` becomes the polymorphic `Comment`. The five codes `issue:view`, `issue:create`, `issue:edit`, `issue:comment`, `issue:delete` are therefore dead — and per the immutability rule above they are **not deleted and not renamed**. Concretely:

- The rows stay in the global `Permission` table forever; their `description` is prefixed **"Deprecated (2026-08-16): absorbed by `work_item:*` / `comment:*`"**. The TypeScript union keeps them (marked `@deprecated` so a call site fails lint, not compile). No call site references them after 2W.
- They are **unseeded at `TEMPLATE_VERSION` 2** (§3.3): new tenants never receive them. Existing tenants (Naxdor is already provisioned with `RolePermission` rows for them at `TEMPLATE_VERSION` 1) keep those rows — B3 propagation is **additive-only** and never revokes, and a dangling grant to a code no gate checks is harmless. A cleanup migration that deletes deprecated `RolePermission` rows is allowed only once no template of any version seeds the code and no call site exists; it is not scheduled.
- The `issues` entitlement key follows the same rule at the entitlement layer (§5): kept in the schema, resolves to `work`.
- Why bother: the rule "codes are forever, deprecate and add" exists precisely so future sessions do not argue this case. Deleting five rows would be cheap today and would set the precedent that immutability bends when convenient.

### 3.2 Draft catalog v1

Seeding column: **C** = CEO (owner-equivalent), **M** = Manager, **A** = Admin, **E** = Employee. This matrix is the *default template seed* — tenants customize clones (§3.3). Scope column: "scoped" = filtered by client/project assignment (§5) unless the actor holds `client:view_all`.

| Code | Module | Grants | Seeded | Scope | Phase |
|---|---|---|---|---|---|
| `client:view` | core | View client records | C M A E | scoped | v1 |
| `client:view_all` | core | **Scope override**: see every client in the tenant (decision #5) | C M A | — | v1 |
| `client:create` | core | Create clients | C M A | — | v1 |
| `client:edit` | core | Edit client details, internal notes | C M A | scoped | v1 |
| `client:delete` | core | Delete/archive a client | C | scoped | v1 |
| `client:manage_assignments` | core | Assign/unassign members to clients (`MemberClient`) | C M A | scoped | v1 |
| `client:manage_contacts` | portal | Invite, deactivate portal contacts; set contact profile | C M A | scoped | v1 |
| `project:view` | core | View projects, timeline, versions | C M A E | scoped | v1 |
| `project:create` | core | Create projects | C M | scoped | v1 |
| `project:edit` | core | Edit project fields, environments, links | C M E | scoped | v1 |
| `project:delete` | core | Delete/archive a project | C M | scoped | v1 |
| `project:manage_versions` | core | Publish `ProjectVersion` + release notes, manage `Milestone`s | C M E | scoped | v1 |
| `project:manage_assignments` | core | Assign members to projects (`MemberProject`) | C M | scoped | v1 |
| `service:view` | core | View services/products | C M A E | scoped | v1 |
| `service:create` | core | Create services | C M A | — | v1 |
| `service:edit` | core | Edit services, renewal dates | C M A | scoped | v1 |
| `service:delete` | core | Delete services | C M | scoped | v1 |
| `contract:view` | contracts | View contracts | C M A | scoped | v1 |
| `contract:create` | contracts | Draft/upload contracts | C M A | scoped | v1 |
| `contract:edit` | contracts | Edit **draft** contracts (sent/signed are immutable) | C M A | scoped | v1 |
| `contract:send` | contracts | Send for signature (client-facing act) | C M A | scoped | v1 |
| `contract:delete` | contracts | Delete **draft** contracts only | C M | scoped | v1 |
| `invoice:view` | invoicing | View invoices | C M A | scoped | v1 |
| `invoice:create` | invoicing | Create **draft** invoices (unnumbered) | C M A | scoped | v1 |
| `invoice:edit` | invoicing | Edit draft invoices | C M A | scoped | v1 |
| `invoice:issue` | invoicing | Issue: allocate gap-free number from `InvoiceSeries` — irreversible (§10.2) | C A | scoped | v1 |
| `invoice:send` | invoicing | Send an issued invoice | C A | scoped | v1 |
| `invoice:record_payment` | invoicing | Register payment / mark paid | C A | scoped | v1 |
| `invoice:credit` | invoicing | Issue a credit note (never delete issued invoices) | C A | scoped | v1 |
| `invoice:delete` | invoicing | Delete **draft** invoices only | C A | scoped | v1 |
| `invoice:manage_series` | invoicing | Configure `InvoiceSeries` (legal numbering config) ✦ | C | — | v1 |
| `document:view` | documentation | View documents/files (internal + client-visible) | C M A E | scoped | v1 |
| `document:upload` | documentation | Upload files, create `Document`/`FileVersion` | C M A E | scoped | v1 |
| `document:edit` | documentation | Rename, move, tag, upload new version | C M A E | scoped | v1 |
| `document:delete` | documentation | Delete documents | C M A | scoped | v1 |
| `document:change_visibility` | documentation | Flip `internal` ↔ `client_visible` — audited, the §5 worst-bug surface | C M A | scoped | v1 |
| `issue:view` | issues *(deprecated)* | ~~View issues~~ **Deprecated 2026-08-16** → `work_item:view` | ~~C M A E~~ unseeded at TV2 | scoped | ~~v1~~ deprecated |
| `issue:create` | issues *(deprecated)* | ~~Create issues (also on behalf of a contact)~~ **Deprecated 2026-08-16** → `work_item:create` (`kind = REQUEST`) | ~~C M A E~~ unseeded at TV2 | scoped | ~~v1~~ deprecated |
| `issue:edit` | issues *(deprecated)* | ~~Triage: type, priority, status, assignee, link to release~~ **Deprecated 2026-08-16** → `work_item:edit` + `work_item:triage` | ~~C M E~~ unseeded at TV2 | scoped | ~~v1~~ deprecated |
| `issue:comment` | issues *(deprecated)* | ~~Comment on issues~~ **Deprecated 2026-08-16** → `comment:create` | ~~C M A E~~ unseeded at TV2 | scoped | ~~v1~~ deprecated |
| `issue:delete` | issues *(deprecated)* | ~~Delete issues~~ **Deprecated 2026-08-16** → `work_item:delete` | ~~C M~~ unseeded at TV2 | scoped | ~~v1~~ deprecated |
| `report:view` | reports | View performance reports / CrUX charts | C M A E | scoped | v1 (CrUX, Phase 6) |
| `report:upload` | reports | Upload report data files | C M A | scoped | v2 |
| `report:delete` | reports | Delete reports | C M | scoped | v2 |
| `continuity_box:view` | continuity_box | See box status, reseal dates, open requests ✦ | C M A | scoped | v1 (Phase 8) |
| `continuity_box:edit` | continuity_box | Author, update, reseal box contents ✦ | C | scoped | v1 (Phase 8) |
| `continuity_box:configure` | continuity_box | Trigger conditions, veto window, trustee, fallback contact ✦ | C | scoped | v1 (Phase 8) |
| `continuity_box:veto` | continuity_box | Respond to a `ContinuityOpenRequest` (veto/approve) ✦ | C M A | scoped | v1 (Phase 8) |
| `role:view` | core | List roles and their permission sets | C M A | — | v1 |
| `role:create` | core | Clone a template / create a custom role | C A | — | v1 |
| `role:edit` | core | Grant/revoke permissions on non-system roles ✦ (subset-guarded, §7) | C A | — | v1 |
| `role:delete` | core | Delete non-system, unassigned roles | C A | — | v1 |
| `member:view` | core | See the member list | C M A E | — | v1 |
| `member:invite` | core | Invite members | C A | — | v1 |
| `member:remove` | core | Remove/suspend members (last-owner-guarded) | C A | — | v1 |
| `member:manage_roles` | core | Assign/revoke roles (`MemberRole`) ✦ (escalation-guarded) | C A | — | v1 |
| `billing:view` | core | See plan, platform invoices, usage vs limits | C A | — | v1 (Phase 7) |
| `billing:manage` | core | Change plan, payment method, cancel ✦ | C | — | v1 (Phase 7) |
| `settings:view` | core | View tenant settings | C M A | — | v1 |
| `settings:edit` | core | Edit tenant profile, branding, locale | C A | — | v1 |
| `settings:manage_modules` | core | Toggle `TenantPreference` module switches ✦ | C | — | v1 |
| `audit:view` | core | View the tenant's own audit log | C A | — | v1 |
| `tenant:export` | core | Full tenant data export ✦ | C | — | v1 (Phase 8 for scheduled; ad-hoc earlier) |

✦ = `requiresMfa` (see §7.5). **63 codes** *(erratum fixed 2026-08-08: prose previously said 64; the table above is normative and has always held 63 rows — verified mechanically at implementation time, and the CI catalog test asserts 63 — **at TEMPLATE_VERSION 1; from 2W the count grows per phase, see the running-count paragraph below**)*. `audit:view` and `tenant:export` sit outside the brief's enumerated module list but are required by §9 (tenant-facing audit log, export paths); they are `core`.

**Amended 2026-08-16 (work-management plan) — running catalog count.** The v1 table above stays at 63 rows (the five deprecated `issue:*` rows are still rows). New codes are appended per phase in §3.2.1 below, and `src/authz/catalog.test.ts` pins the count and is **bumped deliberately in the same commit as the codes** — the bump is the reviewable event, never an incidental fixture change: **63 → 80** (Phase 2W, module `work`, +17) **→ 93** (Phase 2T, `time`, +13) **→ 94** (Phase 3, `portal`, +1) **→ 105** (Phase 3V, `vault`, +11) **→ 108** (Phase 4, +3) **→ 109** (Phase 6, +1). The ✦ set is pinned by the same test (§7.5).

Notes on shape:

- **Draft vs issued is encoded in the verbs.** `invoice:edit`/`invoice:delete` apply to drafts only; `invoice:issue` is a separate, irreversible, legally significant permission (gap-free numbering, §10.2 — detail in DATA_MODEL.md). Same pattern for contracts (`contract:send` freezes).
- **No `project:view_all`.** Client scope subsumes project scope: assignment to a client covers all its projects (§5). One override code (`client:view_all`) keeps the scoping model explainable in one sentence.
- **v1 performance reports** are simply client-visible `Document`s (settled decision #7) — the `document:*` codes govern them; `report:*` codes are reserved now (codes are forever), UI lands Phase 6/v2.

#### 3.2.1 Catalog additions 2026-08-16 (Phases 2W · 2T · 3 · 3V · 4 · 6)

Same columns and seeding legend as the v1 table. "Scoped" now means filtered by the **two-axis** scope of §4 (client *or* project assignment) unless `client:view_all` is held. `work_item:edit` is additionally **scope-checked per call** (`assertInScope` on the item's project — an employee on project P1 cannot edit P2's items even when both belong to the same client, unless assigned to the client). Codes land in the catalog in the phase named; a later UI phase never adds codes retroactively.

| Code | Module | Grants | Seeded | Scope | Phase |
|---|---|---|---|---|---|
| `work_item:view` | work | View Tasks/Epics/Subtasks incl. activity, labels, collaborators, subtree | C M A E | scoped | 2W |
| `work_item:create` | work | Create work items of any `kind` (portal `REQUEST` intake is brokered, §8) | C M A E | scoped | 2W |
| `work_item:edit` | work | Edit fields, state, rank, assignee, parent, milestone, archive/restore — **scope-checked** | C M A E | scoped | 2W |
| `work_item:delete` | work | Hard-delete work items (subtree) | C M | scoped | 2W |
| `work_item:change_visibility` | work | Flip `INTERNAL` ↔ `CLIENT_VISIBLE` incl. bulk "make private with N children" — audited, the worst-bug surface | C M A | scoped | 2W |
| `work_item:triage` | work | Accept / Decline / Duplicate / Snooze a `REQUEST` out of `TRIAGE` | C M E | scoped | 2W |
| `workflow:manage` | work | Edit a project's `WorkflowState`s and tenant `WorkflowPreset`s (category immutable) | C M A | scoped (states) / — (presets) | 2W |
| `label:manage` | work | Create/rename/delete tenant labels | C M A | — | 2W |
| `comment:create` | work | Comment on any commentable subject; edit/delete **own** comments | C M A E | scoped | 2W |
| `comment:edit_any` | work | Edit other members' comments | C M | scoped | 2W |
| `comment:delete` | work | Delete comments (any author) | C M | scoped | 2W |
| `comment:change_visibility` | work | Flip comment visibility (child ≤ parent rule) — audited | C M A | scoped | 2W |
| `project_update:view` | work | View `ProjectUpdate`s incl. drafts and the internal snapshot | C M A E | scoped | 2W (UI Phase 3) |
| `project_update:create` | work | Draft and edit unpublished updates | C M E | scoped | 2W (UI Phase 3) |
| `project_update:publish` | work | Publish (freezes `seq` + snapshots), archive | C M | scoped | 2W (UI Phase 3) |
| `project_update:change_visibility` | work | Flip update visibility — audited | C M A | scoped | 2W (UI Phase 3) |
| `project_template:manage` | work | Create/edit/delete `ProjectTemplate`s, "save project as template" | C M A | — | 2W |
| `time:track` | time | Start/stop own timer; create/edit/delete/split **own unlocked** entries | C M A E | scoped | 2T |
| `time:view_team` | time | See other members' entries and totals within scope (`/time/team`, per-member project tables) | C M | scoped | 2T |
| `time:edit_any` | time | Edit other members' unlocked entries | C M | scoped | 2T |
| `time:delete_any` | time | Delete other members' unlocked entries | C M | scoped | 2T |
| `time:manage_locks` | time | Set lock date; lock/unlock entries (`app.time_lock_bypass`, always audited) | C A | scoped | 2T |
| `time:reprice` | time | Run the reprice command (`FROM_DATE` or `ALL_UNBILLED`) on unlocked entries — audited | C A | scoped | 2T |
| `time:export` | time | CSV export of entries/rollups — cost columns never by default | C M A | scoped | 2T |
| `rate:view_bill` | time | See BILL rate cards, `billRate` snapshots and billable amounts | C M | scoped | 2T |
| `rate:manage_bill` | time | Create/close BILL `RateCard` rows (immutable rows; close + insert) | C A | scoped (project cards) / — (tenant, member cards) | 2T |
| `rate:view_cost` | time | Decrypt COST cards; margin/profit views ✦ (step-up) | C | — | 2T |
| `rate:manage_cost` | time | Create/close COST `RateCard` rows ✦ (step-up) | C | — | 2T |
| `budget:view` | time | See `ProjectBudget` and burn | C M | scoped | 2T |
| `budget:manage` | time | Create/edit budgets, thresholds, notify list | C M A | scoped | 2T |
| `project:manage_portal` | portal | `Project.portalEnabled`, `hoursSharingMode`, task-list/kanban toggles, "View as client" — audited | C M | scoped | 3 |
| `credential:view` | vault | List/detail `CredentialItem` metadata (masked; ciphertext never selected) | C M A E | scoped | 3V |
| `credential:create` | vault | Create credential items (incl. secret) | C M A E | scoped | 3V |
| `credential:edit` | vault | Edit metadata, rotate secret (new `CredentialVersion`) | C M A | scoped | 3V |
| `credential:delete` | vault | Delete credential items | C M | scoped | 3V |
| `credential:reveal` | vault | Reveal / Copy / TOTP **one field** per call — step-up + reveal budget, audited per call ✦ (decision 13: **CMA, not E**) | C M A | scoped | 3V |
| `credential:share` | vault | Create/revoke `CredentialShareLink`s ✦ (always step-up) | C M A | scoped | 3V |
| `credential:export` | vault | Plaintext export of credentials ✦ (always step-up) | C | scoped | 3V |
| `credential:change_visibility` | vault | Flip credential visibility ✦ (always step-up; portal-persistent credentials also need `vault.allowPortalCredentials`) | C A | scoped | 3V |
| `asset:view` | vault | View `ClientAsset` registry and expirations feed | C M A E | scoped | 3V |
| `asset:manage` | vault | Create/edit assets, renewal data | C M A | scoped | 3V |
| `asset:delete` | vault | Delete assets | C M | scoped | 3V |
| `invoice:generate_from_time` | invoicing | Turn the uninvoiced-time queue into invoice draft lines (sets `lockedReason = INVOICE_DRAFT`) | C A | scoped | 4 (reserved now) |
| `time:write_off` | time | Write off / mark billed externally (`lockedReason = WRITTEN_OFF` or `BILLED_EXTERNAL`) | C A | scoped | 4 (reserved now) |
| `retainer:manage` | invoicing | `RetainerPlan` / periods / hour-bank adjustments | C M | scoped | 4 (reserved now) |
| `report:view_portfolio` | reports | Staff "Project health" portfolio table across scope | C M | scoped | 6 (reserved now) |

Notes on shape *(added 2026-08-16)*:

- **Employee (E) is deliberately narrow:** create/edit/track/comment/submit credentials, no delete, no visibility flips, no workflow/labels, no team time, no rates, no reveal. Every "any"/"team"/visibility verb starts at Manager. This is the seeding matrix; tenants widen clones deliberately (§3.3).
- **Money is a ladder:** hours (E) → bill rates + budgets (M) → cost + margin (C, ✦). `time:export` at CMA never includes cost columns unless the caller also holds `rate:view_cost` and passes an explicit flag; cost never appears in `AuditEvent` metadata or any portal-reachable row.
- **`credential:reveal` at CMA (decision 13):** seeding it on E would make the `vault` entitlement silently force MFA enrolment on every employee (§7.5). Tenants that want employees revealing grant it to a clone — which forces enrolment for exactly those holders. The alternative (seed CMAE, accept all-employee MFA) is the CP4 fallback if Naxdor prefers it.
- **Phase 4/6 codes are reserved, not built:** listed so the count sequence is fixed and the codes are never renamed later; they enter the catalog (and the count) in their own phase's commit.

### 3.3 System role templates and clone-and-customize (§3)

Templates ship as the platform's definition; at tenant creation each template is instantiated as a `Role` row in that tenant with `isSystem = true` and a `templateKey` (`owner`, `manager`, `admin`, `employee`). Semantics:

- **System roles are read-only and undeletable.** A tenant cannot edit or delete a system role — this is how "cannot de-fang the role that owns billing and user management" is enforced structurally, not by an allowlist of "critical" permissions someone forgets to maintain.
- **Customization = clone.** `role:create` clones any role (system or custom) into an editable custom role (`isSystem = false`, `clonedFromKey` recorded). Tenants then grant/revoke individual permissions on the clone via `role:edit`, subject to the escalation guards (§7).
- **Owner-equivalence is the `templateKey = 'owner'` system role**, not a permission pattern. A clone of it is just a custom role; the last-owner invariant (§7.3) pins to the system row. The CEO template is seeded with **all ~~63~~ codes** *(amended 2026-08-16: all non-deprecated codes of the current `TEMPLATE_VERSION` — 63 at TV1, 75 at TV2 (80 minus the five deprecated `issue:*`), growing per phase)* — fully, deliberately, so that no code path ever needs an owner bypass (§7.4).
- **Role-explosion guard**: bounded customization, not a blank canvas — a per-tenant cap on custom roles (proposed: an entitlement limit, `maxCustomRoles`, e.g. 5 / 15 / 30 by tier). Templates should carry 90% of tenants with zero customization.
- **Multiple holders of any role** including owner: `MemberRole` is many-to-many from day one (§3.4).

**Portal contact roles are templates of a different kind** — fixed capability profiles, not clonable (see §8 and the Pushback note in §11).

**`TEMPLATE_VERSION` 2 semantics *(added 2026-08-16 — work-management plan)*.** Templates are versioned as one integer (`src/authz/catalog.ts` `TEMPLATE_VERSION`, currently 1); a bump is a platform migration of the four system roles under the B3 rule (§3.5, decided): **additions propagate, removals never do**. TV2 ships with Phase 2W and is defined as:

- **Seed matrix** = the v1 table (§3.2) **minus** the five deprecated `issue:*` rows **plus** the §3.2.1 rows for the phase being shipped (2W adds the `work` block; 2T, 3, 3V, 4, 6 each bump the version again — TV3, TV4… — so "TV *n*" always means "the matrix as of that phase's commit"). A single `TEMPLATE_VERSION` integer, not per-module versions: one number to compare, one propagation pass.
- **Propagation to existing tenants** (Naxdor first): for each system role, grant every new non-✦ code the matrix seeds on it; for each derived clone, grant the same additions unless the tenant explicitly revoked that code on the clone (tracked diff); each grant is an `AuditEvent` `role.permission_granted` with actor SYSTEM and `metadata.templateVersion`; `Tenant.permissionsVersion` bumps once per tenant per pass. ✦ codes are propagated **only to system roles** (§3.5 rule stands) — so `credential:reveal`, `credential:share`, `rate:view_cost` etc. appear on the owner/manager/admin system rows exactly as seeded and on no clone automatically.
- **Deprecated codes** stay wherever they already are (no removal — additive-only), are absent from every new tenant's seed, and are excluded from the "CEO holds everything" invariant, which is now stated as *CEO system role ⊇ all non-deprecated codes* (asserted by the catalog test per phase).
- **Template descriptions** are part of the versioned definition. TV2 updates the **employee** description to: *"Works assigned projects: tasks, time, documents; no invoicing/contracts/admin/reveal."* (TV1, `catalog.ts`: ~~"Works assigned clients: projects, documents, issues. No invoicing, no contracts, no admin."~~ — "issues" is gone, "tasks, time" and "no reveal" arrive.) Manager (TV1 *"Delivery lead: full client/project/service/contract work; no money-final acts, no member/role admin."*) gains *"…visibility, triage, team time, bill rates, budgets, portal control, publish, vault reveal/share; no cost"*; Admin (TV1 *"Back office: full invoice lifecycle, member and role management, settings, audit log."*) gains *"…workflow/labels/templates, time locks and rates; no cost"*; Owner unchanged. Descriptions become i18n keys (sv/en) when next-intl lands in 1b.
- **Cadence rule:** the version bumps in the same commit as the codes it seeds and the `catalog.test.ts` count (§3.2) — three things move together or not at all.

### 3.4 `MemberRole` — many-to-many, union semantics

- A `Member` holds any number of roles; a role is held by any number of members. `MemberRole(memberId, roleId)` with uniqueness on the pair; role is never a column on the member row.
- **Effective permission set = union** of all held roles' `RolePermission` grants. Additive-only (invariant #4): revoking a permission from one role does not mask a grant from another role. Predictable, and it keeps subset comparisons (§7.1) well-defined.

### 3.5 Template drift — open question, recommendation attached

When the platform adds a permission to a template (a new module ships, e.g. `continuity_box:configure` arriving in Phase 8), what happens to tenants' existing roles?

**Option A — frozen clones.** System roles are updated by platform migration; custom clones never change. Tenants opt in by re-cloning or manually granting.
- *Pros:* zero surprise; a tenant's deliberate trims are never overridden; simplest to implement.
- *Cons:* clones rot silently. A tenant whose CEO uses a cloned owner-ish role finds every new feature missing for them; support burden lands on the platform. The [industry pattern](https://workos.com/blog/how-to-design-multi-tenant-rbac-saas) ("global defaults with tenant-level diffs") exists precisely because frozen clones age badly.

**Option B — tracked diffs.** A clone stores its `templateKey` base plus an explicit diff (grants added, grants removed by the tenant). Template updates flow through to derived roles; tenant-authored diff entries always win.
- *Pros:* templates stay alive; tenants keep their intent; new modules "just appear" for appropriately-roled members.
- *Cons:* more moving parts; an *automatic grant* is itself a privilege change the tenant didn't perform — it must be additive-only, audited, and visible.

**Recommendation: tracked-diff-additive.** Propagate **additions only** (never removals) from a template to its derived roles, skip any code the tenant has explicitly revoked on that clone, record every propagated grant as an `AuditEvent` (`role.permission_granted`, actor = SYSTEM, metadata notes the template version), and surface a "role updated by platform" notice in tenant settings. Additionally: permissions flagged `requiresMfa` (the ✦ set — billing, roles, continuity, export) are **never auto-propagated to custom clones**; they appear only on system roles, and tenants grant them to custom roles deliberately. Retrofitting diff-tracking later is painful (the research flags this as the hidden product problem), so the `Role` table carries `templateKey` + diff structure from Phase 1 even if propagation logic ships later.

**Flagged as an open question** (OPEN_QUESTIONS.md, blocks Phase 1 — it shapes the `Role`/`RolePermission` schema).

## 4. Resource scoping — the harder half (§3)

Roles answer *what* a member may do; assignments answer *on which clients*. Settled decision #5 fixes the semantics:

- **Deny-default.** A member with zero `MemberClient` / `MemberProject` rows sees **nothing** in scoped modules, whatever their role says. Fail closed.
- **`client:view_all` is the only override**, seeded on CEO / Manager / Admin templates only. Employees see exactly their assignments.
- **Scope resolution:**
  - `MemberClient(memberId, clientId)` ⇒ scope over that client **and all its projects** (and their contracts, invoices, documents, ~~issues~~ work items, time, updates, credentials, reports, box).
  - `MemberProject(memberId, projectId)` ⇒ scope over that single project and its child records, plus read of the parent client's card (name, contacts — not its other projects, not its other invoices). The freelancer case: brought in for one project, sees one project.
  - Effective scope = union of both, or everything if `client:view_all` is held.
- **Permission ∧ scope.** `authorize()` requires both: `invoice:view` without assignment to client X ⇒ cannot see X's invoices; assignment to X without `invoice:view` ⇒ still cannot. Role and relationship are independent axes, exactly as the brief demands.

**List queries** must never post-filter. The second entry point of the seam:

```
authorizedResourceIds(actor, 'client')  →  { kind: 'all' } | { kind: 'ids', ids: clientId[] }
```

- Resolution: one indexed query over `MemberClient` (+ project→client lift from `MemberProject`), short-circuited to `all` when `client:view_all` is held.
- The result is pushed into the Prisma `where` clause — `where: { tenantId, clientId: { in: ids } }` — composed *inside* the tenant-scoped client (TENANCY.md), so a developer never hand-writes the filter. At tens of clients per tenant an `IN` list is trivially fast; if a tenant ever has thousands, the same function swaps to an `EXISTS` subquery against the assignment table without touching call sites.
- **Existence must not leak across the client↔client boundary**: an out-of-scope resource returns **404, not 403**. 403 is reserved for "you can see it exists but may not do that to it."

Single-resource checks run the same logic in the documented order (per the [WorkOS multi-tenant RBAC guidance](https://workos.com/blog/how-to-design-multi-tenant-rbac-saas), extended with scope): resource belongs to tenant → actor is an active member of tenant → permission held → resource within scope. Tenant boundary is enforced twice — structurally by the scoped Prisma client + RLS, and again here.

**Amended 2026-08-16 (work-management plan) — the project axis becomes explicit (Phase 2).** The client-only `authorizedResourceIds(actor, 'client')` above was sufficient while every scoped table hung off `clientId`. Work items, comments, time entries, updates and credentials are *project*-scoped rows whose `clientId` is denormalised — and a `MemberProject(P1)` freelancer must see P1's rows and **none** of the same client's P2 rows, which a client-id filter alone cannot express. The seam therefore gets three functions, all landing in Phase 2 before any 2W table exists:

```
authorizedResourceIds(actor, 'client')   →  { kind: 'all' } | { kind: 'ids', ids: clientId[] }
authorizedResourceIds(actor, 'project')  →  { kind: 'all' } | { kind: 'ids', ids: projectId[] }
assertInScope(tx, actor, { clientId } | { projectId })  →  void | throws NOT_FOUND
scopeWhere(actor)                        →  Prisma where-fragment composing both axes
```

- **`'client'` axis** — as before: `MemberClient` rows **plus the project→client lift** from `MemberProject`, `all` under `client:view_all`. The lift is what makes the parent client's *card* visible on `/clients` — it is used for reads of the `Client` table itself and for nothing else. Internally the resolver returns `{ directClientIds, liftedClientIds, projectIds }` in one query, memoised per request.
- **`'project'` axis** — `MemberProject` rows **plus** every project of every *directly* assigned client (client assignment subsumes its projects, as before), `all` under `client:view_all`.
- **`scopeWhere(actor)`** — for a project-scoped table (anything with a `projectId` column — projects, milestones, versions, services, work items, comments, updates, time entries, budgets, project-attached documents and credentials): `{ OR: [ { clientId: { in: directClientIds } }, { projectId: { in: projectIds } } ] }` (`{}` under `all`) — **the lifted client ids are deliberately absent**, which is precisely what keeps P2 invisible to a P1-only member; for a client-scoped table without `projectId` (client-level documents, assets, credentials): `{ clientId: { in: directClientIds } }`; for `Client`: `{ id: { in: directClientIds ∪ liftedClientIds } }`. Composed *inside* the tenant-scoped client for every list `where` — a list without `scopeWhere` fails the lint rule that already bans hand-written scope filters.
- **`assertInScope(tx, actor, ref)`** — the single-resource twin: resolves the target's `clientId`/`projectId` inside the transaction (`SELECT … FOR UPDATE` where a mutation follows) and throws **`NOT_FOUND`** when out of scope — never 403, per the existence rule above. Every module service calls it after `requireAccess` and before mutating (the recipe: `withTenant(tenantId, principal, tx => { requireAccess; assertInScope; …mutate…; record; notify.emit })`). Scope-checked codes (`work_item:edit`, and every write on a project-scoped row) mean exactly "passes `assertInScope` on the row's project".
- **Cross-project moves** (re-parenting an item, moving an entry) call `assertInScope` on **both** source and destination.

**Deny-matrix example** (asserted in the Phase 2 scoping tests and regenerated per phase): client Acme has projects P1, P2. Employee E1 has `MemberProject(P1)` only; Manager M1 has `MemberClient(Acme)`; Employee E2 has no assignments.

| Actor | `/projects/P1/board` | `/projects/P2/board` | Acme card | Acme's other projects list | Acme's `Client.internalNotes` |
|---|---|---|---|---|---|
| E1 (`MemberProject P1`) | rows of P1 only | **404** | name + contacts | empty | never (projection) |
| M1 (`MemberClient Acme`) | all | all | full card | P1, P2 | with `client:edit` |
| E2 (no assignments) | **404** | **404** | **404** | — | — |
| anyone with `client:view_all` | all | all | full | all | per permission |

Search, notifications and the ⌘K palette use the same `scopeWhere` — a search hit or an inbox row for a P2 item never reaches E1.

## 5. The four gates (§4)

Four different questions, four records, four single-purpose functions — never conflated:

| # | Gate | Question | Owner | Storage | Function |
|---|---|---|---|---|---|
| 1 | **Feature flag** | "Is this feature switched off by engineering right now?" | Engineering; temporary, deleted after rollout, **never monetization** | `FeatureFlag` (global default + per-tenant override rows) | `flagEnabled(key, tenantId)` |
| 2 | **Entitlement** | "Does this tenant's plan include the module?" | Billing/platform; commercial | Versioned `entitlements` JSON column on `Tenant` | `entitled(tenant, module)` |
| 3 | **Tenant preference** | "Has the tenant chosen to switch it off?" (entitled but disabled — the Fortnox case) | Tenant (`settings:manage_modules`) | `TenantPreference` rows | `preferenceEnabled(tenant, module)` |
| 4 | **Permission / capability** | "May this principal perform this action, on this resource?" | Tenant role config / hardcoded portal profile | `Role`→`RolePermission`→`Permission` + assignments | `authorize(...)` / `authorizePortal(...)` |

**Evaluation order: 1 → 2 → 3 → 4.** All gates are AND-ed, so ordering does not change the outcome — it fixes three things: the kill-switch dominates during an incident regardless of commercial state; the **denial reason** is deterministic for UX (`FEATURE_DISABLED` → "temporarily unavailable"; `NOT_ENTITLED` → upgrade prompt; `DISABLED_BY_TENANT` → "an admin can enable this in settings"; `FORBIDDEN` → 403; `NOT_FOUND` → out-of-scope, §4; **`MFA_REQUIRED`** → step-up prompt, *added 2026-08-16*, §7.5); and the cheapest checks run first. *Note:* the brief (§4) lists "entitlement → preference → permission" and names flags as a fourth, orthogonal gate; the settled refinement is to evaluate the kill-switch first — a rollback switch that only works for unentitled tenants is not a kill-switch.

**Composition.** Call sites use one composite: `requireAccess(ctx, permissionCode, resource?)`. It resolves the code → its `module`, runs gates 1–3 for that module (`core` modules skip 2–3 — always on), then gate 4. One call, all server-side; the UI reads the same resolved gate state to hide affordances, as cosmetics only.

**Entitlements shape** (per the billing research — [Stripe's Entitlements API is boolean-only and Stripe itself recommends persisting locally](https://docs.stripe.com/billing/entitlements), so the source of truth is our own record): the `Tenant.entitlements` JSON is versioned — `{ schemaVersion, planCode, source: 'stripe' | 'manual_override', modules: { invoicing, contracts, reports, issues, documentation, continuity_box, portal }, limits: { maxMembers, maxClients, maxStorageBytes, maxCustomRoles }, addons: { bankidSigning } }` — written by the Stripe webhook resolver (Phase 7) or platform override (§7 of the brief: trials, overrides), read per-request (~1 ms at this scale). The seven `modules` keys are exactly the `Permission.module` values (§3.1) and ARCHITECTURE.md §3's folder map, spelled identically — `reports`, `continuity_box` — because gate composition is a literal lookup. **BankID signing is an `addons` key, not an eighth module**: it meters a capability *inside* `contracts` (v1.5, pooled broker), and adding it as a module would break the module↔folder 1:1 rule. Never `if (plan === 'pro')` in business logic; never entitlements baked into long-lived sessions (revocation lag on cancel/downgrade).

**Amended 2026-08-16 (work-management plan) — `schemaVersion` 2, three new modules, one deprecated alias.** The module set becomes **ten keys**: `{ invoicing, contracts, reports, issues, documentation, continuity_box, portal, work, time, vault }` — ~~"The seven `modules` keys"~~ is superseded, the 1:1 rule (entitlement key = `Permission.module` = `src/modules/<key>` folder = `module.<key>.enabled` preference) is not. Rules:

- **`work`** — work items, workflow, labels, comments, templates, **and `ProjectUpdate`** (`project_update:*` ride on `work`; there is no separate `updates` key — an agency that has tasks has status updates). Phase 7 sells it on every tier.
- **`time`** — timer, entries, rates, budgets, rollups, `ProjectTimeSummary`. Mid-tier and up. Import direction `time → work → core`: `time` may depend on `work` being entitled (an entry may reference a work item), never the reverse.
- **`vault`** — credentials, share links, assets, expirations. Top tier (with the continuity box). `vault → core` only.
- **`issues`** — **deprecated alias of `work`** (first deprecation, §3.1). The zod schema keeps the key so v1 documents parse; `entitled(tenant, 'issues')` resolves to `modules.work`; the resolver never *writes* `issues` at v2. No `Permission.module` value is `issues` after 2W except the five deprecated rows, and no folder `src/modules/issues` ever exists.
- **Not modules:** notifications, search, jobs/outbox, `TenantKey`/crypto, request context — all `core`, always on, never gated by entitlement (a tenant on the smallest plan still gets assignment emails and ⌘K). Channels are toggled by preference (`notify.email.enabled`, digests in Phase 5), never by entitlement.
- **`schemaVersion` 2 + upgrade path:** `entitlementsSchema` becomes a discriminated union on `schemaVersion` (`z.literal(1)` | `z.literal(2)`); a v1 document is upgraded in memory on read — `work = true`, `time = true`, `vault = true` (defaults **on**: every existing tenant is Naxdor or a manual override; Phase 7's Stripe resolver writes explicit values), `issues` dropped from the written form but readable — and persisted as v2 the next time the platform writes the row. No migration touches `Tenant.entitlements` rows in bulk; the reader is tolerant, the writer is strict. `configure_entitlements` (platform plane) writes v2 only.
- **`addons`** unchanged (`bankidSigning`); `limits` unchanged (`maxCustomRoles` still the only role-related limit; no per-module limits at v1).

**TenantPreference keys per module** *(added 2026-08-16; `module.<key>.enabled` is gate 3 for every module; the rest are behaviour, read through the same `preferences` seam and audited as `preference.changed`)*:

| Module | Keys (default) |
|---|---|
| `work` | `module.work.enabled` (on) · `work.defaultPreset` (the seeded preset) |
| `time` | `module.time.enabled` (on) · `time.autoStopHours` (12) · `time.nudgeHours` (8) · `time.allowOverlap` (false) · `time.allowEntriesWithoutItem` (true) · `time.durationStyle` `{hm, clock, decimal}` (hm) · `finance.costRates.enabled` (off; on for Naxdor) · `weekStart` (Monday) · `showIsoWeek` (true, sv locale) |
| `vault` | `module.vault.enabled` (on) · `vault.stepUpMinutes` (10) · `vault.revealBudgetPerHour` (30) · `vault.shareLinkMaxTtlHours` (168) · `vault.allowExternalShareLinks` (true) · `vault.allowPortalCredentials` (false) · `vault.allowContactSubmission` (true) |
| `portal` | `module.portal.enabled` (on) — per-project switches (`portalEnabled`, `hoursSharingMode`, task-list/kanban) are **columns on `Project`** behind `project:manage_portal`, not preferences |
| core | `locale`, `timezone`, `weekStart`, `currency`, `notify.email.enabled` (2W), digest cadence/hour + quiet hours (Phase 5) |

`settings:manage_modules` ✦ governs the `module.*.enabled` switches; the behavioural keys sit under `settings:edit`, **except** `finance.costRates.enabled`, `vault.allowExternalShareLinks` and `vault.allowPortalCredentials`, which are also under `settings:manage_modules` ✦ — turning cost rates, external share links or portal-persistent credentials *on* is a privilege decision, not a settings tweak (proposed; CP2/CP4 may move them).

**Limits** are checked at creation time via the same seam: `enforceLimit(tenant, 'maxClients')` before insert. **Downgrade = read-only grandfathering** ([Trello model](https://community.atlassian.com/forums/Trello-questions/What-happens-to-the-boards-when-you-downgrade-to-free/qaq-p/1987366)): block creation past the new limit; never delete, hide, or lock existing data. Client contacts are unlimited on every plan, forever (settled decision #4) — contact count is never a limit.

**The continuity-box exemption** (product-defining edge case, decided): the `continuity_box` module entitlement gates *authoring and configuring*. Once a box is SEALED, the open-request → open → download path **ignores gates 2 and 3** (and survives subscription lapse and tenant suspension). A continuity promise that seals itself when the card expires is not a continuity promise. Full lifecycle in CONTINUITY_BOX.md.

## 6. Why no policy engine (§3 — "argue me out of it")

The founder's instinct is confirmed, emphatically. The assignment graph here is depth ≤ 2 (member → client → project) — a `JOIN`/`EXISTS`, not graph traversal — and the schema above is [the documented industry-standard shape for multi-tenant RBAC](https://workos.com/blog/how-to-design-multi-tenant-rbac-saas), not an exotic one. Verified against the market (Aug 2026):

| Engine | Why rejected here |
|---|---|
| **OpenFGA** (self-host) | Requires a [separately deployed always-on service with its own datastore](https://openfga.dev/docs/best-practices/running-in-production) — doesn't run in Vercel serverless — plus the dual-write problem: every assignment row mirrored as a tuple, with [reconciliation jobs as the documented adoption pattern](https://openfga.dev/docs/best-practices/adoption-patterns). For a depth-2 graph. |
| **AWS Verified Permissions / Cedar** | [Cheap ($5/M checks)](https://aws.amazon.com/verified-permissions/pricing/) and Stockholm-resident, but drags an AWS control-plane dependency into a Vercel/Neon stack and taxes every check with entity sync or per-call entity passing. |
| **Oso Cloud** | [Pricing page now leads with "Oso for Agents"](https://www.osohq.com/pricing) — visible repositioning away from app authorization; vendor-direction risk. |
| **Casbin** | Loads policies into memory and scans linearly ([~5 s at ~20k policies in node-casbin #90](https://github.com/casbin/node-casbin/issues/90)); weak multi-tenant story; a DSL that doesn't solve resource scoping better than SQL. |
| **Permit.io** | [~$150/mo tier](https://www.permit.io/blog/permit-new-pricing-model) + a PDP sidecar container + authorization data (who works on which client = personal data) flowing through a third party — GDPR review cost on top. The clearest over-engineering at this scale. |
| **Cerbos** | The honorable mention — stateless PDP, data stays in our DB — but still an extra deployed service. Noted as the fallback *if* a policy layer is ever justified. |

Every hosted engine also adds a network hop per check (or caching that reintroduces staleness) versus one indexed query on a Neon connection we already hold. And the guards that actually matter — grant-subset, last-owner, no-self-escalation — are transactional application invariants **under every option**; no engine provides them (§7). What kills hand-rolled authorization is not scale but discipline: scattered ad-hoc checks. That is fixed by the seam, not a vendor.

**The seam is the insurance policy.** Every check flows through `authorize()` / `authorizedResourceIds()` / `assertInScope()` / `scopeWhere()` *(the latter two added 2026-08-16, §4)* (members), `authorizePortal()` (contacts), `authorizePlatform()` (platform). No call site touches authz tables or compares role names — enforced by lint rule and code review.

**Genuine triggers that would reopen this** (none exist in this spec): deep resource hierarchies with permission inheritance; peer-to-peer sharing graphs (Drive/Notion-like); multiple backend services needing the same decisions; enterprise-authored ABAC conditions; authorization at thousands of RPS. **Migration path if they appear:** our tables map 1:1 to relationship tuples (`MemberRole` → `user#role`, `MemberClient` → `user#assigned@client`); OpenFGA's documented path is backfill → shadow mode (async compare) → dual-write + reconciliation → flip inside `authorize()`. Because the seam exists, the swap is contained. We do not buy the engine now; we keep the door.

## 7. Enforcement mechanics

### 7.1 Escalation guards (§3)

All guards run **inside the same database transaction** as the mutation they guard (check-then-grant across two queries races), with the affected rows locked (`SELECT … FOR UPDATE` on the member/role rows involved):

1. **Grant-subset rule.** An actor may grant or revoke only permissions **they themselves hold** (effective set). Applies to `role:edit` (editing a role's grants) and to `member:manage_roles` (assigning a role = granting its whole set — the actor's set must be a superset of the assigned role's set).
2. **Role-edit subset rule.** An actor may edit role R only if both R's current set and the resulting set are subsets of the actor's effective set. This replaces the brief's "above their own level" with well-defined math — no numeric levels to maintain (see §11, refinement note).
3. **No self-escalation.** Any mutation whose effect would increase the *actor's own* effective permission set or scope is denied — including self-assignment of roles, editing a role the actor holds to add permissions, and self-assignment to clients they are not authorized for (`client:manage_assignments` is itself scoped).
4. **Assignment guard.** `client:manage_assignments` / `project:manage_assignments` operate only within the actor's own scope: you can staff clients you can see.

### 7.2 Protected system roles

`isSystem` roles: cannot be deleted, cannot have their permission set edited by any tenant actor (read-only rows; template updates arrive only via platform migration per §3.5). `role:delete` on a custom role additionally requires it to have no active `MemberRole` rows.

### 7.3 Last-owner invariant

At least one **active** member must hold the `templateKey='owner'` system role at all times. `member:remove`, role revocation, and member suspension run a transactional count of remaining active owner-role holders; a mutation that would reach zero is denied with a specific error. Covered in the deny-matrix tests (§10). The invitation flow may create a *pending* second owner, but pending members don't count toward the invariant.

### 7.4 No CEO bypass

There is **no** `if (isOwner) return true` anywhere. The owner template simply holds all permissions, so a bypass buys nothing and costs a permanent escalation surface. Consequence embraced: a tenant *can* lock itself out in exotic ways (e.g., all owner-holders lose MFA devices). Recovery is a **platform-plane operation**, not a code path: `platform.tenant.recover_access` (re-seat the owner role on a verified member, or reset an owner's MFA after out-of-band identity verification) — reason-logged, time-boxed, and visible in the tenant's own audit log like any other platform access (§7 of the brief).

### 7.5 MFA policy hooks (§9)

The brief mandates MFA for platform and tenant owner-equivalent roles. To avoid a role-name check in disguise, the mandate attaches to **permissions, not role names**: catalog codes flagged `requiresMfa` (✦ in §3.2 — billing, role/member management, continuity box, series config, export, module toggles).

- **Enrollment enforcement**: assigning any role whose set includes a ✦ permission requires the target member to have MFA enrolled — or flags the member for forced enrollment at next login, with ✦ actions blocked until enrolled. Since the CEO template holds ✦ codes, every owner is MFA-mandatory, satisfying §9 exactly.
- **Step-up (sudo mode)**: `continuity_box:edit`, `continuity_box:configure`, and `tenant:export` additionally require a fresh second factor within the last 10 minutes. Mechanics in SECURITY.md.

**Amended 2026-08-16 (work-management plan, decision 13) — the ✦ set grows and step-up becomes a helper.**

- **✦ set (`requiresMfa`)** = the v1 set (`invoice:manage_series`, `continuity_box:*` ×4, `role:edit`, `member:manage_roles`, `billing:manage`, `settings:manage_modules`, `tenant:export` — 10) **plus** `rate:view_cost`, `rate:manage_cost` (2T) and `credential:reveal`, `credential:share`, `credential:export`, `credential:change_visibility` (3V) — **16 at Phase 3V** (12 after 2T). Pinned by `catalog.test.ts` alongside the count (§3.2). Rationale per code: cost rates are salary-grade personal data (SECURITY.md §9.7); every vault action that moves plaintext or widens who can reach it is a Hudu/IT-Glue-class "explicit audited act with step-up".
- **Enforcement (Phase 1b, before any ✦ action exists in the UI beyond roles):** `authorize()` denies with reason **`MFA_REQUIRED`** when the code is ✦ and the member has no MFA enrolled — the enrolment rule above becomes an actual gate, not a flag; the UI routes the denial to the enrolment flow, never to a 403.
- **`requireRecentMfa(minutes)`** — the sudo-window helper, called by the service *after* `requireAccess` for actions that need a **fresh** factor: reads the session's last TOTP verification timestamp (Better Auth session field, SECURITY.md) and throws `MFA_REQUIRED` with `metadata.stepUp = true` when older than `minutes`; the UI opens the step-up dialog (one shared component for every ✦ action) and retries. Windows: `continuity_box:edit/configure`, `tenant:export` — 10 min (as before, now via the helper); `rate:view_cost` — 10 min per session, audited once per session as `rate_card.cost_revealed` (aggregate); **vault** — `vault.stepUpMinutes` preference, default 10, applied to `credential:reveal` (Reveal / Copy / TOTP each call), and **always** to `credential:share`, `credential:export`, `credential:change_visibility` regardless of any window (CP4 default: "always step-up for share/export/visibility"). `role:edit`, `member:manage_roles`, `billing:manage`, `settings:manage_modules`, `invoice:manage_series`: enrolled MFA **plus** SECURITY.md §3.6's fresh-session rule (≤ 15 min, C13 default) — implemented as `requireRecentMfa(15)` through the same helper (reconciled 2026-08-16 with SECURITY.md §3.5/§3.6 and the Phase 1b demo "`role:edit` without recent TOTP → step-up").
- **`MFA_REQUIRED` semantics:** it is a *deferred* denial — the action is legitimate, the principal is authorised, only freshness is missing. It is never audited as `authz.escalation_denied` (a wrong signal); the step-up *challenge* is audited as `auth.step_up_required` (vault path: `vault.step_up_required`, already in the 3V audit list) — both to be added to the audit catalog in 1b/3V — and the success is an ordinary `auth.*` MFA event. Three failed step-ups in a window fall back to the login rate limiter.
- **Decision 13 (recorded here, decided in OPEN_QUESTIONS.md):** `credential:reveal` is seeded **CMA — not E**. Because enrolment attaches to permissions, seeding it on the employee template would mean *enabling the `vault` entitlement forces MFA on every employee* the moment TV(3V) propagates — a surprise no tenant asked for. With CMA, owners/managers/admins are already MFA-holders (they hold other ✦ codes) so nothing changes for them; a tenant that wants employees revealing grants `credential:reveal` to an employee clone deliberately, and *that* forces enrolment for exactly those holders (existing rule, first bullet). The alternative — seed CMAE and accept all-employee MFA — stays the CP4 fallback and is a one-line template change with a TV bump.
- **Impersonation** (§9): platform read-only impersonation never satisfies `requireRecentMfa` — ✦ actions are impossible under impersonation by construction (view-class intersection), and the vault reveal endpoints additionally refuse any session carrying `impersonatorId`.

### 7.6 Resolution and caching — per-request, never JWT

Permissions are **resolved per request** from the database, keyed by `Member`. Never baked into JWTs or session tokens — a fired employee keeping access until token expiry is a [known revocation hole](https://oneuptime.com/blog/post/2026-02-02-jwt-revocation/view). At this scale the resolution query (two indexed joins over a few hundred rows) is sub-millisecond; correctness is free.

- **Per-request memoization** (React `cache()` / request context): resolve once per request no matter how many checks run.
- **Cross-request caching (optimization seam, not v1-required):** `Tenant.permissionsVersion` — an integer bumped **in the same transaction** as any mutation of `Role`, `RolePermission`, `MemberRole`, `MemberClient`, or `MemberProject`. A short-TTL cache keyed `(tenantId, memberId, permissionsVersion)` gives instant revocation (version bump ⇒ key miss) with a TTL backstop (≤ 5 min).
- The same rule applies to entitlements and preferences: read per-request from the tenant row, never from long-lived session claims (§5).

### 7.7 Audit coupling

Every authorization-relevant mutation writes an `AuditEvent` in the same transaction (mechanism in SECURITY.md/DATA_MODEL.md): role created/edited/deleted, permission granted/revoked (including template propagation, actor = SYSTEM), role assigned/revoked, member invited/removed, assignment added/removed, visibility flips, entitlement changes, preference toggles, MFA enrollment changes, every denied escalation attempt (`authz.escalation_denied`), and all impersonation and continuity events. The tenant sees its own log (`audit:view`); the platform sees everything — one event model, two audiences via write-time visibility (§9).

## 8. Portal authorization — `authorizePortal()` (§3, §2)

Contacts get **capabilities, not permissions**. The capability universe is a hardcoded TypeScript union in the portal module — **not rows in the `Permission` table, not tenant-customizable, not extensible at runtime**. The portal is the least-trusted surface (§9); its authorization surface is therefore frozen in code and changed only by a deploy.

**Capability allowlist (v1 complete set):**

| Capability | Grants | Phase |
|---|---|---|
| `portal.project.view` | Projects, timeline, milestones, versions — client-visible fields only | v1 (P3) |
| `portal.version.approve` | Sign off on a `ProjectVersion` (v1-lite approval, decision #7) | v1 (P3) |
| `portal.document.view` | List/preview `client_visible` documents only | v1 (P3) |
| `portal.document.download` | Download the same (audited per §9) | v1 (P3) |
| `portal.invoice.view` | View invoices addressed to their client | v1 (P4) |
| `portal.invoice.pay` | Pay-now button (decision #7) | v1 (P4) |
| `portal.contract.view` | View contracts | v1 (P4) |
| `portal.contract.sign` | Native SES click-to-accept (§10.3) | v1 (P4) |
| ~~`portal.issue.view` / `portal.issue.create` / `portal.issue.comment`~~ | ~~The client request queue (bug / idea / requirement)~~ **Retired 2026-08-16** → `portal.work_item.view` / `portal.request.create` / `portal.comment.create` below. The union is code, not a `Permission` row — renaming it is a compile-time refactor with no data migration, so the §3.1 immutability rule does not apply here and the old names are simply gone. | ~~v1 (P5)~~ |
| `portal.report.view` | Performance report charts | v2 |
| `portal.continuity.view_status` | See the sealed box exists, last-resealed date | v1 (P8) |
| `portal.continuity.request_open` | File a `ContinuityOpenRequest` | v1 (P8) |
| `portal.continuity.download` | Download opened box within the window | v1 (P8) |
| `portal.work_item.view` *(added 2026-08-16)* | See `CLIENT_VISIBLE` work items of `portalEnabled` projects — `stateCategory`, title, target date, milestone, own-assignment only; never state names, labels, links, estimates, priority, `assigneeMemberId`, INTERNAL activity | v1 (P3) |
| `portal.work_item.act` *(added 2026-08-16)* | Complete an item **assigned to this contact** (`assigneeContactId = principal`) — **brokered** state change to the project's DONE-category state; nothing else | v1 (P3) |
| `portal.request.create` *(added 2026-08-16)* | Submit a request: `WorkItem(kind = REQUEST, source = PORTAL, visibility = CLIENT_VISIBLE, TRIAGE state)` — **brokered**; rate-limited per contact | v1 (P3) |
| `portal.comment.create` *(added 2026-08-16)* | Comment on a `CLIENT_VISIBLE` subject the contact can see — the one **contact-writable** row (`Comment` INSERT under RLS `WITH CHECK`), forced `CLIENT_VISIBLE`, `authorContactId = principal` | v1 (P3) |
| `portal.update.view` *(added 2026-08-16)* | Read `PUBLISHED` + `CLIENT_VISIBLE` `ProjectUpdate`s and their `portalSnapshot` (never the internal snapshot, never drafts) | v1 (P3) |
| `portal.timeline.view` *(added 2026-08-16)* | The derived Client Timeline (updates, milestone/version events, deliverable versions, approvals) | v1 (P3) |
| `portal.hours.view` *(added 2026-08-16)* | The hours / billable-amount widget from `ProjectTimeSummary` when `Project.hoursSharingMode ≠ NONE` — **`CONTACT_PRIMARY` only**; never `time_entry`, never per member | v1 (P3) |
| `portal.deliverable.approve` *(added 2026-08-16)* | Approve / request changes on a `CLIENT_VISIBLE` `Document(kind = DELIVERABLE)` — approval columns are contact-writable, mirroring `portal.version.approve` — **`CONTACT_PRIMARY` only** | v1 (P3) |
| `portal.credential.submit` *(added 2026-08-16)* | Submit a credential through the portal form (never in a comment or email) — **brokered** insert of `CredentialItem` + `CredentialSecret`, `visibility` per `vault.allowPortalCredentials`; gated by `vault.allowContactSubmission` | v1 (P3V) |
| `portal.share_link.view` *(added 2026-08-16)* | Open a `CredentialShareLink` as an **authenticated contact of that client** (the alternative recipient — email-OTP — is not a portal principal and is resolved by the token path outside `authorizePortal()`, under the same view-once/TTL rules) | v1 (P3V) |

**Contact profiles** (the "portal-side Contact roles" of §3) are fixed bundles over this allowlist. v1 ships two, selected per contact by staff holding `client:manage_contacts`:

- **`CONTACT_PRIMARY`** — all v1 capabilities, including contract signing, invoice payment, version approval, and continuity actions *(amended 2026-08-16: plus `portal.hours.view` and `portal.deliverable.approve`, which exist on this profile only)*.
- **`CONTACT_COLLABORATOR`** — `portal.project.view`, `portal.document.view/download`, ~~`portal.issue.*`~~ *(amended 2026-08-16:)* `portal.work_item.view/act`, `portal.request.create`, `portal.comment.create`, `portal.update.view`, `portal.timeline.view`, `portal.credential.submit`, `portal.share_link.view`. No money, no signatures, no continuity, no hours, no deliverable sign-off.
- **`CONTACT_FINANCE`** (v2) — invoices and contracts only. Per-contact capability toggles *within* the allowlist: v2, if tenants ask. Tenant-defined portal roles: **skip**.

**`authorizePortal(contact, capability, resource)` pipeline:** contact is active and was invited (invite-only is an invariant — no self-signup path exists in code, §3) → capability ∈ profile → resource belongs to the contact's `clientId` and `tenantId` (a contact belongs to exactly one client) → for documents/files, `visibility = 'CLIENT_VISIBLE'` *(amended 2026-08-16: for every portal-reachable row, `visibility = 'CLIENT_VISIBLE'`, and for project-scoped rows also `Project.portalEnabled` — the same predicate the RESTRICTIVE `portal_gate` policy enforces below)* → module gates: `portal` module entitled + preferred, plus the capability's parent module (invoice capabilities require `invoicing` entitled, etc. — `portal.work_item.*`/`portal.request.*`/`portal.comment.*`/`portal.update.*`/`portal.timeline.*` → `work`; `portal.hours.view` → `time`; `portal.credential.*`/`portal.share_link.*` → `vault`; *added 2026-08-16*), with the continuity carve-out from §5. Out-of-scope is always 404. Behind all of it, the RESTRICTIVE RLS policy (TENANCY.md) makes internal rows unreachable even if this function has a bug.

Rate limiting (per-contact, per-email keys) applies to the portal surface first — see SECURITY.md.

**The brokered-write rule *(added 2026-08-16 — work-management plan; normative, stated once here and referenced from TENANCY.md §7.2/§11)*.** Portal **reads** always run under the RLS-scoped **contact principal** (`withTenant(tenantId, {type:'contact', id, clientId})` — `id` becomes the `app.principal_id` GUC in 1b) — never under a system principal, so a projection bug is still caught by `portal_gate` (`client_id = app.client_id AND visibility = 'CLIENT_VISIBLE' AND portal_enabled`). Portal **writes** come in exactly two shapes:

1. **Contact-writable rows** — the census in TENANCY.md §11, exactly: `Comment` INSERT (`WITH CHECK visibility = 'CLIENT_VISIBLE' AND client_id = app.client_id AND author_contact_id = app.principal_id`), `ProjectVersion` approval columns, `Document` approval columns, `Notification.readAt/archivedAt` on the contact's own receiver rows, `ContinuityOpenRequest`. These are written under the contact principal; RLS is the last line.
2. **Brokered writes** — everything else a contact can cause: `portal.request.create`, `portal.work_item.act`, `portal.credential.submit`. The route handler runs `authorizePortal(contact, capability, resource)` **first** (profile, client/tenant ownership, `CLIENT_VISIBLE`, `portalEnabled`, module gates), then performs the write under **`withTenant(tenantId, {type:'system'})`** in `src/modules/<key>/portal.ts`, with hard-coded field values (kind/source/visibility/state/author) that the request body cannot override, an `AuditEvent` naming the contact as actor, and `notify.emit()` in the same tx. `withPlatform` is unreachable from portal routes (ESLint import boundary).

Both shapes are enforced by two CI tripwires that ship in the same commit as each portal feature: the **forbidden-columns grep** over `modules/*/portal.ts` (rates, cost, `internalNotes`, `repoUrl`, `hostingNotes`, non-billable, per-member breakdown, state names, labels, links, `assigneeMemberId`, INTERNAL activity, ciphertext) and the **contact-writable census test** (any new `INSERT`/`UPDATE` policy for the portal role outside the census fails the build). Adding a third write shape — e.g. "the contact edits its own request" — means extending the census and the test, never widening a policy quietly. "View as client" (`project:manage_portal`) calls the very same `portal.ts` functions under a synthetic contact principal, asserted by an import-graph test.

## 9. Platform plane — `authorizePlatform()` and impersonation (§7)

Platform admins are `User` identities carrying **`User.platformRole`** (v1: single value `SUPERADMIN`; per-action platform roles are v2 — the platform team is one person). `User.platformRole` is the field `authorizePlatform()` reads and is authoritative; the Better Auth admin-plugin column `User.role` is vendor plumbing mirrored from it and is never consulted (DATA_MODEL.md §1.1, §6.1). They are **not** members of tenants; platform authorization never touches the tenant RBAC machinery. The action set is hardcoded: `platform.tenant.provision`, `platform.tenant.suspend`, `platform.tenant.configure_entitlements`, `platform.tenant.export`, `platform.tenant.delete`, `platform.tenant.recover_access`, `platform.impersonate.start`, `platform.flags.manage`, `platform.billing.view`, `platform.audit.view`. MFA is mandatory for any `platformRole` (§9), no exceptions, enforced at login.

**Impersonation is a privilege, not a backdoor** (§7):

- Started via `platform.impersonate.start` with a **required reason**, a target member (or contact), and a TTL (default 60 min, hard max 24 h). No open-ended sessions.
- The impersonation session carries `impersonatorId`; every `AuditEvent` written during it records **both identities** (the impersonated actor and the impersonator — the biggest documented audit gap in B2B SaaS).
- **Read-only by default**: during impersonation, `authorize()` resolves the impersonated member's permissions **intersected with view-class verbs**. Write elevation is a separate, explicitly logged escalation per session (v1: not offered; read-only only. v2: scoped write elevation if support reality demands it).
- Start and stop are audited with `visibility = TENANT` — the tenant sees platform access in **their own** audit log, as §7 requires. The GDPR lawful-basis and DPA language for this access lives in SECURITY.md.
- Impersonating a contact uses the portal path (`authorizePortal()` with the contact's own profile) — impersonation never grants more than the principal itself has.

## 10. Testing obligations (§12)

Non-negotiable CI suites (run on every PR, alongside the tenancy isolation suite in TENANCY.md):

- **Deny-matrix**: generated, not hand-written — for every `Permission` code × each template role × fixtures (in-scope resource, out-of-scope resource, other-tenant resource), assert exactly the §3.2 matrix outcome, including 404-vs-403 semantics.
- **Escalation suite**: self-escalation attempts, granting un-held permissions, editing held roles, last-owner removal (direct, via role revocation, via suspension), system-role edit/delete attempts, assignment outside own scope — all must fail transactionally under concurrency (two parallel "remove the other owner" requests must not both succeed).
- **Portal probes**: every portal capability against internal-visibility rows, other clients' rows, other tenants' rows, and tenant/platform routes with a portal token — all deny.
- **Gate ordering**: entitled-but-preference-off, flagged-off-but-entitled, permission-held-but-not-entitled — assert the deterministic denial reasons; continuity carve-out asserted explicitly (lapsed subscription ⇒ open path still works).
- **Added 2026-08-16 (work-management plan)** — the deny-matrix is regenerated per phase from the catalog and the *current* template version (so the deprecated `issue:*` rows are asserted as **unseeded** on every template at TV ≥ 2, and `catalog.test.ts` pins count + ✦ set per §3.2/§7.5); **two-axis scoping** fixtures (§4 example: `MemberProject(P1)` sees P1 and 404s on P2; `scopeWhere` present on every list query — lint); **MFA deny-matrix** (✦ code without enrolment ⇒ `MFA_REQUIRED`; ✦ step-up code with stale factor ⇒ `MFA_REQUIRED` + `stepUp`; `credential:reveal` on an employee clone forces enrolment for its holders); **portal probes** extended to every new capability, incl. brokered writes with tampered bodies (any `kind`/`visibility`/`state`/`author` other than the hard-coded values ⇒ rejected), `portal.work_item.act` on a non-own item ⇒ 404, `portal.hours.view` on `CONTACT_COLLABORATOR` ⇒ deny, `hoursSharingMode = NONE` ⇒ no summary rows; **entitlement v1→v2** parse (v1 document ⇒ `work/time/vault` on, `entitled('issues')` ≡ `entitled('work')`).

## 11. Open questions and pushback

**Routed to OPEN_QUESTIONS.md:**
1. ~~**Template-drift policy** (§3.5)~~ — **decided 2026-08-08 (B3): tracked-diff-additive**, as recommended.
2. ~~**Default seeding matrix sign-off** (§3.2)~~ — **accepted as specced 2026-08-08 (B6)**, opinionated defaults included (Employees have no invoice permissions; Managers don't issue invoices).
3. `maxCustomRoles` cap values per tier — can wait (Phase 7).
4. ~~Step-up MFA action list beyond continuity + export — can wait.~~ — **decided 2026-08-16 (decision 13 + CP4 defaults):** the list is §7.5 (`rate:view_cost`, `credential:reveal` on a `vault.stepUpMinutes` window; `credential:share/export/change_visibility` always). Remaining open: whether `credential:reveal` moves to CMAE (CP4 fallback).

**Pushback (brief §12):**

> **Pushback — portal contact roles are not clone-and-customize.** Brief §3 lists "portal-side Contact roles" among the templates a tenant can clone and customize. This spec deliberately does not honor that for v1: the portal capability universe is hardcoded and profiles are fixed (§8), per the settled architecture ("hardcoded capability set"). Reasons: the portal is the least-trusted surface, and every unit of customization there is attack/misconfiguration surface — a tenant "customizing" a contact role into seeing internal documents is exactly the §5 worst-case bug, self-inflicted; and two fixed profiles cover the actual v1 personas. Bounded per-contact toggles within the allowlist are the v2 path if real demand appears. If the founder wants tenant-customizable portal roles in v1 anyway, the model supports it only as profile-selection plus per-capability toggles — never tenant-defined capabilities.

**Refinements of brief wording (not disagreements):**
- "Edit a role above their own level" (§3) is specified as **subset semantics** (§7.1) — no numeric role levels exist; "above" is defined as "not a subset of what you hold." Strictly stronger and has no hierarchy to maintain.
- MFA "mandatory for owner-equivalent roles" (§9) is implemented as **permission-attached** (`requiresMfa`, §7.5) rather than role-name-attached — same effect for owners, and it survives tenants cloning roles, which a role-name rule would not.
- Gate evaluation order (§4) places the engineering kill-switch **before** the entitlement check (§5) — outcome-identical (AND semantics), but a kill-switch must dominate commercial state during an incident.
