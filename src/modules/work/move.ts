import { recordMany, type AuditInput } from "@/audit/record";
import { assertInScope, scopeWhere } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { lockCounter, nextCounters, withTenant, type TenantDb } from "@/db";
import { hasAccess, requireAccess } from "@/entitlements/resolver";
import { fail, isDeadlock, isLockTimeout } from "@/lib/domain-error";
import { MOVE_MAX_ENTRIES, MOVE_MAX_SUBTASKS, stageInTarget } from "@/lib/move-plan";
import { ranksBetween } from "@/lib/rank";
import { retryOnContention } from "@/lib/retry";
import { pickSnapshot, type RateSnapshot } from "@/modules/time/rates";
import { idsOnly } from "@/modules/time/ctx";
import { recomputeTouched } from "@/modules/time/summary";

import { writeActivityMany } from "./activity";
import { guardedMove } from "./db-errors";
import { mentionableMembers } from "./mentions";
import { NIL_UUID, lockPredecessor, lockProjectRanks } from "./rank-lock";
import { ensureProjectStates, principalOf, type WorkCtx } from "./states";

/**
 * MOVE A TASK TO ANOTHER PROJECT OF ITS CLIENT (slice 131; founder decision
 * C108 — design docs/research/2026-10-17-slice-131-move-a-task-design.md §3.2).
 *
 * The task and EVERY task under it — live, archived or in the bin (a row left
 * behind would break the tree) — leave one project for another of the SAME
 * client (C108 (a); the database refuses a client change outright), with
 * their comments (and those on their attached files), their files, their
 * history and their hours (C108 (b)), which are re-priced for the new
 * project. Each moved task takes a new number in the target and leaves its
 * old key behind as an alias (C108 (c)), so an old link still finds it.
 *
 * WHO: `work_item:view` + `work_item:create` + `work_item:edit`, in sequence
 * (copy's three: the move reads the task, takes it out of one project and
 * creates it in another), both projects in scope, neither archived — and,
 * each in sequence when it applies: `work_item:change_visibility` when
 * anything moved is shared with the client (carrying shared work into
 * another project can put it in front of the client where it was not —
 * C38's code); `time:edit_any` when a moved hour is a colleague's (the move
 * edits and re-prices it, as `updateEntry` would); `work_item:approve` when a
 * live task lands in an approval-gated stage from an ungated one (as
 * entering it would).
 *
 * REFUSED, each with its words: an unaccepted request in Triage anywhere in
 * the tree (`MOVE_IN_TRIAGE`); an hour on it billed, billed elsewhere,
 * written off or locked (`MOVE_HOURS_BILLED` — the billed record keeps its
 * project); more than `MOVE_MAX_SUBTASKS` tasks under it or
 * `MOVE_MAX_ENTRIES` hours on them (`MOVE_TOO_BIG`); an imported task whose
 * source key the target already holds (`MOVE_SOURCE_TAKEN`); contention
 * three times (`MOVE_BUSY`).
 *
 * IN THE TARGET each moved task gets a new number (tree order), a rank at
 * the bottom, a stage (`stageInTarget`: same name, same seeded default, same
 * kind, where new tasks start), no milestone and no "fixed in version"; its
 * labels lose the old project's own (counted); its person stays only if they
 * can take tasks there (`mentionableMembers`; counted, with a history row);
 * a client's contact stays (same client); collaborators and subscribers who
 * cannot reach the target are removed. Visibility never changes; every
 * UPDATE names `project_id`, so `stamp_portal_enabled` re-derives each
 * row's `portal_enabled` from the target (fail-closed, healed at commit).
 *
 * THE ORDER (design §3.2): the target's stage key on a first seed → its task
 * counter → BOTH projects' rank queues in id order → the target's bottom row
 * FOR UPDATE → the moved rows FOR UPDATE (id order) → their hours FOR UPDATE
 * (id order). Holding both queues, a move never meets a copy, a create or a
 * reorder of either project with a queue in hand — the cycle copy's design
 * accepted cannot close through a move. Then, under the transaction-local
 * `app.work_item_move` flag the database asks for, the task and each level
 * under it, then their files (a binned task's file follows only a move —
 * 20261101100000); the flag off again; then comments, history rows, hours,
 * summaries, aliases, history and audit — all in one transaction.
 */

/** One move's transaction: up to 101 tasks, their files, comments, history, up to 5 000 hours and the record. */
const MOVE_TX_MS = 30_000;
/** The longest one statement waits for a lock before the move gives up and retries. */
const MOVE_LOCK_WAIT_MS = 5_000;

/** A project the task can move to — the client's other projects the member reaches. */
export type MoveTarget = {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  /** Whether the project's portal is on — the dialog's visibility sentence. */
  readonly portalEnabled: boolean;
};

/** What the Move dialog shows, read as the move asks (its door). */
export type MoveFacts = {
  readonly id: string;
  readonly number: number;
  readonly projectId: string;
  readonly projectKey: string;
  readonly title: string;
  readonly targets: readonly MoveTarget[];
  /** Live tasks under it that move with it. */
  readonly subtasks: number;
  /** Tasks under it in the bin — they move too. */
  readonly binned: number;
  /**
   * The moved tasks' time the reader may see (the board's rule, `spent.ts`):
   * the team's with `time:view_team` (`teamHours`), else only their own.
   */
  readonly entries: number;
  readonly seconds: number;
  readonly teamHours: boolean;
  /** Some of the moved time is a colleague's — moving it asks `time:edit_any`. */
  readonly othersHours: boolean;
  readonly mayMoveOthersHours: boolean;
  /** The refusals the dialog says in advance (the move asks again). */
  readonly tooBig: boolean;
  readonly inTriage: boolean;
  readonly hoursBilled: boolean;
  /** Anything moved is shared with the client — moving it asks `work_item:change_visibility`. */
  readonly shared: boolean;
  /** The member may move shared work. */
  readonly mayShare: boolean;
  /** For the chosen project: what it would leave off. */
  readonly target: {
    readonly id: string;
    readonly labelsLeftOff: readonly string[];
    readonly peopleLeftOff: readonly string[];
    readonly milestone: string | null;
    /** Time moves, and the client sees hours on this project or the other: their totals change. */
    readonly hoursShared: boolean;
  } | null;
};

/** The moved task's subtree — every row under it, deleted ones too, at most `cap` (the caller refuses past the bound). */
async function treeUnder(tx: TenantDb, tenantId: string, holderId: string, cap: number): Promise<string[]> {
  const first = await tx.workItem.findMany({
    where: { tenantId, parentId: holderId },
    select: { id: true },
    orderBy: { id: "asc" },
    take: cap,
  });
  if (first.length >= cap) return first.map((r) => r.id);
  const second = first.length
    ? await tx.workItem.findMany({
        where: { tenantId, parentId: { in: first.map((r) => r.id) } },
        select: { id: true },
        orderBy: { id: "asc" },
        take: cap - first.length,
      })
    : [];
  return [...first, ...second].map((r) => r.id);
}

/** The files attached to the moved tasks, and their versions — the subjects their comments hang on. */
async function attachedFiles(tx: TenantDb, tenantId: string, ids: readonly string[]) {
  const documents = await tx.document.findMany({
    where: { tenantId, attachedToType: "WORK_ITEM", attachedToId: { in: [...ids] } },
    select: { id: true, visibility: true },
  });
  const versions = documents.length
    ? await tx.fileVersion.findMany({
        where: { tenantId, documentId: { in: documents.map((d) => d.id) } },
        select: { id: true },
      })
    : [];
  return { documents, versionIds: versions.map((v) => v.id) };
}

/** The comment subjects of the moved tasks: themselves, their files and the files' versions. */
const commentSubjects = (ids: readonly string[], documentIds: readonly string[], versionIds: readonly string[]) => ({
  OR: [
    { subjectType: "WORK_ITEM" as const, subjectId: { in: [...ids] } },
    ...(documentIds.length ? [{ subjectType: "DOCUMENT" as const, subjectId: { in: [...documentIds] } }] : []),
    ...(versionIds.length ? [{ subjectType: "FILE_VERSION" as const, subjectId: { in: [...versionIds] } }] : []),
  ],
});

/** Whether anything moved is shared with the client: a task, a file attached to one, a comment on either. */
async function anythingShared(
  tx: TenantDb,
  tenantId: string,
  ids: readonly string[],
  files: Awaited<ReturnType<typeof attachedFiles>>,
): Promise<boolean> {
  if ((await tx.workItem.count({ where: { tenantId, id: { in: [...ids] }, visibility: "CLIENT_VISIBLE" } })) > 0) return true;
  if (files.documents.some((d) => d.visibility === "CLIENT_VISIBLE")) return true;
  const comments = await tx.comment.count({
    where: {
      AND: [
        { tenantId, visibility: "CLIENT_VISIBLE" },
        commentSubjects(
          ids,
          files.documents.map((d) => d.id),
          files.versionIds,
        ),
      ],
    },
  });
  return comments > 0;
}

/** An hour that must keep its project (C108 (b)): billed, billed elsewhere, written off — or locked. */
const BILLED_OR_LOCKED = {
  OR: [
    { invoiceLineId: { not: null } },
    { billedExternallyAt: { not: null } },
    { writtenOffAt: { not: null } },
    { lockedReason: { not: null } },
  ],
};

/** The client's other projects the member reaches, not archived — where a task may move. */
async function targetsOf(tx: TenantDb, ctx: WorkCtx, source: { id: string; clientId: string }): Promise<MoveTarget[]> {
  const scope = await scopeWhere(tx, ctx.actor, { clientField: "clientId", projectField: "id" });
  const rows = await tx.project.findMany({
    where: {
      AND: [
        scope,
        { tenantId: ctx.tenantId, clientId: source.clientId, id: { not: source.id }, archivedAt: null, status: { not: "ARCHIVED" } },
      ],
    },
    select: { id: true, key: true, name: true, portalEnabled: true },
    orderBy: [{ name: "asc" }, { key: "asc" }],
  });
  return rows;
}

/**
 * The Move dialog's read (design §3.3): the projects the task can go to, the
 * tree's facts and the refusals in advance — and, for a chosen project, what
 * the move would leave off there. Asked as the move asks (view + create +
 * edit, the task's project in scope): it is that verb's door.
 */
export async function readMoveFacts(ctx: WorkCtx, itemId: string, targetProjectId: string | null): Promise<MoveFacts> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    // In sequence, never a batch leg (authz-batches.test.ts).
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:view");
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:create");
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:edit");
    const item = await tx.workItem.findFirst({
      where: { tenantId: ctx.tenantId, id: itemId, deletedAt: null },
      select: {
        id: true,
        number: true,
        title: true,
        projectId: true,
        clientId: true,
        project: { select: { key: true, hoursSharingMode: true } },
      },
    });
    if (!item) deny("NOT_FOUND");
    await assertInScope(tx, ctx.actor, { projectId: item!.projectId });
    const targets = await targetsOf(tx, ctx, { id: item!.projectId, clientId: item!.clientId });

    const under = await treeUnder(tx, ctx.tenantId, item!.id, MOVE_MAX_SUBTASKS + 1);
    const ids = [item!.id, ...under];
    // The bin's tasks move too, but the dialog names only the live ones.
    const live = await tx.workItem.findMany({ where: { tenantId: ctx.tenantId, id: { in: ids }, deletedAt: null }, select: { id: true } });
    const liveIds = live.map((r) => r.id);
    const files = await attachedFiles(tx, ctx.tenantId, ids);
    const shared = await anythingShared(tx, ctx.tenantId, ids, files);
    const mayShare = shared ? await hasAccess(tx, ctx.tenantId, ctx.actor, "work_item:change_visibility") : true;
    const inTriage =
      (await tx.workItem.count({ where: { tenantId: ctx.tenantId, id: { in: ids }, deletedAt: null, stateCategory: "TRIAGE" } })) > 0;
    // The time: counted for the refusal, SHOWN only as the board shows it —
    // the team's with `time:view_team`, else only the reader's own.
    const allEntries = await tx.timeEntry.count({ where: { tenantId: ctx.tenantId, workItemId: { in: ids } } });
    const othersHours =
      (await tx.timeEntry.count({ where: { tenantId: ctx.tenantId, workItemId: { in: ids }, memberId: { not: ctx.actor.memberId } } })) > 0;
    const mayMoveOthersHours = othersHours ? await hasAccess(tx, ctx.tenantId, ctx.actor, "time:edit_any") : true;
    const teamHours = await hasAccess(tx, ctx.tenantId, ctx.actor, "time:view_team");
    const shown = await tx.timeEntry.aggregate({
      // Live hours only, as the board counts them (`spent.ts`).
      where: { tenantId: ctx.tenantId, workItemId: { in: ids }, deletedAt: null, ...(teamHours ? {} : { memberId: ctx.actor.memberId }) },
      _count: { _all: true },
      _sum: { durationSeconds: true },
    });
    const billed = (await tx.timeEntry.count({ where: { tenantId: ctx.tenantId, workItemId: { in: ids }, ...BILLED_OR_LOCKED } })) > 0;

    let target: MoveFacts["target"] = null;
    const chosen = targetProjectId === null ? null : (targets.find((t) => t.id === targetProjectId) ?? null);
    if (chosen) {
      const rows = await tx.workItem.findMany({
        where: { tenantId: ctx.tenantId, id: { in: liveIds } },
        select: {
          assigneeMemberId: true,
          milestone: { select: { name: true } },
          labels: { select: { label: { select: { name: true, projectId: true } } } },
        },
      });
      const held = [...new Set(rows.map((r) => r.assigneeMemberId).filter((m): m is string => m !== null))];
      const can = new Set(
        (await mentionableMembers(tx, ctx.tenantId, { projectId: chosen.id, clientId: item!.clientId }, held)).map((m) => m.id),
      );
      const lost = held.filter((m) => !can.has(m));
      const names = lost.length
        ? await tx.member.findMany({ where: { tenantId: ctx.tenantId, id: { in: lost } }, select: { user: { select: { name: true } } } })
        : [];
      const chosenSharing = await tx.project.findFirst({ where: { tenantId: ctx.tenantId, id: chosen.id }, select: { hoursSharingMode: true } });
      target = {
        id: chosen.id,
        labelsLeftOff: [
          ...new Set(rows.flatMap((r) => r.labels.filter((l) => l.label.projectId === item!.projectId).map((l) => l.label.name))),
        ],
        peopleLeftOff: names.map((n) => n.user.name),
        milestone: rows.find((r) => r.milestone !== null)?.milestone?.name ?? null,
        hoursShared: allEntries > 0 && (item!.project.hoursSharingMode !== "NONE" || (chosenSharing?.hoursSharingMode ?? "NONE") !== "NONE"),
      };
    }

    return {
      id: item!.id,
      number: item!.number,
      projectId: item!.projectId,
      projectKey: item!.project.key,
      title: item!.title,
      targets,
      subtasks: liveIds.length - 1,
      binned: ids.length - liveIds.length,
      entries: shown._count._all,
      seconds: shown._sum.durationSeconds ?? 0,
      teamHours,
      othersHours,
      mayMoveOthersHours,
      tooBig: under.length > MOVE_MAX_SUBTASKS || allEntries > MOVE_MAX_ENTRIES,
      inTriage,
      hoursBilled: billed,
      shared,
      mayShare,
      target,
    };
  });
}

/** What a move did. */
export type MoveDone = {
  readonly id: string;
  readonly number: number;
  readonly projectKey: string;
  readonly fromKey: string;
  /** Tasks moved with it. */
  readonly subtasks: number;
  readonly entries: number;
  readonly labelsLeftOff: number;
  readonly assigneesLeftOff: number;
};

export async function moveItemToProject(ctx: WorkCtx, itemId: string, targetProjectId: string): Promise<MoveDone> {
  try {
    return await retryOnContention(() =>
      withTenant(ctx.tenantId, principalOf(ctx), (tx) => guardedMove(() => moveIn(tx, ctx, itemId, targetProjectId)), {
        timeoutMs: MOVE_TX_MS,
        lockTimeoutMs: MOVE_LOCK_WAIT_MS,
      }),
    );
  } catch (e) {
    // The shapes `retryOnContention` retried, told rather than thrown (copy's rule).
    if (isLockTimeout(e)) fail("MOVE_BUSY", "lock timeout");
    if (isDeadlock(e)) fail("MOVE_BUSY", "deadlock");
    throw e;
  }
}

const ROW = {
  id: true,
  number: true,
  projectId: true,
  clientId: true,
  parentId: true,
  depth: true,
  type: true,
  visibility: true,
  deletedAt: true,
  stateCategory: true,
  assigneeMemberId: true,
  milestoneId: true,
  sourceSystem: true,
  sourceId: true,
  completedAt: true,
  state: { select: { name: true, seedKey: true, category: true, requiresApproval: true } },
} as const;

async function moveIn(tx: TenantDb, ctx: WorkCtx, itemId: string, targetProjectId: string): Promise<MoveDone> {
  // In sequence, never a batch leg (authz-batches.test.ts).
  await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:view");
  await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:create");
  await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:edit");

  // The PROBE, unlocked: which project — the queues come before any row lock.
  const probe = await tx.workItem.findFirst({
    where: { tenantId: ctx.tenantId, id: itemId, deletedAt: null },
    select: { projectId: true, parentId: true },
  });
  if (!probe) deny("NOT_FOUND");
  if (probe!.projectId === targetProjectId) deny("NOT_FOUND");
  await assertInScope(tx, ctx.actor, { projectId: probe!.projectId });
  await assertInScope(tx, ctx.actor, { projectId: targetProjectId });
  const projectSelect = { id: true, key: true, clientId: true, status: true, archivedAt: true } as const;
  const source = await tx.project.findFirst({ where: { tenantId: ctx.tenantId, id: probe!.projectId }, select: projectSelect });
  const target = await tx.project.findFirst({ where: { tenantId: ctx.tenantId, id: targetProjectId }, select: projectSelect });
  const live = (p: typeof source) => p !== null && p.archivedAt === null && p.status !== "ARCHIVED";
  // C108 (a): the client's own projects only — another client's is not a
  // place this task can go, so it is not found (the dialog never offers one).
  if (!live(source) || !live(target) || source!.clientId !== target!.clientId) deny("NOT_FOUND");

  await ensureProjectStates(tx, ctx.tenantId, target!.id);
  await lockCounter(tx, `work_item:${target!.id}`);
  for (const id of [source!.id, target!.id].sort()) await lockProjectRanks(tx, id);
  const bottom = await lockPredecessor(tx, ctx.tenantId, target!.id, null, NIL_UUID);

  // The tree, then every row of it locked in id order. Nothing can join the
  // tree meanwhile: a task is created under it only behind the source's
  // queue, which this move holds.
  const under = await treeUnder(tx, ctx.tenantId, itemId, MOVE_MAX_SUBTASKS + 1);
  if (under.length > MOVE_MAX_SUBTASKS) fail("MOVE_TOO_BIG");
  const ids = [itemId, ...under];
  await tx.$queryRaw`SELECT id FROM work_item WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${[...ids].sort()}::text[]) ORDER BY id FOR UPDATE`;
  const rows = await tx.workItem.findMany({ where: { tenantId: ctx.tenantId, id: { in: ids } }, select: ROW });
  const holder = rows.find((r) => r.id === itemId);
  // Still live and where the probe found it.
  if (!holder || holder.deletedAt !== null || holder.projectId !== source!.id || holder.parentId !== probe!.parentId) deny("NOT_FOUND");
  if (rows.length !== ids.length || rows.some((r) => r.projectId !== source!.id)) deny("NOT_FOUND");
  if (rows.some((r) => r.deletedAt === null && r.stateCategory === "TRIAGE")) fail("MOVE_IN_TRIAGE");

  const files = await attachedFiles(tx, ctx.tenantId, ids);
  // Shared work moves only with the code that shares it (C38).
  if (await anythingShared(tx, ctx.tenantId, ids, files)) {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:change_visibility");
  }

  // An imported task keeps its source key — refused where the target already
  // has a live task from the same source row (the partial UNIQUE's words).
  const keyed = rows.filter((r) => r.deletedAt === null && r.sourceSystem !== null && r.sourceId !== null);
  if (keyed.length > 0) {
    const taken = await tx.workItem.count({
      where: {
        tenantId: ctx.tenantId,
        projectId: target!.id,
        deletedAt: null,
        OR: keyed.map((r) => ({ sourceSystem: r.sourceSystem, sourceId: r.sourceId })),
      },
    });
    if (taken > 0) fail("MOVE_SOURCE_TAKEN");
  }

  // THE HOURS (C108 (b)), locked in id order, the marks re-checked under the
  // lock: an hour on an invoice (or billed elsewhere, written off, locked)
  // keeps its project — the move is refused, never half-done.
  const entryIds = (
    await tx.timeEntry.findMany({
      where: { tenantId: ctx.tenantId, workItemId: { in: ids } },
      select: { id: true },
      orderBy: { id: "asc" },
      take: MOVE_MAX_ENTRIES + 1,
    })
  ).map((e) => e.id);
  if (entryIds.length > MOVE_MAX_ENTRIES) fail("MOVE_TOO_BIG");
  if (entryIds.length > 0) {
    await tx.$queryRaw`SELECT id FROM time_entry WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${entryIds}::text[]) ORDER BY id FOR UPDATE`;
  }
  // Re-read under the lock, STILL on a moved task: an hour put on another
  // task between the list and the lock has left the tree, and stays where it
  // is (the narrow re-check's NIT).
  const entries = entryIds.length
    ? await tx.timeEntry.findMany({
        where: { tenantId: ctx.tenantId, id: { in: entryIds }, workItemId: { in: ids } },
        select: {
          id: true,
          memberId: true,
          serviceId: true,
          localDate: true,
          billable: true,
          rateSource: true,
          durationSeconds: true,
          invoiceLineId: true,
          billedExternallyAt: true,
          writtenOffAt: true,
          lockedReason: true,
          billRate: true,
          billRateCardId: true,
          costRateCardId: true,
          service: { select: { projectId: true } },
        },
      })
    : [];
  if (entries.some((e) => e.invoiceLineId || e.billedExternallyAt || e.writtenOffAt || e.lockedReason)) fail("MOVE_HOURS_BILLED");
  // A colleague's hours are edited and re-priced by the move — which editing
  // another member's time always asks (`updateEntry`'s `time:edit_any`; the
  // security review's MEDIUM). In sequence.
  if (entries.some((e) => e.memberId !== ctx.actor.memberId)) {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "time:edit_any");
  }

  // ── what each task becomes in the target ──
  const stages = await tx.workflowState.findMany({
    where: { tenantId: ctx.tenantId, projectId: target!.id },
    select: { id: true, name: true, seedKey: true, category: true, rank: true, isDefault: true, requiresApproval: true },
  });
  const stageOf = new Map(stages.map((st) => [st.id, st]));
  // Each task's stage there, decided BEFORE anything is written — and a task
  // landing in a stage that asks for approval, from one that did not, asks
  // `work_item:approve` as entering it would (`transitionState`; the
  // security review's LOW). In sequence, never a batch leg.
  const stageFor = new Map<string, string>();
  let needsApprove = false;
  for (const r of rows) {
    const id = stageInTarget(r.state, stages);
    if (id === null) deny("NOT_FOUND", "target project has no stages");
    stageFor.set(r.id, id!);
    if (r.deletedAt === null && stageOf.get(id!)!.requiresApproval && !r.state.requiresApproval) needsApprove = true;
  }
  if (needsApprove) await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:approve");
  const people = [
    ...new Set([
      ...rows.map((r) => r.assigneeMemberId).filter((m): m is string => m !== null),
      ...(await tx.workItemCollaborator.findMany({ where: { tenantId: ctx.tenantId, workItemId: { in: ids } }, select: { memberId: true } })).map(
        (c) => c.memberId,
      ),
      ...(await tx.workItemSubscriber.findMany({ where: { tenantId: ctx.tenantId, workItemId: { in: ids } }, select: { memberId: true } })).map(
        (s) => s.memberId,
      ),
    ]),
  ];
  const can = new Set(
    (await mentionableMembers(tx, ctx.tenantId, { projectId: target!.id, clientId: target!.clientId }, people)).map((m) => m.id),
  );

  // Parents first: the moved task, then each level under it (the tree guard
  // finds every row's parent already in the target).
  const ordered = [...rows].sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : 1));
  const numbers = await nextCounters(tx, `work_item:${target!.id}`, ordered.length);
  const ranks = ranksBetween(bottom?.rank ?? null, null, ordered.length);

  let assigneesLeftOff = 0;
  const unassigned: { id: string; from: string }[] = [];
  await tx.$executeRaw`SELECT set_config('app.work_item_move', 'on', true)`;
  for (const [i, r] of ordered.entries()) {
    const top = r.id === itemId;
    const stateId = stageFor.get(r.id)!;
    // Only when the target has no stage of the task's kind (step 4 of
    // `stageInTarget`) does its kind change; a task that leaves Done or
    // Cancelled that way is not finished any more (both reviews' LOW).
    const kind = stageOf.get(stateId)!.category;
    const unfinished = kind !== r.stateCategory && kind !== "DONE" && kind !== "CANCELLED" && r.completedAt !== null;
    const keepAssignee = r.assigneeMemberId === null || can.has(r.assigneeMemberId);
    if (!keepAssignee) {
      assigneesLeftOff += 1;
      unassigned.push({ id: r.id, from: r.assigneeMemberId! });
    }
    await tx.workItem.update({
      where: { id: r.id },
      data: {
        projectId: target!.id,
        number: numbers[i]!,
        rank: ranks[i]!,
        stateId,
        ...(unfinished ? { completedAt: null } : {}),
        milestoneId: null,
        fixedInVersionId: null,
        ...(keepAssignee ? {} : { assigneeMemberId: null }),
        // The moved task goes to the TOP of the target; a subtask taken there
        // on its own becomes a task (copy's rule). Its children keep it as
        // their parent, and the tree guard re-derives their depth and root.
        ...(top ? { parentId: null, ...(r.type === "SUBTASK" ? { type: "TASK" as const } : {}) } : {}),
      },
      select: { id: true },
    });
  }

  // The files next, STILL under the flag: a binned task's file (soft-deleted,
  // still anchored to it) follows only a move (`document_anchor_guard`,
  // 20261101100000). Then the flag is off for everything after.
  if (files.documents.length > 0) {
    await tx.document.updateMany({
      where: { tenantId: ctx.tenantId, id: { in: files.documents.map((d) => d.id) } },
      data: { projectId: target!.id },
    });
  }
  await tx.$executeRaw`SELECT set_config('app.work_item_move', '', true)`;

  // Labels of the old project only are left off; the workspace's stay.
  const labelsLeftOff = (
    await tx.workItemLabel.deleteMany({
      where: { tenantId: ctx.tenantId, workItemId: { in: ids }, label: { projectId: source!.id } },
    })
  ).count;
  // People who cannot reach the target no longer follow its tasks.
  await tx.workItemCollaborator.deleteMany({
    where: { tenantId: ctx.tenantId, workItemId: { in: ids }, memberId: { notIn: [...can] } },
  });
  await tx.workItemSubscriber.deleteMany({
    where: { tenantId: ctx.tenantId, workItemId: { in: ids }, memberId: { notIn: [...can] } },
  });

  // The comments on the tasks and on their files, then the history rows —
  // each UPDATE (as the files' above) names `project_id`, so each row's
  // `portal_enabled` is re-derived from the target.
  await tx.comment.updateMany({
    where: {
      AND: [
        { tenantId: ctx.tenantId },
        commentSubjects(
          ids,
          files.documents.map((d) => d.id),
          files.versionIds,
        ),
      ],
    },
    data: { projectId: target!.id },
  });
  await tx.workItemActivity.updateMany({
    where: { tenantId: ctx.tenantId, workItemId: { in: ids } },
    data: { projectId: target!.id },
  });

  // The hours: the target's project, a service of another project's own
  // cleared, the rate re-picked for the target as `repriceRateCard` does it
  // (the cards once, the pick in memory, one update per snapshot); a MANUAL
  // rate is kept. Then both projects' summaries.
  let seconds = 0;
  const hourAudits: AuditInput[] = [];
  if (entries.length > 0) {
    const cards = await tx.rateCard.findMany({
      where: { tenantId: ctx.tenantId },
      select: {
        id: true,
        kind: true,
        scope: true,
        memberId: true,
        projectId: true,
        serviceId: true,
        amount: true,
        currency: true,
        effectiveFrom: true,
        effectiveTo: true,
      },
    });
    const groups = new Map<string, { serviceId: string | null; snap: RateSnapshot | null; ids: string[] }>();
    for (const e of entries) {
      seconds += e.durationSeconds ?? 0;
      // A service of one project only follows the hour only into that
      // project (`time_entry_scope_guard` refuses any other pairing); the
      // client's own services stay.
      const scoped = e.service?.projectId ?? null;
      const serviceId = e.serviceId !== null && scoped !== null && scoped !== target!.id ? null : e.serviceId;
      const snap =
        e.rateSource === "MANUAL"
          ? null
          : pickSnapshot(
              cards.filter((c) => c.effectiveFrom <= e.localDate && (c.effectiveTo === null || c.effectiveTo > e.localDate)),
              { memberId: e.memberId, projectId: target!.id, serviceId, billable: e.billable },
            );
      const key = JSON.stringify([serviceId, snap]);
      const g = groups.get(key) ?? { serviceId, snap, ids: [] };
      g.ids.push(e.id);
      groups.set(key, g);
    }
    // Each hour's own record, as an edit of it is audited (`updateEntry`):
    // `time_entry.edited_by_other` for a colleague's — ids only, with what
    // it was billed against before, so a move can be read back (the
    // security review's MEDIUM).
    const before = new Map(entries.map((e) => [e.id, e]));
    for (const g of groups.values()) {
      for (const id of g.ids) {
        const e = before.get(id)!;
        hourAudits.push({
          action: e.memberId === ctx.actor.memberId ? "time_entry.updated" : "time_entry.edited_by_other",
          targetType: "TimeEntry",
          targetId: id,
          metadata: idsOnly({
            memberId: e.memberId === ctx.actor.memberId ? undefined : e.memberId,
            fields: "projectId",
            movedWith: itemId,
            fromProjectId: source!.id,
            projectId: target!.id,
            fromServiceId: e.serviceId !== g.serviceId ? (e.serviceId ?? undefined) : undefined,
            fromRateSource: g.snap !== null ? e.rateSource : undefined,
            fromBillRateCardId: g.snap !== null ? (e.billRateCardId ?? undefined) : undefined,
            fromCostRateCardId: g.snap !== null ? (e.costRateCardId ?? undefined) : undefined,
          }),
        });
      }
    }
    for (const { serviceId, snap, ids: group } of groups.values()) {
      await tx.timeEntry.updateMany({
        where: { tenantId: ctx.tenantId, id: { in: group } },
        data: {
          projectId: target!.id,
          serviceId,
          ...(snap === null
            ? {}
            : {
                billRate: snap.billRate,
                currency: snap.billRate !== null ? snap.currency : null,
                rateSource: snap.rateSource,
                billRateCardId: snap.billRateCardId,
                costRateCardId: snap.costRateCardId,
              }),
        },
      });
    }
    await recomputeTouched(tx, ctx.tenantId, [
      ...entries.map((e) => ({ projectId: source!.id, localDate: e.localDate })),
      ...entries.map((e) => ({ projectId: target!.id, localDate: e.localDate })),
    ]);
  }

  // The old keys (C108 (c)): each moved task's `(project, number)` before.
  await tx.workItemAlias.createMany({
    data: rows.map((r) => ({ tenantId: ctx.tenantId, projectId: source!.id, number: r.number, workItemId: r.id })),
  });

  // History, every row INTERNAL: the old project by REF and the old number —
  // the panel names it only for a reader who can see that project.
  const ref = (r: (typeof rows)[number]) => ({ id: r.id, clientId: r.clientId, projectId: target!.id, visibility: r.visibility });
  await writeActivityMany(tx, ctx, [
    ...rows.map((r) => ({
      item: ref(r),
      change: { field: "moved", oldRef: source!.id, oldValue: String(r.number), forceInternal: true },
    })),
    ...unassigned.map((u) => ({
      item: ref(rows.find((r) => r.id === u.id)!),
      change: { field: "assignee", oldRef: u.from, newRef: null, forceInternal: true },
    })),
  ]);

  const toNumber = new Map(ordered.map((r, i) => [r.id, numbers[i]!]));
  const audits: AuditInput[] = rows.map((r) => ({
    action: "work_item.moved",
    targetType: "WorkItem",
    targetId: r.id,
    metadata: {
      fromProjectId: source!.id,
      fromNumber: r.number,
      toProjectId: target!.id,
      toNumber: toNumber.get(r.id)!,
      ...(r.id === itemId
        ? {
            subtasks: under.length,
            entries: entries.length,
            seconds,
            ...(labelsLeftOff > 0 ? { labelsLeftOff } : {}),
            ...(assigneesLeftOff > 0 ? { assigneesLeftOff } : {}),
            ...(rows.some((x) => x.milestoneId !== null) ? { milestoneCleared: true } : {}),
          }
        : { with: itemId }),
    },
  }));
  await recordMany(tx, [...audits, ...hourAudits]);

  return {
    id: itemId,
    number: toNumber.get(itemId)!,
    projectKey: target!.key,
    fromKey: `${source!.key}-${holder!.number}`,
    subtasks: under.length,
    entries: entries.length,
    labelsLeftOff,
    assigneesLeftOff,
  };
}

/**
 * AN OLD KEY, FOLLOWED (C108 (c); design §3.4): the task a moved task's old
 * `(project, number)` names, as its key NOW — but only for a reader who can
 * open it there (`work_item:view` on all four gates, its current project in
 * scope). Anyone else gets null, exactly as for a number that never existed:
 * an alias never names a project the reader cannot see. A read; no audit.
 */
export async function followMovedKey(
  ctx: WorkCtx,
  projectId: string,
  number: number,
): Promise<{ readonly projectKey: string; readonly number: number } | null> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    if (!(await hasAccess(tx, ctx.tenantId, ctx.actor, "work_item:view"))) return null;
    const alias = await tx.workItemAlias.findUnique({
      where: { tenantId_projectId_number: { tenantId: ctx.tenantId, projectId, number } },
      select: { workItemId: true },
    });
    if (!alias) return null;
    const scope = await scopeWhere(tx, ctx.actor, { clientField: "clientId", projectField: "projectId" });
    const item = await tx.workItem.findFirst({
      where: { AND: [scope, { tenantId: ctx.tenantId, id: alias.workItemId, deletedAt: null }] },
      select: { number: true, project: { select: { key: true } } },
    });
    return item ? { projectKey: item.project.key, number: item.number } : null;
  });
}
