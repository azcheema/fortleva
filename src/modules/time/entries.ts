import { randomUUID } from "node:crypto";

import { record } from "@/audit/record";
import { assertInScope, isAuthorized, scopeWhere } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import {
  addSeconds,
  dateColumn,
  floorToSecond,
  intervalsOverlap,
  isZeroDurationText,
  isoDateOf,
  localDateColumn,
  localDateString,
  parseDurationSeconds,
  secondsBetween,
  startOfLocalDay,
} from "@/lib/duration";
import { DomainError, fail } from "@/lib/domain-error";
import { addDays, isIsoDate, weekContaining } from "@/lib/week";
import type { TenantPreferences } from "@/preferences/service";

import { ensureTimeDefaults } from "./bootstrap";
import { copyDayKey, copyRowKey, planWeekCopy, type CopyRowTarget } from "./copy-plan";
import { LOCKED_TX, guarded, idsOnly, lockMember, principalOf, resolveZone, type TimeCtx } from "./ctx";
import { assertNoticeAcknowledged } from "./notice";
import { settleMemberOnce } from "./settle";
import { recomputeTouched, type SummaryTouch } from "./summary";
import { resolveTarget, snapshotFor, type EntryTargetInput, type ResolvedTarget } from "./target";
import { entrySelect, type TimerEntry } from "./timer";

/**
 * Manual / duration entries and edits (UI.md rule 9; DATA_MODEL.md
 * §6.15; D2 ad-hoc, D4 agreement, D6 overlap policy):
 *  - MANUAL = start + end typed; DURATION = "1h 30m" on a local date,
 *    anchored at that day's local 00:00 (the UI shows no clock times);
 *  - midnight-spanning stays ONE row attributed to its start date;
 *  - overlaps: allowed + flagged by default (time.allowOverlap = true);
 *    a tenant that switches it off gets an app check under the member
 *    lock (OVERLAP_BLOCKED) — timer-created overlaps are impossible;
 *  - own unlocked entries are editable (audited time_entry.updated);
 *    others' with time:edit_any (audited edited_by_other); a locked
 *    entry refuses every edit at the database (ENTRY_LOCKED);
 *  - rates re-resolve on any change of project / agreement / billable /
 *    local date; every write recomputes the touched (project, month)
 *    summaries in the same transaction.
 */

export type CreateEntryInput = EntryTargetInput & {
  /** MANUAL: explicit start/stop instants (whole seconds). */
  readonly startedAt?: Date;
  readonly stoppedAt?: Date;
  /** DURATION: "1h 30m" / "90m" / "1,5" on `localDate` (ISO; default today). */
  readonly durationText?: string;
  readonly localDate?: string;
  /** time:edit_any may write for another member. */
  readonly memberId?: string;
};

type EntryMode = "TIMER" | "MANUAL" | "DURATION";

/**
 * Overlap (D6 "allow + flag", blocking = tenant opt-in) is a property of
 * rows that have a CLOCK POSITION — timer and manual entries. A
 * DURATION row is "1h 30m on Tuesday": it is anchored at the day's local
 * 00:00 only so it has a start, and the grid shows no clock for it, so it
 * neither overlaps nor is overlapped (two typed durations on one day
 * would otherwise always "overlap" each other at midnight — and a strict
 * tenant could not type a second one).
 */
const positioned = (mode: EntryMode): boolean => mode !== "DURATION";

async function assertNoBlockedOverlap(
  tx: TenantDb,
  tenantId: string,
  memberId: string,
  mode: EntryMode,
  startedAt: Date,
  stoppedAt: Date | null,
  excludeId: string | null,
  allowOverlap: boolean,
): Promise<void> {
  if (allowOverlap || !positioned(mode)) return;
  const candidates = await tx.timeEntry.findMany({
    where: {
      tenantId,
      memberId,
      deletedAt: null,
      entryMode: { not: "DURATION" },
      ...(excludeId ? { id: { not: excludeId } } : {}),
      OR: [{ stoppedAt: null }, { stoppedAt: { gt: startedAt } }],
      ...(stoppedAt ? { startedAt: { lt: stoppedAt } } : {}),
    },
    select: { id: true, startedAt: true, stoppedAt: true },
    take: 5,
  });
  if (candidates.some((c) => intervalsOverlap(startedAt, stoppedAt, c.startedAt, c.stoppedAt))) {
    fail("OVERLAP_BLOCKED");
  }
}

/** Two listed rows intersect — only when both have a clock position. */
const rowsOverlap = (
  a: { entryMode: EntryMode; startedAt: Date; stoppedAt: Date | null },
  b: { entryMode: EntryMode; startedAt: Date; stoppedAt: Date | null },
): boolean => positioned(a.entryMode) && positioned(b.entryMode) && intervalsOverlap(a.startedAt, a.stoppedAt, b.startedAt, b.stoppedAt);

/**
 * Insert ONE finished row for a resolved target (the shared tail of
 * createEntry and copyWeek): rate snapshot for the local date, the
 * source/mode columns, the creating member. The caller holds the member
 * lock, has authorised, and records the audit row (the action differs).
 */
async function writeFinishedEntry(
  tx: TenantDb,
  input: {
    tenantId: string;
    memberId: string;
    createdByMemberId: string;
    target: ResolvedTarget;
    startedAt: Date;
    stoppedAt: Date;
    mode: "MANUAL" | "DURATION";
    timezone: string;
  },
): Promise<TimerEntry> {
  const localDate = localDateColumn(input.startedAt, input.timezone);
  const snap = await snapshotFor(tx, input.tenantId, input.memberId, input.target, localDate);
  return tx.timeEntry.create({
    data: {
      id: randomUUID(),
      tenantId: input.tenantId,
      clientId: input.target.clientId,
      projectId: input.target.projectId,
      serviceId: input.target.serviceId,
      workTypeId: input.target.workTypeId,
      workItemId: input.target.workItemId,
      memberId: input.memberId,
      description: input.target.description,
      startedAt: input.startedAt,
      stoppedAt: input.stoppedAt,
      durationSeconds: secondsBetween(input.startedAt, input.stoppedAt),
      timezone: input.timezone,
      localDate,
      entryMode: input.mode,
      source: "MANUAL",
      billable: input.target.billable,
      billRate: snap.billRate,
      currency: snap.billRate !== null ? snap.currency : null,
      rateSource: snap.rateSource,
      billRateCardId: snap.billRateCardId,
      costRateCardId: snap.costRateCardId,
      createdByMemberId: input.createdByMemberId,
    },
    select: entrySelect,
  });
}

function intervalFrom(
  input: CreateEntryInput,
  timezone: string,
  now: Date,
): { startedAt: Date; stoppedAt: Date; mode: "MANUAL" | "DURATION" } {
  if (input.startedAt && input.stoppedAt) {
    const startedAt = floorToSecond(input.startedAt);
    const stoppedAt = floorToSecond(input.stoppedAt);
    if (stoppedAt <= startedAt) fail("INVALID_DURATION", "end before start");
    if (secondsBetween(startedAt, stoppedAt) > 24 * 3600) fail("INVALID_DURATION", "over 24 h");
    if (stoppedAt > addSeconds(now, 60)) fail("INVALID_DURATION", "in the future");
    return { startedAt, stoppedAt, mode: "MANUAL" };
  }
  if (input.durationText !== undefined) {
    const seconds = parseDurationSeconds(input.durationText);
    if (seconds === null) fail("INVALID_DURATION");
    const day = input.localDate ?? localDateString(now, timezone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail("INVALID_INPUT", "localDate");
    const startedAt = startOfLocalDay(day, timezone);
    return { startedAt, stoppedAt: addSeconds(startedAt, seconds!), mode: "DURATION" };
  }
  return fail("INVALID_DURATION", "start+end or a duration is required");
}

/** time:track (own) / time:edit_any (another member) — a finished entry. */
export async function createEntry(ctx: TimeCtx, input: CreateEntryInput): Promise<TimerEntry> {
  await ensureTimeDefaults(ctx.tenantId);
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      const memberId = input.memberId ?? ctx.actor.memberId;
      const forOther = memberId !== ctx.actor.memberId;
      await requireAccess(tx, ctx.tenantId, ctx.actor, forOther ? "time:edit_any" : "time:track");
      await lockMember(tx, ctx.tenantId, memberId);
      if (!forOther) await assertNoticeAcknowledged(tx, ctx.tenantId, memberId);
      const { timezone, prefs } = await resolveZone(tx, ctx.tenantId, memberId);
      const target = await resolveTarget(tx, ctx, input, prefs);
      const now = new Date();
      const { startedAt, stoppedAt, mode } = intervalFrom(input, timezone, now);
      await assertNoBlockedOverlap(tx, ctx.tenantId, memberId, mode, startedAt, stoppedAt, null, prefs.time.allowOverlap);

      const created = await writeFinishedEntry(tx, {
        tenantId: ctx.tenantId,
        memberId,
        createdByMemberId: ctx.actor.memberId,
        target,
        startedAt,
        stoppedAt,
        mode,
        timezone,
      });
      await recomputeTouched(tx, ctx.tenantId, [{ projectId: created.projectId, localDate: created.localDate }]);
      await record(tx, {
        action: forOther ? "time_entry.edited_by_other" : "time_entry.created",
        targetType: "TimeEntry",
        targetId: created.id,
        metadata: idsOnly({
          mode,
          memberId: forOther ? memberId : undefined,
          projectId: target.projectId,
          workItemId: target.workItemId,
          durationSeconds: created.durationSeconds,
        }),
      });
      return created;
    }),
  );
}

export type EntryPatch = EntryTargetInput & {
  readonly startedAt?: Date;
  readonly stoppedAt?: Date;
  readonly durationText?: string;
};

/** Own unlocked entry (time:track) or another member's (time:edit_any). */
export async function updateEntry(ctx: TimeCtx, entryId: string, patch: EntryPatch): Promise<TimerEntry> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      const existing = await tx.timeEntry.findFirst({
        where: { tenantId: ctx.tenantId, id: entryId, deletedAt: null },
        select: { ...entrySelect, memberId: true, lockedReason: true, entryMode: true },
      });
      if (!existing) fail("INVALID_INPUT", "unknown entry");
      const forOther = existing!.memberId !== ctx.actor.memberId;
      await requireAccess(tx, ctx.tenantId, ctx.actor, forOther ? "time:edit_any" : "time:track");
      // The SOURCE project must be in scope too (AUTHZ.md §4: a move
      // asserts source AND destination — resolveTarget covers the latter).
      // time:edit_any is a scoped code: a client-A lead cannot re-home a
      // client-B entry by id. RLS bounds the tenant, not the scope.
      if (existing!.projectId) await assertInScope(tx, ctx.actor, { projectId: existing!.projectId });
      if (existing!.lockedReason) fail("ENTRY_LOCKED");
      await lockMember(tx, ctx.tenantId, existing!.memberId);
      const { timezone, prefs } = await resolveZone(tx, ctx.tenantId, existing!.memberId);

      const target = await resolveTarget(
        tx,
        ctx,
        {
          projectId: patch.projectId === undefined ? existing!.projectId : patch.projectId,
          workItemId: patch.workItemId === undefined ? existing!.workItemId : patch.workItemId,
          serviceId: patch.serviceId === undefined ? existing!.serviceId : patch.serviceId,
          workTypeId: patch.workTypeId === undefined ? existing!.workTypeId : patch.workTypeId,
          billable: patch.billable === undefined ? existing!.billable : patch.billable,
          description: patch.description === undefined ? existing!.description : patch.description,
        },
        prefs,
      );

      // Interval: running entries keep running (only the start may move);
      // finished ones take start/end or a new duration from the same start.
      // A DURATION row given a clock position becomes MANUAL — "anchored,
      // not positioned" is a property of the data, so the overlap rules
      // (positioned() above) follow the row, never a stale mode.
      let startedAt = existing!.startedAt;
      let stoppedAt = existing!.stoppedAt;
      let entryMode = existing!.entryMode;
      const anchored = existing!.entryMode === "DURATION";
      if (patch.startedAt) startedAt = floorToSecond(patch.startedAt);
      if (patch.stoppedAt) stoppedAt = floorToSecond(patch.stoppedAt);
      if (anchored && (patch.startedAt || patch.stoppedAt)) entryMode = "MANUAL";
      if (patch.durationText !== undefined) {
        // An anchored row may be emptied back to 0 ("0m") — the state
        // copy-last-week leaves for the member to fill; a positioned one may not.
        const seconds =
          parseDurationSeconds(patch.durationText) ?? (anchored && isZeroDurationText(patch.durationText) ? 0 : null);
        if (seconds === null) fail("INVALID_DURATION");
        stoppedAt = addSeconds(startedAt, seconds!);
      }
      const intervalChanged = Boolean(patch.startedAt || patch.stoppedAt) || patch.durationText !== undefined;
      // An untouched interval is not re-judged: an empty (0 s) anchored row
      // keeps accepting its other edits — billable, note, agreement, type.
      if (intervalChanged && stoppedAt && stoppedAt < startedAt) fail("INVALID_DURATION", "end before start");
      if (intervalChanged && stoppedAt && stoppedAt.getTime() === startedAt.getTime() && entryMode !== "DURATION") {
        fail("INVALID_DURATION", "end before start");
      }
      if (stoppedAt && secondsBetween(startedAt, stoppedAt) > 24 * 3600) fail("INVALID_DURATION", "over 24 h");
      await assertNoBlockedOverlap(tx, ctx.tenantId, existing!.memberId, entryMode, startedAt, stoppedAt, existing!.id, prefs.time.allowOverlap);

      const localDate = localDateColumn(startedAt, timezone);
      const snap = await snapshotFor(tx, ctx.tenantId, existing!.memberId, target, localDate);
      const updated = await tx.timeEntry.update({
        where: { id: existing!.id },
        data: {
          clientId: target.clientId,
          projectId: target.projectId,
          serviceId: target.serviceId,
          workTypeId: target.workTypeId,
          workItemId: target.workItemId,
          description: target.description,
          startedAt,
          stoppedAt,
          durationSeconds: stoppedAt ? secondsBetween(startedAt, stoppedAt) : null,
          entryMode,
          localDate,
          billable: target.billable,
          billRate: snap.billRate,
          currency: snap.billRate !== null ? snap.currency : null,
          rateSource: snap.rateSource,
          billRateCardId: snap.billRateCardId,
          costRateCardId: snap.costRateCardId,
          // An edited auto-stop is no longer provisional.
          needsReview: false,
          reviewReason: null,
        },
        select: entrySelect,
      });
      await recomputeTouched(tx, ctx.tenantId, [
        { projectId: existing!.projectId, localDate: existing!.localDate },
        { projectId: updated.projectId, localDate: updated.localDate },
      ]);
      await record(tx, {
        action: forOther ? "time_entry.edited_by_other" : "time_entry.updated",
        targetType: "TimeEntry",
        targetId: updated.id,
        metadata: idsOnly({
          memberId: forOther ? existing!.memberId : undefined,
          fields: Object.keys(patch).join(","),
          projectId: updated.projectId,
        }),
      });
      return updated;
    }),
  );
}

/** Soft delete (own: time:track; another member's: time:delete_any). */
export async function deleteEntry(ctx: TimeCtx, entryId: string): Promise<void> {
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      const existing = await tx.timeEntry.findFirst({
        where: { tenantId: ctx.tenantId, id: entryId, deletedAt: null },
        select: { id: true, memberId: true, lockedReason: true, projectId: true, localDate: true, startedAt: true, stoppedAt: true },
      });
      if (!existing) fail("INVALID_INPUT", "unknown entry");
      const forOther = existing!.memberId !== ctx.actor.memberId;
      await requireAccess(tx, ctx.tenantId, ctx.actor, forOther ? "time:delete_any" : "time:track");
      // time:delete_any is a scoped code (AUTHZ.md §4): the entry's project must be in scope.
      if (existing!.projectId) await assertInScope(tx, ctx.actor, { projectId: existing!.projectId });
      if (existing!.lockedReason) fail("ENTRY_LOCKED");
      await lockMember(tx, ctx.tenantId, existing!.memberId);
      const now = floorToSecond(new Date());
      // A running entry is stopped as it is deleted so the row stays
      // CHECK-consistent: time_entry_duration_exact requires
      // duration_seconds = floor(stopped_at − started_at), never 0.
      await tx.timeEntry.update({
        where: { id: existing!.id },
        data: existing!.stoppedAt
          ? { deletedAt: now }
          : { deletedAt: now, stoppedAt: now, durationSeconds: secondsBetween(existing!.startedAt, now) },
      });
      await recomputeTouched(tx, ctx.tenantId, [{ projectId: existing!.projectId, localDate: existing!.localDate }]);
      await record(tx, {
        action: "time_entry.deleted",
        targetType: "TimeEntry",
        targetId: existing!.id,
        metadata: idsOnly({ memberId: forOther ? existing!.memberId : undefined, projectId: existing!.projectId }),
      });
    }),
  );
}

export type EntryListRow = TimerEntry & {
  /** Intersects another of the same member's entries (computed; D6 "allow + flag"). */
  overlaps: boolean;
  rateSource: string;
  billRate: string | null;
  currency: string | null;
  lockedReason: string | null;
};

/**
 * time:track — the member's own entries in [from, to] by local date
 * (My Time; week grid). Running entry included. Bill rates are the
 * member's own commercial snapshot and are returned only with
 * rate:view_bill — employees see hours (UI.md rule 14).
 */
export async function listMyEntries(
  ctx: TimeCtx,
  range: { from: string; to: string },
): Promise<EntryListRow[]> {
  await ensureTimeDefaults(ctx.tenantId);
  await settleMemberOnce(ctx.tenantId, ctx.actor.memberId);
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "time:track");
    const canSeeRates = await isAuthorized(tx, ctx.actor, "rate:view_bill");
    const rows = await tx.timeEntry.findMany({
      where: {
        tenantId: ctx.tenantId,
        memberId: ctx.actor.memberId,
        deletedAt: null,
        localDate: { gte: dateColumn(range.from), lte: dateColumn(range.to) },
      },
      orderBy: { startedAt: "asc" },
      select: { ...entrySelect, rateSource: true, billRate: true, currency: true, lockedReason: true },
    });
    return rows.map((r, i) => ({
      ...r,
      rateSource: r.rateSource,
      billRate: canSeeRates ? (r.billRate?.toString() ?? null) : null,
      currency: canSeeRates ? r.currency : null,
      lockedReason: r.lockedReason,
      overlaps: rows.some((o, j) => j !== i && rowsOverlap(r, o)),
    }));
  });
}

/**
 * time:view_team — entries of other members inside the actor's scope
 * (team view). Ad-hoc rows are visible to any time:view_team holder —
 * hiding them would falsify team totals (plan D2 decision).
 */
export async function listTeamEntries(
  ctx: TimeCtx,
  range: { from: string; to: string; memberId?: string; projectId?: string },
): Promise<(EntryListRow & { memberId: string; memberName: string })[]> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "time:view_team");
    const canSeeRates = await isAuthorized(tx, ctx.actor, "rate:view_bill");
    const scope = await scopeWhere(tx, ctx.actor, { clientField: "clientId", projectField: "projectId" });
    const rows = await tx.timeEntry.findMany({
      where: {
        tenantId: ctx.tenantId,
        deletedAt: null,
        localDate: { gte: dateColumn(range.from), lte: dateColumn(range.to) },
        ...(range.memberId ? { memberId: range.memberId } : {}),
        ...(range.projectId ? { projectId: range.projectId } : {}),
        OR: [{ projectId: null }, { projectId: { not: null }, ...scope }],
      },
      orderBy: [{ memberId: "asc" }, { startedAt: "asc" }],
      select: {
        ...entrySelect,
        memberId: true,
        rateSource: true,
        billRate: true,
        currency: true,
        lockedReason: true,
        member: { select: { user: { select: { name: true } } } },
      },
    });
    return rows.map((r, i) => ({
      ...r,
      memberName: r.member.user.name,
      billRate: canSeeRates ? (r.billRate?.toString() ?? null) : null,
      currency: canSeeRates ? r.currency : null,
      overlaps: rows.some((o, j) => j !== i && o.memberId === r.memberId && rowsOverlap(r, o)),
    }));
  });
}

export type CopyWeekResult = {
  /** Rows written into the target week. */
  created: number;
  /** Groups left out because the same row was already on that day of the target week (the idempotent no-op). */
  alreadyPresent: number;
  /** Groups left out because their target no longer resolves (archived project or type, out of scope, a rule switched off). */
  unusable: number;
};

/** "The member's OWN finished rows with a local date in [from, to]" — one spelling for every own aggregate. */
const ownFinishedWhere = (ctx: TimeCtx, from: string, to: string) =>
  ({
    tenantId: ctx.tenantId,
    memberId: ctx.actor.memberId,
    deletedAt: null,
    stoppedAt: { not: null },
    localDate: { gte: dateColumn(from), lte: dateColumn(to) },
  }) as const;

/**
 * "May this member track time here at all?" — the one answer the home
 * page (and any other surface that merely decorates itself with the time
 * module) branches on BEFORE calling a time service: no exception-driven
 * control flow, and no module bootstrap for a member or tenant the
 * module is not on for. Permission AND entitlement, exactly what
 * `requireAccess` decides.
 */
export async function canTrackTime(ctx: TimeCtx): Promise<boolean> {
  try {
    await withTenant(ctx.tenantId, principalOf(ctx), (tx) => requireAccess(tx, ctx.tenantId, ctx.actor, "time:track"));
    return true;
  } catch (e) {
    if (e instanceof AuthzError) return false;
    throw e;
  }
}

export type MyTimeTotals = {
  /** Σ of the member's own FINISHED seconds in the week range. */
  weekSeconds: number;
  /** Σ of the member's own FINISHED seconds on `today`. */
  todaySeconds: number;
};

/**
 * time:track — the /home strip's two numbers (UI.md rule 8 "this-week
 * hours (own)"): the member's OWN finished seconds this week and today,
 * from one grouped query over the week. The running entry is not summed
 * here — the client adds it live from the server instant — and nothing
 * is seeded or settled: this is a read of what is already there (the
 * settle runs with `getCurrentTimer`, which the strip fetches alongside).
 */
export async function myTimeTotals(ctx: TimeCtx, range: { from: string; to: string; today: string }): Promise<MyTimeTotals> {
  if (![range.from, range.to, range.today].every(isIsoDate) || range.from > range.to || range.today < range.from || range.today > range.to) {
    fail("INVALID_INPUT", "range");
  }
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "time:track");
    const days = await tx.timeEntry.groupBy({
      by: ["localDate"],
      where: ownFinishedWhere(ctx, range.from, range.to),
      _sum: { durationSeconds: true },
    });
    const today = dateColumn(range.today).getTime();
    return {
      weekSeconds: days.reduce((s, d) => s + (d._sum.durationSeconds ?? 0), 0),
      todaySeconds: days.find((d) => d.localDate.getTime() === today)?._sum.durationSeconds ?? 0,
    };
  });
}

/** time:track — does the member have any finished row of their own in [from, to]? (The page's "is there anything to copy".) */
export async function hasFinishedEntries(ctx: TimeCtx, range: { from: string; to: string }): Promise<boolean> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "time:track");
    const row = await tx.timeEntry.findFirst({ where: ownFinishedWhere(ctx, range.from, range.to), select: { id: true } });
    return row !== null;
  });
}

const copyRowSelect = {
  id: true,
  projectId: true,
  workItemId: true,
  serviceId: true,
  workTypeId: true,
  billable: true,
  description: true,
  durationSeconds: true,
  needsReview: true,
  localDate: true,
} as const;

/**
 * time:track — copy LAST week's rows into the grid week containing
 * `weekFrom` (UI.md rule 9, D6). The SERVICE decides what "last week"
 * is: `weekFrom` is snapped to the tenant's week start, the source is the
 * seven days before it. Each (weekday, what-it-was-about) group of the
 * member's OWN finished entries becomes one DURATION row on the same
 * weekday — with an empty duration (0; the member fills the hours in),
 * or, only on the explicit secondary `withDurations`, the group's sum of
 * confirmed seconds. Rows already present on that day are left alone
 * (idempotent); a group whose target no longer resolves at the app level
 * (archived project or work type, a project that left the member's
 * scope, ad-hoc switched off, a task moved to another project) is
 * counted `unusable`, not a reason to refuse the rest — a DB-level
 * rejection of a row that passed those checks (the scope trigger, a
 * CHECK) is a bug and aborts the copy as a whole, like createEntry.
 *
 * Lock discipline (ctx.ts): every read and every target resolution runs
 * BEFORE the member lock; under it only the idempotency re-check, the
 * inserts, the recompute and the audit rows. Every written row is
 * audited `time_entry.created` with ids only.
 */
export async function copyWeek(
  ctx: TimeCtx,
  input: { weekFrom: string; withDurations: boolean },
): Promise<CopyWeekResult> {
  if (!isIsoDate(input.weekFrom)) fail("INVALID_INPUT", "weekFrom");
  await ensureTimeDefaults(ctx.tenantId);
  return withTenant(
    ctx.tenantId,
    principalOf(ctx),
    async (tx) =>
      guarded(async () => {
        const memberId = ctx.actor.memberId;
        await requireAccess(tx, ctx.tenantId, ctx.actor, "time:track");
        await assertNoticeAcknowledged(tx, ctx.tenantId, memberId);
        const { timezone, prefs } = await resolveZone(tx, ctx.tenantId, memberId);
        const target = weekContaining(input.weekFrom, prefs.weekStart);
        const sourceFrom = addDays(target.from, -7);
        const sourceTo = addDays(target.from, -1);

        const ownRows = (from: string, to: string, finishedOnly: boolean) =>
          tx.timeEntry.findMany({
            where: {
              tenantId: ctx.tenantId,
              memberId,
              deletedAt: null,
              ...(finishedOnly ? { stoppedAt: { not: null } } : {}),
              localDate: { gte: dateColumn(from), lte: dateColumn(to) },
            },
            orderBy: { startedAt: "asc" },
            select: copyRowSelect,
          });
        const sourceRows = await ownRows(sourceFrom, sourceTo, true);
        const existingRows = await ownRows(target.from, target.to, false);
        const plan = planWeekCopy(
          sourceRows.map((r) => ({ ...r, localDate: isoDateOf(r.localDate), durationSeconds: r.durationSeconds ?? 0 })),
          existingRows.map((r) => ({ ...r, localDate: isoDateOf(r.localDate) })),
          { withDurations: input.withDurations },
        );

        // One resolution per distinct target (Mon–Fri of the same task is one), before the lock.
        const resolved = new Map<string, ResolvedTarget | null>();
        for (const row of plan.rows) {
          const key = copyRowKey(row.target);
          if (!resolved.has(key)) resolved.set(key, await resolveCopyTarget(tx, ctx, row.target, prefs));
        }

        await lockMember(tx, ctx.tenantId, memberId);
        // Idempotency is re-checked under the lock: a double-click's second
        // transaction planned against the pre-copy week and must not write
        // the same rows again.
        const presentNow = new Set((await ownRows(target.from, target.to, false)).map((r) => copyDayKey(isoDateOf(r.localDate), r)));

        let created = 0;
        let alreadyPresent = plan.alreadyPresent;
        let unusable = 0;
        const touches: SummaryTouch[] = [];
        for (const row of plan.rows) {
          if (presentNow.has(copyDayKey(row.localDate, row.target))) {
            alreadyPresent += 1;
            continue;
          }
          const resolvedTarget = resolved.get(copyRowKey(row.target)) ?? null;
          if (!resolvedTarget) {
            unusable += 1;
            continue;
          }
          const startedAt = startOfLocalDay(row.localDate, timezone);
          const entry = await writeFinishedEntry(tx, {
            tenantId: ctx.tenantId,
            memberId,
            createdByMemberId: memberId,
            target: resolvedTarget,
            startedAt,
            stoppedAt: addSeconds(startedAt, row.seconds),
            mode: "DURATION",
            timezone,
          });
          created += 1;
          touches.push({ projectId: entry.projectId, localDate: entry.localDate });
          await record(tx, {
            action: "time_entry.created",
            targetType: "TimeEntry",
            targetId: entry.id,
            metadata: idsOnly({
              mode: "DURATION",
              copiedFrom: row.sourceIds[0],
              withDurations: input.withDurations,
              projectId: resolvedTarget.projectId,
              workItemId: resolvedTarget.workItemId,
              durationSeconds: entry.durationSeconds,
            }),
          });
        }
        await recomputeTouched(tx, ctx.tenantId, touches);
        return { created, alreadyPresent, unusable };
      }),
    LOCKED_TX,
  );
}

/**
 * Resolve a planned row's target, or null when last week's row can no
 * longer be written as-is: a business rule (DomainError — archived project
 * / work type, ad-hoc switched off, a task moved project…) or the project
 * having left the member's scope (assertInScope ⇒ NOT_FOUND — the only
 * denial it raises). Anything else is a real failure and propagates.
 */
async function resolveCopyTarget(
  tx: TenantDb,
  ctx: TimeCtx,
  target: CopyRowTarget,
  prefs: TenantPreferences,
): Promise<ResolvedTarget | null> {
  try {
    return await resolveTarget(tx, ctx, target, prefs);
  } catch (e) {
    if (e instanceof DomainError) return null;
    if (e instanceof AuthzError && e.reason === "NOT_FOUND") return null;
    throw e;
  }
}
