# Fortleva Work Management — Research Synthesis

*Synthesis of 14 research tracks (ADO, Planner, Linear/Plane-class UX, agency-ops suites, time-tracking specialists, client sharing, vault/assets, progress reports, implementation stack, Swedish/US labour-law posture, search, notifications/email, time→invoice bridge, mobile/PWA/imports) plus the completeness critic. Written 2026-08-16 for a solo, EU-resident founder building autonomously with Claude Code.*

---

## 1. Executive summary

**What the best tools actually do.** Azure DevOps, Linear, Plane, Planner-premium and Huly have converged on the same skeleton: one generic work-item record (type, state, single assignee, priority, labels, links, description, comments, attachments, field-level history); states that carry a fixed *category* (backlog/todo/started/done/cancelled) so custom names never break rollups; a parent pointer for hierarchy with progress computed from categories; a board that is a *view* over states (drag = state change + rank change, soft WIP limits, group-by anything); an ordered backlog where position *is* priority (fractional/sparse rank); one universal saved-view abstraction (filters + group-by + order-by + layout + display properties) that renders My Work, backlog, board and portal list; and a personal home ("My Work / My Day / Inbox") that is why individual contributors open the app daily. Time is where they all stop: ADO's Completed Work is a hand-typed number and its #1 marketplace extension (7pace) exists to add a timer; Planner has only estimated effort; Linear/Plane have nothing. The agency suites (Teamwork, Productive, Kimai, OpenProject, Harvest) fill that gap identically: one running timer per person stored as an open row, rate hierarchy resolved *most-specific-wins* and **snapshotted onto each entry**, cost rate kept separate and permission-gated, budgets in hours-or-money with once-per-threshold alerts, entries locked once invoiced. Client sharing converged on Basecamp: private by default, per-item flag with a loud badge, children inherit, comments have their own switch, and a "view as client" preview. Progress reporting converged on Asana/Linear: an immutable status post with a *human-chosen* health signal and *machine-filled* metrics, on a cadence enforced by reminders.

**What "user-friendly" means for a 1–15 person agency** (concretely, from the complaint corpora): latency under ~50 ms perceived (Jira is the most-hated tool for slowness and 200-field forms); title-only creation with no modal; every property inline-editable; drag anywhere with instant optimistic reflow; a ⌘K palette and single-key shortcuts; opinionated defaults with escape hatches (5 priorities, a handful of states, no process-template picker); one place per concept (Project → Board | Backlog | Time | Files | Portal), never per-team settings dialogs; a personal home with a one-click timer; explicit filter chips; digest-not-firehose notifications; explicit archive instead of ADO's silent 183-day disappearance; and nothing that requires a non-technical client to learn a board.

**Product thesis for Fortleva.** Fortleva should *not* be an ADO clone or a Linear clone. Its differentiator is the combination nobody ships in one coherent, small surface: **(a)** ADO's data model with Basic-process UX (Epic → Task → Subtask, category-based states, one board per project); **(b)** first-class time — timer, manual entry, rate cards with snapshots, budgets, per-member/team rollups, cost view — modelled as *tidsredovisning* not *övervakning* (self-reported only, no idle/screenshot/presence capture, deny-default aggregate views); **(c)** a client portal that is a *projection of the same rows* under RESTRICTIVE RLS, showing category-level status, milestones, immutable ProjectUpdates with health, shared documents, an action-items inbox and (opt-in) billable-hours-vs-budget — never internal states, rates, cost or per-member time; **(d)** a per-client vault + asset registry with expirations, sitting *next to* the project (Hudu model), server-side envelope encryption, audited reveal, expiring share links; **(e)** an EU-resident pipeline end to end (Neon FRA, R2 EU, SES eu-central-1, Vercel fra1, Upstash EU) with a durable outbox and one notification seam. The build must stay small: fixed screens instead of query languages and dashboard builders, one WorkItemView component, one Comment table, one notification seam, one search index. Everything larger (sprints, custom typed properties, Gantt dependencies, approvals workflow, E2EE vault, realtime sync engine, AI drafting) is a later, entitlement-gated module.

---

## 2. Feature catalog (MoSCoW)

Tier legend: **M** must (v1 of the Work module unless noted), **S** should (v1.5 / same phase if cheap), **C** could (later phase), **X** skip for v1. Where tracks disagreed the resolved tier and reason are shown.

### 2.1 Work items & hierarchy

| Feature | One-line spec | Tier | From |
|---|---|---|---|
| Generic WorkItem record | One table for tasks, bugs, client requests: title, description (Tiptap JSON + text), state, single assignee, priority, labels, links, attachments, history | M | ADO, Plane, Linear |
| Human key `KEY-123` | Project short key + per-project sequence via TenantCounter; used in palette, comments, search | M | Linear, Plane, Vikunja |
| Hierarchy Epic → Task → Subtask (parentId, depth ≤ 3) | Single parent, acyclic, type ordering enforced by CHECK/trigger; Epic optional and hidden until used | M | ADO (3-level) vs Plane (parentId≤3) vs Planner (bucket+task) → **parentId, depth ≤ 3**: buckets are covered by group-by; 4 levels is enterprise |
| Kind flag TASK / BUG / REQUEST | Kind on the same row; REQUEST = portal-submitted, starts in TRIAGE (replaces the separate Issue entity) | M | Linear triage, Plane intake; resolves the "merge Issue into WorkItem" question |
| Single assignee + collaborators | assigneeMemberId (or assigneeContactId for client-side tasks) + WorkItemCollaborator join | M | ADO/Linear single vs Planner 20 → **single**: unambiguous time/cost attribution and My Work; subtasks when several people share |
| Checklist inside description + convert to subtask | Tiptap taskList nodes; done/total counters denormalised on save; ⌘⇧O converts items to subtasks | M | Linear, Planner (checklist beloved) vs Planner-track ChecklistItem table → **in-description**: fewer tables, subtasks cover assign/time |
| Typed links | RELATED, BLOCKS/BLOCKED_BY (acyclic), DUPLICATE_OF; reverse derived | S | ADO, Linear, Plane |
| Priority enum NONE/LOW/MEDIUM/HIGH/URGENT | Bar glyph, P0–P4 keys | M | Linear, Plane |
| Labels tenant-wide with per-project subset, colour palette | Label(tenantId, projectId?, parentId?, name, color); creation permissioned | M | Planner (per-plan scoping is a complaint), Plane |
| Estimates in hours (+ optional remaining) | estimateMinutes on Task/Subtask; points scale later behind preference | M | ADO, Huly, Solidtime |
| Start/target dates, completedAt | Date columns; completedAt stamped from category transition and cleared on regression | M | ADO Activated/Resolved dates |
| Parent-state rollup rule | any child started → parent In Progress; all children done → parent Done; per-project toggle; implemented in domain service (fires from every entry point) | S | ADO (documented half-implementation) |
| Field-level activity/revision history | WorkItemActivity(field, old, new, identifiers, actor); powers Activity tab, cycle/lead time later | M | ADO History, Plane IssueActivity, Planner Changes pane |
| Archive/restore instead of hidden time cliff | archivedAt; Done column shows last 14 days + "show older"; auto-archive rule per project | S | ADO 183-day complaint, Plane archive_in |
| Bulk edit / multiselect | X / shift-click → floating bar (state, assignee, label, priority, visibility) | S | Linear, Plane |
| Custom typed properties | Property/PropertyOption/PropertyValue | C | Plane EE, Focalboard, Planner premium |
| Recurring tasks | clone-on-completion with rule JSON | C | Vikunja, Planner, Kanboard |
| Dependencies with auto-scheduling / critical path | FS/SS/… scheduling engine | X | Planner premium; agencies don't maintain graphs |
| Delivery Plans, area/iteration paths, teams-in-project, process templates, WIQL queries | — | X | ADO enterprise surface |

### 2.2 Backlog

| Feature | Spec | Tier | From |
|---|---|---|---|
| Ordered backlog, position = priority | fractional-indexing string rank per item within project; drag, move-to-top/bottom/position; rank never exposed as a field | M | ADO Stack Rank, Planner order hints |
| Hide done by default; "show done" + "group by epic" toggles only | Two toggles, not ADO's six | M | ADO |
| Rollup columns on epics | progress %, count, Σ estimate, Σ time | S | ADO portfolio backlog |
| Filter bar (text, assignee, label, type, epic, state, due) with visible chips | Client-side over loaded slice + URL state | M | ADO, Planner (invisible filters complaint) |
| Inline add at top/bottom, Enter creates next | — | M | ADO, Trello, Linear |
| Triage/intake queue | Portal REQUESTs and email-in land in TRIAGE with Accept/Decline/Duplicate/Snooze single keys; triage responsibles notified | M | Linear, Plane |
| Sprint/iteration entity | Sprint(name,start,end,goal) + taskboard | C | ADO, Plane cycles → agencies run continuous flow; entitlement later |
| Capacity per member per sprint | — | C | ADO |
| Velocity/forecast | — | X | ADO |

### 2.3 Board (kanban)

| Feature | Spec | Tier | From |
|---|---|---|---|
| Columns = states 1:1 (one board per project) | No hidden Board Column/Lane fields; rename/add states inside categories | M | ADO (hidden-field confusion), Plane |
| Drag = state + rank; optimistic; drop indicator + auto-scroll | Pragmatic DnD; server computes rank | M | ADO, Linear |
| Group-by assignee/epic/priority/label as alternative columns | Same board component | M | Planner (5 group-bys), Linear |
| Soft WIP limit per column (red header) | Int on state row | S | ADO |
| Card = title, avatar, labels, priority dot, key, checklist n/m, estimate/spent, running-timer badge | Fixed sensible card + tag colours; no style-rule builder | M | ADO card customization → defaults only |
| Column header count + Σ estimate | — | S | Linear, Plane |
| Live freshness | version-poll 12 s + focus refresh → router.refresh(); SSE over Upstash EU later | M / S | ADO live taskboard, implementation track |
| Keyboard "Move to…" and palette equivalent | Required a11y path (Pragmatic ships no keyboard drag) | M | Atlassian guidance |
| Mobile: single-column list with state chips, no drag | Pragmatic touch unreliable (GH #93) | M | Mobile track |
| Swimlanes with rules, split Doing/Done, Definition of Done tooltip | — | C | ADO |
| Card style rules, annotations | — | X | ADO |

### 2.4 Views / queries / filters

| Feature | Spec | Tier | From |
|---|---|---|---|
| Universal `<WorkItemView>` (filters + groupBy + orderBy + layout LIST/BOARD + display props) | Renders My Work, backlog, board, portal list; per-member last-used settings persisted | M | Plane IssueView, Linear custom views |
| Saved views (personal/project/tenant) with favourites | SavedView + Favorite tables | S | Linear, Plane |
| My Work home | Assigned to me (due today/overdue/next 7), running timer, inbox top-5, triage count | M | Planner My Day/My Tasks, ADO Work Items hub |
| Calendar layout | by due/start | C | Planner Schedule, Plane |
| Timeline (milestones + items) hand-built | CSS-grid bars, today marker | S | Linear roadmap |
| Full Gantt (SVAR) | only when dependencies requested | C | Planner premium |
| Managed queries / WIQL / dashboards widget builder | — | X | ADO |

### 2.5 Time tracking & timer

| Feature | Spec | Tier | From |
|---|---|---|---|
| Timer per work item, one running per member, auto-stop-on-start with undo toast | TimeEntry with stoppedAt NULL; partial unique index; server-authoritative timestamps | M | Kimai, Toggl, Productive, OpenProject |
| Persistent timer pill (header desktop / above bottom tabs mobile) | Fed by GET /timer/current; local tick from skew-corrected server start | M | Productive, OpenProject, Asana |
| Stop → inline confirm (adjust duration, note, billable) | No silent save | M | OpenProject, Harvest |
| Manual entry: duration mode ('1h 30m', '90m', '1,5') and start/end mode; edit own past entries | entryMode DURATION hides fake clock times | M | Harvest, Kimai |
| Week grid (My Time) + Day view; copy last week | — | S | Harvest, Clockify |
| Long-timer nudge at 8 h; auto-stop at 12 h → needsReview | Cron */15 | M | Clockify, Solidtime, Productive |
| Overlap policy: block by default, tenant toggle; split entry action | app check + advisory lock; EXCLUDE btree_gist later | S | Solidtime, Clockify |
| Timezone-correct storage: timestamptz + entry.timezone + localDate; midnight-spanning stays one row | Sweden+US from day one | M | Kimai, Toggl |
| Raw seconds stored; rounding only at report/invoice | Rounding rule per project (increment, mode, minimum) | M | Harvest, Kimai |
| Estimate vs actual on card/item/project | remaining = max(0, estimate − spent) | S | Solidtime, Everhour |
| Offline start/stop queue (IDB, clientEventId idempotent, ±5 min skew clamp, needsReview) | Server reconciliation, never discards time | M (mobile) | Toggl/Clockify complaints |
| Locking: invoiced (Phase 4), lock date, approved | lockedReason enum; admin bypass audited | S | Harvest, Clockify |
| Timesheet submit/approve workflow | — | C | Harvest, Tempo |
| Idle detection, screenshots, app/URL capture, presence broadcast, per-minute heatmaps, geolocation | — | **X (never)** | Legal track: crosses into övervakning |
| Time entries without a work item | Allowed with required note (avoid fake "misc" tasks) — see decision D5 | S | agency-ops track |

### 2.6 Rates, cost & budgets

| Feature | Spec | Tier | From |
|---|---|---|---|
| RateCard effective-dated, kind BILL/COST, scopes | BILL: PROJECT_MEMBER > PROJECT > MEMBER > TENANT; COST: MEMBER > TENANT; task-scoped **not in v1** (Toggl/Clockify disagree on placement → niche) | M | Kimai, Toggl, Clockify, Teamwork |
| Snapshot billRate/costRate/currency/rateSource on entry at write | Amounts derived, never stored | M | Kimai, Solidtime, OpenProject |
| Explicit reprice command (from date / all unbilled), skips locked | Audited | S | Toggl, Solidtime |
| Cost rate = salary-grade confidentiality | finance permission, field-encrypted, never in CSV by default/portal/audit metadata | M | Teamwork, Productive, legal track |
| Billable flag with project default cascade | Non-billable still counts as cost | M | Teamwork, Toggl |
| Currency on every rate/money field; no FX in time reports | Project.billingCurrency governs | M | Naxdor SEK/USD |
| ProjectBudget hours-or-money, T&M/fixed-fee/non-billable, one active per project, threshold alerts once per period | BudgetAlert dedupe table | M | Harvest, Teamwork, Everhour |
| Retainer/hour-bank ledger (RetainerPlan/Period/HourBankTransaction, carry-over, overage, prepaid packs) | Phase 4 | S (P4) | Accelo, Productive, Odoo |
| Project Money tab: budget bar, hours by member, revenue/cost/profit/margin | Finance-gated | S | Teamwork profitability, Productive |
| Overhead per hour, role rates, sub-budgets, utilization report | — | C | Productive, Teamwork |

### 2.7 Rollups, reports & dashboards

| Feature | Spec | Tier | From |
|---|---|---|---|
| Time/cost rollup task → epic → project → client, per member and total, date range | Flat SUM over denormalised projectId/clientId; recursive CTE only for subtree pane | M | Founder ask; ClickUp, Teamwork |
| Progress % by state category on parent/project/milestone | completed / (all − cancelled), segmented bar | M | Linear, Plane, ADO |
| Time report (filters, group-by, billable/non-billable/invoiced, CSV with raw + rounded) | — | M | Teamwork, Harvest |
| Uninvoiced-time queue → invoice draft; mark billed externally / write off | Phase 4 | S | Harvest, Odoo |
| Fixed charts: status donut incl. Late, per-state, per-member, hours by member/project | Recharts, no builder | S | Planner Charts |
| Staff portfolio "Project health" table | health, latest update, % done, hours vs budget, update-missing | S | Teamwork, Linear |
| Cycle/lead time, CFD, burndown | data recorded from day one; charts Phase 6 | C | ADO |
| PDF export (timesheet, update, timeline) via @react-pdf/renderer | stored as Document kind REPORT | S | Harvest, AgencyAnalytics |
| Dashboard widget builder, report builder | — | X | ADO, AgencyAnalytics |

### 2.8 Client sharing & portal

| Feature | Spec | Tier | From |
|---|---|---|---|
| Project.portalEnabled gate | Nothing visible to Contacts until switched on | M | Basecamp, Teamwork |
| Item-level visibility flag, INTERNAL default, permanent badge (members only) | Existing Visibility enum; badge "Private to team / Client can see" | M | Basecamp |
| Inheritance child ≤ parent (DB CHECK); attachments follow parent | 403/tooltip on inheriting items | M | Basecamp API |
| Composer asks at create; warn when mentioning/assigning a Contact on an internal item | — | M | Basecamp CLI issue |
| Comment two-mode composer (internal note / reply to client), contact-authored forced CLIENT_VISIBLE | Distinct colour | M | JSM, Productive |
| View-as-Contact preview | Reuses portal projection queries | M | Teamwork, Productive, Rocketlane |
| Portal home = Action items first (approvals, replies, client tasks), then project cards | — | M | Rocketlane, Copilot |
| Portal project page: health, phase/next milestone, latest update, progress (milestone-based/manual), files, hours (opt-in) | Category-level statuses only | M | SuiteDash, Moxo, Basecamp |
| Portal shared items list; kanban toggle per project | read-mostly | S | SuiteDash, Rocketlane |
| hoursSharingMode NONE/HOURS/BILLABLE_AMOUNT, CONTACT_PRIMARY only, billable time only, never rates/cost/per-member | Aggregate read model | S | Productive, Teamwork |
| Retainer cycle widget (used/remaining/reset date) | Phase 4 | S | HourTab critique, Moxie |
| Client-side tasks (assigneeContactId, auto CLIENT_VISIBLE) | feeds action items + "waiting on client" | S | Copilot, Basecamp |
| Approvals on Document/FileVersion mirroring ProjectVersion inline | ApprovalRequest generalisation later | S | Basecamp Clientside, Rocketlane |
| Templates carry visibility; bulk visibility change with confirmation + audit | — | S | Basecamp; gap nobody fills |
| Weekly client digest (Monday 08:00 tenant TZ) built under portal role | Skip when empty; own List-Unsubscribe | S | Basecamp, monday agencies |
| Public no-login share links, magic links | — | X | leak surface; revisit after contact MFA |
| Portal push, client timers | — | X | — |

### 2.9 Progress reports / status updates / timeline

| Feature | Spec | Tier | From |
|---|---|---|---|
| ProjectUpdate: health (human) + sections + frozen metrics snapshot (machine) | Draft → preview → publish; INTERNAL default | M | Asana, Linear, Teamwork, OpenProject |
| Immutable after 15-min grace; correction note afterwards; archive-only | — | S | Teamwork, Asana |
| Updates tab + latest pinned on overview and project list | — | M | all |
| Client Timeline = curated union (updates, milestones, shipped versions, published deliverables, approvals) — never AuditEvent | derived read model | M | Basecamp Clientside, Linear |
| Update cadence + reminders (+1/+2 working days) + "update missing" badge | cron | S | Linear |
| Auto-drafted update from snapshot when schedule fires | deterministic pre-fill; LLM later | S | Asana Smart Status |
| Update templates per tenant | — | S | Asana |
| Notify picker on publish; comments/reactions on updates | — | S | Teamwork, Linear |
| Recurring report schedules, open/engagement log | Phase 6 | C | AgencyAnalytics |
| Hill charts, team check-ins | — | X | Basecamp |

### 2.10 Assets / documents

| Feature | Spec | Tier | From |
|---|---|---|---|
| Attachments reuse Document/FileVersion/FileObject with AttachableType WORK_ITEM / COMMENT / PROJECT_UPDATE / CREDENTIAL / ASSET / PAGE | forced INTERNAL unless parent CLIENT_VISIBLE | M | existing Fortleva |
| Link attachments (URL + title) | Figma/staging | M | Planner references |
| Paste/drop upload via presigned R2 PUT | Tiptap file-handler | S | Linear |
| Deliverable catalog (Document.kind DELIVERABLE/REPORT) with stacked versions + status chip | — | S | Teamwork Proofs, Filestage |
| Per-client Pages (Tiptap, tree, versions, mentions of vault/assets, tsvector) | Phase 2c/3 | S | Hudu, Outline, Docmost |
| Realtime collab editing | — | X | Docmost |

### 2.11 Credential vault & asset registry

| Feature | Spec | Tier | From |
|---|---|---|---|
| Typed CredentialItem (LOGIN, SECURE_NOTE, API_KEY, SSH_KEY, DATABASE, SERVER, WIFI, SOFTWARE_LICENSE, OTHER) linked to Client/Project/Asset | plaintext searchable metadata; encrypted secret JSON | M | Hudu, IT Glue, 1Password |
| Server-side envelope encryption: per-tenant DEK wrapped by root key, AAD (tenant:model:row:field), v2 ciphertext | not E2EE | M | Infisical, IT Glue Vault lessons |
| Masked by default; Reveal and Copy are separate server calls, audited, MFA step-up (sudo window), reveal budget | — | M | Bitwarden events, Hudu |
| Per-item TOTP (server-generated code, seed never leaves) | — | M | Hudu, IT Glue |
| Permission verbs view/reveal/edit/share/export/admin; member↔client scoping + optional per-item ACL | — | M | Passbolt, Hudu |
| Expiring / view-once share links (passcode, email verify, include TOTP code) rendered in portal shell | token hash only | M | Hudu, 1Password, Keeper |
| Contact submits credentials via portal form (never in comments/email) | — | S | MyGlue |
| Persistent CLIENT_VISIBLE credentials | tenant preference default OFF, two-step confirm | S | Hudu portal |
| Expiry/rotation dates; auto "needs rotation" when a member loses access | offboarding killer feature | S | Passbolt |
| Password generator, HIBP k-anonymity check, secret history, attachments | — | S/C | 1Password, Bitwarden, Hudu |
| ClientAsset registry (DOMAIN, HOSTING, DNS_ZONE, SSL_CERT, EMAIL, CMS_APP, THIRD_PARTY_SERVICE, LICENSE, CUSTOM JSON) | fixed types + custom JSON; layouts later | M | Hudu, IT Glue |
| Unified Expirations feed (assets, SSL, credentials, contracts, services) with 60/30/14/7/1 reminders | computed union + reminder dedupe rows | M | Hudu, IT Glue |
| RDAP + TLS auto-checks nightly, DNS snapshot diff | — | S / C | IT Glue, Hudu |
| Secret-shaped-text nudge in comments ("move to vault?") | — | C | continuity box advisory |
| Browser extension, AD rotation, uptime monitoring, emergency-access state machine, E2EE/passphrase mode | — | X | — |

### 2.12 Notifications / inbox / email

| Feature | Spec | Tier | From |
|---|---|---|---|
| Single `notify.emit()` seam inside the same withTenant() tx as the write | Static kind catalog with audience/class/channels | M | Plane, GitLab |
| Notification (kind + params, i18n at read), Subscription (WATCH/PARTICIPATE/MUTED), NotificationPreference (levels + per-kind JSON) | — | M | Plane, GitLab, Vikunja |
| EmailOutbox (SKIP LOCKED worker, idempotencyKey, sendAfter) + Vercel Cron */2 + after() kick | Requires Vercel Pro | M | outbox pattern |
| SES v2 eu-central-1, two config sets, SNS→webhook for bounce/complaint, suppression list | — | M | AWS SES |
| Own List-Unsubscribe + RFC 8058 one-click for digests | — | M | Gmail/Yahoo rules |
| Assignment debounce 2 min (cancel if read); per-item coalescing 10 min; notify mentioned + participants only | — | M | Planner 2026, Linear |
| In-app inbox (grouped, j/k/e/u/s, snooze, reason chip, unread badge with partial index, 500 cap) | — | M | Linear, Plane |
| Member daily digest; client weekly digest under portal role | — | S | Linear, Basecamp |
| Budget/timer/expiry/approval/update-overdue kinds | dedupeKey per bucket | S | Everhour, Harvest |
| Web Push (VAPID, content-free payload, opt-in) | Phase 5 | S | Next PWA guide, WebKit |
| Reply-by-email, email-in (SES receiving in eu-central-1) | Phase 5 behind entitlement | C | GitLab, Basecamp |
| Slack/Teams hooks, push SaaS (OneSignal/FCM), Novu/Knock | — | X | EU posture |

### 2.13 Team & capacity

| Feature | Spec | Tier | From |
|---|---|---|---|
| Group-by-assignee board / People view with counts + hours | same component | S | Planner People, ADO |
| Manager per-member weekly totals dashboard | opt-in per tenant with purpose declaration + DPIA warning | C | Teamwork; legal track |
| Member timezone, working country, default hours/day | fields on Member | M | legal + time tracks |
| Utilization, capacity per sprint, days-off calendars | — | C | Teamwork, ADO |
| Peer-visible timelines, live "who is working on what" | — | **X (never)** | IMY guidance |

### 2.14 Search / command palette / keyboard

| Feature | Spec | Tier | From |
|---|---|---|---|
| ⌘K palette (cmdk): recents first, item-key jump, per-type capped UNION, actions with shortcuts, type prefixes | debounce 120–150 ms | M | Linear, Plane, Outline |
| Global keymap registry: C S A L P E D X, G-chords, T timer, ? overlay, shortcuts in tooltips | react-hotkeys-hook scopes | M | Linear |
| Narrow `search_index` table (trigger-maintained, same RLS + portal_gate), custom TS config `fortleva` = unaccent + swedish_stem, STORED weighted tsvector | no GIN under FORCE RLS (non-leakproof quals) | M | GitLab, Outline, PG source |
| Search page with facets, ts_headline snippets, trigram zero-result fallback | — | S | Linear, Docmost |
| Forbidden-columns test + portal lexeme-probe test | CI | M | Fortleva test families |
| pgvector/semantic, external engines (Meilisearch/Algolia), pg_search | — | X | EU posture, scale |

### 2.15 Templates / recurrence / import / onboarding

| Feature | Spec | Tier | From |
|---|---|---|---|
| Project templates seeding states, epics, tasks, checklists, estimates, labels, visibility flags; "save project as template" | platform + tenant templates | M | Basecamp, Planner 2026, ADO |
| Work-item templates (prefill) | — | S | Linear, Huly |
| Generic CSV import engine + mapper; Trello JSON; Asana CSV | presigned R2 upload → resumable ImportJob, dry-run, idempotent by sourceId | M | Linear, Plane importers |
| Toggl/Clockify CSV time import | — | S | — |
| Jira CSV, Planner XLSX presets | — | C | — |
| First-run wizard (locale/TZ/week start/currency/duration style → client → project from template → invite → import), empty states, sample project | — | M / S / C | Linear, Basecamp |
| Live API sync with Asana/Jira/Trello, attachment migration | — | X | — |

### 2.16 Platform concerns

| Feature | Spec | Tier | From |
|---|---|---|---|
| Entitlement + TenantPreference gates: work, time, rates, budgets, vault, assets, pages, updates, notifications.email/client_digest/push/reply_by_email, search | four-gate seam | M | standing rule |
| Purpose declaration + staff notice (sv/en) with acknowledgment before first timer; US monitoring notice; DPIA-lite checklist | AuditEvents | M | IMY, MBL, NY/CT/DE |
| Permission codes: time:*, rate:*, budget:*, credential:*, asset:*, page:*, project_update:publish, invoice:generate_from_time … (catalog test bumped deliberately) | — | M | — |
| Audit catalog additions (timer, rate, budget, credential, visibility, digest, import, notice) | — | M | — |
| Retention classes: invoiced TimeEntry R1 (BFL 7 yr, pseudonymize member), un-invoiced HR class (2 y SE / 3 y US default), cost rates, audit IP 90 d | SECURITY.md §10 | M | legal track |
| sv+en i18n: state *categories* translated, state *names* tenant data; ISO week numbers, Monday start, decimal comma, duration style pref | — | M | mobile/i18n track |
| Test families extended: running-timer race, rate snapshot stability, lock immutability, rank uniqueness under concurrency, portal projection forbidden columns, no INTERNAL fact to a Contact, search probe | CI | M | — |

---

## 3. UX principles

1. **Latency is a feature.** Every mutation is optimistic (`useOptimistic` reducer + Server Action + `refresh()`), rolls back with a toast; list ↔ detail navigation is instant via side-peek; no local-first sync engine.
2. **Title-only creation, never a modal form.** `C` or inline "+" creates with a title; Enter creates the next sibling; ⌘⇧Enter "create another with same properties"; everything else is set inline afterwards.
3. **Every property is inline-editable via popover pickers** (S state, A assignee, L label, P priority, E estimate, D due, V visibility). No Save buttons.
4. **Drag anywhere with instant reflow and a keyboard twin.** Drop indicator line + auto-scroll on desktop; "Move to…" menu in the palette and on mobile; rank computed server-side; drag never rewrites the whole list.
5. **One board per project, columns are states, position is priority.** Rename/add states freely inside categories; portal only ever sees category names.
6. **One universal view component** for My Work, backlog, board, portal list — filters remove rows, display options hide chips; views are URL-addressable and saveable.
7. **⌘K first, single keys second, shortcuts shown everywhere** (tooltips, palette rows, `?` overlay); item keys `NAX-142` jump directly.
8. **My Work is the home page**: assigned/overdue/next-7 + running timer + inbox + triage count. Project pages are for planning; the timer must be one click from home.
9. **The timer is a personal tool**: persistent pill, one tap to stop, auto-stop-previous with undo, forgotten-timer nudge; manual entry accepts `1h 30m`; raw seconds preserved; rounding shown only in reports/invoices with both columns.
10. **Visibility is loud, explicit, inherited, and previewable**: badge on every item, composer asks, children follow parents, comments have a two-mode composer, "View as client" before inviting; warn when a Contact is mentioned on something internal.
11. **Progress = human health + machine numbers**, immutable once published, on a cadence enforced by reminders; the client sees a one-screen overview and an action-items inbox, not tabs.
12. **Digest, not firehose**: notify mentioned + participants, debounce assignment, coalesce per item, one Monday client digest, skip empty digests, "why you got this" line with a link to that preference.
13. **Opinionated defaults with escape hatches**: 5 priorities, ~5 states, hours as estimate unit, single assignee, depth ≤ 3; no template/process picker at project creation beyond "pick a project template".
14. **Explicit over silent**: archive/restore instead of vanishing items; visible filter chips; locked entries explain why; rate changes ask "from today / date / all unbilled".
15. **Cost is sensitive**: employees see hours, managers see bill rates, finance sees cost; nothing per-member ever reaches the portal; no presence, activity or leaderboard UI anywhere.

---

## 4. Domain / data-model recommendations

All tenant tables follow existing conventions: `tenantId` first in composite keys, `(tenantId,id)` composite FK targets, forced RLS with tenant policy + RESTRICTIVE portal policy on `(clientId, visibility)`, `uuidv7()` PKs on hot tables, `clientId` denormalised wherever a portal path exists. Existing entities referenced: **Client, Contact, Project, Milestone, ProjectVersion, Document/FileVersion/FileObject, Service, Issue, TenantPreference, TenantCounter, AuditEvent**.

### 4.1 Work

**WorkflowState** — `id, tenantId, projectId, name (tenant text, not i18n), color, category enum StateCategory {BACKLOG, TODO, IN_PROGRESS, DONE, CANCELLED, TRIAGE}, rank text, wipLimit int?, isDefault bool, definitionOfDone?`. Constraints: exactly one DONE default per project, one default TODO/BACKLOG. Tenant-level **WorkflowPreset** (`tenantId, name, states JSON`) copied into each project at creation. Portal maps category → i18n label (Planned / In progress / Done).

**WorkItem** — `id, tenantId, clientId (from project), projectId, number int (TenantCounter keyed by projectId; unique (tenantId, projectId, number)), type enum {EPIC, TASK, SUBTASK}, kind enum {TASK, BUG, REQUEST}, title, description Json (Tiptap), descriptionText, stateId, priority enum {NONE, LOW, MEDIUM, HIGH, URGENT}, assigneeMemberId?, assigneeContactId? (mutually exclusive; contact ⇒ CLIENT_VISIBLE), parentId? (self FK; CHECK type ordering EPIC>TASK>SUBTASK; depth ≤ 3 via app + trigger), rootItemId, depth, milestoneId?, sprintId? (nullable, later), rank text COLLATE "C", estimateMinutes?, remainingMinutes?, startDate?, targetDate?, startedAt?, completedAt?, visibility Visibility @default(INTERNAL), triageStatus enum {PENDING, ACCEPTED, DECLINED, SNOOZED, DUPLICATE}?, snoozedUntil?, duplicateOfId?, source enum {IN_APP, PORTAL, EMAIL, IMPORT}, checklistTotal int, checklistDone int, archivedAt?, sourceSystem/sourceId/sourceKey?, importJobId?, createdByMemberId?/reportedByContactId?, timestamps`. Indexes: `(tenantId, projectId, stateId, rank)`, `(tenantId, assigneeMemberId, completedAt)`, `(tenantId, parentId)`, `(tenantId, clientId, visibility)`. **This subsumes Issue**: the existing Issue spec becomes `kind=REQUEST` with `state.category=TRIAGE`; IssueComment becomes the generic Comment.

**Ordering strategy** — single `rank` per item scoped to project (fractional-indexing v4 strings, `COLLATE "C"`). Backlog = all open items by rank; board column = items of that state by rank; a drag within a column recomputes rank between the two column neighbours inside a transaction (`SELECT … FOR UPDATE` on neighbours, jitter, retry on unique `(tenantId, projectId, rank)`), which keeps backlog and board consistent (ADO "maintain backlog order" semantics). Rebalance job when any key > ~50 chars. Add a `WorkItemPlacement(containerType, containerId, workItemId, rank)` table only if independent sprint order is later required.

**State machine** — transitions between states are free (drag), except: TRIAGE→ requires accept (sets default state, clears triage fields) or decline/duplicate (→ CANCELLED-category state); entering IN_PROGRESS stamps `startedAt` (first time), entering DONE stamps `completedAt`, leaving DONE clears it; parent rollup rule per project (`autoStartParent`, `autoCompleteParent`) executed in the domain service; every change writes **WorkItemActivity**.

**WorkItemActivity** — `id, tenantId, workItemId, actorMemberId?/actorContactId?, verb, field, oldValue text, newValue text, oldIdentifier?, newIdentifier?, commentId?, visibility (INTERNAL unless the field is portal-safe: state category, title, target date, client-visible comment), createdAt`. Separate from AuditEvent (which stays privileged-ops); dual-write catalogued events (`workitem.state_changed`, `workitem.visibility_changed`, `workitem.triaged`).

**WorkItemLink** — `(tenantId, sourceId, targetId, type {RELATED, BLOCKS, DUPLICATE_OF})`, one direction stored, acyclic check for BLOCKS. **Label / WorkItemLabel**, **WorkItemCollaborator**, **WorkItemSubscriber** as joins.

**Comment (polymorphic, replaces IssueComment)** — `id, tenantId, clientId?, subjectType {WORK_ITEM, PROJECT_UPDATE, DOCUMENT, FILE_VERSION, PAGE}, subjectId, parentId? (threads), authorMemberId?/authorContactId?, body Json, bodyText, visibility (INTERNAL default; contact-authored forced CLIENT_VISIBLE; CHECK ≤ parent visibility), editedAt, deletedAt`; **Mention** rows extracted on save; **Reaction** unique (commentId, actor, emoji).

**Sprint** (later, entitlement) — `projectId, name, startAt, endAt, goal, status`; `SprintSnapshot(day, remainingMinutes, doneCount)`.

**ProjectTemplate** — `tenantId? (null = platform), name, locale, definition Json {states, epics, items[{title, description, estimateMinutes, checklist, visibility, labels}], recurring}`.

Project additions: `key (≤ 8 chars, unique per tenant), portalEnabled bool default false, portalShowsTasks/portalShowsKanban bool, hoursSharingMode {NONE, HOURS, BILLABLE_AMOUNT}, billingCurrency, defaultBillable, roundingRuleId, updateCadence {NONE, WEEKLY, BIWEEKLY, MONTHLY}, leadMemberId, autoArchiveMonths`. Milestone gets `status {PLANNED, IN_PROGRESS, PAUSED, COMPLETED, CANCELLED}` and `rank`; WorkItem.milestoneId links tasks to the existing Milestone (the agency "phase" unit shown to clients).

### 4.2 Time, rates, budgets

**TimeEntry** — `id, tenantId, clientId, projectId, workItemId?, memberId, description, startedAt timestamptz, stoppedAt timestamptz? (NULL = running), durationSeconds int? (CHECK (stoppedAt IS NULL) = (durationSeconds IS NULL) and = epoch diff), timezone varchar(64), localDate date, entryMode {TIMER, MANUAL, DURATION}, source {TIMER, MANUAL, IMPORT, API, OFFLINE_QUEUE}, billable bool, visibility INTERNAL, billRate Decimal(12,2)?, costRateEnc (encrypted) or resolved-at-read behind finance permission, currency char(3), rateSource {PROJECT_MEMBER, PROJECT, MEMBER, TENANT, MANUAL}, billRateCardId?, costRateCardId?, invoiceLineId?, retainerPeriodId?, lockedReason {INVOICED, INVOICE_DRAFT, LOCK_DATE, APPROVED, BILLED_EXTERNAL, WRITTEN_OFF}?, billedExternallyAt?, writtenOffAt?, needsReview bool, reviewReason {SKEW_CLAMPED, OVERLAP_TRUNCATED, AUTO_STOPPED, STOP_BEFORE_START, DEVICE_CONFLICT}?, clientEventId? (unique per tenant), clientStartedAt?, skewMs?, createdBy, timestamps`. Constraints in hand-written SQL: partial UNIQUE `(tenantId, memberId) WHERE stoppedAt IS NULL`; optional `EXCLUDE USING gist (memberId WITH =, tstzrange(startedAt, coalesce(stoppedAt,'infinity')) WITH &&)` (btree_gist available on Neon; PG18 `WITHOUT OVERLAPS` — verify). Indexes `(tenantId, memberId, startedAt DESC)`, `(tenantId, projectId, startedAt)`, `(tenantId, workItemId)`, `(tenantId, localDate, memberId)`, partial unbilled index. Never store IP/location. Portal never reads raw rows; a **ProjectTimeSummary** projection (billableSeconds, budget used %, per month) is the only portal surface.

**Timer API** — `GET /timer/current`, `POST /timer/start {workItemId?}` (stops running one in same tx, returns both), `POST /timer/stop`, `PATCH /time-entries/:id`, `POST …/split`, `POST …/continue` (new entry), `POST /timer/events` (offline batch: idempotent by clientEventId, skew = serverNow − clientNow, START clamped to ±5 min, STOP may be old, overlaps truncated + needsReview, time never discarded).

**RateCard** — `id, tenantId, kind {BILL, COST}, scope {TENANT, MEMBER, PROJECT, PROJECT_MEMBER}, memberId?, projectId?, amount Decimal(12,2) (COST encrypted), currency, effectiveFrom date, effectiveTo date?, createdBy`. No overlapping validity per (kind, scope, member, project) — app check + optional EXCLUDE.

**Rate resolution algorithm** (run on create/update of an entry when member/project/billable/localDate change, never on read): candidates = cards with `effectiveFrom ≤ localDate < coalesce(effectiveTo,'infinity')`; BILL: first non-empty tier in order PROJECT_MEMBER(projectId, memberId) → PROJECT(projectId) → MEMBER(memberId) → TENANT; COST: MEMBER → TENANT; store amount/currency/source/cardId on the entry; billable=false ⇒ billRate NULL. Reprice = audited command `(rateCardId, FROM_DATE|ALL_UNBILLED)` updating only entries whose resolution points at that card and that are unlocked. Amounts: `billableAmount = round(roundedSeconds/3600 × billRate, 2)`, `costAmount = round(seconds/3600 × costRate, 2)` computed in SQL; only InvoiceLine freezes money.

**RoundingRule** — `tenantId, incrementMinutes {1,6,10,15,30,60}, mode {UP, NEAREST, DOWN}, scope {ENTRY, LINE}, minimumBillableMinutes` referenced by Project; applied at report/invoice time only.

**ProjectBudget** — `id, tenantId, clientId, projectId, kind {HOURS, MONEY}, billingModel {T_AND_M, FIXED_FEE, RETAINER, NON_BILLABLE}, amount Decimal(12,2), currency, period {NONE, WEEKLY, MONTHLY, QUARTERLY, YEARLY}, periodAnchor date, includeNonBillable bool, thresholds int[] default {80,100}, notifyMemberIds, blockOverBudget bool, fixedFeeAmount?, includedHoursCap?, revenueRecognition {ON_INVOICE,…} (stored, only ON_INVOICE reported), status`; one ACTIVE per project (partial unique). **BudgetAlert** `(budgetId, periodKey, threshold, sentAt)` unique for once-per-threshold.

**Phase 4 forward design** — RetainerPlan (includedHoursPerPeriod, interval, carryOverPolicy {NONE, CAPPED, UNLIMITED} + cap/expiry, overagePolicy {BILL_AT_RATE, ALERT_ONLY, BLOCK}, deficitPolicy), RetainerPeriod (state machine SCHEDULED→OPEN→CLOSED→SETTLED, EXCLUDE on daterange), append-only HourBankTransaction (credits/debits; consumption derived from entries), immutable InvoiceLineTimeEntry history alongside `TimeEntry.invoiceLineId`; release on full credit note / draft delete (Odoo semantics, not Kimai's); tidrapport PDF+CSV as Document(kind REPORT, retention R1); FX snapshot (Riksbank SWEA) with SEK totals on non-SEK invoices; CSV fakturajournal export first, Bokio private-token connector v1.5, Fortnox voucher-mode v2, SIE4 behind flag.

### 4.3 Client sharing & progress

**Visibility model** — the existing `visibility` column stays the single truth. Additions: `Project.portalEnabled` gate; DB CHECK child ≤ parent for Comment, WorkItem(parent), Document attached to an item; portal RESTRICTIVE policy = `clientId = app.client_id AND visibility='CLIENT_VISIBLE' AND project.portalEnabled` (or denormalised flag); comment composer two-mode; `hoursSharingMode` + CONTACT_PRIMARY profile for hours; portal projections use allow-listed selects (test greps for forbidden columns: rates, cost, internal notes, non-billable, per-member breakdown unless mode allows names).

**ProjectUpdate** — `id, tenantId, clientId, projectId, seq int (unique per project), health {ON_TRACK, AT_RISK, OFF_TRACK, ON_HOLD, COMPLETE}, title?, periodStart/periodEnd?, body Json {sections[{key SUMMARY|DONE|NEXT|BLOCKERS|DECISIONS_NEEDED|CUSTOM, body}]}, snapshot Json v1 {tasks{done,total,doneInPeriod}, time{hoursInPeriod, hoursToDate, hoursBudget, byMember[]}, cost{toDate,budget} (portal-stripped unless flags), milestones{done,total,hitInPeriod[]}, versions{shippedInPeriod[]}, requests{open,closedInPeriod}, computedAt}, changesSinceLast Json, status {DRAFT, PUBLISHED, ARCHIVED}, visibility, publishedAt, publishedByMemberId, authorMemberId, templateId?, editedAt/editNote, pdfDocumentId?`. **ProjectUpdateSchedule** (cadence, day/time/tz, ownerMemberId, autoDraft, nextDueAt, lastPublishedAt) and **ProjectUpdateTemplate** (sections, metricsIncluded). Health is never computed. **Client Timeline** = derived UNION over PUBLISHED+CLIENT_VISIBLE updates, Milestone completions/dues, ProjectVersion ships/approvals, Document(kind DELIVERABLE|REPORT, CLIENT_VISIBLE) versions, ApprovalRequest decisions; materialise only if slow. AuditEvent never feeds the portal.

**Document additions** — `kind {GENERAL, DELIVERABLE, REPORT, EXPORT}`, inline approval fields mirroring ProjectVersion v1-lite (`approvalStatus, requestedAt, decidedAt, decidedByContactId, note, approvalVersionNumber`; new FileVersion resets to PENDING); AttachableType gains WORK_ITEM, COMMENT, PROJECT_UPDATE, CREDENTIAL, ASSET, PAGE. **ApprovalRequest** generalisation in Phase 5.

### 4.4 Vault, assets, pages

**Encryption choice** — server-side envelope encryption (option "a", hardened), *not* client-side E2EE: **TenantKey**(`tenantId, keyId, wrappedDek, status`) wrapped by the existing root keyring; upgrade the field-encryption service to a `v2.` format with AAD = `tenantId:model:rowId:field` (v1 stays decryptable) — a one-way door to land before any vault data exists. Reveal/copy/TOTP are POST endpoints that decrypt one field and write the AuditEvent in the same transaction, enforce sudo-mode (10-min window default; always step-up for share/export/visibility flip), and a per-member reveal budget (30/h default). Prisma `omit` defaults keep ciphertext columns out of list/detail selects.

**CredentialItem** — `id, tenantId, clientId?, projectId?, assetId?, type CredentialType, name, username?, url?, urls[], tags[], notes (plaintext non-secret), secretCiphertext (JSON of type-specific fields), secretFields[] (keys only), totpSecretCiphertext?, hasTotp, expiresAt?, rotateEveryDays?, lastRotatedAt?, visibility INTERNAL, compromisedAt?, archivedAt?, createdBy/updatedBy`; CHECK CLIENT_VISIBLE ⇒ clientId; portal path only through the reveal endpoint. **CredentialAccessGrant** (optional overlay: when any grants exist access is restricted to grantees), **CredentialVersion** (last N ciphertexts), **CredentialShareLink** (`tokenHash, recipientEmail?, requireEmailVerification, passcodeHash?, includeUsername, includeTotpCode, expiresAt, maxViews default 1, viewCount, revokedAt, lastViewedAt/Ip`; view-once consumed atomically with the audit row).

**ClientAsset** — `id, tenantId, clientId, projectId?, type AssetType, name, provider?, url?, identifier?, status, expiresAt?, autoRenew?, renewalCostCents?, currency?, fields Json (zod per type), lastCheckedAt?, checkStatus?, visibility, notes, tags[]`; **AssetCheck** (`kind {RDAP, TLS, DNS}, result Json, diffFromPrevious`). **Expiration** is a computed UNION view (assets, credentials, contracts, services) + **ExpirationReminderSent** dedupe. **Relation** generic table for Hudu-style related items (never used for authorization). **Page / PageVersion** (Tiptap JSON + text, tree, visibility, mentions of credentials/assets stored as ids and rendered masked; portal renderer strips INTERNAL-referenced nodes). Continuity box stays pointer-only but auto-generates its "systems & assets" section from ClientAsset (non-secret) at seal time.

### 4.5 Notifications & email

**Notification** — `id, tenantId, clientId? (required for CONTACT), projectId?, receiverType {MEMBER, CONTACT}, receiverId, kind (catalog code), reason, class {INSTANT, COALESCED, DIGEST_ONLY}, entityType, entityId, actorType?, actorId?, params Json (ids/names only, zod-validated), dedupeKey? (unique per tenant), readAt, archivedAt, snoozedTill, emailedAt, createdAt`; partial index for unread; 500-cap with auto-archive. **Subscription** (`principal, entityType, entityId, level {WATCH, PARTICIPATE, MUTED}, reason`). **NotificationPreference** (`emailLevel {ALL, PARTICIPATING, MENTIONS, NONE}, inAppLevel, digestCadence, digestHour, digestWeekday, quiet hours, timezone, locale, perKind Json`). **EmailOutbox** (`idempotencyKey unique, recipient, toEmail, kind, locale, params, notificationIds[], configSet, sendAfter, status {QUEUED, SENDING, SENT, FAILED, DEAD, SUPPRESSED, SKIPPED}, attempts, lockedAt, sesMessageId, messageIdHeader, replyToken`), **EmailEvent** (platform-owned SNS events), **EmailSuppression** (global), **InboundEmail** (Phase 5), **PushSubscription** (endpoint unique, keys encrypted, platform, failCount, disabledReason). Kind catalog is a TS module with `audience`; every CONTACT-audience kind is `clientVisibleOnly` and its fan-out runs under the portal role — enforced by tests. Retention: outbox params 90 d, metadata 12 mo; inbound MIME 30 d.

### 4.6 Search

**search_index** — `id, tenantId, clientId?, projectId?, visibility, entityType {WORK_ITEM, WORK_ITEM_COMMENT, PROJECT_UPDATE, PAGE, DOCUMENT, PROJECT, CLIENT, CONTACT, CREDENTIAL_ITEM, TIME_ENTRY}, entityId, parentEntityType/Id, title, subtitle, titleNorm (generated via IMMUTABLE f_unaccent), bodyText (≤100k), metaText, search tsvector GENERATED ALWAYS … STORED (weights A/B/C, config `fortleva`), stateGroup, assigneeMemberId, updatedAt`; unique `(tenantId, entityType, entityId)`; CHECK CLIENT_VISIBLE ⇒ clientId; same tenant + portal_gate policies; trigger-maintained from source tables in the same transaction; btree indexes on `(tenantId, updatedAt DESC)`, `(tenantId, projectId, updatedAt DESC)`, `(tenantId, clientId, visibility, updatedAt DESC)`; **no GIN/trgm indexes at v1** (non-leakproof quals cannot become index quals under FORCE RLS — planner slices on tenant/project then filters). Modelling rule: no member-only free-text column on any entity that can be CLIENT_VISIBLE (internal notes are their own INTERNAL rows).

### 4.7 Imports, PWA, legal

**ImportJob / ImportJobItem** (sourceSystem, fileObjectId in R2, mapping/options/progress JSON, resumable batches, idempotent by `sourceSystem:sourceId`), `WorkItem.sourceSystem/sourceId/importJobId` for update-not-duplicate and 24-h rollback. **StaffNotice / StaffNoticeAcknowledgment** (locale, version, purposes[], jurisdictionTags[]) with `Member.workCountry`, `Member.timezone`. TenantPreference keys: `time_tracking.enabled/purposes/autoStopHours/perMemberDashboards/clientVisibleHours`, `finance.costRates.enabled/perMemberCostBreakdown`, `durationStyle {hm, clock, decimal}`, `weekStart`, `showIsoWeek`, `vault.enabled/stepUpPolicy/shareLinkMaxTtl/allowPortalCredentials`, `notifications.*`, `onboardingStep`.

---

## 5. Recommended implementation stack

*(Versions as reported by the implementation track against npm on 2026-08-16; the ones flagged by the critic should be re-verified before pinning in ARC entries — see §7.)*

| Concern | Choice | Reason |
|---|---|---|
| Drag & drop | `@atlaskit/pragmatic-drag-and-drop` 3.x (+hitbox, auto-scroll, react-drop-indicator) wrapped in one internal `<Sortable>`; desktop only | Tiny, framework-agnostic, Jira/Trello-proven; dnd-kit legacy unmaintained, `@dnd-kit/react` pre-1.0; touch drag disabled (GH #93) |
| Ordering | `fractional-indexing` 4.x, `text COLLATE "C"`, server-side rank with neighbour locks | O(1) moves; lexorank package dead |
| Mutations/state | React 19 `useOptimistic` + Server Actions + `refresh()`/`updateTag`, no TanStack Query in v1; no `'use cache'` on tenant reads until tenant-keyed cache rule + tests exist | Official Next 16 "interactive apps" pattern; RLS does not protect the data cache |
| Freshness | version-poll (12 s + focus) → SSE relay over Upstash Redis EU pub/sub later; Vercel WebSockets beta only for presence | Vercel 300 s function cap; Neon pooler forbids LISTEN/NOTIFY; Ably/Liveblocks EU-only is Enterprise |
| Rich text | Tiptap 3 (starter-kit, mention, link, image, task-list, code-block-lowlight, file-handler, TOC), ProseMirror JSON + extracted text; `useEditorState` (React Compiler); server `generateHTML` + DOMPurify for portal/email | MIT, largest ecosystem, v3 open-sourced former Pro extensions |
| Tables/lists | TanStack Table v9 + TanStack Virtual; `nuqs` for URL filter state | Opt-in features, virtualization at ~200 rows |
| Palette/keys | `cmdk` 1.x, `react-hotkeys-hook` 5.x (scopes) | Linear-class UX in a day |
| Charts | Recharts 3 via shadcn chart wrappers | React 19 peer, small consistent set |
| Timeline/Gantt | hand-built CSS-grid timeline; `@svar-ui/react-gantt` (MIT) only if dependencies requested | Keeps bundle small |
| Dates | `date-fns` 4 + `@date-fns/tz`; `Intl.DurationFormat` with fallback; `Intl.Locale.getWeekInfo()` | Temporal not in stable Safari |
| PDF | `@react-pdf/renderer` in a fra1 Node route handler → R2; Gotenberg on Hetzner EU only if HTML fidelity needed | EU-resident, no Chromium |
| DB | PG18 `uuidv7()`, btree_gist EXCLUDE, partial unique indexes, triggers, generated STORED columns, custom TS config — all in hand-written Prisma 7 migrations | Prisma cannot express them |
| Search | Postgres FTS (unaccent + swedish_stem), pg_trgm fallback functions; no external engine, no pgvector | Under FORCE RLS GIN is dead weight; EU posture |
| Email | `@aws-sdk/client-sesv2` eu-central-1, config sets, SNS→route handler, own RFC 8058 unsubscribe; next-intl `createTranslator` for cron rendering | Only allowed provider; digests need one-click unsubscribe |
| Jobs | Postgres outbox + `FOR UPDATE SKIP LOCKED` + Vercel Cron on **Pro** (*/2 outbox, */15 timers, hourly digests, daily reminders/retention) + `after()` kicks | Hobby crons are daily ±59 min |
| PWA/offline | `app/manifest.ts`, tiny hand-written `sw.js` + `web-push` (VAPID) in Phase 5; `experimental.useOffline`; IDB outbox via `idb-keyval`; Serwist app-shell later (Turbopack adapter still preview) | App-shell only, never tenant data in Cache Storage |
| Vault crypto | existing AES-256-GCM service extended with per-tenant DEK + AAD; `otplib`-class TOTP server-side; HIBP range API | Server-side, auditable, exportable |
| Imports | presigned R2 PUT, streaming `csv-parse`/papaparse, batches via `after()`, cron sweeper | Vercel 4.5 MB body limit |

---

## 6. Decisions for the founder (recommended defaults)

1. **Vocabulary & merge.** One `WorkItem` table (UI: "Task"; epics/subtasks are levels) that also absorbs the planned `Issue` as `kind=REQUEST` in a TRIAGE state. *Default: merge.* One comment/attachment/activity/notification path.
2. **Hierarchy depth.** Epic → Task → Subtask (depth ≤ 3), Epic optional and hidden until used; no Feature level. *Default: 3.*
3. **Assignment.** Single assignee + collaborators join (multi-assignee only via subtasks). *Default: single* — time/cost attribution and My Work stay unambiguous.
4. **States.** Configurable named states inside fixed categories; tenant-level presets ("Default", "Web build: Design/Dev/QA/Review") copied per project; default To do / In progress / Done (+ Backlog, Cancelled, Triage). *Default: configurable-in-categories.*
5. **Time without a task.** Allow project-level entries with a required note (meetings/admin) rather than fake "General" tasks. *Default: allow.*
6. **Timer policy.** One running timer per member enforced by DB; starting another auto-stops with undo toast; nudge at 8 h, auto-stop at 12 h → needsReview; overlaps blocked (tenant toggle). *Default as stated.*
7. **Rate tiers.** BILL: project-member > project > member > tenant; COST: member > tenant; no task rates; single currency per project; effective-dated; snapshot on entry. *Default as stated.*
8. **Who sees money.** Employee: own hours; Manager: hours + bill rates + budgets; CEO/finance permission: cost rates, margin. Cost rates encrypted, never in CSV by default. *Default as stated.*
9. **Client hours.** `hoursSharingMode` per project (NONE default), CONTACT_PRIMARY only, billable aggregates + task/note, never per-member/rates/cost; retainer cycle widget in Phase 4. *Default: schema now, UI with timers.*
10. **Portal surface v1.** Milestones, ProjectUpdates, versions, documents, action items first; shared task list toggle per project; kanban toggle later; no public links, no magic links, no client push. *Default as stated.*
11. **Sprints.** Not in v1 (continuous flow + milestones); Sprint entity behind entitlement in v1.5. *Default: skip.*
12. **Estimate unit.** Hours; points scale later behind preference. *Default: hours.*
13. **Rounding default.** Store seconds; tenant default no rounding, per-project rule (Swedish consulting commonly 15 min UP per entry) applied at invoice; ask Naxdor's contract wording. *Default: none at tenant, per project.*
14. **Vault crypto.** Server-side envelope encryption with per-tenant DEK + AAD; no per-tenant passphrase/E2EE; sudo window 10 min for reveal, always step-up for share/export/visibility; MFA required to reveal at all. *Default as stated.* Update CONTINUITY_BOX/SECURITY docs: box stays pointer-only, vault is a product module.
15. **Portal-visible credentials.** Share links + client credential submission in v1; persistent CLIENT_VISIBLE credentials behind tenant preference default OFF. *Default as stated.*
16. **Vercel Pro now.** Required for the outbox worker, timer nudges, digests. *Default: upgrade before the Work module ships.*
17. **Reply-To / email-in.** Monitored mailbox as Reply-To now; design `reply+{token}@in.mailer…` scheme now; SES receiving in Phase 5 only behind entitlement. *Default as stated.*
18. **Realtime.** Poll + focus refresh in v1; SSE over Upstash EU behind a flag in v1.5; no sync engine. *Default: poll.*
19. **Mobile drag.** No touch drag in v1; "Move to…" sheet + long-press; Web Push in Phase 5 opt-in with content-free payloads. *Default as stated.*
20. **Accounting bridge order.** CSV fakturajournal → Bokio private-token connector → Fortnox voucher mode; SIE4 only on request (decision #3 "ledger not accounting" stands). *Default as stated.*
21. **Legal artefacts before enabling timers at Naxdor.** sv/en staff notice + acknowledgment, purposes declared (billing/planning/profitability, *not* performance evaluation), MBL check if any union member, US notice for NY/CT/DE staff, retention split written into SECURITY.md. *Default: do it; ask a lawyer the MBL 13 § question.*

---

## 7. Risks & pushback

**1. "Like Azure DevOps … and much more" is the wrong target.** ADO's own reviewers call it "not intuitive", "overkill for small teams", "not for business people" — exactly your client persona — and Microsoft ships four process templates, area/iteration trees, WIQL, delivery plans and dashboards that no 1–15 person agency configures. The research converges on copying ADO's *data model* and shipping Planner/Linear's *surface*. Every "and much more" item (sprints, custom fields, Gantt dependencies, approvals workflows, AI drafting, dashboards builder) should be an entitlement-gated module built only when a real tenant asks. If the plan bloats, the solo build fails on maintenance, not on features.

**2. Time tracking is a legal object in Sweden, not just a feature.** A self-started/stopped timer with manager-visible totals is ordinary tidsredovisning (IMY: permitted, contract-necessary; consent is *not* a valid basis). The moment the product captures activity the employee didn't volunteer — idle detection, screenshots, URL/app logs, presence broadcast, per-minute heatmaps, leaderboards — it becomes övervakning: DPIA-mandatory (systematic monitoring + employees), an MBL 11 § "viktigare förändring" for kollektivavtal-bound employers, and squarely inside NY/CT/DE notice statutes. Several reference tools (Hubstaff, Timely, Clockify desktop) sell exactly those; do not follow them, and write the never-list into PLAN.md so future sessions don't re-litigate. Also: cost rates are salary-grade personal data — fanning them out in plaintext on every TimeEntry row (as several trackers do) multiplies exposure; keep them encrypted and finance-gated. Naxdor itself needs the staff notice + acknowledgment and, if any employee is a union member, an MBL 13 § check before go-live.

**3. Credential storage is a liability you are choosing to take on.** Copilot/Moxie/SuiteDash have no vault for a reason. Once Fortleva stores client WordPress/hosting/registrar logins, a single RLS or reveal bug becomes a multi-client breach; the operator can technically decrypt (server-side model) and must say so in the DPA/ROPA. Mitigations are procedural (AAD-bound ciphertext, per-tenant DEK, MFA step-up, audited reveal budget, no support backdoor, offboarding rotation flags, export). E2EE would remove the operator-decrypt risk but forks every path (search, share links, TOTP, portal submission) and creates unrecoverable lockouts for 3-person agencies — Infisical dropped it, IT Glue's Vault is a support burden. Ship server-side, be honest, and treat the vault tests as non-negotiable before UI.

**4. The portal is where the worst bug lives.** The design is right (flag on the row, RESTRICTIVE RLS, projections), but the new surfaces multiply leak vectors: search index, notification/email fan-out, digest bodies, ProjectUpdate snapshots with hours/cost, push payloads, activity feeds, share links, comment threads with two audiences. Each track independently added a CI tripwire (forbidden-columns test, lexeme-probe test, "no INTERNAL fact to a Contact" test, portal projection grep, digest built under portal role). Build those tests in the same commit as the feature, every time.

**5. RLS has non-obvious performance edges.** Under FORCE ROW LEVEL SECURITY the planner will not use GIN/trgm indexes for `@@`/ILIKE/`%` (non-leakproof quals); recursive CTEs re-evaluate policies per scan. Hence: narrow trigger-fed search_index, flat rollups via denormalised projectId/clientId, bounded recursion only for subtree panes, and a documented (not built) escape hatch. Don't discover this after tenants have data.

**6. Notifications need Vercel Pro and an outbox — not `after()` alone.** Hobby crons run once a day with ±59 min jitter; `after()` is not durable. Budget the $20/mo now or the timer nudges, digests and debounced emails cannot exist.

**7. Date-fragile claims to spot-verify before ARC entries** (the implementation track says it checked npm on 2026-08-16, but the critic is right that these should be re-verified at implementation time, not trusted from a research JSON): `@atlaskit/pragmatic-drag-and-drop` 3.0.0 (2026-08-14); TanStack Table v9 GA (2026-08-04); `fractional-indexing` 4.0.0 (June 2026); Vercel WebSockets public beta (June 2026); Linear "agent-assisted project updates" (2026-06-18); Planner Jan–Feb 2026 refresh retiring iCal/Loop; PG18 `WITHOUT OVERLAPS` + btree_gist on Neon; "Neon pooler forbids LISTEN/NOTIFY"; SES inbound receiving in eu-central-1; ICANN RDAP mandatory Jan 2025; `@serwist/turbopack` preview status; Intl.DurationFormat Baseline 2025. Bake each into the ARC line that depends on it with a "verified on <date>" note.

**8. Docs are stale and contradict the new direction.** PLAN.md's skip-list says "Time tracking — don't build"; DATA_MODEL.md §11 says the same; CONTINUITY_BOX/SECURITY say "pointers not secrets" while the product now hosts a vault; Issue is specced as a separate entity; the permission catalog test asserts exactly 63 codes; SECURITY.md has zero words on employee-monitoring law or the new retention classes; Bokio is described as gatekept though it now offers a free private API. Each needs a dated decision entry, not a silent overwrite.

**9. Two known UX traps to avoid on purpose.** (a) Planner's checklist-as-subtask abuse and per-plan labels — decided: checklist in description with convert-to-subtask, labels tenant-wide. (b) ADO's hidden Board Column/Lane fields and per-team settings — decided: one board per project, columns = states, single rank.

**10. Sequencing risk.** The pieces with one-way doors are: AAD ciphertext format, search_index/TS config, rank column collation, TimeEntry constraints, kind-catalog audience flags, notification outbox. Land those in the same phase as the WorkItem tables even if their UIs come later; everything else is additive.

---

## 8. Sources (consolidated)

**Azure DevOps** — https://learn.microsoft.com/en-us/azure/devops/boards/work-items/guidance/choose-process · https://learn.microsoft.com/en-us/azure/devops/boards/queries/link-type-reference · https://learn.microsoft.com/en-us/azure/devops/boards/boards/kanban-overview · https://learn.microsoft.com/en-us/azure/devops/boards/boards/add-columns · https://learn.microsoft.com/en-us/azure/devops/boards/boards/wip-limits · https://learn.microsoft.com/en-us/azure/devops/boards/backlogs/backlogs-overview · https://learn.microsoft.com/en-us/azure/devops/boards/work-items/workflow-and-state-categories · https://learn.microsoft.com/en-us/azure/devops/boards/backlogs/automate-work-item-state-transitions · https://learn.microsoft.com/en-us/azure/devops/boards/queries/query-numeric · https://learn.microsoft.com/en-us/azure/devops/report/dashboards/cumulative-flow-cycle-lead-time-guidance · https://learn.microsoft.com/en-us/azure/devops/organizations/security/stakeholder-access · https://marketplace.visualstudio.com/items?itemName=7pace.Timetracker · https://www.g2.com/products/azure-boards/reviews?qs=pros-and-cons

**Microsoft Planner** — https://support.microsoft.com/en-us/office/compare-microsoft-planner-basic-vs-premium-plans-5e351170-4ed5-43dc-bf30-d6762f5a6968 · https://learn.microsoft.com/en-us/graph/api/resources/plannertask?view=graph-rest-1.0 · https://learn.microsoft.com/en-us/graph/api/resources/planner-order-hint-format?view=graph-rest-1.0 · https://learn.microsoft.com/en-us/office365/planner/planner-limits · https://techcommunity.microsoft.com/blog/plannerblog/introducing-a-refreshed-design-task-chat-and-more-in-microsoft-planner/4495440 · https://support.microsoft.com/en-us/office/guest-access-in-microsoft-planner-cc5d7f96-dced-4da4-ab62-08c72d9759c6 · https://planner-ms.ghost.io/buckets-tasks-and-subtasks/

**Linear / Plane / modern UX / OSS** — https://linear.app/docs/conceptual-model · https://linear.app/docs/configuring-workflows · https://linear.app/docs/custom-views · https://linear.app/docs/triage · https://linear.app/docs/inbox · https://linear.app/docs/search · https://linear.app/docs/initiative-and-project-updates · https://github.com/makeplane/plane/tree/preview/apps/api/plane/db/models · https://raw.githubusercontent.com/makeplane/plane/preview/apps/api/plane/db/models/issue.py · https://raw.githubusercontent.com/makeplane/plane/preview/apps/api/plane/db/models/view.py · https://raw.githubusercontent.com/makeplane/plane/preview/apps/api/plane/db/models/intake.py · https://github.com/makeplane/plane/blob/preview/apps/api/plane/db/models/notification.py · https://github.com/hcengineering/platform/blob/develop/models/tracker/src/types.ts · https://raw.githubusercontent.com/go-vikunja/vikunja/main/pkg/models/tasks.go · https://raw.githubusercontent.com/taigaio/taiga-back/main/taiga/projects/userstories/models.py · https://raw.githubusercontent.com/kanboard/kanboard/main/app/Schema/Sql/postgres.sql · https://www.openproject.org/docs/user-guide/time-and-costs/time-tracking/ · https://developerfirst.substack.com/p/developer-first-163-developers-most · https://leantime.io/features/

**Agency ops & time tracking** — https://support.teamwork.com/projects/finance/user-rates · https://support.teamwork.com/projects/project-budgets/standard-project-budgets · https://support.teamwork.com/projects/reports/profitability-report · https://help.productive.io/en/articles/2179644-understanding-and-setting-up-cost-rates-in-productive · https://help.productive.io/en/articles/2179670-what-can-a-client-see-on-a-budget · https://help.productive.io/en/articles/9902502-retainer-hours-rollover · https://www.kimai.org/documentation/rates.html · https://www.kimai.org/documentation/rounding.html · https://www.kimai.org/documentation/invoices.html · https://github.com/kimai/kimai/blob/main/src/Entity/Timesheet.php · https://github.com/solidtime-io/solidtime/blob/main/app/Http/Controllers/Api/V1/TimeEntryController.php · https://github.com/solidtime-io/solidtime/blob/main/app/Service/BillableRateService.php · https://engineering.toggl.com/docs/track/api/time_entries/ · https://support.toggl.com/historical-billable-rates · https://help.getharvest.com/api-v2/timesheets-api/timesheets/time-entries/ · https://support.getharvest.com/hc/en-us/articles/360053116772-How-does-time-rounding-work · https://support.getharvest.com/hc/en-us/articles/4407283487629-Budget-email-alerts · https://clockify.me/help/reports/hourly-rates · https://clockify.me/help/track-time-and-expenses/lock-timesheets · https://support.everhour.com/article/501-budgeting · https://help.accelo.com/guides/user/modules/retainers/add-a-retainer/ · https://help.clickup.com/hc/en-us/articles/6304281894039-Time-Tracking-Rollup

**Client sharing & progress reports** — https://5.basecamp-help.com/article/1082-what-clients-can-see-and-do · https://github.com/basecamp/bc3-api/blob/master/sections/client_visibility.md · https://github.com/basecamp/basecamp-cli/issues/457 · https://updates.37signals.com/post/new-in-basecamp-client-access-on-templates · https://signalvnoise.com/svn3/helping-clients-and-firms-get-to-yes/ · https://support.teamwork.com/projects/using-teamwork/working-with-client-users · https://support.teamwork.com/projects/project-options/project-updates · https://support.atlassian.com/jira-service-management-cloud/docs/talk-to-the-customer-or-team-members-from-the-new-issue-view/ · https://help.rocketlane.com/support/solutions/articles/67000711318-the-rocketlane-customer-portal · https://help.suitedash.com/article/120-project-dashboard · https://developers.asana.com/reference/status-updates · https://www.openproject.org/docs/user-guide/projects/projects-faq/ · https://help.agencyanalytics.com/en/articles/4706526-report-overview · https://agencyanalytics.com/blog/client-reporting-data-overload · https://help.whatagraph.com/en/articles/6309188-how-to-automate-a-report · https://support.teamwork.com/projects/proofing/review-and-approve-proofs · https://www.projectpanorama.com/why-clients-ask-for-updates-even-when-you-send-them/ · https://www.hourtab.com/blog/toggl-alternative-retainer-tracking

**Vault & assets** — https://support.hudu.com/hc/en-us/articles/7718132777879-Password-Management · https://support.hudu.com/hc/en-us/articles/8588122864407-External-Sharing · https://support.hudu.com/hc/en-us/articles/8688891380631-Expirations · https://help.itglue.kaseya.com/help/Content/2-using/permissions/the-vault.html · https://help.itglue.kaseya.com/help/Content/2-using/documentation-guide/domains.html · https://www.passbolt.com/docs/admin/resource-policies/password-expiry/ · https://bitwarden.com/help/event-logs/ · https://support.1password.com/share-items/ · https://docs.keeper.io/user-guides/sharing/one-time-share · https://infisical.com/docs/internals/security · https://infisical.com/blog/infisical-update-june-2023 · https://www.icann.org/en/announcements/details/icann-update-launching-rdap-sunsetting-whois-27-01-2025-en

**Implementation stack** — https://github.com/atlassian/pragmatic-drag-and-drop · https://github.com/atlassian/pragmatic-drag-and-drop/discussions/93 · https://github.com/rocicorp/fractional-indexing · https://www.manukminasyan.com/blog/kanban-boards-position-management · https://nextjs.org/docs/app/guides/interactive-apps · https://nextjs.org/docs/app/api-reference/functions/after · https://vercel.com/docs/functions/limitations · https://vercel.com/docs/functions/websockets · https://vercel.com/docs/cron-jobs/usage-and-pricing · https://neon.com/docs/connect/connection-pooling · https://neon.com/docs/extensions/pg-extensions · https://neon.com/docs/extensions/btree_gist · https://upstash.com/docs/redis/features/restapi · https://tiptap.dev/tiptap-editor-v3 · https://github.com/ueberdosis/tiptap/issues/6566 · https://tanstack.com/blog/announcing-tanstack-table-v9 · https://github.com/svar-widgets/react-gantt · https://developer.mozilla.org/en-US/docs/Web/API/Push_API · https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ · https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DurationFormat · https://serwist.pages.dev/docs/next/getting-started · https://www.prisma.io/docs/orm/prisma-schema/data-model/unsupported-database-features · https://github.com/prisma/prisma/issues/6336

**Search** — https://www.postgresql.org/docs/18/ddl-rowsecurity.html · https://www.postgresql.org/docs/18/textsearch-controls.html · https://www.postgresql.org/docs/18/textsearch-dictionaries.html · https://www.postgresql.org/docs/18/release-18.html · https://raw.githubusercontent.com/postgres/postgres/REL_18_STABLE/src/backend/optimizer/util/restrictinfo.c · https://raw.githubusercontent.com/postgres/postgres/REL_18_STABLE/src/backend/optimizer/path/indxpath.c · https://gitlab.com/gitlab-org/gitlab/-/raw/master/app/models/concerns/pg_full_text_searchable.rb · https://raw.githubusercontent.com/docmost/docmost/main/apps/server/src/core/search/search.service.ts · https://github.com/outline/outline/blob/main/server/migrations/20260803143858-add-documents-team-search-vector-index.js · https://supabase.com/docs/guides/database/full-text-search

**Notifications & email** — https://docs.aws.amazon.com/general/latest/gr/ses.html · https://docs.aws.amazon.com/ses/latest/dg/regions.html · https://docs.aws.amazon.com/ses/latest/dg/sending-email-subscription-management.html · https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-sns.html · https://docs.aws.amazon.com/ses/latest/dg/monitor-sending-activity-using-notifications.html · https://www.rfc-editor.org/rfc/rfc8058 · https://docs.gitlab.com/user/profile/notifications/ · https://docs.gitlab.com/administration/reply_by_email/ · https://vikunja.io/docs/subscriptions/ · https://next-intl.dev/docs/environments/actions-metadata-route-handlers

**Time → invoice & accounting** — https://raw.githubusercontent.com/odoo/odoo/17.0/addons/sale_timesheet/models/account.py · https://raw.githubusercontent.com/odoo/odoo/17.0/addons/sale_timesheet/models/account_move.py · https://raw.githubusercontent.com/odoo/odoo/17.0/addons/sale_timesheet/models/sale_order.py · https://invoiceninja.github.io/docs/user-guide/tasks · https://raw.githubusercontent.com/invoiceninja/invoiceninja/v5-stable/app/Repositories/TaskRepository.php · https://github.com/kimai/kimai/tree/main/src/Invoice/Calculator · https://docs.gitlab.com/user/project/time_tracking/ · https://www.skatteverket.se/foretag/moms/saljavarorochtjanster/momslagensregleromfakturering.4.58d555751259e4d66168000403.html · https://lagen.nu/1999:1078 · https://developer.api.riksbank.se/api-details#api=swea-api · https://www.bokio.se/hjalp/integrationer/bokio-api/automatisera-bokforingen-i-bokio-med-api-sa-gor-du/ · https://docs.bokio.se/ · https://www.fortnox.se/developer/guides-and-good-to-know/pricing-models · https://apps.fortnox.se/apidocs

**Legal / labour / GDPR** — https://www.imy.se/vagledningar/arbetsliv/kontroll-och-overvakning/ · https://www.imy.se/verksamhet/dataskydd/dataskydd-pa-olika-omraden/arbetsliv/ · https://www.imy.se/verksamhet/dataskydd/dataskydd-pa-olika-omraden/arbetsliv/tillaten-behandling--vilka-krav-galler/konsekvensbedomning/ · https://lagen.nu/1976:580 · https://lagen.nu/1982:673 · https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/bokforingslag-19991078_sfs-1999-1078/ · https://www.bfn.se/fragor-och-svar/arkivering/ · https://ec.europa.eu/newsroom/article29/items/610169 · https://ec.europa.eu/newsroom/article29/items/611236/en · https://www.cnil.fr/fr/la-cnil-publie-une-recommandation-relative-aux-mesures-de-journalisation · https://www.nysenate.gov/legislation/laws/CVR/52-C*2 · https://delcode.delaware.gov/title19/c007/sc01/index.html · https://www.cga.ct.gov/current/pub/chap_557.htm#sec_31-48d · https://www.unionen.se/rad-och-stod/medbestammandeforhandling-sa-har-gor-du

**Imports / mobile** — https://support.atlassian.com/trello/docs/exporting-data-from-trello/ · https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API · https://blog.logrocket.com/nextjs-16-pwa-offline-support/ · local: `node_modules/next/dist/docs/01-app/02-guides/progressive-web-apps.md`, `…/offline-support.md`, `…/interactive-apps.md`; `d:\fortleva\docs\{PLAN,DATA_MODEL,SECURITY,AUTHZ,CONTINUITY_BOX}.md`
