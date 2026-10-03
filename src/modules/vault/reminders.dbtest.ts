import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetTenantDekCache } from "@/crypto/tenant-key";
import { withTenant, type TenantDb } from "@/db";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { listInbox, type InboxRow } from "@/notify/inbox";
import { setModuleEnabled } from "@/preferences/service";

import { createAsset, createCredential, expirationsFeed, sendExpirationReminders, updateAsset } from "./index";

/**
 * THE RENEWAL REMINDERS against the real database and app_runtime (Phase
 * 3V slice 89): the band each date is in and that only the smallest one is
 * ever sent (never retroactively), counted in the TENANT's day; C55 (an
 * agreement's END, never its renewal — and with the vault module off too,
 * since agreements are core); C53's receivers — the project's people
 * (assignees and lead) for a project's row, the directly assigned for a
 * client-level one, each held to the code on all four gates and to the
 * vault's anchor rule, the owners when nobody is left — and each mail's
 * link a page that receiver may open; C56 (logins as a COUNT per client,
 * each reader told how many THEY can open, never a login's id or name; the
 * agency's own to tenant-wide scope only); idempotence, a re-dated row
 * re-arming, two runs at once, nothing recorded while nobody can hear it,
 * the sweep; the inbox naming only what the reader may see NOW
 * (impersonation, a lost assignment, a reader moved from the client to one
 * of its projects, a login deleted since); a custom role without
 * `client:view` sent — by mail, inbox and Renewals — only where it can go;
 * and the two url CHECKs this slice's migration tightened.
 *
 * It calls the per-tenant `sendExpirationReminders` ONLY — never the job's
 * cross-tenant `runExpirationReminders`, which would remind every tenant on
 * the shared dev database (AGENTS.md: never write outside a throwaway
 * tenant). The clock is passed in: "today" is 2031-06-15 in the tenant's
 * zone (Europe/Stockholm, the default, UTC+2 in June), and most runs are at
 * 10:00 UTC; one is at 22:30 UTC, already the next day in Stockholm.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let beta: string;
let gamma: string;
let delta: string;
let p1: string;
let p2: string;
let p3: string;
let g1: string;
/** Members this file creates beyond the fixture's seats — recorded the moment each user exists. */
const extras: { userId: string; memberId: string | null }[] = [];
/** A member of P2 whose role holds no permission at all. */
let nobody: string;
/** An employee assigned to Gamma directly and to its project G1. */
let gammaDirect: string;
/** A custom role holding `asset:view` and `service:view` but NOT `client:view`, assigned to Delta. */
let noClient: string;
const ids: Record<string, string> = {};

const TODAY = "2031-06-15";
const DAY = 86_400_000;
const day = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * DAY);
const iso = (n: number) => day(n).toISOString().slice(0, 10);
/** A run on day `n` at 10:00 UTC (12:00 in Stockholm). */
const at = (n: number) => new Date(day(n).getTime() + 10 * 3_600_000);

const owner = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.owner.memberId) });
const sys = <T,>(fn: (tx: TenantDb) => Promise<T>) => withTenant(f.tenantId, { type: "system" }, fn);
const P = (n: { params: unknown }) => n.params as Record<string, string>;

const SECRET_LOGIN_NAME = `Acme root ${randomUUID().slice(0, 6)}`;

const notes = (kind: string, entityId?: string) =>
  f.platform.notification.findMany({
    where: { tenantId: f.tenantId, kind, ...(entityId ? { entityId } : {}) },
    select: { receiverId: true, entityType: true, entityId: true, params: true, clientId: true, projectId: true },
    orderBy: { id: "asc" },
  });

const receiversOf = async (kind: string, entityId: string) => (await notes(kind, entityId)).map((n) => n.receiverId).sort();

async function extraMember(roleId: string, label: string): Promise<string> {
  const userId = randomUUID();
  await f.platform.user.create({ data: { id: userId, name: label, email: `${label}-remind-${userId.slice(0, 8)}@test.invalid` } });
  const entry: { userId: string; memberId: string | null } = { userId, memberId: null };
  extras.push(entry);
  const member = await f.platform.member.create({ data: { tenantId: f.tenantId, userId }, select: { id: true } });
  entry.memberId = member.id;
  await f.platform.memberRole.create({ data: { tenantId: f.tenantId, memberId: member.id, roleId } });
  return member.id;
}

beforeAll(async () => {
  f = await setupTenant("remind");
  [acme, beta, gamma, delta, p1, p2, p3, g1] = Array.from({ length: 8 }, () => randomUUID()) as [
    string, string, string, string, string, string, string, string,
  ];
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: "Acme" },
      { id: beta, tenantId: f.tenantId, name: "Beta" },
      { id: gamma, tenantId: f.tenantId, name: "Gamma" },
      { id: delta, tenantId: f.tenantId, name: "Delta" },
    ],
  });
  await f.platform.project.createMany({
    data: [
      { id: p1, tenantId: f.tenantId, clientId: acme, key: "RMA", name: "Acme site" },
      // P2's LEAD is the employee, who is not on P2: a candidate the scope check must drop.
      { id: p2, tenantId: f.tenantId, clientId: acme, key: "RMB", name: "Acme app", leadMemberId: f.seats.employee.memberId },
      // P3 has no assignee, only a LEAD (the manager): the lead alone is told.
      { id: p3, tenantId: f.tenantId, clientId: acme, key: "RMC", name: "Acme shop", leadMemberId: f.seats.manager.memberId },
      { id: g1, tenantId: f.tenantId, clientId: gamma, key: "RMG", name: "Gamma site" },
    ],
  });
  // The employee works on P1 only; the manager is assigned to Acme directly;
  // Beta has nobody; P2's only assignee holds no permission; Gamma has one
  // directly assigned employee, who is also on its project G1.
  await f.platform.memberProject.create({ data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, projectId: p1 } });
  await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: f.seats.manager.memberId, clientId: acme } });
  const role = await f.platform.role.create({ data: { tenantId: f.tenantId, name: "No access" }, select: { id: true } });
  nobody = await extraMember(role.id, "nobody");
  await f.platform.memberProject.create({ data: { tenantId: f.tenantId, memberId: nobody, projectId: p2 } });
  gammaDirect = await extraMember(f.roleId("employee"), "gamma");
  await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: gammaDirect, clientId: gamma } });
  await f.platform.memberProject.create({ data: { tenantId: f.tenantId, memberId: gammaDirect, projectId: g1 } });
  const narrow = await f.platform.role.create({ data: { tenantId: f.tenantId, name: "Renewals only" }, select: { id: true } });
  const codes = await f.platform.permission.findMany({ where: { code: { in: ["asset:view", "service:view"] } }, select: { id: true } });
  expect(codes).toHaveLength(2);
  await f.platform.rolePermission.createMany({
    data: codes.map((c) => ({ tenantId: f.tenantId, roleId: narrow.id, permissionId: c.id, source: "TENANT_GRANT" as const })),
  });
  noClient = await extraMember(narrow.id, "noclient");
  await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: noClient, clientId: delta } });

  const asset = async (key: string, input: Record<string, unknown>) => {
    ids[key] = (await createAsset(owner(), { type: "DOMAIN", ...input } as Parameters<typeof createAsset>[1])).id;
  };
  await asset("p1Hosting", { clientId: acme, projectId: p1, type: "HOSTING", name: "p1-hosting", expiresAt: day(10) });
  await asset("acmeDomain", { clientId: acme, name: "acme.se", expiresAt: day(30) });
  await asset("p2App", { clientId: acme, projectId: p2, type: "CMS_APP", name: "p2-app", expiresAt: day(60) });
  await asset("p3Site", { clientId: acme, projectId: p3, type: "HOSTING", name: "p3-site", expiresAt: day(25) });
  await asset("betaDomain", { clientId: beta, name: "beta.se", expiresAt: day(1) });
  await asset("deltaDomain", { clientId: delta, name: "delta.se", expiresAt: day(20) });
  await asset("lapsed", { clientId: acme, name: "lapsed.se", expiresAt: day(-1) });
  await asset("far", { clientId: acme, name: "far.se", expiresAt: day(61) });
  await asset("retired", { clientId: acme, name: "retired.se", expiresAt: day(5) });
  await updateAsset(owner(), ids["retired"]!, { status: "RETIRED" });

  await service("retainer", { name: "Acme retainer", kind: "RECURRING", renewsAt: day(5) }); // C55: a renewal sends nothing …
  await service("launch", { name: "Acme launch", endsAt: day(5) }); // … an end does
  await service("ended", { name: "Old deal", status: "ENDED", endsAt: day(3) });
  await service("p1Support", { name: "P1 support", projectId: p1, kind: "RECURRING", status: "PAUSED", endsAt: day(14) });
  await service("deltaEnd", { name: "Delta care", endsAt: day(20) }, delta);

  const login = async (key: string, input: Record<string, unknown>) => {
    ids[key] = (
      await createCredential(owner(), { type: "LOGIN", secret: { password: "p" }, ...input } as unknown as Parameters<typeof createCredential>[1])
    ).id;
  };
  await login("acmeLogin", { clientId: acme, name: SECRET_LOGIN_NAME, expiresAt: day(12) });
  await login("p1Login", { projectId: p1, name: "P1 ftp", expiresAt: day(13) });
  await login("ours", { name: "Our registrar", expiresAt: day(20) });
  await login("p1Far", { projectId: p1, name: "P1 far", expiresAt: day(200) });
  await login("gammaLogin", { clientId: gamma, name: "Gamma admin", expiresAt: day(12) });
  // Years away, on Gamma's project: never in a reminder, and never enough to
  // keep a Gamma reminder named for someone who reaches only this.
  await login("g1Far", { projectId: g1, name: "G1 far", expiresAt: day(800) });
}, 240_000);

async function service(key: string, data: Record<string, unknown>, clientId = acme) {
  ids[key] = (
    await f.platform.service.create({
      data: { tenantId: f.tenantId, clientId, kind: "ONE_TIME", ...data } as Parameters<typeof f.platform.service.create>[0]["data"],
      select: { id: true },
    })
  ).id;
}

afterAll(async () => {
  if (!f) return;
  const where = { where: { tenantId: f.tenantId } };
  await f.platform.emailOutbox.deleteMany(where);
  await f.platform.notification.deleteMany(where);
  await f.platform.expirationReminderSent.deleteMany(where);
  await f.platform.clientAsset.deleteMany(where);
  await f.platform.service.deleteMany(where);
  await f.platform.credentialItem.deleteMany(where);
  await f.platform.memberProject.deleteMany(where);
  await f.platform.memberClient.deleteMany(where);
  await f.platform.project.deleteMany(where);
  await f.platform.client.deleteMany(where);
  await f.platform.tenantPreference.deleteMany(where);
  await f.platform.tenantKey.deleteMany(where);
  for (const e of extras) {
    if (e.memberId) {
      await f.platform.memberRole.deleteMany({ where: { tenantId: f.tenantId, memberId: e.memberId } });
      await f.platform.member.deleteMany({ where: { tenantId: f.tenantId, id: e.memberId } });
    }
    await f.platform.user.deleteMany({ where: { id: e.userId } });
  }
  resetTenantDekCache();
  await f.cleanup();
}, 120_000);

describe("the first run", () => {
  it("sends each due row's smallest band to C53's people, logins as a count (C56), and records each", async () => {
    const run = await sendExpirationReminders(f.tenantId, at(0));
    expect(run).toEqual({ assets: 6, agreements: 3, logins: 3 });
    const { owner: o, manager: m, employee: e, admin: a } = f.seats;

    // A project's asset → that project's people (the employee), never the owners too.
    expect(await receiversOf("expiration.asset_due", ids["p1Hosting"]!)).toEqual([e.memberId]);
    const [hosting] = await notes("expiration.asset_due", ids["p1Hosting"]!);
    // 10 days out: 14, never 60 or 30. The employee holds `client:view`: the asset's own line.
    expect(hosting!.params).toEqual({ clientId: acme, assetId: ids["p1Hosting"], days: "14", link: "asset" });
    expect(hosting!.projectId).toBe(p1);
    // A client-level asset → the directly assigned (the manager) only.
    expect(await receiversOf("expiration.asset_due", ids["acmeDomain"]!)).toEqual([m.memberId]);
    // A project with only a lead → the lead.
    expect(await receiversOf("expiration.asset_due", ids["p3Site"]!)).toEqual([m.memberId]);
    // P2: its assignee holds nothing and its lead is not on P2 → the owners.
    expect(await receiversOf("expiration.asset_due", ids["p2App"]!)).toEqual([o.memberId]);
    expect(P((await notes("expiration.asset_due", ids["p2App"]!))[0]!)["days"]).toBe("60");
    // Nobody assigned to Beta → the owners; one day out is the 1-day band.
    expect(await receiversOf("expiration.asset_due", ids["betaDomain"]!)).toEqual([o.memberId]);
    expect(P((await notes("expiration.asset_due", ids["betaDomain"]!))[0]!)["days"]).toBe("1");

    // C55: the END of an agreement, to the same people as an asset — the
    // directly assigned manager linked to the Agreements tab, the employee
    // (on one project) to Renewals.
    expect(await receiversOf("expiration.agreement_ending", ids["launch"]!)).toEqual([m.memberId]);
    expect((await notes("expiration.agreement_ending", ids["launch"]!))[0]!.params).toEqual({
      clientId: acme,
      serviceId: ids["launch"],
      days: "7",
      link: "agreements",
    });
    expect(await receiversOf("expiration.agreement_ending", ids["p1Support"]!)).toEqual([e.memberId]);
    expect(P((await notes("expiration.agreement_ending", ids["p1Support"]!))[0]!)["link"]).toBe("renewals");

    // Without `client:view` no client page opens: both mails go to Renewals.
    expect(await receiversOf("expiration.asset_due", ids["deltaDomain"]!)).toEqual([noClient]);
    expect(P((await notes("expiration.asset_due", ids["deltaDomain"]!))[0]!)["link"]).toBe("renewals");
    expect(await receiversOf("expiration.agreement_ending", ids["deltaEnd"]!)).toEqual([noClient]);
    expect(P((await notes("expiration.agreement_ending", ids["deltaEnd"]!))[0]!)["link"]).toBe("renewals");

    // C56: Acme's two logins in the 14-day band — everyone who can open them,
    // each told how many THEY reach. The employee reaches P1's login only
    // (a client-level login is for direct assignment), the rest both.
    const acmeLogins = await notes("expiration.logins_expiring", acme);
    expect(Object.fromEntries(acmeLogins.map((n) => [n.receiverId, P(n)["count"]]))).toEqual({
      [o.memberId]: "2",
      [a.memberId]: "2",
      [m.memberId]: "2",
      [e.memberId]: "1",
    });
    for (const n of acmeLogins) {
      expect(n.entityType).toBe("Client");
      expect(Object.keys(n.params as object).sort()).toEqual(["clientId", "count", "days", "from"]);
      expect(P(n)["from"]).toBe(TODAY); // the tenant's day the job decided on
      expect(P(n)["days"]).toBe("14");
    }
    // Gamma's login: its directly assigned employee too.
    expect((await notes("expiration.logins_expiring", gamma)).map((n) => n.receiverId).sort()).toEqual(
      [o.memberId, a.memberId, m.memberId, gammaDirect].sort(),
    );
    // Our own login: tenant-wide scope only (C49), never the employee.
    const ours = await notes("expiration.logins_expiring", f.tenantId);
    expect(ours.map((n) => n.receiverId).sort()).toEqual([o.memberId, a.memberId, m.memberId].sort());
    for (const n of ours) {
      expect(n.entityType).toBe("Tenant");
      expect(n.params).toEqual({ count: "1", days: "30", from: TODAY });
    }
    // Nothing about a login names it — not the notification, not the mail, not the audit.
    const everything = JSON.stringify([
      await notes("expiration.logins_expiring"),
      await f.platform.emailOutbox.findMany({ where: { tenantId: f.tenantId }, select: { params: true } }),
      await f.audits("expiration.reminder_sent"),
    ]);
    for (const secret of [SECRET_LOGIN_NAME, "P1 ftp", "Our registrar", "Gamma admin", ids["acmeLogin"]!, ids["p1Login"]!, ids["ours"]!, ids["gammaLogin"]!]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("queues one mail per notification, and audits one row per reminder", async () => {
    const all = await f.platform.notification.findMany({ where: { tenantId: f.tenantId, kind: { startsWith: "expiration." } } });
    expect(all).toHaveLength(20); // nine subjects to one person each, and 4 + 3 + 4 for logins
    const mail = await f.platform.emailOutbox.findMany({
      where: { tenantId: f.tenantId, kind: { startsWith: "expiration." } },
      select: { receiverId: true, kind: true, toEmail: true },
    });
    expect(mail).toHaveLength(20);
    expect(mail.every((r) => r.toEmail.endsWith("@test.invalid"))).toBe(true);

    const audits = await f.audits("expiration.reminder_sent");
    expect(audits).toHaveLength(12); // nine subjects + three login groups
    expect(audits.every((x) => x.actorType === "SYSTEM")).toBe(true);
    expect(audits.find((x) => x.targetId === ids["p1Hosting"])?.metadata).toEqual({ offsetDays: 14, dueOn: iso(10), receivers: 1 });
    expect(audits.find((x) => x.targetType === "Client" && x.targetId === acme)?.metadata).toEqual({
      subject: "CredentialItem",
      offsetDays: 14,
      logins: 2,
      receivers: 4,
    });
    expect(audits.find((x) => x.targetType === "Tenant")?.metadata).toMatchObject({ logins: 1, receivers: 3, offsetDays: 30 });

    const dedupe = await f.platform.expirationReminderSent.findMany({ where: { tenantId: f.tenantId } });
    expect(dedupe).toHaveLength(13); // per subject, and per LOGIN
    const row = dedupe.find((r) => r.subjectId === ids["p1Hosting"])!;
    expect(row).toMatchObject({ subjectType: "ClientAsset", offsetDays: 14 });
    expect(row.dueOn.toISOString().slice(0, 10)).toBe(iso(10));
  });

  it("sends nothing for a renewal (C55), an ended agreement, a lapsed or retired date, or one past the horizon", async () => {
    for (const key of ["retainer", "ended", "lapsed", "far", "retired", "p1Far", "g1Far"]) {
      expect(await f.platform.notification.count({ where: { tenantId: f.tenantId, entityId: ids[key]! } }), key).toBe(0);
      expect(await f.platform.expirationReminderSent.count({ where: { tenantId: f.tenantId, subjectId: ids[key]! } }), key).toBe(0);
    }
  });
});

describe("later runs", () => {
  it("a second run the same day sends nothing", async () => {
    const before = await f.platform.notification.count({ where: { tenantId: f.tenantId } });
    expect(await sendExpirationReminders(f.tenantId, at(0))).toEqual({ assets: 0, agreements: 0, logins: 0 });
    expect(await f.platform.notification.count({ where: { tenantId: f.tenantId } })).toBe(before);
  });

  it("two runs at once send the next band once; the passed day's rows are swept", async () => {
    // Day 3: the hosting is 7 days out (band 7) and far.se — 61 days out on
    // day 0, past the horizon — has entered the 60-day band; everything
    // else's band was sent. beta.se's day (day 1) is now before yesterday,
    // so its row is swept.
    await f.platform.expirationReminderSent.create({
      data: { tenantId: f.tenantId, subjectType: "ClientAsset", subjectId: randomUUID(), dueOn: day(-5), offsetDays: 1 },
    });
    const [a, b] = await Promise.all([sendExpirationReminders(f.tenantId, at(3)), sendExpirationReminders(f.tenantId, at(3))]);
    expect(a.assets + b.assets).toBe(2);
    expect(a.agreements + b.agreements + a.logins + b.logins).toBe(0);
    expect((await notes("expiration.asset_due", ids["p1Hosting"]!)).map((n) => P(n)["days"])).toEqual(["14", "7"]);
    expect((await notes("expiration.asset_due", ids["far"]!)).map((n) => P(n)["days"])).toEqual(["60"]);
    expect(await f.platform.expirationReminderSent.count({ where: { tenantId: f.tenantId, dueOn: { lt: day(2) } } })).toBe(0);
  });

  it("a row added inside a band gets that band only; a re-dated row re-arms", async () => {
    ids["lateCert"] = (await createAsset(owner(), { clientId: acme, projectId: p1, type: "SSL_CERT", name: "late-cert", expiresAt: day(13) })).id;
    // acme.se renewed: its new date has sent nothing yet.
    await updateAsset(owner(), ids["acmeDomain"]!, { expiresAt: day(40) });
    expect(await sendExpirationReminders(f.tenantId, at(3))).toEqual({ assets: 2, agreements: 0, logins: 0 });
    const late = await f.platform.expirationReminderSent.findMany({ where: { tenantId: f.tenantId, subjectId: ids["lateCert"]! } });
    expect(late.map((r) => r.offsetDays)).toEqual([14]); // 10 days out: never 60 or 30 after the fact
    expect((await notes("expiration.asset_due", ids["acmeDomain"]!)).map((n) => P(n)["days"])).toEqual(["30", "60"]); // 37 days out
  });

  it("with the vault module off, assets and logins wait unrecorded — agreements (core) still go, linked where each reader can go", async () => {
    ids["betaIo"] = (await createAsset(owner(), { clientId: beta, type: "DOMAIN", name: "beta.io", expiresAt: day(9) })).id;
    ids["betaLogin"] = (
      await createCredential(owner(), { clientId: beta, type: "LOGIN", name: "Beta admin", secret: { password: "p" }, expiresAt: day(9) })
    ).id;
    await service("betaEnd", { name: "Beta wind-down", endsAt: day(9) }, beta);
    await service("p1Deal", { name: "P1 hosting deal", projectId: p1, endsAt: day(12) });
    await setModuleEnabled(owner(), "vault", false);
    try {
      expect(await sendExpirationReminders(f.tenantId, at(3))).toEqual({ assets: 0, agreements: 2, logins: 0 });
      for (const key of ["betaIo", "betaLogin"]) {
        expect(await f.platform.expirationReminderSent.count({ where: { tenantId: f.tenantId, subjectId: ids[key]! } }), key).toBe(0);
      }
      // Beta has nobody → the owner, whose scope is tenant-wide: the Agreements tab.
      expect(await receiversOf("expiration.agreement_ending", ids["betaEnd"]!)).toEqual([f.seats.owner.memberId]);
      expect(P((await notes("expiration.agreement_ending", ids["betaEnd"]!))[0]!)["link"]).toBe("agreements");
      // The employee, on one project, with Renewals closed with the module → the inbox.
      expect(await receiversOf("expiration.agreement_ending", ids["p1Deal"]!)).toEqual([f.seats.employee.memberId]);
      expect(P((await notes("expiration.agreement_ending", ids["p1Deal"]!))[0]!)["link"]).toBe("inbox");
    } finally {
      await setModuleEnabled(owner(), "vault", true);
    }
    expect(await sendExpirationReminders(f.tenantId, at(3))).toEqual({ assets: 1, agreements: 0, logins: 1 });
    expect(await receiversOf("expiration.asset_due", ids["betaIo"]!)).toEqual([f.seats.owner.memberId]);
  });

  it("today is the TENANT's day: at 22:30 UTC it is already tomorrow in Stockholm", async () => {
    ids["zoneEdge"] = (await createAsset(owner(), { clientId: acme, projectId: p1, type: "HOSTING", name: "zone-edge", expiresAt: day(18) })).id;
    expect(await sendExpirationReminders(f.tenantId, at(3))).toEqual({ assets: 1, agreements: 0, logins: 0 }); // 15 days: band 30
    // 22:30 UTC on day 3 is 00:30 on day 4 in Stockholm: zone-edge is 14 days
    // out (band 14) and Acme launch 1 day (band 1). By the UTC day — still
    // day 3 — neither would be due.
    const lateEvening = new Date(day(3).getTime() + 22.5 * 3_600_000);
    expect(await sendExpirationReminders(f.tenantId, lateEvening)).toEqual({ assets: 1, agreements: 1, logins: 0 });
    expect((await notes("expiration.asset_due", ids["zoneEdge"]!)).map((n) => P(n)["days"])).toEqual(["30", "14"]);
    expect((await notes("expiration.agreement_ending", ids["launch"]!)).map((n) => P(n)["days"])).toEqual(["7", "1"]);
  });
});

describe("the inbox names only what the reader may see now", () => {
  const rowsOf = async (memberId: string, impersonated = false) =>
    (
      await listInbox(
        { tenantId: f.tenantId, actor: { ...actorFor(memberId), ...(impersonated ? { impersonated: true } : {}) } },
        { filter: "all" },
      )
    ).rows.filter((r) => r.kind?.startsWith("expiration."));
  const find = (rows: readonly InboxRow[], kind: string, title: string) => rows.find((r) => r.kind === kind && r.subject?.title === title);

  it("the employee: their asset, their agreement (linked to Renewals — not directly assigned), and ONE login of Acme's two", async () => {
    const rows = await rowsOf(f.seats.employee.memberId);
    const hosting = rows.filter((r) => r.kind === "expiration.asset_due" && r.subject?.title === "p1-hosting");
    expect(hosting.map((r) => r.reminder?.days).sort()).toEqual([14, 7]);
    expect(hosting[0]!.subject!.href).toBe(`/clients/${acme}/assets#asset-${ids["p1Hosting"]}`);
    expect(find(rows, "expiration.agreement_ending", "P1 support")?.subject?.href).toBe("/expirations");
    const logins = find(rows, "expiration.logins_expiring", "Acme");
    expect(logins?.subject?.href).toBe(`/clients/${acme}/vault`);
    expect(logins?.reminder).toEqual({ days: 14, count: 1 });
  });

  it("the manager: Acme's logins as two, our own by the workspace's name, the agreement on its own tab", async () => {
    const rows = await rowsOf(f.seats.manager.memberId);
    expect(find(rows, "expiration.logins_expiring", "Acme")?.reminder).toEqual({ days: 14, count: 2 });
    const tenant = await f.platform.tenant.findUniqueOrThrow({ where: { id: f.tenantId }, select: { name: true } });
    const ours = find(rows, "expiration.logins_expiring", tenant.name);
    expect(ours?.subject?.href).toBe("/vault?client=agency");
    expect(ours?.reminder).toEqual({ days: 30, count: 1 });
    expect(find(rows, "expiration.agreement_ending", "Acme launch")?.subject?.href).toBe(`/clients/${acme}/agreements`);
  });

  it("a login deleted since lowers the count to what could still have been in it — a far one does not count", async () => {
    // Acme's 14-day reminder told the manager of two; the client-level one is
    // gone now. P1's far login (day 200) is reachable but could never have
    // been in a 14-day reminder sent on day 0.
    await f.platform.credentialItem.update({ where: { id: ids["acmeLogin"]! }, data: { deletedAt: new Date() } });
    expect(find(await rowsOf(f.seats.manager.memberId), "expiration.logins_expiring", "Acme")?.reminder).toEqual({ days: 14, count: 1 });
  });

  it("without `client:view`: named, and linked to Renewals rather than a client page — the feed's rows too", async () => {
    const rows = await rowsOf(noClient);
    expect(find(rows, "expiration.asset_due", "delta.se")?.subject?.href).toBe("/expirations");
    expect(find(rows, "expiration.agreement_ending", "Delta care")?.subject?.href).toBe("/expirations");
    const feed = await expirationsFeed({ tenantId: f.tenantId, actor: actorFor(noClient) }, TODAY);
    const deltaRows = feed.entries.filter((e) => e.client.name === "Delta");
    expect(deltaRows.map((e) => `${e.kind}|${e.name}|${e.linkable}`).sort()).toEqual(["agreementEnds|Delta care|false", "asset|delta.se|false"]);
    expect(feed.clientPages).toBe(false);
  });

  it("under impersonation the login rows name nothing and count nothing; the asset rows still read", async () => {
    const rows = await rowsOf(f.seats.manager.memberId, true);
    const logins = rows.filter((r) => r.kind === "expiration.logins_expiring");
    expect(logins.length).toBeGreaterThan(0);
    expect(logins.every((r) => r.subject === null && r.reminder === null)).toBe(true);
    expect(rows.some((r) => r.kind === "expiration.asset_due" && r.subject !== null)).toBe(true);
  });

  it("a reader moved from the client to one of its projects no longer sees the client's login row (the security review's low)", async () => {
    expect(find(await rowsOf(gammaDirect), "expiration.logins_expiring", "Gamma")?.reminder).toEqual({ days: 14, count: 1 });
    // Still on G1, no longer on Gamma itself: the client-level login is out of reach.
    await f.platform.memberClient.deleteMany({ where: { tenantId: f.tenantId, memberId: gammaDirect } });
    const rows = await rowsOf(gammaDirect);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.subject === null && r.reminder === null)).toBe(true);
  });

  it("a reader taken off the project keeps the rows, with no name, no link and no numbers", async () => {
    await f.platform.memberProject.deleteMany({ where: { tenantId: f.tenantId, memberId: f.seats.employee.memberId } });
    const rows = await rowsOf(f.seats.employee.memberId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.subject === null && r.reminder === null)).toBe(true);
  });
});

describe("the url CHECKs this slice tightened (migration 20261003180000)", () => {
  it("refuse a user before the host after extra slashes, a backslash or a tab — on both tables — and keep a path @", async () => {
    const asset = (url: string) => sys((tx) => tx.clientAsset.update({ where: { id: ids["far"]! }, data: { url }, select: { id: true } }));
    const login = (url: string) => sys((tx) => tx.credentialItem.update({ where: { id: ids["p1Far"]! }, data: { url }, select: { id: true } }));
    for (const bad of ["https:///u:p@acme.se", "https://a\\@acme.se", "https://\t/u:p@acme.se", "https://u:p@acme.se"]) {
      await expect(asset(bad), bad).rejects.toThrow(/client_asset_url_http/);
      await expect(login(bad), bad).rejects.toThrow(/credential_item_url_http/);
    }
    await expect(asset("https://medium.com/@acme")).resolves.toBeTruthy();
    await expect(login("https://acme.se/login?u=a@b.se")).resolves.toBeTruthy();
  });
});
