# AUTHZ.md — Roles, Permissions, Entitlements

**Status:** Phase 0 specification. Covers brief §2, §3, §4, and the authorization-relevant parts of §7 and §9. Companion docs: TENANCY.md (row-level isolation this model sits on), DATA_MODEL.md (table definitions for the entities named here), SECURITY.md (auth vendor configuration, MFA mechanics, session design).

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
- Every code carries a `module` linking it to the entitlement system (§4 of the brief): `core` (never toggleable) or one of `invoicing`, `contracts`, `reports`, `issues`, `documentation`, `continuity_box`, `portal`. This makes gate composition mechanical (see §6): resolve the permission → its module → run the module gates automatically.
- Mirrored as a TypeScript union type in one module so call sites are compile-checked; the seed migration and the type are generated from a single source list.
- `authorize()` **fails closed on unknown codes**: deny + alert (it's a config error, not a user error).

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
| `issue:view` | issues | View issues | C M A E | scoped | v1 |
| `issue:create` | issues | Create issues (also on behalf of a contact) | C M A E | scoped | v1 |
| `issue:edit` | issues | Triage: type, priority, status, assignee, link to release | C M E | scoped | v1 |
| `issue:comment` | issues | Comment on issues | C M A E | scoped | v1 |
| `issue:delete` | issues | Delete issues | C M | scoped | v1 |
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

✦ = `requiresMfa` (see §7.5). **63 codes** *(erratum fixed 2026-08-08: prose previously said 64; the table above is normative and has always held 63 rows — verified mechanically at implementation time, and the CI catalog test asserts 63)*. `audit:view` and `tenant:export` sit outside the brief's enumerated module list but are required by §9 (tenant-facing audit log, export paths); they are `core`.

Notes on shape:

- **Draft vs issued is encoded in the verbs.** `invoice:edit`/`invoice:delete` apply to drafts only; `invoice:issue` is a separate, irreversible, legally significant permission (gap-free numbering, §10.2 — detail in DATA_MODEL.md). Same pattern for contracts (`contract:send` freezes).
- **No `project:view_all`.** Client scope subsumes project scope: assignment to a client covers all its projects (§5). One override code (`client:view_all`) keeps the scoping model explainable in one sentence.
- **v1 performance reports** are simply client-visible `Document`s (settled decision #7) — the `document:*` codes govern them; `report:*` codes are reserved now (codes are forever), UI lands Phase 6/v2.

### 3.3 System role templates and clone-and-customize (§3)

Templates ship as the platform's definition; at tenant creation each template is instantiated as a `Role` row in that tenant with `isSystem = true` and a `templateKey` (`owner`, `manager`, `admin`, `employee`). Semantics:

- **System roles are read-only and undeletable.** A tenant cannot edit or delete a system role — this is how "cannot de-fang the role that owns billing and user management" is enforced structurally, not by an allowlist of "critical" permissions someone forgets to maintain.
- **Customization = clone.** `role:create` clones any role (system or custom) into an editable custom role (`isSystem = false`, `clonedFromKey` recorded). Tenants then grant/revoke individual permissions on the clone via `role:edit`, subject to the escalation guards (§7).
- **Owner-equivalence is the `templateKey = 'owner'` system role**, not a permission pattern. A clone of it is just a custom role; the last-owner invariant (§7.3) pins to the system row. The CEO template is seeded with **all 63 codes** — fully, deliberately, so that no code path ever needs an owner bypass (§7.4).
- **Role-explosion guard**: bounded customization, not a blank canvas — a per-tenant cap on custom roles (proposed: an entitlement limit, `maxCustomRoles`, e.g. 5 / 15 / 30 by tier). Templates should carry 90% of tenants with zero customization.
- **Multiple holders of any role** including owner: `MemberRole` is many-to-many from day one (§3.4).

**Portal contact roles are templates of a different kind** — fixed capability profiles, not clonable (see §8 and the Pushback note in §11).

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
  - `MemberClient(memberId, clientId)` ⇒ scope over that client **and all its projects** (and their contracts, invoices, documents, issues, reports, box).
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

## 5. The four gates (§4)

Four different questions, four records, four single-purpose functions — never conflated:

| # | Gate | Question | Owner | Storage | Function |
|---|---|---|---|---|---|
| 1 | **Feature flag** | "Is this feature switched off by engineering right now?" | Engineering; temporary, deleted after rollout, **never monetization** | `FeatureFlag` (global default + per-tenant override rows) | `flagEnabled(key, tenantId)` |
| 2 | **Entitlement** | "Does this tenant's plan include the module?" | Billing/platform; commercial | Versioned `entitlements` JSON column on `Tenant` | `entitled(tenant, module)` |
| 3 | **Tenant preference** | "Has the tenant chosen to switch it off?" (entitled but disabled — the Fortnox case) | Tenant (`settings:manage_modules`) | `TenantPreference` rows | `preferenceEnabled(tenant, module)` |
| 4 | **Permission / capability** | "May this principal perform this action, on this resource?" | Tenant role config / hardcoded portal profile | `Role`→`RolePermission`→`Permission` + assignments | `authorize(...)` / `authorizePortal(...)` |

**Evaluation order: 1 → 2 → 3 → 4.** All gates are AND-ed, so ordering does not change the outcome — it fixes three things: the kill-switch dominates during an incident regardless of commercial state; the **denial reason** is deterministic for UX (`FEATURE_DISABLED` → "temporarily unavailable"; `NOT_ENTITLED` → upgrade prompt; `DISABLED_BY_TENANT` → "an admin can enable this in settings"; `FORBIDDEN` → 403; `NOT_FOUND` → out-of-scope, §4); and the cheapest checks run first. *Note:* the brief (§4) lists "entitlement → preference → permission" and names flags as a fourth, orthogonal gate; the settled refinement is to evaluate the kill-switch first — a rollback switch that only works for unentitled tenants is not a kill-switch.

**Composition.** Call sites use one composite: `requireAccess(ctx, permissionCode, resource?)`. It resolves the code → its `module`, runs gates 1–3 for that module (`core` modules skip 2–3 — always on), then gate 4. One call, all server-side; the UI reads the same resolved gate state to hide affordances, as cosmetics only.

**Entitlements shape** (per the billing research — [Stripe's Entitlements API is boolean-only and Stripe itself recommends persisting locally](https://docs.stripe.com/billing/entitlements), so the source of truth is our own record): the `Tenant.entitlements` JSON is versioned — `{ schemaVersion, planCode, source: 'stripe' | 'manual_override', modules: { invoicing, contracts, reports, issues, documentation, continuity_box, portal }, limits: { maxMembers, maxClients, maxStorageBytes, maxCustomRoles }, addons: { bankidSigning } }` — written by the Stripe webhook resolver (Phase 7) or platform override (§7 of the brief: trials, overrides), read per-request (~1 ms at this scale). The seven `modules` keys are exactly the `Permission.module` values (§3.1) and ARCHITECTURE.md §3's folder map, spelled identically — `reports`, `continuity_box` — because gate composition is a literal lookup. **BankID signing is an `addons` key, not an eighth module**: it meters a capability *inside* `contracts` (v1.5, pooled broker), and adding it as a module would break the module↔folder 1:1 rule. Never `if (plan === 'pro')` in business logic; never entitlements baked into long-lived sessions (revocation lag on cancel/downgrade).

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

**The seam is the insurance policy.** Every check flows through `authorize()` / `authorizedResourceIds()` (members), `authorizePortal()` (contacts), `authorizePlatform()` (platform). No call site touches authz tables or compares role names — enforced by lint rule and code review.

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
| `portal.issue.view` / `portal.issue.create` / `portal.issue.comment` | The client request queue (bug / idea / requirement) | v1 (P5) |
| `portal.report.view` | Performance report charts | v2 |
| `portal.continuity.view_status` | See the sealed box exists, last-resealed date | v1 (P8) |
| `portal.continuity.request_open` | File a `ContinuityOpenRequest` | v1 (P8) |
| `portal.continuity.download` | Download opened box within the window | v1 (P8) |

**Contact profiles** (the "portal-side Contact roles" of §3) are fixed bundles over this allowlist. v1 ships two, selected per contact by staff holding `client:manage_contacts`:

- **`CONTACT_PRIMARY`** — all v1 capabilities, including contract signing, invoice payment, version approval, and continuity actions.
- **`CONTACT_COLLABORATOR`** — `portal.project.view`, `portal.document.view/download`, `portal.issue.*`. No money, no signatures, no continuity.
- **`CONTACT_FINANCE`** (v2) — invoices and contracts only. Per-contact capability toggles *within* the allowlist: v2, if tenants ask. Tenant-defined portal roles: **skip**.

**`authorizePortal(contact, capability, resource)` pipeline:** contact is active and was invited (invite-only is an invariant — no self-signup path exists in code, §3) → capability ∈ profile → resource belongs to the contact's `clientId` and `tenantId` (a contact belongs to exactly one client) → for documents/files, `visibility = 'CLIENT_VISIBLE'` → module gates: `portal` module entitled + preferred, plus the capability's parent module (invoice capabilities require `invoicing` entitled, etc.), with the continuity carve-out from §5. Out-of-scope is always 404. Behind all of it, the RESTRICTIVE RLS policy (TENANCY.md) makes internal rows unreachable even if this function has a bug.

Rate limiting (per-contact, per-email keys) applies to the portal surface first — see SECURITY.md.

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

## 11. Open questions and pushback

**Routed to OPEN_QUESTIONS.md:**
1. ~~**Template-drift policy** (§3.5)~~ — **decided 2026-08-08 (B3): tracked-diff-additive**, as recommended.
2. ~~**Default seeding matrix sign-off** (§3.2)~~ — **accepted as specced 2026-08-08 (B6)**, opinionated defaults included (Employees have no invoice permissions; Managers don't issue invoices).
3. `maxCustomRoles` cap values per tier — can wait (Phase 7).
4. Step-up MFA action list beyond continuity + export — can wait.

**Pushback (brief §12):**

> **Pushback — portal contact roles are not clone-and-customize.** Brief §3 lists "portal-side Contact roles" among the templates a tenant can clone and customize. This spec deliberately does not honor that for v1: the portal capability universe is hardcoded and profiles are fixed (§8), per the settled architecture ("hardcoded capability set"). Reasons: the portal is the least-trusted surface, and every unit of customization there is attack/misconfiguration surface — a tenant "customizing" a contact role into seeing internal documents is exactly the §5 worst-case bug, self-inflicted; and two fixed profiles cover the actual v1 personas. Bounded per-contact toggles within the allowlist are the v2 path if real demand appears. If the founder wants tenant-customizable portal roles in v1 anyway, the model supports it only as profile-selection plus per-capability toggles — never tenant-defined capabilities.

**Refinements of brief wording (not disagreements):**
- "Edit a role above their own level" (§3) is specified as **subset semantics** (§7.1) — no numeric role levels exist; "above" is defined as "not a subset of what you hold." Strictly stronger and has no hierarchy to maintain.
- MFA "mandatory for owner-equivalent roles" (§9) is implemented as **permission-attached** (`requiresMfa`, §7.5) rather than role-name-attached — same effect for owners, and it survives tenants cloning roles, which a role-name rule would not.
- Gate evaluation order (§4) places the engineering kill-switch **before** the entitlement check (§5) — outcome-identical (AND semantics), but a kill-switch must dominate commercial state during an incident.
