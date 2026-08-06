# DATA_MODEL.md — Fortleva

**Status:** Phase 0 draft (spec artifact — no migration has been run, no application code exists).
**Date:** 2026-08-03. **Owner docs upstream:** `TENANCY.md` (enforcement mechanics), `AUTHZ.md` (permission catalog, gates), `SECURITY.md` (threat model, key handling), `CONTINUITY_BOX.md` (box protocol).
**This document is the canonical naming authority.** Every other doc uses the entity names defined here, exactly.

---

## 1. Conventions

### 1.1 Vocabulary (brief §1 — law)

| Term | Meaning | Schema entity |
|---|---|---|
| **Tenant** | A company that subscribes | `Tenant` |
| **Member** | A person working at a tenant | `Member` (tenant-scoped) on top of `User` (global identity) |
| **Client** | A customer *of a tenant*; a company record, never a login | `Client` |
| **Contact** | A person at a client; the portal principal | `Contact` (separate identity, own credential/session tables) |
| **Platform** | The layer above all tenants | No table; `AuditEvent.visibility = PLATFORM`, **`User.platformRole = "SUPERADMIN"`** — the authoritative platform flag (AUTHZ.md §9). The Better Auth admin-plugin column `User.role` is vendor plumbing mirrored from it, never read by authorization |

"User" appears in exactly one place: the **auth identity table for members** is called `User` because Better Auth requires it (final decision #6). Nowhere else does "user" mean "member or contact".

### 1.2 Canonical entity names

`Tenant, User, Member, Role, Permission, RolePermission, MemberRole, MemberClient, MemberProject, Client, Contact, Project, ProjectVersion, Milestone, Service, Contract, ContractSignature, InvoiceSeries, Invoice, InvoiceLine, Document, FileObject, FileVersion, Issue, IssueComment, PerformanceReport, AuditEvent, ContinuityBox, ContinuityOpenRequest, TenantPreference, FeatureFlag`.

Supporting models (this doc's additions, still canonical): `Session, Account, Verification, TwoFactor, Passkey` (Better Auth, member side), `ContactSession, ContactAccount, ContactVerification` (portal auth), `MemberInvite`, `TenantCounter`, `StripeWebhookEvent` (webhook idempotency ledger, §6.2), `IntegrationConnection` (v2). Tenant entitlements are a **versioned JSON column `entitlements` on `Tenant`**, not a table (§4).

### 1.3 Scalar conventions

- **IDs:** `String @id @default(uuid(7))` everywhere (Prisma ≥ 5.19). UUIDv7 is time-ordered — b-tree-friendly inserts, sortable by creation, no per-tenant hotspot. No serial integers as PKs; human-facing sequence numbers (invoices, issues) are separate columns.
- **Timestamps:** `DateTime @db.Timestamptz(6)`. `createdAt @default(now())` (DB-side default), `updatedAt @updatedAt`. `AuditEvent.createdAt` is always DB `now()` — never app-supplied.
- **Money:** `Decimal @db.Decimal(12, 2)`; FX rates `@db.Decimal(12, 6)`; VAT rates `@db.Decimal(5, 2)`. Never floats.
- **Currency:** ISO 4217 `String @db.Char(3)`.
- **Emails:** stored lowercase-normalized at write; uniqueness is on the normalized value.
- **Enums:** Prisma enums, `SCREAMING_SNAKE` values. Statuses are enums, not strings, except where a tenant defines the taxonomy (e.g. `Project.type` is free text — nothing Naxdor-specific may be baked in, §12). **Enum *values* defined here are canonical, not illustrative** — every SQL policy, sketch, or prose reference in the other seven docs must quote them exactly as spelled here (`'CLIENT_VISIBLE'`, never `'client_visible'`).
- **Physical naming (decided):** every model gets `@@map` and every field `@map` to **snake_case** physical names (`Project` → `project`, `tenantId` → `tenant_id`, `InvoiceSeries` → `invoice_series`). The mappings are mechanical and are elided from the §6 draft exactly like back-relation fields (see the draft-readability note); the generated Phase-1 schema carries them. Consequence, and the reason the choice is made here: every RLS policy, `FORCE ROW LEVEL SECURITY` statement, `REVOKE`, and trigger in `TENANCY.md` §6–§8 is written against unquoted snake_case identifiers and resolves as written. Prisma's PascalCase defaults are **not** used — they would force quoted, case-sensitive identifiers into every migration artifact.

### 1.4 Per-model annotation legend

Every model in §6 carries a doc-comment trailer:

```
/// scope=…  rls=…  ret=…  enc=…
/// audit: event.one | event.two
```

- **scope** — `platform` (no tenantId), `tenant` (tenantId, staff plane), `client` (tenantId + clientId, portal-relevant), `global-identity` (auth tables), `mixed` (AuditEvent).
- **rls** — RLS class from §2.3.
- **ret** — retention class from §5.
- **enc** — fields encrypted with the app AES-256-GCM field service (`v1.<keyId>.<iv>.<ct>.<tag>` format; key in env v1, seam for per-tenant DEK + KMS later — see `SECURITY.md`).
- **audit** — events this model's mutations emit (namespaced `entity.verb`, from the static catalog, §3).

---

## 2. Tenancy strategy in the schema (§5)

Full enforcement design lives in `TENANCY.md`; the schema commitments are:

1. **Shared database, shared schema.** Every tenant-owned row carries a scalar `tenantId`. No schema-per-tenant (Prisma has no dynamic-schema support), no database-per-tenant in v1 — but `Tenant.cell` / `Tenant.databaseUrl` exist from day 1 so a demanding tenant can later be extracted to its own Neon project mechanically (per-tenant client factory resolves the connection; every row already carries `tenantId`).
2. **Two boundaries.** Tenant ↔ tenant via `tenantId`; client ↔ client inside a tenant via `clientId` + the **`visibility` dimension** (`INTERNAL | CLIENT_VISIBLE`, default `INTERNAL` at the column level — the DB default, not a UI convention). Accidental exposure of an internal file to a contact is the worst bug this product can have (§5); the default is therefore fail-closed in the schema itself.
3. **Composite foreign keys.** Client-scoped children reference `(tenantId, clientId) → Client(tenantId, id)`, project children `(tenantId, projectId) → Project(tenantId, id)`, etc. Parents expose `@@unique([tenantId, id])` as the FK target. This closes Prisma's known nested-write/`connect` escape hatch — a cross-tenant `connect` fails at the constraint, even if the ORM scoping layer slips ([Prisma's own RLS extension example is explicitly not production-grade](https://github.com/prisma/prisma-client-extensions/tree/main/row-level-security)).
4. **RLS as defense in depth** (classes below), evaluated from `set_config('app.tenant_id', $1, true)` inside the `withTenant()` interactive transaction (`true` = transaction-local — mandatory under Neon's transaction-mode pooler). Policies use the `(select current_setting('app.tenant_id', true))` InitPlan form and fail closed on NULL. The runtime role is created via SQL without `BYPASSRLS` ([Neon console roles bypass RLS silently](https://neon.com/docs/manage/roles)) and every tenant table gets `FORCE ROW LEVEL SECURITY`.
5. **Denormalized `tenantId` on every junction and child row** — even where derivable through a join — because RLS policies and leading-`tenantId` indexes need the column on the row itself.

### 2.3 RLS classes

| Class | Policy shape | Models |
|---|---|---|
| **P — platform/global** | No RLS. Global reference or platform-owned data; never exposed to tenant/portal queries directly. | `Permission`, `FeatureFlag`, `User`, `StripeWebhookEvent` |
| **AUTH — auth-managed** | No RLS. Touched only by the auth layer (runs before tenant context exists). Locked down by role grants: only the auth service path reads them. | `Session`, `Account`, `Verification`, `TwoFactor`, `Passkey`, `ContactSession`, `ContactAccount`, `ContactVerification` |
| **A — tenant-strict** | Permissive policy: `tenantId = app.tenant_id`. Staff plane only; a portal principal (`app.principal = 'contact'`) gets zero rows via a restrictive deny policy. | `Member`, `MemberInvite`, `Role`, `RolePermission`, `MemberRole`, `MemberClient`, `MemberProject`, `TenantPreference`, `TenantCounter`, `InvoiceSeries`, `FileObject`, `FileVersion`, `IntegrationConnection` |
| **B — client-scoped** | Class A policy **plus** a RESTRICTIVE portal policy: when `app.principal = 'contact'`, row must satisfy `clientId = app.client_id` AND (where the model has `visibility`) `visibility = 'CLIENT_VISIBLE'`. Restrictive (AND-ed), never permissive (OR-ed) — permissive policies OR together, which is the footgun. | `Client`, `Contact`, `Project`, `ProjectVersion`, `Milestone`, `Service`, `Contract`, `ContractSignature`, `Invoice`, `InvoiceLine`, `Document`, `Issue`, `IssueComment`, `PerformanceReport`, `ContinuityBox`, `ContinuityOpenRequest` |
| **AU — audit** | Append-only: runtime role has INSERT + SELECT only (`REVOKE UPDATE, DELETE`) plus a raise-exception trigger. Tenant reads filter `tenantId = app.tenant_id AND visibility = 'TENANT'`. | `AuditEvent` |
| **T — tenant root** | The `Tenant` row itself: platform plane writes it; tenant plane reads its own row (policy on `id = app.tenant_id`). | `Tenant` |

Notes:
- `FileVersion`/`FileObject` are deliberately class A even though portal downloads exist: the portal never queries the file layer. A portal download resolves through `Document` (class B, visibility-checked), then the server issues an audited, short-lived presigned URL. Signed URLs are authorization-checked at issue time (§9), which is the real gate for bytes.
- **Contacts never write the file layer — uploads are brokered** (decided; stated identically in `TENANCY.md` §7.2 and `SECURITY.md` §5). A contact's issue attachment is not a contact-principal INSERT: the server action runs `authorizePortal(contact, 'portal.issue.create'…)` first, then re-enters `withTenant()` as the **`system` principal** to create the `Document` (forced `clientId` = the contact's client, forced `CLIENT_VISIBLE`), `FileVersion` and `FileObject` rows. `FileObject`/`FileVersion` therefore keep the `portal_deny` RESTRICTIVE policy with no INSERT exception, and `Document.createdByContactId` / `FileVersion.uploadedByContactId` / `FileObject.createdByContactId` are **attribution columns only** — they record who caused the upload, never who performed the write. The contact-writable set is exactly `Issue`, `IssueComment`, `ContinuityOpenRequest`, plus the approval columns of `ProjectVersion` (decision #7 sign-off); CI asserts that set (`TENANCY.md` §11).
- Member↔client/project **assignment scoping (decision #5: deny-default + `client:view_all`) is app-layer**, not RLS — RLS enforces the tenant and portal boundaries; the staff assignment filter is `authorizedClientIds()` in the authorization seam (see `AUTHZ.md`). Fields that are internal-only *within* a client-visible row (e.g. `Client.internalNotes`, `Project.hostingNotes`) are enforced by the portal read-model projection (explicit `select`), since RLS is row-level, not column-level; `TENANCY.md` §column-privileges covers the optional second belt.

---

## 3. Audit strategy in the schema (§9)

One event model, one capture mechanism, two audiences (brief §9):

- **Single `AuditEvent` table.** UUIDv7 id, nullable `tenantId` (NULL = platform-plane event), `actorType` (`MEMBER | CONTACT | PLATFORM_ADMIN | SYSTEM`), `impersonatorId` (set whenever a platform admin acts as a member — both identities always recorded), namespaced `action` from a **static event catalog** that fixes write-time `visibility` (`TENANT | PLATFORM`) per event type — never decided ad hoc at a call site. `metadata` JSONB carries the diff/context; `requestId` is propagated via AsyncLocalStorage; `createdAt` defaults to DB `now()`.
- **Capture:** explicit `audit.record(event)` calls in the service layer, inside the **same `$transaction`** as the mutation they describe. Prisma `$extends` auto-capture is rejected — documented rollback/interactive-transaction problems and CRUD noise that can't drive a tenant-visible activity feed ([prisma/prisma#20016](https://github.com/prisma/prisma/discussions/20016)).
- **Append-only enforcement:** the runtime DB role has no UPDATE/DELETE on the table, plus a `BEFORE UPDATE OR DELETE` raise-exception trigger; Prisma Migrate runs on separate owner credentials (`DIRECT_URL`). Set up early — Neon's default role is owner-level.
- **No foreign keys, by design.** `tenantId`, `actorId`, `targetId` are plain columns. Audit rows must survive deletion of their targets, their actors, and (for `visibility = PLATFORM` events) even the tenant. Referential lookups are by convention.
- **Retention** (class R3, §5): auth events 12 months, admin/impersonation/permission events 24 months ([CNIL's logging recommendation](https://www.cnil.fr/fr/la-cnil-publie-une-recommandation-relative-aux-mesures-de-journalisation) is the only EU-DPA concrete number; IMY publishes none — what matters is a documented, enforced schedule), continuity-box events retained for the life of the box + 24 months. Enforced by a Vercel-cron job under a privileged role (pg_cron does not fire on scale-to-zero). GDPR erasure **pseudonymizes the actor and keeps the event** — never cascade-deletes audit rows.
- **No partitioning** at tens of tenants; `(tenantId, createdAt)` b-tree carries tens of millions of rows. Escape hatch documented in `TENANCY.md`.

### 3.1 Must-capture catalog (write-time visibility in brackets)

| Domain | Events |
|---|---|
| Auth | `auth.login_succeeded`, `auth.login_failed`, `auth.mfa_enabled`, `auth.mfa_disabled`, `auth.password_changed`, `auth.email_changed` [TENANT] |
| Impersonation | `impersonation.started`, `impersonation.ended` — both identities, always [TENANT] (visible to the tenant in their own log, §7) |
| Membership & authz | `member.invited`, `member.joined`, `member.suspended`, `member.removed`, `role.created`, `role.updated`, `role.deleted`, `permission.granted`, `permission.revoked`, `assignment.client_added/removed`, `assignment.project_added/removed` [TENANT] |
| Contacts & portal | `contact.created`, `contact.invited`, `contact.activated`, `contact.suspended`, `contact.access_revoked` [TENANT] |
| Files & visibility | `file.uploaded`, `file.downloaded` (incl. every portal download), `document.visibility_changed` (INTERNAL↔CLIENT_VISIBLE flips are privileged), `document.deleted` [TENANT] |
| Money | `contract.sent`, `contract.signed`, `contract.declined`, `invoice.issued`, `invoice.sent`, `invoice.paid`, `invoice.credited`, `series.created` [TENANT] |
| Data egress | `export.requested`, `export.generated`, `export.downloaded` [TENANT] |
| Continuity box | `continuity_box.sealed`, `.resealed`, `.beneficiary_changed`, `.trustee_changed`, `.open_requested`, `.request_withdrawn`, `.vetoed`, `.escalated`, `.opened` (the once), `.download_issued` (every presign), `.closed` [TENANT] |
| Platform plane | `tenant.provisioned`, `tenant.suspended`, `tenant.offboarded`, `entitlements.changed`, `plan.changed`, `flag.changed`, `platform.tenant_access` (reason-logged support access, §7) [PLATFORM; `entitlements.changed`, `plan.changed`, `platform.tenant_access` mirrored TENANT] |

---

## 4. Field-level encryption inventory (§9)

Mechanism: own ~80-line AES-256-GCM service (`v1.<keyId>.<iv>.<ct>.<tag>`), key in env var at v1, `keyId` in the format so rotation and a later per-tenant-DEK/KMS upgrade are additive. `prisma-field-encryption` rejected (year-stale, Prisma-version-pinned, single maintainer). Encryption is a one-way door for search — the list below is deliberate and closed; adding a field later is easy, removing one is a migration project.

| Field | Why | Notes |
|---|---|---|
| `TwoFactor.secret`, `TwoFactor.backupCodes` | TOTP material | Better Auth stores these; fold into our key inventory, verify hashed/encrypted config |
| `Tenant.bankgiro`, `Tenant.plusgiro`, `Tenant.iban`, `Tenant.bic` | Bank details (printed on invoices via snapshot at issuance) | Decrypt only in the invoice-issuance path |
| `Tenant.databaseUrl` | Connection string = credentials | Unused in v1 (cell escape hatch); see Pushback P3 |
| `ContinuityBox.shareBCiphertext` | Shamir share B | A single share is information-theoretically useless alone; wrapping it is defense in depth, not the guarantee |
| `IntegrationConnection.credentialsCiphertext` (v2) | OAuth refresh tokens, API keys (Fortnox, Google, tenant Stripe) | One row per connection; never in logs |

**Deliberately NOT encrypted:** `Tenant.orgNr` / `Client.orgNr` and VAT numbers — Swedish organisationsnummer are public registry data (Bolagsverket) and must be printed on invoices ([ML 2023:200 17 kap. 24 §](https://www.skatteverket.se/foretag/moms/saljavarorochtjanster/momslagensregleromfakturering.4.58d555751259e4d66168000403.html)). **Caveat (enskild firma):** a sole trader's orgnr *is* the owner's personnummer. It stays unencrypted (it must appear on invoices and in exports), but is classified as personal data: excluded from logs and `AuditEvent.metadata`, included in GDPR export/erasure accounting, and flagged in the ROPA. **No personnummer column exists anywhere in this schema by design**; if one is ever added (e.g. BankID evidence), it must be encrypted — but the v1.5 BankID design keeps evidence packages in R2 (EU), referenced by `ContractSignature.evidenceFileId`, precisely so personnummer never enters Postgres.

---

## 5. Retention classes

| Class | Rule | Applies to |
|---|---|---|
| **R1 — bookkeeping** | Retained until the end of the **7th year after the calendar year in which the tenant's fiscal year ended** ([BFL 1999:1078 7 kap.](https://www.bfn.se/fragor-och-svar/arkivering/)). Issued invoices are the tenant's räkenskapsinformation; Fortleva is a försystem holding it. **Carved out of GDPR deletion** (Art. 17(3)(b), legal obligation — the tenant's, which we support contractually): tenant offboarding and client deletion never delete issued `Invoice`/`InvoiceLine`/`InvoiceSeries` rows or invoice PDF `FileObject`s inside the window; offboarding produces the promised archive export instead. EU storage (Neon Frankfurt, R2 EU) is lawful with Skatteverket notification by the tenant (BFL 7 kap. 3a §) — surfaced in ToS/DPA, see `SECURITY.md`. | `Invoice`, `InvoiceLine`, `InvoiceSeries`, invoice-PDF and signed-contract `FileObject`s |
| **R2 — tenant-lifecycle** | Live for the tenancy; exported then hard-deleted after the offboarding grace period (platform plane, §7). Client-level deletion honors per-client GDPR erasure except R1/R3 carve-outs. | All domain models not listed elsewhere |
| **R3 — audit** | Category schedules per §3 (12/24 months; continuity = box life + 24 months); pseudonymize-don't-delete on erasure requests. | `AuditEvent` |
| **R4 — ephemeral** | TTL'd by expiry columns + sweep jobs: sessions and verifications per auth config, invites per `expiresAt`, `PENDING` FileObjects swept (with the R2 abort-incomplete-multipart lifecycle rule + reconciliation job). | `Session`, `ContactSession`, `Verification`, `ContactVerification`, `MemberInvite`, `FileObject(PENDING)` |
| **R5 — continuity** | Sealed blob + box rows survive subscription lapse (deliberate entitlement exemption — a continuity box that seals itself on non-payment defeats its purpose). Exact post-lapse retention window is an open question (`OPEN_QUESTIONS.md`, "can wait"). Post-open: blob retained through the 7-day download window, then per `CONTINUITY_BOX.md` retention. | `ContinuityBox`, `ContinuityOpenRequest`, the R2 blob |

---

## 6. Draft Prisma schema

**Draft-readability note:** Prisma requires back-relation fields on both sides of every relation and disambiguated relation names where FK columns overlap (they overlap everywhere here, because composite FKs share `tenantId`). Those back-relation arrays and `@relation("name")` labels are **elided** below to keep the spec readable; the generated Phase-1 schema will include them. The same applies to the `@@map`/`@map` snake_case physical mappings fixed in §1.3 — mechanical, elided here, present in the generated schema. Column lists, keys, uniques, indexes and enums below are normative.

```prisma
// ═══════════════════════════════════════════════════════════════════
// Fortleva — draft schema v0.1 (Phase 0 spec artifact)
// Postgres 16 on Neon, region aws-eu-central-1 (Frankfurt — the only
// true EU region; London is UK; region is immutable per project).
// ═══════════════════════════════════════════════════════════════════

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")   // Neon pooled (-pooler), runtime, restricted non-BYPASSRLS role
  directUrl = env("DIRECT_URL")     // unpooled, owner role, Prisma Migrate only
}

generator client {
  provider = "prisma-client-js"
}

// ───────────────────────────────────────────────────────────────────
// 6.1 IDENTITY & AUTH — member side (Better Auth, primary instance)
//
// Better Auth (self-hosted, >= 1.6.11, data in Neon EU) manages these
// tables: User, Session, Account, Verification (core), TwoFactor
// (twoFactor plugin), Passkey (passkey plugin). The admin plugin adds
// User.role/banned/banReason/banExpires and Session.impersonatedBy.
// Plugins deliberately NOT enabled: organization (membership lives in
// OUR schema below — the org plugin's comma-separated role storage is
// not relational), sso, scim, oidcProvider, deviceAuthorization (the
// 2026 CVE surface; enable nothing unused). Invitations are ours
// (MemberInvite / Contact invite state), not Better Auth's.
// ───────────────────────────────────────────────────────────────────

/// User — global member identity (§3: identity is global, membership is
/// tenant-scoped). One person, one login, several tenants via Member.
/// `platformRole` is THE authoritative platform-plane flag and the field
/// `authorizePlatform()` reads (AUTHZ.md §9): "SUPERADMIN" | null, never
/// a tenant Role. `role` is the Better Auth ADMIN-PLUGIN column, kept
/// only because the plugin's impersonation/ban machinery requires it;
/// it is MIRRORED from platformRole ("admin" when platformRole is set)
/// and is never read by any authorization path, tenant or platform.
/// The two names are deliberately distinct because §1.1's vocabulary law
/// forbids an ambiguous "role" on User.
/// scope=global-identity  rls=P  ret=R2 (erased when last Member link goes)  enc=none
/// audit: auth.login_succeeded | auth.login_failed | auth.password_changed | auth.email_changed
model User {
  id            String    @id @default(uuid(7))
  name          String
  email         String    @unique              // lowercase-normalized
  emailVerified Boolean   @default(false)
  image         String?
  locale        String?                        // UI language pref (sv/en/…; never assume two — §12)
  // Platform plane (ours — authoritative; AUTHZ.md §9):
  platformRole  String?                        // "SUPERADMIN" | null — platform plane only; NEVER a tenant Role
  // Better Auth admin plugin fields (vendor plumbing, mirrored from platformRole):
  role          String?                        // "admin" | null — plugin-required mirror, never read by authorization
  banned        Boolean   @default(false)
  banReason     String?
  banExpires    DateTime? @db.Timestamptz(6)
  createdAt     DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt     DateTime  @updatedAt @db.Timestamptz(6)
}

enum SessionPlane {
  MEMBER     // tenant plane
  PLATFORM   // platform console (own host: ops.naxdor.com in v1, separate ops apex from Phase 7 — ARCHITECTURE.md ARC-11)
}

/// Session — member sessions. `impersonatedBy` (admin plugin) carries the
/// platform admin's User.id during support impersonation; every request
/// under it also writes AuditEvent.impersonatorId (§7: support access is
/// not a backdoor). `activeTenantId` is a UX pointer only — authorization
/// always re-derives membership; never trust the cookie alone.
/// `plane` is the second structural barrier between planes (SECURITY.md
/// §3.3, brief §2): each route group's middleware accepts only its own
/// cookie AND its own plane value, so a member session presented on a
/// platform route is rejected on the row, not just on the cookie name.
/// Portal sessions live in ContactSession, whose plane is fixed CONTACT
/// by table identity (no column needed — that table has no other
/// audience).
/// scope=global-identity  rls=AUTH  ret=R4  enc=none
model Session {
  id             String       @id @default(uuid(7))
  token          String       @unique
  userId         String
  plane          SessionPlane @default(MEMBER)   // MEMBER | PLATFORM — SECURITY.md §3.3
  expiresAt      DateTime     @db.Timestamptz(6)
  ipAddress      String?
  userAgent      String?
  impersonatedBy String?                         // platform admin User.id, when impersonating
  activeTenantId String?                         // last-used tenant (UX), re-validated per request
  createdAt      DateTime     @default(now()) @db.Timestamptz(6)
  updatedAt      DateTime     @updatedAt @db.Timestamptz(6)

  @@index([userId])
  @@index([expiresAt])                         // sweep job
}

/// Account — Better Auth credential/provider rows (providerId
/// "credential" for password; OAuth providers later). Passwords are
/// hashed (scrypt, Better Auth default) — hashed, never reversible.
/// scope=global-identity  rls=AUTH  ret=R2  enc=none
model Account {
  id                    String    @id @default(uuid(7))
  userId                String
  accountId             String
  providerId            String
  password              String?                // hash, credential provider only
  accessToken           String?
  refreshToken          String?
  idToken               String?
  accessTokenExpiresAt  DateTime? @db.Timestamptz(6)
  refreshTokenExpiresAt DateTime? @db.Timestamptz(6)
  scope                 String?
  createdAt             DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt             DateTime  @updatedAt @db.Timestamptz(6)

  @@unique([providerId, accountId])
  @@index([userId])
}

/// Verification — Better Auth verification tokens (email verify, reset).
/// Token hashes, TTL'd.
/// scope=global-identity  rls=AUTH  ret=R4  enc=none
model Verification {
  id         String   @id @default(uuid(7))
  identifier String
  value      String
  expiresAt  DateTime @db.Timestamptz(6)
  createdAt  DateTime @default(now()) @db.Timestamptz(6)
  updatedAt  DateTime @updatedAt @db.Timestamptz(6)

  @@index([identifier])
  @@index([expiresAt])
}

/// TwoFactor — Better Auth twoFactor plugin (TOTP + backup codes).
/// MFA mandatory for platform admins and tenant owner-equivalent roles
/// (§9) — enforced in policy (AUTHZ.md), stored here.
/// scope=global-identity  rls=AUTH  ret=R2  enc=secret,backupCodes
/// audit: auth.mfa_enabled | auth.mfa_disabled
model TwoFactor {
  id          String @id @default(uuid(7))
  userId      String @unique
  secret      String                           // ENCRYPTED (app AES-GCM)
  backupCodes String                           // ENCRYPTED
}

/// Passkey — Better Auth passkey plugin (WebAuthn). Shape per plugin docs.
/// scope=global-identity  rls=AUTH  ret=R2  enc=none (public keys only)
model Passkey {
  id           String   @id @default(uuid(7))
  userId       String
  name         String?
  publicKey    String
  credentialID String   @unique
  counter      Int
  deviceType   String
  backedUp     Boolean
  transports   String?
  createdAt    DateTime @default(now()) @db.Timestamptz(6)

  @@index([userId])
}

// ───────────────────────────────────────────────────────────────────
// 6.2 TENANT ROOT & PLATFORM CONFIG
// ───────────────────────────────────────────────────────────────────

enum TenantStatus {
  TRIALING
  ACTIVE
  PAST_DUE      // dunning; features degrade per entitlements, continuity box exempt
  SUSPENDED     // platform action; read-only
  OFFBOARDING   // export window running
  CLOSED        // grace elapsed; R1 archive only
}

/// Tenant — a subscribing company (§1). The aggregate root of everything.
/// - entitlements: versioned JSON resolved from Stripe webhooks into
///   { schemaVersion, planCode, source, modules: { invoicing, contracts,
///   reports, issues, documentation, continuity_box, portal },
///   limits: { maxMembers, maxClients, maxStorageBytes, maxCustomRoles },
///   addons: { bankidSigning } } (§4). The seven module keys are exactly
///   the entitlement keys in AUTHZ.md §5 and the module table in
///   ARCHITECTURE.md §3, character for character — `Permission.module`
///   resolves into this object by string equality, so `reports` (never
///   "performance") and `continuity_box` (never "continuityBox") are
///   load-bearing spellings. BankID signing is an ADD-ON key, not an
///   eighth module: it gates a capability inside `contracts` (v1.5).
///   Stripe stays source of truth for exactly one fact — which Price is
///   paid — because Stripe's Entitlements API is boolean-only and cannot
///   express numeric limits (https://docs.stripe.com/billing/entitlements).
///   Read per request (~1 ms); never baked into a long-lived JWT.
///   Downgrades: read-only grandfathering — block creation past the new
///   limit, never delete or hide existing data.
/// - permissionsVersion: bumped in the same transaction as ANY role/
///   permission/assignment change; cache-invalidation stamp (AUTHZ.md).
/// - slug: reserved NOW for v2 subdomains (decision #8: single app
///   domain in v1; hostname→tenantId resolver stubbed). DNS-safe,
///   lowercase, <=63 chars, reserved-word list enforced at creation.
/// - cell / databaseUrl: physical-isolation escape hatch (§2, TENANCY.md).
/// - orgNr…bic: invoice-issuer identity, snapshotted onto every issued
///   invoice. orgNr may be a personnummer for enskild firma (§4 caveat).
/// scope=tenant-root  rls=T  ret=R2 (R1 outlives via snapshots/archive)  enc=databaseUrl,bankgiro,plusgiro,iban,bic
/// audit: tenant.provisioned | tenant.suspended | tenant.offboarded | entitlements.changed | plan.changed
model Tenant {
  id                 String       @id @default(uuid(7))
  name               String                        // display name
  legalName          String?                       // as printed on invoices, if different
  slug               String       @unique          // v2 subdomain; reserved from day 1
  status             TenantStatus @default(TRIALING)

  // Commercial (Phase 7 fills these; the SHAPE exists from Phase 1 — §4)
  entitlements          Json                       // versioned JSON — see model comment
  entitlementsUpdatedAt DateTime?  @db.Timestamptz(6)
  planCode              String?                    // convenience mirror; entitlements JSON is authoritative
  stripeCustomerId      String?    @unique         // OUR billing of the tenant. Nothing anticipates Stripe Connect.
  stripeSubscriptionId  String?
  billingCurrency       String?    @db.Char(3)     // SEK/USD — sticky per Stripe customer; day-1 decision, OPEN_QUESTIONS
  trialEndsAt           DateTime?  @db.Timestamptz(6)

  // AuthZ cache stamp
  permissionsVersion Int           @default(1)

  // Physical-isolation escape hatch (unused v1)
  cell        String?
  databaseUrl String?                              // ENCRYPTED; see Pushback P3

  // Invoice-issuer identity (seller side; snapshotted at issuance)
  orgNr          String?                           // public registry data; enskild-firma caveat §4
  vatNumber      String?                           // SE + orgnr + 01
  seat           String?                           // säte (ABL 28 kap. 5 §)
  fSkattApproved Boolean @default(false)           // "Godkänd för F-skatt" line
  addressLine1   String?
  addressLine2   String?
  postalCode     String?
  city           String?
  countryCode    String? @db.Char(2)
  bankgiro       String?                           // ENCRYPTED
  plusgiro       String?                           // ENCRYPTED
  iban           String?                           // ENCRYPTED
  bic            String?                           // ENCRYPTED

  // Storage quota metering (transactional counter + reconciliation job)
  storageUsedBytes BigInt @default(0)

  defaultLocale String  @default("sv")             // per-tenant, never hardcoded (§12)

  suspendedAt  DateTime? @db.Timestamptz(6)
  offboardedAt DateTime? @db.Timestamptz(6)
  deleteAfter  DateTime? @db.Timestamptz(6)        // hard-delete grace deadline (§7)
  createdAt    DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt    DateTime  @updatedAt @db.Timestamptz(6)
}

/// TenantPreference — "entitled but disabled by choice" (§4 gate 2) plus
/// misc tenant settings. Keyed rows (not one JSON blob) so every flip is
/// individually audited and re-enabling never needs platform involvement.
/// Keys from a typed catalog: module.invoicing.enabled,
/// module.portal.enabled, module.continuity_box.enabled, locale.default, …
/// scope=tenant  rls=A  ret=R2  enc=none
/// audit: preference.changed
model TenantPreference {
  id                String   @id @default(uuid(7))
  tenantId          String
  key               String
  value             Json
  updatedByMemberId String?
  updatedAt         DateTime @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, key])
}

/// TenantCounter — small monotonic counters for human-facing numbers with
/// NO legal gap-free requirement (issue numbers). Invoices do NOT use
/// this — they use InvoiceSeries (§6.7 + §9 of this doc) with stricter rules.
/// scope=tenant  rls=A  ret=R2  enc=none
model TenantCounter {
  tenantId String
  key      String                               // e.g. "issue"
  value    Int    @default(0)

  @@id([tenantId, key])
}

/// FeatureFlag — engineering-owned, temporary, never monetization (§4
/// gate 4; evaluation order: flag-killswitch → entitlement → preference
/// → permission). `removeBy` nudges the post-rollout deletion the brief
/// demands. Platform-plane data; tenants never see it.
/// scope=platform  rls=P  ret=R2  enc=none
/// audit: flag.changed [PLATFORM]
model FeatureFlag {
  id              String    @id @default(uuid(7))
  key             String    @unique             // e.g. "new-portal-timeline"
  description     String
  defaultOn       Boolean   @default(false)
  tenantOverrides Json?                         // { "<tenantId>": true|false } — fine at tens of tenants
  removeBy        DateTime? @db.Timestamptz(6)  // flags are temporary by definition
  createdAt       DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt       DateTime  @updatedAt @db.Timestamptz(6)
}

/// StripeWebhookEvent — the idempotency ledger ARCHITECTURE.md §5 and
/// ARC-07 name. Platform-scoped (no tenantId: an event may arrive before
/// its tenant is resolvable, and platform-plane rows must survive tenant
/// deletion). The handler INSERTs `eventId` first; a unique violation
/// means "already processed" — the whole idempotency guarantee, enforced
/// by the constraint rather than by a read-then-write race. `payloadDigest`
/// (SHA-256 of the raw body) detects replayed-but-altered payloads;
/// `processedAt` NULL means received-but-not-finished, which the nightly
/// billing-reconciliation job sweeps. Lands with Phase 7 (Stripe), shape
/// fixed here because it is referenced by ARCHITECTURE.md.
/// scope=platform  rls=P  ret=R2 (pruned after 90 days)  enc=none
model StripeWebhookEvent {
  id            String    @id @default(uuid(7))
  eventId       String    @unique              // Stripe evt_… — the idempotency key
  type          String                         // e.g. "customer.subscription.updated"
  payloadDigest String                         // sha256 of the raw body
  receivedAt    DateTime  @default(now()) @db.Timestamptz(6)
  processedAt   DateTime? @db.Timestamptz(6)   // NULL = in flight / failed; reconciliation sweeps
  error         String?

  @@index([type, receivedAt])
  @@index([processedAt])
}

// ───────────────────────────────────────────────────────────────────
// 6.3 MEMBERSHIP & AUTHORIZATION (tenant plane — §3)
// Permissions are the atomic unit; roles are named bundles; assignment
// (member↔client/project) is a relationship, not a role. Every check
// goes through authorize(actor, action, resource) — see AUTHZ.md.
// ───────────────────────────────────────────────────────────────────

enum MemberStatus {
  ACTIVE
  SUSPENDED
}

/// Member — a User's membership in one Tenant (§3: membership is
/// tenant-scoped, identity is global). Role is NEVER a column here —
/// many-to-many via MemberRole from day one. App invariants (AUTHZ.md,
/// transactional): at least one member always holds the owner-equivalent
/// system role; no self-escalation; grant-subset rule.
/// scope=tenant  rls=A  ret=R2  enc=none
/// audit: member.joined | member.suspended | member.removed
model Member {
  id          String       @id @default(uuid(7))
  tenantId    String
  userId      String
  status      MemberStatus @default(ACTIVE)
  title       String?                            // display title, no semantics
  invitedById String?                            // Member.id of inviter
  joinedAt    DateTime     @default(now()) @db.Timestamptz(6)
  suspendedAt DateTime?    @db.Timestamptz(6)
  createdAt   DateTime     @default(now()) @db.Timestamptz(6)
  updatedAt   DateTime     @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, userId])
  @@unique([tenantId, id])                       // composite-FK target
  @@index([userId])                              // "my tenants" lookup
}

enum InviteStatus {
  PENDING
  ACCEPTED
  EXPIRED
  REVOKED
}

/// MemberInvite — our invitation flow (Better Auth org plugin not used).
/// Stores a token HASH, never the raw token. Accepting creates/links a
/// User and creates Member + MemberRole rows in one transaction.
/// scope=tenant  rls=A  ret=R4  enc=none
/// audit: member.invited | member.invite_revoked
model MemberInvite {
  id                String       @id @default(uuid(7))
  tenantId          String
  email             String                       // lowercase-normalized
  proposedRoleIds   Json                         // Role.id[] granted on accept (subset-checked against inviter)
  tokenHash         String       @unique
  status            InviteStatus @default(PENDING)
  invitedByMemberId String
  expiresAt         DateTime     @db.Timestamptz(6)
  acceptedAt        DateTime?    @db.Timestamptz(6)
  createdAt         DateTime     @default(now()) @db.Timestamptz(6)

  @@index([tenantId, email])
  @@index([expiresAt])
}

/// Permission — GLOBAL seeded catalog; the atomic unit (§3). Codes are
/// immutable identifiers, forever, in the format `resource:verb` (the
/// brief's own style): invoice:create, client:delete, continuity_box:edit,
/// client:view_all (decision #5), …
/// **AUTHZ.md §3.1 is the normative source for the code format and the
/// closed 64-code catalog**; this model only stores it.
/// THREE NAMESPACES, DELIBERATELY DISTINCT — do not "harmonize" them:
///   1. permission codes      `resource:verb`      (this table)
///   2. audit actions         `entity.verb`        (AuditEvent.action, §3.1)
///   3. portal capabilities   `portal.area.verb`   (code only, AUTHZ.md §8 —
///      never rows in this table)
/// Colon vs dot is how a reader tells a member permission from an audit
/// action at a glance; codes are immutable, so this is fixed before the
/// Phase-1 seed migration and never revisited.
/// `module` ties a permission to an entitlement module so gates compose
/// (§4); it is NOT nullable — `core` permissions carry the literal string
/// "core" (AUTHZ.md §3.1), never NULL, so gate composition is a plain
/// lookup with no null branch.
/// `requiresMfa` is the storage for AUTHZ.md §7.5's permission-attached
/// MFA mandate (the ✦ set): it drives enrollment enforcement, step-up
/// gating, and the §3.5 rule that ✦ codes are never auto-propagated to
/// custom clones. The brief §9 "MFA mandatory for owner-equivalent roles"
/// requirement has no other storage anywhere — attaching it to permissions
/// rather than role names is what makes it survive role cloning.
/// Portal contacts NEVER enter this machinery (separate principal,
/// hardcoded capability set — §3, decision #6).
/// scope=platform (global reference)  rls=P  ret=permanent  enc=none
model Permission {
  id          String  @id @default(uuid(7))
  code        String  @unique                    // immutable, resource:verb
  description String
  module      String                             // "core" | "invoicing" | "contracts" | "reports" | "issues" | "documentation" | "continuity_box" | "portal"
  requiresMfa Boolean @default(false)            // ✦ in AUTHZ.md §3.2 — §7.5 mandate + step-up
}

/// Role — tenant-scoped named bundle of permissions (§3). System role
/// templates live in CODE as seed constants; provisioning stamps them as
/// rows with isSystem=true. System roles are protected: not deletable,
/// owner-equivalent role not de-fangable (app invariant).
/// TEMPLATE KEYS ARE THE CANONICAL ONES FROM AUTHZ.md §3.3 —
/// "owner" | "manager" | "admin" | "employee". "CEO" is the seeded
/// display *name* of the owner template only; AUTHZ §7.3 pins the
/// last-owner invariant to templateKey = 'owner', so a row keyed "ceo"
/// would silently disarm that invariant.
/// LINEAGE + DRIFT (AUTHZ.md §3.5, OPEN_QUESTIONS B3 — blocks Phase 1):
/// `templateKey` marks a row derived from a template; `clonedFromKey`
/// records which template a custom clone came from; `templateVersion`
/// records the template generation the row was last reconciled against.
/// Per-permission tenant intent lives on RolePermission.source, so a
/// propagated grant is distinguishable from a tenant's own grant and a
/// tenant's explicit revoke is never re-added.
/// **This shape ships in the FIRST migration regardless of which drift
/// policy the founder picks (B3 Option A frozen clones or Option B
/// tracked-diff-additive)** — Option A simply never runs the propagation
/// job. Retrofitting diff-tracking after tenants hold custom roles is the
/// expensive direction; carrying three unused columns is not.
/// scope=tenant  rls=A  ret=R2  enc=none
/// audit: role.created | role.updated | role.deleted
model Role {
  id             String   @id @default(uuid(7))
  tenantId       String
  name           String
  description    String?
  isSystem       Boolean  @default(false)
  templateKey    String?                         // "owner" | "manager" | "admin" | "employee" — system-role identity
  clonedFromKey  String?                         // template a custom clone descends from (AUTHZ §3.3)
  templateVersion Int?                           // template generation last reconciled against (AUTHZ §3.5)
  createdAt      DateTime @default(now()) @db.Timestamptz(6)
  updatedAt      DateTime @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, name])
  @@unique([tenantId, id])                       // composite-FK target
  @@index([tenantId, templateKey])               // last-owner invariant lookup (AUTHZ §7.3)
}

enum RolePermissionSource {
  TEMPLATE       // came from the role's template (seed or propagated grant, actor = SYSTEM)
  TENANT_GRANT   // the tenant added it deliberately — never removed by propagation
  TENANT_REVOKE  // tombstone: the tenant removed a template permission — propagation must skip this code forever
}

/// RolePermission — role ↔ permission junction. tenantId denormalized
/// for RLS + leading-tenantId index (§2.5). Every grant/revoke bumps
/// Tenant.permissionsVersion in the same transaction and is
/// subset-guarded (cannot grant what you do not hold).
/// `source` is the override-tracking structure AUTHZ.md §3.5 and
/// OPEN_QUESTIONS B3 require from the first migration: TENANT_REVOKE rows
/// are tombstones (the permission is NOT effective) whose only job is to
/// make a tenant's deliberate trim survive template propagation; the
/// effective permission set is rows where source != TENANT_REVOKE.
/// Ships whichever drift policy the founder picks — Option A just never
/// writes TEMPLATE rows after provisioning.
/// scope=tenant  rls=A  ret=R2  enc=none
/// audit: permission.granted | permission.revoked
model RolePermission {
  tenantId     String
  roleId       String
  permissionId String
  source       RolePermissionSource @default(TENANT_GRANT)
  createdAt    DateTime @default(now()) @db.Timestamptz(6)

  @@id([tenantId, roleId, permissionId])
  @@index([tenantId, permissionId])
}

/// MemberRole — member ↔ role junction; multiple holders of any role,
/// multiple roles per member (§3).
/// scope=tenant  rls=A  ret=R2  enc=none
/// audit: member.role_assigned | member.role_removed
model MemberRole {
  tenantId     String
  memberId     String
  roleId       String
  assignedById String?                           // Member.id
  createdAt    DateTime @default(now()) @db.Timestamptz(6)

  @@id([tenantId, memberId, roleId])
  @@index([tenantId, roleId])
}

/// MemberClient — explicit member↔client assignment (§3 "the harder
/// half"). Decision #5: deny-default — zero assignments means the member
/// sees no clients unless a role grants client:view_all (seeded on
/// CEO/Manager/Admin templates only). Fail-closed.
/// scope=tenant  rls=A  ret=R2  enc=none
/// audit: assignment.client_added | assignment.client_removed
model MemberClient {
  tenantId     String
  memberId     String
  clientId     String
  assignedById String?
  createdAt    DateTime @default(now()) @db.Timestamptz(6)

  @@id([tenantId, memberId, clientId])
  @@index([tenantId, clientId])
}

/// MemberProject — explicit member↔project assignment; refines client
/// assignment where a member should see only some of a client's projects.
/// Semantics (union vs intersection with MemberClient) defined in AUTHZ.md.
/// scope=tenant  rls=A  ret=R2  enc=none
/// audit: assignment.project_added | assignment.project_removed
model MemberProject {
  tenantId     String
  memberId     String
  projectId    String
  assignedById String?
  createdAt    DateTime @default(now()) @db.Timestamptz(6)

  @@id([tenantId, memberId, projectId])
  @@index([tenantId, projectId])
}

// ───────────────────────────────────────────────────────────────────
// 6.4 CLIENTS & CONTACTS (§6) — and the portal principal (§3)
// ───────────────────────────────────────────────────────────────────

enum ClientStatus {
  ACTIVE
  ARCHIVED
}

enum VatProfile {
  SE_DOMESTIC          // Swedish VAT 25/12/6
  EU_REVERSE_CHARGE    // EU B2B, VIES-validated, "Omvänd betalningsskyldighet", box 39
  OUTSIDE_SCOPE        // non-EU B2B (e.g. US), outside scope of EU VAT, box 40
}

/// Client — a customer of a tenant; a company record, never a login (§1).
/// internalNotes is INTERNAL-ONLY: never selected by the portal read
/// model (column-level rule — RLS is row-level; see §2.3 note), never in
/// exports to the client, never in AuditEvent.metadata.
/// vatProfile is the default applied to new invoices (derived from
/// country + VAT number; overridable per invoice at draft time).
/// scope=client-root  rls=B (portal restrictive: id = app.client_id)  ret=R2 (R1 survives via invoice snapshots)  enc=none (orgNr enskild-firma caveat §4)
/// audit: client.created | client.updated | client.archived | client.deleted | client.note_updated
model Client {
  id                    String       @id @default(uuid(7))
  tenantId              String
  name                  String
  orgNr                 String?                  // org.nr / company reg no; may be personnummer (enskild firma)
  vatNumber             String?                  // buyer VAT id for reverse charge (EN 16931 BT-48)
  vatNumberValidatedAt  DateTime?    @db.Timestamptz(6)  // last successful VIES check
  vatProfile            VatProfile?              // default; per-invoice override allowed
  countryCode           String?      @db.Char(2)
  addressLine1          String?
  addressLine2          String?
  postalCode            String?
  city                  String?
  billingEmail          String?
  invoiceLocale         String?                  // sv/en — per client, not per tenant
  status                ClientStatus @default(ACTIVE)
  internalNotes         String?                  // INTERNAL-ONLY (§5) — excluded from every portal projection
  archivedAt            DateTime?    @db.Timestamptz(6)
  createdAt             DateTime     @default(now()) @db.Timestamptz(6)
  updatedAt             DateTime     @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, id])                       // composite-FK target for ALL client-scoped children
  @@index([tenantId, status])
  @@index([tenantId, name])
}

/// Fixed portal capability profiles. Names and split come from AUTHZ.md
/// §8, which is the source of truth for WHICH capabilities each profile
/// carries — do not restate the split here, it drifts.
/// CONTACT_FINANCE (invoices + contracts only) is reserved for v2.
enum ContactPortalProfile {
  CONTACT_PRIMARY        // all v1 capabilities: projects, documents, issues, invoices, contracts, signing, continuity
  CONTACT_COLLABORATOR   // projects, documents, issues. No money, no signatures, no continuity
}

enum ContactPortalStatus {
  NO_ACCESS  // contact record exists; no portal login
  INVITED
  ACTIVE
  SUSPENDED
  REVOKED
}

/// Contact — a person at a client; the ONLY portal principal (§1, §3).
/// Decision #6: a fully separate identity from User — its own credential/
/// session/verification tables below, its own Better Auth instance
/// (modelName-mapped user→Contact etc.), its own cookie prefix and route
/// group (/portal), own session audience. A member and a contact with
/// the same email are two unrelated accounts, by design.
/// Invite-only, enforced in our code: no public portal signup path
/// exists; ContactAccount rows are only ever created through invite
/// acceptance. portalProfile is a HARDCODED enum, not the Role machinery —
/// contacts never enter tenant RBAC (see Pushback P1).
/// email is globally unique in v1 (single app domain — decision #8 —
/// makes portal login email-keyed); relaxes to (tenantId, email) when
/// Host-based tenant resolution lands in v2 (see Pushback P2).
/// scope=client  rls=B (restrictive: clientId = app.client_id)  ret=R2 (identity fields erasable on GDPR request; audit pseudonymized)  enc=none
/// audit: contact.created | contact.invited | contact.activated | contact.suspended | contact.access_revoked
model Contact {
  id            String              @id @default(uuid(7))
  tenantId      String
  clientId      String
  // Better Auth identity-required fields (portal instance):
  name          String
  email         String              @unique      // v1 global; v2 relax to (tenantId,email) — P2
  emailVerified Boolean             @default(false)
  image         String?
  // Domain fields:
  title         String?
  phone         String?
  portalProfile ContactPortalProfile @default(CONTACT_COLLABORATOR)  // capability set per AUTHZ.md §8
  portalStatus  ContactPortalStatus @default(NO_ACCESS)
  invitedAt     DateTime?           @db.Timestamptz(6)
  invitedById   String?                          // Member.id
  activatedAt   DateTime?           @db.Timestamptz(6)
  locale        String?
  createdAt     DateTime            @default(now()) @db.Timestamptz(6)
  updatedAt     DateTime            @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, email])                    // permanent tenant-scoped unique (v1 also has global)
  @@unique([tenantId, id])                       // composite-FK target
  @@index([tenantId, clientId])
}

/// ContactSession — portal sessions (second Better Auth instance).
/// Separate cookie name/prefix and audience from member Session — a
/// portal token is rejected on tenant routes by table + audience alone,
/// before any role check (§2 "three planes"). Its plane is fixed
/// `CONTACT` by table identity (SECURITY.md §3.3): no column exists
/// because no other value is representable — the barrier is the table.
/// scope=client (via contact)  rls=AUTH  ret=R4  enc=none
model ContactSession {
  id        String   @id @default(uuid(7))
  token     String   @unique
  contactId String
  expiresAt DateTime @db.Timestamptz(6)
  ipAddress String?
  userAgent String?
  createdAt DateTime @default(now()) @db.Timestamptz(6)
  updatedAt DateTime @updatedAt @db.Timestamptz(6)

  @@index([contactId])
  @@index([expiresAt])
}

/// ContactAccount — portal credentials (credential provider only in v1;
/// no social login for contacts). Created exclusively via invite accept.
/// scope=client (via contact)  rls=AUTH  ret=R2  enc=none (password hashed)
model ContactAccount {
  id         String   @id @default(uuid(7))
  contactId  String
  accountId  String
  providerId String                              // "credential" only in v1
  password   String?                             // hash
  createdAt  DateTime @default(now()) @db.Timestamptz(6)
  updatedAt  DateTime @updatedAt @db.Timestamptz(6)

  @@unique([providerId, accountId])
  @@index([contactId])
}

/// ContactVerification — portal invite-accept + reset tokens (hashes).
/// Contact MFA (TOTP) is v2 — see Pushback P5.
/// scope=client (via contact)  rls=AUTH  ret=R4  enc=none
model ContactVerification {
  id         String   @id @default(uuid(7))
  identifier String
  value      String
  expiresAt  DateTime @db.Timestamptz(6)
  createdAt  DateTime @default(now()) @db.Timestamptz(6)

  @@index([identifier])
  @@index([expiresAt])
}

// ───────────────────────────────────────────────────────────────────
// 6.5 PROJECTS, VERSIONS, MILESTONES (§6)
// The portal's main surface: timeline = Milestones + ProjectVersions
// (a list with approvals, not a Gantt — competitive research).
// ───────────────────────────────────────────────────────────────────

enum ProjectStatus {
  PLANNED
  ACTIVE
  PAUSED
  COMPLETED
  CANCELLED
  ARCHIVED
}

/// Project — belongs to exactly one Client (§6). `type` is free text
/// (tenant-defined taxonomy; an enum here would smuggle in one agency's
/// vocabulary — §12). Portal projection exposes: name, type, status,
/// dates, productionUrl, stagingUrl, current version, milestones,
/// versions. INTERNAL-ONLY fields (excluded from portal projection):
/// repoUrl, hostingNotes, internalNotes. "Current version" is derived
/// (latest ProjectVersion with shippedAt set) — no denormalized pointer
/// to keep write paths single-sourced.
/// scope=client  rls=B  ret=R2  enc=none
/// audit: project.created | project.updated | project.status_changed | project.archived
model Project {
  id            String        @id @default(uuid(7))
  tenantId      String
  clientId      String
  name          String
  type          String?                          // free text: "website", "crm", …
  scopeSummary  String?                          // short client-visible scope description
  status        ProjectStatus @default(PLANNED)
  startDate     DateTime?     @db.Timestamptz(6)
  launchDate    DateTime?     @db.Timestamptz(6)
  productionUrl String?                          // client-visible; also CrUX subject (§6.10)
  stagingUrl    String?                          // client-visible
  repoUrl       String?                          // INTERNAL-ONLY
  hostingNotes  String?                          // INTERNAL-ONLY (provider, plan, credentials POINTERS only — never secrets)
  internalNotes String?                          // INTERNAL-ONLY
  archivedAt    DateTime?     @db.Timestamptz(6)
  createdAt     DateTime      @default(now()) @db.Timestamptz(6)
  updatedAt     DateTime      @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, id])                       // composite-FK target
  @@index([tenantId, clientId, status])
  @@index([tenantId, status])
}

enum ProjectVersionStatus {
  DRAFT      // staff authoring release notes
  SHIPPED    // shippedAt set; visible on portal timeline
}

enum ApprovalStatus {
  NOT_REQUESTED
  PENDING            // sign-off requested from client (decision #7, v1-lite)
  APPROVED
  CHANGES_REQUESTED
}

/// ProjectVersion — what shipped when, with release notes (§6 timeline).
/// releaseNotes are client-visible once SHIPPED. Sign-off (decision #7,
/// v1-lite): approval fields inline — a portal contact approves or
/// requests changes on a shipped version; that is the whole v1 feature
/// (no separate approval entity, no reminders engine until v2).
/// scope=client  rls=B (portal sees SHIPPED rows of its client)  ret=R2  enc=none
/// audit: project_version.created | project_version.shipped | project_version.approval_requested | project_version.approved | project_version.changes_requested
model ProjectVersion {
  id                  String               @id @default(uuid(7))
  tenantId            String
  clientId            String                     // denormalized for portal RLS (§2.5)
  projectId           String
  version             String                     // "1.4.0" / "2026-05 release" — tenant convention
  title               String?
  releaseNotes        String?                    // client-visible when SHIPPED
  status              ProjectVersionStatus @default(DRAFT)
  shippedAt           DateTime?            @db.Timestamptz(6)
  // Sign-off, v1-lite (decision #7):
  approvalStatus      ApprovalStatus       @default(NOT_REQUESTED)
  approvalRequestedAt DateTime?            @db.Timestamptz(6)
  approvalDecidedAt   DateTime?            @db.Timestamptz(6)
  approvalByContactId String?                    // who signed off
  approvalNote        String?                    // contact's comment
  createdByMemberId   String?
  createdAt           DateTime             @default(now()) @db.Timestamptz(6)
  updatedAt           DateTime             @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, projectId, version])
  @@unique([tenantId, id])                       // composite-FK target (Issue.fixedInVersionId)
  @@index([tenantId, clientId, shippedAt])
}

enum MilestoneStatus {
  PLANNED
  IN_PROGRESS
  DONE
  SKIPPED
}

/// Milestone — stage view of a project (§6). Client-visible by nature.
/// scope=client  rls=B  ret=R2  enc=none
/// audit: milestone.created | milestone.updated | milestone.completed
model Milestone {
  id          String          @id @default(uuid(7))
  tenantId    String
  clientId    String                             // denormalized for portal RLS
  projectId   String
  name        String
  description String?
  status      MilestoneStatus @default(PLANNED)
  dueAt       DateTime?       @db.Timestamptz(6)
  completedAt DateTime?       @db.Timestamptz(6)
  sortOrder   Int             @default(0)
  createdAt   DateTime        @default(now()) @db.Timestamptz(6)
  updatedAt   DateTime        @updatedAt @db.Timestamptz(6)

  @@index([tenantId, projectId, sortOrder])
  @@index([tenantId, clientId])
}

// ───────────────────────────────────────────────────────────────────
// 6.6 SERVICES & CONTRACTS (§6)
// ───────────────────────────────────────────────────────────────────

enum ServiceKind {
  ONE_TIME
  RECURRING
}

enum BillingInterval {
  MONTHLY
  QUARTERLY
  YEARLY
}

enum ServiceStatus {
  ACTIVE
  PAUSED
  ENDED
}

/// Service — what the client buys: builds, retainers, hosting, SEO,
/// maintenance (§6). v1 is a RECORD with renewal dates that power
/// reminders and invoice-line links; it is NOT a billing engine —
/// auto-generated recurring invoices are v2 (deliberate omission §11).
/// Client-visible in the portal (Phase 3 read surface) minus
/// internalNotes.
/// scope=client  rls=B  ret=R2  enc=none
/// audit: service.created | service.updated | service.ended
model Service {
  id              String           @id @default(uuid(7))
  tenantId        String
  clientId        String
  projectId       String?                        // optional link
  name            String
  description     String?                        // client-visible
  kind            ServiceKind
  billingInterval BillingInterval?               // RECURRING only
  priceExVat      Decimal?         @db.Decimal(12, 2)
  currency        String?          @db.Char(3)
  status          ServiceStatus    @default(ACTIVE)
  startedAt       DateTime?        @db.Timestamptz(6)
  renewsAt        DateTime?        @db.Timestamptz(6)   // next renewal — reminder driver
  endsAt          DateTime?        @db.Timestamptz(6)
  internalNotes   String?                        // INTERNAL-ONLY
  createdAt       DateTime         @default(now()) @db.Timestamptz(6)
  updatedAt       DateTime         @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, id])                       // composite-FK target (InvoiceLine.serviceId)
  @@index([tenantId, clientId, status])
  @@index([tenantId, renewsAt])                  // renewal sweep
}

enum ContractStatus {
  DRAFT
  SENT       // out for signature / review
  SIGNED     // all required signatures collected (or signed PDF uploaded)
  DECLINED
  EXPIRED    // expiresAt passed without full signature, or term ended
  VOIDED     // withdrawn by tenant before signature
}

/// Contract — uploaded or generated, versioned, dated (§6, §10.3).
/// Versioning: a new version is a NEW row with version = n+1 and
/// supersedesId pointing at the old row (which becomes VOIDED/EXPIRED);
/// signed contracts are never edited. Files: sourceFileId = the PDF sent
/// for signature; sealedFileId = the sealed signed PDF + embedded audit
/// trail (SES flow) or the uploaded wet-ink scan. documentSha256 is the
/// hash of the EXACT bytes presented for signature — what each
/// ContractSignature attests to.
/// Portal: visible to contacts of its client on the CONTACT_PRIMARY
/// profile (AUTHZ.md §8: portal.contract.view / .sign).
/// scope=client  rls=B  ret=R2, but signed PDFs follow R1-adjacent
///   contractual retention (avtal are räkenskapsinformation when they
///   underpin bookkeeping — keep with the archive export)
/// enc=none (files live in R2; evidence never in DB)
/// audit: contract.created | contract.sent | contract.signed | contract.declined | contract.voided | contract.superseded
model Contract {
  id                String         @id @default(uuid(7))
  tenantId          String
  clientId          String
  projectId         String?
  title             String
  status            ContractStatus @default(DRAFT)
  version           Int            @default(1)
  supersedesId      String?                      // self-reference: previous version
  effectiveAt       DateTime?      @db.Timestamptz(6)
  expiresAt         DateTime?      @db.Timestamptz(6)
  sourceFileId      String?                      // FileObject: PDF as sent
  sealedFileId      String?                      // FileObject: sealed signed PDF
  documentSha256    String?                      // hash of signed bytes
  sentAt            DateTime?      @db.Timestamptz(6)
  signedAt          DateTime?      @db.Timestamptz(6)  // fully executed
  createdByMemberId String?
  createdAt         DateTime       @default(now()) @db.Timestamptz(6)
  updatedAt         DateTime       @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, id])                       // composite-FK target
  @@index([tenantId, clientId, status])
  @@index([tenantId, expiresAt])                 // expiry sweep
}

enum SignatureParty {
  TENANT
  CLIENT
}

enum SignatureLevel {
  SES          // v1: native click-to-accept by authenticated portal contact — legally
               // sufficient for B2B service contracts in Sweden (formfrihet, eIDAS Art. 25)
               // and the US (ESIGN/UETA):
               // https://www.docusign.com/products/electronic-signature/legality/sweden
  AES_BANKID   // v1.5: pooled broker (Idura), platform entitlement; evidence in R2 EU
  QES          // skip: not required for these contracts; enum value reserved
}

enum SignatureStatus {
  PENDING
  SIGNED
  DECLINED
}

/// ContractSignature — one row per required signer per contract version.
/// Mixed levels PER PARTY by design: e.g. client signs SES in v1, later
/// AES_BANKID, while the tenant party countersigns SES — level is a
/// row attribute, not a contract attribute. The SES audit trail is
/// exactly: signer identity (member/contact link + name + email),
/// ip, userAgent, signedAt, documentSha256 — that trail is what makes
/// SES defensible (NJA 2017 s. 1105 burden-of-proof logic).
/// BankID evidence (v1.5) goes to R2 EU as an evidence package
/// (evidenceFileId) because it contains personnummer — NEVER stored in
/// Postgres (§4).
/// scope=client  rls=B (portal sees its own client's rows)  ret=R2 (follows contract archive)  enc=none (by exclusion of evidence from DB)
/// audit: contract.signature_requested | contract.signature_signed | contract.signature_declined
model ContractSignature {
  id              String          @id @default(uuid(7))
  tenantId        String
  clientId        String                         // denormalized for portal RLS
  contractId      String
  party           SignatureParty
  signerMemberId  String?                        // TENANT party
  signerContactId String?                        // CLIENT party
  signerName      String
  signerEmail     String
  level           SignatureLevel  @default(SES)
  status          SignatureStatus @default(PENDING)
  signedAt        DateTime?       @db.Timestamptz(6)
  ip              String?
  userAgent       String?
  documentSha256  String                         // what was signed
  providerRef     String?                        // broker transaction id (v1.5)
  evidenceFileId  String?                        // FileObject: evidence package in R2 EU (v1.5)
  createdAt       DateTime        @default(now()) @db.Timestamptz(6)

  @@index([tenantId, contractId])
  @@index([tenantId, clientId])
}

// ───────────────────────────────────────────────────────────────────
// 6.7 INVOICING (§6, §10.2) — an invoice LEDGER, not an accounting
// system (decision #3). Modeled on EN 16931 / Peppol BIS Billing 3
// semantics so Peppol transmission is a v2+ adapter, never a remodel
// (ViDA makes intra-EU e-invoicing mandatory 2030-07-01):
// https://sfti.se/sfti/standarder/peppolbisehandel/peppolbisbilling3.49021.html
//
// SELLER-SIDE SCOPE, STATED HONESTLY (brief §10.2 asks for exactly this):
// v1 supports **Swedish-established issuing tenants only**. The whole
// issuer model is Swedish: one issuer-identity block on Tenant (orgNr,
// vatNumber, säte, F-skatt, bankgiro/plusgiro), three hard-coded VAT
// profiles, the SEK-VAT rule (vatTotalSek/fxRateToSek), and R1 retention
// keyed to BFL.
// - Selling TO US / non-EU clients is fully supported — that is the
//   OUTSIDE_SCOPE profile (Art. 44, box 40). "Swedish tenant, US client"
//   is a v1 case and Naxdor's own case.
// - A **US-established issuing entity is OUT OF SCOPE for v1**: there is
//   no sales-tax/nexus concept, no US issuer identity block, and no
//   second tax regime. A tenant operating from both Sweden and the US
//   invoices through the product from its **Swedish entity only** in v1
//   (Naxdor included); US-entity invoicing stays in whatever the tenant
//   uses today.
// - Extension path when a US-established tenant is worth building for:
//   a tenant-level tax-regime enum (SE | US | …) selecting a per-regime
//   issuer-identity profile set, since VatProfile is already per-invoice
//   and sellerSnapshot already freezes issuer identity per invoice — the
//   model bends, it does not break. Flagged in OPEN_QUESTIONS.md.
// ───────────────────────────────────────────────────────────────────

/// InvoiceSeries — per-tenant, per-fiscal-year numbering series.
/// Swedish law requires a löpnummer in one or more series uniquely
/// identifying the invoice (ML 2023:200 17 kap. 24 §); Skatteverket's
/// ställningstagande (2023-06-26, dnr 8-2362095) expects each series
/// UNBROKEN through the fiscal year:
/// https://www.faronline.se/dokument/skatteverket/stallningstaganden2/2023/skvst20230626c/
/// Therefore: `lastNumber` is a transactional counter row — NOT a
/// Postgres SEQUENCE (sequences are non-transactional; a rolled-back
/// issuance would burn a number and leave a gap). Allocation is atomic —
/// see §9 of this doc. Multiple series per tenant are legal and
/// supported (e.g. one per brand); credit notes draw from the same
/// series by default. fiscalYearStart/End support brutet räkenskapsår
/// and drive the R1 retention clock.
/// scope=tenant  rls=A (portal never reads series)  ret=R1  enc=none
/// audit: series.created
model InvoiceSeries {
  id              String   @id @default(uuid(7))
  tenantId        String
  code            String                         // series label, e.g. "A" or "2026"
  fiscalYearLabel Int                            // e.g. 2026
  fiscalYearStart DateTime @db.Timestamptz(6)
  fiscalYearEnd   DateTime @db.Timestamptz(6)
  lastNumber      Int      @default(0)           // transactional counter; see §9
  displayFormat   String   @default("{code}-{number}")  // rendering template only
  createdAt       DateTime @default(now()) @db.Timestamptz(6)

  @@unique([tenantId, code, fiscalYearLabel])
  @@unique([tenantId, id])                       // composite-FK target
}

enum InvoiceKind {
  INVOICE
  CREDIT_NOTE   // corrections happen ONLY via credit notes — issued invoices are never edited or deleted
}

enum InvoiceStatus {
  DRAFT      // no number, fully editable, deletable
  ISSUED     // number allocated, content frozen (immutability trigger)
  SENT
  PAID
  CREDITED   // fully offset by credit note(s)
}

/// Invoice — immutable once ISSUED. Content requirements from ML
/// 2023:200 17 kap. 24 § (17-point list) + ABL 28 kap. 5 § (orgnr, säte)
/// + "Godkänd för F-skatt":
/// https://www.skatteverket.se/foretag/moms/saljavarorochtjanster/momslagensregleromfakturering.4.58d555751259e4d66168000403.html
/// - Three hard-coded VAT profiles (vatProfile) drive line tax
///   categories, legal wording, and report-box metadata (39/40).
/// - vatTotalSek: VAT amount MUST be stated in SEK whenever Swedish VAT
///   is due on a foreign-currency invoice (fxRateToSek = ECB/Riksbanken
///   rate at issuance) — the classic compliance miss.
/// - EU_REVERSE_CHARGE requires buyerVatNumber (VIES-validated;
///   viesConsultationNumber stored as proof) and the exact wording
///   "Omvänd betalningsskyldighet" in legalNotes; OUTSIDE_SCOPE gets
///   the Art. 44 outside-scope notation. Reverse-charge sales also feed
///   the tenant's periodisk sammanställning (metadata, not filing — the
///   tenant files; we are a ledger).
/// - sellerSnapshot/buyerSnapshot: full party identity frozen at
///   issuance (name, orgnr, säte, VAT no, F-skatt, addresses) so later
///   edits to Tenant/Client never mutate an issued invoice.
/// - Credit notes: kind=CREDIT_NOTE + creditsInvoiceId self-reference,
///   positive amounts, own löpnummer from the same series.
/// - Immutability enforcement: app-layer + DB trigger rejecting UPDATE
///   of ISSUED+ rows except the whitelist { status, sentAt, paidAt,
///   paidAmount, stripeCheckoutSessionId, stripePaymentIntentId,
///   externalPaymentRef, pdfFileId (set-once) } — status may only move
///   forward (ISSUED→SENT→PAID / →CREDITED).
/// - Pay-now (decision #7): paymentLinkUrl / Stripe refs; settlement
///   rails are tenant-owned — see §11 (no Stripe Connect).
/// Portal: visible to contacts of the client on the CONTACT_PRIMARY
/// profile (AUTHZ.md §8: portal.invoice.view / .pay).
/// scope=client  rls=B  ret=R1 (7-year BFL carve-out from GDPR deletion — §5)  enc=none
/// audit: invoice.created | invoice.issued | invoice.sent | invoice.paid | invoice.credited | invoice.pdf_generated
model Invoice {
  id                      String        @id @default(uuid(7))
  tenantId                String
  clientId                String
  seriesId                String?                // required at issuance; drafts may pre-select
  kind                    InvoiceKind   @default(INVOICE)
  creditsInvoiceId        String?                // CREDIT_NOTE → the invoice it credits
  status                  InvoiceStatus @default(DRAFT)
  number                  Int?                   // allocated at issuance ONLY; null while DRAFT
  displayNumber           String?                // rendered via series.displayFormat, frozen at issuance
  vatProfile              VatProfile
  issueDate               DateTime?     @db.Date // fakturadatum (law: issue date)
  supplyDate              DateTime?     @db.Date // leveransdatum if determinable & different
  dueDate                 DateTime?     @db.Date
  currency                String        @db.Char(3)
  fxRateToSek             Decimal?      @db.Decimal(12, 6)  // required when currency != SEK and Swedish VAT due
  subtotalExVat           Decimal       @db.Decimal(12, 2)
  vatTotal                Decimal       @db.Decimal(12, 2)
  vatTotalSek             Decimal?      @db.Decimal(12, 2)  // ML SEK rule
  total                   Decimal       @db.Decimal(12, 2)
  buyerVatNumber          String?                // EN 16931 BT-48; required for EU_REVERSE_CHARGE
  buyerReference          String?                // EN 16931 BT-10
  viesValidatedAt         DateTime?     @db.Timestamptz(6)
  viesConsultationNumber  String?                // VIES proof for reverse charge
  sellerSnapshot          Json?                  // frozen at issuance — see comment
  buyerSnapshot           Json?
  legalNotes              String?                // generated wording (reverse charge / outside scope / F-skatt)
  paymentTermsDays        Int?
  paymentDetailsSnapshot  Json?                  // bankgiro/IBAN as printed (decrypted → snapshotted at issuance)
  paymentLinkUrl          String?                // pay-now target (tenant rails)
  stripeCheckoutSessionId String?
  stripePaymentIntentId   String?
  externalPaymentRef      String?                // manual reconciliation note
  paidAt                  DateTime?     @db.Timestamptz(6)
  paidAmount              Decimal?      @db.Decimal(12, 2)
  pdfFileId               String?                // FileObject: archived rendering (R1)
  issuedByMemberId        String?
  issuedAt                DateTime?     @db.Timestamptz(6)
  createdAt               DateTime      @default(now()) @db.Timestamptz(6)
  updatedAt               DateTime      @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, seriesId, number])         // gap-free uniqueness; NULL numbers (drafts) are distinct in PG
  @@unique([tenantId, id])                       // composite-FK target
  @@index([tenantId, clientId, status])
  @@index([tenantId, status, dueDate])           // overdue sweep (overdue is derived, not a status)
}

enum TaxCategory {
  S    // standard rate (SE 25/12/6)
  AE   // reverse charge (EN 16931 category AE)
  O    // outside scope
  E    // exempt — reserved v2 (momsfri supplies); not used by the three v1 profiles
}

/// InvoiceLine — line items, linked to services/projects (§6). Amounts
/// are line-level per rate/category so per-rate taxable-amount totals
/// (ML requirement) are derivable exactly. Frozen with the invoice.
/// scope=client  rls=B  ret=R1  enc=none
model InvoiceLine {
  id             String      @id @default(uuid(7))
  tenantId       String
  clientId       String                          // denormalized for portal RLS
  invoiceId      String
  position       Int
  description    String
  quantity       Decimal     @db.Decimal(12, 3)
  unit           String?                         // "h", "st", "mo"
  unitPriceExVat Decimal     @db.Decimal(12, 2)
  discountPct    Decimal?    @db.Decimal(5, 2)
  taxCategory    TaxCategory
  vatRatePct     Decimal     @db.Decimal(5, 2)   // 25.00 / 12.00 / 6.00 / 0.00
  amountExVat    Decimal     @db.Decimal(12, 2)
  vatAmount      Decimal     @db.Decimal(12, 2)
  serviceId      String?                         // link to what was bought
  projectId      String?
  createdAt      DateTime    @default(now()) @db.Timestamptz(6)

  @@unique([tenantId, invoiceId, position])
  @@index([tenantId, serviceId])
}

// ───────────────────────────────────────────────────────────────────
// 6.8 DOCUMENTS & FILES (§5, §6) — three layers:
//   Document   = logical, visibility-carrying, attachable entity
//   FileVersion= ordered versions of a Document
//   FileObject = physical immutable blob in R2 (quota unit)
// R2 has no object versioning — versioning is app-level by design
// (immutable objects + version rows), which also keeps us portable:
// https://developers.cloudflare.com/r2/pricing/
// Attachment pattern: soft polymorphism — justified in §10 of this doc.
// ───────────────────────────────────────────────────────────────────

enum Visibility {
  INTERNAL         // tenant staff only — THE DEFAULT, everywhere (§5)
  CLIENT_VISIBLE   // visible in the portal to the row's client
}

enum AttachableType {
  CLIENT
  PROJECT
  PROJECT_VERSION
  MILESTONE
  SERVICE
  CONTRACT
  INVOICE
  ISSUE
}

/// Document — the logical file entity (§6). clientId is NULLABLE:
/// tenant-internal documents (templates, playbooks — the "Documentation"
/// module §4) have no client; client/project documents carry it.
/// visibility defaults INTERNAL at the DB level; flipping to
/// CLIENT_VISIBLE is a permission-gated, audited action (the worst-bug
/// guard, §5). A CLIENT_VISIBLE document with clientId NULL is
/// impossible (CHECK constraint: visibility = 'CLIENT_VISIBLE' requires
/// clientId IS NOT NULL). Contact uploads (issue attachments) are forced
/// CLIENT_VISIBLE + clientId = uploader's client at the app layer.
/// (attachedToType, attachedToId) is a presentation anchor only —
/// AUTHORIZATION NEVER TRAVERSES IT; it reads tenantId/clientId/
/// visibility on this row (§10). Tags over folders in v1.
/// scope=client (clientId nullable ⇒ tenant-internal)  rls=B (restrictive portal policy: clientId match AND visibility)  ret=R2 (invoice/contract PDFs referenced via R1 parents survive)  enc=none
/// audit: document.created | document.visibility_changed | document.renamed | document.deleted | file.uploaded | file.downloaded
model Document {
  id                 String          @id @default(uuid(7))
  tenantId           String
  clientId           String?                     // NULL = tenant-internal
  projectId          String?                     // convenience scope (indexed listing)
  name               String
  tags               String[]        @default([])
  visibility         Visibility      @default(INTERNAL)
  attachedToType     AttachableType?             // soft anchor — see §10
  attachedToId       String?
  createdByMemberId  String?
  createdByContactId String?                     // portal uploads (issues)
  deletedAt          DateTime?       @db.Timestamptz(6)  // soft delete; hard delete via retention job
  createdAt          DateTime        @default(now()) @db.Timestamptz(6)
  updatedAt          DateTime        @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, id])
  @@index([tenantId, clientId, visibility])
  @@index([tenantId, projectId])
  @@index([tenantId, attachedToType, attachedToId])
  @@index([tenantId, tags], type: Gin)
}

/// FileVersion — ordered versions of a Document; current = max
/// versionNumber. Portal downloads resolve Document (visibility check)
/// → latest FileVersion → audited presign of FileObject; the file layer
/// itself is never portal-queried (§2.3 note).
/// scope=tenant  rls=A  ret=R2  enc=none
/// audit: (covered by file.uploaded on Document)
model FileVersion {
  id                  String   @id @default(uuid(7))
  tenantId            String
  documentId          String
  versionNumber       Int
  fileObjectId        String
  note                String?                    // "what changed"
  uploadedByMemberId  String?
  uploadedByContactId String?
  createdAt           DateTime @default(now()) @db.Timestamptz(6)

  @@unique([tenantId, documentId, versionNumber])
  @@index([tenantId, fileObjectId])
}

enum FileObjectStatus {
  PENDING     // presigned PUT issued; quota reserved; not yet verified
  COMMITTED   // HEAD-verified size + existence; counted in storageUsedBytes
  DELETED     // tombstone until R2 object confirmed gone
}

enum ScanStatus {
  UNSCANNED   // v1 default (allowlist + attachment disposition are the v1 mitigations)
  CLEAN
  INFECTED    // quarantined; never served
}

enum FileKind {
  GENERAL
  INVOICE_PDF
  CONTRACT_PDF
  SIGNATURE_EVIDENCE
  THUMBNAIL
  EXPORT              // tenant/client data exports
}

/// FileObject — one immutable blob in the R2 EU-jurisdiction bucket
/// (jurisdiction fixed at bucket creation; presigned URLs via the
/// <account>.eu.r2.cloudflarestorage.com endpoint, max 7 days:
/// https://developers.cloudflare.com/r2/reference/data-location/).
/// Key layout: {tenantId}/{fileObjectId} — single bucket, tenant prefix.
/// sizeBytes is THE quota-metering unit: presign checks quota and
/// creates PENDING (reserving size), R2 PUT signs Content-Length (R2
/// has no presigned POST / content-length-range), server HEAD-verifies,
/// then COMMITTED + Tenant.storageUsedBytes increment in one
/// transaction. Reconciliation job + R2 abort-incomplete-multipart
/// lifecycle rule close the drift (§10.6 research).
/// sha256 enables integrity checks and dedupe-by-reference (multiple
/// FileVersions may point at one FileObject).
/// NOTE: the continuity-box blob is deliberately NOT a FileObject — it
/// lives under its own key + bucket-lock rules on ContinuityBox (§6.11).
/// scope=tenant  rls=A (never portal-queried)  ret=R2, except R1 when referenced by an issued Invoice/signed Contract; PENDING rows are R4
/// audit: (file.uploaded / file.downloaded recorded against Document; export.generated for EXPORT kind)
model FileObject {
  id                 String           @id @default(uuid(7))
  tenantId           String
  r2Key              String           @unique
  kind               FileKind         @default(GENERAL)
  sha256             String
  sizeBytes          BigInt
  contentType        String                      // from server-side allowlist, never trusted from client
  originalFilename   String?
  status             FileObjectStatus @default(PENDING)
  scanStatus         ScanStatus       @default(UNSCANNED)
  createdByMemberId  String?
  createdByContactId String?
  committedAt        DateTime?        @db.Timestamptz(6)
  createdAt          DateTime         @default(now()) @db.Timestamptz(6)

  @@unique([tenantId, id])                       // composite-FK target
  @@index([tenantId, status])                    // PENDING sweep
  @@index([tenantId, sha256])                    // dedupe lookup
  @@index([tenantId, kind])
}

// ───────────────────────────────────────────────────────────────────
// 6.9 ISSUES (§6) — lightweight client request queue, not Jira.
// Decision #7: this IS the v1 intake surface (subsumes forms).
// ───────────────────────────────────────────────────────────────────

enum IssueType {
  BUG
  IDEA
  REQUIREMENT
}

enum IssuePriority {
  LOW
  MEDIUM
  HIGH
  URGENT
}

enum IssueStatus {
  NEW
  TRIAGED
  IN_PROGRESS
  RESOLVED
  CLOSED
  DECLINED
}

/// Issue — reported by a contact (portal) or a member (staff).
/// `number` is a per-tenant friendly number from TenantCounter (gaps
/// acceptable — no legal requirement, unlike invoices).
/// visibility: DB default INTERNAL per the global rule (§5); the app
/// sets CLIENT_VISIBLE on contact-created issues (they must see their
/// own reports). Staff can keep internal issues invisible to the portal.
/// fixedInVersionId links the fixing release (§6: "link an issue to the
/// release that fixes it") — composite FK to ProjectVersion.
/// Attachments: Documents anchored (ISSUE, issueId) — §10.
/// scope=client  rls=B  ret=R2  enc=none
/// audit: issue.created | issue.triaged | issue.status_changed | issue.assigned | issue.linked_version | issue.closed
model Issue {
  id                  String        @id @default(uuid(7))
  tenantId            String
  clientId            String                     // reporter's client; scoping anchor
  projectId           String?
  number              Int                        // per-tenant friendly number (TenantCounter)
  type                IssueType
  title               String
  body                String?
  priority            IssuePriority @default(MEDIUM)
  status              IssueStatus   @default(NEW)
  visibility          Visibility    @default(INTERNAL)  // app forces CLIENT_VISIBLE for contact-created
  reportedByContactId String?
  reportedByMemberId  String?
  assigneeMemberId    String?
  fixedInVersionId    String?                    // → ProjectVersion (tenantId, id)
  resolvedAt          DateTime?     @db.Timestamptz(6)
  closedAt            DateTime?     @db.Timestamptz(6)
  createdAt           DateTime      @default(now()) @db.Timestamptz(6)
  updatedAt           DateTime      @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, number])
  @@unique([tenantId, id])                       // composite-FK target
  @@index([tenantId, clientId, status])
  @@index([tenantId, status, priority])
  @@index([tenantId, assigneeMemberId, status])
}

/// IssueComment — the thread. THE key visibility case: staff write
/// INTERNAL comments on CLIENT_VISIBLE issues (triage notes the client
/// must never see). DB default INTERNAL; contact comments forced
/// CLIENT_VISIBLE at app layer. The portal RLS restrictive policy
/// filters on (clientId, visibility) exactly as for Document.
/// This model is also the v2 seam for "messaging as threaded comments"
/// (competitive research) — no new tables needed later.
/// scope=client  rls=B  ret=R2  enc=none
/// audit: issue.comment_added | issue.comment_visibility_changed
model IssueComment {
  id              String     @id @default(uuid(7))
  tenantId        String
  clientId        String                         // denormalized for portal RLS
  issueId         String
  authorMemberId  String?
  authorContactId String?
  body            String
  visibility      Visibility @default(INTERNAL)  // app forces CLIENT_VISIBLE for contact comments
  editedAt        DateTime?  @db.Timestamptz(6)
  createdAt       DateTime   @default(now()) @db.Timestamptz(6)

  @@index([tenantId, issueId, createdAt])
  @@index([tenantId, clientId])
}

// ───────────────────────────────────────────────────────────────────
// 6.10 PERFORMANCE REPORTS (§6, §10.5)
// v1: MANUAL_UPLOAD (report PDFs as client-visible Documents, linked
// here for grouping) + CRUX_SNAPSHOT (API-key-only, free, cron-fetched
// per Project.productionUrl: https://developer.chrome.com/docs/crux/api
// — graceful empty state: small sites often have no CrUX data).
// v2: GSC_SYNC / GA4_SYNC via IntegrationConnection (service-account
// invite pattern preferred over OAuth — §10.5 research).
// ───────────────────────────────────────────────────────────────────

enum PerformanceReportKind {
  MANUAL_UPLOAD   // v1
  CRUX_SNAPSHOT   // v1
  GSC_SYNC        // v2
  GA4_SYNC        // v2
}

/// PerformanceReport — one report/datapoint set for a client (optionally
/// a project) over a period. metrics JSON shape per kind; for
/// CRUX_SNAPSHOT (v1): { formFactor, lcpP75Ms, inpP75Ms, clsP75,
/// ttfbP75Ms, histograms: {...}, collectionPeriod: {...} } — the raw
/// CrUX API record, chart-ready. For MANUAL_UPLOAD, documentId points
/// at the uploaded file (its own visibility applies to the file; this
/// row's visibility gates the chart/listing).
/// scope=client  rls=B  ret=R2  enc=none
/// audit: performance_report.created | performance_report.published (visibility flip)
model PerformanceReport {
  id          String                @id @default(uuid(7))
  tenantId    String
  clientId    String
  projectId   String?
  kind        PerformanceReportKind
  subjectUrl  String?                            // origin or page (CrUX subject)
  periodStart DateTime?             @db.Date
  periodEnd   DateTime?             @db.Date
  metrics     Json?                              // kind-specific; see comment
  documentId  String?                            // MANUAL_UPLOAD source file
  visibility  Visibility            @default(INTERNAL)
  fetchedAt   DateTime?             @db.Timestamptz(6)  // sync kinds
  createdAt   DateTime              @default(now()) @db.Timestamptz(6)

  @@index([tenantId, clientId, kind, periodEnd])
  @@index([tenantId, projectId, kind])
}

// ───────────────────────────────────────────────────────────────────
// 6.11 AUDIT (§9, strategy in §3 of this doc)
// ───────────────────────────────────────────────────────────────────

enum ActorType {
  MEMBER
  CONTACT
  PLATFORM_ADMIN
  SYSTEM           // cron jobs, webhooks, auto-grants
}

enum AuditVisibility {
  TENANT     // appears in the tenant's own activity log (and platform's)
  PLATFORM   // platform log only
}

/// AuditEvent — THE audit table: one event model, one capture mechanism,
/// two audiences via write-time visibility (§9). Append-only (runtime
/// role: INSERT+SELECT only, plus raise-exception trigger). NO foreign
/// keys — rows must survive their actors, targets, and (for PLATFORM
/// events) the tenant itself; tenantId/actorId/targetId are plain
/// columns. createdAt is DB now(), never app-supplied. id is UUIDv7 —
/// time-ordered inserts. action comes from the static event catalog
/// (§3.1) which also fixes visibility per event type.
/// impersonatorId: set on every event performed under impersonation —
/// both identities, always (§7).
/// metadata: minimized — never plaintext of encrypted fields, never
/// document contents, never personnummer (§4).
/// scope=mixed (tenantId nullable)  rls=AU  ret=R3  enc=none
model AuditEvent {
  id             String          @id @default(uuid(7))   // UUIDv7
  tenantId       String?                        // NULL = platform-plane event
  actorType      ActorType
  actorId        String?                        // User.id | Contact.id | null for SYSTEM
  impersonatorId String?                        // platform admin User.id when impersonating
  action         String                         // namespaced, from static catalog: "invoice.issued"
  targetType     String?                        // "Invoice", "ContinuityBox", …
  targetId       String?
  metadata       Json?                          // JSONB; minimized diff/context
  requestId      String?                        // AsyncLocalStorage-propagated
  ip             String?
  userAgent      String?
  visibility     AuditVisibility
  createdAt      DateTime        @default(now()) @db.Timestamptz(6)  // DB now()

  @@index([tenantId, createdAt(sort: Desc)])
  @@index([tenantId, targetType, targetId])
  @@index([actorType, actorId, createdAt(sort: Desc)])
  @@index([requestId])
}

// ───────────────────────────────────────────────────────────────────
// 6.12 CONTINUITY BOX (§8) — schema only; full protocol, crypto and
// legal framing in CONTINUITY_BOX.md. Decisions #1 (2-of-3 Shamir) and
// #2 (open-once + 7-day window) are settled.
// The database NEVER holds plaintext contents or a usable key:
// contents are sealed client-side with age (typage:
// https://github.com/FiloSottile/typage/blob/main/README.md) into ONE
// blob in the R2 EU bucket (bucket-locked); the age key is split 2-of-3
// (audited https://github.com/privy-io/shamir-secret-sharing):
//   Share A — printed continuity card, client-held, never touches server
//   Share B — below, ciphertext at rest (one share alone is useless)
//   Share C — trustee (client's lawyer or second contact)
// A DB dump plus the R2 bucket together still reveal nothing. Trigger
// model = Bitwarden-style request + veto window with auto-grant:
// https://bitwarden.com/help/emergency-access/
// ───────────────────────────────────────────────────────────────────

/// Box status. OPEN_REQUESTED EXISTS (stated identically in
/// CONTINUITY_BOX.md §3.2): it is a display/query convenience meaning "a
/// PENDING ContinuityOpenRequest exists", not a crypto state — the box is
/// still sealed and a veto returns it to SEALED. The exactly-once
/// transition guarded in §6.13 is (SEALED | OPEN_REQUESTED) → OPENED.
enum ContinuityBoxStatus {
  SEALED           // the steady state; reseals stay SEALED (sealVersion++)
  OPEN_REQUESTED   // a PENDING ContinuityOpenRequest exists; still sealed
  OPENED           // irreversible; download window running or elapsed
  CLOSED           // retired: window elapsed, client offboarded, or tenant closed per retention
}

enum TrusteeKind {
  CONTACT    // second contact at the client
  EXTERNAL   // client's lawyer etc. — name/email only, no login
}

/// ContinuityBox — one sealed box per client (§8): @@unique(tenantId,
/// clientId). Authored/resealed only by members holding
/// continuity_box:edit (trigger/trustee/fallback config requires
/// continuity_box:configure); opened exactly once (atomic conditional
/// transition — §6.13); survives billing lapse (R5 — deliberate
/// entitlement exemption). resealDueAt drives the quarterly reseal
/// ritual (content rot is the real product risk); contact offboarding
/// forces a reseal (card holder change).
/// contentChecklist is METADATA ONLY (which checklist categories the
/// blob covers — domain/DNS, hosting, repo, vault pointers…), never
/// content. Contents are pointers + recovery instructions, not live
/// credentials (§8, founder lean confirmed).
/// scope=client  rls=B (portal sees status of its own box; beneficiary
///   gating is app-layer)  ret=R5  enc=shareBCiphertext
/// audit: continuity_box.sealed | .resealed | .beneficiary_changed | .trustee_changed | .opened | .download_issued | .closed
model ContinuityBox {
  id                   String              @id @default(uuid(7))
  tenantId             String
  clientId             String
  status               ContinuityBoxStatus @default(SEALED)  // row exists only once first sealed
  // Blob (R2 EU-jurisdiction bucket, bucket-locked; NOT a FileObject):
  blobKey              String?             @unique
  blobSha256           String?
  blobSizeBytes        BigInt?
  sealedAt             DateTime?           @db.Timestamptz(6)
  sealedByMemberId     String?
  sealVersion          Int                 @default(0)       // increments per CONTENT reseal; old blob destroyed
  templateVersion      Int?                                  // contents-template generation sealed (CONTINUITY_BOX.md §2.6)
  attachmentCount      Int                 @default(0)       // COUNT ONLY — never a file list; the manifest lives inside the ciphertext
  resealDueAt          DateTime?           @db.Timestamptz(6) // quarterly ritual reminder
  // Key custody (decision #1):
  keyScheme            String              @default("age-x25519+shamir-2of3.v1")
  recipientPublicKey   String?                               // age1… recipient — printed on the cards as the key fingerprint
  keyGeneration        Int                 @default(1)       // increments per RE-KEY only; matches a card to a generation (§2.7)
  rekeyRequired        Boolean             @default(false)   // flag, not a status: cardholder offboarded / card lost / trustee changed (§7)
  shareBCiphertext     String?                               // ENCRYPTED platform share — useless alone
  beneficiaryContactId String?                               // CARDHOLDER OF RECORD (holds the Share A card). NOT the gate on who may request — see ContinuityOpenRequest
  trusteeKind          TrusteeKind?
  trusteeContactId     String?                               // when trusteeKind = CONTACT
  trusteeName          String?                               // when EXTERNAL
  trusteeEmail         String?
  // Fallback notification target (brief §8 "plus any nominated fallback
  // contact") — a notification target, never a principal: no login, no veto:
  fallbackContactName  String?
  fallbackContactEmail String?
  fallbackContactPhone String?                               // SMS dispatch is v2; the number is recorded from v1
  // Trigger config (per-box, tenant-set within platform bounds):
  vetoWindowDays       Int                 @default(21)      // 7–60 configurable, 21 default per CONTINUITY_BOX.md §3.2
  cooldownDays         Int                 @default(30)      // after a veto
  nextRequestAllowedAt DateTime?           @db.Timestamptz(6) // cooldown gate
  // Open-once + window (decision #2):
  openedAt             DateTime?           @db.Timestamptz(6)
  openedByContactId    String?
  downloadWindowEndsAt DateTime?           @db.Timestamptz(6) // openedAt + 7 days (R2 presign max)
  closedAt             DateTime?           @db.Timestamptz(6)
  contentChecklist     Json?                                  // metadata only — categories covered
  createdAt            DateTime            @default(now()) @db.Timestamptz(6)
  updatedAt            DateTime            @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, clientId])                 // ONE box per client
  @@unique([tenantId, id])                       // composite-FK target
  @@index([tenantId, status])
  @@index([resealDueAt])                         // reseal-reminder sweep (cross-tenant SYSTEM job)
}

/// The eight states of CONTINUITY_BOX.md §3.2, spelled identically there.
enum ContinuityOpenRequestState {
  PENDING      // veto window running; all tenant admins notified, escalating
  WITHDRAWN    // requester cancelled
  VETOED       // any tenant admin vetoed in time → box back to SEALED, cooldown armed
  GRANTED      // window expired unvetoed (SYSTEM auto-grant), or approved early, or dispute upheld the request
  ESCALATED    // vetoed-but-disputed → platform-mediated human review (hostile-veto path)
  DENIED       // ESCALATED resolved in favor of the veto; extended cooldown
  CONSUMED     // the open ceremony ran — this request is what opened the box
  LAPSED       // GRANTED but not opened within 30 days; box stays SEALED, a new request restarts the procedure
}

/// ContinuityOpenRequest — the trigger state machine (§8). Created by
/// **any active Contact of the client whose portalProfile is
/// CONTACT_PRIMARY** (app-gated via the portal capability
/// portal.continuity.request_open — AUTHZ.md §8), only when
/// nextRequestAllowedAt allows. Deliberately NOT restricted to
/// beneficiaryContactId: that field records who holds the Share A card,
/// and the dead-cardholder recovery path (CONTINUITY_BOX.md §8) requires
/// another CONTACT_PRIMARY contact to be able to request. Per-contact
/// toggles are v2. State transitions (all audited, all transactional):
///   PENDING → WITHDRAWN | VETOED | GRANTED | ESCALATED(after veto dispute)
///   VETOED → ESCALATED (requester disputes; platform human review)
///   ESCALATED → GRANTED | DENIED (platform review outcome)
///   GRANTED → CONSUMED (open ceremony ran) | LAPSED (grantLapsesAt passed)
///   CONSUMED ⇒ box SEALED→OPENED atomically (see §6.13 / CONTINUITY_BOX.md)
/// corroboration snapshots platform-observed dead-man signals AT REQUEST
/// TIME (subscription lapsed? days since last staff login?) — signals
/// may badge/shorten, NEVER auto-open (§8 research). Veto sets box
/// cooldown; repeated vetoes with lapsed subscription auto-suggest
/// escalation.
/// scope=client  rls=B  ret=R5  enc=none
/// audit: continuity_box.open_requested | .request_withdrawn | .vetoed | .escalated | .granted
model ContinuityOpenRequest {
  id                   String                     @id @default(uuid(7))
  tenantId             String
  clientId             String                     // denormalized for portal RLS
  boxId                String
  state                ContinuityOpenRequestState @default(PENDING)
  requestedByContactId String
  reason               String?                    // free-text, shown to tenant admins in notifications
  corroboration        Json?                      // dead-man signal snapshot at request time
  requestedAt          DateTime                   @default(now()) @db.Timestamptz(6)
  vetoDeadlineAt       DateTime                   @db.Timestamptz(6)  // requestedAt + box.vetoWindowDays
  vetoedAt             DateTime?                  @db.Timestamptz(6)
  vetoedByMemberId     String?
  vetoReason           String?
  withdrawnAt          DateTime?                  @db.Timestamptz(6)
  grantedAt            DateTime?                  @db.Timestamptz(6)
  grantLapsesAt        DateTime?                  @db.Timestamptz(6)  // grantedAt + 30 days → LAPSED if unopened (§3.2)
  escalatedAt          DateTime?                  @db.Timestamptz(6)
  deniedAt             DateTime?                  @db.Timestamptz(6)  // ESCALATED → DENIED
  consumedAt           DateTime?                  @db.Timestamptz(6)  // the open ceremony ran
  resolutionNote       String?                    // platform-mediation outcome (ESCALATED path)
  createdAt            DateTime                   @default(now()) @db.Timestamptz(6)
  updatedAt            DateTime                   @updatedAt @db.Timestamptz(6)

  @@index([tenantId, boxId, state])
  @@index([state, vetoDeadlineAt])               // auto-grant sweep (SYSTEM, cross-tenant)
  @@index([state, grantLapsesAt])                // lapse sweep (SYSTEM, cross-tenant)
}

// ───────────────────────────────────────────────────────────────────
// 6.13 INTEGRATIONS (v2 — placeholder shape; the encrypted-credentials
// home demanded by §4 of this doc)
// ───────────────────────────────────────────────────────────────────

enum IntegrationProvider {
  FORTNOX                  // v2: invoice push (self-serve dev portal; marketplace review)
  GOOGLE_SEARCH_CONSOLE    // v2: GSC_SYNC
  GOOGLE_ANALYTICS         // v2: GA4_SYNC
  STRIPE_TENANT            // v1.5 option: tenant's own Stripe key for pay-now rails (§11)
}

enum IntegrationStatus {
  CONNECTED
  ERRORED
  REVOKED
}

/// IntegrationConnection — v2 (STRIPE_TENANT possibly v1.5). One row per
/// tenant per provider (per-client property mapping for GSC/GA4 lives in
/// connection config JSON until it earns a table).
/// scope=tenant  rls=A  ret=R2 (credentials hard-deleted on revoke)  enc=credentialsCiphertext
/// audit: integration.connected | integration.errored | integration.revoked
model IntegrationConnection {
  id                    String              @id @default(uuid(7))
  tenantId              String
  provider              IntegrationProvider
  status                IntegrationStatus   @default(CONNECTED)
  credentialsCiphertext String                       // ENCRYPTED (refresh token / API key)
  config                Json?                        // non-secret config (property ids, scopes)
  connectedByMemberId   String?
  lastSyncAt            DateTime?           @db.Timestamptz(6)
  lastErrorAt           DateTime?           @db.Timestamptz(6)
  createdAt             DateTime            @default(now()) @db.Timestamptz(6)
  updatedAt             DateTime            @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, provider])
}
```

---

## 7. Index strategy

Rules (in order of authority):

1. **Every tenant-scoped access path gets a composite index with `tenantId` leading** — the schema above never indexes a scoped column without `tenantId` in front (§5: composite indexes starting with `tenantId`). Single-column indexes on scoped tables exist only for cross-tenant SYSTEM sweeps (`resealDueAt`, `expiresAt`, `[state, vetoDeadlineAt]`) which legitimately run without tenant context under a privileged role.
2. **UUIDv7 PKs** keep inserts append-mostly in the PK b-tree; no per-tenant PK hotspots, no fragmentation tax from random v4.
3. **RLS policy columns are always indexed** — `tenantId` everywhere; `(tenantId, clientId, visibility)` on class-B tables the portal lists directly (`Document`); `(tenantId, clientId, …)` composites elsewhere cover the portal policy's `clientId` predicate as their second column. Policies use the InitPlan `(select current_setting(...))` form so the planner can use these indexes (per-row re-evaluation is the documented 1000× trap).
4. **Uniques double as indexes** — every `@@unique([tenantId, …])` is also the primary lookup path (e.g. `Invoice(tenantId, seriesId, number)`, `Issue(tenantId, number)`).
5. **Postgres does not auto-index FK columns** — junction second-columns get explicit composites (`RolePermission(tenantId, permissionId)`, `MemberClient(tenantId, clientId)`, `MemberRole(tenantId, roleId)`) because the authorization seam queries both directions.
6. **`AuditEvent`** gets exactly four indexes (activity feed, target history, actor history, request correlation) and no more — it is the highest-insert-rate table; every extra index is a write tax. No partitioning at this scale (§3).
7. **GIN** only where array/JSONB containment is actually queried (`Document.tags`). `entitlements`, `metadata`, `metrics` JSONB are read by row, never containment-searched — no GIN on them.

## 8. Tenant-scoped compound uniques (the invariants)

| Model | Unique | Meaning |
|---|---|---|
| `Tenant` | `slug` (global) | v2 subdomain reservation, day 1 |
| `User` | `email` (global) | one member identity per email |
| `Contact` | `email` (global, **v1 only** — Pushback P2) + `(tenantId, email)` (permanent) | portal login key; person-per-tenant |
| `Member` | `(tenantId, userId)` | one membership per user per tenant |
| `Role` | `(tenantId, name)` | no duplicate role names within a tenant |
| `RolePermission` | `(tenantId, roleId, permissionId)` PK | grant is a set |
| `MemberRole` | `(tenantId, memberId, roleId)` PK | assignment is a set |
| `MemberClient` / `MemberProject` | `(tenantId, memberId, clientId/projectId)` PK | assignment is a set |
| `Permission` | `code` (global) | immutable catalog (`resource:verb`) |
| `StripeWebhookEvent` | `eventId` (global) | webhook idempotency — the constraint *is* the guarantee (§6.2) |
| `ProjectVersion` | `(tenantId, projectId, version)` | version labels unique per project |
| `InvoiceSeries` | `(tenantId, code, fiscalYearLabel)` | one counter per series per fiscal year |
| `Invoice` | `(tenantId, seriesId, number)` | the gap-free series integrity backstop (drafts: number NULL, distinct in PG) |
| `InvoiceLine` | `(tenantId, invoiceId, position)` | stable line ordering |
| `FileObject` | `r2Key` (global) | one row per blob |
| `FileVersion` | `(tenantId, documentId, versionNumber)` | monotonic versions |
| `Issue` | `(tenantId, number)` | friendly per-tenant numbering |
| `ContinuityBox` | `(tenantId, clientId)` | **one box per client** (§8) |
| `TenantPreference` | `(tenantId, key)` | one value per key |
| `TenantCounter` | `(tenantId, key)` PK | one counter per key |
| `IntegrationConnection` | `(tenantId, provider)` | one connection per provider |
| Parents (`Client`, `Project`, `Member`, `Role`, `Service`, `Contract`, `Invoice`, `Issue`, `ProjectVersion`, `Document`, `FileObject`, `InvoiceSeries`, `ContinuityBox`) | `(tenantId, id)` | composite-FK targets — the anti-cross-tenant-`connect` constraint (§2.3) |

## 9. Gap-free invoice number allocation (spec)

Numbers exist only on issued invoices; issuance is one transaction (physical snake_case names per §1.3):

```sql
BEGIN;  -- withTenant() transaction; app.tenant_id already set

-- 1. Lock + increment the series counter (row lock serializes
--    concurrent issuance per series; NOT a SEQUENCE — sequences are
--    non-transactional and leak numbers on rollback):
UPDATE invoice_series
   SET last_number = last_number + 1
 WHERE id = $seriesId AND tenant_id = $tenantId
RETURNING last_number;            -- => the allocated number, e.g. 104

-- 2. Freeze the invoice in the same transaction:
UPDATE invoice
   SET status = 'ISSUED', number = 104,
       display_number = 'A-104', issue_date = CURRENT_DATE,
       issued_at = now(), issued_by_member_id = $memberId,
       seller_snapshot = $frozenSeller, buyer_snapshot = $frozenBuyer, …
 WHERE id = $invoiceId AND tenant_id = $tenantId
   AND status = 'DRAFT';          -- conditional: issuance is not repeatable

-- 3. audit.record('invoice.issued', …)  -- same transaction (§3)

COMMIT;  -- any failure rolls back counter, invoice AND audit row → no gap
```

Properties: **atomic** (counter and status move together or not at all), **concurrency-safe** (the `UPDATE` takes a row lock on the series; the second issuer waits and gets 105), **gap-free** (rollback returns the counter; there is no burned number), **draft-safe** (drafts have no number — deleting a draft can never create a gap; issued invoices are undeletable — corrections via `CREDIT_NOTE` only). The `@@unique([tenantId, seriesId, number])` constraint is the backstop if any code path misbehaves. This matches Skatteverket's unbroken-series expectation (guidance, not statute — designing to the stricter reading costs nothing).

## 10. Polymorphic attachment: the chosen pattern

**Chosen: hard columns for authorization + soft pointer for anchoring.** `Document` carries real, composite-FK-constrained `tenantId`/`clientId` (+ indexed `projectId`) — everything authorization and RLS ever read — plus an unconstrained `(attachedToType, attachedToId)` pair that only says *where the file is displayed*. App code validates the anchor at write time (target exists, belongs to same tenant and, where applicable, same client); a periodic sweep flags dangling anchors (cosmetic, not a security event).

Rejected alternatives:

- **Exclusive arc** (one nullable FK per attachable entity + CHECK that exactly one is set): referentially perfect, but eight nullable FK columns today and a migration + CHECK rewrite every time an entity becomes attachable. The churn cost lands on the highest-traffic table in the product.
- **Typed join tables** (`DocumentOnIssue`, `DocumentOnProject`, …): same churn, plus N tables and N query branches for one listing surface.
- **Pure polymorphism** (`entityType`/`entityId` used for authorization): the classic mistake — scoping decisions would traverse an unconstrained pointer. Explicitly not what this design does.

The decisive argument: **the security-relevant dimensions of a file are tenant, client, and visibility — never "what it is pinned to."** A document attached to an Issue is client-visible because its own row says `(clientId=X, visibility=CLIENT_VISIBLE)`, not because the issue is. That keeps the §5 invariant enforceable at the data layer with real constraints, while the anchor stays flexible enough that "attachable to any entity" (§6) never needs another migration.

## 11. Deliberate omissions — and why

| Omission | Verdict | Why |
|---|---|---|
| **Stripe Connect** | absent by design | Platform bills tenants directly; `Tenant.stripeCustomerId` is the only Stripe artifact. Pay-now (v1) settles on the **tenant's own rails**: `Invoice.paymentLinkUrl` (tenant-provided link) or, at v1.5, the tenant's own Stripe key via `IntegrationConnection(STRIPE_TENANT)` — money never flows through the platform, so no Connect onboarding, no payout liability. If tenants ever charge clients *through us*, Connect is a v2+ integration surface; nothing here needs re-modeling ([account types can't be converted](https://docs.stripe.com/connect/accounts) — good reason not to guess now). |
| **Forms / intake builder** | v2 | Decision #7: the Issue queue *is* v1 intake. A form is a nicer skin on `Issue.type=REQUIREMENT`. |
| **Proposals / quotes** | v2 | `Service` + `Contract` cover the v1 job; quote-accept composes with the SES flow later. |
| **Recurring billing engine** | v2 | `Service.renewsAt` powers reminders; auto-generating invoices adds proration/dunning surface with no v1 payer. |
| **Messaging / chat** | v2 | `IssueComment` is the seam; full chat is a quarter of work (competitor research). |
| **Time tracking / scheduling / email marketing** | skip | Freelancer-lane table stakes, not this ICP; integrate, don't build (research 10.8). |
| **Peppol / e-invoice transmission** | v2/v3 | EN 16931 alignment is in the model now; transmission is an adapter. Never Svefaktura (withdrawn 2021). |
| **Fortnox/Bokio push** | v2 | `IntegrationConnection(FORTNOX)` placeholder; marketplace review + end-customer license make it a project, not a field. |
| **GSC/GA4 sync** | v2 | `PerformanceReportKind` reserves the kinds; v1 ships uploads + CrUX (API-key only). |
| **Notification/inbox model** | v2 | v1 notifies via transactional email; deliveries that matter are audit events. A `Notification` table earns its place with in-app inbox (Phase 5). |
| **Custom domains / subdomain routing tables** | v2 | Decision #8: single app domain v1. `Tenant.slug` is reserved; hostname→tenantId resolution is a stubbed seam, a `TenantDomain` table arrives with the feature. |
| **Per-tenant DEK / KMS envelope** | v2 | The `v1.<keyId>.` ciphertext prefix is the seam; env-var key is proportionate at v1 (SECURITY.md). |
| **API tokens / public API / webhooks** | v2 | `api_token.*` audit actions reserved in the catalog; no table until the surface exists. |
| **SIE export / verifikationer / bookkeeping** | skip | The line drawn by decision #3: we are a försystem issuing invoices; the tenant's accounting tool is the bookkeeping source of truth. Building toward SIE drags in systemdokumentation and audit expectations (§10.2 research). |
| **Kanban/Gantt tables** | v2 (views) | Board = view over `Issue`; timeline = `Milestone` + `ProjectVersion`. No new storage. |
| **Tenant-customizable portal roles** | v2 if demanded | See Pushback P1. |
| **AI features** | none | Room left via JSONB metadata; no schema commitment (market trend noted, not chased). |

## 12. Pushback & flagged tensions (§12: disagree in the doc)

**P1 — Portal contact "roles" are a hardcoded enum, not the Role machinery.** Brief §3 lists "portal-side Contact roles" among the cloneable templates. I spec'd `ContactPortalProfile { CONTACT_PRIMARY, CONTACT_COLLABORATOR }` (the fixed profiles of `AUTHZ.md` §8, `CONTACT_FINANCE` reserved v2) instead: contacts are a different principal with a hardcoded capability set (§3's own "physically separate paths" requirement, decision #6, research architecture rule). Putting contacts into tenant-customizable RBAC would reopen the exact ambiguity the separation exists to kill, for a customization no competitor's customers demonstrably use. If a tenant ever needs per-contact granularity beyond two levels, that is a v2 enum extension (`CONTACT_FINANCE`) or a portal-capability matrix — still never the member Role tables.

**P2 — `Contact.email` is globally unique in v1.** A consequence of decision #8 (single app domain): portal login is email-keyed with no Host to disambiguate, and the Better Auth portal instance expects a unique login identifier. Cost: the same person cannot be a portal contact of two different tenants with one email in v1 (rare at tens of tenants; workaround: plus-addressing). This is deliberately the cheap direction of travel — *relaxing* to the permanent `(tenantId, email)` unique when subdomain login lands is a constraint drop; the reverse would be a data migration. Flagged for `OPEN_QUESTIONS.md` (can wait).

**P3 — `Tenant.databaseUrl` weakens the "DB dump reveals nothing" posture for itself.** The plan requires the column from day 1 (physical-isolation escape hatch). Storing a live connection string — even AES-GCM-encrypted with an env-held key — means a DB dump *plus* the app environment yields tenant-DB credentials. Recommendation: keep the column but store a **cell name** resolved via environment/secret store at runtime (`databaseUrl` stays null forever); the column exists because migrating it in later is harder than ignoring it now. Spec'd as decided; noted here.

**P4 — "Sequential per tenant" (brief §6) is really "unbroken per series per fiscal year".** Swedish law wants a löpnummer within one or more series, unbroken through the fiscal year (Skatteverket 2023 guidance); a tenant may legitimately run several series. `InvoiceSeries` models the law; a tenant with one series gets exactly the brief's behavior. Not a disagreement — a refinement the brief's §10.2 research clause anticipated.

**P5 — "MFA available everywhere" (§9) is staged.** Member/platform MFA (TOTP + passkeys, mandatory for owner-equivalent and platform roles) is v1. **Contact MFA is v2**: the portal is invite-only, rate-limited, and read-mostly in v1, and the second Better Auth instance makes adding `ContactTwoFactor` additive. The brief's word "everywhere" is not fully honored in v1 — deliberate, visible here, revisit if a tenant's client demands it (likely alongside BankID, which is itself a stronger factor).

**P6 — `Client.internalNotes` (and `Project.repoUrl`/`hostingNotes`) rely on projection, not RLS.** RLS is row-level; these are internal-only *columns* on portal-visible rows. The portal read model uses explicit `select` allowlists (never `SELECT *`/default Prisma selects on class-B models in portal code — lintable), with optional column-level `REVOKE` under a dedicated portal DB role as a second belt (TENANCY.md). Field-in-row was chosen over a separate always-INTERNAL `ClientNote` table to keep §6's "internal private notes" a one-field feature; if notes grow authorship/history, promote to a Document with `visibility=INTERNAL`.

**P7 — "Open exactly once" is spec'd as open-once-then-window.** Decision #2 settled this against a literal burn-on-read (which demonstrably strands clients on failed transfers — Google and Apple both do open-then-window). The schema encodes it: the `SEALED→OPENED` transition is the exactly-once event (conditional update, audited); `downloadWindowEndsAt` bounds re-downloads of the same blob at 7 days (the R2 presign maximum). Marketing language follows the decision: "opened exactly once, downloadable for 7 days, fully logged."

---

*End of DATA_MODEL.md. Schema version 0.1 — every change to entity names or key structure after Phase 1 begins requires updating this file first; the other seven docs reference these names.*
