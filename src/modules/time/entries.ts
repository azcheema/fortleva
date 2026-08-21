import { randomUUID } from "node:crypto";

import { record } from "@/audit/record";
import { assertInScope, isAuthorized, scopeWhere } from "@/authz/authorize";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import {
  addSeconds,
  dateColumn,
  floorToSecond,
  intervalsOverlap,
  localDateColumn,
  localDateString,
  parseDurationSeconds,
  secondsBetween,
  startOfLocalDay,
} from "@/lib/duration";
import { fail } from "@/lib/domain-error";

import { ensureTimeDefaults } from "./bootstrap";
import { guarded, idsOnly, lockMember, principalOf, resolveZone, type TimeCtx } from "./ctx";
import { assertNoticeAcknowledged } from "./notice";
import { settleMemberOnce } from "./settle";
import { recomputeTouched } from "./summary";
import { resolveTarget, snapshotFor, type EntryTargetInput } from "./target";
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

async function assertNoBlockedOverlap(
  tx: TenantDb,
  tenantId: string,
  memberId: string,
  startedAt: Date,
  stoppedAt: Date | null,
  excludeId: string | null,
  allowOverlap: boolean,
): Promise<void> {
  if (allowOverlap) return;
  const candidates = await tx.timeEntry.findMany({
    where: {
      tenantId,
      memberId,
      deletedAt: null,
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
      await assertNoBlockedOverlap(tx, ctx.tenantId, memberId, startedAt, stoppedAt, null, prefs.time.allowOverlap);

      const localDate = localDateColumn(startedAt, timezone);
      const snap = await snapshotFor(tx, ctx.tenantId, memberId, target, localDate);
      const id = randomUUID();
      const created = await tx.timeEntry.create({
        data: {
          id,
          tenantId: ctx.tenantId,
          clientId: target.clientId,
          projectId: target.projectId,
          serviceId: target.serviceId,
          workTypeId: target.workTypeId,
          workItemId: target.workItemId,
          memberId,
          description: target.description,
          startedAt,
          stoppedAt,
          durationSeconds: secondsBetween(startedAt, stoppedAt),
          timezone,
          localDate,
          entryMode: mode,
          source: "MANUAL",
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
      await recomputeTouched(tx, ctx.tenantId, [{ projectId: created.projectId, localDate: created.localDate }]);
      await record(tx, {
        action: forOther ? "time_entry.edited_by_other" : "time_entry.created",
        targetType: "TimeEntry",
        targetId: id,
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
      let startedAt = existing!.startedAt;
      let stoppedAt = existing!.stoppedAt;
      if (patch.startedAt) startedAt = floorToSecond(patch.startedAt);
      if (patch.stoppedAt) stoppedAt = floorToSecond(patch.stoppedAt);
      if (patch.durationText !== undefined) {
        const seconds = parseDurationSeconds(patch.durationText);
        if (seconds === null) fail("INVALID_DURATION");
        stoppedAt = addSeconds(startedAt, seconds!);
      }
      if (stoppedAt && stoppedAt <= startedAt) fail("INVALID_DURATION", "end before start");
      if (stoppedAt && secondsBetween(startedAt, stoppedAt) > 24 * 3600) fail("INVALID_DURATION", "over 24 h");
      await assertNoBlockedOverlap(tx, ctx.tenantId, existing!.memberId, startedAt, stoppedAt, existing!.id, prefs.time.allowOverlap);

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
      overlaps: rows.some(
        (o, j) => j !== i && intervalsOverlap(r.startedAt, r.stoppedAt, o.startedAt, o.stoppedAt),
      ),
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
      overlaps: rows.some(
        (o, j) =>
          j !== i && o.memberId === r.memberId && intervalsOverlap(r.startedAt, r.stoppedAt, o.startedAt, o.stoppedAt),
      ),
    }));
  });
}
