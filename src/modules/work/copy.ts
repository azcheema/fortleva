import { recordMany, type AuditInput } from "@/audit/record";
import { assertInScope } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { lockCounter, nextCounters, withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail, isDeadlock, isLockTimeout } from "@/lib/domain-error";
import { newId } from "@/lib/ids";
import { ranksBetween } from "@/lib/rank";
import { REPEAT_MAX_DESCRIPTION_BYTES, REPEAT_MAX_SUBTASKS } from "@/lib/repeat-rules";
import { retryOnContention } from "@/lib/retry";
import { emit } from "@/notify/emit";

import { writeActivityMany } from "./activity";
import { guarded } from "./db-errors";
import { mentionableMembers } from "./mentions";
import { NIL_UUID, lockItemRow, lockPredecessor, lockProjectRanks } from "./rank-lock";
import { copyableSubtree, descriptionBytes } from "./repeat";
import { freshDescription } from "./repeat-copies";
import { ensureProjectStates, principalOf, type WorkCtx } from "./states";

/**
 * COPY A TASK (slice 129; founder decision C106 (a), (b) — design
 * docs/research/2026-10-17-slice-129-copy-and-new-task-design.md §3.2).
 *
 * A member copies one task into the project they pick (the current one by
 * default), ticking what comes along: its description, its subtasks, its
 * labels, the people it is given to, its dates. Always: the title as typed,
 * the type (a subtask copied to another project becomes a task), the kind (a
 * client's request becomes a task — it is no longer the client's ask), the
 * priority and the estimate. Never: who can see it — a copy is ALWAYS
 * INTERNAL, written out (C103 (f)'s rule for a repeat's copy) — comments,
 * files, time, history, a contact hand-over, the milestone, the stage (it
 * starts where new tasks start) or a repeat.
 *
 * WHERE IT LANDS: at the bottom of the chosen project; in the same project a
 * subtask's copy goes under the same parent, in another project it is a
 * top-level task.
 *
 * WHO: `work_item:view` + `work_item:create` + `work_item:edit` (in
 * sequence — the copy READS the task, so a role with view revoked must not
 * read one through it: the security review's L-2), the source's project AND
 * the target's in scope; the target not archived.
 *
 * BOUNDED as a repeat's copy is (`REPEAT_MAX_SUBTASKS`, and the descriptions
 * together `REPEAT_MAX_DESCRIPTION_BYTES`) — but REFUSED past either
 * (`COPY_TOO_BIG`), never cut short: a member who ticked "Subtasks" is told,
 * not handed a partial copy.
 *
 * THE ORDER (the copier's, `repeat-copies.ts`, on the TARGET project): the
 * stage key (first seed only) → the task counter → the rank queue → the
 * bottom row FOR UPDATE → (same project) the source's parent FOR SHARE → the
 * source FOR SHARE. The tree under it is read, not locked, as the copier
 * reads it — so the reads that follow the measure filter deleted rows again
 * and weigh what they read (the security review's NIT-2). A source in
 * ANOTHER project is share-locked while the target's queue is held. No
 * ordinary writer closes a cycle with that (none moves a task between
 * projects, and every queued writer takes its own project's queue before
 * any row) — but TWO CROSS-PROJECT COPIES IN OPPOSITE DIRECTIONS can: A→B
 * holds B's bottom row and wants its source in A, B→A holds A's bottom row
 * and wants its source in B, and when each source IS the other's bottom row
 * that is a cycle (both reviews). Postgres ends it within its deadlock
 * timeout and `retryOnContention` runs the loser again; three losses say
 * COPY_BUSY. A retry, never a hang — accepted rather than ordered away,
 * since taking two projects' queues in id order would serialise every copy
 * against every create in both.
 */

/** The parts a member may tick (C106 (a)). */
export const COPY_PARTS = ["description", "subtasks", "labels", "assignee", "dates"] as const;
export type CopyPart = (typeof COPY_PARTS)[number];

/** At most this many tasks under the one copied — a repeat's bound. */
export const COPY_MAX_SUBTASKS = REPEAT_MAX_SUBTASKS;
/** Their descriptions and its own together at most this many bytes — a repeat's bound. */
export const COPY_MAX_DESCRIPTION_BYTES = REPEAT_MAX_DESCRIPTION_BYTES;

/** Descriptions are read this many at a time — a copy may carry up to 101 of up to 512 KB. */
const DESCRIPTION_CHUNK = 20;
/** One copy's transaction: up to 101 tasks with their labels, history, audit and notices. */
const COPY_TX_MS = 30_000;
/** The longest any one statement waits for a lock before the copy gives up and retries. */
const COPY_LOCK_WAIT_MS = 5_000;

/** What the Copy dialog shows before anything is ticked — the source and its tree, as facts. */
export type CopySource = {
  readonly id: string;
  readonly number: number;
  readonly projectId: string;
  readonly projectKey: string;
  readonly title: string;
  /** Whether it, or a task under it, has a description. */
  readonly description: boolean;
  /** The tasks under it a copy would take — at most `COPY_MAX_SUBTASKS + 1`. */
  readonly subtasks: number;
  /** More than `COPY_MAX_SUBTASKS` under it: "Subtasks" cannot be ticked. */
  readonly tooManySubtasks: boolean;
  /** Its descriptions and its subtasks' together pass `COPY_MAX_DESCRIPTION_BYTES`: "Subtasks" and "Description" cannot BOTH come. */
  readonly descriptionsTooBig: boolean;
  /** Whether it, or a task under it, has a label. */
  readonly labels: boolean;
  /** Whether it, or a task under it, is given to a member. */
  readonly assignee: boolean;
  /** The member it is given to, when it is. */
  readonly assigneeName: string | null;
  /** Whether it, or a task under it, has a start or due date. */
  readonly dates: boolean;
};

/**
 * The Copy dialog's read. Asked as the copy itself asks — view + create +
 * edit, the source's project in scope — because it is that verb's door, and
 * it returns the task's words.
 */
export async function readCopySource(ctx: WorkCtx, itemId: string): Promise<CopySource> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    // In sequence, never a batch leg (authz-batches.test.ts). VIEW first:
    // this read returns the task's words (the security review's L-2).
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:view");
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:create");
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:edit");
    const item = await tx.workItem.findFirst({
      where: { tenantId: ctx.tenantId, id: itemId, deletedAt: null },
      select: {
        id: true,
        number: true,
        projectId: true,
        title: true,
        depth: true,
        project: { select: { key: true } },
        assigneeMember: { select: { user: { select: { name: true } } } },
      },
    });
    if (!item) deny("NOT_FOUND");
    await assertInScope(tx, ctx.actor, { projectId: item!.projectId });
    const under = await copyableSubtree(tx, ctx.tenantId, item!, COPY_MAX_SUBTASKS + 1, { includeSeries: true });
    // The tree's facts in one read each — over the rows a copy would take
    // with "Subtasks" ticked, so an option is offered when it would bring
    // anything at all.
    const ids = [item!.id, ...under.map((u) => u.id)];
    const facts = await tx.workItem.findMany({
      where: { tenantId: ctx.tenantId, id: { in: ids } },
      select: {
        assigneeMemberId: true,
        startDate: true,
        targetDate: true,
        _count: { select: { labels: true } },
      },
    });
    const sizes = await descriptionBytes(tx, ctx.tenantId, ids);
    return {
      id: item!.id,
      number: item!.number,
      projectId: item!.projectId,
      projectKey: item!.project.key,
      title: item!.title,
      description: sizes.size > 0,
      subtasks: under.length,
      tooManySubtasks: under.length > COPY_MAX_SUBTASKS,
      descriptionsTooBig: [...sizes.values()].reduce((a, b) => a + b, 0) > COPY_MAX_DESCRIPTION_BYTES,
      labels: facts.some((f) => f._count.labels > 0),
      assignee: facts.some((f) => f.assigneeMemberId !== null),
      assigneeName: item!.assigneeMember?.user.name ?? null,
      dates: facts.some((f) => f.startDate !== null || f.targetDate !== null),
    };
  });
}

/** What a copy made. */
export type CopyDone = {
  readonly id: string;
  readonly number: number;
  readonly projectKey: string;
  /** Tasks copied under it. */
  readonly subtasks: number;
  /** Labels left off because they belong only to another project. */
  readonly labelsLeftOff: number;
  /** Tasks left unassigned because their member cannot take tasks in the chosen project. */
  readonly assigneesLeftOff: number;
};

export async function copyItem(
  ctx: WorkCtx,
  itemId: string,
  input: { readonly projectId: string; readonly title: string; readonly bring: ReadonlySet<CopyPart> },
): Promise<CopyDone> {
  try {
    return await retryOnContention(() =>
      withTenant(ctx.tenantId, principalOf(ctx), (tx) => guarded(() => copyIn(tx, ctx, itemId, input)), {
        timeoutMs: COPY_TX_MS,
        lockTimeoutMs: COPY_LOCK_WAIT_MS,
      }),
    );
  } catch (e) {
    // Both shapes `retryOnContention` retried, told rather than thrown (the
    // bin's rule); the detail is the log's breadcrumb.
    if (isLockTimeout(e)) fail("COPY_BUSY", "lock timeout");
    if (isDeadlock(e)) fail("COPY_BUSY", "deadlock");
    throw e;
  }
}

type Head = {
  id: string;
  type: "EPIC" | "TASK" | "SUBTASK";
  kind: "TASK" | "BUG" | "REQUEST";
  title: string;
  priority: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  estimateMinutes: number | null;
  startDate: Date | null;
  targetDate: Date | null;
  assigneeMemberId: string | null;
  labels: { labelId: string; label: { projectId: string | null } }[];
};

/** A row the copy reads, without its description (read only when ticked, within the budget). */
const HEAD = {
  id: true,
  type: true,
  kind: true,
  title: true,
  priority: true,
  estimateMinutes: true,
  startDate: true,
  targetDate: true,
  assigneeMemberId: true,
  labels: { select: { labelId: true, label: { select: { projectId: true } } } },
} as const;

async function copyIn(
  tx: TenantDb,
  ctx: WorkCtx,
  itemId: string,
  input: { readonly projectId: string; readonly title: string; readonly bring: ReadonlySet<CopyPart> },
): Promise<CopyDone> {
  // In sequence, never a batch leg (authz-batches.test.ts).
  await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:view");
  await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:create");
  await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:edit");

  // The PROBE: which project and parent, read unlocked — the target's queue
  // comes before any row lock, so the rows cannot be locked yet (rows.ts).
  const probe = await tx.workItem.findFirst({
    where: { tenantId: ctx.tenantId, id: itemId, deletedAt: null },
    select: { projectId: true, parentId: true },
  });
  if (!probe) deny("NOT_FOUND");
  await assertInScope(tx, ctx.actor, { projectId: probe!.projectId });
  const sameProject = input.projectId === probe!.projectId;
  if (!sameProject) await assertInScope(tx, ctx.actor, { projectId: input.projectId });
  const target = await tx.project.findFirst({
    where: { tenantId: ctx.tenantId, id: input.projectId },
    select: { id: true, key: true, clientId: true, status: true, archivedAt: true },
  });
  // An archived project takes no copies — the dialog never offers one (the
  // quick-create list, `listProjects`, leaves them out). Otherwise the
  // projects `createItem` creates in: a paused or finished one included.
  if (!target || target.archivedAt !== null || target.status === "ARCHIVED") deny("NOT_FOUND");
  const parentId = sameProject ? probe!.parentId : null;

  await ensureProjectStates(tx, ctx.tenantId, target!.id);
  await lockCounter(tx, `work_item:${target!.id}`);
  await lockProjectRanks(tx, target!.id);
  // The bottom row FOR UPDATE straight after the queue, as the copier takes
  // it: a source that IS the bottom row is then locked once at the stronger
  // mode and never upgraded under a colleague's share.
  const bottom = await lockPredecessor(tx, ctx.tenantId, target!.id, null, NIL_UUID);
  if (parentId) {
    await lockItemRow(tx, ctx.tenantId, parentId, "SHARE");
    const parent = await tx.workItem.findFirst({
      where: { tenantId: ctx.tenantId, id: parentId, projectId: target!.id, deletedAt: null },
      select: { id: true },
    });
    if (!parent) deny("NOT_FOUND");
  }
  await lockItemRow(tx, ctx.tenantId, itemId, "SHARE");
  // Re-read under the lock: still live, still where the probe found it (a
  // parent changed since would make the lock above the wrong row's).
  const source = await tx.workItem.findFirst({
    where: { tenantId: ctx.tenantId, id: itemId, deletedAt: null },
    select: {
      ...HEAD,
      depth: true,
      parentId: true,
      projectId: true,
      clientId: true,
      visibility: true,
    },
  });
  if (!source || source.projectId !== probe!.projectId || source.parentId !== probe!.parentId) deny("NOT_FOUND");
  const start = await tx.workflowState.findFirst({
    where: { tenantId: ctx.tenantId, projectId: target!.id, isDefault: true },
    select: { id: true, category: true },
  });
  if (!start) deny("NOT_FOUND", "project has no default state");

  // The tree under it, by the template rule — refused past the bound.
  const under = input.bring.has("subtasks")
    ? await copyableSubtree(tx, ctx.tenantId, source!, COPY_MAX_SUBTASKS + 1, { includeSeries: true })
    : [];
  if (under.length > COPY_MAX_SUBTASKS) fail("COPY_TOO_BIG");
  // The tree is read, not locked (the copier's way): every later read asks
  // `deletedAt: null` again, so a subtask deleted since the measure is left
  // out — with its own subtasks, below — never copied back to life.
  const heads = new Map<string, Head>();
  for (let i = 0; i < under.length; i += DESCRIPTION_CHUNK) {
    const rows = await tx.workItem.findMany({
      where: { tenantId: ctx.tenantId, deletedAt: null, id: { in: under.slice(i, i + DESCRIPTION_CHUNK).map((u) => u.id) } },
      select: HEAD,
    });
    for (const r of rows) heads.set(r.id, r);
  }

  // Descriptions, when ticked: measured in SQL before any is read, refused
  // past the budget, then read a chunk at a time — and WEIGHED as read, so a
  // description grown since the measure cannot carry the copy past it.
  const descriptionOf = new Map<string, unknown>();
  if (input.bring.has("description")) {
    const order = [source!.id, ...under.map((u) => u.id)];
    const sizes = await descriptionBytes(tx, ctx.tenantId, order);
    if ([...sizes.values()].reduce((a, b) => a + b, 0) > COPY_MAX_DESCRIPTION_BYTES) fail("COPY_TOO_BIG");
    const described = order.filter((id) => (sizes.get(id) ?? 0) > 0);
    let read = 0;
    for (let i = 0; i < described.length; i += DESCRIPTION_CHUNK) {
      const rows = await tx.workItem.findMany({
        where: { tenantId: ctx.tenantId, deletedAt: null, id: { in: described.slice(i, i + DESCRIPTION_CHUNK) } },
        select: { id: true, description: true },
      });
      for (const r of rows) {
        // BYTES, as the measure and the gate count them — never UTF-16 units,
        // which undercount multibyte text up to fourfold (the re-check's NIT).
        read += Buffer.byteLength(JSON.stringify(r.description ?? null), "utf8");
        if (read > COPY_MAX_DESCRIPTION_BYTES) fail("COPY_TOO_BIG");
        descriptionOf.set(r.id, r.description);
      }
    }
  }

  // Who may take what they held, in the CHOSEN project — one rule, one read.
  const can = new Set<string>();
  if (input.bring.has("assignee")) {
    const held = [source!.assigneeMemberId, ...[...heads.values()].map((h) => h.assigneeMemberId)].filter(
      (id): id is string => id !== null,
    );
    if (held.length > 0) {
      for (const m of await mentionableMembers(tx, ctx.tenantId, { projectId: target!.id, clientId: target!.clientId }, [
        ...new Set(held),
      ])) {
        can.add(m.id);
      }
    }
  }
  // A label of the whole workspace, or of the chosen project; one of another
  // project only is left off (C106 (b)).
  const labelFits = (l: { label: { projectId: string | null } }) => l.label.projectId === null || l.label.projectId === target!.id;

  const n = 1 + under.length;
  const numbers = await nextCounters(tx, `work_item:${target!.id}`, n);
  const ranks = ranksBetween(bottom?.rank ?? null, null, n);
  const copyId = newId();
  const idOf = new Map<string, string>(under.map((u) => [u.id, newId()]));

  let labelsLeftOff = 0;
  let assigneesLeftOff = 0;
  const rowOf = (from: Head, id: string, number: number, rank: string, parent: string | null, top: boolean) => {
    const doc = descriptionOf.has(from.id) ? freshDescription(descriptionOf.get(from.id)) : null;
    const wanted = input.bring.has("assignee") ? from.assigneeMemberId : null;
    const assignee = wanted !== null && can.has(wanted) ? wanted : null;
    if (wanted !== null && assignee === null) assigneesLeftOff += 1;
    const labels = input.bring.has("labels") ? [...new Set(from.labels.filter(labelFits).map((l) => l.labelId))] : [];
    if (input.bring.has("labels")) labelsLeftOff += from.labels.filter((l) => !labelFits(l)).length;
    return {
      assignee,
      labels,
      data: {
        id,
        tenantId: ctx.tenantId,
        clientId: target!.clientId,
        projectId: target!.id,
        number,
        // A subtask copied to the top of another project becomes a task; in
        // place, and under the copy, every row keeps its own type.
        type: top && parent === null && from.type === "SUBTASK" ? ("TASK" as const) : from.type,
        // A client's request copied is no longer the client's ask.
        kind: from.kind === "REQUEST" ? ("TASK" as const) : from.kind,
        title: top ? input.title : from.title,
        ...(doc === null
          ? {}
          : { description: doc.doc as object, descriptionText: doc.text, checklistTotal: doc.checklistTotal, checklistDone: doc.checklistDone }),
        stateId: start!.id,
        stateCategory: start!.category,
        parentId: parent,
        rootId: id, // parent_guard derives the real root/depth
        rank,
        priority: from.priority,
        estimateMinutes: from.estimateMinutes,
        ...(input.bring.has("dates") ? { startDate: from.startDate, targetDate: from.targetDate } : {}),
        assigneeMemberId: assignee,
        // THE WORST-BUG DEFAULT, written out rather than left to the column.
        visibility: "INTERNAL" as const,
        source: "IN_APP" as const,
        createdByMemberId: ctx.actor.memberId,
      },
    };
  };
  type Made = ReturnType<typeof rowOf> & { readonly level: number; readonly sourceId: string };

  // Parents before children (`copyableSubtree`'s order): a subtask deleted
  // since the measure is skipped, and so is every task under it — its parent
  // row would not exist. Its number and order key go unused.
  const made: Made[] = [
    { level: -1, sourceId: source!.id, ...rowOf(source!, copyId, numbers[0]!, ranks[0]!, parentId, true) },
  ];
  const written = new Set<string>();
  under.forEach((u, i) => {
    const from = heads.get(u.id);
    if (!from || (u.parentId !== null && !written.has(u.parentId))) return;
    written.add(u.id);
    const parent = u.parentId === null ? copyId : idOf.get(u.parentId)!;
    made.push({ level: u.depth, sourceId: u.id, ...rowOf(from, idOf.get(u.id)!, numbers[i + 1]!, ranks[i + 1]!, parent, false) });
  });

  // A level at a time, so the tree trigger always finds the parent the
  // statement before wrote (the template copier's rule).
  for (const level of [-1, 0, 1]) {
    const rows = made.filter((m) => m.level === level).map((m) => m.data);
    if (rows.length > 0) await tx.workItem.createMany({ data: rows });
  }
  const labelRows = made.flatMap((m) => m.labels.map((labelId) => ({ tenantId: ctx.tenantId, workItemId: m.data.id, labelId })));
  if (labelRows.length > 0) await tx.workItemLabel.createMany({ data: labelRows, skipDuplicates: true });

  // History — every row INTERNAL: a copy's existence must never reach a
  // shared task's history. Each end names the other by its ID (a ref), never
  // its key: the panel resolves the key when it is read, and only for a task
  // in the SAME project — a reader of one project never learns another
  // project's key from it (the security review's L-1), and a renamed key
  // reads as it is now.
  const ref = (id: string) => ({ id, clientId: target!.clientId, projectId: target!.id, visibility: "INTERNAL" as const });
  await writeActivityMany(tx, ctx, [
    ...made.map((m) => ({ item: ref(m.data.id), change: { field: "created", forceInternal: true } })),
    { item: ref(copyId), change: { field: "copiedFrom", oldRef: source!.id, forceInternal: true } },
    ...made
      .filter((m) => m.assignee !== null)
      .map((m) => ({ item: ref(m.data.id), change: { field: "assignee", oldRef: null, newRef: m.assignee, forceInternal: true } })),
    {
      item: { id: source!.id, clientId: source!.clientId, projectId: source!.projectId, visibility: source!.visibility },
      change: { field: "copiedTo", newRef: copyId, forceInternal: true },
    },
  ]);

  const brought = COPY_PARTS.filter((p) => input.bring.has(p));
  const audits: AuditInput[] = made.map((m) => ({
    action: "work_item.created",
    targetType: "WorkItem",
    targetId: m.data.id,
    metadata: {
      number: m.data.number,
      projectId: target!.id,
      type: m.data.type,
      visibility: "INTERNAL",
      ...(m.data.id === copyId
        ? {
            copiedFromId: source!.id,
            brought,
            ...(labelsLeftOff > 0 ? { labelsLeftOff } : {}),
            ...(assigneesLeftOff > 0 ? { assigneesLeftOff } : {}),
          }
        : { copyOf: m.sourceId }),
    },
  }));
  await recordMany(tx, audits);

  // Told once a copy, each about the first task they hold in it; `emit`
  // drops the actor, so copying one's own task tells nobody.
  const firstHeld = new Map<string, Made>();
  for (const m of made) if (m.assignee !== null && !firstHeld.has(m.assignee)) firstHeld.set(m.assignee, m);
  for (const [memberId, m] of firstHeld) {
    await emit(tx, ctx.tenantId, {
      kind: "work_item.assigned",
      entity: { type: "WorkItem", id: m.data.id },
      actorMemberId: ctx.actor.memberId,
      clientId: target!.clientId,
      projectId: target!.id,
      receivers: new Map([[memberId, "ASSIGNEE"]]),
      params: { projectKey: target!.key, itemNumber: String(m.data.number) },
      dedupeKey: `assigned:${m.data.id}`,
    });
  }

  return {
    id: copyId,
    number: numbers[0]!,
    projectKey: target!.key,
    subtasks: made.length - 1,
    labelsLeftOff,
    assigneesLeftOff,
  };
}
