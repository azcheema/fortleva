# Slice 135 — schedule a progress update (founder decision C112)

*2026-10-18. Own-use item 7, the founder's pick over the recommended calendar feed. Four answers, all with the recommendation.*

## 1. The decision (C112)

- **(a) Locked until it goes out.** A scheduled update cannot be edited or discarded; **Unschedule** turns it back into a draft. Nobody's last-minute edit reaches the client unseen by the person who scheduled it — which matters because `project_update:create` (C M E) may edit any draft while only `:publish` (C M) may publish.
- **(b) The numbers are counted when it goes out** — exactly what pressing Publish at that moment would freeze. Cost and margin are left off a scheduled post: `rate:view_cost` is ✦ and needs a fresh factor at the moment of publishing, which a job never has.
- **(c) The hour you pick.** A day and a whole hour in the scheduler's own zone; it goes out with the hourly run (Vercel Cron at minute 7), a few minutes after.
- **(d) Told only if it couldn't go out** — an inbox row to the person who scheduled it.

## 2. Data

Three columns on `project_update` (migration `20261103090000_project_update_schedule`), all or none, on a DRAFT only (CHECKs):

| column | |
|---|---|
| `scheduled_for timestamptz` | the instant — a whole hour in the scheduler's zone, resolved by `localHourInstant` |
| `scheduled_by_member_id text` | who scheduled it; becomes `published_by_member_id` (attribution, no FK, like its neighbours) |
| `scheduled_visibility "Visibility"` | the audience chosen in the dialog — not `visibility`, which a draft may never hold (`project_update_visible_only_published`) |

A **lock trigger** (`project_update_schedule_lock`) refuses any change to the draft's content (health, title, period, body, body text) while `OLD.scheduled_for` is set and the row stays a draft — so the race the service's own check cannot close (an edit read before the schedule, written after it) is refused by the database (`UPDATE_SCHEDULED`). No delete guard: a trigger refusing a delete would break the project's cascade (the 2026-08-21 lesson); discard refuses in the service.

A partial index on `scheduled_for WHERE scheduled_for IS NOT NULL` serves the job's cross-tenant discovery. Publishing CLEARS the three columns, so no member id lingers on a row the portal can read.

## 3. Verbs (`src/modules/work/updates.ts`)

- **`scheduleUpdate(ctx, id, { visibility, date, hour, timeZone })`** — `project_update:publish` + scope (the act decides what a client reads, so it is the publish code); a DRAFT, not empty, project not archived; the instant after now and at most 90 days ahead; re-scheduling a scheduled draft moves its time. Audited `project_update.scheduled` (`scheduledFor`, `visibility`, and `movedFrom` when it moved).
- **`unscheduleUpdate(ctx, id)`** — `project_update:publish` + scope. Audited `project_update.unscheduled`.
- **Edit, discard and Publish now** refuse a scheduled draft (`UPDATE_SCHEDULED`).
- **Publish is factored**: the window, the snapshots and the compare-and-set write are one internal pair (`preparePublish` / `freezePublish`) shared by the member's Publish and the job's.

## 4. The job (`src/jobs/scheduled-updates.ts` → `publishScheduledUpdates` in `src/modules/work/scheduled-updates.ts`)

Hourly, right after the outbox drain, 45 s a kick, in every SENDING workspace holding a due scheduled update (discovery: one audited `withPlatform` read, ids only). Per update, under the workspace's SYSTEM principal:

1. **Re-read** the draft: still scheduled, still due, same `scheduled_for` and `updated_at` as found.
2. **Refusals** — each clears the schedule (the draft stays, unlocked), audits `project_update.schedule_failed` (SYSTEM; reason) and tells the scheduler (`project_update.schedule_failed`, inbox only, if still active):
   - `not_allowed` — the scheduler is not ACTIVE, or no longer holds `project_update:publish` on all four gates, or the project left their scope (resolved AS THEM inside the system transaction — the update reminders' precedent);
   - `archived` — the project is archived;
   - `empty` — nothing to publish (the lock makes this a belt);
   - `late` — more than 24 hours past its time (a job that did not run for a day must not send last week's update today).
3. **Publish** with the scheduler's figure codes (`time:view_team`, `budget:view`, `rate:view_bill` — never `rate:view_cost`), `publishedByMemberId` = the scheduler, the schedule columns cleared, audited `project_update.published` as SYSTEM with `scheduled: true`.

A transient error leaves the schedule in place for the next run. Two runs racing on one post produce one publish (the compare-and-set on `updated_at` + `status = 'DRAFT'`).

**Reminders** (`update-reminders.ts`): a project with a scheduled update that would count (a client-visible one while the portal is on) and goes out before the NEXT round's day (counted from the current round's own day, its reminder slot) is not reminded, nor badged due or late (§6–§8).

## 5. UI

- **Publish dialog**: a **When** choice — *Now* / *Later*; Later shows a day and an hour (00:00–23:00) with the zone named; the button reads **Schedule**.
- **A scheduled draft's page**: the post as it will read (no composer), a banner — "Scheduled for Mon 20 Oct, 09:00 · to the client · by Anna — the numbers are counted when it goes out" — and **Unschedule** (publish code).
- **The Updates list**: a *Scheduled* chip with the time instead of *Draft*.
- The inbox row: "A scheduled update couldn't go out", the project named, linking to its Updates tab.

## 6. Reviews (fresh agents, read-only) and dispositions

**Security** — no HIGH, no MEDIUM; nothing lets someone without `project_update:publish` reach a client, nothing lets a contact read a scheduled draft.
- L1 *Unschedule says "Unscheduled" over a post the job published a moment earlier* (the write waited on the job's lock and cleared nothing) — TAKEN: a zero-row clear re-reads; a published post is UPDATE_NOT_DRAFT, a moved one UPDATE_CHANGED, and the page refreshes to show what it is (Retract while open). Also the code review's M1.
- L2 *the schedule binds to the version the server reads, not the one the scheduler saved* — TAKEN, for Publish now too: the save returns `updatedAt` from the write (RETURNING); Schedule and Publish take `expectedUpdatedAt`.
- L3 *the private-work warning is never asked when the job publishes* — TAKEN: a CLIENT_VISIBLE post naming private work as a whole line is refused, `private_named` (`privateNamesIn`, `linesOfPost`).
- L4 *a banned user* — NOT APPLICABLE: `user.banned` is a dead column (the admin plugin that writes it is not mounted; `src/auth/index.ts`); a person taken off a workspace is SUSPENDED, which the job checks.
- L5 *a far-future schedule silences the reminders* — TAKEN (and the code review's M2): a schedule counts only when it goes out before the round's reminders end (`lastReminderDayOf`, `roundEndOf`).
- NITs: the unguarded halves are pinned by an AST import test (`publish-halves.test.ts`) — TAKEN; `scheduledBy` on the published, unscheduled and schedule_failed rows — TAKEN; `movedFrom` vs the design's word — TAKEN; the code-frame trap on the trigger token — TAKEN (matched on the RAISE's own text, no migration needed); "never mailed" — wording TAKEN (the opt-in summary counts it); the lock trigger without `edit_note` — ACCEPTED (only `annotateUpdate` writes it, on a PUBLISHED row; a second migration for an unreachable column is not worth it); the migration's name beside slice 102's — ACCEPTED (applied; renaming would break `_prisma_migrations`).

**Code** — no HIGH.
- M1 = security L1; M2 = security L5 — TAKEN.
- L1 the trigger token — TAKEN as above. L2 the banner promising a client read with the portal off — TAKEN (`bannerPortalOff`). L3 the picker's last day refused at a late hour — TAKEN (the 90 days are counted on the member's calendar, as the picker's `max`). L4 a closed work module would clear every schedule — TAKEN (the workspace is skipped; its posts wait).
- NITs: the toast after a clock change — TAKEN (formats the stored instant in the zone); a concurrent discard — TAKEN; the portal tripwire — TAKEN (`scheduledByMemberId`); `UPDATE_CHANGED`'s copy — TAKEN (generic); the dbtest's midnight — TAKEN (the day taken once); "never mailed" — TAKEN; **a held reminder mail released after a post is scheduled** (`src/jobs/outbox.ts`) — ACCEPTED: the reminder was owed when it was written, the case needs it enqueued, held overnight by quiet hours and a post scheduled before morning, and the drain's held-mail logic is shared by every kind.
- Untested, now tested: unschedule after the job published (through `loadUpdate`'s status read — the zero-row re-read itself is a lock race no dbtest can stage deterministically, so it stands on reading), scope loss, the owner's cost, private work, a closed module, a far-ahead schedule, the version token.

## 7. Narrow re-check of the fixes

- **M1 — the round window used the FIRST missed due day** (`owedAt`'s `dueOn` stays there until a post goes out), so from the second late round on no schedule silenced anything — a regression of the fix itself. TAKEN: the round is the reminder's slot (`o.slot`, `still.slot`; `readUpdateSchedule` computes it with `reminderSlotOn`); a dbtest two rounds late.
- **M2 — a schedule over the private-work warning was certain to be refused at go-out, with no reason shown.** TAKEN: `scheduleUpdate` refuses a CLIENT_VISIBLE post naming private work (`UPDATE_NAMES_PRIVATE`), and the dialog holds Schedule with a sentence saying why; Publish now stays advisory.
- L1 a hard break is a line to the editor and a space in `bodyText` — TAKEN: `linesOfPost` reads the section documents (`docText`). L2 the cap counted blank lines and paragraphs — TAKEN: candidates filtered, then capped. L3 the lock test matched `e.message` (the code-frame trap) — TAKEN, through the module's mapper; a fresh token passing — TAKEN; the zero-row re-read — stands on reading (above).
- NITs TAKEN: the catalog comment (private work; "told twice" corrected), this section §4, the halves test now sees `import *` / `export *`, a vanished row on Unschedule is NOT_FOUND.

## 8. Second narrow re-check

No HIGH or MEDIUM; every §7 fix confirmed.
- L1 *between rounds, a post scheduled for tomorrow could not quiet the late badge* (the round ended at its last reminder day, already past) — TAKEN, and the rule simplified for the job and the badge alike: a scheduled post is in hand when it goes out before the NEXT round's day (`nextRoundDayOf`), so the silence is bounded by one cadence period, never by the reminder window.
- L2 *the job's skip had no dbtest* — TAKEN: `update-reminders.dbtest.ts` "a scheduled post and the reminders", on its 2031 clock with the schedule written directly.
- NITs TAKEN: the "next update due" line hidden too (documented), `export * as` and `.js` specifiers in the halves test, the blocked sentence tied to Schedule by `aria-describedby`, the Swedish. ACCEPTED: the dialog's block has no e2e (the server's refusal is dbtested; the dialog reads the same open-time check as the existing warning).
