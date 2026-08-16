# Fortleva → Work-Management Platform: Sequenced Build Plan (sequencing / risk / autonomy perspective)

*Read against commit 78b58b5 (2026-08-16): `docs/PLAN.md`, `DATA_MODEL.md` §6.5/§6.9/§11, `AUTHZ.md` §3, `TENANCY.md` §7–11, `prisma/schema.prisma`, `src/authz/catalog.ts` (63 codes), `src/audit/catalog.ts`, `src/entitlements/resolver.ts`, `src/db/with-tenant.ts`, `src/members/*`, `src/app/(tenant)/(authed)/*`.*

---

## 0. Thesis in three sentences

The fastest route to "Naxdor uses this every day" is **Client/Project → WorkItem board+backlog → timer**, not the current Phase 2 → 3 → 4 order, because the founder's daily need is tasks and time, and a portal without work behind it is empty. Every phase below is cut so Claude Code can build it end-to-end from a spec, with the founder's job reduced to (a) a handful of provisioning steps that only a human with credentials can do and (b) dated brainstorm checkpoints where one-way doors get closed. The one-way doors are pulled forward deliberately: rank collation, work-item numbering, hierarchy depth, visibility inheritance, the polymorphic Comment, the TimeEntry constraints, rate snapshotting, and the AAD-bound ciphertext format all land in the *first* migration of the phase that introduces the table — even when their UI comes later.

---

## 1. Dependency graph and the Naxdor-first ordering

```
P1.5 Foundation leftovers (i18n, UI kit, R2, request-context, MFA hook)
   └─▶ P2 Core domain (Client, Contact record, Project, Milestone, MemberClient/Project, Document UI, export v0)
          ├─▶ W1 Work items, board, backlog, My Work, comments, activity   ← Naxdor starts daily use
          │      ├─▶ W2 Timer, time entries, rates, budgets, rollups        ← Naxdor fully on product
          │      │      ├─▶ P4 Money (+ time→invoice bridge, retainer)      (existing phase, extended)
          │      │      └─▶ P6 Reports (+ project health, timesheet PDF)   (existing phase, extended)
          │      └─▶ P3 Portal + sharing + ProjectUpdates (Contact identity)
          │             ├─▶ V  Vault + asset registry + expirations         (needs MFA step-up from P1.5)
          │             └─▶ P5 Collaboration: notifications/outbox, intake triage, digests
          └─────────────────────────────────────────────────────────────▶ P7 Productization → P8 Continuity box
```

**Critical path to daily use:** P1.5 (2 wk) → P2 (3–4 wk) → W1 (4–5 wk) ≈ **weeks 9–11**; add W2 (3–4 wk) ≈ **weeks 12–15** for the full tasks+timer+cost loop. P3/V/P4/P5/P6 follow; P7/P8 keep their existing plans. Total for the new work (P1.5 → P6): ~28–36 weeks solo with Claude Code, on top of P7/P8's ~14 weeks.

**Independent shippability:** each box above is deployable and leaves nothing half-built in the UI; W2 without P3 simply means "no client sees hours yet"; P3 without V means the portal has no credentials surface.

---

## 2. One-way doors — decide now, land in the first migration that needs them

| Door | Decision (recommended default) | Lands in |
|---|---|---|
| Ordering key | `rank text COLLATE "C"` (fractional-indexing v4), one rank per item per project, server-computed with neighbour `FOR UPDATE`; unique `(tenantId, projectId, rank)` | W1 |
| Human key | `Project.key` (≤8 chars, unique per tenant) + `WorkItem.number` from **TenantCounter** with key `workitem:<projectId>`; unique `(tenantId, projectId, number)` | P2 adds `Project.key`; W1 uses it |
| Hierarchy | single `parentId`, `type` EPIC/TASK/SUBTASK, depth ≤ 3 enforced by app + trigger; no Feature level | W1 |
| Kind / triage | `kind` TASK/BUG/REQUEST and `StateCategory.TRIAGE` in the enums from day one, even though portal submission arrives in P3 — this is what absorbs `Issue` | W1 |
| Assignment | single `assigneeMemberId` xor `assigneeContactId`; collaborators via join | W1 |
| Visibility | existing `Visibility` enum; DB CHECK child ≤ parent for WorkItem and Comment; contact-authored rows forced CLIENT_VISIBLE; `Project.portalEnabled` denormalised into the RESTRICTIVE policy | W1 (columns + CHECKs), P3 (policy uses `portalEnabled`) |
| Comment | one polymorphic `Comment(subjectType, subjectId)` replaces the drafted `IssueComment` | W1 |
| Time entry | `stoppedAt NULL` = running; partial unique `(tenantId, memberId) WHERE stopped_at IS NULL`; raw seconds; `timezone`+`localDate`; `clientEventId` unique | W2 |
| Rates | effective-dated `RateCard`, snapshot `billRate/currency/rateSource/billRateCardId` onto the entry at write; cost rate encrypted and *resolved at read* behind a permission (never fanned out) | W2 |
| Encryption format | upgrade `field-encryption.ts` to `v2.` with per-tenant DEK (`TenantKey`) and AAD `tenantId:model:rowId:field`; v1 stays decryptable | P1.5 (format only), V (first data) |
| Notification seam | `notify.emit()` function signature and static kind catalog exist from W2 (writes in-app rows only); outbox/SES fan-out in P5 | W2 stub, P5 real |
| Search index | narrow trigger-fed `search_index` with custom TS config; created empty in W1 with only WORK_ITEM rows | W1 |

---

## 3. Phase 1.5 — Foundation leftovers that must precede the UI wave (2 weeks)

**Why first:** every W1 screen written before i18n and a component kit exist gets written twice. These are the Phase-1 items still unchecked in `PLAN.md` that block later phases; the rest are interleaved where first needed (table at the end of this section).

**Scope (autonomous):**
- `next-intl` scaffold, `sv` + `en` message files, no locale prefix in URLs, resolution principal → tenant default (`Tenant.defaultLocale`) → Accept-Language → `en`; ESLint rule banning literal JSX strings under `src/app`. Convert the six existing pages.
- **ARC-15 (new): UI kit = shadcn/ui on Radix + Tailwind 4**, self-hosted, no vendor. Install ~15 primitives (button, input, dialog, popover, command, dropdown, tooltip, sheet, tabs, badge, avatar, toast, table, skeleton, form). Add `src/components/`.
- **ARC-16 (new): folder layout** — adopt `src/modules/<key>` for entitlement modules from now on; existing `src/members` etc. stay as core.
- Wire `withRequestContext()` in the authed layouts and route handlers so audit rows carry `requestId/ip/userAgent` (currently NULL).
- MFA enforcement hook: `authorize()` denies `MFA_REQUIRED` for `requiresMfa` codes when the session lacks a recent TOTP; add `sudo` window helper (10 min) reused later by vault reveal. Small, and it unblocks `role:edit`, `member:manage_roles`, and V.
- Member admin minimum: role assignment editing, suspend/remove with last-owner guard, revoke invite (all catalogued events already exist).
- R2 transport: presigned PUT/GET, HEAD verify, quota metering, `FileObject` commit; behind a `StorageTransport` interface with a local-disk dev transport so Claude can build and test without Cloudflare credentials.
- Rate limiting: `@upstash/ratelimit` behind one config module with a no-op fallback when env is absent (fail-open by design except the P8 paths).

**Founder-side provisioning (parallel, not blocking):** create the two R2 buckets (`jurisdiction=eu`), Upstash EU database, upgrade Vercel to Pro (needed by W2 crons), finish SES DNS + production access. Claude proceeds against the dev transports until env vars appear.

**Tests:** existing suites stay green; new: i18n lint passes; MFA gate deny-matrix (✦ codes without step-up → `MFA_REQUIRED`); last-owner guard; storage transport contract test (upload→commit→presign→download) against the local transport, and against R2 when `R2_*` env exists.

**Demo:** switch locale on `/account`, see Swedish; try `role:edit` without recent TOTP → step-up prompt; upload a file with visibility toggle on a test page.

**Interleaving of remaining Phase-1 leftovers:** SES real transport → needed by P3 (portal invites); audit retention cron → P5 (with the outbox worker); passkeys → v2; platform console → P7; tenant switcher → P7 (Naxdor has one tenant).

---

## 4. Phase 2 — Core domain, trimmed to what W1 needs (3–4 weeks)

**Existing PLAN.md Phase 2 stands**, with three changes: `Project` gains the work-management columns now; `Contact` remains records-only (identity in P3); the timeline view is reduced to a milestone list (ProjectUpdates arrive in P3).

**Models (from `DATA_MODEL.md` §6.4/6.5 as drafted, plus additions):** `Client`, `Contact` (record), `MemberClient`, `MemberProject`, `Project` (+ `key`, `portalEnabled=false`, `billingCurrency`, `defaultBillable`, `leadMemberId`, `hoursSharingMode=NONE`, `updateCadence=NONE`), `Milestone` (+ `rank`, status enum widened to PLANNED/IN_PROGRESS/PAUSED/COMPLETED/CANCELLED), `Service`, `ProjectVersion` (as drafted). `Document.clientId/projectId` get their composite FKs. `AttachableType` gains WORK_ITEM, COMMENT, PROJECT_UPDATE, CREDENTIAL, ASSET (enum values are cheap; add all now).

**Seams reused:** all writes through `withTenant` + `requireAccess`; `authorizedClientIds()` finally implements the MemberClient ∪ project→client lift (the TODO at `authorize.ts:105`); Class B RLS template from the security_foundations migration copied for every client-scoped table; `TenantCounter` unused yet; `audit.record` for `client.*`, `project.*`, `milestone.*` (add to catalog — currently absent).

**Permissions:** none new (all `client:*`, `project:*`, `service:*`, `document:*` exist). **Audit additions:** `client.created/updated/archived`, `project.created/updated/status_changed/archived/key_changed`, `milestone.created/updated/completed`, `service.created/updated`.

**Routes:** `/clients`, `/clients/[id]`, `/clients/[id]/contacts`, `/projects`, `/projects/[id]` (overview: milestones, versions, documents, members), `/settings/export`.

**Tests:** four families — isolation suite auto-extends via DMMF; client-scoping deny-default (member with zero assignments sees zero clients; assigned to A and B cannot read C → 404); file visibility (`Client.internalNotes`, `Project.repoUrl/hostingNotes/internalNotes` absent from portal-projection selects — grep test on the projection modules); privilege escalation (employee cannot `client:create`, `project:delete`). Feature: export v0 round-trip validates manifest completeness against DMMF.

**Demo:** create client "Acme", assign an employee, create project "Acme site" with key `ACME`, add three milestones, upload a document as internal, log in as the employee → sees Acme only.

**Founder inputs:** none blocking. Checkpoint CP1 after this demo (see §12) to react to the UI kit before W1 multiplies it.

---

## 5. Phase W1 — Work items, board, backlog, My Work (4–5 weeks) — *new phase; Naxdor's daily entry point*

**Goal:** an Azure-DevOps data model under a Planner/Linear surface: one WorkItem table, category-based states, one board per project, ranked backlog, personal home, comments with two-audience visibility, field-level activity. No time yet.

**Entitlement:** new module key `work` (add to `MODULES`, `entitlementsSchema.modules`, preference `module.work.enabled`, flag `module.work`).

**Models:**
- `WorkflowState(id, tenantId, projectId, name, color, category StateCategory{BACKLOG,TODO,IN_PROGRESS,DONE,CANCELLED,TRIAGE}, rank, wipLimit?, isDefault)`; per-project defaults copied from a code-side `WorkflowPreset` constant (Backlog / To do / In progress / Done / Cancelled + hidden Triage). Tenant-editable presets: later.
- `WorkItem(id, tenantId, clientId, projectId, number, type{EPIC,TASK,SUBTASK}, kind{TASK,BUG,REQUEST}, title, description Json, descriptionText, stateId, priority{NONE,LOW,MEDIUM,HIGH,URGENT}, assigneeMemberId?, assigneeContactId?, parentId?, rootItemId, depth, milestoneId?, rank, estimateMinutes?, startDate?, targetDate?, startedAt?, completedAt?, visibility=INTERNAL, triageStatus?, snoozedUntil?, duplicateOfId?, source{IN_APP,PORTAL,EMAIL,IMPORT}, checklistTotal, checklistDone, archivedAt?, createdByMemberId?, reportedByContactId?)`; indexes `(tenantId, projectId, stateId, rank)`, `(tenantId, assigneeMemberId, completedAt)`, `(tenantId, parentId)`, `(tenantId, clientId, visibility)`; CHECK `visibility` ≤ parent's (trigger), CHECK `assigneeContactId IS NULL OR visibility='CLIENT_VISIBLE'`.
- `WorkItemActivity(id, tenantId, workItemId, actorMemberId?/actorContactId?, field, oldValue, newValue, oldIdentifier?, newIdentifier?, visibility, createdAt)` — separate from AuditEvent.
- `WorkItemLink(tenantId, sourceId, targetId, type{RELATED,BLOCKS,DUPLICATE_OF})`, `Label(tenantId, projectId?, name, color)`, `WorkItemLabel`, `WorkItemCollaborator`, `WorkItemSubscriber` (subscription rows written now, consumed by P5).
- `Comment(id, tenantId, clientId?, subjectType{WORK_ITEM,PROJECT_UPDATE,DOCUMENT,PROJECT_VERSION}, subjectId, parentId?, authorMemberId?/authorContactId?, body Json, bodyText, visibility=INTERNAL, editedAt, deletedAt)`, `Mention`, `Reaction`.
- `search_index` (hand-written SQL: generated tsvector, custom TS config `fortleva` = unaccent + swedish_stem, same tenant + portal_gate policies, no GIN) fed by triggers on `work_item` and `comment`.
- `SavedView(tenantId, ownerMemberId?, projectId?, name, definition Json)` — cheap now, powers `<WorkItemView>` persistence.

**Numbering:** `UPDATE tenant_counter SET value=value+1 WHERE tenant_id=$1 AND key='workitem:'||$2 RETURNING value` inside the create transaction (upsert row on first use) — reuse of `TenantCounter` exactly as `DATA_MODEL.md` §9 describes for issues.

**Permissions (module `work`, seeding C/M/A/E):** `work_item:view` CMAE · `work_item:create` CMAE · `work_item:edit` CMAE · `work_item:delete` CM · `work_item:change_visibility` CMA · `work_item:triage` CME · `work_item:archive` CME · `workflow:manage` CM · `label:manage` CMA · `comment:create` CMAE · `comment:delete` CMA · `comment:change_visibility` CMA · `saved_view:manage_shared` CM. (13 codes → catalog test 76; bump `TEMPLATE_VERSION` to 2; propagation job for existing tenants' template roles — B3 additive — is a P1.5/W1 utility that runs in `prisma/seed.ts` and once per deploy.)

**Audit events:** `work_item.created`, `work_item.deleted`, `work_item.archived`, `work_item.visibility_changed`, `work_item.bulk_updated`, `work_item.triaged`, `comment.deleted`, `comment.visibility_changed`, `workflow.changed`, `label.created`, `label.deleted`. State/assignee changes go to `WorkItemActivity`, not AuditEvent (audit stays privileged-ops).

**Routes/screens:** `/work` (My Work: assigned, overdue, next 7 days, triage count), `/projects/[id]/board`, `/projects/[id]/backlog`, `/projects/[id]/items/[key]` (side-peek + full page), `/projects/[id]/settings/workflow`, `/search`, ⌘K palette (`cmdk`), keymap (`react-hotkeys-hook`), `<WorkItemView>` (filters/group-by/order-by/layout LIST|BOARD) shared by all three lists; drag via `@atlaskit/pragmatic-drag-and-drop` desktop-only with "Move to…" keyboard/mobile twin; optimistic mutations via `useOptimistic` + Server Actions; freshness by 12 s version poll + focus refresh.

**Seams reused:** `withTenant` for every action; `requireAccess(tx, tenantId, actor, "work_item:edit")` (module `work` → gates 1–3 apply); `authorizedClientIds()` scopes every list; `Document` attachments via `AttachableType.WORK_ITEM/COMMENT` with visibility forced ≤ parent; `TenantCounter`; `audit.record`; `Visibility` enum + Class B RLS (portal_gate additionally requires `project.portal_enabled` — denormalise `portalEnabled` onto `work_item`/`comment` via trigger, so the policy stays a column comparison).

**Tests:** *tenant isolation* (DMMF auto + rank/number uniqueness under two tenants); *client scoping* (employee assigned to A cannot list/peek/search B's items → 404, search index respects `authorizedClientIds`); *file visibility* (INTERNAL comment on CLIENT_VISIBLE item invisible under contact principal; child cannot be CLIENT_VISIBLE under INTERNAL parent — CHECK fires; attachment inherits); *privilege escalation* (employee cannot `workflow:manage`, cannot flip visibility). Feature: rank uniqueness under 20 concurrent moves; depth-4 insert rejected; parent rollup rule; TRIAGE→accept clears fields; search lexeme-probe (INTERNAL text never matches under `app.principal='contact'`); activity row per field change.

**Definition of done:** Naxdor's live projects decomposed into epics/tasks on boards; every state change optimistic; nothing time-related visible; i18n complete; export manifest extended.

**Demo script:** press `C` on `/work`, type a title, Enter → item `ACME-1`; drag it across the board; open it, add subtask, set priority with `P`, add an internal comment then a client-visible one (badge differs); ⌘K "ACME-1" jumps to it; log in as employee not assigned to Acme → `/projects/<acme>/board` 404s.

**Founder inputs:** CP0 decisions (§12) before starting; nothing provisioning-related.

---

## 6. Phase W2 — Timer, time entries, rates, budgets, rollups (3–4 weeks) — *new phase; reverses the skip-list*

**Goal:** the founder's timer/cost ask, modelled as *tidsredovisning* not monitoring, with per-member/team rollups and cost.

**Entitlements:** `time` (timer/entries/rollups) and `budgets` (rates, cost, budgets). Preferences: `time_tracking.autoStopHours` (12), `time_tracking.overlapPolicy` (BLOCK), `finance.costRates.enabled`, `durationStyle`, `weekStart`.

**Models:**
- `TimeEntry(id, tenantId, clientId, projectId, workItemId?, memberId, description, startedAt, stoppedAt?, durationSeconds?, timezone, localDate, entryMode{TIMER,MANUAL,DURATION}, source{TIMER,MANUAL,IMPORT,OFFLINE_QUEUE}, billable, visibility=INTERNAL, billRate?, currency, rateSource, billRateCardId?, costRateCardId?, invoiceLineId?, lockedReason?, needsReview, reviewReason?, clientEventId?, createdBy)`; hand-written SQL: partial unique running-timer index, CHECK `(stopped_at IS NULL) = (duration_seconds IS NULL)`, indexes on `(tenantId, memberId, startedAt DESC)`, `(tenantId, projectId, startedAt)`, `(tenantId, workItemId)`, `(tenantId, localDate, memberId)`. Class A RLS (portal never reads rows; a projection serves P3).
- `RateCard(id, tenantId, kind{BILL,COST}, scope{TENANT,MEMBER,PROJECT,PROJECT_MEMBER}, memberId?, projectId?, amount (COST → `amountEnc` via field-encryption), currency, effectiveFrom, effectiveTo?)`.
- `RoundingRule(tenantId, incrementMinutes, mode, minimumBillableMinutes)` referenced by `Project.roundingRuleId`; applied only in reports.
- `ProjectBudget(id, tenantId, clientId, projectId, kind{HOURS,MONEY}, billingModel{T_AND_M,FIXED_FEE,RETAINER,NON_BILLABLE}, amount, currency, period, periodAnchor, includeNonBillable, thresholds int[], status)` one ACTIVE per project; `BudgetAlert(budgetId, periodKey, threshold, sentAt)`.
- `Member` gains `timezone`, `workCountry`, `staffNoticeAckedAt`, `staffNoticeVersion`. Staff notice text is a tenant preference (`time_tracking.purposes`, `time_tracking.noticeVersion`) rendered sv/en; first timer start requires acknowledgment.
- `Notification` + `NotificationPreference` tables and the `notify.emit()` seam (in-app only; email in P5) — created here because budget thresholds and 12-h auto-stop need somewhere to land.

**Rate resolution:** run at entry write (and on member/project/billable/localDate change), never on read: BILL PROJECT_MEMBER → PROJECT → MEMBER → TENANT; COST MEMBER → TENANT; store `billRate/currency/rateSource/billRateCardId`; cost is stored as `costRateCardId` only and decrypted at report time behind `cost:view`. `reprice(rateCardId, FROM_DATE|ALL_UNBILLED)` is an audited command that skips locked entries.

**Permissions (module `time` unless noted):** `time:track` CMAE (own entries) · `time:view_team` CM · `time:edit_others` CM · `time:lock` CA · `time:export` CMA · `rate:view` CM (`budgets`) · `rate:manage` CA ✦ (`budgets`) · `cost:view` C ✦ (`budgets`) · `budget:view` CM (`budgets`) · `budget:manage` CM (`budgets`). (10 codes → 86.)

**Audit events:** `timer.started`, `timer.stopped`, `timer.auto_stopped`, `time_entry.created`, `time_entry.updated_by_other`, `time_entry.deleted`, `time_entry.locked`, `time_entry.unlocked`, `rate_card.created`, `rate_card.updated`, `rate_card.ended`, `rate.repriced`, `budget.created`, `budget.updated`, `budget.threshold_reached`, `cost_report.viewed`, `staff_notice.acknowledged`, `time_export.generated`.

**Routes:** timer pill in the authed layout (`GET /api/timer/current`, actions start/stop/adjust); `/time` (My Time: today, week grid, manual entry `1h 30m`), `/projects/[id]/time` (rollup by member/epic/task, date range, billable split, CSV raw+rounded), `/projects/[id]/money` (budget bar, hours by member, revenue/cost/margin — finance-gated), `/settings/rates`, `/settings/time` (purposes, notice, auto-stop). Board cards show Σ spent / estimate and a running-timer badge. Vercel Cron `*/15`: nudge at 8 h (in-app), auto-stop at 12 h → `needsReview`. **Autonomy fallback:** every time-based effect is also applied lazily on `GET /timer/current` and on list reads, so the feature is correct on Hobby before Pro exists.

**Seams reused:** `withTenant` transaction with `SELECT … FOR UPDATE` on the member's running entry; `requireAccess` for `time`/`budgets`; field-encryption for cost rates; `Visibility` (entries INTERNAL forever; portal reads only `ProjectTimeSummary` in P3); `audit.record`; `TenantPreference` for policies; `notify.emit()` stub.

**Tests:** *isolation* (auto); *client scoping* (employee's `/projects/[id]/time` for an unassigned project → 404; team view needs `time:view_team`); *visibility* (TimeEntry never readable under contact principal; portal projection module greps forbid `billRate|cost|memberId` unless `hoursSharingMode` allows); *escalation* (employee cannot edit others' entries, cannot see rates; `cost:view` requires MFA step-up). Feature: running-timer race (two concurrent starts → exactly one running, one stopped); rate snapshot stability (change rate card → old entries unchanged; reprice touches only unlocked entries pointing at that card); midnight-spanning entry stays one row with correct `localDate`; auto-stop idempotent; rollup equality (Σ task = epic = project = per-member sums); rounding applied only in report output (raw column preserved); staff-notice gate.

**DoD:** Naxdor staff track every billable hour in-product; project money page reconciles with a hand calculation; cost never appears in CSV by default; notice acknowledged by all members.

**Demo:** open a task, press `T` → pill starts; start another → first stops with undo toast; stop → confirm dialog with note+billable; `/projects/ACME/time` shows per-member totals; set project bill rate 1 200 SEK and member cost rate → `/money` shows margin (CEO with TOTP); log in as employee → sees own hours only.

**Founder inputs:** CP2 (rate tiers, rounding default, who-sees-cost, staff notice wording, MBL check if a union member exists, Vercel Pro upgrade). Claude proceeds with the defaults in §12 if unanswered; the notice text ships as a draft the founder edits in settings.

---

## 7. Phase 3 — Portal, sharing, progress updates (4–5 weeks) — *existing phase, extended*

**Existing scope stands** (Contact identity stack, invite flow, read surfaces, version sign-off v1-lite, portal rate limits, audited downloads) **plus** the sharing model the founder asked for.

**Additions:** `Project.portalEnabled` gate wired into every portal RESTRICTIVE policy (work_item, comment, document, milestone, project_update); item-level visibility with permanent badge and inheritance (schema from W1, UI now); comment two-mode composer; **View-as-Contact** preview reusing the exact portal projection queries under a contact principal; portal home = action items (approvals, replies, client-side tasks) then project cards; portal project page = health + next milestone + latest update + progress by state category + shared items list (kanban toggle later) + files + hours-vs-budget when `hoursSharingMode ≠ NONE` (CONTACT_PRIMARY only, billable aggregates only); `ProjectUpdate(id, tenantId, clientId, projectId, seq, health{ON_TRACK,AT_RISK,OFF_TRACK,ON_HOLD,COMPLETE}, title?, periodStart/End, body Json, snapshot Json v1, status{DRAFT,PUBLISHED,ARCHIVED}, visibility, publishedAt, authorMemberId, editNote)` — immutable after 15-min grace; client timeline = derived union of published updates, milestone completions, shipped versions, client-visible deliverable documents (never AuditEvent); `ProjectTimeSummary` projection (billable seconds per month, budget %); portal REQUEST submission (`WorkItem.kind=REQUEST`, source PORTAL, forced CLIENT_VISIBLE, lands in TRIAGE) — the v1 replacement for `Issue`; contact-writable census widened to WorkItem(REQUEST), Comment, ProjectVersion approval columns.

**Permissions:** `project:manage_portal` CM (enable/disable, hoursSharingMode) · `project_update:create` CME · `project_update:publish` CM · `project_update:archive` CM (→ 90). Portal capabilities (hardcoded union): `portal.work_item.view/create_request/comment`, `portal.update.view`, `portal.hours.view`.

**Audit:** `project.portal_enabled`, `project.portal_disabled`, `project.hours_sharing_changed`, `project_update.published`, `project_update.archived`, `portal.previewed_as_contact`, `work_item.request_submitted`, plus the existing `contact.*`/`file.downloaded`.

**Routes:** `/portal` (home), `/portal/projects/[id]`, `/portal/projects/[id]/items`, `/portal/requests/new`, `/projects/[id]/updates`, `/projects/[id]/portal` (settings + preview).

**Seams reused:** `withTenant` with `{type:"contact", id, clientId}` for every portal read (RLS does the work; projections add allow-listed selects); Class B RLS + `portalEnabled` denormalisation; `Document` for update attachments (`PROJECT_UPDATE`); `audit.record`; `TenantCounter` for `ProjectUpdate.seq`; SES transport for contact invites (needs the founder's SES production access — dev outbox until then).

**Tests:** portal deny-matrix (cross-client, cross-tenant, INTERNAL item/comment/document, tenant route with portal cookie, self-signup); "no INTERNAL fact to a Contact" grep over every projection module (forbidden columns: rates, cost, internalNotes, per-member time, state names — only categories); portal-enabled=false ⇒ zero rows for every table; view-as returns byte-identical JSON to the real contact session; update immutability after grace; hours widget hidden for CONTACT_COLLABORATOR; rate limits on request creation.

**DoD:** one real Naxdor client logs in, sees exactly its shared items/milestones/updates/files, submits a request that lands in the triage queue.

**Demo:** flip `Project.portalEnabled`, mark two tasks client-visible, publish an update with health AT_RISK, "View as client" → confirm; invite a contact; contact submits a request; staff sees it in TRIAGE with `A/D/U` keys.

**Founder inputs:** CP3 (portal surface priority, `hoursSharingMode` default, whether clients get kanban); SES production access + DNS (blocking real client invites only).

---

## 8. Phase V — Vault, asset registry, expirations (3–4 weeks) — *new phase; reopens "pointers not secrets"*

**Pushback recorded before building:** this is the highest-liability feature in the plan and contradicts `PROJECT_BRIEF.md` §8, `DATA_MODEL.md` §6.5 (`hostingNotes` pointers only) and `CONTINUITY_BOX.md` §336–343. Recommendation: build it as a *product module* (server-side envelope encryption, auditable, exportable), keep the continuity box pointer-only and let it auto-generate its "systems & assets" section from `ClientAsset` at seal time. Do not build E2EE. Say all this in a dated `OPEN_QUESTIONS.md` decision 12.

**Prerequisites:** P1.5 MFA step-up + `v2.` AAD ciphertext format landed; `TenantKey(tenantId, keyId, wrappedDek, status)` created and back-filled for existing tenants.

**Entitlement:** `vault` (credentials) and `assets` (registry + expirations); preference `vault.allowPortalCredentials=false`.

**Models:** `CredentialItem(id, tenantId, clientId?, projectId?, assetId?, type{LOGIN,SECURE_NOTE,API_KEY,SSH_KEY,DATABASE,SERVER,WIFI,SOFTWARE_LICENSE,OTHER}, name, username?, url?, tags[], notes, secretCiphertext, secretFields[], totpSecretCiphertext?, hasTotp, expiresAt?, rotateEveryDays?, lastRotatedAt?, visibility=INTERNAL, archivedAt?)` (Prisma `omit` default on ciphertext columns); `CredentialVersion`; `CredentialShareLink(tokenHash, recipientEmail?, passcodeHash?, includeTotpCode, expiresAt, maxViews=1, viewCount, revokedAt)`; `ClientAsset(id, tenantId, clientId, projectId?, type{DOMAIN,HOSTING,DNS_ZONE,SSL_CERT,EMAIL,CMS_APP,THIRD_PARTY_SERVICE,LICENSE,CUSTOM}, name, provider?, url?, identifier?, expiresAt?, autoRenew?, renewalCost?, currency?, fields Json, visibility, notes)`; `ExpirationReminderSent`; `Relation` (generic, never used for authz).

**Permissions (module `vault`):** `credential:view` CMA · `credential:reveal` CMAE ✦ · `credential:edit` CMA · `credential:share` CMA ✦ · `credential:export` C ✦ · `credential:change_visibility` C ✦; (module `assets`): `asset:view` CMAE · `asset:manage` CMA (→ 98). Reveal/copy/TOTP are separate POST endpoints that decrypt one field and write the audit row in the same transaction; sudo window 10 min; per-member reveal budget 30/h in Upstash.

**Audit:** `credential.created/updated/deleted/revealed/copied/totp_generated/shared/share_viewed/share_revoked/exported/visibility_changed`, `asset.created/updated/deleted`, `tenant_key.created/rotated`, `expiration.reminded`.

**Routes:** `/clients/[id]/vault`, `/clients/[id]/assets`, `/expirations`, `/portal/share/[token]` (rendered in portal shell), `/portal/projects/[id]/submit-credential`.

**Seams reused:** field-encryption v2 (first real caller); `withTenant`; MFA step-up from P1.5; Class B RLS (portal path only through the share endpoint and, when the preference is on, CLIENT_VISIBLE items); `Document` for credential attachments (`CREDENTIAL`, forced INTERNAL); `audit.record`; `TenantPreference`.

**Tests:** *isolation* (DB dump test: no plaintext, AAD mismatch across tenants fails to decrypt); *scoping* (member not assigned to client cannot list or reveal → 404); *visibility* (contact principal sees zero credential rows unless preference on and item CLIENT_VISIBLE; share link consumed atomically once); *escalation* (reveal without MFA → `MFA_REQUIRED`; employee cannot export; reveal budget exceeded → deny + audit). Feature: TOTP code generation matches reference vectors; expiration union view; nightly reminder dedupe.

**DoD:** Naxdor's per-client logins live in the vault, every reveal audited; expirations page shows domains/SSL/licences with reminders.

**Demo:** add a WordPress login for Acme; reveal (TOTP prompt) → audit row; create a one-view share link, open it in the portal shell, second open fails; add a domain asset expiring in 20 days → appears on `/expirations`.

**Founder inputs:** CP4 (server-side vs E2EE — recommend server-side; portal-visible credentials default OFF; share-link max TTL); update `SECURITY.md` §6 inventory and DPA wording ("operator can technically decrypt").

---

## 9. Phases 4, 5, 6 — existing phases, extended

**P4 Money (6–8 wk, +1 wk):** as planned, plus the time→invoice bridge: uninvoiced-time queue → invoice draft lines (`InvoiceLine.unit="h"`, quantity = rounded hours, `projectId`), immutable `InvoiceLineTimeEntry` join + `TimeEntry.invoiceLineId`, `lockedReason=INVOICED` on issue, release on full credit note; "mark billed externally / write off"; `RetainerPlan/RetainerPeriod/HourBankTransaction` (S tier — build only if Naxdor has a retainer client at that point); tidrapport PDF as `Document(kind=REPORT)`. Permissions `invoice:generate_from_time` CA, `time:write_off` CA. Retention: invoiced entries inherit R1.

**P5 Collaboration (3–4 wk):** *Issue/IssueComment removed* (absorbed by WorkItem REQUEST + Comment in W1/P3). Scope becomes: `EmailOutbox` + SES v2 config sets + SNS bounce webhook + suppression + one-click unsubscribe; `notify.emit()` fan-out (assignment debounce 2 min, per-item coalescing, mentioned+participants only); in-app inbox (`/inbox`, j/k/e/u/s); member daily digest; client weekly digest built under the portal role; Web Push opt-in; audit retention cron. Kind catalog with `audience`; every CONTACT-audience kind `clientVisibleOnly` — CI-tested. Reply-by-email stays v2 behind entitlement.

**P6 Reports (2 wk):** as planned (uploaded PDFs + CrUX) plus staff "Project health" table (health, latest update age, % done, hours vs budget), fixed Recharts charts (status donut, per-state, hours by member/project), cycle/lead-time from `WorkItemActivity` recorded since W1, `ProjectTemplate` + "save project as template", CSV/Trello import.

**P7/P8:** unchanged; P7 adds entitlement keys `work/time/budgets/vault/assets` to plans and the DPA vault wording; P8's box "systems & assets" section reads `ClientAsset`.

---

## 10. PLAN.md reconciliation — what is absorbed, reordered, reopened

| Existing item | Change |
|---|---|
| Skip list "Time tracking — don't build" (PLAN.md l.310; DATA_MODEL §11 l.1932; OPEN_QUESTIONS decision 7) | **Reversed** by dated decision 11 (2026-08-16); W2 is the build; add the *never-list* (idle detection, screenshots, URL/app capture, presence, leaderboards, geolocation) to the skip list in its place |
| Phase 5 `Issue`/`IssueComment` | **Absorbed**: `WorkItem.kind=REQUEST` + `StateCategory.TRIAGE` (W1 schema), portal submission (P3), notifications (P5). Permission codes `issue:*` stay in the catalog (immutable) but unseeded from templates at TEMPLATE_VERSION 2 |
| DATA_MODEL §11 "Kanban/Gantt tables = v2, no new storage" | **Reopened**: board needs `WorkflowState` + `rank`; timeline stays not-a-Gantt (milestone list + updates) |
| Phase 2 "timeline / stage view" | Reduced to milestone list; `ProjectUpdate` timeline moves to P3 |
| Phase 2 `Project` fields | Extended (key, portalEnabled, billing, hoursSharingMode, cadence) |
| `AttachableType` | Extended in P2 with WORK_ITEM/COMMENT/PROJECT_UPDATE/CREDENTIAL/ASSET |
| Phase 4 | Gains time→invoice bridge, locking, retainer ledger |
| Phase 6 | Gains project health, charts, templates, imports |
| `catalog.test.ts` count 63 | Bumped per phase (76 → 86 → 90 → 98 → …); `TEMPLATE_VERSION` bumped and additive propagation implemented (B3) in W1 |
| CONTINUITY_BOX/SECURITY "pointers not secrets" | Amended: box stays pointer-only; vault is a product module (decision 12) |
| Phase 1 checkboxes / progress log | Reconcile: tick built items, log 2026-08-08→16 commits, add P1.5 as the leftover bucket |
| Phase table | Insert W1, W2, V; re-estimate totals; note P3 depends on W1 |
| ARCHITECTURE.md | ARC-15 UI kit (shadcn), ARC-16 modules folder, ARC-17 DnD/ordering (Pragmatic + fractional-indexing, server rank), ARC-18 freshness (poll → SSE later), ARC-19 rich text (Tiptap 3), ARC-20 vault crypto (server-side envelope, AAD v2), ARC-21 jobs (Postgres outbox + Vercel Cron Pro + lazy fallbacks) |

---

## 11. Founder-side provisioning and how Claude proceeds without it

| Item | Needed by | Fallback while missing |
|---|---|---|
| Vercel Pro (crons, `after()` durability) | W2 (auto-stop), P5 (outbox) | lazy evaluation on read; outbox drained by an authenticated `POST /api/jobs/run` the founder can hit manually |
| R2 buckets + keys | P2 documents, W1 attachments | local-disk `StorageTransport` in dev; integration test skipped without env |
| SES production access + DNS | P3 contact invites, P5 email | dev outbox (`.dev-outbox/outbox.jsonl`) — already how invites are tested |
| Upstash Redis EU | P1.5 rate limits, V reveal budget | no-op limiter with warning log (fail-open) except vault reveal budget (fail-closed → in-Postgres counter fallback) |
| Neon Launch plan | before tenant-zero data (P2) | none needed for code |
| Staff notice text / MBL check / lawyer | before Naxdor *uses* W2 timers | ship draft sv/en text; feature gated behind acknowledgment |
| TOTP on founder's phone | P1.5 MFA enforcement | already enrolled on `/account` |
| Vault crypto stance | V | do not start V until CP4 is closed |

Everything else — schema, migrations, RLS SQL, services, screens, tests, docs edits — is autonomous.

---

## 12. Founder decisions (recommended defaults) and brainstorm checkpoints

**CP0 — before P1.5 starts (30 min):** ① approve this sequence and the reversal of decision 7; ② vocabulary: UI says "Task", levels are Epic/Task/Subtask, `Issue` is gone (default: yes); ③ hierarchy depth 3, single assignee (default: yes); ④ configurable state names inside fixed categories (default: yes); ⑤ shadcn/ui as UI kit (default: yes); ⑥ project key format `ACME-12` (default: yes).
**CP1 — after P2 demo:** react to the visual style before W1 multiplies it; confirm `Project.key` per project vs tenant-global numbering (default: per project).
**CP2 — before W2:** rate tiers (default BILL project-member > project > member > tenant; COST member > tenant); rounding (default none at tenant, per-project rule at invoice); who sees money (employee hours, manager bill rates + budgets, CEO/finance cost + margin, cost encrypted); time without a task allowed with required note (default yes); overlap block (default yes); staff-notice purposes = billing/planning/profitability, not performance evaluation; Vercel Pro now.
**CP3 — before P3:** portal v1 surface = action items + project overview + shared items list, no client kanban, no public links (default); `hoursSharingMode` default NONE; client REQUEST submission on (default yes).
**CP4 — before V:** server-side envelope encryption, no E2EE (default); MFA required to reveal, always step-up for share/export/visibility; persistent client-visible credentials default OFF; share-link max TTL 7 days.
**CP5 — before P4:** invoice bridge semantics (lock on issue, release on full credit — default), retainer ledger only if a retainer client exists.
**CP6 — before P5:** digest cadence (member daily, client Monday 08:00), Reply-To mailbox, reply-by-email deferred (default).
**Standing:** any time a phase demo surfaces something wrong — checkpoints are cheap, retrofits are not.

---

## 13. What NOT to build (write into the skip list)

Sprints/iterations/capacity/velocity (continuous flow + milestones; Sprint entity only behind entitlement when a tenant asks); custom typed fields; Gantt with dependencies/auto-scheduling; process templates, area/iteration paths, WIQL, dashboard/report builders; multi-assignee; per-team board settings and hidden board-column fields; touch drag; a realtime sync engine (poll → SSE later); idle detection, screenshots, app/URL capture, presence, per-minute heatmaps, leaderboards, geolocation — *never*; task-scoped rates; timesheet approval workflows (v2); E2EE vault, browser extension, uptime monitoring; public no-login share links, magic links, client push; external search engines/pgvector; Slack/Teams/Novu/OneSignal; live Asana/Jira sync; AI drafting of updates (v2, deterministic pre-fill first).

---

## 14. Effort summary

| Phase | Weeks | Cumulative | Naxdor milestone |
|---|---|---|---|
| P1.5 leftovers | 2 | 2 | — |
| P2 core domain | 3–4 | 6 | clients/projects/docs in product |
| **W1 work** | 4–5 | 11 | **daily task work on boards** |
| **W2 time** | 3–4 | 15 | **timer + cost live** |
| P3 portal+sharing+updates | 4–5 | 20 | first client in portal |
| V vault+assets | 3–4 | 24 | credentials off spreadsheets |
| P4 money | 7–9 | 33 | invoices from time |
| P5 collaboration | 3–4 | 37 | notifications/digests |
| P6 reports | 2 | 39 | health + charts |
| P7, P8 | 12–16 | ~55 | as planned |

Riskiest overruns: W1 (UX polish is unbounded — cap it with the fixed screen list and the "one `<WorkItemView>`" rule), P4 (regulated), V (security tests before UI, no exceptions). Everything else is additive on seams that already exist.
