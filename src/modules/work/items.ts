import { randomUUID } from "node:crypto";

import { record } from "@/audit/record";
import { assertInScope, authorizedCodes, isAuthorized } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { softDeleteCommentsOn } from "@/comments/cascade";
import { nextCounter, withTenant, type TenantDb } from "@/db";
import { softDeleteDocumentsInTx } from "@/documents/service";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { readItemActivity, writeActivity, type ItemActivityPage } from "./activity";
import { readItemComments, type ItemComments } from "./comments";
import { readItemLabels, readLabelsByItem, type ItemLabels, type LabelEntry } from "./labels";
import { descriptionToken } from "./description-token";
import { guarded } from "./db-errors";
import { notifyItemMembers } from "./notify";
import { bottomRank, lockItemRow, lockProjectRanks } from "./rank-lock";
import { loadItemInScope, type ItemRow } from "./rows";
import { ensureProjectStates, principalOf, transitionState, type WorkCtx } from "./states";
import { readItemSubtasks, type ItemSubtasks, type SubtaskEntry } from "./subtasks";
import { childTypeOf, type StateSeedKey, type StatusValue } from "@/lib/enum-map";
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

export type ItemListEntry = {
  id: string;
  number: number;
  title: string;
  type: string;
  /**
   * What the row is ABOUT, orthogonal to `type`'s hierarchy (§6.14).
   *
   * Added to the LIST in slice 6b for one rule, and it is a rule about
   * the item rather than its target: a `kind = REQUEST` row may not be
   * moved into a cancelled state, because that is how a client's own
   * request would vanish from their portal with nobody having said why.
   * `transitionState` refuses it; the board's drop targets and the
   * backlog's bulk bar need this column so they can stop OFFERING it.
   *
   * An open string like `type` and `priority` beside it, not a closed
   * union: the list's shapes are open here and closed in `ItemDetail`,
   * whose surfaces interpolate them into message keys.
   */
  kind: string;
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
  /**
   * The item's labels in `compareLabelNames` order — the board card's and
   * the backlog row's chips (`display.labels`, UI.md §5.3).
   *
   * INTERNAL-ONLY, like every other word on this projection. A label is
   * on the never-list (UI.md §11) and `labels` is on
   * `PORTAL_FORBIDDEN_COLUMNS`, which is safe here for the same reason
   * `stateName`, `priority`, `estimateMinutes` and `assigneeMemberId`
   * already are: `listItems` is a MEMBER read, gated on `work_item:view`
   * and run under the member principal. The portal gets its own
   * `portal.ts` projection, and the forbidden-columns grep is what will
   * catch it if that one ever reaches for this field.
   */
  labels: LabelEntry[];
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

/** A row's RAW state pair (see `ItemListEntry.stateName`) — what `resolveRowState` strips. */
type RawStateRow = { stateName: string | null; stateSeedKey: StateSeedKey | null };

/** The row with its state pair resolved to display text — the ONE shape a client component sees. */
export type ResolvedRow<T extends RawStateRow> = Omit<T, "stateName" | "stateSeedKey"> & { stateName: string };

/**
 * The ONE row-resolving pass (its twin for states is `resolveStates`):
 * the raw pair is STRIPPED, not merely overwritten, so a resolved row
 * is one no client component can mis-read, and nothing downstream has
 * to know the translate-until-renamed rule exists.
 */
export const resolveRowState = <T extends RawStateRow>(row: T, t: (key: StateSeedKey) => string): ResolvedRow<T> => {
  const { stateName, stateSeedKey, ...rest } = row;
  return { ...rest, stateName: stateLabel({ name: stateName, seedKey: stateSeedKey }, t) };
};

export type ResolvedItemList = Omit<ItemList, "items" | "states"> & {
  items: ResolvedRow<ItemListEntry>[];
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
    items: data.items.map((item) => resolveRowState(item, t)),
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
            // Slice 6b: the board and the bulk bar need it to stop
            // offering a cancelled state for a REQUEST (see the type).
            kind: true,
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

    // TWO reads over the page's ids, never a per-row query: one grouped
    // count over the document anchor index, and the labels (labels.ts).
    const ids = items.map((i) => i.id);
    const [attachmentCounts, labelsById] = await Promise.all([
      tx.document.groupBy({
        by: ["attachedToId"],
        where: {
          tenantId: ctx.tenantId,
          attachedToType: "WORK_ITEM",
          attachedToId: { in: ids },
          deletedAt: null,
        },
        _count: { _all: true },
      }),
      readLabelsByItem(tx, ctx.tenantId, ids),
    ]);
    const attachmentsById = new Map(attachmentCounts.map((c) => [c.attachedToId, c._count._all]));

    return {
      items: items.map((i) => ({
        id: i.id,
        number: i.number,
        title: i.title,
        type: i.type,
        kind: i.kind,
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
        labels: labelsById.get(i.id) ?? [],
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

/** The project's phases, as the `M` picker lists them (§6.5). */
export type MilestoneStatus = StatusValue<"milestoneStatus">;

/**
 * One row of the `M` picker (UI.md §5.2): the project's milestones by
 * rank. `dueAt` is the row's `meta` — the datum that tells "Sprint 3"
 * from "Sprint 4" — and the milestone's own visibility is deliberately
 * absent: nothing renders it here, and a phase's chip belongs on the
 * timeline, where a member actually changes it.
 */
export type MilestoneEntry = {
  id: string;
  name: string;
  status: MilestoneStatus;
  dueAt: Date | null;
};

/**
 * The project's phases for the `M` picker — by RANK, which is the one
 * order the timeline shows them in (`projects/milestones.ts`), so the
 * picker and the timeline can never disagree about what comes after
 * what. Every milestone, terminal ones included: which of them may be
 * chosen is `milestonePickerTargets`' rule, applied where the rows are
 * built, so the read stays a read.
 */
async function projectMilestones(
  tx: TenantDb,
  tenantId: string,
  projectId: string,
): Promise<MilestoneEntry[]> {
  return tx.milestone.findMany({
    where: { tenantId, projectId },
    orderBy: { rank: "asc" },
    select: { id: true, name: true, status: true, dueAt: true },
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
// `labels` is omitted with `type` and `priority`, and for the same kind
// of reason: the panel has a RICHER labels shape of its own
// (`ItemDetailResult.labels` — applied plus the vocabulary it may pick
// from), so the list's chip array would be a second, thinner copy of
// the same fact on the same read. One surface, one source.
export type ItemDetail = Omit<ItemListEntry, "type" | "priority" | "labels"> & {
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
  /**
   * The item's phase (§6.5). Name and STATUS: the rail's trigger draws
   * the status glyph exactly as the `M` picker's rows do. NOT the
   * milestone's own visibility — nothing renders it, and a picker row
   * is not a class-B row of the timeline (the milestone's chip lives on
   * the timeline, which is where a member changes it).
   */
  milestone: { id: string; name: string; status: MilestoneStatus } | null;
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
 * What the panel's controls are gated on — each `isAuthorized` resolves
 * the member's permissions with its own query, so a cap nobody reads is
 * a query nobody needed (the slice-2 review dropped five of those).
 * `approve` joins `edit` because the State picker cannot be drawn
 * without it (`enterableStates` needs it to decide whether the gated
 * Done is a target); `changeVisibility` (slice 7) because the `V`
 * picker is a control only for a member who holds it; `create` (slice
 * 9) for the Subtasks add row; `comment` (slice 10) for the composer.
 * The per-COMMENT caps (edit, delete, visibility — own or any) are
 * stamped on each comment row by `readItemComments`, which knows the
 * author; they are not here.
 *
 * Folded into one object with slice 10 (a review disposition of slice
 * 9): five flat booleans beside a sixth was the point at which the
 * flat shape stopped being the simpler one.
 */
export type ItemDetailCaps = {
  /** `work_item:edit` — the description and the properties are editable. */
  edit: boolean;
  /** `work_item:approve` — a gated state is a legal target. */
  approve: boolean;
  /** `work_item:change_visibility` — the `V` picker is a control. */
  changeVisibility: boolean;
  /** `work_item:create` — the Subtasks add row is a control. */
  create: boolean;
  /** `comment:create` — the composer is rendered. */
  comment: boolean;
  /** `label:manage` — the `L` picker offers to create a label from the typed text. */
  manageLabels: boolean;
};

export type ItemDetailResult = {
  item: ItemDetail;
  /** RAW pair, by rank — the module has no locale. */
  states: WorkflowStateEntry[];
  caps: ItemDetailCaps;
  /** The `A` picker's rows: ACTIVE members, in the order the list surfaces use. */
  members: { id: string; name: string }[];
  /** The `M` picker's rows: the project's milestones by rank — empty for a member who cannot edit. */
  milestones: MilestoneEntry[];
  /** The task's labels and the vocabulary it may pick from (labels.ts) — `offered` empty for a member who cannot edit. */
  labels: ItemLabels;
  /** The newest page of the item's history (slice 8) — or the page `activityBefore` asked for. */
  activity: ItemActivityPage;
  /** The item's live children by rank, with the meter's counts (subtasks.ts) — empty for a SUBTASK, which has none by construction. */
  subtasks: ItemSubtasks;
  /** The item's live comments, oldest first, each with its own caps (comments.ts, slice 10). */
  comments: ItemComments;
};

/** `ItemDetail` with the state pair resolved — see `ResolvedItemList`. */
export type ResolvedItemDetail = ResolvedRow<ItemDetail>;

/** A subtask row with its state pair resolved. */
export type ResolvedSubtaskEntry = ResolvedRow<SubtaskEntry>;

/** `ItemSubtasks` after the page boundary has resolved every state name. */
export type ResolvedItemSubtasks = Omit<ItemSubtasks, "rows"> & { rows: ResolvedSubtaskEntry[] };

/** `ItemDetailResult` after the page boundary has resolved every name. */
export type ResolvedItemDetailResult = Omit<ItemDetailResult, "item" | "states" | "subtasks"> & {
  item: ResolvedItemDetail;
  states: ResolvedWorkflowState[];
  subtasks: ResolvedItemSubtasks;
};

/** The detail twin of `resolveStateNames`: strips every raw pair at the page boundary. */
export function resolveItemDetail(
  result: ItemDetailResult,
  t: (key: StateSeedKey) => string,
): ResolvedItemDetailResult {
  return {
    ...result,
    item: resolveRowState(result.item, t),
    states: resolveStates(result.states, t),
    subtasks: { ...result.subtasks, rows: result.subtasks.rows.map((row) => resolveRowState(row, t)) },
  };
}

export async function getItemDetail(
  ctx: WorkCtx,
  projectId: string,
  number: number,
  opts: {
    /** One of the item's own activity row ids: the history page strictly older than it. Anything else is the newest page. */
    activityBefore?: string | null;
  } = {},
): Promise<ItemDetailResult> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:view");
    await assertInScope(tx, ctx.actor, { projectId });
    const row = await tx.workItem.findFirst({
      where: { tenantId: ctx.tenantId, projectId, number, deletedAt: null },
      select: {
        id: true,
        clientId: true,
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
        milestone: { select: { id: true, name: true, status: true } },
      },
    });
    if (!row) deny("NOT_FOUND");
    // All six in parallel, inside the transaction `requireAccess` +
    // `assertInScope` already opened.
    //
    // `ensureProjectStates` is deliberately NOT called here: `createItem`
    // seeds a project's states, so an EXISTING item implies existing
    // states, and turning the panel's only GET into a write would also
    // owe a Phase-3 answer for the contact principal. If the read ever
    // does come back empty, the panel degrades to plain text rather
    // than rendering a picker with nothing in it.
    const [attachmentCount, held, states, activity, subtasks] = await Promise.all([
      tx.document.count({
        where: {
          tenantId: ctx.tenantId,
          attachedToType: "WORK_ITEM",
          attachedToId: row!.id,
          deletedAt: null,
        },
      }),
      // Every cap the panel gates on, from ONE resolution of the member's
      // permissions (`authorizedCodes` — each answer exactly as
      // `isAuthorized` would give it). Nine separate calls resolved the
      // same roles nine times, serially on this transaction's connection.
      authorizedCodes(tx, ctx.actor, [
        "work_item:edit",
        "work_item:approve",
        "work_item:change_visibility",
        "work_item:create",
        "comment:create",
        "comment:edit_any",
        "comment:delete",
        "comment:change_visibility",
        "label:manage",
      ]),
      tx.workflowState.findMany({
        where: { tenantId: ctx.tenantId, projectId },
        orderBy: { rank: "asc" },
        // IDENTICAL to listItems' select above, so the board's states and
        // the panel's cannot drift into two shapes.
        select: { id: true, name: true, seedKey: true, category: true, isHidden: true, isDefault: true, wipLimit: true, requiresApproval: true },
      }),
      // The Activity section's page (activity.ts): one bounded read, in
      // the same transaction and behind the same scope check as the item
      // — never a second entry point that could answer for an item this
      // read refused.
      readItemActivity(tx, ctx.tenantId, row!.id, row!.clientId, opts.activityBefore),
      // The Subtasks section's rows (subtasks.ts), under the same rule. A
      // level with no children (`childTypeOf`: a SUBTASK) is skipped
      // rather than read to return nothing.
      childTypeOf(row!.type) === null
        ? Promise.resolve({ rows: [], done: 0, total: 0 } satisfies ItemSubtasks)
        : readItemSubtasks(tx, ctx.tenantId, row!.id),
    ]);
    const canEdit = held.has("work_item:edit");
    // The `A` picker's rows — read only for a member who can edit: a
    // viewer's panel renders the assignee as text and never lists anyone.
    // The Comments section's rows (comments.ts), behind the same scope
    // check as the item, with the reading member's own caps stamped on
    // each row — the section never decides who may edit what.
    const [members, milestones, labels, comments] = await Promise.all([
      canEdit ? activeMembers(tx, ctx.tenantId) : Promise.resolve([]),
      // Same rule as the members: a viewer's panel renders the phase as
      // text and never lists the project's others.
      canEdit ? projectMilestones(tx, ctx.tenantId, projectId) : Promise.resolve([]),
      // The task's labels always; the vocabulary under the same rule.
      readItemLabels(tx, ctx.tenantId, { id: row!.id, projectId }, canEdit),
      readItemComments(tx, ctx.tenantId, row!, ctx.actor.memberId, {
        create: held.has("comment:create"),
        editAny: held.has("comment:edit_any"),
        deleteAny: held.has("comment:delete"),
        changeVisibility: held.has("comment:change_visibility"),
      }),
    ]);
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
      caps: {
        edit: canEdit,
        approve: held.has("work_item:approve"),
        changeVisibility: held.has("work_item:change_visibility"),
        create: held.has("work_item:create"),
        comment: held.has("comment:create"),
        manageLabels: held.has("label:manage"),
      },
      members,
      milestones,
      labels,
      activity,
      subtasks,
      comments,
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
    let parent: Pick<ItemRow, "type" | "visibility"> | null = null;
    if (input.parentId) {
      // Share-locked, so the read that follows is the parent the insert
      // is checked against: it cannot be deleted or made private in
      // between (the tree trigger takes the same lock at the insert,
      // where it is then re-entrant).
      await lockItemRow(tx, ctx.tenantId, input.parentId, "SHARE");
      parent = await tx.workItem.findFirst({
        where: { tenantId: ctx.tenantId, id: input.parentId, projectId: input.projectId, deletedAt: null },
        // The two fields the child takes from it, never the whole row
        // (the standing trap: a select-less read ships the description).
        select: { type: true, visibility: true },
      });
      if (!parent) deny("NOT_FOUND");
    }
    // The tree trigger has the last word on nesting; `childTypeOf` is
    // the same rule, and a parent it says has no children is its
    // CANNOT_NEST.
    const type = parent ? (childTypeOf(parent.type) ?? "SUBTASK") : "TASK";
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
 *
 * IT IS ALSO THE WAY A CONTACT ASSIGNEE IS REMOVED, which is why
 * `assigneeContactId` is nulled in the same statement and why the
 * no-op test below reads BOTH columns. `assignItemToContact` is the
 * other direction and the two are deliberately separate functions: a
 * contact assignment publishes the task to a client and is gated on
 * `work_item:change_visibility`, and folding that into this signature
 * would put the product's most dangerous flip behind an argument's
 * type.
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
    // **BOTH COLUMNS, AND THE SECOND HALF IS NOT DECORATION.** The
    // UPDATE below clears `assigneeContactId` too, so a task held by a
    // CONTACT and unassigned with `null` really does change — and until
    // slice 6c gave that column a writer, this test read the member
    // column alone and would have reported `changed: false`, written no
    // history row, and left the client holding the task.
    if (item.assigneeMemberId === memberId && !(memberId === null && item.assigneeContactId)) {
      // Nothing written, and the caller is TOLD so — from the row just
      // read, which is the truth about the item right now.
      return { id: item.id, assigneeMemberId: item.assigneeMemberId, assigneeName, changed: false };
    }
    if (memberId && member?.status !== "ACTIVE") deny("NOT_FOUND");
    const row = await tx.workItem.update({
      where: { id: item.id },
      data: {
        assigneeMemberId: memberId,
        assigneeContactId: null,
        // THE CLAIM GOES WITH THE ASSIGNMENT IT ANSWERS, and
        // `work_item_contact_completed_has_assignee` makes this a
        // requirement rather than a courtesy: leaving it behind writes a
        // row the CHECK refuses. A client's "I've done my part" is one
        // person's statement about one thing they were asked to do; it
        // does not survive being asked by somebody else, or not being
        // asked at all.
        contactCompletedAt: null,
      },
      // INLINE, and never omitted: a select-less update returns the
      // WHOLE row, 512 KB description included. This is the RETURNING.
      select: { id: true, assigneeMemberId: true },
    });
    // UP TO TWO ROWS, ONE PER FIELD, and never one row spanning both.
    // The first cut put the contact id into the `assignee` row's
    // `oldRef` — and `readItemActivity` resolves that field's refs
    // against the MEMBER table, so taking a task back from a client
    // rendered "unassigned Unknown" in the panel: an attribution lost
    // in the trail, eight lines from the comment in `activity.ts`
    // promising it could not happen. Both fresh reviews found it.
    if (item.assigneeContactId) {
      await writeActivity(tx, ctx, item, {
        field: "assigneeContactId",
        oldRef: item.assigneeContactId,
        newRef: null,
      });
    }
    if (item.assigneeMemberId !== memberId) {
      await writeActivity(tx, ctx, item, {
        field: "assignee",
        oldRef: item.assigneeMemberId,
        newRef: memberId,
        forceInternal: true,
      });
    }
    if (memberId) await notifyItemMembers(tx, ctx, item, "work_item.assigned", [memberId], "assigned");
    return { id: row.id, assigneeMemberId: row.assigneeMemberId, assigneeName, changed: true };
  });
}

export type ContactAssignmentCommitted = {
  id: string;
  assigneeContactId: string;
  /** The contact's display name, resolved HERE so no caller joins it. */
  assigneeName: string;
  /** What the row's visibility is now — CLIENT_VISIBLE either way. */
  visibility: "CLIENT_VISIBLE";
  /** True when this call is what published the task to the client. */
  shared: boolean;
  /** False when that contact already held the task: nothing written. */
  changed: boolean;
};

/**
 * HAND A TASK TO A CLIENT'S CONTACT — the writer `assigneeContactId`
 * has waited for since 2W, and the member-plane half of Phase 3 slice
 * 6c. Removing a contact assignee is `assignItem(ctx, id, null)`.
 *
 * **IT IS A SHARE, AND IT IS GATED AS ONE** (founder decision,
 * 2026-09-22). `work_item_contact_assignee_visible` (a CHECK since 2W)
 * says a contact-assigned row MUST be CLIENT_VISIBLE, so handing over
 * an INTERNAL task publishes it — there is no third answer the database
 * will accept. That makes this function a route to the flip that
 * `work_item:change_visibility` (C M A) exists to govern, so on an
 * INTERNAL row it demands that code ON TOP of `work_item:edit`, exactly
 * as `work_item:approve` supplements `work_item:edit` for a gated
 * state. An EMPLOYEE can still hand over a task the client can already
 * see; what they cannot do is publish a private one by assigning it.
 *
 * *The alternative — `work_item:edit` alone — would have made the C M A
 * code a speed bump for the one outcome it governs, which is the exact
 * shape of the `work_item:triage` bug the slice-6b reviews found one day
 * earlier. The other alternative, refusing on an INTERNAL row and making
 * the member share it first, was rejected as two deliberate steps where
 * one honest one will do.*
 *
 * **THE FLIP IS THE SAME FLIP**, so it takes the same locks and writes
 * the same trail: a subtask's raise to CLIENT_VISIBLE is the one flip
 * whose trigger locks the PARENT, which makes it a two-row writer and
 * therefore a queued one (`rank-lock.ts`, THE ONE ORDER) — an unlocked
 * probe, the project's rank queue, then the locked scoped read. It
 * audits `work_item.visibility_changed` like every other share, because
 * an operator reading the log must not have to know that assignment is
 * a way to publish. `changeItemVisibility` is not CALLED — it would
 * open its own `withTenant` and re-`requireAccess` — but everything it
 * does is done here, and `guarded` maps the same trigger refusals
 * (child ≤ parent) to the same typed errors.
 *
 * THE ASSIGNMENT ITSELF STAYS ROUTINE: a `WorkItemActivity` row and no
 * audit event, the founder's 2026-09-12 rule for a field a client can
 * see. The field is `assigneeContactId` and NOT `assignee` — that is
 * what keeps each field's refs homogeneous (`activity.ts`) and it is
 * the name DATA_MODEL §6.14 puts on the portal-safe list, so on a
 * client-visible row the history row is client-visible too.
 *
 * NOBODY IS NOTIFIED. The assignee is a contact, and contacts have no
 * notification channel in v1 — inventing one here would mean designing
 * their whole email identity in passing (the same wall slice 6a hit
 * from the other side). The client learns they have been asked when
 * they open the portal.
 *
 * **THE "SAME CLIENT" RULE IS THIS SERVICE'S, NOT THE DATABASE'S**, and
 * that is a residue rather than an oversight. `work_item`'s FK on the
 * contact is `(tenant_id, assignee_contact_id)` with no `client_id`
 * term, so the schema would accept a contact of ANOTHER client of the
 * same tenant; the read above binds `clientId: item.clientId`, which is
 * what actually prevents it, and a dbtest drives that door. It is not a
 * confidentiality hole — `portal_gate` on `work_item` keys on the
 * ITEM's `client_id`, so such a row would still be unreadable by the
 * contact it named — it is a row that means nothing. Closing it
 * properly needs a `(tenant_id, client_id, id)` unique on `contact` and
 * an FK swap on `work_item`, which is a schema change with no
 * confidentiality consequence and does not belong inside this slice.
 */
export async function assignItemToContact(
  ctx: WorkCtx,
  itemId: string,
  contactId: string,
): Promise<ContactAssignmentCommitted> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => guarded(async () => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:edit");
    // The probe decides the lock plan before anything is locked — it
    // cannot be the locked read, because the rank queue precedes any
    // row lock and only the row says whether this is a subtask. Safe to
    // decide on: no service reparents, so `parentId` is the one fact a
    // wait cannot change. A task that is ALREADY client-visible writes
    // one row and never queues.
    const probe = await loadItemInScope(tx, ctx, itemId, { lock: false });
    // **CONDITIONED ON THE REQUESTED VISIBILITY, NOT THE CURRENT ONE**,
    // which is why `probe.visibility` is absent from this test even
    // though the flip below is conditional on it. This call ALWAYS
    // writes `visibility: 'CLIENT_VISIBLE'`, so for a subtask it is
    // always the raise the tree trigger locks the parent for — a
    // two-row writer, and one `UPDATE OF visibility` fires for whether
    // the column is in the SET list rather than for whether its value
    // moved. Reading `probe.visibility` here made the lock PLAN stale:
    // a colleague's make-private committing in the window would leave a
    // two-row writer running with the project's rank queue never taken.
    // `changeItemVisibility` conditions on the requested value for
    // exactly this reason and a code review caught the copy that did
    // not. The GATE below is a different question and is decided on the
    // locked row, where staleness is impossible.
    if (probe.parentId) {
      await lockProjectRanks(tx, probe.projectId);
    }
    const item = await loadItemInScope(tx, ctx, probe.id);
    // **THE SECOND PERMISSION IS DECIDED ON THE LOCKED ROW**, never on
    // the probe: a colleague's share committing in between would
    // otherwise let this call demand — or skip — the wrong code for the
    // row it is actually about to write.
    const sharing = item.visibility === "INTERNAL";
    if (sharing) {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:change_visibility");
    }
    // ONE read of the contact serves both branches: the no-op answers
    // with the name of whoever holds the task, and only a REAL
    // assignment insists on ACTIVE. Bound to the ITEM's client, so a
    // contact id from another client is NOT_FOUND and never a
    // cross-client write — the row-level twin of `setItemMilestone`'s
    // project binding.
    const contact = await tx.contact.findFirst({
      where: { tenantId: ctx.tenantId, clientId: item.clientId, id: contactId },
      select: { name: true, portalStatus: true },
    });
    // `return deny(...)` rather than a bare call — `deny` returns
    // `never`, but the narrowing past it is only reliable in return
    // position here (`authorize.ts` records the same).
    if (!contact) return deny("NOT_FOUND");
    if (item.assigneeContactId === contactId) {
      // Nothing written, and the caller is TOLD so — from the row just
      // read, which is the truth about the item right now.
      return {
        id: item.id,
        assigneeContactId: contactId,
        assigneeName: contact.name,
        visibility: "CLIENT_VISIBLE" as const,
        shared: false,
        changed: false,
      };
    }
    // **AN ALLOWLIST, NEVER A DENYLIST** — the rule `policy.ts` and
    // `portal-gate.ts` both state in as many words, and which the first
    // cut of this line broke by refusing `SUSPENDED` alone.
    // `ContactPortalStatus` has five values and that test admitted four
    // of them, including `REVOKED` (access deliberately taken away) and
    // `NO_ACCESS` — which is the column's DEFAULT and, with no
    // invite flow shipped yet, what every contact row on a live tenant
    // currently holds. Assigning one of those publishes the task to the
    // client (the CHECK forces CLIENT_VISIBLE) for the benefit of
    // somebody who can never open it, and `deleteContact` — which
    // permits deletion only of a `NO_ACCESS` contact — would then hit
    // the RESTRICT foreign key and fail, breaking an erasure control.
    //
    // `INVITED` is admitted deliberately: an agency preparing work for a
    // client it has just invited is ordinary, and `INVITED` becomes
    // ACTIVE without anything touching this row.
    //
    // **WHAT THIS DOES NOT CLOSE, and it is a residue rather than a
    // fix:** nothing clears `assigneeContactId` when a contact's status
    // changes LATER. There is no writer of `portalStatus` anywhere in
    // the product yet, so the case cannot arise today — but the slice
    // that ships "revoke access" must sweep this column, or a revoked
    // contact holding a task (including a SOFT-deleted one, whose FK
    // reference survives its 30-day window) makes `deleteContact` fail
    // on the RESTRICT foreign key: an erasure control broken by a task
    // nobody can see.
    //
    // Checked AFTER the no-op for the reason `assignItem` gives:
    // whoever holds the task still has a name to show, whatever their
    // status is now.
    if (contact.portalStatus !== "ACTIVE" && contact.portalStatus !== "INVITED") {
      deny("NOT_FOUND");
    }
    const row = await tx.workItem.update({
      where: { id: item.id },
      data: {
        assigneeContactId: contactId,
        // THE XOR (`work_item_single_assignee`): handing a task to the
        // client takes it off whoever at the agency held it.
        assigneeMemberId: null,
        // Forced, never toggled — the CHECK admits no other value on a
        // contact-assigned row, and writing it unconditionally means
        // this statement is the same statement whether or not the row
        // was already shared.
        visibility: "CLIENT_VISIBLE",
        // A claim belongs to the assignment it answers: moving the task
        // from one contact to another does not carry the first one's
        // "done" across. The CHECK cannot see names, so this is the
        // service's to hold.
        contactCompletedAt: null,
      },
      // INLINE, never omitted (the 512 KB description). The RETURNING.
      select: { id: true, assigneeContactId: true, visibility: true },
    });
    if (sharing) {
      // The share's own history row, and it is INTERNAL: `visibility`
      // is not on the portal-safe list and since 20260912120000 the
      // database refuses it there. A client learns what changed from
      // the assignment row below, which names them.
      await writeActivity(tx, ctx, item, {
        field: "visibility",
        oldValue: item.visibility,
        newValue: row.visibility,
      });
      await record(tx, {
        action: "work_item.visibility_changed",
        targetType: "WorkItem",
        targetId: item.id,
        // `via` is what tells an operator reading the log that nobody
        // pressed "share": the flip is the assignment's consequence.
        metadata: {
          from: item.visibility,
          to: row.visibility,
          projectId: item.projectId,
          via: "contact_assignment",
        },
      });
    }
    // Written against the row AFTER the flip, so a share-and-assign
    // writes a CLIENT_VISIBLE history row: the item the client is being
    // told about is one they can now see, and `writeActivity` decides
    // portal-safety from the `item` it is handed.
    await writeActivity(
      tx,
      ctx,
      { ...item, visibility: row.visibility },
      { field: "assigneeContactId", oldRef: item.assigneeContactId, newRef: contactId },
    );
    return {
      id: row.id,
      assigneeContactId: contactId,
      assigneeName: contact.name,
      visibility: "CLIENT_VISIBLE" as const,
      shared: sharing,
      changed: true,
    };
  }));
}

/**
 * What a milestone change left in the row — the canonical values the
 * panel's `M` picker replaces its optimistic slice with (UI.md §7.2).
 * The NAME and the STATUS come from the milestone row read in the same
 * transaction, so no caller joins them.
 */
export type MilestoneAssigned = {
  id: string;
  milestoneId: string | null;
  milestoneName: string | null;
  milestoneStatus: MilestoneStatus | null;
  /**
   * False when the item already sat under that milestone: no UPDATE, no
   * activity. Compared UNDER THE ROW LOCK, against the version an UPDATE
   * would replace — so an identical change that committed while this one
   * waited makes it false too.
   */
  changed: boolean;
};

/**
 * File the item under one of its project's milestones, or remove it from
 * the one it is under (UI.md §5.2 `M`). A ROUTINE edit by the founder's
 * 2026-09-12 decision — an activity row, never an audit event — even
 * though `milestoneId` is one of the five PORTAL-SAFE fields, so on a
 * client-visible task the row the client reads is client-visible too.
 *
 * THE ROW CARRIES IDS, NEVER THE PHASE'S NAME. `oldRef` / `newRef` are
 * the milestone ids and the names are resolved at READ time
 * (`readItemActivity`, exactly as the `assignee` refs are), for one
 * safety reason worth stating here: a name written into a
 * CLIENT_VISIBLE history row is a copy that outlives every later
 * decision about the phase. A milestone made INTERNAL afterwards would
 * leave its name sitting in a row the portal can read, and nothing
 * flips a milestone's history the way the item's own downgrade flips
 * its rows. Resolved at read time, the name is whatever the READER's
 * own RLS gives: `Milestone` is class B, so an internal phase does not
 * resolve for a contact and the row names no phase at all — no trigger
 * to maintain, and no way to get it wrong later. That RLS policy is the
 * belt to rely on. There is a second, `oldRef` and `newRef` both being
 * on `PORTAL_FORBIDDEN_COLUMNS`, so a Phase 3 `portal.ts` may not select
 * them for ANY field — but it is the weaker one, a Vitest grep over
 * files named exactly `portal.ts` matching camelCase identifiers, which
 * a raw `old_ref`, an imported select object or a `portal/history.ts`
 * would all walk past (`activity.ts` says the same of the same test).
 * Read that way round: the database refuses, the grep reminds.
 *
 * The milestone must be one of the ITEM's project's — read bound to
 * `item.projectId`, so an id from another project is `NOT_FOUND` and
 * never a cross-project write. `work_item_milestone_guard` (20260912120000)
 * is the belt behind that; see `db-errors.ts` for why its token stays
 * unmapped.
 *
 * A CANCELLED phase is accepted here. Only the picker filters those
 * (`milestonePickerTargets`), because the service must accept the phase
 * the item is ALREADY under, which may have been cancelled since — the
 * same UI-gate-only shape as `createItem` under an archived parent.
 */
export async function setItemMilestone(
  ctx: WorkCtx,
  itemId: string,
  milestoneId: string | null,
): Promise<MilestoneAssigned> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:edit");
    // LOCKED, then read (rows.ts), for the reason `assignItem` and
    // `updateItemFields` are: the diff below must describe the row
    // version the UPDATE replaces, or a no-op reports `changed` and the
    // history row names a phase the item had already left. A writer of
    // ONE work_item row: never the rank lock, never a second row.
    const item = await loadItemInScope(tx, ctx, itemId);
    // ONE read of the milestone serves both branches: the no-op answers
    // with the name of the phase the item is under, and only a REAL
    // change insists the target belongs to this project.
    const target = milestoneId
      ? await tx.milestone.findFirst({
          where: { tenantId: ctx.tenantId, id: milestoneId, projectId: item.projectId },
          select: { id: true, name: true, status: true },
        })
      : null;
    if (item.milestoneId === milestoneId) {
      // Nothing written, and the caller is TOLD so — from the row just
      // read, which is the truth about the item right now. The name is
      // the target's when the caller named the phase the item is
      // already under; a bare no-op (`null` → `null`) names nothing.
      return {
        id: item.id,
        milestoneId: item.milestoneId,
        milestoneName: target?.name ?? null,
        milestoneStatus: target?.status ?? null,
        changed: false,
      };
    }
    // Existence must not leak, and a milestone of ANOTHER project is
    // exactly as absent as one that does not exist (AUTHZ §4).
    if (milestoneId && !target) deny("NOT_FOUND");
    const row = await tx.workItem.update({
      where: { id: item.id },
      data: { milestoneId },
      // INLINE, and never omitted: a select-less update returns the
      // WHOLE row, 512 KB description included. This is the RETURNING.
      select: { id: true, milestoneId: true },
    });
    await writeActivity(tx, ctx, item, {
      field: "milestoneId",
      oldRef: item.milestoneId,
      newRef: milestoneId,
    });
    return {
      id: row.id,
      milestoneId: row.milestoneId,
      milestoneName: target?.name ?? null,
      milestoneStatus: target?.status ?? null,
      changed: true,
    };
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
   * True when making this private also ENDED A CLIENT ASSIGNMENT —
   * `assigneeContactId` and any claim on it were cleared by the same
   * statement, because a contact-assigned row must be CLIENT_VISIBLE
   * and the make-private lever must never fail.
   *
   * REPORTED RATHER THAN SILENT, the mirror of `assignItemToContact`'s
   * `shared`: that one exists so nobody has to know assignment is a way
   * to publish, and this one so nobody has to know make-private is a
   * way to take a task off a client. A re-share does NOT bring the
   * assignment back, so this is the caller's only chance to say so.
   */
  endedContactAssignment: boolean;
  /**
   * False when the item already had that visibility: no UPDATE, no
   * activity, no audit event. Compared UNDER THE ROW LOCK, against the
   * version an UPDATE would replace.
   */
  changed: boolean;
};

/** Visibility flip — audited; the DB triggers enforce child ≤ parent
 * and refuse downgrades that would orphan client-visible children —
 * both refusals reach the caller as typed DomainErrors (`guarded`).
 *
 * **SINCE SLICE 6c, MAKING A TASK PRIVATE ALSO ENDS A CLIENT
 * ASSIGNMENT** — `assigneeContactId` and any claim on it, in the same
 * statement, reported as `endedContactAssignment` and stamped into the
 * audit event. Not a feature of that slice but a consequence of it: a
 * contact-assigned row must be CLIENT_VISIBLE (a CHECK), so without
 * this the flip would raise an unmapped constraint violation on exactly
 * the rows it most needs to work for. See the comment at the UPDATE. */
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
    if (item.visibility === visibility) {
      return { id: item.id, visibility, endedContactAssignment: false, changed: false };
    }
    // **MAKING IT PRIVATE ENDS A CLIENT ASSIGNMENT, IN THE SAME
    // STATEMENT** — and this is a correctness fix that slice 6c made
    // urgent rather than a feature of it. `work_item_contact_assignee_visible`
    // (a CHECK since 2W) says a contact-assigned row must be
    // CLIENT_VISIBLE; until 6c nothing wrote `assigneeContactId`, so the
    // constraint was unreachable and this UPDATE could not violate it.
    // With a writer, a plain `data: { visibility }` on a handed-over
    // task raises a bare 23514 that `db-errors.ts` does not map — so
    // THE SAFETY LEVER, the one flip whose whole purpose is to stop
    // showing a client something, would have 500'd and left the row
    // published. Both fresh reviews found it, from opposite directions.
    //
    // Cleared rather than REFUSED, deliberately. A refusal would be
    // honest and would still leave internal data on a client's screen
    // while the member worked out that the fix is to unassign first.
    // This lever must always work; and an assignment to somebody who
    // can no longer see the task is not an assignment. The claim goes
    // with it, as it does everywhere else (the CHECK insists).
    const endingClientAssignment = visibility === "INTERNAL" && item.assigneeContactId !== null;
    const row = await tx.workItem.update({
      where: { id: item.id },
      data: {
        visibility,
        ...(endingClientAssignment ? { assigneeContactId: null, contactCompletedAt: null } : {}),
      },
      // INLINE, never omitted (the 512 KB description). The RETURNING.
      select: { id: true, visibility: true },
    });
    // Its own history row, BEFORE the visibility row below, so the panel
    // reads in the order the acts happened: the client lost the task,
    // then the task went private.
    //
    // **WRITTEN AGAINST THE ROW AFTER THE UPDATE**, which is not a
    // stylistic choice — `work_item_activity_denorm_guard`
    // (20260821120000_review_guards) re-reads the item's LIVE visibility and refuses a
    // CLIENT_VISIBLE activity row on an item the client cannot see. A
    // first cut passed the pre-update `item` here, reasoning that the
    // row should be client-visible and would be flipped by the
    // downgrade trigger along with the item's others; the guard refused
    // it outright and the whole flip rolled back — the safety lever
    // broken a second time, by its own fix. `assigneeContactId` is on
    // the portal-safe list, so the post-update INTERNAL is what decides
    // it, and that is the right answer anyway: a client cannot read the
    // history of a task they can no longer read.
    if (endingClientAssignment) {
      await writeActivity(
        tx,
        ctx,
        { ...item, visibility: row.visibility },
        { field: "assigneeContactId", oldRef: item.assigneeContactId, newRef: null },
      );
    }
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
      metadata: {
        from: item.visibility,
        to: row.visibility,
        projectId: item.projectId,
        // Ids and flags, never names: an operator asked later why a
        // client lost a task and its claim finds the answer on the
        // event that caused it, rather than a bare visibility flip and
        // an INTERNAL history row.
        ...(endingClientAssignment ? { endedContactAssignment: true } : {}),
      },
    });
    return {
      id: row.id,
      visibility: row.visibility,
      endedContactAssignment: endingClientAssignment,
      changed: true,
    };
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
 * updatedAt; ranks, states, assignments, archives all do), a state is
 * renamed/reordered, or a label is put on or taken off one of its items
 * (a write to `work_item_label` alone, which touches neither of the
 * others — see the aggregate below). A counter, not a list — the poll is cheap and
 * carries no content. Requires the same view permission + scope as the
 * list itself, so polling cannot probe a project the member cannot see.
 */
export async function projectWorkVersion(ctx: WorkCtx, projectId: string): Promise<string> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:view");
    await assertInScope(tx, ctx.actor, { projectId });
    const [items, states, labels] = await Promise.all([
      tx.workItem.aggregate({
        where: { tenantId: ctx.tenantId, projectId },
        _max: { updatedAt: true },
        _count: { _all: true },
      }),
      tx.workflowState.aggregate({
        where: { tenantId: ctx.tenantId, projectId },
        _max: { updatedAt: true },
      }),
      // LABELS ARE THE FIRST THING ON A CARD THAT LIVES OUTSIDE `work_item`
      // (2026-09-16, labels on the card and the row). A toggle inserts or
      // deletes a `work_item_label` row and never touches the item, so the
      // two aggregates above could not see it and a colleague's open board
      // kept its old chips until some unrelated write (fresh-agent review).
      // The pair below changes on every add (a newer `created_at`) and on
      // every remove (a smaller count), including an add and a remove in
      // one poll interval. Read-side only, on purpose: touching
      // `work_item.updated_at` instead would fire every work_item trigger
      // (the search feed among them) for a routine edit. Not seen: a label
      // RENAME — nothing can rename one yet; the settings surface that adds
      // it must add `label.updated_at` here too.
      tx.workItemLabel.aggregate({
        where: { tenantId: ctx.tenantId, workItem: { projectId } },
        _max: { createdAt: true },
        _count: { _all: true },
      }),
    ]);
    const stamp = (d: Date | null) => (d ? d.getTime().toString(36) : "0");
    return `${stamp(items._max.updatedAt)}.${items._count._all}.${stamp(states._max.updatedAt)}.${stamp(labels._max.createdAt)}.${labels._count._all}`;
  });
}

