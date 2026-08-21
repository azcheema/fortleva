# UI.md — Interface conventions

**Status:** Normative conventions, created 2026-08-16 (work-management plan, Step 0). Applies to every screen from Phase 1b onward; retro-applied to the six Phase-1 pages during 1b.
**Amended 2026-08-17** — §9 and §10 rewritten as the normative visual system: tokens, type scale, spacing, radii, elevation, motion, the semantic colour map for every enum, the entity-colour algorithm, the component catalogue, dark-mode rules, the accessibility checklist, and the rule that new UI uses tokens and components only (with grep tripwires as enforcement).
**Amended again 2026-08-17 (set B + reconciliation)** — the project tree, files, members, settings and account screens landed, and the whole app was then reconciled against this document: §10.10 gains `Timeline`, `ProgressMeter` and `EntityTile`; §10.15 is new and records the six recurring screen patterns every route must now use; §10.4 gains the row-cue token; §10.14 records the set-B contrast rows. Three tokens moved as a result of that audit and are noted where they live.
**Amended 2026-08-17 (release gate)** — §10.14 now requires the browser visual sweep (`e2e/visual.spec.ts`, `RUNBOOK.md` §7) for every visual change: the contrast table proves the palette, only the sweep proves the pages.
**Amended 2026-08-17 (craft refinement)** — the app was functional and consistent and still did not read as a product, for three reasons the founder named: every editable row rendered an always-visible input, so pages that are content looked like data entry; a solid red `Delete` was repeated on every row of every table; and the raw OS file input showed inside the upload target. Three patterns fix all three and are **normative from this date**: §5.11 `InlineEdit` (a value is text until you edit it), §5.12 `RowActions` (the row's verbs live in a `⋯` menu, and destructive weight is spent only on the confirm's "Yes"), §5.13 `FileDropField` (the native input is `sr-only`, never `hidden`). §5.14 adds the one disclosure and §5.15 the whole-page state. §10.15 grows from six recurring patterns to nine, §10.13 gains four tripwires, and §10.14 folds the craft audit (`e2e/audit.ts`) into the gate so none of the three can regress silently.
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
| 3 | **Inline edit everything.** | A record property is an `<InlineEdit>` (§5.11) — text at rest, the real control on click / Enter / F2; a *work-item* property is the `<PropertyPicker>` popover (§5.2, Phase 2) with single keys `S A L P E D V M T X`. **No Save buttons anywhere** — a change is committed on select/blur, undoable via toast. An always-mounted input for a value nobody is editing is the defect this rule exists to prevent. | Lint: no button whose label key ends in `.save` outside `/settings/*` and auth pages; audit: no visible input inside a resting table row |
| 4 | **Drag with a keyboard twin.** | Desktop: Pragmatic DnD, drop indicator + auto-scroll. Keyboard/mobile: "Move to…" (menu, palette, long-press sheet). `rank` never rendered. | E2E: keyboard-only move; grep: `rank` absent from any client component's JSX |
| 5 | **One board per project; columns are states; position is priority.** | No swimlane settings, no per-team boards, no board-only fields. Group-by (assignee/epic/priority/label) is a *display* transform of the same view. Portal never sees state names, only categories. | Review; portal forbidden-columns grep (state names) |
| 6 | **One universal `<WorkItemView>`.** | Home, backlog, board, project list, portal task list are the same component with different config (§5.3). URL-addressable via `nuqs`. No `SavedView` table in v1. | Import graph: no second list/board implementation |
| 7 | **⌘K first, single keys second, shortcuts shown everywhere.** | Every action reachable from the palette. Tooltips carry the key. `?` opens the overlay. Palette rows show their key. | Review: new action ⇒ palette entry + tooltip key |
| 8 | **Home is the home page.** | `/home` = assigned (overdue / today / next 7 d), waiting on client, triage count, inbox top-5, timer slot, this-week hours (own). Post-login lands here; `/dashboard` is only the workspace picker for > 1 membership. | E2E: login → `/home` |
| 9 | **The timer is a personal tool.** | Pill on every page; one tap to stop; starting another auto-stops the running one with an undo toast; 8 h nudge, 12 h auto-stop → needs review; `1h 30m` / `90m` / `1,5` accepted; raw seconds preserved. Never shown to peers. *Amended 2026-08-20 (industry sweep):* the pill quick-start takes a bare description (= instant task, non-billable until a project is attached) with `@project` / `#task` autocomplete; a recents dropdown offers **one-click continue** (copies task/project/agreement/type/billable — the category's most-loved interaction); a global start/stop shortcut exists (palette-discoverable, rule 7); elapsed time ticks in the **browser tab title**; **copy-last-week copies rows, never hours** ("copy with durations" is the explicit secondary action); overlapping entries are **allowed and badge-flagged, never blocked** (strict blocking is the tenant opt-in); shift clock-in/out + breaks live on `/time` and in the pill menu — a break auto-stops the running timer (undo), auto-closed shifts are visibly provisional until confirmed. | 2T tests (PLAN §3) |
| 10 | **Visibility is loud, explicit, inherited, previewable.** | Two-token badge on every class-B row; composer asks on create in portal-enabled projects; children default from parent and cannot exceed it; two-mode comment composer; "View as client" banner; warning when mentioning/assigning a Contact on an INTERNAL item. | "No INTERNAL fact to a Contact" fixtures; view-as byte-identity test |
| 11 | **Progress = human health + machine numbers.** | `ProjectUpdate.health` chosen by a person, metrics filled by the system; immutable after publish; client sees one screen + an action-items inbox. | Update immutability trigger test |
| 12 | **Digest, not firehose; explicit over silent.** | Only assignment (debounced) and mention email instantly; everything else coalesces/digests. Archive is a visible action with restore; filter chips always visible; locked entries say why (*2026-08-20:* grey + lock icon + tooltip naming the `lockedReason`; unlock is an explicit admin action that never mutates the issued invoice); rate changes ask "from today / from date / all unbilled" and always state "past entries unchanged; use Reprice to correct history". | Kind-catalog audience test; review |
| 13 | **Opinionated defaults with escape hatches.** | 5 priorities, ~5 states from a preset, hours as estimate unit, single assignee, depth ≤ 3. The only "process" choice is a project template. | Review; no settings page for card styles / process |
| 14 | **Cost is sensitive.** | Employee: own hours. Manager: hours + bill rates + budgets. Finance: cost + margin behind ✦ step-up. Nothing per-member in the portal. No presence, activity, or leaderboard UI anywhere (never-list, SECURITY.md). *2026-08-20:* team time surfaces aggregate **closed** shifts/entries only for members other than the viewer — no live clock state, no on-shift indicator; the agreement picker shows names, never rates, without `rate:view_bill`. | Forbidden-columns grep; CSV default omits cost |
| 15 | **Empty states have a verb; density compact; every entity has a chip; destructive actions confirm inline; mobile is bottom tabs.** | See §5.7–5.9, §11, §4. | Review |

---

## 3. Information architecture — member app

### 3.1 Left rail (desktop) — fixed order, no reordering, module-gated items hidden (not disabled) when the entitlement/preference is off

| Rail item | Route | Notes |
|---|---|---|
| Home | `/home` | Rule 8. |
| Clients | `/clients`, `/clients/[id]` | Tabs: Overview · Projects · Contacts · Files · Agreements (2T — *added 2026-08-20*: `Service` rows presented as "Agreements"/"Avtal", their rate cards, and a consumption strip "X h this period"; rates masked without `rate:view_bill`) · Vault (3V) · Assets (3V). |
| Projects | `/projects` (grouped by client), `/projects/[key]/…` | Tabs in this order: **Board · Backlog · Timeline · Updates · Time · Files · Team · Portal**. Board/Backlog need `work`; Time needs `time` (the finance-gated **Money** page `/projects/[key]/money` lives under the Time tab as a sub-view, shown only with `rate:view_bill`/`rate:view_cost` — `PLAN.md` Phase 2T; *2026-08-20:* the **Reports** sub-view `/projects/[key]/time/reports` — `TimeReport` list · composer with period/grouping/amounts · preview · publish with the two-token visibility badge — also lives under Time, `time_report:manage`); Updates/Portal appear in Phase 3; a tab the actor lacks permission for is hidden. |
| Time | `/time` (My Time), `/time/team` (`time:view_team`) | `time` module. *2026-08-20:* `/time` = today (clock in/out + breaks when `time.shiftsEnabled`, the **day reconciliation strip** shift − breaks − tracked = unallocated, continue-on-every-row) + the ISO week grid (`ui.weekStart`, copy-last-week rows-only) + needs-review banner (provisional auto-closed shifts, one-click fix) + overlap / missed-rast warn badges + the member's own **working-time statement** (month picker, CSV + print). `/time/team` = per-member closed-day totals by project/agreement/type over a range, Δ vs `Member.hoursPerDay`, warn-flag filters, statement export per member. |
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

Bottom tabs **Home / Board / Timer / Inbox / More**. Board is a single-column list grouped by state with state chips (tap chip → "Move to…" sheet). No touch drag (ARC-17). `More` = rail items not in tabs. Long-press on any task = action sheet (state, assignee, timer, visibility). Web Push opt-in arrives Phase 5. *(2026-08-20, decision 15 / ARC-25)* **Installable from 2T:** the member app ships a manifest (`display: standalone`, `start_url: /home`, maskable icon, `theme_color`/`background_color` = the `--background` token per theme) and a pass-through service worker — **no offline, no install-only screens, no "open in app" banners** beyond the browser's own prompt. Installed and browser tabs render the same UI; `display-mode: standalone` may adjust chrome only (safe-area insets, no duplicated back affordance), never anything a permission or visibility rule touches. The portal gets its own manifest at Phase 3 (CP3); the ops host none.

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
`Private to team` / `Client can see`. Every class-B row shows one; never a third wording, never an icon alone. Inheritance tooltip: "Follows ACME-12". Bulk change shows the count: "Make 14 tasks private?".

**The rendering is specified in §10.4, which supersedes the "neutral / accent" wording once used here** — the pair now differs on five channels (fill, icon, shape, weight, border) plus a 2px row cue, and is measured under three colour-vision simulations by the release gate.

### 5.6 Comment composer — two modes
Toggle "Internal note" (default, neutral) / "Reply to client" (distinct colour, border). Mode maps 1:1 to visibility; contact-authored comments have no toggle. Mentioning a Contact in an internal note warns inline. `⌘Enter` posts.

### 5.7 Step-up dialog
One `<StepUpDialog>` reused for every ✦ action (role edit, cost reveal, credential reveal/share/export/visibility, member removal…). TOTP field, "why" line, `vault.stepUpMinutes` explained. Never a custom MFA prompt elsewhere.

### 5.8 Empty state
One verb + one sentence + one primary action, e.g. "**Create** the first task — press C or click +". No illustrations larger than the text. Onboarding checklists are skippable and dismissible for good.

`variant="empty"` **requires** an `icon` and an `action` — enforced by the type, not by review. An open folder on a Team tab and an open folder on a Board tab say nothing about either, and a "nothing here yet" with no verb is a dead end. A state that genuinely has no verb to offer is not `empty`: it is `filtered` (clear the filter) or `forbidden` (this is real, it is not yours). The audit asserts the runtime half — every `[data-variant=empty]` contains a focusable descendant.

### 5.9 Inline confirm
Destructive actions (delete, archive-with-children, lock, revoke) confirm **in place**: the trailing slot becomes `Delete "file.pdf"? [Yes] [No]`; no modal. Undo toast where reversible. Esc and focus leaving both cancel; focus moves to `Yes` when the question opens and returns to the trigger when it closes.

**Resting weight and confirm weight are separate.** The resting control is `variant="outline"` (or a `tone="danger"` menu item, §5.12); the `Yes` of the question is `variant="destructive"`, and that is **the only solid `--destructive` fill in the product's resting UI**. A page-level destructive — Archive client, Archive project, Delete role — is not a button floating on the canvas either: it gets its own `<SectionCard title={t("danger.title")}>` at the foot of the main column, one line of consequence, and the outline resting weight.

### 5.10 No Save buttons
Forms outside `/settings/*` and auth do not have Save; settings forms auto-save per field with a saved-tick and undo. Rule 3 tripwire.

### 5.11 `<InlineEdit>` — a value is text until you edit it (FOUNDER MANDATE 1)

**A page of labelled properties is content, not a form.** A record property renders as TEXT and becomes its control on activation. An always-mounted `<Input>` for a value nobody is editing turns a Timeline into a data-entry screen, makes the milestone *name* the lowest-contrast thing in its own row (32px of chrome around 13px of text), and advertises the browser's `yyyy-mm-dd` on every undated field.

- **Rest** is a real `<button data-slot="inline-edit">`: transparent background, `1px solid transparent` border, and the **same box** as the control it becomes — `px-2.5`, `h-8` (`h-7` at `density="table"`). `hover:bg-accent hover:border-input`. Focus is the standard `outline-2 outline-offset-2 outline-ring`, never a ring shadow (§9). A `select` shows its chevron on hover/focus only.
- **Empty** shows a `placeholder` verb in `--muted-foreground` — "Set date", never a native date placeholder.
- **Editing** mounts the existing `Input` / `Input type="date"` / `NativeSelect` / `Textarea`, uncontrolled, autofocused, text selected. `key={value}` re-seeds it from a server refresh.
- **Commit is unchanged**: blur for text and multiline, `change` for select and date — the two events `<AutoForm>` already listens for. `InlineEdit` adds **no second save path**.
- **Keyboard**: Enter / Space / **F2** open; Escape restores the value into the control *before* blurring (so AutoForm's focus snapshot matches and **nothing is posted**) and returns focus to the trigger; Tab out commits; `⌘/Ctrl+Enter` commits a multiline.
- **ARIA**: the trigger's accessible name is `common.inlineEdit.trigger` — "Edit due date, currently 12 September 2026" — the mode change is announced in a live region, and the trigger is the **only** tab stop for the value.
- **Failure is not lossy.** `invalid` keeps the control open with `aria-invalid` and the user's text intact. Reverting to the server value while the edit is still on screen is a bug this product shipped once.

**The hazard, stated once so nobody re-introduces it.** `<AutoForm>` posts the *whole* FormData and several server actions read an absent field as an erase. So `InlineEdit` **always renders `<input type="hidden" name value>` at rest**, and never mounts it at the same time as the real control (`FormData.get()` returns the first entry, and a stale hidden value would win). Every action reached this way is additionally `has(formData, name)`-guarded. `e2e/inline-edit.spec.ts` is the regression gate: it edits a milestone's name alone and asserts, in the database, that the due date still names the same day and the visibility is unchanged.

`VisibilityInlineEdit` is the safety-critical companion: its rest state **is** the `<VisibilityBadge>`, so it carries all five §10.4 channels, which a 28px filled `<select>` drops two of.

**Not for**: a preferences page (a control panel *is* its switches, §5.10) or a writing surface (`ClientNotesForm`, `internalNotes`, `scopeSummary` keep their textarea). Inline edit is for *labelled properties*.

### 5.12 `<RowActions>` — the row's verbs live in a menu (FOUNDER MANDATE 2)

A solid `--destructive` button repeated on every row of every table is the highest-chroma object on most pages and outranks the row it serves.

- The trailing cell holds **at most one** ghost `size="icon-sm"` icon button for the row's everyday verb (download, open), then a ghost `⋯` trigger. Nothing else.
- The menu is the existing `ui/dropdown-menu`. Destructive items are `variant="destructive"` — danger **text**, tinted hover — and **no `variant="destructive"` `<Button>` may exist inside a table row anywhere in the app**.
- `tone: "danger"` **requires** `confirm`; the type refuses it otherwise. Selecting it does not act: it closes the menu and swaps the trailing slot for the §5.9 question in place.
- Reorder arrows, "Move up" / "Move down" and every other row verb go **into the menu**, not behind hover: a hover-only control is unreachable by touch and invisible to a keyboard user scanning the row.
- A menu whose items are all disabled is not focusable, so a reason nobody can read is worse than no control: render **nothing** in that row instead, and let the row's own marker ("(you)") say why.
- Icons are client-only — a lucide component does not serialise across the RSC boundary, so a server component passes items without `icon`.

### 5.13 `<FileDropField>` — the OS input never shows (FOUNDER MANDATE 3)

The dashed region is a `<label htmlFor>`. Inside it: a 16px `UploadIcon`, the hint, and a **`<span>` wearing `buttonVariants({variant:"outline",size:"sm"})`** — not a `<button>`, which would swallow the label's click. The real `<input type="file">` is `className="sr-only"` — **never** `hidden`, never `display:none`, both of which take it out of the tab order and the AT tree. The label shows the input's focus ring via `has-[input:focus-visible]:outline-*`. Dragging swaps to a solid border and a "Drop now" hint; a chosen file replaces the hint with `filename · 1,2 MB` plus a ghost `×`. Disabled is `--bg-disabled`, never opacity.

### 5.14 `<Disclosure>` — one progressive-disclosure trigger

Fields that are empty, and matrices nobody has asked for yet, wait behind one 28px ghost trigger with a rotating chevron: `<details>`/`<summary>`, so it is keyboard-operable, announced as expandable, and findable by find-in-page — which a React-state disclosure is not. Hidden inputs inside it still post, so a closed disclosure and an open one send identical FormData.

### 5.15 `<PageState>` — one component for every whole-page state

404 (anonymous and in-app), the error boundary and an unusable invitation are four renderings of one idea, and they used to differ in every dimension. All four are now `<Page>` → `<SectionCard>` → `<EmptyState titleAs="h1">`: a 22px h1 (the page-title role, §10.7), inside a card, at the content column's normal top-left — no `min-h`/`justify-center` gymnastics — and **always at least one action**, because a whole-page state that offers nothing to do is a dead end.

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

Testable rules. Every numeric claim below is asserted in `src/lib/contrast.test.ts`, which parses `src/app/globals.css` itself — the file that ships — so a lowered contrast fails CI rather than review. **When a row fails, the fix is the token, never the threshold.**

- Body and muted text ≥ 4.5:1 on every surface it renders on (`--background`, `--card`, `--popover`, `--muted`, `--sidebar`, `--accent`, and every tone tint). Placeholders included — SC 1.4.3 grants them no exemption.
- Control boundaries (`--input`, not `--border`) ≥ 3:1; outline-chip borders (`--tone-*-line`) ≥ 3:1 on the card they sit on.
- Focus indicator: `outline: 2px solid var(--ring)` at `outline-offset: 2px`, **never** a `box-shadow` ring (box-shadows are clipped by `overflow:hidden` ancestors — the table container, the tab strip, cards). Inside a scroll container use a negative offset (`-outline-offset-2`), as `TabNav` does. Because the offset puts the ring on the *surface* behind the control, the gate measures ring × surface, not ring × control fill.
- Every drag has a keyboard twin (§7.1); every single-key action is also a menu item.
- Every icon-only control carries `aria-label` from `t()`, and its tooltip text is the identical string.
- Colour is never the sole carrier. Every enum value has a distinct icon silhouette; terminal values additionally strike their label; priority is geometry, not hue, at every level except URGENT.
- The active-row indicator is two channels everywhere — `--accent` fill **plus** a 2px `--primary` inset bar — in the table, the dropdown menu, the select and the command palette. An `--accent` fill alone measures ~1.07:1 against `--popover` and is not a focus indicator.
- Targets ≥ 24×24 CSS px; **grouped** icon buttons ≥ 28px (`size="icon-sm"` / `size="sm"`, SC 2.5.8 spacing clause). `size="xs"` (24px) is for isolated controls only.
- `prefers-reduced-motion: reduce` clamps every duration to **1ms — never `animation: none`**, because Radix exit transitions wait on `animationend` and would leave dialogs mounted for ever.
- `role="status"` on results, `role="alert"` on errors; `aria-invalid` helper text is announced, not merely tinted. `<FormMessage>` and `<Field>` do this for you.
- `aria-current="page"` on the active nav item, which also carries a 2px indicator and a colour change (three channels).
- Disabled state uses `--fg-disabled` / `--bg-disabled` + `cursor: not-allowed` (≥ 3:1), never `opacity: 0.5`.
- `color-scheme` is declared per theme so native scrollbars, date pickers and autofill follow.
- Both locales must pass at the longest Swedish string: chips and buttons wrap or grow, never truncate.

---

## 10. The visual system (normative)

**Amended 2026-08-17.** This section replaces the ARC-15 sketch that preceded it. It is the reference for every new screen: **new UI is assembled from the tokens and components named here, and adds neither a colour nor a component of its own.**

### 10.1 Where the system lives

| concern | file |
|---|---|
| all tokens, utilities, base layer | `src/app/globals.css` |
| self-hosted faces + licences | `src/app/fonts/` (`inter-eu.woff2` 110 KB, `geistmono-eu.woff2` 28.5 KB, `build-fonts.mjs`) |
| entity colour algorithm | `src/lib/entity-color.ts` |
| tone → class strings | `src/lib/tones.ts` |
| enum → tone / icon / shape | `src/lib/enum-map.ts` |
| locale-correct numbers, money, durations, bytes | `src/lib/format.ts` |
| theme vocabulary, cookie, no-FOUC script | `src/lib/theme.ts` |
| **the release gate** | `src/lib/contrast.test.ts` (+ `color.ts`, `css-tokens.ts`) |
| the living preview | `/settings/design` |

Since set B: `src/components/semantic/timeline.tsx`, `progress-meter.tsx`, and `EntityTile` in `entity-chip.tsx`. Everything in `src/components/semantic/` is re-exported from `@/components/semantic` — **screens import from the barrel**, never from a deep path.

There is **no `tailwind.config.js`** — Tailwind 4 is CSS-first. Everything is `@theme` in `globals.css`.

### 10.2 Colour: three layers, in this order

1. **Primitives** in `@theme static` — the ramps. `@theme static` is required: without it Tailwind tree-shakes theme vars it cannot see used, and `--brand-h`, the surface ladder and the motion tokens vanish.
2. **Roles** in `:root` / `.dark` as plain custom properties — *not* in `@theme`.
3. **Bridge** in `@theme inline { --color-primary: var(--primary); … }`. Omitting `inline` makes dark mode silently do nothing.

Ramps: `slate` (neutral, carrying a hairline of brand chroma — zero-chroma grey is the signature of an untouched preset), `indigo` (brand, hue 268), `red` h25, `amber` h70, `green` h150. **No blue and no violet ramp**: info states use brand tints plus an info glyph. Surfaces are a separate ladder (`l0`–`l2`, `d0`–`d4`) so elevation is explicit rather than borrowed from the text ramp.

The brand accent has exactly **three jobs**: filled primary buttons, the active nav indicator, and the focus ring. Everything else is neutral chrome plus the tone set.

**Phase 7 seam.** Brand tokens are written `oklch(<L> <C> var(--brand-h, 268))`; a tenant override is one inline `style="--brand-h: 250"` on `<html>`. **Excluded from tenant control, and asserted so by the gate:** `--ring`, `--destructive`, `--success`, `--warning`, `--vis-*`, all `--chart-*`. A tenant whose hue is 25° must not make their primary button read as delete.

### 10.3 The semantic tone set — six tones

`neutral · brand · caution · success · danger · quiet`. Each is three tokens: `--tone-<t>-bg`, `--tone-<t>-fg`, `--tone-<t>-line`. A tinted chip is `bg` + `fg` (measures 6.3–7.9:1 light, 10.7–11.4:1 dark); an outline chip is transparent + `line` + `fg`. `quiet` is transparent with `--muted-foreground` and strikes its label; **`--tone-quiet-line` is `var(--input)`** so the quiet outline chip's hairline and the cancelled timeline node's glyph — the only marks those states carry — clear 3:1 instead of the 1.90:1 a decorative grey measured.

**Tone as plain text.** `--destructive` is a FILL colour: white on it measures 4.60:1, but *as text* on a dark card it measures 3.90:1 and fails SC 1.4.3. Danger text — `<FormMessage>`, `<Field error>`, the destructive menu item, the error toast icon — is therefore `--tone-danger-fg`, and every tone's `fg` is asserted ≥4.5:1 on card, canvas, muted, accent and popover. Reach for `--destructive` only where it is a fill or an outline.

Never reach for a tone by hand — `<StatusBadge>` picks it from `src/lib/enum-map.ts`.

### 10.4 The visibility system (safety-critical)

The worst bug this product can ship is a client seeing internal data. The two states differ on **five channels at once**, none of them hue alone:

| | Private to team | Client can see |
|---|---|---|
| fill | transparent | **solid warm** `--vis-client`, *identical in both themes* |
| icon | `lock`, outline | `eye`, filled |
| shape | 4px radius | full pill |
| weight | 500 | 600 |
| border | 1px `--input` | 1px `--vis-client-border` |
| row cue | 2px transparent left border (no layout shift) | 2px left border in `--vis-client-cue` via `visibilityRowCue()` |

Measured separation (client fill vs the card showing through the internal chip): **ΔE_OK 0.249–0.290 light, 0.543–0.593 dark**, across normal / protan / deutan / tritan.

Rules, all enforced in code:

- **Both states always render a chip.** Absence is not a state — absence is indistinguishable from a bug.
- The **fill** (`--vis-client`) is identical in both themes, because that is the pair the CVD gate measures. The **2px row cue** (`--vis-client-cue`) is not: the warm fill measures 2.10:1 on a white row, and a 2px edge at 2.1:1 is a decoration rather than a signal, so light draws the cue in the darker warm (≥4.19:1 on card, canvas, muted and row hover) and dark keeps the fill (≥6.49:1 on the same four). Never hand-write the class — call `visibilityRowCue()`, which the design gate itself renders.
- Never icon-only, at any density. Never optimistic.
- The **write** control wears the same warm fill as the read chip when set to `CLIENT_VISIBLE` (`VisibilitySelect`, the upload form, the milestone row) — an editable row is never less legible than a read-only one.
- **Collision rule:** the warm band is the caution family, and a **filled warm pill means "Client can see" and nothing else, product-wide.** `warning` renders only as a tinted surface + 1px border + `triangle-alert` (`<Callout tone="caution">`), never as a filled pill. Project "Portal on" is `Badge variant="brand"` + `globe` for exactly this reason.

### 10.5 Enum → tone / icon / shape

The full table lives in `src/lib/enum-map.ts` (`STATUS_MAP`) and covers `clientStatus, projectStatus, milestoneStatus, versionStatus, approvalStatus, memberStatus, inviteStatus, serviceStatus, portalStatus, stateCategory, projectHealth, workItemKind, workItemType` plus `PRIORITIES`. It is the single source of truth: a screen never decides what colour `ACTIVE` is, so the same word cannot mean two things on two pages.

Labels come from `t("states.<domain>.<value>")` and are **never passed in** — a caller that could pass a label could pass a different word for the same state.

Deliberate: **priority is not hue-coded** across levels (geometry only; URGENT alone is red). **Health keeps RAG** because stakeholders read it that way, but always carries a distinct icon silhouette *and* its text.

### 10.6 Deterministic entity colour

Twelve frozen hues, each anchored to 3:1 against every surface of its theme, exposed as `--entity-0 … --entity-11`. `entityHash()` is FNV-1a 32-bit over the **immutable id** (`name` is a last-resort fallback for optimistic rows, reconciled on the server response — otherwise renaming a client would silently change its identity).

Entity colour is **identity, never status**; the label beside it always carries the meaning, and the tile is `aria-hidden`. Used by `<EntityChip>` (clients, projects) and `<MemberAvatar>` (people).

`<MemberAvatar>` deviates from the original spec on purpose: the spec coloured the *initials*, but the entity ramp is anchored to 3:1 — a non-text threshold — so coloured initials on a tint of their own hue measure ~3:1 and fail SC 1.4.3. The `.entity-tint` utility carries the identity (15% wash light, 28% dark) and the initials stay `--foreground`, measuring 16.8:1 light / 8.9:1 dark.

### 10.7 Typography

Self-hosted, subset, **zero network**: Inter 4.1 variable + Geist Mono 1.7.2 variable via `next/font/local`, two preloads, ~140 KB total, OFL licences committed beside them. Google's Inter build is stripped of `zero`, `ss01`–`ss08` and `cv01`–`cv14` — the exact features that disambiguate `ACME-12` — which alone forces a local file.

Root stays 16px; the `--text-*` keys are remapped so existing `text-sm`/`text-xs` sites moved with the system.

| role | utility | px | line | weight | tracking |
|---|---|---|---|---|---|
| display (auth) | `text-3xl` | 30 | 36 | 600 | −0.021em |
| dialog heading | `text-2xl` | 24 | 32 | 600 | −0.0195em |
| page title h1 | `text-xl` | 22 | 28 | 600 | −0.018em |
| section title h2 | `text-lg` | 16 | 22 | 600 | −0.011em |
| subsection h3 | `text-base` | 14 | 20 | 600 | −0.006em |
| body, table cell | `text-sm` | 13 | 20 | 400 | 0 |
| secondary / hint | `text-xs` | 12 | 16 | 400 | 0 |
| caption, badge, kbd | `text-2xs` | 11 | 14 | 500 | +0.005em |
| table header, eyebrow | `text-2xs uppercase` | 11 | 16 | 600 | +0.04em |

Weights are capped at **600**; 700 and 300 do not exist in this product. Hierarchy is size + colour, **three foreground tokens per view maximum** (`--foreground`, `--muted-foreground`, plus one tone). No italics.

`font-feature-settings` is declared **exactly once**, on `html` — it replaces rather than merges, so any second declaration silently drops `cv01`/`cv05`/`ss01`.

**Numerals.** `@utility num { font-variant-numeric: tabular-nums lining-nums slashed-zero }` goes on every numeric cell, duration, money value, count, byte size, version number, date, percentage, project key and `<kbd>`. Prose keeps proportional figures. Use `font-variant-numeric`, never `font-feature-settings`.

**Formatting** is `src/lib/format.ts` only — `Intl` formatters built once per locale in a module-level Map, never inside a render. sv-SE's group separator is U+00A0, so machine output uses `{useGrouping:false}` and client-side matching normalises it. Swedish runs 10–25% longer than English.

### 10.8 Space, shape, elevation

- **Spacing** on a 4px grid: `2 4 6 8 12 16 24 32 48`. The 2px step is only for icon-to-label gaps inside chips.
- **Control heights**: `xs 24` (isolated icon-only), `sm 28` (compact / **grouped** icon buttons), `default 32`, `lg 40` (prominent CTA).
- **Rows**: 36px default / 32px compact, set once by `<DataTable density>` as `--row-h` and consumed by both `TableRow` **and** `Skeleton`, so a table cannot load at one rhythm and settle at another. Table header 32px.
- **Radii**: `sm 4 · md 6 · lg 8 · xl 12`, plus `--radius-card: 10px`. Controls 6px, cards/dialogs/popovers 10px, badges/avatars `rounded-full`. **Nothing above 12px.**
- **One surface language: `1px solid var(--border)`.** Anchored things (cards, rows, sidebar, inputs, tables) get border + surface step, **never a shadow**. Exactly three shadows exist (`--shadow-1/2/3`) and only for things that genuinely float: dropdown/popover/tooltip/select, command palette/toast, dialog/sheet.
- **Content widths**: `--content-form` 720px (settings, account, auth), `--content-default` 1080px (detail pages), `--content-wide` 1440px (tables, board, backlog). Chosen via `<Page width>`.
- Card padding 16px (12px at `size="sm"`); 16px between cards, 24px between sections.

### 10.9 Motion

Tokens: `--dur-instant 80 · --dur-fast 120 · --dur-base 200 · --dur-slow 320`, with `--ease-out` / `--ease-entrance` / `--ease-exit`. Exits run at roughly two-thirds the enter duration.

**Animates:** colour on hover and press (80ms); popover, dropdown, tooltip and select opacity + 4px translate (120 enter / 80 exit); dialog and command palette (200 / 120); disclosure height; sheet transform (320 / 200); the toast stack.

**Never animates:** table row insert, remove or reorder; sort; column resize; numeric value changes; the board on data refresh (only on user drag); route changes; anything on an interval.

Never `transition-all` — enumerate the properties. Loading: under 200ms render nothing; 200ms–1s swap the trigger's leading icon for a spinner in a **fixed-width slot** so the button never resizes; over 1s show a skeleton matching the real row height and column widths.

### 10.10 Component catalogue

**Rule: a screen imports from `@/components/semantic` for anything that carries domain meaning, and from `@/components/ui` only for raw controls.**

`src/components/semantic/` — the layer that knows what a value *means*:

| component | use it for |
|---|---|
| `SectionCard` | **the one boxed surface.** Replaces every raw `<Card>` and every `rounded-md border border-border` wrapper |
| `DataTable` | the density/rhythm wrapper around every `<Table>` |
| `StatusBadge {domain, value}` | **every** enum value. Never a hand-rolled `<Badge variant={…}>` |
| `EntityChip {id, name, kind}` | every client/project reference in a list |
| `MemberAvatar {id, name}` | every person |
| `VisibilityBadge` + `visibilityRowCue()` | §10.4, always together on a row |
| `Callout {tone}` | every tinted notice block. Replaces the hand-rolled amber divs |
| `Field {label, htmlFor, hint, error}` | every labelled control (was duplicated three ways) |
| `Pending {label}` | the ellipsis indicator (was duplicated five ways) |
| `EmptyState {variant}` | `empty` vs `filtered` vs `forbidden` — three variants, never conflated. `empty` **requires** `icon` + `action` (§5.8) |
| `InlineEdit {kind,name,value,label}` | **every editable record property** (§5.11). Never a bare `<Input>` for a value that should read as text |
| `VisibilityInlineEdit` | the safety-critical one: rest state IS the badge (§10.4) |
| `RowActions {label,primary,items}` | **every** per-row verb (§5.12). No destructive `<Button>` in a row, ever |
| `FileDropField` | the only file input in the product (§5.13) |
| `Disclosure {label}` | the one 28px progressive-disclosure trigger (§5.14) |
| `PageState {variant,icon,title,body,primary}` | 404, error boundary, unusable invitation (§5.15) |
| `Page {width}` / `PageHeader` | the content column and the h1 block |
| `Timeline` + `TimelineItem` | the one dated rail (§10.15) |
| `ProgressMeter {value,total,label}` | done-of-total, wherever a count has a denominator |
| `EntityTile {id,name,size}` | the identity mark alone, for an h1 that cannot be `EntityChip` |
| `MetricTile`, `HealthChip`, `PriorityIndicator`, `KeyboardHint`, `ThemeToggle`, `StatusIcon` | as named |

Utilities carry the roles that are typographic rather than componentised: `eyebrow` (the 11px/600/+0.04em uppercase table-header and eyebrow role — **never** written out as four classes), `otp-field` (a six-digit code), `row-h` (the `--row-h` rhythm outside a `<Table>`), `hairline-b`, `entity-tint`, and `hit` (an invisible 6px collar that lifts a 20px mark over the §9 touch floor **without moving a pixel of the design** — enlarge the hit area, never the glyph).

**Figures split by job.** `num` is tabular lining figures for a QUANTITY — money, counts, byte sizes, percentages, dates; `num-id` adds `slashed-zero` for an IDENTIFIER that is read character by character and transcribed — a project key, a version, a hash, an org. number, a postal code. The slash is a disambiguation device, and a slashed zero in a two-row count column at 13px reads as a rendering fault. In practice the rule is mechanical: wherever the mono face carries a code, it is `num-id`.

`src/components/ui/` — 25 primitives. Two are deliberately native: **`NativeSelect` and `NativeCheckbox` fire real `change` events**, which is what `<AutoForm>` listens for. The Radix `Checkbox` renders a button plus a bubble input and does **not** emit a bubbling change event — an auto-saving form built on it silently stops saving. Use the native pair inside `<AutoForm>`, Radix elsewhere.

### 10.11 Dark mode

Dark is a separate design, not an inversion.

1. **Elevation reverses** — surfaces get *lighter* with height (`d0` sidebar 0.115 → `d1` canvas 0.155 → `d2` card 0.205 → `d3` popover 0.245 → `d4` border/hover 0.300). The contract is **ΔL ≥ 0.04, not a contrast ratio** (card-over-canvas measures 1.10:1 — arithmetically nothing, perceptually obvious). Shipped steps: 0.040 / 0.050 / 0.040 / 0.055.
2. **Shadows stop doing work** — hairlines and surface steps carry elevation; the shadow tokens become pure black at higher alpha and are kept for dialogs only.
3. **Chroma drops**; the twelve entity dots are re-anchored to 3:1 against `--card`, not the canvas.
4. **Neither pure black nor pure white.**
5. **Borders are opaque** — never `oklch(1 0 0 / n%)`. Alpha borders cannot be statically contrast-tested and change meaning per backdrop; the gate asserts `alpha === 1`.
6. The sidebar **recedes** — darker than the canvas in *both* themes (asserted).
7. `color-scheme` is set per theme.

**The toggle is not `next-themes`.** The app already resolves per-request preferences server-side; a second client-only source of truth would drift from it and force a client boundary at the root. The preference lives in the `fl_theme` cookie (`SameSite=Lax`, one year), which becomes the mirror of the member preference row when that lands.

**No-FOUC contract, verified:** an explicit `light`/`dark` is server-rendered onto `<html>` and ships **zero** script; only `system` emits a ~180-byte synchronous script in `<head>`, before `<body>`, so it resolves pre-paint. `suppressHydrationWarning` on `<html>` only. `<meta name="theme-color">` cannot read a custom property, so its two literals live in `src/lib/theme.ts` and the gate asserts them equal to `--background` in each theme.

### 10.12 Density

Compact, information-dense, but calm — this is a tool people live in all day. 13px body on a 4px grid, 32px controls, 36px rows, 16px card padding, no zebra striping, no shadows on anchored elements, borders only.

Inside a row a control is 28px (`InlineEdit density="table"`, `RowActions`' ghost `icon-sm`, `MemberAvatar`). **`DataTable` sets `[&_td]:py-0.5`** — 2px, not the primitive's 6px — because a fixed-height row centres its cells, so vertical padding buys nothing visually and acts only as a floor that taller content pushes through. At 6px a 28px control made a 40px row and a 22px chip made a 34px compact row: the density promise broken by padding rather than by content. The audit measures every row's height against the `--row-h` it declares, so it cannot happen quietly again.

**Below `sm`/`md`, columns drop rather than scroll off.** `TableHead`/`TableCell` take `priority="high" | "medium" | "low"` (`low` hides below `md`, `medium` below `sm`, `high` always renders, and the trailing actions column is always `high`). The scroll box that remains is `role="region" tabIndex={0}` with a real `aria-label` and a right-edge fade — a scroll container only a mouse can reach is content a keyboard user cannot read. **There is no second, stacked-row renderer for tables** (§12): one list implementation, columns removed by one prop. What priority must buy is the trailing actions cell: the audit fails any `[data-slot=row-actions]` that sits outside its table's visible box, because a verb behind an unadvertised horizontal scroll is a verb nobody finds. Where the priorities alone are not enough, the identifying column takes a per-viewport cap (`max-w-28 sm:max-w-64` on `/files`, `max-w-36 sm:max-w-64` on `/members`) and truncates with a `title` — never the actions.

### 10.13 The rule: tokens and components only

**New UI adds no colour and no component of its own.** If a screen needs a colour, it is already a token; if it needs a boxed surface, it is `SectionCard`; if it needs a status, it is `StatusBadge`.

Tripwires — each must return **nothing** across `src/app/**` and `src/components/**`:

```sh
# 1. raw palette utilities
grep -rEn "\b(bg|text|border|ring|fill|outline|divide|placeholder)-(neutral|gray|slate|zinc|stone|red|green|blue|amber|yellow|orange|purple|violet|indigo|teal|cyan|pink|rose|emerald|lime|sky)-[0-9]{2,3}" src/app src/components

# 2. colour literals (the only allowed pair lives in src/lib/theme.ts)
grep -rEn "#[0-9a-fA-F]{3,8}\b|oklch\(" src/app src/components --include=*.tsx

# 3. removed focus patterns
grep -rEn "ring-3|focus-visible:ring-\[|ring-ring/50|ring-1 ring-foreground" src/app src/components

# 4. dimming as a disabled state
grep -rEn "disabled:opacity-[0-9]{1,2}|[^-]opacity-50" src/app src/components --include=*.tsx

# 5. off-scale type
grep -rEn "text-\[[0-9]" src/app src/components --include=*.tsx

# 6. raw checkboxes (use NativeCheckbox inside AutoForm, Checkbox elsewhere)
grep -rn 'type="checkbox"' src/app src/components | grep -v native-checkbox

# 7. hand-written eyebrows and one-time-code fields (use the utilities)
grep -rEn "tracking-\[" src/app src/components --include=*.tsx

# 8. danger as TEXT (it is a fill colour; use --tone-danger-fg)
grep -rn "text-destructive" src/app src/components --include=*.tsx | grep -v "text-destructive-foreground"

# 9. a bordered DataTable nested inside a padded card (use flush).
#    The grep below only finds CORRECT usage, so it is a reading aid,
#    not the gate: the real check is the audit's `doubleHairlines`,
#    which measures the rendered borders and padding (§10.14).
grep -rn "rounded-none border-0" src/app | grep -i datatable

# 10. MANDATE 2 — a solid destructive FILL (the menu item is the correct
#     shape; the only legal fill is InlineConfirm's "Yes")
grep -rn 'variant="destructive"' src/app --include=*.tsx | grep -v DropdownMenuItem

# 11. MANDATE 3 — a file input outside FileDropField
grep -rn 'type="file"' src/app src/components --include=*.tsx | grep -v file-drop-field

# 12. MANDATE 1 — a bare control bound to a record property inside a
#     table row or a definition list (use InlineEdit)
grep -rEn "<(Input|NativeSelect|Textarea)[ />]" src/app --include=*.tsx | grep -iE "TableCell|<dd"

# 13. a second <details>/<summary> (use Disclosure)
grep -rn "<summary" src/app src/components --include=*.tsx | grep -v disclosure.tsx
```

Tripwire 10's one standing hit is `/settings/design`, the showcase whose job is to render every variant of every control; it is captioned as such. Tripwire 13's is nothing — `Disclosure` is the only `<summary>` in the product.

Justified standing exceptions, all inside `src/components/**`, none of them a colour: `KeyboardHint` (`h-[18px] min-w-[18px]`, `shadow-[0_1px_0_var(--input)]` — the specified kbd geometry), `PriorityIndicator` (`w-[3px] rounded-[1px]` — a sub-grid glyph), `EntityTile` (`text-[0.5625rem]` — 9px initials inside a 16px `aria-hidden` tile), `EmptyState` (`max-w-[340px]` — the specified measure), the `Tooltip` arrow geometry, the viewport-relative `Dialog`/`Sheet` widths, and the four `shadow-[inset_2px_0_0_var(--primary)]` active-row bars (a token reference; Tailwind has no inset-shadow utility). `Switch` uses `data-disabled:opacity-100` to *defeat* Radix's own dimming. `h-10` is the `lg` (40px) control height, not an ad-hoc value; `h-11`/`h-14` are the specified command-palette input row and mobile tab bar.

### 10.14 The release gate

`pnpm test` runs `src/lib/contrast.test.ts`, which parses `globals.css` and asserts the whole table in both themes: text ≥ 4.5:1 on every surface it renders on; non-text ≥ 3:1; tone chips, outline borders, visibility, entity dots, chart series and avatar washes; dark ΔL ≥ 0.04 and monotonically lighter; ΔE_OK ≥ 0.15 between the visibility fills and ≥ 0.10 between chart series under Machado 2009 severity-1.0 protan/deutan/tritan; no alpha borders; the brand seam excluded from `--ring`/`--destructive`/`--vis-*`; every colour role defined in **both** themes; and the `theme-color` literals equal to `--background`.

Set B added the pairs those screens actually paint: **every** tone (including `quiet`) as plain text and as a rule mark on card / canvas / muted / **accent** / popover; `--input` and `--ring` on `--accent`, because a control inside a table row is read on the HOVER surface and not on the resting one; `--destructive` as an outline; the internal chip's label and hairline on a hovered row; and the client-visible row cue at ≥3:1 on all five surfaces **plus** ΔE_OK ≥ 0.15 against the row it marks under all four vision types. Three tokens moved to satisfy those rows — dark `--input` 0.535 → 0.590, `--tone-quiet-line` → `var(--input)`, and the new `--vis-client-cue` — because the fix for a failing row is the token, never the threshold.

**No visual change ships on a screenshot of one page.** Every change to a token, a component or a screen is verified with the browser visual sweep — `pnpm test:e2e` (`e2e/visual.spec.ts`, `RUNBOOK.md` §7): 38 stops × light/dark × 1440×900 and 390×844, each stop audited in the page for exactly one `h1`, text that composites to its own backdrop, untranslated message keys, horizontal overflow at phone width, broken images, and console/network errors. The shots land in `.design-shots/` (git-ignored) and are reviewed in both themes before the commit. A contrast table that passes proves the palette; only the sweep proves the pages.

**The craft audit** (`e2e/audit.ts`, run at all 152 stops) is the half of this document a screenshot cannot hold open. Each of these must be empty on every stop, or the run fails:

| it asserts | because |
|---|---|
| no visible `input`/`select`/`textarea` inside a resting `[data-slot=table-row]` (toggles excluded — a checkbox *is* its value) | MANDATE 1 |
| every `[data-slot=inline-edit]` is a `<button>` with a non-empty accessible name | §5.11 |
| no `[data-variant=destructive]` inside a table row, and no computed `--destructive` background on any control outside a `[role=group]` confirm | MANDATE 2 |
| `input[type=file]:not(.sr-only)` is empty | MANDATE 3 |
| every `[data-variant=empty]` contains a focusable descendant | §5.8 |
| every scrollable `[data-slot=data-table]` has `role=region`, `tabindex` and a non-empty `aria-label` | §10.12 |
| every `[data-slot=row-actions]` sits inside the visible box of its own table — never behind a horizontal scroll | §10.12 |
| no bordered `[data-slot=data-table]` inside a padded `[data-slot=section-card]` content box | §10.15.1 |
| every row's measured height equals its own `--row-h` (desktop) | §10.12 |
| exactly one `aria-current="page"` in the phone tab bar; the current tab is inside its strip's box | §3.3 |
| the h1 of `/files`, `/members`, `/settings/roles` does not contain the tenant name (the `<title>` may — today it is "{page} · Fortleva") | §10.7 |

Behavioural halves that a DOM audit cannot reach live in specs: `e2e/inline-edit.spec.ts` (a keyboard-only edit — Tab, Enter, type, Enter — persists across a reload; Escape sends **zero** `next-action` POSTs and returns focus to the trigger; a one-field edit leaves the other columns intact in the database) and `e2e/visibility.spec.ts` (the client-visible row cue survives `:last-child`; deleting a document takes two interactions and the first posts nothing).

One thing that gate deliberately does **not** assert: a `dueAt` is compared as a calendar DAY, not as an instant. The control is an `<input type="date">`, so the field's precision has always been the day, and the first save through the form normalises a seeded timestamp to midnight — the same thing the always-mounted date input did. Losing the day, or the visibility, is the erase H1 is about; losing a time-of-day the UI never showed is not.

`/settings/design` renders the same system live — the token ladder with computed ratios, every component state, all twelve entity colours, and the two visibility chips under protanopia / deuteranopia / tritanopia / greyscale filters. **If the two visibility chips are not instantly distinguishable in every panel, the pass is not done.**

### 10.15 Recurring screen patterns

Nine shapes recur across the app. A new screen picks one of them; it does not invent a tenth.

**1. List surface.** A page's primary table is a `<DataTable>` — which already *is* the card surface (1px hairline, 10px radius, `--card`). When the list needs a caption (a count, a second population on the same page, an inline create beneath), it goes inside a `<SectionCard title description>` with `contentClassName="p-0"` and `<DataTable flush>`, which drops the table's own hairline so the card's carries it — and adds the 16px first/last-column padding, or the table's content hangs 8px left of the title above it. Never nest a bordered `DataTable` inside a padded card: that draws two borders 16px apart, and the audit fails the run when it happens. Numeric columns are right-aligned `.num`; a project key column is `w-[10ch]` of the mono face marked `.num-id`; a byte size splits into `.num` value + muted unit (`bytesParts`). Columns carry `priority` (§10.12), and the row's verbs are a `<RowActions>` in the trailing, right-aligned, always-`high` column.

**2. Create-in-place.** A page that can create shows a `size="sm"` primary button in the `PageHeader` linking to `#new-<thing>`, the same button in its `EmptyState`, and an anchored `<SectionCard id="new-<thing>" className="scroll-mt-16">` at the foot. `/clients` and `/projects` are the reference; a modal is never used for creation (§12).

**3. Dated rail.** The `Timeline` is one column: a 24px node carrying the state's *icon* (silhouette first, tone second), a 1px `--border` rail that stops at the last node, and 16px between entries. Terminal states fill the node — except `quiet`, which is transparent by definition and would erase the ring, so a cancelled entry stays outlined and strikes its label. The rail and the node are `aria-hidden`; the state is repeated as a `StatusBadge` in the content, so nothing is carried by the decoration alone. `contentClassName` is where `visibilityRowCue()` goes. Used by the project timeline and by TOTP enrolment (three numbered steps).

**4. File visibility.** Every documents row says it three times: a `<VisibilityBadge>` — which is now literally the rest state of the editable control too (`VisibilityInlineEdit`, §5.11), so an editable row and a read-only row are the same silhouette — the 2px `visibilityRowCue()` on the row, and a legend strip *outside* the table hairline naming both states in words. The row also emits `data-visibility` for E2E. The upload form states where the file will land *before* it is sent: a standing info `Callout` for private, swapped for a caution naming who can open it the moment "Client can see" is chosen.

**The cue must survive the last row.** `TableBody` carries `[&_tr:last-child]:border-b-0`, **not** `border-0`: `border-0` zeroes all four widths, including the `border-left` the cue paints — which meant the last client-visible row of every table in the product silently lost its safety marking while the legend below it asserted it in words. `/settings/design`'s visibility demo puts a client-visible row **last** on purpose, so the showcase proves this rather than hiding it, and `e2e/visibility.spec.ts` asserts the computed `border-left-width` on `:last-child`.

**5. Permission matrix.** One scrolling region (`max-h-96`) with `position: sticky` module headers — it is a bare `fieldset`, not a nested `SectionCard`, because sticky is inert inside the card's `overflow-hidden`. Codes split `namespace:` + verb; the ✦ MFA marker is `role="img"` with an `aria-label`, not a bare span; tombstones are a caution `Callout` plus a per-row badge. A **system** role has no controls to label, so it renders as a tick/dash ledger with `sr-only` "granted"/"not granted" rather than 63 disabled checkboxes.

**6. The three empty states.** `empty` (nothing yet → create it), `filtered` (things exist, none match → clear the filter), `forbidden` (things exist, not for you). They are never conflated, and a whole-page denial is an `EmptyState variant="forbidden"` inside a `SectionCard` — never a `Callout`, which is for notices about content the reader *can* see. `empty` requires an icon and a verb (§5.8), so a tab whose feature has not shipped is **`forbidden`, not `empty`**: there is no verb to offer and inventing one would be a lie. It keeps its static, `aria-hidden` **structural preview** beside it under a "Preview" eyebrow, built from the real tokens and the real `--row-h` (board columns, backlog ghost rows), outline-only so it cannot be mistaken for a `<Skeleton>` that is about to resolve. Never an illustration.

**7. The read-first property list.** A card of labelled properties is a `<dl>`: `<dt>` the label at `text-xs text-muted-foreground`, `<dd>` an `<InlineEdit>` (§5.11). The label carries the control's own `px-2.5` inset so the resting text sits under its label rather than 10px right of it. **Only populated fields render at rest**; everything blank waits behind one `<Disclosure label={t("addDetails")}>`, so the card states what is true instead of advertising ten blanks. The hidden inputs inside the disclosure still post, open or closed. Lead with the fact that identifies the record, not with the name the h1 already carries.

**8. The row's actions.** The trailing cell is right-aligned and holds at most one ghost icon plus a `⋯` (§5.12). A page-level destructive is not a row action: it is a danger-footer `SectionCard` at the foot of the main column (§5.9).

**9. The whole-page state.** `<PageState>` (§5.15). Four routes, one shape, one h1 size, one left edge, always a way forward.

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
