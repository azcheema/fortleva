import { startOfLocalDay } from "@/lib/duration";

/**
 * THE SHAPES OF A PROGRESS UPDATE'S FROZEN NUMBERS, and the two pure
 * rules over them — a LEAF module with no database import, so the
 * composer (a client component), the shared renderer and the unit test
 * can all reach it. The computations that read rows live in
 * `update-metrics.ts` next door and re-export these.
 *
 * Two snapshots, two tables, one rule (DATA_MODEL.md §6.16, SECURITY.md
 * §T9): `PortalSnapshot` is what the class-B post carries — aggregates a
 * client may read — and `InternalSnapshot` is the class-A twin. The
 * allow-list `PORTAL_SNAPSHOT_KEYS` is the belt: every key the portal
 * snapshot may contain, pinned, and `update-metrics.test.ts` walks a
 * built snapshot against it. A key added to the portal shape without
 * being named there fails the unit suite; a member id or a margin
 * figure never had a key to arrive under.
 */

/** An instant window: `[from, to)`. */
export type MetricsWindow = { readonly from: Date; readonly to: Date };

export type HoursFigure = {
  readonly seconds: number;
  readonly billableSeconds: number;
  /** Σ billable hours × the bill-rate snapshot, 2 dp — BILLABLE_AMOUNT only. */
  readonly amount: string | null;
};

export type PortalSnapshot = {
  readonly version: 1;
  /** ISO instant the numbers were computed. */
  readonly computedAt: string;
  /** The window the "in period" figures cover, as ISO instants. */
  readonly window: { readonly from: string; readonly to: string };
  readonly tasks?: { readonly done: number; readonly total: number; readonly doneInPeriod: number };
  readonly milestones?: {
    readonly done: number;
    readonly total: number;
    /** Names of the CLIENT_VISIBLE milestones completed in the window, oldest first. */
    readonly hitInPeriod: readonly string[];
  };
  readonly versions?: {
    readonly shippedInPeriod: readonly { readonly version: string; readonly title: string | null }[];
  };
  readonly requests?: { readonly open: number; readonly acceptedInPeriod: number };
  /** Present only when `Project.hoursSharingMode ≠ NONE`; amounts only for BILLABLE_AMOUNT. */
  readonly hours?: {
    readonly mode: "HOURS" | "BILLABLE_AMOUNT";
    readonly inPeriod: HoursFigure;
    readonly toDate: HoursFigure;
    readonly budgetSeconds: number | null;
    readonly budgetAmount: string | null;
    readonly currency: string | null;
  };
};

/**
 * Every key a portal snapshot may carry — the forbidden-keys walk's
 * allow-list. Pinned as a readonly tuple so the unit test can assert the
 * list itself did not quietly grow a `memberId`.
 */
export const PORTAL_SNAPSHOT_KEYS = [
  "version",
  "computedAt",
  "window",
  "from",
  "to",
  "tasks",
  "done",
  "total",
  "doneInPeriod",
  "milestones",
  "hitInPeriod",
  "versions",
  "shippedInPeriod",
  "title",
  "requests",
  "open",
  "acceptedInPeriod",
  "hours",
  "mode",
  "inPeriod",
  "toDate",
  "seconds",
  "billableSeconds",
  "amount",
  "budgetSeconds",
  "budgetAmount",
  "currency",
] as const;

/** Walk any JSON value and return the object keys that are not on the allow-list. */
export function foreignPortalSnapshotKeys(value: unknown): string[] {
  const allowed: ReadonlySet<string> = new Set(PORTAL_SNAPSHOT_KEYS);
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (typeof v !== "object" || v === null) return;
    for (const [k, child] of Object.entries(v)) {
      if (!allowed.has(k)) out.push(k);
      visit(child);
    }
  };
  visit(value);
  return out;
}

/** Which of the codes that gate the hours block's LIVE sources the reader holds. */
export type HoursAccess = {
  /** `time:view_team` — project-wide seconds at all. */
  readonly team: boolean;
  /** `budget:view` — the active budget's size. */
  readonly budget: boolean;
  /** `rate:view_bill` — billed amounts. */
  readonly bill: boolean;
};

/**
 * THE HOURS BLOCK AS *THIS* READER MAY SEE IT (security review of slice
 * 67, both planes). The frozen row stays complete for the client the
 * agency shared it with; what a MEMBER reads off it is gated by the
 * same codes that gate the figures live — the Time tab, the budget card
 * and the Money page all refuse an Employee these numbers, and a frozen
 * post must never widen what a member could read live (AUTHZ.md §3.1).
 * Without `time:view_team` the block is gone; without `budget:view` the
 * budget figures are null; without `rate:view_bill` every amount is.
 */
export function redactHoursFor(snapshot: PortalSnapshot, access: HoursAccess): PortalSnapshot {
  if (!snapshot.hours) return snapshot;
  if (!access.team) return withoutHours(snapshot);
  const h = snapshot.hours;
  const figure = (f: HoursFigure): HoursFigure => (access.bill ? f : { ...f, amount: null });
  return {
    ...snapshot,
    hours: {
      ...h,
      inPeriod: figure(h.inPeriod),
      toDate: figure(h.toDate),
      budgetSeconds: access.budget ? h.budgetSeconds : null,
      budgetAmount: access.budget && access.bill ? h.budgetAmount : null,
    },
  };
}

/**
 * The snapshot with no hours block at all — what a contact who does not
 * hold `portal.hours.view` (a `CONTACT_COLLABORATOR`, or any contact of
 * a tenant whose `time` module is off) is projected. Typed loosely
 * because the portal projection hands the stored JSON over as `unknown`.
 */
export function withoutHours<T extends object>(snapshot: T): T {
  if (!("hours" in snapshot)) return snapshot;
  const rest: Record<string, unknown> = { ...(snapshot as Record<string, unknown>) };
  delete rest["hours"];
  return rest as T;
}

export type InternalSnapshot = {
  readonly version: 1;
  /** Hours per member in the window — null when the publisher could not see team time. */
  readonly byMember:
    | readonly { readonly memberId: string; readonly name: string; readonly seconds: number; readonly billableSeconds: number }[]
    | null;
  /** Cost and margin for the window — null unless the publisher held rate:view_cost ✦ with a recent factor. */
  readonly cost: {
    readonly cost: string;
    readonly value: string;
    readonly margin: string;
    readonly marginPercent: number | null;
    readonly currency: string | null;
    /** Seconds on entries with no cost card at the time — reported, never silently costed at zero. */
    readonly uncostedSeconds: number;
  } | null;
  /** The ACTIVE budget's burn at publish — null when there is none or the publisher could not see budgets. */
  readonly budget: {
    readonly kind: "HOURS" | "MONEY";
    readonly amount: string;
    readonly currency: string | null;
    readonly periodKey: string;
    readonly usedSeconds: number;
    /** MONEY budgets, and only when the publisher could see bill amounts. */
    readonly usedAmount: string | null;
    readonly usedPercent: number;
  } | null;
};

/**
 * WHAT HAPPENED SINCE THE LAST UPDATE — the composer's pull-in panel.
 * STAFF-ONLY: it lists INTERNAL work too, with its visibility, because
 * the author decides what to write and must know what they are about to
 * publish. The ids of what was pulled in are frozen onto
 * `changesSinceLast` at publish, never rendered to a client.
 */
export type ChangesSinceLast = {
  readonly window: { readonly from: string; readonly to: string };
  readonly doneItems: readonly {
    readonly id: string;
    readonly key: string;
    readonly title: string;
    readonly visibility: "INTERNAL" | "CLIENT_VISIBLE";
  }[];
  readonly milestonesHit: readonly {
    readonly id: string;
    readonly name: string;
    readonly visibility: "INTERNAL" | "CLIENT_VISIBLE";
  }[];
  readonly versionsShipped: readonly { readonly id: string; readonly version: string; readonly title: string | null }[];
  readonly requestsReceived: readonly { readonly id: string; readonly key: string; readonly title: string }[];
};

/** The ids alone — what `ProjectUpdate.changesSinceLast` stores. */
export type ChangeIds = {
  readonly doneItemIds: readonly string[];
  readonly milestoneIds: readonly string[];
  readonly versionIds: readonly string[];
  readonly requestIds: readonly string[];
};

export const changeIdsOf = (c: ChangesSinceLast): ChangeIds => ({
  doneItemIds: c.doneItems.map((i) => i.id),
  milestoneIds: c.milestonesHit.map((m) => m.id),
  versionIds: c.versionsShipped.map((v) => v.id),
  requestIds: c.requestsReceived.map((r) => r.id),
});

/** The day after an ISO date, as an ISO date. */
const nextDay = (isoDate: string): string => {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/**
 * The window an update's "in period" figures cover.
 *
 * A stated period wins: the author's dates, as whole local days in the
 * tenant's zone (`startOfLocalDay`), the end day inclusive. Otherwise the
 * window runs from the previous published update — the day after its
 * period ended, or the moment it was published — to now; and for the
 * first update of a project, from the project's creation. That is what
 * "since the last update" means to a reader, and it is the same rule
 * whether the composer previews the numbers or publish freezes them.
 */
export function metricsWindowFor(
  input: {
    readonly periodStart: string | null;
    readonly periodEnd: string | null;
    readonly previous: { readonly periodEnd: string | null; readonly publishedAt: Date } | null;
    readonly projectCreatedAt: Date;
  },
  timeZone: string,
  now: Date = new Date(),
): MetricsWindow {
  const from = input.periodStart
    ? startOfLocalDay(input.periodStart, timeZone)
    : input.previous
      ? input.previous.periodEnd
        ? startOfLocalDay(nextDay(input.previous.periodEnd), timeZone)
        : input.previous.publishedAt
      : input.projectCreatedAt;
  const to = input.periodEnd ? startOfLocalDay(nextDay(input.periodEnd), timeZone) : now;
  return { from, to: to.getTime() > from.getTime() ? to : from };
}
