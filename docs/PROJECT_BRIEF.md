# PROJECT_BRIEF.md — Fortleva
### Multi-tenant SaaS: client & project management, client portal, and continuity box

## 0. How to use this document

You are Claude Code. **Do not write application code in your first pass.**

Phase 0 is research and specification. Read this brief, research the open
questions in §10, then produce these files in `/docs` and stop for my review:

1. `PLAN.md` — phased build plan, each phase independently shippable.
2. `ARCHITECTURE.md` — stack decisions with rationale, trade-offs, rejected options.
3. `TENANCY.md` — tenant model, isolation strategy, and how it is enforced.
4. `AUTHZ.md` — roles, permissions, entitlements, and how the three interact.
5. `DATA_MODEL.md` — full Prisma schema draft with tenancy and audit strategy.
6. `SECURITY.md` — threat model, auth model, encryption design, GDPR posture.
7. `CONTINUITY_BOX.md` — dedicated design doc for §8 (the hardest part).
8. `OPEN_QUESTIONS.md` — decisions you need from me, grouped "blocks Phase 1" vs "can wait".

Where my spec is weak, incomplete, or wrong, say so. I would rather be
challenged now than refactor later. Do not pad the scope — if a feature
belongs in v2, put it in v2.

---

## 1. What this is

A **multi-tenant SaaS product**. Agencies and small service companies sign up,
manage their clients and projects inside it, and give their own clients a
portal. I am the platform owner (super admin).

My own agency, Naxdor (web development, CRM, AI integration, SEO; Sweden + US),
is **tenant zero**. I run my real business on it. That is the design constraint
that keeps the product honest — but it must not leak Naxdor-specific
assumptions into the schema or the UI.

Scale target for v1: tens of tenants, each with tens of clients. Optimize for
correctness, isolation, and low operating cost — not for scale you do not have.

### Vocabulary — use these names consistently everywhere

Ambiguity here will wreck the schema. Fix the words before writing code:

- **Tenant** (a.k.a. Organization / Workspace) — a company that subscribes.
- **Member** — a person who works at a tenant (CEO, manager, admin, employee).
- **Client** — a customer *of a tenant*. A company record, not a login.
- **Contact** — a person at a client. This is who logs into the portal.
- **Platform** — my layer, above all tenants.

Never use "user" to mean both a member and a contact. Never use "client" to
mean a tenant.

### Stack defaults (deviate only with a written reason)

- Next.js (App Router) + TypeScript + Tailwind, deployed on Vercel
- Prisma + Postgres (Neon), **EU region** — non-negotiable, see §9
- Cloudflare R2 for file storage
- Stripe for tenant subscriptions
- Auth: see §10.1 — research before choosing

---

## 2. The three planes

Three distinct surfaces, one codebase, one database. Keep them in separate
route groups with separate middleware, separate session claims, and separate
layouts. A role check must never be the only thing between a portal contact
and platform data.

| Plane | Who | What they do |
|---|---|---|
| **Platform** | Me (super admin) | Onboard tenants, set plans and entitlements, support, billing, platform health |
| **Tenant** | CEO / Manager / Admin / Employee | Run the agency: clients, projects, invoices, contracts, files |
| **Portal** | Client contacts | See their own projects, invoices, contracts, files; report issues |

---

## 3. Identity, roles, and permissions

This is the part most likely to be built wrong and expensive to fix. Design it
properly in `AUTHZ.md` before touching the schema.

### Requirements

- **Permissions are the atomic unit.** Roles are named bundles of permissions.
  Never check a role name in business logic — check a permission
  (`invoice:create`, `client:delete`, `continuity_box:edit`). Role names change;
  permission checks should not.
- **Roles are tenant-scoped.** Ship system **role templates** — CEO, Manager,
  Admin, Employee, plus portal-side Contact roles — that a tenant can clone and
  customize. Tenants can grant and revoke individual permissions on their own
  roles. Guard against role explosion: templates plus bounded customization,
  not a blank canvas.
- **Multiple holders of any role.** A tenant can have several CEOs, several
  admins, anything. Do not model role as a single enum column on the member
  record. Membership → role assignments must be many-to-many from day one.
- **Membership is tenant-scoped, identity is global.** One person, one login,
  potentially several tenants, a different role in each. Every authorization
  decision answers "does this user hold this permission *in this tenant*",
  never "is this user an admin".
- **System roles are protected.** A tenant cannot delete or de-fang the role
  that owns billing and user management, or they will lock themselves out.
  There must always be at least one member holding the owner-equivalent role.
- **Privilege escalation guard.** A member must not be able to grant a
  permission they do not themselves hold, or edit a role above their own level.

### The harder half: resource scoping

Roles alone will not carry this product. "Employee" is not one thing — an
employee assigned to three clients must not see the other twenty. That is a
*relationship*, not a role: membership on a client or a project.

Model assignment explicitly (member ↔ client, member ↔ project) and make the
permission check a function of both role and assignment. Research whether a
policy layer (Cedar, OpenFGA, Oso, Casbin, Permit.io) earns its place here or
whether a well-structured RBAC + assignment table is enough at this size. My
instinct is that a hosted policy engine is over-engineering for tens of
tenants — argue me out of it if you disagree, but be specific about what
breaks without one.

### Portal contacts

Contacts are not members with fewer permissions. They are a different
principal type with their own small permission set (view invoices, view
projects, submit issues, open the continuity box). Keep the two authorization
paths physically separate in the code. Invite-only — no self-signup for
contacts, ever.

---

## 4. Feature configuration: entitlements vs. flags vs. permissions

I want features enabled and disabled per company. Research says do not
conflate three different gates — get this right in `AUTHZ.md`:

1. **Entitlement** — "this tenant's plan includes Invoicing." Commercial,
   permanent, owned by billing. Stripe is the source of truth for the
   subscription state; the app resolves it into an entitlement record per
   tenant. Never write `if (plan === 'pro')` anywhere in business logic.
2. **Tenant preference** — "this tenant has Invoicing turned off because they
   use Fortnox." Entitled but disabled by choice. A separate flag from the
   entitlement, because re-enabling must not require me to touch anything.
3. **Permission** — "this member may create an invoice." Per-role, per-tenant.
4. **Feature flag** — engineering-owned, temporary, for rollout. Delete after
   rollout. Never used for monetization.

Evaluation order: entitlement → tenant preference → permission. All three
enforced **server-side**; UI hiding is cosmetics, not security. Every gate is a
single function call, not scattered conditionals.

At this scale a per-tenant JSON config of booleans and numeric limits, resolved
server-side and cached in the session, covers nearly everything. Do not reach
for a feature-flag SaaS or build a service until there is real pressure. Do
build the *shape* correctly now — modules, limits (max clients, max storage,
max members), and add-ons — because retrofitting entitlements into scattered
plan checks is the classic mess.

Modules to make toggleable: Invoicing, Contracts, Performance reports, Issue
tracker, Documentation, Continuity box, Client portal itself.

---

## 5. Tenant isolation

Two boundaries, not one: **tenant ↔ tenant**, and **client ↔ client inside a
tenant**. Both are data-leak surfaces. The second is the one people forget.

Recommended approach (validate it, don't just accept it):

- Shared database, shared schema, `tenantId` on every tenant-owned row.
- A Prisma client extension that injects the tenant scope automatically, so a
  developer cannot forget the filter — because they never write it.
- Postgres **RLS as defense in depth** on the sensitive tables, so even a raw
  query is filtered by the database itself.
- Composite indexes starting with `tenantId` on every scoped table.
- Cross-tenant read attempts as an automated test suite that runs in CI on
  every PR — not a one-off test written once and forgotten.

Compare this against schema-per-tenant and database-per-tenant in `TENANCY.md`,
including what changes if a tenant later demands physical isolation.

Every file, note, and field also carries a **visibility** dimension:
`internal` (tenant staff only) vs `client-visible`. Default `internal`.
Accidental exposure of an internal file to a client is the worst bug this
product can have — enforce it at the data layer, not the UI.

---

## 6. Domain model (tenant plane)

Model these as first-class entities, not a document dump. All tenant-scoped.

**Clients** — company details, org.nr / VAT ID, billing address, contacts with
portal access and roles, internal private notes never visible to the client,
assigned members.

**Projects** — belongs to a client. Type, scope, status, start date, launch
date, current version, environments (staging/production URLs), repo link,
hosting details. A **timeline / stage view** showing where it is right now,
what shipped when, which version is live, with release notes. This is what
contacts look at most — design it well.

**Services / Products** — what the client buys: one-off builds, retainers,
hosting, SEO, maintenance. Recurring vs one-time, renewal dates.

**Contracts** — uploaded or generated, versioned, status
(draft / sent / signed / expired), effective and expiry dates. See §10.3.

**Invoices** — line items linked to services/projects, status, due dates,
multi-currency, VAT/moms handling, tenant-specific numbering sequences.
Note: invoice numbering must be sequential *per tenant*, gap-free, and
concurrency-safe. See §10.2 for the legal requirements before designing this.

**Documents & files** — the general storage layer. Attachable to any entity.
Folders or tags, versioning, previews, and the visibility flag from §5.

**Performance reports** — uploaded or synced search engine and site performance
data (Search Console, GA4, Core Web Vitals, rankings), shown as charts plus the
raw file. Manual upload first; API sync is a v2 question.

**Issues** — contacts report a **bug**, an **idea**, or a **requirement**, with
type, priority, status, comment thread, attachments. Lightweight tracker, not
Jira. Staff triage, respond, and link an issue to the release that fixes it.

---

## 7. Platform plane (my layer)

- Tenant provisioning, plan assignment, entitlement overrides, trials.
- Subscription and billing via Stripe; dunning, cancellation, downgrade
  behaviour (what happens to data over the limit on a downgrade?).
- Usage and health per tenant: storage, member count, activity.
- **Support access is not a backdoor.** Cross-tenant access by me must be
  exceptional, explicitly reason-logged, time-boxed, read-only by default,
  visible to the tenant in their own audit log, and separate from ordinary
  platform administration. Design impersonation this way from the start —
  research shows it is far harder to retrofit, and under GDPR my access to a
  tenant's data needs a documented lawful basis and a DPA that permits it.
- Tenant lifecycle: suspension, offboarding, full data export, hard deletion
  with a defined grace period.

---

## 8. The continuity box (design this carefully)

The original reason I am building this, and the strongest differentiator: most
agencies are one or two people, and their clients have no path forward if that
person disappears.

Each client gets a **sealed box** in their portal, authored by the tenant,
containing what the client would need to carry on without them.

### Requirements

- One sealed box per client, contents authored and updated by tenant staff
  holding a specific permission.
- Contents encrypted such that a database dump alone does not reveal them.
- The client can open it **exactly once**. Irreversible and permanently logged.
- Openable only under defined trigger conditions — not on a whim.
- Opening notifies the tenant immediately through every available channel, plus
  any nominated fallback contact.
- Contents downloadable as a single package once opened, because the scenario
  where it is opened may also be one where hosting and domains are lapsing.

### SaaS twist: two levels of continuity

1. **Tenant → client.** The feature above, productized for every tenant.
2. **Platform → tenants.** If *I* disappear, every tenant loses their system
   *and* the continuity mechanism they were relying on. Address this in
   `CONTINUITY_BOX.md`: scheduled per-tenant data exports they hold themselves,
   documented self-hosting or escrow arrangements, a platform-level dead-man's
   switch. A continuity product with a single point of failure at the platform
   is a promise I cannot keep. This is a credibility issue as much as a
   technical one.

### Design questions you must answer

- **Trigger model.** Evaluate: dead-man's-switch heartbeat (tenant checks in
  every N days; missed check-ins plus grace period arm the box), nominated
  trustee approval, manual arming, or a combination. Recommend one and state
  the failure modes of each. What if they are simply on holiday? What if the
  app itself is down?
- **Key custody.** Where does the decryption key live so it is *not* usable by
  the running application in normal operation but *is* recoverable in the
  trigger scenario? Evaluate envelope encryption with a client-held key,
  split-key/Shamir with a trustee, escrow, and time-locked release. Be honest
  about which are over-engineering. Note that as the platform operator I must
  be *unable* to read box contents — that is the whole point, and it also
  limits my liability.
- **"Exactly once" enforcement.** What does it mean technically and in
  practice? If the download fails mid-transfer, is the client locked out of
  their own data forever? Design a defensible answer.
- **Abuse and accident.** A curious client opening the box out of impatience is
  a real risk. Design the friction: confirmation flow, plain-language warning,
  cooldown, notification, possibly trustee approval.
- **Contents template.** Propose a standard checklist: domain registrar and
  DNS, hosting and deployment accounts, repository access, third-party
  services, environment variables and where the real secrets live, architecture
  notes, known issues, handover instructions, recommended successor developers.
  Storing live credentials in the app is itself a risk — evaluate storing
  *pointers and instructions* (how to recover accounts, where the password
  vault lives, who holds emergency access) versus the secrets themselves. I
  lean toward pointers; argue me out of it if you disagree.
- **Legal reality.** The technical mechanism is the easy half. Who is legally
  empowered to trigger it, and whether the arrangement holds, needs a lawyer.
  As a SaaS this compounds: I am providing a mechanism other companies rely on
  for *their* continuity obligations. Do not give me legal advice — give me the
  list of questions to take to a Swedish lawyer, and flag what the terms of
  service must disclaim.

Prior art worth researching: source code escrow, dead man's switch services,
key ceremonies, digital legacy features in password managers, business
continuity clauses in agency contracts.

---

## 9. Security and data protection

- **GDPR chain.** Tenants are controllers (or processors) for their clients'
  data; I am their processor and a sub-processor further down. I need a DPA to
  offer tenants, a sub-processor list, and a documented lawful basis for any
  platform access to tenant data. Data stays in the EU — this rules out
  infrastructure without EU residency, including some auth vendors (§10.1).
- MFA available everywhere, mandatory for platform and for tenant
  owner-equivalent roles.
- Files served via short-lived signed URLs. Never public buckets. Signed URLs
  must themselves be authorization-checked at issue time, not just at upload.
- **Append-only audit log** with tenant, actor, action, target, and timestamp
  on every privileged operation: role and permission changes, entitlement
  changes, exports, file downloads, impersonation, and every continuity-box
  event. Two audiences — the tenant's own log and my platform log — but one
  event model and one capture mechanism, not two systems.
- Encryption at rest for sensitive fields, not just disk-level.
- Retention policy per entity type; export and deletion paths per tenant and
  per client.
- Rate limiting and abuse protection on the portal, which is the surface with
  the least-trusted users.

---

## 10. Open questions to research before proposing

**10.1 Auth.** Recommend an approach covering: global identity with
tenant-scoped membership, three principal types, invite-only flows, MFA, and
future SSO for larger tenants. Compare self-hosted (Better Auth's organization
plugin, Auth.js, SuperTokens) against hosted (Clerk, WorkOS, PropelAuth, Kinde)
on cost curve, lock-in, and — decisively — **EU data residency**. My reading is
that Clerk currently has no EU residency option, which would disqualify it for
Swedish clients regardless of DX; verify this before recommending anything, and
check whether it has changed. Note that hosted org models often assume one role
per member per org, which conflicts with §3 — check before committing.

**10.2 Swedish and US invoicing.** Legal content requirements, VAT/moms rules
for Swedish vs US clients, reverse charge, invoice numbering and archiving
obligations. Should tenants integrate with Fortnox/Bokio rather than have me
reimplement bookkeeping? Where is the line between "invoice record" and
"accounting system"? Multi-country tenants make this worse — scope it honestly.

**10.3 E-signature** in Sweden, proportionate to small tenants, including
BankID-based options.

**10.4 Branding and domains.** Subdomain per tenant vs path-based vs custom
domain. Subdomain-per-tenant with wildcard DNS on Vercel is the likely sweet
spot; custom domains are a premium-tier feature with domain verification and
certificate management. Confirm cost and operational burden, and check that the
chosen auth solution handles cookies across subdomains cleanly — that is a
known source of pain.

**10.5 Performance data ingestion** — manual upload vs Search Console/GA4 API
sync, and the OAuth burden of each when every tenant must connect their own
clients' properties.

**10.6 File storage** — R2 vs alternatives, given per-tenant quotas, signed
URLs, versioning, lifecycle rules, and egress cost.

**10.7 Everything in §8.**

**10.8 Competitive landscape.** Look at SuiteDash, Copilot, Moxie, Bonsai,
Plutio, Accelo, and Notion-based setups. Bring back: features I did not ask for
that clearly earn their place; features I asked for that are not worth building
yet; and the two or three decisions that will be expensive to reverse. Mark
each **v1 / v2 / skip** with a one-line reason. I decide.

---

## 11. Build phases (proposed — revise in `PLAN.md`)

Tenancy, permissions, and audit are **foundations, not features**. Everything
after Phase 1 assumes them. Never retrofit tenancy.

- **Phase 1 — foundation.** Tenants, members, identity, tenant-scoped roles and
  permissions, isolation enforcement (extension + RLS + CI tests), audit log,
  file storage with visibility flags. Naxdor as tenant zero.
- **Phase 2 — core domain.** Clients, contacts, projects, timeline and
  versions, documents.
- **Phase 3 — client portal.** Read surfaces: projects, timeline, files,
  services. Invite flows.
- **Phase 4 — money.** Contracts, invoices, services, renewals.
- **Phase 5 — collaboration.** Issues (bug / idea / requirement), comments,
  notifications.
- **Phase 6 — performance reports and dashboards.**
- **Phase 7 — productization.** Entitlements, plans, Stripe subscriptions,
  tenant self-signup and onboarding, branding, platform admin console.
- **Phase 8 — continuity box**, built on the audit and encryption foundations
  from Phase 1, at both tenant and platform level.

Note the ordering: I run the product myself before I sell it. Phases 1–6 make
Naxdor's system real; Phase 7 turns it into a SaaS. Tell me if you think
productization should come earlier and why.

---

## 12. Rules of engagement

- Ask before assuming on anything in `OPEN_QUESTIONS.md` that blocks Phase 1.
- Keep `PLAN.md` as the source of truth; mark progress there.
- Small, reviewable commits. Tests for tenant isolation, client-level scoping,
  file visibility, and privilege escalation are non-negotiable.
- Swedish and English throughout; no hardcoded strings. Tenants may later need
  other languages — do not assume two.
- Nothing Naxdor-specific in the schema or UI. If it only makes sense for my
  agency, it is a tenant setting, not a table.
- When you disagree with this brief, say so in the doc rather than silently
  building something else.
