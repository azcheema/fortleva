import { record } from "@/audit/record";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { dateColumn, isoDateOf, localDateString } from "@/lib/duration";
import { newId } from "@/lib/ids";
import {
  REPEAT_MAX_DESCRIPTION_BYTES,
  REPEAT_MAX_SUBTASKS,
  anchorFor,
  firstRepeatDay,
  isRepeatRhythm,
  isWeekRhythm,
  nextDayAllowed,
  repeatValue,
  type RepeatRhythm,
} from "@/lib/repeat-rules";
import { readPreferences } from "@/preferences/service";

import { writeActivity } from "./activity";
import { lockItemRow } from "./rank-lock";
import { loadItemInScope } from "./rows";
import { principalOf, type WorkCtx } from "./states";
import { takeTasks, type SourceTaskHead } from "./templates/definition";

/**
 * REPEATING TASKS — the member's side (slice 127; founder decision C103 —
 * docs/research/2026-10-17-slice-127-repeating-tasks-design.md). A task is
 * set to repeat with a rhythm and the day of its next copy; the jobs route
 * makes each copy (`repeat-copies.ts`) and moves the setting onto it, so the
 * NEWEST task of a series is always the one that holds it — "to change
 * future copies, edit the newest one" (C103 (a)).
 *
 * Who (design §3.7): `work_item:edit` AND `work_item:create`, the task's
 * project in scope — the setting is a standing instruction to create tasks.
 * No new permission code.
 *
 * Audited (`work_item.repeat_changed`) as well as a history row: a standing
 * instruction to make tasks is not one of AGENTS.md's routine-edit
 * carve-outs. Neither the setting nor its history is ever a client's to read
 * (class A tables; the history row is forced INTERNAL).
 *
 * THE LOCK ORDER (design §3.6): the task's row (`loadItemInScope`, NO KEY
 * UPDATE), then the series row FOR UPDATE — item before series, which is
 * the copier's order too (it holds the task FOR SHARE before it locks the
 * series), so the two never close a cycle.
 */

/** What the task panel shows on the Repeat row. */
export type ItemRepeat =
  /** This task holds the setting: the next copy is made from it. */
  | {
      readonly role: "holder";
      readonly rhythm: RepeatRhythm;
      /** `YYYY-MM-DD`, the workspace's day the next copy appears on. */
      readonly nextOn: string;
      /** The project makes no copies now (archived, completed, cancelled, paused, or its client archived) — the copier skips it (§3.5). */
      readonly projectClosed: boolean;
    }
  /**
   * An older task of a series: the next copies are made from the newest.
   * `holderDeleted` — the newest is in the bin (or past it): the series
   * waits, and THIS task may stop it (the pre-apply review's M3 — else a
   * newest copy deleted for good would strand the series, unstoppable).
   */
  | { readonly role: "copy"; readonly holderNumber: number; readonly holderDeleted: boolean }
  | null;

/**
 * A project whose state means its series wait (design §3.5): archived,
 * completed, cancelled — and PAUSED (the pre-apply review's L1: a paused
 * retainer is not one to keep handing work out on). Its client archived too
 * (archiving a client does not archive its projects).
 */
export const PROJECT_STATUSES_WITHOUT_COPIES = ["ARCHIVED", "COMPLETED", "CANCELLED", "PAUSED"] as const;

export const projectMakesCopies = (p: {
  readonly status: string;
  readonly archivedAt: Date | null;
  readonly client: { readonly status: string };
}): boolean =>
  p.archivedAt === null && p.client.status !== "ARCHIVED" && !(PROJECT_STATUSES_WITHOUT_COPIES as readonly string[]).includes(p.status);

/** The same rule as a Prisma filter on a task's `project`, for the copier's reads. */
export const PROJECT_MAKES_COPIES_WHERE = {
  archivedAt: null,
  status: { notIn: [...PROJECT_STATUSES_WITHOUT_COPIES] },
  client: { status: { not: "ARCHIVED" as const } },
};

/**
 * The Repeat row's read — in SEQUENCE inside the caller's transaction (the
 * one-connection rule). The caller has already read the task as the viewer
 * (`getItemDetail`), so this reads only the two class-A rows and the
 * holder's number.
 */
export async function readItemRepeat(
  tx: TenantDb,
  tenantId: string,
  item: { readonly id: string; readonly projectId: string },
): Promise<ItemRepeat> {
  const held = await tx.workItemRepeat.findFirst({
    where: { tenantId, workItemId: item.id },
    select: { rhythm: true, nextOn: true },
  });
  if (held && isRepeatRhythm(held.rhythm)) {
    const project = await tx.project.findFirst({
      where: { tenantId, id: item.projectId },
      select: { status: true, archivedAt: true, client: { select: { status: true } } },
    });
    return {
      role: "holder",
      rhythm: held.rhythm,
      nextOn: isoDateOf(held.nextOn),
      projectClosed: project ? !projectMakesCopies(project) : false,
    };
  }
  const member = await tx.workItemRepeatItem.findFirst({
    where: { tenantId, workItemId: item.id },
    select: { repeat: { select: { workItem: { select: { number: true, deletedAt: true } } } } },
  });
  if (!member) return null;
  const holder = member.repeat.workItem;
  return { role: "copy", holderNumber: holder.number, holderDeleted: holder.deletedAt !== null };
}

/**
 * The tasks a copy of `holder` takes under it (design §3.3): its live
 * descendants by the template rule (`takeTasks` — no deleted task, no client
 * request, nothing in Triage or Cancelled, nothing whose parent is left out;
 * an ARCHIVED one is taken, below), RE-ROOTED at the holder, parents before
 * children and in rank order. Two levels at most below any task (the tree's depth cap).
 * Returns at most `limit`: a caller that needs to know only whether there
 * are more than N asks for N + 1.
 *
 * Every LIVE descendant's head is read (ids and the rule's columns, never a
 * description) — a left-out parent takes its children with it, so the rule
 * needs them all. A deleted row is filtered in SQL, which loses nothing: a
 * task with a live subtask cannot be deleted (`HAS_CHILDREN`).
 */
export async function copyableSubtree(
  tx: TenantDb,
  tenantId: string,
  holder: { readonly id: string; readonly depth: number },
  limit: number,
): Promise<{ id: string; parentId: string | null; depth: number }[]> {
  const rows = await tx.workItem.findMany({
    where: { tenantId, deletedAt: null, OR: [{ parentId: holder.id }, { parent: { parentId: holder.id } }] },
    select: { id: true, parentId: true, depth: true, type: true, kind: true, stateCategory: true, archivedAt: true, deletedAt: true },
    orderBy: [{ depth: "asc" }, { rank: "asc" }],
  });
  // NEVER a task of another series (the pre-apply review's M2 belt; setting
  // a repeat refuses nesting, `REPEAT_NESTED`, but a task moved under a
  // repeating one afterwards would otherwise bring its own copies along,
  // more each period). Left out as a left-out parent is: with its children.
  const inSeries = new Set(
    rows.length === 0
      ? []
      : (
          await tx.workItemRepeatItem.findMany({
            where: { tenantId, workItemId: { in: rows.map((r) => r.id) } },
            select: { workItemId: true },
          })
        ).map((m) => m.workItemId),
  );
  // An ARCHIVED subtask is still taken (the code review's L4): archiving this
  // period's finished steps is housekeeping, as it is for the holder (§3.5),
  // and must not drop a step from every later copy. A cancelled one is left
  // out — the step is not done any more — and a deleted one never read.
  const heads: SourceTaskHead[] = rows
    .filter((r) => !inSeries.has(r.id))
    .map((r) => ({
      ...r,
      archivedAt: null,
      parentId: r.parentId === holder.id ? null : r.parentId,
      depth: r.depth - holder.depth - 1,
    }));
  const taken = new Set(takeTasks(heads).slice(0, limit));
  return heads
    .filter((h) => taken.has(h.id))
    .map((h) => ({ id: h.id, parentId: h.parentId, depth: h.depth }));
}

/**
 * Each task's stored description size in bytes (its JSON text), measured in
 * SQL so no description is read to be weighed — the copy's budget (design
 * §3.3, `REPEAT_MAX_DESCRIPTION_BYTES`). Tasks without one are left out.
 */
export async function descriptionBytes(tx: TenantDb, tenantId: string, ids: readonly string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.$queryRaw<{ id: string; bytes: number }[]>`
    SELECT id, octet_length(description::text)::int AS bytes
    FROM work_item
    WHERE tenant_id = ${tenantId} AND id = ANY(${[...ids]}::text[]) AND description IS NOT NULL`;
  return new Map(rows.map((r) => [r.id, Number(r.bytes)]));
}

/** What the setting is now, as the action answers it. */
export type RepeatCommitted = {
  readonly rhythm: RepeatRhythm | null;
  readonly nextOn: string | null;
  /** False when the setting already said that: nothing written. */
  readonly changed: boolean;
};

/**
 * Start, change or stop a task's repeat.
 *
 * - `{ rhythm }` on a task that does not repeat starts it, the next copy one
 *   period from today in the workspace's zone (`firstRepeatDay`).
 * - `{ rhythm }` on the holder changes the rhythm and KEEPS the next day.
 * - `{ nextOn }` moves the next day — after today, at most two years ahead
 *   (`REPEAT_DAY_INVALID`) — and re-anchors on it.
 * - `null` stops it: the series is deleted and its older copies become plain
 *   tasks. An older copy may stop its series only while the newest is
 *   deleted (the pre-apply review's M3: a newest copy deleted for good would
 *   otherwise strand the series, every task of it answering NOT_NEWEST).
 *
 * THE ANCHOR (the review's L2): a month rhythm repeats on the day of the
 * month it was STARTED on (today's), so a repeat started on 31 January is
 * next on 28 February and on 31 March again; a change between month
 * rhythms keeps the stored anchor; only a picked day re-anchors.
 *
 * Refused: a client's request (`REPEAT_NOT_ALLOWED`), a task of a series
 * that is not its newest (`REPEAT_NOT_NEWEST` — the panel links to the
 * newest instead), a task inside a repeating task or with one inside it
 * (`REPEAT_NESTED` — the review's M2: the outer copy would take the inner
 * one's copies, more each period), more than `REPEAT_MAX_SUBTASKS` tasks
 * under one starting to repeat (`REPEAT_TOO_BIG`), a deleted task
 * (`NOT_FOUND`).
 */
export async function setItemRepeat(
  ctx: WorkCtx,
  itemId: string,
  next: { readonly rhythm?: RepeatRhythm; readonly nextOn?: string } | null,
  now: Date = new Date(),
): Promise<RepeatCommitted> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    // In sequence, never a batch leg (authz-batches.test.ts).
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:edit");
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:create");
    const item = await loadItemInScope(tx, ctx, itemId);
    if (item.kind === "REQUEST") fail("REPEAT_NOT_ALLOWED");

    // The series row LOCKED, then read — after the task's row (the order).
    await tx.$queryRaw`SELECT 1 FROM work_item_repeat WHERE tenant_id = ${ctx.tenantId} AND work_item_id = ${item.id} FOR UPDATE`;
    const series = await tx.workItemRepeat.findFirst({
      where: { tenantId: ctx.tenantId, workItemId: item.id },
      select: { id: true, rhythm: true, nextOn: true, anchorDay: true },
    });
    const current =
      series && isRepeatRhythm(series.rhythm) ? { rhythm: series.rhythm, nextOn: isoDateOf(series.nextOn) } : null;
    if (!series) {
      const member = await tx.workItemRepeatItem.findFirst({
        where: { tenantId: ctx.tenantId, workItemId: item.id },
        select: {
          repeatId: true,
          repeat: { select: { workItemId: true, rhythm: true, nextOn: true, anchorDay: true, workItem: { select: { deletedAt: true } } } },
        },
      });
      if (member) {
        // An older copy. It may STOP its series while the newest is deleted —
        // nothing else (M3). The newest task's row is share-locked and read
        // AGAIN before the series (the security review's L-2: a Bring back
        // committing in between would otherwise let this stop a series whose
        // newest is live) — tasks before series, the copier's order; the
        // series is deleted only if it still names that newest task.
        if (next !== null || member.repeat.workItem.deletedAt === null) fail("REPEAT_NOT_NEWEST");
        await lockItemRow(tx, ctx.tenantId, member.repeat.workItemId, "SHARE");
        const newest = await tx.workItem.findFirst({
          where: { tenantId: ctx.tenantId, id: member.repeat.workItemId },
          select: { deletedAt: true },
        });
        if (!newest || newest.deletedAt === null) fail("REPEAT_NOT_NEWEST");
        await tx.$queryRaw`SELECT 1 FROM work_item_repeat WHERE tenant_id = ${ctx.tenantId} AND id = ${member.repeatId} FOR UPDATE`;
        const gone = await tx.workItemRepeat.deleteMany({
          where: { tenantId: ctx.tenantId, id: member.repeatId, workItemId: member.repeat.workItemId },
        });
        if (gone.count === 0) fail("REPEAT_NOT_NEWEST"); // moved or stopped meanwhile
        const was = isRepeatRhythm(member.repeat.rhythm)
          ? { rhythm: member.repeat.rhythm, nextOn: isoDateOf(member.repeat.nextOn) }
          : null;
        await writeActivity(tx, ctx, item, { field: "repeat", oldValue: repeatValue(was), newValue: null, forceInternal: true });
        await record(tx, {
          action: "work_item.repeat_changed",
          targetType: "WorkItem",
          targetId: item.id,
          metadata: {
            number: item.number,
            projectId: item.projectId,
            from: was ? { ...was, anchorDay: member.repeat.anchorDay } : null,
            to: null,
            newestId: member.repeat.workItemId,
            newestDeleted: true,
          },
        });
        return { rhythm: null, nextOn: null, changed: true };
      }
    }

    let wanted: { rhythm: RepeatRhythm; nextOn: string; anchorDay: number | null } | null = null;
    if (next !== null) {
      const rhythm = next.rhythm ?? current?.rhythm;
      if (!rhythm) fail("INVALID_INPUT");
      const prefs = await readPreferences(tx, ctx.tenantId);
      const today = localDateString(now, prefs.timezone);
      let nextOn: string;
      let anchorDay: number | null;
      if (next.nextOn !== undefined) {
        // A day the MEMBER picked is held to the bounds, and anchors.
        if (!nextDayAllowed(next.nextOn, today)) fail("REPEAT_DAY_INVALID");
        nextOn = next.nextOn;
        anchorDay = anchorFor(rhythm!, nextOn);
      } else if (current) {
        // A rhythm change keeps the day the series is next on — even one the
        // copier has not reached yet today: that copy is still owed — and,
        // between two month rhythms, the anchor (a 31st stays a 31st).
        nextOn = current.nextOn;
        anchorDay =
          isWeekRhythm(rhythm!) ? null : !isWeekRhythm(current.rhythm) && series!.anchorDay !== null ? series!.anchorDay : anchorFor(rhythm!, nextOn);
      } else {
        const first = firstRepeatDay(rhythm!, today);
        if (first === null) fail("REPEAT_DAY_INVALID");
        nextOn = first!;
        // Today's day of the month — the day `firstRepeatDay` stepped on.
        anchorDay = anchorFor(rhythm!, today);
      }
      wanted = { rhythm: rhythm!, nextOn, anchorDay };
    }

    if (wanted === null && current === null) return { rhythm: null, nextOn: null, changed: false };
    if (wanted && current && wanted.rhythm === current.rhythm && wanted.nextOn === current.nextOn && wanted.anchorDay === series!.anchorDay) {
      return { ...current, changed: false };
    }

    if (wanted === null) {
      await tx.workItemRepeat.delete({ where: { id: series!.id }, select: { id: true } });
    } else if (series) {
      await tx.workItemRepeat.update({
        where: { id: series.id },
        data: { rhythm: wanted.rhythm, anchorDay: wanted.anchorDay, nextOn: dateColumn(wanted.nextOn) },
        select: { id: true },
      });
    } else {
      // Starting: never inside a repeating task, nor around one (M2) — the
      // task's parent and grandparent, and every live task under it.
      const ancestors: string[] = [];
      if (item.parentId) {
        ancestors.push(item.parentId);
        const parent = await tx.workItem.findFirst({ where: { tenantId: ctx.tenantId, id: item.parentId }, select: { parentId: true } });
        if (parent?.parentId) ancestors.push(parent.parentId);
      }
      const nested = await tx.workItemRepeatItem.findFirst({
        where: {
          tenantId: ctx.tenantId,
          OR: [
            { workItemId: { in: ancestors } },
            { workItem: { deletedAt: null, OR: [{ parentId: item.id }, { parent: { parentId: item.id } }] } },
          ],
        },
        select: { workItemId: true },
      });
      if (nested) fail("REPEAT_NESTED");
      // The tree under it is bounded (design §3.3): its tasks, and its
      // descriptions' bytes together (the security review's M-1).
      const under = await copyableSubtree(tx, ctx.tenantId, item, REPEAT_MAX_SUBTASKS + 1);
      if (under.length > REPEAT_MAX_SUBTASKS) fail("REPEAT_TOO_BIG");
      const sizes = await descriptionBytes(tx, ctx.tenantId, [item.id, ...under.map((u) => u.id)]);
      if ([...sizes.values()].reduce((a, b) => a + b, 0) > REPEAT_MAX_DESCRIPTION_BYTES) fail("REPEAT_TOO_BIG");
      const repeatId = newId();
      await tx.workItemRepeat.create({
        data: {
          id: repeatId,
          tenantId: ctx.tenantId,
          workItemId: item.id,
          rhythm: wanted.rhythm,
          anchorDay: wanted.anchorDay,
          nextOn: dateColumn(wanted.nextOn),
          createdByMemberId: ctx.actor.memberId,
        },
        select: { id: true },
      });
      await tx.workItemRepeatItem.create({
        data: { tenantId: ctx.tenantId, repeatId, workItemId: item.id, madeFor: null },
        select: { workItemId: true },
      });
    }

    const shown = wanted === null ? null : { rhythm: wanted.rhythm, nextOn: wanted.nextOn };
    await writeActivity(tx, ctx, item, {
      field: "repeat",
      oldValue: repeatValue(current),
      newValue: repeatValue(shown),
      forceInternal: true,
    });
    await record(tx, {
      action: "work_item.repeat_changed",
      targetType: "WorkItem",
      targetId: item.id,
      // `from` and `to` in one shape — rhythm, next day, anchor (the code review's NIT).
      metadata: {
        number: item.number,
        projectId: item.projectId,
        from: current ? { ...current, anchorDay: series!.anchorDay } : null,
        to: wanted,
      },
    });
    return shown === null ? { rhythm: null, nextOn: null, changed: true } : { ...shown, changed: true };
  });
}
