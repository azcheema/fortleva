# TENANCY.md — Tenant Model, Isolation Strategy, Enforcement

**Doc status:** Phase 0 specification, for founder review. Covers brief §5 (both isolation boundaries), with §7 (platform access) and §9 (EU residency) where they touch the database. No application code — the SQL below is policy sketch, the TypeScript below is interface sketch.

**Related docs:** ARCHITECTURE.md (stack, tenant-resolution seam), AUTHZ.md (permission model, assignment scoping), DATA_MODEL.md (full schema; physical column names), SECURITY.md (threat model, DPA/CLOUD Act notes, break-glass), CONTINUITY_BOX.md (box crypto — explicitly *not* an RLS problem).

**Naming convention:** entities use the canonical names (Tenant, Client, Contact, …). SQL sketches use snake_case physical names (`project`, `tenant_id`) — **not illustrative**: DATA_MODEL.md §1.3 fixes the physical mapping as `@@map`/`@map` snake_case for every model and field, precisely so the policies, `REVOKE`s and triggers below resolve as written without quoting.

**Enum values are canonical, not illustrative** either: every literal in the SQL below (`'CLIENT_VISIBLE'`, `'TENANT'`, …) is the exact Prisma enum value from DATA_MODEL.md §1.3, which is the naming authority. A policy compiled against a lowercase spelling matches zero rows and fails silently open-looking (the portal shows nothing) — so these strings are copied, never paraphrased.

---

## 1. Tenant model

One codebase, one Postgres database (Neon, Frankfurt — §9, §9.1 below), one schema. Every tenant-owned row carries a `tenantId` column, `NOT NULL`, indexed first. Scale target is tens of tenants with tens of clients each (§1); we optimize for **correctness, isolation, and low operating cost**, not hypothetical scale.

There are **two isolation boundaries, not one** (§5):

- **B1 — tenant ↔ tenant.** A Member or Contact of tenant A must never read or write tenant B's rows. Enforced by four layers (§3).
- **B2 — client ↔ client inside a tenant, plus the visibility dimension.** A Contact of client C1 must never see C2's data, and must never see anything marked `internal` — even within their own client. The brief is right that B2 is the one people forget, and that leaking an internal file to a client is the worst bug this product can have. Enforced at the data layer (§7), not the UI.

### 1.1 Table ownership classes

| Class | Entities | `tenantId` | Enforcement template |
|---|---|---|---|
| **Tenant root** | Tenant (entitlements JSON lives here) | its own `id` | self-policy (`id = app.tenant_id`) for runtime; writes to plan/entitlements only via platform plane |
| **Tenant-owned** | Member, Role, RolePermission, MemberRole, MemberClient, MemberProject, Client, Contact, Project, ProjectVersion, Milestone, Service, Contract, ContractSignature, InvoiceSeries, Invoice, InvoiceLine, Document, FileObject, FileVersion, Issue, IssueComment, PerformanceReport, ContinuityBox, ContinuityOpenRequest, TenantPreference | required, `NOT NULL` | tenant policy + a portal RESTRICTIVE policy (§6, §7) |
| **Client-scoped subset** | the tenant-owned tables that also carry `clientId` (Contact, Project, Contract, Invoice, InvoiceLine, Document*, Issue, ContinuityBox, ContinuityOpenRequest, PerformanceReport, and project children by denormalization — exact set fixed in DATA_MODEL.md) | required | adds composite FK `(tenantId, clientId)` (§8) and portal gate (§7.2) |
| **Global (plane-shared)** | User (member auth identity), Contact-credential/session tables, Permission (catalog), FeatureFlag, StripeWebhookEvent (platform webhook idempotency ledger) | none | role grants only; accessed by the auth layer pre-tenant-context; **never** portal- or tenant-readable directly |
| **Mixed** | AuditEvent (`tenantId` nullable; `NULL` = platform-plane event) | nullable | INSERT-only for runtime; tenant reads filtered by `tenantId` + `visibility='TENANT'`; append-only enforced by grants + trigger (SECURITY.md) |

\* `Document.clientId` is **nullable** — a tenant-internal document has no client. Under the portal gate (§7.2) a `NULL clientId` can never equal a contact's `app.client_id`, so unattached documents are invisible to contacts by construction. Fail-closed.

Rules that keep this table honest:

- **Junction tables carry `tenantId` too** (RolePermission, MemberRole, MemberClient, MemberProject), denormalized, with composite FKs to their parents — so RLS and constraints apply uniformly and no join is needed to police them.
- **Portal-readable rows denormalize `clientId`** (e.g. ProjectVersion, Milestone, InvoiceLine carry it even though their parent already does) so the portal RLS gate is a column comparison, never a per-row subquery. Safe because a Project never moves between Clients (invariant, DATA_MODEL.md).
- A new model without `tenantId` **fails CI** unless explicitly allowlisted as global (§11).

---

## 2. Isolation strategy — decision and comparison

**Decision (v1): shared database, shared schema, `tenantId` on every tenant-owned row, enforced by a layered stack (§3), with a physical-isolation escape hatch built into the schema from day 1 (§10).** This validates the brief's recommended approach (§5) — with one material adjustment to *how* the Prisma layer enforces it (§4).

| | **Shared schema + tenantId (chosen)** | Schema-per-tenant | Project-per-tenant (Neon) |
|---|---|---|---|
| Prisma support | First-class | **Effectively unsupported** — [`multiSchema` is static](https://www.prisma.io/docs/orm/prisma-schema/data-model/multi-schema) (schema names hard-coded per model); dynamic schema selection is an open feature request ([#24928](https://github.com/prisma/prisma/issues/24928)) | Works (one client per project) but needs per-tenant URLs + client pools |
| Migrations | One `prisma migrate deploy` | Hand-rolled per-schema scripting, ×N fan-out | ×N fan-out across projects |
| Platform-plane queries (§7: health, billing, usage) | Plain SQL across tenants | Cross-schema unions, painful | **No cross-tenant SQL at all** — fan-out or ETL |
| Isolation strength | Logical (4 layers, §3) | Logical (search_path mistakes replace WHERE mistakes; RLS still needed for B2) | Physical — strongest |
| Cost at tens of tenants | One Neon project, ~$5–20/mo | Same DB cost, high ops cost | Dollar-modest ([scale-to-zero](https://neon.com/docs/guides/multitenancy) makes idle tenants ≈$0; ~30 active tenants ≈ $190/mo worst case at [current pricing](https://neon.com/pricing)) but operationally expensive |
| Verdict | **v1** | **Rejected** — worst of both worlds with Prisma | **Rejected as default; kept as the escape hatch** (§10). Neon officially promotes it, so it remains credible when a single tenant demands physical isolation |

Also evaluated: **ZenStack** (access policies declared on the Prisma schema — a genuinely good fit for the visibility model on paper, but its v3 rewrite was still beta as of late 2025; adopt only via a deliberate spike later — **v2-watch, not v1**), and policy engines for isolation (**skip** — see AUTHZ.md; isolation is a data-layer property here, not a policy-engine problem).

**What changes if a tenant later demands physical isolation** (brief §5 asks directly): nothing in the application, because the per-tenant client factory and `Tenant.databaseUrl` seam exist from day 1 — see §10 for the extraction runbook.

---

## 3. Enforcement stack — four layers plus structure

No single mechanism is trusted. Each layer independently catches the failure of the one above it:

1. **`withTenant()` unit-of-work (§4)** — *primary.* Correct tenant context by construction: one transaction, GUCs set first, all work inside.
2. **Prisma `$extends` where-injection (§5)** — *second belt.* Catches the developer who forgets a filter on the 95% path; has known holes, each closed elsewhere.
3. **Postgres RLS (§6)** — *defense in depth.* The database filters rows itself; catches raw SQL, nested writes, and bugs in layers 1–2.
4. **CI adversarial isolation suite (§11)** — catches regressions in all of the above, on every PR.

Plus **structural enforcement** that is not a "layer" but schema fact: composite FKs and tenant-scoped uniques (§8) make many cross-tenant writes a constraint violation regardless of code.

**The one-seam rule:** no code path reaches the database except through `withTenant()` (or `withPlatform()`, §12). The base Prisma client is module-private; an ESLint `no-restricted-imports` rule blocks importing it anywhere else. This is the same "the interface is the insurance" principle AUTHZ.md applies to `authorize()`.

---

## 4. Layer 1 — the `withTenant(tenantId, principal, fn)` unit-of-work (v1)

### 4.1 Design

```ts
// Interface sketch (spec artifact, not implementation)
withTenant<T>(
  tenantId: string,               // from the tenant-resolution seam (session), never from request params
  principal: Principal,           // { type: 'member'|'contact'|'platform_admin'|'system', id, clientId? }
  fn: (tx: TenantDb) => Promise<T>,
  opts?: { timeoutMs?: number }
): Promise<T>
```

Behavior, in order:

1. Open **one interactive transaction** on the pooled runtime connection (role `app_runtime`, §9.2).
2. First statement, single round trip, parameterized:
   `SELECT set_config('app.tenant_id', $1, true), set_config('app.principal', $2, true), set_config('app.client_id', $3, true);`
   (`app.client_id` set only for `contact` principals; `tenantId` validated as a UUID before binding.)
3. Run `fn(tx)` — every query in the request's unit of work executes on `tx`, inside the same transaction, under the same GUCs.
4. Commit or roll back. Either way the GUCs die with the transaction.

`tenantId` comes from the session/tenant-resolution seam (single app domain in v1 per settled decision #8, with the hostname→tenantId lookup stubbed in the resolver — ARCHITECTURE.md); the principal comes from the session. Neither is ever derived from client-supplied identifiers.

### 4.2 Why the third argument `true` is critical

`set_config(name, value, is_local)` with `is_local = true` scopes the setting to the **current transaction**; with `false` it is **session-scoped** — it lives on the underlying server connection until that connection closes.

Neon's pooled endpoint (the `-pooler` connection string) is [PgBouncer in transaction mode](https://neon.com/docs/connect/connection-pooling): a server connection is assigned to a client **for exactly one transaction**, then returned to the pool. Two consequences:

- **`is_local = false` leaks tenant identity.** The session-scoped GUC survives COMMIT on the server connection, and the next borrower — a different request, a different tenant — inherits `app.tenant_id`. RLS then happily serves them the previous tenant's rows. This is the classic multi-tenant RLS failure, and it passes every single-request test.
- **Setting the GUC outside a transaction is meaningless.** Consecutive statements without a transaction may land on *different* server connections, so a separate `SET` followed by a query enforces nothing.

Transaction-local GUCs align the context's lifetime exactly with the pooler's pinning unit. This is a code-review rule ("the third argument is always `true`") *and* a CI regression test (§11: after a committed `withTenant`, a fresh no-GUC transaction on the same pool must see zero rows). Note also that transaction mode does not support session-level `SET`, `LISTEN/NOTIFY`, or SQL-level `PREPARE` — no design here may rely on session state, ever.

### 4.3 Why Prisma's official per-query RLS extension was rejected

Prisma's own [row-level-security client-extension example](https://github.com/prisma/prisma-client-extensions/tree/main/row-level-security) — the top search result and the pattern most LLMs will suggest — wraps **every individual query** in a batch transaction: `$transaction([$executeRaw set_config(...), query])`. Rejected as the primary mechanism because:

- Its own README states it is **"not intended to be used in production"**.
- It documents that explicit `$transaction()` calls **"may not work as intended"** — every query already opens its own batch transaction, so multi-statement units of work cannot be made atomic *with* tenant context. This product has hard transactional invariants — gap-free invoice numbering (DATA_MODEL.md), last-owner and escalation guards (AUTHZ.md), audit rows written in the same transaction as the mutation (SECURITY.md) — that are unbuildable on a per-query-transaction pattern.
- Per-query transaction overhead on every read.
- It does not close the nested-write hole anyway (§5).

`withTenant()` inverts the shape: **one transaction per request unit-of-work**, not per query. Multi-statement invariants come back for free, and the GUC round trip is paid once per request instead of once per query.

Practical notes: Prisma interactive-transaction defaults (`maxWait`/`timeout` ≈ 5 s) are kept deliberately low; long-running jobs chunk their work into multiple `withTenant` units rather than raising timeouts globally.

---

## 5. Layer 2 — the thin `$extends` where-injection extension (v1)

A minimal query-hook extension on `$allModels.$allOperations` that (a) injects `where: { tenantId }` into finds, updates, deletes, counts, aggregates, and groupBys, and (b) stamps `tenantId` into create data. Its job is the brief's "a developer cannot forget the filter — because they never write it" (§5) on the common path. It is **belt two, not the mechanism**, because it has known escape hatches ([prisma discussion #19917](https://github.com/prisma/prisma/discussions/19917)):

| Escape hatch | Why it escapes the extension | How it is closed |
|---|---|---|
| **Nested writes / `connect` / `connectOrCreate`** | The query hook fires only for the **top-level** operation; nested args can reference another tenant's rows by id | **Composite FKs** `(tenantId, clientId) → Client(tenantId, id)` etc. (§8) make the cross-tenant reference a constraint violation; RLS `WITH CHECK` (§6) rejects it too |
| **`findUnique` on a globally-unique field** | Unique selectors can't accept an injected extra `where` | Business uniques are **tenant-scoped compound uniques** (`@@unique([tenantId, …])`, §8.2) so the selector must include `tenantId`; the extension rewrites bare-id `findUnique` → `findFirst` + `tenantId`; RLS filters regardless |
| **`$queryRaw` / `$executeRaw`** | The hook can intercept raw ops but **cannot safely rewrite SQL** | Raw queries are only reachable *inside* `withTenant` (the `tx` client), so the GUC is set and **RLS filters the SQL itself**; lint confines raw usage to the data layer |
| **Explicit `$transaction` on the base client** | Bypasses the wrapper's semantics entirely | The base client is **never exported** (module-private + ESLint `no-restricted-imports`); the only exported entry points are `withTenant`/`withPlatform` |

`prisma-extension-nested-operations` (a community package that rewrites nested operations) was evaluated and rejected — it adds a dependency and complexity to partially solve what composite FKs + RLS already close deterministically.

---

## 6. Layer 3 — Row-Level Security, done correctly on Neon (v1)

RLS is defense in depth (§5): even a hand-written raw query, an ORM bug, or a layer-1 mistake is filtered by the database itself. Three Neon-specific traps must be engineered around, or RLS silently enforces nothing.

### 6.1 The Neon BYPASSRLS trap

Roles created through the Neon Console, API, or CLI are members of `neon_superuser`, which has **BYPASSRLS** ([Neon: manage roles](https://neon.com/docs/manage/roles)) — for such roles, RLS policies are ignored *silently*. Every test passes; nothing is enforced. Additionally, **table owners bypass RLS by default** in Postgres — so the migration role reads everything unless forced not to.

Mandatory setup, kept in versioned Prisma migration SQL (policies drifting outside migrations is a real failure mode):

1. Create the runtime role **via SQL**, not the console: `CREATE ROLE app_runtime LOGIN PASSWORD ...;` (no `neon_superuser` membership, no BYPASSRLS).
2. On **every** tenant-owned table: `ALTER TABLE … ENABLE ROW LEVEL SECURITY; ALTER TABLE … FORCE ROW LEVEL SECURITY;` — `FORCE` subjects even the table owner to policies.
3. **Verify, in migration smoke test and CI** (§11): `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('app_runtime','app_platform');` — expect `rolbypassrls = false` for `app_runtime`; and check `pg_class.relrowsecurity AND relforcerowsecurity` for every tenant-owned table.

### 6.2 Tenant policy template

Applied mechanically to every tenant-owned table (Tenant root uses `id` instead of `tenant_id`):

```sql
ALTER TABLE project ENABLE ROW LEVEL SECURITY;
ALTER TABLE project FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON project
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)::uuid))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)::uuid));
```

Two load-bearing details:

- **InitPlan wrapping.** `(SELECT current_setting(...))` forces Postgres to evaluate the setting **once per statement** (an InitPlan) instead of once per row. Naked `current_setting()` in a policy is re-evaluated per row — the [documented trap](https://github.com/orgs/supabase/discussions/14576) that turns 5 ms queries into 5 s on 100k rows. Verified with `EXPLAIN (ANALYZE, BUFFERS)` on hot paths; benchmarks put correctly-indexed RLS overhead at ~2–6%, which we accept.
- **Fail-closed NULL.** The second argument `true` is `missing_ok`: an **unset** GUC yields `NULL`, `tenant_id = NULL` evaluates to `NULL`, the row is not visible, and `WITH CHECK` rejects writes. No context ⇒ **zero rows**, never all rows. (A malformed non-empty value fails the `::uuid` cast loudly — also acceptable: fail closed, noisily.)

### 6.3 Coverage

- **All tenant-owned tables** get the template — see Pushback below.
- **AuditEvent:** `app_runtime` gets INSERT + SELECT only (UPDATE/DELETE revoked and trigger-blocked — SECURITY.md); the SELECT policy adds `visibility = 'TENANT'` so tenant members read exactly their own tenant-visible trail; platform events (`tenant_id IS NULL`) are invisible to runtime.
- **Global tables** (User, contact-credential/session tables, Permission, FeatureFlag) are *not* under the tenant template — auth flows run before tenant context exists and would break. They are protected by role grants, are reachable only from the auth/data layer, and carry a `portal_deny` restrictive policy where applicable (§7.2).

> **Pushback (brief §5).** The brief scopes RLS to "the sensitive tables." This spec applies it to **every tenant-owned table** via the mechanical template above. Per-table sensitivity triage is itself the leak vector — the table someone judged "not sensitive" (a junction table, a comment table) is exactly where the forgotten filter ships, and B2 makes almost every table sensitive to *someone*. Blanket application costs ~2–6% and one migration template; the CI posture check (§11) then makes "table exists without RLS" a build failure instead of a judgment call. The decided approach (RLS as defense-in-depth) is unchanged — only its coverage is widened.

RLS caveats we do not paper over: RLS filters rows, it does not stop query execution or replace app-layer authorization and rate limiting ([PlanetScale's critique](https://planetscale.com/blog/rls-sounds-great-until-it-isnt) is fair); and the continuity box's "open exactly once" is an application-level state machine plus cryptography (CONTINUITY_BOX.md) — RLS must not create false confidence there.

---

## 7. The second boundary — client ↔ client scoping and visibility (v1)

### 7.1 The visibility dimension

Every file, note, and field-bearing surface carries `visibility: INTERNAL | CLIENT_VISIBLE` (the `Visibility` enum, DATA_MODEL.md §1.3), **default `INTERNAL`** (§5). Defaulting internal means *forgetting the flag fails safe* — the worst bug (internal → client) requires an explicit act, which is permission-gated (`document:change_visibility`, AUTHZ.md §3.2) and audited (`document.visibility_changed`, SECURITY.md).

Column placement rule (DATA_MODEL.md enumerates): **any row a portal query can render either carries `(clientId, visibility)` itself or is unreachable by portal queries.** Content tables (Document, ProjectVersion, Milestone, IssueComment, PerformanceReport) carry `visibility`; structural client rows (Contact, Issue, ContinuityBox, Invoice, Contract) are gated by client match plus **status** where lifecycle applies (an Invoice is portal-visible only once issued/sent; a Contract only once sent — status gates live in queries *and* in the portal capability layer, AUTHZ.md). FileObject/FileVersion are never queried by contacts directly: portal downloads exist only as short-lived signed URLs issued *after* a data-layer check of the owning Document's visibility (SECURITY.md).

### 7.2 The portal gate — RESTRICTIVE policies

Postgres **permissive** policies OR together — adding a permissive "portal" policy would *widen* access. The portal gate is therefore `AS RESTRICTIVE` (ANDed), keyed on the `app.principal` / `app.client_id` GUCs set by `withTenant` (§4.1). Two templates:

**Default-deny for contacts — on every tenant-owned table:**

```sql
CREATE POLICY portal_deny ON member_role
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');
```

**Portal-visible tables replace `portal_deny` with the gate** (shown with the visibility variant; structural tables use the client-match-only variant):

```sql
CREATE POLICY portal_gate ON document
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR (
      client_id = (SELECT current_setting('app.client_id', true)::uuid)
      AND visibility = 'CLIENT_VISIBLE'
    )
  )
  WITH CHECK (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR client_id = (SELECT current_setting('app.client_id', true)::uuid)
  );
```

Properties: a `contact` principal sees only `CLIENT_VISIBLE` rows of **their own client**; `INTERNAL` rows of their own client are invisible; other clients' rows are invisible; rows with `NULL client_id` are invisible; contact writes cannot target another client. Member principals are untouched by the gate (first disjunct), and their client-level scoping happens in the app layer (§7.3).

**The contact-writable set, enumerated exactly** (asserted in CI, §11 — a model entering this set is a deliberate, reviewed change):

| Table | What a contact may write | Note |
|---|---|---|
| `Issue` | INSERT (own client), and only the reporter-authored fields | app forces `CLIENT_VISIBLE` + `clientId` |
| `IssueComment` | INSERT (own client) | app forces `CLIENT_VISIBLE` |
| `ContinuityOpenRequest` | INSERT + withdraw | `CONTACT_PRIMARY` profile only (AUTHZ.md §8, CONTINUITY_BOX.md §3.2) |
| `ProjectVersion` | UPDATE of the **approval columns only** (`approvalStatus`, `approvalDecidedAt`, `approvalByContactId`, `approvalNote`) | decision #7 sign-off; the column allowlist is enforced in the service layer, the row is already gated by the portal policy |

**Contact file uploads do not widen this set — they are brokered** (decided; stated identically in DATA_MODEL.md §2.3 and SECURITY.md §5). An issue attachment is not a contact-principal INSERT into the file layer: the server action runs `authorizePortal()` first, then re-enters `withTenant()` as the **`system` principal** to create the `Document` / `FileVersion` / `FileObject` rows (forced `clientId` = the contact's client, forced `CLIENT_VISIBLE` on the `Document`). `FileObject`/`FileVersion` therefore keep `portal_deny` with **no INSERT exception**, `Document` stays writable only by members and the system principal, and the `createdByContactId` / `uploadedByContactId` columns in DATA_MODEL.md are **attribution only** — who caused the upload, never who performed the write. The alternative (a narrow INSERT-only portal policy on the file layer) was rejected: it puts a write grant on the exact tables whose accidental exposure §1 calls the worst bug this product can have, to save one server-side principal switch.

This satisfies the brief's §2 rule structurally: between a portal Contact and another tenant's (or client's) data stand a separate route group, a separate session audience (decision #6), the principal GUC, and a database-enforced RESTRICTIVE policy — a role check is never the only thing.

### 7.3 Staff-side scoping stays in the app layer — deliberately

Member↔client and member↔project scoping (MemberClient, MemberProject; deny-by-default with `client:view_all` seeded on CEO/Manager/Admin templates — settled decision #5) is enforced by the authorization seam (`authorizedClientIds()` → Prisma `where`), **not** by RLS. Reasons: the rule is permission-dependent (`client:view_all` flips it), it changes shape with product needs, and it belongs beside the escalation guards in AUTHZ.md. RLS carries the *hard* boundaries (tenant, contact); assignment scoping is a product-correctness concern with its own deny-matrix tests. Consequence, stated honestly: a bug in the assignment filter can leak client A's data to an unassigned **member of the same tenant** — a real defect, but contained inside one tenant's staff, an order less severe than B1/B2 breaches. The CI suite still covers it (§11).

---

## 8. Structural discipline — FKs, uniques, indexes (v1)

### 8.1 Composite foreign keys

Every client-scoped table references its parent with the tenant id *in* the key:

```sql
ALTER TABLE project
  ADD CONSTRAINT project_client_fk
  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, id);
```

Parents carry a redundant `@@unique([tenantId, id])` as the FK target (cheap; PK on `id` remains). Same pattern one level down: `(tenant_id, project_id) → project(tenant_id, id)`, `(tenant_id, role_id) → role(tenant_id, id)`, etc. Effect: a nested write, `connect`, or hand-written INSERT that crosses tenants (or attaches a project to another tenant's client) violates a constraint **even if every code layer fails**. This is the specific closure for the extension's worst escape hatch (§5).

### 8.2 Tenant-scoped uniques

Every business uniqueness is compound with `tenantId`: `@@unique([tenantId, name])` on Role, `@@unique([tenantId, seriesId, number])` on Invoice, etc. Two effects: tenants can't collide, and `findUnique` callers are *forced* to supply `tenantId` (closing escape hatch (b) in §5). Globally-unique fields exist only on global tables (e.g. `User.email`).

### 8.3 Index rule

**Every secondary index on a tenant-owned table leads with `tenantId`** (§5): `@@index([tenantId, clientId])`, `@@index([tenantId, status, dueDate])`, … The RLS predicate then hits the same leading column, keeping policy evaluation index-supported (the other half of the ~2–6% overhead claim). Primary keys stay `id` (UUID; v7 preferred for insert locality — DATA_MODEL.md). Hot queries get `EXPLAIN (ANALYZE, BUFFERS)` spot checks for InitPlan presence and index use.

---

## 9. Database topology — region, roles, connections (v1)

### 9.1 Region: Neon Frankfurt, decided once

The Neon project is created in **AWS Frankfurt `aws-eu-central-1`** — the EU region. **London `aws-eu-west-2` is the UK, not the EU** (adequacy-decision territory ≠ EU residency; brief §9 makes EU non-negotiable), and Neon's Azure regions are deprecated for new projects. **Region is immutable per project** ([Neon regions](https://neon.com/docs/introduction/regions)) — moving later means a new project plus full migration, so this is a create-day decision (listed as *blocks Phase 1* in OPEN_QUESTIONS.md).

Jurisdiction honesty for SECURITY.md's DPA: Neon is a US-owned company (Databricks). Frankfurt satisfies GDPR data-*location*; it does not insulate from US jurisdiction (CLOUD Act). If a tenant contract ever demands EU-*controlled* processing, that is a vendor change, not a config change — disclosed in the sub-processor list now, and one more reason the physical-isolation seam (§10) allows a per-contract cell.

### 9.2 Separate roles, separate URLs

| Role | Created via | Attributes | Grants | Used by | Connection |
|---|---|---|---|---|---|
| `app_migrate` (owner) | Neon default | owner; **subject to FORCE RLS** on DML | DDL, owns objects | Prisma Migrate, seeds | `DIRECT_URL` (unpooled — [Prisma × Neon guidance](https://www.prisma.io/docs/orm/v6/overview/databases/neon)) |
| `app_runtime` | **SQL migration** (§6.1) | LOGIN, **no BYPASSRLS**, no DDL | SELECT/INSERT/UPDATE/DELETE on app tables; **INSERT+SELECT only on `audit_event`** (UPDATE/DELETE revoked) | `withTenant()` | `DATABASE_URL` (pooled, `-pooler`) |
| `app_platform` | SQL migration | LOGIN, **BYPASSRLS (deliberate, audited)** | read-mostly; writes on platform-owned surfaces (Tenant provisioning, entitlements) | `withPlatform()` (§12) | separate env var, loaded only by platform-plane code |

The runtime-restricted vs migrate-owner split is set up in **Phase 1** — Neon's default role is owner-level, and retrofitting connection roles across Migrate (needs elevation) and runtime (must not have it) later is fiddly and risky.

Pooling facts we rely on: the pooled endpoint is PgBouncer in transaction mode, up to 10,000 client connections, with roughly `0.9 × max_connections` concurrently active transactions (≈377 at 1 CU) — ample at target scale. The app runs on Vercel's Node runtime with standard Prisma over TCP. The **Neon serverless driver's HTTP mode is single-shot and cannot run interactive transactions** — it is *incompatible* with the `set_config`-in-transaction pattern and must not be used; WebSocket mode would be the only option if an edge runtime were ever adopted (it is not — ARCHITECTURE.md).

---

## 10. The physical-isolation escape hatch (schema seam **v1**, execution **v2**)

Day-1 provisions, deliberately cheap:

- `Tenant.databaseUrl` — nullable; when set, this tenant's data lives elsewhere. It is a credential: encrypted at rest by the field-encryption service (SECURITY.md).
- `Tenant.cell` — logical placement label, default `'cell-0'`.
- **Per-tenant client factory:** all data access already resolves its Prisma client through one factory keyed by the tenant's effective URL (default pooled client when `databaseUrl` is `NULL`, cached per URL). `withTenant` calls the factory; nothing else changes.

Extraction runbook (mechanical *because* every row carries `tenantId`):

1. Create a new Neon project (Frankfurt, or per-contract jurisdiction); apply the identical migration history.
2. Copy the tenant's slice: `pg_dump --where "tenant_id = …"` per table for small tenants, or PG15+ **logical replication with row-filtered publications** (`WHERE tenant_id = …`) for minimal downtime.
3. Copy required global rows: the Permission catalog, and the User rows of that tenant's members.
4. Verify per-table counts and checksums; optional dual-read soak.
5. Maintenance window: final delta, set `Tenant.databaseUrl`, invalidate the factory cache.
6. Soak, then delete the source slice. Every step emits platform AuditEvents.

Honest costs once any tenant is extracted: migrations fan out to N cells (CI applies to all), and platform-plane aggregates over extracted tenants go through per-cell connections (fan-out or ETL). That is precisely why this is an escape hatch for the tenant who *demands and pays for* physical isolation — not the default.

---

## 11. CI cross-tenant isolation suite (v1, Phase 1, every PR)

Non-negotiable (§5, §12): adversarial, generated from the schema so new tables cannot dodge it, run on real infrastructure.

- **Model census via Prisma DMMF.** Enumerate `Prisma.dmmf.datamodel.models`; classify each as tenant-owned / client-scoped / visibility-bearing / global. **An unclassified model (no `tenantId`, not explicitly allowlisted global) fails the build.** This converts "every tenant-owned row has tenantId" from convention into a checked invariant.
- **Seed** tenants A and B, with clients C1/C2 inside A, via a DMMF-driven factory graph.
- **Read isolation:** for every tenant-owned model, as B: `findMany` → zero A rows; lookups by A's ids → null; counts/aggregates see only B.
- **Write isolation:** as B: update/delete by A ids → zero affected; **nested `connect` from B's create to A's client/project → constraint or RLS error** (exercises §5's worst hatch and §8.1's closure).
- **Fail-closed:** raw query as `app_runtime` with **no GUC set** → zero rows; writes rejected.
- **GUC-leak regression:** after a committed `withTenant(A)`, a fresh no-GUC transaction on the same pool → zero rows (catches any `is_local=false` regression, §4.2).
- **Portal boundary (B2):** as a contact of C1: only `CLIENT_VISIBLE` C1 rows; `INTERNAL` C1 rows invisible; all C2 rows invisible; staff/junction tables invisible (`portal_deny`); writes outside the C1 slice rejected. Plus the member-assignment deny-matrix (AUTHZ.md) for §7.3.
- **Contact-writable census:** enumerate every model via DMMF and attempt an INSERT/UPDATE as a `contact` principal on each; the set that succeeds must equal **exactly** the §7.2 table (Issue, IssueComment, ContinuityOpenRequest, ProjectVersion approval columns). Any other success — notably `Document`, `FileVersion`, `FileObject` — fails the build. The brokered-upload path is tested separately: `authorizePortal` → `system`-principal `withTenant` produces exactly one `Document` (CLIENT_VISIBLE, contact's client) + one `FileVersion` + one `FileObject` with the contact recorded in the attribution columns.
- **Posture assertions:** every tenant-owned table has `relrowsecurity AND relforcerowsecurity`; `app_runtime` has `rolbypassrls = false`; UPDATE/DELETE on `audit_event` denied.
- **Infrastructure:** each CI run creates an **ephemeral Neon branch**, migrates, seeds, runs the suite **as the real `app_runtime` role**, and deletes the branch. Never localhost-only — a local role is typically owner/superuser, so RLS false-passes ([Neon's own guidance](https://neon.com/guides/test-rls-on-neon-branches)); this also matches [AWS SaaS Lens REL_3](https://wa.aws.amazon.com/saas.question.REL_3.en.html) on continuously testing tenant boundaries.

---

## 12. Platform-plane access — sanctioned bypass, heavily audited (v1)

The platform plane (§7) legitimately needs cross-tenant access: provisioning, entitlement changes, billing sync, usage/health, support. Per the brief, **support access is not a backdoor** — so the bypass is narrow, credentialed, and audited:

- **Its own role and pool.** `app_platform` (BYPASSRLS, §9.2) is loaded **only** by platform route-group code (separate middleware and session per §2). Tenant and portal request paths never hold the credential — the bypass is unreachable from them by construction, not by discipline.
- **One entry point:** `withPlatform(platformActor, reason, fn, { readOnly = true, targetTenantId? })`. Read-only by default; every invocation writes an AuditEvent (`actorType: PLATFORM_ADMIN`, action, target, **mandatory reason**) in the same transaction. Events that touch a specific tenant are written with `visibility: 'TENANT'` — they appear in **that tenant's own audit log**, exactly as §7 requires.
- **Support access** to a tenant's data is an explicit, **time-boxed** grant recorded as auditable state, read-only unless escalated — full rules in SECURITY.md (tied to §7 and the DPA's lawful-basis documentation).
- **Impersonation does not use the bypass role.** "Act as member" runs through ordinary `withTenant()` *as that member*, with `impersonatorId` stamped on the session and every audit row — so RLS and all tenant policies remain fully active during impersonation, and the tenant sees both identities in their log.
- **System jobs** (retention cron, Stripe webhook → entitlements refresh) run as the `system` principal through the same `withPlatform` seam; each write audited.
- **Break-glass** (psql as owner against production) is an incident *procedure* — documented, logged, post-reviewed in SECURITY.md — never a routine tool. Prisma Studio or ad-hoc consoles are never pointed at production with owner credentials.

---

## 13. Scope summary

| Item | Scope |
|---|---|
| Shared schema + `tenantId`; `withTenant` UoW; where-injection extension; RLS (all tenant-owned tables, portal RESTRICTIVE gates); composite FKs + tenant-scoped uniques + tenantId-leading indexes; role split + separate URLs; CI isolation suite on Neon branches; `Tenant.databaseUrl`/`cell` seam; `withPlatform` audited bypass | **v1** (Phase 1 foundations — §11 of the brief: never retrofit tenancy) |
| Subdomain-per-tenant / custom-domain tenant resolution (hostname→tenantId lookup already stubbed in the resolver seam per settled decision #8) | **v2** |
| Physical extraction of a tenant to its own Neon project (runbook §10) | **v2**, on demand — seam ships in v1 |
| ZenStack policy layer | **v2-watch** (deliberate spike only; v3 was beta at research time) |
| Schema-per-tenant; policy-engine-enforced isolation; per-tenant databases as the default | **skip** |

**Open items routed to OPEN_QUESTIONS.md:** Neon project creation in Frankfurt (blocks Phase 1 — region immutable); confirmation that the audit-retention job runs via Vercel cron (pg_cron does not fire on scale-to-zero); DPA language for the Neon/CLOUD-Act nuance (§9.1).
