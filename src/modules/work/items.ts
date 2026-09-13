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
import { descriptionToken } from "./description-token";
import { guarded } from "./db-errors";
import { bottomRank, lockProjectRanks } from "./rank-lock";
import { loadItemInScope, type ItemRow } from "./rows";
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

/**
 * Share-lock a parent row, so a read that follows is the parent the
 * insert will be checked against: it cannot be deleted or made private
 * in between (the tree trigger takes the same lock at the insert, where
 * it is then re-entrant). Only ever taken under the project's rank lock
 * — see createItem for why the position is load-bearing. (The module's
 * read of one item for a writer — locked, then scoped — is rows.ts.)
 */
async function shareLockParent(tx: TenantDb, tenantId: string, parentId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM work_item WHERE tenant_id = ${tenantId} AND id = ${parentId} FOR SHARE`;
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
/**
 * A workflow state after a SERVER PAGE has resolved its name.
 *
 * `ResolvedItemList.states` already WAS exactly this shape, spelled as
 * an inline `Omit`; naming it is what lets a states-ONLY read (the item
 * panel's) type honestly, with no cast and no second model. `WorkState`
 * in `work-view/model.ts` still derives from `ResolvedItemList`, so
 * every existing consumer is untouched.
 */
export type ResolvedWorkflowState = Omit<WorkflowStateEntry, "name" | "seedKey"> & {
  name: string;
};

export type ResolvedItemList = Omit<ItemList, "items" | "states"> & {
  items: (Omit<ItemListEntry, "stateName" | "stateSeedKey"> & { stateName: string })[];
  states: ResolvedWorkflowState[];
};

/** The ONE state-resolving pass, shared by the list and the panel reads. */
export const resolveStates = (
  states: readonly WorkflowStateEntry[],
  t: (key: StateSeedKey) => string,
): ResolvedWorkflowState[] =>
  states.map(({ name, seedKey, ...state }) => ({
    ...state,
    name: stateLabel({ name, seedKey }, t),
  }));

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
    states: resolveStates(data.states, t),
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
        activeMembers(tx, ctx.tenantId),
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
      members,
      caps: { canCreate, canEdit, canChangeVisibility, canDelete, canApprove },
    };
  });
}

/**
 * Who can be assigned — the ONE read behind the backlog's assignee cell,
 * the board's lanes and the panel's `A` picker, so the three offer the
 * same people in the same order. ACTIVE members, by the day they joined;
 * the id breaks a tie, because members provisioned in one transaction
 * share a `joinedAt` and the picker's ordinal test ids must name one
 * person on every surface.
 */
async function activeMembers(tx: TenantDb, tenantId: string): Promise<{ id: string; name: string }[]> {
  const rows = await tx.member.findMany({
    where: { tenantId, status: "ACTIVE" },
    select: { id: true, user: { select: { name: true } } },
    orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
  });
  return rows.map((m) => ({ id: m.id, name: m.user.name }));
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
  /** The stored ProseMirror document (ARC-19) — null when there is none. */
  description: unknown;
  /**
   * What the editor sends back with its next save. NOT `updatedAt`: a
   * rank move bumps that, and the panel would refuse a save because a
   * colleague dragged the card (description.ts).
   */
  descriptionToken: string;
};

/**
 * Exactly what the panel renders, and nothing it does not: each
 * `isAuthorized` resolves the member's permissions with its own query,
 * so a cap nobody reads is a query nobody needed (the slice-2 review
 * dropped five of those). `canApprove` joins `canEdit` here because the
 * State picker cannot be drawn without it — `enterableStates` needs it
 * to decide whether the gated Done is a target — and `states` because
 * the panel must not depend on a list the caller happens to have
 * loaded. `canChangeVisibility` and `members` (slice 7) are there for
 * the same two reasons: the `V` picker is a control only for a member
 * who holds `work_item:change_visibility`, and the `A` picker's rows
 * are the tenant's members — read HERE, not borrowed from the board's
 * or the backlog's list, which the full page does not have.
 *
 * FLAT rather than nested under `caps`: the shape has one consumer and
 * three existing assertions, and nesting would churn them for nothing.
 */
export type ItemDetailResult = {
  item: ItemDetail;
  /** RAW pair, by rank — the module has no locale. */
  states: WorkflowStateEntry[];
  canEdit: boolean;
  canApprove: boolean;
  /** `work_item:change_visibility` — whether the `V` picker is a control here. */
  canChangeVisibility: boolean;
  /** The `A` picker's rows: ACTIVE members, in the order the list surfaces use. */
  members: { id: string; name: string }[];
};

/** `ItemDetail` with the state pair resolved — see `ResolvedItemList`. */
export type ResolvedItemDetail = Omit<ItemDetail, "stateName" | "stateSeedKey"> & { stateName: string };

/** `ItemDetailResult` after the page boundary has resolved every name. */
export type ResolvedItemDetailResult = Omit<ItemDetailResult, "item" | "states"> & {
  item: ResolvedItemDetail;
  states: ResolvedWorkflowState[];
};

/** The detail twin of `resolveStateNames`: strips every raw pair at the page boundary. */
export function resolveItemDetail(
  result: ItemDetailResult,
  t: (key: StateSeedKey) => string,
): ResolvedItemDetailResult {
  const { stateName, stateSeedKey, ...rest } = result.item;
  return {
    ...result,
    item: { ...rest, stateName: stateLabel({ name: stateName, seedKey: stateSeedKey }, t) },
    states: resolveStates(result.states, t),
  };
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
        // The panel is the only surface that loads the document; the list
        // reads must never select it (a board is 200 descriptions).
        description: true,
        state: { select: { name: true, seedKey: true } },
        assigneeMember: { select: { user: { select: { name: true } } } },
        parent: { select: { id: true, number: true, title: true, deletedAt: true } },
        milestone: { select: { id: true, name: true, visibility: true } },
      },
    });
    if (!row) deny("NOT_FOUND");
    // All four in parallel, inside the transaction `requireAccess` +
    // `assertInScope` already opened.
    //
    // `ensureProjectStates` is deliberately NOT called here: `createItem`
    // seeds a project's states, so an EXISTING item implies existing
    // states, and turning the panel's only GET into a write would also
    // owe a Phase-3 answer for the contact principal. If the read ever
    // does come back empty, the panel degrades to plain text rather
    // than rendering a picker with nothing in it.
    const [attachmentCount, canEdit, canApprove, canChangeVisibility, states] = await Promise.all([
      tx.document.count({
        where: {
          tenantId: ctx.tenantId,
          attachedToType: "WORK_ITEM",
          attachedToId: row!.id,
          deletedAt: null,
        },
      }),
      isAuthorized(tx, ctx.actor, "work_item:edit"),
      isAuthorized(tx, ctx.actor, "work_item:approve"),
      isAuthorized(tx, ctx.actor, "work_item:change_visibility"),
      tx.workflowState.findMany({
        where: { tenantId: ctx.tenantId, projectId },
        orderBy: { rank: "asc" },
        // IDENTICAL to listItems' select above, so the board's states and
        // the panel's cannot drift into two shapes.
        select: { id: true, name: true, seedKey: true, category: true, isHidden: true, isDefault: true, wipLimit: true, requiresApproval: true },
      }),
    ]);
    // The `A` picker's rows — read only for a member who can edit: a
    // viewer's panel renders the assignee as text and never lists anyone.
    const members = canEdit ? await activeMembers(tx, ctx.tenantId) : [];
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
        description: item.description ?? null,
        descriptionToken: descriptionToken(item.description ?? null),
      },
      states,
      canEdit,
      canApprove,
      canChangeVisibility,
      members,
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
    const created = await tx.workItem.findFirst({ where: { tenantId: ctx.tenantId, id }, omit: { description: true, descriptionText: true } });
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

/**
 * What an inline property edit left in the row — the canonical values
 * an optimistic slice is REPLACED with (UI.md §7.2), read back through
 * the UPDATE's own `select` (its RETURNING), never echoed from the patch.
 */
export type ItemFieldsCommitted = {
  id: string;
  title: string;
  priority: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  estimateMinutes: number | null;
  /** As STORED: `@db.Date`, so UTC midnight of the day, whatever instant was sent. */
  targetDate: Date | null;
  /**
   * False when every patched field already held its value: no UPDATE, no
   * activity, `updatedAt` untouched. Compared UNDER THE ROW LOCK, against
   * the version an UPDATE would replace — so an identical edit that
   * committed while this one waited makes it false too.
   */
  changed: boolean;
};

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
): Promise<ItemFieldsCommitted> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:edit");
    // LOCKED, then read (rows.ts): every diff below is taken from the row
    // version the UPDATE replaces. Read unlocked, an edit that committed
    // while this one waited at its UPDATE left `changed` and each history
    // row's oldValue describing a version it never replaced: two LOW →
    // HIGH edits both said changed, and a shared item's due-date history
    // — a row the client reads — said "from the 15th" twice. A writer of
    // ONE work_item row: never the rank lock, never a second row.
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
    if (changes.length === 0) {
      // Nothing written, and the caller is TOLD so — built from the row
      // just read, which is the truth about the item right now.
      return {
        id: item.id,
        title: item.title,
        priority: item.priority,
        estimateMinutes: item.estimateMinutes,
        targetDate: item.targetDate,
        changed: false,
      };
    }
    const row = await tx.workItem.update({
      where: { id: item.id },
      data,
      // INLINE, and never omitted: a select-less update returns the
      // WHOLE row, 512 KB description included. This is the RETURNING.
      select: { id: true, title: true, priority: true, estimateMinutes: true, targetDate: true },
    });
    for (const c of changes) await writeActivity(tx, ctx, item, c);
    return { ...row, changed: true };
  });
}

/**
 * What an assignment left in the row — the canonical values the panel's
 * `A` picker and the backlog's assignee cell replace their optimistic
 * slice with (UI.md §7.2), read back through the UPDATE's own `select`.
 */
export type AssignmentCommitted = {
  id: string;
  assigneeMemberId: string | null;
  /** The member's display name, resolved HERE so no caller joins it. */
  assigneeName: string | null;
  /**
   * False when the item already had that assignee: no UPDATE, no
   * activity, no notification. Compared UNDER THE ROW LOCK, against the
   * version an UPDATE would replace — so an identical assignment that
   * committed while this one waited makes it false too.
   */
  changed: boolean;
};

/**
 * Assign / unassign a member; assignment notifies (debounced email). A
 * routine edit: an INTERNAL activity row (`assignee` is not on the
 * portal-safe list), never an audit event.
 */
export async function assignItem(
  ctx: WorkCtx,
  itemId: string,
  memberId: string | null,
): Promise<AssignmentCommitted> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:edit");
    // LOCKED, then read (rows.ts; slice 7 carried updateItemFields' fix
    // here). Read unlocked, an assignment that waited at its UPDATE on one
    // that committed said `changed` for a no-op, wrote a history row whose
    // oldRef named an assignee the UPDATE never replaced, and mailed a
    // member who already held the task. A writer of ONE work_item row.
    const item = await loadItemInScope(tx, ctx, itemId);
    // ONE read of the member serves both branches: the no-op answers with
    // the name of whoever holds the task — deactivated or not, still a
    // name to show — and only a REAL assignment insists on ACTIVE.
    const member = memberId
      ? await tx.member.findFirst({
          where: { tenantId: ctx.tenantId, id: memberId },
          select: { status: true, user: { select: { name: true } } },
        })
      : null;
    const assigneeName = member?.user.name ?? null;
    if (item.assigneeMemberId === memberId) {
      // Nothing written, and the caller is TOLD so — from the row just
      // read, which is the truth about the item right now.
      return { id: item.id, assigneeMemberId: item.assigneeMemberId, assigneeName, changed: false };
    }
    if (memberId && member?.status !== "ACTIVE") deny("NOT_FOUND");
    const row = await tx.workItem.update({
      where: { id: item.id },
      data: { assigneeMemberId: memberId, assigneeContactId: null },
      // INLINE, and never omitted: a select-less update returns the
      // WHOLE row, 512 KB description included. This is the RETURNING.
      select: { id: true, assigneeMemberId: true },
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
    return { id: row.id, assigneeMemberId: row.assigneeMemberId, assigneeName, changed: true };
  });
}

/**
 * What a visibility flip left in the row (UI.md §7.2) — the one property
 * whose canonical answer a surface must show INSTEAD of its pick, never
 * beside it (§10.4: never optimistic).
 */
export type VisibilityCommitted = {
  id: string;
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
  /**
   * False when the item already had that visibility: no UPDATE, no
   * activity, no audit event. Compared UNDER THE ROW LOCK, against the
   * version an UPDATE would replace.
   */
  changed: boolean;
};

/** Visibility flip — audited; the DB triggers enforce child ≤ parent
 * and refuse downgrades that would orphan client-visible children —
 * both refusals reach the caller as typed DomainErrors (`guarded`). */
export async function changeItemVisibility(
  ctx: WorkCtx,
  itemId: string,
  visibility: "INTERNAL" | "CLIENT_VISIBLE",
): Promise<VisibilityCommitted> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => guarded(async () => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:change_visibility");
    // A subtask's raise is the one flip the tree trigger locks the parent
    // for, which makes it a writer of TWO rows — so it is a QUEUED writer
    // (rank-lock.ts, THE ONE ORDER): an unlocked probe for its project and
    // its parent, the queue lock, then the locked, scoped read. The probe
    // can decide the plan because no service reparents: `parentId` is the
    // one fact about the row a wait cannot change. A flip to INTERNAL, or
    // a raise with no parent, writes one row and never takes the queue
    // lock, so it never waits on the queue or on a parent — only on
    // whoever holds its own row, which includes an in-flight subtask
    // create or raise under it (that wait IS the write-skew fix). It is
    // the safety lever.
    const probe = await loadItemInScope(tx, ctx, itemId, { lock: false });
    if (visibility === "CLIENT_VISIBLE" && probe.parentId) {
      await lockProjectRanks(tx, probe.projectId);
    }
    // LOCKED, then read, then scope asserted again — the module's read
    // for a writer (rows.ts), after every wait. Read unlocked, a flip
    // that waited at its UPDATE on one that committed reported `changed`
    // for a no-op and audited a transition the UPDATE never made (two
    // raises at once both said "INTERNAL → CLIENT_VISIBLE"), and a
    // make-private issued while a colleague's share was still uncommitted
    // read INTERNAL, called itself a no-op and returned without ever
    // waiting — leaving the task shared.
    const item = await loadItemInScope(tx, ctx, probe.id);
    if (item.visibility === visibility) return { id: item.id, visibility, changed: false };
    const row = await tx.workItem.update({
      where: { id: item.id },
      data: { visibility },
      // INLINE, never omitted (the 512 KB description). The RETURNING.
      select: { id: true, visibility: true },
    });
    // No `forceInternal`: `visibility` is not on the portal-safe list
    // (activity.ts) and since 20260912120000 the database refuses it
    // there, so this row is INTERNAL either way — whatever the item's
    // visibility before or after the flip. A client learns what changed
    // from the STATE row.
    await writeActivity(tx, ctx, item, {
      field: "visibility",
      oldValue: item.visibility,
      newValue: row.visibility,
    });
    await record(tx, {
      action: "work_item.visibility_changed",
      targetType: "WorkItem",
      targetId: item.id,
      metadata: { from: item.visibility, to: row.visibility, projectId: item.projectId },
    });
    return { id: row.id, visibility: row.visibility, changed: true };
  }));
}

/** What an archive / restore left in the row; `changed` false when it was already so — nothing written, nothing audited. */
export type ArchiveCommitted = { id: string; archivedAt: Date | null; changed: boolean };

/** Explicit archive / restore — never silent (UI rule 12). */
export async function setItemArchived(
  ctx: WorkCtx,
  itemId: string,
  archived: boolean,
): Promise<ArchiveCommitted> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:edit");
    // LOCKED, then read (rows.ts; slice 7). Read unlocked, an archive that
    // waited on an identical one restamped archivedAt and audited a
    // second `work_item.archived` for a change that had already happened.
    const item = await loadItemInScope(tx, ctx, itemId);
    if (Boolean(item.archivedAt) === archived) {
      return { id: item.id, archivedAt: item.archivedAt, changed: false };
    }
    const row = await tx.workItem.update({
      where: { id: item.id },
      data: { archivedAt: archived ? new Date() : null },
      // INLINE, never omitted (the 512 KB description). The RETURNING.
      select: { id: true, archivedAt: true },
    });
    await record(tx, {
      action: "work_item.archived",
      targetType: "WorkItem",
      targetId: item.id,
      metadata: { archived, projectId: item.projectId },
    });
    return { id: row.id, archivedAt: row.archivedAt, changed: true };
  });
}

/** Soft delete (30 d, then hard delete by a later sweep). */
export async function deleteItem(ctx: WorkCtx, itemId: string): Promise<void> {
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:delete");
    // Unlocked, explicitly (rows.ts): the compare-and-set below IS this
    // writer's guard — it diffs nothing from this read but the id.
    const item = await loadItemInScope(tx, ctx, itemId, { lock: false });
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

