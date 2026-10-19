# Slice 136 — Saved views (founder decision C113)

*2026-10-19. Asked what to build after slice 135 (the calendar in Google/Apple Calendar recommended), the founder picked **saved views** from the own-use list's "Also still open". Four answers, all with the recommendation.*

## 1. The decision (C113)

| | Asked | Answer |
|---|---|---|
| (a) | Who sees a saved view? | **Only the person who saved it.** |
| (b) | Which lists? | **The Tasks page and project backlogs** — the two lists with filters (the board and the calendar have none). |
| (c) | Where? | **The left menu, under Tasks**, each with a small menu to rename or delete it; under More on a phone. |
| (d) | A filter changed on an open view? | **Nothing until "Update view".** |

Defaults stated, not asked: 30 views a person; names unique per person ignoring case; an impersonating operator changes none; a backlog view of a project the person no longer reaches leaves the menu but stays theirs to delete.

## 2. What a view keeps

Exactly what the list's filter bar sets, as ONE canonical query string (`src/lib/saved-view-plan.ts`):

- **Tasks page:** `due`, `person` (the reader's own id written `me`), `project`, `group` — read as `parseTaskListParams` reads them.
- **Backlog:** `state`, `assignee`, `priority`, `hideDone`, `group` — the filter bar's `workViewParsers`. Stricter than the page: a list value that is not an id (or `none` / `client` for a person), a priority that is not one, or a list past 50 refuses the save (`VIEW_FILTERS_INVALID`) rather than keeping a filter that matches nothing.
- Never `archived` (changes what the server loads), `item`, `error` or `view`.
- Canonical: fixed key order, defaults as no key, list values de-duplicated and sorted, ids lower-cased; alphabet `[A-Za-z0-9=&,_-]` (nothing needs encoding), ≤ 4000. So "has this view changed?" is a string comparison, on the client, against the filters on screen.

A view's address is its list, its filters, and `view=<id>` last. `?view=` rides every link on the page (the Tasks page's `tasksHref` carries it; the backlog's shallow nuqs updates keep it), so the page knows which view is open.

## 3. Data — `saved_view` (migration `20261104090000_saved_views`)

`id`, `tenant_id`, `member_id`, `kind` (`TASKS` | `BACKLOG`), `project_id` (BACKLOG only — CHECK), `name` (one line ≤ 60 — CHECK; `lower(name)` UNIQUE per member), `query` (CHECK on the outline), timestamps. Member and project FKs cascade; tenant RESTRICT. Class A (`tenant_isolation`, `portal_deny`) plus RESTRICTIVE **`own_view`**: the member principal only, its own rows only — no colleague, owner, admin or SYSTEM job; pinned by name in `isolation.dbtest.ts`. The export runs as the exporting member and so carries only their views. DDL and grants only.

## 4. Service and gates — `src/modules/work/saved-views.ts`

- `createSavedView`, `updateSavedViewQuery` ("Update view"), `renameSavedView`, `deleteSavedView`; `listSavedViewLinks` (inside the layout's transaction) and `readOpenSavedView` (the pages).
- Every read and write asks `work_item:view` AND `project:view` on all four gates (the Tasks page's pair — the reads with ONE `accessibleCodes`). Making or updating a BACKLOG view asks its project in scope (NOT_FOUND outside); renaming and deleting ask no scope. The menu keeps a backlog view whose project is out of scope, greyed, with no link and no key, so it can be renamed or deleted (it counts toward the 30).
- An impersonating operator is refused every write (FORBIDDEN) — the push devices' rule.
- A member's writes are serialised by a transaction advisory lock (`saved_view:<tenant>:<member>`) for the cap and the name; the unique index is the belt (`VIEW_NAME_TAKEN`).
- Audited: `saved_view.created` / `.updated` / `.renamed` / `.deleted` — the ACT only (target id, actor, kind), never the name, the filters or the project (§8 M1, §9). Writes name the member as well as the id (`updateMany` / `deleteMany`). No new permission code.

## 5. UI (UI.md §5.21)

- `SavedViewControls` beside the filters on both lists: **Save view** (no view open), the open view's name, and when a filter changed "(changed)", **Update view** and **Save as new view**. Saving opens the new view (`router.replace` to its address).
- `SavedViewsNav` under Tasks in the rail (hidden while collapsed) and in the More sheet: name, the project key for a backlog view, lit while open; a `⋯` menu with Rename… and Delete… dialogs. Deleting the open view drops `?view=` from the address; focus goes to the Tasks entry.
- Every action revalidates the signed-in layout (the menu lives there).

## 6. Tests

- `saved-view-plan.test.ts` — canonical forms, the outline at its largest, the href, the name rule.
- `saved-views.dbtest.ts` — canonical storage and audit; scope; kind/project; names ignoring case per member; the cap and a race at the edge; `own_view` against colleagues, the owner, SYSTEM and a contact; impersonation; Update view; rename/delete; the menu's scope filter; the open view's list and project; the project cascade; the CHECKs.
- `e2e/saved-views.spec.ts` — Tasks page: save, lit in the menu, change, Update view, open from the menu, rename, delete; a backlog: save, Save as new view.

## 7. Recorded residues

- The menu shows views only while the rail is expanded.
- The audit log says THAT a member made, changed or deleted a view, and when (its kind) — never what it holds.
- With a view open, the rail marks both Tasks and the view `aria-current="page"` (Settings' parent and child do the same).
- The impersonation refusal is defence in depth: impersonation is not built (`requireTenantContext` never sets the flag); the dbtest sets it by hand.
- The workspace export carries the exporter's own views, names and filters included — their own data. Until slice 136b closes the pre-existing hole below, the export file itself is downloadable by every member with `document:view`.

## 8. The migration's review, before it was applied (fresh agent, read-only)

No HIGH. Dispositions:

- **M1 — TAKEN.** The audit rows carried each view's name and filters (`from`/`to` too) at TENANT visibility, so an owner's workspace export (`audit_event.jsonl`) would show every colleague's view names — free text — and filters: C113 (a) broken outside the table. The metadata is now `{ kind, projectId }` on every `saved_view.*` row; `saved-views.dbtest.ts` pins it.
- **L1 — TAKEN.** The foreign keys lock `member` and `project` (and `tenant`) with no bound: the migration now takes `member, project` first under `lock_timeout = '10s'` (the repeating-tasks rule).
- **L2 — TAKEN.** The posture test checked `own_view`'s name and qual but not that it is RESTRICTIVE (a PERMISSIVE copy would OR with `tenant_isolation`): `CLASS_A_REQUIRED_EXTRA` now asserts it, `own_device` included.
- **N1 — TAKEN.** The plain `(tenant_id, member_id)` index is covered by `saved_view_name_ci_key`: dropped from schema and SQL.
- **N2 — RECORDED.** `[[:cntrl:]]` in the name CHECK means C0/C1 controls only under the builtin `C.UTF-8` locale (pinned by `isolation.dbtest.ts` for the test database); under ICU it would also match format characters the service allows (ZWJ). Production must be created with the builtin provider — the same holds for the template, label and stage name CHECKs.
- **N3 — RECORDED.** The "goes with its project" test deletes through the platform role, so it does not exercise a cascade under `own_view`; Postgres runs referential actions without row security, and no product code hard-deletes a member or a project today.
- **N4 — RECORDED.** A deactivated member's views stay (no SYSTEM job can see them); a future clean-up runs on the platform role.

## 9. The slice's reviews (fresh agents, read-only)

**Security** — no HIGH or MEDIUM inside the slice.
- **Pre-existing, outside the diff — probably HIGH, re-audited and CONFIRMED by the implementing session:** a workspace export is a `Document` (kind EXPORT, INTERNAL, no client, no project); `listDocuments` shows every client-less document to any holder of `document:view` (employees included) and only REPORT is filtered out; `getDownloadUrl`'s scope check does nothing for a client-less row and asks no extra code for EXPORT. So a member scoped to one client can open Files and download the owner's whole export. Told to the founder; recommended as slice 136b (exports only on Settings → Export, listed and downloaded under `tenant:export`).
- LOW (the exporter's views leave in that export) — recorded (§7); closed by 136b.
- NIT 1 TAKEN — the audit's `projectId` dropped too (metadata `{ kind }`).
- NIT 2 TAKEN — a backlog view out of reach is LISTED greyed with its menu (no link, no key), so the member can delete it rather than sit at the cap.
- NIT 3 TAKEN — `updateMany` / `deleteMany` on id AND member.
- NIT 4 RECORDED (§7). NIT 5 TAKEN (a stale test title). NIT 6 TAKEN — the posture test asserts the `'member'` term in the qual too.

**Code** — no HIGH.
- **M1 TAKEN.** The Tasks page dropped a person filter once that person held no open task in scope, and a project filter once the project was archived or out of reach — so a saved view opened as everyone's tasks under its own name, already showing "(changed)", and "Update view" would have wiped the filter. `listAllTasks` now KEEPS such a filter and it matches nothing (`projectKnown` / `personKnown`); the pickers name it as gone. Empty says nothing (the list is the scope either way). Slice 130's "no filter" rule superseded in UI.md, AUTHZ.md and its design; `all-tasks.dbtest.ts` re-pinned.
- L1 TAKEN — after Delete, focus goes to the Tasks entry found when the dialog OPENS (the last view's delete unmounted the list the lookup went through), and as a return (`returnFocusTo`, so the rail's tooltip stays shut).
- L2 TAKEN — Save opens the new view on the address as it was plus `?view=` (it rebuilt the address from the stored filters, which turned "show archived" off).
- L3 TAKEN — after Save and Update, focus goes to the open view's name (`tabIndex=-1`); the e2e asserts it after Save.
- L4 TAKEN — the menu's and the open view's gate is one `accessibleCodes` call, not two full `hasAccess` chains.
- NITs TAKEN: the unused `nameTaken` removed (the name field takes focus back after a refusal instead); the menu reads `?view=` through `viewParamOf` (case); the "just updated" state yields to the server's read once that moves; the e2e helper waits for a NEW view id; the canonical form's comment says how a repeated key reads. ACCEPTED: two `aria-current` with a view open (§7).

## 10. Narrow re-check of the fixes (fresh agent, read-only)

No HIGH or MEDIUM; every fix of §8–§9 confirmed in code.
- **L-1 TAKEN — a regression of L2.** Save opened the new view at the router's URL, which on the Tasks page trails a filter press still navigating — so the view (stored with the pressed filter) opened on the old one, already "(changed)". The caller now passes the address (`openHref`): the Tasks page builds it from the filters SHOWN (`tasksHref`), the backlog from the window's live address (nuqs writes history directly).
- NIT 1 TAKEN — the focus flag holds the NEW view's id and is cleared by the first view shown after; NIT 2 TAKEN — the "just updated" state is dropped (during render, React's prop-following pattern) the moment the server's copy moves, so a later change back cannot revive it; NIT 3 TAKEN — stale "no filter" comments (the Tasks page, its filter bar, PLAN's slice 130 line) and the audit catalog's comment; NIT 5 TAKEN — the e2e asserts focus ON the rail's Tasks entry after the last view is deleted; NIT 6 TAKEN — `people` compared by id.
- ACCEPTED: NIT 4 (with one project in scope and a gone project picked away, the project select unmounts under the cursor — no layer behind it), NIT 7 (a repeated `view=` lights the first in the menu and none on the page).
