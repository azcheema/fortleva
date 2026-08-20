import { randomUUID } from "node:crypto";

import { record } from "@/audit/record";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { dateColumn, floorToSecond, localDateColumn, secondsBetween } from "@/lib/duration";
import { fail } from "@/lib/domain-error";

import { ensureTimeDefaults } from "./bootstrap";
import { LOCKED_TX, guarded, lockMember, principalOf, resolveZone, type TimeCtx } from "./ctx";
import { assertNoticeAcknowledged } from "./notice";
import { settleMember } from "./settle";
import { stopRunningEntry, type TimerEntry } from "./timer";
import { breakSecondsOf, workedSecondsOf } from "./worked";

/**
 * Shifts + breaks (D1; DATA_MODEL.md §6.15 Shift/ShiftBreak; SECURITY.md
 * §9.7 amended): self-reported clock-in/out with breaks as ROWS.
 *  - one open shift per member / one open break per shift (DB);
 *  - startBreak auto-stops a running task timer (undo offered — the
 *    pinned start-another pattern); startTimer auto-closes an open
 *    break (timer.ts); clockOut closes the break, recomputes
 *    workedSeconds = span − Σ breaks, closes the shift and auto-stops a
 *    running timer;
 *  - NO LIVE PRESENCE: nothing here ever selects another member's open
 *    shift — team surfaces aggregate CLOSED rows only (listTeamShifts);
 *  - the staff-notice gate covers clockIn exactly as timer start;
 *  - the 14 h auto-stop is lazy + deterministic (settle.ts).
 */

export type ShiftBreakRow = {
  id: string;
  startedAt: Date;
  stoppedAt: Date | null;
  durationSeconds: number | null;
  note: string | null;
};

export type ShiftRow = {
  id: string;
  memberId: string;
  startedAt: Date;
  stoppedAt: Date | null;
  workedSeconds: number | null;
  timezone: string;
  localDate: Date;
  note: string | null;
  needsReview: boolean;
  reviewReason: string | null;
  breaks: ShiftBreakRow[];
};

export const shiftSelect = {
  id: true,
  memberId: true,
  startedAt: true,
  stoppedAt: true,
  workedSeconds: true,
  timezone: true,
  localDate: true,
  note: true,
  needsReview: true,
  reviewReason: true,
  breaks: {
    select: { id: true, startedAt: true, stoppedAt: true, durationSeconds: true, note: true },
    orderBy: { startedAt: "asc" as const },
  },
} as const;

export { breakSecondsOf, workedSecondsOf };

async function openShiftOf(tx: TenantDb, tenantId: string, memberId: string) {
  return tx.shift.findFirst({
    where: { tenantId, memberId, stoppedAt: null, deletedAt: null },
    select: shiftSelect,
  });
}

async function requireShiftsEnabled(prefs: { time: { shiftsEnabled: boolean } }): Promise<void> {
  if (!prefs.time.shiftsEnabled) fail("SHIFTS_DISABLED");
}

/** time:track — clock in. */
export async function clockIn(ctx: TimeCtx, input?: { note?: string | null }): Promise<ShiftRow> {
  await ensureTimeDefaults(ctx.tenantId);
  await settleMember(ctx.tenantId, ctx.actor.memberId);
  return withTenant(
    ctx.tenantId,
    principalOf(ctx),
    async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "time:track");
      await assertNoticeAcknowledged(tx, ctx.tenantId, ctx.actor.memberId);
      const { timezone, prefs } = await resolveZone(tx, ctx.tenantId, ctx.actor.memberId);
      await requireShiftsEnabled(prefs);
      await lockMember(tx, ctx.tenantId, ctx.actor.memberId);
      if (await openShiftOf(tx, ctx.tenantId, ctx.actor.memberId)) fail("SHIFT_ALREADY_OPEN");
      const now = floorToSecond(new Date());
      const id = randomUUID();
      const shift = await tx.shift.create({
        data: {
          id,
          tenantId: ctx.tenantId,
          memberId: ctx.actor.memberId,
          startedAt: now,
          timezone,
          localDate: localDateColumn(now, timezone),
          note: input?.note?.trim() || null,
          createdByMemberId: ctx.actor.memberId,
        },
        select: shiftSelect,
      });
      await record(tx, { action: "shift.started", targetType: "Shift", targetId: id });
      return shift;
    }),
    LOCKED_TX,
  );
}

/**
 * time:track — clock out: close an open break, auto-stop a running timer
 * (returned for the undo toast), compute workedSeconds, close the shift.
 */
export async function clockOut(
  ctx: TimeCtx,
): Promise<{ shift: ShiftRow; stoppedTimer: TimerEntry | null }> {
  await settleMember(ctx.tenantId, ctx.actor.memberId);
  return withTenant(
    ctx.tenantId,
    principalOf(ctx),
    async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "time:track");
      await lockMember(tx, ctx.tenantId, ctx.actor.memberId);
      const open = await openShiftOf(tx, ctx.tenantId, ctx.actor.memberId);
      if (!open) fail("SHIFT_NOT_OPEN");
      const now = floorToSecond(new Date());
      const openBreak = open!.breaks.find((b) => b.stoppedAt === null);
      if (openBreak) {
        await tx.shiftBreak.update({
          where: { id: openBreak.id },
          data: { stoppedAt: now, durationSeconds: secondsBetween(openBreak.startedAt, now) },
        });
        await record(tx, {
          action: "shift.break_stopped",
          targetType: "Shift",
          targetId: open!.id,
          metadata: { breakId: openBreak.id, reason: "clock_out" },
        });
      }
      const stoppedTimer = await stopRunningEntry(tx, ctx.tenantId, ctx.actor.memberId, now, "clock_out");
      const breaks = open!.breaks.map((b) => ({ ...b, stoppedAt: b.stoppedAt ?? now }));
      const workedSeconds = workedSecondsOf({ startedAt: open!.startedAt, stoppedAt: now }, breaks);
      const shift = await tx.shift.update({
        where: { id: open!.id },
        data: { stoppedAt: now, workedSeconds },
        select: shiftSelect,
      });
      await record(tx, {
        action: "shift.stopped",
        targetType: "Shift",
        targetId: open!.id,
        metadata: { workedSeconds, breaks: shift.breaks.length, stoppedTimer: stoppedTimer?.id ?? null },
      });
      return { shift, stoppedTimer };
    }),
    LOCKED_TX,
  );
}

/** time:track — start a break; a running task timer is auto-stopped (undo offered). */
export async function startBreak(
  ctx: TimeCtx,
  input?: { note?: string | null },
): Promise<{ shift: ShiftRow; stoppedTimer: TimerEntry | null }> {
  await settleMember(ctx.tenantId, ctx.actor.memberId);
  return withTenant(
    ctx.tenantId,
    principalOf(ctx),
    async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "time:track");
      await lockMember(tx, ctx.tenantId, ctx.actor.memberId);
      const open = await openShiftOf(tx, ctx.tenantId, ctx.actor.memberId);
      if (!open) fail("SHIFT_NOT_OPEN");
      if (open!.breaks.some((b) => b.stoppedAt === null)) fail("BREAK_ALREADY_OPEN");
      const now = floorToSecond(new Date());
      const stoppedTimer = await stopRunningEntry(tx, ctx.tenantId, ctx.actor.memberId, now, "break");
      const id = randomUUID();
      await tx.shiftBreak.create({
        data: {
          id,
          tenantId: ctx.tenantId,
          shiftId: open!.id,
          memberId: ctx.actor.memberId,
          startedAt: now,
          note: input?.note?.trim() || null,
          createdByMemberId: ctx.actor.memberId,
        },
      });
      await record(tx, {
        action: "shift.break_started",
        targetType: "Shift",
        targetId: open!.id,
        metadata: { breakId: id, stoppedTimer: stoppedTimer?.id ?? null },
      });
      const shift = await tx.shift.findFirst({ where: { id: open!.id }, select: shiftSelect });
      return { shift: shift!, stoppedTimer };
    }),
    LOCKED_TX,
  );
}

/** time:track — end the open break. */
export async function stopBreak(ctx: TimeCtx): Promise<ShiftRow> {
  await settleMember(ctx.tenantId, ctx.actor.memberId);
  return withTenant(
    ctx.tenantId,
    principalOf(ctx),
    async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "time:track");
      await lockMember(tx, ctx.tenantId, ctx.actor.memberId);
      const open = await openShiftOf(tx, ctx.tenantId, ctx.actor.memberId);
      if (!open) fail("SHIFT_NOT_OPEN");
      const openBreak = open!.breaks.find((b) => b.stoppedAt === null);
      if (!openBreak) fail("BREAK_NOT_OPEN");
      const now = floorToSecond(new Date());
      await tx.shiftBreak.update({
        where: { id: openBreak!.id },
        data: { stoppedAt: now, durationSeconds: secondsBetween(openBreak!.startedAt, now) },
      });
      await record(tx, {
        action: "shift.break_stopped",
        targetType: "Shift",
        targetId: open!.id,
        metadata: { breakId: openBreak!.id, reason: "user" },
      });
      const shift = await tx.shift.findFirst({ where: { id: open!.id }, select: shiftSelect });
      return shift!;
    }),
    LOCKED_TX,
  );
}

export type CurrentShift = {
  shift: ShiftRow | null;
  onBreak: boolean;
  shiftsEnabled: boolean;
  serverNow: Date;
};

/** time:track — the member's OWN open shift (the one place a live shift is read). */
export async function getCurrentShift(ctx: TimeCtx): Promise<CurrentShift> {
  await ensureTimeDefaults(ctx.tenantId);
  await settleMember(ctx.tenantId, ctx.actor.memberId);
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "time:track");
    const [shift, { prefs }] = await Promise.all([
      openShiftOf(tx, ctx.tenantId, ctx.actor.memberId),
      resolveZone(tx, ctx.tenantId, ctx.actor.memberId),
    ]);
    return {
      shift,
      onBreak: shift?.breaks.some((b) => b.stoppedAt === null) ?? false,
      shiftsEnabled: prefs.time.shiftsEnabled,
      serverNow: new Date(),
    };
  });
}

/** time:track — own shifts (open or closed) in [from, to] by local date. */
export async function listMyShifts(ctx: TimeCtx, range: { from: string; to: string }): Promise<ShiftRow[]> {
  await settleMember(ctx.tenantId, ctx.actor.memberId);
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "time:track");
    return tx.shift.findMany({
      where: {
        tenantId: ctx.tenantId,
        memberId: ctx.actor.memberId,
        deletedAt: null,
        localDate: { gte: dateColumn(range.from), lte: dateColumn(range.to) },
      },
      orderBy: { startedAt: "asc" },
      select: shiftSelect,
    });
  });
}

export type TeamDayTotal = {
  memberId: string;
  memberName: string;
  localDate: Date;
  workedSeconds: number;
  breakSeconds: number;
  shifts: number;
};

/**
 * time:view_team — per-member per-day totals from CLOSED shifts only.
 * The select carries no open/active flag and no open row can reach it
 * (stoppedAt is required non-null in the WHERE): never live presence
 * (SECURITY.md §9.7.2). The viewer's own open shift is shown elsewhere.
 */
export async function listTeamShiftTotals(
  ctx: TimeCtx,
  range: { from: string; to: string; memberId?: string },
): Promise<TeamDayTotal[]> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "time:view_team");
    const rows = await tx.shift.findMany({
      where: {
        tenantId: ctx.tenantId,
        deletedAt: null,
        stoppedAt: { not: null },
        ...(range.memberId ? { memberId: range.memberId } : {}),
        localDate: { gte: dateColumn(range.from), lte: dateColumn(range.to) },
      },
      select: {
        memberId: true,
        localDate: true,
        startedAt: true,
        stoppedAt: true,
        workedSeconds: true,
        member: { select: { user: { select: { name: true } } } },
        breaks: { select: { startedAt: true, stoppedAt: true } },
      },
    });
    const totals = new Map<string, TeamDayTotal>();
    for (const r of rows) {
      const key = `${r.memberId}:${r.localDate.toISOString()}`;
      const t = totals.get(key) ?? {
        memberId: r.memberId,
        memberName: r.member.user.name,
        localDate: r.localDate,
        workedSeconds: 0,
        breakSeconds: 0,
        shifts: 0,
      };
      t.workedSeconds += r.workedSeconds ?? 0;
      t.breakSeconds += breakSecondsOf(r.breaks, r.stoppedAt!);
      t.shifts += 1;
      totals.set(key, t);
    }
    return [...totals.values()].sort(
      (a, b) => a.memberName.localeCompare(b.memberName) || a.localDate.getTime() - b.localDate.getTime(),
    );
  });
}

/**
 * time:track (own) / time:edit_any (another member's) — correct a closed
 * shift's span (e.g. confirm a provisional auto-stop). The shrink guard
 * refuses a span that would orphan a break; workedSeconds is recomputed.
 */
export async function updateShift(
  ctx: TimeCtx,
  shiftId: string,
  patch: { startedAt?: Date; stoppedAt?: Date; note?: string | null },
): Promise<ShiftRow> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      const existing = await tx.shift.findFirst({
        where: { tenantId: ctx.tenantId, id: shiftId, deletedAt: null },
        select: shiftSelect,
      });
      if (!existing) fail("INVALID_INPUT", "unknown shift");
      const forOther = existing!.memberId !== ctx.actor.memberId;
      await requireAccess(tx, ctx.tenantId, ctx.actor, forOther ? "time:edit_any" : "time:track");
      await lockMember(tx, ctx.tenantId, existing!.memberId);
      const startedAt = patch.startedAt ? floorToSecond(patch.startedAt) : existing!.startedAt;
      const stoppedAt = patch.stoppedAt ? floorToSecond(patch.stoppedAt) : existing!.stoppedAt;
      if (stoppedAt && stoppedAt <= startedAt) fail("INVALID_DURATION", "end before start");
      if (stoppedAt && secondsBetween(startedAt, stoppedAt) > 24 * 3600) fail("INVALID_DURATION", "over 24 h");
      const workedSeconds = stoppedAt ? workedSecondsOf({ startedAt, stoppedAt }, existing!.breaks) : null;
      const shift = await tx.shift.update({
        where: { id: existing!.id },
        data: {
          startedAt,
          stoppedAt,
          workedSeconds,
          localDate: localDateColumn(startedAt, existing!.timezone),
          ...(patch.note !== undefined ? { note: patch.note?.trim() || null } : {}),
          needsReview: false,
          reviewReason: null,
        },
        select: shiftSelect,
      });
      await record(tx, {
        action: forOther ? "shift.edited_by_other" : "shift.updated",
        targetType: "Shift",
        targetId: shift.id,
        metadata: { fields: Object.keys(patch), ...(forOther ? { memberId: existing!.memberId } : {}) },
      });
      return shift;
    }),
  );
}
