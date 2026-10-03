import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { resetTenantDekCache } from "@/crypto/tenant-key";
import { DomainError } from "@/lib/domain-error";
import { actorFor, noMfa, setupTenant } from "@/members/dbtest-fixture";
import { setModuleEnabled } from "@/preferences/service";

import { createAsset, createCredential, expirationsFeed, expirationsGlance, updateAsset } from "./index";

/**
 * THE EXPIRATIONS FEED against the real database and app_runtime (Phase
 * 3V slice 88): what is in it (assets in use with a date inside the
 * window or lapsed; agreements not ended, by renewal and end date; logins
 * as a COUNT per client), what is not (retired, dateless, past the window,
 * ended), the order, the gates (`asset:view` is the feed's; agreements and
 * logins join only with their own codes), scope by anchor for all three,
 * C54 (no login is ever named, and the feed needs no fresh factor), C49
 * (the agency's own logins counted for tenant-wide scope only), and the
 * Home glance's window and cut.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let beta: string;
let acmeP1: string;
let acmeP2: string;

const TODAY = "2031-06-15";
const day = (offset: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * 86_400_000);
const iso = (offset: number) => day(offset).toISOString().slice(0, 10);

const owner = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.owner.memberId) });
const employee = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.employee.memberId) });

const outcome = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof AuthzError) return e.reason;
    if (e instanceof DomainError) return e.code;
    throw e;
  }
};

const SECRET_LOGIN_NAME = `Acme root login ${randomUUID().slice(0, 6)}`;

beforeAll(async () => {
  f = await setupTenant("expir");
  acme = randomUUID();
  beta = randomUUID();
  acmeP1 = randomUUID();
  acmeP2 = randomUUID();
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: "Acme" },
      { id: beta, tenantId: f.tenantId, name: "Beta" },
    ],
  });
  await f.platform.project.createMany({
    data: [
      { id: acmeP1, tenantId: f.tenantId, clientId: acme, key: "ACA", name: "Acme site" },
      { id: acmeP2, tenantId: f.tenantId, clientId: acme, key: "ACB", name: "Acme app" },
    ],
  });
  // The employee works on ONE project of Acme and nothing else.
  await f.platform.memberProject.create({ data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, projectId: acmeP1 } });

  const asset = (name: string, extra: Record<string, unknown>) =>
    createAsset(owner(), { clientId: acme, type: "DOMAIN", name, ...extra } as Parameters<typeof createAsset>[1]);
  await asset("lapsed.se", { expiresAt: day(-3) });
  await asset("soon.se", { expiresAt: day(10), autoRenew: true });
  await asset("later.se", { expiresAt: day(80) });
  await asset("beyond.se", { expiresAt: day(91) });
  await asset("edge.se", { expiresAt: day(90) });
  await asset("dateless.se", {});
  const retired = await asset("retired.se", { expiresAt: day(5) });
  await updateAsset(owner(), retired.id, { status: "RETIRED" });
  await asset("p1-hosting", { projectId: acmeP1, type: "HOSTING", expiresAt: day(20) });
  await asset("p2-hosting", { projectId: acmeP2, type: "HOSTING", expiresAt: day(20) });
  await createAsset(owner(), { clientId: beta, type: "DOMAIN", name: "beta.se", expiresAt: day(15) });

  await f.platform.service.createMany({
    data: [
      { tenantId: f.tenantId, clientId: acme, name: "Acme retainer", kind: "RECURRING", renewsAt: day(25), endsAt: day(200) },
      { tenantId: f.tenantId, clientId: acme, projectId: acmeP1, name: "P1 support", kind: "RECURRING", status: "PAUSED", endsAt: day(40) },
      { tenantId: f.tenantId, clientId: acme, name: "Ended deal", kind: "RECURRING", status: "ENDED", renewsAt: day(5) },
      // A running agreement past its renewal date has renewed — out (the code review's medium) …
      { tenantId: f.tenantId, clientId: acme, name: "Old renewal", kind: "RECURRING", renewsAt: day(-10) },
      // … but one still running past its END date is the page's business.
      { tenantId: f.tenantId, clientId: acme, name: "Lapsed end", kind: "ONE_TIME", endsAt: day(-2) },
      // Services' dates are not midnight-normalised: the window's last day holds to its end, and no further.
      { tenantId: f.tenantId, clientId: acme, name: "Zeta edge renewal", kind: "RECURRING", renewsAt: new Date(day(90).getTime() + 23 * 3_600_000) },
      { tenantId: f.tenantId, clientId: acme, name: "Past the edge", kind: "RECURRING", renewsAt: new Date(day(91).getTime() + 60_000) },
      // The renewals' LOWER bound, pinned at both sides of today (the fix-pass review).
      { tenantId: f.tenantId, clientId: acme, name: "Due today renewal", kind: "RECURRING", renewsAt: day(0) },
      { tenantId: f.tenantId, clientId: acme, name: "Late yesterday", kind: "RECURRING", renewsAt: new Date(day(0).getTime() - 60_000) },
      // Beta's own agreement: a directly assigned member's line is a link.
      { tenantId: f.tenantId, clientId: beta, name: "Beta care", kind: "RECURRING", renewsAt: day(50) },
    ],
  });

  await createCredential(owner(), { clientId: acme, type: "LOGIN", name: SECRET_LOGIN_NAME, secret: { password: "p" }, expiresAt: day(12) });
  await createCredential(owner(), { projectId: acmeP1, type: "LOGIN", name: "P1 ftp", secret: { password: "p" }, expiresAt: day(-1) });
  await createCredential(owner(), { projectId: acmeP1, type: "LOGIN", name: "P1 far", secret: { password: "p" }, expiresAt: day(300) });
  await createCredential(owner(), { type: "LOGIN", name: "Our registrar", secret: { password: "p" }, expiresAt: day(30) });
}, 180_000);

afterAll(async () => {
  if (!f) return;
  await f.platform.clientAsset.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.service.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.credentialItem.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.memberProject.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.project.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantKey.deleteMany({ where: { tenantId: f.tenantId } });
  resetTenantDekCache();
  await f.cleanup();
}, 120_000);

describe("what the feed holds, in what order", () => {
  it("assets in use inside 90 days or lapsed; agreements not ended by both dates; soonest first", async () => {
    const feed = await expirationsFeed(owner(), TODAY);
    expect(feed.until).toBe(iso(90));
    expect(feed.truncated).toBe(false);
    expect(feed.cutAt).toBeNull();
    expect(feed.entries.map((e) => `${e.date}|${e.kind}|${e.name}`)).toEqual([
      `${iso(-3)}|asset|lapsed.se`,
      `${iso(-2)}|agreementEnds|Lapsed end`,
      `${iso(0)}|agreementRenews|Due today renewal`,
      `${iso(10)}|asset|soon.se`,
      `${iso(15)}|asset|beta.se`,
      `${iso(20)}|asset|p1-hosting`,
      `${iso(20)}|asset|p2-hosting`,
      `${iso(25)}|agreementRenews|Acme retainer`,
      `${iso(40)}|agreementEnds|P1 support`,
      `${iso(50)}|agreementRenews|Beta care`,
      `${iso(80)}|asset|later.se`,
      `${iso(90)}|asset|edge.se`,
      `${iso(90)}|agreementRenews|Zeta edge renewal`,
    ]);
    const soon = feed.entries.find((e) => e.name === "soon.se")!;
    expect(soon).toMatchObject({ client: { id: acme, name: "Acme" }, project: null, assetType: "DOMAIN", autoRenew: true, linkable: true });
    expect(feed.entries.find((e) => e.name === "p1-hosting")?.project).toEqual({ key: "ACA", name: "Acme site" });
    // An owner may open every client's Agreements tab: the agreement's line is a link.
    expect(feed.entries.find((e) => e.name === "Acme retainer")?.linkable).toBe(true);
  });

  it("logins are a COUNT per client — our own first — and no login is ever named (C54)", async () => {
    const feed = await expirationsFeed(owner(), TODAY);
    expect(feed.logins).toEqual([
      { client: null, count: 1 },
      { client: { id: acme, name: "Acme" }, count: 2 },
    ]);
    expect(JSON.stringify(feed)).not.toContain(SECRET_LOGIN_NAME);
    expect(JSON.stringify(feed)).not.toContain("P1 ftp");
  });

  it("needs no fresh factor: the feed never opens the vault's door", async () => {
    const stale = { tenantId: f.tenantId, actor: noMfa(f.seats.owner.memberId) };
    expect((await expirationsFeed(stale, TODAY)).logins?.length).toBe(2);
  });

  it("impersonation reads the feed but never the login count — the vault refuses it before reading anything", async () => {
    const imp = { tenantId: f.tenantId, actor: { ...actorFor(f.seats.owner.memberId), impersonated: true } };
    const feed = await expirationsFeed(imp, TODAY);
    expect(feed.entries.length).toBeGreaterThan(0);
    expect(feed.logins).toBeNull();
  });

  it("a malformed today is refused", async () => {
    // `2031-02-30` and a non-leap `2031-02-29` parse — into March — and are refused by the round trip.
    for (const bad of ["2031-6-15", "tomorrow", "2031-02-30x", "", "2031-02-30", "2031-02-29", "2031-13-01"]) {
      expect(await outcome(expirationsFeed(owner(), bad)), bad).toBe("INVALID_INPUT");
    }
  });
});

describe("scope and gates", () => {
  it("an employee on one project sees that project's rows only — never the client's own, a sibling project's or another client's", async () => {
    const feed = await expirationsFeed(employee(), TODAY);
    expect(feed.entries.map((e) => e.name).sort()).toEqual(["P1 support", "p1-hosting"]);
    // The agreement's tab wants direct assignment: the line, without the link.
    expect(feed.entries.find((e) => e.name === "P1 support")?.linkable).toBe(false);
    // Their project's one lapsed login; the agency's own is not theirs (C49).
    expect(feed.logins).toEqual([{ client: { id: acme, name: "Acme" }, count: 1 }]);
  });

  it("a member assigned to a client DIRECTLY reaches its client-level rows and its projects' — and never the agency's own logins", async () => {
    await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId: beta } });
    try {
      const feed = await expirationsFeed(employee(), TODAY);
      expect(feed.entries.map((e) => e.name).sort()).toEqual(["Beta care", "P1 support", "beta.se", "p1-hosting"]);
      // Their client's agreement is a link; the project's (reached through the project only) is not.
      expect(feed.entries.find((e) => e.name === "Beta care")?.linkable).toBe(true);
      expect(feed.entries.find((e) => e.name === "P1 support")?.linkable).toBe(false);
      // Beta's client-level asset is theirs now; Acme's are still not.
      expect(feed.entries.some((e) => e.client.id === acme && e.project === null)).toBe(false);
      expect(feed.logins).toEqual([{ client: { id: acme, name: "Acme" }, count: 1 }]);
    } finally {
      await f.platform.memberClient.deleteMany({ where: { tenantId: f.tenantId, memberId: f.seats.employee.memberId } });
    }
  });

  it("agreements and logins join only with their own codes; the feed itself needs asset:view", async () => {
    const drop = async (code: string) => {
      const permission = await f.platform.permission.findUniqueOrThrow({ where: { code }, select: { id: true } });
      await f.platform.rolePermission.deleteMany({ where: { tenantId: f.tenantId, roleId: f.seats.employee.roleId, permissionId: permission.id } });
    };
    await drop("service:view");
    await drop("credential:view");
    const feed = await expirationsFeed(employee(), TODAY);
    expect(feed.entries.map((e) => e.name)).toEqual(["p1-hosting"]);
    expect(feed.logins).toBeNull();
    await drop("asset:view");
    expect(await outcome(expirationsFeed(employee(), TODAY))).toBe("FORBIDDEN");
    expect(await expirationsGlance(employee(), TODAY)).toBeNull();
  });

  it("switching the vault off closes the feed, and the Home card with it", async () => {
    await setModuleEnabled(owner(), "vault", false);
    try {
      expect(await outcome(expirationsFeed(owner(), TODAY))).toBe("DISABLED_BY_TENANT");
      expect(await expirationsGlance(owner(), TODAY)).toBeNull();
    } finally {
      await setModuleEnabled(owner(), "vault", true);
    }
  });
});

describe("the Home glance", () => {
  it("is what is lapsed or due within 30 days, the first five, and how many more", async () => {
    const glance = await expirationsGlance(owner(), TODAY);
    expect(glance?.entries.map((e) => e.name)).toEqual(["lapsed.se", "Lapsed end", "Due today renewal", "soon.se", "beta.se"]);
    // Within 30 days there are three more — both hostings and the retainer's renewal — nothing from day 31 on, and the count is exact.
    expect(glance?.more).toBe(3);
    expect(glance?.moreAtLeast).toBe(false);
  });
});
