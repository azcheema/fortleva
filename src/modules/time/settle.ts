import { cache } from "react";

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
 * on the row — and the writes below are GUARDED (`stopped_at IS NULL`,
 * count-checked) so two passes that read the same running row before
 * either commits still produce ONE stop, ONE audit row, ONE recompute
 * (the review found five concurrent settles per /time render writing
 * duplicate `timer.auto_stopped` rows).
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
        // Guarded: a concurrent stop (user or another pass) that landed
        // first wins; this pass then does nothing further.
        const { count } = await tx.timeEntry.updateMany({
          where: { id: running.id, stoppedAt: null },
          data: {
            stoppedAt: bound,
            durationSeconds: secondsBetween(running.startedAt, bound),
            needsReview: true,
            reviewReason: "AUTO_STOPPED",
          },
        });
        if (count === 1) {
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
            await tx.shiftBreak.deleteMany({ where: { id: openBreak.id, stoppedAt: null } });
            breaks = breaks.filter((b) => b.id !== openBreak.id);
          } else {
            await tx.shiftBreak.updateMany({
              where: { id: openBreak.id, stoppedAt: null },
              data: { stoppedAt: bound, durationSeconds: secondsBetween(openBreak.startedAt, bound) },
            });
            breaks = breaks.map((b) => (b.id === openBreak.id ? { ...b, stoppedAt: bound } : b));
          }
        }
        const { count } = await tx.shift.updateMany({
          where: { id: open.id, stoppedAt: null },
          data: {
            stoppedAt: bound,
            workedSeconds: workedSecondsOf({ startedAt: open.startedAt, stoppedAt: bound }, breaks),
            needsReview: true,
            reviewReason: "AUTO_STOPPED",
          },
        });
        if (count === 1) {
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
    }
    return out;
  });
}

/**
 * Once per request: the page, the layout's pill snapshot and every
 * service read of one render used to each open their own SYSTEM settle
 * transaction for the same member (five on /time). React's `cache()`
 * dedupes by (tenantId, memberId) inside one server request and is a
 * plain pass-through outside one (jobs, tests), so the semantics above
 * are unchanged — only the redundant transactions are gone.
 */
export const settleMemberOnce = cache(
  (tenantId: string, memberId: string): Promise<SettleResult> => settleMember(tenantId, memberId),
);

/**
 * Tenant-wide pass for the cron / POST /api/jobs/run: only the members
 * with something actually PAST its bound (the discovery query applies the
 * caps), so a tick over a tenant where everyone is simply working opens
 * no per-member transaction at all. Bounded and idempotent like the
 * per-member pass.
 */
export async function settleTenant(tenantId: string, now: Date = new Date()): Promise<SettleResult> {
  const memberIds = await withTenant(tenantId, { type: "system" }, async (tx) => {
    const prefs = await readPreferences(tx, tenantId);
    const [entries, shifts] = await Promise.all([
      tx.timeEntry.findMany({
        where: { tenantId, stoppedAt: null, deletedAt: null, startedAt: { lte: addHours(now, -prefs.time.autoStopHours) } },
        select: { memberId: true },
        distinct: ["memberId"],
      }),
      tx.shift.findMany({
        where: { tenantId, stoppedAt: null, deletedAt: null, startedAt: { lte: addHours(now, -prefs.time.shiftAutoStopHours) } },
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
