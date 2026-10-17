import { recordMany, type AuditInput } from "@/audit/record";
import { assertInScope } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail, isDeadlock, isLockTimeout } from "@/lib/domain-error";
import { retryOnContention } from "@/lib/retry";

import { writeActivityMany } from "./activity";
import { BIN_PAGE_SIZE, binBlock, binOpen, binSince, type BinBlock } from "./bin-rules";
import { guardedRestore } from "./db-errors";
import { lockItemRow, lockProjectRanks } from "./rank-lock";
import { principalOf, type WorkCtx } from "./states";

/**
 * THE BIN FOR DELETED TASKS (slice 126, founder decision C102; design
 * `docs/research/2026-10-17-slice-126-task-bin-design.md`).
 *
 * A task deleted by hand stays in its project's bin for 30 days, and
 * whoever may delete it may bring it back — from the project's "Deleted
 * tasks" page or the Undo on "Task deleted" (C102 (a)). After 30 days it
 * leaves the bin and the row is KEPT (C102 (c)): erasing old deleted
 * tasks, their comments and files is its own later piece.
 *
 * IT COMES BACK PRIVATE (C102 (b)). A task the client could see returns
 * hidden from them, with everything its deletion took — its files and
 * every comment on it, on those files and on their versions, the client's
 * own words included — and a hand-over to someone at the client ends (the
 * hand-over CHECK insists a handed-over task is shared). Sharing it again
 * is a fresh decision; the next share raises the client's own comments on
 * the task back with it (C37, `follow-task.ts`), whatever lowered them.
 * The database holds the task's half for every writer: a work item
 * restored from deletion must land INTERNAL (`work_item_restore_guard`,
 * 20261030090000), and with the task private the comment and document
 * restore guards already refuse a client-visible child.
 *
 * WHAT THE DELETION TOOK is found by TWO keys, both required: the
 * deletion's one stamp (`deleteItem` stamps the task, its files and their
 * threads with ONE `deletedAt`), and the row's NEWEST deletion record
 * being the cascade's, naming the task (`comment.deleted` with reason
 * `work_item_deleted` / `document_deleted`, `document.deleted` with
 * `work_item_deleted`, each with `workItemId` — the record
 * `comments/cascade.ts` and `documents/service.ts` say an undo must
 * restore by). The stamp alone could take a comment deleted by hand in the
 * same millisecond — and a comment deleted by hand names its task too
 * (`removed_by_author`), so the REASON is what tells them apart (the
 * pre-apply review's LOW); the record alone could take a comment an
 * EARLIER deletion of the same task took, which came back with it and was
 * then deleted by hand — its old cascade record still names the task. The stamps
 * are compared IN SQL, against the task's own column, never round-tripped
 * through a JS Date (the timestamp-keyset trap).
 *
 * NOT IN THE BIN: a task removed by undoing an import that can still be
 * brought back (its newest `work_item.deleted` record says `reason:
 * "import_undone"`, and that import is UNDONE). The import's own row brings
 * those back, all at once; a second door would split that import's record,
 * and a few hundred of them would bury a task deleted by hand. Once the
 * import has been brought back, a task it skipped (a card imported again
 * meanwhile) IS in the bin — it has no other way back.
 *
 * THE ORDER (rank-lock.ts, THE ONE ORDER): the gate and the scope → the
 * project's rank queue (a restore share-locks the task's parent in the
 * restore guard, which makes it a writer of two rows — the guard
 * migration's own instruction) → the task's row → its files → their
 * comments, parents before children so each restore guard finds its
 * subject alive. Under a bounded lock wait with the contention retry: the
 * portal switch's fan-out updates a project's documents before its tasks,
 * dead rows included, so a cycle is possible, and the queue may be held
 * by a long bulk edit. A spent retry is TOLD (`BIN_BUSY`), never a 500.
 */

/** How long one statement may wait for a lock — the queue included — before the attempt is abandoned and retried. */
const BIN_LOCK_WAIT_MS = 5_000;
/** The whole transaction's budget: a task's thread can be long, and every write is set-based. */
const BIN_TX_MS = 30_000;

/** Where a restore came from — recorded on its audit row. */
export type RestoreVia = "bin" | "undo";

/** One row of a project's bin. */
export type BinEntry = {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly deletedAt: Date;
  /** The member who deleted it; null when the record names nobody this workspace still knows. */
  readonly deletedBy: string | null;
  /** Why Bring back is drawn disabled; null when it can be pressed. */
  readonly blocked: BinBlock | null;
};

export type BinPage = {
  readonly entries: readonly BinEntry[];
  /** More than `BIN_PAGE_SIZE` tasks are in the bin; the page shows the newest. */
  readonly more: boolean;
  readonly archived: boolean;
};

/** What a Bring back wrote. `changed: false` — the task was already back, and nothing was written. */
export type ItemRestored = {
  readonly id: string;
  readonly number: number;
  readonly changed: boolean;
  /** An Undo for a deletion that no longer stands — the task was brought back (and maybe deleted again) since. */
  readonly superseded: boolean;
  /** It was shared with the client when it was deleted, and came back private. */
  readonly madePrivate: boolean;
  /** It had been handed to someone at the client; that hand-over ended. */
  readonly endedContactAssignment: boolean;
  readonly files: number;
  readonly comments: number;
};

/**
 * The bin's codes, page and verb alike: the code that deleted the task, and
 * the code that lists tasks at all — a custom role holding only the first
 * must not read titles it could not list live (the security review's NIT).
 * In sequence, never legs of one `Promise.all` (AGENTS.md).
 */
async function requireBinCodes(tx: TenantDb, ctx: WorkCtx): Promise<void> {
  await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:delete");
  await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:view");
}

/** The page's gate: the codes, then the project in scope. */
async function gate(tx: TenantDb, ctx: WorkCtx, projectId: string): Promise<void> {
  await requireBinCodes(tx, ctx);
  await assertInScope(tx, ctx.actor, { projectId });
}

/**
 * The project's bin: tasks deleted by hand in the last 30 days, newest
 * first, each with who deleted it and whether it can be brought back now.
 */
export async function listDeletedItems(ctx: WorkCtx, projectId: string): Promise<BinPage> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await gate(tx, ctx, projectId);
    const project = await tx.project.findFirst({
      where: { tenantId: ctx.tenantId, id: projectId },
      select: { status: true },
    });
    if (!project) deny("NOT_FOUND");
    const archived = project!.status === "ARCHIVED";
    const now = new Date();
    // The newest `work_item.deleted` record per task — who, and whether it
    // was an undo of an import that can still be brought back (`fromImport`,
    // the header's rule) — and the same of a deleted parent. Ordered by the
    // record's own time and then its id (uuid v7), so two records in one
    // millisecond still have an order.
    const rows = await tx.$queryRaw<
      {
        id: string;
        number: number;
        title: string;
        deleted_at: Date;
        parent_number: number | null;
        parent_deleted_at: Date | null;
        parent_from_import: boolean | null;
        has_twin: boolean;
        actor_type: string | null;
        actor_id: string | null;
      }[]
    >`
      SELECT w.id, w.number, w.title, w.deleted_at,
             p.number AS parent_number, p.deleted_at AS parent_deleted_at,
             pa.from_import AS parent_from_import,
             (w.source_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM work_item t
                WHERE t.tenant_id = w.tenant_id AND t.project_id = w.project_id
                  AND t.source_system = w.source_system AND t.source_id = w.source_id
                  AND t.deleted_at IS NULL)) AS has_twin,
             a.actor_type, a.actor_id
        FROM work_item w
        LEFT JOIN work_item p ON p.tenant_id = w.tenant_id AND p.id = w.parent_id
        LEFT JOIN LATERAL (
          SELECT e.actor_type::text AS actor_type, e.actor_id,
                 coalesce(e.metadata->>'reason' = 'import_undone' AND EXISTS (
                   SELECT 1 FROM import_job j
                    WHERE j.tenant_id = e.tenant_id AND j.id = e.metadata->>'importJobId'
                      AND j.status = 'UNDONE'), false) AS from_import
            FROM audit_event e
           WHERE e.tenant_id = w.tenant_id AND e.target_type = 'WorkItem'
             AND e.target_id = w.id AND e.action = 'work_item.deleted'
           ORDER BY e.created_at DESC, e.id DESC
           LIMIT 1
        ) a ON true
        LEFT JOIN LATERAL (
          SELECT coalesce(e.metadata->>'reason' = 'import_undone' AND EXISTS (
                   SELECT 1 FROM import_job j
                    WHERE j.tenant_id = e.tenant_id AND j.id = e.metadata->>'importJobId'
                      AND j.status = 'UNDONE'), false) AS from_import
            FROM audit_event e
           WHERE p.deleted_at IS NOT NULL
             AND e.tenant_id = p.tenant_id AND e.target_type = 'WorkItem'
             AND e.target_id = p.id AND e.action = 'work_item.deleted'
           ORDER BY e.created_at DESC, e.id DESC
           LIMIT 1
        ) pa ON true
       WHERE w.tenant_id = ${ctx.tenantId} AND w.project_id = ${projectId}
         AND w.deleted_at IS NOT NULL AND w.deleted_at >= ${binSince(now)}
         AND NOT coalesce(a.from_import, false)
       ORDER BY w.deleted_at DESC, w.id DESC
       LIMIT ${BIN_PAGE_SIZE + 1}`;
    const page = rows.slice(0, BIN_PAGE_SIZE);
    const memberIds = [
      ...new Set(page.filter((r) => r.actor_type === "MEMBER" && r.actor_id !== null).map((r) => r.actor_id!)),
    ];
    const names = new Map(
      memberIds.length === 0
        ? []
        : (
            await tx.member.findMany({
              where: { tenantId: ctx.tenantId, id: { in: memberIds } },
              select: { id: true, user: { select: { name: true } } },
            })
          ).map((m) => [m.id, m.user.name]),
    );
    return {
      archived,
      more: rows.length > BIN_PAGE_SIZE,
      entries: page.map((r) => ({
        id: r.id,
        number: r.number,
        title: r.title,
        deletedAt: r.deleted_at,
        deletedBy: r.actor_type === "MEMBER" && r.actor_id !== null ? (names.get(r.actor_id) ?? null) : null,
        blocked: binBlock(
          {
            parent:
              r.parent_number === null
                ? null
                : { number: r.parent_number, deletedAt: r.parent_deleted_at, fromImport: r.parent_from_import === true },
            hasTwin: r.has_twin,
          },
          archived,
          now,
        ),
      })),
    };
  });
}

/**
 * Bring back one deleted task — from the bin (`via: "bin"`) or from the
 * Undo on "Task deleted" (`via: "undo"`); the same verb either way. A task
 * that is already back answers `changed: false` and writes nothing: a
 * second press of Undo, another tab, a colleague who got there first.
 *
 * AN UNDO NAMES THE DELETION IT UNDOES (`deletion`, the stamp the delete
 * returned): if the task has been brought back and deleted again since — a
 * colleague, another tab — the Undo is for a deletion that no longer
 * stands, and it answers `superseded` and writes nothing (the pre-apply
 * review's LOW). The stamp is a JS `Date` on both sides (`deleteItem` makes
 * it in JavaScript, at millisecond precision), so the comparison is exact.
 */
export async function restoreDeletedItem(
  ctx: WorkCtx,
  itemId: string,
  via: RestoreVia,
  deletion?: Date,
): Promise<ItemRestored> {
  try {
    return await retryOnContention(() =>
      withTenant(
        ctx.tenantId,
        principalOf(ctx),
        (tx) => guardedRestore(() => restoreIn(tx, ctx, itemId, via, deletion)),
        { timeoutMs: BIN_TX_MS, lockTimeoutMs: BIN_LOCK_WAIT_MS },
      ),
    );
  } catch (e) {
    // Both shapes `retryOnContention` retried (retry.ts), told rather than
    // thrown; the detail is the log's breadcrumb.
    if (isLockTimeout(e)) fail("BIN_BUSY", "lock timeout");
    if (isDeadlock(e)) fail("BIN_BUSY", "deadlock");
    throw e;
  }
}

async function restoreIn(
  tx: TenantDb,
  ctx: WorkCtx,
  itemId: string,
  via: RestoreVia,
  deletion: Date | undefined,
): Promise<ItemRestored> {
  const tenantId = ctx.tenantId;
  await requireBinCodes(tx, ctx);
  // The probe, unlocked: the queue's key is the row's own project, and the
  // queue comes before any row lock. Deleted or not — this verb's rows are
  // the deleted ones.
  const probe = await tx.workItem.findFirst({ where: { tenantId, id: itemId }, select: { projectId: true } });
  if (!probe) deny("NOT_FOUND");
  await assertInScope(tx, ctx.actor, { projectId: probe!.projectId });
  await lockProjectRanks(tx, probe!.projectId);
  // The row, locked, then read: what the UPDATE below replaces.
  await lockItemRow(tx, tenantId, itemId, "NO KEY UPDATE");
  const item = await tx.workItem.findFirst({
    where: { tenantId, id: itemId },
    select: {
      id: true,
      number: true,
      clientId: true,
      projectId: true,
      parentId: true,
      visibility: true,
      assigneeContactId: true,
      deletedAt: true,
      sourceSystem: true,
      sourceId: true,
    },
  });
  if (!item) deny("NOT_FOUND");
  const unchanged: ItemRestored = {
    id: item!.id,
    number: item!.number,
    changed: false,
    superseded: false,
    madePrivate: false,
    endedContactAssignment: false,
    files: 0,
    comments: 0,
  };
  if (item!.deletedAt === null) return unchanged;
  const task = item!;
  if (deletion !== undefined && task.deletedAt!.getTime() !== deletion.getTime()) {
    return { ...unchanged, superseded: true };
  }
  const now = new Date();
  if (!binOpen(task.deletedAt!, now)) fail("BIN_CLOSED");
  // How it was deleted: the newest record says. An import's undo brings its
  // tasks back from the import's own row while that import can still be
  // brought back (it is UNDONE); once it has been brought back, a task it
  // skipped — a card imported again meanwhile — has no other door than
  // this one (the pre-apply review's LOW).
  const record = await tx.auditEvent.findFirst({
    where: { tenantId, targetType: "WorkItem", targetId: task.id, action: "work_item.deleted" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { metadata: true },
  });
  const how = (record?.metadata ?? null) as { reason?: unknown; importJobId?: unknown } | null;
  if (how?.reason === "import_undone" && typeof how.importJobId === "string") {
    const job = await tx.importJob.findFirst({
      where: { tenantId, id: how.importJobId, status: "UNDONE" },
      select: { id: true },
    });
    if (job) fail("BIN_FROM_IMPORT");
  }
  const project = await tx.project.findFirst({ where: { tenantId, id: task.projectId }, select: { status: true } });
  if (project?.status === "ARCHIVED") fail("ARCHIVED");
  if (task.parentId !== null) {
    const parent = await tx.workItem.findFirst({
      where: { tenantId, id: task.parentId },
      select: { deletedAt: true },
    });
    // The restore guard share-locks the parent at the UPDATE and refuses a
    // dead one — the belt for a parent deleted after this read.
    if (parent?.deletedAt !== null) fail("BIN_PARENT_DELETED");
  }
  if (task.sourceSystem !== null && task.sourceId !== null) {
    // One LIVE task per project, source and card (the import's partial
    // unique index): a card imported again since must not be doubled. No
    // import writes here while this transaction holds the queue.
    const twin = await tx.workItem.findFirst({
      where: {
        tenantId,
        projectId: task.projectId,
        sourceSystem: task.sourceSystem,
        sourceId: task.sourceId,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (twin) fail("BIN_SOURCE_TWIN");
  }

  // WHAT THE DELETION TOOK — read before the task's stamp is cleared, both
  // keys compared in SQL (the header). Files first: their comments are
  // found through them.
  const files = await tx.$queryRaw<{ id: string; visibility: string }[]>`
    SELECT d.id, d.visibility::text AS visibility
      FROM document d
      JOIN work_item w ON w.tenant_id = d.tenant_id AND w.id = d.attached_to_id
     CROSS JOIN LATERAL (
       SELECT e.metadata FROM audit_event e
        WHERE e.tenant_id = d.tenant_id AND e.target_type = 'Document' AND e.target_id = d.id
          AND e.action = 'document.deleted'
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT 1
     ) last
     WHERE d.tenant_id = ${tenantId} AND w.id = ${task.id}
       AND d.attached_to_type = 'WORK_ITEM' AND d.deleted_at = w.deleted_at
       AND last.metadata->>'reason' = 'work_item_deleted' AND last.metadata->>'workItemId' = w.id`;
  const fileIds = files.map((f) => f.id);
  const comments = await tx.$queryRaw<{ id: string; visibility: string; subject_type: string; subject_id: string }[]>`
    SELECT c.id, c.visibility::text AS visibility, c.subject_type::text AS subject_type, c.subject_id
      FROM comment c
      JOIN work_item w ON w.tenant_id = c.tenant_id AND w.id = ${task.id}
     CROSS JOIN LATERAL (
       SELECT e.metadata FROM audit_event e
        WHERE e.tenant_id = c.tenant_id AND e.target_type = 'Comment' AND e.target_id = c.id
          AND e.action = 'comment.deleted'
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT 1
     ) last
     WHERE c.tenant_id = ${tenantId} AND c.deleted_at = w.deleted_at
       AND (   (c.subject_type = 'WORK_ITEM' AND c.subject_id = w.id)
            OR (c.subject_type = 'DOCUMENT' AND c.subject_id = ANY(${fileIds}::text[]))
            OR (c.subject_type = 'FILE_VERSION' AND c.subject_id IN (
                  SELECT v.id FROM file_version v
                   WHERE v.tenant_id = c.tenant_id AND v.document_id = ANY(${fileIds}::text[]))))
       AND last.metadata->>'reason' IN ('work_item_deleted', 'document_deleted')
       AND last.metadata->>'workItemId' = w.id`;

  // (1) The task — private, and a hand-over to the client ended in the same
  // statement (the CHECK: a handed-over task is a shared one).
  const madePrivate = task.visibility === "CLIENT_VISIBLE";
  const endedContactAssignment = task.assigneeContactId !== null;
  await tx.workItem.update({
    where: { id: task.id },
    data: {
      deletedAt: null,
      visibility: "INTERNAL",
      ...(endedContactAssignment ? { assigneeContactId: null, contactCompletedAt: null } : {}),
    },
    // INLINE, never select-less (the 512 KB description).
    select: { id: true },
  });
  // (2) Its files, then (3) their comments and the task's — the UPDATE's
  // own RETURNING is what is recorded, so nothing is claimed that this
  // transaction did not write.
  const filesBack = fileIds.length
    ? await tx.document.updateManyAndReturn({
        where: { tenantId, id: { in: fileIds }, deletedAt: { not: null } },
        data: { deletedAt: null, visibility: "INTERNAL" },
        select: { id: true },
      })
    : [];
  const commentIds = comments.map((c) => c.id);
  const commentsBack = commentIds.length
    ? await tx.comment.updateManyAndReturn({
        where: { tenantId, id: { in: commentIds }, deletedAt: { not: null } },
        data: { deletedAt: null, visibility: "INTERNAL" },
        select: { id: true },
      })
    : [];
  const fileWas = new Map(files.map((f) => [f.id, f.visibility]));
  const commentWas = new Map(comments.map((c) => [c.id, c]));

  // (4) History — make-private's shape, and only when something the client
  // could see came back private: the ended hand-over, the task's
  // visibility, each of the task's own comments that came back lowered.
  // Written against the post-update row (INTERNAL), which the activity
  // guard requires.
  const ref = { id: task.id, clientId: task.clientId, projectId: task.projectId, visibility: "INTERNAL" as const };
  const history: Parameters<typeof writeActivityMany>[2][number][] = [];
  if (madePrivate) {
    if (endedContactAssignment) {
      history.push({ item: ref, change: { field: "assigneeContactId", oldRef: task.assigneeContactId, newRef: null } });
    }
    history.push({ item: ref, change: { field: "visibility", oldValue: "CLIENT_VISIBLE", newValue: "INTERNAL" } });
  }
  for (const c of commentsBack) {
    const was = commentWas.get(c.id)!;
    if (was.subject_type !== "WORK_ITEM" || was.visibility !== "CLIENT_VISIBLE") continue;
    history.push({
      item: ref,
      change: { field: "commentVisibility", oldValue: "CLIENT_VISIBLE", newValue: "INTERNAL", commentId: c.id },
    });
  }
  await writeActivityMany(tx, ctx, history);

  // (5) The record — ids and flags (SECURITY.md §7). Every row the deletion
  // recorded gets a row saying it came back; `madePrivate` says what the
  // restore did to what the client could see.
  const trail: AuditInput[] = [
    {
      action: "work_item.restored",
      targetType: "WorkItem",
      targetId: task.id,
      metadata: {
        number: task.number,
        projectId: task.projectId,
        reason: via,
        files: filesBack.length,
        comments: commentsBack.length,
        ...(madePrivate ? { madePrivate: true } : {}),
        ...(endedContactAssignment ? { endedContactAssignment: true } : {}),
      },
    },
    ...filesBack.map(
      (d): AuditInput => ({
        action: "document.restored",
        targetType: "Document",
        targetId: d.id,
        metadata: {
          workItemId: task.id,
          projectId: task.projectId,
          ...(fileWas.get(d.id) === "CLIENT_VISIBLE" ? { madePrivate: true } : {}),
        },
      }),
    ),
    ...commentsBack.map((c): AuditInput => {
      const was = commentWas.get(c.id)!;
      return {
        action: "comment.restored",
        targetType: "Comment",
        targetId: c.id,
        metadata: {
          workItemId: task.id,
          projectId: task.projectId,
          ...(was.subject_type === "DOCUMENT" ? { documentId: was.subject_id } : {}),
          ...(was.subject_type === "FILE_VERSION" ? { fileVersionId: was.subject_id } : {}),
          ...(was.visibility === "CLIENT_VISIBLE" ? { madePrivate: true } : {}),
        },
      };
    }),
  ];
  await recordMany(tx, trail);

  return {
    id: task.id,
    number: task.number,
    changed: true,
    superseded: false,
    madePrivate,
    endedContactAssignment,
    files: filesBack.length,
    comments: commentsBack.length,
  };
}
