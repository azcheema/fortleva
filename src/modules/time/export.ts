import { record } from "@/audit/record";
import { assertInScope, isAuthorized, scopeWhere } from "@/authz/authorize";
import { withTenant } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { dateColumn, isoDateOf, secondsBetween } from "@/lib/duration";
import { fail } from "@/lib/domain-error";
import { MAX_YEAR, MIN_YEAR, daysBetween, isIsoDate, monthContaining, spanDays } from "@/lib/week";

import { billAmountOf, idsOnly, money, principalOf, type TimeCtx } from "./ctx";
import { projectMoney, type MoneyLine } from "./money";
import { projectRollup, type Range, type RollupLine } from "./rollup";
import { settleMemberOnce } from "./settle";
import { breakSecondsOf } from "./worked";

export { entriesCsv, rollupCsv, statementCsv } from "./export-csv";

/**
 * Exports (PLAN.md 2T "CSV exports" + D1 "monthly working-time statement";
 * SECURITY.md §9.7.3–§9.7.4; AUTHZ.md `time:export`):
 *
 *  - a member's OWN entries and own statement need nothing beyond
 *    `time:track` — Art. 15/20 self-access "handled by a button";
 *  - TEAM entries (inside scope), a PROJECT's entries/rollup and another
 *    member's statement need `time:export` (+ `time:view_team`);
 *  - bill rate / amount columns exist only for `rate:view_bill`
 *    (UI.md rule 14: the column is absent, not blank);
 *  - COST is never in a CSV by default: the rollup export gains cost +
 *    margin only when the caller asks (`includeCost`) AND the ✦ reveal
 *    passes (rate:view_cost + the tenant's cost layer + a fresh factor,
 *    audited `rate_card.cost_revealed`), exactly like the money page —
 *    a stale factor is MFA_REQUIRED, a missing permission is silently
 *    "no cost", never an error and never a leak;
 *  - every export records ONE `time.exported` row with ids and counts
 *    only (never a name, never an amount), `includesCost` stating what
 *    the file actually contains;
 *  - closed rows only (a running timer / open shift is not a fact yet),
 *    and another member's statement carries no tracked-time column —
 *    attendance is what the employer's record (ATL §11) is about, task
 *    time of another member inside a partial scope would misstate it;
 *  - numbers are machine-formatted (`machineNumber`), headers are
 *    machine keys: a CSV is for other programs, the screen localises.
 */

export type ExportRange = Range;

const MAX_RANGE_DAYS = 366;

/** Runs before any permission check on a user-supplied range, so it must be O(1): arithmetic, never a day loop. */
function assertRange(r: ExportRange): void {
  if (!isIsoDate(r.from) || !isIsoDate(r.to) || r.from > r.to) fail("INVALID_INPUT", "bad range");
  if (spanDays(r.from, r.to) > MAX_RANGE_DAYS) fail("INVALID_INPUT", "range too long");
}

// ── Entries ─────────────────────────────────────────────────────────

export type EntryExportRow = {
  id: string;
  /** Local date of the start (the entry's own zone). */
  date: string;
  /** ISO 8601, UTC. */
  startedAt: string;
  stoppedAt: string;
  timezone: string;
  seconds: number;
  memberId: string;
  memberName: string;
  clientName: string | null;
  projectKey: string | null;
  projectName: string | null;
  taskKey: string | null;
  taskTitle: string | null;
  agreement: string | null;
  workType: string | null;
  billable: boolean;
  description: string | null;
  entryMode: string;
  source: string;
  needsReview: boolean;
  lockedReason: string | null;
  /** Only with rate:view_bill; null otherwise (and the CSV has no such column). */
  rate: string | null;
  currency: string | null;
  amount: string | null;
};

export type EntriesExportFilter =
  | { scope: "own" }
  | { scope: "team"; memberId?: string; projectId?: string };

export type EntriesExport = {
  scope: "own" | "team";
  range: ExportRange;
  includesRates: boolean;
  rows: EntryExportRow[];
};

/**
 * Own (time:track) or team (time:export + time:view_team, inside scope)
 * closed entries in a local-date range. Audited `time.exported`.
 */
export async function exportEntries(ctx: TimeCtx, range: ExportRange, filter: EntriesExportFilter): Promise<EntriesExport> {
  assertRange(range);
  if (filter.scope === "own") await settleMemberOnce(ctx.tenantId, ctx.actor.memberId);
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    let narrow: Record<string, unknown>;
    if (filter.scope === "own") {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "time:track");
      narrow = { memberId: ctx.actor.memberId };
    } else {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "time:export");
      await requireAccess(tx, ctx.tenantId, ctx.actor, "time:view_team");
      if (filter.projectId) await assertInScope(tx, ctx.actor, { projectId: filter.projectId });
      const scope = await scopeWhere(tx, ctx.actor, { clientField: "clientId", projectField: "projectId" });
      narrow = {
        ...(filter.memberId ? { memberId: filter.memberId } : {}),
        ...(filter.projectId ? { projectId: filter.projectId } : {}),
        // Ad-hoc (project-less) rows are visible to every team viewer — hiding them would falsify totals (D2).
        OR: [{ projectId: null }, { projectId: { not: null }, ...scope }],
      };
    }
    const includesRates = await isAuthorized(tx, ctx.actor, "rate:view_bill");
    const rows = await tx.timeEntry.findMany({
      where: {
        tenantId: ctx.tenantId,
        deletedAt: null,
        stoppedAt: { not: null },
        localDate: { gte: dateColumn(range.from), lte: dateColumn(range.to) },
        ...narrow,
      },
      orderBy: [{ memberId: "asc" }, { startedAt: "asc" }],
      select: {
        id: true,
        memberId: true,
        localDate: true,
        startedAt: true,
        stoppedAt: true,
        timezone: true,
        durationSeconds: true,
        billable: true,
        description: true,
        entryMode: true,
        source: true,
        needsReview: true,
        lockedReason: true,
        billRate: true,
        currency: true,
        member: { select: { user: { select: { name: true } } } },
        client: { select: { name: true } },
        project: { select: { key: true, name: true } },
        workItem: { select: { number: true, title: true, project: { select: { key: true } } } },
        service: { select: { name: true } },
        workType: { select: { name: true } },
      },
    });
    // Target = what the file is about: the project, the one member, or (an unfiltered team export) the tenant itself.
    const target =
      filter.scope === "own"
        ? { targetType: "Member", targetId: ctx.actor.memberId }
        : filter.projectId
          ? { targetType: "Project", targetId: filter.projectId }
          : filter.memberId
            ? { targetType: "Member", targetId: filter.memberId }
            : { targetType: "Tenant", targetId: ctx.tenantId };
    await record(tx, {
      action: "time.exported",
      ...target,
      metadata: idsOnly({
        kind: "entries",
        scope: filter.scope,
        from: range.from,
        to: range.to,
        rows: rows.length,
        includesRates,
        includesCost: false,
        memberId: filter.scope === "team" ? filter.memberId : undefined,
        projectId: filter.scope === "team" ? filter.projectId : undefined,
      }),
    });
    return {
      scope: filter.scope,
      range,
      includesRates,
      rows: rows.map((r) => ({
        id: r.id,
        date: isoDateOf(r.localDate),
        startedAt: r.startedAt.toISOString(),
        stoppedAt: r.stoppedAt!.toISOString(),
        timezone: r.timezone,
        seconds: r.durationSeconds ?? 0,
        memberId: r.memberId,
        memberName: r.member.user.name,
        clientName: r.client?.name ?? null,
        projectKey: r.project?.key ?? null,
        projectName: r.project?.name ?? null,
        taskKey: r.workItem ? `${r.workItem.project.key}-${r.workItem.number}` : null,
        taskTitle: r.workItem?.title ?? null,
        agreement: r.service?.name ?? null,
        workType: r.workType?.name ?? null,
        billable: r.billable,
        description: r.description,
        entryMode: r.entryMode,
        source: r.source,
        needsReview: r.needsReview,
        lockedReason: r.lockedReason,
        rate: includesRates && r.billRate ? money(Number(r.billRate.toString())) : null,
        currency: includesRates ? r.currency : null,
        amount: includesRates ? money(billAmountOf(r)) : null,
      })),
    };
  });
}

// ── Project rollup (with the ✦ cost columns on explicit ask) ────────

export type RollupExportLine = {
  dimension: "member" | "task" | "epic" | "agreement" | "work_type" | "total";
  key: string;
  label: string;
  seconds: number;
  billableSeconds: number;
  /** rate:view_bill only. */
  amount: string | null;
  /** ✦ only (includesCost). */
  cost: string | null;
  margin: string | null;
  marginPercent: number | null;
};

export type RollupExport = {
  projectId: string;
  range: ExportRange;
  currency: string | null;
  includesAmounts: boolean;
  includesCost: boolean;
  lines: RollupExportLine[];
};

/**
 * time:export + the project rollup's own gates (time:view_team + scope;
 * amounts with rate:view_bill). `includeCost` runs the audited ✦ reveal
 * through projectMoney — ignored without rate:view_cost / the cost
 * layer, MFA_REQUIRED on a stale factor (the caller turns that into
 * step-up navigation and comes back with the same URL).
 */
export async function exportProjectRollup(
  ctx: TimeCtx,
  projectId: string,
  range: ExportRange,
  opts: { includeCost: boolean } = { includeCost: false },
): Promise<RollupExport> {
  assertRange(range);
  await withTenant(ctx.tenantId, principalOf(ctx), (tx) => requireAccess(tx, ctx.tenantId, ctx.actor, "time:export"));
  const rollup = await projectRollup(ctx, projectId, range);
  const includesAmounts = rollup.totals.amount !== null;
  // projectMoney needs rate:view_bill itself — exactly the holders who see amounts here.
  const cost = opts.includeCost && includesAmounts ? await projectMoney(ctx, projectId, range, { revealCost: true }) : null;
  // Revealed AND usable: on a COST-card currency mismatch projectMoney withholds every cost figure
  // (two currencies never sum), so the file must not claim cost columns it cannot fill.
  const includesCost = cost?.costRevealed === true && !cost.currencyMismatch;

  const costBy = (lines: readonly MoneyLine[] | undefined) => new Map((lines ?? []).map((l) => [l.key, l]));
  const costMaps = {
    member: costBy(cost?.byMember),
    task: costBy(cost?.byItem),
    epic: costBy(cost?.byEpic),
    agreement: costBy(cost?.byAgreement),
    work_type: new Map<string, MoneyLine>(), // cost is a member attribute; there is no per-work-type cost line
  };
  const lineOf = (dimension: Exclude<RollupExportLine["dimension"], "total">, l: RollupLine): RollupExportLine => {
    const c = includesCost ? costMaps[dimension].get(l.key) : undefined;
    return {
      dimension,
      key: l.key,
      label: l.label,
      seconds: l.seconds,
      billableSeconds: l.billableSeconds,
      amount: l.amount,
      cost: c?.cost ?? null,
      margin: c?.margin ?? null,
      marginPercent: c?.marginPercent ?? null,
    };
  };
  const lines: RollupExportLine[] = [
    ...rollup.byMember.map((l) => lineOf("member", l)),
    ...rollup.byItem.map((l) => lineOf("task", l)),
    ...rollup.byEpic.map((l) => lineOf("epic", l)),
    ...rollup.byAgreement.map((l) => lineOf("agreement", l)),
    ...rollup.byWorkType.map((l) => lineOf("work_type", l)),
    {
      dimension: "total",
      key: "total",
      label: "",
      seconds: rollup.totals.seconds,
      billableSeconds: rollup.totals.billableSeconds,
      amount: rollup.totals.amount,
      cost: includesCost ? (cost?.totals.cost ?? null) : null,
      margin: includesCost ? (cost?.totals.margin ?? null) : null,
      marginPercent: includesCost ? (cost?.totals.marginPercent ?? null) : null,
    },
  ];
  await withTenant(ctx.tenantId, principalOf(ctx), (tx) =>
    record(tx, {
      action: "time.exported",
      targetType: "Project",
      targetId: projectId,
      metadata: idsOnly({
        kind: "project_rollup",
        projectId,
        from: range.from,
        to: range.to,
        rows: lines.length,
        includesRates: includesAmounts,
        includesCost,
      }),
    }),
  );
  return { projectId, range, currency: rollup.currency, includesAmounts, includesCost, lines };
}

// ── Working-time statement (D1: the ATL §11 journal, per member, per month)

export type StatementShift = {
  id: string;
  startedAt: Date;
  stoppedAt: Date;
  timezone: string;
  breakSeconds: number;
  workedSeconds: number;
  /** Auto-closed at the 14 h bound and not yet confirmed — visibly provisional. */
  provisional: boolean;
  /** > 5 h without a recorded break — the statutory-break WARN (never auto-inserted). */
  noBreak: boolean;
  note: string | null;
};

export type StatementDay = {
  date: string;
  shifts: StatementShift[];
  spanSeconds: number;
  breakSeconds: number;
  workedSeconds: number;
  /** Closed task time that day — OWN statement only (null for another member's). */
  trackedSeconds: number | null;
  /** worked − tracked, SIGNED (negative = more tracked than worked, "over") so worked = tracked + unallocated always holds — OWN statement only. */
  unallocatedSeconds: number | null;
};

export type WorkingTimeStatement = {
  memberId: string;
  memberName: string;
  /** The viewer is the member — tracked/unallocated columns present. */
  own: boolean;
  tenantName: string;
  month: string;
  from: string;
  to: string;
  /** The member's zone (falls back to the tenant's), for the header. */
  timezone: string | null;
  hoursPerDay: number | null;
  /** Mon–Fri days in the month — holidays NOT deducted; "expected" is indicative only. */
  weekdays: number;
  expectedSeconds: number | null;
  days: StatementDay[];
  totals: {
    shifts: number;
    spanSeconds: number;
    breakSeconds: number;
    workedSeconds: number;
    trackedSeconds: number | null;
    unallocatedSeconds: number | null;
    provisional: number;
    noBreak: number;
  };
  generatedAt: Date;
};

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const FIVE_HOURS = 5 * 3600;

/** "YYYY-MM" inside the product's year bounds (MIN_YEAR..MAX_YEAR — `monthContaining` would otherwise build an invalid date). */
export const isMonth = (s: string | null | undefined): s is string =>
  typeof s === "string" && MONTH_RE.test(s) && Number(s.slice(0, 4)) >= MIN_YEAR && Number(s.slice(0, 4)) <= MAX_YEAR;

/**
 * Own (time:track) or another member's (time:view_team + time:export)
 * statement for one month. Closed shifts only — an open shift is never
 * selected for another member (never live presence), and the viewer's
 * own open shift is today's business on /time, not a record yet.
 */
export async function workingTimeStatement(
  ctx: TimeCtx,
  input: { month: string; memberId?: string },
): Promise<WorkingTimeStatement> {
  if (!isMonth(input.month)) fail("INVALID_INPUT", "bad month");
  const memberId = input.memberId ?? ctx.actor.memberId;
  const own = memberId === ctx.actor.memberId;
  const { from, to } = monthContaining(`${input.month}-01`);
  if (own) await settleMemberOnce(ctx.tenantId, memberId);
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    if (own) await requireAccess(tx, ctx.tenantId, ctx.actor, "time:track");
    else {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "time:view_team");
      await requireAccess(tx, ctx.tenantId, ctx.actor, "time:export");
    }
    const [member, tenant, shifts, entries] = await Promise.all([
      tx.member.findFirst({
        where: { tenantId: ctx.tenantId, id: memberId },
        select: { timezone: true, hoursPerDay: true, user: { select: { name: true } } },
      }),
      tx.tenant.findFirst({ where: { id: ctx.tenantId }, select: { name: true } }),
      tx.shift.findMany({
        where: {
          tenantId: ctx.tenantId,
          memberId,
          deletedAt: null,
          stoppedAt: { not: null },
          localDate: { gte: dateColumn(from), lte: dateColumn(to) },
        },
        orderBy: { startedAt: "asc" },
        select: {
          id: true,
          startedAt: true,
          stoppedAt: true,
          timezone: true,
          localDate: true,
          workedSeconds: true,
          needsReview: true,
          note: true,
          breaks: { select: { startedAt: true, stoppedAt: true } },
        },
      }),
      own
        ? tx.timeEntry.findMany({
            where: {
              tenantId: ctx.tenantId,
              memberId,
              deletedAt: null,
              stoppedAt: { not: null },
              localDate: { gte: dateColumn(from), lte: dateColumn(to) },
            },
            select: { localDate: true, durationSeconds: true },
          })
        : Promise.resolve(null),
    ]);
    if (!member) fail("INVALID_INPUT", "unknown member");

    const trackedByDay = new Map<string, number>();
    for (const e of entries ?? []) {
      const d = isoDateOf(e.localDate);
      trackedByDay.set(d, (trackedByDay.get(d) ?? 0) + (e.durationSeconds ?? 0));
    }
    const shiftsByDay = new Map<string, StatementShift[]>();
    for (const s of shifts) {
      const stoppedAt = s.stoppedAt!;
      const breakSeconds = breakSecondsOf(s.breaks, stoppedAt);
      const span = secondsBetween(s.startedAt, stoppedAt);
      const row: StatementShift = {
        id: s.id,
        startedAt: s.startedAt,
        stoppedAt,
        timezone: s.timezone,
        breakSeconds,
        workedSeconds: s.workedSeconds ?? Math.max(0, span - breakSeconds),
        provisional: s.needsReview,
        noBreak: span > FIVE_HOURS && breakSeconds === 0,
        // A shift note is the member's own free text: it travels on the OWN statement only.
        // Another member's statement is start/end/break/worked (SECURITY.md §9.7.7 D1), nothing more.
        note: own ? s.note : null,
      };
      const d = isoDateOf(s.localDate);
      shiftsByDay.set(d, [...(shiftsByDay.get(d) ?? []), row]);
    }
    const days: StatementDay[] = daysBetween(from, to).map((date) => {
      const rows = shiftsByDay.get(date) ?? [];
      const spanSeconds = rows.reduce((s, r) => s + secondsBetween(r.startedAt, r.stoppedAt), 0);
      const breakSeconds = rows.reduce((s, r) => s + r.breakSeconds, 0);
      const workedSeconds = rows.reduce((s, r) => s + r.workedSeconds, 0);
      const trackedSeconds = own ? (trackedByDay.get(date) ?? 0) : null;
      return {
        date,
        shifts: rows,
        spanSeconds,
        breakSeconds,
        workedSeconds,
        trackedSeconds,
        unallocatedSeconds: trackedSeconds === null ? null : workedSeconds - trackedSeconds,
      };
    });
    const sum = (pick: (d: StatementDay) => number | null): number | null =>
      own ? days.reduce((s, d) => s + (pick(d) ?? 0), 0) : null;
    const hoursPerDay = member!.hoursPerDay ? Number(member!.hoursPerDay.toString()) : null;
    const weekdays = daysBetween(from, to).filter((d) => {
      const dow = dateColumn(d).getUTCDay();
      return dow >= 1 && dow <= 5;
    }).length;
    return {
      memberId,
      memberName: member!.user.name,
      own,
      tenantName: tenant?.name ?? "",
      month: input.month,
      from,
      to,
      timezone: member!.timezone,
      hoursPerDay,
      weekdays,
      expectedSeconds: hoursPerDay !== null ? Math.round(hoursPerDay * weekdays * 3600) : null,
      days,
      totals: {
        shifts: shifts.length,
        spanSeconds: days.reduce((s, d) => s + d.spanSeconds, 0),
        breakSeconds: days.reduce((s, d) => s + d.breakSeconds, 0),
        workedSeconds: days.reduce((s, d) => s + d.workedSeconds, 0),
        trackedSeconds: own ? sum((d) => d.trackedSeconds) : null,
        unallocatedSeconds: own ? sum((d) => d.unallocatedSeconds) : null,
        provisional: shifts.filter((s) => s.needsReview).length,
        noBreak: days.reduce((n, d) => n + d.shifts.filter((r) => r.noBreak).length, 0),
      },
      generatedAt: new Date(),
    };
  });
}

/** The statement as a download: built, then audited `time.exported` (kind statement, ids only). */
export async function exportStatement(ctx: TimeCtx, input: { month: string; memberId?: string }): Promise<WorkingTimeStatement> {
  const statement = await workingTimeStatement(ctx, input);
  await withTenant(ctx.tenantId, principalOf(ctx), (tx) =>
    record(tx, {
      action: "time.exported",
      targetType: "Member",
      targetId: statement.memberId,
      metadata: idsOnly({
        kind: "statement",
        scope: statement.own ? "own" : "team",
        memberId: statement.memberId,
        month: statement.month,
        rows: statement.totals.shifts,
        includesCost: false,
      }),
    }),
  );
  return statement;
}
