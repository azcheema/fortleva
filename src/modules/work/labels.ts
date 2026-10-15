import { record } from "@/audit/record";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { isLabelColor, type LabelColor } from "@/lib/label-colors";
import { singleLineName } from "@/lib/single-line-name";
import { MAX_LABEL_NAME_LENGTH, compareLabelNames } from "@/lib/work-view";

import { writeActivity } from "./activity";
import { guarded } from "./db-errors";
import { loadItemInScope, type ItemRow } from "./rows";
import { principalOf, type WorkCtx } from "./states";

/**
 * Labels (DATA_MODEL §6.14, UI.md §5.2 `L`): tenant-wide tags with an
 * optional project scope — class A, no visibility column, and
 * INTERNAL-ONLY in v1: a label never reaches the portal, `labelId` is
 * on `PORTAL_FORBIDDEN_COLUMNS`, and `labels` is not a portal-safe
 * activity field, so every history row this module writes is INTERNAL
 * by construction. Planner's per-plan-label trap is avoided on purpose:
 * one tenant vocabulary, offered on every task.
 *
 * WHAT IS ROUTINE AND WHAT IS NOT. Filing a task under a label, or
 * taking it out again, is a routine edit by the founder's 2026-09-12
 * decision (labels are named in the carve-out): a `WorkItemActivity`
 * row, never an audit event. CREATING a label is a tenant-level act
 * under `label:manage` and audits `label.created` — a new word in the
 * tenant's vocabulary is not routine.
 *
 * THE READ IS NOT ON THE BARREL, for the reason `readItemSubtasks` and
 * `readItemComments` are not: a row carries a label id, which is on the
 * portal-forbidden list, and `portal-projections.test.ts` greps only
 * `portal.ts` files — so the non-export is the belt, and `getItemDetail`
 * is the one caller.
 */

export type LabelEntry = {
  id: string;
  name: string;
  /** A palette token name (`@/lib/label-colors`), or null — never a hex literal (UI.md §10). Drawn as a dot inside the neutral chip (slice 123). */
  color: string | null;
};

/** What the panel needs: the task's own labels, and the vocabulary it may pick from. */
export type ItemLabels = {
  /** The task's labels, by name. */
  applied: LabelEntry[];
  /**
   * Every label this task may carry — the tenant-wide ones and this
   * project's own — by name. Empty for a member who cannot edit: a
   * viewer's panel renders the labels as text and never lists the rest.
   */
  offered: LabelEntry[];
};

const select = { id: true, name: true, color: true } as const;

/** The vocabulary a task in `projectId` may draw from: tenant-wide labels plus its project's own. */
const offeredWhere = (tenantId: string, projectId: string) => ({
  tenantId,
  OR: [{ projectId: null }, { projectId }],
});

const byName = (labels: LabelEntry[]): LabelEntry[] => labels.sort((a, b) => compareLabelNames(a.name, b.name));

/**
 * Every listed item's labels, for the board card's and the backlog row's
 * chips (`listItems`). ONE read over the page's ids, never a query per
 * row: `work_item_label`'s primary key is
 * `(tenant_id, work_item_id, label_id)`, so the `IN` is an index scan.
 * Grouped and sorted HERE with the rail's own `select` and `byName`, so
 * the list and the panel cannot disagree about a label's shape or order.
 *
 * Off the barrel for the reason the rest of this module's reads are: the
 * rows carry label ids, which are portal-forbidden.
 */
export async function readLabelsByItem(
  tx: TenantDb,
  tenantId: string,
  workItemIds: readonly string[],
): Promise<Map<string, LabelEntry[]>> {
  const rows = await tx.workItemLabel.findMany({
    where: { tenantId, workItemId: { in: [...workItemIds] } },
    select: { workItemId: true, label: { select } },
  });
  const byItem = new Map<string, LabelEntry[]>();
  for (const row of rows) {
    const list = byItem.get(row.workItemId);
    if (list) list.push(row.label);
    else byItem.set(row.workItemId, [row.label]);
  }
  for (const list of byItem.values()) byName(list);
  return byItem;
}

async function appliedLabels(tx: TenantDb, tenantId: string, workItemId: string): Promise<LabelEntry[]> {
  const rows = await tx.workItemLabel.findMany({ where: { tenantId, workItemId }, select: { label: { select } } });
  // Sorted HERE, by the one comparator, never by the database's collation
  // (compareLabelNames says why).
  return byName(rows.map((r) => r.label));
}

/**
 * The panel's labels, inside `getItemDetail`'s transaction and behind
 * its scope check. `offered` is read only for a member who can edit,
 * the rule `activeMembers` and the milestones follow.
 */
export async function readItemLabels(
  tx: TenantDb,
  tenantId: string,
  item: { id: string; projectId: string },
  canEdit: boolean,
): Promise<ItemLabels> {
  const [applied, offered] = await Promise.all([
    appliedLabels(tx, tenantId, item.id),
    canEdit ? tx.label.findMany({ where: offeredWhere(tenantId, item.projectId), select }) : Promise.resolve([]),
  ]);
  return { applied, offered: byName(offered) };
}

/**
 * What a label change left on the task — the canonical list the `L`
 * picker replaces its optimistic slice with (UI.md §7.2): ALL of the
 * task's labels after the write, read back in the same transaction, so
 * a colleague's concurrent add is shown rather than overwritten.
 */
/** What a label change did — the three words the history rows and the live region use. */
export type LabelVerb = "added" | "removed" | "created";

export type LabelsCommitted = {
  labels: LabelEntry[];
  /** The label acted on, by its current name — what the live region speaks, whichever way it went. */
  label: LabelEntry;
  verb: LabelVerb;
  /**
   * False when the task already had (or already lacked) that label: no
   * INSERT or DELETE happened, no activity row. Decided by the write's
   * own row count, not by a read before it — two members adding the
   * same label at once both hold SHARE on the task, and the join's
   * primary key, not a prior SELECT, decides which of them wrote.
   */
  changed: boolean;
};

/**
 * Put ONE label on the task, or take it off. One label per commit,
 * because the picker commits one row and closes (UI.md §5.2) — there
 * is no "set the whole list" write, so two members editing the same
 * task's labels never overwrite each other's adds.
 *
 * The task is share-locked (rows.ts `"SHARE"`), the lock of a writer of
 * ANOTHER table's row that must hold the item still and alive — the
 * comment writer's lock, for the comment writer's reason: a join row
 * must not land on a task that is being deleted underneath it. Two adds
 * of different labels on one task therefore run side by side, and two
 * adds of the SAME label are settled by `createMany`'s `skipDuplicates`
 * against the join's primary key: exactly one of them counts.
 *
 * The label must be one the task may carry — tenant-wide, or this
 * project's own. A label of another project is `NOT_FOUND`, as absent as
 * one that does not exist (AUTHZ §4). Nothing creates a project-scoped
 * label yet, so this check has no database belt the way the milestone's
 * has (`work_item_milestone_guard`); the day something does, the trigger
 * lands with it.
 */
export async function setItemLabel(
  ctx: WorkCtx,
  itemId: string,
  labelId: string,
  on: boolean,
): Promise<LabelsCommitted> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:edit");
      const item = await loadItemInScope(tx, ctx, itemId, { lock: "SHARE" });
      const label =
        (await tx.label.findFirst({
          where: { ...offeredWhere(ctx.tenantId, item.projectId), id: labelId },
          select,
        })) ?? deny("NOT_FOUND");
      const changed = await writeLabel(tx, ctx, item, labelId, on);
      return {
        labels: await appliedLabels(tx, ctx.tenantId, item.id),
        label,
        verb: on ? "added" : "removed",
        changed,
      };
    }),
  );
}

/** The join write and its history row — shared by the toggle and by a create that applies at once. */
async function writeLabel(tx: TenantDb, ctx: WorkCtx, item: ItemRow, labelId: string, on: boolean): Promise<boolean> {
  const { count } = on
    ? await tx.workItemLabel.createMany({
        data: { tenantId: ctx.tenantId, workItemId: item.id, labelId },
        skipDuplicates: true,
      })
    : await tx.workItemLabel.deleteMany({ where: { tenantId: ctx.tenantId, workItemId: item.id, labelId } });
  if (count === 0) return false;
  // Routine: a history row, no audit. `labels` is not portal-safe, so the
  // row is INTERNAL whatever the task's visibility — a label is a word the
  // client never sees. The refs carry the fact in the schema's own shape
  // (§6.14, as the assignee's and the milestone's rows do): an add is
  // `newRef`, a removal `oldRef`. The label's NAME is never written; the
  // read resolves the ref (activity.ts), so a rename shows the current
  // name and a deleted label reads as one that is gone.
  await writeActivity(tx, ctx, item, { field: "labels", oldRef: on ? null : labelId, newRef: on ? labelId : null });
  return true;
}

/**
 * What a create answers: the label, and — when it was put on a task in
 * the same transaction — that task's labels afterwards. The type follows
 * the argument, so a caller that applied is never handed `null` to
 * paper over with an empty list.
 */
export type LabelCreated<A extends string | undefined = undefined> = {
  label: LabelEntry;
  labels: A extends string ? LabelEntry[] : null;
};

/**
 * A new tenant-wide label, under `label:manage`, audited `label.created`
 * — optionally put on one task in the same transaction, which is how
 * the picker's "Create “…”" row works: one transaction, so a member who
 * may create but may not edit this task (or whose task vanished
 * meanwhile) creates nothing, rather than a label nobody asked for.
 *
 * THE NAME IS UNIQUE PER TENANT, CASE-INSENSITIVELY, AND THE DATABASE
 * DECIDES: `label_tenant_wide_name_key` (20260915180000) is a partial
 * unique index on `(tenant_id, lower(name)) WHERE project_id IS NULL`,
 * because the schema's `(tenant_id, project_id, name)` index cannot
 * refuse two tenant-wide names — NULLs are distinct to a unique index.
 * No probe, no lock: two creators race straight to the index and the
 * second is told `LABEL_TAKEN` (`db-errors.ts` maps the index's name).
 * The first cut checked under a tenant-wide advisory lock; the review
 * showed it was held to COMMIT across the audit and join writes, and
 * that any later writer of `name` would have bypassed it.
 */
export async function createLabel<A extends string | undefined = undefined>(
  ctx: WorkCtx,
  input: { name: string; applyTo?: A; color?: LabelColor | null },
): Promise<LabelCreated<A>> {
  // The bound lives in @/lib/work-view (client-safe); the action's zod
  // shape enforces it first, this is the belt.
  const name = labelName(input.name);
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "label:manage");
      // The task first, when there is one: its edit permission and scope
      // are refused BEFORE any label row exists.
      // Presence, not truthiness: the return type keys on `A extends
      // string`, and an empty string is a string.
      const item =
        input.applyTo !== undefined
          ? (await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:edit"),
            await loadItemInScope(tx, ctx, input.applyTo, { lock: "SHARE" }))
          : null;
      const label = await tx.label.create({
        data: { tenantId: ctx.tenantId, projectId: null, name, color: input.color ?? null },
        select,
      });
      await record(tx, {
        action: "label.created",
        targetType: "Label",
        targetId: label.id,
        metadata: { name: label.name },
      });
      const labels = item ? (await writeLabel(tx, ctx, item, label.id, true), await appliedLabels(tx, ctx.tenantId, item.id)) : null;
      return { label, labels: labels as LabelCreated<A>["labels"] };
    }),
  );
}

/** A label name as it will be stored (`singleLineName`), or the refusal — one rule for create and rename. */
function labelName(raw: string): string {
  const checked = singleLineName(raw, MAX_LABEL_NAME_LENGTH);
  return checked.ok ? checked.name : fail(checked.code);
}

// ── The labels page (slice 123, founder decision C99 (b)) ───────────
//
// Settings → Labels: rename, colour, delete, merge — every one under
// `label:manage` and audited, because each changes the vocabulary on
// every task at once (design doc §7). Only tenant-wide labels: nothing
// makes a project-scoped one yet, and a scoped id here is NOT_FOUND.
//
// NO PER-TASK HISTORY ROWS for any of the four. A history row holds the
// label's id and the read resolves it (`activity.ts`), so a rename is
// shown everywhere at once and a deleted label reads as one that is gone
// — which is also what a merged label's old rows say. The audit row is
// the record of the act.

/** One row of the labels page. `tasks` counts tasks on the board and in the archive — not the bin. */
export type LabelRow = LabelEntry & { tasks: number };

export async function listWorkspaceLabels(ctx: WorkCtx): Promise<LabelRow[]> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "label:manage");
    const rows = await tx.label.findMany({
      where: { tenantId: ctx.tenantId, projectId: null },
      select: {
        ...select,
        _count: { select: { workItems: { where: { workItem: { deletedAt: null } } } } },
      },
    });
    return rows
      .map(({ _count, ...l }) => ({ ...l, tasks: _count.workItems }))
      .sort((a, b) => compareLabelNames(a.name, b.name));
  });
}

/**
 * The label, locked for this transaction's write — so a rename's audit
 * `from` is the name it replaced, and two merges cannot interleave.
 * Tenant-wide only; anything else is as absent as a missing one.
 *
 * `"keep"` is the lock of a label that SURVIVES this transaction — a
 * merge's target: `FOR NO KEY UPDATE`, which a concurrent "put it on a
 * task" does not wait on (its foreign-key check takes only KEY SHARE).
 * `FOR UPDATE` there was a deadlock: that add holds its new join row and
 * waits on the target's lock, while the merge's INSERT reaches the same
 * uncommitted join row and waits on the add (the code review's LOW).
 */
async function lockLabel(
  tx: TenantDb,
  tenantId: string,
  id: string,
  mode: "write" | "keep" = "write",
): Promise<{ id: string; name: string; color: string | null }> {
  const [row] =
    mode === "keep"
      ? await tx.$queryRaw<{ id: string; name: string; color: string | null }[]>`
          SELECT id, name, color FROM label
          WHERE tenant_id = ${tenantId} AND id = ${id} AND project_id IS NULL
          FOR NO KEY UPDATE`
      : await tx.$queryRaw<{ id: string; name: string; color: string | null }[]>`
          SELECT id, name, color FROM label
          WHERE tenant_id = ${tenantId} AND id = ${id} AND project_id IS NULL
          FOR UPDATE`;
  return row ?? deny("NOT_FOUND");
}

export async function renameLabel(ctx: WorkCtx, id: string, rawName: string): Promise<LabelEntry> {
  const name = labelName(rawName);
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "label:manage");
      const before = await lockLabel(tx, ctx.tenantId, id);
      if (before.name === name) return { id, name, color: before.color };
      // The index decides a clash, case-insensitively (`LABEL_TAKEN`) — a
      // change of case alone is the same row and passes.
      const label = await tx.label.update({ where: { id }, data: { name }, select });
      await record(tx, {
        action: "label.renamed",
        targetType: "Label",
        targetId: id,
        metadata: { from: before.name, to: name },
      });
      return label;
    }),
  );
}

export async function setLabelColor(ctx: WorkCtx, id: string, color: LabelColor | null): Promise<LabelEntry> {
  // The database's `label_color_token` CHECK is the belt.
  if (color !== null && !isLabelColor(color)) fail("INVALID_INPUT", "not a palette colour");
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "label:manage");
    const before = await lockLabel(tx, ctx.tenantId, id);
    if (before.color === color) return { id, name: before.name, color };
    const label = await tx.label.update({ where: { id }, data: { color }, select });
    await record(tx, {
      action: "label.color_changed",
      targetType: "Label",
      targetId: id,
      metadata: { name: before.name, color },
    });
    return label;
  });
}

/** Deleting a label takes it off every task (the join cascades) — the bin's tasks too. */
export async function deleteLabel(ctx: WorkCtx, id: string): Promise<{ tasks: number }> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "label:manage");
    const label = await lockLabel(tx, ctx.tenantId, id);
    const tasks = await tx.workItemLabel.count({ where: { tenantId: ctx.tenantId, labelId: id } });
    await tx.label.delete({ where: { id }, select: { id: true } });
    await record(tx, {
      action: "label.deleted",
      targetType: "Label",
      targetId: id,
      metadata: { name: label.name, tasks },
    });
    return { tasks };
  });
}

/**
 * MERGE `fromId` INTO `intoId`: every task wearing the first wears the
 * second (once — a task with both keeps one), and the first is gone.
 *
 * Both labels are locked in ID ORDER — the source `FOR UPDATE` (it is
 * deleted), the target `FOR NO KEY UPDATE` (it survives; `lockLabel`'s
 * `"keep"`) — so two opposite merges at once cannot deadlock: the second
 * waits on the first's lock, then finds its source gone (NOT_FOUND). A
 * member putting the SOURCE label on a task meanwhile waits on its lock
 * (the join's foreign-key check) and then finds it gone too
 * (`LABEL_GONE`, `db-errors.ts`); one putting the TARGET on waits on
 * nothing this holds.
 */
export async function mergeLabel(ctx: WorkCtx, fromId: string, intoId: string): Promise<{ tasks: number }> {
  if (fromId === intoId) fail("INVALID_INPUT", "a label cannot be merged into itself");
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "label:manage");
      const [first, second] = fromId < intoId ? [fromId, intoId] : [intoId, fromId];
      const a = await lockLabel(tx, ctx.tenantId, first, first === fromId ? "write" : "keep");
      const b = await lockLabel(tx, ctx.tenantId, second, second === fromId ? "write" : "keep");
      const from = a.id === fromId ? a : b;
      const into = a.id === intoId ? a : b;
      const tasks = await tx.workItemLabel.count({ where: { tenantId: ctx.tenantId, labelId: from.id } });
      await tx.$executeRaw`
        INSERT INTO work_item_label (tenant_id, work_item_id, label_id, created_at)
        SELECT tenant_id, work_item_id, ${into.id}, now()
        FROM work_item_label
        WHERE tenant_id = ${ctx.tenantId} AND label_id = ${from.id}
        ON CONFLICT DO NOTHING`;
      await tx.label.delete({ where: { id: from.id }, select: { id: true } });
      await record(tx, {
        action: "label.merged",
        targetType: "Label",
        targetId: into.id,
        metadata: { from: from.name, into: into.name, fromId: from.id, tasks },
      });
      return { tasks };
    }),
  );
}
