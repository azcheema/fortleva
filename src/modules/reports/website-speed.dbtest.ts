import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { parseEntitlements } from "@/entitlements/resolver";
import { fakeCrux } from "@/integrations/crux/fake";
import { resolvePortalModuleGates, type PortalPrincipal } from "@/portal";
import { setPortalEnabled, setSpeedShared, type ProjectCtx } from "@/projects/service";

import { countPortalWebsiteSpeed, listPortalWebsiteSpeed } from "./portal";
import { readWebsiteSpeed } from "./speed";
import { fetchWebsiteSpeed, REFRESH_AFTER_MS } from "./speed-fetch";

/**
 * THE WEBSITE SPEED CHARTS AGAINST THE REAL SCHEMA (Phase 6 slice 118;
 * founder decision C94; docs/research/2026-10-14-slice-118-website-speed-design.md §8).
 *
 * What only a database can say: that the weekly fetch writes Google's weeks
 * INTERNAL and dedupes them; what each of Google's answers leaves in the
 * check row; the CHECKs that hold a row's shape; that the "Show to the
 * client" switch DERIVES every row's visibility (a direct write overwritten,
 * a later row born with the switch's value); that a contact reads a row only
 * with the switch AND the project's portal on, never another client's, and
 * never rows of a previous origin; the module gates; scope; and the race the
 * job's `FOR SHARE` closes, in both orders.
 *
 * Tenant slug prefix `wspd-` is registered in `DBTEST_PREFIXES`
 * (e2e/fixtures/seed-cli.ts) so `sweep-dbtests` collects orphans.
 */

const run = randomUUID().slice(0, 8);

let f: Awaited<ReturnType<typeof setupTenant>>;
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;
const acme = randomUUID();
const beta = randomUUID();
const carol = randomUUID(); // Acme, main contact
const bo = randomUUID(); // Beta, main contact
const P: Record<string, string> = {};
const extras: { userId: string; memberId: string; roleId: string }[] = [];

const owner = (): ProjectCtx => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const employee = (): ProjectCtx => ({ tenantId: f.tenantId, actor: f.seats.employee.actor });
const principal = (contactId: string, clientId = acme): PortalPrincipal => ({ contactId, tenantId: f.tenantId, clientId, gates });

const reason = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    if (e instanceof AuthzError) return e.reason;
    throw e;
  }
};

/** The error's META — a constraint's name lives there (the code-frame trap). */
const meta = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return JSON.stringify((e as { meta?: unknown })?.meta ?? null);
  }
};

async function project(name: string, clientId: string, data: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  P[name] = id;
  await f.platform.project.create({
    data: { id, tenantId: f.tenantId, clientId, key: `W${Object.keys(P).length}${run.slice(0, 2).toUpperCase()}`, name: `${name} ${run}`, status: "ACTIVE", ...data } as Parameters<
      typeof f.platform.project.create
    >[0]["data"],
    select: { id: true },
  });
  return id;
}

const weeksOf = (projectId: string) =>
  f.platform.websiteSpeedWeek.findMany({
    where: { tenantId: f.tenantId, projectId },
    select: { formFactor: true, origin: true, visibility: true, portalEnabled: true, periodEnd: true, lcpP75Ms: true, lcpGood: true },
    orderBy: [{ formFactor: "asc" }, { periodEnd: "asc" }],
  });

const checkOf = (projectId: string) =>
  f.platform.websiteSpeedCheck.findFirst({ where: { tenantId: f.tenantId, projectId }, select: { origin: true, outcome: true, detail: true, checkedAt: true } });

/** A raw week row — the shape the job writes, with the switch deciding `visibility`. */
const rawWeek = (projectId: string, end: string, extra: Record<string, unknown> = {}) => {
  const periodEnd = new Date(`${end}T00:00:00Z`);
  return {
    id: randomUUID(),
    tenantId: f.tenantId,
    clientId: acme,
    projectId,
    origin: "https://example.invalid",
    formFactor: "PHONE" as const,
    periodStart: new Date(periodEnd.getTime() - 27 * 86_400_000),
    periodEnd,
    lcpP75Ms: 2100,
    lcpGood: 0.8,
    lcpNeedsWork: 0.15,
    lcpPoor: 0.05,
    ...extra,
  };
};

const withModule = async (module: "reports" | "portal", on: boolean, body: () => Promise<void>) => {
  const before = await f.platform.tenant.findUniqueOrThrow({ where: { id: f.tenantId }, select: { entitlements: true } });
  const ents = parseEntitlements(before.entitlements);
  await f.platform.tenant.update({ where: { id: f.tenantId }, data: { entitlements: { ...ents, modules: { ...ents.modules, [module]: on } } } });
  const savedGates = gates;
  gates = await resolvePortalModuleGates(f.tenantId);
  try {
    await body();
  } finally {
    await f.platform.tenant.update({ where: { id: f.tenantId }, data: { entitlements: before.entitlements ?? {} } });
    gates = savedGates;
  }
};

/** A member holding exactly `codes` through a custom role, assigned to one client (scoped). */
async function customMember(label: string, codes: readonly string[], clientId: string): Promise<ProjectCtx> {
  const userId = randomUUID();
  const email = `wspd-${label}-${run}@test.invalid`;
  await f.platform.user.create({ data: { id: userId, name: email, email } });
  const member = await f.platform.member.create({ data: { tenantId: f.tenantId, userId } });
  const role = await f.platform.role.create({ data: { tenantId: f.tenantId, name: `Speed ${label} ${run}` } });
  const perms = await f.platform.permission.findMany({ where: { code: { in: [...codes] } } });
  expect(perms).toHaveLength(codes.length);
  await f.platform.rolePermission.createMany({ data: perms.map((p) => ({ tenantId: f.tenantId, roleId: role.id, permissionId: p.id })) });
  await f.platform.memberRole.create({ data: { tenantId: f.tenantId, memberId: member.id, roleId: role.id } });
  await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: member.id, clientId } });
  extras.push({ userId, memberId: member.id, roleId: role.id });
  return { tenantId: f.tenantId, actor: actorFor(member.id) };
}

const NOW = new Date();

beforeAll(async () => {
  f = await setupTenant("wspd");
  gates = await resolvePortalModuleGates(f.tenantId);
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: `Acme ${run}` },
      { id: beta, tenantId: f.tenantId, name: `Beta ${run}` },
    ],
  });
  const person = (id: string, who: string, clientId: string) => ({
    id,
    tenantId: f.tenantId,
    clientId,
    name: who,
    email: `wspd-${who}-${run}@test.invalid`,
    portalProfile: "CONTACT_PRIMARY" as const,
    portalStatus: "ACTIVE" as const,
    invitedAt: new Date("2026-09-01T09:00:00Z"),
    emailVerified: true,
  });
  await f.platform.contact.createMany({ data: [person(carol, "carol", acme), person(bo, "bo", beta)] });
  // A page URL, which the fetch reduces to its site.
  await project("site", acme, { productionUrl: "https://example.invalid/some/page?x=1#top" });
  await project("noUrl", acme);
  await project("nodata", acme, { productionUrl: "https://nodata.example.invalid" });
  await project("down", acme, { productionUrl: "https://down.example.invalid" });
  await project("refused", acme, { productionUrl: "https://refused.example.invalid" });
  await project("badUrl", acme, { productionUrl: "mailto:someone@example.invalid" });
  await project("archived", acme, { productionUrl: "https://archived.example.invalid", status: "COMPLETED", archivedAt: new Date("2026-01-01T00:00:00Z") });
  await project("betaSite", beta, { productionUrl: "https://beta.example.invalid" });
});

afterAll(async () => {
  if (!f) return;
  await f.platform.websiteSpeedWeek.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.websiteSpeedCheck.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.memberClient.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${f.tenantId}`;
  await f.platform.project.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.contact.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
  for (const x of extras) {
    await f.platform.memberRole.deleteMany({ where: { memberId: x.memberId } });
    await f.platform.rolePermission.deleteMany({ where: { roleId: x.roleId } });
    await f.platform.role.delete({ where: { id: x.roleId } });
    await f.platform.member.delete({ where: { id: x.memberId } });
    await f.platform.user.delete({ where: { id: x.userId } });
  }
  await f.cleanup();
});

describe("the weekly fetch (C94 (c))", () => {
  it("writes both kinds' weeks INTERNAL for a site, reduces a page URL to its origin, and records what each of Google's answers came to", async () => {
    const r = await fetchWebsiteSpeed(f.tenantId, { transport: fakeCrux, now: NOW });
    expect(r.skipped).toBeNull();
    expect(r.outOfQuota).toBe(false);
    // site, nodata, down, refused, badUrl, betaSite — never noUrl or the archived one.
    expect(r.projects).toBe(6);
    expect(r.weeks).toBe(40 * 2 * 2); // site and betaSite, phones and computers
    expect(r.noData).toBe(1);
    expect(r.refused).toBe(2);
    expect(r.failed).toBe(1);

    const rows = await weeksOf(P.site!);
    expect(rows).toHaveLength(80);
    expect(rows.filter((w) => w.formFactor === "PHONE")).toHaveLength(40);
    expect(new Set(rows.map((w) => w.origin))).toEqual(new Set(["https://example.invalid"]));
    expect(new Set(rows.map((w) => w.visibility))).toEqual(new Set(["INTERNAL"]));
    expect(new Set(rows.map((w) => w.portalEnabled))).toEqual(new Set([false]));
    expect(rows.every((w) => w.lcpP75Ms !== null && w.lcpGood !== null)).toBe(true);
    expect((await checkOf(P.site!))?.outcome).toBe("OK");
    expect((await checkOf(P.site!))?.origin).toBe("https://example.invalid");

    expect(await checkOf(P.nodata!)).toMatchObject({ outcome: "NO_DATA", detail: null });
    expect(await weeksOf(P.nodata!)).toHaveLength(0);
    expect(await checkOf(P.down!)).toMatchObject({ outcome: "FAILED", detail: "network" });
    expect(await checkOf(P.refused!)).toMatchObject({ outcome: "REFUSED", detail: "bad_request" });
    expect(await checkOf(P.badUrl!)).toMatchObject({ outcome: "REFUSED", detail: "bad_url", origin: null });
    expect(await checkOf(P.noUrl!)).toBeNull();
    expect(await checkOf(P.archived!)).toBeNull();
    expect(await weeksOf(P.archived!)).toHaveLength(0);
  });

  it("asks nobody again the same week, and a week later inserts nothing it already holds (the unique key)", async () => {
    const again = await fetchWebsiteSpeed(f.tenantId, { transport: fakeCrux, now: NOW });
    expect(again.projects).toBe(0);
    expect(again.weeks).toBe(0);
    const later = await fetchWebsiteSpeed(f.tenantId, { transport: fakeCrux, now: new Date(NOW.getTime() + REFRESH_AFTER_MS + 60_000) });
    expect(later.projects).toBe(6);
    expect(later.weeks).toBe(0);
    expect(await weeksOf(P.site!)).toHaveLength(80);
  });

  it("the reports module off: nothing is asked", async () => {
    await withModule("reports", false, async () => {
      const r = await fetchWebsiteSpeed(f.tenantId, { transport: fakeCrux, now: new Date(NOW.getTime() + 2 * REFRESH_AFTER_MS) });
      expect(r.skipped).toBe("module");
      expect(r.projects).toBe(0);
    });
  });
});

describe("the database holds a week's shape", () => {
  it("refuses a period that is not 28 days, a share outside 0..1, a p75 without its shares, a row with no metric, a page or a credential as the origin", async () => {
    const insert = (data: ReturnType<typeof rawWeek>) => f.platform.websiteSpeedWeek.create({ data, select: { id: true } });
    expect(await meta(insert(rawWeek(P.noUrl!, "2026-02-07", { periodStart: new Date("2026-01-01T00:00:00Z") })))).toContain("website_speed_week_period_28_days");
    expect(await meta(insert(rawWeek(P.noUrl!, "2026-02-07", { lcpGood: 1.5 })))).toContain("website_speed_week_shares_unit");
    expect(await meta(insert(rawWeek(P.noUrl!, "2026-02-07", { lcpGood: null })))).toContain("website_speed_week_metric_whole");
    expect(await meta(insert(rawWeek(P.noUrl!, "2026-02-07", { lcpP75Ms: null, lcpGood: null, lcpNeedsWork: null, lcpPoor: null })))).toContain(
      "website_speed_week_some_metric",
    );
    expect(await meta(insert(rawWeek(P.noUrl!, "2026-02-07", { origin: "https://example.invalid/page" })))).toContain("website_speed_week_origin_shape");
    expect(await meta(insert(rawWeek(P.noUrl!, "2026-02-07", { origin: "https://user:pw@example.invalid" })))).toContain("website_speed_week_origin_shape");
    expect(await meta(insert(rawWeek(P.noUrl!, "2026-02-07", { lcpP75Ms: -1 })))).toContain("website_speed_week_p75_nonnegative");
    expect(await weeksOf(P.noUrl!)).toHaveLength(0);
  });
});

describe("the switch derives every row's visibility (C94 (a))", () => {
  it("on: every row CLIENT_VISIBLE and the audit row; a row inserted after is born visible; a direct write is overwritten; off: INTERNAL again", async () => {
    expect(await setSpeedShared(owner(), P.site!, true)).toEqual({ changed: true });
    expect(await setSpeedShared(owner(), P.site!, true)).toEqual({ changed: false });
    expect(new Set((await weeksOf(P.site!)).map((w) => w.visibility))).toEqual(new Set(["CLIENT_VISIBLE"]));
    const audits = await f.platform.auditEvent.findMany({
      where: { tenantId: f.tenantId, action: "project.speed_sharing_changed", targetId: P.site! },
      select: { metadata: true, actorId: true },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toEqual({ shown: true });
    // Born with the switch's value, whatever the writer says.
    const born = await f.platform.websiteSpeedWeek.create({ data: rawWeek(P.site!, "2020-02-01", { visibility: "INTERNAL" }), select: { visibility: true } });
    expect(born.visibility).toBe("CLIENT_VISIBLE");
    const written = await f.platform.websiteSpeedWeek.updateManyAndReturn({
      where: { tenantId: f.tenantId, projectId: P.site!, periodEnd: new Date("2020-02-01T00:00:00Z") },
      data: { visibility: "INTERNAL" },
      select: { visibility: true },
    });
    expect(written.map((w) => w.visibility)).toEqual(["CLIENT_VISIBLE"]);
    await f.platform.websiteSpeedWeek.deleteMany({ where: { tenantId: f.tenantId, projectId: P.site!, periodEnd: new Date("2020-02-01T00:00:00Z") } });

    expect(await setSpeedShared(owner(), P.site!, false)).toEqual({ changed: true });
    expect(new Set((await weeksOf(P.site!)).map((w) => w.visibility))).toEqual(new Set(["INTERNAL"]));
  });

  it("an employee (no project:manage_portal) is refused; an archived project cannot be switched ON (off is always allowed); the team's read needs report:view and the project in scope", async () => {
    expect(await reason(setSpeedShared(employee(), P.site!, true))).toBe("FORBIDDEN");
    await expect(setSpeedShared(owner(), P.archived!, true)).rejects.toMatchObject({ code: "ARCHIVED" });
    // …while OFF is allowed on one archived with the switch on (set past the service, as an archive after a press would leave it).
    await f.platform.project.update({ where: { id: P.archived! }, data: { portalShowSpeed: true }, select: { id: true } });
    expect(await setSpeedShared(owner(), P.archived!, false)).toEqual({ changed: true });
    const read = await readWebsiteSpeed(owner(), P.site!);
    expect(read.origin).toBe("https://example.invalid");
    expect(read.shown).toBe(false);
    expect(read.portalEnabled).toBe(false);
    expect(read.check?.outcome).toBe("OK");
    expect(read.series.PHONE).toHaveLength(40);
    expect(read.series.DESKTOP).toHaveLength(40);
    // Oldest first, a week apart.
    const ends = read.series.PHONE.map((w) => w.periodEnd);
    expect(ends[0]! < ends[1]!).toBe(true);
    expect(read.series.PHONE.every((w) => w.lcp !== null && w.inp !== null && w.cls !== null)).toBe(true);
    expect((await readWebsiteSpeed(owner(), P.noUrl!)).series.PHONE).toHaveLength(0);
    // A member on Beta only: Acme's project is NOT_FOUND to them.
    const onBeta = await customMember("beta", ["report:view", "project:view"], beta);
    expect(await reason(readWebsiteSpeed(onBeta, P.site!))).toBe("NOT_FOUND");
    expect((await readWebsiteSpeed(onBeta, P.betaSite!)).series.PHONE).toHaveLength(40);
    await withModule("reports", false, async () => {
      expect(await reason(readWebsiteSpeed(owner(), P.site!))).toBe("NOT_ENTITLED");
    });
  });
});

describe("the client's side", () => {
  it("a contact reads a project's weeks only with the switch AND the project's portal on; never another client's; the nav's count follows", async () => {
    expect(await listPortalWebsiteSpeed(principal(carol))).toEqual([]);
    expect(await countPortalWebsiteSpeed(principal(carol))).toBe(0);
    await setSpeedShared(owner(), P.site!, true);
    // Switch on, portal off: nothing (the three-term gate).
    expect(await listPortalWebsiteSpeed(principal(carol))).toEqual([]);
    expect(await countPortalWebsiteSpeed(principal(carol))).toBe(0);
    await setPortalEnabled(owner(), P.site!, true);
    const shown = await listPortalWebsiteSpeed(principal(carol));
    expect(shown.map((p) => [p.id, p.origin])).toEqual([[P.site!, "https://example.invalid"]]);
    expect(shown[0]!.series.PHONE).toHaveLength(40);
    expect(shown[0]!.series.DESKTOP).toHaveLength(40);
    expect(shown[0]!.series.PHONE.every((w) => w.lcp !== null)).toBe(true);
    expect(JSON.stringify(shown)).not.toContain("fetchedAt");
    expect(await countPortalWebsiteSpeed(principal(carol))).toBe(1);
    // Beta's contact sees nothing of Acme's.
    expect(await listPortalWebsiteSpeed(principal(bo, beta))).toEqual([]);
    expect(await countPortalWebsiteSpeed(principal(bo, beta))).toBe(0);
    // The reports module off: refused; the count answers zero.
    await withModule("reports", false, async () => {
      expect(await reason(listPortalWebsiteSpeed(principal(carol)))).not.toBe("resolved");
      expect(await countPortalWebsiteSpeed(principal(carol))).toBe(0);
    });
  });

  it("rows of a PREVIOUS origin are not drawn; the next fetch brings the new site's (the dedupe is per site — migration 20261023100000)", async () => {
    await f.platform.project.update({ where: { id: P.site! }, data: { productionUrl: "https://moved.example.invalid" }, select: { id: true } });
    // The DATABASE made the previous site's rows INTERNAL in the same
    // transaction (migration 20261023110000's fan-out), so the nav's count
    // and the list agree: nothing to see (the code review's 1, the security
    // review's 1).
    expect(new Set((await weeksOf(P.site!)).map((w) => w.visibility))).toEqual(new Set(["INTERNAL"]));
    expect(await listPortalWebsiteSpeed(principal(carol))).toEqual([]);
    expect(await countPortalWebsiteSpeed(principal(carol))).toBe(0);
    const before = await readWebsiteSpeed(owner(), P.site!);
    expect(before.series.PHONE).toHaveLength(0);
    // …and the team's card knows the check it holds was of the old site.
    expect(before.check?.origin).toBe("https://example.invalid");
    expect(before.origin).toBe("https://moved.example.invalid");
    const r = await fetchWebsiteSpeed(f.tenantId, { transport: fakeCrux, now: new Date(NOW.getTime() + 3 * REFRESH_AFTER_MS) });
    expect(r.weeks).toBeGreaterThanOrEqual(80);
    const shown = await listPortalWebsiteSpeed(principal(carol));
    expect(shown[0]!.origin).toBe("https://moved.example.invalid");
    expect(shown[0]!.series.PHONE).toHaveLength(40);
    expect(await countPortalWebsiteSpeed(principal(carol))).toBe(1);
    const all = await weeksOf(P.site!);
    expect(all).toHaveLength(160); // the old origin's rows stay as history…
    // …INTERNAL, while the new site's are born CLIENT_VISIBLE (the switch is on).
    expect(all.filter((w) => w.origin === "https://example.invalid").every((w) => w.visibility === "INTERNAL")).toBe(true);
    expect(all.filter((w) => w.origin === "https://moved.example.invalid").every((w) => w.visibility === "CLIENT_VISIBLE")).toBe(true);
    // A URL the app refuses (a credential, or whitespace, before the path) is
    // no origin to the database either (migration 20261023120000): every row
    // INTERNAL, the nav's count 0 — the list's own answer.
    await f.platform.project.update({ where: { id: P.site! }, data: { productionUrl: "https://moved.example.invalid@evil.invalid" }, select: { id: true } });
    expect(new Set((await weeksOf(P.site!)).map((w) => w.visibility))).toEqual(new Set(["INTERNAL"]));
    expect(await countPortalWebsiteSpeed(principal(carol))).toBe(0);
    expect(await listPortalWebsiteSpeed(principal(carol))).toEqual([]);
    await f.platform.project.update({ where: { id: P.site! }, data: { productionUrl: "https://moved.example.invalid" }, select: { id: true } });
    expect(await countPortalWebsiteSpeed(principal(carol))).toBe(1);
    // A row of another site inserted by hand is born INTERNAL whatever the switch says.
    const stray = await f.platform.websiteSpeedWeek.create({
      data: rawWeek(P.site!, "2020-03-07", { origin: "https://elsewhere.example.invalid" }),
      select: { visibility: true },
    });
    expect(stray.visibility).toBe("INTERNAL");
    await f.platform.websiteSpeedWeek.deleteMany({ where: { tenantId: f.tenantId, projectId: P.site!, origin: "https://elsewhere.example.invalid" } });
  });

  it("the portal switched off: 0 rows for the contact (the fan-out), back on: the rows return", async () => {
    await setPortalEnabled(owner(), P.site!, false);
    expect(await listPortalWebsiteSpeed(principal(carol))).toEqual([]);
    expect(new Set((await weeksOf(P.site!)).map((w) => w.portalEnabled))).toEqual(new Set([false]));
    await setPortalEnabled(owner(), P.site!, true);
    expect((await listPortalWebsiteSpeed(principal(carol)))[0]!.series.PHONE).toHaveLength(40);
    await setSpeedShared(owner(), P.site!, false);
    expect(await listPortalWebsiteSpeed(principal(carol))).toEqual([]);
  });
});

describe("Google's quota and the server's key end the run (the code review's 3 and 4)", () => {
  it("the per-minute quota: what was answered is kept, no check row is written (the site stays due), the run stops", async () => {
    const id = await project("quota", acme, { productionUrl: "https://rate.example.invalid" });
    const r = await fetchWebsiteSpeed(f.tenantId, { transport: fakeCrux, now: NOW });
    expect(r.outOfQuota).toBe(true);
    expect(r.keyRefused).toBe(false);
    // Phones were answered before computers met the quota: kept.
    const rows = await weeksOf(id);
    expect(rows).toHaveLength(40);
    expect(new Set(rows.map((w) => w.formFactor))).toEqual(new Set(["PHONE"]));
    expect(await checkOf(id)).toBeNull();
    await f.platform.project.update({ where: { id }, data: { archivedAt: new Date(), status: "COMPLETED" }, select: { id: true } });
  });

  it("the key refused: recorded on the site that met it, the run stops", async () => {
    const id = await project("nokey", acme, { productionUrl: "https://nokey.example.invalid" });
    const r = await fetchWebsiteSpeed(f.tenantId, { transport: fakeCrux, now: NOW });
    expect(r.keyRefused).toBe(true);
    expect(await checkOf(id)).toMatchObject({ outcome: "REFUSED", detail: "key" });
    expect(await weeksOf(id)).toHaveLength(0);
    await f.platform.project.update({ where: { id }, data: { archivedAt: new Date(), status: "COMPLETED" }, select: { id: true } });
  });
});

describe("the race the job's FOR SHARE closes (design §2.3)", () => {
  /** A platform transaction held open until released. */
  const hold = (body: (tx: Parameters<Parameters<typeof f.platform.$transaction>[0]>[0]) => Promise<void>) => {
    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    const done = f.platform.$transaction(
      async (tx) => {
        await body(tx);
        await released;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    return { release, done };
  };

  it("job first: a switch pressed while the job holds the project row waits, and the row the job wrote ends with the switch's value", async () => {
    const id = await project("raceA", acme, { productionUrl: "https://racea.example.invalid" });
    const held = hold(async (tx) => {
      await tx.$queryRaw`SELECT id FROM project WHERE tenant_id = ${f.tenantId} AND id = ${id} FOR SHARE`;
      await tx.websiteSpeedWeek.create({ data: rawWeek(id, "2026-03-07", { origin: "https://racea.example.invalid" }), select: { id: true } });
    });
    let settled = false;
    const press = setSpeedShared(owner(), id, true).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(settled, "the switch waits on the job's lock").toBe(false);
    held.release();
    await held.done;
    expect(await press).toEqual({ changed: true });
    expect((await weeksOf(id)).map((w) => w.visibility)).toEqual(["CLIENT_VISIBLE"]);
  });

  it("switch first: the job's write waits on the uncommitted switch, and its rows are born with the switch's value", async () => {
    const id = await project("raceB", acme, { productionUrl: "https://raceb.example.invalid" });
    const held = hold(async (tx) => {
      await tx.$executeRaw`UPDATE project SET portal_show_speed = true WHERE tenant_id = ${f.tenantId} AND id = ${id}`;
    });
    let settled = false;
    const fetching = fetchWebsiteSpeed(f.tenantId, { transport: fakeCrux, now: new Date(NOW.getTime() + 4 * REFRESH_AFTER_MS) }).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(settled, "the job waits on the switch's lock").toBe(false);
    held.release();
    await held.done;
    const r = await fetching;
    // (`r.failed` counts the planted `down.` site, due again on this clock.)
    expect(r.outOfTime).toBe(false);
    const rows = await weeksOf(id);
    expect(rows).toHaveLength(80);
    expect(new Set(rows.map((w) => w.visibility))).toEqual(new Set(["CLIENT_VISIBLE"]));
  });
});
