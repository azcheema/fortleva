import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { expirationsFeed, expirationsGlance, sendExpirationReminders } from "@/modules/vault";
import { listInbox } from "@/notify/inbox";
import { resolvePortalModuleGates, withCensusWrite, type PortalPrincipal } from "@/portal";
import { setModuleEnabled } from "@/preferences/service";
import { LocalDiskTransport, setStorage } from "@/storage";

import { readContract, startContract, updateContractDraft } from "./drafts";
import { sendContract, withdrawContract } from "./send";
import { commitContractUpload, deleteUploadedContract, presignContractUpload, updateUploadedContract } from "./uploads";

/**
 * A SIGNED CONTRACT'S END ON RENEWALS AND IN THE REMINDERS, against the real
 * database and app_runtime (Phase 4 slice 112c2; founder decisions C86 (c),
 * (e); migration 20261015090000; the design: docs/research/2026-10-10-slice-
 * 112-contracts-design.md §15):
 *   - the 60/30/14/7/1-day reminders for a SIGNED contract with an end date —
 *     written and signed, or signed elsewhere and put in — to the client's
 *     DIRECTLY assigned people and the owners, each held to `contract:view`
 *     on all four gates and to direct scope; never a draft's, a sent, a
 *     declined or a withdrawn one's;
 *     once per band; an edited end date re-arms; the module off sends and
 *     records nothing;
 *   - the inbox naming it only while the reader may open its page;
 *   - Renewals listing it, an ended one for 30 days after its end (C86 (e)).
 *
 * It calls the per-tenant `sendExpirationReminders` ONLY — never the job's
 * cross-tenant run (AGENTS.md: never write outside a throwaway tenant). The
 * clock is passed in: "today" is 2031-06-15 in the tenant's zone
 * (Europe/Stockholm), runs at 10:00 UTC. CI-only in practice, like the other
 * contract dbtests: `contract:view` comes with the TV16 catalogue seed.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let beta: string;
let pa: string;
let eva: string; // acme, main contact, in the portal — the written contract's signer
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;
/** A custom role with `contract:view` and `asset:view` but no tenant-wide scope, assigned to Acme directly. */
let direct: string;
/** The same role, on Acme's project only — Acme is LIFTED for them, never direct. */
let viaProject: string;
/** Members this file creates beyond the fixture's seats — recorded the moment each user exists. */
const extras: { userId: string; memberId: string | null }[] = [];
const ids: Record<string, string> = {};
const storageDir = mkdtempSync(join(tmpdir(), "fortleva-contract-reminders-"));
let storage: LocalDiskTransport;

const TODAY = "2031-06-15";
const DAY = 86_400_000;
const day = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * DAY);
const iso = (n: number) => day(n).toISOString().slice(0, 10);
/** A run on day `n` at 10:00 UTC (12:00 in Stockholm). */
const at = (n: number) => new Date(day(n).getTime() + 10 * 3_600_000);

const ctxOf = (memberId: string) => ({ tenantId: f.tenantId, actor: actorFor(memberId) });
const manager = () => ctxOf(f.seats.manager.memberId);
const owner = () => ctxOf(f.seats.owner.memberId);
const P = (n: { params: unknown }) => n.params as Record<string, string>;
const run = (n = 0) => sendExpirationReminders(f.tenantId, at(n));
const KIND = "expiration.contract_ending";
/** The dedupe table's subject CHECK, by name — matched in the error's META only (the code-frame trap). */
const SUBJECT_CHECK = "expiration_reminder_sent_subject_type";

const notes = (entityId: string) =>
  f.platform.notification.findMany({
    where: { tenantId: f.tenantId, kind: KIND, entityId },
    select: { receiverId: true, entityType: true, params: true, clientId: true, projectId: true, reason: true },
    orderBy: { id: "asc" },
  });
const receiversOf = async (entityId: string) => [...new Set((await notes(entityId)).map((n) => n.receiverId))].sort();

async function extraMember(roleId: string, label: string): Promise<string> {
  const userId = randomUUID();
  await f.platform.user.create({ data: { id: userId, name: label, email: `${label}-ctrremind-${userId.slice(0, 8)}@test.invalid` } });
  const entry: { userId: string; memberId: string | null } = { userId, memberId: null };
  extras.push(entry);
  const member = await f.platform.member.create({ data: { tenantId: f.tenantId, userId }, select: { id: true } });
  entry.memberId = member.id;
  await f.platform.memberRole.create({ data: { tenantId: f.tenantId, memberId: member.id, roleId } });
  return member.id;
}

const pdf = (text: string) => new Uint8Array(Buffer.from(`%PDF-1.4\n% ${text}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`, "latin1"));

/** A contract signed elsewhere, put in through all three steps by the manager — its id. */
async function putIn(clientId: string, title: string, endsOn: string | null): Promise<string> {
  const bytes = pdf(title);
  const ticket = await presignContractUpload(manager(), {
    clientId,
    fileName: "signed.pdf",
    contentType: "application/pdf",
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  const key = new URL(ticket.uploadUrl, "http://localhost").pathname
    .replace(/^\/api\/dev-storage\//, "")
    .split("/")
    .map(decodeURIComponent)
    .join("/");
  const res = await storage.handlePut(
    new Request(new URL(ticket.uploadUrl, "http://localhost"), { method: "PUT", headers: { ...ticket.headers }, body: Buffer.from(bytes) }),
    key,
  );
  expect(res.status).toBe(200);
  const { id } = await commitContractUpload(manager(), {
    fileObjectId: ticket.fileObjectId,
    clientId,
    title,
    signedOn: "2024-03-01",
    startsOn: "2024-03-01",
    endsOn: endsOn ?? "",
  });
  return id;
}

const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

/** A written contract for Acme, ending on `endsOn`: a draft, sent if `send`. */
async function written(title: string, endsOn: string, send: boolean): Promise<string> {
  const { id } = await startContract(manager(), { clientId: acme, templateId: null, title, signerContactId: eva });
  await updateContractDraft(manager(), id, { body: doc("Scope: a website."), endsOn });
  if (send) await sendContract(manager(), id, { seen: (await readContract(manager(), id)).updatedAt.toISOString(), typedName: "Maja Manager" });
  return id;
}

/** The signer decides their own row, under their own principal — the census write. */
const decide = (contractId: string, status: "SIGNED" | "DECLINED") => {
  const principal: PortalPrincipal = { contactId: eva, tenantId: f.tenantId, clientId: acme, gates };
  const typedName = status === "SIGNED" ? "Eva Ek" : null;
  return withCensusWrite(principal, (tx) =>
    tx.$executeRaw`
      UPDATE contract_signature
         SET status = ${status}::signature_status, typed_name = ${typedName}, decided_at = now(),
             ip = '203.0.113.7', user_agent = 'Mozilla/5.0 (test)'
       WHERE contract_id = ${contractId} AND party = 'CLIENT'`,
  );
};

beforeAll(async () => {
  f = await setupTenant("ctrremind");
  storage = new LocalDiskTransport(storageDir);
  setStorage(storage);
  gates = await resolvePortalModuleGates(f.tenantId);
  [acme, beta, pa, eva] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: "Acme AB", orgNr: "556677-8899", addressLine1: "Storgatan 1", postalCode: "111 22", city: "Stockholm", countryCode: "SE" },
      { id: beta, tenantId: f.tenantId, name: "Beta AB" },
    ],
  });
  await f.platform.project.create({ data: { id: pa, tenantId: f.tenantId, clientId: acme, key: "CRA", name: "Acme site" } });
  await f.platform.contact.create({
    data: {
      id: eva,
      tenantId: f.tenantId,
      clientId: acme,
      name: "Eva Ek",
      email: `ctrremind-eva-${randomUUID().slice(0, 8)}@test.invalid`,
      portalProfile: "CONTACT_PRIMARY",
      portalStatus: "ACTIVE",
      invitedAt: new Date("2026-09-01T09:00:00Z"),
      emailVerified: true,
    },
  });
  await f.platform.tenant.update({
    where: { id: f.tenantId },
    data: { legalName: "Remind Konsult AB", orgNr: "556016-0680", addressLine1: "Kungsgatan 2", postalCode: "411 19", city: "Göteborg", countryCode: "SE" },
  });

  // The manager is assigned to Acme directly (and sees every client: the
  // seat holds `client:view_all`); the employee is assigned to Acme directly
  // but holds no `contract:view`; the admin sees every client and is
  // assigned to nobody — not one of Acme's people, not an owner.
  await f.platform.memberClient.createMany({
    data: [
      { tenantId: f.tenantId, memberId: f.seats.manager.memberId, clientId: acme },
      { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId: acme },
    ],
  });
  const role = await f.platform.role.create({ data: { tenantId: f.tenantId, name: "Contracts reader" }, select: { id: true } });
  const codes = await f.platform.permission.findMany({ where: { code: { in: ["contract:view", "asset:view"] } }, select: { id: true } });
  expect(codes).toHaveLength(2);
  await f.platform.rolePermission.createMany({
    data: codes.map((c) => ({ tenantId: f.tenantId, roleId: role.id, permissionId: c.id, source: "TENANT_GRANT" as const })),
  });
  direct = await extraMember(role.id, "direct");
  await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: direct, clientId: acme } });
  viaProject = await extraMember(role.id, "viaproject");
  await f.platform.memberProject.create({ data: { tenantId: f.tenantId, memberId: viaProject, projectId: pa } });

  ids["uploaded"] = await putIn(acme, "Support agreement", iso(10)); // band 14
  ids["today"] = await putIn(acme, "Ends today", iso(0)); // band 1 — the window's lower edge
  ids["noEnd"] = await putIn(acme, "Open-ended deal", null);
  ids["beta"] = await putIn(beta, "Beta retainer", iso(20)); // band 30; nobody assigned
  ids["lapsed30"] = await putIn(acme, "Ended a month ago", iso(-30));
  ids["lapsed31"] = await putIn(acme, "Ended long ago", iso(-31));
  ids["signed"] = await written("Web build", iso(30), true); // band 30, once signed
  expect(await decide(ids["signed"]!, "SIGNED")).toBe(1);
  ids["sent"] = await written("Waiting for Eva", iso(5), true); // SENT, never signed
  ids["draft"] = await written("Still a draft", iso(5), false);
  ids["declined"] = await written("Turned down", iso(5), true);
  expect(await decide(ids["declined"]!, "DECLINED")).toBe(1);
  ids["withdrawn"] = await written("Taken back", iso(5), true);
  await withdrawContract(manager(), ids["withdrawn"]!);
  const statuses = await f.platform.contract.findMany({ where: { tenantId: f.tenantId }, select: { id: true, status: true } });
  expect(Object.fromEntries(statuses.map((s) => [s.id, s.status]))).toMatchObject({
    [ids["signed"]!]: "SIGNED",
    [ids["sent"]!]: "SENT",
    [ids["draft"]!]: "DRAFT",
    [ids["declined"]!]: "DECLINED",
    [ids["withdrawn"]!]: "WITHDRAWN",
  });
}, 240_000);

afterAll(async () => {
  setStorage(null);
  if (!f) return;
  const where = { where: { tenantId: f.tenantId } };
  await f.deleteInvoices(); // contracts, their signatures and PDFs (slice 112)
  await f.platform.fileObject.deleteMany(where); // the placeholders
  await f.platform.emailOutbox.deleteMany(where);
  await f.platform.notification.deleteMany(where);
  await f.platform.expirationReminderSent.deleteMany(where);
  await f.platform.contact.deleteMany(where);
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
  await f.cleanup();
}, 180_000);

describe("the module off (the first run)", () => {
  it("sends and records nothing while nobody can hold `contract:view` — then the next run sends", async () => {
    await setModuleEnabled(owner(), "contracts", false);
    try {
      expect(await run()).toEqual({ assets: 0, agreements: 0, contracts: 0, logins: 0 });
      expect(await f.platform.expirationReminderSent.count({ where: { tenantId: f.tenantId, subjectType: "Contract" } })).toBe(0);
      // …and Renewals has no contract row for anyone.
      const feed = await expirationsFeed(owner(), TODAY);
      expect(feed.entries.filter((e) => e.kind === "contractEnds")).toEqual([]);
    } finally {
      await setModuleEnabled(owner(), "contracts", true);
    }
  });
});

describe("the reminders (C86 (c))", () => {
  it("a SIGNED contract's smallest band, to the client's direct people and the owners — put in or written and signed", async () => {
    expect(await run()).toEqual({ assets: 0, agreements: 0, contracts: 4, logins: 0 });
    const { owner: o, manager: m } = f.seats;

    // Acme's: the manager and the custom role's member (directly assigned,
    // `contract:view`) and the owner — never the employee (no code), the
    // member on Acme's project only (lifted, not direct), nor the admin.
    expect(await receiversOf(ids["uploaded"]!)).toEqual([direct, m.memberId, o.memberId].sort());
    const [n] = (await notes(ids["uploaded"]!)).filter((x) => x.receiverId === direct);
    expect(P(n!)).toEqual({ clientId: acme, contractId: ids["uploaded"], days: "14", link: "contract" });
    expect([n!.entityType, n!.clientId, n!.projectId, n!.reason]).toEqual(["Contract", acme, null, "CLIENT_MEMBER"]);
    expect((await notes(ids["uploaded"]!)).find((x) => x.receiverId === o.memberId)?.reason).toBe("OWNER");

    // Ending TODAY is inside the 1-day band.
    expect(await receiversOf(ids["today"]!)).toEqual([direct, m.memberId, o.memberId].sort());
    expect((await notes(ids["today"]!)).every((x) => P(x)["days"] === "1")).toBe(true);

    // Written in Fortleva and signed: the same people, band 30.
    expect(await receiversOf(ids["signed"]!)).toEqual([direct, m.memberId, o.memberId].sort());
    expect((await notes(ids["signed"]!)).every((x) => P(x)["days"] === "30")).toBe(true);
    // Beta has nobody: the owner (C57).
    expect(await receiversOf(ids["beta"]!)).toEqual([o.memberId]);

    // Never one nobody signed, one with no end, or an end already passed.
    for (const key of ["sent", "draft", "declined", "withdrawn", "noEnd", "lapsed30", "lapsed31"]) {
      expect(await notes(ids[key]!), key).toEqual([]);
    }
    // Recorded under the widened CHECK, and audited.
    const sent = await f.platform.expirationReminderSent.findMany({
      where: { tenantId: f.tenantId, subjectType: "Contract" },
      select: { subjectId: true, offsetDays: true, dueOn: true },
    });
    expect(sent.map((r) => `${r.subjectId}|${r.offsetDays}|${r.dueOn.toISOString().slice(0, 10)}`).sort()).toEqual(
      [`${ids["uploaded"]}|14|${iso(10)}`, `${ids["today"]}|1|${iso(0)}`, `${ids["signed"]}|30|${iso(30)}`, `${ids["beta"]}|30|${iso(20)}`].sort(),
    );
    const audits = (await f.audits("expiration.reminder_sent")).filter((a) => a.targetType === "Contract");
    expect(audits.map((a) => a.targetId).sort()).toEqual([ids["uploaded"], ids["today"], ids["signed"], ids["beta"]].sort());
  });

  it("the dedupe table's CHECK takes a Contract and still refuses a subject it does not know", async () => {
    const insert = (subjectType: string) =>
      f.platform.expirationReminderSent.create({
        data: { tenantId: f.tenantId, subjectType, subjectId: randomUUID(), dueOn: day(40), offsetDays: 60 },
        select: { subjectId: true },
      });
    const meta = async (p: Promise<unknown>): Promise<string> => {
      try {
        await p;
        return "ok";
      } catch (e) {
        return JSON.stringify((e as { meta?: unknown })?.meta ?? null);
      }
    };
    expect(await meta(insert("Contract"))).toBe("ok");
    expect(await meta(insert("Invoice"))).toContain(SUBJECT_CHECK);
    await f.platform.expirationReminderSent.deleteMany({ where: { tenantId: f.tenantId, dueOn: day(40) } });
  });

  it("once per band: the same day again sends nothing", async () => {
    expect(await run()).toEqual({ assets: 0, agreements: 0, contracts: 0, logins: 0 });
  });

  it("an end date edited re-arms: the new day's band goes out", async () => {
    await updateUploadedContract(manager(), ids["uploaded"]!, {
      title: "Support agreement",
      signedOn: "2024-03-01",
      startsOn: "2024-03-01",
      endsOn: iso(6),
    });
    expect(await run()).toEqual({ assets: 0, agreements: 0, contracts: 1, logins: 0 });
    expect((await notes(ids["uploaded"]!)).filter((x) => x.receiverId === direct).map((x) => P(x)["days"])).toEqual(["14", "7"]);
  });

  it("a contract deleted: nothing more is sent, and its inbox rows name nothing", async () => {
    // Day 10: Beta's contract (day 20) enters the 14-day band; delete it first.
    await deleteUploadedContract(manager(), ids["beta"]!);
    expect(await run(10)).toMatchObject({ contracts: 0 });
    const rows = (await listInbox(owner(), { filter: "all" })).rows.filter((r) => r.kind === KIND);
    // The one row Beta's reminder left the owner: no name, no link, and no
    // band either — an unresolved reminder takes the kind's own label.
    const beta = rows.filter((r) => r.subject === null);
    expect(beta).toHaveLength(1);
    expect(beta[0]!.reminder).toBeNull();
  });
});

describe("the inbox names it only while the reader may open its page", () => {
  const rowsOf = async (memberId: string) => (await listInbox(ctxOf(memberId), { filter: "all" })).rows.filter((r) => r.kind === KIND);

  it("named by its title and client, linked to its page, with its band", async () => {
    const rows = await rowsOf(direct);
    const uploaded = rows.filter((r) => r.subject?.title === "Support agreement · Acme AB");
    expect(uploaded.map((r) => r.reminder?.days).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([7, 14]);
    expect(uploaded.every((r) => r.subject?.href === `/contracts/${ids["uploaded"]}`)).toBe(true);
    expect(rows.find((r) => r.subject?.title === "Web build · Acme AB")?.reminder).toEqual({ days: 30, count: null });
  });

  it("the contracts module switched off since: the rows stay and name nothing — then name it again", async () => {
    await setModuleEnabled(owner(), "contracts", false);
    try {
      const rows = await rowsOf(direct);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.subject === null && r.reminder === null)).toBe(true);
    } finally {
      await setModuleEnabled(owner(), "contracts", true);
    }
    expect((await rowsOf(direct)).some((r) => r.subject?.title === "Support agreement · Acme AB")).toBe(true);
  });

  it("moved off the client (to its project only): the rows stay and name nothing", async () => {
    await f.platform.memberClient.deleteMany({ where: { tenantId: f.tenantId, memberId: direct, clientId: acme } });
    await f.platform.memberProject.create({ data: { tenantId: f.tenantId, memberId: direct, projectId: pa } });
    try {
      const rows = await rowsOf(direct);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.subject === null && r.reminder === null)).toBe(true);
    } finally {
      await f.platform.memberProject.deleteMany({ where: { tenantId: f.tenantId, memberId: direct, projectId: pa } });
      await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: direct, clientId: acme } });
    }
  });
});

describe("Renewals (C86 (e))", () => {
  const contractsOn = async (memberId: string) =>
    (await expirationsFeed(ctxOf(memberId), TODAY)).entries.filter((e) => e.kind === "contractEnds");

  it("a signed contract's end, coming or passed up to 30 days ago — linked to its page; never one unsigned, never day 31", async () => {
    const rows = await contractsOn(f.seats.owner.memberId);
    expect(rows.map((e) => `${e.name}|${e.date}|${e.client.name}|${e.linkable}`)).toEqual([
      `Ended a month ago|${iso(-30)}|Acme AB|true`,
      `Ends today|${iso(0)}|Acme AB|true`,
      `Support agreement|${iso(6)}|Acme AB|true`,
      `Web build|${iso(30)}|Acme AB|true`,
    ]);
    expect(rows.every((e) => e.project === null && e.assetType === null)).toBe(true);
  });

  it("the Home card: only ends still to come — an ended contract is the page's note, never the card's", async () => {
    const glance = await expirationsGlance(owner(), TODAY);
    expect(glance?.entries.filter((e) => e.kind === "contractEnds").map((e) => e.name)).toEqual([
      "Ends today",
      "Support agreement",
      "Web build",
    ]);
  });

  it("to a member of the client's project only, nothing of the client's contracts", async () => {
    expect(await contractsOn(viaProject)).toEqual([]);
    expect((await contractsOn(direct)).map((e) => e.name)).toEqual(["Ended a month ago", "Ends today", "Support agreement", "Web build"]);
  });
});
