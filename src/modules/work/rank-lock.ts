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
 * KNOWN LOCKERS OUTSIDE THE QUEUE, all older than it, and nothing
 * retries a deadlock (40P01) yet — PLAN §0. Able to deadlock WITH a
 * queued writer: the portal toggle's fan-out (every row of the project,
 * scan order), and inserts that REFERENCE several work items in one
 * transaction (copyWeek — each time_entry's foreign key takes FOR KEY
 * SHARE on its item, in date order, and a rank UPDATE is a key update).
 * Able to deadlock with EACH OTHER, never with the queue: deleteItem,
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
 * The mode a writer's own UPDATE will take on the row: FOR NO KEY UPDATE
 * when no column it writes is in a unique index (a field edit, a state
 * change, an assignment, a visibility flip, an archive), FOR UPDATE when
 * it writes `rank` or `number` (a move). A lock taken in the weaker mode
 * would UPGRADE under the stronger UPDATE — so the writer says which.
 */
export type RowLockMode = "NO KEY UPDATE" | "UPDATE";

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
  // Two statements rather than one interpolated clause: a lock mode is
  // SQL syntax, and `$queryRaw` binds values, never keywords.
  if (mode === "UPDATE") {
    await tx.$queryRaw`SELECT 1 FROM work_item WHERE tenant_id = ${tenantId} AND id = ${itemId} FOR UPDATE`;
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
