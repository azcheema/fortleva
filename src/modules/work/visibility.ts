import { recordMany, type AuditInput } from "@/audit/record";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { DomainError, fail, isDeadlock, isLockTimeout } from "@/lib/domain-error";
import { retryOnContention } from "@/lib/retry";

import { writeActivityMany } from "./activity";
import { probeSelection } from "./bulk";
import { guarded } from "./db-errors";
import { raiseClientCommentsWithTask } from "./follow-task";
import { changeItemVisibility, type VisibilityCommitted } from "./items";
import { lockProjectRanks } from "./rank-lock";
import { principalOf, type WorkCtx } from "./states";

/**
 * THE SHARING UI's SERVER HALF (Phase 3 slice 72; founder decisions
 * C35–C37, 2026-09-28): "make private with N children" and the backlog
 * selection bar's two visibility verbs.
 *
 * WHY A CASCADE EXISTS AT ALL. The database refuses to make a task
 * private while anything directly under it — a subtask, a comment, an
 * attached file — is still CLIENT_VISIBLE (`work_item_visibility_
 * downgrade_guard`, 20260911200000), and it checks DIRECT children only
 * and counts ARCHIVED ones (it filters `deleted_at` alone). A file in turn
 * refuses while a client-visible comment sits on it or on one of its
 * versions (`document_visibility_downgrade_guard`). So "make this task
 * private" was a chore the member had to do bottom-up by hand, and for a
 * client's own comment it was impossible: no member verb may hide a
 * contact's words (`setCommentVisibility`). DATA_MODEL §10 has promised
 * the one-step version since 2W: children first, deepest first, one
 * transaction, audited. AUTHZ.md gives the whole of it to
 * `work_item:change_visibility` — the files and the comments included,
 * the way a task's delete cascade runs under the task's delete code —
 * so the documents module's switches and codes are deliberately NOT
 * asked here: a tenant with documentation turned off must still be able
 * to take a task off its client's screen.
 *
 * MAKING SOMETHING PRIVATE MUST ALWAYS WORK (items.ts: "the safety
 * lever"). Three consequences shape this file:
 *   · No cap. Every write is set-based — a fixed number of statements
 *     per depth whatever the count, one history batch, one audit batch —
 *     so a long-lived task with a thousand client comments goes private
 *     as surely as a fresh one. (A cap was designed and refused by
 *     review: its refusal would have had no action the member could
 *     take, since a contact's comment cannot be lowered one at a time.)
 *   · The closure is FROZEN before it is written: every task in it is
 *     locked FOR NO KEY UPDATE first, which blocks every writer that
 *     could hang a new client-visible child under it (a comment insert
 *     or raise, an attachment, a subtask raise — each takes FOR SHARE on
 *     the task, or queues). After that the set can only shrink, so the
 *     downgrade trigger at the end cannot meet a surprise child.
 *   · `makeItemPrivate` — the rail's and the backlog cell's one door —
 *     tries the plain one-row flip FIRST (unqueued: a task with nothing
 *     under it never waits on the project's queue) and falls back to the
 *     cascade when the database says something is still visible below,
 *     including a child that arrived after the member's preview.
 *
 * LOCK ORDER, and why a retry is required rather than optional. A
 * cascade is a multi-row work_item writer, so it takes the project's
 * queue first (rank-lock.ts) — then tasks (root first, level by level),
 * then files, then comments. Three writers outside the queue lock the
 * other way round and can close a cycle with it: a FILE flip locks the
 * document and then share-locks its task (`document_anchor_guard`), the
 * portal switch's fan-out updates `document` before `work_item` in scan
 * order, and `releaseContactAssignments` updates every task a contact
 * holds in one statement. No order satisfies them all (rank-lock.ts
 * records the pre-existing deleteItem-versus-file-flip cycle). Postgres
 * breaks a cycle by aborting one side (40P01); this side retries, with a
 * bounded lock wait so it cannot sit on the queue behind a long bulk
 * edit, and a spent retry is TOLD — `VISIBILITY_BUSY`, nothing written —
 * never a 500. (Comment edits and deletes are not in that list: the
 * comment trigger fires only on `UPDATE OF subject_type, subject_id,
 * parent_id, visibility`, and their only lock on the task is the history
 * row's FOR KEY SHARE, which does not conflict.)
 */

/** How long one statement may wait for a lock — the queue included — before the attempt is abandoned and retried. */
const VISIBILITY_LOCK_WAIT_MS = 5_000;
/** The whole transaction's budget: the bulk verbs' (bulk.ts), and a closure is at most three levels of set writes. */
const VISIBILITY_TX_MS = 60_000;

/** Depth of the work-item tree: EPIC → TASK → SUBTASK (a CHECK caps `depth` at 2). */
const MAX_DEPTH = 2;

/** What a make-private of this selection would take out of the client's view — counts only. */
export type PrivacyPreview = {
  /** The project's portal switch: with it off the client sees nothing today, and the question says so. */
  portalEnabled: boolean;
  /** Selected tasks the client can see now. */
  tasks: number;
  /** Selected tasks already private (nothing to do for them). */
  alreadyPrivate: number;
  /** Client-visible tasks below the selected ones (any depth, archived included — the database counts them). */
  below: number;
  /** Client-visible comments on all of those tasks and on their files — the client's own words included (C37). */
  comments: number;
  /** Client-visible files attached to all of those tasks. */
  files: number;
  /** Of all the tasks going private, those handed to someone at the client — they come off that person's list. */
  handedOver: number;
  /** Of the files, those waiting for the client's sign-off — the ask is hidden with the file, not withdrawn. */
  awaitingSignoff: number;
};

/** What `makePrivateWithChildren` actually wrote — counted from the rows each UPDATE returned. */
export type MakePrivateResult = {
  /** Selected tasks made private by this call. */
  tasks: number;
  /** Selected tasks that were already private. */
  alreadyPrivate: number;
  below: number;
  comments: number;
  files: number;
  endedContactAssignments: number;
};

/** What `bulkShare` wrote. */
export type BulkShareResult = {
  /** Tasks shared by this call. */
  changed: number;
  /** Selected tasks that were already shared. */
  skipped: number;
  /** The client's own comments that came back with their tasks (C37). */
  clientComments: number;
};

type ClosureItem = {
  id: string;
  clientId: string;
  projectId: string;
  depth: number;
  assigneeContactId: string | null;
};

const ITEM_SELECT = {
  id: true,
  clientId: true,
  projectId: true,
  depth: true,
  visibility: true,
  assigneeContactId: true,
} as const;

/**
 * The client-visible LIVE tasks below `parents`, level by level, LOCKED
 * before they are read when `lock` is set. Each level's rows can only be
 * added by a queued writer (a create, a subtask's raise, a subtask's
 * hand-over) or by a restore under a parent it must share-lock — both
 * blocked while the caller holds the queue and the parents — so reading a
 * level after locking the one above it reads a set that can only shrink.
 * `exclude` keeps a task that is ALSO a selected root (a bulk selection
 * holding a parent and its child) from being counted or written twice.
 */
async function visibleBelow(
  tx: TenantDb,
  tenantId: string,
  projectId: string,
  parents: readonly string[],
  exclude: ReadonlySet<string>,
  lock: boolean,
): Promise<ClosureItem[]> {
  const found: ClosureItem[] = [];
  let frontier = [...parents];
  for (let level = 1; level <= MAX_DEPTH && frontier.length > 0; level++) {
    const where = {
      tenantId,
      projectId,
      parentId: { in: frontier },
      deletedAt: null,
      visibility: "CLIENT_VISIBLE" as const,
    };
    let rows: ClosureItem[];
    if (lock) {
      const candidates = await tx.workItem.findMany({ where, select: { id: true } });
      const ids = candidates.map((c) => c.id).filter((id) => !exclude.has(id));
      if (ids.length === 0) break;
      await tx.$queryRaw`
        SELECT 1 FROM work_item
         WHERE tenant_id = ${tenantId} AND project_id = ${projectId}
           AND id = ANY(${ids}::text[]) AND deleted_at IS NULL
         FOR NO KEY UPDATE`;
      // Re-read under the lock: a colleague's single make-private may
      // have landed while this waited, and a row already private is not
      // this call's to write or to claim.
      rows = await tx.workItem.findMany({
        where: { tenantId, projectId, id: { in: ids }, deletedAt: null, visibility: "CLIENT_VISIBLE" },
        select: ITEM_SELECT,
      });
    } else {
      rows = (await tx.workItem.findMany({ where, select: ITEM_SELECT })).filter((r) => !exclude.has(r.id));
    }
    found.push(...rows);
    frontier = rows.map((r) => r.id);
  }
  return found;
}

/** The client-visible live files attached to `itemIds` — locked when asked. */
async function visibleFiles(
  tx: TenantDb,
  tenantId: string,
  itemIds: readonly string[],
  lock: boolean,
): Promise<{ id: string; attachedToId: string; pending: boolean }[]> {
  if (itemIds.length === 0) return [];
  if (lock) {
    const rows = await tx.$queryRaw<{ id: string; attached_to_id: string; approval_status: string }[]>`
      SELECT id, attached_to_id, approval_status::text AS approval_status FROM document
       WHERE tenant_id = ${tenantId}
         AND attached_to_type = 'WORK_ITEM'
         AND attached_to_id = ANY(${itemIds as string[]}::text[])
         AND visibility = 'CLIENT_VISIBLE'
         AND deleted_at IS NULL
       FOR NO KEY UPDATE`;
    return rows.map((r) => ({ id: r.id, attachedToId: r.attached_to_id, pending: r.approval_status === "PENDING" }));
  }
  const rows = await tx.document.findMany({
    where: {
      tenantId,
      attachedToType: "WORK_ITEM",
      attachedToId: { in: [...itemIds] },
      visibility: "CLIENT_VISIBLE",
      deletedAt: null,
    },
    select: { id: true, attachedToId: true, approvalStatus: true },
  });
  return rows.map((r) => ({ id: r.id, attachedToId: r.attachedToId!, pending: r.approvalStatus === "PENDING" }));
}

/** The OR-arms matching every comment under the closure: on its tasks, on their files, on those files' versions. */
async function commentSubjects(
  tx: TenantDb,
  tenantId: string,
  itemIds: readonly string[],
  fileIds: readonly string[],
) {
  const versions = fileIds.length
    ? await tx.fileVersion.findMany({
        where: { tenantId, documentId: { in: [...fileIds] } },
        select: { id: true, documentId: true },
      })
    : [];
  const arms = [
    ...(itemIds.length ? [{ subjectType: "WORK_ITEM" as const, subjectId: { in: [...itemIds] } }] : []),
    ...(fileIds.length ? [{ subjectType: "DOCUMENT" as const, subjectId: { in: [...fileIds] } }] : []),
    ...(versions.length ? [{ subjectType: "FILE_VERSION" as const, subjectId: { in: versions.map((v) => v.id) } }] : []),
  ];
  return { arms, versionDocument: new Map(versions.map((v) => [v.id, v.documentId])) };
}

/**
 * previewMakePrivate — the COUNTS the member is asked about before the
 * cascade runs: "Make 3 tasks private, with 2 tasks under them, 5
 * comments and 1 file?" Read-only, one transaction, no locks, no queue.
 *
 * The same gate as the write (`work_item:change_visibility` alone) and
 * the same scope-FILTERED selection (`probeSelection`): an id outside the
 * member's scope is absent, never a separate answer, and every row
 * counted below it lives in the one project the scope check passed. The
 * write never trusts these numbers — it recomputes the closure under its
 * locks and reports what it actually did; this is only what to ASK.
 * Reads run in sequence: never a leg of a `Promise.all` on the one
 * transaction (AGENTS.md).
 */
export async function previewMakePrivate(ctx: WorkCtx, itemIds: readonly string[]): Promise<PrivacyPreview> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    const { projectId, where } = await probeSelection(tx, ctx, itemIds, "work_item:change_visibility");
    const project = await tx.project.findFirst({ where: { tenantId: ctx.tenantId, id: projectId }, select: { portalEnabled: true } });
    const roots = await tx.workItem.findMany({ where, select: ITEM_SELECT });
    const visibleRoots = roots.filter((r) => r.visibility === "CLIENT_VISIBLE");
    const rootIds = new Set(roots.map((r) => r.id));
    const below = await visibleBelow(tx, ctx.tenantId, projectId, visibleRoots.map((r) => r.id), rootIds, false);
    const closure = [...visibleRoots, ...below];
    const itemIdsAll = closure.map((i) => i.id);
    const files = await visibleFiles(tx, ctx.tenantId, itemIdsAll, false);
    const { arms } = await commentSubjects(tx, ctx.tenantId, itemIdsAll, files.map((f) => f.id));
    const comments = arms.length
      ? await tx.comment.count({
          where: { tenantId: ctx.tenantId, deletedAt: null, visibility: "CLIENT_VISIBLE", OR: arms },
        })
      : 0;
    return {
      portalEnabled: project?.portalEnabled ?? false,
      tasks: visibleRoots.length,
      alreadyPrivate: roots.length - visibleRoots.length,
      below: below.length,
      comments,
      files: files.length,
      handedOver: closure.filter((i) => i.assigneeContactId !== null).length,
      awaitingSignoff: files.filter((f) => f.pending).length,
    };
  });
}

/** Runs one visibility transaction with the bounded wait and the retry; a spent retry becomes VISIBILITY_BUSY. */
async function contended<T>(ctx: WorkCtx, body: (tx: TenantDb) => Promise<T>): Promise<T> {
  try {
    return await retryOnContention(() =>
      withTenant(ctx.tenantId, principalOf(ctx), (tx) => guarded(() => body(tx)), {
        timeoutMs: VISIBILITY_TX_MS,
        lockTimeoutMs: VISIBILITY_LOCK_WAIT_MS,
      }),
    );
  } catch (e) {
    // BOTH shapes `retryOnContention` retried (retry.ts: a caller that
    // translates only one leaves the other to arrive as a 500). The
    // detail is the log's breadcrumb; the member reads `t(code)`.
    if (isLockTimeout(e)) fail("VISIBILITY_BUSY", "lock timeout");
    if (isDeadlock(e)) fail("VISIBILITY_BUSY", "deadlock");
    throw e;
  }
}

/**
 * makePrivateWithChildren — the cascade. Every selected task the client
 * can see goes private, with everything below it the client can see:
 * the tasks under it (any depth, archived included), every comment on
 * them — the client's own included (C37) — every file attached to them,
 * and every comment on those files and their versions. Children first,
 * deepest first, in one transaction; each write's own RETURNING is what
 * the history and the audit trail are built from, so no row is claimed
 * that this call did not write. A task handed to someone at the client
 * comes off their list in the same statement (the contact-assignee CHECK
 * — `changeItemVisibility`'s 6c rule, applied per row).
 *
 * A pending sign-off on a file is HIDDEN with the file, never withdrawn —
 * what `documents.changeVisibility` has always done to a single file.
 */
export async function makePrivateWithChildren(
  ctx: WorkCtx,
  itemIds: readonly string[],
): Promise<MakePrivateResult> {
  const r = await contended(ctx, (tx) => cascade(tx, ctx, itemIds));
  return {
    tasks: r.tasks,
    alreadyPrivate: r.alreadyPrivate,
    below: r.below,
    comments: r.comments,
    files: r.files,
    endedContactAssignments: r.endedContactAssignments,
  };
}

/** The cascade's result, plus the ROOTS whose own hand-over it ended — what the single-task door reports. */
type CascadeWritten = MakePrivateResult & { endedRootIds: string[] };

async function cascade(tx: TenantDb, ctx: WorkCtx, itemIds: readonly string[]): Promise<CascadeWritten> {
  const tenantId = ctx.tenantId;
  const { projectId, ids, where } = await probeSelection(tx, ctx, itemIds, "work_item:change_visibility");
  // The queue first (rank-lock.ts, THE ONE ORDER): this is a writer of
  // many work_item rows, and holding the queue is also what stops a new
  // client-visible subtask being created or raised under the closure.
  await lockProjectRanks(tx, projectId);
  // The roots, locked then read — the queue's own rule.
  await tx.$queryRaw`
    SELECT 1 FROM work_item
     WHERE tenant_id = ${tenantId} AND project_id = ${projectId}
       AND id = ANY(${ids}::text[]) AND deleted_at IS NULL
     FOR NO KEY UPDATE`;
  const roots = await tx.workItem.findMany({ where, select: ITEM_SELECT });
  // Every row died between the probe and the lock (deleted in another
  // tab): the probe's own answer, as `loadSelection` gives it.
  if (roots.length === 0) return deny("NOT_FOUND");
  const visibleRoots = roots.filter((r) => r.visibility === "CLIENT_VISIBLE");
  const empty: CascadeWritten = {
    tasks: 0,
    alreadyPrivate: roots.length,
    below: 0,
    comments: 0,
    files: 0,
    endedContactAssignments: 0,
    endedRootIds: [],
  };
  if (visibleRoots.length === 0) return empty;

  const rootIds = new Set(roots.map((r) => r.id));
  const below = await visibleBelow(tx, tenantId, projectId, visibleRoots.map((r) => r.id), rootIds, true);
  const closure: ClosureItem[] = [...visibleRoots, ...below];
  const closureIds = closure.map((i) => i.id);
  const byId = new Map(closure.map((i) => [i.id, i]));

  // Files, locked. Then the comments' subjects — the files' versions are
  // read AFTER the files are locked, so a new version cannot land between
  // (adding one updates its document, which waits on this lock).
  const files = await visibleFiles(tx, tenantId, closureIds, true);
  const fileIds = files.map((f) => f.id);
  const { arms, versionDocument } = await commentSubjects(tx, tenantId, closureIds, fileIds);

  // (a) Every comment — leaves, so first. The UPDATE is also the SELECT
  // (src/comments/cascade.ts): the rows it returns ARE the rows lowered.
  // `comment_denorm_guard` takes no lock on the subject for a row written
  // INTERNAL on the subject it already had.
  const comments = arms.length
    ? await tx.comment.updateManyAndReturn({
        where: { tenantId, deletedAt: null, visibility: "CLIENT_VISIBLE", OR: arms },
        data: { visibility: "INTERNAL" },
        select: { id: true, subjectType: true, subjectId: true },
      })
    : [];
  // (b) The files — their comments are private now, so their own guard
  // passes; `document_anchor_guard`'s FOR SHARE on the task is ours.
  const lowered = fileIds.length
    ? await tx.document.updateManyAndReturn({
        where: { tenantId, id: { in: fileIds }, visibility: "CLIENT_VISIBLE", deletedAt: null },
        data: { visibility: "INTERNAL" },
        select: { id: true, attachedToId: true },
      })
    : [];
  // (c) The tasks, deepest first: each level's downgrade guard finds
  // every direct child already private. Two statements per level — a
  // task handed to a client contact loses the assignment and its claim in
  // the same statement, or the contact-assignee CHECK refuses the row.
  const flipped: (ClosureItem & { endedAssignment: boolean })[] = [];
  for (let depth = MAX_DEPTH; depth >= 0; depth--) {
    const level = closure.filter((i) => i.depth === depth);
    if (level.length === 0) continue;
    const handed = level.filter((i) => i.assigneeContactId !== null).map((i) => i.id);
    const plain = level.filter((i) => i.assigneeContactId === null).map((i) => i.id);
    if (handed.length) {
      const rows = await tx.workItem.updateManyAndReturn({
        where: { tenantId, id: { in: handed }, visibility: "CLIENT_VISIBLE", deletedAt: null },
        data: { visibility: "INTERNAL", assigneeContactId: null, contactCompletedAt: null },
        // INLINE, never select-less (the 512 KB description).
        select: { id: true },
      });
      for (const r of rows) flipped.push({ ...byId.get(r.id)!, endedAssignment: true });
    }
    if (plain.length) {
      const rows = await tx.workItem.updateManyAndReturn({
        where: { tenantId, id: { in: plain }, visibility: "CLIENT_VISIBLE", deletedAt: null },
        data: { visibility: "INTERNAL" },
        select: { id: true },
      });
      for (const r of rows) flipped.push({ ...byId.get(r.id)!, endedAssignment: false });
    }
  }

  // History, ONE statement (activity.ts `writeActivityMany`). Written
  // AFTER the UPDATEs and against the post-update row: the activity
  // guard re-reads the task's live visibility and refuses a client-
  // visible row on a private task (items.ts, slice 6c — the lever once
  // rolled itself back this way). Per task: the ended hand-over first,
  // then the visibility row, the order the panel reads them in. Then the
  // task comments. File flips write no task history — a single file's
  // flip writes none either.
  const history: Parameters<typeof writeActivityMany>[2][number][] = [];
  for (const i of flipped) {
    const ref = { id: i.id, clientId: i.clientId, projectId: i.projectId, visibility: "INTERNAL" as const };
    if (i.endedAssignment) {
      history.push({ item: ref, change: { field: "assigneeContactId", oldRef: i.assigneeContactId, newRef: null } });
    }
    history.push({ item: ref, change: { field: "visibility", oldValue: "CLIENT_VISIBLE", newValue: "INTERNAL" } });
  }
  for (const c of comments) {
    if (c.subjectType !== "WORK_ITEM") continue;
    const i = byId.get(c.subjectId);
    if (!i) continue;
    history.push({
      item: { id: i.id, clientId: i.clientId, projectId: i.projectId, visibility: "INTERNAL" },
      change: { field: "commentVisibility", oldValue: "CLIENT_VISIBLE", newValue: "INTERNAL", commentId: c.id },
    });
  }
  await writeActivityMany(tx, ctx, history);

  const rootsFlipped = flipped.filter((i) => rootIds.has(i.id)).length;
  const belowFlipped = flipped.length - rootsFlipped;
  const ended = flipped.filter((i) => i.endedAssignment).length;
  const trail: AuditInput[] = [];
  // The operation's own row, ids and counts only (SECURITY.md §7), the
  // way the rank rebalance writes `work_item.bulk_edited` — unless all it
  // did was one task with nothing under it, which is the single flip in
  // everything but name and is audited exactly as that one is.
  if (flipped.length > 1 || comments.length > 0 || lowered.length > 0) {
    trail.push({
      action: "work_item.bulk_edited",
      targetType: "Project",
      targetId: projectId,
      metadata: {
        projectId,
        reason: "make_private",
        tasks: rootsFlipped,
        below: belowFlipped,
        comments: comments.length,
        files: lowered.length,
        endedContactAssignments: ended,
      },
    });
  }
  for (const i of flipped) {
    trail.push({
      action: "work_item.visibility_changed",
      targetType: "WorkItem",
      targetId: i.id,
      metadata: {
        from: "CLIENT_VISIBLE",
        to: "INTERNAL",
        projectId,
        via: "cascade",
        ...(i.endedAssignment ? { endedContactAssignment: true } : {}),
      },
    });
  }
  for (const c of comments) {
    const subject =
      c.subjectType === "WORK_ITEM"
        ? { workItemId: c.subjectId }
        : c.subjectType === "DOCUMENT"
          ? { documentId: c.subjectId }
          : { fileVersionId: c.subjectId, documentId: versionDocument.get(c.subjectId) ?? null };
    trail.push({
      action: "comment.visibility_changed",
      targetType: "Comment",
      targetId: c.id,
      metadata: { from: "CLIENT_VISIBLE", to: "INTERNAL", projectId, via: "cascade", ...subject },
    });
  }
  for (const d of lowered) {
    trail.push({
      action: "document.visibility_changed",
      targetType: "Document",
      targetId: d.id,
      metadata: { from: "CLIENT_VISIBLE", to: "INTERNAL", via: "cascade", workItemId: d.attachedToId },
    });
  }
  await recordMany(tx, trail);

  return {
    tasks: rootsFlipped,
    alreadyPrivate: roots.length - rootsFlipped,
    below: belowFlipped,
    comments: comments.length,
    files: lowered.length,
    endedContactAssignments: ended,
    endedRootIds: flipped.filter((i) => i.endedAssignment && rootIds.has(i.id)).map((i) => i.id),
  };
}

/** What `makeItemPrivate` hands the rail and the backlog cell: the single flip's contract, plus what else went private. */
export type ItemPrivateCommitted = VisibilityCommitted & {
  /** Null when the plain flip was enough; the cascade's counts when it was not. */
  alsoPrivate: Pick<MakePrivateResult, "below" | "comments" | "files" | "endedContactAssignments"> | null;
};

/**
 * makeItemPrivate — THE ONE DOOR for making a single task private, from
 * the item panel's `V` and the backlog's cell. It must never fail on
 * something the member can do nothing about, so it tries the plain
 * one-row flip first — unqueued, the lever `changeItemVisibility` has
 * always been — and when the database answers that something below is
 * still client-visible (`HAS_VISIBLE_CHILDREN`), runs the cascade in a
 * fresh transaction. The surfaces ASK first when their preview counts
 * something below; this fallback is what makes the answer hold even
 * when the preview was stale — a client comment posted in between, or a
 * reversal picked while a share was still in flight (a share raises the
 * client's comments back, C37, so the plain lower behind it would meet
 * them).
 */
export async function makeItemPrivate(ctx: WorkCtx, itemId: string): Promise<ItemPrivateCommitted> {
  try {
    const c = await changeItemVisibility(ctx, itemId, "INTERNAL");
    return { ...c, alsoPrivate: null };
  } catch (e) {
    if (!(e instanceof DomainError) || e.code !== "HAS_VISIBLE_CHILDREN") throw e;
  }
  const r = await contended(ctx, (tx) => cascade(tx, ctx, [itemId]));
  return {
    id: itemId,
    visibility: "INTERNAL",
    // THIS task's own hand-over — the surface names the task in front of
    // the member; the ones below it are in `alsoPrivate`.
    endedContactAssignment: r.endedRootIds.includes(itemId),
    changed: r.tasks > 0,
    // What ELSE went private — the tasks, comments and files below it,
    // and the hand-overs that ended BELOW it. This task's own is
    // `endedContactAssignment`, above; counting it twice here would say a
    // subtask came off a client's list when none did.
    alsoPrivate: {
      below: r.below,
      comments: r.comments,
      files: r.files,
      endedContactAssignments: r.endedContactAssignments - r.endedRootIds.length,
    },
  };
}

/**
 * bulkShare — the selection bar's "Show to client" (C35). Every selected
 * PRIVATE task becomes CLIENT_VISIBLE; nothing below it moves (a child
 * keeps its own visibility — inheritance is a default at creation, never
 * live), and nothing ABOVE it is shared behind the member's back: a
 * selected task whose parent is private and not selected refuses the
 * whole batch (`PARENT_NOT_VISIBLE` — the service checks first; the
 * tree trigger is the belt). A parent and its child selected together
 * are shared parent first, so the trigger finds the parent shared.
 *
 * The client's own comments come back with each task (C37,
 * follow-task.ts). ALL OR NOTHING, like every bulk verb (bulk.ts).
 */
export async function bulkShare(ctx: WorkCtx, itemIds: readonly string[]): Promise<BulkShareResult> {
  return contended(ctx, async (tx) => {
    const tenantId = ctx.tenantId;
    const { projectId, ids, where } = await probeSelection(tx, ctx, itemIds, "work_item:change_visibility");
    await lockProjectRanks(tx, projectId);
    await tx.$queryRaw`
      SELECT 1 FROM work_item
       WHERE tenant_id = ${tenantId} AND project_id = ${projectId}
         AND id = ANY(${ids}::text[]) AND deleted_at IS NULL
       FOR NO KEY UPDATE`;
    const rows = await tx.workItem.findMany({
      where,
      select: { ...ITEM_SELECT, parentId: true },
    });
    if (rows.length === 0) return deny("NOT_FOUND");
    const toShare = rows.filter((r) => r.visibility === "INTERNAL");
    if (toShare.length === 0) return { changed: 0, skipped: rows.length, clientComments: 0 };
    const sharing = new Set(toShare.map((r) => r.id));
    // REFUSE-UP. The parents outside the selection, share-locked before
    // they are read, so a colleague's make-private of one cannot land
    // between this check and the UPDATE (it waits for this transaction;
    // the tree trigger would share-lock the parent anyway).
    const outsideParents = [
      ...new Set(toShare.map((r) => r.parentId).filter((p): p is string => p !== null && !sharing.has(p))),
    ];
    if (outsideParents.length) {
      await tx.$queryRaw`
        SELECT 1 FROM work_item
         WHERE tenant_id = ${tenantId} AND id = ANY(${outsideParents}::text[])
         FOR SHARE`;
      const parents = await tx.workItem.findMany({
        where: { tenantId, id: { in: outsideParents } },
        select: { id: true, visibility: true, deletedAt: true },
      });
      if (parents.some((p) => p.visibility !== "CLIENT_VISIBLE" || p.deletedAt !== null)) {
        fail("PARENT_NOT_VISIBLE", "a selected task's parent is private and not selected");
      }
    }
    // Parent first: depth 0, then 1, then 2.
    const shared: typeof toShare = [];
    for (let depth = 0; depth <= MAX_DEPTH; depth++) {
      const level = toShare.filter((r) => r.depth === depth).map((r) => r.id);
      if (level.length === 0) continue;
      const done = await tx.workItem.updateManyAndReturn({
        where: { tenantId, id: { in: level }, visibility: "INTERNAL", deletedAt: null },
        data: { visibility: "CLIENT_VISIBLE" },
        select: { id: true },
      });
      const doneIds = new Set(done.map((d) => d.id));
      shared.push(...toShare.filter((r) => doneIds.has(r.id)));
    }
    // The share's history rows are INTERNAL whatever the task's visibility
    // now: `visibility` is not a portal-safe field (activity.ts).
    await writeActivityMany(
      tx,
      ctx,
      shared.map((r) => ({
        item: { id: r.id, clientId: r.clientId, projectId: r.projectId, visibility: "CLIENT_VISIBLE" as const },
        change: { field: "visibility", oldValue: "INTERNAL", newValue: "CLIENT_VISIBLE" },
      })),
    );
    await recordMany(tx, [
      {
        action: "work_item.bulk_edited",
        targetType: "Project",
        targetId: projectId,
        metadata: { projectId, reason: "share", count: shared.length },
      },
      ...shared.map(
        (r): AuditInput => ({
          action: "work_item.visibility_changed",
          targetType: "WorkItem",
          targetId: r.id,
          metadata: { from: "INTERNAL", to: "CLIENT_VISIBLE", projectId, bulk: true },
        }),
      ),
    ]);
    const clientComments = await raiseClientCommentsWithTask(tx, ctx, shared, "bulk_share");
    return { changed: shared.length, skipped: rows.length - shared.length, clientComments };
  });
}
