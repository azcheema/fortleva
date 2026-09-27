import { DEFAULT_TIMEZONE } from "@/i18n/config";
import { isoDateOf, localDateString } from "@/lib/duration";
import { AuthzError } from "@/authz/errors";
import { authorizePortal, withPortalRead, type PortalPrincipal } from "@/portal";

import { money } from "./ctx";
import type { ReportGroupBy, ReportSnapshot } from "./reports";

/**
 * THE HOURS & RETAINER WIDGET (Phase 3; UI.md §4 item 7; DATA_MODEL
 * §6.15) — the portal's ONE live time surface, and the published time
 * reports beside it (D3), both under `portal.hours.view`: PRIMARY only,
 * riding on the `time` module (AUTHZ.md §8).
 *
 * WHAT IS READ AND WHY IT IS SAFE. `project_time_summary` is the
 * physical class-B table the entry transaction recomputes per (project,
 * month) — NO MEMBER COLUMN BY CONSTRUCTION, so a per-member breakdown
 * cannot reach a contact-selectable row whatever this code does. Its
 * `visibility` is trigger-derived from `Project.hoursSharingMode`
 * (CLIENT_VISIBLE iff ≠ NONE) and its money columns are nulled at the
 * database unless the mode is BILLABLE_AMOUNT — so `portal_gate` (the
 * three-term form) hands a contact a month row only when the agency
 * shares hours at all, and the amount columns only when it shares
 * amounts. The `where` below restates every term as defence in depth
 * and adds the one the policy does not carry: the project's archive.
 * `time_entry` is class A and is never touched here — the widget reads
 * SUMS, never rows, which is the whole reason the table exists (§11's
 * "ProjectTimeSummary as a SQL view" rejection).
 *
 * WHAT THE WIDGET SAYS: the reader's current month, everything to date,
 * the shared budget as a FACT, and a month-by-month table. It is the
 * live twin of the hours block a published update freezes
 * (`computePortalSnapshot`, `update-metrics.ts`): same aggregate, same
 * budget rule, same vocabulary — so the post and the widget cannot
 * disagree on what a "billable second" is.
 *
 * THE BUDGET IS A FIGURE, NOT A METER — a decision, recorded. The
 * summary row carries the ACTIVE budget's amount (restamped by trigger
 * on every budget or mode change, and `createBudget` upserts the
 * current month's row so a budget set before the first entry has a row
 * to ride on) but not its PERIOD nor its
 * non-billable rule, and `project_budget` is class A. "12 h of 40 h"
 * needs to know whether 40 h is the month or the whole project; drawing
 * a bar without knowing would be a wrong bar half the time. DATA_MODEL
 * §6.15 already puts the retainer's own columns
 * (`retainerIncludedSeconds/UsedSeconds`) on this table in Phase 4; the
 * meter lands with them.
 *
 * "THIS MONTH" IS THE READER'S. The month is chosen by the reader's
 * clock and zone — the request's (`getTimeZone()`), pinned to the
 * product default on `/view-as` — while the rows' months come from the
 * entries' `local_date` in the tenant's zone. The two agree except in
 * the first hours of a month across a zone gap, which is the same
 * tolerance the header's "next milestone" accepts.
 *
 * PUBLISHED TIME REPORTS are the statement of record beside the
 * widget's ambient transparency (DATA_MODEL §6.15 D3). Their gate is
 * the FOUR-term one (`status = 'PUBLISHED'`) and has no hours-mode
 * term: a report is published by an explicit, audited act of a member
 * holding `time_report:publish`, and it shows whatever that member
 * previewed — with amounts iff the report was generated with them by a
 * member holding `rate:view_bill`. The snapshot is client-safe by
 * construction (no member key can exist; INTERNAL names folded at
 * generation), which is what makes it selectable here.
 */

/** One month of the widget: "YYYY-MM", total seconds, of which billable, and the billed amount when shared. */
export type PortalHoursMonth = {
  readonly month: string;
  readonly seconds: number;
  readonly billableSeconds: number;
  /** `"1234.50"` when the project shares amounts and the month has billable time; null otherwise. */
  readonly amount: string | null;
};

export type PortalHoursLive = {
  readonly mode: "HOURS" | "BILLABLE_AMOUNT";
  readonly currency: string | null;
  /** The reader's current month — zeros when nothing was logged in it yet. */
  readonly thisMonth: PortalHoursMonth;
  /** Everything ever logged on the project, all months summed. */
  readonly toDate: { readonly seconds: number; readonly billableSeconds: number; readonly amount: string | null };
  /** The ACTIVE hours budget, in seconds, when shared (any mode but NONE). */
  readonly budgetSeconds: number | null;
  /** The ACTIVE money budget, when shared (BILLABLE_AMOUNT only). */
  readonly budgetAmount: string | null;
  /** Months with time logged, newest first, cut at `PORTAL_HOURS_MONTHS`. */
  readonly months: readonly PortalHoursMonth[];
  /** True when older months exist beyond the cut; `toDate` still counts them. */
  readonly truncated: boolean;
};

export type PortalTimeReport = {
  readonly id: string;
  readonly title: string;
  /** `@db.Date`s — format with `formatDay`. */
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly groupBy: ReportGroupBy;
  readonly totalSeconds: number;
  readonly billableSeconds: number;
  /** The report's own choice, made at generation by a member who could see amounts. */
  readonly billableAmount: string | null;
  readonly currency: string | null;
  readonly publishedAt: Date;
  /** The frozen lines, as `buildSnapshot` wrote them — the shape `ReportSnapshotTable` draws. */
  readonly snapshot: ReportSnapshot;
};

export type PortalHours = {
  /** Null when the project shares no hours (`hoursSharingMode = NONE`) — the widget is then not drawn. */
  readonly live: PortalHoursLive | null;
  /** The project's published reports, newest period first, cut at `PORTAL_REPORT_LIMIT`. */
  readonly reports: readonly PortalTimeReport[];
  /** True when older published reports exist beyond the cut. */
  readonly reportsTruncated: boolean;
};

/** The months the table shows; older ones are summed into "to date" and announced as such. */
export const PORTAL_HOURS_MONTHS = 12;

/** The most reports one project's list will show. */
export const PORTAL_REPORT_LIMIT = 24;

const sum = (a: string | null, b: string | null): string | null =>
  a === null && b === null ? null : money(Number(a ?? "0") + Number(b ?? "0"));

export async function readPortalHours(
  principal: PortalPrincipal,
  projectId: string,
  /** The reader's clock and zone — the request's (`getTimeZone()`), so View-as and the portal agree on "this month". */
  clock: { readonly now?: Date; readonly timeZone?: string } = {},
): Promise<PortalHours> {
  const now = clock.now ?? new Date();
  const timeZone = clock.timeZone ?? DEFAULT_TIMEZONE;
  const currentMonth = localDateString(now, timeZone).slice(0, 7);
  return withPortalRead(principal, async (tx) => {
    // The project ref proves, under `portal_gate` on `project`, that this
    // contact may read THIS project (client match + the portal switch) —
    // asked of the capability EVERY profile holds, so an out-of-scope
    // project, a switched-off one and a suspended contact are still
    // refused with the plane's own reasons.
    await authorizePortal(tx, principal, "portal.project.view", { kind: "project", projectId });
    // THE HOURS CAPABILITY, ASKED WITHOUT THROWING — `listPortalUpdates`'
    // rule for the same capability: `portal.hours.view` is PRIMARY only,
    // so for a collaborator the answer is "nothing here", decided in the
    // projection, not a refusal the page would log as a denial on every
    // visit (review, slice 71). The section is then absent, which is what
    // "no money to a collaborator" looks like. Anything but an AuthzError
    // still propagates.
    try {
      await authorizePortal(tx, principal, "portal.hours.view", { kind: "project", projectId });
    } catch (e) {
      if (!(e instanceof AuthzError)) throw e;
      return { live: null, reports: [], reportsTruncated: false };
    }

    // THE MODE, read off the project row the ref just proved readable.
    // Needed because a BILLABLE_AMOUNT month with no billable time has a
    // NULL amount (a SUM over no rows), which is indistinguishable from
    // HOURS mode on the row alone — and the widget must say "0 kr" in
    // one case and nothing about money in the other. The archive term
    // is the projection's, as everywhere on this plane: an archived
    // project publishes nothing (founder decision, 2026-09-21).
    const project = await tx.project.findFirst({
      where: { tenantId: principal.tenantId, clientId: principal.clientId, id: projectId, portalEnabled: true, archivedAt: null },
      select: { hoursSharingMode: true, billingCurrency: true },
    });

    let live: PortalHoursLive | null = null;
    if (project && project.hoursSharingMode !== "NONE") {
      const mode = project.hoursSharingMode;
      // Tenant, client, visibility and the portal switch are
      // `portal_gate`'s (three-term form) under this principal; repeated
      // as defence in depth. No `take`: a project owns at most twelve
      // rows a year, and "to date" is the sum of every one of them.
      const rows = await tx.projectTimeSummary.findMany({
        where: {
          tenantId: principal.tenantId,
          clientId: principal.clientId,
          projectId,
          visibility: "CLIENT_VISIBLE",
          portalEnabled: true,
          project: { archivedAt: null },
        },
        select: {
          periodMonth: true,
          billableSeconds: true,
          nonBillableSeconds: true,
          billableAmount: true,
          budgetSeconds: true,
          budgetAmount: true,
        },
        orderBy: [{ periodMonth: "desc" }],
      });
      const all: PortalHoursMonth[] = rows.map((r) => ({
        month: isoDateOf(r.periodMonth).slice(0, 7),
        seconds: r.billableSeconds + r.nonBillableSeconds,
        billableSeconds: r.billableSeconds,
        // The column is nulled at the database outside BILLABLE_AMOUNT;
        // the mode check here is the same rule said twice.
        amount: mode === "BILLABLE_AMOUNT" && r.billableAmount !== null ? money(Number(r.billableAmount.toString())) : null,
      }));
      // A zero row exists for the month a budget was set in before any
      // entry (`createBudget` upserts it so the budget has a row to ride);
      // it carries the budget, not a month worth listing.
      const months = all.filter((m) => m.seconds > 0);
      const toDate = months.reduce(
        (acc, m) => ({
          seconds: acc.seconds + m.seconds,
          billableSeconds: acc.billableSeconds + m.billableSeconds,
          amount: sum(acc.amount, m.amount),
        }),
        { seconds: 0, billableSeconds: 0, amount: null as string | null },
      );
      const empty: PortalHoursMonth = {
        month: currentMonth,
        seconds: 0,
        billableSeconds: 0,
        amount: mode === "BILLABLE_AMOUNT" ? money(0) : null,
      };
      // The budget columns are restamped on EVERY row by the fan-out
      // triggers (`project_hours_sharing_fanout`,
      // `project_budget_summary_fanout`), so any row's answer is the
      // project's; the newest is read for the same reason "to date" is
      // summed rather than trusted — one row, one rule.
      const newest = rows[0] ?? null;
      live = {
        mode,
        currency: project.billingCurrency,
        thisMonth: months.find((m) => m.month === currentMonth) ?? empty,
        toDate: {
          ...toDate,
          amount: mode === "BILLABLE_AMOUNT" ? (toDate.amount ?? money(0)) : null,
        },
        budgetSeconds: newest?.budgetSeconds ?? null,
        budgetAmount:
          mode === "BILLABLE_AMOUNT" && newest?.budgetAmount != null ? money(Number(newest.budgetAmount.toString())) : null,
        months: months.slice(0, PORTAL_HOURS_MONTHS),
        truncated: months.length > PORTAL_HOURS_MONTHS,
      };
    }

    // THE PUBLISHED REPORTS — sequential, after the summary read, on
    // the same connection (AGENTS.md's `Promise.all` trap). Tenant,
    // client, visibility, the switch and PUBLISHED are all the
    // four-term gate's; the archive term is ours.
    const reportRows = await tx.timeReport.findMany({
      where: {
        tenantId: principal.tenantId,
        clientId: principal.clientId,
        projectId,
        visibility: "CLIENT_VISIBLE",
        portalEnabled: true,
        status: "PUBLISHED",
        project: { archivedAt: null },
      },
      select: {
        id: true,
        title: true,
        periodStart: true,
        periodEnd: true,
        groupBy: true,
        includeAmounts: true,
        totalSeconds: true,
        billableSeconds: true,
        billableAmount: true,
        currency: true,
        publishedAt: true,
        snapshot: true,
      },
      orderBy: [{ periodStart: "desc" }, { publishedAt: "desc" }],
      // One past the cut, so the page can say older ones exist rather
      // than let a statement of record fall off the end silently.
      take: PORTAL_REPORT_LIMIT + 1,
    });
    const reportsTruncated = reportRows.length > PORTAL_REPORT_LIMIT;
    const reports: PortalTimeReport[] = [];
    for (const r of reportRows.slice(0, PORTAL_REPORT_LIMIT)) {
      // Non-null on every PUBLISHED row; the guard keeps the type honest.
      if (r.publishedAt === null) continue;
      reports.push({
        id: r.id,
        title: r.title,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        groupBy: r.groupBy,
        totalSeconds: r.totalSeconds,
        billableSeconds: r.billableSeconds,
        billableAmount: r.includeAmounts && r.billableAmount !== null ? money(Number(r.billableAmount.toString())) : null,
        currency: r.currency,
        publishedAt: r.publishedAt,
        snapshot: r.snapshot as ReportSnapshot,
      });
    }

    return { live, reports, reportsTruncated };
  });
}
