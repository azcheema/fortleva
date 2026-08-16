# UI.md — Interface conventions

**Status:** Normative conventions, created 2026-08-16 (work-management plan, Step 0). Applies to every screen from Phase 1b onward; retro-applied to the six Phase-1 pages during 1b.
**Companion docs:** `PLAN.md` (phase bodies name the screens), `ARCHITECTURE.md` (ARC-15 UI kit, ARC-17 DnD, ARC-18 freshness, ARC-19 rich text), `AUTHZ.md` (what a screen may show is a permission question, never a UI one), `TENANCY.md` §7.2 (portal projections), `DATA_MODEL.md` (vocabulary).
**Evidence:** `docs/research/2026-08-16-work-management-synthesis.md` §5 (complaint corpora → UX rules), `…-plan-draft-ux-product.md`, `…-reviews.md`.

This document is the **source of truth for how Fortleva looks and behaves**. A build session follows it verbatim; deviations are amendments here, dated, not local exceptions. Where a rule conflicts with a data-layer rule (visibility, scoping, permissions), the data layer wins and the UI conforms.

Vocabulary is law (DATA_MODEL §1): **Tenant, Member, Client, Contact, Platform**. A `WorkItem` is called a **"Task"** in the UI; levels are **Epic → Task → Subtask**. Never "issue", "ticket", "card", "story" in user-facing strings.

---

## 1. Purpose and scope

- **Covers:** the 15 UX rules, information architecture (member app, mobile, portal), the shared component vocabulary, the keyboard map, drag-and-drop and optimistic-update rules, i18n and formatting, accessibility, density and visual language, portal-specific rules, and the deliberate omissions.
- **Does not cover:** what a principal may *see* (AUTHZ/TENANCY), schema (DATA_MODEL), copy per locale (`messages/{sv,en}.json`).
- **Enforcement:** each rule names its tripwire — an ESLint rule, a component contract, an E2E test, or a review checklist item in PLAN §2 (definition of done). Rules without a tripwire are review items.

---

## 2. The fifteen UX rules (normative)

| # | Rule | Concretely | Tripwire |
|---|---|---|---|
| 1 | **Latency is a feature.** | Every mutation is optimistic (§7). Navigation to an item is a side-peek (`?item=ACME-12`), not a page load. Perceived < 100 ms on board drag, < 50 ms on inline property change. No modal for create. | E2E: drag reflow before server round-trip; lint: no `<Dialog>` in a `create*` component |
| 2 | **Title-only creation.** | `C` anywhere, `+` in any list/column. One text field, Enter creates and focuses the next; `⌘⇧Enter` create-another with the same properties; `⌘Enter` create-and-open. Defaults come from context (column ⇒ state, group ⇒ assignee/epic, project ⇒ visibility). | E2E: keyboard-only create; review: create form has one required field |
| 3 | **Inline edit everything.** | Every property is a `<PropertyPicker>` popover (§5.2). Single keys `S A L P E D V M T X` on a focused item. **No Save buttons anywhere** — a change is committed on select/blur, undoable via toast. | Lint: no button whose label key ends in `.save` outside `/settings/*` and auth pages |
| 4 | **Drag with a keyboard twin.** | Desktop: Pragmatic DnD, drop indicator + auto-scroll. Keyboard/mobile: "Move to…" (menu, palette, long-press sheet). `rank` never rendered. | E2E: keyboard-only move; grep: `rank` absent from any client component's JSX |
| 5 | **One board per project; columns are states; position is priority.** | No swimlane settings, no per-team boards, no board-only fields. Group-by (assignee/epic/priority/label) is a *display* transform of the same view. Portal never sees state names, only categories. | Review; portal forbidden-columns grep (state names) |
| 6 | **One universal `<WorkItemView>`.** | Home, backlog, board, project list, portal task list are the same component with different config (§5.3). URL-addressable via `nuqs`. No `SavedView` table in v1. | Import graph: no second list/board implementation |
| 7 | **⌘K first, single keys second, shortcuts shown everywhere.** | Every action reachable from the palette. Tooltips carry the key. `?` opens the overlay. Palette rows show their key. | Review: new action ⇒ palette entry + tooltip key |
| 8 | **Home is the home page.** | `/home` = assigned (overdue / today / next 7 d), waiting on client, triage count, inbox top-5, timer slot, this-week hours (own). Post-login lands here; `/dashboard` is only the workspace picker for > 1 membership. | E2E: login → `/home` |
| 9 | **The timer is a personal tool.** | Pill on every page; one tap to stop; starting another auto-stops the running one with an undo toast; 8 h nudge, 12 h auto-stop → needs review; `1h 30m` / `90m` / `1,5` accepted; raw seconds preserved. Never shown to peers. | 2T tests (PLAN §3) |
| 10 | **Visibility is loud, explicit, inherited, previewable.** | Two-token badge on every class-B row; composer asks on create in portal-enabled projects; children default from parent and cannot exceed it; two-mode comment composer; "View as client" banner; warning when mentioning/assigning a Contact on an INTERNAL item. | "No INTERNAL fact to a Contact" fixtures; view-as byte-identity test |
| 11 | **Progress = human health + machine numbers.** | `ProjectUpdate.health` chosen by a person, metrics filled by the system; immutable after publish; client sees one screen + an action-items inbox. | Update immutability trigger test |
| 12 | **Digest, not firehose; explicit over silent.** | Only assignment (debounced) and mention email instantly; everything else coalesces/digests. Archive is a visible action with restore; filter chips always visible; locked entries say why; rate changes ask "from today / from date / all unbilled". | Kind-catalog audience test; review |
| 13 | **Opinionated defaults with escape hatches.** | 5 priorities, ~5 states from a preset, hours as estimate unit, single assignee, depth ≤ 3. The only "process" choice is a project template. | Review; no settings page for card styles / process |
| 14 | **Cost is sensitive.** | Employee: own hours. Manager: hours + bill rates + budgets. Finance: cost + margin behind ✦ step-up. Nothing per-member in the portal. No presence, activity, or leaderboard UI anywhere (never-list, SECURITY.md). | Forbidden-columns grep; CSV default omits cost |
| 15 | **Empty states have a verb; density compact; every entity has a chip; destructive actions confirm inline; mobile is bottom tabs.** | See §5.7–5.9, §11, §4. | Review |

---

## 3. Information architecture — member app

### 3.1 Left rail (desktop) — fixed order, no reordering, module-gated items hidden (not disabled) when the entitlement/preference is off

| Rail item | Route | Notes |
|---|---|---|
| Home | `/home` | Rule 8. |
| Clients | `/clients`, `/clients/[id]` | Tabs: Overview · Projects · Contacts · Files · Vault (3V) · Assets (3V). |
| Projects | `/projects` (grouped by client), `/projects/[key]/…` | Tabs in this order: **Board · Backlog · Timeline · Updates · Time · Files · Team · Portal**. Board/Backlog need `work`; Time needs `time` (the finance-gated **Money** page `/projects/[key]/money` lives under the Time tab as a sub-view, shown only with `rate:view_bill`/`rate:view_cost` — `PLAN.md` Phase 2T); Updates/Portal appear in Phase 3; a tab the actor lacks permission for is hidden. |
| Time | `/time` (My Time), `/time/team` (`time:view_team`) | `time` module. |
| Inbox | `/inbox` | Core; unread badge. |
| Vault | `/vault`, `/expirations` | `vault` module. |
| Reports | `/reports` | Phase 6. |
| Settings | `/settings/{general,members,roles,preferences,export,labels,templates,workflow-presets,rates,time,notifications}` | Only pages the actor can act on. |

Rail collapses to icons < 1280 px; project tabs become a horizontal scroller. `/projects/[key]` redirects to Board when `work` is on, else Timeline.

### 3.2 Global chrome (every authed member page)

- **⌘K palette** (`cmdk`): recents → `KEY-123` jump → per-type capped search (tasks, projects, clients, files, credentials by name) → actions ("Start timer on…", "Move to…", "New task in…"). Never returns a row the actor could not open.
- **Timer pill** (2T): header slot, desktop right of breadcrumb; mobile above tabs. Shows task title, elapsed with skew-corrected local tick, stop button; click → jump to the item.
- **`?` overlay**: the keymap of §6, filtered to the current scope.
- **`C`** creates a task in the current context (project if inside one, else asks project first via picker).
- Toasts (`sonner`) bottom-right desktop, top mobile; every toast with an undo path has one.

### 3.3 Mobile (< 768 px)

Bottom tabs **Home / Board / Timer / Inbox / More**. Board is a single-column list grouped by state with state chips (tap chip → "Move to…" sheet). No touch drag (ARC-17). `More` = rail items not in tabs. Long-press on any task = action sheet (state, assignee, timer, visibility). Web Push opt-in arrives Phase 5.

---

## 4. Information architecture — portal

- `/portal` = **Action items first** (approvals pending, tasks assigned to you, questions awaiting reply, credential submission requests), **then project cards** (name, health chip, next milestone, last update age). Only projects with `portalEnabled` and the contact's client.
- `/portal/projects/[key]` = **one screen, this exact order** (PLAN §3 Phase 3):
  1. Header — project name, health chip, "Phase: Design · Next milestone: Launch due 12 Sep", milestone progress bar.
  2. Action items for this project.
  3. Latest published update.
  4. Timeline (derived: updates, milestone dues/completions, version ships/approvals, deliverable versions, approval decisions).
  5. Shared tasks grouped by **category** (only if the project enables the task list; no estimates, priorities, state names, assignee names).
  6. Files & deliverables (approve / request changes).
  7. Hours & retainer (only when `hoursSharingMode ≠ NONE`, CONTACT_PRIMARY only).
  8. Requests (create + own list with category status).
- `/portal/files`, `/portal/company`, `/portal/share/[token]` (3V), `/portal/projects/[key]/submit-credential` (3V).
- No portal left rail, no tabs, no board unless the project enables it (default off), no settings beyond profile/notification email toggles.
- Exhaustive contact actions: view; approve / request changes; complete an own-assigned task; comment (forced CLIENT_VISIBLE); create a request; download; submit a credential; open a share link. **Nothing else** — a portal screen with another button is a bug.

---

## 5. Component vocabulary (`src/components/ui` primitives + `src/components/*` composites)

### 5.1 `<EntityChip>`
One chip component for Member, Contact, Client, Project, Task (`ACME-12`), Milestone, Label, ProjectVersion, Document. Avatar/icon + name + optional secondary; hover card with the entity's summary; click = side-peek or navigate. Contact chips in the member app carry a small "client" glyph. In the portal, member chips are never rendered (v1) — the composite refuses to render `Member` when the principal is a Contact.

### 5.2 `<PropertyPicker>`
Popover with type-ahead list; single key opens it when the item is focused; Esc closes without change; Enter/click commits (optimistic). Keys and pickers:

| Key | Property | Picker | Notes |
|---|---|---|---|
| `S` | State | states of the project grouped by category | shows category dot; TRIAGE hidden unless item is in triage |
| `A` | Assignee | members in scope, then contacts (portal-enabled projects only) | choosing a contact warns if item is INTERNAL and offers to make it CLIENT_VISIBLE |
| `L` | Labels | tenant labels, multi | internal-only |
| `P` | Priority | NONE LOW MEDIUM HIGH URGENT | |
| `E` | Estimate | text `2h`, `1,5`, `90m` → minutes | |
| `D` | Due date | calendar, ISO week Monday-first, `today/tomorrow/next week` tokens | |
| `V` | Visibility | two tokens (§5.5) | refuses INTERNAL when a child is CLIENT_VISIBLE; explains |
| `M` | Milestone | project milestones by rank | |
| `T` | Timer | start/stop on this item | 2T |
| `X` | Select | toggles multi-select for the bulk bar | |

### 5.3 `<WorkItemView>`
Config: `{ filters, groupBy, orderBy, layout: 'LIST' | 'BOARD', display: { estimate, labels, key, checklist, assignee, dueDate, timer } }`. Filter chips are always visible above the view (Planner's hidden filters are a top complaint); URL state via `nuqs` (`?state=…&assignee=…&group=…&layout=board`), so every view is a link. Virtualised at ~200 rows. Bulk bar appears on `X`/checkbox. The portal instance is the same component with a fixed config and a Contact principal — it renders category chips, never state names.

### 5.4 Side-peek `?item=KEY-123`
Item opens as a right panel over the current view; `⌘↵`/full-screen icon → `/projects/[key]/items/[number]`. Back closes the peek. Panel: title, properties rail, Tiptap description (checklist nodes, paste-upload), subtasks, attachments, comments, Activity tab.

### 5.5 Visibility badge — two tokens only
`Private to team` (neutral) / `Client can see` (accent). Every class-B row shows one; never a third wording, never an icon alone. Inheritance tooltip: "Follows ACME-12". Bulk change shows the count: "Make 14 tasks private?".

### 5.6 Comment composer — two modes
Toggle "Internal note" (default, neutral) / "Reply to client" (distinct colour, border). Mode maps 1:1 to visibility; contact-authored comments have no toggle. Mentioning a Contact in an internal note warns inline. `⌘Enter` posts.

### 5.7 Step-up dialog
One `<StepUpDialog>` reused for every ✦ action (role edit, cost reveal, credential reveal/share/export/visibility, member removal…). TOTP field, "why" line, `vault.stepUpMinutes` explained. Never a custom MFA prompt elsewhere.

### 5.8 Empty state
One verb + one sentence + one primary action, e.g. "**Create** the first task — press C or click +". No illustrations larger than the text. Onboarding checklists are skippable and dismissible for good.

### 5.9 Inline confirm
Destructive actions (delete, archive-with-children, lock, revoke) confirm **in place**: the button becomes "Delete? Yes / No" or a popover with the count; no modal. Undo toast where reversible.

### 5.10 No Save buttons
Forms outside `/settings/*` and auth do not have Save; settings forms auto-save per field with a saved-tick and undo. Rule 3 tripwire.

---

## 6. Keyboard map (registry: `react-hotkeys-hook` scopes `global`, `item`, `inbox`, `triage`; shown in `?` and tooltips)

| Scope | Key | Action |
|---|---|---|
| global | `C` | New task (title-only) in context |
| global | `⌘K` | Palette |
| global | `?` | Keymap overlay |
| global | `G H` · `G P` · `G B` · `G L` · `G T` · `G I` · `G V` | Go to Home · Projects · Board (current project) · Backlog · Time · Inbox · Vault |
| global | `T` | Start/stop timer on focused item, else open timer pill |
| global | `N` | New time entry (2T; on `/time` and item) |
| global | `Esc` | Close peek/picker/palette |
| item | `S A L P E D V M X` | §5.2 |
| item | `⌘⇧O` | Convert focused checklist item → subtask |
| item | `⌘Enter` | Create-and-open (in create field) |
| item | `⌘⇧Enter` | Create-another with same properties |
| item | `⌘Enter` (composer) | Post comment |
| item | `↑ ↓` / `J K` | Move focus in list/column; `← →` across columns |
| inbox | `J K` · `E` · `U` · `S` | Next/prev · archive · mark unread · snooze |
| triage | `A` · `D` · `U` · `S` | Accept · Decline · Duplicate-of… · Snooze |

Rules: single keys are inert while an input has focus; `⌘` = `Ctrl` on Windows/Linux and the overlay renders the right glyph; no key is bound that a browser or screen reader needs (`⌘L`, `⌘F`, `Tab`).

---

## 7. Interaction rules

### 7.1 Drag and drop (ARC-17)
- Desktop only, `@atlaskit/pragmatic-drag-and-drop`. Drop indicator line between cards, edge auto-scroll, dragged card ghost at reduced opacity, column highlights on hover.
- Board drop = state change + rank change in one Server Action; backlog drop = rank change; group-by view drop = property change + rank.
- Keyboard/mobile twin: "Move to…" (`⌘K` action, item menu, mobile long-press) → picker of state/position ("Top of To do", "After ACME-9", "Bottom").
- Rank is server-computed (fractional-indexing, neighbours locked). The client sends `{ itemId, stateId?, beforeId?, afterId? }`, never a rank string; rank never appears in the DOM.
- Multi-select drag moves the selection preserving relative order.

### 7.2 Optimistic updates (ARC-18)
- Pattern: `useOptimistic` for the affected slice → Server Action → `router.refresh()`; on error, revert and show a toast with the server reason (i18n key) and Undo/Retry when applicable.
- Every mutation returns the canonical row(s) so the optimistic state is replaced, not merged.
- Freshness: version poll every 12 s while visible + refresh on window focus; no WebSockets/sync engine in v1. A stale-conflict (row `updatedAt` newer than the client saw) reverts with "Updated by <chip> — refreshed".
- Never block the UI on audit/notify side effects — they are inside the same tx server-side (TENANCY recipe), invisible to the client.

### 7.3 Navigation
- Side-peek is default; full page only by explicit action or direct link. Browser back closes the peek. Filters live in the URL, so back/forward restores views.
- 404 (not 403) for anything out of scope, portal or member — the page must not reveal existence.

---

## 8. i18n and formatting

- Languages: **sv + en** from Phase 1b (`next-intl`); locale resolution member → `Tenant.defaultLocale` → Accept-Language → en. Portal locale = contact preference → tenant default.
- **No literal user-facing strings in JSX** (`src/app`, `src/components`) — ESLint rule; keys `<area>.<screen>.<element>`.
- **State categories are translated** (`Planned / In progress / Done` in the portal; the six category labels internally); **state names are tenant data** and rendered verbatim, never translated. Same for label names, project names, milestone names.
- Dates: `date-fns` 4 + `@date-fns/tz`; rendered in the member's timezone (`Member.timezone`), tenant TZ for contacts. **ISO week, Monday-first**, week numbers shown when `showIsoWeek`.
- Numbers: sv uses **decimal comma** and space thousands (`1 200,50 kr`); en uses `.`; input accepts both (`1,5` and `1.5` → 90 min).
- Duration style is a tenant preference `time.durationStyle {hm, clock, decimal}` — `1 h 30 m` · `1:30` · `1,50 h`; the same `<Duration>` component everywhere; raw seconds never rounded for display beyond the minute (2T), rounding only at invoice (Phase 4).
- Currency from `Project.billingCurrency`; never mixed in one total.
- Relative time ("2 h ago") only for activity/inbox; absolute elsewhere.

---

## 9. Accessibility

- Every drag has a keyboard twin (§7.1); every single-key action is also a menu item.
- Visible focus ring on all interactive elements (`focus-visible`), never `outline: none` without a replacement.
- Pickers: `role="listbox"`/`combobox`, `aria-activedescendant`, announced selection; badges carry text, not only colour (rule 10 two-token wording is the aria label).
- Colour never the sole carrier: priority dot + label on hover/tooltip, health chip + text.
- `prefers-reduced-motion`: no drag ghost animation, no toast slide, instant peek.
- Minimum tap target 40 px on mobile; contrast AA on the neutral palette.

---

## 10. Density and visual language (ARC-15)

- **Compact by default.** 13–14 px body, 32 px rows in lists, 8 px grid, no card shadows in lists (borders only).
- Palette matches the current pages: `rounded border border-neutral-200` surfaces, `bg-neutral-900 text-white` primary button, `text-neutral-600` secondary text, one accent for "Client can see" and one for danger. shadcn/ui **neutral** preset (CP1 default) generated for Tailwind 4 + React 19 on Radix.
- Typography: **self-hosted Inter** (`next/font/local`) or the system stack; no CDN fonts (EU-neutral, self-host bias).
- Icons: `lucide-react`; one icon per concept, reused (Task, Epic, Subtask, Milestone, Client, Contact, Vault, Timer, Private, Client-visible).
- Colours for state **categories** are fixed (grey/blue/yellow/green/red/purple for BACKLOG/TODO/IN_PROGRESS/DONE/CANCELLED/TRIAGE); tenants name states, not colours.
- Charts (Phase 6): Recharts 3, fixed set, palette from the same tokens.
- Dark mode: tokens prepared, shipped when cheap; never a blocker.

---

## 11. Portal-specific rules

| Never shown to a Contact | Shown to a Contact |
|---|---|
| State names, estimates, priorities, labels, links, member names / avatars (v1), rates, cost, per-member time, INTERNAL activity, internal notes, repo/hosting fields, unpublished updates | Categories (Planned / In progress / Done), milestones + progress bar, published updates with health, timeline, files & deliverables, action items, own requests, hours summary (opt-in, PRIMARY only) |

- No board unless the project enables it; then it is the same `<WorkItemView>` with category columns and no drag.
- Portal reads use only `modules/*/portal.ts` projections; **View-as-Contact** in the member app renders through the very same functions (banner "Viewing as <contact> — you see exactly what they see").
- Portal chrome is minimal: tenant name/logo, project switcher, profile menu. No ⌘K, no keymap, no timer.
- Copy is written for a business reader: no "backlog", "triage", "epic" — say "Requested", "In progress", "Phase".
- Every portal write is one of the eight actions in §4; the UI offers nothing else.

---

## 12. What we deliberately don't do (UI)

- Modals for creating tasks, time entries, or comments; wizard flows for everyday work.
- Save buttons; unsaved-changes prompts.
- Hidden or implicit filters; "smart" views the user cannot see the definition of.
- Silent archive/disappearance (ADO 183-day style); every archive is an explicit, reversible action with a "show older" path.
- Dashboard/report builders, card style rules, per-team board settings, swimlane editors, custom column fields.
- Presence indicators, "who is online", activity feeds of colleagues, leaderboards, heatmaps, per-minute timelines — the never-list (SECURITY.md).
- Multi-assignee pickers, sprint pickers by default, story points by default.
- Portal features that require learning: no kanban by default, no state names, no filters beyond "open / done", no public links.
- A second implementation of any list, board, comment thread, attachment list, notification list, or search box.
