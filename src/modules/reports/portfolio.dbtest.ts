import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { dateColumn, localDateString } from "@/lib/duration";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";

import { readPortfolio, type PortfolioCtx, type PortfolioRow } from "./portfolio";

/**
 * THE PROJECT HEALTH TABLE AGAINST THE REAL SCHEMA (Phase 6 slice 116;
 * founder decision C92; docs/research/2026-10-13-slice-116-project-health-design.md §5).
 *
 * What only a database can say: who is refused (no code, no projects, the
 * reports module off); that the rows are the member's SCOPE — a scoped
 * member's client filter can never widen it; which post's health counts
 * (the newest PUBLISHED — never a draft or an archived post); that "late" is
 * the slice-102 rule over the post IT counts (a client-visible one while the
 * portal is on); the order C92 (c) asked for; the five exclusions of % done;
 * and the batched burn's windows (the period, the anchor, non-billable hours).
 *
 * Tenant slug prefix `pfo-` is registered in `DBTEST_PREFIXES`
 * (e2e/fixtures/seed-cli.ts) so `sweep-dbtests` collects orphans.
 */

const run = randomUUID().slice(0, 8);
const DAY = 86_400_000;
/** The schedule's clock: far enough past every schedule's start that one with no post is late. */
const T = new Date(Date.now() + 60 * DAY);

let f: Awaited<ReturnType<typeof setupTenant>>;
const acme = randomUUID();
const beta = randomUUID();
const P: Record<string, string> = {};
const states: Record<string, string> = {};
const extras: { userId: string; memberId: string; roleId: string }[] = [];
let scoped: PortfolioCtx;
let onOneProject: PortfolioCtx;
let tableOnly: PortfolioCtx;
let nextNumber = 1;
let seq = 0;

const ctxOf = (seat: "owner" | "admin" | "manager" | "employee"): PortfolioCtx => ({
  tenantId: f.tenantId,
  actor: f.seats[seat].actor,
});

const reason = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    if (e instanceof AuthzError) return e.reason;
    throw e;
  }
};

const names = (rows: readonly PortfolioRow[]) => rows.map((r) => r.name);
const byName = (rows: readonly PortfolioRow[], name: string) => rows.find((r) => r.name === name)!;

/** A member holding exactly `codes` through a custom role, assigned to a client or ONE project (scoped — no `client:view_all`). */
async function customMember(
  label: string,
  codes: readonly string[],
  on: { readonly clientId: string } | { readonly projectId: string },
): Promise<PortfolioCtx> {
  const userId = randomUUID();
  const email = `pfo-${label}-${run}@test.invalid`;
  await f.platform.user.create({ data: { id: userId, name: email, email } });
  const member = await f.platform.member.create({ data: { tenantId: f.tenantId, userId } });
  const role = await f.platform.role.create({ data: { tenantId: f.tenantId, name: `Portfolio ${label} ${run}` } });
  const perms = await f.platform.permission.findMany({ where: { code: { in: [...codes] } } });
  expect(perms).toHaveLength(codes.length);
  await f.platform.rolePermission.createMany({
    data: perms.map((p) => ({ tenantId: f.tenantId, roleId: role.id, permissionId: p.id })),
  });
  await f.platform.memberRole.create({ data: { tenantId: f.tenantId, memberId: member.id, roleId: role.id } });
  if ("clientId" in on) {
    await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: member.id, clientId: on.clientId } });
  } else {
    await f.platform.memberProject.create({ data: { tenantId: f.tenantId, memberId: member.id, projectId: on.projectId } });
  }
  extras.push({ userId, memberId: member.id, roleId: role.id });
  return { tenantId: f.tenantId, actor: actorFor(member.id) };
}

async function project(name: string, key: string, clientId: string, data: Record<string, unknown> = {}) {
  const id = randomUUID();
  P[name] = id;
  await f.platform.project.create({
    data: { id, tenantId: f.tenantId, clientId, key, name, status: "ACTIVE", ...data } as Parameters<
      typeof f.platform.project.create
    >[0]["data"],
  });
  let rank = 0;
  for (const category of ["BACKLOG", "TODO", "IN_PROGRESS", "DONE", "CANCELLED", "TRIAGE"] as const) {
    const stateId = randomUUID();
    states[`${name}:${category}`] = stateId;
    await f.platform.workflowState.create({
      data: {
        id: stateId,
        tenantId: f.tenantId,
        projectId: id,
        name: `${category}-${run}`,
        category,
        rank: `a${(rank++).toString().padStart(4, "0")}`,
        isDefault: category === "BACKLOG",
      },
    });
  }
}

/** A PUBLISHED post (or a draft / an archived one) planted directly. */
async function post(
  name: string,
  health: "ON_TRACK" | "AT_RISK" | "OFF_TRACK" | "ON_HOLD" | "COMPLETE",
  publishedAt: Date | null,
  opts: { status?: "DRAFT" | "PUBLISHED" | "ARCHIVED"; visibility?: "INTERNAL" | "CLIENT_VISIBLE" } = {},
) {
  const status = opts.status ?? "PUBLISHED";
  const clientId = (await f.platform.project.findFirstOrThrow({ where: { id: P[name]! }, select: { clientId: true } }))
    .clientId;
  await f.platform.projectUpdate.create({
    data: {
      tenantId: f.tenantId,
      clientId,
      projectId: P[name]!,
      seq: status === "DRAFT" ? null : ++seq,
      health,
      body: { sections: [], metrics: {} },
      bodyText: "planted",
      // Omitted on a draft: a Json `null` would be stored as JSON null, which is NOT NULL.
      ...(status === "DRAFT" ? {} : { portalSnapshot: {} }),
      status,
      visibility: opts.visibility ?? "INTERNAL",
      authorMemberId: f.seats.manager.memberId,
      publishedAt,
      publishedByMemberId: status === "DRAFT" ? null : f.seats.manager.memberId,
    } as Parameters<typeof f.platform.projectUpdate.create>[0]["data"],
  });
}

async function task(
  name: string,
  category: "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED" | "TRIAGE",
  opts: { type?: "EPIC" | "TASK" | "SUBTASK"; parentId?: string; archived?: boolean; deleted?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  const clientId = (await f.platform.project.findFirstOrThrow({ where: { id: P[name]! }, select: { clientId: true } }))
    .clientId;
  await f.platform.workItem.create({
    data: {
      id,
      tenantId: f.tenantId,
      clientId,
      projectId: P[name]!,
      number: nextNumber++,
      title: `Task ${nextNumber} ${run}`,
      type: opts.type ?? "TASK",
      stateId: states[`${name}:${category}`]!,
      stateCategory: category,
      ...(category === "TRIAGE" ? { triageStatus: "PENDING" } : {}),
      ...(category === "DONE" ? { completedAt: new Date() } : {}),
      rootId: opts.parentId ?? id,
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
      rank: `Zz${randomUUID().replace(/-/g, "")}1`,
      ...(opts.archived ? { archivedAt: new Date() } : {}),
      ...(opts.deleted ? { deletedAt: new Date() } : {}),
    } as Parameters<typeof f.platform.workItem.create>[0]["data"],
  });
  return id;
}

/** A closed entry of the owner's, `hours` long, on `localDate`. */
async function hours(name: string, h: number, localDate: string, billable: boolean, billRate = "1000") {
  const clientId = (await f.platform.project.findFirstOrThrow({ where: { id: P[name]! }, select: { clientId: true } }))
    .clientId;
  const startedAt = new Date(`${localDate}T08:00:00Z`);
  await f.platform.timeEntry.create({
    data: {
      tenantId: f.tenantId,
      clientId,
      projectId: P[name]!,
      memberId: f.seats.owner.memberId,
      startedAt,
      stoppedAt: new Date(startedAt.getTime() + h * 3_600_000),
      durationSeconds: Math.round(h * 3600),
      description: `Planted ${run}`,
      timezone: "Europe/Stockholm",
      localDate: dateColumn(localDate),
      entryMode: "MANUAL",
      source: "MANUAL",
      billable,
      // A non-billable hour carries no rate (`time_entry_billable_rate`).
      ...(billable ? { billRate } : {}),
      currency: "SEK",
    },
  });
}

beforeAll(async () => {
  f = await setupTenant("pfo");
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: `Acme ${run}` },
      { id: beta, tenantId: f.tenantId, name: `Beta ${run}` },
    ],
  });

  // Running (C92 (a)) — planned, active, paused.
  await project("Alpha", "PFA", acme);
  await project("Bravo", "PFB", beta, { billingCurrency: "SEK" });
  await project("Delta", "PFD", acme, { updateCadence: "WEEKLY", portalEnabled: false });
  await project("Echo", "PFE", beta, { status: "PLANNED" });
  await project("Foxtrot", "PFF", acme, { status: "PAUSED" });
  // Weekly with the portal ON: its only post is INTERNAL, so the schedule
  // has nothing the client can see and the update is LATE (C70 (g)). Named
  // to sort last, so its rank — not the alphabet — is what lifts it.
  await project("Kilo", "PFK", acme, { updateCadence: "WEEKLY", portalEnabled: true });
  // Finished — behind "Show finished".
  await project("Golf", "PFG", acme, { status: "COMPLETED" });
  await project("Hotel", "PFH", beta, { status: "ARCHIVED", archivedAt: new Date("2026-01-01T00:00:00Z") });

  // Alpha: the newest PUBLISHED post is Off track; a newer draft and a newer
  // ARCHIVED post must not count.
  await post("Alpha", "ON_TRACK", new Date(T.getTime() - 10 * DAY));
  await post("Alpha", "OFF_TRACK", new Date(T.getTime() - 5 * DAY));
  await post("Alpha", "AT_RISK", null, { status: "DRAFT" });
  await post("Alpha", "ON_TRACK", new Date(T.getTime() - 1 * DAY), { status: "ARCHIVED" });
  await post("Bravo", "AT_RISK", new Date(T.getTime() - 3 * DAY), { visibility: "CLIENT_VISIBLE" });
  // The same internal post a day before T: on Delta (portal off) it counts
  // and the next one is not due for days; on Kilo (portal on) it does not.
  await post("Delta", "ON_TRACK", new Date(T.getTime() - 1 * DAY));
  await post("Kilo", "ON_TRACK", new Date(T.getTime() - 1 * DAY));
  await post("Golf", "OFF_TRACK", new Date(T.getTime() - 30 * DAY));

  // Delta's tasks (C92 (b)): counted — a done task, an open one, a subtask in
  // progress, a done task put away; NOT counted — a done epic, a cancelled
  // task, a request nobody has accepted, an open task put away, a deleted one.
  const parent = await task("Delta", "DONE");
  await task("Delta", "TODO");
  await task("Delta", "IN_PROGRESS", { type: "SUBTASK", parentId: parent });
  await task("Delta", "DONE", { archived: true });
  await task("Delta", "DONE", { type: "EPIC" });
  await task("Delta", "CANCELLED");
  await task("Delta", "TRIAGE");
  await task("Delta", "TODO", { archived: true });
  await task("Delta", "DONE", { deleted: true });

  // Budgets: Delta 10 h for the whole project (2 billable hours count, the
  // non-billable hour does not); Bravo 1 000 kr, 1.5 h at 1 000 kr — over;
  // Foxtrot 4 h a MONTH (this month's hour counts, last month's three do not);
  // Echo 10 h from an ANCHOR, non-billable hours included (the day before
  // the anchor does not count; the anchor's billable hour and the next day's
  // non-billable one do).
  const today = localDateString(new Date(), "Europe/Stockholm");
  const lastMonth = localDateString(new Date(Date.now() - 40 * DAY), "Europe/Stockholm");
  await f.platform.projectBudget.createMany({
    data: [
      { tenantId: f.tenantId, clientId: acme, projectId: P["Delta"]!, kind: "HOURS", amount: "10", period: "NONE" },
      { tenantId: f.tenantId, clientId: beta, projectId: P["Bravo"]!, kind: "MONEY", amount: "1000", currency: "SEK", period: "NONE" },
      { tenantId: f.tenantId, clientId: acme, projectId: P["Foxtrot"]!, kind: "HOURS", amount: "4", period: "MONTHLY", periodAnchor: dateColumn("2026-01-01") },
      {
        tenantId: f.tenantId,
        clientId: beta,
        projectId: P["Echo"]!,
        kind: "HOURS",
        amount: "10",
        period: "NONE",
        periodAnchor: dateColumn("2026-06-15"),
        includeNonBillable: true,
      },
    ],
  });
  await hours("Delta", 2, today, true);
  await hours("Delta", 1, today, false);
  await hours("Bravo", 1.5, today, true);
  await hours("Foxtrot", 1, today, true);
  await hours("Foxtrot", 3, lastMonth, true);
  await hours("Echo", 2, "2026-06-14", true);
  await hours("Echo", 1, "2026-06-15", true);
  await hours("Echo", 1, "2026-06-16", false);

  // A member kept to Acme holding the table and projects, nothing else.
  scoped = await customMember("scoped", ["report:view_portfolio", "project:view"], { clientId: acme });
  // The same codes, assigned to ONE project of Acme's (the scope's other branch).
  onOneProject = await customMember("oneproject", ["report:view_portfolio", "project:view"], { projectId: P["Delta"]! });
  // A member holding the table but not projects.
  tableOnly = await customMember("tableonly", ["report:view_portfolio"], { clientId: acme });
}, 120_000);

afterAll(async () => {
  if (!f) return;
  const where = { where: { tenantId: f.tenantId } };
  await f.platform.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.work_maintenance', 'on', true)`;
    await tx.projectUpdate.deleteMany(where);
  });
  await f.platform.timeEntry.deleteMany(where);
  await f.platform.projectBudget.deleteMany(where);
  await f.platform.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${f.tenantId}`;
  await f.platform.workItemActivity.deleteMany(where);
  await f.platform.workItem.deleteMany({ where: { tenantId: f.tenantId, parentId: { not: null } } });
  await f.platform.workItem.deleteMany(where);
  await f.platform.workflowState.deleteMany(where);
  await f.platform.projectUpdateReminderSent.deleteMany(where);
  await f.platform.memberClient.deleteMany(where);
  await f.platform.memberProject.deleteMany(where);
  for (const e of extras) {
    await f.platform.memberRole.deleteMany({ where: { tenantId: f.tenantId, memberId: e.memberId } });
    await f.platform.rolePermission.deleteMany({ where: { tenantId: f.tenantId, roleId: e.roleId } });
    await f.platform.role.deleteMany({ where: { tenantId: f.tenantId, id: e.roleId } });
    await f.platform.member.deleteMany({ where: { tenantId: f.tenantId, id: e.memberId } });
    await f.platform.user.deleteMany({ where: { id: e.userId } });
  }
  await f.platform.project.deleteMany(where);
  await f.platform.client.deleteMany(where);
  await f.platform.tenantPreference.deleteMany(where);
  await f.cleanup();
}, 60_000);

describe("who may read the table", () => {
  it("refuses a member without the code — the admin and the employee by default", async () => {
    expect(await reason(readPortfolio(ctxOf("employee")))).toBe("FORBIDDEN");
    expect(await reason(readPortfolio(ctxOf("admin")))).toBe("FORBIDDEN");
    expect(await reason(readPortfolio(ctxOf("manager")))).toBe("resolved");
  });

  it("refuses a role holding the table but not projects", async () => {
    expect(await reason(readPortfolio(tableOnly))).toBe("FORBIDDEN");
  });

  it("closes with the reports module", async () => {
    await f.platform.tenantPreference.create({ data: { tenantId: f.tenantId, key: "module.reports.enabled", value: false } });
    try {
      expect(await reason(readPortfolio(ctxOf("owner")))).toBe("DISABLED_BY_TENANT");
    } finally {
      await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId, key: "module.reports.enabled" } });
    }
  });
});

describe("the rows and their order (C92 (a), (c))", () => {
  it("lists running projects, most worrying first: off track, at risk, a late update, then client and name", async () => {
    const p = await readPortfolio(ctxOf("owner"), {}, T);
    expect(names(p.rows)).toEqual(["Alpha", "Bravo", "Kilo", "Delta", "Foxtrot", "Echo"]);
    expect(p.show).toEqual({ updates: true, tasks: true, budget: true });
    expect(p.clients.map((c) => c.id)).toEqual([acme, beta]);
    expect(p.capped).toBe(false);
    expect(p.rows.every((r) => r.running)).toBe(true);
  });

  it("takes health from the newest PUBLISHED post — never a draft or an archived one", async () => {
    const p = await readPortfolio(ctxOf("owner"), {}, T);
    const alpha = byName(p.rows, "Alpha");
    expect(alpha.health).toBe("OFF_TRACK");
    expect(alpha.lastUpdateAt?.getTime()).toBe(T.getTime() - 5 * DAY);
    expect(byName(p.rows, "Echo").health).toBeNull();
    expect(byName(p.rows, "Echo").lastUpdateAt).toBeNull();
  });

  it("is late by the slice-102 rule over the post IT counts: with the portal on, only one the client can see", async () => {
    const p = await readPortfolio(ctxOf("owner"), {}, T);
    expect(byName(p.rows, "Kilo").schedule?.state).toBe("late");
    expect(byName(p.rows, "Delta").schedule?.state).toBe("scheduled");
    // No cadence, or not active: no schedule at all.
    expect(byName(p.rows, "Alpha").schedule).toBeNull();
    expect(byName(p.rows, "Foxtrot").schedule).toBeNull();
  });

  it("appends the finished ones after every running one when asked", async () => {
    const p = await readPortfolio(ctxOf("owner"), { finished: true }, T);
    expect(names(p.rows)).toEqual(["Alpha", "Bravo", "Kilo", "Delta", "Foxtrot", "Echo", "Golf", "Hotel"]);
    expect(byName(p.rows, "Golf")).toMatchObject({ running: false, health: "OFF_TRACK" });
    expect(byName(p.rows, "Hotel").running).toBe(false);
  });

  it("filters to one client, keeps both in the options, and ignores a client it does not span", async () => {
    const one = await readPortfolio(ctxOf("owner"), { clientId: beta }, T);
    expect(names(one.rows)).toEqual(["Bravo", "Echo"]);
    expect(one.clients.map((c) => c.id)).toEqual([acme, beta]);
    const bogus = await readPortfolio(ctxOf("owner"), { clientId: randomUUID() }, T);
    expect(bogus.rows).toHaveLength(6);
  });
});

describe("scope and the columns' own codes", () => {
  it("shows a scoped member their clients' projects only — and a filter naming another client never widens it", async () => {
    const own = await readPortfolio(scoped, {}, T);
    expect(names(own.rows)).toEqual(["Alpha", "Delta", "Foxtrot", "Kilo"]);
    expect(own.clients.map((c) => c.id)).toEqual([acme]);
    const widened = await readPortfolio(scoped, { clientId: beta, finished: true }, T);
    expect(widened.rows.every((r) => r.clientId === acme)).toBe(true);
    expect(names(widened.rows)).toContain("Golf");
  });

  it("shows a member assigned to ONE project that project alone — its client's other projects never, filtered or not", async () => {
    const own = await readPortfolio(onOneProject, { finished: true }, T);
    expect(names(own.rows)).toEqual(["Delta"]);
    expect(own.clients.map((c) => c.id)).toEqual([acme]);
    const filtered = await readPortfolio(onOneProject, { clientId: acme, finished: true }, T);
    expect(names(filtered.rows)).toEqual(["Delta"]);
  });

  it("draws no last update, schedule, tasks or budget for a member without their codes — and an unseen late update moves no row", async () => {
    const p = await readPortfolio(scoped, {}, T);
    expect(p.show).toEqual({ updates: false, tasks: false, budget: false });
    expect(
      p.rows.every((r) => r.lastUpdateAt === null && r.schedule === null && r.tasks === null && r.budget === null),
    ).toBe(true);
    // Kilo is late, but this member cannot see it, so it sorts by name: last.
    expect(names(p.rows).at(-1)).toBe("Kilo");
    // Health is the project page's: anyone who can open the project sees it.
    expect(byName(p.rows, "Alpha").health).toBe("OFF_TRACK");
  });

  it("never carries a cost", async () => {
    const p = await readPortfolio(ctxOf("owner"), { finished: true }, T);
    expect(JSON.stringify(p).toLowerCase()).not.toContain("cost");
  });
});

describe("% done (C92 (b)) and the budget", () => {
  it("counts tasks and subtasks, done ones put away included — never an epic, a cancelled task, an unaccepted request, an open task put away or a deleted one", async () => {
    const p = await readPortfolio(ctxOf("owner"));
    expect(byName(p.rows, "Delta").tasks).toEqual({ done: 2, total: 4 });
    expect(byName(p.rows, "Echo").tasks).toEqual({ done: 0, total: 0 });
  });

  it("shows each ACTIVE budget's burn in its own window: the whole project, a month, from an anchor, with non-billable hours or without", async () => {
    const p = await readPortfolio(ctxOf("owner"));
    expect(byName(p.rows, "Delta").budget).toEqual({ percent: 20 });
    expect(byName(p.rows, "Bravo").budget).toEqual({ percent: 150 });
    expect(byName(p.rows, "Foxtrot").budget).toEqual({ percent: 25 });
    expect(byName(p.rows, "Echo").budget).toEqual({ percent: 20 });
    expect(byName(p.rows, "Alpha").budget).toBeNull();
  });
});
