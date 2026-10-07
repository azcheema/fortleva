import type { TenantDb } from "@/db";
import { rankBetween } from "@/lib/rank";
import { lockContactBudget } from "@/portal/contact-budget-lock";

/**
 * The project's rank lock and the locked neighbour reads (ARC-17),
 * shared by create (items.ts) and move/rebalance (ordering.ts) so every
 * writer of a rank serialises on the same advisory transaction lock —
 * under READ COMMITTED a row lock alone does not refresh the statement
 * snapshot, so two "bottom" writers would otherwise mint the same key.
 *
 * Neighbour reads include SOFT-DELETED rows on purpose: they keep their
 * slot under the unique `(tenant_id, project_id, rank)` index for the
 * 30-day window, so a key generated as if they were gone would collide
 * (2026-08-21 review) — they are simply invisible rows that still
 * occupy a position. Only an ANCHOR the client names must be live.
 *
 * SECOND JOB (2026-09-11): the project's row-lock queue. Every WORK
 * service that locks more than one work_item row of a project takes this
 * lock before its first row lock — create (a subtask's parent, then the
 * bottom row), move and rebalance (anchors, neighbours, every rank), the
 * bulk edits (the whole selection), a subtask's raise to CLIENT_VISIBLE
 * (its own row, then the parent the tree trigger share-locks) and — since
 * slice 6c — a subtask's CONTACT ASSIGNMENT, whether or not it raises
 * anything — and re-reads, after the wait, whatever it read before it
 * (moveItem's pattern).
 *
 * **THAT LAST ONE IS THE TRAP THIS PARAGRAPH NOW EXISTS TO CLOSE.**
 * `work_item_parent_guard` fires on `BEFORE UPDATE OF … visibility`,
 * and Postgres fires `UPDATE OF` on SET-LIST MEMBERSHIP, not on the
 * value moving. `assignItemToContact` always writes
 * `visibility: 'CLIENT_VISIBLE'` — forced by the contact-assignee CHECK
 * — so for a subtask the guard share-locks the parent EVERY time,
 * including when the row was already client-visible and no raise
 * happens at all. Its first cut therefore conditioned the queue on the
 * row's CURRENT visibility and skipped it in exactly that case; a code
 * review caught it. **Condition a queue decision on what your statement
 * WRITES, never on what the row currently holds** — the latter is read
 * before any lock and can go stale under you. None of them locks rows in tree order — a
 * move goes by rank in either direction, a bulk edit by scan order — so
 * no order could be imposed; queued, no two of them ever hold rows at
 * once, and a writer of ONE work_item row cannot close a cycle among
 * work_item rows with them. A new multi-row writer MUST take it.
 * (lockItemRow, below, is the lock a writer of ONE row takes instead.)
 *
 * THE ONE ORDER, stated once (slice 7): a queued writer PROBES its item
 * unlocked first (`loadItemInScope(…, { lock: false })`, rows.ts) —
 * the queue key is the row's own projectId, and the queue must precede
 * every row lock — then takes this lock, then its locked, scoped read of
 * the same row, then the rest. A writer of one row that never queues
 * skips the probe and the queue and takes its locked, scoped read at
 * once; changeItemVisibility probes in every branch, because only the
 * probe says whether this flip is a subtask's raise that must queue.
 * Either way the diff is taken from a row read AFTER every wait, and a
 * member the scope check refuses holds a row lock only until the
 * rollback.
 *
 * KNOWN LOCKERS OUTSIDE THE QUEUE, all older than it. A deadlock
 * (40P01) IS retried as of 2026-09-19 — `ordering.ts`'s
 * `retryOnRankCollision` takes `isDeadlock` beside `isUniqueViolation`,
 * which is a cure and not a cure-all: a retry is three more chances at
 * the same race, not a proof — and only one side of each cycle below
 * actually has one. Each was re-verified on 2026-09-20 against the
 * migrations rather than trusted; none is closed.
 *
 * ALL THREE ARE STILL OPEN, deliberately, with what each would cost
 * written down so the next session does not re-derive it. The portal
 * toggle was TRIED in the queue on 2026-09-20 and the attempt is kept
 * here because the reason it failed is the interesting part:
 *   • the portal toggle's fan-out. `setPortalEnabled` writes one
 *     `project` row and `project_portal_enabled_fanout` turns it into
 *     TEN mass UPDATEs — milestone, project_version, service, document,
 *     work_item, work_item_activity, comment, search_index,
 *     project_time_summary, time_report — each in scan order (ELEVEN
 *     since `project_update` joined the fan-out in 20260925200000; "ten"
 *     below is the count this was argued on, and the argument stands). Joining
 *     THIS queue covers exactly one of those ten legs: milestones queue
 *     on `milestone_rank:` and the other eight tables have no queue at
 *     all. And the cost falls in the worst possible place. Turning a
 *     project's portal OFF is the emergency "stop showing this client
 *     our data" switch, and an unbounded wait on a queue a bulk edit is
 *     holding turns that switch into a timeout. A control that must
 *     work when it is needed does not get to wait on a board drag. It
 *     takes a RETRY instead (`src/projects/service.ts`), which covers
 *     all ten legs and costs nothing when there is no contention.
 *     Slice 43 (2026-09-20) finished the job the deadlock retry could
 *     not: a bulk edit holding `FOR NO KEY UPDATE` makes the fan-out
 *     BLOCK rather than cycle, so there is no 40P01 to match and no
 *     retry here ever applied. THIS LIST SAID THAT WAIT ENDED AT
 *     `withTenant`'s 5 s budget AS A P2028, AND THAT WAS WRONG —
 *     measured in `portal-contention.dbtest.ts`, a blocked fan-out with
 *     a 3 s budget was still waiting past 30 s, because Prisma's
 *     transaction timeout does not reach into a statement the database
 *     has parked. The switch now passes `lockTimeoutMs`, so the wait
 *     ends as a 55P03 `retryOnContention` retries and, if every attempt
 *     is spent, the member is told (PORTAL_SWITCH_BUSY) instead of
 *     holding this project's locks until something upstream gives up.
 *     Still a cure and not a prevention: the cycle below is unchanged.
 *   • copyWeek — each time_entry's foreign key takes FOR KEY SHARE on
 *     its item, in the plan's DATE order, and a rank UPDATE is a key
 *     update. It cannot join the queue as cheaply: one copy can span
 *     SEVERAL projects, so it would need every touched project's lock,
 *     taken in a deterministic (sorted) order or it makes a new cycle
 *     among copies — and it would then block every rank writer in all of
 *     them for the length of the copy. That is a real contention change
 *     on a path nothing here can measure, against a race that has never
 *     been observed. It takes `retryOnDeadlock` instead, as of
 *     2026-09-20 — before that nothing under `src/modules/time` tested
 *     for a deadlock at all, so only the rank writer on the other side
 *     recovered and a copy chosen as the victim came back a 500 with the
 *     week uncopied. BOTH sides retry now; neither prevents.
 *     A review found a SECOND multi-row `time_entry` writer this list
 *     had never named while checking that one: `repriceRateCard` reads
 *     by `startedAt` but writes one `updateMany` per distinct resulting
 *     snapshot, so its lock order is the GROUPING's — two reprices over
 *     overlapping entries can cycle with each other, nothing to do with
 *     ranks. It takes the same retry. The lesson for whoever edits this
 *     list: it names the lockers someone thought to look for.
 *   • deleteItem against an attachment's visibility flip (below). The
 *     lock the flip takes is REAL and takes two migrations to see: the
 *     anchor carries no foreign key — `(attachedToType, attachedToId)`
 *     is a presentation pointer and authorization never traverses it —
 *     and `document_anchor_guard` v1 read the item with a plain SELECT,
 *     which takes nothing. `document_anchor_guard_v2` added `FOR SHARE
 *     OF wi` to close a write-skew, and THAT is the lock. Reading v1
 *     alone says this cycle does not exist; it does.
 * ABLE TO DEADLOCK WITH EACH OTHER — and, SINCE PHASE 3 SLICE 72, WITH
 * THE QUEUE TOO. The sentence that stood here said "never with the
 * queue", resting on no queued writer ever locking a document or comment
 * row. The sharing UI's cascade (`visibility.ts`, `makePrivateWithChildren`)
 * is a queued writer that DOES: queue → the closure's tasks (root first,
 * level by level) → their attached documents → the comments on all of
 * them. That order FREEZES the closure (every writer that could hang a new
 * client-visible child under a locked task takes FOR SHARE on it, or
 * queues), which is what makes the make-private lever always work — and
 * no order could satisfy every locker outside the queue anyway, because
 * they disagree among themselves:
 *   • an attachment's visibility flip (`documents.changeVisibility`)
 *     locks the DOCUMENT, then the task (`document_anchor_guard`'s
 *     FOR SHARE) — the reverse of the cascade's task → document;
 *   • the portal switch's fan-out updates `document` before `work_item`,
 *     in scan order (the first bullet above);
 *   • `releaseContactAssignments` updates every task a contact holds in
 *     ONE unqueued statement, in scan order, against the cascade's
 *     level-by-level order.
 * Each cycle is detected by Postgres (40P01) and the cascade RETRIES
 * (`retryOnContention`, with a bounded lock wait, and a spent retry is
 * `VISIBILITY_BUSY`, never a 500). THE OTHER SIDES RETRY TOO, since the
 * same slice: the portal switch (`retryOnContention`, PORTAL_SWITCH_BUSY),
 * the attachment flip (`documents.changeVisibility`, `retryOnDeadlock`,
 * VISIBILITY_BUSY) and the contact revoke that wraps the release
 * (`setContactPortalAccess`, `retryOnDeadlock`, CONTACT_ACCESS_BUSY) —
 * the first cut of slice 72 left the last two unretried, so a revoke that
 * lost to a cascade was a 500 with the access still live (review). The
 * cascade-versus-release cycle is NEW in slice 72: make-private used to
 * lock one row. Comment EDITS and DELETES are not
 * in the list — the comment trigger fires only on `UPDATE OF
 * subject_type, subject_id, parent_id, visibility`, and their only lock
 * on the task is the history row's FOR KEY SHARE, which conflicts with
 * nothing here. `changeItemVisibility`'s raise also locks comment rows
 * now (a client's own comments follow the task, C37, follow-task.ts) —
 * task first, then comment, the order every comment writer keeps.
 *
 * THE PORTAL SWITCH GATE, SINCE SLICE 74 (C40; migration
 * `20260928180000`, `src/projects/portal-gate.ts`), changes this list in
 * three places:
 *   • the switch now WAITS FIRST on the project's gate, for every write
 *     already in flight that stamped one of the project's rows — a
 *     queued writer that inserts a stamped row (createItem's task, the
 *     activity rows the bulk verbs and the cascade write) holds the gate
 *     SHARED to its commit. The gate itself closes no cycle: the switch
 *     takes it before it has written or row-locked anything (the SQL
 *     refuses a transaction that already has an xid; it cannot see an
 *     advisory lock taken earlier, so that half of the order is the
 *     code's), and a stamp never waits on it — it TRIES, and writes
 *     `false` when it cannot. So the gate adds no wait and no cycle for
 *     any writer except the request broker, which waits on it
 *     deliberately (bounded; REQUEST_BUSY when spent), and the fan-out's
 *     row locks block and deadlock with the lockers above exactly as
 *     before. The cost: a stamped writer now delays the switch until it
 *     commits — the bulk verbs and the cascade can be long — bounded by
 *     the switch's lock wait per attempt, then PORTAL_SWITCH_BUSY.
 *   • THE RECONCILE (`portal_switch_reconcile`) is a new locker outside
 *     the queue: its own transactions after the switch's, once per call,
 *     as the SYSTEM principal — up to three passes, each retried on a
 *     lock timeout or deadlock whatever the switch's outcome (an OFF
 *     skips only the drain) — which take the gate shared and then
 *     re-derive every row of the
 *     project whose copy disagrees, on the fan-out's eleven tables in the
 *     fan-out's order. It never waits on a SOURCE row a writer holds —
 *     each leg selects `FOR NO KEY UPDATE SKIP LOCKED`, reports what it
 *     skipped and retries in a later pass — but its document / work_item
 *     / comment legs fire the search feeds, and a feed's `search_index`
 *     upsert CAN wait: on a concurrent reconcile's `search_index` leg
 *     (itself SKIP LOCKED, so it waits on nobody and closes no cycle),
 *     and on the next entry.
 *   • `restampSearchLang` (`src/search/rebuild.ts` — a tenant's locale
 *     change, under `updatePreferences`) is a locker outside the queue
 *     this list never named: ONE unqueued `UPDATE search_index … WHERE
 *     tenant_id = …` that locks the tenant's search rows in scan order
 *     WITHOUT their source rows. A reconcile's feed upsert can wait on
 *     it, and with two or more stale rows the two can close a 40P01
 *     cycle. The reconcile's side retries (`retryOnContention`, every
 *     pass, in every mode); the locale save's does not, so a victim there is a raw error on a save
 *     that rolled back cleanly and succeeds when repeated. Pre-existing
 *     with the switch's own fan-out, whose feeds can make the same cycle
 *     (the switch retries); recorded, not fixed.
 *   • THE LOGIN FEED, since Phase 3V slice 97 (`search_feed_credential_item`,
 *     migration `20261007120000`): a login write that changes what it is
 *     found by (name, username, address, tags, anchor, the bin) locks the
 *     `credential_item` row, then its `search_index` row. It fires on no
 *     other column — deliberately not `updated_at` (the pre-apply review) —
 *     so the multi-row login writers (the offboarding flags on a member's
 *     removal, `offboarding.ts` — named there only, by the vault boundary
 *     test's caller pin — and `hideEveryShownLogin` when client logins are
 *     switched off) lock no
 *     index row and close no cycle with the fan-out's search leg or the
 *     restamp. ONE residual: a single `updatePreferences` save that changes
 *     the language (`restampSearchLang` holds every search row) AND switches
 *     client logins off (`hideEveryShownLogin` then wants each shown login's
 *     row) against a concurrent write to one SHOWN login that holds its row
 *     and then wants its search row — an edit of its name, username, address
 *     or tags (`updateCredential`), or binning it (`deleteCredential`, whose
 *     `deleted_at` fires the feed's delete). Postgres breaks it (40P01). The
 *     login side retries — both run in `boundedVaultWrite` (`updateCredential`
 *     since slice 97, for this), VAULT_BUSY when spent; the save does not,
 *     and its victim is a raw error on a save that rolled back cleanly.
 *     Recorded, not fixed: it needs both settings in one save during that
 *     write.
 *
 * The older pair: deleteItem,
 * which locks its item and then the item's attachments and comments,
 * against an attachment's visibility flip, which locks the attachment
 * and then the item through document_anchor_guard — deleteItem writes
 * only deleted_at, so it never takes a second work_item row. The flip's
 * side of it retries since slice 72; deleteItem's side still does not,
 * and a victim there is still an unmapped error (a recorded residual,
 * PLAN §0's slice-72 entry).
 *
 * TWO APPLIED MIGRATIONS SAY OTHERWISE AND MUST NOT BE EDITED (an
 * applied migration's checksum is fixed):
 *   • `20260911200000_work_tree_guards` argues against making
 *     make-private a multi-row writer that queues behind creates, moves
 *     and bulk edits. Slice 72 does exactly that — for the CASCADE only;
 *     the single make-private (`changeItemVisibility`) still never
 *     queues, and `makeItemPrivate` tries it first — and the bounded wait
 *     is the answer to that migration's concern.
 *   • `20260915120000_comment_guard_lock_and_activity_id_index` says "No
 *     work service that queues on the project's rank lock ever locks a
 *     comment row". False since slice 72: the cascade, `bulkShare` and a
 *     subtask's raise (through follow-task.ts) all do — task first, then
 *     comment, the order every comment writer keeps.
 * This comment and PLAN §0's slice-72 entry are where both supersessions
 * are recorded.
 *
 * A QUEUED WRITER FROM ANOTHER MODULE, since slice 72: the time reports'
 * publish check (`assertNamesStillShared`) share-locks the tasks a report
 * names, and their parents and roots, root first — behind THIS queue, so
 * it cannot cycle with a bulk edit or the cascade; `publishReport`
 * retries a deadlock with the unqueued lockers above.
 *
 * SINCE 6c A QUEUED WRITER ALSO TOUCHES A `contact` ROW — the foreign
 * key on `assignee_contact_id` takes `FOR KEY SHARE` on it — so the
 * sentence above needed checking rather than extending. It closes no
 * cycle: `deleteContact` locks the contact row and then takes only
 * `FOR KEY SHARE` on `work_item` through the same FK, which does not
 * conflict with the `NO KEY UPDATE` a queued writer holds, and nothing
 * else locks a contact and then a work item. Setting the column to NULL
 * takes no lock on `contact` at all.
 */

export async function lockProjectRanks(tx: TenantDb, projectId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`work_rank:${projectId}`}))`;
}

/**
 * THE PORTAL INTAKE'S BUDGET LOCK, and the database's own clock with it
 * (Phase 3 slice 6a).
 *
 * It is here and not in `requests.ts` for two reasons, one of them
 * structural. The honest one: this file is where every
 * `pg_advisory_xact_lock` in the product lives, and a fourth key taken
 * somewhere else is a lock nobody reviewing the lock order would find.
 * (Corrected 2026-09-28, slice 74: it never quite was — `milestone_rank:`
 * is taken in `src/projects/milestones.ts` and the time module's
 * `tenant:member` in `src/modules/time/ctx.ts` — and since the files
 * slice the budget statement itself lives in
 * `src/portal/contact-budget-lock.ts`. Slice 74's portal switch gate
 * lives in SQL, below.)
 * The structural one: `requests.ts` is scanned by the portal tripwire's
 * AST tier (`src/authz/portal-projections.test.ts`), which bans raw SQL
 * outright — "raw SQL has no allow-list a reader can check" — and a
 * file the tripwire cannot read is a file the tripwire does not cover.
 *
 * **IT IS NOT A RANK LOCK AND IT SHARES THE SAME KEY SPACE.** The
 * single-argument `pg_advisory_xact_lock` has ONE 64-bit space; the
 * `portal_request:` / `work_rank:` / `milestone_rank:` prefixes change
 * the hash INPUT, not the namespace, and `hashtext` is 32-bit, so two
 * unrelated keys can collide. (A first draft of this comment claimed a
 * namespace of its own — a code review caught it, and it is the repo's
 * recurring finding: the documents disagreeing with the code.) The
 * consequence is benign — a collision serialises two unrelated waiters
 * and nothing more — and the CYCLE conclusion is unaffected for a
 * better reason: the intake takes this key BEFORE the project's rank
 * key and nothing anywhere takes them in the other order.
 *
 * THE ONE ADVISORY KEY OUTSIDE THAT SPACE (slice 74, C40): the portal
 * switch GATE uses the TWO-int4 form — `pg_advisory_xact_lock(int4,
 * int4)` and its shared and try variants — which is a separate space
 * (`pg_locks.objsubid` 2, not 1), keyed on the high and low halves of a
 * 64-bit `hashtextextended` of the project id, so it cannot collide with
 * any key above. It is taken in SQL — the stamp and heal triggers, the
 * fan-out, the reconcile (migration `20260928180000`) — and wrapped for
 * application code by `src/projects/portal-gate.ts`, never here. Its
 * order against these keys: the switch, the reconcile and the request
 * broker take it before any write or row lock — the SQL refuses a
 * transaction that already has an xid, and that is ALL it can check: an
 * advisory lock assigns no xid, so it cannot see this budget key or the
 * rank queue taken earlier. The intake's order — the gate, then this
 * budget key, then the rank queue — is kept by the code
 * (`createPortalRequest`), not by the database; keep it. A stamp only
 * tries the gate, wherever it falls, and never waits on it.
 *
 * THE CLOCK RIDES ALONG because it costs nothing to return it from the
 * statement that takes the lock, and because the alternative compares
 * two clocks: `work_item.created_at` is stamped by Postgres, so a
 * window computed from a serverless instance's `Date.now()` silently
 * narrows when that instance runs fast and widens when it runs slow,
 * with nothing failing either way.
 */
export const lockContactRequestBudget = (tx: TenantDb, contactId: string): Promise<Date> =>
  // The statement itself lives in core since the portal files slice
  // (2026-09-27): the download budget needed the same lock, and one raw
  // statement in one place beats two copies of the CTE trick and its
  // caveats. The key is unchanged — `portal_request:<contactId>`.
  lockContactBudget(tx, "portal_request", contactId);

/**
 * The mode a writer takes on an item row. For a writer of THAT row it is
 * the mode its own UPDATE will take: FOR NO KEY UPDATE when no column it
 * writes is in a unique index (a field edit, a state change, an
 * assignment, a visibility flip, an archive), FOR UPDATE when it writes
 * `rank` or `number` (a move) — a lock taken in the weaker mode would
 * UPGRADE under the stronger UPDATE, so the writer says which. "SHARE"
 * is the third kind: the lock of a writer of ANOTHER table's row that
 * must hold the item still while it writes — a subtask's parent
 * (createItem), a comment's task (comments.ts, slice 10) — taken BEFORE
 * the child row, which is the order deleteItem takes them in.
 */
export type RowLockMode = "NO KEY UPDATE" | "UPDATE" | "SHARE";

/**
 * Row-lock ONE item before it is read (rows.ts `loadItemInScope` is the
 * caller). Under READ COMMITTED a wait refreshes only the statement that
 * waited; the read AFTER this is a new statement, so it sees whatever
 * committed meanwhile, and a diff taken from it describes the row
 * version the UPDATE replaces.
 *
 * FOR NO KEY UPDATE is the lock of a writer of ONE work_item row (the
 * header): never the rank lock, never a second work_item row after it.
 * FOR UPDATE is the move's, taken on its own row AFTER the queue lock and
 * BEFORE its neighbours (slice 7, PLAN §0). Two consequences: a
 * state-only move now waits on a FOR KEY SHARE holder of its row — a
 * time entry being written against the item (the foreign key's lock,
 * held to that transaction's commit) — where its NO KEY UPDATE never
 * did, a wait of milliseconds, accepted; and the copyWeek cycle the
 * header lists is NOT removed, only turned around: the move waits on its
 * own row while holding no other, but once it holds that row and waits
 * on a neighbour copyWeek already key-shares, copyWeek's next entry can
 * wait on the moved item — the same known locker outside the queue, and
 * nothing retries 40P01 yet. It lives here, with the queue lock, because
 * the two are one story (THE ONE ORDER, above); rows.ts is its caller.
 */
export async function lockItemRow(
  tx: TenantDb,
  tenantId: string,
  itemId: string,
  mode: RowLockMode = "NO KEY UPDATE",
): Promise<void> {
  // Three statements rather than one interpolated clause: a lock mode is
  // SQL syntax, and `$queryRaw` binds values, never keywords.
  // FOR SHARE is the lock of a writer of ANOTHER table's row that must
  // hold the item still while it writes — a subtask's parent (createItem),
  // a comment's task (comments.ts) — taken BEFORE the child row, which is
  // the order deleteItem takes them in, so no cycle closes; it never
  // conflicts with another share, so two comments on one task land
  // together, and it waits on exactly the writers it exists to wait for:
  // the item's make-private and its delete.
  if (mode === "UPDATE") {
    await tx.$queryRaw`SELECT 1 FROM work_item WHERE tenant_id = ${tenantId} AND id = ${itemId} FOR UPDATE`;
  } else if (mode === "SHARE") {
    await tx.$queryRaw`SELECT 1 FROM work_item WHERE tenant_id = ${tenantId} AND id = ${itemId} FOR SHARE`;
  } else {
    await tx.$queryRaw`SELECT 1 FROM work_item WHERE tenant_id = ${tenantId} AND id = ${itemId} FOR NO KEY UPDATE`;
  }
}

export type Neighbour = { id: string; rank: string };

/** One LIVE row of the project (an anchor the client named), locked; null when absent. */
export async function lockLiveRow(
  tx: TenantDb,
  tenantId: string,
  projectId: string,
  id: string,
): Promise<Neighbour | null> {
  const rows = await tx.$queryRaw<Neighbour[]>`
    SELECT id, rank FROM work_item
    WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND id = ${id} AND deleted_at IS NULL
    FOR UPDATE`;
  return rows[0] ?? null;
}

/** The row directly after `rank` in the project order (live or deleted), excluding `exceptId`, locked. */
export async function lockSuccessor(
  tx: TenantDb,
  tenantId: string,
  projectId: string,
  rank: string | null,
  exceptId: string,
): Promise<Neighbour | null> {
  const rows =
    rank === null
      ? await tx.$queryRaw<Neighbour[]>`
          SELECT id, rank FROM work_item
          WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND id <> ${exceptId}
          ORDER BY rank ASC LIMIT 1 FOR UPDATE`
      : await tx.$queryRaw<Neighbour[]>`
          SELECT id, rank FROM work_item
          WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND id <> ${exceptId} AND rank > ${rank}
          ORDER BY rank ASC LIMIT 1 FOR UPDATE`;
  return rows[0] ?? null;
}

/** The row directly before `rank` (live or deleted), excluding `exceptId`, locked; null rank = the project's last row. */
export async function lockPredecessor(
  tx: TenantDb,
  tenantId: string,
  projectId: string,
  rank: string | null,
  exceptId: string,
): Promise<Neighbour | null> {
  const rows =
    rank === null
      ? await tx.$queryRaw<Neighbour[]>`
          SELECT id, rank FROM work_item
          WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND id <> ${exceptId}
          ORDER BY rank DESC LIMIT 1 FOR UPDATE`
      : await tx.$queryRaw<Neighbour[]>`
          SELECT id, rank FROM work_item
          WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND id <> ${exceptId} AND rank < ${rank}
          ORDER BY rank DESC LIMIT 1 FOR UPDATE`;
  return rows[0] ?? null;
}

/** The key for a new row at the bottom of the project — the caller holds the project rank lock. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export async function bottomRank(tx: TenantDb, tenantId: string, projectId: string): Promise<string> {
  const last = await lockPredecessor(tx, tenantId, projectId, null, NIL_UUID);
  return rankBetween(last?.rank ?? null, null);
}
