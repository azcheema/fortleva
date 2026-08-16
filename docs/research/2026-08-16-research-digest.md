# Fortleva Work Management — per-track research digest (2026-08-16)

*Summaries, recommendations, open questions and sources of the 14 research tracks + 3 codebase explorations. Full structured JSON lives in the session workflow journal (not committed).*


## agency-ops: tasks + time tracking + rates/costs/budgets + client visibility + reports (Teamwork, Productive, Scoro, Accelo, ClickUp, Asana, monday, Basecamp, Harvest, Toggl, Kimai, OpenProject, Bonsai, Assembly/Copilot, Hubflo, SuiteDash, Hudu)

Across every serious agency-ops tool the money model is the same three-layer structure and Fortleva should copy it verbatim: (1) a per-Member COST rate (site-wide, admin-only, effective-dated; Productive adds overhead-per-hour on top, Teamwork explicitly forbids project-level cost overrides), (2) a BILLABLE rate resolved through a hierarchy (Teamwork: project > client-role > role > user; Kimai: activity > project > customer > user with user-specific beating global at each level; Productive: single-rate / per-service / per-person on a budget), and (3) an immutable snapshot of both rates onto each time entry at write time (Kimai stores rate+internalRate on the timesheet row; OpenProject computes cost at entry creation from a valid_from rate history; Teamwork's "retroactive rates" recompute only UNINVOICED entries). Revenue = billable hours x billable rate for T&M; fixed-fee/retainer revenue is the fee (Teamwork spreads a retainer daily across its period); cost = hours x cost rate; profit and margin fall out. Budgets are either hours or money, T&M or fixed-fee, optionally repeating (retainer), one active per project, with %-threshold alerts (Harvest emails at 80% etc., Teamwork configurable recipients/percent). Sub-budgets (Teamwork task-list budgets, Accelo task->milestone->project rollup) inherit the parent's type and must sum <= parent.

Client visibility converges on Basecamp's model: everything private by default, a per-item "client can see this" flag set at posting time on top-level items (to-do lists, messages, docs, card tables) with children and comments inheriting the parent's flag, chat/folders all-or-nothing, a visible flag on every item, templates remembering flags, and clients never seeing the flags themselves. Productive adds hidden-from-client comments, private folders, per-budget "Client Access" toggle with an org-wide default, and a "view as client" preview; clients see billable time + task/note but never worked time, cost, rate, margin, or profit, and optional approval before time becomes client-visible. Assembly/Copilot keeps internal tasks/notes off the portal by design.

Timer UX is consistent everywhere: exactly one running timer per person (starting another stops the first), a persistent global indicator (Productive top-right, OpenProject avatar badge, Asana bottom-right popup, ClickUp global timer), start from task card/list/detail, edit start time while running, stop -> confirm/adjust duration, auto-stop safety (Productive warns at 8h idle, stops at 24h), idle-detection only in desktop apps (Harvest/Toggl 10-min prompt keep/discard), plus a Day view (timer+notes) and a Week grid (durations only) for manual entry, billable defaults cascading project > list > entry, and locking once invoiced/approved.

Reports agencies actually use: time by client/project/member with billable/non-billable/invoiced split (Teamwork Time Report), utilization = logged/available and billable/available with available = contracted hours minus time off (Teamwork), profitability per project and per user (revenue/cost/profit/margin), budget burn with remaining %, uninvoiced time, and planned-vs-actual (estimate vs logged). Users complain about Productive's growing complexity, ClickUp's rates being paid-only/absent, monday's time column not feeding formulas, and Harvest price hikes — a small-agency tool wins by keeping the model complete but the surface small.

**Recommendations**
- Reverse the DATA_MODEL.md §11 'time tracking: skip' line explicitly and add a Phase 'Time & Money' between Core domain and Money: TimeEntry + timer + rates + project budget + rollups are prerequisites for the founder's cost view and for Phase 4 invoicing of T&M work.
- Model rates as three layers exactly like Teamwork/Productive: Member cost rate (site-wide, effective-dated, finance-permission only), billable rate hierarchy (project+member > project flat > member default), snapshot both on the TimeEntry — do not compute cost on read.
- Enforce one running timer per Member with a partial unique index and treat the running timer as an open TimeEntry; add the 24h auto-stop job on day one.
- Ship budgets as hours-or-money x T&M-or-fixed-fee with one active budget per project and %-alerts; defer sub-budgets, roles rates and overhead to v2.
- Adopt Basecamp's visibility semantics on top of Fortleva's existing visibility column: default INTERNAL, flag set on containers, children inherit, comments default internal, badge everywhere for Members, hidden from Contacts, plus a read-only 'View as client' preview.
- Portal time exposure must be a separate aggregated read model (billable hours + budget used/remaining) gated by a per-project toggle with a tenant default; never expose rates, cost, non-billable time, or per-Member breakdown to Contacts in v1.
- Build the Time report (filters, group-by, billable/non-billable/invoiced, CSV) and the Project profitability panel first; utilization and planned-vs-actual are v1.5 once capacity/estimates exist.
- Store currency on every rate and money field now (SEK/USD for Naxdor), no FX conversion in v1; report revenue per project currency and cost in tenant base currency.
- Lock time entries once attached to an invoice line and audit every edit of duration/billable/rate — this is what keeps reports and invoices consistent and satisfies the privilege-escalation test family.
- Implement the credential vault with the existing AES-GCM service, reveal-audited, with expiring share links (Hudu pattern) — but keep TOTP-seed storage optional and behind a TenantPreference.
- Keep the surface small: one timer chip, one My Time page (Day + Week), one project Money tab (budget bar, hours by member, revenue/cost/profit), one report page — Productive's main criticism is complexity creep.
- Add the new permission codes and audit actions to the catalogs in the same commit as the schema (time_entry.created/updated/deleted, timer.started/stopped, rate.changed, budget.created/updated, credential.revealed/shared).

**Open questions**
- Fixed-fee revenue recognition: pro-rata by days across the budget period (Teamwork retainer style) vs recognize on completion vs recognize as billable-hours capped at fee (Productive 'recognized time')? Default: pro-rata by days for retainers, full fee on completion for one-off fixed fee.
- Should Employees see their own billable rate? Default: no rates visible to Employee role; they see hours only; Managers see billable rates; CEO/finance permission sees cost rates.
- Should non-billable hours be shown to clients at all? Default: never; portal shows billable hours only, and only if project.clientCanSeeTime is on.
- Timer minimum increment/rounding (raw seconds vs 1-min vs 6-min for billing)? Default: store raw seconds, display minutes, apply rounding only at invoice-line generation as a tenant preference.
- Do time entries attach to tasks only, or also directly to a project (no task)? Default: allow project-level entries with a required note, to avoid fake 'misc' tasks — but the board/backlog remain the primary entry point.
- Retainer excess handling: carry over unused hours, bill excess at an excess rate, or just alert? Default: alert + report only in v1; carry-over/excess rate v2 (Accelo pattern).
- Credential vault scope: store TOTP seeds and offer an OTP generator (Hudu) or passwords/URLs only? Default: passwords/URLs/notes in v1; TOTP seeds behind a TenantPreference in v1.5.
- Should time entries require approval before becoming client-visible (Productive optional approver)? Default: no approval engine in v1; client visibility of time is aggregate-only, which limits exposure risk.
- Overhead cost per hour: include now (one tenant field + per-Member toggle) or later? Default: later; margins in v1 = revenue - direct labor cost.

**Sources**
- [Teamwork.com — User Rates (billable vs cost, hierarchy, currency)](https://support.teamwork.com/projects/finance/user-rates)
- [Teamwork.com — Retroactive User Rates](https://www.teamwork.com/blog/introducing-retroactive-user-rates/)
- [Teamwork.com — Time and Materials Project Budgets](https://support.teamwork.com/projects/project-budgets/standard-project-budgets)
- [Teamwork.com — Fixed Fee Budgets](https://support.teamwork.com/projects/project-budgets/fixed-fee-budgets)
- [Teamwork.com — Task List Budgets](https://support.teamwork.com/projects/project-budgets/setting-task-list-budgets)
- [Teamwork.com — Profitability Report](https://support.teamwork.com/projects/reports/profitability-report)
- [Teamwork.com — Project Profitability formulas](https://support.teamwork.com/projects/project-budgets/viewing-project-profitability)
- [Teamwork.com — Utilization Report](https://support.teamwork.com/projects/reports/utilization-report)
- [Teamwork.com — Reports Overview](https://support.teamwork.com/projects/reports/reports-overview)
- [Teamwork.com — Time Report](https://support.teamwork.com/projects/reports/time-report)
- [Teamwork.com — Set Billable Time Defaults](https://support.teamwork.com/projects/time/set-billable-time-defaults)
- [Teamwork.com — Manage Tracked Time / invoiced lock](https://support.teamwork.com/projects/time/marking-time-logs-as-billable)
- [Teamwork.com — User Permissions and Access (client users, collaborators)](https://support.teamwork.com/projects/using-teamwork/understanding-user-permissions-and-access)
- [Productive — Glossary (cost rate, overhead, recognized revenue, utilization)](https://help.productive.io/en/articles/6254964-productive-glossary)
- [Productive — Understanding and Setting Up Cost Rates](https://help.productive.io/en/articles/2179644-understanding-and-setting-up-cost-rates-in-productive)
- [Productive — Overhead Cost](https://help.productive.io/en/articles/6839043-overhead-cost)
- [Productive — Billing Types](https://help.productive.io/en/articles/12048976-billing-types)
- [Productive — Using the Timer to Track Time](https://help.productive.io/en/articles/3903111-using-the-timer-to-track-time)
- [Productive — Time Tracking Policies](https://help.productive.io/en/articles/11769095-setting-up-time-tracking-policies)
- [Productive — Timer rounding](https://help.productive.io/en/articles/3421740-how-time-entry-rounding-works-when-using-the-timer)
- [Productive — What Can a Client See after Joining](https://help.productive.io/en/articles/2179600-what-can-a-client-see-after-joining-productive)
- [Productive — What Can a Client See On a Budget](https://help.productive.io/en/articles/2179670-what-can-a-client-see-on-a-budget)
- [Productive — Giving Clients Access to Budgets and Timesheets](https://help.productive.io/en/articles/2179616-giving-clients-access-to-budgets-and-timesheets)
- [Productive — Commenting on Tasks (Hidden from client)](https://help.productive.io/en/articles/2179584-commenting-on-tasks)
- [Productive — Private Folders in Projects](https://help.productive.io/en/articles/12156522-private-folders-in-projects)
- [Basecamp — What clients can see and do](https://5.basecamp-help.com/article/1082-what-clients-can-see-and-do)
- [Basecamp — Client access on templates](https://updates.37signals.com/post/new-in-basecamp-client-access-on-templates)
- [Basecamp — Launch: working with clients (private by default)](https://signalvnoise.com/svn3/launch-a-brand-new-way-to-work-with-clients-in-basecamp-3/)
- [Basecamp — Clientside approvals](https://3.basecamp-help.com/article/118-using-the-clientside)
- [Basecamp — Hill Charts](https://basecamp.com/hill-charts)
- [Basecamp — Automatic Check-ins](https://3.basecamp-help.com/article/50-automatic-check-ins)
- [Kimai — Rates documentation (storage on timesheet, lookup order, internal rate)](https://www.kimai.org/documentation/rates.html)
- [OpenProject — Time tracking (one timer, avatar badge)](https://www.openproject.org/docs/user-guide/time-and-costs/time-tracking/)
- [OpenProject — Budgets / rate history](https://www.openproject.org/docs/user-guide/budgets/)
- [Harvest — Budget email alerts](https://support.getharvest.com/hc/en-us/articles/4407283487629-Budget-email-alerts)
- [Harvest — How to set project budgets](https://support.getharvest.com/hc/en-us/articles/360048686811-How-to-set-project-budgets)
- [Harvest — Day view vs Week view](https://support.getharvest.com/hc/en-us/articles/360048687531-Track-and-edit-time-in-the-Week-view)
- [Harvest — Idle timer (desktop)](https://support.getharvest.com/hc/en-us/articles/360048685231-How-does-the-idle-timer-work-for-the-Mac-and-Windows-apps)
- [Toggl Track — Desktop app (idle detection, reminders)](https://support.toggl.com/en-us/article/toggl-track-desktop-app-for-macos-1669b8x/)
- [ClickUp — Track time on tasks](https://help.clickup.com/hc/en-us/articles/6304106812823-Track-time-on-tasks)


## Azure DevOps Boards — deep feature study and v1 recommendations for Fortleva work tracking (kanban, backlog, sprints, time, reporting, client visibility)

Azure Boards is a work-item tracking system built on five ideas that are worth copying and a dozen layers of enterprise configurability that are not. The keepers: (1) ONE generic work-item record with a type, a state, a single assignee, tags, discussion, links, attachments and full field-level history; (2) a strict tree hierarchy (Epic → Feature → Story/PBI → Task) enforced by a single-parent, acyclic Parent/Child link, plus a small set of other typed links (Related = network, Predecessor/Successor = acyclic dependency, Duplicate); (3) STATE CATEGORIES (Proposed / In Progress / Resolved / Completed / Removed) that decouple a team's custom state names from all tooling — backlogs hide Completed, boards map first column = Proposed and last column = Completed, cycle time = first In-Progress → final Completed, lead time = created → Completed, Activated/Resolved dates are stamped from category transitions; (4) a board that is a VIEW over states (columns map 1..n states, soft WIP limits shown red when exceeded, optional Doing/Done split, swimlanes with rules, card style rules and tag colours, per-column Definition of Done, "maintain backlog order vs free reorder" toggle, drag = state change + reorder); (5) numeric planning fields that roll up (Story Points/Effort on backlog items, Original Estimate / Remaining Work / Completed Work on tasks; Remaining Work zeroed on Done and summed for burndown and capacity bars).

What ADO gets clunky, per Microsoft's own docs and user reviews: four process templates and a Hosted-XML/Inheritance customization model nobody small needs; teams × area paths × iteration paths as the scoping mechanism (multi-team board views produce "unexpected results", per-team board settings can't be shared, items owned by another team are read-only); Completed items silently vanish from backlogs/boards after 183 days; only leaf nodes of same-type hierarchies show on boards; automation rules only fire from Boards/Backlogs/Sprints views (not forms/queries) and only within one team; managed queries with WIQL and a 1000-item chart limit; and — decisive for Fortleva — NO native timer or time-entry: Completed Work is a hand-typed number, and the marketplace's #1 extension (7pace) exists purely to add start/stop timers, worklogs, billable flags, budgets and timesheet approvals. Reviews consistently call the UI "not intuitive", "click around randomly", "overkill for small teams", and "not for non-engineering / business people" — exactly Fortleva's client persona.

Recommendation: build ADO's DATA MODEL (WorkItem + typed links + state categories + numeric rollups + history) but ship the BASIC-process UX (Epic/Issue/Task-like: Project → WorkItem(EPIC|STORY|TASK|BUG) with a fixed 3-category default board), replace teams/area/iteration paths with Project + optional Sprint, add first-class TimeEntry with a running timer, hourly rate on Project, and a per-item client_visible flag driving the portal, and skip queries/WIQL, delivery plans, dashboards, capacity-by-activity, CMMI/Scrum ceremonies for v1.

**Recommendations**
- Adopt ADO's Basic process as the ONLY process: WorkItem types EPIC → STORY → TASK (+ BUG as a STORY-level type flag), default states To Do / In Progress / Done (+ Removed), because reviewers say the Agile/Scrum/CMMI choice and inherited-process editor are pure overhead for small teams.
- Model state categories from day one (Proposed/InProgress/Resolved/Completed/Removed) and let each project rename/add states inside categories; this gives custom columns and safe portal status mapping without ADO's team-level board-column indirection.
- Make the board a direct view over states (one board per project, columns = states 1:1, soft WIP limit, drag = state+rank) and add 'group by' (assignee | epic | priority) instead of stored swimlanes.
- Ship the child-task checklist on Story cards and a parent-state rollup rule (any child started → parent In Progress; all children done → parent Done, per-project toggle) implemented in the domain service so it fires from every entry point, fixing ADO's documented limitation.
- Build TimeEntry + running timer as first-class: one running timer per member (DB partial unique), start/stop from card, item drawer and a global 'My Work' bar, manual add/edit, rollup to Story/Epic/Project, per-member and team totals — the exact 7pace surface ADO users pay for.
- Put hourlyRate (+ currency, optional per-member override, optional budget hours) on Project and snapshot rateApplied on each TimeEntry so project cost = Σ hours × rate is stable and reusable by Phase 4 invoicing.
- Record every field change as an append-only revision with state-category transitions timestamped; defer charts (lead/cycle time, CFD, burndown) to Phase 6 but never lose the data needed to build them.
- Replace queries/WIQL/dashboards with three fixed screens: 'My Work' (assigned to me / following / mentioned / recently updated across projects with timer), 'Project overview' (progress rollup, hours by member, cost vs budget, milestones), and a filter bar (text, assignee, tag, type, epic, show-done) on board and backlog.
- Client sharing = per-item CLIENT_VISIBLE flag + per-project portal toggles; the portal shows shared items grouped by state CATEGORY only, shared documents, milestones and CLIENT_VISIBLE comments; TimeEntry, internal comments, internal states and unassigned/internal items are never portal-readable (RESTRICTIVE RLS) — this is strictly better than ADO's coarse Stakeholder access.
- Add Project templates that seed Epic/Story/Task trees (with estimates and tags) rather than ADO-style field templates; that is what agencies repeat per engagement type.
- Keep single assignee per item (ADO does; multiple-assignee requests exist but complicate time and accountability); use child tasks when several people share a story.
- Handle 'done clutter' explicitly: Done column shows the last 14 days with 'show older'; archive/restore instead of ADO's silent 183-day disappearance.
- Skip for v1: Delivery Plans, area/iteration path trees, teams within a project, capacity-by-activity and days-off calendars, split columns, style rules, WIQL, dashboards/widgets, forecasting, CMMI/Scrum ceremonies, cross-project links, external/remote links.
- Sequence build so autonomous work stays testable: (1) schema WorkItem/State/Tag/Link/Revision + RLS + isolation tests, (2) backlog + board with drag/rank/state, (3) item drawer with comments/mentions/attachments/history, (4) TimeEntry + timer + rollups + rates/cost, (5) portal sharing, (6) optional Sprint/taskboard, (7) metrics.

**Open questions**
- Hierarchy depth: three levels (Epic → Story → Task) or two (Story → Task) for v1? Recommended default: allow three but make Epic optional and hide the Epic level in the UI until a project has one.
- Are Bugs a separate type or a Story flag? Recommended default: WorkItem.type includes BUG at Story level (ADO's 'bugs as requirements' mode), no separate bug workflow.
- Should time be trackable at Project level without a task (e.g. meetings, admin)? Recommended default: v1 requires a work item; auto-create a per-project 'General' Story to absorb such time; revisit when timesheets arrive.
- Estimates in hours or points? Recommended default: hours on Task (estimate/remaining) and optional points on Story; no velocity/forecast in v1.
- Custom states: per project or per tenant template? Recommended default: tenant-level 'workflow presets' (e.g. Default, Web build with Design/Dev/QA/Review) that a project picks at creation and may tweak; states carry categories so metrics stay valid.
- Should the client portal ever show a board or only a list/timeline? Recommended default: a read-only, category-collapsed board of CLIENT_VISIBLE items plus milestone timeline; no drag, no comments on internal items; per-project toggle.
- Who may see cost figures internally? Recommended default: new permission codes time:read_own, time:read_all, project:cost_read (CEO/Manager only), added to the immutable catalog.
- Sprints in v1 or continuous flow only? Recommended default: continuous flow per project in v1; optional tenant-wide Sprint entity in v1.x with a taskboard grouped by story or by person.
- Running-timer semantics when switching tasks: auto-stop previous timer or block? Recommended default: auto-stop and start the new one (one running timer per member enforced by DB), with a toast to undo.
- Time-entry editing/approval: allow members to edit their own past entries freely? Recommended default: yes within the current locked period, with every edit audited; approvals/locking postponed to the invoicing phase.
- Notifications channel: email only in v1 (SES) or in-app inbox too? Recommended default: in-app notification table + email for @mention and 'assigned to me changed'; digests and Slack later.

**Sources**
- [Default processes and process templates - Azure Boards](https://learn.microsoft.com/en-us/azure/devops/boards/work-items/guidance/choose-process)
- [Link Types Reference Guide - Azure Boards](https://learn.microsoft.com/en-us/azure/devops/boards/queries/link-type-reference)
- [About Kanban boards - Azure Boards](https://learn.microsoft.com/en-us/azure/devops/boards/boards/kanban-overview)
- [Manage columns on your board - Azure Boards](https://learn.microsoft.com/en-us/azure/devops/boards/boards/add-columns)
- [Customize cards on a board - Azure Boards](https://learn.microsoft.com/en-us/azure/devops/boards/boards/customize-cards)
- [Set Work in Progress Limits - Azure Boards](https://learn.microsoft.com/en-us/azure/devops/boards/boards/wip-limits)
- [Expedite work using swimlanes - Azure Boards](https://learn.microsoft.com/en-us/azure/devops/boards/boards/expedite-work)
- [Use backlogs to manage projects - Azure Boards](https://learn.microsoft.com/en-us/azure/devops/boards/backlogs/backlogs-overview)
- [How workflow category states are used - Azure Boards](https://learn.microsoft.com/en-us/azure/devops/boards/work-items/workflow-and-state-categories)
- [Set work item automation rules - Azure Boards](https://learn.microsoft.com/en-us/azure/devops/boards/backlogs/automate-work-item-state-transitions)
- [Set the team sprint capacity - Azure Boards](https://learn.microsoft.com/en-us/azure/devops/boards/sprints/set-capacity)
- [Track progress on the Taskboard - Azure Boards](https://learn.microsoft.com/en-us/azure/devops/boards/sprints/task-board)
- [Forecast your product backlog - Azure Boards](https://learn.microsoft.com/en-us/azure/devops/boards/sprints/forecast)
- [Query by numeric fields (effort, estimates, story points) - Azure Boards](https://learn.microsoft.com/en-us/azure/devops/boards/queries/query-numeric)
- [Use managed queries to list work items - Azure Boards](https://learn.microsoft.com/en-us/azure/devops/boards/queries/about-managed-queries)
- [Use team delivery plans - Azure Boards](https://learn.microsoft.com/en-us/azure/devops/boards/plans/review-team-plans)
- [Cumulative flow, lead time, and cycle time guidance](https://learn.microsoft.com/en-us/azure/devops/report/dashboards/cumulative-flow-cycle-lead-time-guidance)
- [Catalog of out-of-box dashboard widgets](https://learn.microsoft.com/en-us/azure/devops/report/dashboards/widget-catalog)
- [About work items and work item types - Azure Boards](https://learn.microsoft.com/en-us/azure/devops/boards/work-items/about-work-items)
- [Update work items with templates - Azure Boards](https://learn.microsoft.com/en-us/azure/devops/boards/backlogs/work-item-template)
- [How are area and iteration paths used?](https://learn.microsoft.com/en-us/azure/devops/organizations/settings/about-areas-iterations)
- [About notifications - Azure DevOps](https://learn.microsoft.com/en-us/azure/devops/organizations/notifications/about-notifications)
- [Stakeholder access quick reference](https://learn.microsoft.com/en-us/azure/devops/organizations/security/stakeholder-access)
- [7pace Timetracker for Azure DevOps (Marketplace)](https://marketplace.visualstudio.com/items?itemName=7pace.Timetracker)
- [Extension Spotlight – 7pace Timetracker (Azure DevOps Blog)](https://devblogs.microsoft.com/devops/extension-spotlight-7pace-timetracker/)
- [Azure DevOps Review 2026 — weaknesses for project management (Product Owl)](https://www.productowl.io/project-management-software/azure-devops)
- [Azure Boards Pros and Cons (G2)](https://www.g2.com/products/azure-boards/reviews?qs=pros-and-cons)
- [Azure DevOps UX is horrible (Blind discussion)](https://www.teamblind.com/post/azure-devops-ux-is-horrible-vjttrrch)
- [Performance issues on Azure DevOps boards (Microsoft Q&A)](https://learn.microsoft.com/en-us/answers/questions/15c40cb8-ca9c-47b5-bdc3-33cf9fb7b952/performance-issues-on-azure-devops-boards)
- [Jira vs Azure DevOps for small teams (Unito)](https://unito.io/blog/jira-vs-azure-devops/)
- [Improved sprint board filtering (Sprint 274 release notes)](https://learn.microsoft.com/en-us/azure/devops/release-notes/2026/sprint-274-update)


## Client-sharing: selective progress sharing and client-portal presentation for Fortleva

Across Basecamp, Teamwork, Productive, Scoro, Rocketlane, SuiteDash, monday, Asana, ClickUp, Linear, JSM and the portal-first tools (Copilot, Assembly, Hubflo, Moxie, Bonsai), one sharing model dominates and it matches Fortleva's existing design almost exactly: (1) a client is attached at the project level (Basecamp "Work with clients", Teamwork client company on project, Rocketlane customer added to project); (2) inside that project every item is private by default and is made client-visible by an explicit act, with a permanent visual badge (Basecamp's blue-lock "private to our team" vs yellow-eye "the client can see this"; Rocketlane private/shared tasks and phases; monday two-board pattern); (3) child items inherit the parent's visibility (Basecamp: to-dos inherit the list, comments inherit the item; Teamwork: tasks inherit task-list privacy) — inheritance is what makes item-level toggles usable rather than exhausting; (4) comments are the sharpest edge and get their own switch (JSM "internal note" vs "reply to customer" with different background colour; Basecamp comments inherit the parent; Fortleva already has IssueComment.visibility). Every serious tool adds a "view as client"/impersonation preview (Teamwork, Productive, Rocketlane presentation mode) because staff cannot otherwise trust the badges. Nobody offers bulk-publish beyond templates that carry visibility (Basecamp templates preserve client-visibility) — that is a cheap differentiator. What clients actually consume: a single project overview with health/status, "what's next", the actions waiting on them (Rocketlane "Action items"), the recent update log, files, and — for hourly/retainer work — hours used vs remaining in the current billing cycle. Productive is the reference for money-safe hours sharing: clients see services, billable hours, quantity, budget total/used/remaining, and billable time entries with task/note, but never worked (non-billable) time, cost, hourly rate, margin or profit — and only after a per-budget "Client can view this budget" toggle. Status updates (Asana, Linear, Teamwork, Rocketlane, SuiteDash) are immutable, timestamped posts with a 3-4 value health enum, rich text, optional auto-populated highlights (done since last update / upcoming), archived chronologically with comments; Linear adds reminder cadence and "update missing" staleness; SuiteDash puts them on the client dashboard with a progress arc. Complaints cluster around portals that are stale/duplicated (Notion, monday mirror boards), too many tabs, no email delivery (clients don't log in), and silent defaults (Basecamp CLI posting private with no warning). Recommendation: keep the data-layer flag as the single truth, add project-level portal enablement + inheritance + explicit "share to portal" UX with preview, ship a client-facing Project Update entity and a weekly digest, and share hours only via a per-project toggle in hours-only or billable-amount modes, never rates.

**Recommendations**
- Keep the single data-layer flag (INTERNAL|CLIENT_VISIBLE) as the only truth and add three UX layers on top: project-level `portalEnabled` gate, parent→child inheritance with DB CHECK, and an always-visible badge + composer prompt — this reproduces Basecamp's proven model on Fortleva's stronger enforcement.
- Ship 'View as <Contact>' preview in the same phase as any sharing UI; it reuses the portal projection queries and is the cheapest trust-builder observed across Teamwork/Productive/Rocketlane.
- Build ProjectUpdate (health + rich text + structured 'done / next / need from you' + hours snapshot) as the client-facing progress-report primitive, immutable, timelined, with weekly reminder to the project lead — this satisfies the founder's 'progress reports with timelines' request without a separate reporting module.
- Portal home = Action items first (approvals, replies, client tasks), then project overview cards (health, next milestone, latest update), then recent activity; do not expose kanban to clients by default (per-project toggle only).
- Weekly digest email to Contacts is a must in the same phase as portal read surfaces; assemble from client-visible ProjectUpdates/versions/action items/hours; skip when empty; every fact re-checked against visibility at send time (Phase 5 test family already demands this).
- Hours sharing: per-project `hoursSharingMode` (NONE default | HOURS | BILLABLE_AMOUNT), gated by CONTACT_PRIMARY profile, showing billable time only with task/note; cost rate, bill rate, non-billable time, margin never enter the portal projection — enforce with an allowlisted select and a test that greps the projection for forbidden columns.
- Give retainers a cycle-shaped view (used/remaining/reset/log) — a differentiator versus Toggl/Harvest that fits Naxdor's SEO/maintenance services.
- Generalise comment privacy (JSM two-mode composer, contact-authored forced visible) from IssueComment to a shared Comment model used by tasks, updates and documents; warn when a Contact is mentioned/assigned on an internal item.
- Extend approvals from ProjectVersion inline fields to Documents in Phase 5 with an ApprovalRequest entity; keep one-click approve from email; show approval history on the item.
- Templates should carry visibility (Basecamp) and bulk-visibility change with confirmation + audit should exist from day one — nobody does bulk well and it is trivial with the audit catalog.
- Skip public no-login share links and magic links in v1: they bypass the Contact identity model and add a leak surface; revisit after contact MFA.
- Do not build a separate 'client board' or mirrored copy of anything (monday/Notion anti-pattern); every client view is a projection of the same rows.
- Add the missing audit events (portal_enabled, project_update.published, hours_sharing.changed, comment.visibility_changed, digest.sent) and a fifth test family: 'portal projection contains no forbidden columns' run against every portal query.

**Open questions**
- Should hours be shareable at all in v1 (Phase 3) or wait for the time-tracking module? Recommended default: schema fields now (hoursSharingMode NONE), UI when timers ship.
- Which profile can see hours: CONTACT_PRIMARY only (Productive Client Lead pattern) or a separate 'can view hours' per-contact bit? Default: CONTACT_PRIMARY only.
- Should client-visible tasks/kanban exist in v1 or only milestones + updates + versions? Default: milestones/updates/versions in Phase 3; task list toggle per project in the tasks phase, kanban later.
- Update immutability: strictly immutable (Asana) or 15-minute edit window (Teamwork)? Default: 15-minute edit window then immutable, with visible 'edited' marker.
- Digest cadence and default: opt-out weekly Friday digest for every active Contact, or opt-in? Default: opt-out weekly, per-contact preference, tenant-level default day/time.
- Should Contacts be able to comment on ProjectUpdates (SuiteDash toggle) in Phase 3 or wait for Phase 5 comments? Default: wait for the shared Comment model in Phase 5.
- Progress percentage: computed from client-visible tasks, from milestones, or manual? Default: milestone-based with manual override; never from internal task counts.
- Public read-only share links: skip in v1? Default: skip; revisit with contact MFA and expiring signed links.
- Sharing credentials to clients from the vault: v1 internal-only? Default: internal-only; client reveal is a later, separately audited feature.
- Should a Contact be assignable to Tasks in the same Task model or via a separate 'client request' entity? Default: same Task model with assigneeContactId, auto CLIENT_VISIBLE.

**Sources**
- [Basecamp — What clients can see and do](https://5.basecamp-help.com/article/1082-what-clients-can-see-and-do)
- [Basecamp — Working with clients](https://5.basecamp-help.com/article/1081-working-with-clients)
- [Basecamp — Using Basecamp as a client](https://5.basecamp-help.com/article/1084-using-basecamp-as-a-client)
- [Basecamp bc3-api client_visibility.md](https://github.com/basecamp/bc3-api/blob/master/sections/client_visibility.md)
- [Basecamp CLI issue #457 (silent private default)](https://github.com/basecamp/basecamp-cli/issues/457)
- [Basecamp — client access on templates](https://updates.37signals.com/post/new-in-basecamp-client-access-on-templates)
- [Basecamp — Hilltop view (Hill Charts hidden from clients)](https://updates.37signals.com/post/new-in-basecamp-hilltop-view)
- [Signal v. Noise — brand new way to work with clients in Basecamp 3](https://signalvnoise.com/svn3/launch-a-brand-new-way-to-work-with-clients-in-basecamp-3/)
- [Signal v. Noise — Helping clients and firms get to Yes (Clientside approvals)](https://signalvnoise.com/svn3/helping-clients-and-firms-get-to-yes/)
- [Signal v. Noise — Two new email reports in Basecamp](https://signalvnoise.com/svn3/two-new-email-reports-in-basecamp/)
- [Teamwork — Client users](https://support.teamwork.com/projects/using-teamwork/working-with-client-users)
- [Teamwork — User permissions and access](https://support.teamwork.com/projects/using-teamwork/understanding-user-permissions-and-access)
- [Teamwork — Who sees what: permissions and privacy](https://www.teamwork.com/blog/who-sees-what-customizing-permissions-and-privacy-in-teamwork-projects/)
- [Teamwork — Setting privacy on task lists](https://support.teamwork.com/projects/privacy/privacy-on-task-lists)
- [Teamwork — Adding project updates](https://support.teamwork.com/projects/project-options/project-updates)
- [Teamwork — Requesting a project update](https://support.teamwork.com/projects/project-sections/requesting-a-project-update)
- [Productive — What can a client see on a budget](https://help.productive.io/en/articles/2179670-what-can-a-client-see-on-a-budget)
- [Productive — What can a client see after joining](https://help.productive.io/en/articles/2179600-what-can-a-client-see-after-joining-productive)
- [Productive — Giving clients access to budgets and timesheets](https://help.productive.io/en/articles/2179616-giving-clients-access-to-budgets-and-timesheets)
- [Scoro — Customer portal as an administrator](https://support.scoro.com/hc/en-us/articles/12404542608909-Customer-portal-as-an-administrator)
- [Scoro — Customer portal as a user](https://support.scoro.com/hc/en-us/articles/12404614068109-Customer-portal-as-a-user)
- [Linear — Initiative and project updates](https://linear.app/docs/initiative-and-project-updates)
- [Linear — Customer requests](https://linear.app/docs/customer-requests)
- [Asana — Status updates API](https://developers.asana.com/reference/status-updates)
- [Asana — Share project updates](https://help.asana.com/hc/en-us/articles/14246229345947-Project-status-updates-and-reporting)
- [Asana Forum — read-only link viewers cannot open task details](https://forum.asana.com/t/allow-public-link-viewers-to-open-task-details-in-read-only-mode/1143036)
- [ClickUp — Share with a public link](https://help.clickup.com/hc/en-us/articles/6309298874775-Share-locations-and-items-with-a-public-link)
- [monday community — client-facing boards](https://community.monday.com/learn-workflows-best-practices/post/how-to-create-client-facing-boards-in-monday-for-visibility-and-moD2B5cnxLzepPy)
- [monday — Shareable boards](https://support.monday.com/hc/en-us/articles/115005309925-Shareable-Boards)
- [Jira Service Management — talk to the customer or team members](https://support.atlassian.com/jira-service-management-cloud/docs/talk-to-the-customer-or-team-members-from-the-new-issue-view/)
- [Atlassian community — restrict internal notes to roles](https://community.atlassian.com/forums/Jira-Service-Management-articles/New-Restrict-your-internal-notes-to-project-roles-or-groups/ba-p/2704909)
- [JSM — What are approvals](https://support.atlassian.com/jira-service-management-cloud/docs/what-are-approvals/)
- [Rocketlane — Customer portal](https://help.rocketlane.com/support/solutions/articles/67000711318-the-rocketlane-customer-portal)
- [Rocketlane — Customer portal status update tab](https://help.rocketlane.com/support/solutions/articles/67000712189-the-customer-portal-status-update-tab)
- [Rocketlane — Customer portal project plan tab](https://help.rocketlane.com/support/solutions/articles/67000712052-the-customer-portal-project-plan-tab)
- [Rocketlane — Approvals for tasks and documents](https://help.rocketlane.com/support/solutions/articles/67000732734-how-to-manage-approvals-for-tasks-and-documents)
- [Rocketlane — 2FA and magic links](https://help.rocketlane.com/support/solutions/articles/67000745544-2fa-and-magic-links)
- [Rocketlane — Customer Portal 2.0 announcement](https://www.rocketlane.com/blogs/customer-portal)
- [SuiteDash — Project dashboard](https://help.suitedash.com/article/120-project-dashboard)
- [SuiteDash — Project settings](https://help.suitedash.com/article/78-project-settings)


## modern-ux — best-UX work-management tools (Linear, Height, Shortcut) and leading OSS (Plane, Huly, Vikunja, Focalboard, Taiga, OpenProject, Leantime, WeKan, Kanboard, AppFlowy, Kimai): UX patterns + data models to copy for Fortleva's Work module

Across every tool studied, the "feels fast and friendly" quality comes from a small set of repeatable decisions rather than feature count: (1) latency is treated as a bug — Linear renders from a local store with optimistic writes (<50ms navigations; its "new issue" flow measured 2.4s vs Jira's 9.1s), and Jira is the most-hated tool in the 2025 Pragmatic Engineer survey precisely because of slowness, "200 fields on a ticket" and click-heavy UI; (2) keyboard-first everywhere (single-key actions C/S/A/L/P, G-then-X navigation, Cmd+K command palette, X to multi-select, ? for help); (3) inline editing on every property with no modal round-trips; (4) one universal "view" abstraction (filters + group-by + order-by + layout + visible properties) that is saved, shared, favourited and reused for list/board/calendar/timeline; (5) opinionated defaults with escape hatches (fixed state CATEGORIES with custom named states inside them; five fixed priorities; a handful of estimate scales).

Data-model consensus is remarkably uniform. Plane (Django, closest OSS to Linear+Jira) is the best schema reference: Issue{sequence_id per project, state FK, priority enum, parent self-FK, sort_order float default 65535, start/target dates, estimate_point FK, is_draft, archived_at, completed_at}; State{group ∈ backlog|unstarted|started|completed|cancelled|triage, sequence float, default bool}; IssueRelation{relation_type ∈ blocked_by|relates_to|duplicate|start_before|finish_before|implemented_by with reverse mapping}; IssueActivity{verb, field, old_value, new_value, old_identifier, new_identifier}; IssueView{filters JSON, display_filters JSON{group_by,order_by,layout,sub_issue,show_empty_groups}, display_properties JSON, access}; Cycle/Module join tables; Intake{status pending/accepted/rejected/snoozed/duplicate, snoozed_till, duplicate_to, source}; Notification{receiver, read_at, snoozed_till, archived_at, entity_name/identifier}; Label{parent, color, sort_order}. Ordering is float/fractional everywhere (Plane 65535+ gaps, Vikunja float per-view position, Focalboard cardOrder array, Taiga three separate order columns per context, Kanboard integer position) — fractional-indexing string keys per (container, view) is the modern default. Time tracking done well (Huly TimeSpendReport{employee,date,value,description} + Issue.estimation/reportedTime/remainingTime; Kimai Timesheet{begin,end null=running,duration,rate,internalRate,hourlyRate,fixedRate,billable,exported}; OpenProject start/stop timer since v13, per-user rate history with valid-from dates) gives Fortleva a proven pattern for the founder's timer + cost-per-hour ask.

Key recommendation: model one WorkItem table (not separate Task and Issue) with configurable States grouped by category, per-tenant/project sequence numbers, a per-view fractional rank table, an activity table doubling as feed, and a TimeEntry table with end=null as the running timer and rate snapshot at save time. Portal-created client requests land in a Triage/Intake state — Linear/Plane pattern — and are accepted into the normal flow.

**Recommendations**
- Rename/merge: turn the current fixed-enum Issue into a general WorkItem with configurable States grouped by category and a TRIAGE category for portal-submitted requests — one table for tasks and client requests avoids duplicated comments/attachments/activity/notifications and matches Linear/Plane intake exactly.
- Copy Plane's schema shapes (State.group, IssueRelation types, IssueActivity old/new+identifiers, IssueView filters/display_filters/display_properties JSON, Notification, Label.parent) almost verbatim; it is battle-tested and Apache-2.0-friendly to study. Reference paths: github.com/makeplane/plane/tree/preview/apps/api/plane/db/models/{issue.py,state.py,view.py,cycle.py,module.py,estimate.py,label.py,project.py,notification.py,intake.py,issue_type.py,workspace.py}.
- Adopt fractional-indexing string ranks stored per (view/container, item) from day one (rocicorp/fractional-indexing npm) — retrofitting ordering after users have boards is painful; Taiga's three order columns show why per-context rank matters.
- Build the Work module as one generic <WorkItemView> (filters+groupBy+orderBy+layout) with list and board layouts first, then calendar/timeline; every page (My work, project backlog, client portal tasks, cycle) is a saved view instance. Persist per-member last-used display settings (Plane ProjectMember.view_props).
- Model time as TimeEntry rows where endedAt IS NULL means running, with a partial unique index per member (toggleable to allow parallel timers), and snapshot hourlyRate/internalRate/currency into each entry from a ProjectRate history table; compute project cost per member and total from entries, never from a stored total.
- Ship a global keymap registry + cmdk palette in Phase 1 of the Work module (C, S, A, L, P, E, X, G-chords, ?, Cmd+K) and show shortcuts in tooltips; this is cheap and is what makes it 'not an MVP' in the founder's eyes.
- Use optimistic mutations (TanStack Query or React 19 useOptimistic + Server Actions) with rollback toasts and side-peek detail panels; do NOT attempt a Linear-style local-first sync engine as a solo founder — the 80% is achievable with caching + optimistic writes.
- Keep opinionated defaults: 5 priorities as an enum, default states Backlog/Todo/In Progress/Done/Cancelled (+Triage), sub-issue depth ≤3, single assignee, hours as the v1 estimate unit; add point scales, cycles, custom typed properties as later entitlement-gated modules.
- Portal projection: portal reads WorkItems through the existing RESTRICTIVE RLS (visibility + clientId) and shows category-level status, progress bars, milestones, project updates and EXTERNAL comments; add a 'share to client' toggle on item, comment, update and document, and a per-project 'portal shows: tasks|milestones|updates|time summary' preference. Never expose internal state names, time entries or rates unless explicitly enabled.
- Add Project Updates (health On track/At risk/Off track + rich text, weekly reminder to lead, client-visible toggle) early — it is the founder's 'progress reports with timelines' with almost no schema cost.
- Activity as its own table (WorkItemActivity) driving both the item timeline and notifications; keep AuditEvent for privileged/security ops only, and dual-write the catalogued events (issue.state_changed, issue.triaged, timer.started/stopped, rate.changed).
- Study three OSS repos for UX/code, not just schema: Plane (React/MobX web app: apps/web/core/components/issues for list/kanban/spreadsheet layouts and drag logic), Huly platform (plugins/tracker + models/tracker/src for Issue/TimeSpendReport/estimation and its rank-based ordering), Vikunja (pkg/models/tasks.go, project_view.go, kanban buckets/filters mode) and Focalboard (webapp/src/blocks/boardView.ts for a compact view definition; server/model/block.go for the property-bag design to avoid).
- Add project templates (default states, labels, milestones, rate) per service type and item templates; agencies repeat project shapes per client and this is where a solo-run tool earns time back.
- Deliberately skip in v1: Azure-style 4-level hierarchy, sprint capacity planning, custom typed properties, SLAs, poker/voting, gantt dependencies with auto-scheduling, AI standups — each is a later entitlement module and none blocks the founder's stated needs.

**Open questions**
- One WorkItem table for both tasks and client requests (triage category) vs keep Issue separate? Recommended default: one table with kind + triage fields; the existing Issue spec becomes the REQUEST kind.
- Assignment model: single assignee (Linear) or multiple (Plane)? Recommended default: single assignee + collaborators join, because per-member time/cost attribution and 'my work' are unambiguous.
- Timer policy: one running timer per member (Kimai default) or allow parallel? Recommended default: one, enforced by partial unique index, with a TenantPreference to relax it later.
- Rate precedence and currency: per project only (founder ask) or project→member→tenant fallback with rate history? Recommended default: full fallback chain with validFrom history and snapshot on entry; single currency per tenant in v1.
- Should time entries and costs ever be client-visible? Recommended default: never by default; a per-project preference can expose an hours-summary widget (total hours this month) but never rates or per-member detail.
- Estimate unit in v1: hours vs points? Recommended default: hours (agency billing reality), with Plane-style Estimate scales as a later toggle.
- Ordering key: fractional-indexing strings vs Decimal(20,10)? Recommended default: strings via rocicorp/fractional-indexing (well-tested, ISO order in Postgres text) with a rebalance job.
- State scope: states per project (Plane) or per tenant 'workflow' shared by projects (Linear team)? Recommended default: tenant-level workflow templates copied into each project on creation (project-level rows), so a client project can deviate without affecting others.
- Sub-issue depth: unlimited vs capped? Recommended default: cap at 3 with UI nudging to milestones for anything larger.
- Should client (portal) contacts be able to create work items directly? Recommended default: yes, but only into TRIAGE with visibility CLIENT_VISIBLE and no state/assignee control — matches the existing spec that contacts must see their own reports.
- Local-first sync engine (Linear-style) or optimistic mutations + cache? Recommended default: optimistic + cache; revisit only if measured latency is a complaint.
- Cycles/sprints in v1? Recommended default: no — milestones + saved views cover agencies; cycles behind an entitlement later.

**Sources**
- [Plane models directory (Django) — issue.py, state.py, view.py, cycle.py, module.py, estimate.py, label.py, project.py, notification.py, intake.py, issue_type.py, workspace.py](https://github.com/makeplane/plane/tree/preview/apps/api/plane/db/models)
- [Plane issue.py (Issue, IssueRelation, IssueActivity, IssueComment, IssueSequence…)](https://raw.githubusercontent.com/makeplane/plane/preview/apps/api/plane/db/models/issue.py)
- [Plane state.py (State groups, default sequences)](https://raw.githubusercontent.com/makeplane/plane/preview/apps/api/plane/db/models/state.py)
- [Plane view.py (IssueView filters/display_filters/display_properties)](https://raw.githubusercontent.com/makeplane/plane/preview/apps/api/plane/db/models/view.py)
- [Plane intake.py (IntakeIssue statuses)](https://raw.githubusercontent.com/makeplane/plane/preview/apps/api/plane/db/models/intake.py)
- [Plane notification.py](https://raw.githubusercontent.com/makeplane/plane/preview/apps/api/plane/db/models/notification.py)
- [Plane custom properties API (property types)](https://developers.plane.so/api-reference/issue-types/properties/overview)
- [Plane docs — work item properties](https://docs.plane.so/core-concepts/issues/properties)
- [Linear docs — Conceptual model](https://linear.app/docs/conceptual-model)
- [Linear docs — Configuring workflows (state categories)](https://linear.app/docs/configuring-workflows)
- [Linear docs — Estimates](https://linear.app/docs/estimates)
- [Linear docs — Custom views](https://linear.app/docs/custom-views)
- [Linear docs — Display options](https://linear.app/docs/display-options)
- [Linear docs — Triage](https://linear.app/docs/triage)
- [Linear docs — SLAs](https://linear.app/docs/sla)
- [Linear docs — Parent and sub-issues](https://linear.app/docs/parent-and-sub-issues)
- [Linear docs — Issue relations](https://linear.app/docs/issue-relations)
- [Linear docs — Inbox](https://linear.app/docs/inbox)
- [Linear docs — Initiative and Project updates (health)](https://linear.app/docs/initiative-and-project-updates)
- [Linear docs — Project status](https://linear.app/docs/project-status)
- [Linear keyboard shortcuts cheat sheet](https://shortcut.fyi/linear-shortcuts)
- [Linear — Invisible details (craft/UX)](https://medium.com/linear-app/invisible-details-2ca718b41a44)
- [Reverse engineering Linear's sync engine](https://github.com/wzhudev/reverse-linear-sync-engine)
- [Linear vs Jira 2025 — why teams switch (timing data)](https://productmanagementresources.com/linear-vs-jira/)
- [Developer-First #163 — developers' most hated tools (Pragmatic Engineer survey)](https://developerfirst.substack.com/p/developer-first-163-developers-most)
- [Huly platform repo (tracker plugin/models)](https://github.com/hcengineering/platform)
- [Huly tracker model types.ts (TIssue, TTimeSpendReport, TProject)](https://github.com/hcengineering/platform/blob/develop/models/tracker/src/types.ts)
- [Huly docs — related and blocking issues](https://docs.huly.io/task-tracking/related-issues/)
- [Vikunja tasks.go (Task struct, position, buckets)](https://raw.githubusercontent.com/go-vikunja/vikunja/main/pkg/models/tasks.go)
- [Vikunja project_view.go (view kinds, bucket configuration modes)](https://raw.githubusercontent.com/go-vikunja/vikunja/main/pkg/models/project_view.go)
- [Focalboard boardView.ts (view definition)](https://raw.githubusercontent.com/mattermost-community/focalboard/main/webapp/src/blocks/boardView.ts)
- [Focalboard board.ts (property types)](https://raw.githubusercontent.com/mattermost-community/focalboard/main/webapp/src/blocks/board.ts)
- [Focalboard block.go (property-bag block model)](https://github.com/mattermost-community/focalboard/blob/main/server/model/block.go)
- [Kanboard Postgres schema (columns.task_limit, subtasks, transitions, time tracking)](https://raw.githubusercontent.com/kanboard/kanboard/main/app/Schema/Sql/postgres.sql)
- [WeKan cards.js schema](https://raw.githubusercontent.com/wekan/wekan/main/models/cards.js)
- [Taiga userstories models (backlog_order/sprint_order/kanban_order)](https://raw.githubusercontent.com/taigaio/taiga-back/main/taiga/projects/userstories/models.py)
- [AppFlowy field_entities.rs (FieldType enum)](https://raw.githubusercontent.com/AppFlowy-IO/AppFlowy/main/frontend/rust-lib/flowy-database2/src/entities/field_entities.rs)
- [OpenProject work packages user guide](https://www.openproject.org/docs/user-guide/work-packages/)
- [OpenProject time tracking (start/stop timer, rates)](https://www.openproject.org/docs/user-guide/time-and-costs/time-tracking/)
- [OpenProject cost types / rates admin](https://www.openproject.org/docs/system-admin-guide/time-and-costs/)


## Time tracking specialists (Toggl Track, Harvest, Clockify, Kimai, Solidtime, Everhour, Tempo, Timely, Hubstaff) — timer, timesheet, rates and cost engine design for Fortleva

Every mature tracker converges on the same core: a TimeEntry row = (member, project, optional task, description, tags, startedAt, stoppedAt NULL while running, cached durationSeconds, billable flag, snapshotted bill rate, optional cost rate, locked/billed markers). Running entries are stored as start + null stop (Kimai, Solidtime, Harvest); Toggl's "negative duration = running" is a legacy hack nobody copies. Exactly one running entry per person is the norm — Kimai's default setting is 1 with auto-stop-on-start, Solidtime rejects a second start with an error, Toggl/Everhour clients auto-stop the previous one. Timestamps are server-set UTC (timestamptz) with the member's IANA timezone and a "local date" column stored per entry (Kimai date_tz) so day/week grids, midnight-spanning entries and lock dates behave; entries crossing midnight stay one row attributed to their start date (Toggl applies rates by start date), with an explicit "split" action (Clockify) rather than automatic splitting.

Rates: every product has a most-specific-wins hierarchy; the disagreement is only whether task-level beats project-member-level (Toggl: task > project member > project > workspace member > workspace; Clockify: project member > task > project > member > workspace; Kimai has no task rate but user-specific activity/project/customer rates scored by points; Solidtime has no task rate at all). All snapshot the resolved rate onto the entry so old entries never silently reprice (Kimai: "existing records will never be changed retrospectively"; Clockify: historic rate kept, optional retroactive apply; Toggl Premium keeps an effective-dated rate timeline and picks the rate valid on the entry's start date). Cost rate is a separate, sensitive number (Harvest cost_rate, Clockify cost rates, Kimai internal_rate). Rounding is applied at report/invoice time, per entry, with raw seconds preserved (Harvest rounded_hours vs hours; Kimai warns that displayed hours × rate must equal amount, hence 36-second/0.01h rounding).

Locking: entries lock when invoiced, approved, or older than a lock date (Harvest is_locked + locked_reason; Clockify lock date/auto-lock "older than X"; Kimai lockdown + exported flag). Budgets are hours or money, optionally recurring for retainers, alerting once per threshold (Everhour 75/90/custom, checks every 2 min; Hubstaff notify %); estimates vs actuals live on tasks and projects (Solidtime caches spent_time on projects/tasks; Tempo adjusts remainingEstimate on log). Unbilled billable time → invoice lines grouped by project/task/person with a detailed report attached (Harvest), entries then marked billed and locked. Recommendation for Fortleva v1: server-authoritative single timer with auto-stop, seconds granularity, effective-dated RateCard table + per-entry snapshot, project-level budgets and rounding rules, lock-on-invoice plus tenant lock date, computed-on-read aggregation with a portal-facing rollup, and no idle detection/approval workflow yet.

**Recommendations**
- Adopt one-running-timer-per-member with server-side auto-stop and a partial unique index; it is the semantics every product converged on and it removes an entire class of dirty data.
- Store startedAt/stoppedAt as timestamptz, durationSeconds cached with CHECK constraints, plus entry.timezone and localDate — copy Kimai's column set, not Toggl's negative-duration API.
- Build a RateCard table with effective dates and snapshot the resolved bill/cost rate onto each entry at write time; reprice only via an explicit audited command that skips billed/locked entries (Toggl history + Kimai immutability).
- Ship v1 rate tiers as project-member > project > member > tenant (bill) and member > tenant (cost); leave the task tier out until a real customer asks — Toggl and Clockify disagree on where task rates sit, which signals it is a niche need.
- Keep rounding out of storage: apply project rounding rules at report/invoice time, freeze rounded hours into InvoiceLine.quantity, and export raw and rounded columns side by side (Harvest).
- Compute aggregates on read with the recommended indexes; only introduce cached spentSeconds / ProjectTimeSummary rollups where the portal needs a visibility-safe surface or when reports get slow — a small-agency tenant has tens of thousands of entries, not millions.
- Feed the portal from a project-level rollup gated by shareTimeWithClient/shareAmountsWithClient, never from raw entries; this satisfies 'client sees chosen things' without weakening the RESTRICTIVE RLS default.
- Implement lock-on-invoice in the same phase as unbilled→invoice generation, and a tenant lock date with admin bypass; defer submit/approve workflows to a later phase.
- Implement budgets on Project (hours or money, optional monthly reset for retainer Services) with once-per-threshold alerts stored in a dedupe table, evaluated on entry stop and nightly.
- Add the 8h nudge email and configurable max timer duration in v1; skip idle detection, activity capture and screenshots permanently on privacy and web-only grounds.
- Expose a tiny timer API surface (GET /timer/current, POST /timer/start, POST /timer/stop, PATCH /time-entries/:id, POST /time-entries/:id/split, POST /time-entries/:id/continue) so the persistent timer bar, task cards and the week grid share one server truth.
- Wire estimates vs actuals into the task entity from the start (estimateSeconds) so kanban cards and project pages show progress without a later migration.
- Treat cost rates as sensitive: separate permission, excluded from CSV exports by default, never in AuditEvent metadata, never in portal rollups.
- Write the four extra test families for time: one-running-timer race (parallel starts), lock/billed immutability, rate snapshot stability across RateCard changes, and portal rollup never leaking INTERNAL entries or cost.

**Open questions**
- Overlap policy default: block (clean data, Solidtime optional) or warn-only (Kimai default allows overlaps)? Recommended default: block, tenant preference to allow.
- Should task-scoped bill rates exist in v1? Recommended: no — project-member/project/member/tenant only; revisit as WorkCategory (activity) rates in v2.
- When a rate is edited, default reprice scope: from today (Toggl default) or none (Kimai)? Recommended: prompt with 'from today' preselected, never touching billed/locked entries.
- Rounding default for new tenants: none (exact minutes) vs nearest 6 min vs up to 15 min? Recommended: none at tenant level, set per project when a contract requires it.
- Auto-stop long timers at N hours or only nudge? Recommended: nudge at 8h, auto-stop at 12h with needsReview flag, both tenant-configurable.
- Do entries default to non-billable on internal projects and billable on client projects (project.defaultBillable) — recommended yes — and can a tenant force 'billable only' on a project (Toggl workspace setting)? Recommended: per-project toggle, off by default.
- Portal sharing granularity: hours only per month vs also per task and per entry descriptions? Recommended v1: monthly hours (and optional amount) per project; per-entry sharing via CLIENT_VISIBLE flag as a later opt-in.
- Should cost rates be effective-dated from day one (salary changes) or a single current value? Recommended: effective-dated using the same RateCard table — zero extra cost.
- Timesheet approval workflow: skip until Phase 7? Recommended: skip; lock date + billed lock cover a 2–10 person agency.
- Currency on time reports when a client project is in USD and tenant base is SEK: report per project currency only, or convert? Recommended: never convert in time reports; FX belongs to invoicing (Phase 4).

**Sources**
- [Kimai — Rates (points-based precedence, hourly vs fixed, internal rate, no retroactive change)](https://www.kimai.org/documentation/rates.html)
- [Kimai — Timesheet docs (running records, max duration, edit restrictions)](https://www.kimai.org/documentation/timesheet.html)
- [Kimai — Settings (permitted running entries = 1 with auto-stop, overlapping, future entries, lockdown, rounding)](https://www.kimai.org/documentation/configurations.html)
- [Kimai — Rounding (CLASSIC vs DECIMAL mode)](https://www.kimai.org/documentation/rounding.html)
- [Kimai — Timesheet entity source (columns and indexes)](https://github.com/kimai/kimai/blob/main/src/Entity/Timesheet.php)
- [Solidtime — time_entries migration (start, end nullable, billable_rate int, billable, project/task FKs)](https://github.com/solidtime-io/solidtime/blob/main/database/migrations/2024_01_20_110837_create_time_entries_table.php)
- [Solidtime — migrations list (spent_time/estimated_time on projects and tasks, still_active_email_sent_at, member_id)](https://github.com/solidtime-io/solidtime/tree/main/database/migrations)
- [Solidtime — TimeEntryController (one active entry per member, overlap prevention, aggregate grouping, rounding)](https://github.com/solidtime-io/solidtime/blob/main/app/Http/Controllers/Api/V1/TimeEntryController.php)
- [Solidtime — BillableRateService (rate cascade and selective update of existing entries)](https://github.com/solidtime-io/solidtime/blob/main/app/Service/BillableRateService.php)
- [Solidtime docs — Billable rates precedence](https://docs.solidtime.io/user-guide/billable-rates)
- [Toggl Track API — Time entries (start/stop/duration semantics, negative duration, stop endpoint 409, bulk edit)](https://engineering.toggl.com/docs/track/api/time_entries/)
- [Toggl Track — Billable rates (task > project member > project > workspace member > workspace)](https://support.toggl.com/billable-rates)
- [Toggl Track — Historical billable rates (rate timeline, apply from today/date/all, midnight rule)](https://support.toggl.com/historical-billable-rates)
- [Toggl Track — Required fields for time entries](https://support.toggl.com/required-fields-for-time-entries)
- [Toggl Track — Locking time entries](https://support.toggl.com/locking-time-entries)
- [Harvest API v2 — Time entries (hours, hours_without_timer, rounded_hours, is_locked, locked_reason, timer_started_at, billable_rate, cost_rate)](https://help.getharvest.com/api-v2/timesheets-api/timesheets/time-entries/)
- [Harvest — How does time rounding work](https://support.getharvest.com/hc/en-us/articles/360053116772-How-does-time-rounding-work)
- [Harvest — Locked time and expenses](https://support.getharvest.com/hc/en-us/articles/360048687491-Unlocking-time-and-expenses)
- [Harvest — Submitting and approving timesheets](https://support.getharvest.com/hc/en-us/articles/360048181832-Submitting-and-approving-timesheets)
- [Harvest — Uninvoiced report](https://support.getharvest.com/hc/en-us/articles/360048687231-Uninvoiced-report)
- [Harvest — Write off time / mark as invoiced](https://support.getharvest.com/hc/en-us/articles/360053881392-Can-I-write-off-time-or-manually-mark-it-as-invoiced)
- [Clockify — Hourly rates overview (hierarchy, historic rates, retroactive apply)](https://clockify.me/help/reports/hourly-rates)
- [Clockify — Task rates](https://clockify.me/help/reports/task-rates)
- [Clockify — Lock timesheets (manual/auto lock, roles)](https://clockify.me/help/track-time-and-expenses/lock-timesheets)
- [Clockify — Split time entries](https://clockify.me/help/track-time-and-expenses/split-time-entries)
- [Clockify — Pomodoro, idle detection, reminders](https://clockify.me/help/track-time-and-expenses/idle-detection-reminders)
- [Clockify — Approve time & expenses](https://clockify.me/help/extra-features/approval)
- [Everhour — Budgeting (hours/fees, recurring reset, thresholds, block over budget)](https://support.everhour.com/article/501-budgeting)
- [Everhour — Budget alert emails](https://everhour.com/blog/budgets-alert-emails-and-visibility/)
- [Everhour — Recurrent project budgets](https://everhour.com/blog/recurrent-project-budgets-everhour/)
- [Hubstaff — Project budgets](https://support.hubstaff.com/project-level-budgets/)
- [Hubstaff — Project limits (members)](https://support.hubstaff.com/member-limits/)
- [Tempo — Worklog REST APIs for Jira Cloud (timeSpentSeconds, billableSeconds, remainingEstimateSeconds)](https://help.tempo.io/cloudmigration/latest/worklog-rest-apis-for-jira-cloud)
- [Tempo — Approval REST APIs (timesheet-approvals, period, status)](https://help.tempo.io/cloudmigration/latest/approval-rest-apis-for-jira-cloud)
- [Timely — Automatic time tracking (Memory)](https://www.timely.com/feature/automatic-time-tracking/)
- [Toggl Track reviews roundup (no pause, correction clicks, sync complaints)](https://www.timely.com/blog/toggl-track-reviews/)
- [Neon — btree_gist extension](https://neon.com/docs/extensions/btree_gist)
- [Neon — PostgreSQL 18 temporal constraints WITHOUT OVERLAPS](https://neon.com/postgresql/18/temporal-constraints)
- [PostgreSQL 18 — Range types and exclusion constraints](https://www.postgresql.org/docs/current/rangetypes.html)


## code-foundations: exact state of the Fortleva codebase (d:\fortleva) — schema, RLS, db seams, authz, audit, auth, service/UI patterns, tests, stubs

(codebase exploration — see constraints/gaps)

**Constraints**
- One-seam rule (eslint.config.mjs:16-41, TENANCY.md §3): all DB access via withTenant/withPlatform/withUser from '@/db'; never import '@/db/client' or the generated client (types excepted) outside src/db and src/auth.
- Every new Prisma model must be added to MODEL_CLASSES in src/db/model-registry.ts (model-registry.test.ts fails CI otherwise); tenant-scoped models must carry tenantId and be given explicit GRANTs to app_runtime plus ENABLE+FORCE RLS with tenant_isolation + portal_deny (or portal_gate) in a hand-written migration (security_foundations migration pattern; isolation.dbtest.ts posture test fails on any unforced table).
- Client-visible tables follow the document pattern: `visibility Visibility @default(INTERNAL)`, denormalized `clientId`, RESTRICTIVE portal_gate on (client_id = app.client_id AND visibility='CLIENT_VISIBLE'), and a CHECK that CLIENT_VISIBLE requires client_id (DATA_MODEL §5/§6.8).
- Composite FKs to tenant-scoped parents: parent gets @@unique([tenantId, id]); child relation uses fields [tenantId, parentId] references [tenantId, id] (schema.prisma:374, 391, 464).
- GUCs are set transaction-locally (set_config(..., true)) — never session-scoped (Neon PgBouncer transaction pooling; with-tenant.ts:6-11).
- Every mutation: authorize()/requireAccess() first, audit record() in the same transaction, action key must exist in AUDIT_EVENTS (record.ts throws otherwise); PLATFORM-visibility events only via withPlatform.
- Permission codes are immutable resource:verb; catalog.test.ts pins count 63 and the exact requiresMfa set — extending the catalog means updating those tests, re-seeding prisma/seed.ts, and propagating to existing tenants' template roles.
- Module gating: new entitlement modules must be added to MODULES (authz/catalog.ts), entitlementsSchema.modules (resolver.ts), and use TenantPreference key `module.<mod>.enabled` and FeatureFlag key `module.<mod>`; core skips gates 2-3.
- Deny-default scoping (AUTHZ.md §4, authorize.ts:99): members without client:view_all see only MemberClient/MemberProject assignments; out-of-scope resources must 404 (NOT_FOUND) not 403.
- No hostnames/cookie names outside src/config (INV-D1/D2 tests); no cookie Domain attribute anywhere (inv-d1.test.ts scans src).
- Attribution columns (createdByMemberId etc.) are strings without FKs; AuditEvent has no FKs and is append-only.
- Physical names snake_case via @@map/@map; ids uuid(7); timestamps Timestamptz(6); enum values UPPER_SNAKE.
- Contact/portal principal is a separate identity (decision 6); Principal type in src/db/context.ts already models {type:'contact', id, clientId}.
- Server actions must derive tenant/member from requireTenantContext(), never from form params; membership re-derived per request, session.activeTenantId is a UX pointer only.
- Docs remain source of truth: DATA_MODEL.md drafts for Client/Project/Milestone/Issue/MemberClient/MemberProject should be materialized as-is unless a decision changes them; the time-tracking 'skip' in PLAN.md l.310 / DATA_MODEL.md l.1932 / OPEN_QUESTIONS.md l.21 must be formally reversed in docs.

**Gaps**
- No domain tables beyond auth/tenancy/documents: Client, Contact, Project, ProjectVersion, Milestone, Service, Issue, IssueComment, MemberClient, MemberProject exist only as drafts in docs/DATA_MODEL.md; Document.clientId/projectId have no FKs.
- authorizedClientIds returns an empty scope for non-view_all members (authorize.ts:105 TODO) — resource scoping is unimplemented; no resource-level requireAccess variant.
- No i18n at all (ARC-14 mandates next-intl sv+en and a no-literal-strings lint); all UI copy is hard-coded English; root layout title is 'Create Next App'.
- No R2 file transport (presign/upload/commit/quota), no SES mail transport (dev outbox only; production send() throws), no passkey plugin.
- MFA enforcement for requiresMfa permissions and MFA_REQUIRED denial not implemented; only TOTP enrollment UI and login step exist.
- Member/role administration missing: revoke invite, suspend/remove member, assign/revoke roles, role CRUD, last-owner guard, permissionsVersion bump, template drift propagation (B3).
- No tenant switcher / activeTenantId setter; no tenant settings or preferences UI; no feature-flag or entitlement admin; ops console is a placeholder.
- Portal plane is a static shell: no Contact identity tables, no portal Better Auth instance, no authorizePortal(), no client-visible read models.
- requestContext is never populated (withRequestContext has no callers), so audit rows carry NULL requestId/ip/userAgent.
- Field-encryption service has no callers (TwoFactor secrets rely on Better Auth's own handling); Tenant bank fields unused.
- AttachableType enum lacks any work-item/task value; AUDIT_EVENTS has no client.*, project.*, milestone.*, issue.*, or time-tracking events; permission catalog has no task/work-item or time-entry codes and no 'time'/'work' module — all must be designed for the new Planner/DevOps-style scope.
- No src/modules/<key> folder structure per ARCHITECTURE.md §3; current code is flat (src/members etc.) — planner must decide whether to adopt the doc layout now.
- No shared UI kit/design system, no error/loading boundaries, no client-side data fetching pattern (needed for kanban drag-and-drop and a running timer); no realtime/pubsub, no cron/job runner (needed for timer auto-stop, reminders).
- CI isolation suite runs against a shared Neon dev DB serialized by concurrency group; no ephemeral branch per run.
- Better Auth passkey plugin not wired although Passkey table exists.


## Microsoft Planner (classic + new Planner 2024-2026, incl. premium/Project-for-the-web features) — feature inventory, UX principles, data model, and must/should/could/skip for Fortleva v1

Microsoft Planner is the archetype of "task management non-engineers actually use": a plan is a board of buckets holding task cards; each card has title, bucket, progress (Not started / In progress / Completed = percentComplete 0/50/100), priority (Urgent/Important/Medium/Low, stored as int 0-10), start/due dates, up to 20 assignees, up to 25 plan-scoped colored labels, a 20-item checklist, up to 15 attachments/links ("references"), rich-text notes, and a card preview ("show on card") of either checklist, description or an attachment. The same task set is rendered as Board (group by bucket / assignee / progress / due / priority / labels — drag between columns changes the field), Grid (spreadsheet with inline edit), Charts (Status donut incl. "Late", per-bucket stacked bars, per-priority, per-member workload), and Schedule (calendar with an "Unscheduled" side list you drag onto dates). Cross-plan surfaces are My Day (auto-adds today's due tasks, clears nightly), My Tasks (Private tasks / Assigned to me / Flagged emails) and My Plans. Ordering is stored as string "order hints" (fractional indexing) — server-generated, drag-and-drop-friendly, with etag concurrency. Premium plans (ex-Project for the web, $10-55/user/mo) add subtasks/summary tasks, dependencies (FS/SS/SF/FF), Timeline/Gantt with critical path, milestones, effort in hours + Assignments view (per-day/week distribution), People/workload view, custom fields (max 10; text/date/number/yes-no/choice), conditional coloring, colored buckets, sprints (a "Sprint" grouping with a Backlog column, drag tasks into dated sprints), Goals (statuses Not started/On track/At risk/Off track/Closed, tasks linked to goals), task history ("Changes" pane: field, old→new, actor, relative time), baselines, portfolios/roadmap, custom calendars, and Copilot "Project Manager agent". The Jan-Feb 2026 refresh brought Task chat (@mentions, edit/delete, notify only mentioned) replacing Group-mailbox comments, custom plan templates, and Goals to basic plans, while retiring iCal feed, Loop components and Whiteboard.

What users praise: zero-training visual boards, "one place for who does what by when", quick switching between views, Charts for status meetings, tight Teams/Outlook integration, no extra cost. What they hate: no time tracking or cost at all, weak reporting/no PDF export, no subtasks/dependencies/custom fields in basic, no real external/client access (guest access rides on M365 Group guests, breaks often, no notifications, historically no comments), noisy or missing notifications, comments leaking to group mailbox, 3,000-active-task limit, and constant UI churn. Reddit verdict for agencies: "a glorified grocery list" — teams doing client work migrate to Asana/ClickUp. Fortleva's opportunity is exactly Planner's basic-tier approachability plus the four things it lacks: per-task timers with per-member/per-project cost roll-ups, client-visible projections chosen per item, real subtasks/checklists in one model, and reporting that can be shared to a portal.

**Recommendations**
- Adopt Planner's basic tier as the v1 feature ceiling for the board: Bucket board + task pane (title, notes, bucket, status, priority, start/due, assignees, labels, checklist, attachments/links, comments, activity) — nothing else until it is used daily by Naxdor.
- Make Board, List and Charts three lenses over one query from day one (same server action, same filters, same sort keys) — this is what makes Planner feel simple; avoid separate 'kanban module' vs 'list module'.
- Give every Member a 'My Work' home (assigned tasks across projects, due-today/overdue/next-7 sections, one-click Start timer, running-timer banner) — Planner's My Day/My Tasks is why individual contributors show up; timers only get used if starting one is one click from this page.
- Model time as first-class TimeEntry rows produced by timers (and manual entry), with a single running timer per member enforced in the DB, and cost derived from ProjectRate (default per project, override per member). Planner has only estimated effort — real tracked time + cost is Fortleva's headline differentiator.
- Ship checklists in v1 and true subtasks (parentTaskId, depth ≤ 2, timeable, roll-up) in the following phase — and explain the difference in the UI, because Planner users demonstrably abuse checklists as subtasks.
- Do labels tenant-wide with an optional per-project subset, fixed ~25-colour palette, renameable — Planner's per-plan scoping is a recurring complaint for multi-project teams (which every agency is).
- Reuse the IssueComment shape for TaskComment with @mentions, edit/delete markers and per-comment visibility, and notify only mentioned members plus a single morning digest (overdue / due today / due in 7 days). Copy the 2026 Task-chat model, not the legacy group-mailbox model.
- Expose the audit trail as a per-task Activity tab with exact timestamps (Planner premium's 'Changes' pane is a paid feature with relative timestamps; you get it for free from AuditEvent).
- Client visibility per task and per comment/attachment via the existing Visibility enum, defaulting INTERNAL, with a restrictive portal RLS policy; the portal shows a read-mostly 'Project progress' page (client-visible tasks grouped by bucket/status, milestones, shared documents, time totals only if the tenant opts in). Never give Contacts board-edit rights — that is exactly the Planner guest-access failure mode.
- Add 'Save as template' / 'New project from template' (buckets, tasks, checklists, labels; no dates/assignees) early — agencies onboard the same kinds of projects repeatedly and this is the 2026 Planner feature users waited years for.
- Skip dependencies, Gantt, baselines, critical path, portfolios, goals and custom-field builders for v1; keep the schema open (optional tables that reference Task) so any of them can be added without touching Task.
- Use fractional-index string sort keys and optimistic concurrency (version/updatedAt) for drag-and-drop; return the new order from the server action so two staff can reorder the same bucket concurrently.
- Put soft caps in place (e.g., 3,000 open tasks / project, 20 assignees, 25 labels, 15 links per task) with clear errors — Planner's published limits show where boards stop being usable.
- Add sane guardrails Planner lacks: show active filter chips, debounce assignment notifications a couple of minutes after task creation, keep the layout stable across releases (Capterra's 'moving target' complaint).

**Open questions**
- Task status set: fixed 3 states (To do / In progress / Done) like Planner, or 4 with 'Waiting on client'? Recommended default: 4 fixed states, buckets remain freeform stages; no per-tenant custom workflows in v1.
- Checklist vs subtask: ship both, or only subtasks (timeable) and drop checklists? Recommended: both, checklists in v1 (no time, no assignee), subtasks (parentTaskId, depth ≤ 2) in the phase right after timers land.
- Multiple assignees per task or single owner? Recommended: allow multiple (Planner-style, cap 20) but time entries are always per member, so cost roll-ups stay exact; show a 'primary owner' as first assignee.
- Rates: per project only, or per project with per-member override, or per member tenant-wide default? Recommended: ProjectRate with optional memberId override + a tenant default hourly rate; store currency; rates are effective-dated so historical cost doesn't change when a rate is edited.
- Should clients ever see hours/cost? Recommended: off by default (TenantPreference + per-project toggle); when on, show totals per period only, never per member names.
- Labels scope: tenant-wide vs per project? Recommended: tenant-wide catalogue, per-project 'active labels' subset, fixed 25-colour palette.
- Do we build Charts natively in v1 or wait for Phase 6 reports? Recommended: 4 fixed charts (status incl. late, per bucket, per member, hours per member/project) on the project page in the tasks phase; the exportable/shareable report stays in Phase 6.
- Recurring tasks and Schedule/calendar view: v1 or later? Recommended: later (Phase 5), since retainer routines can be templated as project copies until then.
- Comments: separate TaskComment table or one polymorphic Comment table shared by Issue and Task? Recommended: one Comment table with attachable (type, id) + clientId + visibility, since visibility semantics and mention fan-out are identical.

**Sources**
- [Compare Microsoft Planner basic vs. premium plans (Microsoft Support)](https://support.microsoft.com/en-us/office/compare-microsoft-planner-basic-vs-premium-plans-5e351170-4ed5-43dc-bf30-d6762f5a6968)
- [Advanced capabilities with premium plans in Planner (Microsoft Support)](https://support.microsoft.com/en-us/office/advanced-capabilities-with-premium-plans-in-planner-6cdba2aa-da06-4e08-be4c-baaa4fda17ba)
- [Manage your Team's plans with Planner in Teams (Microsoft Support)](https://support.microsoft.com/en-us/office/-manage-your-team-s-plans-with-planner-in-teams-69a7f060-57dd-48bb-829a-55ae39ae2d89)
- [Frequently asked questions about Microsoft Planner (Microsoft Support)](https://support.microsoft.com/en-us/planner/frequently-asked-questions-about-microsoft-planner)
- [Microsoft Planner limits (Microsoft Learn)](https://learn.microsoft.com/en-us/office365/planner/planner-limits)
- [Microsoft Planner service description (Microsoft Learn)](https://learn.microsoft.com/en-us/office365/servicedescriptions/project-online-service-description/microsoft-planner-service-description)
- [plannerTask resource type (Microsoft Graph v1.0)](https://learn.microsoft.com/en-us/graph/api/resources/plannertask?view=graph-rest-1.0)
- [plannerTaskDetails resource type (Microsoft Graph v1.0)](https://learn.microsoft.com/en-us/graph/api/resources/plannertaskdetails?view=graph-rest-1.0)
- [Use the Planner REST API — object model, board formats, etags (Microsoft Graph)](https://learn.microsoft.com/en-us/graph/api/resources/planner-overview?view=graph-rest-1.0)
- [Using order hints in Planner (Microsoft Graph)](https://learn.microsoft.com/en-us/graph/api/resources/planner-order-hint-format?view=graph-rest-1.0)
- [View charts of your plan's progress (Microsoft Support)](https://support.microsoft.com/en-us/planner/view-charts-of-your-plan-s-progress)
- [Use Schedule view in Microsoft Planner (Microsoft Support)](https://support.microsoft.com/en-us/office/use-schedule-view-in-microsoft-planner-1b46f8a4-a29a-4d18-8276-4e4d2af5a953)
- [Manage your tasks with My Tasks and My Day (Microsoft Support)](https://support.microsoft.com/en-us/planner/training/manage-your-tasks-with-my-tasks-and-my-day)
- [Flag your tasks with labels (Microsoft Support)](https://support.microsoft.com/en-us/planner/flag-your-tasks-with-labels)
- [Read this before using labels in Microsoft Planner (planner-ms.ghost.io)](https://planner-ms.ghost.io/using-labels-in-microsoft-planner/)
- [Buckets, Tasks, and Subtasks, oh my! (planner-ms.ghost.io)](https://planner-ms.ghost.io/buckets-tasks-and-subtasks/)
- [Task history: the where's Waldo of Microsoft Planner (planner-ms.ghost.io)](https://planner-ms.ghost.io/microsoft-planner-task-history/)
- [Plan a project in sprints in Project for the web (Microsoft Support)](https://support.microsoft.com/en-us/project/plan-a-project-in-sprints-in-project-for-the-web)
- [Recurring tasks in Planner (Microsoft Support)](https://support.microsoft.com/en-us/planner/recurring-tasks-in-planner)
- [Guest access in Microsoft Planner (Microsoft Support)](https://support.microsoft.com/en-us/office/guest-access-in-microsoft-planner-cc5d7f96-dced-4da4-ab62-08c72d9759c6)
- [Why Is Microsoft Planner Removing Access From Guests? (Microsoft Q&A)](https://learn.microsoft.com/en-us/answers/questions/4425221/why-is-microsoft-planner-removing-access-from-gues)
- [Stay updated with notifications in Planner (Microsoft Support)](https://support.microsoft.com/en-us/office/stay-updated-with-notifications-in-planner-f6a32f83-058d-4f39-988d-8a2e932820ec)
- [Frequently asked questions about Planner agent (Microsoft Support)](https://support.microsoft.com/en-us/planner/copilot/frequently-asked-questions-about-planner-agent)
- [Manage multiple plans with portfolios in Microsoft Planner (Microsoft Support)](https://support.microsoft.com/en-us/planner/manage-multiple-plans-with-portfolios-in-microsoft-planner)
- [Introducing a refreshed design, task chat, and more in Microsoft Planner (Tech Community, 2026)](https://techcommunity.microsoft.com/blog/plannerblog/introducing-a-refreshed-design-task-chat-and-more-in-microsoft-planner/4495440)
- [Microsoft Planner 2026 New and Retired Features (Sourcepass)](https://sourcepassmcoe.com/articles/microsoft-planner-2026-new-and-retiring-features-sourcepass-mcoe)
- [Upcoming Microsoft Planner Changes in Early 2026 (U of Toronto EASI)](https://easi.its.utoronto.ca/upcoming-microsoft-planner-changes-in-early-2026/)
- [What Happened to Planner Task Comments? (seanshares.com)](https://seanshares.com/what-happened-to-planner-task-comments/)
- [Planner Leak Allows External Recipients to Receive Task Comments (Office 365 for IT Pros)](https://office365itpros.com/2020/10/27/planner-leak-external-recipients-see-task-comments/)
- [Unboxing the New Microsoft Planner for Enterprise Work Management (Sensei)](https://www.senseiprojectsolutions.com/resources/unboxingthenewplanner/)
- [Planner Premium: Assignments & Resources (HubSite365)](https://www.hubsite365.com/en-ww/crm-pages/how-to-use-assignments-in-planner-premium-to-manage-resources-2dcc697e-35ce-4da8-928b-c867cf9be5a1.htm)
- [Resource assignment report on Planner and Planner Premium (The Project Corner)](https://www.theprojectcornerblog.com/2025/07/12/resource-assignment-report-on-planner-and-planner-premium/)
- [Planner Premium Views Explained (nBold)](https://nbold.com/planner-premium-views-explained-kanban-timeline-people-goals-agile-ceremonies/)
- [What Is Microsoft Planner Premium? Uses, Features and Pricing (ProjectManager.com)](https://www.projectmanager.com/blog/what-is-microsoft-planner-premium)
- [Top 5 Microsoft Planner Limitations & How to Fix Them (Data Inseyets)](https://datainseyets.com.au/top-5-microsoft-planner-limitations-and-how-to-fix-them/)
- [Asana vs Microsoft Planner Reddit Users Debate (ONES)](https://ones.com/blog/asana-vs-microsoft-planner-reddit-users-debate-5-honest-takes/)
- [Microsoft Planner Reviews (Capterra)](https://www.capterra.com/p/227201/Microsoft-Planner/reviews/)
- [Add up to 25 embedded, editable labels to your tasks (Tech Community)](https://techcommunity.microsoft.com/blog/plannerblog/add-up-to-25-embedded-editable-labels-to-your-tasks/2174399)
- [Microsoft Planner vs Trello (Forbes Advisor)](https://www.forbes.com/advisor/business/software/microsoft-planner-vs-trello/)


## docs-rules: standing rules, settled decisions, and phase status that any new feature plan (kanban/backlog/timer/cost/portal-sharing/credentials) must obey or explicitly reopen

(codebase exploration — see constraints/gaps)

**Constraints**
- Standing DoD every phase (PLAN.md 32-41): CI green incl. isolation suite; four test families (tenant isolation, client-level scoping, file visibility, privilege escalation) for everything touched; every privileged op in AuditEvent static catalog with write-time visibility; every module behind entitlement gate + TenantPreference toggle; sv+en via i18n, no hardcoded copy, no two-language assumption; from Phase 2 every new entity in the export manifest; nothing Naxdor-specific in schema/UI (→ TenantPreference); small reviewable commits.
- Independently shippable = deployed, Naxdor uses it on real work, nothing half-built reachable in UI, tests green; must survive being left alone three months (PLAN.md 30).
- Visibility dimension internal(default)|client_visible on every file/note/field, enforced at data layer via RESTRICTIVE portal RLS; visibility flips audited (BRIEF §5, SECURITY.md §5/§7). Applies to tasks, boards, time entries, progress reports, credentials.
- Four-gate order fixed: feature flag → entitlement → TenantPreference → permission, one server-side call; UI hiding is cosmetics; flags never monetize (ARCHITECTURE.md §3, ARC-10). Module keys today: invoicing, contracts, reports, issues, documentation, continuity_box, portal (+ core never gated). Key conventions `module.<key>` / `module.<key>.enabled` (src/entitlements/resolver.ts).
- Permissions are immutable `resource:verb` codes; never check role names; single authorize()/authorizedResourceIds() seam; deny-default scoping (zero assignments ⇒ nothing) with client:view_all only on CEO/Manager/Admin templates (decision 5, ARC-05). Template additions auto-propagate to cloned roles with audit (B3 Option B).
- EU residency non-negotiable: data at rest in EU, compute pinned fra1, Node runtime only for data paths; allowed vendors Vercel/Neon Frankfurt/Prisma/Better Auth self-hosted/R2 eu/Stripe (billing only)/Upstash EU/Amazon SES eu-central-1/Vercel cron; disqualified: Clerk, WorkOS, Auth.js, SuperTokens, Supabase, policy engines (OpenFGA/Cedar/Oso/Casbin/Permit/Cerbos), S3/B2, Stripe Connect/Entitlements API, flag SaaS, Resend, Postmark, pg_cron, pgcrypto. New third-party services must be EU-at-rest, added to sub-processor list with 30-day notice, and beat 'run it in the app' on total cost (solo/self-host bias). Marketing claims constrained by SECURITY.md §9.3.
- Encryption: AES-256-GCM service, format v1.<keyId>.<iv>.<ct>.<tag>, AAD tenantId||model||field; MUST encrypt TOTP secrets, integration credentials/tokens, payment details, personnummer; MUST NOT encrypt searchable business fields; per-field decision is a one-way door before data exists (SECURITY.md §6). Live-credential storage reopens brief §8's 'pointers not secrets' lean and must be argued explicitly.
- Rate limiting via Upstash EU with per-principal/email/tenant HMAC-hashed keys; portal is least-trusted with heaviest limits; limits are constants in one config module; fail-open except ContinuityOpenRequest/impersonation/export (SECURITY.md §4). New portal write surfaces need limits.
- Audit: audit.record() in same transaction; append-only; static catalog; must-capture list incl. assignment changes, exports, download-URL issuance, visibility flips, TenantPreference toggles; retention 12/24 months via Vercel cron; metadata never holds encrypted plaintext (SECURITY.md §7).
- Settled decisions 1-10 are closed (OPEN_QUESTIONS.md §1); decision 7's 'time tracking → skip' and PLAN.md skip-list row must be EXPLICITLY reopened/recorded (new dated decision) rather than silently built around; founder wants pushback written in docs.
- Progress tracked only in PLAN.md (checkboxes, status column, dated progress log); no forking to other tools (PLAN.md 3).
- No design system/component library decided; only Tailwind 4 (ARC-01). Any choice (e.g. shadcn/ui) must be recorded as a new ARC with Decision/Rationale/Rejected/Revisit. UX guidance on record: portal read-mostly & low friction; timeline deliberately not a Gantt; issues 'lightweight tracker, not Jira'; designed empty states; module registry removes disabled-module nav.
- i18n via next-intl (ARC-14), sv+en, no locale URL prefixes, lint bans literal strings — NOT yet implemented in repo (no next-intl dep; hardcoded English JSX exists).
- Cost ceiling: v1 fixed infra < $50/mo; ~50 tenants $80-135/mo (ARCHITECTURE.md §6).
- INV-D1: no cookie ever carries Domain= while under naxdor.com (CI-enforced); INV-D2: host never hardcoded, one config module owns APP_URL/cookies/mail sender; no tenant slugs/IDs in absolute URLs, urlFor() only (ARC-11/13).
- Vocabulary fixed: Tenant, Member, Client, Contact, Platform; never 'user' ambiguously (BRIEF §1). Bare 'SES' means Simple Electronic Signature; mail adapter never named `ses`.
- Prisma DMMF-enumerated isolation suite auto-covers every new model — every new table needs tenantId, RLS FORCE fail-closed policy, composite FKs and tenantId-leading indexes or CI fails (ARC-03, TENANCY).
- Step-up re-auth (≤15 min) for role/permission changes, member removal, entitlement-affecting settings, exports, invoice-series changes; C13 adds member:manage_roles + role:edit (SECURITY.md §3.6).
- Contacts never enter role/permission machinery — hardcoded portal capability set; invite-only forever; contact uploads brokered via system principal with forced clientId + CLIENT_VISIBLE (SECURITY.md §3.4, §5).

**Gaps**
- PLAN.md tracker is stale: header 'Last updated 2026-08-03', all Phase 1 checkboxes unticked, single progress-log row, despite ~11 Phase-1 commits — the new plan must reconcile it.
- Phase 1 items not evidenced in repo: i18n scaffold (no next-intl, hardcoded English), real Amazon SES adapter + DNS + SNS bounce webhook (mailer is a stub), auth rate limiting (no Upstash deps), FileObject/FileVersion presign/upload/quota path (no R2/S3 SDK dep), passkeys, audit-retention cron, R2 bucket provisioning, platform console beyond /ops login, runbook skeleton/Bitwarden emergency access, TOTP-mandatory enforcement for platform/owner roles (unverified).
- Phase 2 core domain (Client/Contact/Project/ProjectVersion/Milestone/Service/Document/MemberClient/MemberProject/export v0) not started — tasks/kanban/time/cost all depend on Project + assignment tables landing first.
- No component library / design system decision exists; no src/components; no UI conventions doc — needed before a large UI build (kanban, backlog, timers).
- Decision 7 / skip-list 'Time tracking — don't build' must be formally reversed in OPEN_QUESTIONS.md (decision 11+) and PLAN.md skip list; PLAN.md phase table has no slot for a tasks/time/costing module — needs new phase(s) or Phase 2/5 rescoping.
- Entitlement schema and module registry have no keys for tasks/boards, time tracking, project costing, credentials/asset vault, progress reports-with-timelines; permission catalog has no task:*/time:*/credential:* codes; audit catalog has no events for them; export manifest rule will require these entities added.
- Credentials-per-project storage conflicts with brief §8 'pointers not live secrets' lean and SECURITY.md §6 encrypt-list — plan must decide: field-encrypted server-readable vault (new encrypted-field one-way door) vs continuity-box-style client-side, and record it.
- 'Progress reports with timelines' overlaps Phase 6 PerformanceReport (uploaded PDFs) and Phase 2 timeline view ('deliberately not a Gantt') — scope boundary undefined.
- Realtime/collaboration expectations of kanban (drag-drop, live updates) have no stated approach; any realtime vendor must clear EU-residency + <$50/mo cost tests; ARC entry missing.
- Portal sharing of tasks/time/cost to Contacts touches decision 4 (unlimited free Contacts) and portal capability set (hardcoded, AUTHZ.md §8) — new portal capabilities must be enumerated and deny-matrix tested; portal write surfaces need rate limits.


## docs-domain — already-designed (not yet built) domain model for phases 2-8, plus the tenancy/authz/audit conventions any new module (tasks, boards, time tracking, rates, credentials, client-visible tasks) must obey

(codebase exploration — see constraints/gaps)

**Constraints**
- Every tenant-owned table: tenantId NOT NULL, denormalized on children/junctions; composite FK (tenantId, parentId) -> Parent(tenantId, id); parents expose @@unique([tenantId,id]) (DATA_MODEL.md §2 items 3,5; TENANCY.md §8.1)
- Every secondary index leads with tenantId; single-column indexes only for cross-tenant SYSTEM sweeps (DATA_MODEL.md §7 rule 1; TENANCY.md §8.3)
- Every model classified in src/db/model-registry.ts or the census test fails the build (TENANCY.md §11; model-registry.test.ts)
- RLS on every tenant table with FORCE ROW LEVEL SECURITY, InitPlan (SELECT current_setting(...)) form, fail-closed on NULL; class-A gets portal_deny RESTRICTIVE; portal-visible tables get portal_gate RESTRICTIVE keyed on client_id AND visibility='CLIENT_VISIBLE'; never a PERMISSIVE portal policy (TENANCY.md §6.2, §7.2; migration 20260808191500)
- Any row a portal query can render carries (clientId, visibility) itself or is unreachable by portal queries; visibility DB default INTERNAL; internal-only columns on client-visible rows use explicit select allowlists (TENANCY.md:193; DATA_MODEL.md P6)
- Contact-writable set is exactly Issue, IssueComment, ContinuityOpenRequest, ProjectVersion approval columns — CI-asserted; contact uploads brokered via system principal; widening it is a deliberate reviewed change (TENANCY.md §7.2, §11)
- Permission codes are immutable resource:verb, global seeded, module non-null from the closed list; new codes appended in src/authz/catalog.ts with template seeding + TEMPLATE_VERSION bump; ✦ codes never auto-propagate to custom clones (AUTHZ.md §3.1, §3.5)
- Three namespaces never harmonized: resource:verb (permissions), entity.verb (audit), portal.area.verb (portal capabilities, hardcoded TS union, never DB rows) (DATA_MODEL.md:538-545; AUTHZ.md §8)
- Every module = entitlement key = folder src/modules/<key> = Permission.module = Tenant.entitlements.modules key, spelled identically; gate order flag -> entitlement -> preference -> permission via requireAccess; core skips gates 2-3 (ARCHITECTURE.md §3; AUTHZ.md §5; resolver.ts)
- Deny-default resource scoping: zero MemberClient/MemberProject rows => nothing; client:view_all only override; out-of-scope => 404 not 403; no project:view_all (AUTHZ.md §4)
- Every privileged mutation writes an AuditEvent from the static catalog in the same transaction; write-time visibility fixed in catalog; no FKs on AuditEvent; metadata minimized (DATA_MODEL.md §3; audit/catalog.ts)
- Assignment/role mutations bump Tenant.permissionsVersion in the same transaction (AUTHZ.md §7.6)
- Money Decimal(12,2), never floats; currency Char(3); Timestamptz(6); uuid(7) ids; SCREAMING_SNAKE enums; snake_case @@map/@map (DATA_MODEL.md §1.3)
- Nothing Naxdor-specific in schema/UI; tenant-defined taxonomies are free text/preferences not enums (DATA_MODEL.md:36; PLAN.md:40)
- sv+en i18n, no hardcoded copy; no two-language assumption (PLAN.md:38; ARCHITECTURE ARC-14)
- From Phase 2 on every new entity is added to the per-tenant export manifest (JSONL + files + schema-versioned manifest) (PLAN.md:39,141)
- Field encryption inventory is closed/deliberate; any stored secret must use the AES-GCM service and be excluded from logs/AuditEvent.metadata (DATA_MODEL.md §4; SECURITY.md:220)
- Live credentials discouraged everywhere in the docs (pointers-not-secrets: DATA_MODEL.md:881,1682; CONTINUITY_BOX.md:336-343; PROJECT_BRIEF.md:300); a per-project credential store contradicts this and must be argued/decided explicitly
- Invoices: gap-free numbering only via InvoiceSeries counter in-transaction; issued invoices immutable; corrections via credit notes; TenantCounter is for non-legal numbers only (DATA_MODEL.md §6.7, §9, :415-425)
- DATA_MODEL.md is the naming authority: any new entity/key must be added there first; PLAN.md is the source of truth for phase progress (DATA_MODEL.md:1963; PLAN.md:3)
- Four non-negotiable test families for everything touched: tenant isolation, client-level scoping, file visibility, privilege escalation (PLAN.md:35)
- EU residency: all data in Neon Frankfurt / R2 EU; no new non-EU processors (ARCHITECTURE.md binding constraints)

**Gaps**
- No task/work-item model: Issue is a client request queue with required clientId, tenant-global number, no parent/child, rank/order, board column, estimate, iteration/sprint, labels, due date, watchers, or multi-assignee
- No time-tracking model at all (TimeEntry, running timer state, per-member/per-project rollups); explicitly skipped in DATA_MODEL.md:1932 and PLAN.md:310
- No rate/budget/cost fields on Project (or Member); no billable/non-billable concept; only seams are Service.priceExVat and InvoiceLine(unit 'h', quantity, projectId)
- No board/backlog/sprint storage: DATA_MODEL.md:1941 says board = view over Issue with no new tables
- No per-client/per-project credential or secret store; only tenant-level IntegrationConnection (one row per provider) is designed; docs consistently argue pointers-not-secrets
- No Notification model (v2 per DATA_MODEL.md:1936); Phase 5 plans in-app + email but no schema
- No export manifest schema defined anywhere; only the JSONL+files+manifest shape in PLAN/SECURITY/CONTINUITY_BOX prose
- AttachableType lacks TASK (or any new entity); enum extension migration required for assets on tasks
- Portal capability union has no task capabilities; contact profiles would need task view/comment additions; contact-writable census would change if clients act on tasks
- authorizedClientIds() is a stub returning empty ids until MemberClient/MemberProject land (Phase 2); authorize() has no resource argument; MemberClient/MemberProject/Client/Project/... are designed but not in schema.prisma
- Model registry has no client-scoped/visibility subclass; portal_gate policies are hand-written per table in migrations (only document today)
- No milestone<->task or version<->task linkage designed; 'progress reports with timelines' has no entity beyond Milestone + ProjectVersion + PerformanceReport(MANUAL_UPLOAD)
- Retention/GDPR class for time entries and rate data undefined (R2 default; billed time frozen into R1 InvoiceLine only via snapshot)
- PLAN.md phases (2 core domain, 5 collaboration) have no slot for tasks/time/boards; PLAN.md skip-list line 310 must be edited to reflect the reversal
- Permission count assertion (63) and TEMPLATE_VERSION need bumping; entitlement module list would need a new key if tasks/time are entitlement-gated modules


## vault-assets — per-client credential vault, asset/expiry registry, secure sharing, and lightweight documentation for Fortleva

Agencies and MSPs converge on one shape: credentials live *next to* the client, its assets and its docs (Hudu, IT Glue), not in a detached password manager. Hudu's model — per-company passwords + OTP + folders + per-item permissions + expiring/view-once share links + an external portal + an "Expirations" feed fed by asset date fields and automatic domain/SSL checks — is the closest analogue to what Fortleva needs; IT Glue adds two lessons: password "types" (general vs embedded-in-an-asset) and a Vault mode whose zero-knowledge passphrase kills export/search/mobile and makes lost passphrases unrecoverable. Generic agency portals (Copilot, Moxie, SuiteDash, Teamwork) have no vault at all — this is a genuine differentiator for an agency+portal product; the only niche exceptions are ElePass and Jetpack CRM's password extension.

Security model recommendation: **server-side envelope encryption with an app-held root key (option a), hardened**, not client-side E2EE. Fortleva already has AES-256-GCM field encryption with keyId rotation and an append-only audit log; the vault should add per-tenant DEKs wrapped by the root key, AAD binding ciphertext to (tenantId, itemId, field), reveal/copy as explicit server-mediated audited actions, MFA step-up (sudo mode already specced for continuity box/export), and rate limits on reveals. Evidence: Infisical (OSS secrets manager) deprecated its E2EE mode because users treated it as nice-to-have and it broke API/search ergonomics; Bitwarden documents that its "viewed password" events are client-reported and suppressible, whereas server-side reveal is enforceable; IT Glue's Vault shows the recovery/export cost of zero-knowledge; Passbolt v5 needed a whole key-distribution redesign to encrypt even metadata. Be honest in the ROPA/security page: operator can technically decrypt; mitigations are procedural (audit, MFA, no support backdoor). Reserve E2EE for the continuity box only, where it already exists.

Data model: a `CredentialItem` (typed: LOGIN, SECURE_NOTE, API_KEY, SSH_KEY, DATABASE, SERVER, WIFI, SOFTWARE_LICENSE, OTHER; no cards) with encrypted `secretJson`, plaintext searchable metadata (name, username, url, tags), optional TOTP secret (encrypted, codes generated server-side and audited), attachments via existing Document layer, `expiresAt`/`rotateEveryDays`, links to Client/Project/Asset, per-item ACL overlay on top of member↔client scoping, share links (expiring, view-once, optional passcode, TOTP-code inclusion), and a `ClientAsset` registry (domain, hosting, DNS provider, SSL, registrar, third-party service, license) with an `Expiration` feed and RDAP/TLS auto-checks. Portal exposure of a credential is *always* through a share link or an explicit CLIENT_VISIBLE grant with a second-person confirmation, never by default. A lightweight rich-text "Pages" feature (per-client notes/runbooks) is a SHOULD, not a MUST — ship it after tasks/time in Phase 2b using Tiptap + Documents attachments, and defer real-time collab.

**Recommendations**
- Choose server-side envelope encryption (option a) with per-tenant DEK wrapped by the existing root keyring, AAD-bound ciphertexts, server-mediated reveal, MFA step-up and rate limits — Infisical dropped E2EE for the same reasons and IT Glue's Vault shows the recovery/export/search cost of zero-knowledge; document honestly that the operator can technically decrypt.
- Do NOT offer a per-tenant passphrase/E2EE mode in v1 (option b/c) — it forks every code path (search, export, portal share links, TOTP generation, credential requests) and creates unrecoverable lockouts for 3-person agencies; keep the door open by making the DEK layer pluggable (a tenant-supplied wrapping key later = 'bring your own key', a much cheaper hybrid than client-side crypto).
- Add AAD to the field-encryption service now (v2 ciphertext format) before any vault data exists — one-way door; ciphertext-swap between rows/tenants is a real attack under RLS bugs.
- Make reveal a POST endpoint that decrypts one field, writes the AuditEvent in the same transaction, and enforces sudo-mode + per-member reveal budget; list/detail queries must select ciphertext columns never (use Prisma `omit` defaults on the model).
- Ship the vault in the same phase as Client/Project (Phase 2b) rather than late — the founder explicitly wants credentials per project and it is a differentiator against Copilot/Moxie/SuiteDash which have none.
- Build share links and 'client submits credential via portal' before portal-visible credentials; links cover 90% of client hand-offs with less standing exposure than a persistently CLIENT_VISIBLE secret; make portal-visible credentials a tenant preference defaulting OFF.
- Model assets as a fixed typed set + CUSTOM JSON in v1 and defer Hudu-style tenant-defined layouts; add RDAP + TLS auto-checks in the same phase because a web/SEO agency gets immediate value from domain/SSL expiry alerts.
- Build a single Expirations feed (computed union) with idempotent reminder rows and dashboard tiles instead of per-module reminder code; wire Contract/Service renewals into it in Phase 4.
- Implement Pages as a SHOULD in Phase 2c/3 using Tiptap JSON + PageVersion + tsvector search + mentions of vault/asset entities; skip real-time collab and BookStack-style hierarchies; render CLIENT_VISIBLE pages in the portal with a strict node whitelist.
- Reuse the Document layer for attachments (attachedToType CREDENTIAL/ASSET/PAGE) — do not invent a second file path; force INTERNAL unless the parent is CLIENT_VISIBLE.
- Add offboarding automation: when a Member is removed or unassigned from a Client, list every credential they could reveal and mark them 'needs rotation' (Passbolt's auto-expiry-on-access-loss) — this is the feature agency owners actually fear missing.
- Write the four non-negotiable test families for the vault before UI: tenant isolation (RLS on CredentialItem/ShareLink), client-level scoping (unassigned member cannot list/reveal), file visibility (portal cannot read INTERNAL credential or its attachments), privilege escalation (view-without-reveal cannot decrypt; share-link with wrong token/expired/consumed fails closed).
- Keep the continuity box pointer-only, but auto-generate its 'systems & assets' section from ClientAsset (non-secret) at seal time so the box stays fresh without ceremony.
- Skip browser extensions, AD rotation, uptime monitoring and emergency-access state machines in v1; note them as v2/never in PLAN.md's skip list so future sessions don't re-litigate.

**Open questions**
- Step-up frequency default: per session (10-min sudo window, matches existing spec) vs per reveal? Recommended default: sudo window of 10 minutes for reveal/copy, always-step-up for share-link creation, export and visibility flips; tenant can tighten to per-reveal.
- Should reveal be allowed at all for members without MFA enrolled? Recommended: `credential:reveal` is requiresMfa ✦, so no — forced enrollment at next login, copy also blocked (copy is a reveal to the clipboard).
- Portal-visible credentials in v1 or share-links only? Recommended: share links + credential submission in v1; persistent CLIENT_VISIBLE credentials behind a tenant preference defaulting OFF, added once the portal RLS tests for the vault pass.
- Per-tenant DEK now or later? Recommended: introduce `TenantKey` now (cheap) with all DEKs wrapped by the single root key; per-tenant KMS wrapping and BYOK remain v2 seams.
- Include TOTP codes in share links (Hudu does) or never? Recommended: allow the live 6-digit code (never the seed) as an opt-in checkbox, audited.
- Item types: include CARD/bank details? Recommended: no in v1 (PCI-adjacent, agencies rarely need it); SECURE_NOTE covers edge cases.
- Asset custom layouts (Hudu-style schema builder) — v1 or v2? Recommended: v2; ship fixed types + CUSTOM key/value.
- Reveal budget defaults and alerting: 30 reveals/hour/member with owner alert on exceed? Recommended default yes, tenant-configurable.
- Pages: ship in Phase 2c (right after vault/assets) or fold into Phase 5 collaboration? Recommended: Phase 2c minimal (single page tree per client, versions, mentions), rich collab features later.
- Should credential submission by a Contact create a client-owned item that the agency must be granted (MyGlue model) or an agency-owned item? Recommended: agency-owned, visible to the submitting client (simpler ACL, one owner).
- Retention of reveal-audit IPs and share-link view logs: 90 days truncate vs keep? Recommended: 90 days then pseudonymize IP, keep event.

**Sources**
- [Hudu — Password Management (support)](https://support.hudu.com/hc/en-us/articles/7718132777879-Password-Management)
- [Hudu — Secure Password Management for IT Teams](https://www.hudu.com/product/features/passwords)
- [Hudu — Password Management tips (AES-256-GCM, folders, OTP, PWNED)](https://www.hudu.com/tips_and_tricks_password_management)
- [Hudu — External Sharing (share links, portal)](https://support.hudu.com/hc/en-us/articles/8588122864407-External-Sharing)
- [Hudu — Expirations](https://support.hudu.com/hc/en-us/articles/8688891380631-Expirations)
- [Hudu — Expiration Tracking use case](https://hudu.com/use-case/expiration-tracking)
- [Hudu — Website and SSL Monitoring](https://support.hudu.com/hc/en-us/articles/8353290960407-Website-and-SSL-Monitoring)
- [Hudu — Key Concepts (companies, assets, layouts, processes)](https://support.hudu.com/hc/en-us/articles/11420910999063-Key-Concepts)
- [Hudu — Asset Layouts (field types)](https://support.hudu.com/hc/en-us/articles/7905521347991-Asset-Layouts)
- [Hudu — Password Expiration feature request (Canny)](https://hudu.canny.io/feature-requests/p/password-expiration)
- [Hudu — Introducing Hudu Password Manager extension](https://community.hudu.com/discussions/post/hudu-browser-extension-changes-fXNErnmUmaIO3tc)
- [IT Glue — Passwords (help)](https://help.itglue.kaseya.com/help/Content/2-using/documentation-guide/passwords.html)
- [IT Glue — The Vault (host-proof hosting)](https://help.itglue.kaseya.com/help/Content/2-using/permissions/the-vault.html)
- [IT Glue — Domains (RDAP/WHOIS, DNS, cadence)](https://help.itglue.kaseya.com/help/Content/2-using/documentation-guide/domains.html)
- [IT Glue — SSL certificates](https://help.itglue.kaseya.com/help/Content/2-using/documentation-guide/ssl-certificates.html)
- [IT Glue — OTP generator](https://help.itglue.kaseya.com/help/Content/2-using/security/generating-one-time-passwords-otp.html)
- [IT Glue — MyGlue client password management scenario](https://help.itglue.kaseya.com/help/Content/5-myglue/using-myglue/myglue-scenario-1-client-password-management-solution.html)
- [Passbolt — Security white paper v5.4](https://www.passbolt.com/docs/files/security_white_paper_-_passbolt_pro_edition_v5.4_-_(august_2025_-_rev9).pdf)
- [Passbolt — Road to v5: encrypted metadata](https://www.passbolt.com/blog/the-road-to-passbolt-v5-encrypted-metadata-and-other-core-security-changes-2)
- [Passbolt — Password expiry (auto-expire on access loss)](https://www.passbolt.com/docs/admin/resource-policies/password-expiry/)
- [Passbolt — Automation of shared password expiry](https://www.passbolt.com/blog/passbolts-new-automation-of-shared-passwords-expiry)
- [Bitwarden — Event logs (item event codes 1100–1118)](https://bitwarden.com/help/event-logs/)
- [Bitwarden — Provider Portal (MSP)](https://bitwarden.com/help/providers/)
- [Bitwarden — About Send / Send lifespan](https://bitwarden.com/help/send-lifespan/)
- [Bitwarden — Emergency Access](https://bitwarden.com/help/emergency-access/)
- [1Password — Item categories and fields](https://support.1password.com/item-categories/)
- [1Password — Share items (links, expiry, email verification)](https://support.1password.com/share-items/)
- [Keeper — One-Time Share](https://docs.keeper.io/user-guides/sharing/one-time-share)
- [Keeper — Record types](https://docs.keeper.io/enterprise-guide/record-types)
- [Infisical — Security / encryption model (root key, AES-256-GCM hierarchy)](https://infisical.com/docs/internals/security)
- [Infisical — Secret sharing (max views, expiry, password)](https://infisical.com/docs/documentation/platform/secret-sharing)
- [Infisical — Update June 2023 (E2EE deprecated as nice-to-have)](https://infisical.com/blog/infisical-update-june-2023)
- [Infisical — Secret rotation reminders issue](https://github.com/Infisical/infisical/issues/2860)
- [ElePass — client password manager for agencies](https://elepass.io/)
- [Jetpack CRM — Client Password Manager extension](https://jetpackcrm.com/product/client-password-manager/)
- [Bitwarden — Password manager for marketing agencies](https://bitwarden.com/solutions/marketing-agencies/)
- [ICANN — RDAP replaces WHOIS for gTLDs (Jan 2025)](https://www.icann.org/en/announcements/details/icann-update-launching-rdap-sunsetting-whois-27-01-2025-en)
- [Retrieving domain expiration via RDAP events](https://internet.noticeable.news/publications/retrieving-the-expiration-date-of-a-domain-using-rdap)
- [Docmost vs BookStack comparison](https://docmost.com/compare/docmost-vs-bookstack)
- [Outline vs BookStack (elest.io)](https://blog.elest.io/outline-vs-bookstack-which-self-hosted-wiki-for-your-team/)


## Implementation stack for an Azure-DevOps/Linear-class board + backlog + timer UI in Next.js 16 / React 19.2 / Prisma 7 / Postgres 18 (RLS) on Vercel fra1 with EU residency

Verified against the npm registry on 2026-08-16 and the Next.js 16.3 docs bundled in node_modules. Headline picks: (1) DnD: @atlaskit/pragmatic-drag-and-drop 3.0.0 (released 2026-08-14, Apache-2.0, ~4.7 kB core, framework-agnostic, native drag on iOS/Android, virtualization-safe, powers Jira/Trello) with hitbox + auto-scroll + react-drop-indicator and an explicit keyboard "Move to…" menu for a11y; @dnd-kit/core 6.3.1 has had no release since Dec 2024 and its successor @dnd-kit/react is 0.5.x pre-1.0, @hello-pangea/dnd 18.0.1 (Feb 2025) is the safe React-19 fallback if you want built-in keyboard DnD. (2) Ordering: fractional-indexing 4.0.0 (Rocicorp, June 2026) string ranks stored in a COLLATE "C" text column, rank computed server-side from (beforeId, afterId) inside a transaction with SELECT … FOR UPDATE on the neighbours, jitter, unique (tenantId, containerId, rank) constraint with retry, rebalance when keys exceed ~50 chars; the lexorank npm package is dead (2022). (3) Realtime: Vercel Functions cap at 300 s (Hobby) and bill provisioned-memory time for idle connections; Neon's pooler forbids LISTEN/NOTIFY; Ably and Liveblocks EU-only residency are Enterprise-only; Pusher has an all-plan eu (Ireland) cluster; Upstash Redis EU supports pub/sub over REST/SSE; Vercel WebSockets are public beta (June 2026, experimental_upgradeWebSocket in Next.js) but single-instance with no fan-out. v1: cheap version-poll (every 10-15 s + on focus) that triggers router.refresh(); v1.5: SSE route handler relaying Upstash EU pub/sub. (4) Editor: Tiptap 3.30 (MIT; v3 open-sourced drag-handle, file-handler, unique-id, emoji, details, TOC) storing ProseMirror JSON, mentions via @tiptap/extension-mention, uploads presigned to R2, sanitize server-rendered HTML with DOMPurify; use useEditorState (React Compiler gotcha #6566). (5) Charts: Recharts 3.10 (React 19, shadcn charts). (6) Timeline: hand-built CSS-grid milestone timeline in v1; @svar-ui/react-gantt 2.7 (MIT, React 19, virtualized) when dependencies/drag-scheduling are needed. (7) TanStack Table 9.1 (Aug 2026, opt-in features) + TanStack Virtual 3.14, cmdk 1.1, react-hotkeys-hook 5.3, date-fns 4 + @date-fns/tz (Temporal is Stage 4/ES2026 and in Chrome 144/Firefox 139 but not Safari stable — polyfill optional). (8) Timers: TimeEntry rows with stoppedAt NULL, unique partial index per member, btree_gist EXCLUDE to forbid overlaps, denormalized projectId on entries so rollups are flat SUM/GROUP BY; recursive CTE only for subtree display; skip closure tables and ltree. (9) React 19 useOptimistic + server actions + refresh()/updateTag exactly as the Next.js 16 "Building interactive apps" Taskboard guide; no TanStack Query in v1. (10) PDF: @react-pdf/renderer 4.6 in a Node route handler in fra1 for v1; Gotenberg self-hosted in Hetzner EU or @sparticuz/chromium 149 + playwright-core when HTML fidelity is needed. (11) Next 16 gotchas: proxy.ts (done), cacheComponents/'use cache' must never cache tenant-scoped reads without tenantId in the key (RLS does not protect a cache), refresh() only from server actions, 'use cache: private' unavailable in route handlers, React Compiler is on — watch libraries that read mutable objects during render.

**Recommendations**
- Adopt @atlaskit/pragmatic-drag-and-drop 3.x for board and backlog; wrap it once in a small internal <Sortable> abstraction so a later switch (e.g. to @dnd-kit/react 1.0) is local — dnd-kit legacy is unmaintained since Dec 2024 and its successor is 0.5.x.
- Use fractional-indexing 4 string ranks in a COLLATE "C" text column, computed server-side from neighbour ids inside the tenant transaction with FOR UPDATE + jitter + unique constraint retry; do not use the lexorank npm package (dead) or integer renumbering.
- Ship v1 realtime as version-polling + focus refresh through router.refresh(); reserve SSE-over-Upstash-EU (or Pusher eu cluster) for v1.5; do not use Ably/Liveblocks (EU-only routing is Enterprise) or Neon LISTEN/NOTIFY (pooler forbids it, functions cannot hold listeners).
- Standardize on Tiptap 3 with ProseMirror JSON storage, useEditorState for toolbar state (React Compiler), server-side generateHTML + DOMPurify for portal/email rendering, and presigned R2 uploads for images.
- Follow the Next.js 16 'Building interactive apps' guide literally: Suspense-streamed reads, useOptimistic reducers, startTransition (not useTransition) on drop, refresh() from server actions; skip TanStack Query in v1 (revisit only if you need client-side cache across routes).
- Do NOT enable 'use cache' for tenant-scoped reads until you have a rule that tenantId/memberId is an explicit argument of every cached function and tests that assert cache keys differ per tenant; RLS protects rows, not the Next.js data cache.
- Model timers as TimeEntry rows with a partial unique index (one running per member) and a btree_gist EXCLUDE overlap constraint; compute duration and cost on the server; snapshot the hourly rate per entry.
- Denormalize projectId/clientId onto WorkItem and TimeEntry so aggregates are flat under RLS; cap hierarchy depth at 3 and use a bounded recursive CTE only for subtree panes; skip ltree/closure tables.
- Use Recharts 3 (via shadcn/ui chart wrappers) for burndown/CFD/time-by-member; keep dataviz to a small consistent set of components.
- Build the milestone timeline yourself in v1; adopt @svar-ui/react-gantt (MIT) only when dependency links and drag-scheduling are requested.
- Start on TanStack Table v9 (opt-in features) + TanStack Virtual for backlog/time-sheet tables; cmdk for the palette; react-hotkeys-hook for scoped shortcuts; nuqs for URL filter state.
- Generate PDFs with @react-pdf/renderer inside a fra1 Node route handler and store to R2; put Gotenberg on a Hetzner EU box later if designed HTML reports are needed.
- Use Postgres 18 uuidv7() for new hot tables and add a Vercel Cron for stale-timer auto-stop, rank rebalancing, and sprint burndown snapshots; use after() in server actions for non-blocking side effects (notifications, publish).
- Add the four test families for the new tables now: tenant isolation on WorkItem/TimeEntry, contact cannot see INTERNAL work items or raw time entries, running-timer uniqueness/overlap constraints, and rank uniqueness under concurrent moves (two parallel transactions in the DB test suite).

**Open questions**
- Pragmatic (explicit Move-to menu for keyboard, tiny, Atlassian-backed) vs @hello-pangea/dnd (built-in keyboard drag, React 19, but board-only semantics and slower cadence) — recommended default: Pragmatic.
- Single rank per item (ordering shared between board column and backlog) vs per-container placements — recommended default: single rank per (projectId, stateId) for v1; add placements only if backlog order must differ from board order.
- Polling interval and whether to ship SSE in v1 — recommended default: 12 s poll + focus refresh in v1, SSE relay over Upstash EU in v1.5 behind a tenant feature flag.
- Store editor content as ProseMirror JSON only, or also a sanitized HTML column for search/portal — recommended default: JSON + plain-text search column (tsvector) generated on save; render HTML on demand.
- Should time totals (hours, never cost) be client-visible by default for shared work items — recommended default: off; per-project preference 'share hours with client' that only exposes aggregates via a server projection.
- Hourly rate model: project rate only vs member-project overrides in v1 — recommended default: project rate + optional member override, both snapshotted onto entries.
- Enable cacheComponents now or later — recommended default: later; keep tenant reads dynamic until the tenant-keyed cache rule and tests exist.
- PDF fidelity target for progress reports — recommended default: @react-pdf/renderer tables in v1; decide on Gotenberg only after seeing client feedback.
- Temporal polyfill vs date-fns — recommended default: date-fns 4 + @date-fns/tz; revisit when Safari ships Temporal.
- Whether the timer should also exist in the portal (contacts logging their own time) — recommended default: no; contacts are read-only on time in v1.

**Sources**
- [npm registry (versions/dates verified 2026-08-16 for all packages listed)](https://registry.npmjs.org/)
- [dnd-kit roadmap discussion (@dnd-kit/react vs core, unanswered)](https://github.com/clauderic/dnd-kit/discussions/1842)
- [dnd kit React migration guide](https://dndkit.com/react/guides/migration/)
- [PkgPulse: dnd-kit vs react-beautiful-dnd vs Pragmatic DnD 2026](https://www.pkgpulse.com/guides/dnd-kit-vs-react-beautiful-dnd-vs-pragmatic-drag-drop-2026)
- [Pragmatic drag and drop repo](https://github.com/atlassian/pragmatic-drag-and-drop)
- [Pragmatic drag and drop core CHANGELOG (3.0.0)](https://github.com/atlassian/pragmatic-drag-and-drop/blob/main/packages/core/CHANGELOG.md)
- [@atlaskit/pragmatic-drag-and-drop-hitbox](https://www.npmjs.com/package/@atlaskit/pragmatic-drag-and-drop-hitbox)
- [hello-pangea/dnd](https://github.com/hello-pangea/dnd)
- [Marmelab: Kanban with shadcn + hello-pangea (Jan 2026)](https://marmelab.com/blog/2026/01/15/building-a-kanban-board-with-shadcn.html)
- [Puck: Top 5 drag-and-drop libraries for React](https://puckeditor.com/blog/top-5-drag-and-drop-libraries-for-react)
- [rocicorp/fractional-indexing](https://github.com/rocicorp/fractional-indexing)
- [fractional-indexing releases (v4.0.0)](https://github.com/rocicorp/fractional-indexing/releases)
- [Kanban position management (LexoRank → decimals, locking)](https://www.manukminasyan.com/blog/kanban-boards-position-management)
- [Nick McCleery: robust kanban indexing](https://nickmccleery.com/posts/08-kanban-indexing/)
- [fractional-indexing collisions (dev.to)](https://dev.to/sonim1/fractional-indexing-implementing-drag-and-drop-ordering-and-avoiding-index-collisions-g3)
- [Vercel Functions limits](https://vercel.com/docs/functions/limitations)
- [Vercel WebSockets (beta) incl. Next.js experimental_upgradeWebSocket](https://vercel.com/docs/functions/websockets)
- [Vercel streaming functions](https://vercel.com/docs/functions/streaming-functions)
- [Neon connection pooling (LISTEN/NOTIFY not in transaction mode)](https://neon.com/docs/connect/connection-pooling)
- [Neon supported extensions (ltree, btree_gist, pg_trgm)](https://neon.com/docs/extensions/pg-extensions)
- [Upstash REST API (SUBSCRIBE over SSE)](https://upstash.com/docs/redis/features/restapi)
- [Pusher Channels clusters (eu = Ireland)](https://pusher.com/docs/channels/miscellaneous/clusters/)
- [Ably enterprise customization (regional restrictions)](https://ably.com/docs/platform/account/enterprise-customization)
- [Liveblocks projects (EU region Enterprise only)](https://liveblocks.io/docs/platform/projects)
- [Tiptap Editor 3.0](https://tiptap.dev/tiptap-editor-v3)
- [Tiptap 3.0 beta discussion (open-sourced pro extensions)](https://github.com/ueberdosis/tiptap/discussions/6323)
- [Tiptap Next.js install (immediatelyRender)](https://tiptap.dev/docs/editor/getting-started/install/nextjs)
- [Tiptap BubbleMenu + React Compiler issue #6566](https://github.com/ueberdosis/tiptap/issues/6566)
- [BuildPilot: Tiptap vs Lexical vs Plate 2026](https://trybuildpilot.com/609-tiptap-vs-lexical-vs-plate-editor-2026)
- [Eddyter: best WYSIWYG for React 19 (2026)](https://eddyter.com/blogs/best-wysiwyg-editor-for-react-19-2026)
- [SVAR React Gantt (MIT)](https://github.com/svar-widgets/react-gantt)
- [TanStack Table v9 announcement](https://tanstack.com/blog/announcing-tanstack-table-v9)
- [TanStack Table v8→v9 migration (React)](https://tanstack.com/table/latest/docs/framework/react/guide/migrating)
- [InfoQ: Chrome 144 ships Temporal](https://www.infoq.com/news/2026/02/chrome-temporal-date-api/)
- [Bryntum: JavaScript Temporal in 2026](https://bryntum.com/blog/javascript-temporal-is-it-finally-here/)
- [Next.js 16 guide: Building interactive apps (bundled node_modules/next/dist/docs/01-app/02-guides/interactive-apps.md)](https://nextjs.org/docs/app/guides/interactive-apps)
- [Next.js Taskboard demo source](https://github.com/vercel-labs/async-react-demo)
- [Next.js refresh() API](https://nextjs.org/docs/app/api-reference/functions/refresh)
- [Next.js proxy.ts file convention](https://nextjs.org/docs/app/api-reference/file-conventions/proxy)
- [Next.js 'use cache: private'](https://nextjs.org/docs/app/api-reference/directives/use-cache-private)


## progress-reports: capturing project progress over time and publishing client-facing progress reports / timelines (status updates, health, metrics snapshots, schedules, digests, asset catalog with approvals, activity-feed noise)

Across Asana, Linear, Plane, Teamwork, OpenProject and Basecamp the "status update" has converged on one shape: a per-project post with (a) a hand-picked health signal (on track / at risk / off track, plus on hold / complete), (b) a short rich-text narrative, (c) optional attachments, and (d) auto-inserted context computed at post time (Asana drags in charts/milestone highlights; Linear appends a progress graph, target-date/lead/milestone changes when they moved >2%; Confluence embeds live JQL macros for "resolved last 7 days" and "still open"). Health is always human-chosen — OpenProject explicitly says it is "not calculated"; Asana's own community says definitions are subjective — while numbers are machine-filled. Updates are effectively immutable once posted (Asana API: create/delete only; Teamwork: 15-minute edit window) and displayed newest-first on a Progress/Updates tab; the latest one is pinned on the project overview and rolled up to portfolio views. Cadence is enforced by reminders (Linear: weekly/biweekly, day+time in local tz, nudges at +1 and +2 working days, "Update missing" badge; Asana: reminders the day before). AI drafts (Asana Smart Status, Linear "Write with Agent") only summarise data already in the system and are edited before publishing.

Client-facing reporting tools (AgencyAnalytics, Whatagraph, DashThis) add: report = cover + TOC + sections + widgets + text commentary; templates; schedules (daily→yearly) with rolling date ranges only; an optional review/hold step before auto-send; PDF (frozen snapshot) vs web link (live); report logs (generated/sent/opened); version history of the report itself. Their users' loudest complaint is data overload — clients want a one-page narrative with 3–5 metrics, comparison to last period, and "what do you need from me"; and they want frequent bite-sized updates plus a persistent visual place to check progress (the "clients ask for updates even when you send them" problem). monday agencies articulate the wish precisely: pick a project, define client visibility, get a branded plain-language email organised by done / in progress / next / awaiting you, plus a login-free link.

For deliverables, Teamwork Proofs / Filestage / Ziflow share one model: asset with stacked versions, comments bound to a version, per-approver decision (pending / needs changes / approved), overall status In review → Needs changes → Approved, reviewers notified on new version, external reviewers without seats. Activity feeds everywhere are noisy (Jira automation spam, Basecamp's 7 am daily recap); the fix is curated timelines (only published/first-class events), aggregation, and Basecamp's exception: clients see only what was explicitly marked visible.

Fortleva design in short: a new `ProjectUpdate` entity (draft→published, health, narrative sections, frozen metrics snapshot, visibility, period), a derived client Timeline that unions published updates + shipped ProjectVersions + Milestones + published Documents + sign-offs (never AuditEvent), a per-project update schedule with reminders + auto-drafted snapshot, a Monday client digest, deliverable approvals on Document/FileVersion mirroring the ProjectVersion inline approval, and print-CSS/PDF export stored as a client-visible Document.

**Recommendations**
- Build `ProjectUpdate` as the core 'progress' primitive in Phase 3 (portal), not Phase 6 — it is the client's landing view and reuses Milestone/ProjectVersion/Document; Phase 6 then adds schedules, PDF and metric-heavy reports.
- Keep health manual and the numbers automatic: a `computeProjectSnapshot(projectId, period)` service (tasks, time entries, cost, milestones, versions, requests) frozen into the update at publish; never derive health from it.
- Ship default sections Summary / Done / Next / Blockers / Needs your decision, with a per-tenant template; keep the client body ≤ one screen — enforce with a soft length hint, not a limit.
- Draft → preview-as-client → publish, with visibility defaulting INTERNAL and RLS restrictive policy on status+visibility; publish is the audited, permission-gated action (`project_update:publish`).
- Client Timeline = curated union read model (updates, milestones, shipped versions, published deliverables, sign-offs) with type filters and month grouping; explicitly forbid AuditEvent from ever feeding the portal.
- Add update schedule + reminders + 'Update missing' badge and cron auto-draft (pre-filled snapshot & lists) in Phase 5/6; deterministic pre-fill first, LLM paraphrase later behind an entitlement.
- Weekly Monday client digest (in Phase 5 notifications) with 'awaiting your action' block; event emails only for sign-off/approval requests and health drops to Off track.
- PDF: print stylesheet for updates/timeline in Phase 3; server-generated PDF (stored as Document kind REPORT, FileObject kind EXPORT, EU R2) in Phase 6 with cover page (tenant logo, client, project, period, generated-at) — this satisfies the founder's 'progress reports with timelines' as archivable artefacts.
- Deliverables: extend Document with kind + inline approval (same shape as ProjectVersion v1-lite) and version-bound comments; approvals appear on the timeline; full multi-approver workflows stay v2.
- Credentials: separate encrypted `Secret` entity with reveal-audit and INTERNAL-only default; never store secrets in Document/hostingNotes; not part of the reports surface.
- Time/cost in client-visible snapshots must be double-gated: project-level `shareHoursWithClient` / `shareCostWithClient` flags plus tenant preference; default off; portal projection strips per-member breakdown.
- Add a staff portfolio 'Project health' table (health, latest update, % done, hours vs budget, days left, update missing) — trivial once snapshot service exists and matches Teamwork/Linear.
- Non-negotiable tests: unpublished/internal updates never returned by any portal query; snapshot excludes cost/hours unless flagged; timeline union respects clientId; digest never includes another client's items; deleting/archiving an update is audited.
- Skip Hill Charts, team check-ins and a drag-and-drop widget report builder in v1; a fixed, well-designed template beats a builder for a solo founder.

**Open questions**
- Immutability policy after publish: 15-minute silent grace then visible 'corrected' note (recommended) vs free edits by author (Linear) vs no edits (Asana)?
- Should ProjectUpdate be per project only, or also per client (multi-project retainer summary)? Recommend per project in v1 with a client-level digest/timeline that aggregates.
- Health vocabulary: 5 states (On track/At risk/Off track/On hold/Complete) — recommended default; allow tenant relabelling of the three colours (Teamwork) or fixed enum? Recommend fixed enum, i18n labels.
- Client-visible hours/cost by default off (recommended); should tenants be able to expose per-member hours to clients at all? Recommend never per-member in portal v1.
- Comments on updates: generalise IssueComment into a polymorphic Comment now (recommended) or add ProjectUpdateComment and merge later?
- PDF generation stack on Vercel: HTML→PDF via a headless-Chromium function (heavier) vs @react-pdf/renderer (lighter, less faithful). Recommend print CSS in v1 and react-pdf for archived snapshots; revisit if branding demands pixel parity.
- Digest cadence: Monday weekly default (recommended) with per-contact opt-out; do contacts get a per-project subscription toggle?
- Auto-draft on schedule: create the DRAFT automatically (recommended) vs only remind; and should staff be able to publish from the reminder email with one click?
- Timeline as derived union vs materialised TimelineEntry table from day one — recommend derived until pagination/perf forces materialisation.
- Should a published update be revocable (unpublish) or only archivable? Recommend archive-only (audited), with delete reserved for admins within grace.

**Sources**
- [Asana developers — StatusUpdate resource](https://developers.asana.com/reference/status-updates)
- [Asana — Status updates feature page](https://asana.com/features/project-management/status-updates)
- [Asana Help — Share project updates](https://help.asana.com/hc/en-us/articles/14246229345947-Project-status-updates-and-reporting)
- [Asana Forum — Smart Status (AI) status updates](https://forum.asana.com/t/automate-project-status-updates-with-the-asana-intelligence-smart-status-feature/552005)
- [Asana Forum — Export Status Updates (feature request)](https://forum.asana.com/t/export-status-updates/120390)
- [Asana Forum — Best practice for defining On track / At risk / Off track](https://forum.asana.com/t/best-practice-for-defining-status-on-track-concerned-off-track/34629)
- [Linear Docs — Initiative and Project updates](https://linear.app/docs/initiative-and-project-updates)
- [Linear Changelog — Project Updates (2022)](https://linear.app/changelog/2022-08-04-project-updates)
- [Linear Changelog — Agent-assisted project updates (2026)](https://linear.app/changelog/2026-06-18-agent-assisted-project-updates)
- [Plane Docs — Project updates](https://docs.plane.so/communication-and-collaboration/project-updates)
- [Basecamp Help — Hill Charts](https://5.basecamp-help.com/article/1078-hill-charts)
- [Basecamp Help — Automatic Check-ins](https://5.basecamp-help.com/article/1051-automatic-check-ins)
- [Basecamp bc3-api — client_visibility](https://github.com/basecamp/bc3-api/blob/master/sections/client_visibility.md)
- [Basecamp Help — Getting started as a client](https://5.basecamp-help.com/article/1087-getting-started-as-a-client)
- [Signal v. Noise — Two new email reports in Basecamp](https://signalvnoise.com/svn3/two-new-email-reports-in-basecamp/)
- [Teamwork Support — Adding Project Updates](https://support.teamwork.com/projects/project-options/project-updates)
- [Teamwork Support — Using Project Health Reports](https://support.teamwork.com/projects/reports/using-project-health-reports)
- [Teamwork Support — Generating a Project Report (PDF)](https://support.teamwork.com/projects/project-sections/project-report)
- [Teamwork Support — Upload a New Proof Version](https://support.teamwork.com/projects/proofing/proof-versions)
- [Teamwork Support — Review and Approve Proofs](https://support.teamwork.com/projects/proofing/review-and-approve-proofs)
- [Confluence — Project status report template](https://www.atlassian.com/software/confluence/templates/project-status)
- [Confluence — Jira Report blueprint](https://confluence.atlassian.com/doc/jira-report-blueprint-427623492.html)
- [OpenProject 10.1 — project status reporting](https://www.openproject.org/blog/openproject-10-1-with-project-status-reporting-in-a-project-overview-dashboard/)
- [OpenProject — Projects FAQ (status not calculated)](https://www.openproject.org/docs/user-guide/projects/projects-faq/)
- [AgencyAnalytics KB — Report overview](https://help.agencyanalytics.com/en/articles/4706526-report-overview)
- [AgencyAnalytics — Report scheduling](https://agencyanalytics.com/feature/report-scheduling)
- [AgencyAnalytics blog — Client reporting data overload](https://agencyanalytics.com/blog/client-reporting-data-overload)
- [Whatagraph Help — How to automate a report](https://help.whatagraph.com/en/articles/6309188-how-to-automate-a-report)
- [Whatagraph — DashThis comparison](https://whatagraph.com/alternatives/dashthis)
- [ClickUp — Automate weekly status report with AI](https://clickup.com/blog/how-to-automate-weekly-status-report-with-ai/)
- [Scoro Help — Burn and breakdown charts](https://support.scoro.com/hc/en-us/articles/18326155777037-Burn-and-breakdown-charts-budget)
- [Productive Help — Reports overview](https://help.productive.io/en/articles/3732255-reports-overview)
- [monday community — Agencies, how do you send clients project status updates?](https://community.monday.com/ask-the-com/post/agencies----how-do-you-send-clients-project-status-updates-ThuPw7I3dN15BXW)
- [Moxo — Client-facing project dashboards & alerts](https://www.moxo.com/blog/client-facing-project-dashboard)
- [SuiteDash — Project settings (digest emails)](https://help.suitedash.com/article/78-project-settings)
- [Project Panorama — Why clients ask for updates even when you send them](https://www.projectpanorama.com/why-clients-ask-for-updates-even-when-you-send-them/)
- [WhatConverts — The analytics overwhelm issue](https://www.whatconverts.com/blog/the-analytics-overwhelm-issue-solving-client-report-confusion/)
- [Filestage vs Ziflow comparison](https://filestage.io/filestage-vs-ziflow/)
- [Atlassian Community — Jira activity stream filtering & noise](https://community.atlassian.com/forums/App-Central-articles/How-to-filter-and-customize-Activity-Stream-Gadget-for-Jira-User/ba-p/2589636)
- [GetStream — Aggregated feeds demystified](https://getstream.io/blog/aggregated-feeds-demystified/)


## (untitled)

The nine research tracks cover the feature surface (ADO/Planner/Linear-class boards, timer + rate/cost engine, client sharing, vault/assets, progress reports, implementation stack) unusually well and converge on a coherent design. Three kinds of things are missing.

(1) Whole dimensions nobody researched: legal/HR compliance of tracking employees' time and cost rates in Sweden (MBL §11 negotiation duty before introducing control/monitoring systems, IMY guidance on employee monitoring, GDPR Art. 88 + DPIA list, Bokföringslagen 7-year retention of billing-supporting records) and US-side state monitoring-notice laws — Fortleva's SECURITY.md/DATA_MODEL.md have retention classes and a sub-processor list but zero words on employee-monitoring law; search architecture (Postgres FTS with sv+en dictionaries, pg_trgm, tsvector over ProseMirror JSON, RLS-safe ranking, what the cmdk palette actually queries); a real notification/inbox + email pipeline design (in-app inbox schema exists in Plane notes, but SES templates, SNS bounce/complaint handling, reply-by-email / email-in, digest scheduling on Vercel cron, per-locale emails were never designed and mailer is a stub); the concrete time→invoice bridge and retainer/hour-bank ledger for Phase 4 in a Swedish context (Fortnox/Bokio export, tidrapport attachment, prepaid-hours ledger with carry-over/expiry, reverse-charge for US clients, rounding frozen into InvoiceLine); mobile/PWA usage of the timer and board (Web Push on iOS PWA, offline start/stop queue, responsive kanban, touch DnD).

(2) Cross-agent contradictions the planner must reconcile rather than research: single vs multiple assignees (ADO/modern-ux say single, Planner says up to 20); fixed 3-4 states (Planner) vs configurable states in categories (ADO/Linear/Plane); 3-level Epic/Story/Task vs parentId depth≤3 vs Bucket+Task; checklists-in-description vs ChecklistItem table; separate WorkItemActivity table vs reuse AuditEvent; task-scoped rates yes/no; one polymorphic Comment table; whether Issue is merged into WorkItem (triage category). Also: docs explicitly hold 'pointers not secrets' and 'time tracking — skip' — both need dated decision entries, and PLAN.md's tracker is stale.

(3) Claims that look date-fragile and should be spot-verified before being baked into ARC entries: @atlaskit/pragmatic-drag-and-drop 3.0.0 (2026-08-14), TanStack Table v9 GA (2026-08-04), fractional-indexing 4.0.0 (June 2026), Vercel WebSockets public beta (June 2026), Linear 'agent-assisted project updates' changelog (2026-06-18), Planner Jan–Feb 2026 refresh retiring iCal/Loop, PG18 WITHOUT OVERLAPS + btree_gist availability on Neon, 'Neon pooler forbids LISTEN/NOTIFY', SES inbound receiving in eu-central-1, ICANN RDAP mandatory Jan 2025. Uncovered OSS worth reading: Odoo project/timesheet/sale/portal (timesheet→invoice, prepaid hours, portal), Invoice Ninja (time → invoice), GitLab issue time tracking (/spend, /estimate, timelogs), Worklenz, Redmine timelog, Traggo. Smaller uncovered UX topics that can ride inside the five prompts or the plan itself: recurring tasks, capacity/workload, calendar view, dependencies (all rated could/later by researchers), imports from Trello/Jira/Asana/CSV, onboarding/empty states, i18n of a board UI (sv/en dates, numbers, week start Monday), WCAG for DnD (covered by explicit Move-to menu).

## Notification, inbox and email pipeline design for Fortleva (work module + portal): data model, fan-out/noise control, delivery on Vercel + SES eu-central-1, reply-by-email/email-in, client digest, in-app inbox UX, phased rollout

Fortleva needs one notification pipeline that every later track (mentions, assignment, timers, budgets, updates, approvals, expirations, cadence reminders, weekly client digest) plugs into, and it must be structurally incapable of emailing an INTERNAL fact to a Contact. Recommended shape: (a) an in-transaction event → `Notification` row fan-out inside the same `withTenant()` unit of work as the mutation (using the same seam as `audit.record()`), (b) a durable Postgres `EmailOutbox` table with a `dedupeKey`, `sendAfter` (debounce/coalesce) and `FOR UPDATE SKIP LOCKED` worker, (c) a single Vercel Cron worker on Pro (`*/2 * * * *`) plus an `after()` "kick" from server actions so instant mail leaves within seconds, (d) SES v2 `SendEmail` in eu-central-1 with a configuration set → SNS → HTTPS route handler for bounce/complaint/delivery, and (e) email bodies rendered per recipient locale from i18n keys + params (never pre-rendered strings) at send time, with digests re-querying CLIENT_VISIBLE facts through the portal RLS role. Verified facts that shape the design: Vercel Hobby crons run once per day with ±59 min jitter, Pro runs per minute — Pro ($20/mo) is required for a usable outbox worker and stays inside the < $50 budget; SES sandbox is 200 msgs/24h, 1 msg/s, verified recipients only until production access; SES supports email receiving in eu-central-1 (`inbound-smtp.eu-central-1.amazonaws.com`) with SNS (≤150 KB) or S3 actions in-region, so reply-by-email and email-in are feasible entirely inside Frankfurt; SES subscription management adds RFC 8058 List-Unsubscribe headers only for single-recipient sends and requires Easy DKIM — but for digests we should set our own List-Unsubscribe/List-Unsubscribe-Post pointing at a signed Fortleva URL, so preferences remain in our DB. Modelled after Plane (Notification + UserNotificationPreference + EmailNotificationLog, snoozed_till/archived_at), GitLab (Watch/Participate/Mention/Custom levels, X-NotificationReason, `%{key}` reply address), Linear (Inbox with keyboard nav, group by item, snooze), Basecamp (Hey!, per-thread mute) and Vikunja (subscriptions cascade). Ships with the work module: Notification, NotificationPreference, Subscription, EmailOutbox/EmailEvent, worker cron, SES transport, SNS webhook, in-app inbox, member digest, i18n emails. Phase 3/5: client digest, approvals, reply-by-email, email-in. Never: notify-everyone-on-comment (Planner noise), pre-rendered notification strings, sending from request path without outbox.

**Recommendations**
- Build the pipeline as part of the work module (not Phase 5): Notification + Subscription + NotificationPreference + EmailOutbox + EmailEvent + worker cron + SES transport + SNS webhook + inbox page — the work module is unusable without assignment/mention notifications, and retrofitting an outbox later is painful.
- Upgrade Vercel to Pro before the work module ships: Hobby crons are once-per-day with ±59 min jitter (Vercel docs), which cannot run an outbox worker or an 8h-timer nudge; Pro ($20/mo) keeps you inside the < $50 budget with SES pennies and Upstash free tier.
- Use the transactional-outbox pattern (Postgres table + FOR UPDATE SKIP LOCKED) rather than QStash or after()-only sending: durable, EU-resident, inspectable in /ops, no new sub-processor; add `after()` as a low-latency kick only.
- Never store rendered strings in Notification; store kind + params and render in the reader's locale (in-app) or the recipient's preference locale (email) using next-intl `createTranslator` — `getTranslations()` needs request context that cron does not have.
- Make 'audience' a property of the kind catalog and enforce with tests: any kind that can reach a Contact must be clientVisibleOnly and its Contact fan-out must run under the portal role; add the four-part 'no INTERNAL fact to a Contact' test family to the non-negotiable list.
- Implement own List-Unsubscribe + RFC 8058 one-click endpoint for digest/coalesced kinds instead of SES ListManagementOptions (which stores subscription state in AWS contact lists and only applies to single-recipient sends); keep the preference source of truth in Postgres.
- Two SES configuration sets and two From addresses (notify@ transactional, digest@ bulk-ish), one SNS topic → one HTTPS webhook with signature verification; write EmailEvent and EmailSuppression on hard bounce/complaint and mirror to the SES account-level suppression list.
- Fix the reply path now (PLAN already flags it): set Reply-To to a monitored mailbox in Phase 1/2, and design the `reply+{token}@in.mailer.naxdor.com` address scheme so that turning on SES receiving in eu-central-1 (verified available: inbound-smtp.eu-central-1.amazonaws.com) in Phase 5 needs no header changes.
- Debounce assignment (2 min, cancel-if-read) and coalesce comment/activity mail per item per 10 min; default comment fan-out = mentioned + participants only; WATCHers get digest — this is the Planner 2026 lesson.
- Rate-limit and cap: max 500 open notifications per principal, auto-archive read > 90 days; outbox per-tenant cap (e.g. 2,000 emails/day) with an ops alert, since one runaway loop against SES can burn reputation.
- Retention: EmailOutbox params + EmailEvent 90 days then params nulled (keep status/messageId 12 months for deliverability disputes); InboundEmail raw MIME in S3 30 days; Notification archived rows purged after 12 months; document in ROPA (SECURITY.md §9).
- Keep SES data location: identity, config set, SNS, S3 inbound bucket all in eu-central-1; do not enable SES open/click tracking (US-branded awstrack.me domain and unnecessary personal data); DPA sub-processor list already covers AWS SES.
- Ship the member digest with the work module and the client digest with Phase 3 portal (needs ProjectUpdate + client-visible items); reply-by-email and email-in in Phase 5 behind entitlements, only if a real tenant asks.
- Add these audit events with the module: notification.preference_changed, notification.unsubscribed_one_click, email.suppressed, email.bounce_received, email.complaint_received, digest.client_sent, project_update.published; later comment.created_via_email, workitem.created_via_email, inbound_email.rejected.
- Vercel Cron schedule (vercel.json): `/api/cron/outbox` */2 * * * * (Pro; also kicked by after()); `/api/cron/timers` */15 * * * *; `/api/cron/digest-members` 0 * * * * (hourly, sends to members whose local digest hour == now); `/api/cron/digest-clients` 0 * * * 1 hourly-guarded to Monday local 08:00 (or 0 6,7,8,9 * * 1 to cover EU/US zones); `/api/cron/reminders` 0 5 * * * (expiry, update-overdue, approval reminders, budget nightly recompute); `/api/cron/retention` 0 3 * * *. All routes verify `CRON_SECRET`, run maxDuration 60 s, batch and self-re-invoke.
- Pipeline diagram: server action / mutation → withTenant tx {write entity, audit.record, notify.emit → resolve recipients (Subscription ∪ assignee ∪ mentioned − actor, filtered by NotificationPreference, Contact recipients only for clientVisibleOnly kinds under portal projection) → INSERT Notification (dedupeKey upsert) → UPSERT EmailOutbox(idempotencyKey, sendAfter)} → commit → after(kickOutbox) ‖ cron */2 → worker claims SKIP LOCKED → suppression check → render(locale) → SES v2 SendEmail(configSet, tags, headers Message-ID/In-Reply-To/List-Unsubscribe) → mark SENT (sesMessageId) → SES event → SNS → /api/webhooks/ses → EmailEvent (+ EmailSuppression on bounce/complaint) ; inbound (Phase 5): SES receipt rule → S3 EU + SNS → /api/webhooks/inbound → verify token+sender → comment/work item under actor's forced visibility.
- Rejected alternatives: Resend/Postmark (disqualified, non-EU control); QStash as primary queue (extra vendor/DPA, retries billed, not needed at v1); pg_cron/Neon scheduled functions (Neon scale-to-zero doesn't fire, SECURITY.md already notes this); LISTEN/NOTIFY (unsupported through transaction-mode pooler per TENANCY.md); SES ListManagementOptions for unsubscribe (state lives in AWS, single-recipient only, EU-residency of contact lists unclear); react-email with remote fonts/images (CSP/privacy); storing rendered HTML in Notification (breaks sv/en and retro-fixes); notifying whole team on comments (Planner noise); web push/SMS at v1 (cost, consent complexity); Novu/Knock hosted notification services (US, cost, another processor).

**Open questions**
- Vercel Pro now or a Hobby-compatible fallback? Recommended default: Pro before the work module ships; the outbox and timer nudges do not work on daily crons.
- Reply-To before Phase 5: monitored SiteGround mailbox (PLAN's cheap fix) vs no-reply with a portal deep link? Recommended default: monitored mailbox `hello@…` as Reply-To on all transactional mail now; switch to reply+{token} when SES receiving is enabled.
- Should Contacts ever receive comment emails, or only 'update published' and approvals? Recommended default: Contacts get mention + comment-on-my-item (client-visible only) + updates + approvals + weekly digest; tenant master switch defaults OFF until branding is set.
- Client digest day: Friday (week wrap-up) or Monday (week ahead)? Recommended default: Monday 08:00 tenant TZ, tenant-configurable to Friday 16:00.
- Member digest default: daily or weekly? Recommended default: daily at 08:00 local for COALESCED/DIGEST kinds; email level PARTICIPATING.
- Do we build reply-by-email and email-in at all before a tenant asks? Recommended default: design headers/address scheme now, implement in Phase 5 only behind entitlement; email-in only if forwarding client emails is a real Naxdor workflow.
- Where does the SNS webhook live: Next.js route in fra1 (recommended, simplest) or a Lambda in eu-central-1 writing directly to Neon? Default: Next.js route with SNS signature verification; Lambda only if webhook cold starts cause SNS retries.
- Sender name for client-facing mail: '{Tenant name} via Fortleva' or just '{Tenant name}'? Default: '{Tenant name} (via Fortleva)' with tenant logo, configurable to hide 'via' on paid tiers.
- Retention numbers for outbox/event rows (proposed 90 days params / 12 months metadata) — confirm with the lawyer list alongside the audit retention schedule.
- Do Managers get budget alerts for all projects or only projects they are assigned to? Default: project lead + members with `project:manage` on that project; CEO gets a weekly rollup instead.

**Sources**
- [Vercel — Usage & Pricing for Cron Jobs (Hobby daily/±59 min, Pro per-minute)](https://vercel.com/docs/cron-jobs/usage-and-pricing)
- [AWS — Amazon SES endpoints and quotas (eu-central-1 inbound-smtp, sandbox 200/day 1/s)](https://docs.aws.amazon.com/general/latest/gr/ses.html)
- [AWS — Regions and Amazon SES (receiving resources must be in-region)](https://docs.aws.amazon.com/ses/latest/dg/regions.html)
- [AWS — Using subscription management (List-Unsubscribe, RFC 8058, ListManagementOptions)](https://docs.aws.amazon.com/ses/latest/dg/sending-email-subscription-management.html)
- [AWS — SES receipt rule SNS action (150 KB limit, S3 alternative)](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-sns.html)
- [AWS — Setting up event notifications for SES (config sets, SNS bounces/complaints)](https://docs.aws.amazon.com/ses/latest/dg/monitor-sending-activity-using-notifications.html)
- [AWS blog — Using one-click unsubscribe with Amazon SES](https://aws.amazon.com/blogs/messaging-and-targeting/using-one-click-unsubscribe-with-amazon-ses/)
- [Upstash — QStash pricing (free 1k msgs/day, retries billed)](https://upstash.com/docs/qstash/overall/pricing)
- [Plane — notification.py models (Notification, UserNotificationPreference, EmailNotificationLog)](https://github.com/makeplane/plane/blob/preview/apps/api/plane/db/models/notification.py)
- [GitLab — Notification emails (levels, custom events, X-GitLab-NotificationReason)](https://docs.gitlab.com/user/profile/notifications/)
- [GitLab — Reply by email (%{key} reply address, 2-year metadata)](https://docs.gitlab.com/administration/reply_by_email/)
- [Next.js — after() (waitUntil semantics, maxDuration)](https://nextjs.org/docs/app/api-reference/functions/after)
- [next-intl — server actions/route handlers and createTranslator core API](https://next-intl.dev/docs/environments/actions-metadata-route-handlers)
- [RFC 8058 — Signaling One-Click Functionality for List Email Headers](https://www.rfc-editor.org/rfc/rfc8058)
- [Linear — Inbox docs](https://linear.app/docs/inbox)
- [Vikunja — Subscriptions (project → task inheritance)](https://vikunja.io/docs/subscriptions/)


## Swedish/EU labour-law and GDPR posture for employee time tracking, cost rates and access logs in Fortleva (plus US-arm notice laws and bookkeeping retention)

Bottom line: a self-started, self-stopped per-task timer with manual entries and manager-visible totals is ordinary "tidsredovisning", which Swedish law and IMY treat as normal, contract-necessary processing (Art. 6(1)(b) for pay/billing; Art. 6(1)(f) for planning/profitability). It becomes "kontroll/övervakning" — with heavier GDPR duties (DPIA, interest-balancing, MBL negotiation) and higher psychosocial-risk exposure — the moment the system captures activity the employee did not volunteer (idle detection, screenshots, app/URL logs, keystrokes, per-minute heat-maps, real-time "who is working on what now" broadcasts). Fortleva should ship only the former by default, make aggregate/manager views deny-default, give every Member self-service access + export of their own entries and audit rows about them, and never build screenshots/keystroke/URL capture. Consent is NOT a valid basis in employment (IMY explicit); Sweden has no Art. 88 statute (Dataskyddslagen 2018:218 has no employment chapter — collective agreements are the Art. 88 vehicle), so IMY's general guidance + WP29 Opinion 2/2017 govern. MBL: for an employer WITH kollektivavtal, introducing a time-registration/control system is widely treated as a "viktigare förändring" → 11 § primärförhandling + 19 § information; WITHOUT kollektivavtal (Naxdor today, presumably) 13 § 1 st. still obliges negotiation with any union that has a member employed IF the question "särskilt angår" that member's employment conditions — whether a company-wide timer counts is a genuine lawyer question; the safe practical move is written information to all staff and an offer to consult with any union-affiliated employee's union. Bokföringslagen 7 kap 2 §: räkenskapsinformation is kept until the end of the 7th year after the calendar year in which the fiscal year ended (verified). Time entries are only räkenskapsinformation to the extent the invoice depends on them (verifikation content, "handlingar av särskild betydelse") — invoiced TimeEntries should therefore inherit R1 legal-hold, with member identity pseudonymized on erasure while hours/rates/dates survive. Salary-derived cost rates are personal data (not special-category) and must get salary-grade confidentiality: permission-gated, field-encrypted, not fanned out onto every TimeEntry row in plaintext. Reveal/audit logs with IP + UA are Members' personal data; the "90 days then pseudonymize IP, keep event 24 months" plan is defensible (only CNIL publishes a number, 6–12 months; IMY publishes none). US: NY CRL §52-c, CT §31-48d, DE 19 §705 require notice for monitoring of phone/email/internet — a self-reported timer is arguably outside their scope, but the notice is cheap: ship a one-page US notice + acknowledgment. CPRA/CCPA does not reach a small agency (revenue/volume thresholds). FLSA 29 CFR 516 requires 2-year retention of time cards for non-exempt US staff. Legal facts with confidence levels are in ux_insights; feature→risk→default table in features; artefacts/retention in data_model_notes; Naxdor checklist in recommendations; lawyer questions in open_questions.

**Recommendations**
- Ship the timer as tidsredovisning, not monitoring: self-start/stop, manual entries, auto-stop, own-data self-service + export; no idle detection, screenshots, URL/app capture, keystrokes, per-minute heat-maps, live presence broadcast, or peer-visible timelines — hard 'never' list in PLAN.md and SECURITY.md so future features are challenged (reason: crossing into övervakning triggers DPIA, MBL 11 §, and US notice statutes, and is the founder's biggest reputational risk with a Swedish workforce).
- Make manager/finance visibility deny-default and purpose-bound: per-Member breakdowns only for finance/manager permission holders and assigned project leads (that project only); per-Member cost visible only with finance:costrate:read; portal sees aggregates without names unless the tenant opts in per project (reason: IMY proportionality/purpose limitation; minimization towards clients as third parties).
- Treat cost rate like salary: encrypted, permission-gated, not fanned out in plaintext across TimeEntry; offer role/blended rates as the minimization path (reason: salary-derived data is confidential personal data; snapshotting on every row multiplies exposure).
- Adopt the retention split: invoiced/locked TimeEntries = R1 (BFL 7 kap 2 §, pseudonymize member on erasure), un-invoiced = HR record class with tenant-configurable years (default 3 for US staff, 2 for Sweden-only tenants), audit events 24 months with IP/UA pseudonymized at 90 days; write it into SECURITY.md §10 and DATA_MODEL.md (reason: Art. 17(3)(b) carve-out is only defensible if the legal basis for the retention is documented).
- Ship tenant-facing artefacts in Phase 5/6 with the timer: (a) sv+en 'Personalinformation om tidsredovisning' template (purposes, basis, recipients, retention, rights, no consent language, contact) with in-app acknowledgment; (b) US 'Notice of Electronic Monitoring' template with acknowledgment (NY/CT/DE compatible); (c) DPIA-lite/interest-balancing checklist shown when enabling the module or any 'performance evaluation'/per-Member dashboard purpose; (d) ROPA row text and DPA annex paragraph; (e) marketing/DPA sentence: 'Fortleva records only time your staff report themselves; it does not capture screenshots, keystrokes, browsing or idle time' — diff against features on every change like the residency claim.
- Docs placement: SECURITY.md → new §9.x 'Employee time data & monitoring posture' (lawful basis, consent-invalid, never-list, US notices) + §10 retention rows; DATA_MODEL.md → TimeEntry/MemberCostRate/StaffNotice models with encryption + RLS notes; AUTHZ.md → new permission codes and portal aggregate rule; PLAN.md → reverse the 'Time tracking — don't build' skip-list line, add the never-list, add MBL/notice items as launch checklist for tenant zero; OPEN_QUESTIONS.md → lawyer questions below.
- Founder checklist for Naxdor before enabling timers (do yourself): 1) Confirm whether any employee is a union member; if yes and Naxdor is not bound by kollektivavtal, ask the lawyer whether MBL 13 § 1 st. is triggered and, regardless, offer that union information/consultation in writing (cheap, defuses 12–13 § disputes); if Naxdor is or becomes bound by kollektivavtal, treat introduction as 'viktigare förändring' → call 11 § förhandling and give 19 § information BEFORE go-live. 2) Issue the written staff information (sv for Sweden, en for US) and collect acknowledgments; do not ask for consent. 3) Add a short time-reporting/data-processing clause to anställningsavtal or a personalpolicy (purposes, who sees what, retention, that cost rates are confidential). 4) Record the interest-balancing/DPIA-lite in Naxdor's ROPA; note ATL 11 § overtime records if any staff are non-exempt from ATL. 5) US staff: deliver NY/CT/DE-style notice at hiring and post it (if any US Member is in NY/CT/DE), keep FLSA time records ≥ 2 years (payroll 3), check state extensions. 6) Decide and document the purposes list (billing, planning, profitability) and explicitly exclude performance evaluation for now. 7) Ensure Swedish invoices that reference time reports keep those entries 7 years (Fortleva R1 hold + export at offboarding).

**Open questions**
- MBL: For an employer with no kollektivavtal but a union-member employee, does introducing a company-wide per-task timer 'särskilt angå' that member's employment conditions under 13 § 1 st. (triggering 11–12 § negotiation), or is it merely a 19 a § information matter? Recommended default: give written information and offer consultation regardless.
- MBL: If Naxdor later signs a kollektivavtal (or a hängavtal), is enabling per-Member dashboards or cost visibility a new 11 § 'viktigare förändring' separate from the initial timer? Default: treat every purpose expansion as a new negotiation item.
- BFL: Are per-task time entries räkenskapsinformation in themselves when the invoice only states hours × rate, or only when the invoice references/attaches a time report? Default: hold invoiced entries 7 years either way; ask whether member identity may be pseudonymized within the hold.
- Retention of un-invoiced time entries and ATL 11 § overtime notes: what period do Arbetsmiljöverkets föreskrifter and wage-claim limitation rules (preskription) suggest for a small consultancy? Default: 2 years SE, 3 years US, tenant-configurable.
- GDPR: Is a per-Member salary-derived cost rate exposure to a 'Manager' role (not only CEO) proportionate, and should the notice list it explicitly? Default: only a distinct finance permission; notice states 'internal cost rates are visible only to finance roles'.
- Art. 15 access to audit logs: when a Member requests all events about them, may/should the tenant redact the identity of the other actor (e.g., manager who edited the entry)? Default: show actor role, not name, unless the actor is the requester.
- US: Does in-app logging of IP/user-agent on credential reveals constitute 'monitoring of internet access or usage' under NY §52-c / CT §31-48d / DE §705? Default: give the notice anyway.
- Pay Transparency Directive transposition in Sweden (2026): does it change what pay-related data must be shareable with workers/unions, affecting how cost rates are stored/exported? Default: no product change; keep rates exportable per Member.
- Should Fortleva (as processor) contractually forbid tenants from using the module for individual performance evaluation without documented DPIA, or merely warn? Default: warn + require purpose declaration; forbidding is a lawyer/product call.

**Sources**
- [IMY – Kontroll och övervakning av anställda (vägledning)](https://www.imy.se/vagledningar/arbetsliv/kontroll-och-overvakning/)
- [IMY – Kontroll och övervakning av anställda (översikt)](https://www.imy.se/verksamhet/dataskydd/dataskydd-pa-olika-omraden/arbetsliv/kontroll-och-overvakning-av-anstallda/)
- [IMY – Konsekvensbedömning, personuppgifter i arbetslivet](https://www.imy.se/verksamhet/dataskydd/dataskydd-pa-olika-omraden/arbetsliv/tillaten-behandling--vilka-krav-galler/konsekvensbedomning/)
- [IMY – Dataskydd i arbetslivet (rättslig grund, samtycke, art. 88)](https://www.imy.se/verksamhet/dataskydd/dataskydd-pa-olika-omraden/arbetsliv/)
- [IMY – Konsekvensbedömningar och förhandssamråd](https://www.imy.se/verksamhet/dataskydd/det-har-galler-enligt-gdpr/konsekvensbedomningar-och-forhandssamrad/)
- [Lag (1976:580) om medbestämmande i arbetslivet (MBL) – lagen.nu](https://lagen.nu/1976:580)
- [Bokföringslag (1999:1078) – riksdagen.se](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/bokforingslag-19991078_sfs-1999-1078/)
- [Arbetstidslag (1982:673) – lagen.nu](https://lagen.nu/1982:673)
- [NY Civil Rights Law § 52-c*2 – Employers engaged in electronic monitoring; prior notice required](https://www.nysenate.gov/legislation/laws/CVR/52-C*2)
- [19 Del. C. § 705 – Notice of monitoring of telephone transmissions, electronic mail and Internet usage](https://delcode.delaware.gov/title19/c007/sc01/index.html)
- [Conn. Gen. Stat. § 31-48d – Electronic monitoring notice (text not fetched this session; cite from statute)](https://www.cga.ct.gov/current/pub/chap_557.htm#sec_31-48d)
- [WP29 Opinion 2/2017 on data processing at work (WP249) – EDPB archive](https://ec.europa.eu/newsroom/article29/items/610169)
- [WP29 Guidelines on DPIA (WP248 rev.01)](https://ec.europa.eu/newsroom/article29/items/611236/en)
- [BFN – Frågor och svar: arkivering (7 år)](https://www.bfn.se/fragor-och-svar/arkivering/)
- [CNIL – Recommandation relative aux mesures de journalisation (log retention 6–12 months)](https://www.cnil.fr/fr/la-cnil-publie-une-recommandation-relative-aux-mesures-de-journalisation)
- [Unionen – Medbestämmandeförhandling, så här gör du](https://www.unionen.se/rad-och-stod/medbestammandeforhandling-sa-har-gor-du)
- [Sören Öman – 11 § medbestämmandelagen, tillämpat lagrum (AD-praxis index)](https://www.sorenoman.se/lagrum-mbl/11-%C2%A7-medbestammandelagen/)


## Gap 5 — Mobile/PWA/offline behaviour of timer, My Work and board (Web Push, offline start/stop queue, responsive kanban, touch DnD) + imports, templates, onboarding and sv/en i18n specifics

Verified findings first. (a) Pragmatic DnD's touch support is NOT production-grade: GitHub discussion #93 (opened Jul 2024, re-confirmed Sep 2025, still unanswered by Atlassian) reports drops succeeding ~10% of the time on touch and an uncomfortably long press-and-hold; native HTML5 DnD on iOS Safari also fights scroll. Recommendation: disable drag on `(pointer: coarse)` and use a "Move to…" bottom sheet + long-press context menu; keep Pragmatic on desktop. (b) PWA in Next.js 16.3: `app/manifest.ts` is first-party; Next's own PWA guide uses `web-push` from Server Actions and links Serwist for both webpack and Turbopack (`@serwist/turbopack` is at *preview* status with an esbuild step; the webpack path is stable but Next 16 defaults to Turbopack). Next 16.3 also ships `experimental.useOffline`, which silently retries Server Actions and soft navigations when the network returns — this covers most of "offline" for free but only while the tab lives, so the timer still needs a small IndexedDB pending queue. (c) Web Push: Push API is Baseline since Mar 2023; iOS 16.4+ only for home-screen (standalone) web apps, permission only from a user gesture, every push must show a notification (no silent push), Badging API available. Payloads are end-to-end encrypted (RFC 8291) so Apple/Google relays see only endpoint + timing — still list them as sub-processors and keep bodies content-free. Verdict: push is a "should" for Phase 5, email + in-app inbox is the v1 must. (d) Background Sync is Chromium-only (not Baseline); Periodic Sync Chromium + installed-only; Notification Triggers were abandoned. There is no way for a PWA to show an Android ongoing "media-style" timer notification; the practical substitutes are a same-tag persistent local notification (Android Chrome only), the app badge, and the in-app pill. (e) Intl.DurationFormat is Baseline 2025 "newly available" (Mar 2025) — usable with a tiny fallback; recommend a tenant preference for duration style ("1 h 30 min" / "1:30" / decimal "1,5") because Swedish invoicing uses decimal hours. Area B: the two importers that buy most adoption for small agencies are Trello JSON (free, board-shaped, but no member emails and a 1000-action cap on comments) and Asana CSV (has Assignee Email); add Toggl/Clockify CSV for time history since the timer is the wedge; Jira CSV and Planner Excel are "could". All imports go presigned-upload → R2 → ImportJob rows processed in resumable batches with dry-run and idempotency keys (`sourceSystem:sourceId`). Onboarding: Client → Project-from-template → invite, with templates seeding states/epics/tasks/checklists/visibility flags and designed empty states per surface.

OFFLINE TIMER RECONCILIATION (pseudocode):
client: onTap(kind, workItemId) → ev={clientEventId:uuid7(), kind:START|STOP, workItemId, clientAt:now}; applyOptimistic(ev); idb.outbox.put(ev); flush()
flush(): if online → applyTimerEvents(events, clientNow=Date.now()); on OK remove acked ids; on network error keep; triggers: online, visibilitychange→visible, app start, SW 'sync' (Chromium)
server applyTimerEvents(events, clientNow): skew=serverNow-clientNow; for ev in events ordered by clientAt: if exists(tenantId,clientEventId) → ack (idempotent); eff=ev.clientAt+skew; if kind=START: if |eff-serverNow|>5min → eff=clamp(serverNow-5min..serverNow), review=SKEW_CLAMPED; running=findRunning(member); if running: if running.startedAt>=eff → review=DEVICE_CONFLICT (server wins: close new event as zero-length? no → create closed entry [eff, running.startedAt) if positive else skip, needsReview) else stop running at eff (review=AUTO_STOPPED on that row); insert running row (startedAt=eff, source=TIMER, clientStartedAt=ev.clientAt, skewMs). if kind=STOP: running=findRunning(member); if !running → try match entry by ev.workItemId with stoppedAt IS NULL or last auto-stopped one; if none → ack+ignore w/ audit; if eff<=running.startedAt → review=STOP_BEFORE_START, eff=running.startedAt+1s; if eff>serverNow+5min → eff=serverNow, review=SKEW_CLAMPED; running.stoppedAt=eff; if overlaps another closed entry of same member → truncate to boundary, review=OVERLAP_TRUNCATED. All in withTenant() tx; audit time.entry_started/stopped with source=OFFLINE_QUEUE flag; return {acked[], running, flagged[]}. Never discard time; needsReview surfaced in report.

**Recommendations**
- AREA A tiers — MUST: responsive single-column board with state chips; route-backed item sheet; bottom tabs + thumb-zone timer pill; disable drag on coarse pointers with 'Move to…' sheet; IDB timer outbox with clientEventId idempotency and ±5 min skew rule; battery-aware polling (visibilitychange); duration/week/locale prefs. SHOULD: manifest + install hint; Serwist app-shell SW (webpack build or @serwist/turbopack once out of preview); `experimental.useOffline`; Web Push with VAPID + PushSubscription + preferences; pending/conflict UI. COULD: app badge + Android persistent local notification for running timer; Background Sync registration where supported. SKIP: offline data caching of tenant content, Periodic Background Sync, Notification Triggers, third-party push SaaS (OneSignal/Firebase), swipeable multi-column board on phones, touch drag in v1.
- Timer offline queue: implement as (1) optimistic reducer, (2) IDB outbox via `idb-keyval`, (3) `flushOutbox()` invoked on online/visibilitychange/app start/`sync` event, (4) Server Action `applyTimerEvents(events[], clientNow)` that is idempotent — do this even before any service worker exists; the SW only adds background flush on Chromium.
- Skew rule: server computes skewMs = serverReceivedAt − clientNow (sent with the batch); effectiveAt = clientAt + skewMs; if |effectiveAt − serverReceivedAt| > 5 min for a START, clamp and set needsReview=SKEW_CLAMPED; queued STOPs may be arbitrarily older as long as effective time is after the entry's start. Never reject.
- Push GDPR posture: payload is E2E encrypted by `web-push` (RFC 8291) so Apple/Google/Mozilla push services process only pseudonymous endpoint + timing metadata; list 'browser push services (Apple, Google, Mozilla) — selected by the member's browser, US-based, encrypted payloads' in the sub-processor list; store p256dh/auth encrypted; keep body content-free; document as a member-opt-in feature (each member consents when tapping Enable). Do not use FCM SDK or any push SaaS.
- Service worker + auth: never precache or runtime-cache HTML of authenticated routes; `NetworkOnly` for `/api`, RSC (`?_rsc`), Server Actions (POST); on member/contact logout post a message to the SW to clear runtime caches and clear the IDB outbox; register the SW for the app plane only and exclude /portal from precache.
- Serwist choice: today `@serwist/next` (webpack) is the stable path and Next 16 requires `next build --webpack` for it; `@serwist/turbopack` is preview (esbuild-based). Defer the full SW until Phase 3/5, re-check @serwist/turbopack then; ship manifest + push earlier with a tiny hand-written `public/sw.js` — Next's own guide does exactly this without Serwist.
- Cross-device: on reconcile, server running timer wins; show 'Started on another device' toast; keep local outbox events that predate the server change and let the server truncate overlaps.
- AREA B tiers — MUST: generic CSV engine + mapper, Trello JSON, Asana CSV, presigned R2 upload + resumable ImportJob, dry-run preview, unmatched-assignee handling, first-run wizard, project templates with visibility flags, empty states, duration/week/locale prefs, tenant-owned state names. SHOULD: Toggl/Clockify time import, notification preferences, sample project. COULD: Jira CSV, Planner XLSX, 'save project as template'. SKIP: live API sync with Asana/Jira/Trello (OAuth, rate limits, tokens at rest), attachment file migration (links only), Trello Power-Up data, Jira sprints/story points in v1.
- Import size limits: presigned PUT to R2 (cap 100 MB; large Trello JSON can be 20–50 MB); parse server-side with a streaming CSV parser (`csv-parse`/papaparse), 200-row batches inside a route handler using `after()`; a cron every 5 min re-drives jobs with status RUNNING and stale `updatedAt`>10 min. Store the error report as a FileObject kind=EXPORT for download.
- Assignee mapping policy: match by email (Asana, Toggl, Clockify, Jira if present) → exact Member; Trello/Planner names → suggest fuzzy match, require confirmation; unmatched → 'unassigned' plus keep original name in `WorkItem.importMeta` so it can be shown as 'Was: J. Svensson (Trello)'.
- i18n: use next-intl ICU plurals (`{count, plural, one {# task} other {# tasks}}`; sv has one/other), `useFormatter()` for dates/numbers (sv decimal comma comes free), Intl.DurationFormat short for hm style with a 4-line fallback formatter (`1 h 30 min`), `Intl.Locale.getWeekInfo()` with static fallback, ISO week via date-fns `getISOWeek`, timezone per member with tenant default (Europe/Stockholm).
- Onboarding path (Phase 7 but design now): signup → tenant basics → first client → project from template → invite → import; wizard state stored in TenantPreference `onboardingStep` so it resumes; a dashboard 'Getting started' checklist until 5/5 done.
- Rejected options: OneSignal/Firebase push (US SaaS, unnecessary, payload visible); dnd-kit/react-beautiful-dnd for touch (rbd archived; dnd-kit touch works but adds a second DnD library — revisit only if mobile drag is demanded); full offline data cache (RLS leak risk on shared devices, low value); Periodic Background Sync for timer heartbeat (Chromium-only, engagement-gated); Notification Triggers (abandoned by Chrome); native wrappers (Capacitor) for a lock-screen timer (founder is web-only).

**Open questions**
- Ship Web Push in v1 (Phase 5) or defer to Phase 7? Recommended default: build PushSubscription + web-push in Phase 5 behind an entitlement + TenantPreference toggle, but make email + in-app inbox the guaranteed channels; push is opt-in per member.
- Skew tolerance for offline timer events: ±5 min for START (recommended default) vs looser (±30 min).
- When a queued offline START collides with a server-side auto-stop/other-device START, does the device event or the server win? Recommended default: server state wins for 'running'; the device event becomes a closed entry truncated at the conflicting boundary and flagged needsReview.
- Should mobile ever allow drag? Default: no in v1; revisit with dnd-kit or a custom pointer sensor only if users ask.
- Service worker now or later? Default: manifest + tiny push SW in Phase 5, full Serwist app-shell SW when @serwist/turbopack leaves preview or accept `--webpack` builds.
- Which importers first? Default: Trello JSON + Asana CSV (work items) and Toggl CSV (time); Jira/Planner as presets later.
- Attachments on import: links only (default) vs downloading files into R2 (egress, auth to source, size). Default: links only, with a per-item 'attachments not migrated' note.
- Duration default style per tenant: 'hm' on boards and 'decimal' on reports/invoices (recommended) vs one global style.
- Should tenants be allowed to enable client (Contact) push in the portal? Default: no in v1 — portal stays email-only.
- Sample project on signup: opt-in button (default) vs auto-created.

**Sources**
- [Pragmatic drag and drop — Mobile/Touch Support? (Discussion #93, unanswered; reports from Jul 2024 and Sep 2025)](https://github.com/atlassian/pragmatic-drag-and-drop/discussions/93)
- [Next.js 16.3 local docs — How to build a PWA (manifest.ts, web-push Server Actions, hand-written SW, iOS 16.4+ note, Serwist webpack/turbopack examples)](file:///d:/fortleva/node_modules/next/dist/docs/01-app/02-guides/progressive-web-apps.md)
- [Next.js 16.3 local docs — Handling connectivity drops (experimental.useOffline retries Server Actions and navigations)](file:///d:/fortleva/node_modules/next/dist/docs/01-app/02-guides/offline-support.md)
- [Serwist next-turbo-basic example (uses @serwist/turbopack preview + esbuild)](https://github.com/serwist/serwist/tree/main/examples/next-turbo-basic)
- [Serwist @serwist/next getting started (webpack; separate Turbopack guide)](https://serwist.pages.dev/docs/next/getting-started)
- [LogRocket — Build a Next.js 16 PWA with true offline support (Jan 14 2026; Serwist requires `next build --webpack`)](https://blog.logrocket.com/nextjs-16-pwa-offline-support/)
- [WebKit — Web Push for Web Apps on iOS and iPadOS (16.4; home-screen only, user-gesture permission, Badging API)](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- [MDN — Push API (Baseline widely available since March 2023; Safari iOS 16.4 home-screen only)](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
- [MDN — Background Synchronization API (not Baseline; Chromium only)](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API)
- [MDN — Web Periodic Background Synchronization API (experimental, not Baseline, engagement-gated)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Periodic_Background_Synchronization_API)
- [MDN — Intl.DurationFormat (Baseline 2025 newly available, March 2025)](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DurationFormat)
- [Atlassian — Exporting data from Trello (JSON includes 1000 most recent actions incl. comments; CSV Premium only; no re-import)](https://support.atlassian.com/trello/docs/exporting-data-from-trello/)
- [Fortleva DATA_MODEL.md (conventions for FileObject/Issue reused for ImportJob/PushSubscription drafts)](file:///d:/fortleva/docs/DATA_MODEL.md)


## Search & command-palette data architecture for Fortleva: Postgres FTS (sv+en), trigram, RLS-safe ranking over work items, comments, pages, files, credential metadata; portal-safe search projection

Verdict: build search inside Postgres on Neon, no external engine, and design it around one hard fact most guides miss: under FORCE ROW LEVEL SECURITY the planner will NOT use an index for a user-supplied predicate unless the predicate is leakproof or has the same security level as the policy quals (PG source: restriction_is_securely_promotable() in restrictinfo.c, checked in indxpath.c match_clause_to_index; RLS quals get level 0, WHERE quals get root->qual_security_level). `@@` (ts_match_vq), ILIKE (textlike/texticlike), pg_trgm `%` and array `@>` are not leakproof; only equality/comparison on text/uuid/int/enum and starts_with() are. Consequence: on every RLS'd table the GIN(tsvector) and GIN(trgm) indexes are dead weight; the effective plan is "btree range on (tenant_id[, project_id]) from the policy/scoping quals -> Filter search @@ q". That is fine for agency-sized tenants (<= 20-50k searchable rows) if the tsvector lives in a NARROW row, and it argues for a dedicated narrow `search_index` table (GitLab's issue_search_data pattern) rather than fat source tables. Neon PG18 status verified: pg_trgm 1.6, unaccent 1.1, btree_gin 1.3, fuzzystrmatch 1.2, dict_int, pgvector 0.8.6 available; pg_search/ParadeDB deprecated (PG14-16 only, must migrate before 2026-06-01); rum absent on PG18. PG18 note: generated columns default to VIRTUAL and virtual columns are not indexable — write `GENERATED ALWAYS AS (...) STORED` explicitly. Language: one custom text search configuration `fortleva` = swedish_stem behind an unaccent filtering dictionary (Snowball recognises everything, so two stemmers cannot be chained; dual sv/en columns rejected). Plain text is extracted from Tiptap JSON in the app on write into a `*_text` column (also used for previews/exports), the tsvector is a STORED generated column with setweight(title A, body B, tags/meta C). Read model: a unified `search_index` table (tenant_id, client_id, visibility, project_id, entity_type, entity_id, title, title_norm, search tsvector, updated_at, assignee hints) maintained by DB triggers on the source tables (not app code) so client_id/visibility cannot drift, carrying the identical tenant_isolation + RESTRICTIVE portal_gate policies and the `CLIENT_VISIBLE requires client_id` CHECK. Portal search therefore never sees INTERNAL rows by construction; the residual risk (member-only text columns on client-visible rows) is closed by a modelling rule: internal text is always its own row (comment/note with visibility=INTERNAL), never a column on a client-visible row, enforced by a "forbidden columns in tsvector expressions" DB test. Palette: item-key regex first (exact btree hit), then prefix/substring over the tenant slice with per-type caps; trigram only as a zero-results fallback; pgvector skipped at v1. Latency target <100ms server time is realistic for tenants under ~50k index rows; a documented escape hatch (SECURITY DEFINER search function under a BYPASSRLS owner that restates the GUC predicates verbatim, or per-tenant partition/partial indexes) exists but should not be built until measured p95 exceeds budget.

**Recommendations**
- Do NOT add GIN(tsvector) or gin_trgm_ops indexes on RLS-forced tables at v1 — the planner cannot use them for `@@`/ILIKE/`%` (non-leakproof user quals under RLS); rely on (tenant_id[, project_id], updated_at DESC) btrees and a narrow search_index heap. Also note the existing document (tenant_id, tags) btree_gin index only ever serves the tenant_id key for the same reason.
- Land the search_index table, triggers, `fortleva` TS config and f_unaccent in the SAME migration as WorkItem tables (Phase 2/WM-1) — the generated-column expression and config OID are the one-way-door pieces; everything else is additive.
- Adopt one custom config `fortleva` (unaccent -> swedish_stem) for both indexing and querying; never mix configs between write and read; document that changing it requires the reindex job.
- Extract plain text in the app (extractText) and store it next to the JSON; treat `*_text` columns as the only searchable projection of rich text; forbid indexing JSON columns directly.
- Modelling rule: no member-only free-text column may exist on an entity that can be CLIENT_VISIBLE (put internal notes in a separate row with visibility=INTERNAL); enforce with the forbidden-columns DB test so a single tsvector per row is portal-safe.
- Portal search uses the same table under contact GUCs plus an entity_type allow-list; add the lexeme-probe test to the file-visibility test family and rate-limit portal search per contact.
- Palette query order: (1) key regex exact lookup, (2) UNION ALL per-type capped FTS+prefix, (3) trigram fallback only when 0 hits; debounce 120-150 ms; cap total rows at ~30; server budget 100 ms measured with a synthetic 100k-row tenant on Neon before Phase 3 exit.
- Skip pgvector/semantic search at v1 (Neon has pgvector 0.8.6 and OpenAI/Mistral offer EU residency, but there is no v1 story worth an external processor of client data); keep a `search_index.embedding vector(…)` column out of the schema until needed — it is additive later.
- Keep pg_search/ParadeDB, RUM, Meilisearch/Typesense/Algolia out: pg_search is deprecated on Neon (PG14-16 only, migrate before 2026-06-01), RUM is not on PG18, external engines break the 'no second copy of client data outside Postgres/R2 EU' posture and cost more than the compute they save at this scale.
- Write the escape hatch design (SECURITY DEFINER search function owned by a BYPASSRLS role that restates the tenant/portal predicates from GUCs verbatim, EXECUTE granted to app_runtime, covered by the isolation suite under foreign-tenant and contact GUCs) into OPEN_QUESTIONS.md, gated on measured p95 > 100 ms — do not build speculatively.
- Ship sv/en operator help and Linear-style type prefixes; store recent items client-side first, server table later.
- Add to CI: forbidden-columns test, portal lexeme-probe test, trigger-sync test (flip visibility both ways), cross-tenant search test (foreign tenant GUC returns 0), scoped-member test (member without client:view_all cannot find items in unassigned projects even with exact key).

**Open questions**
- Should the RLS-slowness escape hatch (SECURITY DEFINER search under BYPASSRLS) ever be acceptable given the fail-closed doctrine? Recommended default: no until measured; if needed, prefer per-tenant physical isolation (Tenant.databaseUrl seam) for the outlier tenant over a global RLS bypass.
- Comment visibility semantics for search: does a CLIENT_VISIBLE comment on an INTERNAL item exist? Recommended default: schema CHECK forbids it (comment visibility <= parent visibility), so the index copies comment.visibility directly.
- Should contact-authored portal content (client requests, comments) be searchable by contacts of the same client only or by the authoring contact only? Recommended default: same client (matches Contact profile model), portal_gate already does this.
- Do we index TimeEntry notes at all? Recommended default: yes for members (weight B, entity_type TIME_ENTRY, never portal), because 'what did I do on X' is a common lookup; cost rates never.
- Per-tenant language config (swedish vs english vs finnish later)? Recommended default: single `fortleva` config now; if a non-Nordic tenant appears, add `lang regconfig` column on search_index set from TenantPreference and switch the generated expression to to_tsvector(lang, …) — a rewrite migration, not a redesign.
- Should credential usernames be searchable? Recommended default: yes (member-only, weight B) but excluded from ts_headline snippets and from the portal allow-list; secrets/notes stay encrypted and unindexed.
- Recent items/searches: client-only or server table (Outline stores search_queries)? Recommended default: client-only at v1; add `member_recent_item` table when cross-device recents are requested.
- Search analytics ('zero-result queries')? Recommended default: aggregate counters only in Upstash, no raw query logging (GDPR minimisation).

**Sources**
- [Neon — Supported Postgres extensions (pg_trgm 1.6, unaccent 1.1, btree_gin 1.3, fuzzystrmatch 1.2, pgvector 0.8.6 on PG18, pg_search deprecated, rum not on PG18)](https://neon.com/docs/extensions/pg-extensions)
- [Neon — pg_trgm guide](https://neon.com/docs/extensions/pg_trgm)
- [Neon — tsvector data type guide](https://neon.com/docs/data-types/tsvector)
- [PostgreSQL 18 — Text search dictionaries (filtering dictionaries, snowball must be last)](https://www.postgresql.org/docs/18/textsearch-dictionaries.html)
- [PostgreSQL 18 — Controlling text search (setweight, ts_rank_cd weights/normalization, websearch_to_tsquery, ts_headline, prefix :*)](https://www.postgresql.org/docs/18/textsearch-controls.html)
- [PostgreSQL 18 — Row security policies (policy quals evaluated before user quals; leakproof exception; permissive vs restrictive)](https://www.postgresql.org/docs/18/ddl-rowsecurity.html)
- [PostgreSQL 18 release notes (virtual generated columns default, uuidv7, FTS collation change)](https://www.postgresql.org/docs/18/release-18.html)
- [PostgreSQL source — restrictinfo.c restriction_is_securely_promotable()](https://raw.githubusercontent.com/postgres/postgres/REL_18_STABLE/src/backend/optimizer/util/restrictinfo.c)
- [PostgreSQL source — indxpath.c match_clause_to_index (rejects non-promotable quals as index quals)](https://raw.githubusercontent.com/postgres/postgres/REL_18_STABLE/src/backend/optimizer/path/indxpath.c)
- [PostgreSQL source — initsplan.c (security_level assignment: RLS quals 0.., user quals qual_security_level)](https://raw.githubusercontent.com/postgres/postgres/REL_18_STABLE/src/backend/optimizer/plan/initsplan.c)
- [PostgreSQL source — pg_proc.dat (texteq/starts_with leakproof; textlike not)](https://raw.githubusercontent.com/postgres/postgres/REL_18_STABLE/src/include/catalog/pg_proc.dat)
- [PostgreSQL 18 — Index types (B-tree pattern matching, C locale / text_pattern_ops)](https://www.postgresql.org/docs/18/indexes-types.html)
- [GitLab — PgFullTextSearchable concern (weights, english config, 1MB tsvector cap, prefix queries)](https://gitlab.com/gitlab-org/gitlab/-/raw/master/app/models/concerns/pg_full_text_searchable.rb)
- [GitLab — Issues::SearchData model (issue_search_data side table)](https://gitlab.com/gitlab-org/gitlab/-/raw/master/app/models/issues/search_data.rb)
- [Plane — global search endpoint (icontains per entity, sequence_id regex, per-type caps, membership joins)](https://raw.githubusercontent.com/makeplane/plane/preview/apps/api/plane/app/views/search/base.py)
- [Docmost — search.service.ts (tsv column, to_tsquery + f_unaccent, ts_rank, ts_headline options, space scoping)](https://raw.githubusercontent.com/docmost/docmost/main/apps/server/src/core/search/search.service.ts)
- [Outline — migration adding (teamId, searchVector) btree_gin index (Aug 2026)](https://github.com/outline/outline/blob/main/server/migrations/20260803143858-add-documents-team-search-vector-index.js)
- [Linear docs — Search (operators, ID lookup, ordering, prefixes, 500 cap)](https://linear.app/docs/search)
- [Supabase — Full text search guide (generated tsvector column, setweight, websearch_to_tsquery)](https://supabase.com/docs/guides/database/full-text-search)
- [Prisma — Unsupported database features (generated columns, custom TS configs, triggers via customized migrations)](https://www.prisma.io/docs/orm/prisma-schema/data-model/unsupported-database-features)
- [Prisma issue #6336 — generated columns support (open)](https://github.com/prisma/prisma/issues/6336)
- [OpenAI — data residency (EU region incl. /v1/embeddings, requires ZDR/Modified Retention, eu.api.openai.com)](https://developers.openai.com/api/docs/guides/your-data)


## Time → invoice bridge, retainer/hour-bank ledger, timesheet attachment, multi-currency and accounting export for Fortleva Phase 4 (Swedish AB issuer, SEK/USD clients), informed by Odoo sale_timesheet, Invoice Ninja, Kimai, GitLab, Harvest, Accelo, Everhour, Productive and Swedish law/practice

The strongest OSS reference for the bridge is Odoo sale_timesheet: a timesheet carries a many-to-one `timesheet_invoice_id`, edits to invoiced timesheets are refused ("You cannot modify timesheets that are already invoiced"), a cancelled invoice or a posted credit note UNLINKS the timesheets so they can be re-billed, prepaid hours are simply an ordered quantity on a sales-order line with `remaining_hours = ordered - delivered` and an "upsell" activity when a threshold is crossed (no carry-over/expiry natively), and the customer portal shows the timesheets behind each invoice plus a printable "Timesheets" report. Kimai adds the "exported" flag (never reset on cancel — a pattern to reject), a menu of invoice calculators (per entry / short / user / activity / project / date / week / combinations) and the compliance rule that quantity × rate shown must equal the amount charged. Invoice Ninja rounds destructively at timer stop (reject), resolves rate task→project→client→company, releases tasks when an invoice is deleted, and lets tenants print datelog/timelog on the line. Harvest keeps raw `hours` and preference-rounded `rounded_hours`, distinguishes `is_billed` (marked invoiced, possibly without an invoice) from the invoice link, and exposes `is_locked/locked_reason`. Retainer semantics converge across Accelo (pre/post-paid periods, allowance in hours or value, "rollover unused", "subtract excess from subsequent periods", excess rate, auto-renew, close period), Everhour (recurring resets, thresholds, stop timer at budget, no carry-over) and Productive (positive AND negative rollover, recalculated at period generation or manually, caps unaffected). Swedish side: BFL 5 kap. 7 § requires the verifikation to reference "handlingar som legat till grund för affärshändelsen" and BFL 1 kap. 2 § makes such underlying material räkenskapsinformation (7-year retention) — so an attached tidrapport becomes R1 material once it underpins an issued invoice; ML requires VAT in SEK on foreign-currency invoices only when Swedish VAT is due (not for OUTSIDE_SCOPE US clients), using ECB or Nasdaq OMX Stockholm rate; the Riksbank SWEA API returns SEKUSDPMI publicly. Bokio now offers a free token-based private API (invoices, articles, customers, vouchers, file upload; 5,000 req/month) — cheaper than the Fortnox marketplace route. Recommended v1: HourBank ledger + RetainerPeriod state machine, one-active-binding via `TimeEntry.invoiceLineId` plus an immutable `InvoiceLineTimeEntry` history, per-entry rounding frozen into line quantity, tidrapport PDF/CSV as Document(kind REPORT, R1), CSV accounting export + PDF archive; v1.5 Bokio token connector and optional SIE4; v2 Fortnox.

**Recommendations**
- Adopt Odoo's release semantics, not Kimai's: full credit note or draft deletion releases bound entries automatically (audited); partial credit requires explicit invoice:release_time.
- Store binding as TimeEntry.invoiceLineId (one active) PLUS immutable InvoiceLineTimeEntry rows — Odoo's bare FK loses history after a credit note; agencies need 'this hour was billed on 2026-A-17 then credited'.
- Round per ENTRY by default (Harvest model), freeze into InvoiceLine.quantity and InvoiceLineTimeEntry.billedSeconds; keep raw seconds forever; scope LINE is an opt-in for 'sum then round'.
- Default grouping = one summary line per project per invoice period + attached tidrapport; PER_MEMBER when rates differ (mandatory split key: rate+currency+tax category).
- Hour bank: consumption derived from entries (retainerPeriodId), credits/expiry/carry as ledger rows — avoids double bookkeeping and makes 'recalculate' trivial (Productive's manual recalc).
- Retainer defaults: monthly, carryOver NONE, overage BILL_AT_RATE at project bill rate, deficit BILL_NOW, alerts 80/100 %, portal widget shows hours only.
- Fixed fee: v1 recognises revenue only on invoice (ledger, not accounting); store the enum for later; report effective hourly rate and margin.
- Tidrapport: generate with @react-pdf/renderer in a fra1 route handler at issuance (same job as the invoice PDF), store as Document(kind REPORT, attachedTo INVOICE, retention R1), CSV twin; client-visible only when tenant preference on; the invoice's legalNotes/description references it ('Se bifogad tidrapport') to satisfy BFL 5:7 'var dessa finns tillgängliga'.
- Currency: Project.billingCurrency governs rate cards, budgets, hour packs and invoice currency; time reports never convert; generation splits drafts per currency; always snapshot Riksbank SEKxxxPMI on issue date (fallback ECB, manual override audited) and store SEK totals.
- Accounting export v1 = CSV fakturajournal + line CSV + PDF/tidrapport zip; v1.5 = Bokio private-token connector (free, EU, no review) and optional SIE4 behind entitlement; v2 = Fortnox connector in voucher mode by default (Fortleva stays legal issuer) with an opt-in 'Fortnox issues' mode; correct the docs that call Bokio gatekept.
- Permissions: add time:bill, time:write_off, time:unlock, time:approve, invoice:generate_from_time, invoice:release_time, retainer:manage, retainer:adjust, budget:manage, rate:view, rate:manage, cost_rate:view, export:accounting; portal RLS: RateCard, HourBankTransaction, TimeEntry rate columns unreachable — expose a portal view with hours only.
- DB invariants: trigger blocks UPDATE of durationSeconds/startedAt/stoppedAt/memberId/projectId/billable/billRate on locked entries; InvoiceLineTimeEntry insert-only; HourBankTransaction append-only; RetainerPeriod non-overlap EXCLUDE; issued InvoiceLine immutable (existing); gap-free series (existing).
- Tests to add: billed-lock (update rejected), release-on-credit-note, no-double-binding under concurrent generation (two workers, SKIP LOCKED), rate-snapshot stability after RateCard change, rounding determinism property test (sum of per-entry billed = quantity×3600), hour bank never negative under BLOCK, currency-mix refused, portal JSON contains no rate fields, tidrapport totals == line quantities, CSV/SIE totals == invoice totals.
- Challenge to the founder: do not build revenue recognition or FX gains/losses — that is the accounting tool's job (decision #3); the product's job is a defensible, immutable bridge from seconds to a numbered invoice plus exports.

**Open questions**
- Rounding default: 15-minute UP per entry (common in Swedish consulting) vs 6-minute NEAREST (US legal-style)? Recommended default: 15 min UP per entry, minimum 15 min, overridable per project.
- Overage default rate: project bill rate (recommended) vs a plan-specific 'excess rate' (Accelo)? Recommend field exists, default falls back to bill rate.
- Carry-over default NONE (recommended) — Naxdor's actual contract wording? If contracts say 'roll over one month', use CAPPED(cap = included, expiresAfter=1).
- Should Employees see billable rates? Recommended: no by default (rate:view granted to Manager/CEO/Admin), cost rates CEO/Manager only.
- Lock entries on DRAFT attach (Odoo, recommended) or only at issuance? Recommend draft-lock to prevent double billing between two drafts.
- Fixed-fee revenue recognition: skip in v1 (recommended) or store PRO_RATA_DAYS for the retainer fee report?
- Which entity issues USD invoices — Swedish AB in USD (OUTSIDE_SCOPE, no VAT, '6 kap. 33 § ML / Art. 44' notation) confirmed? Recommend yes; SEK equivalents stored, US entity out of scope.
- FX source: Riksbank SWEA (public, no key) vs ECB reference; recommend Riksbank for SEK books, ECB as fallback, manual override audited.
- Tidrapport client-visible by default? Recommend ON for T&M and retainer projects, OFF for fixed fee; per-project override.
- Approval workflow before billing in v1? Recommend preference off by default; Naxdor is small.
- SIE4 export at all (contradicts decision #3)? Recommend defer, ship CSV; revisit when a tenant's accountant asks.
- Bokio before Fortnox for the connector (token-based, free) — accept reordering PLAN.md v2 integration priority?
- Retainer period anchor: calendar month vs contract start day? Recommend anchorDay configurable, default 1st.
- Timer BLOCK on exhausted hour bank: allow at all? Recommend available but off; ALERT default.
- Should the portal show per-entry time (member names) or only aggregates? Recommend aggregates + tidrapport documents; per-entry live view v2 with member-name masking option.

**Sources**
- [Odoo sale_timesheet account.py (timesheet_invoice_type, invoiced-timesheet write/unlink guards)](https://raw.githubusercontent.com/odoo/odoo/17.0/addons/sale_timesheet/models/account.py)
- [Odoo sale_timesheet account_move.py (link timesheets to invoice; credit note unlinks)](https://raw.githubusercontent.com/odoo/odoo/17.0/addons/sale_timesheet/models/account_move.py)
- [Odoo sale_timesheet account_move_reversal.py](https://raw.githubusercontent.com/odoo/odoo/17.0/addons/sale_timesheet/models/account_move_reversal.py)
- [Odoo sale_timesheet sale_order.py (remaining_hours, upsell threshold, qty_delivered from timesheets)](https://raw.githubusercontent.com/odoo/odoo/17.0/addons/sale_timesheet/models/sale_order.py)
- [Odoo sale_timesheet portal controller (timesheets under invoices in customer portal)](https://raw.githubusercontent.com/odoo/odoo/17.0/addons/sale_timesheet/controllers/portal.py)
- [Odoo docs: Invoice based on time and materials](https://www.odoo.com/documentation/18.0/applications/sales/sales/invoicing/time_materials.html)
- [Invoice Ninja user guide: Tasks](https://invoiceninja.github.io/docs/user-guide/tasks)
- [Invoice Ninja user guide: Basic settings (Task Settings)](https://invoiceninja.github.io/docs/user-guide/basic-settings)
- [Invoice Ninja CompanySettings.php (task_round_up, task_round_to_nearest, lock_invoices)](https://raw.githubusercontent.com/invoiceninja/invoiceninja/v5-stable/app/DataMapper/CompanySettings.php)
- [Invoice Ninja TaskRepository.php roundTimeLog()](https://raw.githubusercontent.com/invoiceninja/invoiceninja/v5-stable/app/Repositories/TaskRepository.php)
- [Invoice Ninja Task.php getRate() hierarchy](https://raw.githubusercontent.com/invoiceninja/invoiceninja/v5-stable/app/Models/Task.php)
- [Kimai docs: Invoices (export flag, cancel does not reset)](https://www.kimai.org/documentation/invoices.html)
- [Kimai docs: Rounding](https://www.kimai.org/documentation/rounding.html)
- [Kimai invoice calculators (source)](https://github.com/kimai/kimai/tree/main/src/Invoice/Calculator)
- [GitLab docs: Time tracking](https://docs.gitlab.com/user/project/time_tracking/)
- [Harvest API v2: Time entries (rounded_hours, is_billed, is_locked)](https://help.getharvest.com/api-v2/timesheets-api/timesheets/time-entries/)
- [Accelo help: Add a retainer (pre/post-paid, rollover, excess rate)](https://help.accelo.com/guides/user/modules/retainers/add-a-retainer/)
- [Accelo help: Retainers module](https://help.accelo.com/guides/user/modules/retainers/)
- [Everhour: Project budgeting](https://everhour.com/project-budgeting)
- [Productive help: Retainer hours rollover](https://help.productive.io/en/articles/9902502-retainer-hours-rollover)
- [Productive help: Fixed price budget type](https://help.productive.io/en/articles/9128621-simple-editor-fixed-price-budget-type-explained)
- [Skatteverket: Momslagens regler om fakturering](https://www.skatteverket.se/foretag/moms/saljavarorochtjanster/momslagensregleromfakturering.4.58d555751259e4d66168000403.html)
- [Bokföringslagen (1999:1078) — lagen.nu (1 kap. 2 §, 5 kap. 7 §, 7 kap. 2 §)](https://lagen.nu/1999:1078)
- [Riksbank SWEA API (SEKUSDPMI observations)](https://developer.api.riksbank.se/api-details#api=swea-api)
- [Fortnox developer: pricing models](https://www.fortnox.se/developer/guides-and-good-to-know/pricing-models)
- [Fortnox API reference (invoices, vouchers)](https://apps.fortnox.se/apidocs)
- [Fortnox developer: rate limits](https://www.fortnox.se/developer/guides-and-good-to-know/rate-limits-for-fortnox-api)
- [Bokio hjälp: Automatisera bokföringen i Bokio med API](https://www.bokio.se/hjalp/integrationer/bokio-api/automatisera-bokforingen-i-bokio-med-api-sa-gor-du/)
- [Bokio API reference](https://docs.bokio.se/)

