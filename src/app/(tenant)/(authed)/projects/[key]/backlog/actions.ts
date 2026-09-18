"use server";

import { revalidatePath } from "next/cache";
import { getLocale, getTranslations } from "next-intl/server";
import { z } from "zod";

import { requireTenantContext } from "@/members/tenant-context";
import {
  assignItem,
  bulkChangeState,
  bulkSetArchived,
  bulkSetPriority,
  changeItemVisibility,
  changeState,
  createItem,
  createLabel,
  deleteItem,
  moveItem,
  setItemArchived,
  setItemLabel,
  setItemMilestone,
  updateItemFields,
  type AssignmentCommitted,
  type BulkResult,
  type LabelsCommitted,
  type MilestoneAssigned,
  type MovedItem,
  type VisibilityCommitted as WorkVisibilityCommitted,
  type WorkCtx,
} from "@/modules/work";
import { PROJECT_KEY_RE } from "@/projects/service";
import { MAX_ESTIMATE_MINUTES, dateColumn, isoDateOf } from "@/lib/duration";
import { PRIORITIES, type Priority } from "@/lib/enum-map";
import { formatDay } from "@/lib/format";
import { runAction, runForm, type ActionResult, type FormResult } from "@/lib/server-actions";
import { stateLabel } from "@/lib/state-label";
import { ITEM_SURFACES, MAX_BULK_ITEMS, MAX_LABEL_NAME_LENGTH, MAX_TITLE_LENGTH, itemReturnTo } from "@/lib/work-view";
import { isIsoDate } from "@/lib/week";

/**
 * Thin server actions for the project's work surfaces (the backlog
 * list and the board share them): parse → call the work service →
 * revalidate both routes. Tenant and member come from
 * requireTenantContext(), never from the form.
 */

const uuid = z.uuid();
const keyShape = z.string().regex(/^[A-Z][A-Z0-9]*$/);

const ctxOf = async (): Promise<WorkCtx> => {
  const { membership, actor } = await requireTenantContext();
  return { tenantId: membership.tenantId, actor };
};

const backlogPath = (key: string) => `/projects/${key}/backlog`;
const boardPath = (key: string) => `/projects/${key}/board`;

/** One order, one item set: whichever surface wrote, both re-render. */
const revalidate = (key: string) => {
  revalidatePath(backlogPath(key));
  revalidatePath(boardPath(key));
};

/**
 * Title-only create into a project's DEFAULT state (UI rule 2), with the
 * created row coming back — the board's `createItemInStateAction` with
 * no column to aim at.
 *
 * It exists as its own export because the global `C` (the shell's quick
 * create, §5.x) needs the id and the number: ⌘Enter is create-AND-OPEN,
 * and a formatted success message cannot be navigated to.
 * `createItemAction` below is this function plus that message, so the
 * backlog's create row and the shell's dialog are one implementation of
 * "create a task here", not two.
 */
export async function createItemAnywhereAction(
  projectId: string,
  projectKey: string,
  title: string,
): Promise<ActionResult<{ id: string; number: number }>> {
  const ctx = await ctxOf();
  const t = await getTranslations("projects.backlog");
  const parsed = z
    .object({
      projectId: uuid,
      projectKey: keyShape,
      title: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
    })
    // Trimmed and CAPPED before the shape is judged, exactly as the
    // original did: a 400-character title is a title to cut, not a
    // refusal, and `.max()` on the raw string would have refused it.
    .safeParse({ projectId, projectKey, title: title.trim().slice(0, MAX_TITLE_LENGTH) });
  if (!parsed.success) return { ok: false, message: t("invalidTitle") };
  const input = parsed.data;
  const r = await runAction(backlogPath(input.projectKey), () =>
    createItem(ctx, { projectId: input.projectId, title: input.title }),
  );
  if (r.ok) revalidate(input.projectKey);
  return r;
}

export async function createItemAction(
  projectId: string,
  projectKey: string,
  title: string,
): Promise<FormResult> {
  const t = await getTranslations("projects.backlog");
  const r = await createItemAnywhereAction(projectId, projectKey, title);
  if (!r.ok) return r;
  return { ok: true, message: t("created", { key: `${projectKey}-${r.value.number}` }) };
}

export async function renameItemAction(
  itemId: string,
  projectKey: string,
  title: string,
): Promise<FormResult> {
  const ctx = await ctxOf();
  const t = await getTranslations("projects.backlog");
  const id = uuid.safeParse(itemId);
  const key = keyShape.safeParse(projectKey);
  const trimmed = title.trim().slice(0, MAX_TITLE_LENGTH);
  if (!id.success || !key.success || trimmed.length === 0) {
    return { ok: false, message: t("invalidTitle") };
  }
  const r = await runForm(backlogPath(key.data), async () => {
    await updateItemFields(ctx, id.data, { title: trimmed });
    return t("saved");
  });
  if (r.ok) revalidate(key.data);
  return r;
}

/* -------------------------------------------------------------- *
 * The item PROPERTY setters — S, P, E, D, A, V, M, and L's two (UI.md §5.2, §7.2).
 *
 * ONE action per property, shared by the backlog table's cells and the
 * item panel's pickers. Each takes an object input naming WHERE it was
 * called from and returns the canonical row as an `ActionResult`, so
 * an optimistic slice is REPLACED rather than merged, and a failure is
 * a typed message a caller toasts — never a silent revert.
 *
 * `surface` decides only two things, both from a validated enum: the
 * MFA step-up return address (`itemReturnTo`) and which sentence a
 * refusal speaks — the table's "the list shows…" or the panel's "the
 * panel shows…". It never builds a path from caller text.
 *
 * Revalidation happens only when the service reports `changed`: a
 * no-op wrote nothing, so there is nothing to re-render and no reason
 * to evict the member's prefetch cache. The item page is never
 * revalidated by path — `revalidatePath('/projects/KEY/items/[number]')`
 * mixes a resolved segment with a placeholder and matches nothing — the
 * client's `router.refresh()` re-reads it.
 * -------------------------------------------------------------- */

const Target = z.object({
  itemId: uuid,
  // The projects service's own key rule, rather than a third copy of it.
  projectKey: z.string().regex(PROJECT_KEY_RE),
  itemNumber: z.number().int().min(1).max(999_999_999),
  surface: z.enum(ITEM_SURFACES),
});
const SetState = Target.extend({ stateId: uuid });
const SetPriority = Target.extend({ priority: z.enum(PRIORITIES) });
// Min 1: the shared grammar maps a typed zero to null (CLEAR), so a 0
// here is not something any caller means to send.
const SetEstimate = Target.extend({
  estimateMinutes: z.number().int().min(1).max(MAX_ESTIMATE_MINUTES).nullable(),
});
const SetDueDate = Target.extend({
  targetDate: z.string().refine((s) => isIsoDate(s)).nullable(),
});
const SetAssignee = Target.extend({ memberId: uuid.nullable() });
const SetMilestone = Target.extend({ milestoneId: uuid.nullable() });
const SetLabel = Target.extend({ labelId: uuid, on: z.boolean() });
// The bound is `@/lib/work-view`'s, the island's and the service's alike:
// a `"use server"` module may export only async functions, and a constant
// re-exported from here refused every action in the file at runtime.
const CreateLabel = Target.extend({ name: z.string().trim().min(1).max(MAX_LABEL_NAME_LENGTH) });
// CLOSED at the boundary: the two tokens and nothing else. The old
// action coerced anything unrecognised to INTERNAL — safe, but a write
// nobody asked for is still a write; a refusal writes nothing.
const SetVisibility = Target.extend({ visibility: z.enum(["INTERNAL", "CLIENT_VISIBLE"]) });

/** The canonical state the picker replaces its optimistic slice with. */
export type StateCommitted = {
  stateId: string;
  stateCategory: string;
  /** Resolved HERE: the work module has no locale, the action does. */
  stateName: string;
  /** False when the item was already in that state — nothing was written. */
  changed: boolean;
};
export type PriorityCommitted = { priority: Priority; changed: boolean };
export type EstimateCommitted = { estimateMinutes: number | null; changed: boolean };
export type DueDateCommitted = {
  /** ISO date, never a `Date` — the column is `@db.Date`. */
  targetDate: string | null;
  /** Formatted on the SERVER, so the adopted label cannot flicker between Node's and the browser's ICU. */
  dueLabel: string | null;
  changed: boolean;
};
/** The service's canonical rows minus the id the caller already holds — one contract, not a second copy of it. */
export type AssigneeCommitted = Omit<AssignmentCommitted, "id">;
export type MilestoneCommitted = Omit<MilestoneAssigned, "id">;
/** The service's own contract — the list as it now stands, the label acted on and the verb — not a second copy of it. */
export type LabelsChanged = LabelsCommitted;
export type VisibilityCommitted = Omit<WorkVisibilityCommitted, "id">;

const FAILED = {
  state: "state.failed",
  priority: "priority.failed",
  estimate: "estimate.failed",
  dueDate: "dueDate.failed",
  assignee: "assignee.failed",
  visibility: "visibility.failed",
  milestone: "milestone.failed",
  labels: "labels.failed",
} as const;

/**
 * The refusal names the surface the member is looking at. Takes the RAW
 * surface (`unknown`), because it also speaks for input that did not
 * parse — and only an exact `"backlog"` picks the table's sentence.
 */
async function failureText(surface: unknown, prop: keyof typeof FAILED): Promise<string> {
  if (surface === "backlog") return (await getTranslations("projects.backlog"))("actionFailed");
  return (await getTranslations("projects.item"))(FAILED[prop]);
}

/** A server action receives whatever was posted — read `surface` without trusting the type. */
const rawSurface = (input: unknown): unknown =>
  typeof input === "object" && input !== null ? (input as { surface?: unknown }).surface : undefined;

/**
 * State (`S`). It calls `changeState`, never `moveItemAction`: that
 * action with a `stateId` and no anchor resolves both anchors to null
 * and re-ranks the item to the BOTTOM of the project. `changeState` has
 * no rank parameter at all, so this path physically cannot re-rank —
 * which is also why the rank-only audit carve-out is never in play. A
 * state change is never a routine edit: `transitionState` writes the
 * activity row and `work_item.state_changed` in the same transaction.
 */
export async function setItemStateAction(
  input: z.input<typeof SetState>,
): Promise<ActionResult<StateCommitted>> {
  const ctx = await ctxOf();
  const parsed = SetState.safeParse(input);
  if (!parsed.success) return { ok: false, message: await failureText(rawSurface(input), "state") };
  const { itemId, projectKey, itemNumber, surface, stateId } = parsed.data;
  const tSeed = await getTranslations("projects.states.seed");
  const r = await runAction(itemReturnTo(surface, projectKey, itemNumber), async () => {
    const c = await changeState(ctx, itemId, stateId);
    return {
      stateId: c.stateId,
      stateCategory: c.stateCategory,
      stateName: stateLabel({ name: c.stateName, seedKey: c.stateSeedKey }, (k) => tSeed(k)),
      changed: c.changed,
    };
  });
  if (r.ok && r.value.changed) revalidate(projectKey);
  return r;
}

/** Priority (`P`) — a routine edit: an INTERNAL activity row, never audit. */
export async function setItemPriorityAction(
  input: z.input<typeof SetPriority>,
): Promise<ActionResult<PriorityCommitted>> {
  const ctx = await ctxOf();
  const parsed = SetPriority.safeParse(input);
  if (!parsed.success) return { ok: false, message: await failureText(rawSurface(input), "priority") };
  const { itemId, projectKey, itemNumber, surface, priority } = parsed.data;
  const r = await runAction(itemReturnTo(surface, projectKey, itemNumber), async () => {
    const c = await updateItemFields(ctx, itemId, { priority });
    return { priority: c.priority, changed: c.changed };
  });
  if (r.ok && r.value.changed) revalidate(projectKey);
  return r;
}

/** Estimate (`E`) — whole minutes, or null to clear. Routine: activity, never audit. */
export async function setItemEstimateAction(
  input: z.input<typeof SetEstimate>,
): Promise<ActionResult<EstimateCommitted>> {
  const ctx = await ctxOf();
  const parsed = SetEstimate.safeParse(input);
  if (!parsed.success) return { ok: false, message: await failureText(rawSurface(input), "estimate") };
  const { itemId, projectKey, itemNumber, surface, estimateMinutes } = parsed.data;
  const r = await runAction(itemReturnTo(surface, projectKey, itemNumber), async () => {
    const c = await updateItemFields(ctx, itemId, { estimateMinutes });
    return { estimateMinutes: c.estimateMinutes, changed: c.changed };
  });
  if (r.ok && r.value.changed) revalidate(projectKey);
  return r;
}

/**
 * Due date (`D`) — an ISO date ("2026-09-15") or null to clear. Routine,
 * so no audit; but `targetDate` IS on the portal-safe list (activity.ts),
 * so on a client-visible item its activity row is CLIENT_VISIBLE.
 */
export async function setItemDueDateAction(
  input: z.input<typeof SetDueDate>,
): Promise<ActionResult<DueDateCommitted>> {
  const ctx = await ctxOf();
  const parsed = SetDueDate.safeParse(input);
  if (!parsed.success) return { ok: false, message: await failureText(rawSurface(input), "dueDate") };
  const { itemId, projectKey, itemNumber, surface, targetDate } = parsed.data;
  const locale = await getLocale();
  const r = await runAction(itemReturnTo(surface, projectKey, itemNumber), async () => {
    // `dateColumn` = UTC midnight, matching the `@db.Date` column and
    // updateItemFields' own `toISOString().slice(0, 10)` diff. What comes
    // back is what the column STORED, not what was sent.
    const c = await updateItemFields(ctx, itemId, {
      targetDate: targetDate === null ? null : dateColumn(targetDate),
    });
    return {
      targetDate: c.targetDate ? isoDateOf(c.targetDate) : null,
      dueLabel: c.targetDate ? formatDay(locale, c.targetDate) : null,
      changed: c.changed,
    };
  });
  if (r.ok && r.value.changed) revalidate(projectKey);
  return r;
}

/**
 * Assignee (`A`) — a member's id, or null to unassign. A routine edit:
 * an INTERNAL activity row (`assignee` is not portal-safe), never audit;
 * a real assignment notifies the member (debounced email). Members only:
 * a contact assignee is Phase 3's, with the "make it client-visible?"
 * warning that has to come with it (UI.md §5.2).
 */
export async function setItemAssigneeAction(
  input: z.input<typeof SetAssignee>,
): Promise<ActionResult<AssigneeCommitted>> {
  const ctx = await ctxOf();
  const parsed = SetAssignee.safeParse(input);
  if (!parsed.success) return { ok: false, message: await failureText(rawSurface(input), "assignee") };
  const { itemId, projectKey, itemNumber, surface, memberId } = parsed.data;
  const r = await runAction(itemReturnTo(surface, projectKey, itemNumber), async () => {
    const c = await assignItem(ctx, itemId, memberId);
    return { assigneeMemberId: c.assigneeMemberId, assigneeName: c.assigneeName, changed: c.changed };
  });
  if (r.ok && r.value.changed) revalidate(projectKey);
  return r;
}

/**
 * Milestone (`M`) — one of the item's own project's phases, or null to
 * take it out of the one it is under. A ROUTINE edit (founder decision
 * 2026-09-12): an activity row, never an audit event. `milestoneId` IS
 * on the portal-safe list (activity.ts), so on a client-visible task
 * that row is client-visible — and it carries the phase's ID, never its
 * name, so what a reader is told the phase is called is always their own
 * RLS's answer (items.ts, `setItemMilestone`).
 */
export async function setItemMilestoneAction(
  input: z.input<typeof SetMilestone>,
): Promise<ActionResult<MilestoneCommitted>> {
  const ctx = await ctxOf();
  const parsed = SetMilestone.safeParse(input);
  if (!parsed.success) return { ok: false, message: await failureText(rawSurface(input), "milestone") };
  const { itemId, projectKey, itemNumber, surface, milestoneId } = parsed.data;
  const r = await runAction(itemReturnTo(surface, projectKey, itemNumber), async () => {
    const c = await setItemMilestone(ctx, itemId, milestoneId);
    return {
      milestoneId: c.milestoneId,
      milestoneName: c.milestoneName,
      milestoneStatus: c.milestoneStatus,
      changed: c.changed,
    };
  });
  if (r.ok && r.value.changed) revalidate(projectKey);
  return r;
}

/**
 * Labels (`L`), the toggle: ONE label on or off the task. Routine — an
 * INTERNAL history row, never audit (`labels` is not portal-safe). The
 * answer is the whole list as it then stands, so two members labelling
 * one task never overwrite each other.
 */
export async function setItemLabelAction(input: z.input<typeof SetLabel>): Promise<ActionResult<LabelsChanged>> {
  const ctx = await ctxOf();
  const parsed = SetLabel.safeParse(input);
  if (!parsed.success) return { ok: false, message: await failureText(rawSurface(input), "labels") };
  const { itemId, projectKey, itemNumber, surface, labelId, on } = parsed.data;
  const r = await runAction(itemReturnTo(surface, projectKey, itemNumber), () => setItemLabel(ctx, itemId, labelId, on));
  if (r.ok && r.value.changed) revalidate(projectKey);
  return r;
}

/**
 * Labels (`L`), the typed row: a NEW tenant-wide label with the typed
 * name, put on this task in the same transaction — `label:manage` for
 * the word (audited `label.created`), `work_item:edit` for the task, and
 * nothing created when either is refused.
 */
export async function createItemLabelAction(
  input: z.input<typeof CreateLabel>,
): Promise<ActionResult<LabelsChanged>> {
  const ctx = await ctxOf();
  const parsed = CreateLabel.safeParse(input);
  if (!parsed.success) return { ok: false, message: await failureText(rawSurface(input), "labels") };
  const { itemId, projectKey, itemNumber, surface, name } = parsed.data;
  const r = await runAction(itemReturnTo(surface, projectKey, itemNumber), async () => {
    const c = await createLabel(ctx, { name, applyTo: itemId });
    return { labels: c.labels, label: c.label, verb: "created" as const, changed: true };
  });
  if (r.ok) revalidate(projectKey);
  return r;
}

/**
 * Visibility (`V`) — SAFETY-CRITICAL (UI.md §10.4), and never routine:
 * an activity row and `work_item.visibility_changed` in the same
 * transaction. A downgrade over a subtask, comment or file the client can
 * still see is refused by the database and reaches the caller as the
 * typed `HAS_VISIBLE_CHILDREN` sentence, which says what to make private
 * first — the surface toasts it and keeps showing the value the row
 * still holds.
 */
export async function setItemVisibilityAction(
  input: z.input<typeof SetVisibility>,
): Promise<ActionResult<VisibilityCommitted>> {
  const ctx = await ctxOf();
  const parsed = SetVisibility.safeParse(input);
  if (!parsed.success) return { ok: false, message: await failureText(rawSurface(input), "visibility") };
  const { itemId, projectKey, itemNumber, surface, visibility } = parsed.data;
  const r = await runAction(itemReturnTo(surface, projectKey, itemNumber), async () => {
    const c = await changeItemVisibility(ctx, itemId, visibility);
    return { visibility: c.visibility, changed: c.changed };
  });
  if (r.ok && r.value.changed) revalidate(projectKey);
  return r;
}

export async function setItemArchivedAction(
  itemId: string,
  projectKey: string,
  archived: boolean,
): Promise<FormResult> {
  const ctx = await ctxOf();
  const t = await getTranslations("projects.backlog");
  const id = uuid.safeParse(itemId);
  const key = keyShape.safeParse(projectKey);
  if (!id.success || !key.success) return { ok: false, message: t("invalidTitle") };
  let changed = false;
  const r = await runForm(backlogPath(key.data), async () => {
    // The sentence names the item's STATE — archived, restored — which is
    // true whether this call wrote it or a colleague's did a moment ago.
    ({ changed } = await setItemArchived(ctx, id.data, archived));
    return archived ? t("archivedToast") : t("restoredToast");
  });
  // Nothing to re-render for a write that did not happen.
  if (r.ok && changed) revalidate(key.data);
  return r;
}

export async function deleteItemAction(itemId: string, projectKey: string): Promise<FormResult> {
  const ctx = await ctxOf();
  const t = await getTranslations("projects.backlog");
  const id = uuid.safeParse(itemId);
  const key = keyShape.safeParse(projectKey);
  if (!id.success || !key.success) return { ok: false, message: t("invalidTitle") };
  const r = await runForm(backlogPath(key.data), async () => {
    await deleteItem(ctx, id.data);
    return t("deletedToast");
  });
  if (r.ok) revalidate(key.data);
  return r;
}

/**
 * Board: title-only create straight into a column (UI rule 2). The id +
 * number come back for a caller that wants them; the board itself keeps
 * its optimistic card until the revalidated page replaces it, which is
 * the same round trip.
 */
export async function createItemInStateAction(
  projectId: string,
  projectKey: string,
  stateId: string,
  title: string,
): Promise<ActionResult<{ id: string; number: number }>> {
  const ctx = await ctxOf();
  const t = await getTranslations("projects.backlog");
  const parsed = z
    .object({
      projectId: uuid,
      projectKey: keyShape,
      stateId: uuid,
      title: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
    })
    .safeParse({ projectId, projectKey, stateId, title });
  if (!parsed.success) return { ok: false, message: t("invalidTitle") };
  const input = parsed.data;
  const r = await runAction(boardPath(input.projectKey), () =>
    createItem(ctx, { projectId: input.projectId, title: input.title, stateId: input.stateId }),
  );
  if (r.ok) revalidate(input.projectKey);
  return r;
}

/**
 * Board drop / "Move to…" (UI.md §7.1): the client sends ids — a target
 * state and at most the neighbour it lands after/before — never a rank.
 * The service computes the rank under lock and runs the state machine
 * in the same transaction; the canonical row comes back so the
 * optimistic card is replaced, not merged (§7.2).
 */
export async function moveItemAction(input: {
  itemId: string;
  projectKey: string;
  /**
   * Which surface asked. It is ONLY the return address: `runAction`'s
   * first argument is what `handleAuthzRedirect` sends a member back to
   * after a step-up, and this action hardcoded the board — so a move
   * that hit MFA_REQUIRED from the backlog returned the member to a
   * different page than the one they were working on. It is validated
   * as an enum and never used to build a path from caller-supplied
   * text.
   */
  surface?: "board" | "backlog";
  stateId?: string;
  afterId?: string | null;
  beforeId?: string | null;
}): Promise<ActionResult<MovedItem>> {
  const ctx = await ctxOf();
  // The refusal has to name the surface the member is looking at: the
  // board's string ends "the board shows the current state", which is
  // the wrong sentence to show someone reordering a list.
  const [tBoard, tView] = await Promise.all([
    getTranslations("projects.board"),
    getTranslations("projects.workView"),
  ]);
  const invalid = () => ({
    ok: false as const,
    message: input.surface === "backlog" ? tView("move.failed") : tBoard("moveFailed"),
  });
  const parsed = z
    .object({
      itemId: uuid,
      projectKey: keyShape,
      surface: z.enum(["board", "backlog"]).default("board"),
      stateId: uuid.optional(),
      afterId: uuid.nullable().optional(),
      beforeId: uuid.nullable().optional(),
    })
    .safeParse(input);
  if (!parsed.success) return invalid();
  const { itemId, projectKey, surface, stateId, afterId, beforeId } = parsed.data;
  const returnTo = surface === "backlog" ? backlogPath(projectKey) : boardPath(projectKey);
  const r = await runAction(returnTo, () =>
    moveItem(ctx, {
      itemId,
      ...(stateId ? { stateId } : {}),
      afterId: afterId ?? null,
      beforeId: beforeId ?? null,
    }),
  );
  if (r.ok) revalidate(projectKey);
  return r;
}

/**
 * The selection bar's three verbs (2W-F slice 4). Each parses, calls the
 * one bulk service and revalidates both work surfaces; the service owns
 * the transaction, the gates and the audit rows.
 *
 * The id list is validated as UUIDs and capped HERE as well as in the
 * service — the cap is a contract, not a performance guess, and a
 * server action is a public entry point.
 */
const bulkShape = z.object({
  itemIds: z.array(uuid).min(1).max(MAX_BULK_ITEMS),
  projectKey: keyShape,
});

export async function bulkChangeStateAction(
  itemIds: string[],
  projectKey: string,
  stateId: string,
): Promise<ActionResult<BulkResult>> {
  const ctx = await ctxOf();
  const t = await getTranslations("projects.workView");
  const parsed = bulkShape.extend({ stateId: uuid }).safeParse({ itemIds, projectKey, stateId });
  if (!parsed.success) return { ok: false, message: t("bulk.failed") };
  const input = parsed.data;
  const r = await runAction(backlogPath(input.projectKey), () =>
    bulkChangeState(ctx, input.itemIds, input.stateId),
  );
  if (r.ok) revalidate(input.projectKey);
  return r;
}

export async function bulkSetPriorityAction(
  itemIds: string[],
  projectKey: string,
  priority: string,
): Promise<ActionResult<BulkResult>> {
  const ctx = await ctxOf();
  const t = await getTranslations("projects.workView");
  const parsed = bulkShape.extend({ priority: z.enum(PRIORITIES) }).safeParse({ itemIds, projectKey, priority });
  if (!parsed.success) return { ok: false, message: t("bulk.failed") };
  const input = parsed.data;
  const r = await runAction(backlogPath(input.projectKey), () =>
    bulkSetPriority(ctx, input.itemIds, input.priority),
  );
  if (r.ok) revalidate(input.projectKey);
  return r;
}

export async function bulkSetArchivedAction(
  itemIds: string[],
  projectKey: string,
  archived: boolean,
): Promise<ActionResult<BulkResult>> {
  const ctx = await ctxOf();
  const t = await getTranslations("projects.workView");
  const parsed = bulkShape.extend({ archived: z.boolean() }).safeParse({ itemIds, projectKey, archived });
  if (!parsed.success) return { ok: false, message: t("bulk.failed") };
  const input = parsed.data;
  const r = await runAction(backlogPath(input.projectKey), () =>
    bulkSetArchived(ctx, input.itemIds, input.archived),
  );
  if (r.ok) revalidate(input.projectKey);
  return r;
}
