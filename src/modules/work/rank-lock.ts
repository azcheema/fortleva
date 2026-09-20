import type { TenantDb } from "@/db";
import { rankBetween } from "@/lib/rank";

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
 * bulk edits (the whole selection) and a subtask's raise to
 * CLIENT_VISIBLE (its own row, then the parent the tree trigger
 * share-locks) — and re-reads, after the wait, whatever it read before
 * it (moveItem's pattern). None of them locks rows in tree order — a
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
 *     project_time_summary, time_report — each in scan order. Joining
 *     THIS queue covers exactly one of those ten legs: milestones queue
 *     on `milestone_rank:` and the other eight tables have no queue at
 *     all. And the cost falls in the worst possible place. Turning a
 *     project's portal OFF is the emergency "stop showing this client
 *     our data" switch, and inside `withTenant`'s 5 s interactive budget
 *     an unbounded wait on a queue a bulk edit is holding turns that
 *     switch into a P2028 failure. A control that must work when it is
 *     needed does not get to wait on a board drag. It takes a deadlock
 *     RETRY instead (`src/projects/service.ts`), which covers all ten
 *     legs and costs nothing when there is no contention. NOT a full
 *     answer even so: a bulk edit holding `FOR NO KEY UPDATE` makes the
 *     fan-out BLOCK rather than cycle, and that ends as a P2028 timeout
 *     which no retry here matches (PLAN §0).
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
 * ABLE TO DEADLOCK WITH EACH OTHER, NEVER WITH THE QUEUE — and that
 * second half rests entirely on no queued writer ever locking a document
 * or comment row, so re-check it before putting anything in the queue
 * that does. The portal toggle would have locked both, which is one of
 * the reasons it stayed out. The pair: deleteItem,
 * which locks its item and then the item's attachments and comments,
 * against an attachment's visibility flip, which locks the attachment
 * and then the item through document_anchor_guard — deleteItem writes
 * only deleted_at, so it never takes a second work_item row and no
 * queued writer ever locks a document or comment row.
 */

export async function lockProjectRanks(tx: TenantDb, projectId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`work_rank:${projectId}`}))`;
}

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
