import { randomUUID } from "node:crypto";

import { record } from "@/audit/record";
import { assertInScope, isAuthorized } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { nextCounter, withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { rankBetween } from "@/lib/rank";
import { emit } from "@/notify/emit";
import { writeActivity } from "./activity";
import { ensureProjectStates, type WorkCtx } from "./states";

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

async function loadInScope(tx: TenantDb, ctx: WorkCtx, itemId: string): Promise<ItemRow> {
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
  stateName: string;
  priority: string;
  estimateMinutes: number | null;
  targetDate: Date | null;
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
  assigneeMemberId: string | null;
  assigneeName: string | null;
  archivedAt: Date | null;
  checklistTotal: number;
  checklistDone: number;
};

export type ItemList = {
  items: ItemListEntry[];
  states: { id: string; name: string; category: string; isHidden: boolean }[];
  members: { id: string; name: string }[];
  caps: { canCreate: boolean; canEdit: boolean; canChangeVisibility: boolean; canDelete: boolean };
};

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

    const [items, states, members, canCreate, canEdit, canChangeVisibility, canDelete] =
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
            archivedAt: true,
            checklistTotal: true,
            checklistDone: true,
            state: { select: { name: true } },
            assigneeMember: { select: { user: { select: { name: true } } } },
          },
        }),
        tx.workflowState.findMany({
          where: { tenantId: ctx.tenantId, projectId },
          orderBy: { rank: "asc" },
          select: { id: true, name: true, category: true, isHidden: true },
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
      ]);

    return {
      items: items.map((i) => ({
        id: i.id,
        number: i.number,
        title: i.title,
        type: i.type,
        stateId: i.stateId,
        stateCategory: i.stateCategory,
        stateName: i.state.name,
        priority: i.priority,
        estimateMinutes: i.estimateMinutes,
        targetDate: i.targetDate,
        visibility: i.visibility,
        assigneeMemberId: i.assigneeMemberId,
        assigneeName: i.assigneeMember?.user.name ?? null,
        archivedAt: i.archivedAt,
        checklistTotal: i.checklistTotal,
        checklistDone: i.checklistDone,
      })),
      states,
      members: members.map((m) => ({ id: m.id, name: m.user.name })),
      caps: { canCreate, canEdit, canChangeVisibility, canDelete },
    };
  });
}

/** Title-only create (UI rule 2): lands in the default state at the
 * bottom of the list; visibility defaults from the parent (INTERNAL at
 * the root — the worst-bug guard). Returns the human key. */
export async function createItem(
  ctx: WorkCtx,
  input: { projectId: string; title: string; parentId?: string },
): Promise<{ id: string; number: number }> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
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

    let parent: ItemRow | null = null;
    if (input.parentId) {
      parent = await tx.workItem.findFirst({
        where: { tenantId: ctx.tenantId, id: input.parentId, projectId: input.projectId, deletedAt: null },
      });
      if (!parent) deny("NOT_FOUND");
    }
    const type = parent ? (parent.type === "EPIC" ? "TASK" : "SUBTASK") : "TASK";
    const visibility = parent?.visibility ?? "INTERNAL";
    const number = await nextCounter(tx, `work_item:${input.projectId}`);
    const id = randomUUID();

    // Bottom rank. Two creates in one project cannot race on the
    // (tenantId, projectId, rank) unique: nextCounter() above took the
    // tenant_counter row lock for this project, which serialises them
    // until commit (the 'numbering + rank under concurrency' dbtest). A
    // retry loop inside the transaction could not work anyway — after a
    // unique violation Postgres aborts the transaction (25P02).
    const last = await tx.workItem.findFirst({
      where: { tenantId: ctx.tenantId, projectId: input.projectId, deletedAt: null },
      orderBy: { rank: "desc" },
      select: { rank: true },
    });
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
        rank: rankBetween(last?.rank ?? null, null),
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
    return { id, number };
  });
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
    const item = await loadInScope(tx, ctx, itemId);
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
    const item = await loadInScope(tx, ctx, itemId);
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
 * and refuse downgrades that would orphan client-visible children. */
export async function changeItemVisibility(
  ctx: WorkCtx,
  itemId: string,
  visibility: "INTERNAL" | "CLIENT_VISIBLE",
): Promise<void> {
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:change_visibility");
    const item = await loadInScope(tx, ctx, itemId);
    if (item.visibility === visibility) return;
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
  });
}

/** Explicit archive / restore — never silent (UI rule 12). */
export async function setItemArchived(
  ctx: WorkCtx,
  itemId: string,
  archived: boolean,
): Promise<void> {
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:edit");
    const item = await loadInScope(tx, ctx, itemId);
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
    const item = await loadInScope(tx, ctx, itemId);
    const children = await tx.workItem.count({
      where: { tenantId: ctx.tenantId, parentId: item.id, deletedAt: null },
    });
    if (children > 0) deny("FORBIDDEN", "delete children first");
    await tx.workItem.update({ where: { id: item.id }, data: { deletedAt: new Date() } });
    await record(tx, {
      action: "work_item.deleted",
      targetType: "WorkItem",
      targetId: item.id,
      metadata: { number: item.number, projectId: item.projectId },
    });
  });
}
