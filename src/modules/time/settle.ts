import { record } from "@/audit/record";
import { withTenant } from "@/db";
import { addHours, floorToSecond, secondsBetween } from "@/lib/duration";
import { readPreferences } from "@/preferences/service";

import { recomputeTouched } from "./summary";
import { workedSecondsOf } from "./worked";

/**
 * The lazy sweep (DATA_MODEL.md §6.15 "Timer policy"; PLAN.md 2T risk 2):
 * applied before every timer/shift read and write so the 12 h entry
 * auto-stop and the 14 h shift auto-stop are correct BEFORE Vercel Pro
 * crons exist. Runs under the SYSTEM principal in its own bounded
 * transaction (it must audit as SYSTEM, never as the viewer) and is
 * idempotent by construction: the stop instant is the deterministic
 * bound `started_at + cap`, so a cron and a lazy pass that race agree
 * on the row and the second finds nothing running.
 */

export type SettleResult = { autoStoppedEntries: number; autoStoppedShifts: number };

export async function settleMember(
  tenantId: string,
  memberId: string,
  now: Date = new Date(),
): Promise<SettleResult> {
  return withTenant(tenantId, { type: "system" }, async (tx) => {
    const prefs = await readPreferences(tx, tenantId);
    const out: SettleResult = { autoStoppedEntries: 0, autoStoppedShifts: 0 };

    const running = await tx.timeEntry.findFirst({
      where: { tenantId, memberId, stoppedAt: null, deletedAt: null },
      select: { id: true, startedAt: true, projectId: true, localDate: true },
    });
    if (running) {
      const bound = floorToSecond(addHours(running.startedAt, prefs.time.autoStopHours));
      if (bound <= now) {
        await tx.timeEntry.update({
          where: { id: running.id },
          data: {
            stoppedAt: bound,
            durationSeconds: secondsBetween(running.startedAt, bound),
            needsReview: true,
            reviewReason: "AUTO_STOPPED",
          },
        });
        await recomputeTouched(tx, tenantId, [{ projectId: running.projectId, localDate: running.localDate }]);
        await record(tx, {
          action: "timer.auto_stopped",
          targetType: "TimeEntry",
          targetId: running.id,
          metadata: { capHours: prefs.time.autoStopHours, memberId },
        });
        out.autoStoppedEntries = 1;
      }
    }

    const open = await tx.shift.findFirst({
      where: { tenantId, memberId, stoppedAt: null, deletedAt: null },
      select: {
        id: true,
        startedAt: true,
        breaks: { select: { id: true, startedAt: true, stoppedAt: true } },
      },
    });
    if (open) {
      const bound = floorToSecond(addHours(open.startedAt, prefs.time.shiftAutoStopHours));
      if (bound <= now) {
        const openBreak = open.breaks.find((b) => b.stoppedAt === null);
        let breaks = open.breaks;
        if (openBreak) {
          if (openBreak.startedAt >= bound) {
            // Began after the shift is deemed over: it cannot lie inside the
            // closed span — removed, recorded in the audit metadata.
            await tx.shiftBreak.delete({ where: { id: openBreak.id } });
            breaks = breaks.filter((b) => b.id !== openBreak.id);
          } else {
            await tx.shiftBreak.update({
              where: { id: openBreak.id },
              data: { stoppedAt: bound, durationSeconds: secondsBetween(openBreak.startedAt, bound) },
            });
            breaks = breaks.map((b) => (b.id === openBreak.id ? { ...b, stoppedAt: bound } : b));
          }
        }
        await tx.shift.update({
          where: { id: open.id },
          data: {
            stoppedAt: bound,
            workedSeconds: workedSecondsOf({ startedAt: open.startedAt, stoppedAt: bound }, breaks),
            needsReview: true,
            reviewReason: "AUTO_STOPPED",
          },
        });
        await record(tx, {
          action: "shift.auto_stopped",
          targetType: "Shift",
          targetId: open.id,
          metadata: {
            capHours: prefs.time.shiftAutoStopHours,
            memberId,
            ...(openBreak ? { openBreak: openBreak.id, breakDropped: openBreak.startedAt >= bound } : {}),
          },
        });
        out.autoStoppedShifts = 1;
      }
    }
    return out;
  });
}

/**
 * Tenant-wide pass for the cron / POST /api/jobs/run: every member with
 * something open. Bounded and idempotent like the per-member pass.
 */
export async function settleTenant(tenantId: string, now: Date = new Date()): Promise<SettleResult> {
  const memberIds = await withTenant(tenantId, { type: "system" }, async (tx) => {
    const [entries, shifts] = await Promise.all([
      tx.timeEntry.findMany({
        where: { tenantId, stoppedAt: null, deletedAt: null },
        select: { memberId: true },
        distinct: ["memberId"],
      }),
      tx.shift.findMany({
        where: { tenantId, stoppedAt: null, deletedAt: null },
        select: { memberId: true },
        distinct: ["memberId"],
      }),
    ]);
    return [...new Set([...entries, ...shifts].map((r) => r.memberId))];
  });
  const out: SettleResult = { autoStoppedEntries: 0, autoStoppedShifts: 0 };
  for (const memberId of memberIds) {
    const r = await settleMember(tenantId, memberId, now);
    out.autoStoppedEntries += r.autoStoppedEntries;
    out.autoStoppedShifts += r.autoStoppedShifts;
  }
  return out;
}
