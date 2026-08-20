# DATA_MODEL.md — Fortleva

**Status:** Phase 0 draft (spec artifact — no migration has been run, no application code exists). **Amended 2026-08-16 (work-management plan, decisions 11–13):** schema version 0.2 — Work (§6.14), Time (§6.15), Progress updates (§6.16), Vault & assets (§6.17), Notifications & email (§6.18), Search (§6.19) added; `Issue`/`IssueComment` superseded by `WorkItem(kind=REQUEST)` + `Comment`; the `portal_enabled` refinement of class B (§2.3); crypto v2 + `TenantKey` (§4). Every amendment is dated in place; nothing pre-existing was deleted silently. Authority: `PLAN.md` §3 (phases 1b/2W/2T/3V), `OPEN_QUESTIONS.md` decisions 11–13, `docs/research/2026-08-16-work-management-synthesis.md` §4.
**Date:** 2026-08-03 (v0.1) · 2026-08-16 (v0.2). **Owner docs upstream:** `TENANCY.md` (enforcement mechanics), `AUTHZ.md` (permission catalog, gates), `SECURITY.md` (threat model, key handling), `CONTINUITY_BOX.md` (box protocol).
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

*(added 2026-08-16 — work-management plan §3.1)* **Task** is the UI word for a `WorkItem` row (any level); the levels are **Epic / Task / Subtask** (`WorkItem.type`); "Request" is a `WorkItem` with `kind = REQUEST`. "Issue" is no longer a product word (§1.2 superseded note). Namespaces stay distinct: permission codes `resource:verb` (`work_item:edit`), audit actions `entity.verb` (`work_item.state_changed`), portal capabilities `portal.area.verb` (`portal.work_item.act`).

### 1.2 Canonical entity names

`Tenant, User, Member, Role, Permission, RolePermission, MemberRole, MemberClient, MemberProject, Client, Contact, Project, ProjectVersion, Milestone, Service, Contract, ContractSignature, InvoiceSeries, Invoice, InvoiceLine, Document, FileObject, FileVersion, ~~Issue, IssueComment~~ (superseded 2026-08-16, below), PerformanceReport, AuditEvent, ContinuityBox, ContinuityOpenRequest, TenantPreference, FeatureFlag`.

Supporting models (this doc's additions, still canonical): `Session, Account, Verification, TwoFactor, Passkey` (Better Auth, member side), `ContactSession, ContactAccount, ContactVerification` (portal auth), `MemberInvite`, `TenantCounter`, `StripeWebhookEvent` (webhook idempotency ledger, §6.2), `IntegrationConnection` (v2). Tenant entitlements are a **versioned JSON column `entitlements` on `Tenant`**, not a table (§4).

**Amended 2026-08-16 (work-management plan).** Added canonical names, by module:

- **Work** (`work`, Phase 2W — §6.14): `WorkItem` (**UI word: "Task"**; levels Epic / Task / Subtask via `WorkItem.type`), `WorkflowState`, `WorkflowPreset`, `WorkItemActivity`, `Comment` (polymorphic; **replaces `IssueComment`**), `Mention`, `Label`, `WorkItemLabel`, `WorkItemCollaborator`, `WorkItemSubscriber`, `ProjectTemplate`.
- **Time** (`time`, Phase 2T — §6.15): `TimeEntry`, `RateCard`, `ProjectBudget`, `BudgetAlert`, `ProjectTimeSummary`, `StaffNotice`, `StaffNoticeAcknowledgment`, `Shift`, `ShiftBreak`, `TimeReport`, `WorkType` *(last four added 2026-08-20 — founder time-tracking extensions)*; Phase 4: `RoundingRule`, `InvoiceLineTimeEntry`, `RetainerPlan`, `RetainerPeriod`, `HourBankTransaction`.
- **Progress updates** (rides on `work`, Phase 3 — §6.16): `ProjectUpdate`, `ProjectUpdateInternalSnapshot`; Phase 5: `ProjectUpdateSchedule`, `ProjectUpdateTemplate`.
- **Vault & assets** (`vault`, Phase 3V — §6.17): `TenantKey` (Phase 1b, core), `CredentialItem`, `CredentialSecret`, `CredentialVersion`, `CredentialAccessGrant`, `CredentialShareLink`, `ClientAsset`, `ExpirationReminderSent`; later: `AssetCheck`.
- **Notifications & email** (core, never entitlement-gated, Phase 2W — §6.18): `Notification`, `Subscription`, `NotificationPreference`, `EmailOutbox`, `EmailSuppression`; Phase 5: `PushSubscription`; later: `InboundEmail`.
- **Search** (core, Phase 2W — §6.19): `search_index` (deliberately a lower-case physical name — hand-written DDL, generated column, no Prisma model semantics beyond a thin read mapping).

**Superseded 2026-08-16:** ~~`Issue`, `IssueComment`~~ — absorbed by `WorkItem(kind=REQUEST)` + `Comment(subjectType=WORK_ITEM)` (plan §3.1). The §6.9 draft is kept for history under a superseded header; the `issues` entitlement key remains as a deprecated alias and the five `issue:*` permission codes stay in the catalog (immutable) but are unseeded from `TEMPLATE_VERSION` 2 (AUTHZ.md — first deprecation). No table named `issue` or `issue_comment` is created.

### 1.3 Scalar conventions

- **IDs:** `String @id @default(uuid(7))` everywhere (Prisma ≥ 5.19). UUIDv7 is time-ordered — b-tree-friendly inserts, sortable by creation, no per-tenant hotspot. No serial integers as PKs; human-facing sequence numbers (invoices, work-item numbers ~~issues~~) are separate columns.
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
- **enc** — fields encrypted with the app AES-256-GCM field service (`v1.<keyId>.<iv>.<ct>.<tag>` format; key in env v1, seam for per-tenant DEK + KMS later — see `SECURITY.md`). **Amended 2026-08-16 (decision 12):** new ciphertext is written in the **v2 format** `v2.<rootKeyId>.<tenantKeyId>.<iv>.<ct>.<tag>` with AAD `tenantId:model:rowId:field` under a per-tenant DEK (`TenantKey`, §6.17); v1 stays decryptable. See §4.
- **Class-B refinement (amended 2026-08-16):** every model whose `rls=B` line says `projectScoped` also carries the trigger-maintained `portal_enabled` column (§2.3); it is elided from the field lists below (mechanical, like `@@map`) except where a model is new in this amendment and the column is spelled out for emphasis.
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
| **B — client-scoped** | Class A policy **plus** a RESTRICTIVE portal policy: when `app.principal = 'contact'`, row must satisfy `clientId = app.client_id` AND (where the model has `visibility`) `visibility = 'CLIENT_VISIBLE'`. Restrictive (AND-ed), never permissive (OR-ed) — permissive policies OR together, which is the footgun. | `Client`, `Contact`, `Project`, `ProjectVersion`, `Milestone`, `Service`, `Contract`, `ContractSignature`, `Invoice`, `InvoiceLine`, `Document`, ~~`Issue`, `IssueComment`~~ *(superseded 2026-08-16 — `WorkItem`, `Comment` below)*, `PerformanceReport`, `ContinuityBox`, `ContinuityOpenRequest` |
| **AU — audit** | Append-only: runtime role has INSERT + SELECT only (`REVOKE UPDATE, DELETE`) plus a raise-exception trigger. Tenant reads filter `tenantId = app.tenant_id AND visibility = 'TENANT'`. | `AuditEvent` |
| **T — tenant root** | The `Tenant` row itself: platform plane writes it; tenant plane reads its own row (policy on `id = app.tenant_id`). | `Tenant` |

**Amended 2026-08-16 (work-management plan §3.2) — class-B refinement and registry subclasses.** The two-term portal gate above is unchanged for client-scoped rows without a project. Project-scoped class-B rows gain a third term:

| Registry subclass (`src/db/model-registry.ts`) | Class | Required columns / policy | Models |
|---|---|---|---|
| `principalScoped` | A | `portal_deny`; **never a `visibility` column** — a class-A table carrying one is a posture-test failure (it invites a later "just gate it" shortcut). | all class-A models above + `WorkflowState`, `WorkflowPreset`, `Label`, `WorkItemLabel`, `WorkItemCollaborator`, `WorkItemSubscriber`, `Mention`, `ProjectTemplate`, `TimeEntry`, `RateCard`, `ProjectBudget`, `BudgetAlert`, `StaffNotice`, `StaffNoticeAcknowledgment`, `RoundingRule`, `ProjectUpdateInternalSnapshot`, `TenantKey`, `CredentialSecret`, `CredentialVersion`, `CredentialAccessGrant`, `CredentialShareLink`, `ExpirationReminderSent`, `Subscription`, `NotificationPreference`, `EmailOutbox`, `PushSubscription` |
| `clientScoped` | B | `client_id`, `visibility`, RESTRICTIVE `portal_gate` in the two-term form `client_id = app.client_id AND visibility = 'CLIENT_VISIBLE'`. | `Client`, `Contact` (structural — client match only), `Document` without `projectId`, `Contract`, `ContractSignature`, `Invoice`, `InvoiceLine`, `PerformanceReport`, `ContinuityBox`, `ContinuityOpenRequest`, `CredentialItem`, `ClientAsset` |
| `projectScoped` | B | `client_id`, `visibility`, **`portal_enabled boolean NOT NULL DEFAULT false`** (denormalised from `Project.portalEnabled`, maintained by an `AFTER UPDATE OF portal_enabled ON project` trigger fanning out to every projectScoped table in the same transaction, and set on INSERT by a BEFORE trigger reading the parent project), RESTRICTIVE `portal_gate` in the **three-term form** `portal_gate = client_id = app.client_id AND visibility = 'CLIENT_VISIBLE' AND portal_enabled`. | `Project` (its own row: `client_id` + `portal_enabled` — a project row is a structural row, so the visibility term is replaced by `portal_enabled`), `Milestone`, `ProjectVersion`, `Service`, `Document` with `projectId`, `WorkItem`, `WorkItemActivity`, `Comment`, `ProjectUpdate`, `ProjectTimeSummary`, `search_index` rows with `project_id` |
| (special) | — | `Notification`: contact rows readable/updatable (`read_at`, `archived_at` only) under `receiver_type='CONTACT' AND receiver_id = app.principal_id AND client_id = app.client_id`. | `Notification` |

- **`app.principal_id` GUC** (Phase 1b): `withTenant()` sets `app.principal_id` (Member.id or Contact.id) transaction-locally alongside `app.tenant_id` / `app.principal` / `app.client_id`, so contact-authored `WITH CHECK` clauses can bind the author column (`author_contact_id = app.principal_id`) and `Notification` rows can bind the receiver.
- **Posture test** (CI): for every registered model the subclass implies its column set and policy names; a projectScoped table missing `portal_enabled`, or a principalScoped table carrying `visibility`, fails the build. Behavioural test: flipping `Project.portalEnabled=false` ⇒ 0 rows for a contact principal across every projectScoped table.
- **Contact-writable census (amended 2026-08-16, replaces the list in the note below):** exactly `Comment` (INSERT, `WITH CHECK visibility='CLIENT_VISIBLE' AND client_id=app.client_id AND author_contact_id=app.principal_id`), `ProjectVersion` approval columns, `Document` approval columns, `Notification.read_at/archived_at` on contact-receiver rows, `ContinuityOpenRequest`. **Every other contact-caused write** (REQUEST creation, completing an own-assigned task, credential submission, uploads) is brokered under `withTenant(tenantId, {type:'system'})` after `authorizePortal()`, in `src/modules/*/portal.ts`. Portal *reads* always run under the RLS-scoped contact principal — never a system principal.
- Why a column and not a subquery: under FORCE RLS a `project.portal_enabled` subquery inside a RESTRICTIVE policy re-evaluates `project`'s own policies per row for the contact principal — the same footgun family as `ProjectTimeSummary`-as-view (§11). A trigger-fanned boolean keeps `portal_gate` a pure column comparison, which is the only shape TENANCY.md §7.2's template has ever had.

Notes:
- `FileVersion`/`FileObject` are deliberately class A even though portal downloads exist: the portal never queries the file layer. A portal download resolves through `Document` (class B, visibility-checked), then the server issues an audited, short-lived presigned URL. Signed URLs are authorization-checked at issue time (§9), which is the real gate for bytes.
- **Contacts never write the file layer — uploads are brokered** (decided; stated identically in `TENANCY.md` §7.2 and `SECURITY.md` §5). A contact's ~~issue~~ request/comment attachment is not a contact-principal INSERT: the server action runs `authorizePortal(contact, ~~'portal.issue.create'~~ 'portal.request.create' | 'portal.comment.create'…)` *(capability names amended 2026-08-16, AUTHZ.md §8)* first, then re-enters `withTenant()` as the **`system` principal** to create the `Document` (forced `clientId` = the contact's client, forced `CLIENT_VISIBLE`), `FileVersion` and `FileObject` rows. `FileObject`/`FileVersion` therefore keep the `portal_deny` RESTRICTIVE policy with no INSERT exception, and `Document.createdByContactId` / `FileVersion.uploadedByContactId` / `FileObject.createdByContactId` are **attribution columns only** — they record who caused the upload, never who performed the write. ~~The contact-writable set is exactly `Issue`, `IssueComment`, `ContinuityOpenRequest`, plus the approval columns of `ProjectVersion` (decision #7 sign-off)~~ **(superseded 2026-08-16 — see the amended census above: `Comment` INSERT, `ProjectVersion` + `Document` approval columns, `Notification.readAt/archivedAt`, `ContinuityOpenRequest`; REQUEST creation is brokered, not a contact INSERT)**; CI asserts that set (`TENANCY.md` §11).
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

*(rows below added 2026-08-16 — work-management plan; per-phase in PLAN.md. Routine field edits on a WorkItem are `WorkItemActivity` history, not audit — only privileged/state-changing operations are catalogued.)*

| Domain | Events |
|---|---|
| Work (2W) | `work_item.created`, `work_item.deleted`, `work_item.state_changed`, `work_item.visibility_changed`, `work_item.triaged`, `work_item.archived`, `work_item.bulk_edited`, `comment.deleted`, `comment.visibility_changed`, `workflow.changed`, `label.created`, `label.deleted`, `project_template.applied`, `notification.preference_changed`, `search.index_rebuilt` [TENANT] |
| Time (2T) | `timer.started`, `timer.stopped`, `timer.auto_stopped`, `time_entry.created`, `time_entry.edited_by_other`, `time_entry.deleted`, `time_entry.locked`, `time_entry.unlocked`, `time_entry.repriced`, `time.exported`, `rate_card.created`, `rate_card.closed`, `rate_card.cost_revealed` (aggregate, per session — never per row), `budget.created`, `budget.changed`, `budget.alert_sent`, `staff_notice.published`, `staff_notice.acknowledged` [TENANT]. **Metadata never contains a cost amount** — card id + field only. |
| Portal & sharing (2, 3) | `project.portal_enabled`, `project.portal_disabled`, `project.hours_sharing_changed`, `project.key_changed`, `project.viewed_as_contact`, `project_update.published`, `project_update.archived`, `project_update.visibility_changed`, `portal.request_created`, `portal.comment_created`, `portal.task_completed`, `document.approval_requested`, `document.approval_decided` [TENANT] |
| Vault & assets (3V) | `credential.created`, `credential.updated`, `credential.deleted`, `credential.revealed`, `credential.copied`, `credential.totp_generated`, `credential.visibility_changed`, `credential.shared`, `credential.share_revoked`, `credential.share_viewed`, `credential.exported`, `credential.rotation_flagged`, `asset.created`, `asset.updated`, `asset.deleted`, `tenant_key.created`, `tenant_key.rotated`, `expiration.reminder_sent`, `vault.step_up_required`, `vault.reveal_budget_exceeded` [TENANT]. Metadata: credential id + field name only, never a secret, never a username. |
| Auth (1b) | `auth.step_up_required` — the ✦ step-up *challenge* (`MFA_REQUIRED` with `stepUp`), never audited as `authz.escalation_denied` (AUTHZ.md §7.5); the vault path uses `vault.step_up_required` (row above) [TENANT] |
| Jobs (2W+) | `job.run` — **one summary event per job run** (job name, counts, duration), not one per invocation (TENANCY.md §12 amendment) [PLATFORM; mirrored TENANT when the run touched exactly one tenant] |

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

**Amended 2026-08-16 (decisions 11–12; ARC-20).** *Format upgrade — one-way door, lands in Phase 1b before any encrypted app data exists:* new ciphertext is **v2** `v2.<rootKeyId>.<tenantKeyId>.<iv>.<ct>.<tag>` — the field is encrypted under a per-tenant DEK, itself wrapped by the env root keyring (`TenantKey(tenantId, keyId, wrappedDek, rootKeyId, status)`, §6.17; no KMS at v1 — a stated deviation from SECURITY.md §6's KMS seam, the seam being `rootKeyId`). **AAD is mandatory: `tenantId:model:rowId:field`** (SECURITY.md §6 already specified AAD; the v1 code lacked it) — a ciphertext moved to another row, tenant or column fails to decrypt. v1 rows stay decryptable (`v1.` prefix dispatches to the env key); re-encryption to v2 is lazy on write plus a one-off job for the five v1 fields above. `TenantKey` is back-filled for existing tenants before 3V. New inventory rows:

| Field | Why | Notes |
|---|---|---|
| `RateCard.amountCiphertext` (COST kind only, 2T) | Internal cost rate = salary-grade personal data (IMY; plan §2 legal) | AAD `tenantId:rate_card:<id>:amount`. Encrypted **on the card only** — `TimeEntry` stores `costRateCardId`, never the amount; aggregation is `SUM(seconds) GROUP BY cost_rate_card_id` → decrypt a handful of cards behind `rate:view_cost` ✦ + recent MFA. Prisma `omit` globally; never in CSV by default, never in `AuditEvent.metadata`. |
| `CredentialSecret.secretCiphertext` (3V) | The vault: type-specific secret fields as one JSON blob | AAD `tenantId:credential_secret:<credentialId>:secret`. Class-A row (§6.17) — a contact principal cannot SELECT it even for a CLIENT_VISIBLE item. Decrypted one field at a time by the reveal endpoint, audited in the same tx. |
| `CredentialSecret.totpSecretCiphertext` (3V) | Per-item TOTP seed; codes generated server-side | AAD `…:totp_secret`. Never returned — only the 6-digit code, itself audited (`credential.totp_generated`). |
| `CredentialVersion.secretCiphertext` (3V) | Last-N history of the above | Same AAD scheme keyed on the version row; pruned with the item. |
| `PushSubscription.keysCiphertext` (Phase 5, later) | Web Push `p256dh`/`auth` keys | AAD `tenantId:push_subscription:<id>:keys`; content-free payloads, so the keys are the only sensitive part. |

Not encrypted, on purpose: `WorkItem`/`Comment` bodies, `TimeEntry.billRate` (a bill rate is a commercial fact shown to managers and, via `ProjectTimeSummary`, optionally to the client), `CredentialItem` metadata (name, username, url, tags — searchable, non-secret by contract; a tenant who considers a username secret puts it in the secret blob), `ClientAsset` fields. **E2EE for the vault was rejected** (§11, P8): it breaks search-by-name, share links, server TOTP, portal submission and export, and strands 3-person agencies with a lost passphrase.

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

*(rows below added 2026-08-16 — decision 11 time tracking, decision 12 vault, notifications; legal basis in SECURITY.md §9.7 and the plan's legal track)*

| Class | Rule | Applies to |
|---|---|---|
| **R1 (extended)** — invoiced time | A `TimeEntry` with `invoiceLineId IS NOT NULL` (or `lockedReason ∈ {INVOICED, BILLED_EXTERNAL}`) is räkenskapsinformation underpinning an issued invoice ([BFL 1999:1078 7 kap. 2 §](https://www.bfn.se/fragor-och-svar/arkivering/)) — retained on the R1 clock, carved out of GDPR erasure. On a member's erasure request the entry survives with **`memberId` re-pointed to a per-tenant pseudonymous Member tombstone** and description scrubbed of names; hours, rate, dates stay. `InvoiceLineTimeEntry` follows the invoice. | `TimeEntry` (invoiced), `InvoiceLineTimeEntry`, `RateCard` rows referenced by an invoiced entry (`billRateCardId`), tidrapport `Document(kind REPORT)` PDFs attached to an invoice |
| **HR — un-invoiced time** | Employee working-time records are HR data, not bookkeeping: **tenant-configurable retention, default 2 years (SE — preskription/ATL 11 §-adjacent practice) / 3 years (US — FLSA 29 CFR 516.5)** by `Member.workCountry`; preference `time.retentionMonths.<country>`. Sweep job soft-deletes then hard-deletes; member erasure pseudonymises like R1 if the tenant has flagged the entries as evidence, else deletes. Timer telemetry (`skewMs`, `clientEventId`) is dropped at 90 d regardless. | `TimeEntry` (un-invoiced), `BudgetAlert` |
| **R2 + finance carve-out** — cost rates | `RateCard(kind=COST)` rows are salary-grade personal data: kept while any entry references them, hard-deleted 24 months after `effectiveTo` when unreferenced; **never exported to the client, never in the offboarding archive's client-facing part**, present in the tenant's own archive export (encrypted at rest there too). | `RateCard` (COST) |
| **R2 — staff notice evidence** | `StaffNoticeAcknowledgment` rows are the tenant's evidence of information duty (Art. 13 GDPR; MBL 19 §) — retained for the membership + 24 months, pseudonymised (not deleted) on erasure, like audit. `StaffNotice` versions immutable, never deleted. | `StaffNotice`, `StaffNoticeAcknowledgment` |
| **R4 (extended)** — notifications & mail | `Notification`: auto-archived at **500 per receiver** (oldest first) or **90 days** after `createdAt`, hard-deleted 12 months after archive; contact-receiver rows deleted with the contact. `EmailOutbox`: `params` (recipient-addressed template inputs) nulled at **90 days**, metadata (status, timestamps, `sesMessageId`) kept **12 months**; `EmailSuppression` kept while the address is suppressed (bounce/complaint) — it is what keeps us off SES blocklists. `PushSubscription` deleted on unsubscribe or after 3 consecutive delivery failures. `InboundEmail` raw MIME 30 d (later). | `Notification`, `EmailOutbox`, `EmailSuppression`, `PushSubscription`, `InboundEmail` |
| **R3 (refined)** — audit request fields | `AuditEvent.ip` / `userAgent` are **pseudonymised at 90 days** (ip → /24 (v4) / /48 (v6) truncation, UA → family+major) by the audit-retention cron; the event itself keeps its 12/24-month schedule. `credential.revealed` and `rate_card.cost_revealed` events are 24-month class. | `AuditEvent` |
| **R2 — vault** | `CredentialSecret` and `CredentialVersion` are hard-deleted with their `CredentialItem` (soft-delete window 30 d, then purge including versions); `CredentialShareLink` rows kept 12 months after expiry as evidence (token hash only). `TenantKey` rows are never deleted while any v2 ciphertext under them exists; retired keys marked `RETIRED`. | `CredentialItem`, `CredentialSecret`, `CredentialVersion`, `CredentialShareLink`, `TenantKey` |

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
///   AMENDED 2026-08-16: schemaVersion → 2 adds exactly three module
///   keys — `work`, `time`, `vault` (defaults on in the v1→v2 upgrade);
///   `issues` stays as a DEPRECATED ALIAS resolved to `work`.
///   Notifications and search are core, never entitlement keys.
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
/// NO legal gap-free requirement (work-item numbers, update seq). Invoices
/// do NOT use this — they use InvoiceSeries (§6.7 + §9 of this doc) with
/// stricter rules.
/// AMENDED 2026-08-16: keys are namespaced per project — `work_item:
/// <projectId>` (WorkItem.number, displayed `<Project.key>-<number>`) and
/// `project_update:<projectId>` (ProjectUpdate.seq) — allocated by ONE
/// helper `counters.next(tx, key)` = `INSERT … ON CONFLICT (tenant_id,
/// key) DO UPDATE SET value = tenant_counter.value + 1 RETURNING value`
/// inside the creating transaction (§9). Gaps on rollback are acceptable.
/// scope=tenant  rls=A  ret=R2  enc=none
model TenantCounter {
  tenantId String
  key      String                               // "work_item:<projectId>" | "project_update:<projectId>" | …
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
  // Added 2026-08-16 (decision 11, Phase 1b): the three facts the time
  // module needs about a person, and nothing more (never location, never
  // device). timezone = IANA name for localDate/week grids; workCountry =
  // ISO 3166-1 alpha-2, selects the staff-notice jurisdiction tags and the
  // HR retention default (§5); hoursPerDay = optional planning capacity
  // (7.5/8), used only for "estimate remaining" hints — never for
  // utilisation reports or comparisons (never-list, PLAN.md skip-list).
  timezone    String?                            // IANA, e.g. "Europe/Stockholm"; NULL → Tenant preference
  workCountry String?      @db.Char(2)           // ISO 3166-1 alpha-2
  hoursPerDay Decimal?     @db.Decimal(4, 2)     // planning capacity only
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
  module      String                             // "core" | "invoicing" | "contracts" | "reports" | "issues" (deprecated alias 2026-08-16) | "documentation" | "continuity_box" | "portal" | "work" | "time" | "vault" (the last three added 2026-08-16)
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
/// AMENDED 2026-08-16 (work-management plan §3.1–3.3; lands Phase 2):
/// - key: <= 8 chars, [A-Z][A-Z0-9]*, unique per tenant, the human prefix
///   of every WorkItem ("ACME-12"). Changing it is audited
///   (project.key_changed) and old keys are NOT redirected in v1.
/// - portalEnabled: THE project-level portal gate (§2.3 refinement).
///   Default false. Fanned out by trigger to `portal_enabled` on every
///   projectScoped table; flipping it is project:manage_portal + audited
///   (project.portal_enabled/disabled). Turning it off hides everything
///   in the project from every contact at the RLS layer — per-item
///   visibility decisions are preserved, not cascaded.
/// - hoursSharingMode: what the portal's hours widget may show
///   (CONTACT_PRIMARY only): NONE (default) | HOURS | BILLABLE_AMOUNT.
///   Drives ProjectTimeSummary.visibility (§6.15). Never per-member.
/// - billingCurrency / defaultBillable: one billing currency per project
///   (no FX in time reports); defaultBillable seeds TimeEntry.billable.
/// - leadMemberId: the accountable member (shown to staff, not portal).
/// - updateCadence {NONE, WEEKLY, BIWEEKLY, MONTHLY}: intent only in
///   Phase 3; ProjectUpdateSchedule (Phase 5) enforces reminders.
/// - autoArchiveMonths?: explicit, tenant-chosen archive of DONE items —
///   never ADO's silent 183-day disappearance; NULL = never.
/// - autoStartParent / autoCompleteParent: WorkItem parent rollup rules
///   executed by the state service (child IN_PROGRESS ⇒ parent
///   IN_PROGRESS; all children DONE/CANCELLED ⇒ parent DONE).
/// - roundingRuleId? [Phase 4]: → RoundingRule (§6.15); applied at
///   invoice-line creation only. Column reserved, NULL until Phase 4.
/// - defaultServiceId? [ADDED 2026-08-20, D4]: → Service (§6.6, the
///   "agreement") — seeds TimeEntry.serviceId when the member picks
///   none (the whole-project-under-one-agreement case); the per-entry
///   picker overrides. Managed with service:* + rate:manage_bill.
/// - hostingNotes: still POINTERS only. Live credentials now have a home
///   (CredentialItem/CredentialSecret, §6.17); hostingNotes stays free
///   text for provider/plan/where-to-look and is never a secret field.
/// rls=B projectScoped on ITS OWN ROW: portal_gate for `project` is
/// `client_id = app.client_id AND portal_enabled` (a project row is
/// structural — it has no visibility column of its own).
/// scope=client  rls=B (projectScoped)  ret=R2  enc=none
/// audit: project.created | project.updated | project.status_changed | project.archived | project.key_changed | project.portal_enabled | project.portal_disabled | project.hours_sharing_changed | project.viewed_as_contact
model Project {
  id            String        @id @default(uuid(7))
  tenantId      String
  clientId      String
  key           String                           // ADDED 2026-08-16 — <= 8 chars, unique per tenant, WorkItem prefix
  name          String
  type          String?                          // free text: "website", "crm", …
  scopeSummary  String?                          // short client-visible scope description
  status        ProjectStatus @default(PLANNED)
  startDate     DateTime?     @db.Timestamptz(6)
  launchDate    DateTime?     @db.Timestamptz(6)
  productionUrl String?                          // client-visible; also CrUX subject (§6.10)
  stagingUrl    String?                          // client-visible
  repoUrl       String?                          // INTERNAL-ONLY
  hostingNotes  String?                          // INTERNAL-ONLY (provider, plan, credentials POINTERS only — never secrets; live secrets → CredentialItem §6.17)
  internalNotes String?                          // INTERNAL-ONLY
  // ADDED 2026-08-16 (work-management plan):
  portalEnabled      Boolean          @default(false)   // the project-level portal gate; trigger fans out to portal_enabled
  hoursSharingMode   HoursSharingMode @default(NONE)    // portal hours widget mode (CONTACT_PRIMARY only)
  billingCurrency    String?          @db.Char(3)       // one currency per project for time money
  defaultBillable    Boolean          @default(true)    // seeds TimeEntry.billable
  leadMemberId       String?                            // accountable member (staff-only projection)
  updateCadence      UpdateCadence    @default(NONE)    // intent; enforced by ProjectUpdateSchedule (Phase 5)
  autoArchiveMonths  Int?                               // explicit archive of DONE items; NULL = never
  autoStartParent    Boolean          @default(true)    // WorkItem rollup rule
  autoCompleteParent Boolean          @default(false)   // WorkItem rollup rule
  roundingRuleId     String?                            // Phase 4 → RoundingRule (§6.15); NULL until then
  defaultServiceId   String?                            // ADDED 2026-08-20 (D4) → Service (tenantId, id); seeds TimeEntry.serviceId
  archivedAt    DateTime?     @db.Timestamptz(6)
  createdAt     DateTime      @default(now()) @db.Timestamptz(6)
  updatedAt     DateTime      @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, id])                       // composite-FK target
  @@unique([tenantId, key])                      // ADDED 2026-08-16 — human key
  @@index([tenantId, clientId, status])
  @@index([tenantId, status])
}

/// ADDED 2026-08-16. What the portal hours widget may show; drives
/// ProjectTimeSummary.visibility (§6.15). Never per-member.
enum HoursSharingMode {
  NONE               // default: the client sees no hours
  HOURS              // billable / non-billable hours per month
  BILLABLE_AMOUNT    // hours + billable amount in billingCurrency
}

/// ADDED 2026-08-16. Progress-update cadence intent (§6.16).
enum UpdateCadence {
  NONE
  WEEKLY
  BIWEEKLY
  MONTHLY
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
/// AMENDED 2026-08-16: rls subclass projectScoped — gains the trigger-
/// maintained `portal_enabled` column (elided below, §1.4); a SHIPPED
/// version of a portal-disabled project is invisible to contacts.
/// `visibility` remains implicit (SHIPPED ⇒ client-visible): the
/// portal_gate for this table uses `status = 'SHIPPED'` in place of the
/// visibility term (TENANCY.md §7.2 structural variant). WorkItem.
/// fixedInVersionId (§6.14) keeps the "issue → fixing release" link.
/// scope=client  rls=B (projectScoped; portal sees SHIPPED rows of its client in portal-enabled projects)  ret=R2  enc=none
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
  @@unique([tenantId, id])                       // composite-FK target (~~Issue~~ WorkItem.fixedInVersionId — amended 2026-08-16)
  @@index([tenantId, clientId, shippedAt])
}

/// AMENDED 2026-08-16: SKIPPED → CANCELLED, PAUSED added — one spelling
/// of "done"/"cancelled" across Milestone and StateCategory (§6.14),
/// so the portal timeline and rollups share vocabulary.
enum MilestoneStatus {
  PLANNED
  IN_PROGRESS
  PAUSED        // added 2026-08-16
  DONE
  CANCELLED     // added 2026-08-16 — replaces SKIPPED
  // SKIPPED    — removed 2026-08-16 (never shipped; no data migration needed)
}

/// Milestone — stage view of a project (§6). Client-visible by nature —
/// but see the amendment: it is projectScoped, so it carries a
/// `visibility` column (default INTERNAL like everything else; the
/// project template flips milestones to CLIENT_VISIBLE on creation when
/// the project is portal-enabled) and `portal_enabled`. This is the
/// agency "phase" unit: WorkItem.milestoneId groups tasks under it and
/// the portal shows "Phase: Design · Next milestone: Launch due 12 Sep".
/// AMENDED 2026-08-16: `sortOrder Int` → `rank text COLLATE "C"`
/// (fractional-indexing, same ordering service as WorkItem — one
/// ordering mechanism in the product); `@@unique([tenantId, id])` added
/// as the composite-FK target for WorkItem.milestoneId; `visibility`
/// added; status enum widened.
/// scope=client  rls=B (projectScoped)  ret=R2  enc=none
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
  rank        String                             // ADDED 2026-08-16 — text COLLATE "C" (hand-written SQL); replaces sortOrder
  visibility  Visibility      @default(INTERNAL) // ADDED 2026-08-16 — projectScoped rows carry it
  // sortOrder Int — REMOVED 2026-08-16 (superseded by rank)
  createdAt   DateTime        @default(now()) @db.Timestamptz(6)
  updatedAt   DateTime        @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, id])                       // ADDED 2026-08-16 — composite-FK target (WorkItem.milestoneId)
  @@unique([tenantId, projectId, rank])          // ADDED 2026-08-16 — one position per milestone
  @@index([tenantId, clientId, visibility])
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
/// AMENDED 2026-08-16: rls subclass projectScoped when projectId is set
/// (gains `portal_enabled` — trigger sets it from the project, TRUE-
/// irrelevant/false when projectId is NULL, in which case the two-term
/// clientScoped gate applies); gains `visibility Visibility
/// @default(INTERNAL)` like every other class-B row (previously implied
/// client-visible — the default is now fail-closed, and the service form
/// asks). Also a source row of the Expirations feed (§6.17: renewsAt /
/// endsAt).
/// AMENDED 2026-08-20 (D4 — founder decision, time-tracking session):
/// Service IS the commercial "agreement" (UI label: Agreement / sv
/// Avtal; Phase 4's signed Contract stays a distinct legal document). A
/// client holds several concurrently (development @ X kr/h, maintenance
/// @ Y kr/h). Hourly rates NEVER live as columns here — they are
/// RateCard rows with scope SERVICE (§6.15): immutable, effective-
/// dated, snapshotted onto entries at write. TimeEntry.serviceId points
/// here (picked at start/during/after); Project.defaultServiceId seeds
/// it. The agreement page shows a consumption strip ("X h this period",
/// a SUM — the retainer LEDGER stays Phase 4). priceExVat/currency
/// below remain the fixed/recurring FEE of the service (e.g. hosting
/// per month) — distinct from the hourly rate cards.
/// scope=client  rls=B (projectScoped when projectId set, else clientScoped)  ret=R2  enc=none
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
  visibility      Visibility       @default(INTERNAL)  // ADDED 2026-08-16 — fail-closed like every class-B row
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
  ISSUE            // DEPRECATED 2026-08-16 — never used; kept only so the enum is additive. New anchors use WORK_ITEM.
  // ADDED 2026-08-16 (work-management plan):
  WORK_ITEM        // 2W — attachments on a Task/Epic/Subtask (visibility defaulted from the item; child <= parent guard, §10)
  COMMENT          // 2W — paste-upload inside a comment
  PROJECT_UPDATE   // 3  — files shared with a progress update (+ pdfDocumentId)
  CREDENTIAL       // 3V — non-secret attachments (setup guides); NEVER the secret itself
  ASSET            // 3V — invoices/certificates for a ClientAsset
}

/// ADDED 2026-08-16. What kind of file a Document is — drives the portal
/// "Files & deliverables" grouping, the Client Timeline (DELIVERABLE |
/// REPORT versions appear), retention (REPORT tidrapporter attached to an
/// invoice follow R1) and the approval flow (DELIVERABLE only).
enum DocumentKind {
  GENERAL
  DELIVERABLE      // client-approvable output (design, build, copy…)
  REPORT           // generated: progress-update PDF, tidrapport, performance report
  EXPORT           // tenant/client data export
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
/// AMENDED 2026-08-16 (Phase 2/3):
/// - kind DocumentKind (GENERAL default; DELIVERABLE | REPORT | EXPORT).
/// - Approval columns mirroring ProjectVersion's v1-lite sign-off
///   (decision #7): DELIVERABLE documents can be sent for client
///   approval; a portal contact APPROVES / REQUESTS CHANGES; a new
///   FileVersion resets approvalStatus to NOT_REQUESTED and records
///   approvalVersionNumber so "what exactly was approved" is answerable.
///   These columns are in the contact-writable census (§2.3): a
///   contact may UPDATE only them, only on CLIENT_VISIBLE rows of its
///   client with approvalStatus = 'PENDING' (WITH CHECK). Generalised
///   ApprovalRequest is Phase 5.
/// - rls subclass: projectScoped when projectId IS NOT NULL (gains
///   `portal_enabled` — set from the project by trigger; a document on a
///   portal-disabled project is invisible to contacts even if
///   CLIENT_VISIBLE), clientScoped otherwise. The posture test covers
///   both shapes via a CHECK: `project_id IS NULL OR portal_enabled IS
///   NOT NULL` is trivially true — instead the trigger guarantees
///   `portal_enabled = false` whenever `project_id IS NULL`, and the
///   policy for this table is `client_id = app.client_id AND visibility
///   = 'CLIENT_VISIBLE' AND (project_id IS NULL OR portal_enabled)`.
/// - Attached to WORK_ITEM / COMMENT / PROJECT_UPDATE: visibility is
///   defaulted from the parent at creation and the child <= parent guard
///   applies (§10); a parent cannot be flipped to INTERNAL while an
///   attached CLIENT_VISIBLE document exists (downgrade refusal).
/// scope=client (clientId nullable ⇒ tenant-internal)  rls=B (projectScoped when projectId set, else clientScoped)  ret=R2 (invoice/contract PDFs referenced via R1 parents survive)  enc=none
/// audit: document.created | document.visibility_changed | document.renamed | document.deleted | document.approval_requested | document.approval_decided | file.uploaded | file.downloaded
model Document {
  id                 String          @id @default(uuid(7))
  tenantId           String
  clientId           String?                     // NULL = tenant-internal
  projectId          String?                     // convenience scope (indexed listing)
  name               String
  kind               DocumentKind    @default(GENERAL)   // ADDED 2026-08-16
  tags               String[]        @default([])
  visibility         Visibility      @default(INTERNAL)
  attachedToType     AttachableType?             // soft anchor — see §10
  attachedToId       String?
  // ADDED 2026-08-16 — approval, v1-lite (mirrors ProjectVersion):
  approvalStatus        ApprovalStatus @default(NOT_REQUESTED)
  approvalRequestedAt   DateTime?      @db.Timestamptz(6)
  approvalDecidedAt     DateTime?      @db.Timestamptz(6)
  approvalByContactId   String?                  // who decided
  approvalNote          String?                  // contact's comment
  approvalVersionNumber Int?                     // FileVersion.versionNumber the decision applies to
  createdByMemberId  String?
  createdByContactId String?                     // portal uploads (attribution only — brokered write, §2.3)
  deletedAt          DateTime?       @db.Timestamptz(6)  // soft delete; hard delete via retention job
  createdAt          DateTime        @default(now()) @db.Timestamptz(6)
  updatedAt          DateTime        @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, id])
  @@index([tenantId, clientId, visibility])
  @@index([tenantId, projectId, kind])           // AMENDED 2026-08-16 — kind added for the portal Files grouping
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
//
// ╔═══════════════════════════════════════════════════════════════════╗
// ║ SUPERSEDED 2026-08-16 (work-management plan §3.1) by             ║
// ║ WorkItem(kind = REQUEST) + Comment(subjectType = WORK_ITEM) —     ║
// ║ see §6.14. The two models below are KEPT AS WRITTEN for history   ║
// ║ and are NOT materialised: no `issue` / `issue_comment` table is   ║
// ║ ever created. Mapping: Issue.type BUG→kind BUG; IDEA/REQUIREMENT  ║
// ║ →kind REQUEST; IssueStatus NEW→TRIAGE category, TRIAGED→TODO,     ║
// ║ IN_PROGRESS→IN_PROGRESS, RESOLVED/CLOSED→DONE, DECLINED→          ║
// ║ CANCELLED (+ triageStatus DECLINED); Issue.number → per-project   ║
// ║ WorkItem.number; fixedInVersionId carried over 1:1; the "issue    ║
// ║ attachment" anchor becomes AttachableType.WORK_ITEM. Decision #7  ║
// ║ ("issue queue IS v1 intake") still holds — the intake surface is  ║
// ║ now the portal REQUEST form landing in the hidden Triage state.   ║
// ║ The `issues` entitlement key remains a deprecated alias of `work`; ║
// ║ issue:* permission codes remain in the catalog, unseeded from     ║
// ║ TEMPLATE_VERSION 2 (AUTHZ.md — first deprecation).                ║
// ╚═══════════════════════════════════════════════════════════════════╝
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

### 6.14 Work — WorkItem, workflow states, activity, comments, labels, templates *(added 2026-08-16 — work-management plan §3.1; lands Phase 2W; entitlement `work`)*

The design in one line: **Azure DevOps' data model under Planner/Linear's surface** — one generic work-item row, tenant-named states inside fixed categories, one fractional rank, Epic → Task → Subtask, field-level history — and *nothing* of ADO's configuration surface (no process templates, area/iteration paths, sprints-by-default). UI word for a `WorkItem` is **"Task"**; `type` names the level.

Constraints that Prisma cannot express are **hand-written SQL in the 2W migration** (marked `SQL:` below) and every one has a data-layer test in the same commit. Pinned facts (plan §3.1): `depth` 0-indexed with `CHECK depth <= 2` (three levels); single assignee (member xor contact); `kind {TASK, BUG, REQUEST}`; `StateCategory {BACKLOG, TODO, IN_PROGRESS, DONE, CANCELLED, TRIAGE}`; `stateCategory` denormalised on the item; `rank text COLLATE "C"` unique per project; `Project.key` + `TenantCounter` numbering.

```prisma
// ───────────────────────────────────────────────────────────────────
// 6.14 WORK (Phase 2W) — module `work`
// Folder: src/modules/work/{items,states,ordering,activity,comments,
// labels,triage,rollup,templates,portal,actions}.ts
// ───────────────────────────────────────────────────────────────────

/// Fixed categories. Tenants name their states; categories never change
/// (immutable per state — trigger). Rollups, the portal, and the state
/// machine read ONLY the category. TRIAGE is the landing zone for
/// kind=REQUEST (portal / email intake); one hidden Triage state is
/// auto-created per project and shown only when it has items.
enum StateCategory {
  BACKLOG
  TODO
  IN_PROGRESS
  DONE
  CANCELLED
  TRIAGE
}

/// WorkflowState — per-project named states (tenant text, not i18n).
/// Copied from a WorkflowPreset at project creation; default preset =
/// Backlog / To do / In progress / Done / Cancelled + hidden Triage.
/// App invariants (states.ts): exactly one isDefault per project (the
/// state new items land in), >= 1 DONE-category and >= 1 CANCELLED-
/// category state, exactly one TRIAGE state. Deleting a state requires a
/// target state for its items (same category or explicit remap).
/// CLASS A: the portal never joins this table — it reads
/// WorkItem.stateCategory only (P10). Therefore no visibility column.
/// SQL: `rank text COLLATE "C"`; trigger workflow_state_category_immutable
///      (BEFORE UPDATE: NEW.category <> OLD.category ⇒ RAISE).
/// scope=tenant  rls=A (principalScoped)  ret=R2  enc=none
/// audit: workflow.changed
model WorkflowState {
  id               String        @id @default(uuid(7))
  tenantId         String
  projectId        String
  name             String
  color            String?                          // hex, UI hint
  category         StateCategory                    // IMMUTABLE after insert (trigger)
  rank             String                           // text COLLATE "C" — column order on the board
  isDefault        Boolean       @default(false)    // where new items land (exactly one per project)
  isHidden         Boolean       @default(false)    // TRIAGE state hidden until it has items
  wipLimit         Int?                             // stored, enforced v1.5 (soft warning only in v1)
  definitionOfDone String?                          // v1.5 UI; column reserved
  createdAt        DateTime      @default(now()) @db.Timestamptz(6)
  updatedAt        DateTime      @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, projectId, name])
  @@unique([tenantId, projectId, rank])
  @@unique([tenantId, id])                        // composite-FK target (WorkItem.stateId)
  @@index([tenantId, projectId, category])
}

/// WorkflowPreset — tenant-editable named state sets, copied into each
/// new project. `states Json` = [{name, color, category, rank, isDefault}].
/// The seed ships one preset per tenant ("Default", locale-aware names
/// from Tenant.defaultLocale at provisioning; the NAMES are tenant text
/// after that — never re-translated). Preference work.defaultPreset.
/// scope=tenant  rls=A (principalScoped)  ret=R2  enc=none
/// audit: workflow.changed
model WorkflowPreset {
  id        String   @id @default(uuid(7))
  tenantId  String
  name      String
  states    Json                                   // [{name, color, category, rank, isDefault}]
  isDefault Boolean  @default(false)               // used when a project is created without a choice
  createdAt DateTime @default(now()) @db.Timestamptz(6)
  updatedAt DateTime @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, name])
}

/// The three levels. UI: Epic / Task / Subtask. No "Feature" level.
enum WorkItemType {
  EPIC      // depth 0 only
  TASK      // depth 0 or 1
  SUBTASK   // depth 1 or 2
}

/// What the row is about; orthogonal to type. REQUEST = portal/email-
/// submitted, starts in the TRIAGE-category state (absorbs Issue, §6.9).
enum WorkItemKind {
  TASK
  BUG
  REQUEST
}

enum WorkItemPriority {
  NONE
  LOW
  MEDIUM
  HIGH
  URGENT
}

/// Triage outcome for kind=REQUEST (and anything else parked in TRIAGE).
enum TriageStatus {
  PENDING
  ACCEPTED    // moved to the project's default state; triage fields cleared
  DECLINED    // moved to a CANCELLED-category state
  SNOOZED     // hidden from the triage lane until snoozedUntil
  DUPLICATE   // → CANCELLED-category state; duplicateOfId set
}

enum WorkItemSource {
  IN_APP
  PORTAL     // brokered contact write (system principal after authorizePortal)
  EMAIL      // Phase 5+, behind entitlement work.email_intake
  IMPORT     // ImportJob (Phase 6)
}

/// WorkItem — THE table. UI word "Task". One row per Epic/Task/Subtask;
/// `kind` says what it is about; `parentId` builds the (max three-level)
/// tree; `rank` is the ONE order used by both backlog and board columns
/// (ADO "maintain backlog order"): backlog = all open items by rank,
/// board column = that state's items by rank. Numbered per project
/// (`Project.key`-`number`, e.g. ACME-12) via counters.next().
///
/// DENORMALISED, ON PURPOSE (each is load-bearing for RLS or flat rollups):
///   clientId      — from the project; the portal_gate predicate.
///   stateCategory — kept in sync with WorkflowState.category by the
///                   state service AND a trigger (belt + braces): the
///                   portal never joins workflow_state (class A) and reads
///                   this column only.
///   rootId, depth — flat GROUP BY root_id replaces recursive CTEs for
///                   epic rollups (depth <= 2 ⇒ WHERE root_id = $1 is a
///                   plain index scan). rootId = self for depth 0.
///   checklistTotal/Done — counted from Tiptap taskList nodes on save
///                   (no ChecklistItem table; "convert to subtask" action).
///   portal_enabled — §2.3 (elided; trigger-maintained).
///
/// ASSIGNMENT: single assignee, member XOR contact (CHECK); a contact
/// assignee forces CLIENT_VISIBLE (CHECK) because a contact can only act
/// on what they can see. Collaborators are a join (WorkItemCollaborator).
/// No multi-assignee (§11).
///
/// VISIBILITY: own column, default INTERNAL, defaulted from the parent
/// at creation; child <= parent enforced by trigger; flipping a parent to
/// INTERNAL is REFUSED while any child (item, comment, attached document)
/// is CLIENT_VISIBLE — a bulk "make private with N children" action
/// exists and is audited (work_item.bulk_edited + visibility_changed).
///
/// SQL (hand-written in the 2W migration; every line has a test):
///   rank text COLLATE "C"                       — fractional-indexing keys
///   CHECK (depth BETWEEN 0 AND 2)               — three levels
///   CHECK (type <> 'EPIC' OR (parent_id IS NULL AND depth = 0))
///   CHECK (type <> 'TASK' OR depth <= 1)
///   CHECK (type <> 'SUBTASK' OR depth >= 1)
///   CHECK (num_nonnulls(assignee_member_id, assignee_contact_id) <= 1)
///   CHECK (assignee_contact_id IS NULL OR visibility = 'CLIENT_VISIBLE')
///   CHECK (kind <> 'REQUEST' OR source IN ('PORTAL','EMAIL','IN_APP'))
///   CHECK (triage_status IS NOT NULL OR state_category <> 'TRIAGE') — an
///     item in TRIAGE always carries a triage status
///   TRIGGER work_item_parent_guard BEFORE INSERT OR UPDATE OF parent_id,
///     project_id, type, visibility: parent must exist in the same tenant
///     AND same project; parent.type strictly higher (EPIC > TASK >
///     SUBTASK); NEW.depth := parent.depth + 1 (0 when NULL); NEW.root_id
///     := parent.root_id (self when NULL); acyclic (walk <= 2 hops — depth
///     bound makes this O(1)); NEW.visibility = 'CLIENT_VISIBLE' ⇒
///     parent.visibility = 'CLIENT_VISIBLE'.
///   TRIGGER work_item_visibility_downgrade_guard BEFORE UPDATE OF
///     visibility: OLD = CLIENT_VISIBLE AND NEW = INTERNAL AND EXISTS any
///     child work_item / comment(subject) / document(attached WORK_ITEM)
///     with visibility = 'CLIENT_VISIBLE' ⇒ RAISE (the bulk action
///     flips children first, in the same tx, deepest first).
///   TRIGGER work_item_state_sync BEFORE INSERT OR UPDATE OF state_id:
///     NEW.state_category := (SELECT category FROM workflow_state WHERE
///     id = NEW.state_id AND tenant_id = NEW.tenant_id AND project_id =
///     NEW.project_id) — RAISE if no row (cross-project state).
///   TRIGGER work_item_reparent_children AFTER UPDATE OF project_id: RAISE
///     — moving an item across projects is a service operation
///     (renumber, restate, re-rank, re-client), never a column update.
///   UNIQUE (tenant_id, project_id, number); UNIQUE (tenant_id,
///     project_id, rank) — collisions retried with jitter in ordering.ts.
///   Portal WITH CHECK (written in 2W, exercised by tests, enabled for the
///     REQUEST intake in Phase 3 — the intake is a BROKERED write, so this
///     policy is defence in depth, not the grant): a contact principal may
///     never INSERT/UPDATE work_item directly. The only contact-caused
///     mutations (REQUEST create, complete own-assigned) run under the
///     system principal in modules/work/portal.ts.
/// scope=client  rls=B (projectScoped)  ret=R2  enc=none
/// audit: work_item.created | work_item.deleted | work_item.state_changed | work_item.visibility_changed | work_item.triaged | work_item.archived | work_item.bulk_edited | portal.request_created | portal.task_completed
model WorkItem {
  id                 String           @id @default(uuid(7))
  tenantId           String
  clientId           String                       // denormalised from project — RLS predicate
  projectId          String
  number             Int                          // counters.next("work_item:<projectId>")
  type               WorkItemType     @default(TASK)
  kind               WorkItemKind     @default(TASK)
  title              String
  description        Json?                        // Tiptap ProseMirror JSON (checklist = taskList nodes)
  descriptionText    String?                      // extracted plain text (search feed, previews)
  stateId            String                       // → WorkflowState (tenantId, id); same project (trigger)
  stateCategory      StateCategory                // DENORMALISED — the only state field the portal reads
  priority           WorkItemPriority @default(NONE)
  assigneeMemberId   String?                      // XOR assigneeContactId (CHECK)
  assigneeContactId  String?                      // ⇒ visibility = CLIENT_VISIBLE (CHECK); portal UI in Phase 3
  parentId           String?                      // self FK (tenantId, id); same project, higher type (trigger)
  rootId             String                       // DENORMALISED — top of this item's tree (self at depth 0)
  depth              Int              @default(0) // 0-indexed; CHECK depth <= 2
  milestoneId        String?                      // → Milestone (tenantId, id) — the agency "phase"
  fixedInVersionId   String?                      // → ProjectVersion (tenantId, id) — "the release that fixes it"
  rank               String                       // text COLLATE "C"; UNIQUE per project
  estimateMinutes    Int?                         // hours in the UI; points later behind a preference
  remainingMinutes   Int?
  startDate          DateTime?        @db.Date
  targetDate         DateTime?        @db.Date
  startedAt          DateTime?        @db.Timestamptz(6)  // stamped on first IN_PROGRESS; cleared on regression
  completedAt        DateTime?        @db.Timestamptz(6)  // stamped on DONE; cleared when leaving DONE
  visibility         Visibility       @default(INTERNAL)
  // Triage (kind=REQUEST and anything parked in TRIAGE):
  triageStatus       TriageStatus?
  snoozedUntil       DateTime?        @db.Timestamptz(6)
  duplicateOfId      String?                      // → WorkItem (tenantId, id) when triageStatus = DUPLICATE
  source             WorkItemSource   @default(IN_APP)
  // Checklist counters (denormalised from description on save):
  checklistTotal     Int              @default(0)
  checklistDone      Int              @default(0)
  // Import provenance (Phase 6 ImportJob; columns reserved now):
  sourceSystem       String?                      // "trello" | "csv" | …
  sourceId           String?                      // idempotency: (sourceSystem, sourceId) update-not-duplicate
  importJobId        String?
  createdByMemberId  String?
  reportedByContactId String?                     // attribution for PORTAL/EMAIL requests (brokered write)
  archivedAt         DateTime?        @db.Timestamptz(6)  // explicit archive; never silent
  deletedAt          DateTime?        @db.Timestamptz(6)  // soft delete (30 d), then hard delete
  createdAt          DateTime         @default(now()) @db.Timestamptz(6)
  updatedAt          DateTime         @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, projectId, number])        // human key ACME-12
  @@unique([tenantId, projectId, rank])          // one position per item (retry-with-jitter on collision)
  @@unique([tenantId, id])                        // composite-FK target (parent, duplicateOf, activity, comments, time entries)
  @@index([tenantId, projectId, stateId, rank])   // board column
  @@index([tenantId, projectId, stateCategory, rank]) // backlog (open by rank), rollups
  @@index([tenantId, assigneeMemberId, stateCategory, targetDate]) // /home: assigned/overdue/next-7
  @@index([tenantId, parentId])
  @@index([tenantId, rootId])                     // epic subtree rollups (flat)
  @@index([tenantId, milestoneId])
  @@index([tenantId, clientId, visibility, stateCategory]) // portal list + portal_gate
  @@index([tenantId, projectId, archivedAt])
  @@index([tenantId, projectId, triageStatus])    // triage lane
  @@index([tenantId, sourceSystem, sourceId])     // import idempotency
}

/// WorkItemActivity — field-level HISTORY of an item (who changed what,
/// from → to). This is not AuditEvent: AuditEvent stays for privileged
/// operations (state change, visibility flip, triage, delete are dual-
/// written); routine edits (title, priority, estimate, assignee, dates,
/// labels) live only here. Cycle/lead time (Phase 6) is computed from
/// state rows here.
/// visibility: INTERNAL unless the field is in the PORTAL-SAFE LIST —
/// {stateCategory, title, targetDate, milestoneId, assigneeContactId,
/// visibility(→CLIENT_VISIBLE only)} — and the item is CLIENT_VISIBLE at
/// write time; the service decides, the row carries it, portal_gate
/// enforces it. Labels, links, estimates, priority, assigneeMemberId,
/// INTERNAL comments never produce a CLIENT_VISIBLE activity row.
/// oldValue/newValue are display text; oldRef/newRef are ids for
/// re-rendering (a member id here is INTERNAL by construction).
/// scope=client  rls=B (projectScoped)  ret=R2 (deleted with the item)  enc=none
/// audit: (dual-write of privileged transitions only)
model WorkItemActivity {
  id              String     @id @default(uuid(7))
  tenantId        String
  clientId        String                          // denormalised — RLS
  projectId       String                          // denormalised — RLS (portal_enabled fan-out)
  workItemId      String                          // → WorkItem (tenantId, id)
  actorMemberId   String?
  actorContactId  String?
  field           String                          // "stateCategory" | "title" | "priority" | "assignee" | "label" | "comment" | …
  oldValue        String?
  newValue        String?
  oldRef          String?                         // id form (state id, member id, label id…)
  newRef          String?
  commentId       String?                         // when field = "comment"
  visibility      Visibility @default(INTERNAL)  // CLIENT_VISIBLE only for portal-safe fields on CLIENT_VISIBLE items
  createdAt       DateTime   @default(now()) @db.Timestamptz(6)

  @@index([tenantId, workItemId, createdAt])
  @@index([tenantId, clientId, visibility])
}

/// Label — tenant-wide (optionally project-scoped) tags. INTERNAL-ONLY IN
/// v1: labels never reach the portal (one less leak vector), so this is
/// class A and carries no visibility. Planner's per-plan-label trap is
/// avoided by making them tenant-wide with an optional project filter.
/// scope=tenant  rls=A (principalScoped)  ret=R2  enc=none
/// audit: label.created | label.deleted
model Label {
  id        String   @id @default(uuid(7))
  tenantId  String
  projectId String?                                // NULL = tenant-wide
  name      String
  color     String?
  createdAt DateTime @default(now()) @db.Timestamptz(6)

  @@unique([tenantId, projectId, name])          // NULL projectId distinct in PG — app also checks tenant-wide uniqueness
  @@unique([tenantId, id])
}

/// WorkItemLabel — join. Class A like Label.
/// scope=tenant  rls=A (principalScoped)  ret=R2  enc=none
model WorkItemLabel {
  tenantId   String
  workItemId String
  labelId    String
  createdAt  DateTime @default(now()) @db.Timestamptz(6)

  @@id([tenantId, workItemId, labelId])
  @@index([tenantId, labelId])
}

/// WorkItemCollaborator — extra members on an item (not the assignee).
/// Drives notifications (participating) and the "my work" collaborating
/// section. Members only — contacts participate via assignment/comments.
/// scope=tenant  rls=A (principalScoped)  ret=R2  enc=none
model WorkItemCollaborator {
  tenantId   String
  workItemId String
  memberId   String
  addedById  String?
  createdAt  DateTime @default(now()) @db.Timestamptz(6)

  @@id([tenantId, workItemId, memberId])
  @@index([tenantId, memberId])
}

/// WorkItemSubscriber — explicit watch/mute per member per item; the
/// generic Subscription (§6.18) covers other entity types. Kept as its
/// own narrow table because it is the hottest fan-out lookup.
/// scope=tenant  rls=A (principalScoped)  ret=R2  enc=none
model WorkItemSubscriber {
  tenantId   String
  workItemId String
  memberId   String
  level      SubscriptionLevel @default(WATCH)     // enum shared with §6.18
  createdAt  DateTime @default(now()) @db.Timestamptz(6)

  @@id([tenantId, workItemId, memberId])
  @@index([tenantId, memberId])
}

/// What a Comment hangs on. PROJECT_VERSION covers release-note threads
/// (the v0.1 "messaging as threaded comments" seam is now this table).
enum CommentSubjectType {
  WORK_ITEM
  PROJECT_UPDATE
  DOCUMENT
  FILE_VERSION
  PROJECT_VERSION
}

/// Comment — ONE polymorphic thread table (replaces IssueComment). THE
/// key visibility case survives unchanged: staff write INTERNAL comments
/// on CLIENT_VISIBLE items (triage notes the client must never see); DB
/// default INTERNAL; contact-authored comments are FORCED CLIENT_VISIBLE
/// (WITH CHECK). Two-mode composer in the UI ("Internal note" default /
/// "Reply to client").
/// This is the ONE table in the contact-writable census that a contact
/// INSERTs directly (§2.3): `WITH CHECK (visibility = 'CLIENT_VISIBLE'
/// AND client_id = current_setting('app.client_id') AND author_contact_id
/// = current_setting('app.principal_id') AND portal_enabled)`; UPDATE/
/// DELETE by contacts: none in v1 (edit-own is v1.5).
/// SQL: CHECK (num_nonnulls(author_member_id, author_contact_id) = 1);
///   CHECK (visibility <> 'CLIENT_VISIBLE' OR client_id IS NOT NULL);
///   TRIGGER comment_subject_guard BEFORE INSERT OR UPDATE OF visibility,
///   subject_id: subject looked up by subject_type in the same tenant;
///   NEW.client_id/project_id := subject's; NEW.visibility =
///   'CLIENT_VISIBLE' ⇒ subject visible to the client (WorkItem/Document/
///   ProjectUpdate: visibility = CLIENT_VISIBLE; ProjectVersion: status =
///   SHIPPED; FileVersion: its Document CLIENT_VISIBLE); parent comment
///   (thread) must share subject and tenant; downgrade of a subject is
///   refused while a CLIENT_VISIBLE comment exists (guard on the subject
///   tables checks this table).
/// Mentions are extracted on save into Mention rows (ids only). Reactions:
/// not in v1 (§11).
/// scope=client (clientId nullable only for tenant-internal DOCUMENT subjects)  rls=B (projectScoped when projectId set, else clientScoped; contact INSERT allowed by WITH CHECK)  ret=R2  enc=none
/// audit: comment.deleted | comment.visibility_changed | portal.comment_created
model Comment {
  id              String             @id @default(uuid(7))
  tenantId        String
  clientId        String?                         // denormalised from subject — RLS; NULL only for tenant-internal documents
  projectId       String?                         // denormalised from subject — RLS (portal_enabled)
  subjectType     CommentSubjectType
  subjectId       String                          // soft pointer (validated by trigger) — never used for authorization (§10)
  parentId        String?                         // threaded reply → Comment (tenantId, id), same subject
  authorMemberId  String?                         // XOR authorContactId
  authorContactId String?
  body            Json                            // Tiptap JSON
  bodyText        String                          // extracted text (search feed, email, previews)
  visibility      Visibility         @default(INTERNAL)  // contact-authored forced CLIENT_VISIBLE
  editedAt        DateTime?          @db.Timestamptz(6)
  deletedAt       DateTime?          @db.Timestamptz(6)  // soft delete keeps the thread shape
  createdAt       DateTime           @default(now()) @db.Timestamptz(6)
  updatedAt       DateTime           @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, id])
  @@index([tenantId, subjectType, subjectId, createdAt])
  @@index([tenantId, clientId, visibility])
  @@index([tenantId, projectId, createdAt])
}

/// Mention — extracted @-mentions (ids only) for notification fan-out
/// and the "mentioned a Contact on an INTERNAL item" warning. Never
/// rendered from here (the body carries the text).
/// scope=tenant  rls=A (principalScoped)  ret=R2  enc=none
model Mention {
  id                 String   @id @default(uuid(7))
  tenantId           String
  commentId          String                       // → Comment (tenantId, id)
  mentionedMemberId  String?                      // XOR mentionedContactId
  mentionedContactId String?
  createdAt          DateTime @default(now()) @db.Timestamptz(6)

  @@unique([tenantId, commentId, mentionedMemberId, mentionedContactId])
  @@index([tenantId, mentionedMemberId])
}

/// ProjectTemplate — "pick a template" is the ONLY process picker in the
/// product (UI.md rule 13). Tenant-owned rows only: platform templates
/// are COPIED into the tenant at provisioning (no nullable tenantId —
/// keeps RLS and the census clean). definition Json = { states:
/// [{name, category, color}], epics: [{title, items: [{title,
/// description, estimateMinutes, checklist, visibility, labels}]}],
/// milestones: [...], settings: {defaultBillable, updateCadence, …} }.
/// "Save project as template" writes one; applying is audited.
/// scope=tenant  rls=A (principalScoped)  ret=R2  enc=none
/// audit: project_template.applied
model ProjectTemplate {
  id                String   @id @default(uuid(7))
  tenantId          String
  name              String
  description       String?
  locale            String?                       // language of the seeded titles (informational)
  definition        Json
  createdByMemberId String?
  createdAt         DateTime @default(now()) @db.Timestamptz(6)
  updatedAt         DateTime @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, name])
}
```

**Ordering (`ordering.ts`).** `moveItem(tx, {id, stateId?, afterId?, beforeId?})`: `SELECT … FOR UPDATE` the two neighbours in the target container (same project; column = state), `generateKeyBetween(a, b)` (fractional-indexing 4.x), UPDATE; on unique-violation retry with jitter (max 5), rebalance the project's keys in one tx when any key exceeds 50 chars. Rank is never shown. `WorkItemPlacement`/sprint order tables: not in v1 (§11).

**Numbering.** `counters.next(tx, "work_item:<projectId>")` inside the item-creation tx (§9); display `<Project.key>-<number>`; monotonic per project under concurrency (row-level upsert lock), gaps on rollback acceptable.

**State machine (`states.ts`).** Invoked from every entry point (drag, inline, palette, bulk, triage, import). Transitions are free except out of TRIAGE (accept → default state and clear triage fields; decline/duplicate → CANCELLED-category state). Entering IN_PROGRESS stamps `startedAt` (first time), entering DONE stamps `completedAt`, leaving DONE clears it; parent rollup per `Project.autoStartParent/autoCompleteParent`; writes `WorkItemActivity`; dual-writes `work_item.state_changed`; `notify.emit()` in the same tx.

**Rollups.** progress % = `count(DONE) / count(all − CANCELLED)` per parent/milestone/project — flat `GROUP BY root_id` / `milestone_id` on the denormalised columns; a bounded CTE only in one item's subtree pane. No `RollupCache` table until a tenant exceeds ~10k open items.

**Portal projection (`modules/work/portal.ts`).** Allow-listed select: `number, title, stateCategory, targetDate, milestoneId, assigneeContactId, visibility, updatedAt` + CLIENT_VISIBLE comments and activity. **Never:** state names, labels, links, priority, estimates, `assigneeMemberId`, INTERNAL rows. Assignee (member) names are not shown in the portal in v1 (P10). A forbidden-columns grep test and the "no INTERNAL fact to a Contact" fixture suite ship with the feature. View-as-Contact calls the same functions (asserted by import graph).

### 6.15 Time — entries, rates, budgets, summary, staff notice *(added 2026-08-16 — decision 11 reverses the v0.1 skip; plan §3.3; lands Phase 2T; entitlement `time`; Phase 4 items marked)*

Posture first (SECURITY.md §9.7, PLAN.md skip-list): a **self-started/stopped timer with manager-visible totals** is ordinary *tidsredovisning* — permitted, contract-necessary (IMY; consent is not a valid basis in employment). It becomes *övervakning* the moment the system captures what the employee did not volunteer. Hence the **never-list** (idle detection, screenshots, app/URL/keystroke capture, presence/"who is working now" broadcast, per-minute heatmaps, leaderboards, geolocation, peer-visible timelines) is enforced by *absence of columns*: `TimeEntry` has no IP, no location, no device, no activity fields, and no schema anywhere in this document may add them. Cost rates are salary-grade personal data — encrypted on the card, never fanned onto entry rows. Invoiced entries are räkenskapsinformation (R1, §5). `StaffNotice` + acknowledgment gate the first timer.

Pinned facts (plan §3.3): `TimeEntry` is **class A with no visibility column**; one running timer per member via partial unique index; `RateCard` rows immutable, COST amount encrypted on the card only, entry stores `costRateCardId`; `ProjectTimeSummary` is a **physical class-B table recomputed** per (project, month) in the entry transaction; the founder's "cost per hour" = project BILL rate.

**Amended 2026-08-20 (founder time-tracking session; three-track industry sweep in the session plan).** Six deltas join this section: **(D1)** `Shift` + `ShiftBreak` — a self-reported attendance layer (clock-in/out with breaks), class A, one open shift per member, reconciled against task time in the day view; team surfaces aggregate **closed** rows only — never a live "who is in" (never-list). **(D2)** ad-hoc "instant task" entries — `TimeEntry.clientId/projectId` become **nullable as a pair**; description-only, forced non-billable; categorize-later re-runs rate resolution. **(D3)** `TimeReport` — explicitly published, **immutable** client time reports (class B projectScoped; snapshot frozen at publish; INTERNAL names folded at generation). **(D4)** agreements — the existing `Service` (§6.6; UI label "Agreement"/"Avtal") becomes the rate carrier: `RateCard` scope `SERVICE`, `TimeEntry.serviceId` picked at start/during/after, resolution tier **above** PROJECT_MEMBER (an explicit pick outranks ambient defaults — the Productive/Accelo container semantics). **(D5)** `WorkType` — tenant-editable analytics dimension with `defaultBillable`; never rate-bearing. **(D6)** researched refinements: overlaps **allow + flag** by default (amendment below), one-click continue on recents, copy-last-week copies rows not hours, statutory-break warn flags (never auto-insert), monthly working-time statement export.

```prisma
// ───────────────────────────────────────────────────────────────────
// 6.15 TIME (Phase 2T) — module `time`
// Folder: src/modules/time/{timer,entries,shifts,rates,budgets,rollup,
// summary,reports,work-types,notice,portal,actions}.ts (shifts/reports/
// work-types ADDED 2026-08-20). Import direction: time → work → core.
// ───────────────────────────────────────────────────────────────────

enum TimeEntryMode {
  TIMER      // start/stop
  MANUAL     // start + end typed
  DURATION   // "1h 30m" / "90m" / "1,5"
}

enum TimeEntrySource {
  TIMER
  MANUAL
  IMPORT
  // API, OFFLINE_QUEUE — reserved (v1.5), not in the 2T enum
}

enum RateSource {
  SERVICE    // ADDED 2026-08-20 (D4) — resolved from the explicitly picked agreement's card
  PROJECT_MEMBER
  PROJECT
  MEMBER
  TENANT
  MANUAL     // rate typed on the entry by a rate:manage_bill holder
  NONE       // non-billable / no card resolved
}

/// Why an entry is frozen. Enum lands in 2T; invoicing sets INVOICED /
/// INVOICE_DRAFT in Phase 4; LOCK_DATE (tenant month-close) and APPROVED
/// (Phase 4/5 timesheet approve, if ever built) are reserved values.
enum TimeLockReason {
  INVOICED
  INVOICE_DRAFT
  LOCK_DATE
  APPROVED
  BILLED_EXTERNAL
  WRITTEN_OFF
}

enum TimeReviewReason {
  AUTO_STOPPED        // > time.autoStopHours (12) — needs a human look
  OVERLAP_TRUNCATED   // when the tenant allows overlaps and one was clipped
  STOP_BEFORE_START   // clock skew on the client; server clamped
  SKEW_CLAMPED
}

/// TimeEntry — one row per (member, interval). NULL stoppedAt = RUNNING.
/// Raw seconds stored; rounding is a Phase-4 invoice-line concern
/// (RoundingRule) — 2T reports show raw hours. Midnight-spanning stays
/// ONE row (localDate = the local start date in `timezone`).
/// CLASS A — the portal NEVER reads time_entry; the only portal time
/// surface is ProjectTimeSummary. No visibility column, by rule.
/// Money on the row: `billRate` is a PLAINTEXT SNAPSHOT resolved at WRITE
/// time (never at read) + `billRateCardId`; cost is `costRateCardId`
/// ONLY (never the amount — §4). Reprice = audited command.
/// Locks: lockedReason ⇒ BEFORE UPDATE/DELETE trigger raises unless
/// `current_setting('app.time_lock_bypass', true) = 'on'` — set
/// transaction-locally ONLY by the invoicing service (Phase 4), always
/// with an audit row (time_entry.unlocked / .locked).
/// SQL (hand-written, 2T migration):
///   CREATE UNIQUE INDEX time_entry_one_running ON time_entry
///     (tenant_id, member_id) WHERE stopped_at IS NULL AND deleted_at IS
///     NULL;                                     — one running timer per member
///   CHECK ((stopped_at IS NULL) = (duration_seconds IS NULL));
///   CHECK (stopped_at IS NULL OR stopped_at >= started_at);
///   CHECK (duration_seconds IS NULL OR duration_seconds =
///     EXTRACT(EPOCH FROM (stopped_at - started_at))::int);
///   CHECK (billable OR bill_rate IS NULL);
///   CHECK (work_item_id IS NOT NULL OR description IS NOT NULL) —
///     project-level entries require a note (preference
///     time.allowEntriesWithoutItem gates the UI; the CHECK is the floor);
///   CHECK ((client_id IS NULL) = (project_id IS NULL)) — ADDED
///     2026-08-20 (D2): ad-hoc "instant task" entries carry neither;
///   CHECK (work_item_id IS NULL OR project_id IS NOT NULL) — ADDED
///     2026-08-20 (D2);
///   CHECK (project_id IS NOT NULL OR NOT billable) — ADDED 2026-08-20
///     (D2): ad-hoc is forced non-billable (no rate context without a
///     project); attaching a project later re-runs resolution and
///     unlocks billable — categorize-later is the flow, not a failure;
///   CHECK (service_id IS NULL OR project_id IS NOT NULL) — ADDED
///     2026-08-20 (D4): an agreement implies client work;
///   TRIGGER time_entry_lock_guard BEFORE UPDATE OR DELETE: OLD.locked_
///     reason IS NOT NULL AND coalesce(current_setting('app.time_lock_
///     bypass', true), '') <> 'on' ⇒ RAISE;
///   TRIGGER time_entry_scope_guard BEFORE INSERT OR UPDATE (AMENDED
///     2026-08-20 — NULL-tolerant): validates ONLY when project_id IS
///     NOT NULL — work_item (if set) belongs to project; project
///     belongs to client; service (if set) belongs to the same client
///     AND (service.project_id IS NULL OR = project_id); all same
///     tenant;
///   no EXCLUDE constraint for overlaps — overlap policy is a TENANT
///     TOGGLE (time.allowOverlap — AMENDED 2026-08-20: default TRUE,
///     allow + flag; Toggl and Clockify both allow overlaps and refuse
///     to block, since manual/duration edits make them inevitable —
///     blocking is the documented failure mode. Overlapping rows get a
///     computed warn badge + a Team-view filter; timer-created overlaps
///     stay impossible via the one-running index. The app check under
///     pg_advisory_xact_lock(hashtext(tenant_id || member_id)) enforces
///     blocking only for tenants that switch the toggle off; a
///     constraint cannot be per-tenant. btree_gist EXCLUDE verified/
///     decided in the 1b Neon spike; if used later it is a tenant-level
///     opt-in via a partial predicate, still not global.)
///   Partial index (tenant_id, project_id, member_id) WHERE invoice_line_id
///     IS NULL AND billable AND deleted_at IS NULL — the uninvoiced queue.
/// Timer policy (timer.ts): start another ⇒ auto-stop the running one in
/// the same tx and return both (undo toast); nudge at time.nudgeHours (8,
/// in-app), auto-stop at time.autoStopHours (12) → needsReview — cron
/// */15 AND applied lazily on GET /api/timer/current and list reads (so
/// it is correct before Vercel Pro crons exist). Server-authoritative
/// timestamps. Offline event queue = v1.5 (clientEventId reserved).
/// scope=tenant (clientId/projectId denormalised for scoping + rollups, NOT for portal)  rls=A (principalScoped — no visibility column)  ret=R1 when invoiced / HR class otherwise (§5)  enc=none (cost never on the row)
/// audit: timer.started | timer.stopped | timer.auto_stopped | time_entry.created (manual) | time_entry.edited_by_other | time_entry.deleted | time_entry.locked | time_entry.unlocked | time_entry.repriced | time.exported
model TimeEntry {
  id               String           @id @default(uuid(7))
  tenantId         String
  clientId         String?                        // denormalised from project — scoping + client rollups; NULL = ad-hoc (AMENDED 2026-08-20, D2 — pair-null with projectId)
  projectId        String?                        // → Project (tenantId, id); NULL = ad-hoc "instant task"
  serviceId        String?                        // ADDED 2026-08-20 (D4) → Service (tenantId, id) — the chosen agreement
  workTypeId       String?                        // ADDED 2026-08-20 (D5) → WorkType (tenantId, id) — analytics, never rate-bearing
  workItemId       String?                        // → WorkItem (tenantId, id); NULL = project-level (note required)
  memberId         String                         // → Member (tenantId, id); pseudonymised on erasure (R1)
  description      String?
  startedAt        DateTime         @db.Timestamptz(6)
  stoppedAt        DateTime?        @db.Timestamptz(6)  // NULL = running
  durationSeconds  Int?                           // CHECK-tied to stoppedAt; raw, never rounded
  timezone         String           @db.VarChar(64)     // IANA at write time (Member.timezone → tenant)
  localDate        DateTime         @db.Date       // start date in `timezone`; week grids, rate resolution
  entryMode        TimeEntryMode
  source           TimeEntrySource  @default(TIMER)
  billable         Boolean                        // seeded from Project.defaultBillable
  // Rate snapshot (resolved at WRITE — rates.ts):
  billRate         Decimal?         @db.Decimal(12, 2)  // plaintext snapshot; NULL when non-billable
  currency         String?          @db.Char(3)         // = Project.billingCurrency at write
  rateSource       RateSource       @default(NONE)
  billRateCardId   String?                        // → RateCard (tenantId, id), kind BILL
  costRateCardId   String?                        // → RateCard (tenantId, id), kind COST — id ONLY, never the amount
  // Locks & invoicing bridge (Phase 4 sets these; columns land in 2T):
  lockedReason     TimeLockReason?
  lockedAt         DateTime?        @db.Timestamptz(6)
  invoiceLineId    String?                        // Phase 4 → InvoiceLine (tenantId, id); ⇒ R1
  retainerPeriodId String?                        // Phase 4 → RetainerPeriod
  billedExternallyAt DateTime?      @db.Timestamptz(6)
  writtenOffAt     DateTime?        @db.Timestamptz(6)
  // Review flags:
  needsReview      Boolean          @default(false)
  reviewReason     TimeReviewReason?
  // Offline queue (v1.5; reserved, NULL in 2T):
  clientEventId    String?
  clientStartedAt  DateTime?        @db.Timestamptz(6)
  skewMs           Int?
  createdByMemberId String?                       // who wrote it (≠ memberId when a manager edits: time_entry.edited_by_other)
  deletedAt        DateTime?        @db.Timestamptz(6)  // soft delete; excluded from the running index
  createdAt        DateTime         @default(now()) @db.Timestamptz(6)
  updatedAt        DateTime         @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, id])
  @@unique([tenantId, memberId, clientEventId])   // offline idempotency (NULLs distinct)
  @@index([tenantId, memberId, startedAt(sort: Desc)])  // My Time
  @@index([tenantId, projectId, startedAt])       // project time tab, summary recompute
  @@index([tenantId, workItemId])                 // Σ spent on a card
  @@index([tenantId, serviceId])                  // ADDED 2026-08-20 — per-agreement rollups + consumption strip
  @@index([tenantId, workTypeId])                 // ADDED 2026-08-20 — per-type rollups
  @@index([tenantId, localDate, memberId])        // week grid, team view
  @@index([tenantId, costRateCardId])             // cost aggregation GROUP BY
  @@index([tenantId, billRateCardId])             // reprice scope
  @@index([tenantId, invoiceLineId])              // Phase 4
}

enum RateKind {
  BILL   // what the client pays — the founder's "cost per hour for the project"
  COST   // internal cost (salary-derived) — encrypted, finance-only
}

enum RateScope {
  TENANT
  MEMBER
  PROJECT
  PROJECT_MEMBER
  SERVICE          // ADDED 2026-08-20 (D4) — the agreement's own BILL rate; serviceId only
  // SERVICE_MEMBER reserved (v1.5) — per-member rates within an agreement; ALTER TYPE ADD VALUE later is cheap
}

/// RateCard — IMMUTABLE ROWS: a change = close the old row (set
/// effectiveTo) + insert a new one, so a card id is a stable snapshot
/// that TimeEntry rows can point at forever. amount (BILL) is plaintext;
/// amountCiphertext (COST) is v2-encrypted with AAD
/// `tenantId:rate_card:<id>:amount` (§4) and Prisma `omit`ted globally —
/// decrypted only in rates.ts behind rate:view_cost ✦ + recent MFA, a
/// handful of cards per aggregation, audited once per session
/// (rate_card.cost_revealed). No task-scoped rates (§11).
/// SQL: CHECK ((kind = 'BILL') = (amount IS NOT NULL) AND (kind = 'COST')
///   = (amount_ciphertext IS NOT NULL)); CHECK scope ↔ member_id/
///   project_id/service_id nullness (TENANT: all NULL; MEMBER: member
///   only; PROJECT: project only; PROJECT_MEMBER: member + project;
///   SERVICE: service only — AMENDED 2026-08-20, D4); CHECK (kind <>
///   'COST' OR scope IN ('MEMBER','TENANT')) — COST stays salary-
///   derived, never per agreement; TRIGGER rate_card_immutable BEFORE
///   UPDATE: only effective_to may change, and only from NULL to a date
///   >= effective_from; no-overlap per (tenant, kind, scope, member,
///   project, service — dimension AMENDED 2026-08-20): EXCLUDE USING
///   gist (… daterange(effective_from, effective_to) WITH &&) IF
///   btree_gist verified on Neon in the 1b spike, ELSE app check under
///   advisory lock (decided fallback written into the 2T migration).
///   Rate-change UI wording is pinned (2026-08-20, industry-converged):
///   "applies from <date>; past entries unchanged; use Reprice to
///   correct history."
/// scope=tenant  rls=A (principalScoped)  ret=R2 / R1 when referenced by an invoiced entry / COST 24 mo after close (§5)  enc=amountCiphertext (COST)
/// audit: rate_card.created | rate_card.closed | rate_card.cost_revealed
model RateCard {
  id               String    @id @default(uuid(7))
  tenantId         String
  kind             RateKind
  scope            RateScope
  memberId         String?                        // MEMBER / PROJECT_MEMBER
  projectId        String?                        // PROJECT / PROJECT_MEMBER
  serviceId        String?                        // ADDED 2026-08-20 (D4) — SERVICE scope → Service (tenantId, id)
  amount           Decimal?  @db.Decimal(12, 2)   // BILL only, plaintext
  amountCiphertext String?                        // COST only — v2 ENCRYPTED, AAD-bound, omit()ted
  currency         String    @db.Char(3)
  effectiveFrom    DateTime  @db.Date
  effectiveTo      DateTime? @db.Date             // NULL = open; the ONLY mutable column
  createdByMemberId String?
  createdAt        DateTime  @default(now()) @db.Timestamptz(6)

  @@unique([tenantId, id])
  @@index([tenantId, kind, scope, projectId, memberId, effectiveFrom])  // resolution lookup
  @@index([tenantId, serviceId, kind])            // ADDED 2026-08-20 — agreement-rate lookup
  @@index([tenantId, memberId, kind])
}

enum BudgetKind {
  HOURS
  MONEY
}

enum BillingModel {
  T_AND_M
  FIXED_FEE
  RETAINER
  NON_BILLABLE
}

enum BudgetPeriod {
  NONE
  WEEKLY
  MONTHLY
  QUARTERLY
  YEARLY
}

enum BudgetStatus {
  ACTIVE
  ARCHIVED
}

/// ProjectBudget — hours-or-money budget with once-per-threshold alerts.
/// One ACTIVE per project (partial unique). Retainer/hour-bank LEDGER is
/// Phase 4 (RetainerPlan/Period/HourBankTransaction); billingModel =
/// RETAINER here is intent + a cap, not a ledger.
/// SQL: CREATE UNIQUE INDEX project_budget_one_active ON project_budget
///   (tenant_id, project_id) WHERE status = 'ACTIVE';
///   CHECK (period = 'NONE' OR period_anchor IS NOT NULL);
///   CHECK (thresholds <@ ARRAY[1..200]) — percentages, sorted by app.
/// scope=tenant (clientId/projectId denormalised)  rls=A (principalScoped — budget figures never reach the portal directly; ProjectTimeSummary carries budgetSeconds/budgetAmount when hoursSharingMode allows)  ret=R2  enc=none
/// audit: budget.created | budget.changed | budget.alert_sent
model ProjectBudget {
  id                 String       @id @default(uuid(7))
  tenantId           String
  clientId           String
  projectId          String
  kind               BudgetKind
  billingModel       BillingModel @default(T_AND_M)
  amount             Decimal      @db.Decimal(12, 2)   // hours (as decimal hours) or money
  currency           String?      @db.Char(3)          // MONEY: = Project.billingCurrency
  period             BudgetPeriod @default(NONE)
  periodAnchor       DateTime?    @db.Date
  includeNonBillable Boolean      @default(false)
  thresholds         Int[]        @default([80, 100])
  notifyMemberIds    String[]     @default([])
  status             BudgetStatus @default(ACTIVE)
  createdByMemberId  String?
  createdAt          DateTime     @default(now()) @db.Timestamptz(6)
  updatedAt          DateTime     @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, id])
  @@index([tenantId, projectId, status])
}

/// BudgetAlert — once per (budget, period, threshold). The unique IS the
/// dedupe: the hourly budget cron INSERTs and a conflict means "already
/// sent". periodKey = "ALL" for period NONE, else ISO period label.
/// scope=tenant  rls=A (principalScoped)  ret=HR-adjacent (deleted with the budget)  enc=none
model BudgetAlert {
  id        String   @id @default(uuid(7))
  tenantId  String
  budgetId  String                                 // → ProjectBudget (tenantId, id)
  periodKey String                                 // "ALL" | "2026-W34" | "2026-08" | …
  threshold Int
  sentAt    DateTime @default(now()) @db.Timestamptz(6)

  @@unique([tenantId, budgetId, periodKey, threshold])
}

/// ProjectTimeSummary — THE ONLY PORTAL TIME SURFACE. A PHYSICAL class-B
/// table (a SQL view was rejected: under FORCE RLS a view over class-A
/// time_entry returns 0 rows to a contact — §11). One row per (project,
/// month). NO MEMBER ID COLUMN BY CONSTRUCTION — per-member breakdown can
/// never reach a contact-selectable row.
/// Maintenance: RECOMPUTED (not delta-upserted) for the touched (project,
/// periodMonth) IN THE SAME TRANSACTION as every time_entry write
/// (insert/update/delete/reprice/lock), i.e. `INSERT … SELECT SUM(…)
/// FROM time_entry WHERE tenant_id=$1 AND project_id=$2 AND localDate in
/// month ON CONFLICT (tenant_id, project_id, period_month) DO UPDATE`;
/// nightly self-heal job recomputes every (project, month) touched in
/// the last 35 days; property test `summary == SUM(time_entry)` after
/// random writes. Recompute-not-delta because a delta drifts on every
/// edge (edit that moves an entry across months, delete of a running
/// entry, reprice) and a full month of one project is a few hundred rows.
/// visibility DERIVED: CLIENT_VISIBLE iff Project.hoursSharingMode ≠
/// NONE (trigger on project.hours_sharing_mode fans out like
/// portal_enabled); billableAmount populated only when mode =
/// BILLABLE_AMOUNT; budget columns copied from the ACTIVE budget when the
/// mode allows. Portal reads it under the contact principal via RLS —
/// no system-principal bypass in any portal read path.
/// scope=client  rls=B (projectScoped: client_id, visibility, portal_enabled)  ret=R2  enc=none
model ProjectTimeSummary {
  id                 String     @id @default(uuid(7))
  tenantId           String
  clientId           String
  projectId          String
  periodMonth        DateTime   @db.Date            // first day of month
  billableSeconds    Int        @default(0)
  nonBillableSeconds Int        @default(0)
  billableAmount     Decimal?   @db.Decimal(12, 2)  // only when hoursSharingMode = BILLABLE_AMOUNT
  budgetSeconds      Int?                            // from the ACTIVE HOURS budget, when shared
  budgetAmount       Decimal?   @db.Decimal(12, 2)  // from the ACTIVE MONEY budget, when shared
  currency           String?    @db.Char(3)
  visibility         Visibility @default(INTERNAL)  // derived from Project.hoursSharingMode
  portalEnabled      Boolean    @default(false)     // ADDED 2026-08-20 (doc fix) — trigger-derived like every projectScoped row; the rls=B annotation below always required it
  computedAt         DateTime   @default(now()) @db.Timestamptz(6)

  @@unique([tenantId, projectId, periodMonth])
  @@index([tenantId, clientId, visibility])
}

/// StaffNotice — the information the tenant gives its staff before time
/// tracking starts (Art. 13 GDPR; MBL 19 §; NY/CT/DE notice statutes by
/// jurisdictionTags). Versioned & immutable; sv/en draft text ships in
/// the seed so 2T is demoable; purposes are billing / planning /
/// profitability — explicitly NOT performance evaluation. Timers refuse
/// to start until the member has acknowledged the current version.
/// scope=tenant  rls=A (principalScoped)  ret=R2 (versions never deleted)  enc=none
/// audit: staff_notice.published
model StaffNotice {
  id                String   @id @default(uuid(7))
  tenantId          String
  version           Int
  locale            String                          // "sv" | "en" | … one row per locale per version
  title             String
  body              String                          // markdown
  purposes          String[]                        // ["billing","planning","profitability"]
  jurisdictionTags  String[]                        // ["SE","US-NY",…]
  publishedAt       DateTime? @db.Timestamptz(6)
  publishedByMemberId String?
  createdAt         DateTime @default(now()) @db.Timestamptz(6)

  @@unique([tenantId, version, locale])
  @@unique([tenantId, id])
}

/// StaffNoticeAcknowledgment — one per (member, notice version). Evidence
/// of the information duty — pseudonymised, not deleted, on erasure (§5).
/// scope=tenant  rls=A (principalScoped)  ret=R2 (membership + 24 mo)  enc=none
/// audit: staff_notice.acknowledged
model StaffNoticeAcknowledgment {
  id             String   @id @default(uuid(7))
  tenantId       String
  memberId       String
  noticeId       String                              // → StaffNotice (tenantId, id)
  noticeVersion  Int
  locale         String                              // which rendering was shown
  acknowledgedAt DateTime @default(now()) @db.Timestamptz(6)

  @@unique([tenantId, memberId, noticeId, noticeVersion])
  @@index([tenantId, memberId])
}

// ─── ADDED 2026-08-20 — D1 attendance layer, D3 published reports, ───
// ─── D5 work types (founder session; industry sweep in session log) ───

/// Shift — self-reported attendance: clock-in/out with breaks. A
/// second, deliberate layer next to TimeEntry (the Clockify/Clockodo/
/// Personio convention): the shift answers "when did I work", entries
/// answer "what on"; the personal day view reconciles shift − breaks −
/// tracked = unallocated (a view no comparator ships without activity
/// monitoring — differentiator). NO live presence: team surfaces
/// aggregate CLOSED rows only for members other than the viewer; no
/// open/active flag is ever selected for another member (never-list,
/// SECURITY §9.7). Timers never REQUIRE a shift; the staff-notice gate
/// covers clockIn exactly as timer start. CCOO (C-55/18) readiness:
/// with the monthly working-time statement export this is the
/// "objective, reliable, accessible" daily record; retention =
/// working-time/HR class (ATL §11 journal: its year + 2 following;
/// Denmark's 5-y 2024 law is the Nordic benchmark — SECURITY §9.7).
/// SQL (hand-written, 2T migration):
///   CREATE UNIQUE INDEX shift_one_open ON shift (tenant_id, member_id)
///     WHERE stopped_at IS NULL AND deleted_at IS NULL; — one open shift
///   CHECK (stopped_at IS NULL OR stopped_at >= started_at);
///   CHECK ((stopped_at IS NULL) = (worked_seconds IS NULL));
///   CHECK (worked_seconds IS NULL OR (worked_seconds >= 0 AND
///     worked_seconds <= EXTRACT(EPOCH FROM (stopped_at -
///     started_at))::int)); — exact equality vs Σ breaks is service-
///     maintained + property-tested (cross-row, not CHECK-able);
///   TRIGGER shift_shrink_guard BEFORE UPDATE OF started_at, stopped_at:
///     RAISE if any shift_break would fall outside the new span.
/// Policy (shifts.ts, under pg_advisory_xact_lock(hashtext(tenant_id ||
/// member_id)) — the same lock timer.ts takes): startBreak requires an
/// open shift and auto-stops a running TimeEntry in the same tx (undo
/// toast — the pinned start-another pattern); startTimer auto-closes an
/// open break (working ⇒ not on break); clockOut closes the open break,
/// recomputes workedSeconds, closes the shift, and auto-stops a running
/// timer (undo offered). Auto-stop at time.shiftAutoStopHours (pref,
/// default 14): deterministic stopped_at = started_at + cap ⇒
/// idempotent under lazy + cron double-run; closes the open break at
/// the same bound; needsReview + AUTO_STOPPED; auto-closed shifts are
/// VISIBLY PROVISIONAL until the member confirms the real end (one
/// click from the needs-review banner). Statutory-break WARN flag
/// (computed, never stored, NEVER auto-inserted — auto-deduction
/// fabricates records; Clockodo's warn-at-entry is the model): a closed
/// span > 5 h without a recorded break gets a rast badge (ATL). v1
/// break stance, stated in the staff notice: a recorded break = rast
/// (unpaid); paus is working time and simply is not clocked.
/// Member.hoursPerDay is the v1 display expectation only — a dated
/// MemberWorkSchedule is the designated structure when the cumulative
/// overtime account lands (deliberately deferred, §11).
/// Permissions: reuses time:track / time:view_team / time:edit_any /
/// time:delete_any — zero new codes for shifts.
/// scope=tenant  rls=A (principalScoped — never portal-reachable)  ret=working-time/HR class (§5)  enc=none
/// audit: shift.started | shift.stopped | shift.auto_stopped | shift.edited_by_other | shift.deleted | shift.break_started | shift.break_stopped
model Shift {
  id                String            @id @default(uuid(7))
  tenantId          String
  memberId          String                          // → Member (tenantId, id)
  startedAt         DateTime          @db.Timestamptz(6)
  stoppedAt         DateTime?         @db.Timestamptz(6)  // NULL = open
  workedSeconds     Int?                            // service-maintained = span − Σ breaks
  timezone          String            @db.VarChar(64)     // IANA at write (Member.timezone → tenant)
  localDate         DateTime          @db.Date       // start date in `timezone`
  note              String?
  needsReview       Boolean           @default(false)
  reviewReason      TimeReviewReason?                // AUTO_STOPPED fits; enum shared with TimeEntry
  createdByMemberId String?                          // ≠ memberId ⇒ shift.edited_by_other
  deletedAt         DateTime?         @db.Timestamptz(6)  // soft delete; excluded from the open index
  createdAt         DateTime          @default(now()) @db.Timestamptz(6)
  updatedAt         DateTime          @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, id])                          // composite-FK target (ShiftBreak)
  @@index([tenantId, memberId, startedAt(sort: Desc)])
  @@index([tenantId, localDate, memberId])          // day grids, team totals, statement export
}

/// ShiftBreak — a typed break ROW inside a shift (rows, not pause-
/// events: the Clockify/Personio/Factorial convention, and what the
/// rast check and an authority-facing export need). Hard delete;
/// after-the-fact corrections by another member ride
/// shift.edited_by_other metadata. One open break per shift + one open
/// shift per member ⇒ transitively one open break per member.
/// SQL: CREATE UNIQUE INDEX shift_break_one_open ON shift_break
///     (tenant_id, shift_id) WHERE stopped_at IS NULL;
///   CHECK (stopped_at IS NULL OR stopped_at >= started_at);
///   CHECK ((stopped_at IS NULL) = (duration_seconds IS NULL));
///   CHECK (duration_seconds IS NULL OR duration_seconds =
///     EXTRACT(EPOCH FROM (stopped_at - started_at))::int);
///   TRIGGER shift_break_bounds_guard BEFORE INSERT OR UPDATE: parent
///     shift exists; started_at >= shift.started_at; when the shift is
///     closed the break lies fully inside it. (Triggers, not app-only:
///     bounds are absolute invariants with multiple writer paths —
///     self-service, time:edit_any, future import.)
/// scope=tenant  rls=A (principalScoped)  ret=follows Shift  enc=none
model ShiftBreak {
  id                String    @id @default(uuid(7))
  tenantId          String
  shiftId           String                          // → Shift (tenantId, id) ON DELETE CASCADE
  memberId          String                          // denormalised — break totals per member/day without a join
  startedAt         DateTime  @db.Timestamptz(6)
  stoppedAt         DateTime? @db.Timestamptz(6)    // NULL = open
  durationSeconds   Int?                            // CHECK-tied, as on TimeEntry
  note              String?
  createdByMemberId String?
  createdAt         DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt         DateTime  @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, id])
  @@index([tenantId, shiftId])
  @@index([tenantId, memberId, startedAt])
}

enum TimeReportStatus {
  DRAFT
  PUBLISHED
  ARCHIVED
}

enum TimeReportGroupBy {
  DAY
  WORK_ITEM
  EPIC
  SERVICE    // by agreement — "maintenance hours this month"
}

/// TimeReport — an EXPLICITLY published, IMMUTABLE client time report
/// ("not all the reports — the ones the user wants"; founder decision
/// 2026-08-20). Industry ships live share links whose data silently
/// changes after edits (Toggl/Clockify) or says "export a PDF yourself"
/// (Harvest); a hosted frozen snapshot is deliberately better and
/// mirrors ProjectUpdate's publish model (§6.16). Coexists with the
/// live monthly ProjectTimeSummary widget (hoursSharingMode): widget =
/// ambient transparency, report = statement of record.
/// SNAPSHOT IS CLIENT-SAFE BY CONSTRUCTION: the generator's SQL never
/// selects/groups member_id (no member key can exist — same rule as
/// ProjectTimeSummary), and lines carry an entity's NAME only when that
/// entity (work item / service) is CLIENT_VISIBLE — INTERNAL ones fold
/// into one generic "Other work" line AT GENERATION TIME, so any
/// snapshot is publishable without a validate-at-publish step. Fixture
/// test: an INTERNAL task title / agreement name never appears in any
/// snapshot.
/// Generation runs under the acting member (RLS live): requires
/// time_report:manage + time:view_team (+ rate:view_bill when
/// includeAmounts); internal readers without rate:view_bill get amount
/// keys stripped by the service. Per-project in v1 (cross-project
/// analysis stays in /time/team + CSV).
/// SQL: CHECK (period_end >= period_start);
///   CHECK ((status = 'DRAFT') = (published_at IS NULL));
///   CHECK (visibility = 'INTERNAL' OR status = 'PUBLISHED');
///   portal_gate is FOUR-term: client_id = app.client_id AND visibility
///     = 'CLIENT_VISIBLE' AND portal_enabled AND status = 'PUBLISHED';
///   TRIGGER time_report_immutable BEFORE UPDATE: once published_at is
///     set, only status (PUBLISHED → ARCHIVED), visibility, updated_at
///     may change, else RAISE;
///   TRIGGER time_report_no_delete_published BEFORE DELETE: RAISE when
///     published_at IS NOT NULL (drafts hard-delete; published are
///     archive-only).
/// Publish = status → PUBLISHED + visibility → CLIENT_VISIBLE in ONE
/// audited tx; unpublish = visibility → INTERNAL (status stays
/// PUBLISHED; republish allowed). Portal capability: portal.hours.view
/// (CONTACT_PRIMARY) — the portal page section lands Phase 3; the gate
/// is proven by contact-principal dbtests in 2T.
/// scope=client  rls=B (projectScoped: client_id, visibility, portal_enabled)  ret=R2 (R1-adjacent once invoice-referenced, Phase 4)  enc=none
/// audit: time_report.created | time_report.updated | time_report.published | time_report.unpublished | time_report.archived | time_report.deleted
model TimeReport {
  id                  String            @id @default(uuid(7))
  tenantId            String
  clientId            String
  projectId           String
  title               String
  periodStart         DateTime          @db.Date
  periodEnd           DateTime          @db.Date
  groupBy             TimeReportGroupBy @default(DAY)
  includeAmounts      Boolean           @default(false)
  includeNonBillable  Boolean           @default(false)
  snapshot            Json                            // lines + totals; NEVER a member key; INTERNAL names folded
  totalSeconds        Int               @default(0)
  billableSeconds     Int               @default(0)
  billableAmount      Decimal?          @db.Decimal(12, 2)  // only when includeAmounts
  currency            String?           @db.Char(3)         // = Project.billingCurrency at generation
  status              TimeReportStatus  @default(DRAFT)
  visibility          Visibility        @default(INTERNAL)  // publish flips to CLIENT_VISIBLE; app-written
  portalEnabled       Boolean           @default(false)     // trigger-derived, never app-written
  generatedAt         DateTime          @default(now()) @db.Timestamptz(6)
  publishedAt         DateTime?         @db.Timestamptz(6)
  publishedByMemberId String?
  createdByMemberId   String?
  createdAt           DateTime          @default(now()) @db.Timestamptz(6)
  updatedAt           DateTime          @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, id])
  @@index([tenantId, projectId, periodStart])
  @@index([tenantId, clientId, visibility])
}

/// WorkType — tenant-editable time category ("where does the time
/// go"): a LOOKUP TABLE, not an enum — a fixed enum would bake one
/// tenant's vocabulary into the schema (§12) — and NOT rate-bearing:
/// rate-carrying type lists are a substitute for a missing engagement
/// layer and degenerate (Harvest's documented "Jane Programming"
/// workaround); differentiated pricing per kind of work = a second
/// agreement (D4, §6.6). defaultBillable (nullable) seeds
/// TimeEntry.billable — order: explicit choice → workType.
/// defaultBillable → project.defaultBillable. Seeded per tenant at
/// provisioning, localized by Tenant.defaultLocale: Client development
/// · Internal product development (false) · Consultancy · Meeting ·
/// Learning (false) · Marketing (false) — editable/extendable per
/// tenant. Internal product work itself uses the SELF-CLIENT
/// CONVENTION (a Client row for the tenant itself, portal never
/// enabled) — Project.clientId stays NOT NULL; nullable clientId was
/// considered and rejected (client_id is load-bearing in every RLS
/// gate and scope axis). Archived types stay on history, disappear
/// from pickers. Never portal-reachable in v1.
/// SQL: CREATE UNIQUE INDEX work_type_name_live ON work_type
///   (tenant_id, name) WHERE archived_at IS NULL; — names unique among
///   live rows, reusable after archive.
/// scope=tenant  rls=A (principalScoped)  ret=R2  enc=none
/// audit: work_type.created | work_type.updated | work_type.archived
model WorkType {
  id                String    @id @default(uuid(7))
  tenantId          String
  name              String
  sortOrder         Int       @default(0)
  defaultBillable   Boolean?                        // NULL = inherit project.defaultBillable
  archivedAt        DateTime? @db.Timestamptz(6)
  createdByMemberId String?
  createdAt         DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt         DateTime  @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, id])
  @@index([tenantId, archivedAt, sortOrder])       // picker: live rows in order
}

// ─── Phase 4 (invoicing bridge) — shapes fixed now, tables land then ───

enum RoundingMode {
  UP
  NEAREST
  DOWN
}

/// RoundingRule [Phase 4] — referenced by Project.roundingRuleId; applied
/// ONLY at invoice-line creation (raw + rounded stored on the line's
/// metadata). Never mutates stored seconds. incrementMinutes ∈ {1, 6, 10,
/// 15, 30, 60} (CHECK).
/// scope=tenant  rls=A (principalScoped)  ret=R2  enc=none
model RoundingRule {
  id                    String       @id @default(uuid(7))
  tenantId              String
  name                  String
  incrementMinutes      Int
  mode                  RoundingMode @default(NEAREST)
  minimumBillableMinutes Int         @default(0)
  createdAt             DateTime     @default(now()) @db.Timestamptz(6)

  @@unique([tenantId, name])
  @@unique([tenantId, id])
}

/// InvoiceLineTimeEntry [Phase 4] — IMMUTABLE history of which entries
/// fed which line (survives release on credit note: the entry's
/// invoiceLineId is cleared under app.time_lock_bypass, this row stays).
/// rawSeconds/roundedSeconds/rate frozen at line creation.
/// scope=tenant (clientId denormalised)  rls=A (principalScoped)  ret=R1  enc=none
model InvoiceLineTimeEntry {
  tenantId       String
  invoiceLineId  String
  timeEntryId    String
  rawSeconds     Int
  roundedSeconds Int
  billRate       Decimal  @db.Decimal(12, 2)
  currency       String   @db.Char(3)
  createdAt      DateTime @default(now()) @db.Timestamptz(6)

  @@id([tenantId, invoiceLineId, timeEntryId])
  @@index([tenantId, timeEntryId])
}

/// Retainer* [Phase 4, SKETCH — build only if a tenant has a retainer
/// client by then]: RetainerPlan(projectId, includedHoursPerPeriod,
/// interval, carryOverPolicy {NONE, CAPPED, UNLIMITED}, carryOverCap,
/// overagePolicy {BILL_AT_RATE, ALERT_ONLY, BLOCK}, deficitPolicy);
/// RetainerPeriod(planId, periodStart/End, state {SCHEDULED, OPEN, CLOSED,
/// SETTLED}, EXCLUDE on daterange); HourBankTransaction(periodId, kind
/// {CREDIT, DEBIT, CARRY_IN, CARRY_OUT, EXPIRE, ADJUST}, seconds, note) —
/// append-only; consumption derived from entries via retainerPeriodId.
/// Portal retainer widget reads a summary column set on ProjectTimeSummary
/// (retainerIncludedSeconds/UsedSeconds), added then.
```

**Rate resolution (`rates.ts`) — at WRITE, never at read.** *(Amended 2026-08-20: SERVICE tier + `serviceId` joins the re-resolution list.)* Runs on entry create and on any change of `memberId`, `projectId`, `serviceId`, `billable`, `localDate`: candidates = cards with `effectiveFrom ≤ localDate < coalesce(effectiveTo, 'infinity')`; **BILL** = first non-empty tier in `SERVICE(serviceId)` *(only when the entry carries an agreement — an explicit pick outranks ambient defaults; Productive/Accelo container semantics)* `→ PROJECT_MEMBER(projectId, memberId) → PROJECT(projectId) → MEMBER(memberId) → TENANT`; **COST** = `MEMBER → TENANT` (never per agreement). Store `billRate` (plaintext snapshot), `currency`, `rateSource`, `billRateCardId`, `costRateCardId` (id only). `billable = false ⇒ billRate NULL, rateSource NONE`. A later card change never touches existing entries (snapshot stability test). Bill amounts in SQL: `SUM(duration_seconds)/3600 × bill_rate`; **cost aggregation** = `SUM(duration_seconds) GROUP BY cost_rate_card_id` → decrypt the handful of cards in app behind `rate:view_cost` ✦ + `requireRecentMfa()` → multiply; cost columns never in CSV by default, never in `AuditEvent.metadata`, never portal-reachable.

**Reprice** = audited command `(rateCardId, FROM_DATE | ALL_UNBILLED)` in one tx: re-resolves and updates only entries that (a) currently point at that card, (b) are unlocked, (c) fall in scope; recomputes every touched `ProjectTimeSummary` (project, month); `time_entry.repriced` with counts. *(2026-08-20)* Locked entries are **skipped and counted** in the audit metadata — the contract exists before Phase 4's locks do.

**Who sees money.** Employee: own hours. Manager: hours + bill rates + budgets (`time:view_team`, `rate:view_bill`, `budget:view`). CEO/finance: cost + margin (`rate:view_cost` ✦, `rate:manage_cost` ✦; preference `finance.costRates.enabled`). UI labels: "Rate / Value" vs "Internal cost / Margin".

### 6.16 Progress updates — ProjectUpdate, internal snapshot, Client Timeline *(added 2026-08-16 — plan §3.5; lands Phase 3 as the portal centrepiece; rides on entitlement `work`; schedules/templates Phase 5)*

The pattern (Asana/Linear): an **immutable status post** with a **human-chosen** health signal and **machine-filled** metrics, on a cadence enforced by reminders; the client sees one page — "how is it going, what's next, what do you need from me, what did I get" — never a board.

```prisma
// ───────────────────────────────────────────────────────────────────
// 6.16 PROGRESS UPDATES (Phase 3; schedules Phase 5) — module `work`
// (project_update:* permissions live under `work`)
// ───────────────────────────────────────────────────────────────────

/// Human-chosen. NEVER computed from data (a computed health is either
/// wrong or ignored; the machine numbers sit next to it instead).
enum ProjectHealth {
  ON_TRACK
  AT_RISK
  OFF_TRACK
  ON_HOLD
  COMPLETE
}

enum ProjectUpdateStatus {
  DRAFT
  PUBLISHED
  ARCHIVED   // archive-only; never deleted once published
}

/// ProjectUpdate — one status post. seq from counters.next("project_
/// update:<projectId>"). body Json = { sections: [{ key SUMMARY | DONE |
/// NEXT | BLOCKERS | DECISIONS_NEEDED | CUSTOM, title?, body Tiptap }] }.
/// portalSnapshot Json = PORTAL-SAFE metrics frozen at publish: { tasks:
/// {done, total, doneInPeriod}, milestones: {done, total, hitInPeriod[]},
/// versions: {shippedInPeriod[]}, requests: {open, closedInPeriod},
/// hours: {inPeriod, toDate, budget}? — ONLY when Project.
/// hoursSharingMode ≠ NONE, and amounts only for BILLABLE_AMOUNT,
/// computedAt }. Anything per-member or cost-related lives on
/// ProjectUpdateInternalSnapshot (class A) so it never sits on a row a
/// contact can select. A forbidden-keys test walks portalSnapshot.
/// Immutability: TRIGGER project_update_immutable BEFORE UPDATE: when
/// OLD.published_at IS NOT NULL only status (PUBLISHED→ARCHIVED),
/// visibility, editNote, pdfDocumentId may change (15-min grace window
/// after publish is APP-level: the service re-issues as a new seq if
/// content must change after that — "edited" is a new post with
/// editNote). Internal remarks = INTERNAL Comments on the update.
/// portal_gate: only PUBLISHED rows are visible to contacts — the policy
/// adds `status = 'PUBLISHED'` to the three-term gate.
/// scope=client  rls=B (projectScoped; + status = PUBLISHED)  ret=R2  enc=none
/// audit: project_update.published | project_update.archived | project_update.visibility_changed
model ProjectUpdate {
  id                  String              @id @default(uuid(7))
  tenantId            String
  clientId            String
  projectId           String
  seq                 Int                                 // counters.next("project_update:<projectId>")
  health              ProjectHealth                       // human-chosen
  title               String?
  periodStart         DateTime?           @db.Date
  periodEnd           DateTime?           @db.Date
  body                Json                                // sections
  bodyText            String?                             // extracted (search feed, email digest)
  portalSnapshot      Json?                               // portal-safe metrics, frozen at publish
  changesSinceLast    Json?                               // pull-in panel source (ids), staff-only rendering
  status              ProjectUpdateStatus @default(DRAFT)
  visibility          Visibility          @default(INTERNAL)  // publish flow asks; portal-enabled projects default CLIENT_VISIBLE in the composer
  authorMemberId      String
  publishedAt         DateTime?           @db.Timestamptz(6)
  publishedByMemberId String?
  editNote            String?
  pdfDocumentId       String?                             // → Document(kind REPORT) rendering, generated post-publish
  createdAt           DateTime            @default(now()) @db.Timestamptz(6)
  updatedAt           DateTime            @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, projectId, seq])
  @@unique([tenantId, id])
  @@index([tenantId, projectId, status, publishedAt(sort: Desc)])
  @@index([tenantId, clientId, visibility, publishedAt(sort: Desc)])  // portal + timeline
}

/// ProjectUpdateInternalSnapshot — 1:1 with ProjectUpdate, CLASS A: the
/// per-member hours, cost, margin and budget-burn figures the composer
/// shows staff. Frozen at publish alongside portalSnapshot. Cost figures
/// present only when the publisher held rate:view_cost at publish time
/// (else NULL — never back-filled).
/// scope=tenant  rls=A (principalScoped)  ret=R2  enc=none (cost figures are aggregates; the card amounts stay encrypted at their source)
model ProjectUpdateInternalSnapshot {
  updateId   String   @id                                 // → ProjectUpdate (tenantId, id)
  tenantId   String
  byMember   Json?                                        // [{memberId, seconds, billableSeconds}]
  cost       Json?                                        // {toDate, inPeriod, margin} — NULL unless rate:view_cost
  budget     Json?                                        // {kind, amount, usedPct, projected}
  computedAt DateTime @default(now()) @db.Timestamptz(6)

  @@unique([tenantId, updateId])
}

/// ProjectUpdateSchedule [Phase 5] — cadence enforcement: nextDueAt,
/// ownerMemberId, autoDraft (pre-fill from changesSinceLast), reminders
/// at +1/+2 working days, "update missing" badge. One per project.
/// ProjectUpdateTemplate [Phase 5] — sections + metricsIncluded defaults
/// per tenant. Shapes:
///   ProjectUpdateSchedule(id, tenantId, projectId @unique, cadence
///     UpdateCadence, weekday Int?, hour Int, timezone, ownerMemberId,
///     autoDraft Boolean, nextDueAt, lastPublishedAt) — class A
///   ProjectUpdateTemplate(id, tenantId, name, sections Json,
///     metricsIncluded Json, isDefault) — class A
```

**Client Timeline (Phase 3) — derived, not stored.** `UNION ALL` over: PUBLISHED + CLIENT_VISIBLE `ProjectUpdate` (health chip, title, seq); `Milestone` completions and due dates (CLIENT_VISIBLE rows); `ProjectVersion` ships and approval decisions (SHIPPED rows); CLIENT_VISIBLE `Document(kind IN (DELIVERABLE, REPORT))` new versions and approval decisions. Read under the contact principal (every branch is a class-B table, so RLS applies per branch). **Never** `AuditEvent`, never `WorkItemActivity` beyond the portal-safe list, never comments. Materialise into a table only if measured slow (unlikely at agency scale: a few hundred rows per project).

### 6.17 Vault & assets — TenantKey, credentials, share links, asset registry, expirations *(added 2026-08-16 — decision 12 (vault is a product module; the continuity box stays pointer-only), decision 13 (MFA to reveal); plan §3.4; `TenantKey` lands Phase 1b, the rest Phase 3V; entitlement `vault`)*

The pattern (Hudu/IT Glue): credentials live **next to** the client/project/asset, typed, masked by default; reveal is an explicit audited act with step-up; expiring/view-once share links; an asset registry with a unified expirations feed. **Server-side envelope encryption, not E2EE** (P8): E2EE was tried by Infisical/IT Glue and dropped or became a support burden; it breaks search-by-name, share links, server-side TOTP, portal submission and export, and strands a 3-person agency that loses a passphrase. The operator can technically decrypt — stated in the DPA/ROPA (SECURITY.md §6). Mitigations are procedural and **tested before any UI ships**.

Pinned facts (plan §3.4): `TenantKey` per tenant; v2 ciphertext with AAD `tenantId:model:rowId:field`; `CredentialItem` (class B metadata) + `CredentialSecret` (class A ciphertext); `credential:reveal` seeded CMA ✦ (decision 13); share-link token `<tenantId>.<random>`, resolved via `withTenant(tenantId, {type:'system'})` — never `withPlatform` from a portal/tenant route — email-OTP or authenticated contact, `maxViews` 1, TTL ≤ 7 d.

```prisma
// ───────────────────────────────────────────────────────────────────
// 6.17 VAULT & ASSETS (TenantKey: Phase 1b; rest: Phase 3V) — module `vault`
// Folder: src/modules/vault/{items,reveal,share,assets,expirations,
// portal,actions}.ts; crypto in src/crypto/field-encryption.ts (core).
// ───────────────────────────────────────────────────────────────────

enum TenantKeyStatus {
  ACTIVE     // the key new ciphertext is written under (exactly one per tenant)
  ROTATING   // still decrypts; re-encryption job in flight
  RETIRED    // decrypt-only; never deleted while ciphertext references it
}

/// TenantKey — per-tenant data-encryption key (DEK), WRAPPED by the env
/// root keyring (`rootKeyId` names which root key wrapped it — the KMS
/// seam of SECURITY.md §6; no KMS at v1, stated deviation). The v2
/// ciphertext format `v2.<rootKeyId>.<tenantKeyId>.<iv>.<ct>.<tag>`
/// names this row; AAD `tenantId:model:rowId:field` binds every
/// ciphertext to its row. Created at tenant provisioning (Phase 1b),
/// back-filled for existing tenants before 3V. Rotation = new ACTIVE
/// row + old → ROTATING → RETIRED after the re-encrypt job; audited.
/// Cross-tenant by construction: a DEK from tenant A cannot decrypt
/// tenant B's rows even if the ciphertext were copied (AAD + key).
/// scope=tenant  rls=A (principalScoped; readable only by the crypto service path)  ret=never deleted while referenced (§5)  enc=wrappedDek is itself wrapped by the root key
/// audit: tenant_key.created | tenant_key.rotated
model TenantKey {
  id         String          @id @default(uuid(7))
  tenantId   String
  keyId      String                                     // short id embedded in the ciphertext (<tenantKeyId>)
  rootKeyId  String                                     // which env root key wrapped this DEK (<rootKeyId>)
  wrappedDek String                                     // AES-256-GCM-wrapped DEK, base64
  status     TenantKeyStatus @default(ACTIVE)
  createdAt  DateTime        @default(now()) @db.Timestamptz(6)
  retiredAt  DateTime?       @db.Timestamptz(6)

  @@unique([tenantId, keyId])
  @@index([tenantId, status])
}

enum CredentialType {
  LOGIN
  SECURE_NOTE
  API_KEY
  SSH_KEY
  DATABASE
  SERVER
  WIFI
  SOFTWARE_LICENSE
  OTHER
}

/// CredentialItem — METADATA ONLY (class B). Name, username, url, tags,
/// non-secret notes, which secret fields exist (keys only), whether a
/// TOTP seed exists, expiry/rotation, visibility. The secret is NOT here
/// (CredentialSecret, class A) — a contact principal can list a
/// CLIENT_VISIBLE item's metadata but can never SELECT its ciphertext.
/// The split IS the design; Prisma `omit` on the secret table is belt two.
/// Portal: persistent CLIENT_VISIBLE credentials are behind preference
/// vault.allowPortalCredentials (default OFF); a contact SUBMITTING a
/// credential (portal form, brokered write under the system principal,
/// forced clientId, visibility INTERNAL unless the tenant opted in) is v1
/// (vault.allowContactSubmission, default on). Never in comments/email.
/// Offboarding: removing a member flags items they revealed in the last
/// 90 d as needsRotation (credential.rotation_flagged).
/// Search: name/username/url/tags only feed search_index (§6.19) — never
/// notes containing anything secret-shaped, never the secret.
/// SQL: CHECK (visibility <> 'CLIENT_VISIBLE' OR client_id IS NOT NULL);
///   CHECK (project_id IS NULL OR client_id IS NOT NULL).
/// scope=client (clientId nullable ⇒ tenant-internal, e.g. the agency's own logins)  rls=B (clientScoped; a projectId is a filter, not a portal gate — credentials never inherit portal_enabled because they are never a project surface in the portal)  ret=R2 (soft-delete 30 d then purge incl. secret + versions)  enc=none here (see CredentialSecret)
/// audit: credential.created | credential.updated | credential.deleted | credential.visibility_changed | credential.rotation_flagged | credential.exported
model CredentialItem {
  id              String         @id @default(uuid(7))
  tenantId        String
  clientId        String?                                // NULL = tenant-internal
  projectId       String?                                // filter/anchor only
  assetId         String?                                // → ClientAsset (tenantId, id) — "the login for this hosting"
  type            CredentialType
  name            String
  username        String?                                // non-secret by contract; put it in the blob if it must be secret
  url             String?
  tags            String[]       @default([])
  notes           String?                                // NON-SECRET notes; secret-shaped strings are refused by a heuristic + shown a warning
  secretFieldKeys String[]       @default([])             // e.g. ["password"] | ["apiKey","apiSecret"] — keys only
  hasTotp         Boolean        @default(false)
  expiresAt       DateTime?      @db.Timestamptz(6)      // feeds the Expirations feed
  rotateEveryDays Int?
  lastRotatedAt   DateTime?      @db.Timestamptz(6)
  needsRotation   Boolean        @default(false)         // offboarding / compromise flag
  compromisedAt   DateTime?      @db.Timestamptz(6)
  visibility      Visibility     @default(INTERNAL)
  createdByMemberId String?
  updatedByMemberId String?
  submittedByContactId String?                           // attribution for portal submissions (brokered)
  archivedAt      DateTime?      @db.Timestamptz(6)
  deletedAt       DateTime?      @db.Timestamptz(6)
  createdAt       DateTime       @default(now()) @db.Timestamptz(6)
  updatedAt       DateTime       @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, id])
  @@index([tenantId, clientId, visibility])
  @@index([tenantId, projectId])
  @@index([tenantId, assetId])
  @@index([tenantId, expiresAt])
  @@index([tenantId, needsRotation])
}

/// CredentialSecret — 1:1 with CredentialItem, CLASS A. The ciphertext.
/// secretCiphertext = v2-encrypted JSON of the type-specific fields
/// (AAD `tenantId:credential_secret:<credentialId>:secret`);
/// totpSecretCiphertext = the TOTP seed (AAD `…:totp_secret`); codes are
/// generated server-side and the seed is never returned. Prisma `omit`
/// on both columns globally; only reveal.ts selects them.
/// Reveal path: POST /api/vault/[id]/reveal|copy|totp →
/// requireAccess(credential:reveal ✦) → requireRecentMfa(vault.
/// stepUpMinutes = 10) → reveal budget (Upstash; in-Postgres counter
/// fallback, FAIL-CLOSED; vault.revealBudgetPerHour = 30) → decrypt ONE
/// field → record('credential.revealed' | 'copied' | 'totp_generated')
/// in the same tx → return. Reveal and Copy are separate calls.
/// portal_deny: a contact principal gets 0 rows here even when the item
/// is CLIENT_VISIBLE; a portal reveal (only when allowPortalCredentials)
/// runs under the system principal in vault/portal.ts after
/// authorizePortal() re-checks the item's visibility + client, and audits.
/// scope=tenant  rls=A (principalScoped)  ret=deleted with the item  enc=secretCiphertext,totpSecretCiphertext
/// audit: credential.revealed | credential.copied | credential.totp_generated
model CredentialSecret {
  credentialId         String   @id                        // → CredentialItem (tenantId, id)
  tenantId             String
  secretCiphertext     String                              // v2 ENCRYPTED JSON {password | apiKey, apiSecret | privateKey, passphrase | …}
  totpSecretCiphertext String?                             // v2 ENCRYPTED TOTP seed
  version              Int      @default(1)                // bumps on every secret change; CredentialVersion keeps the old one
  updatedByMemberId    String?
  updatedAt            DateTime @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, credentialId])
}

/// CredentialVersion — last N (default 10) previous ciphertexts for
/// "what was the old password". Same crypto, keyed on the version row.
/// scope=tenant  rls=A (principalScoped)  ret=deleted with the item  enc=secretCiphertext
model CredentialVersion {
  id               String   @id @default(uuid(7))
  tenantId         String
  credentialId     String
  version          Int
  secretCiphertext String                                  // v2 ENCRYPTED, AAD `tenantId:credential_version:<id>:secret`
  changedByMemberId String?
  createdAt        DateTime @default(now()) @db.Timestamptz(6)

  @@unique([tenantId, credentialId, version])
}

/// CredentialAccessGrant — OPTIONAL overlay: when any grant exists for an
/// item, access is restricted to grantees (checked in the service, not
/// RLS — RLS stays tenant + client + visibility). Default: none ⇒
/// permission + client scoping decide.
/// scope=tenant  rls=A (principalScoped)  ret=R2  enc=none
model CredentialAccessGrant {
  tenantId     String
  credentialId String
  memberId     String
  grantedById  String?
  createdAt    DateTime @default(now()) @db.Timestamptz(6)

  @@id([tenantId, credentialId, memberId])
  @@index([tenantId, memberId])
}

/// CredentialShareLink — expiring, view-once share of ONE item.
/// Token = `<tenantId>.<random>`; ONLY the hash of the random part is
/// stored. Resolution: the route parses tenantId from the token, enters
/// `withTenant(tenantId, {type:'system'})` (NEVER withPlatform from a
/// portal/tenant route — ESLint import-boundary rule), looks up by hash,
/// then REQUIRES recipient = authenticated Contact of that client OR a
/// mandatory email OTP (requireEmailVerification default true), then
/// consumes the view ATOMICALLY: `UPDATE … SET view_count = view_count +
/// 1 WHERE id = $1 AND revoked_at IS NULL AND expires_at > now() AND
/// view_count < max_views RETURNING *` + record('credential.share_viewed')
/// in the same tx (concurrency test: exactly one success). maxViews
/// default 1; TTL ≤ vault.shareLinkMaxTtlHours (168 = 7 d, hard cap);
/// preference vault.allowExternalShareLinks can disable the feature.
/// Passcode-only links, TOTP-in-link, browser extension: NOT in v1.
/// scope=tenant  rls=A (principalScoped)  ret=12 mo after expiry (evidence, hash only)  enc=none (hash at rest)
/// audit: credential.shared | credential.share_revoked | credential.share_viewed
model CredentialShareLink {
  id                       String    @id @default(uuid(7))
  tenantId                 String
  credentialId             String                          // → CredentialItem (tenantId, id)
  tokenHash                String    @unique                // sha256 of the random part
  recipientEmail           String?                         // lowercase; OTP target
  recipientContactId       String?                         // when shared to an authenticated contact
  requireEmailVerification Boolean   @default(true)
  includeUsername          Boolean   @default(true)
  includeTotpCode          Boolean   @default(false)       // one current code at view time, never the seed
  fields                   String[]  @default([])          // subset of secretFieldKeys to reveal
  expiresAt                DateTime  @db.Timestamptz(6)    // <= created + 7 d (CHECK via trigger against the preference cap)
  maxViews                 Int       @default(1)
  viewCount                Int       @default(0)
  lastViewedAt             DateTime? @db.Timestamptz(6)
  revokedAt                DateTime? @db.Timestamptz(6)
  createdByMemberId        String
  createdAt                DateTime  @default(now()) @db.Timestamptz(6)

  @@index([tenantId, credentialId])
  @@index([expiresAt])                                     // sweep (SYSTEM)
}

enum AssetType {
  DOMAIN
  HOSTING
  DNS_ZONE
  SSL_CERT
  EMAIL
  CMS_APP
  THIRD_PARTY_SERVICE
  LICENSE
  CUSTOM
}

enum AssetStatus {
  ACTIVE
  EXPIRING     // derived hint set by the nightly job (expiresAt within 30 d)
  EXPIRED
  RETIRED
}

/// ClientAsset — the asset registry: domains, hosting, DNS zones, SSL,
/// mailboxes, CMS/apps, third-party services, licences. `fields Json` is
/// zod-validated per type (registrar, nameservers, plan, cert issuer,
/// seats…). Feeds the Expirations feed; the continuity box auto-fills
/// its "systems & assets" section from these NON-SECRET rows at seal
/// time (the box stays pointer-only). RDAP/TLS auto-checks (AssetCheck)
/// are LATER.
/// scope=client  rls=B (clientScoped; projectId is a filter)  ret=R2  enc=none
/// audit: asset.created | asset.updated | asset.deleted
model ClientAsset {
  id            String      @id @default(uuid(7))
  tenantId      String
  clientId      String
  projectId     String?
  type          AssetType
  name          String
  provider      String?                                    // "Loopia", "Cloudflare", "Hetzner"…
  url           String?
  identifier    String?                                    // domain name, account id, cert serial…
  status        AssetStatus @default(ACTIVE)
  expiresAt     DateTime?   @db.Timestamptz(6)
  autoRenew     Boolean?
  renewalCost   Decimal?    @db.Decimal(12, 2)
  currency      String?     @db.Char(3)
  fields        Json?                                      // per-type, zod-validated
  notes         String?
  tags          String[]    @default([])
  visibility    Visibility  @default(INTERNAL)
  lastCheckedAt DateTime?   @db.Timestamptz(6)             // AssetCheck (later)
  checkStatus   String?                                    // AssetCheck (later)
  createdByMemberId String?
  archivedAt    DateTime?   @db.Timestamptz(6)
  createdAt     DateTime    @default(now()) @db.Timestamptz(6)
  updatedAt     DateTime    @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, id])
  @@index([tenantId, clientId, visibility])
  @@index([tenantId, projectId])
  @@index([tenantId, type, expiresAt])
  @@index([tenantId, expiresAt])                           // expirations feed
}

/// ExpirationReminderSent — dedupe for the Expirations feed reminders
/// (60/30/14/7/1 d before). The feed itself is a computed UNION over
/// ClientAsset.expiresAt, CredentialItem.expiresAt, Service.renewsAt/
/// endsAt (later Contract.expiresAt) — no table. The unique IS the
/// dedupe (INSERT … ON CONFLICT DO NOTHING ⇒ already sent).
/// scope=tenant  rls=A (principalScoped)  ret=deleted with the subject  enc=none
/// audit: expiration.reminder_sent
model ExpirationReminderSent {
  tenantId    String
  subjectType String                                       // "ClientAsset" | "CredentialItem" | "Service" | "Contract"
  subjectId   String
  offsetDays  Int                                          // 60 | 30 | 14 | 7 | 1
  sentAt      DateTime @default(now()) @db.Timestamptz(6)

  @@id([tenantId, subjectType, subjectId, offsetDays])
}

/// AssetCheck [LATER — not 3V]: (tenantId, assetId, kind {RDAP, TLS,
/// DNS}, checkedAt, result Json, diffFromPrevious Json?) — nightly under
/// the system principal; processor rows for RDAP/TLS endpoints go into
/// SECURITY.md §9.2 when built.
```

**Reveal budget fallback.** Upstash EU is the primary limiter; when absent the in-Postgres counter (`tenant_id, member_id, hour_bucket`) is used and the endpoint **fails closed** if neither works — the vault is the one place the "no-op limiter" fallback of Phase 1b does not apply.

### 6.18 Notifications & email — Notification, Subscription, preferences, outbox, suppression *(added 2026-08-16 — plan §3.5; CORE infrastructure, never entitlement-gated (channels toggled by preference); lands Phase 2W with `notify.emit()`; digests/push/email-in Phase 5)*

Supersedes the v0.1 §11 row "Notification/inbox model — v2". One seam: **`notify.emit(tx, {kind, receivers, entity, actor, params})`** called inside the same `withTenant` transaction as the write; it inserts `Notification` rows (fan-out honouring visibility and subscription level) and, for INSTANT kinds, `EmailOutbox` rows. A **static kind catalog** (TS module) fixes per kind: `audience {MEMBER, CONTACT}`, `class`, template, coalescing key; **every CONTACT-audience kind is `clientVisibleOnly`** and its fan-out runs from a CLIENT_VISIBLE fact — CI-tested. In 2W the only INSTANT email kinds are *assignment* (debounced 2 min, cancelled if read) and *mention*. The worker drains the outbox under `withPlatform({type:'system', job:'outbox'})` with `FOR UPDATE SKIP LOCKED` (Vercel Cron `*/2` on Pro + `after()` kick + manual `POST /api/jobs/run` for dev) through the existing `mailer` (dev outbox until SES production). One `job.run` audit event per run.

```prisma
// ───────────────────────────────────────────────────────────────────
// 6.18 NOTIFICATIONS & EMAIL (Phase 2W; Phase 5 additions) — CORE
// Folder: src/notify/{emit,catalog,fanout,outbox,digest}.ts (flat, core)
// ───────────────────────────────────────────────────────────────────

enum ReceiverType {
  MEMBER
  CONTACT
}

enum NotificationClass {
  INSTANT      // in-app + email now (assignment, mention, approval requested…)
  COALESCED    // in-app now, email folded into the next digest / per-item coalesce
  DIGEST_ONLY  // in-app only, digest mention
}

/// Notification — one row per receiver per event. params Json carries
/// IDS ONLY (entity ids, actor id) — the UI/email renders from live rows
/// under the RECEIVER's principal, so a notification can never leak a
/// fact the receiver cannot read now (a later visibility flip hides it).
/// dedupeKey collapses repeats (unique per tenant while unread).
/// CONTACT rows: clientId REQUIRED; readable + updatable (readAt,
/// archivedAt ONLY — column-level GRANT + WITH CHECK) by the contact
/// under `receiver_type = 'CONTACT' AND receiver_id = app.principal_id AND
/// client_id = app.client_id` — this is the Notification entry in the
/// contact-writable census (§2.3). Member rows: portal_deny.
/// SQL: CHECK (receiver_type <> 'CONTACT' OR client_id IS NOT NULL);
///   partial index (tenant_id, receiver_type, receiver_id) WHERE read_at
///   IS NULL AND archived_at IS NULL — the unread badge; auto-archive at
///   500 per receiver / 90 d (§5).
/// scope=tenant (special principal-bound portal policy)  rls=B-special (see §2.3 table)  ret=R4 extended (§5)  enc=none
/// audit: notification.preference_changed (preferences only — deliveries themselves are not audit events)
model Notification {
  id           String            @id @default(uuid(7))
  tenantId     String
  receiverType ReceiverType
  receiverId   String                                     // Member.id | Contact.id (bound to app.principal_id for contacts)
  clientId     String?                                    // REQUIRED for CONTACT receivers (CHECK)
  projectId    String?
  kind         String                                     // catalog code, e.g. "work_item.assigned"
  class        NotificationClass @default(COALESCED)
  entityType   String                                     // "WorkItem" | "Comment" | "ProjectUpdate" | "Document" | …
  entityId     String
  actorType    ActorType?
  actorId      String?
  params       Json?                                      // ids only, zod-validated per kind
  dedupeKey    String?
  readAt       DateTime?         @db.Timestamptz(6)
  archivedAt   DateTime?         @db.Timestamptz(6)
  snoozedTill  DateTime?         @db.Timestamptz(6)
  emailedAt    DateTime?         @db.Timestamptz(6)       // set by the outbox worker
  createdAt    DateTime          @default(now()) @db.Timestamptz(6)

  @@index([tenantId, receiverType, receiverId, createdAt(sort: Desc)])
  @@index([tenantId, receiverType, receiverId, dedupeKey])
  @@index([tenantId, entityType, entityId])
}

/// Shared with WorkItemSubscriber (§6.14).
enum SubscriptionLevel {
  WATCH        // everything on the entity
  PARTICIPATE  // default when you touch it: assigned, commented, mentioned
  MUTED
}

/// Subscription — explicit per-entity subscription for entities other
/// than WorkItem (Project, ProjectUpdate, Document, Client…). Members
/// only in v1 (contacts are notified by capability + visibility rules,
/// not subscriptions).
/// scope=tenant  rls=A (principalScoped)  ret=R2  enc=none
model Subscription {
  tenantId   String
  memberId   String
  entityType String
  entityId   String
  level      SubscriptionLevel @default(PARTICIPATE)
  reason     String?                                      // "assigned" | "commented" | "manual"
  createdAt  DateTime @default(now()) @db.Timestamptz(6)

  @@id([tenantId, memberId, entityType, entityId])
  @@index([tenantId, entityType, entityId])
}

enum EmailLevel {
  ALL
  PARTICIPATING
  MENTIONS
  NONE
}

enum DigestCadence {
  NONE
  DAILY
  WEEKLY
}

/// NotificationPreference — per member (and, Phase 5, per contact for
/// the weekly client digest — a contact row is written by the system
/// principal on invite; contacts do not edit it in v1). Digest defaults:
/// member DAILY; client WEEKLY Monday 08:00 tenant TZ (skipped when
/// empty; RFC 8058 one-click unsubscribe). Quiet hours in `timezone`.
/// scope=tenant  rls=A (principalScoped)  ret=R2  enc=none
/// audit: notification.preference_changed
model NotificationPreference {
  id             String        @id @default(uuid(7))
  tenantId       String
  receiverType   ReceiverType  @default(MEMBER)
  receiverId     String
  emailLevel     EmailLevel    @default(PARTICIPATING)
  inAppLevel     EmailLevel    @default(ALL)
  digestCadence  DigestCadence @default(DAILY)
  digestHour     Int           @default(8)
  digestWeekday  Int?                                     // 1 = Monday (WEEKLY)
  quietHoursFrom Int?                                     // 0-23 local
  quietHoursTo   Int?
  timezone       String?
  perKind        Json?                                    // { "<kind>": {email: bool, inApp: bool} }
  unsubscribeTokenHash String?                            // RFC 8058 one-click (digests)
  updatedAt      DateTime      @updatedAt @db.Timestamptz(6)

  @@unique([tenantId, receiverType, receiverId])
}

enum EmailOutboxStatus {
  QUEUED
  SENDING     // lockedAt set; SKIP LOCKED worker owns it
  SENT
  FAILED      // retry with backoff (attempts < max)
  DEAD        // gave up; visible in the platform console
  SUPPRESSED  // recipient on EmailSuppression
  SKIPPED     // debounce cancelled it (e.g. assignment read within 2 min)
}

/// EmailOutbox — the Postgres outbox (ARC-21). idempotencyKey unique =
/// the whole exactly-once story (`<kind>:<notificationId>` or
/// `digest:<receiver>:<periodKey>`). params = template inputs (ids +
/// pre-rendered locale strings), nulled at 90 d; metadata kept 12 mo
/// (§5). Worker: `SELECT … WHERE status IN ('QUEUED','FAILED') AND
/// send_after <= now() ORDER BY send_after FOR UPDATE SKIP LOCKED LIMIT
/// 50` under withPlatform system; sends via mailer; SES messageId
/// stored; bounce/complaint SNS webhook (fra1) writes EmailSuppression.
/// scope=tenant  rls=A (principalScoped; worker runs cross-tenant under the platform system principal)  ret=R4 extended (§5)  enc=none
model EmailOutbox {
  id             String            @id @default(uuid(7))
  tenantId       String
  idempotencyKey String            @unique
  receiverType   ReceiverType
  receiverId     String
  toEmail        String                                   // lowercase snapshot at enqueue
  kind           String                                   // template key
  locale         String
  params         Json?                                    // nulled at 90 d
  notificationIds String[]         @default([])
  configSet      String?                                  // SES configuration set
  sendAfter      DateTime          @default(now()) @db.Timestamptz(6)  // debounce / digest scheduling
  status         EmailOutboxStatus @default(QUEUED)
  attempts       Int               @default(0)
  lastError      String?
  lockedAt       DateTime?         @db.Timestamptz(6)
  sentAt         DateTime?         @db.Timestamptz(6)
  sesMessageId   String?
  messageIdHeader String?                                 // for threading / reply-by-email (Phase 5)
  createdAt      DateTime          @default(now()) @db.Timestamptz(6)
  updatedAt      DateTime          @updatedAt @db.Timestamptz(6)

  @@index([status, sendAfter])                            // worker pick (cross-tenant, SYSTEM)
  @@index([tenantId, receiverType, receiverId, createdAt(sort: Desc)])
}

enum SuppressionReason {
  HARD_BOUNCE
  COMPLAINT
  UNSUBSCRIBED   // RFC 8058 / preference NONE
  MANUAL
}

/// EmailSuppression — GLOBAL (platform-owned): an address that bounced
/// or complained is never mailed again from any tenant (SES account
/// reputation is shared). Checked at enqueue and at send.
/// scope=platform  rls=P  ret=while suppressed  enc=none
model EmailSuppression {
  email     String            @id                          // lowercase
  reason    SuppressionReason
  source    String?                                        // "ses-sns" | "manual" | "unsubscribe"
  createdAt DateTime          @default(now()) @db.Timestamptz(6)
}

/// PushSubscription [Phase 5] — Web Push (VAPID), CONTENT-FREE payloads
/// ("you have new notifications" + deep link), opt-in per device.
/// keysCiphertext = v2-encrypted p256dh/auth (§4). Deleted on
/// unsubscribe or after 3 consecutive failures.
/// scope=tenant  rls=A (principalScoped)  ret=R4 (§5)  enc=keysCiphertext
model PushSubscription {
  id             String   @id @default(uuid(7))
  tenantId       String
  memberId       String
  endpoint       String   @unique
  keysCiphertext String                                    // v2 ENCRYPTED {p256dh, auth}
  userAgent      String?
  failCount      Int      @default(0)
  disabledReason String?
  createdAt      DateTime @default(now()) @db.Timestamptz(6)
  lastUsedAt     DateTime? @db.Timestamptz(6)

  @@index([tenantId, memberId])
}

/// InboundEmail [LATER — behind entitlement work.email_intake]: (id,
/// tenantId?, messageId @unique, fromEmail, toAddress (reply token /
/// intake address), subject, textBody, htmlBody?, rawFileObjectId?,
/// matchedEntityType/Id?, status {RECEIVED, MATCHED, CREATED, REJECTED,
/// SPAM}, receivedAt) — SES receiving in eu-central-1 (verify at build
/// time); raw MIME 30 d.
```

**Fan-out rules (tested):** an INTERNAL comment never notifies a contact; a CLIENT_VISIBLE change never emails another client's contacts; a digest built for a contact runs the same allow-listed projections under the contact principal and therefore cannot contain INTERNAL rows; suppression honoured at enqueue and send; assignment debounce cancels (`SKIPPED`) if read within 2 min.

### 6.19 Search — `search_index` *(added 2026-08-16 — plan §3.5; CORE; lands Phase 2W; hand-written DDL, thin Prisma read mapping)*

Postgres FTS in one narrow, trigger-fed table under the same tenant + `portal_gate` policies as everything else. **Per-row `lang regconfig`** derived from `Tenant.defaultLocale` (later per-project/document language) — configs `fortleva_sv` (unaccent + `swedish_stem`) and `fortleva_en` (unaccent + `english_stem`), never Swedish-only (PLAN.md's "no two-language assumption" rule; nothing Naxdor-specific in schema). **No GIN/trgm indexes at v1**: under FORCE RLS a non-leakproof operator (`@@`, `%`) never becomes an index qual, so a GIN would be dead weight; the planner slices on `(tenant_id, project_id | client_id, updated_at)` btrees and filters — fine at agency scale, measured before any change. Modelling rule enforced by review: **no member-only free-text column on any entity that can be CLIENT_VISIBLE** (internal notes are their own INTERNAL rows), so the feed never has to redact inside a row.

```sql
-- 2W migration (hand-written; Prisma sees a read-only model `SearchIndex` mapped to this table)
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE TEXT SEARCH CONFIGURATION fortleva_sv ( COPY = swedish );
ALTER TEXT SEARCH CONFIGURATION fortleva_sv
  ALTER MAPPING FOR hword, hword_part, word WITH unaccent, swedish_stem;
CREATE TEXT SEARCH CONFIGURATION fortleva_en ( COPY = english );
ALTER TEXT SEARCH CONFIGURATION fortleva_en
  ALTER MAPPING FOR hword, hword_part, word WITH unaccent, english_stem;
-- (1b Neon spike decides whether unaccent-in-config or an IMMUTABLE
--  f_unaccent() wrapper is used inside the generated column; either
--  keeps to_tsvector(regconfig, text) IMMUTABLE, which a STORED
--  generated column requires. Result written into this migration.)

CREATE TABLE search_index (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL,
  entity_type        text NOT NULL,          -- 'WORK_ITEM' | 'COMMENT' | 'PROJECT_UPDATE' | 'DOCUMENT' | 'PROJECT' | 'CLIENT' | 'CONTACT' | 'CREDENTIAL_ITEM' | 'CLIENT_ASSET'
  entity_id          uuid NOT NULL,
  client_id          uuid,                   -- NULL = tenant-internal
  project_id         uuid,
  visibility         visibility NOT NULL DEFAULT 'INTERNAL',
  portal_enabled     boolean NOT NULL DEFAULT false,   -- projectScoped fan-out (§2.3) when project_id IS NOT NULL
  title              text NOT NULL,
  subtitle           text,                   -- e.g. 'ACME-12 · Acme site'
  body_text          text,                   -- <= 100k chars (trigger truncates)
  meta_text          text,                   -- tags, username, url, provider… (never a secret)
  lang               regconfig NOT NULL,     -- 'fortleva_sv' | 'fortleva_en' | … per row
  search             tsvector GENERATED ALWAYS AS (
                       setweight(to_tsvector(lang, coalesce(title, '')), 'A') ||
                       setweight(to_tsvector(lang, coalesce(subtitle, '') || ' ' || coalesce(meta_text, '')), 'B') ||
                       setweight(to_tsvector(lang, coalesce(body_text, '')), 'C')
                     ) STORED,
  state_category     state_category,         -- WORK_ITEM rows: for result chips + filters
  assignee_member_id uuid,                   -- WORK_ITEM rows: staff filter; STRIPPED from portal projections
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT search_index_client_visible_needs_client
    CHECK (visibility <> 'CLIENT_VISIBLE' OR client_id IS NOT NULL),
  CONSTRAINT search_index_entity_unique UNIQUE (tenant_id, entity_type, entity_id)
);
CREATE INDEX search_index_tenant_updated   ON search_index (tenant_id, updated_at DESC);
CREATE INDEX search_index_project_updated  ON search_index (tenant_id, project_id, updated_at DESC);
CREATE INDEX search_index_client_vis       ON search_index (tenant_id, client_id, visibility, updated_at DESC);
-- NO GIN on `search` at v1 (non-leakproof under FORCE RLS). Revisit only with a measurement.

ALTER TABLE search_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_index FORCE ROW LEVEL SECURITY;
-- tenant_isolation + portal_gate exactly per TENANCY.md §7.2 (three-term form when project_id IS NOT NULL,
-- two-term form otherwise — expressed as
--   client_id = app.client_id AND visibility = 'CLIENT_VISIBLE' AND (project_id IS NULL OR portal_enabled)).
GRANT SELECT, INSERT, UPDATE, DELETE ON search_index TO app_runtime;   -- writes come only from triggers/services in the same tx
```

**Feed.** `AFTER INSERT OR UPDATE OR DELETE` triggers on `work_item`, `comment`, `project_update`, `document`, `project`, `client`, `contact`, `credential_item` (name/username/url/tags only), `client_asset` upsert/delete their row **in the same transaction** (visibility, client_id, project_id, portal_enabled copied from the source row — the index row can never be more visible than its source). `lang` = the tenant's config at write; a tenant locale change re-feeds lazily (touch on next write) plus `search.index_rebuilt` for a forced rebuild. Query = `search @@ websearch_to_tsquery(lang, $q)` ranked by `ts_rank_cd`, per-type capped `UNION`, then hydrated by id under the caller's principal (so a stale index row cannot leak a since-hidden fact — the hydrate under RLS is the second belt). ⌘K palette: recents → `KEY-123` jump → per-type results → actions.

**Tests.** Forbidden-columns grep on `search/portal.ts`; **lexeme probe** — an INTERNAL body word never matches under a contact principal; portal_gate + `portal_enabled=false` ⇒ 0 rows; posture test (projectScoped rows carry all three columns).

**Prisma mapping.** `model SearchIndex` with `@@map("search_index")`, `@@ignore`d for migrations (Prisma does not manage generated columns or `regconfig`); the app reads via `$queryRaw` in `src/search/` only. `/// scope=client (nullable)  rls=B (projectScoped when project_id set, else clientScoped)  ret=R2 (derived; rebuildable)  enc=none`.

---

## 7. Index strategy

Rules (in order of authority):

1. **Every tenant-scoped access path gets a composite index with `tenantId` leading** — the schema above never indexes a scoped column without `tenantId` in front (§5: composite indexes starting with `tenantId`). Single-column indexes on scoped tables exist only for cross-tenant SYSTEM sweeps (`resealDueAt`, `expiresAt`, `[state, vetoDeadlineAt]`) which legitimately run without tenant context under a privileged role.
2. **UUIDv7 PKs** keep inserts append-mostly in the PK b-tree; no per-tenant PK hotspots, no fragmentation tax from random v4.
3. **RLS policy columns are always indexed** — `tenantId` everywhere; `(tenantId, clientId, visibility)` on class-B tables the portal lists directly (`Document`); `(tenantId, clientId, …)` composites elsewhere cover the portal policy's `clientId` predicate as their second column. Policies use the InitPlan `(select current_setting(...))` form so the planner can use these indexes (per-row re-evaluation is the documented 1000× trap).
4. **Uniques double as indexes** — every `@@unique([tenantId, …])` is also the primary lookup path (e.g. `Invoice(tenantId, seriesId, number)`, ~~`Issue(tenantId, number)`~~ `WorkItem(tenantId, projectId, number)` *(amended 2026-08-16)*).
5. **Postgres does not auto-index FK columns** — junction second-columns get explicit composites (`RolePermission(tenantId, permissionId)`, `MemberClient(tenantId, clientId)`, `MemberRole(tenantId, roleId)`) because the authorization seam queries both directions.
6. **`AuditEvent`** gets exactly four indexes (activity feed, target history, actor history, request correlation) and no more — it is the highest-insert-rate table; every extra index is a write tax. No partitioning at this scale (§3).
7. **GIN** only where array/JSONB containment is actually queried (`Document.tags`). `entitlements`, `metadata`, `metrics` JSONB are read by row, never containment-searched — no GIN on them.

*(added 2026-08-16 — work-management plan)*

8. **No GIN/trgm on `search_index.search` at v1** (§6.19): under FORCE RLS a non-leakproof operator (`@@`, `%`, and for that matter array `@>`) cannot become an index qual, so the index would not be used for a tenant-scoped query anyway. The planner slices on the leading-`tenantId` btrees and filters. The existing `Document.tags` GIN stays but is subject to the same caveat — measure before relying on it. Revisit only with a measurement on real data.
9. **Hot paths of the new modules — every one is `tenantId`-leading and mirrors a real screen or policy predicate:**
   - Board column: `WorkItem(tenantId, projectId, stateId, rank)`; backlog + rollups: `(tenantId, projectId, stateCategory, rank)`; `/home`: `(tenantId, assigneeMemberId, stateCategory, targetDate)`; tree/rollups: `(tenantId, parentId)`, `(tenantId, rootId)`, `(tenantId, milestoneId)`; portal list + gate: `(tenantId, clientId, visibility, stateCategory)`; triage lane: `(tenantId, projectId, triageStatus)`.
   - Threads: `Comment(tenantId, subjectType, subjectId, createdAt)`; history: `WorkItemActivity(tenantId, workItemId, createdAt)`.
   - Time: `TimeEntry(tenantId, memberId, startedAt DESC)` (My Time), `(tenantId, projectId, startedAt)` (project tab + summary recompute), `(tenantId, workItemId)` (Σ on cards), `(tenantId, localDate, memberId)` (week grid), `(tenantId, costRateCardId)` / `(tenantId, billRateCardId)` (cost aggregation, reprice), the **partial one-running unique** `(tenantId, memberId) WHERE stopped_at IS NULL AND deleted_at IS NULL` (doubles as the `GET /timer/current` lookup), the partial uninvoiced index `(tenantId, projectId, memberId) WHERE invoice_line_id IS NULL AND billable AND deleted_at IS NULL`.
   - Rates: `RateCard(tenantId, kind, scope, projectId, memberId, effectiveFrom)` — the resolution lookup in one index.
   - Portal time: `ProjectTimeSummary(tenantId, projectId, periodMonth)` (unique) + `(tenantId, clientId, visibility)`.
   - Updates & timeline: `ProjectUpdate(tenantId, projectId, status, publishedAt DESC)`, `(tenantId, clientId, visibility, publishedAt DESC)`.
   - Vault: `CredentialItem(tenantId, clientId, visibility)`, `(tenantId, expiresAt)`, `(tenantId, needsRotation)`; `ClientAsset(tenantId, expiresAt)`, `(tenantId, type, expiresAt)`; `CredentialShareLink.tokenHash` (unique) + `(expiresAt)` sweep.
   - Notifications: partial unread `Notification(tenantId, receiverType, receiverId) WHERE read_at IS NULL AND archived_at IS NULL` (badge), `(tenantId, receiverType, receiverId, createdAt DESC)` (inbox), `(tenantId, receiverType, receiverId, dedupeKey)`; outbox pick `EmailOutbox(status, sendAfter)` — deliberately **not** tenant-leading: the worker is a cross-tenant SYSTEM sweep like `resealDueAt` (rule 1's carve-out).
   - Search: `search_index(tenantId, updatedAt DESC)`, `(tenantId, projectId, updatedAt DESC)`, `(tenantId, clientId, visibility, updatedAt DESC)` — and nothing on the tsvector.
10. **`portal_enabled` is never indexed alone** — it is the third term of a policy whose first two terms are already covered by `(tenantId, clientId, visibility)` composites; a boolean with two values buys nothing as a leading column.

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
| ~~`Issue`~~ | ~~`(tenantId, number)`~~ | ~~friendly per-tenant numbering~~ **superseded 2026-08-16 → `WorkItem(tenantId, projectId, number)`** |
| `ContinuityBox` | `(tenantId, clientId)` | **one box per client** (§8) |
| `TenantPreference` | `(tenantId, key)` | one value per key |
| `TenantCounter` | `(tenantId, key)` PK | one counter per key |
| `IntegrationConnection` | `(tenantId, provider)` | one connection per provider |
| Parents (`Client`, `Project`, `Member`, `Role`, `Service`, `Contract`, `Invoice`, ~~`Issue`~~, `ProjectVersion`, `Document`, `FileObject`, `InvoiceSeries`, `ContinuityBox`, and — added 2026-08-16 — `Milestone`, `WorkflowState`, `WorkItem`, `Comment`, `Label`, `TimeEntry`, `RateCard`, `ProjectBudget`, `StaffNotice`, `RoundingRule`, `ProjectUpdate`, `CredentialItem`, `ClientAsset`) | `(tenantId, id)` | composite-FK targets — the anti-cross-tenant-`connect` constraint (§2.3) |

*(rows below added 2026-08-16 — work-management plan; partial uniques are hand-written SQL, listed here because they ARE invariants)*

| Model | Unique | Meaning |
|---|---|---|
| `Project` | `(tenantId, key)` | the human prefix (`ACME`) is unique per tenant |
| `WorkItem` | `(tenantId, projectId, number)` | human key `ACME-12`; monotonic per project via `counters.next()` |
| `WorkItem` | `(tenantId, projectId, rank)` | **one position per item** — the single order behind backlog and board; collisions retried with jitter |
| `WorkflowState` | `(tenantId, projectId, name)`, `(tenantId, projectId, rank)` | no duplicate state names; one column position |
| `Milestone` | `(tenantId, projectId, rank)` | one position per milestone |
| `Label` | `(tenantId, projectId, name)` | no duplicate label names (tenant-wide when projectId NULL — app also checks) |
| `WorkflowPreset`, `ProjectTemplate`, `RoundingRule` | `(tenantId, name)` | named tenant assets |
| `WorkItemLabel`, `WorkItemCollaborator`, `WorkItemSubscriber`, `CredentialAccessGrant`, `Subscription` | composite PKs | membership is a set |
| `Mention` | `(tenantId, commentId, mentionedMemberId, mentionedContactId)` | one mention row per person per comment |
| `TimeEntry` | **partial** `(tenantId, memberId) WHERE stopped_at IS NULL AND deleted_at IS NULL` | **one running timer per member — enforced by the DB, not the app** (two concurrent starts ⇒ exactly one running row) |
| `TimeEntry` | `(tenantId, memberId, clientEventId)` | offline-queue idempotency (v1.5; NULLs distinct) |
| `RateCard` | no-overlap per `(tenantId, kind, scope, memberId, projectId)` on `daterange(effectiveFrom, effectiveTo)` | EXCLUDE (btree_gist, if the 1b spike verifies it on Neon) else app check under advisory lock — decided fallback |
| `ProjectBudget` | **partial** `(tenantId, projectId) WHERE status = 'ACTIVE'` | one active budget per project |
| `BudgetAlert` | `(tenantId, budgetId, periodKey, threshold)` | once per threshold per period — the unique is the dedupe |
| `ProjectTimeSummary` | `(tenantId, projectId, periodMonth)` | one summary row per project-month; recompute target |
| `StaffNotice` / `StaffNoticeAcknowledgment` | `(tenantId, version, locale)` / `(tenantId, memberId, noticeId, noticeVersion)` | one text per version+locale; one ack per member per version |
| `InvoiceLineTimeEntry` | `(tenantId, invoiceLineId, timeEntryId)` PK | immutable bridge history |
| `ProjectUpdate` | `(tenantId, projectId, seq)` | monotonic per project via `counters.next()` |
| `ProjectUpdateInternalSnapshot` | `(tenantId, updateId)` | 1:1 |
| `TenantKey` | `(tenantId, keyId)` | the `<tenantKeyId>` in every v2 ciphertext resolves to one row |
| `CredentialSecret` | `(tenantId, credentialId)` | 1:1 with the item |
| `CredentialVersion` | `(tenantId, credentialId, version)` | monotonic history |
| `CredentialShareLink` | `tokenHash` (global) | one link per token; the atomic view-once UPDATE keys on it |
| `ExpirationReminderSent` | `(tenantId, subjectType, subjectId, offsetDays)` PK | reminder dedupe |
| `NotificationPreference` | `(tenantId, receiverType, receiverId)` | one preference row per principal |
| `EmailOutbox` | `idempotencyKey` (global) | exactly-once email — the constraint is the guarantee (same pattern as `StripeWebhookEvent`) |
| `EmailSuppression` | `email` PK (global) | one suppression per address, across all tenants |
| `PushSubscription` | `endpoint` (global) | one row per browser subscription |
| `search_index` | `(tenantId, entityType, entityId)` | one index row per source row — the trigger upsert target |

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

**Non-legal counters — `counters.next()` *(added 2026-08-16 — Phase 1b helper; used by 2W for `WorkItem.number` and Phase 3 for `ProjectUpdate.seq`)*.** Everything that is *not* an invoice number goes through `TenantCounter` with ONE helper, so there is exactly one way to allocate a human-facing number:

```sql
-- counters.next(tx, key) — inside the creating withTenant() transaction; app.tenant_id already set
INSERT INTO tenant_counter (tenant_id, key, value)
     VALUES ($tenantId, $key, 1)                       -- e.g. key = 'work_item:<projectId>'
ON CONFLICT (tenant_id, key)
  DO UPDATE SET value = tenant_counter.value + 1
RETURNING value;                                      -- ⇒ WorkItem.number / ProjectUpdate.seq
```

Properties: **upsert-safe** (first allocation creates the counter row — no seed step per project), **serialised per key** (the row lock orders concurrent creators; 100 concurrent creates ⇒ 1…100 with no duplicates — property test in 2W), **gaps allowed** (a rolled-back create burns a number; nothing legal rides on these numbers — §6.2 `TenantCounter`), **key-namespaced per project** so numbering is per project (`ACME-12`, `BETA-12` coexist; CP1 may revisit). Backed by `@@unique([tenantId, projectId, number])`.

## 10. Polymorphic attachment: the chosen pattern

**Chosen: hard columns for authorization + soft pointer for anchoring.** `Document` carries real, composite-FK-constrained `tenantId`/`clientId` (+ indexed `projectId`) — everything authorization and RLS ever read — plus an unconstrained `(attachedToType, attachedToId)` pair that only says *where the file is displayed*. App code validates the anchor at write time (target exists, belongs to same tenant and, where applicable, same client); a periodic sweep flags dangling anchors (cosmetic, not a security event).

Rejected alternatives:

- **Exclusive arc** (one nullable FK per attachable entity + CHECK that exactly one is set): referentially perfect, but eight nullable FK columns today and a migration + CHECK rewrite every time an entity becomes attachable. The churn cost lands on the highest-traffic table in the product.
- **Typed join tables** (`DocumentOnIssue`, `DocumentOnProject`, …): same churn, plus N tables and N query branches for one listing surface.
- **Pure polymorphism** (`entityType`/`entityId` used for authorization): the classic mistake — scoping decisions would traverse an unconstrained pointer. Explicitly not what this design does.

The decisive argument: **the security-relevant dimensions of a file are tenant, client, and visibility — never "what it is pinned to."** A document attached to a ~~Issue~~ WorkItem *(amended 2026-08-16)* is client-visible because its own row says `(clientId=X, visibility=CLIENT_VISIBLE)`, not because the issue is. That keeps the §5 invariant enforceable at the data layer with real constraints, while the anchor stays flexible enough that "attachable to any entity" (§6) never needs another migration.

**Restated 2026-08-16 (work-management plan §3.2 "Inheritance") — the rule stands and is now enforced in the DB, not only in the app.** Attachments, comments and child work items carry their **own** `visibility` column, **defaulted from the parent at creation** (an attachment on a CLIENT_VISIBLE task starts CLIENT_VISIBLE; on an INTERNAL task, INTERNAL — the composer shows the two-token badge either way). Two guards, both triggers with tests: **child ≤ parent** — a `WorkItem(parent)`, `Comment(subject)` or `Document` anchored to `WORK_ITEM | COMMENT | PROJECT_UPDATE` cannot be CLIENT_VISIBLE unless its parent is (§6.14 `work_item_parent_guard`, `comment_subject_guard`, and the Document anchor check on write); and **downgrade refusal** — flipping a parent to INTERNAL is *refused* while any child (item, comment, attached document) is CLIENT_VISIBLE (`work_item_visibility_downgrade_guard` and its siblings on `project_update`/`document`); the UI offers a bulk "make private with N children" action that flips children first, deepest first, in one transaction, audited (`work_item.bulk_edited` + one `*.visibility_changed` per privileged flip). `Project.portalEnabled` sits above all of this as the project-level gate (§2.3): turning it off hides everything without touching per-item decisions; turning it back on restores exactly what was shared. `AttachableType` gained `WORK_ITEM, COMMENT, PROJECT_UPDATE, CREDENTIAL, ASSET` (§6.8); a `CREDENTIAL` anchor never carries a secret — the secret lives only in `CredentialSecret`.

## 11. Deliberate omissions — and why

| Omission | Verdict | Why |
|---|---|---|
| **Stripe Connect** | absent by design | Platform bills tenants directly; `Tenant.stripeCustomerId` is the only Stripe artifact. Pay-now (v1) settles on the **tenant's own rails**: `Invoice.paymentLinkUrl` (tenant-provided link) or, at v1.5, the tenant's own Stripe key via `IntegrationConnection(STRIPE_TENANT)` — money never flows through the platform, so no Connect onboarding, no payout liability. If tenants ever charge clients *through us*, Connect is a v2+ integration surface; nothing here needs re-modeling ([account types can't be converted](https://docs.stripe.com/connect/accounts) — good reason not to guess now). |
| **Forms / intake builder** | v2 | Decision #7: the ~~Issue queue~~ portal REQUEST intake (`WorkItem.kind = REQUEST`, §6.14 — *amended 2026-08-16*) *is* v1 intake. A form is a nicer skin on ~~`Issue.type=REQUIREMENT`~~ a REQUEST item. |
| **Proposals / quotes** | v2 | `Service` + `Contract` cover the v1 job; quote-accept composes with the SES flow later. |
| **Recurring billing engine** | v2 | `Service.renewsAt` powers reminders; auto-generating invoices adds proration/dunning surface with no v1 payer. |
| **Messaging / chat** | v2 | ~~`IssueComment`~~ the polymorphic `Comment` (§6.14, *amended 2026-08-16*) is the seam; full chat is a quarter of work (competitor research). |
| ~~**Time tracking**~~ / scheduling / email marketing | ~~skip~~ **Time tracking: SUPERSEDED 2026-08-16 by decision 11 → §6.15 (Phase 2T)**; scheduling / email marketing: still skip | ~~Freelancer-lane table stakes, not this ICP; integrate, don't build (research 10.8).~~ Reversed by the founder for time tracking (per-task timer → rate snapshot → budget → rollups → invoice line, with a hard never-list — see the last row of the added table below and P9). Scheduling and email marketing remain out of scope. |
| **Peppol / e-invoice transmission** | v2/v3 | EN 16931 alignment is in the model now; transmission is an adapter. Never Svefaktura (withdrawn 2021). |
| **Fortnox/Bokio push** | v2 | `IntegrationConnection(FORTNOX)` placeholder; marketplace review + end-customer license make it a project, not a field. |
| **GSC/GA4 sync** | v2 | `PerformanceReportKind` reserves the kinds; v1 ships uploads + CrUX (API-key only). |
| ~~**Notification/inbox model**~~ | ~~v2~~ **superseded 2026-08-16 → §6.18 (Phase 2W); see the row at the end of this table** | ~~v1 notifies via transactional email; deliveries that matter are audit events. A `Notification` table earns its place with in-app inbox (Phase 5).~~ |
| **Custom domains / subdomain routing tables** | v2 | Decision #8: single app domain v1. `Tenant.slug` is reserved; hostname→tenantId resolution is a stubbed seam, a `TenantDomain` table arrives with the feature. |
| **Per-tenant DEK** ~~/ KMS envelope~~ | ~~v2~~ **per-tenant DEK: SUPERSEDED 2026-08-16 by decision 12 → `TenantKey` + v2 format in Phase 1b (§4, §6.17)**; KMS root custody: still later | ~~The `v1.<keyId>.` ciphertext prefix is the seam; env-var key is proportionate at v1 (SECURITY.md).~~ The v2 `rootKeyId` segment is now the KMS seam; the DEK is wrapped by the env root keyring until then (SECURITY.md §6.1). |
| **API tokens / public API / webhooks** | v2 | `api_token.*` audit actions reserved in the catalog; no table until the surface exists. |
| **SIE export / verifikationer / bookkeeping** | skip | The line drawn by decision #3: we are a försystem issuing invoices; the tenant's accounting tool is the bookkeeping source of truth. Building toward SIE drags in systemdokumentation and audit expectations (§10.2 research). |
| ~~**Kanban/Gantt tables**~~ | ~~v2 (views)~~ **Kanban: SUPERSEDED 2026-08-16 → §6.14 (Phase 2W)**; Gantt: still no tables | ~~Board = view over `Issue`; timeline = `Milestone` + `ProjectVersion`. No new storage.~~ The board is now a view over `WorkItem` grouped by `WorkflowState` with one `rank` per item — that IS new storage (`WorkflowState`, `WorkItem.rank`), deliberately. Gantt with dependency auto-scheduling stays out (later module, if ever); the portal timeline stays `Milestone` + `ProjectVersion` + `ProjectUpdate` (§6.16 derived UNION). |
| **Tenant-customizable portal roles** | v2 if demanded | See Pushback P1. |
| **AI features** | none | Room left via JSONB metadata; no schema commitment (market trend noted, not chased). |
| **Notification/inbox model** *(row above, superseded 2026-08-16)* | → §6.18, Phase 2W | The `Notification` table earns its place with the assignment/mention seam that 2W needs; the v0.1 "v1 notifies via transactional email" line is replaced by the outbox. |

*(rows below added 2026-08-16 — work-management plan §6 "what NOT to build"; each is a decision, not an oversight)*

| Omission | Verdict | Why |
|---|---|---|
| **`ProjectTimeSummary` as a SQL view** | rejected | Under FORCE RLS a view over class-A `time_entry` returns **0 rows to a contact** (the view's underlying tables are policy-checked as the caller); a `SECURITY DEFINER` view or system-principal read in a portal path would violate "portal reads never under a system principal". Hence a physical class-B table recomputed in the entry transaction (§6.15). |
| **`SavedView` / `Favorite`** | v1.5 | One universal `<WorkItemView>` with URL state (`nuqs`) covers Home/backlog/board/portal list; a table arrives when someone asks to name a view. |
| **`Reaction`** | v1.5 | Comments + mentions first; emoji rows are cheap to add later, and are a leak vector to test in the portal. |
| **`WorkItemLink` {RELATED, BLOCKS, DUPLICATE_OF}** | v1.5 | `duplicateOfId` on the item covers triage; a general link table (acyclic BLOCKS) waits for a real dependency need. Internal-only when it lands. |
| **WIP limits enforcement / definition of done** | v1.5 | Columns reserved on `WorkflowState`; soft warnings only in v1. |
| **Sprints (`Sprint`, taskboard, capacity, burndown, `SprintSnapshot`)** | later module (entitlement-gated) | The ICP runs client projects, not sprints; ADO's sprints-by-default is exactly the surface reviewers call overkill. `WorkItem.sprintId` is NOT reserved — a nullable column later is additive. |
| **`WorkItemPlacement` (independent sprint/board order)** | not in v1 | One `rank` per item keeps backlog and board consistent (ADO "maintain backlog order"); a placement table appears only if independent sprint order is ever required. |
| **`ChecklistItem` table** | never | Checklists are Tiptap taskList nodes in the description with denormalised counters + "convert to subtask" (Planner's checklist-as-subtask abuse avoided by making the conversion one action). |
| **`RollupCache`** | not before a tenant needs it | Flat `GROUP BY root_id / milestone_id` on denormalised columns is a plain index scan at depth ≤ 2. |
| **E2EE / passphrase vault** | rejected (P8) | Breaks search-by-name, share links, server TOTP, portal submission, export; strands small agencies on a lost passphrase; Infisical dropped it, IT Glue's is a support burden. Server-side envelope + AAD + audit + step-up + budget instead; operator-can-decrypt stated in the DPA. |
| **Passcode-only share links, TOTP-in-link, browser extension, emergency-access state machine, uptime monitoring** | not in v1 | Share links require an authenticated contact or email OTP; the continuity box is the emergency path. |
| **Task-scoped rate cards** | skip | Four tiers (PROJECT_MEMBER > PROJECT > MEMBER > TENANT) cover agency pricing; a per-task rate is a spreadsheet, not a product. |
| **Multi-assignee** | skip | Single assignee xor contact + `WorkItemCollaborator`. Accountability is one name; every tool that added multi-assignee regretted the rollup semantics. |
| **4+ hierarchy levels / "Feature" level / custom typed properties (v1) / process templates, area & iteration paths, WIQL, delivery plans, dashboard builders, per-team board settings, silent 183-day archive** | never (ADO's configuration surface) | We copy ADO's data model, not its configuration surface. `CHECK depth <= 2` is the fence. |
| **Timesheet submit/approve workflow, utilisation reports** | later, if a tenant asks | `TimeLockReason.APPROVED` is reserved; no approval tables. |
| **FX inside time reports** | skip | One `Project.billingCurrency`; FX snapshot exists only on invoices (Phase 4). |
| **Offline timer queue, SSE realtime, WebSockets/sync engine** | v1.5 / never | `clientEventId` columns reserved; freshness = poll + focus refresh (ARC-18). *(2026-08-20, decision 15)* The PWA shell (ARC-25) is installable, not offline — it caches no tenant-scoped response; the offline queue stays v1.5 behind its own security pass. |
| **External search engines, pgvector, GIN under FORCE RLS** | never / measure first | §6.19. |
| **Public/no-login project links, magic links, client push** | never in v1 | Portal is invite-only; credential share links are the one hardened exception. |
| **The never-list (decision 11): idle detection, screenshots, app/URL/keystroke capture, presence/"who is working now" broadcast, per-minute activity heatmaps, leaderboards, geolocation, peer-visible timelines** | **NEVER** | Any of these turns tidsredovisning into övervakning (DPIA-mandatory, MBL 11 §, US notice statutes) and breaks the product's promise to staff. Enforced by absence of columns (§6.15) and by PLAN.md's skip-list; a PR adding such a column fails review by rule, not by taste. |

*(rows below added 2026-08-20 — founder time-tracking session; each is a decision, not an oversight)*

| Omission | Verdict | Why |
|---|---|---|
| **A parallel `Agreement` entity** | rejected | The founder's "contracts/agreements" ARE `Service` rows (§6.6 amendment): one place per concept — a second commercial object would duplicate kind/renewal semantics and double the Phase-3 portal projection surface. UI label "Agreement"/"Avtal" is i18n only; Phase 4's signed `Contract` stays the legal document. |
| **Agreements as separate projects** | rejected | Conflates the delivery workspace (board, tasks) with the commercial engagement — exactly the documented workaround cost in tools without an engagement layer (Harvest/Toggl clone projects per rate). |
| **Nullable `Project.clientId` for internal projects** | rejected | `client_id` is load-bearing in every RLS gate and scope axis. Internal product work uses the self-client convention (a `Client` row for the tenant itself, portal never enabled) — standard agency practice, zero schema surgery. |
| **Rate-bearing `WorkType`** | rejected | A rate-carrying type list is a substitute for a missing engagement layer and degenerates (Harvest's documented "Jane Programming" workaround). Types carry `defaultBillable` only; differentiated pricing per kind of work = a second agreement (D4). |
| **Auto-inserted statutory breaks** | **NEVER** | Auto-deduction fabricates records (Personio's API cannot distinguish auto from employee-entered breaks; US auto-deduct suits; German BAG guidance requires deductions match reality). Warn flags on self-reported data deliver the compliance value without fabrication. |
| **Live "who is on shift" / presence widget** | **NEVER** (never-list) | Every attendance competitor ships one; this product's IMY-aligned posture is closed rows + aggregates only. The absence is a worker-friendly selling point, not a gap. |
| **Cumulative overtime account (Stundenkonto)** | later | Expected eventually (Clockodo/Personio/Kimai all carry one) but gated on absences, holiday calendars and a dated `MemberWorkSchedule`; v1 ships per-day + period delta vs `Member.hoursPerDay` (display expectation only). |
| **Blocking overlapping entries by default** | rejected 2026-08-20 (amends the 2026-08-16 default) | Toggl and Clockify allow overlaps and refuse to block — manual/duration edits make them inevitable; blocking is the documented failure mode. Default = allow + computed warn badge; strict blocking stays the tenant opt-in (`time.allowOverlap` off). |
| **Live public time-report links** | never | Toggl/Clockify-style anonymous URLs both leak (unauthenticated) and silently change after edits. Client visibility goes through the portal principal; the statement of record is the immutable `TimeReport` (§6.15 D3). |

## 12. Pushback & flagged tensions (§12: disagree in the doc)

**P1 — Portal contact "roles" are a hardcoded enum, not the Role machinery.** Brief §3 lists "portal-side Contact roles" among the cloneable templates. I spec'd `ContactPortalProfile { CONTACT_PRIMARY, CONTACT_COLLABORATOR }` (the fixed profiles of `AUTHZ.md` §8, `CONTACT_FINANCE` reserved v2) instead: contacts are a different principal with a hardcoded capability set (§3's own "physically separate paths" requirement, decision #6, research architecture rule). Putting contacts into tenant-customizable RBAC would reopen the exact ambiguity the separation exists to kill, for a customization no competitor's customers demonstrably use. If a tenant ever needs per-contact granularity beyond two levels, that is a v2 enum extension (`CONTACT_FINANCE`) or a portal-capability matrix — still never the member Role tables.

**P2 — `Contact.email` is globally unique in v1.** A consequence of decision #8 (single app domain): portal login is email-keyed with no Host to disambiguate, and the Better Auth portal instance expects a unique login identifier. Cost: the same person cannot be a portal contact of two different tenants with one email in v1 (rare at tens of tenants; workaround: plus-addressing). This is deliberately the cheap direction of travel — *relaxing* to the permanent `(tenantId, email)` unique when subdomain login lands is a constraint drop; the reverse would be a data migration. Flagged for `OPEN_QUESTIONS.md` (can wait).

**P3 — `Tenant.databaseUrl` weakens the "DB dump reveals nothing" posture for itself.** The plan requires the column from day 1 (physical-isolation escape hatch). Storing a live connection string — even AES-GCM-encrypted with an env-held key — means a DB dump *plus* the app environment yields tenant-DB credentials. Recommendation: keep the column but store a **cell name** resolved via environment/secret store at runtime (`databaseUrl` stays null forever); the column exists because migrating it in later is harder than ignoring it now. Spec'd as decided; noted here.

**P4 — "Sequential per tenant" (brief §6) is really "unbroken per series per fiscal year".** Swedish law wants a löpnummer within one or more series, unbroken through the fiscal year (Skatteverket 2023 guidance); a tenant may legitimately run several series. `InvoiceSeries` models the law; a tenant with one series gets exactly the brief's behavior. Not a disagreement — a refinement the brief's §10.2 research clause anticipated.

**P5 — "MFA available everywhere" (§9) is staged.** Member/platform MFA (TOTP + passkeys, mandatory for owner-equivalent and platform roles) is v1. **Contact MFA is v2**: the portal is invite-only, rate-limited, and read-mostly in v1, and the second Better Auth instance makes adding `ContactTwoFactor` additive. The brief's word "everywhere" is not fully honored in v1 — deliberate, visible here, revisit if a tenant's client demands it (likely alongside BankID, which is itself a stronger factor).

**P6 — `Client.internalNotes` (and `Project.repoUrl`/`hostingNotes`) rely on projection, not RLS.** RLS is row-level; these are internal-only *columns* on portal-visible rows. The portal read model uses explicit `select` allowlists (never `SELECT *`/default Prisma selects on class-B models in portal code — lintable), with optional column-level `REVOKE` under a dedicated portal DB role as a second belt (TENANCY.md). Field-in-row was chosen over a separate always-INTERNAL `ClientNote` table to keep §6's "internal private notes" a one-field feature; if notes grow authorship/history, promote to a Document with `visibility=INTERNAL`.

**P7 — "Open exactly once" is spec'd as open-once-then-window.** Decision #2 settled this against a literal burn-on-read (which demonstrably strands clients on failed transfers — Google and Apple both do open-then-window). The schema encodes it: the `SEALED→OPENED` transition is the exactly-once event (conditional update, audited); `downloadWindowEndsAt` bounds re-downloads of the same blob at 7 days (the R2 presign maximum). Marketing language follows the decision: "opened exactly once, downloadable for 7 days, fully logged."

*(P8–P10 added 2026-08-16 — work-management plan §10)*

**P8 — The vault is a liability the founder is choosing, and the operator can decrypt.** Copilot/Moxie/SuiteDash ship no vault; Hudu/IT Glue do and it is their support burden. Server-side envelope encryption (`TenantKey` per tenant, v2 ciphertext with AAD, §4/§6.17) means that **a platform operator with the root keyring and database access can technically decrypt every tenant's credentials** — this is stated plainly in the DPA/ROPA (SECURITY.md §6), not hidden behind "encrypted at rest". E2EE would remove that risk but breaks search, share links, server TOTP, portal submission and export, and strands a 3-person agency on a lost passphrase (Infisical dropped it; IT Glue's Vault is a support burden). The mitigations are therefore procedural and *tested before any UI ships*: class-A ciphertext table, `omit`, step-up MFA (`credential:reveal` seeded CMA ✦ — decision 13), reveal budget fail-closed, one field per reveal, audit in the same tx, AAD binding (row/tenant swap fails), share links view-once + OTP, offboarding rotation flags, DB-dump-contains-no-plaintext test. The continuity box stays pointer-only precisely so the box never becomes a second vault. Spec'd as decided; the liability is named here.

**P9 — Time tracking is a legal object in Sweden; the schema takes a side.** Decision 11 reverses v0.1's skip. A self-started/stopped timer with manager-visible totals is ordinary *tidsredovisning* (permitted, contract-necessary; consent is not a valid basis in employment). Anything captured without the employee's act is *övervakning*: DPIA-mandatory, an MBL 11 § "viktigare förändring" for kollektivavtal-bound employers, and notice-statute territory in NY/CT/DE. The data model therefore (a) has **no columns** for idle/activity/URL/screenshot/location/device — the never-list is enforced by absence, and a PR adding such a column fails review by rule; (b) keeps cost rates encrypted on the card and never on the entry row (salary-grade data); (c) gates the first timer on `StaffNoticeAcknowledgment` with purposes = billing/planning/profitability, explicitly not performance evaluation; (d) splits retention: invoiced entries R1 (BFL 7 y, member pseudonymised), un-invoiced HR class (tenant-configurable, 2 y SE / 3 y US), audit IP/UA pseudonymised at 90 d; (e) shows every member their own hours only, managers hours + bill rates, CEO/finance cost + margin. Naxdor itself needs the staff notice — and an MBL 13 § check if any union member — before its own staff use timers (OPEN_QUESTIONS.md lawyer list). Not a disagreement with the founder; a boundary drawn so the feature survives contact with a lawyer.

**P10 — `WorkflowState` is class A, so the portal reads `stateCategory` only; assignee names are not in the portal in v1.** Tenant-named states ("Väntar på kund", "QA — Anna") are internal vocabulary and a leak vector; the portal shows fixed i18n category labels (Planned / In progress / Done) from the denormalised `WorkItem.stateCategory` (kept in sync by service + trigger). Cost of the denormalisation: one more column to keep honest (tested). Likewise, `assigneeMemberId` never reaches a portal projection and no `assigneeDisplayName` is denormalised for contacts in v1 — the plan considered a service-written display name and chose to drop names from the portal instead (fewer moving parts, no stale-name bug). If a tenant wants "who is on this" in the portal, that is a CP3 revisit with an explicit denormalised, service-maintained column — never a join to `Member`. Labels and links are internal-only in v1 for the same reason. Search inherits both rules (§6.19).

---

*End of DATA_MODEL.md. Schema version **0.3 (2026-08-20)** — v0.2 plus the founder time-tracking extensions (§6.15 D1–D6: `Shift`/`ShiftBreak`, ad-hoc entries, `TimeReport`, Service-as-agreement `SERVICE` rate tier, `WorkType`, researched refinements incl. the overlap-default amendment; §6.6 Service agreement amendment; `Project.defaultServiceId`; `ProjectTimeSummary.portalEnabled` doc fix). v0.2 (2026-08-16) was v0.1 (2026-08-03) plus the work-management amendments (§6.14–§6.19, §2.3 `portal_enabled` refinement, crypto v2, decisions 11–13). Every change to entity names or key structure after Phase 1 begins requires updating this file first; the other docs reference these names.*
