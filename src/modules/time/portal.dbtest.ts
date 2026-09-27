import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { setupTenant } from "@/members/dbtest-fixture";
import { changeItemVisibility, createItem } from "@/modules/work";
import { resolvePortalModuleGates, type PortalPrincipal } from "@/portal";
import { setHoursSharingMode } from "@/projects/service";

import {
  acknowledgeNotice,
  archiveBudget,
  createBudget,
  createEntry,
  createRateCard,
  generateReport,
  getNoticeStatus,
  publishReport,
  resetTimeDefaultsMemo,
  unpublishReport,
} from "./index";
import { readPortalHours } from "./portal";

/**
 * THE HOURS & RETAINER WIDGET AGAINST THE REAL SCHEMA (Phase 3; UI.md
 * §4 item 7; DATA_MODEL §6.15): `project_time_summary` and `time_report`
 * read under a real contact principal, so `portal_gate` decides every
 * row before this code has an opinion.
 *
 * WHAT ONLY A DATABASE CAN SAY: that the three-term gate on the summary
 * hands a contact a month row only while the project shares hours
 * (the visibility is trigger-derived from the mode), that the amount
 * columns are NULL at the database outside BILLABLE_AMOUNT (so a
 * projection bug could not print them), that the four-term gate on
 * `time_report` keeps a draft and an unpublished report out, that a
 * switched-off or another client's project is unreachable rather than
 * filtered, and that the archive term — which the policies do not carry
 * — empties an archived project's widget.
 *
 * THE CENTRAL ASSERTION IS THE SENTINEL WALK, as in every portal
 * dbtest: every fact a client must never read is planted as a string
 * or a number that appears nowhere else — the INTERNAL task's title
 * (folded into "Other work" at generation), the draft report, the
 * unpublished report, the reports and rows of a switched-off project,
 * an archived project and another client's project — and the
 * serialised projection is searched for each.
 *
 * Tenant slug prefix `phrs-` is registered in `DBTEST_PREFIXES`
 * (e2e/fixtures/seed-cli.ts) so `sweep-dbtests` collects orphans.
 */

const run = randomUUID().slice(0, 8);

let f: Awaited<ReturnType<typeof setupTenant>>;
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;
let acme: string;
let beta: string;
let pOn: string;
let pOff: string;
let pArchived: string;
let pBeta: string;
let carol: string;
let dan: string;
let bo: string;
let sue: string;
let sharedTaskId: string;

/** Strings a contact IS meant to read. */
const SHOWN = {
  sharedTask: `Build the header ${run}`,
  report: `July and August ${run}`,
} as const;

/** Strings and figures that exist nowhere but on rows a contact must never reach. */
const S = {
  internalTask: `SENTINELINTERNALTASK-${run}`,
  draftReport: `SENTINELDRAFTREPORT-${run}`,
  unpublishedReport: `SENTINELUNPUBLISHED-${run}`,
  offReport: `SENTINELOFFREPORT-${run}`,
  archivedReport: `SENTINELARCHIVEDREPORT-${run}`,
  betaReport: `SENTINELBETAREPORT-${run}`,
  /** Planted summary rows on the unreachable projects carry this many seconds — a figure no real entry writes. */
  plantedSeconds: "777777",
} as const;

/** The reader's clock: August 2026, so "this month" is a fact and not a race. */
const CLOCK = { now: new Date("2026-08-20T12:00:00Z"), timeZone: "UTC" } as const;

const ctxOf = (seat: "owner" | "employee") => ({ tenantId: f.tenantId, actor: f.seats[seat].actor });

const principal = (contactId: string, clientId = acme): PortalPrincipal => ({
  contactId,
  tenantId: f.tenantId,
  clientId,
  gates,
});

const authzReason = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    if (e instanceof AuthzError) return e.reason;
    throw e;
  }
};

/** Every sentinel, checked against a serialised projection. */
const expectNoSentinel = (value: unknown) => {
  const json = JSON.stringify(value);
  for (const [name, sentinel] of Object.entries(S)) {
    expect(json, `sentinel ${name} leaked`).not.toContain(sentinel);
  }
  // The names a portal projection may never carry (the tripwire in
  // `portal-projections.test.ts` holds the full list; these are the
  // ones a TIME projection could plausibly reach for).
  for (const key of ["memberId", "billRate", "cost", "costRateCardId", "createdByMemberId", "publishedByMemberId", "internalNotes"]) {
    expect(json, `forbidden key ${key} leaked`).not.toContain(`"${key}"`);
  }
};

beforeAll(async () => {
  resetTimeDefaultsMemo();
  f = await setupTenant("phrs");
  gates = await resolvePortalModuleGates(f.tenantId);
  acme = randomUUID();
  beta = randomUUID();
  pOn = randomUUID();
  pOff = randomUUID();
  pArchived = randomUUID();
  pBeta = randomUUID();
  carol = randomUUID();
  dan = randomUUID();
  bo = randomUUID();
  sue = randomUUID();
  const up = run.slice(0, 3).toUpperCase();

  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: `Acme ${run}` },
      { id: beta, tenantId: f.tenantId, name: `Beta ${run}` },
    ],
  });
  // Every project shares hours from the start, so the planted rows on
  // the unreachable three are CLIENT_VISIBLE by trigger: what keeps them
  // out is the gate's client term, the portal switch and the archive
  // term — never the mode.
  await f.platform.project.createMany({
    data: [
      { id: pOn, tenantId: f.tenantId, clientId: acme, key: `PHR${up}`, name: `Site ${run}`, portalEnabled: true, billingCurrency: "SEK", hoursSharingMode: "HOURS" },
      { id: pOff, tenantId: f.tenantId, clientId: acme, key: `PHO${up}`, name: `Off ${run}`, portalEnabled: false, billingCurrency: "SEK", hoursSharingMode: "HOURS" },
      {
        id: pArchived,
        tenantId: f.tenantId,
        clientId: acme,
        key: `PHA${up}`,
        name: `Archived ${run}`,
        portalEnabled: true,
        billingCurrency: "SEK",
        hoursSharingMode: "HOURS",
        status: "ARCHIVED",
        archivedAt: new Date("2026-01-01T00:00:00Z"),
      },
      { id: pBeta, tenantId: f.tenantId, clientId: beta, key: `PHB${up}`, name: `Beta site ${run}`, portalEnabled: true, billingCurrency: "SEK", hoursSharingMode: "HOURS" },
    ],
  });
  const invitedAt = new Date("2026-09-01T09:00:00Z");
  await f.platform.contact.createMany({
    data: [
      { id: carol, tenantId: f.tenantId, clientId: acme, name: "Carol", email: `phrs-carol-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt, emailVerified: true },
      { id: dan, tenantId: f.tenantId, clientId: acme, name: "Dan", email: `phrs-dan-${run}@test.invalid`, portalProfile: "CONTACT_COLLABORATOR", portalStatus: "ACTIVE", invitedAt, emailVerified: true },
      { id: bo, tenantId: f.tenantId, clientId: beta, name: "Bo", email: `phrs-bo-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt, emailVerified: true },
      { id: sue, tenantId: f.tenantId, clientId: acme, name: "Sue", email: `phrs-sue-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "SUSPENDED", invitedAt, emailVerified: true },
    ],
  });

  // ── The time, through the real services ────────────────────────────
  const owner = ctxOf("owner");
  const status = await getNoticeStatus(owner);
  await acknowledgeNotice(owner, status.notice!.id);
  await createRateCard(owner, { kind: "BILL", scope: "TENANT", amount: "1000", currency: "SEK", effectiveFrom: "2026-01-01" });
  sharedTaskId = (await createItem(owner, { projectId: pOn, title: SHOWN.sharedTask })).id;
  await changeItemVisibility(owner, sharedTaskId, "CLIENT_VISIBLE");
  const internalTaskId = (await createItem(owner, { projectId: pOn, title: S.internalTask })).id;
  // July: 2 h on the shared task. August: 3 h on the shared task, 1 h on
  // the INTERNAL task, 30 min non-billable on the project.
  await createEntry(owner, { workItemId: sharedTaskId, durationText: "2h", localDate: "2026-07-15", billable: true });
  await createEntry(owner, { workItemId: sharedTaskId, durationText: "3h", localDate: "2026-08-10", billable: true });
  await createEntry(owner, { workItemId: internalTaskId, durationText: "1h", localDate: "2026-08-12", billable: true });
  await createEntry(owner, { projectId: pOn, durationText: "30m", localDate: "2026-08-14", billable: false, description: "Planning" });

  // ── The reports ────────────────────────────────────────────────────
  const published = await generateReport(owner, {
    projectId: pOn,
    title: SHOWN.report,
    periodStart: "2026-07-01",
    periodEnd: "2026-08-31",
    groupBy: "WORK_ITEM",
    includeAmounts: true,
  });
  await publishReport(owner, published.id);
  await generateReport(owner, { projectId: pOn, title: S.draftReport, periodStart: "2026-07-01", periodEnd: "2026-07-31" });
  const unpublished = await generateReport(owner, { projectId: pOn, title: S.unpublishedReport, periodStart: "2026-08-01", periodEnd: "2026-08-31" });
  await publishReport(owner, unpublished.id);
  await unpublishReport(owner, unpublished.id);

  // ── Rows the gate must keep out of reach ───────────────────────────
  // Planted directly: `createEntry` refuses an archived project, and
  // these exist only to be NOT read. Each summary row carries a figure
  // no real entry writes; each report a sentinel title.
  const month = new Date("2026-08-01T00:00:00Z");
  const planted = Number(S.plantedSeconds);
  await f.platform.projectTimeSummary.createMany({
    data: [
      { tenantId: f.tenantId, clientId: acme, projectId: pOff, periodMonth: month, billableSeconds: planted },
      { tenantId: f.tenantId, clientId: acme, projectId: pArchived, periodMonth: month, billableSeconds: planted },
      { tenantId: f.tenantId, clientId: beta, projectId: pBeta, periodMonth: month, billableSeconds: planted },
    ],
  });
  const snapshot = { version: 1, groupBy: "DAY", period: { start: "2026-08-01", end: "2026-08-31" }, currency: "SEK", includeAmounts: false, includeNonBillable: false, lines: [], totals: { seconds: 0, billableSeconds: 0 } };
  const report = (projectId: string, clientId: string, title: string) => ({
    tenantId: f.tenantId,
    clientId,
    projectId,
    title,
    periodStart: month,
    periodEnd: new Date("2026-08-31T00:00:00Z"),
    snapshot,
    status: "PUBLISHED" as const,
    visibility: "CLIENT_VISIBLE" as const,
    publishedAt: new Date(),
  });
  await f.platform.timeReport.createMany({
    data: [report(pOff, acme, S.offReport), report(pArchived, acme, S.archivedReport), report(pBeta, beta, S.betaReport)],
  });
}, 120_000);

afterAll(async () => {
  if (!f) return;
  const db = f.platform;
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.time_maintenance', 'on', true)`;
    await tx.$executeRaw`SELECT set_config('app.time_lock_bypass', 'on', true)`;
    await tx.timeReport.deleteMany({ where: { tenantId: f.tenantId } });
    await tx.timeEntry.deleteMany({ where: { tenantId: f.tenantId } });
    await tx.budgetAlert.deleteMany({ where: { tenantId: f.tenantId } });
    await tx.projectBudget.deleteMany({ where: { tenantId: f.tenantId } });
    await tx.rateCard.deleteMany({ where: { tenantId: f.tenantId } });
    await tx.projectTimeSummary.deleteMany({ where: { tenantId: f.tenantId } });
    await tx.staffNoticeAcknowledgment.deleteMany({ where: { tenantId: f.tenantId } });
    await tx.staffNotice.deleteMany({ where: { tenantId: f.tenantId } });
    await tx.workType.deleteMany({ where: { tenantId: f.tenantId } });
  });
  await db.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${f.tenantId}`;
  await db.notification.deleteMany({ where: { tenantId: f.tenantId } });
  await db.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItem.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  await db.contact.deleteMany({ where: { tenantId: f.tenantId } });
  await db.project.deleteMany({ where: { tenantId: f.tenantId } });
  await db.client.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  resetTimeDefaultsMemo();
  await f.cleanup();
}, 60_000);

describe("the live widget", () => {
  it("is the project's months, summed, with no amount while the project shares hours only", async () => {
    const { live, reports } = await readPortalHours(principal(carol), pOn, CLOCK);
    expect(live).not.toBeNull();
    expect(live!.mode).toBe("HOURS");
    expect(live!.currency).toBe("SEK");
    // August: 3 h + 1 h billable, 30 min not; July: 2 h.
    expect(live!.thisMonth).toEqual({ month: "2026-08", seconds: 4.5 * 3600, billableSeconds: 4 * 3600, amount: null });
    expect(live!.toDate).toEqual({ seconds: 6.5 * 3600, billableSeconds: 6 * 3600, amount: null });
    expect(live!.months.map((m) => m.month)).toEqual(["2026-08", "2026-07"]);
    expect(live!.months[1]).toEqual({ month: "2026-07", seconds: 2 * 3600, billableSeconds: 2 * 3600, amount: null });
    expect(live!.budgetSeconds).toBeNull();
    expect(live!.budgetAmount).toBeNull();
    expect(live!.truncated).toBe(false);
    // The report is asserted below; here only that it is the one.
    expect(reports.map((r) => r.title)).toEqual([SHOWN.report]);
    expectNoSentinel({ live, reports });
    // The contract, pinned: a key added to any of these shapes is a
    // decision a reviewer meets here.
    expect(Object.keys(live!).sort()).toEqual(
      ["budgetAmount", "budgetSeconds", "currency", "mode", "months", "thisMonth", "toDate", "truncated"],
    );
    expect(Object.keys(live!.thisMonth).sort()).toEqual(["amount", "billableSeconds", "month", "seconds"]);
  });

  it("reads 'this month' off the reader's clock, and answers zeros for a month nobody logged", async () => {
    const { live } = await readPortalHours(principal(carol), pOn, { now: new Date("2026-09-03T12:00:00Z"), timeZone: "UTC" });
    expect(live!.thisMonth).toEqual({ month: "2026-09", seconds: 0, billableSeconds: 0, amount: null });
    // The zone moves the month at the boundary: 23:30 UTC on 31 July is
    // already August in Stockholm.
    const stockholm = await readPortalHours(principal(carol), pOn, { now: new Date("2026-07-31T23:30:00Z"), timeZone: "Europe/Stockholm" });
    expect(stockholm.live!.thisMonth.month).toBe("2026-08");
    const utc = await readPortalHours(principal(carol), pOn, { now: new Date("2026-07-31T23:30:00Z"), timeZone: "UTC" });
    expect(utc.live!.thisMonth.month).toBe("2026-07");
  });

  it("shares the hours budget in any mode but NONE, and the money budget and the amounts only in BILLABLE_AMOUNT", async () => {
    const owner = ctxOf("owner");
    const hoursBudget = await createBudget(owner, { projectId: pOn, kind: "HOURS", amount: "40" });
    let { live } = await readPortalHours(principal(carol), pOn, CLOCK);
    expect(live!.budgetSeconds).toBe(40 * 3600);
    expect(live!.budgetAmount).toBeNull();
    expect(live!.thisMonth.amount).toBeNull();

    // The switch to amounts: money appears on every figure, without an
    // entry write (the fan-out trigger re-derives the columns).
    await setHoursSharingMode(owner, pOn, "BILLABLE_AMOUNT");
    ({ live } = await readPortalHours(principal(carol), pOn, CLOCK));
    expect(live!.mode).toBe("BILLABLE_AMOUNT");
    // 4 billable hours × 1000 SEK this month; 6 to date; 2 in July.
    expect(live!.thisMonth.amount).toBe("4000.00");
    expect(live!.toDate.amount).toBe("6000.00");
    expect(live!.months.find((m) => m.month === "2026-07")?.amount).toBe("2000.00");
    expect(live!.budgetSeconds).toBe(40 * 3600);
    expect(live!.budgetAmount).toBeNull(); // an HOURS budget has no money figure

    // A MONEY budget replaces it (one ACTIVE per project): the money
    // figure is shared, the hours figure is gone with the budget.
    const moneyBudget = await createBudget(owner, { projectId: pOn, kind: "MONEY", amount: "50000", currency: "SEK" });
    ({ live } = await readPortalHours(principal(carol), pOn, CLOCK));
    expect(live!.budgetSeconds).toBeNull();
    expect(live!.budgetAmount).toBe("50000.00");

    // Back to HOURS: the money budget is nulled AT THE DATABASE, the
    // amounts with it — and the projection says so without an if of
    // its own being the only thing in the way.
    await setHoursSharingMode(owner, pOn, "HOURS");
    ({ live } = await readPortalHours(principal(carol), pOn, CLOCK));
    expect(live!.budgetAmount).toBeNull();
    expect(live!.thisMonth.amount).toBeNull();
    expect(live!.toDate.amount).toBeNull();
    await archiveBudget(owner, moneyBudget.id);
    void hoursBudget;
  });

  it("a budget set before the first entry reaches the client: createBudget upserts the month row the figure rides on", async () => {
    const owner = ctxOf("owner");
    const fresh = randomUUID();
    await f.platform.project.create({
      data: {
        id: fresh,
        tenantId: f.tenantId,
        clientId: acme,
        key: `PHN${run.slice(0, 3).toUpperCase()}`,
        name: `Fresh ${run}`,
        portalEnabled: true,
        billingCurrency: "SEK",
        hoursSharingMode: "HOURS",
      },
    });
    const budget = await createBudget(owner, { projectId: fresh, kind: "HOURS", amount: "20" });
    const { live } = await readPortalHours(principal(carol), fresh, CLOCK);
    expect(live).not.toBeNull();
    expect(live!.budgetSeconds).toBe(20 * 3600);
    // The zero row is the budget's vehicle, not a month worth listing.
    expect(live!.months).toEqual([]);
    expect(live!.toDate.seconds).toBe(0);
    await archiveBudget(owner, budget.id);
  });

  it("is null while the project shares nothing — and the rows are unreadable, not merely unread", async () => {
    const owner = ctxOf("owner");
    await setHoursSharingMode(owner, pOn, "NONE");
    const { live, reports } = await readPortalHours(principal(carol), pOn, CLOCK);
    expect(live).toBeNull();
    // The published report stands: its gate has no hours-mode term, and
    // a report is a member's explicit act (DATA_MODEL §6.15 D3).
    expect(reports.map((r) => r.title)).toEqual([SHOWN.report]);
    await setHoursSharingMode(owner, pOn, "HOURS");
  });
});

describe("the published reports", () => {
  it("is the PUBLISHED, CLIENT_VISIBLE report with its lines — the INTERNAL task folded, the draft and the unpublished absent", async () => {
    const { reports } = await readPortalHours(principal(carol), pOn, CLOCK);
    expect(reports).toHaveLength(1);
    const r = reports[0]!;
    expect(r.title).toBe(SHOWN.report);
    expect(r.groupBy).toBe("WORK_ITEM");
    expect(r.periodStart.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(r.periodEnd.toISOString()).toBe("2026-08-31T00:00:00.000Z");
    // Billable only (the generator's default): 2 + 3 + 1 hours.
    expect(r.totalSeconds).toBe(6 * 3600);
    expect(r.billableSeconds).toBe(6 * 3600);
    expect(r.billableAmount).toBe("6000.00");
    expect(r.currency).toBe("SEK");
    // The shared task by name, the INTERNAL one as "other" with no label.
    const kinds = r.snapshot.lines.map((l) => l.kind).sort();
    expect(kinds).toEqual(["other", "work_item"]);
    const shared = r.snapshot.lines.find((l) => l.kind === "work_item");
    expect(shared && "label" in shared ? shared.label : null).toBe(SHOWN.sharedTask);
    const other = r.snapshot.lines.find((l) => l.kind === "other");
    expect(other?.seconds).toBe(3600);
    expect(Object.keys(r).sort()).toEqual(
      ["billableAmount", "billableSeconds", "currency", "groupBy", "id", "periodEnd", "periodStart", "publishedAt", "snapshot", "title", "totalSeconds"],
    );
    expectNoSentinel(reports);
  });

  it("a report generated without amounts carries none, whatever the project shares", async () => {
    const owner = ctxOf("owner");
    await setHoursSharingMode(owner, pOn, "BILLABLE_AMOUNT");
    const plain = await generateReport(owner, { projectId: pOn, title: `Plain ${run}`, periodStart: "2026-07-01", periodEnd: "2026-07-31" });
    await publishReport(owner, plain.id);
    const { reports } = await readPortalHours(principal(carol), pOn, CLOCK);
    const found = reports.find((r) => r.id === plain.id);
    expect(found?.billableAmount).toBeNull();
    expect(found?.snapshot.includeAmounts).toBe(false);
    expect(JSON.stringify(found?.snapshot.lines)).not.toContain('"amount"');
    await setHoursSharingMode(owner, pOn, "HOURS");
  });
});

describe("who may read it, and what they cannot", () => {
  it("a COLLABORATOR gets an EMPTY answer — the capability is PRIMARY only, because the figures are money, and the projection decides it rather than the page logging a denial per visit", async () => {
    expect(await readPortalHours(principal(dan), pOn, CLOCK)).toEqual({ live: null, reports: [], reportsTruncated: false });
    // …while the same collaborator on a project that is not theirs is
    // still REFUSED: the project ref is asked of the capability every
    // profile holds, before the hours capability is asked at all.
    expect(await authzReason(readPortalHours(principal(dan), pOff, CLOCK))).toBe("NOT_FOUND");
  });

  it("another client's contact, a switched-off project and a suspended contact are refused; an archived project is empty", async () => {
    expect(await authzReason(readPortalHours(principal(bo, beta), pOn, CLOCK))).toBe("NOT_FOUND");
    expect(await authzReason(readPortalHours(principal(carol), pOff, CLOCK))).toBe("NOT_FOUND");
    expect(await authzReason(readPortalHours(principal(sue), pOn, CLOCK))).toBe("FORBIDDEN");
    // Portal ON and ARCHIVED: reachable through the gate, empty by the
    // projection's own term — the widget and the reports both.
    const archived = await readPortalHours(principal(carol), pArchived, CLOCK);
    expect(archived).toEqual({ live: null, reports: [], reportsTruncated: false });
  });

  it("a contact of the other client reads their own project and nothing of Acme's", async () => {
    const theirs = await readPortalHours(principal(bo, beta), pBeta, CLOCK);
    expect(theirs.live?.toDate.seconds).toBe(Number(S.plantedSeconds));
    expect(theirs.reports.map((r) => r.title)).toEqual([S.betaReport]);
    // …and Acme's reader never sees the planted figures or titles, on
    // any project they can name.
    const mine = await readPortalHours(principal(carol), pOn, CLOCK);
    expectNoSentinel(mine);
  });

  it("a principal claiming another client's scope reads nothing of it", async () => {
    // Carol's contact row belongs to Acme; a principal that names Beta's
    // client id with Carol's contact id is refused before any row.
    expect(await authzReason(readPortalHours(principal(carol, beta), pBeta, CLOCK))).not.toBe("resolved");
  });
});
