# Fortleva Work Management — Phased Build Plan (Product & UX perspective)

*Written 2026-08-16 against commit 78b58b5. Companion to PLAN.md; proposes edits to it, does not replace it.*

---

## 0. Thesis in one paragraph

Fortleva should become "the agency's operating system with a client window", not an Azure DevOps clone. Copy ADO's **data model** (generic work item, category-typed states, single rank, hierarchy ≤ 3, field history) and ship **Planner/Linear's surface** (title-only create, inline everything, one board per project, ⌘K, a personal Home). Add the two things none of those tools have and every agency needs: **first-class time** (timer → rate snapshot → budget → rollup per member/team/project/client → invoice line) and a **client portal that is a projection of the same rows** under the existing RESTRICTIVE RLS policy, plus a **per-client vault/asset registry** next to the project. Every one of the founder's asks maps onto one of those four surfaces. The build stays solo-sized by refusing dashboards builders, query languages, sprints-by-default, multi-assignee, custom fields, Gantt dependencies, E2EE, realtime sync engines and any employee-monitoring feature.

The most important product rule, restated for this plan: **the worst bug is a client seeing an internal fact.** Every new table below carries `(clientId, visibility)` or is unreachable from the portal, and every phase ships its "no INTERNAL fact to a Contact" test in the same commit as the feature.

---

## 1. Information architecture

### 1.1 Member app navigation (left rail, collapsible; mobile = bottom tabs Home / Board / Timer / Inbox / More)

| Rail item | Route | What it is | Phase |
|---|---|---|---|
| **Home** (My Work) | `/home` | Assigned to me (overdue / today / next 7 days), running timer pill, "waiting on client", triage count, inbox top-5. The page people open every morning. Replaces `/dashboard` (which becomes the workspace picker only when >1 membership). | 2B |
| **Clients** | `/clients`, `/clients/[id]` (tabs: Overview · Projects · Contacts · Files · Vault · Assets · Time) | Company records; the client card is the parent of everything portal-visible | 2A |
| **Projects** | `/projects`, `/projects/[key]` (tabs: **Board · Backlog · Timeline · Updates · Time · Files · Portal**) | The project is the unit of work; one board per project; tabs are the only "settings dialogs" | 2A/2B |
| **Time** | `/time` (My Time week grid), `/time/team` (manager), `/time/reports` | Timesheets, approvals-lite (locking), time report | 2C |
| **Inbox** | `/inbox` | Grouped notifications, j/k/e/s | 5 |
| **Vault** | `/vault` (tenant-wide credential list, filter by client) | Optional rail item; primarily reached via Client → Vault | 3V |
| **Reports** | `/reports` | Portfolio health table, hours-by-member/project, budget burn, PDF exports, uploaded reports, CrUX | 6 |
| **Settings** | `/settings/*` | Members, roles, workflow presets, labels, rate cards, preferences, i18n, staff notice | 2A→ |
| **View as client** | overlay, per project | Renders the portal projection in the member shell with a red banner | 3 |

Global chrome: **⌘K palette** (search + actions + `KEY-123` jump), **timer pill** in the header (desktop) / above tabs (mobile), **`?` shortcut overlay**, **`C` creates a work item** from anywhere with project defaulted to the current context.

Not in the rail: sprints, dashboards, wiki, people/capacity — they are later, entitlement-gated modules and appear only when enabled.

### 1.2 Portal navigation (Contact)

`/portal` = **Action items** first (approvals, replies, client-owned tasks, credential submission requests), then project cards. `/portal/projects/[id]` = one-screen project page (see §6). `/portal/files`, `/portal/invoices` (P4), `/portal/requests` (P5), `/portal/company`. No board by default; a "Show as board" toggle per project only when the tenant enables `portalShowsKanban`.

### 1.3 Component approach (record as ARC-15)

**Decision:** shadcn/ui-style **copy-in components** under `src/components/ui`, generated for **Tailwind 4 + React 19**, on **Radix primitives** (Dialog, Popover, DropdownMenu, Tooltip, Toast via `sonner`, Command via `cmdk`), plus `lucide-react` icons, `react-hotkeys-hook`, `nuqs` (URL filter state), TanStack Table v9 + Virtual, `@atlaskit/pragmatic-drag-and-drop`, Tiptap 3, Recharts 3, `date-fns` 4. Owned code, zero runtime vendor, EU-neutral (no CDN fonts — self-host Inter or use system stack), fits the self-host bias and the current hand-written Tailwind pages (neutral palette, `rounded border border-neutral-200`, `bg-neutral-900` primary — keep that visual language; shadcn's "neutral" preset matches it almost exactly). Base UI is the fallback if shadcn's Base UI variant is GA and stable at implementation time — verify then, do not decide now. Rejected: Mantine/Chakra (runtime CSS-in-JS/theme engine, fights Tailwind 4), headless-only (too much rebuild for a solo founder), any hosted design-system service.

**UI conventions to write down once (docs/UI.md, new):** density = compact by default; every entity has an `<EntityChip>` (avatar/colour/key); every editable property has a `<PropertyPicker>` popover with a single-key shortcut; every list is a `<WorkItemView>` config; every destructive action confirms inline, not modal; every empty state has one primary action and one sentence; every visibility badge uses the same two tokens ("Private to team" / "Client can see"); no page needs a Save button.

---

## 2. Core interactions (apply to every phase)

1. **Title-only creation.** `C` anywhere, or `+` at top/bottom of any list/column, opens an inline row: type title, Enter creates and opens the next; `⌘⇧Enter` "create another with same properties"; `⌘Enter` create-and-open. No modal forms for work items, time entries, comments or credentials (the credential form is a side panel, not a page).
2. **Inline edit everything.** Click any property → popover picker; single keys when an item is focused: `S` state, `A` assignee, `L` label, `P` priority, `E` estimate, `D` due, `V` visibility, `M` milestone, `T` timer, `X` select, `⌘⇧O` convert checklist item → subtask. Optimistic via `useOptimistic` + Server Action + `refresh()`, rollback toast on error.
3. **Drag with a keyboard twin.** Board and backlog drag via Pragmatic DnD (desktop only), drop indicator + auto-scroll; server computes rank; "Move to…" in the item menu, palette, and mobile long-press sheet. Rank never shown.
4. **Side-peek by default.** Clicking a card opens a right-side peek (URL `?item=KEY-123`); `⌘↵` expands to full page. List ↔ item navigation is instant; no page reload.
5. **⌘K palette.** Recents → item-key jump → per-type capped search (items, projects, clients, contacts, credentials by name only, pages later) → actions with their shortcuts. `>` prefix = actions, `#` = project, `@` = person.
6. **Saved views** = one `<WorkItemView>` component (filters + groupBy + orderBy + layout LIST/BOARD + display props), URL-addressable via `nuqs`; "Save view" writes a `SavedView` row (personal / project / tenant). My Work, Backlog, Board and the portal item list are all this component.
7. **Explicit filters.** Filter chips always visible; "clear all" always one click; never hidden filters (Planner complaint).
8. **Freshness** = version poll 12 s + focus refresh → `router.refresh()`; SSE over Upstash EU later behind a flag. No sync engine.
9. **Empty states with a verb.** Empty board → "Add your first task (C)". Empty client → "Invite a contact / Create a project". Empty timesheet → "Start a timer from any task, or add time (N)". Empty portal → "Nothing shared yet" is *never* shown to a contact — the project card is hidden until `portalEnabled`.
10. **Onboarding (first-run, tenant owner):** locale · timezone · week start · currency · duration style → first client → first project from template → invite team → (optional) import CSV/Trello. Skippable at each step; a sample project ("Fortleva tour") can be seeded and deleted in one click.
11. **Digest not firehose** (Phase 5): notify mentioned + participants only; assignment debounced 2 min; per-item coalescing; one Monday client digest; every email has "why you got this".

---

## 3. Phase plan — integrated with PLAN.md

Execution order (recommended): **1 (finish) → 2A → 2B → 2C → 3 → 3V → 5 → 4 → 6 → 7 → 8.** Numbers stay stable so all docs agree; letters are inserted; Phase 5 moves ahead of Phase 4 because notifications + client requests complete the portal and Naxdor invoices elsewhere until then (founder decision D1). Rough calendar: ~37 weeks to the end of Phase 6, i.e. productization starts around month 9–10, same horizon as the original plan because Phase 4/5/6 shrink through reuse (one Comment table, one attachment path, one notification seam).

Every phase below lists: models · permission codes (`resource:verb`) · audit events (`entity.verb`) · module keys · routes/screens · tests · seams reused · UX acceptance criteria.

### Phase 1 — Foundation (finish the tail, ~1–2 wk)

Not new scope; the pieces later phases block on: R2 presigned PUT/HEAD/commit + quota (Document/FileVersion/FileObject already exist), SES transport behind `mailer`, Upstash rate limiting, `withRequestContext` actually populated in a root wrapper (audit rows currently carry NULL request fields), MFA step-up primitive (`requireRecentAuth(minutes)`) because Phase 3V and every ✦ code need it, and **reconcile the PLAN.md tracker** (tick Phase-1 items, add log rows). Add the `v2.` AAD-bound ciphertext format to the field-encryption service **now** (one-way door before any secret is stored). Vercel Pro upgrade (crons for timers/digests).

### Phase 2A — Core domain + product shell (4 wk)

**Absorbs PLAN.md Phase 2 as written**, minus nothing, plus the app shell that everything after it needs. Materialise the DATA_MODEL.md drafts as-is: `Client`, `Contact` (records only), `MemberClient`, `MemberProject`, `Project` (+ new fields: `key` ≤ 8 chars unique per tenant, `portalEnabled=false`, `billingCurrency`, `defaultBillable`, `leadMemberId`, `updateCadence`, `hoursSharingMode=NONE`, `autoArchiveMonths`), `ProjectVersion`, `Milestone` (+ `status {PLANNED, IN_PROGRESS, PAUSED, COMPLETED, CANCELLED}`, `rank`), `Service`, Document attach UI, export v0. Implement `authorizedClientIds()` union (the TODO at `authorize.ts:99`) and a resource-level `requireAccess(tx, tenantId, actor, code, {clientId|projectId})` that 404s out-of-scope.

**Product shell:** next-intl scaffold (sv+en, lint for literals), `src/components/ui` kit (ARC-15), left rail + header + timer-pill slot + `?` overlay + ⌘K shell (search over clients/projects/contacts only for now), tenant switcher setting `activeTenantId`, `/settings` skeleton, error/loading boundaries, `TenantPreference` UI (locale, TZ, week start, duration style, currency). Adopt `src/modules/<key>` layout for new modules; leave `src/members` where it is.

- Permissions: none new (existing client/project/service/document codes cover it). 
- Audit: `client.created|updated|archived|note_updated`, `project.created|updated|status_changed|archived`, `milestone.created|updated|completed`, `service.*`, `assignment.*` (already in catalog), `preference.changed`.
- Module keys: none (core).
- Screens: `/clients` (table + inline create), `/clients/[id]` tabs Overview/Projects/Contacts/Files, `/projects` (table grouped by client, health column empty until Phase 3), `/projects/[key]` shell with tabs (Board/Backlog empty-state until 2B, Timeline = milestones + versions list, Files), `/settings/{general,members,roles}`.
- Tests: four families for every new model (DMMF-enumerated suite auto-extends); deny-default scoping (employee assigned to 2 of 3 clients sees exactly 2 — at the app layer *and* via portal_gate for CLIENT_VISIBLE rows); Client.internalNotes / Project.repoUrl|hostingNotes|internalNotes absent from every projection (grep test on select allow-lists); export round-trip.
- Seams reused: withTenant/withPlatform, authorize + new scope union, record(), Document/FileObject for client & project files, TenantPreference for all shell prefs, Visibility enum + portal_gate template from the `document` migration for Client/Project/Milestone/ProjectVersion.
- **UX acceptance:** a Naxdor employee creates a client, a project (from the "blank" template), three milestones and uploads a file with the visibility badge visible, in under 3 minutes and without leaving the keyboard except for the file picker; every string is in sv and en; nav shows only what the member may see.

### Phase 2B — Work: items, board, backlog, My Work (4–5 wk) — the daily-value phase

**Reopens** DATA_MODEL.md §11 "Kanban = view over Issue, no new storage" and **absorbs** the planned `Issue`/`IssueComment` into `WorkItem`/`Comment` (Phase 5 keeps only the *intake* semantics). Everything here is member-only; nothing is portal-visible until Phase 3 flips the switch — but the `visibility` column, `clientId` denorm and portal_gate policy land **now** so Phase 3 is UI, not schema.

**Models** (all class B where portal-reachable, tenantId-first indexes, composite FKs, `uuidv7()`):
- `WorkflowState` (projectId, name, color, `category StateCategory {BACKLOG, TODO, IN_PROGRESS, DONE, CANCELLED, TRIAGE}`, rank, wipLimit?, isDefault, definitionOfDone?) + tenant `WorkflowPreset` (name, states JSON) copied at project creation. Category is what the portal and rollups see; names are tenant data, not i18n.
- `WorkItem` (clientId, projectId, `number` from **TenantCounter** key `work_item:<projectId>` → human key `KEY-123`, `type {EPIC, TASK, SUBTASK}`, `kind {TASK, BUG, REQUEST}`, title, description Json + descriptionText, stateId, `priority {NONE, LOW, MEDIUM, HIGH, URGENT}`, assigneeMemberId?, assigneeContactId? (Phase 3), parentId?/rootItemId/depth ≤ 3 (CHECK + trigger), milestoneId?, `rank text COLLATE "C"` (fractional-indexing, unique per project), estimateMinutes?, startDate?, targetDate?, startedAt?, completedAt?, `visibility Visibility @default(INTERNAL)`, triage fields (Phase 5), `source {IN_APP, PORTAL, EMAIL, IMPORT}`, checklistTotal/Done, archivedAt, createdByMemberId). CHECK: `CLIENT_VISIBLE ⇒ clientId`; trigger: child visibility ≤ parent.
- `WorkItemActivity` (field-level history with own `visibility`; feeds Activity tab; separate from AuditEvent), `WorkItemLink {RELATED, BLOCKS, DUPLICATE_OF}`, `Label`/`WorkItemLabel` (tenant-wide, optional project scope), `WorkItemCollaborator`, `WorkItemSubscriber`, `SavedView`, `Favorite`, `ProjectTemplate` (tenantId? null = platform; definition JSON).
- `Comment` (polymorphic: `subjectType {WORK_ITEM, PROJECT_UPDATE, DOCUMENT, FILE_VERSION}`, subjectId, parentId?, author member/contact, body Json + text, `visibility` default INTERNAL, CHECK ≤ subject visibility, editedAt, deletedAt) + `Mention` + `Reaction`. Contact authorship arrives in Phase 3/5.
- Enum extension: `AttachableType` += `WORK_ITEM, COMMENT, PROJECT_UPDATE, CREDENTIAL, ASSET`. Attachments = Document rows forced INTERNAL unless the parent is CLIENT_VISIBLE.
- New `search_index` table (trigger-fed, same tenant + portal_gate policies, custom TS config `fortleva` = unaccent + swedish_stem, STORED tsvector, no GIN — see synthesis §4.6). Landing it here is a one-way door (TS config, collation).

**Permissions** (module `work`, seeding C/M/A/E): `work_item:view` CMAE · `work_item:create` CMAE · `work_item:edit` CMAE · `work_item:delete` CM · `work_item:change_visibility` CMA · `work_item:manage_workflow` CMA (states, presets, WIP) · `label:manage` CMA · `comment:create` CMAE · `comment:delete` CM · `project_template:manage` CMA · `saved_view:manage_shared` CMA. (11 codes; bump catalog test 63→74 and `TEMPLATE_VERSION`.) **Recommendation:** delete the five `issue:*` codes and the `issues` module key in the same migration — they never had a physical resource, so immutability has not attached; record as a one-time exception in AUTHZ.md (decision D2).

**Audit:** `workitem.created|deleted|archived|state_changed|assigned|visibility_changed|parent_changed|bulk_edited`, `workflow.state_created|state_updated|state_deleted|preset_changed`, `label.created|deleted`, `comment.created|deleted|visibility_changed`, `template.created|applied`, `saved_view.shared`. Routine field edits go to WorkItemActivity, not AuditEvent.

**Module key:** `work` (+ `module.work.enabled` preference, `module.work` flag). Preferences: `work.autoStartParent`, `work.autoCompleteParent`, `work.defaultPreset`.

**Screens:** `/home` (My Work); `/projects/[key]/board` (columns = states, group-by assignee/epic/priority/label, soft WIP, card = title/avatar/labels/priority dot/key/checklist n/m/estimate, column count + Σ estimate); `/projects/[key]/backlog` (ordered list, hide-done + group-by-epic toggles, inline add, filter chips, epic rollup columns, bulk-edit bar); item side-peek + full page (properties rail, Tiptap description with checklist, subtasks list, links, attachments, comments, Activity tab); `/settings/workflow`, `/settings/labels`, `/settings/templates`; ⌘K now searches work items and jumps by key.

**Tests:** four families for every table (WorkItem/Comment/Activity/search_index under contact principal return 0 rows until Phase 3 flips visibility); rank uniqueness under concurrent drags (10 parallel moves → no duplicates, order stable); parent-visibility CHECK; depth ≤ 3; TenantCounter allocation race (100 parallel creates → contiguous per project); search_index forbidden-columns + lexeme-probe (an INTERNAL title never appears in a contact search); optimistic rollback (server rejects → UI reverts); keyboard-only creation/move E2E.

**Seams reused:** withTenant for every mutation; `requireAccess(...work_item:*, {projectId})` with the 2A scope union; `record()` for the catalogued events; TenantCounter for keys; Document/FileObject for attachments; Visibility + portal_gate copied from `document`; TenantPreference for rollup toggles.

**UX acceptance (Naxdor daily use starts here):** from Home, a member reaches any assigned item in ≤ 2 clicks; create → assign → move to In progress → done takes < 15 s with keys only; drag on the board reflows in < 100 ms perceived and survives a refresh; nothing on the board requires a modal; a project with 300 items scrolls at 60 fps (virtualised backlog); ⌘K jumps to `NAX-42` in one keystroke sequence; archived Done items are reachable via "show older", never silently gone.

### Phase 2C — Time: timer, timesheets, rates, budgets (3–4 wk)

**Reverses** PLAN.md skip-list "Time tracking — don't build", DATA_MODEL.md §11 line 1932, OPEN_QUESTIONS decision 7 — record as **decision 11** with the *tidsredovisning-not-övervakning* posture written into PLAN.md's never-list.

**Models:** `TimeEntry` (clientId, projectId, workItemId?, memberId, description, startedAt/stoppedAt timestamptz — NULL stoppedAt = running, durationSeconds CHECK-consistent, timezone, localDate, `entryMode {TIMER, MANUAL, DURATION}`, `source {TIMER, MANUAL, IMPORT, OFFLINE_QUEUE}`, billable, `visibility` INTERNAL **always** (portal never reads rows), billRate Decimal(12,2)?, costRateEnc (encrypted, finance-gated), currency, `rateSource {PROJECT_MEMBER, PROJECT, MEMBER, TENANT, MANUAL}`, rate card ids, `lockedReason {INVOICED, INVOICE_DRAFT, LOCK_DATE, APPROVED, BILLED_EXTERNAL, WRITTEN_OFF}?`, needsReview + `reviewReason`, clientEventId unique). Partial UNIQUE `(tenantId, memberId) WHERE stopped_at IS NULL`; optional `EXCLUDE USING gist` for overlaps (btree_gist, verify on Neon). `RateCard` (`kind {BILL, COST}`, `scope {TENANT, MEMBER, PROJECT, PROJECT_MEMBER}`, amount (COST encrypted), currency, effectiveFrom/To). `RoundingRule` (incrementMinutes, `mode {UP, NEAREST, DOWN}`, minimumBillableMinutes) referenced by Project. `ProjectBudget` (`kind {HOURS, MONEY}`, `billingModel {T_AND_M, FIXED_FEE, RETAINER, NON_BILLABLE}`, amount, currency, `period {NONE, WEEKLY, MONTHLY, QUARTERLY, YEARLY}`, thresholds int[] default {80,100}, notifyMemberIds, one ACTIVE per project) + `BudgetAlert` dedupe. `StaffNotice`/`StaffNoticeAcknowledgment` (locale, version, purposes[]) + `Member.timezone`, `Member.workCountry`. `ProjectTimeSummary` is a projection (SQL view / read model), not a table.

**Rate resolution** on write only: BILL PROJECT_MEMBER → PROJECT → MEMBER → TENANT; COST MEMBER → TENANT; snapshot amount/currency/source/cardId; billable=false ⇒ billRate NULL; explicit audited **reprice** command (`FROM_DATE | ALL_UNBILLED`, skips locked). Amounts (`billableAmount`, `costAmount`) are computed in SQL, never stored; only InvoiceLine (Phase 4) freezes money.

**Timer API** (route handlers, Node runtime): `GET /api/timer/current`, `POST /api/timer/start {workItemId?}` (stops the running one in the same tx, returns both for the undo toast), `POST /api/timer/stop`, `PATCH /api/time-entries/:id`, `POST …/split`, `POST …/continue`, `POST /api/timer/events` (offline batch, idempotent by clientEventId, ±5 min skew clamp, never discards time). Cron `*/15`: nudge at 8 h, auto-stop at 12 h → needsReview.

**Permissions** (module `time`): `time:track` CMAE (own timer + own unlocked entries) · `time:view_team` CM · `time:edit_team` CM · `time:lock` CA · `time:export` CMA · `rate:view` CM · `rate:manage` CA · `cost_rate:view` C ✦ · `cost_rate:manage` C ✦ · `budget:view` CMA · `budget:manage` CM · `project:view_profitability` C ✦. (12; catalog → 86.)

**Audit:** `timer.started|stopped|auto_stopped`, `time_entry.created|updated|deleted|split|locked|unlocked|repriced|imported`, `rate_card.created|updated|ended`, `cost_rate.viewed` (aggregate, per session, not per row), `budget.created|updated|threshold_reached`, `staff_notice.published|acknowledged`, `preference.changed` for `time.*`. Metadata never contains rate amounts.

**Module key:** `time`. Preferences: `time.enabled`, `time.purposes[]`, `time.autoStopHours`, `time.allowWithoutWorkItem`, `time.blockOverlaps`, `time.durationStyle`, `finance.costRates.enabled`, `finance.perMemberCostBreakdown`.

**Screens:** header **timer pill** (item title, elapsed, stop; click → jump); `T` on any focused item starts/stops; stop → inline confirm (duration editable, note, billable toggle); `/time` My Time week grid (ISO weeks, Monday, `1h 30m` / `90m` / `1,5` input, copy last week, day view, `N` new entry); `/time/team` (CM: per-member totals by project, date range, lock date, needsReview queue); `/projects/[key]/time` (hours by member and total, estimate vs actual per item, budget bar, per-month sparkline); **Money sub-tab** (finance-gated: revenue/cost/profit/margin, "cost view" behind `cost_rate:view` with step-up); `/settings/rates` (bill cards; cost cards behind ✦), `/settings/time` (purposes, staff notice publish, acknowledgment status). First timer start for each member shows the staff notice (sv/en) and requires acknowledgment.

**Tests:** running-timer race (parallel starts → exactly one open row); auto-stop-previous + undo restores; rate snapshot stability (change card → old entries unchanged; reprice touches only unlocked entries pointing at that card); lock immutability (locked entry rejects edits by owner; admin bypass audited); cost rate never in list selects (Prisma `omit` + grep), never in CSV by default, never in AuditEvent metadata, never portal-reachable (contact principal → 0 rows on time_entry, rate_card, budget); rollup correctness (task → epic → project → client, per member/total, DST/midnight-spanning entries); privilege matrix for the 12 codes × 4 templates; overlap policy; offline batch idempotency.

**Seams reused:** field encryption (`v2.` AAD) for cost rates; withTenant for timer tx; requireAccess with `{projectId}` scope; record(); TenantPreference for every policy knob; MemberProject/MemberClient scoping decides which projects a member may log time to.

**UX acceptance:** starting a timer from Home is one click or one key; the pill is visible on every page and on mobile; a forgotten timer is nudged and never silently discarded; a manager sees per-member and team totals for a project in one screen with a date range; an employee cannot see anyone else's hours; the founder can enter a project bill rate and see cost for the project computed from its tasks per member and total; the staff notice is shown before the first timer and its acknowledgment is recorded.

### Phase 3 — Client portal + sharing (5 wk)

**Absorbs PLAN.md Phase 3 as written** (Contact identity stack, invite, read surfaces, version sign-off, rate limiting, audited downloads) and **adds the sharing surface** the founder asked for. Also introduces `ProjectUpdate` here — the portal centrepiece — instead of waiting for Phase 6.

**Models:** `Contact` gets identity (ContactSession/Account/Verification per DATA_MODEL). `ProjectUpdate` (clientId, projectId, seq, `health {ON_TRACK, AT_RISK, OFF_TRACK, ON_HOLD, COMPLETE}`, title?, period, body Json sections `{SUMMARY, DONE, NEXT, BLOCKERS, DECISIONS_NEEDED, CUSTOM}`, `snapshot` Json v1 (tasks done/total, hours in period/to date/budget, milestones hit, versions shipped — portal-stripped of cost/per-member unless flags), `status {DRAFT, PUBLISHED, ARCHIVED}`, visibility, publishedAt/By, editNote, pdfDocumentId?). `ProjectUpdateSchedule` (cadence, owner, autoDraft, nextDueAt). `ProjectUpdateTemplate`. `WorkItem.assigneeContactId` (client-side tasks, forced CLIENT_VISIBLE). Document gains `kind {GENERAL, DELIVERABLE, REPORT, EXPORT}` and inline approval fields mirroring ProjectVersion. **No new storage for the Client Timeline** — it is a derived UNION (published updates, milestone completions, shipped versions, deliverable versions, approvals). AuditEvent never feeds it.

**Portal capabilities** (hardcoded TS union, AUTHZ.md §8): add `portal.work_item.view`, `portal.work_item.act` (complete a client-owned task, P5 adds comment), `portal.update.view`, `portal.time_summary.view`, `portal.deliverable.approve`. Profiles: CONTACT_PRIMARY all; CONTACT_COLLABORATOR minus time_summary and approvals. Contact-writable census grows by exactly: `WorkItem` (state category of *own-assigned* items only, via service allow-list) and `Document` approval columns — recorded as a reviewed change in TENANCY.md.

**Member permissions:** `project:manage_portal` CM (portalEnabled, hoursSharingMode, kanban toggle) · `project_update:create` CME · `project_update:publish` CM · `project_update:delete` CM · `contact:invite` (exists as `client:manage_contacts`). (4; → 90.)

**Audit:** `portal.enabled|disabled`, `project.hours_sharing_changed`, `workitem.visibility_changed` (bulk variant with count), `update.created|published|archived|corrected`, `contact.invited|activated|suspended`, `portal.viewed_as_contact` (preview), `document.approval_requested|decided`, `portal.file_downloaded`.

**Module keys:** `portal` (exists). Preferences: `portal.defaultTaskVisibility` (INTERNAL, fixed default), `portal.showHoursDefault`.

**Screens (member):** item property `V` visibility with the two-token badge; composer asks visibility on create *when the project has portal enabled*; child inherits parent (tooltip explains); bulk visibility change with confirmation dialog stating count; **Project → Portal tab** = the switch, hours-sharing mode, kanban toggle, "View as client" button, list of contacts and their last login; `/projects/[key]/updates` (list + composer, see §7); "Update missing" badge on project list when cadence is overdue.

**Screens (portal):** see §6.

**Tests:** portal deny-matrix (cross-client, cross-tenant, INTERNAL rows, audience rejection); **"no INTERNAL fact to a Contact"** suite: for every portal projection, a forbidden-column grep (rates, cost, internal notes, non-billable, per-member breakdown, state *names*, assignee member names unless allowed) and a fixture where an INTERNAL child of a CLIENT_VISIBLE parent, an INTERNAL comment on a CLIENT_VISIBLE item, and an unpublished update are all invisible; visibility CHECKs (child ≤ parent) at DB; hours summary respects `hoursSharingMode` and never returns per-member rows; view-as-client renders exactly the portal query set (same functions, asserted by import graph); sign-off recorded once; portal rate limits.

**Seams reused:** the `document` portal_gate template on WorkItem/Comment/ProjectUpdate; withTenant with contact principal; `system` principal brokering for contact-caused writes; Document/FileObject for deliverables and update PDFs; record(); mailer for invites.

**UX acceptance:** a member can tell at a glance, on every item and comment, whether a client can see it; flipping a project to portal-enabled shows a preview *before* the first contact is invited; a Naxdor client logs in and sees one page per project answering "how is it going, what's next, what do you need from me, what did you get" without learning a board; nothing on that page mentions an internal state name, a member's hours, a rate or a cost.

### Phase 3V — Vault & assets (3–4 wk) — new phase

**Reopens** the "pointers not secrets" stance (PROJECT_BRIEF §8, CONTINUITY_BOX.md, DATA_MODEL Project.hostingNotes) — record as **decision 12**: the vault is a product module with server-side envelope encryption; the continuity box stays pointer-only and auto-generates its systems section from ClientAsset. Ship the tests before the UI.

**Models:** `TenantKey` (per-tenant DEK wrapped by root keyring), `CredentialItem` (clientId?, projectId?, assetId?, `type {LOGIN, SECURE_NOTE, API_KEY, SSH_KEY, DATABASE, SERVER, WIFI, SOFTWARE_LICENSE, OTHER}`, name, username, url(s), tags, notes (non-secret), secretCiphertext (v2 AAD `tenant:model:row:field`), secretFields[], totpSecretCiphertext?, expiresAt?, rotateEveryDays?, lastRotatedAt?, visibility INTERNAL, compromisedAt?, archivedAt?), `CredentialVersion` (last N), `CredentialAccessGrant` (optional overlay), `CredentialShareLink` (tokenHash, passcodeHash?, requireEmailVerification, includeTotpCode, expiresAt, maxViews=1, viewCount, revokedAt), `ClientAsset` (`type {DOMAIN, HOSTING, DNS_ZONE, SSL_CERT, EMAIL, CMS_APP, THIRD_PARTY_SERVICE, LICENSE, CUSTOM}`, provider, url, identifier, expiresAt, autoRenew, renewalCost, fields Json zod-per-type, checkStatus, visibility), `AssetCheck` (RDAP/TLS nightly, later), `ExpirationReminderSent` dedupe; Expirations feed is a computed UNION (assets, credentials, services, later contracts).

**Permissions** (module `vault`): `credential:view` CMA (metadata) · `credential:reveal` CMA ✦ · `credential:edit` CMA · `credential:delete` CM · `credential:share` CMA ✦ · `credential:export` C ✦ · `credential:manage_access` CA ✦ · `asset:view` CMAE · `asset:edit` CMA · `asset:delete` CM. (10; → 100.) Employees see assets, not credentials, unless a role clone grants it — deliberate.

**Audit:** `credential.created|updated|deleted|revealed|copied|totp_generated|shared|share_viewed|share_revoked|exported|access_granted|access_revoked|marked_compromised|visibility_changed`, `asset.created|updated|deleted|expiring_notified`, `vault.step_up_required`, `vault.reveal_budget_exceeded`. Metadata never includes secret material or share tokens.

**Module key:** `vault`. Preferences: `vault.stepUpMinutes` (10), `vault.revealBudgetPerHour` (30), `vault.shareLinkMaxTtlHours`, `vault.allowPortalCredentials` (OFF), `vault.allowContactSubmission` (ON).

**Screens:** Client → **Vault** tab (list: name/type/username/url/tags/expiry, masked; side panel with Reveal / Copy as separate buttons and per-field audit hint; TOTP code with countdown; history; share link creator with TTL/passcode/view-once; "needs rotation" badge); Client → **Assets** tab (typed registry with expiry, cost, provider; expiring soon strip); `/vault` tenant-wide list with client filter; **Expirations** widget on Home; portal: `/portal/share/[token]` one-time viewer in the portal shell (no login) and `/portal/submit-credential/[request]` form for contacts (never in comments); step-up dialog reused for all ✦ actions.

**Tests:** ciphertext AAD binding (moving a row's ciphertext to another row/tenant fails to decrypt); reveal requires MFA + recent auth; reveal budget; contact principal 0 rows on credential tables even when CLIENT_VISIBLE unless preference ON; share link view-once atomic under concurrency; token hash only at rest; export requires ✦ and is audited; secret never in search_index (only name/username/url/tags), never in logs (log-scrub test); offboarding sets "needs rotation" on credentials the removed member revealed.

**Seams reused:** field-encryption service (v2 + per-tenant DEK), step-up primitive from Phase 1 tail, Document for credential attachments, portal shell for share viewer, record(), withTenant, TenantPreference.

**UX acceptance:** finding a client's WordPress login from ⌘K takes < 5 s; reveal is one click after step-up and the audit hint tells the member it was logged; sharing a credential with a client produces a link that dies after one view; the Home page tells the founder which domains/certs expire in the next 30 days.

### Phase 5 — Collaboration: intake, client comments, notifications (4 wk) — executed before Phase 4

**Absorbs PLAN.md Phase 5** with `Issue` replaced by `WorkItem.kind=REQUEST` in a `TRIAGE`-category state; `IssueComment` replaced by the Phase-2B `Comment` with the two-mode composer. Module key `issues` → renamed `intake` (decision D2) gating portal request creation and the triage queue.

**Models:** WorkItem triage fields (`triageStatus {PENDING, ACCEPTED, DECLINED, SNOOZED, DUPLICATE}`, snoozedUntil, duplicateOfId, reportedByContactId); `Notification` (receiverType MEMBER|CONTACT, kind from a static catalog with `audience` + `clientVisibleOnly`, class INSTANT|COALESCED|DIGEST_ONLY, params Json ids only, dedupeKey, readAt, snoozedTill), `Subscription {WATCH, PARTICIPATE, MUTED}`, `NotificationPreference`, `EmailOutbox` (SKIP LOCKED worker, idempotencyKey, sendAfter, status), `EmailEvent`/`EmailSuppression` (SNS bounce/complaint), `PushSubscription` (later). `notify.emit()` seam called inside the same withTenant tx as the write.

**Permissions:** `work_item:triage` CME · `notification:manage_tenant_defaults` CA. Portal capabilities `portal.request.create`, `portal.work_item.comment`. (2; → 102.)

**Audit:** `workitem.triaged|declined|marked_duplicate|snoozed`, `notification.preferences_changed`, `digest.sent` (count only), `email.suppressed`, `email.bounced`.

**Screens:** Board/Backlog gain a **Triage** lane/list with Accept/Decline/Duplicate/Snooze single keys; portal `/portal/requests` (create with title/type/attachment, see own requests and category status); item comments get the two-mode composer ("Internal note" default / "Reply to client" in a distinct colour, contact-authored forced CLIENT_VISIBLE, mention warning when tagging a contact on an INTERNAL item); `/inbox` (grouped, j/k/e/u/s, snooze, reason chip, unread badge, 500 cap); `/settings/notifications` (levels, digest cadence/hour, quiet hours); member daily digest; **client weekly digest** built under the portal role, skipped when empty, own List-Unsubscribe.

**Tests:** fan-out respects visibility (INTERNAL comment never notifies a contact; CLIENT_VISIBLE change never emails another client's contacts); every CONTACT-audience kind is `clientVisibleOnly` and rendered under the contact principal (asserted by test that constructs digests with `app.principal='contact'`); outbox idempotency + retry; portal request rate limit; triage transitions; assignment debounce cancels if read within 2 min.

**UX acceptance:** a client files a request in < 30 s and sees its status change without asking; a member's Inbox is empty most mornings and every item in it names why it exists; internal notes are visually impossible to mistake for client replies.

### Phase 4 — Money (6–8 wk) + the time → invoice bridge

**PLAN.md Phase 4 as written** (Contract/Signature, InvoiceSeries/Invoice/InvoiceLine, VAT profiles, pay-now link, BFL) **plus:** uninvoiced-time queue → invoice draft (rounding applied here, both raw and rounded columns in the export), `TimeEntry.invoiceLineId` + immutable `InvoiceLineTimeEntry` history, `lockedReason=INVOICED`, "mark billed externally / write off"; `RetainerPlan`/`RetainerPeriod`/`HourBankTransaction` (carry-over, overage, prepaid packs) with the portal retainer widget (used/remaining/reset date); tidrapport PDF (Document kind REPORT, retention R1) attached to invoices; FX snapshot for SEK totals; CSV fakturajournal export first, Bokio/Fortnox connectors later. Permissions add `invoice:generate_from_time` CA, `retainer:manage` CM. Audit adds `invoice.generated_from_time`, `time_entry.billed_externally|written_off`, `retainer.period_closed`. Portal capability `portal.retainer.view`. Tests add: entries locked at invoice issue and released on credit note; time on a draft is `INVOICE_DRAFT`-locked; rounding never mutates stored seconds.

### Phase 6 — Reports (2–3 wk)

**PLAN.md Phase 6 as written** (uploaded report PDFs, CrUX) **plus** what accumulates naturally: portfolio "Project health" table (health, latest update, % done, hours vs budget, update-missing), fixed charts (status donut incl. late, hours by member/project, budget burn), update/timesheet/timeline PDF export via `@react-pdf/renderer` stored as Document kind REPORT, cycle/lead time from WorkItemActivity (recorded since 2B). No builders. `report:view/upload/delete` codes exist; add `report:view_portfolio` CM.

### Phases 7–8 — unchanged in scope; note the additions they inherit

Phase 7's onboarding wizard uses the Phase-2A first-run flow and project templates; plans gate `work`/`time`/`vault` as entitlements (recommend: `work` in every tier, `time` from mid-tier, `vault` top-tier with the box). Phase 8's continuity box reads ClientAsset (non-secret) for its systems section and points at the vault. Legal package (Phase 6–7 lawyer) gains the MBL 13 § / staff-notice questions.

### Later modules (entitlement-gated, only when a tenant asks)

Sprints (`Sprint`, taskboard, capacity), custom typed properties, calendar layout, Gantt with dependencies (SVAR), Pages/wiki (Tiptap tree, Hudu-style), imports (Trello/Asana/Jira/Toggl CSV via `ImportJob`), Web Push (VAPID, content-free), SSE realtime over Upstash EU, reply-by-email / email-in (SES receiving), timesheet submit/approve workflow, utilisation, RDAP/TLS auto-checks, HIBP, AI-drafted updates.

---

## 4. Which PLAN.md items are absorbed, reordered, reopened

| PLAN.md item | Disposition |
|---|---|
| Skip list "Time tracking — don't build" | **Reversed** → decision 11; replaced by a *never-list*: idle detection, screenshots, app/URL capture, presence, per-minute heatmaps, leaderboards, geolocation, peer-visible timelines |
| Phase 2 core domain | **Kept as 2A**, adds product shell (i18n, UI kit, ⌘K), Project key/portal fields, Milestone status/rank |
| DATA_MODEL §11 "Kanban = view over Issue, no new storage" | **Reopened**: WorkItem/WorkflowState/rank storage in 2B |
| Phase 5 `Issue`/`IssueComment` | **Absorbed** into `WorkItem.kind=REQUEST` + polymorphic `Comment`; module `issues` → `intake`; Phase 5 keeps triage + notifications and moves before Phase 4 |
| Phase 3 portal | **Kept**, gains work-item sharing, ProjectUpdate, action items, hours summary, view-as-client |
| Phase 6 reports | **Kept thin**; ProjectUpdate moved to Phase 3; charts/PDF exports remain here |
| "Timeline deliberately not a Gantt" | **Kept** — Client Timeline is a curated list; Gantt stays a later module |
| "Pointers not live credentials" | **Reopened for the vault module only** (decision 12); continuity box unchanged |
| Notification model v2 | **Pulled into Phase 5** with the outbox (needs Vercel Pro) |
| DATA_MODEL "AI features: none" | Unchanged; auto-drafted updates are deterministic snapshots, LLM later |
| Permission catalog count 63 | Grows to ~102 across phases; each phase bumps `catalog.test.ts` and `TEMPLATE_VERSION` |
| Export manifest rule | Every new entity added per phase (WorkItem, TimeEntry, RateCard (bill only; cost redacted unless ✦), ProjectUpdate, CredentialItem *encrypted export* behind `credential:export`) |

Docs to edit first, in this order: OPEN_QUESTIONS.md (decisions 11–13), PLAN.md (§3 table, phase bodies, skip list, never-list, progress log), DATA_MODEL.md (new §6.x sections + §11 rows), AUTHZ.md (§3.2 rows, §8 capabilities), TENANCY.md (§7.2 contact-writable set), SECURITY.md (§6 v2 ciphertext + vault, §10 retention classes for time, employee-monitoring posture), ARCHITECTURE.md (ARC-15 components, ARC-16 DnD/ordering, ARC-17 realtime = poll, ARC-18 outbox/cron), CONTINUITY_BOX.md (vault relationship).

---

## 5. Key screens (what is on each)

**Home / My Work.** Header row: greeting, timer pill (or "Nothing running — start from a task"). Column 1: *Today* (overdue in red, due today, next 7 days grouped) — each row is a `<WorkItemRow>` with key, title, project chip, state, `T` to start timer. Column 2: *Waiting on client* (client-owned tasks + open approvals + unanswered client replies), *Triage* count per project (P5), *Expiring soon* (P3V), *Inbox* top-5 (P5). Footer: "This week: 23 h 40 m logged · 6 h today". Nothing about other members' time.

**Project → Board.** Column headers = state name + count + Σ estimate + WIP badge; toolbar = filter chips, group-by, display options, saved-view picker, "+ Task"; card as in 2B; running-timer badge on the card being timed; keyboard focus ring and `Move to…`. Group-by-assignee turns columns into people (this is the "team" view; no capacity numbers).

**Project → Backlog.** Virtualised ordered list; epics as collapsible groups with rollup columns (progress bar by category, count, Σ estimate, Σ logged); inline add at top and bottom; drag handle; multiselect bar (state, assignee, label, priority, milestone, visibility, archive).

**Item peek / page.** Left: title (inline), description (Tiptap with checklist, paste-to-upload), subtasks (inline add), links, attachments, comments (two-mode composer from P5) / activity toggle. Right rail: state, assignee, priority, labels, estimate & logged (with "Start timer"), dates, milestone, parent, visibility badge with switch, watchers, key + copy link.

**Project → Time.** Range picker; totals strip (logged, billable, estimate remaining, budget bar); table by member (rows) × week (cols) with totals; table by item; "Money" sub-tab finance-gated. Export CSV (raw + rounded).

**Project → Updates.** Latest update pinned (health chip, sections, metrics), list of prior updates, "New update" (see §7), schedule settings (cadence, owner, auto-draft), "Update missing" banner.

**Project → Portal.** Master switch; what the client sees (checkboxes: task list, kanban, hours mode, updates, files, milestones); contacts + last login + invite; **View as client**.

**Client → Overview.** Company card, active projects with health, primary contacts, hours this month (manager), open requests, upcoming expirations, latest updates across projects.

**Time → My Time.** Week grid (projects/items × days), keyboard entry, copy last week, per-day totals, needsReview banner, lock indicators with reasons.

**Settings → Workflow / Labels / Rates / Templates / Time / Notifications** — plain forms, each on one page, no wizards.

---

## 6. The client portal project page (what a Contact sees and can do)

One screen, top to bottom, all category-level:

1. **Header:** project name, health chip (from latest published update, or none), "Phase: *Design* · Next milestone: *Launch* due 12 Sep", progress bar (milestones done / total, or manual % if the tenant prefers).
2. **Your action items:** approvals pending (versions/deliverables), tasks assigned to you (with a *Done* button — the only state change a contact can make), questions awaiting your reply, credential submission requests. Empty → section hidden.
3. **Latest update:** health, period, sections (Summary/Done/Next/Blockers/Decisions needed) exactly as authored, metrics the tenant chose to include (tasks done, milestones hit, hours used vs included if `hoursSharingMode ≠ NONE`), attachments, "See all updates".
4. **Timeline:** curated list (updates, milestone completions, shipped versions with release notes, published deliverables, approvals) — a list, not a Gantt.
5. **Shared tasks** (only if enabled): list grouped by category (*Planned / In progress / Done*), title, due date, optional assignee *name* only if the tenant allows, no estimates, no internal state names, no priority unless shared; optional board toggle.
6. **Files & deliverables:** client-visible documents with versions, download (audited), approve/request changes on deliverables.
7. **Hours & retainer** (opt-in, CONTACT_PRIMARY only): billable hours this period vs included/budget, remaining, reset date; per-task hours only if mode allows; never rates, cost, per-member.
8. **Requests** (P5): create, list with category status and replies.

What a Contact can *do*, exhaustively: view the above; approve/request changes on versions and deliverables; complete a task assigned to them; comment (P5, forced CLIENT_VISIBLE); create a request (P5); download files; submit a credential via a form (P3V); view a one-time share link. Nothing else — no editing tasks, no timers, no seeing members' workloads.

Rendering rule: every widget on this page reads through the portal projection functions that the "View as client" preview also uses; the same functions are what the forbidden-columns tests grep. State *names* are mapped to category i18n labels server-side; the state table is never selected.

---

## 7. Progress-report (ProjectUpdate) authoring flow

1. **Trigger:** manual "New update" on the Updates tab, the "Update missing" banner, or the schedule cron creating a **draft** with the snapshot pre-filled (deterministic: tasks done in period, milestones hit, versions shipped, hours in period/to date, requests closed).
2. **Composer (side-by-side):** left = health picker (five values, human-chosen, never computed), title, sections with templates ("What we did / What's next / Blockers / Decisions needed"), a "Changes since last update" panel the author can pull items from (done tasks, shipped versions) into the sections with one click; right = the metrics card with per-metric include toggles (hours, budget, tasks, milestones) — cost and per-member breakdown are not togglable into a client-visible update.
3. **Visibility & audience:** update defaults to INTERNAL; toggling to "Client can see" shows the exact portal rendering below the composer (same projection), and the notify picker (which contacts get an email; digest-only option) (P5).
4. **Publish:** freezes the snapshot, assigns `seq`, sets `publishedAt`, records `update.published`; 15-minute grace for edits, then correction note only; archive instead of delete. Optional "Export PDF" stores a Document (kind REPORT, CLIENT_VISIBLE if the update is) so the client's Files tab and the timeline both show it (P6).
5. **Cadence:** per project (none/weekly/biweekly/monthly), owner, reminders at +1/+2 working days, badge on the project list, weekly digest to the client includes the latest published update.

---

## 8. Founder decisions needed (recommended defaults)

| # | Decision | Default |
|---|---|---|
| D1 | Execution order: Phase 5 (collab/notifications) before Phase 4 (money) | Yes — completes the portal; Naxdor invoices elsewhere until P4 |
| D2 | Retire the five unused `issue:*` codes + `issues` module key in favour of `work` + `intake` (one-time exception to code immutability, before any tenant data) | Yes, record in AUTHZ.md |
| D3 | Merge Issue into WorkItem (`kind=REQUEST`, TRIAGE state) | Merge |
| D4 | Hierarchy Epic → Task → Subtask, single assignee + collaborators, hours as estimate unit, ~5 states in fixed categories | As stated |
| D5 | Time without a work item allowed (project-level with required note) | Allow |
| D6 | Timer policy: one running per member, auto-stop-previous with undo, nudge 8 h, auto-stop 12 h, overlaps blocked (toggle) | As stated |
| D7 | Rate tiers BILL project-member > project > member > tenant; COST member > tenant; snapshot on entry; single currency per project; no task rates | As stated |
| D8 | Who sees money: employee own hours; manager hours + bill rates + budgets; owner/finance ✦ cost + margin; cost encrypted, never in CSV by default | As stated |
| D9 | Client hours sharing per project `NONE / HOURS / BILLABLE_AMOUNT`, CONTACT_PRIMARY only | NONE default; schema in 2C, UI in 3 |
| D10 | Vault = server-side envelope encryption (per-tenant DEK, AAD), MFA to reveal, 10-min step-up window; no E2EE; portal-persistent credentials OFF by default | As stated; update SECURITY/CONTINUITY docs |
| D11 | Rounding: store seconds; tenant default none; per-project rule applied at report/invoice | Confirm Naxdor contract wording |
| D12 | Vercel Pro now (outbox, timer cron, digests) | Upgrade before 2C ships |
| D13 | Component approach ARC-15 (shadcn-style copy-in on Radix + Tailwind 4) | Yes; Base UI only if GA at build time |
| D14 | Legal artefacts before Naxdor timers: sv/en staff notice + acknowledgment, purposes (billing/planning/profitability, not performance evaluation), MBL 13 § check, US notice for NY/CT/DE | Do it; one lawyer question added to the Phase 6–7 list |
| D15 | Portal item list default OFF per project; kanban toggle later | OFF |
| D16 | Realtime = poll + focus refresh; SSE later; no sync engine | Poll |
| D17 | Sprints, custom fields, Gantt, imports, PWA push, email-in = later entitlement modules | Skip for v1 |

---

## 9. What NOT to build (and why)

- **ADO's configuration surface:** process templates, area/iteration paths, teams-in-project, WIQL, delivery plans, dashboard/report builders, card style rules, per-team board settings. Non-technical agency staff never configure these; a solo founder cannot maintain them.
- **Multi-assignee, 4+ hierarchy levels, custom typed properties in v1.** Each one breaks time/cost attribution or the single `<WorkItemView>`.
- **Sprints/velocity/burndown by default.** Agencies run continuous flow + milestones. Sprint entity later, gated.
- **Any employee-monitoring feature — ever:** idle detection, screenshots, URL/app capture, presence, heatmaps, leaderboards, geolocation, peer-visible timelines. It converts *tidsredovisning* into *övervakning* (DPIA, MBL, US notice statutes) and it is not what agencies want from Fortleva.
- **Public/no-login share links for project pages, magic links, client push notifications.** Leak surface; revisit after contact MFA.
- **E2EE / passphrase vault mode.** Forks every path (search, share, TOTP, submission) and locks out 3-person agencies; server-side with AAD, step-up and audit is the honest, exportable choice.
- **A separate Issue tracker, separate comment tables, separate attachment paths, separate notification paths.** One WorkItem, one Comment, one Document, one `notify.emit()`.
- **External search engines, pgvector, GIN under FORCE RLS, realtime SaaS, Slack/Teams hooks, Novu/Knock, OneSignal.** EU posture and cost ceiling; Postgres FTS in a narrow index is enough at this scale.
- **Full Gantt with dependency scheduling.** Timeline is a curated list; Gantt only as a later module if a tenant maintains dependency graphs.
- **Modal forms for tasks/time/comments; Save buttons; hidden filters; silent auto-archive.** These are the exact things people hate about Jira/ADO/Planner.

---

## 10. Cross-phase seam reuse (summary)

- **withTenant / withPlatform:** every mutation and read; timer, reprice, publish, reveal are single transactions; crons use `withPlatform({type:"system", job})` with per-tenant re-entry into `withTenant`.
- **authorize / requireAccess (four gates):** new module keys `work`, `time`, `vault`, `intake` added to `MODULES` + `entitlementsSchema` + `module.<key>.enabled` preference; resource-scoped variant lands in 2A and is used by every later code.
- **audit.record():** every event listed above is a catalog entry; routine field edits go to WorkItemActivity, so AuditEvent stays privileged-ops.
- **Visibility enum + RESTRICTIVE portal_gate:** copied from the `document` migration onto WorkItem, Comment, ProjectUpdate, Document(kind), ClientAsset, CredentialItem, search_index; TimeEntry/RateCard/Budget/Notification(member) get `portal_deny`.
- **Document / FileVersion / FileObject:** attachments (AttachableType extension), deliverables, update PDFs, tidrapport PDFs, credential attachments, exports.
- **TenantCounter:** `work_item:<projectId>` keys; ProjectUpdate `seq` per project.
- **Field encryption:** `v2.` AAD format for cost rates, credential secrets, TOTP seeds, push keys; per-tenant DEK table.
- **TenantPreference:** every policy knob (rollup rules, timer limits, duration style, sharing defaults, vault step-up, digest cadence) — nothing Naxdor-specific in schema.
- **Mailer / outbox:** existing `send()` seam becomes the outbox worker's transport; digests rendered with next-intl `createTranslator`.

Total new permission codes ≈ 39 (63 → ~102), new module keys 3 (+1 rename), new tables ≈ 35 across 2B–5, all inside the existing conventions — which is what makes the plan buildable phase by phase, mostly autonomously, with the founder brainstorming at each phase boundary rather than inside it.
