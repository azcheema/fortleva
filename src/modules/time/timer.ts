import { randomUUID } from "node:crypto";
import { cache } from "react";

import { record } from "@/audit/record";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { addHours, floorToSecond, localDateColumn, secondsBetween } from "@/lib/duration";
import { fail } from "@/lib/domain-error";

import { ensureTimeDefaults } from "./bootstrap";
import { LOCKED_TX, guarded, idsOnly, lockMember, principalOf, resolveZone, type TimeCtx } from "./ctx";
import { assertNoticeAcknowledged, noticeRequiredFor } from "./notice";
import { settleMemberOnce } from "./settle";
import { recomputeTouched } from "./summary";
import { resolveTarget, snapshotFor, type EntryTargetInput } from "./target";

/**
 * The personal timer (UI.md rule 9; DATA_MODEL.md §6.15 "Timer policy"):
 *  - start another ⇒ the running one is stopped in the SAME transaction
 *    and both rows are returned for the undo toast;
 *  - one running row per member is a DB invariant (partial unique);
 *    every start/stop runs under the member's advisory lock;
 *  - timers refuse to start until the staff notice is acknowledged;
 *  - starting a timer auto-closes an open break (working ⇒ not on break,
 *    D1); server-authoritative whole-second timestamps;
 *  - the 12 h auto-stop is applied lazily (settle.ts) before every read
 *    so it is correct before Vercel Pro crons exist.
 */

export type TimerEntry = {
  id: string;
  projectId: string | null;
  clientId: string | null;
  workItemId: string | null;
  serviceId: string | null;
  workTypeId: string | null;
  description: string | null;
  startedAt: Date;
  stoppedAt: Date | null;
  durationSeconds: number | null;
  billable: boolean;
  localDate: Date;
  timezone: string;
  entryMode: "TIMER" | "MANUAL" | "DURATION";
  needsReview: boolean;
  reviewReason: string | null;
  project: { key: string; name: string } | null;
  workItem: { number: number; title: string } | null;
  service: { name: string } | null;
  workType: { name: string } | null;
};

export const entrySelect = {
  id: true,
  projectId: true,
  clientId: true,
  workItemId: true,
  serviceId: true,
  workTypeId: true,
  description: true,
  startedAt: true,
  stoppedAt: true,
  durationSeconds: true,
  billable: true,
  localDate: true,
  timezone: true,
  entryMode: true,
  needsReview: true,
  reviewReason: true,
  project: { select: { key: true, name: true } },
  workItem: { select: { number: true, title: true } },
  service: { select: { name: true } },
  workType: { select: { name: true } },
} as const;

/** Stop the member's running entry (if any) at `at`; returns it or null. */
export async function stopRunningEntry(
  tx: TenantDb,
  tenantId: string,
  memberId: string,
  at: Date,
  reason: "user" | "switch" | "break" | "clock_out" | "auto",
): Promise<TimerEntry | null> {
  const running = await tx.timeEntry.findFirst({
    where: { tenantId, memberId, stoppedAt: null, deletedAt: null },
    select: entrySelect,
  });
  if (!running) return null;
  const stoppedAt = floorToSecond(at);
  const durationSeconds = secondsBetween(running.startedAt, stoppedAt);
  const updated = await tx.timeEntry.update({
    where: { id: running.id },
    data: { stoppedAt, durationSeconds },
    select: entrySelect,
  });
  await recomputeTouched(tx, tenantId, [{ projectId: updated.projectId, localDate: updated.localDate }]);
  await record(tx, {
    action: "timer.stopped",
    targetType: "TimeEntry",
    targetId: updated.id,
    metadata: idsOnly({ reason, durationSeconds, projectId: updated.projectId, workItemId: updated.workItemId }),
  });
  return updated;
}

/** Close the member's open break (if any) at `at` — "working ⇒ not on break". */
export async function closeOpenBreak(
  tx: TenantDb,
  tenantId: string,
  memberId: string,
  at: Date,
): Promise<{ shiftId: string; breakId: string } | null> {
  const open = await tx.shiftBreak.findFirst({
    where: { tenantId, memberId, stoppedAt: null, shift: { stoppedAt: null, deletedAt: null } },
    select: { id: true, shiftId: true, startedAt: true },
  });
  if (!open) return null;
  const stoppedAt = floorToSecond(at);
  await tx.shiftBreak.update({
    where: { id: open.id },
    data: { stoppedAt, durationSeconds: secondsBetween(open.startedAt, stoppedAt) },
  });
  await record(tx, {
    action: "shift.break_stopped",
    targetType: "Shift",
    targetId: open.shiftId,
    metadata: { breakId: open.id, reason: "timer_started" },
  });
  return { shiftId: open.shiftId, breakId: open.id };
}

/**
 * time:track — start a timer on a task / project / ad-hoc description.
 * Returns the new running entry and the one it auto-stopped (undo toast).
 */
export async function startTimer(
  ctx: TimeCtx,
  input: EntryTargetInput,
): Promise<{ started: TimerEntry; stopped: TimerEntry | null }> {
  await ensureTimeDefaults(ctx.tenantId);
  await settleMemberOnce(ctx.tenantId, ctx.actor.memberId);
  return withTenant(
    ctx.tenantId,
    principalOf(ctx),
    async (tx) =>
      guarded(async () => {
        // Every read before the lock; the critical section is the switch + insert.
        await requireAccess(tx, ctx.tenantId, ctx.actor, "time:track");
        await assertNoticeAcknowledged(tx, ctx.tenantId, ctx.actor.memberId);
        const { timezone, prefs } = await resolveZone(tx, ctx.tenantId, ctx.actor.memberId);
        const target = await resolveTarget(tx, ctx, input, prefs);
        await lockMember(tx, ctx.tenantId, ctx.actor.memberId);

      const now = floorToSecond(new Date());
      const stopped = await stopRunningEntry(tx, ctx.tenantId, ctx.actor.memberId, now, "switch");
      await closeOpenBreak(tx, ctx.tenantId, ctx.actor.memberId, now);

      const localDate = localDateColumn(now, timezone);
      const snap = await snapshotFor(tx, ctx.tenantId, ctx.actor.memberId, target, localDate);
      const id = randomUUID();
      const started = await tx.timeEntry.create({
        data: {
          id,
          tenantId: ctx.tenantId,
          clientId: target.clientId,
          projectId: target.projectId,
          serviceId: target.serviceId,
          workTypeId: target.workTypeId,
          workItemId: target.workItemId,
          memberId: ctx.actor.memberId,
          description: target.description,
          startedAt: now,
          stoppedAt: null,
          durationSeconds: null,
          timezone,
          localDate,
          entryMode: "TIMER",
          source: "TIMER",
          billable: target.billable,
          billRate: snap.billRate,
          currency: snap.billRate !== null ? snap.currency : null,
          rateSource: snap.rateSource,
          billRateCardId: snap.billRateCardId,
          costRateCardId: snap.costRateCardId,
          createdByMemberId: ctx.actor.memberId,
        },
        select: entrySelect,
      });
      await record(tx, {
        action: "timer.started",
        targetType: "TimeEntry",
        targetId: id,
        metadata: idsOnly({
          projectId: target.projectId,
          workItemId: target.workItemId,
          serviceId: target.serviceId,
          autoStopped: stopped?.id ?? null,
        }),
      });
      return { started, stopped };
    }),
    LOCKED_TX,
  );
}

/** time:track — stop the running timer; optional confirm-dialog edits ride along. */
export async function stopTimer(
  ctx: TimeCtx,
  patch?: { description?: string | null; billable?: boolean; workTypeId?: string | null; serviceId?: string | null },
): Promise<TimerEntry> {
  await settleMemberOnce(ctx.tenantId, ctx.actor.memberId);
  return withTenant(
    ctx.tenantId,
    principalOf(ctx),
    async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "time:track");
      await lockMember(tx, ctx.tenantId, ctx.actor.memberId);
      const now = floorToSecond(new Date());
      const stopped = await stopRunningEntry(tx, ctx.tenantId, ctx.actor.memberId, now, "user");
      if (!stopped) fail("TIMER_NOT_RUNNING");
      if (!patch) return stopped!;
      // Confirm-dialog edits: same rules as an entry edit (re-resolve rates
      // when agreement/billable change); the entry is ours and unlocked.
      const { prefs } = await resolveZone(tx, ctx.tenantId, ctx.actor.memberId);
      const target = await resolveTarget(
        tx,
        ctx,
        {
          projectId: stopped!.projectId,
          workItemId: stopped!.workItemId,
          serviceId: patch.serviceId === undefined ? stopped!.serviceId : patch.serviceId,
          workTypeId: patch.workTypeId === undefined ? stopped!.workTypeId : patch.workTypeId,
          billable: patch.billable ?? stopped!.billable,
          description: patch.description === undefined ? stopped!.description : patch.description,
        },
        prefs,
      );
      const snap = await snapshotFor(tx, ctx.tenantId, ctx.actor.memberId, target, stopped!.localDate);
      const updated = await tx.timeEntry.update({
        where: { id: stopped!.id },
        data: {
          serviceId: target.serviceId,
          workTypeId: target.workTypeId,
          description: target.description,
          billable: target.billable,
          billRate: snap.billRate,
          currency: snap.billRate !== null ? snap.currency : null,
          rateSource: snap.rateSource,
          billRateCardId: snap.billRateCardId,
          costRateCardId: snap.costRateCardId,
        },
        select: entrySelect,
      });
      await recomputeTouched(tx, ctx.tenantId, [{ projectId: updated.projectId, localDate: updated.localDate }]);
      return updated;
    }),
    LOCKED_TX,
  );
}

export type CurrentTimer = {
  running: TimerEntry | null;
  /** Running longer than time.nudgeHours — the UI shows a gentle nudge. */
  nudge: boolean;
  /** The member has not acknowledged the current staff notice. */
  noticeRequired: boolean;
  /** Elapsed seconds at `serverNow` (clients tick from here, skew-corrected). */
  elapsedSeconds: number;
  serverNow: Date;
};

/** time:track — the pill's state (lazy auto-stop applied first). */
export async function getCurrentTimer(ctx: TimeCtx): Promise<CurrentTimer> {
  await ensureTimeDefaults(ctx.tenantId);
  await settleMemberOnce(ctx.tenantId, ctx.actor.memberId);
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "time:track");
    const [running, noticeRequired, { prefs }] = await Promise.all([
      tx.timeEntry.findFirst({
        where: { tenantId: ctx.tenantId, memberId: ctx.actor.memberId, stoppedAt: null, deletedAt: null },
        select: entrySelect,
      }),
      noticeRequiredFor(tx, ctx.tenantId, ctx.actor.memberId), // the boolean, not the bodies
      resolveZone(tx, ctx.tenantId, ctx.actor.memberId),
    ]);
    const serverNow = new Date();
    const elapsedSeconds = running ? secondsBetween(running.startedAt, serverNow) : 0;
    const nudge = running ? addHours(running.startedAt, prefs.time.nudgeHours) <= serverNow : false;
    return {
      running,
      nudge,
      noticeRequired,
      elapsedSeconds,
      serverNow,
    };
  });
}

/**
 * The same snapshot, once per request: the authed layout reads it for the
 * pill and /home reads it for its strip in the SAME render — keyed by
 * primitives (a cache keyed on the ctx object would miss: every caller
 * builds its own), so both surfaces share one transaction and one
 * `serverNow`. The actor is rebuilt from the member id AND its authz
 * posture: an impersonating platform actor is read-only (AUTHZ.md §7) and
 * `time:track` is not a view verb, so the posture must be part of the key
 * or the shared snapshot would serve what `authorize` denies. No ✦.
 */
export const getCurrentTimerOnce = cache(
  (tenantId: string, memberId: string, impersonated: boolean): Promise<CurrentTimer> =>
    getCurrentTimer({ tenantId, actor: impersonated ? { memberId, impersonated: true } : { memberId } }),
);

/** time:track — one-click continue: a NEW timer copying the entry's target (D6). */
export async function continueEntry(
  ctx: TimeCtx,
  entryId: string,
): Promise<{ started: TimerEntry; stopped: TimerEntry | null }> {
  const source = await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "time:track");
    const e = await tx.timeEntry.findFirst({
      where: { tenantId: ctx.tenantId, id: entryId, memberId: ctx.actor.memberId, deletedAt: null },
      select: entrySelect,
    });
    if (!e) fail("INVALID_INPUT", "unknown entry");
    return e!;
  });
  return startTimer(ctx, {
    projectId: source.projectId,
    workItemId: source.workItemId,
    serviceId: source.serviceId,
    workTypeId: source.workTypeId,
    billable: source.billable,
    description: source.description,
  });
}

/**
 * time:track — the undo toast: remove the entry the member just started
 * and resume the one it auto-stopped. Only within the undo window, only
 * the member's own rows, under the same lock.
 */
export const UNDO_WINDOW_SECONDS = 120;

export async function undoStart(ctx: TimeCtx, input: { startedId: string; resumeId: string }): Promise<void> {
  await withTenant(
    ctx.tenantId,
    principalOf(ctx),
    async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "time:track");
      await lockMember(tx, ctx.tenantId, ctx.actor.memberId);
      const now = new Date();
      const started = await tx.timeEntry.findFirst({
        where: { tenantId: ctx.tenantId, id: input.startedId, memberId: ctx.actor.memberId, deletedAt: null, stoppedAt: null },
        select: { id: true, startedAt: true, projectId: true, localDate: true },
      });
      const resume = await tx.timeEntry.findFirst({
        where: { tenantId: ctx.tenantId, id: input.resumeId, memberId: ctx.actor.memberId, deletedAt: null, lockedReason: null },
        select: { id: true, stoppedAt: true, projectId: true, localDate: true },
      });
      if (!started || !resume || !resume.stoppedAt) fail("INVALID_INPUT", "nothing to undo");
      if (secondsBetween(started!.startedAt, now) > UNDO_WINDOW_SECONDS) fail("INVALID_INPUT", "undo window passed");
      // The resume target must be the entry THIS start auto-stopped: startTimer
      // stops the previous one and starts the new one at the same instant, so
      // a crafted pair (any old finished entry) is refused here, not reopened.
      if (resume!.stoppedAt!.getTime() !== started!.startedAt.getTime()) fail("INVALID_INPUT", "not the auto-stopped entry");
      // Hard-delete the mistaken start (seconds old, never invoiced), then reopen.
      await tx.timeEntry.delete({ where: { id: started!.id } });
      await tx.timeEntry.update({
        where: { id: resume!.id },
        data: { stoppedAt: null, durationSeconds: null },
      });
      await recomputeTouched(tx, ctx.tenantId, [
        { projectId: started!.projectId, localDate: started!.localDate },
        { projectId: resume!.projectId, localDate: resume!.localDate },
      ]);
      await record(tx, {
        action: "time_entry.deleted",
        targetType: "TimeEntry",
        targetId: started!.id,
        metadata: { reason: "undo_start", resumed: resume!.id },
      });
      await record(tx, {
        action: "timer.started",
        targetType: "TimeEntry",
        targetId: resume!.id,
        metadata: { resumed: true },
      });
    }),
    LOCKED_TX,
  );
}
