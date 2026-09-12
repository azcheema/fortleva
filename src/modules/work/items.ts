import { randomUUID } from "node:crypto";

import { record } from "@/audit/record";
import { assertInScope, isAuthorized } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { softDeleteCommentsOn } from "@/comments/cascade";
import { nextCounter, withTenant, type TenantDb } from "@/db";
import { softDeleteDocumentsInTx } from "@/documents/service";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { emit } from "@/notify/emit";
import { writeActivity } from "./activity";
import { guarded } from "./db-errors";
import { bottomRank, lockProjectRanks } from "./rank-lock";
import { ensureProjectStates, transitionState, type WorkCtx } from "./states";
import type { StateSeedKey } from "@/lib/enum-map";
import { stateLabel } from "@/lib/state-label";

/**
 * WorkItem CRUD for the 2W core slice (title-only create, list, inline
 * property edits, visibility, archive, soft delete). Board/backlog
 * surfaces, triage, bulk ops and the side-peek land with the 2W UX
 * finish — the schema and this service already carry their invariants.
 * Recipe per module rule: withTenant → requireAccess → assertInScope →
 * mutate → record (+ notify.emit) in ONE transaction.
 */

export type { WorkCtx } from "./states";

const principalOf = (ctx: WorkCtx) => ({ type: "member", id: ctx.actor.memberId }) as const;

type ItemRow = NonNullable<Awaited<ReturnType<TenantDb["workItem"]["findFirst"]>>>;

/**
 * Share-lock a parent row, so a read that follows is the parent the
 * insert will be checked against: it cannot be deleted or made private
 * in between (the tree trigger takes the same lock at the insert, where
 * it is then re-entrant). Only ever taken under the project's rank lock
 * — see createItem for why the position is load-bearing.
 */
async function shareLockParent(tx: TenantDb, tenantId: string, parentId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM work_item WHERE tenant_id = ${tenantId} AND id = ${parentId} FOR SHARE`;
}

/** Load a live item and assert the actor's scope on its project (module-internal; not in the barrel). */
export async function loadItemInScope(tx: TenantDb, ctx: WorkCtx, itemId: string): Promise<ItemRow> {
  const item = await tx.workItem.findFirst({
    where: { tenantId: ctx.tenantId, id: itemId, deletedAt: null },
  });
  if (!item) deny("NOT_FOUND");
  await assertInScope(tx, ctx.actor, { projectId: item!.projectId });
  return item!;
}

export type ItemListEntry = {
  id: string;
  number: number;
  title: string;
  type: string;
  stateId: string;
  stateCategory: string;
  /**
   * RAW state name — `null` when the state still wears its seeded
   * default, in which case `stateSeedKey` is what renders, in the
   * VIEWER's language (DATA_MODEL §6.14). Resolve the pair with
   * `stateLabel()` at the server-page boundary; this module has no
   * locale, because it also runs in dbtests and in a server action.
   */
  stateName: string | null;
  stateSeedKey: StateSeedKey | null;
  priority: string;
  estimateMinutes: number | null;
  targetDate: Date | null;
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
  assigneeMemberId: string | null;
  assigneeName: string | null;
  /** Hierarchy (§3.1): the root of the subtree (itself at depth 0) — the board's group-by-epic lane. */
  rootId: string;
  parentId: string | null;
  archivedAt: Date | null;
  checklistTotal: number;
  checklistDone: number;
  /** Live documents anchored to this item (2W-A) — the backlog's paperclip. */
  attachmentCount: number;
};

export type WorkflowStateEntry = {
  id: string;
  /** RAW — `null` while the state still wears its seeded default; see `ItemListEntry.stateName`. */
  name: string | null;
  seedKey: StateSeedKey | null;
  category: string;
  isHidden: boolean;
  isDefault: boolean;
  wipLimit: number | null;
  requiresApproval: boolean;
};

export type ItemList = {
  items: ItemListEntry[];
  states: WorkflowStateEntry[];
  members: { id: string; name: string }[];
  caps: { canCreate: boolean; canEdit: boolean; canChangeVisibility: boolean; canDelete: boolean; canApprove: boolean };
};

/**
 * `ItemList` after a SERVER PAGE has resolved every state name into the
 * viewer's language (DATA_MODEL §6.14). This is what every client
 * component takes: the nullable pair never reaches the UI, so no
 * component has to know the translate-until-renamed rule exists.
 */
export type ResolvedItemList = Omit<ItemList, "items" | "states"> & {
  items: (Omit<ItemListEntry, "stateName" | "stateSeedKey"> & { stateName: string })[];
  states: (Omit<WorkflowStateEntry, "name" | "seedKey"> & { name: string })[];
};

/**
 * Resolve both name-bearing shapes in one pass, at the page boundary.
 * Takes the translator as a plain function so this module still imports
 * no next-intl — it also runs in dbtests and in a server action, where
 * there is no request locale to resolve against.
 */
export function resolveStateNames(
  data: ItemList,
  t: (key: StateSeedKey) => string,
): ResolvedItemList {
  return {
    ...data,
    // The raw pair is STRIPPED, not merely overwritten: a resolved list
    // is one no client component can mis-read. Nothing downstream has to
    // know the translate-until-renamed rule exists.
    items: data.items.map(({ stateName, stateSeedKey, ...item }) => ({
      ...item,
      stateName: stateLabel({ name: stateName, seedKey: stateSeedKey }, t),
    })),
    states: data.states.map(({ name, seedKey, ...state }) => ({
      ...state,
      name: stateLabel({ name, seedKey }, t),
    })),
  };
}

/** The minimal ordered list (UI: Backlog tab). Done/cancelled included —
 * the slice list is small; hide-done toggles arrive with the full UX. */
export async function listItems(
  ctx: WorkCtx,
  projectId: string,
  opts?: { includeArchived?: boolean },
): Promise<ItemList> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:view");
    await assertInScope(tx, ctx.actor, { projectId });
    await ensureProjectStates(tx, ctx.tenantId, projectId);

    const [items, states, members, canCreate, canEdit, canChangeVisibility, canDelete, canApprove] =
      await Promise.all([
        tx.workItem.findMany({
          where: {
            tenantId: ctx.tenantId,
            projectId,
            deletedAt: null,
            ...(opts?.includeArchived ? {} : { archivedAt: null }),
          },
          orderBy: { rank: "asc" },
          select: {
            id: true,
            number: true,
            title: true,
            type: true,
            stateId: true,
            stateCategory: true,
            priority: true,
            estimateMinutes: true,
            targetDate: true,
            visibility: true,
            assigneeMemberId: true,
            rootId: true,
            parentId: true,
            archivedAt: true,
            checklistTotal: true,
            checklistDone: true,
            state: { select: { name: true, seedKey: true } },
            assigneeMember: { select: { user: { select: { name: true } } } },
          },
        }),
        tx.workflowState.findMany({
          where: { tenantId: ctx.tenantId, projectId },
          orderBy: { rank: "asc" },
          select: { id: true, name: true, seedKey: true, category: true, isHidden: true, isDefault: true, wipLimit: true, requiresApproval: true },
        }),
        tx.member.findMany({
          where: { tenantId: ctx.tenantId, status: "ACTIVE" },
          select: { id: true, user: { select: { name: true } } },
          orderBy: { joinedAt: "asc" },
        }),
        isAuthorized(tx, ctx.actor, "work_item:create"),
        isAuthorized(tx, ctx.actor, "work_item:edit"),
        isAuthorized(tx, ctx.actor, "work_item:change_visibility"),
        isAuthorized(tx, ctx.actor, "work_item:delete"),
        isAuthorized(tx, ctx.actor, "work_item:approve"),
      ]);

    // One grouped count over the anchor index — never a per-row query.
    const attachmentCounts = await tx.document.groupBy({
      by: ["attachedToId"],
      where: {
        tenantId: ctx.tenantId,
        attachedToType: "WORK_ITEM",
        attachedToId: { in: items.map((i) => i.id) },
        deletedAt: null,
      },
      _count: { _all: true },
    });
    const attachmentsById = new Map(attachmentCounts.map((c) => [c.attachedToId, c._count._all]));

    return {
      items: items.map((i) => ({
        id: i.id,
        number: i.number,
        title: i.title,
        type: i.type,
        stateId: i.stateId,
        stateCategory: i.stateCategory,
        // RAW, not display text: NULL means the state still wears its
        // seeded default and must render in the VIEWER's language. The
        // server page resolves the pair with stateLabel() before any
        // client component sees it — this module has no locale.
        stateName: i.state.name,
        stateSeedKey: i.state.seedKey,
        priority: i.priority,
        estimateMinutes: i.estimateMinutes,
        targetDate: i.targetDate,
        visibility: i.visibility,
        assigneeMemberId: i.assigneeMemberId,
        assigneeName: i.assigneeMember?.user.name ?? null,
        rootId: i.rootId,
        parentId: i.parentId,
        archivedAt: i.archivedAt,
        checklistTotal: i.checklistTotal,
        checklistDone: i.checklistDone,
        attachmentCount: attachmentsById.get(i.id) ?? 0,
      })),
      states,
      members: members.map((m) => ({ id: m.id, name: m.user.name })),
      caps: { canCreate, canEdit, canChangeVisibility, canDelete, canApprove },
    };
  });
}

/**
 * ONE item, by its human number, for the item panel (peek and full
 * page). The panel does NOT read its item out of a list any more: a list
 * is filtered (the board drops archived items, the backlog drops them
 * unless asked), so an item could be addressed and not found for reasons
 * that had nothing to do with permission. Archived items ARE returned —
 * a soft-deleted one never is.
 */
export type ItemDetail = Omit<ItemListEntry, "type" | "priority"> & {
  // Closed unions, not the list's open strings: the panel interpolates
  // them straight into message keys (`states.workItemType.${type}`),
  // which next-intl can only type against the catalogue when the value
  // is closed — a cast there would silence the check instead.
  type: "EPIC" | "TASK" | "SUBTASK";
  kind: "TASK" | "BUG" | "REQUEST";
  priority: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  depth: number;
  startDate: Date | null;
  /** "Follows ACME-12" — null at the root, and null when the parent is soft-deleted. */
  parent: { id: string; number: number; title: string } | null;
  /** Name only; the picker (and the same-project guard) arrive with the M key. */
  milestone: { id: string; name: string; visibility: "INTERNAL" | "CLIENT_VISIBLE" } | null;
};

/**
 * No caps here yet, deliberately: every `isAuthorized` resolves the
 * member's permissions with its own query, and this slice's panel is
 * read-only — five caps per render that nobody reads is five wasted
 * round trips. The slices that add editing (the PropertyPicker, `V`)
 * bring back exactly the ones they use.
 */
export type ItemDetailResult = { item: ItemDetail };

/** `ItemDetail` with the state pair resolved — see `ResolvedItemList`. */
export type ResolvedItemDetail = Omit<ItemDetail, "stateName" | "stateSeedKey"> & { stateName: string };

/** The detail twin of `resolveStateNames`: strips the raw pair at the page boundary. */
export function resolveItemDetailState(
  item: ItemDetail,
  t: (key: StateSeedKey) => string,
): ResolvedItemDetail {
  const { stateName, stateSeedKey, ...rest } = item;
  return { ...rest, stateName: stateLabel({ name: stateName, seedKey: stateSeedKey }, t) };
}

export async function getItemDetail(
  ctx: WorkCtx,
  projectId: string,
  number: number,
): Promise<ItemDetailResult> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:view");
    await assertInScope(tx, ctx.actor, { projectId });
    const row = await tx.workItem.findFirst({
      where: { tenantId: ctx.tenantId, projectId, number, deletedAt: null },
      select: {
        id: true,
        number: true,
        title: true,
        type: true,
        kind: true,
        depth: true,
        stateId: true,
        stateCategory: true,
        priority: true,
        estimateMinutes: true,
        startDate: true,
        targetDate: true,
        visibility: true,
        assigneeMemberId: true,
        rootId: true,
        parentId: true,
        archivedAt: true,
        checklistTotal: true,
        checklistDone: true,
        state: { select: { name: true, seedKey: true } },
        assigneeMember: { select: { user: { select: { name: true } } } },
        parent: { select: { id: true, number: true, title: true, deletedAt: true } },
        milestone: { select: { id: true, name: true, visibility: true } },
      },
    });
    if (!row) deny("NOT_FOUND");
    const attachmentCount = await tx.document.count({
      where: {
        tenantId: ctx.tenantId,
        attachedToType: "WORK_ITEM",
        attachedToId: row!.id,
        deletedAt: null,
      },
    });
    const item = row!;
    return {
      item: {
        id: item.id,
        number: item.number,
        title: item.title,
        type: item.type,
        kind: item.kind,
        depth: item.depth,
        stateId: item.stateId,
        stateCategory: item.stateCategory,
        // RAW pair, resolved by the page (resolveItemDetailState).
        stateName: item.state.name,
        stateSeedKey: item.state.seedKey,
        priority: item.priority,
        estimateMinutes: item.estimateMinutes,
        startDate: item.startDate,
        targetDate: item.targetDate,
        visibility: item.visibility,
        assigneeMemberId: item.assigneeMemberId,
        assigneeName: item.assigneeMember?.user.name ?? null,
        rootId: item.rootId,
        parentId: item.parentId,
        archivedAt: item.archivedAt,
        checklistTotal: item.checklistTotal,
        checklistDone: item.checklistDone,
        attachmentCount,
        // A parent that was soft-deleted is no reference to show: the
        // panel would link a key that 404s.
        parent:
          item.parent && item.parent.deletedAt === null
            ? { id: item.parent.id, number: item.parent.number, title: item.parent.title }
            : null,
        milestone: item.milestone,
      },
    };
  });
}

/** Title-only create (UI rule 2): lands in the default state — or the
 * given state of the same project (a board column's "+") — at the
 * bottom of the list; visibility defaults from the parent (INTERNAL at
 * the root — the worst-bug guard). Returns the human key. The tree
 * trigger has the last word on nesting, translated by `guarded`. */
export async function createItem(
  ctx: WorkCtx,
  input: { projectId: string; title: string; parentId?: string; stateId?: string },
): Promise<{ id: string; number: number }> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => guarded(async () => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:create");
    await assertInScope(tx, ctx.actor, { projectId: input.projectId });
    const project = await tx.project.findFirst({
      where: { tenantId: ctx.tenantId, id: input.projectId },
      select: { clientId: true },
    });
    if (!project) deny("NOT_FOUND");
    await ensureProjectStates(tx, ctx.tenantId, input.projectId);
    const defaultState = await tx.workflowState.findFirst({
      where: { tenantId: ctx.tenantId, projectId: input.projectId, isDefault: true },
    });
    if (!defaultState) deny("NOT_FOUND", "project has no default state");
    // A column's "+": the target state must be this project's; the row
    // is created in the default state and then TRANSITIONED by the state
    // machine, so startedAt/completedAt and the history row are exactly
    // what a drag into that column would have produced.
    const targetState =
      input.stateId && input.stateId !== defaultState!.id
        ? await tx.workflowState.findFirst({
            where: { tenantId: ctx.tenantId, projectId: input.projectId, id: input.stateId },
          })
        : null;
    if (input.stateId && input.stateId !== defaultState!.id && !targetState) deny("NOT_FOUND");

    const number = await nextCounter(tx, `work_item:${input.projectId}`);
    const id = randomUUID();

    // Bottom rank under the project's rank lock (rank-lock.ts): creates
    // serialise with each other (nextCounter() above already took the
    // tenant_counter row lock) AND with moves to the bottom, which hold
    // the same advisory lock — without it a create and a "bottom" drop
    // could mint the same key, and a create has no retry. The last row
    // may be soft-deleted: it still owns its slot under the unique index.
    await lockProjectRanks(tx, input.projectId);

    // The parent: share-locked, THEN read, so it cannot be deleted or
    // made private between the read and the insert. AFTER the counter
    // and the rank lock, never before: taken first, two quick subtasks
    // under the project's last row deadlock (both hold the parent
    // shared; one then wants the counter, the other that row FOR
    // UPDATE) — pinned by tree-guards.dbtest.ts. Under the rank lock no
    // other QUEUED writer of this project holds rows (rank-lock.ts, which
    // also lists the lockers outside the queue).
    let parent: ItemRow | null = null;
    if (input.parentId) {
      await shareLockParent(tx, ctx.tenantId, input.parentId);
      parent = await tx.workItem.findFirst({
        where: { tenantId: ctx.tenantId, id: input.parentId, projectId: input.projectId, deletedAt: null },
      });
      if (!parent) deny("NOT_FOUND");
    }
    const type = parent ? (parent.type === "EPIC" ? "TASK" : "SUBTASK") : "TASK";
    const visibility = parent?.visibility ?? "INTERNAL";
    const rank = await bottomRank(tx, ctx.tenantId, input.projectId);
    await tx.workItem.create({
      data: {
        id,
        tenantId: ctx.tenantId,
        clientId: project!.clientId,
        projectId: input.projectId,
        number,
        type,
        title: input.title,
        stateId: defaultState!.id,
        stateCategory: defaultState!.category,
        parentId: input.parentId ?? null,
        rootId: id, // parent_guard derives the real root/depth
        rank,
        visibility,
        createdByMemberId: ctx.actor.memberId,
      },
    });
    const created = await tx.workItem.findFirst({ where: { tenantId: ctx.tenantId, id } });
    await writeActivity(tx, ctx, created!, { field: "created", forceInternal: true });
    await record(tx, {
      action: "work_item.created",
      targetType: "WorkItem",
      targetId: id,
      metadata: { number, projectId: input.projectId, type },
    });
    if (targetState) await transitionState(tx, ctx, created!, targetState);
    return { id, number };
  }));
}

/** Inline property edits (routine — activity, never audit). */
export async function updateItemFields(
  ctx: WorkCtx,
  itemId: string,
  patch: {
    title?: string;
    priority?: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "URGENT";
    estimateMinutes?: number | null;
    targetDate?: Date | null;
  },
): Promise<void> {
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:edit");
    const item = await loadItemInScope(tx, ctx, itemId);
    const data: Record<string, unknown> = {};
    const changes: { field: string; oldValue: string | null; newValue: string | null }[] = [];
    if (patch.title !== undefined && patch.title !== item.title) {
      data["title"] = patch.title;
      changes.push({ field: "title", oldValue: item.title, newValue: patch.title });
    }
    if (patch.priority !== undefined && patch.priority !== item.priority) {
      data["priority"] = patch.priority;
      changes.push({ field: "priority", oldValue: item.priority, newValue: patch.priority });
    }
    if (patch.estimateMinutes !== undefined && patch.estimateMinutes !== item.estimateMinutes) {
      data["estimateMinutes"] = patch.estimateMinutes;
      changes.push({
        field: "estimate",
        oldValue: item.estimateMinutes?.toString() ?? null,
        newValue: patch.estimateMinutes?.toString() ?? null,
      });
    }
    if (patch.targetDate !== undefined) {
      const oldIso = item.targetDate?.toISOString().slice(0, 10) ?? null;
      const newIso = patch.targetDate?.toISOString().slice(0, 10) ?? null;
      if (oldIso !== newIso) {
        data["targetDate"] = patch.targetDate;
        changes.push({ field: "targetDate", oldValue: oldIso, newValue: newIso });
      }
    }
    if (changes.length === 0) return;
    await tx.workItem.update({ where: { id: item.id }, data });
    for (const c of changes) await writeActivity(tx, ctx, item, c);
  });
}

/** Assign / unassign a member; assignment notifies (debounced email). */
export async function assignItem(
  ctx: WorkCtx,
  itemId: string,
  memberId: string | null,
): Promise<void> {
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:edit");
    const item = await loadItemInScope(tx, ctx, itemId);
    if (item.assigneeMemberId === memberId) return;
    if (memberId) {
      const member = await tx.member.findFirst({
        where: { tenantId: ctx.tenantId, id: memberId, status: "ACTIVE" },
        select: { id: true },
      });
      if (!member) deny("NOT_FOUND");
    }
    await tx.workItem.update({
      where: { id: item.id },
      data: { assigneeMemberId: memberId, assigneeContactId: null },
    });
    await writeActivity(tx, ctx, item, {
      field: "assignee",
      oldRef: item.assigneeMemberId,
      newRef: memberId,
      forceInternal: true,
    });
    if (memberId) {
      const project = await tx.project.findFirst({
        where: { tenantId: ctx.tenantId, id: item.projectId },
        select: { key: true },
      });
      await emit(tx, ctx.tenantId, {
        kind: "work_item.assigned",
        entity: { type: "WorkItem", id: item.id },
        actorMemberId: ctx.actor.memberId,
        clientId: item.clientId,
        projectId: item.projectId,
        memberIds: [memberId],
        params: { projectKey: project?.key ?? "", itemNumber: String(item.number) },
        dedupeKey: `assigned:${item.id}`,
      });
    }
  });
}

/** Visibility flip — audited; the DB triggers enforce child ≤ parent
 * and refuse downgrades that would orphan client-visible children —
 * both refusals reach the caller as typed DomainErrors (`guarded`). */
export async function changeItemVisibility(
  ctx: WorkCtx,
  itemId: string,
  visibility: "INTERNAL" | "CLIENT_VISIBLE",
): Promise<void> {
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => guarded(async () => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:change_visibility");
    let item = await loadItemInScope(tx, ctx, itemId);
    if (item.visibility === visibility) return;
    // A subtask's raise is the one flip the tree trigger locks the
    // parent for, which makes it a writer of TWO rows — so it queues on
    // the project's rank lock first, like every queued writer
    // (rank-lock.ts), and re-reads the item after the wait (moveItem's
    // pattern): it may have been deleted or changed meanwhile. A flip to
    // INTERNAL writes one row and takes neither lock, so it never waits
    // on the queue or on its parent — only on whoever holds its own row,
    // which includes an in-flight subtask create or raise under it (that
    // wait IS the write-skew fix). It is the safety lever.
    if (visibility === "CLIENT_VISIBLE" && item.parentId) {
      await lockProjectRanks(tx, item.projectId);
      item = await loadItemInScope(tx, ctx, itemId);
      if (item.visibility === visibility) return;
    }
    await tx.workItem.update({ where: { id: item.id }, data: { visibility } });
    await writeActivity(
      tx,
      ctx,
      { ...item, visibility },
      {
        field: "visibility",
        oldValue: item.visibility,
        newValue: visibility,
        forceInternal: visibility !== "CLIENT_VISIBLE",
      },
    );
    await record(tx, {
      action: "work_item.visibility_changed",
      targetType: "WorkItem",
      targetId: item.id,
      metadata: { from: item.visibility, to: visibility, projectId: item.projectId },
    });
  }));
}

/** Explicit archive / restore — never silent (UI rule 12). */
export async function setItemArchived(
  ctx: WorkCtx,
  itemId: string,
  archived: boolean,
): Promise<void> {
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:edit");
    const item = await loadItemInScope(tx, ctx, itemId);
    if (Boolean(item.archivedAt) === archived) return;
    await tx.workItem.update({
      where: { id: item.id },
      data: { archivedAt: archived ? new Date() : null },
    });
    await record(tx, {
      action: "work_item.archived",
      targetType: "WorkItem",
      targetId: item.id,
      metadata: { archived, projectId: item.projectId },
    });
  });
}

/** Soft delete (30 d, then hard delete by a later sweep). */
export async function deleteItem(ctx: WorkCtx, itemId: string): Promise<void> {
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:delete");
    const item = await loadItemInScope(tx, ctx, itemId);
    // ONE stamp for the item and everything that goes with it, so the
    // whole deletion reads as a single event to an export and to the
    // retention sweep. What a future undo restores by is the audit
    // trail, not this timestamp (comments/cascade.ts).
    const deletedAt = new Date();
    // Guarded on `deletedAt: null`, not just the id: the scope check
    // above read the row in an earlier statement, and a concurrent
    // delete committing in between owns the cascade. Without the guard
    // this would restamp the item while its attachments and thread kept
    // the first stamp — breaking the one-stamp promise — and audit a
    // second `work_item.deleted` naming this actor for someone else's
    // deletion.
    const { count } = await tx.workItem.updateMany({
      where: { id: item.id, deletedAt: null },
      data: { deletedAt },
    });
    if (count === 0) deny("NOT_FOUND");
    // Live children refuse the delete — counted AFTER the update above
    // holds the row, never before. A subtask insert share-locks its
    // parent (work_item_parent_guard), so an insert still in flight made
    // that update wait, and this count's fresh snapshot now sees the
    // child it committed. Counted first, it read 0 and the parent was
    // deleted with a live child under it. The throw rolls the stamp back.
    const children = await tx.workItem.count({
      where: { tenantId: ctx.tenantId, parentId: item.id, deletedAt: null },
    });
    if (children > 0) fail("HAS_CHILDREN");
    // Attachments live the life of their parent (DATA_MODEL §10): the
    // item's soft delete takes its anchored documents with it — else a
    // CLIENT_VISIBLE attachment would outlive the task on the portal
    // with the make-private lever refused by the anchor guard (2W-A
    // review). Each gets its own document.deleted audit row, ids only,
    // and takes its own comments with it (documents/service.ts).
    const attached = await tx.document.findMany({
      where: {
        tenantId: ctx.tenantId,
        attachedToType: "WORK_ITEM",
        attachedToId: item.id,
        deletedAt: null,
      },
      select: { id: true },
    });
    const why = { reason: "work_item_deleted", workItemId: item.id } as const;
    await softDeleteDocumentsInTx(tx, ctx.tenantId, attached.map((d) => d.id), deletedAt, why);
    // And so does the thread (comments/cascade.ts): a comment's index
    // row carries its body, and nothing else would ever remove it.
    await softDeleteCommentsOn(tx, ctx.tenantId, [{ type: "WORK_ITEM", id: item.id, why }], deletedAt);
    await record(tx, {
      action: "work_item.deleted",
      targetType: "WorkItem",
      targetId: item.id,
      metadata: { number: item.number, projectId: item.projectId },
    });
  });
}

/**
 * Freshness token for the board / backlog poll (ARC-18): changes
 * whenever an item of the project is written (soft deletes bump
 * updatedAt; ranks, states, assignments, archives all do) or a state is
 * renamed/reordered. A counter, not a list — the poll is cheap and
 * carries no content. Requires the same view permission + scope as the
 * list itself, so polling cannot probe a project the member cannot see.
 */
export async function projectWorkVersion(ctx: WorkCtx, projectId: string): Promise<string> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:view");
    await assertInScope(tx, ctx.actor, { projectId });
    const [items, states] = await Promise.all([
      tx.workItem.aggregate({
        where: { tenantId: ctx.tenantId, projectId },
        _max: { updatedAt: true },
        _count: { _all: true },
      }),
      tx.workflowState.aggregate({
        where: { tenantId: ctx.tenantId, projectId },
        _max: { updatedAt: true },
      }),
    ]);
    const stamp = (d: Date | null) => (d ? d.getTime().toString(36) : "0");
    return `${stamp(items._max.updatedAt)}.${items._count._all}.${stamp(states._max.updatedAt)}`;
  });
}

