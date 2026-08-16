# Fortleva Work-Management Build Plan — data-model & architecture perspective

*Written 2026-08-16 against commit 78b58b5. Read: PLAN.md, DATA_MODEL.md (§6.4–6.9, §11), AUTHZ.md §3, TENANCY.md §7–11, schema.prisma, authz/catalog.ts, audit/catalog.ts, entitlements/resolver.ts, db/with-tenant.ts, members/*, app/(tenant)/(authed)/*. Goal of this perspective: a schema and service layer that does not get rewritten when boards, timers, rates, portal sharing, updates, vault and notifications all sit on it under FORCE RLS, deny-default scoping, audit, and the RESTRICTIVE portal policy.*

---

## 0. Thesis and what changes in PLAN.md

Fortleva keeps its 8-phase spine. Three things change:

1. **Two new build phases are inserted between Phase 2 and Phase 3** — **2W Work** and **2T Time & progress** — because Naxdor (tenant zero) validates them internally before any client sees a portal. **3V Vault** follows Phase 3.
2. **`Issue` is dissolved into `WorkItem` (`kind=REQUEST`, state category `TRIAGE`) and `IssueComment` into a polymorphic `Comment`.** Phase 5 stops being "issues + notifications" and becomes "notification channels + email-in + digests". Portal request intake moves to Phase 3 because the tables already exist by then.
3. **Time tracking leaves the skip list** (PLAN.md l.310, DATA_MODEL.md l.1932, OPEN_QUESTIONS decision 7) via a dated *decision 11*, with the legal never-list written into PLAN.md so it is not re-litigated. The continuity box stays pointer-only; the vault is a separate product module (CONTINUITY_BOX.md §336-343 unchanged; SECURITY.md §6 gains a per-tenant DEK section).

Three new entitlement modules only: **`work`**, **`time`**, **`vault`**. Notifications and search are *core infrastructure* (never gated; channels toggled by TenantPreference). ProjectUpdate rides on `work`. Fewer keys, fewer gates, fewer folders — the solo constraint.

Realistic total: Phase 1b (2–3 wk) + Phase 2 (5) + 2W (6) + 2T (5) + Phase 3 (6) + 3V (4) + Phase 4 (7) + Phase 5 (3) + Phase 6 (2) ≈ **40 weeks** to the end of Phase 6, then Phases 7–8 unchanged. Anything shorter means cutting tests, and the tests are the product.

---

## 1. One-way doors — land these with the tables, not with the UIs

| Door | Where it lands | Why now |
|---|---|---|
| Field-encryption **v2** format `v2.<rootKeyId>.<tenantKeyId>.<iv>.<ct>.<tag>` with AAD `tenantId:model:rowId:field`; `TenantKey` table; `encrypt(ctx, plain)` signature | Phase 2 | No encrypted app data exists yet (TwoFactor is Better Auth's own). After the vault holds one row it is a migration of secrets. |
| `app.principal_id` GUC added to `withTenant()` alongside tenant/principal/client | Phase 2 | Contact-authored rows (comments, notification reads) need `author_contact_id = app.principal_id` in `WITH CHECK`; retrofitting policies later is a full policy sweep. |
| `WorkItem.rank text COLLATE "C"` + unique `(tenant_id, project_id, rank)` | 2W | Collation change on a live ordered column is a rewrite of every board. |
| `WorkItem.stateCategory` denormalised (state category immutable) | 2W | The portal can never join `workflow_state` (class A) — category must live on the row. |
| `search_index` table shape + custom text-search config `fortleva` | 2W | Trigger-maintained; changing the config re-indexes everything. |
| `TimeEntry` constraints: one-running-per-member partial unique, lock trigger, nullness CHECKs | 2T | Cannot be added under running timers without a freeze. |
| Rate snapshot strategy (bill = amount on entry; cost = immutable card id on entry) | 2T | Changing snapshot semantics after invoicing breaks BFL immutability. |
| `Notification`/`EmailOutbox` shapes + `notify.emit()` seam + kind catalog with `audience` | 2W | Every later feature calls `emit()`; retrofitting an outbox after `after()`-based mail means dropped nudges. |
| Model-registry subclasses (`clientScoped`, `principalScoped`) + posture test | Phase 2 | Every new class-B table must prove `client_id`+`visibility`+`portal_gate` exist; the test is what keeps 40 new tables honest. |

---

## 2. Module and service structure

Adopt ARCHITECTURE.md §3 literally for *gated* modules; core stays flat like today.

```
src/
  db/            (unchanged + app.principal_id GUC + registry subclasses)
  authz/ audit/ entitlements/ crypto/ (v2 envelope: tenant-key.ts) mailer/ config/
  clients/ projects/ documents/         core domain (Phase 2): service.ts, actions.ts, portal.ts (allow-listed projections)
  notify/                                core infra (2W): catalog.ts (kinds+audience), emit.ts, outbox.ts, inbox.ts, digest.ts (P5)
  search/                                core infra (2W): index-sql (migration), query.ts, palette.ts
  jobs/                                  cron handlers' domain logic; app/api/cron/* are thin, CRON_SECRET-checked
  modules/
    work/     key "work"   items.ts, states.ts, ordering.ts, activity.ts, comments.ts, labels.ts, links.ts,
                           triage.ts, rollup.ts, updates.ts (ProjectUpdate), templates.ts, portal.ts, actions.ts, ui/
    time/     key "time"   timer.ts, entries.ts, rates.ts, rounding.ts, budgets.ts, rollup.ts, summary.ts
                           (ProjectTimeSummary projection), notice.ts, portal.ts, actions.ts, ui/
    vault/    key "vault"  credentials.ts, secrets.ts (decrypt path), reveal.ts, share-links.ts, totp.ts,
                           assets.ts, expirations.ts, portal.ts, actions.ts, ui/
```

Rules (add to `eslint.config.mjs`): modules import core freely; cross-module imports only through a module's `index.ts` barrel, and only in the direction **time → work → core**, **vault → core**; UI pages compose read functions from several modules (page-level composition, not module-level import). Every module exports `register()` into a module registry that owns nav entries and route prefixes so a disabled `module.<key>.enabled` removes the surface server-side.

Service recipe stays exactly the members recipe: `withTenant(tenantId, principal, tx => { await requireAccess(tx, tenantId, actor, code); await assertInScope(tx, actor, {projectId}); …mutate…; await record(tx, …); await notify.emit(tx, …); })`, side effects after commit. Add two seams in Phase 2: `assertInScope(tx, actor, resource)` (deny-default → NOT_FOUND) implemented over `MemberClient ∪ MemberProject`, and `requireRecentMfa(minutes)` for `requiresMfa` codes and vault step-up.

---

## 3. Phase plan

### Phase 1b — Foundation close-out (2–3 wk, prerequisite)

Not new scope; the Phase-1 items the exploration shows missing and that everything below assumes: next-intl scaffold + no-literal-strings lint (the work UI is the first big string wave — do not write it in English first); R2 presign/commit/quota path (attachments on items); real SES transport + SNS bounce webhook (outbox in 2W sends through it); Upstash rate limiting; `withRequestContext` actually populated in a root wrapper (audit rows currently carry NULL request fields); `requiresMfa` enforcement + `requireRecentMfa` step-up (vault, `member:manage_roles`); component library decision recorded as **ARC-15: shadcn/ui on Radix + Tailwind 4, code-owned, no vendor**; Vercel Pro (cron minutes; outbox worker). Tick the Phase-1 checkboxes in PLAN.md and add progress-log rows — the tracker is three weeks stale.

Tests: MFA_REQUIRED denial matrix; audit rows carry requestId; upload path file-visibility family (presign refuses INTERNAL to a contact principal).

---

### Phase 2 — Core domain + scoping + one-way doors (5 wk; PLAN.md Phase 2 as written, plus)

**Models (from DATA_MODEL.md, materialised as designed):** Client, Contact (records), MemberClient, MemberProject, Project, ProjectVersion, Milestone, Service, Document FKs. **Additions:**

- `Project` + `key VarChar(8)` (`@@unique([tenantId, key])`), `portalEnabled Boolean @default(false)`, `hoursSharingMode HoursSharingMode {NONE, HOURS, BILLABLE_AMOUNT} @default(NONE)`, `billingCurrency Char(3)`, `defaultBillable Boolean @default(true)`, `roundingRuleId?`, `updateCadence {NONE, WEEKLY, BIWEEKLY, MONTHLY}`, `leadMemberId?`, `autoArchiveMonths Int?`, `autoStartParent/autoCompleteParent Boolean`.
- `Milestone.status` → `{PLANNED, IN_PROGRESS, PAUSED, COMPLETED, CANCELLED}`, `rank text COLLATE "C"` (replaces `sortOrder`), keep "client-visible by nature".
- `Member` + `timezone VarChar(64)`, `workCountry Char(2)?`, `hoursPerDay Decimal(4,2)?`.
- `TenantKey` (`tenantId, keyId, wrappedDek, rootKeyId, status {ACTIVE, RETIRED}, createdAt`; class A; `@@unique([tenantId, keyId])`) + crypto v2 (v1 remains decryptable). Tenant bank fields switch to v2 on first write.
- `withTenant()` sets `app.principal_id`. Model registry gains `MODEL_CLASSES.clientScoped` and `principalScoped`; `isolation.dbtest.ts` posture test asserts, per clientScoped table, that `client_id` and `visibility` columns exist and a policy named `portal_gate` exists in `pg_policies`.
- `authorizedClientIds()` implemented (`client:view_all` → all; else `MemberClient ∪ project→client lift`); `assertInScope()`; every list query pushes the scope into `where`.
- Export v0 manifest with schema version; every later phase appends entities.

Permissions: none new (catalog already has client/project/service/document). Audit: add the designed `client.*`, `project.*`, `milestone.*`, `assignment.*` (already present) events; `project.portal_enabled/disabled`, `project.key_changed`. Screens: `/clients`, `/clients/[id]`, `/projects/[key]` (overview, milestones, versions, files), `/settings/preferences` (first tenant-preference UI, needed for module toggles).

Tests: client-level scoping family goes live (zero assignments ⇒ zero rows; project assignment lifts only the parent card); v2 encryption round-trip + AAD mismatch fails + v1 still decrypts; posture test on the new subclasses.

---

### Phase 2W — Work: items, states, backlog, board, comments, notifications seam, search (6 wk)

**Entitlement:** `work` (MODULES, `entitlementsSchema.modules.work`, `module.work.enabled`, flag `module.work`). `issues` key stays in the schema for compatibility; `issue:*` codes remain (immutable) but are marked deprecated in descriptions and no longer seeded into new templates.

**Models (all `tenantId`, uuid(7), snake_case, tenantId-leading indexes):**

| Model | Key fields / constraints | RLS |
|---|---|---|
| `WorkflowState` | `projectId, name, color, category StateCategory {BACKLOG, TODO, IN_PROGRESS, DONE, CANCELLED, TRIAGE}, rank text COLLATE "C", wipLimit Int?, isDefault Bool, definitionOfDone?`; `@@unique([tenantId, projectId, name])`, `@@unique([tenantId,id])`; trigger: `category` immutable after insert; app: exactly one default per project, ≥1 DONE and ≥1 CANCELLED state | A |
| `WorkflowPreset` | tenant-level named state sets, `states Json`; copied at project creation | A |
| `WorkItem` | `clientId (NOT NULL, from project), projectId, number Int, type {EPIC, TASK, SUBTASK}, kind {TASK, BUG, REQUEST}, title, description Json, descriptionText, stateId, stateCategory StateCategory (denormalised), priority {NONE, LOW, MEDIUM, HIGH, URGENT}, assigneeMemberId?, assigneeContactId?, parentId?, rootId?, depth Int, milestoneId?, rank text COLLATE "C", estimateMinutes?, remainingMinutes?, startDate?, targetDate?, startedAt?, completedAt?, visibility @default(INTERNAL), triageStatus {PENDING, ACCEPTED, DECLINED, SNOOZED, DUPLICATE}?, snoozedUntil?, duplicateOfId?, source {IN_APP, PORTAL, EMAIL, IMPORT}, checklistTotal, checklistDone, archivedAt?, sourceSystem/sourceId/importJobId?, createdByMemberId?/reportedByContactId?`. Uniques: `(tenantId, projectId, number)`, `(tenantId, projectId, rank)`, `(tenantId, id)`. Indexes: `(tenantId, projectId, stateId, rank)`, `(tenantId, assigneeMemberId, stateCategory)`, `(tenantId, parentId)`, `(tenantId, clientId, visibility)`, `(tenantId, milestoneId)`, `(tenantId, projectId, archivedAt)`. CHECKs: one of assigneeMemberId/assigneeContactId; `assignee_contact_id IS NULL OR visibility='CLIENT_VISIBLE'`; `type='EPIC' ⇒ parent_id IS NULL`; `depth <= 2`. Triggers: `work_item_parent_guard` (parent type strictly higher, same project, depth = parent.depth+1, child CLIENT_VISIBLE ⇒ parent CLIENT_VISIBLE, cycle-free); `work_item_visibility_downgrade_guard` (flipping to INTERNAL when any child is CLIENT_VISIBLE raises). Portal `WITH CHECK` for contact: `client_id = app.client_id AND visibility='CLIENT_VISIBLE' AND kind='REQUEST' AND source='PORTAL' AND state_category='TRIAGE'` (Phase 3 turns it on; policy written now, contact-writable census updated then) | B |
| `WorkItemActivity` | `workItemId, clientId, actorMemberId?/actorContactId?, field, oldValue, newValue, oldRef?, newRef?, commentId?, visibility, createdAt`; INTERNAL unless the field is in the portal-safe list (`stateCategory, title, targetDate, milestoneId, assigneeContactId, client-visible comment`); index `(tenantId, workItemId, createdAt)`. This is history, not audit. | B |
| `Comment` | `subjectType {WORK_ITEM, PROJECT_UPDATE, DOCUMENT, FILE_VERSION}, subjectId, clientId?, projectId?, parentId?, authorMemberId?/authorContactId?, body Json, bodyText, visibility, editedAt?, deletedAt?`; index `(tenantId, subjectType, subjectId, createdAt)`, `(tenantId, clientId, visibility)`; CHECK CLIENT_VISIBLE ⇒ clientId; contact `WITH CHECK`: `visibility='CLIENT_VISIBLE' AND client_id=app.client_id AND author_contact_id=app.principal_id`; trigger: comment visibility ≤ subject visibility (subject looked up by type) | B (contact-writable P3) |
| `Mention`, `Reaction`, `WorkItemSubscriber`, `WorkItemCollaborator`, `WorkItemLabel`, `Label (projectId?, name, color)`, `WorkItemLink (sourceId, targetId, type {RELATED, BLOCKS, DUPLICATE_OF}; acyclic BLOCKS in service)` | joins with composite FKs; labels and links are **internal-only in v1** (portal never sees them — one less leak vector) | A |
| `ProjectTemplate` | `name, locale, definition Json` (states, epics, items with checklist/estimate/visibility/labels); tenant-owned only — platform templates are copied at provisioning (no nullable tenantId, keeps the census clean) | A |
| `search_index` | `entityType, entityId, clientId?, projectId?, visibility, title, subtitle, bodyText, metaText, search tsvector GENERATED STORED (config fortleva = unaccent + swedish_stem, weights A/B/C), stateCategory?, assigneeMemberId?, updatedAt`; unique `(tenantId, entityType, entityId)`; btree `(tenantId, updatedAt)`, `(tenantId, projectId, updatedAt)`, `(tenantId, clientId, visibility, updatedAt)`; **no GIN at v1** (non-leakproof quals under FORCE RLS); trigger-maintained from work_item, comment, project, client, document | B |
| `Notification` | `receiverType {MEMBER, CONTACT}, receiverId, clientId? (required for CONTACT), projectId?, kind, class {INSTANT, COALESCED, DIGEST_ONLY}, entityType, entityId, actorType?/actorId?, params Json, dedupeKey?, readAt, archivedAt, snoozedTill, emailedAt`; partial index unread; contact policy `receiver_type='CONTACT' AND receiver_id=app.principal_id AND client_id=app.client_id` (SELECT + UPDATE of readAt only) | principalScoped |
| `Subscription`, `NotificationPreference`, `EmailOutbox (idempotencyKey unique, toEmail, kind, locale, params, sendAfter, status, attempts, lockedAt, sesMessageId)`, `EmailSuppression (global)` | worker drains outbox under `withPlatform({type:'system', job:'outbox'})` with `FOR UPDATE SKIP LOCKED`, Vercel Cron */2 + `after()` kick | A / global |

**Ordering:** `src/modules/work/ordering.ts` — `moveItem(tx, {id, stateId?, afterId?, beforeId?})`: `SELECT … FOR UPDATE` the two neighbours, compute `generateKeyBetween`, retry on unique violation with jitter, rebalance the container when any key exceeds 50 chars. Backlog = all open items by rank; board column = state's items by rank; a single rank keeps them consistent (ADO "maintain backlog order"). `WorkItemPlacement` only if independent sprint order is ever required — not now.

**Numbers:** `TenantCounter` key `work_item:<projectId>` allocated with `INSERT … ON CONFLICT (tenant_id, key) DO UPDATE SET value = tenant_counter.value + 1 RETURNING value` inside the item-creation transaction; human key = `Project.key-number`. Gaps acceptable (DATA_MODEL §9 says so for non-legal numbers).

**State machine** lives in `states.ts`, invoked from every entry point (drag, inline edit, palette, bulk, triage, import): sets `stateCategory`, stamps `startedAt`/`completedAt`, clears on regression, runs parent rollup if project flags are on, writes `WorkItemActivity`, and dual-writes catalogued audit events.

**Rollups (work):** progress % = `count(DONE) / count(all − CANCELLED)` per parent/milestone/project — flat `GROUP BY root_id` / `milestone_id` queries over the denormalised columns; recursive CTE only in the subtree pane of one item (bounded depth 2). No `RollupCache` table until a real tenant exceeds ~10k open items.

**Permissions (module `work`, 17):** `work_item:view` CMAE · `work_item:create` CMAE · `work_item:edit` CMAE (scope-checked; employees only inside assigned projects) · `work_item:delete` CM · `work_item:change_visibility` CMA · `work_item:triage` CME · `workflow:manage` CMA · `label:manage` CMA · `comment:create` CMAE · `comment:edit_any` CM · `comment:delete` CM · `comment:change_visibility` CMA · `project_update:view` CMAE · `project_update:create` CME · `project_update:publish` CM · `project_update:change_visibility` CMA · `project_template:manage` CMA. Bump `catalog.test.ts` (63 → 80) and `TEMPLATE_VERSION` → 2 (B3 additive propagation with audit).

**Audit events:** `work_item.created`, `work_item.deleted`, `work_item.state_changed`, `work_item.visibility_changed`, `work_item.triaged`, `work_item.archived`, `work_item.bulk_edited`, `comment.deleted`, `comment.visibility_changed`, `workflow.changed`, `project_template.applied`, `notification.preference_changed`, `search.index_rebuilt`.

**Screens:** `/my-work` (new home; assigned/overdue/next-7 + inbox), `/projects/[key]/backlog`, `/projects/[key]/board`, `/projects/[key]/items/[number]` (side-peek + full page), `/projects/[key]/settings/workflow`, `/inbox`, `/search`, ⌘K palette, universal `<WorkItemView>` (filters/group/order/layout via `nuqs` URL state — no `SavedView` table in v1). Pragmatic DnD desktop-only; "Move to…" keyboard/mobile twin; optimistic `useOptimistic` + Server Actions; freshness by 12 s version-poll + focus refresh.

**Seams reused:** `withTenant` (all writes), `requireAccess` (gates 1–3 for `work`), `assertInScope`, `record`, `TenantCounter`, `Document/FileVersion/FileObject` with `AttachableType += WORK_ITEM, COMMENT, PROJECT_UPDATE` (attachments forced INTERNAL unless the parent is CLIENT_VISIBLE), `Visibility` + portal_gate written now and exercised by the data-layer test before any portal UI exists.

**Tests:** isolation (DMMF auto-covers 15 new tables); scoping (employee with one project sees only that project's items; out-of-scope item → 404); file visibility (attachment on INTERNAL item invisible to contact principal); escalation (employee cannot `work_item:delete`, `change_visibility`; catalog × template deny matrix regenerated); feature: rank uniqueness under 50 concurrent moves; parent/child visibility guard; depth/type triggers; state-category denormalisation stays in sync; per-project number monotonic under concurrency; contact principal sees only CLIENT_VISIBLE items in enabled-portal projects (portal_gate) and never a label/link/INTERNAL activity row; search lexeme probe (an INTERNAL body word never matches under contact principal); outbox idempotency; notification kind audience test (every CONTACT-audience kind is `clientVisibleOnly`).

---

### Phase 2T — Time, rates, budgets, rollups, progress updates (5 wk)

**Entitlement:** `time`. Preferences: `time.enabled_for_members`, `time.autoStopHours (12)`, `time.nudgeHours (8)`, `time.allowOverlap (false)`, `time.allowEntriesWithoutItem (true)`, `time.durationStyle {hm, clock, decimal}`, `finance.costRates.enabled`, `weekStart`, `showIsoWeek`.

**Models:**

| Model | Design | RLS |
|---|---|---|
| `TimeEntry` | `clientId, projectId, workItemId?, memberId, description?, startedAt timestamptz, stoppedAt timestamptz? (NULL = running), durationSeconds Int?, timezone VarChar(64), localDate date, entryMode {TIMER, MANUAL, DURATION}, source {TIMER, MANUAL, IMPORT, API, OFFLINE_QUEUE}, billable Bool, billRate Decimal(12,2)?, billRateCardId?, costRateCardId?, currency Char(3), rateSource {PROJECT_MEMBER, PROJECT, MEMBER, TENANT, MANUAL, NONE}, invoiceLineId? (P4), retainerPeriodId? (P4), lockedReason {INVOICED, INVOICE_DRAFT, LOCK_DATE, APPROVED, BILLED_EXTERNAL, WRITTEN_OFF}?, lockedAt?, needsReview Bool, reviewReason?, clientEventId?, clientStartedAt?, skewMs?, createdBy, deletedAt?`. **SQL:** `CREATE UNIQUE INDEX time_entry_one_running ON time_entry (tenant_id, member_id) WHERE stopped_at IS NULL AND deleted_at IS NULL;` `CHECK ((stopped_at IS NULL) = (duration_seconds IS NULL))`; `CHECK (stopped_at IS NULL OR stopped_at >= started_at)`; unique `(tenant_id, member_id, client_event_id)` partial; trigger `time_entry_lock_guard` BEFORE UPDATE/DELETE: raise when `OLD.locked_reason IS NOT NULL` unless `current_setting('app.time_lock_bypass', true) = 'on'` (set transaction-locally only by the invoicing service, always with an audit row); no EXCLUDE (overlap policy is a tenant toggle → app check under `pg_advisory_xact_lock(hashtext(tenant_id||member_id))`). Indexes `(tenantId, memberId, startedAt DESC)`, `(tenantId, projectId, startedAt)`, `(tenantId, workItemId)`, `(tenantId, localDate, memberId)`, partial `(tenantId, projectId) WHERE invoice_line_id IS NULL AND billable`. Never IP/location. Retention: `invoiceLineId IS NOT NULL` ⇒ R1 (member pseudonymised on erasure), else HR class (2 y SE / 3 y US preference). | **A** — the portal never reads rows |
| `RateCard` | `kind {BILL, COST}, scope {TENANT, MEMBER, PROJECT, PROJECT_MEMBER}, memberId?, projectId?, amount Decimal(12,2)? (BILL), amountCiphertext String? (COST, v2 encrypted, AAD rate_card:id:amount), currency, effectiveFrom date, effectiveTo date?, createdBy`. **Rows are immutable** (a change = close old row's `effectiveTo`, insert new) so a card id is a stable snapshot. CHECK kind/amount column pairing; `EXCLUDE USING gist (tenant_id WITH =, kind::text WITH =, scope::text WITH =, coalesce(member_id,'') WITH =, coalesce(project_id,'') WITH =, daterange(effective_from, effective_to) WITH &&)` (btree_gist — verify on Neon before the migration). Prisma `omit: { amountCiphertext: true }` globally; decrypt only in `rates.ts` behind `rate:view_cost`. | A |
| `RoundingRule` | `incrementMinutes, mode {UP, NEAREST, DOWN}, scope {ENTRY, LINE}, minimumBillableMinutes` referenced by `Project.roundingRuleId`; applied at report/invoice time only, raw seconds preserved | A |
| `ProjectBudget` | `clientId, projectId, kind {HOURS, MONEY}, billingModel {T_AND_M, FIXED_FEE, RETAINER, NON_BILLABLE}, amount, currency, period {NONE, WEEKLY, MONTHLY, QUARTERLY, YEARLY}, periodAnchor, includeNonBillable, thresholds Int[], notifyMemberIds, status`; partial unique `(tenant_id, project_id) WHERE status='ACTIVE'` | A |
| `BudgetAlert` | `(budgetId, periodKey, threshold)` unique — once-per-threshold | A |
| `ProjectTimeSummary` | **the only portal time surface**: `projectId, clientId, periodMonth date, billableSeconds, nonBillableSeconds, billableAmount?, budgetSeconds?, budgetAmount?, currency, visibility (derived: CLIENT_VISIBLE iff project.hoursSharingMode ≠ NONE)`; unique `(tenantId, projectId, periodMonth)`; upserted with deltas in the same transaction as every entry write, recomputed nightly (self-heal). Portal reads it under RLS — no system-principal bypass in any portal path. Contains no member ids by construction. | B |
| `StaffNotice`, `StaffNoticeAcknowledgment` | `locale, version, purposes[], jurisdictionTags[]`; ack `(tenantId, memberId, noticeId, noticeVersion)` unique; timers refuse to start until acknowledged | A |
| `ProjectUpdate` | `clientId, projectId, seq Int (TenantCounter project_update:<projectId>), health {ON_TRACK, AT_RISK, OFF_TRACK, ON_HOLD, COMPLETE}, title?, periodStart/End?, body Json (sections), portalSnapshot Json (portal-safe: tasks done/total, milestones, versions, hours only when hoursSharingMode allows), status {DRAFT, PUBLISHED, ARCHIVED}, visibility, publishedAt, publishedByMemberId, authorMemberId, editNote?, pdfDocumentId?`; unique `(tenantId, projectId, seq)`; trigger: after `publishedAt` only `status, visibility, editNote, pdfDocumentId` may change. **`ProjectUpdateInternalSnapshot`** (class A, 1:1): `byMember Json, cost Json, budget Json` — per-member hours and cost never sit on a row a contact can select. Internal remarks are INTERNAL `Comment`s on the update. Cadence/reminders (`ProjectUpdateSchedule`) in Phase 5. | B / A |
| `Document.kind {GENERAL, DELIVERABLE, REPORT, EXPORT}` | enum addition; REPORT is where exported timesheets/updates land | — |

**Rate resolution** (`rates.ts`, run on entry create/update when member/project/billable/localDate change, never on read): candidates by `effectiveFrom ≤ localDate < coalesce(effectiveTo,'infinity')`; BILL tier order PROJECT_MEMBER → PROJECT → MEMBER → TENANT; COST MEMBER → TENANT; store `billRate, currency, rateSource, billRateCardId, costRateCardId`. Reprice = audited command `(rateCardId, FROM_DATE|ALL_UNBILLED)` touching only unlocked entries pointing at that card. Cost aggregation: `SUM(duration_seconds) GROUP BY cost_rate_card_id` → decrypt the handful of card amounts in app → multiply. Bill amounts in SQL (`roundedSeconds/3600 × bill_rate`).

**Timer service** (`timer.ts`): `start({workItemId?, projectId, clientEventId?})` — advisory lock on member, stop any running entry (compute duration, resolve rate), insert new, `record('timer.started')`, return both for the undo toast; `stop()`; `events[]` batch endpoint for the offline queue (idempotent by clientEventId, START clamped ±5 min with `needsReview`, never discards time). Cron `*/15`: >8 h → `notify.emit(timer.long_running)`; >12 h → auto-stop + `needsReview` + `timer.auto_stopped`. Budget cron hourly: thresholds → `BudgetAlert` + emit.

**Rollups (time):** per project / epic / item / client, per member and total, date range — flat SUMs over the denormalised `projectId/clientId/workItemId`; the epic subtree Σ uses a bounded CTE over `WorkItem.rootId` (depth ≤ 2 → `WHERE root_id = $1` is a plain index scan, no recursion needed — that is why `rootId` is denormalised).

**Permissions (module `time`, 13):** `time:track` CMAE · `time:view_team` CM · `time:edit_any` CM · `time:delete_any` CM · `time:manage_locks` CA · `time:reprice` CA · `time:export` CMA · `rate:view_bill` CM · `rate:manage_bill` CA · `rate:view_cost` C ✦ · `rate:manage_cost` C ✦ · `budget:view` CM · `budget:manage` CMA. (Catalog 80 → 93.)

**Audit:** `timer.started`, `timer.stopped`, `timer.auto_stopped`, `time_entry.created`, `time_entry.edited_by_other`, `time_entry.deleted`, `time_entry.locked`, `time_entry.unlocked`, `time_entry.repriced`, `time.exported`, `rate_card.created`, `rate_card.closed`, `rate_card.cost_revealed`, `budget.created`, `budget.changed`, `budget.alert_sent`, `staff_notice.published`, `staff_notice.acknowledged`, `project_update.published`, `project_update.archived`, `project_update.visibility_changed`. Metadata never contains a cost amount.

**Screens:** persistent timer pill (layout-level, `GET /api/timer/current`), item-level start/stop, `/time` (My Time week grid + day, manual entry `1h 30m`), `/projects/[key]/time` (by member/total, estimate vs actual, budget bar), `/projects/[key]/money` (finance-gated: revenue/cost/margin), `/projects/[key]/updates` (draft → preview → publish; latest pinned on overview), `/settings/rates`, `/settings/time` (notice + purposes), `/reports/time` (CSV raw + rounded).

**Seams reused:** `withTenant` timeouts raised for batch endpoints; `requireAccess`; `record`; field encryption v2 for `RateCard.amountCiphertext`; `TenantCounter` for update seq; `Document(kind=REPORT)` for exports; `notify.emit`; `withPlatform({type:'system'})` for cron sweeps.

**Tests:** isolation; scoping (member sees own entries always, team entries only with `time:view_team` and inside scope); file visibility (update PDF follows update visibility); escalation (employee cannot read `RateCard`, cost never decrypted without `rate:view_cost` + recent MFA; CSV export omits cost columns unless permitted); feature: two concurrent starts → exactly one running row (partial unique + advisory lock); auto-stop-previous is atomic; lock trigger blocks edit/delete and bypass GUC is transaction-local; rate snapshot stable after card closure; reprice touches only unlocked entries; overlap toggle honoured; `ProjectTimeSummary` equals SUM after random writes (property test) and carries no member id; contact principal reads zero `time_entry` rows and only summary rows of enabled projects; `ProjectUpdate` immutability trigger; `portalSnapshot` forbidden-keys test.

---

### Phase 3 — Client portal (6 wk; PLAN.md Phase 3 as written, plus the work/time projections)

As designed (Contact identity stack, invite-only, rate limits, version sign-off) **plus**: portal capability union additions `portal.work_item.view`, `portal.work_item.comment`, `portal.request.create`, `portal.update.view`, `portal.timeline.view`, `portal.hours.view` (CONTACT_PRIMARY only), profile bundles updated; **contact-writable census** becomes {`Comment`, `WorkItem` (REQUEST insert), `Notification.readAt`, `ProjectVersion` approval columns, `ContinuityOpenRequest`} — the CI census test is updated in the same commit as the policies. Portal projections live in `src/modules/work/portal.ts` and `src/modules/time/portal.ts` with allow-listed selects and a grep-style forbidden-columns test (`billRate, cost*, internalNotes, label, link, assigneeMemberId, WorkItemActivity INTERNAL rows`). Screens: `/portal` (action items: approvals, replies, client-side tasks; then project cards), `/portal/projects/[key]` (health, next milestone, latest update, milestone progress, files, hours widget), shared items list (kanban toggle later), request form, `Client Timeline` = derived UNION of published CLIENT_VISIBLE updates, milestone completions, shipped versions, CLIENT_VISIBLE deliverables/approvals — never `AuditEvent`, never `WorkItemActivity` beyond the portal-safe list. Staff side: "View as Contact" preview reusing the same projection functions under a synthetic contact principal, comment two-mode composer, composer visibility prompt, warning when assigning/mentioning a Contact on an INTERNAL item.

New audit: `portal.request_created`, `portal.comment_created`, `project.viewed_as_contact`. Tests: portal deny matrix as planned + "no INTERNAL fact to a Contact" suite (activity, comment threads with mixed visibility, update snapshots, hours widget when `hoursSharingMode=NONE`), request insert with any other kind/state/visibility rejected by policy, cross-client request read → 0 rows.

---

### Phase 3V — Vault & asset registry (4 wk)

**Entitlement:** `vault`; preferences `vault.stepUpMinutes (10)`, `vault.revealBudgetPerHour (30)`, `vault.shareLinkMaxTtlHours`, `vault.allowPortalCredentials (false)`.

**Models — the split is the design:**

| Model | Design | RLS |
|---|---|---|
| `CredentialItem` | metadata only: `clientId?, projectId?, assetId?, type {LOGIN, SECURE_NOTE, API_KEY, SSH_KEY, DATABASE, SERVER, WIFI, SOFTWARE_LICENSE, OTHER}, name, username?, url?, tags[], notes (non-secret), secretFieldKeys String[], hasTotp, expiresAt?, rotateEveryDays?, lastRotatedAt?, compromisedAt?, archivedAt?, visibility`; CHECK CLIENT_VISIBLE ⇒ clientId; indexes `(tenantId, clientId, visibility)`, `(tenantId, projectId)`, `(tenantId, expiresAt)` | B |
| `CredentialSecret` | 1:1: `credentialId PK, secretCiphertext, totpSecretCiphertext?, version Int`; v2 envelope with AAD `tenantId:credential_secret:credentialId:secret`; **class A** — a contact principal cannot SELECT ciphertext even if the item is CLIENT_VISIBLE; portal reveal goes through `reveal.ts` under a `system` principal that re-checks visibility + share rules and audits | A |
| `CredentialVersion` | last N ciphertexts, class A | A |
| `CredentialAccessGrant` | optional overlay `(credentialId, memberId)`; when any grant exists access is restricted to grantees (checked in service, not RLS) | A |
| `CredentialShareLink` | `credentialId, tokenHash, recipientEmail?, requireEmailVerification, passcodeHash?, includeUsername, includeTotpCode, expiresAt, maxViews (1), viewCount, revokedAt, lastViewedAt`; consumption is one conditional UPDATE + audit row in one transaction under `withPlatform(system)` (no principal); rendered on the portal host route group without a session | A |
| `ClientAsset` | `clientId, projectId?, type {DOMAIN, HOSTING, DNS_ZONE, SSL_CERT, EMAIL, CMS_APP, THIRD_PARTY_SERVICE, LICENSE, CUSTOM}, name, provider?, url?, identifier?, status, expiresAt?, autoRenew?, renewalCost?, currency?, fields Json (zod per type), lastCheckedAt?, checkStatus?, visibility, notes, tags[]` | B |
| `AssetCheck` (RDAP/TLS results), `ExpirationReminderSent (subjectType, subjectId, offsetDays)` unique | cron nightly under system | A |

Reveal path: `POST /api/vault/[id]/reveal|copy|totp` → `requireAccess(credential:reveal)` → `requireRecentMfa(stepUpMinutes)` → reveal-budget check (Upstash) → decrypt one field → `record('credential.revealed')` in the same transaction → return. Prisma `omit` keeps ciphertext out of every list select as belt two. Continuity box seal-time auto-fills its "systems & assets" section from `ClientAsset` (non-secret) — the box stays pointer-only.

**Permissions (module `vault`, 11):** `credential:view` CMAE · `credential:create` CMAE · `credential:edit` CMA · `credential:delete` CM · `credential:reveal` CMAE ✦ · `credential:share` CMA ✦ · `credential:export` C ✦ · `credential:change_visibility` CA ✦ · `asset:view` CMAE · `asset:manage` CMA · `asset:delete` CM. (Catalog 93 → 104.)

**Audit:** `credential.created/updated/deleted/revealed/copied/totp_generated/visibility_changed/shared/share_revoked/share_viewed/exported/rotation_flagged`, `asset.created/updated/deleted`, `expiration.reminder_sent`. Reveal metadata: credential id + field name only.

**Screens:** `/clients/[id]/vault`, `/projects/[key]/vault`, `/clients/[id]/assets`, `/expirations`, share-link page, portal credential-submission form (writes via system principal, forced clientId), offboarding hook: member removal flags credentials they revealed in the last 90 days as "needs rotation".

**Tests:** isolation; scoping (vault follows `MemberClient`); file visibility n/a; escalation (reveal without recent MFA → MFA_REQUIRED; employee cannot share/export; contact principal SELECT on `credential_secret` → 0 rows even for CLIENT_VISIBLE items); feature: AAD mismatch (row id swap) fails decryption; share link view-once under concurrency → exactly one success; reveal budget; export excludes archived/compromised unless asked; DB dump contains no plaintext.

---

### Phase 4 — Money (7 wk; as written, plus the time→invoice bridge)

Additions: `TimeEntry.invoiceLineId` FK + `InvoiceLineTimeEntry` (immutable history), uninvoiced-time queue → invoice draft (rounding rule applied at line creation, both raw and rounded stored on the line's metadata), locking (`INVOICE_DRAFT` on draft, `INVOICED` on issue; release on draft delete or full credit note under `app.time_lock_bypass` with audit), mark billed externally / write off, `Service` renewals as planned; `RetainerPlan/RetainerPeriod/HourBankTransaction` (S — build if Naxdor has a retainer client by then, else Phase 4b). Permissions: `invoice:generate_from_time` CA. Tests: locked entries immutable through issuance and credit; gap-free numbering unchanged.

### Phase 5 — Notifications & intake channels (3 wk; rescoped)

Issue-related scope is gone (absorbed). Remaining: member daily digest + client weekly digest built under the portal role (skip empty), RFC 8058 one-click unsubscribe, Web Push (`PushSubscription`, VAPID, content-free payloads), `ProjectUpdateSchedule` + reminders + "update missing" badge, `ApprovalRequest` generalisation over Document/FileVersion, reply-by-email + email-in (`InboundEmail`) behind entitlement `work.email_intake` and preference. Tests: fan-out respects visibility; digest body built under contact principal cannot contain INTERNAL rows; suppression honoured.

### Phase 6 — Reports (2 wk; as written, plus)

Fixed Recharts set (status donut, per-state, hours by member/project, budget burn), staff "Project health" portfolio table, cycle/lead time from `WorkItemActivity` (data recorded since 2W), PDF exports (`@react-pdf/renderer` in fra1 → R2 → `Document(kind=REPORT)`).

Phases 7–8 unchanged; Phase 7 gains plan gating for `work/time/vault` and Phase 8's export manifest already includes every new entity (standing rule since Phase 2).

---

## 4. Existing PLAN.md items absorbed, reordered, reopened

- **Skip list — Time tracking**: reversed → decision 11 (dated) in OPEN_QUESTIONS.md; DATA_MODEL.md §11 rows "Time tracking" and "Kanban/Gantt tables — no new storage" replaced; PLAN.md gains a **never-list**: idle detection, screenshots, URL/app capture, presence, per-minute heatmaps, leaderboards, geolocation.
- **Phase 5 Issue/IssueComment**: absorbed into `WorkItem(kind=REQUEST)` + `Comment` (2W tables, Phase 3 portal write). `issue:*` codes deprecated, never removed. Portal capability `portal.issue.*` renamed in the union (union is code, not data — safe).
- **Phase 2**: reopened for `Project.key/portalEnabled/hoursSharingMode/billingCurrency`, `Milestone.status/rank`, `Member.timezone/workCountry`, crypto v2, `app.principal_id`, registry subclasses.
- **Phase 3**: grows by the portal projections, request intake, timeline, hours widget, view-as-Contact.
- **Phase 4**: gains time→invoice bridge and locking; DATA_MODEL `InvoiceLine.unit "h"` is the seam it always was.
- **Phase 6**: gains fixed charts + cycle time; the "timeline deliberately not a Gantt" stance holds (CSS-grid timeline of milestones + items; no dependencies).
- **Notification model "v2"** (DATA_MODEL l.1936): pulled to 2W (tables + seam), channels remain Phase 5.
- **Continuity box "pointers not secrets"**: unchanged; vault is a separate module with server-side envelope encryption; SECURITY.md §6 and DPA wording gain "operator can technically decrypt".
- **ARC entries to add:** ARC-15 shadcn/ui; ARC-16 Pragmatic DnD + fractional-indexing server-side rank; ARC-17 freshness = poll + focus refresh (SSE over Upstash later, no sync engine); ARC-18 Tiptap 3 for rich text; ARC-19 Postgres outbox + Vercel Cron Pro for jobs; ARC-20 per-tenant DEK envelope encryption (v2 format).

---

## 5. Founder decisions needed (recommended default in bold)

1. Merge Issue into WorkItem — **yes**; one comment/attachment/activity/notification path.
2. Hierarchy — **Epic → Task → Subtask (depth ≤ 2 from root), Epic optional**; no Feature level.
3. Assignment — **single assignee + collaborators**; time attribution and My Work stay unambiguous.
4. States — **named states inside fixed categories, tenant presets copied per project**; category immutable per state.
5. Time without a task — **allowed with required note** (project-level entries).
6. Overlap — **blocked by default via app check + advisory lock, tenant toggle**; no EXCLUDE constraint (cannot be per-tenant).
7. Cost-rate storage — **encrypted on the immutable RateCard row, entry snapshots the card id**; bill rate snapshotted as plaintext amount on the entry. Cost visible only with `rate:view_cost` + recent MFA.
8. Client hours — **`ProjectTimeSummary` physical projection table (class B), `hoursSharingMode` per project default NONE, CONTACT_PRIMARY only**; never raw entries in a portal path.
9. Vault crypto — **server-side envelope (per-tenant DEK, AAD-bound), secret in a class-A side table**; no E2EE, no per-tenant passphrase; step-up 10 min; MFA required to reveal at all.
10. Portal-visible persistent credentials — **preference default OFF**; share links + client submission on.
11. Sprints — **not in v1**; `Sprint` behind entitlement later, `WorkItemPlacement` only then.
12. Module keys — **three (`work`, `time`, `vault`)**, not eight; notifications/search are core.
13. Phase order — **2W → 2T → 3 → 3V**; alternative (3V before 3) acceptable if Naxdor's vault pain is acute — schema unaffected either way.
14. Vercel Pro — **upgrade before 2W ships** (outbox worker, timer sweeps).
15. Rounding default — **none at tenant, per-project rule applied at invoice**; confirm Naxdor's contract wording.
16. Legal artefacts before Naxdor timers — **staff notice sv/en + acknowledgment, purposes declared (billing/planning/profitability, not evaluation)**; ask a lawyer the MBL 13 § question if any union member.
17. Component library — **shadcn/ui** (ARC-15).

---

## 6. What NOT to build (say it in PLAN.md)

Sprints/velocity/capacity in v1 · custom typed properties · Gantt with dependencies/critical path · dashboard or report builders · WIQL/managed queries · multi-assignee · per-team boards, swimlane rules, hidden board columns · SavedView tables in v1 (URL state) · realtime sync engine / WebSockets (poll + focus refresh) · E2EE vault, browser extension, emergency-access state machine · public no-login portal links, magic links, client push · idle/screenshot/URL/presence/leaderboard capture (**never**) · external search engines / pgvector · GIN indexes under FORCE RLS · task-scoped rate cards · FX conversion inside time reports · AI drafting (JSONB room left, no schema commitment) · a `RollupCache` table before a tenant needs it · a second comment table, a second attachment path, a second notification seam.

The product's differentiator is the *combination* under one RLS-enforced visibility model — not the breadth of any one clone. Every table above is class A or class B with a written policy, every mutation goes through `withTenant → requireAccess → assertInScope → record → emit`, and every portal read hits a projection whose forbidden-columns test lives in the same commit as the feature.
