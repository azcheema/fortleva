# Slice 125 — @mentions in comments (founder decision C101)

*2026-10-16. The first of the three Basecamp-comparison slices (mentions → a bin for deleted tasks → repeating tasks; C101–C103, asked together, all with the recommendation). This document is the build plan: the settled parts are C101's, and everything marked **(reading)** is the implementing session's choice, named so a reviewer can push on it.*

## 1. What the founder decided

- **(a) Only teammates can be @mentioned.** The person is told in their inbox, by email and on their phone, following their own notification settings. A client's people cannot be mentioned — so UI.md §5.6's "mentioning a Contact in an internal note warns inline" has nothing to warn about and stays unbuilt.
- **(b) Internal notes only.** In "Reply to client" mode nobody can be mentioned, and a note that mentions a teammate cannot be made client-visible until the mention is removed. C42's "clients never see your team's names" holds without exception.
- C44 ("later, as their own piece of work") is superseded.

## 2. What already exists (read, not assumed)

- **`mention`** (§6.14 / migration `20260820170000`): `id, tenant_id, comment_id, mentioned_member_id?, mentioned_contact_id?, created_at`; FK to `comment` ON DELETE CASCADE; grants to `app_runtime`; class A (`tenant_isolation` + RESTRICTIVE `portal_deny`); registered in `MODEL_CLASSES` / `RLS_CLASSES.A`. **Nothing writes it.** It has NO either-or CHECK, and its unique index `(tenant_id, comment_id, mentioned_member_id, mentioned_contact_id)` never deduplicates (one column is always NULL, and NULLs are distinct).
- **The notification kind `comment.mentioned`** (`src/notify/catalog.ts`): MEMBER, INSTANT, mailed at the `MENTIONS` level and louder. Its email copy (`templates.ts`), inbox label (`kind-copy.ts`, `inbox.kind.mentioned`), icon (`AtSignIcon`), summary line (`digest.ts`) and push coverage already exist. The email links to the task (`projectKey` + `itemNumber`). The "Only mentions" email level has been a dead setting until now.
- **No `MENTIONED` reason.** `NOTIFICATION_REASONS` and the database's `notification_reason_known` CHECK refuse it; `reasons.test.ts` and `inbox-polish.dbtest.ts` assert the refusal.
- **The comment schema** (`commentExtensions()`) is StarterKit without headings. `normalizeComment` parses → allow-lists attributes → parses again → `check()`; `bodyText` comes from `textBetween(…, "\n", " ")`, so an inline leaf with no `leafText` contributes a space (Tiptap 3 does not map `renderText` to `leafText` — checked in `@tiptap/core`'s dist).
- **The static renderer** (`RichText`) serves the member panel AND the portal task page; an unknown node renders nothing. The portal passes the stored body straight to it (`readPortalTask`).
- **Writers:** `createComment`, `updateComment` (own under `comment:create`, another member's under `comment:edit_any`), `setCommentVisibility` (can RAISE a note to client-visible), and the contact's `createPortalComment` (plain text only, built into a document on the server — no mention can come from a contact).
- **Who can open a task:** `work_item:view` on all four gates plus scope — `client:view_all`, or a `MemberProject` row for the project, or a `MemberClient` row for its client (`resolveScope`). The assignee picker lists every ACTIVE member of the workspace, scope or not.
- **`@tiptap/extension-mention` and `@tiptap/suggestion` were not installed.** This slice adds `@tiptap/suggestion@3.31.3` only (the editor's own version, pinned exact; its `@floating-ui/dom` peer was already in the store). `ARCHITECTURE.md` named the mention extension originally; it is not used — see §3.1.

## 3. The design

### 3.1 The mention node (reading)

A node of our own in `extensions.ts`, in `commentExtensions()` ONLY (never the description's, an update's or a contract's schema): `mention`, inline, atom, not selectable as text, one attribute `id` — **a member id and nothing else**. No `label`: a name stored in a body is a name that can travel (a raise, a copy, a future export); the name is resolved at READ time, for members only.

- The normaliser's attribute pass keeps `id` only when it is a UUID; the derive walk then refuses a mention without one (`INVALID_INPUT`) and collects the ids, distinct, in order. **At most 20 people a comment** (`MENTION_MAX`; past it `TOO_MANY_MENTIONS`).
- `bodyText` gets a space for a mention (the existing leaf rule) — the search index and its snippet never hold a name.
- `@tiptap/extension-mention` is not used: its node stores `label` and its `renderHTML` prints it, and its module imports the suggestion plugin into the server's schema build. Our node is ten lines; the editor adds the suggestion plugin client-side (it adds no node, so the schema the server validates is unchanged — the file's own rule).

### 3.2 Who can be mentioned (reading)

**Teammates who can open this task**: ACTIVE, holding `work_item:view`, and reaching the project — `client:view_all`, or assigned to the project, or to its client. One helper, `mentionableMembers(tx, tenantId, item)` in `src/modules/work/mentions.ts`, answers it in four statements (the members, their permission rows filtered to the two codes, the project's `MemberProject` rows, the client's `MemberClient` rows) instead of a scope resolution per member. The **module gates** are not re-checked per person: all three are workspace-level, and the writer has just passed them for the same module. A dbtest pins the helper EQUAL to the canonical per-member answer (`hasAccess(work_item:view)` + `assertInScope`) across seven shapes (owner, admin, manager, an employee assigned to the client, one assigned to the project, one assigned to neither, a suspended member, a role with `work_item:view` revoked).

The writer never trusts the list the browser had: every id in a posted body is checked against the helper inside the write transaction.

### 3.3 Writing

- **`createComment`**: `normalizeComment` returns `mentions`. A client-visible post with any mention is refused BEFORE the transaction (`COMMENT_MENTION_VISIBLE`, "A reply to the client can't mention a teammate…"). Inside, after the task's share lock: every mentioned id must be mentionable, else `MENTION_NOT_ALLOWED` (the words stay in the composer — the action-failure rule). Then the comment, its `mention` rows (one `createMany`), the history row as today, and **one `comment.mentioned` per person** (reason `MENTIONED`, the task's link params). **(reading, changed while building)** The dedupe key is per TASK — `mentioned:<itemId>`, through `notifyItemMembers` like every work notice — so a second mention on the same task before the first is read adds nothing (no second mail); the person reads the thread. The author is never told (emit drops the actor). The assignee's coalesced `work_item.commented` is skipped when the assignee is among those mentioned — one notice, the more specific one.
- **`updateComment`**: the same refusal for a client-visible comment. Only ADDED people are checked and told; a mention of someone who has since left stays in the text (an edit must not fail because a colleague left), removed people's rows are deleted. Editing someone else's comment tells the added people with the EDITOR as the actor.
- **`setCommentVisibility`**: a raise of a body with a mention is refused (`COMMENT_HAS_MENTION`: "Remove the @mention first"). The comment's row lock reads `jsonb_path_exists(body, …)` in the same statement, so the answer is the locked version's.
- **The database's belt** (the migration, §3.6): a CHECK on `comment`, `comment_visible_no_mention`, refuses any CLIENT_VISIBLE row whose body holds a `mention` node, mapped by its NAME to `COMMENT_MENTION_VISIBLE` in `db-errors.ts`. It covers every writer, including ones not yet written (a re-share cascade, a future import), and a contact's insert under `portal_gate`. *(The first draft was a trigger; the pre-apply review's LOW moved it to a CHECK, which runs after every BEFORE trigger on every write. The constraint name, not a token spelled like the service code, is what the mapper matches: outside production Prisma prints the caller's source lines into an error's message — the code-frame trap.)*

**Audit (reading):** a mention is part of writing one's own comment — routine, a history row and no audit event (the AGENTS.md carve-out: a comment's own creation and edit are routine). The notification rows are the record of who was told.

### 3.4 Reading

- `readItemComments` collects the mention ids of the page's bodies into the SAME name lookup it already makes for authors (no new statement) and returns `mentionNames` (id → name, or null for one that no longer resolves). Each row also gets `hasMention`, so the card offers "Show to client" DISABLED with the reason "Remove the @mention first" (`RowAction.disabledReason`) — the panel never offers a verb the service refuses.
- `RichText` gains an optional `mentions` map. A `mention` node renders `@Name` (a token-styled span) ONLY when the map is passed; without one it renders **nothing**. The portal and View-as never pass one — and by the CHECK no body they read can hold one.

### 3.5 The composer (reading)

- In **Internal note** mode, `@` (at the start of a line or after a space) opens a list **docked under the field** — never a floating layer: the peek's scroller, `RemoveScroll` and a phone width are where a popover runs off-screen (the standing trap). The list is the mentionable teammates (the author left out), loaded ONCE per composer on the first `@` through a server action (`listMentionableAction`, `comment:create` + `member:view` + the task in scope — the panel offers the list only to a member holding both, `caps.mention`), filtered as the person types (a name, or any word in it, starting with the text, case-insensitive). ↑/↓ move, Enter or Tab picks, Escape closes the list only. *(Built differently from this draft: `data-escape-local` cannot serve a ProseMirror editor — ProseMirror ignores an already-prevented event, so inside the peek the plugin never saw Escape; measured in a browser. The editor takes Escape at the window's capture phase — AGENTS.md's new standing trap. The list closes too when mentions are switched off under it (at once) or when focus leaves the editor's box (`focusout` on the box) — judged on the RELEASE when a press inside the box moved focus, so the list never collapses under the pointer before a click lands — the code review's and the narrow reviews' LOWs.)* A pick inserts the chip and a space. "No teammates match" when the filter empties it; "Couldn't load your teammates…" when the load failed.
- The editor field carries `aria-autocomplete="list"`, `aria-controls` and `aria-activedescendant` while the list is open (no `aria-expanded`: Tiptap's field is `role="textbox"`, where ARIA does not allow it); the list is a `listbox` of `option`s.
- In **Reply to client** mode the `@` list is off (the plugin's `allow`). A draft that already holds a mention and is switched to Reply-to-client is refused at post with the sentence above, and the words stay.
- Editing an INTERNAL comment in place offers the same list; editing a client-visible one does not.
- In the editor the chip reads `@Name` from the names the thread's read supplies (`mentionNames`, passed whether or not the member may list teammates) and the loaded list (`…` while unknown).

### 3.6 The migration (DDL only — a fresh agent reviews it BEFORE it is applied)

1. `mention`: `mention_member_only` CHECK (a member, never a contact — C101 (a) held by the database; the review's second LOW) and a UNIQUE `(tenant_id, comment_id, mentioned_member_id)` — the guard first refuses to run if any row breaks either (there are none; nothing has written the table).
2. `comment_visible_no_mention` CHECK on `comment`, as §3.3.
3. `notification_reason_known` widened by `MENTIONED`, FIRST in the list (the most specific reason — `reasons.ts` keeps the order as precedence).

No DML, no `neon-smoke.yml` dispatch owed.

### 3.7 Not built

A client's people as mentionable (C101 (a)); mentions in a description, an update or a contract (the `mention` table hangs off a comment); following a task (C98 (f)); the inline Contact warning (nothing to warn about); a deep link to the comment itself (the email and the inbox open the task, as every work notice does).

## 4. Tests

- **Unit** — `normalize-comment.test.ts`: a mention keeps only a UUID `id`, a missing or bad id is `INVALID_INPUT`, ids come back distinct and in order, 21 people is `TOO_MANY_MENTIONS`, `bodyText` holds no name; the description schema refuses a mention node. `render.test.ts`: a mention without a map renders nothing; with one, `@Name`; an unknown id, the unknown label. `reasons.test.ts`: `MENTIONED` is known and first.
- **dbtest** — `src/modules/work/mentions.dbtest.ts` (prefix `mention-`, registered in `DBTEST_PREFIXES`): the helper equals the canonical answer (§3.2); a mention writes rows, one notification per person with reason `MENTIONED`, and an outbox mail by level (MENTIONS and louder mailed, NONE not); the author is not told; the mentioned assignee gets the mention and not the coalesced notice; an out-of-scope or suspended teammate is `MENTION_NOT_ALLOWED` and nothing is written; a client reply with a mention is refused; an edit tells only the added and drops the removed rows; a raise of a mentioning note is `COMMENT_HAS_MENTION`; and the CHECK refuses a CLIENT_VISIBLE body with a mention written straight as `app_runtime` (insert and raise), and `mention_member_only` / `mention_member_once` refuse a contact row and a twin. `inbox-polish.dbtest.ts` now asserts `MENTIONED` is accepted (and a made-up reason still refused).
- **e2e** — `e2e/mentions.spec.ts`: on a task, type `@`, Escape closes the list and not the peek, pick a teammate, post — the chip shows the name; Escape cancels an in-place edit inside the peek; in Reply-to-client mode `@` opens no list. (The teammate's inbox is the dbtest's, not the browser's.)

## 5. Docs amended with the build

UI.md §5.6 (the shipped paragraph, and the stale "mention warning waits" line), §5.4's "no mentions yet"; DATA_MODEL §6.14 (`Mention` extracted on save; the two constraints) and the Comment note; SECURITY.md's mixed-visibility line (mentions are internal-only, held by the CHECK); ARCHITECTURE.md's mention-extension line; the `comments.ts` and `extensions.ts` headers; PLAN §0.

## 6. The migration's pre-apply review (a fresh agent) — dispositions

No HIGH, no MEDIUM. **LOW 1** (a trigger can be defeated by a later BEFORE trigger that sets `visibility` or `body`): TAKEN — a CHECK instead. **LOW 2** (the either-or CHECK accepted a contact-only row, which C101 (a) forbids): TAKEN — `mention_member_only`. **NIT 3** (the 128 KB bound is the service's, not the database's): TAKEN in the comment. **NIT 4** (reasons.ts and its two tests must change in the same commit): already so. **NIT 5** ("no CHECK is half-added" — the file is one transaction anyway): TAKEN in the comment. Applied to dev after the changes (`prisma migrate deploy`, 2026-10-16).

## 7. What the build changed (record)

- **Escape inside the peek, measured in a browser.** The first e2e run found that Escape did not close the `@` list: ProseMirror ignores every bubbling event that is already `defaultPrevented` (`eventBelongsToView`), and the sheet's `data-escape-local` contract works by PREVENTING the Escape in Radix's capture-phase hook. So no binding inside an editor in the peek — the suggestion plugin's own Escape, and the in-place comment edit's Escape-to-cancel shipped in slice 10 and never pressed by a test — ever ran. The editor now takes Escape at the WINDOW's capture phase (before the layer and ProseMirror) and prevents it there; AGENTS.md has the new standing trap; the e2e presses Escape in an in-place edit inside the peek.
- **The list is in the flow, not floating** — the section card clipped an absolutely placed list at its edge (the first e2e screenshot).
- **`@tiptap/suggestion@3.31.3`** added (exact, the editor's version); `@tiptap/extension-mention` is not used.

## 8. The slice reviews (fresh agents, read-only) — dispositions

**Code review** — no HIGH, no MEDIUM. TAKEN: a chip pasted without a valid `data-id` now pastes as text (a parse rule `getAttrs`), and the member-side renderer carries `data-id` so a copied chip pastes back as the mention; the list closes when mentions are switched off under it (Reply to client) and when focus leaves the box; a failed load says so ("Couldn't load your teammates…") instead of "No teammates match"; Escape during an IME composition is left alone; `aria-expanded` removed (Tiptap's field is a `textbox`); `@@unique(…, map: "mention_member_once")` modelled in `schema.prisma`; the design doc's wrong claims corrected; C44 marked superseded; a unit test pins the `TOO_MANY_MENTIONS` copy to `MENTION_MAX`. DISPOSITIONED: the pre-existing two-leg `Promise.all` in `resolveActorNames` (the diff adds no leg).

**Security review** — no HIGH, no MEDIUM; no path by which a member's name or id, or an internal body, reaches a contact. TAKEN: the `@` list also asks `member:view` (parity with the assignee picker for a custom role) — `listMentionable` and the panel's `caps.mention`; a clause in AGENTS.md's mutation rule (a mention is part of its comment); the `domain-error.ts` comment. ACCEPTED: the spam bound (20 people a comment, one unread notice per person and task, member addresses only — insider, attributable).

**Fix round 1** (one fresh agent) — no HIGH/MEDIUM. TAKEN: a composing Escape is now PREVENTED (it had reached the layer and closed the peek); the list's close on focus loss no longer fires on a window switch, nor collapses under a pointer mid-press; a failed load retries on a fresh `@`, not every keystroke; the list is offered only with `member:view` (so it is never a list that can only fail); the composer gets the thread's names. NIT accepted: the e2e cannot tell the two close paths apart in Chromium.

**Fix round 2** — TAKEN: macOS Safari/Firefox do not focus a clicked button, so "focus stayed inside" was the wrong test — a press that began inside the box is judged on its release; chip names are a prop of their own. ACCEPTED (NIT): Safari's 229 Escape after `compositionend` leaves ProseMirror's 500 ms composition window unreset.

**Fix round 3** — TAKEN: the close is watched as `focusout` on the box (a Tab out of the box after a Tab to the toggle now closes it), and a press-caused focus change is judged on release. Wording corrected. The rounds converged on cosmetic items; no further round run.

**Gates** (the implementing session; reviewers ran none): typecheck 0 · ESLint 0 · unit 199 files / 3 034 passed / 1 skipped · dbtests run locally against dev: `mentions` 11/11, `comments` + `work` 83 with `mentions`, `inbox-polish` + `portal-comment` + `visibility` + `push` 108 — the full `test:db` runs in CI from an empty database · `next build` green · e2e `mentions.spec.ts` + `item-comments.spec.ts` 3/3 on port 3457.
