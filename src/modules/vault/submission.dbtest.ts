import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { deleteContact } from "@/clients/service";
import { resetTenantDekCache } from "@/crypto/tenant-key";
import { withTenant } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { listInbox } from "@/notify/inbox";
import { resolvePortalModuleGates, type PortalPrincipal } from "@/portal";
import { setModuleEnabled, updatePreferences } from "@/preferences/service";

import {
  deleteCredential,
  portalCanSendLogins,
  readPortalSubmissions,
  revealCredentialField,
  submitPortalCredential,
  SUBMISSIONS_PER_DAY,
  SUBMISSIONS_PER_HOUR,
  updateCredential,
  type PortalLoginInput,
} from "./index";
import { insertSubmittedCredential } from "./submission";

/**
 * A CLIENT HANDS A LOGIN OVER, against the real database and the real
 * app_runtime role (Phase 3V slice 96; founder decision C64). The broker's
 * whole shape — the contact's own proof, then SYSTEM with every term
 * restated — and what the migration's guard holds for ANY writer
 * (20261006180000): only SYSTEM sets the sender; the login is born as sent
 * (its name frozen in `submitted_name`), INTERNAL, unsealed, seedless, live,
 * with no member author, by an active contact of its own client, whose row
 * it locks; the sender and the frozen name never change, nor the client.
 * Then C64's promises: a helper may send too; the client's OWN list shows
 * the name as sent and never what the team renamed it to (the design
 * review's high), binned or not, switch or not; the client's people AND the
 * owners are told (C64 (c)), each only if they may open it, the client
 * named and never the login; the budget; and `deleteContact` refuses a
 * contact who handed a login over — including while a hand-over is in
 * flight (the row lock).
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;
let acme: string;
let beta: string;
let acmeSite: string; // Acme project, portal ON
let acmeDark: string; // Acme project, portal OFF
let betaSite: string; // Beta project, portal ON

const RUN = randomUUID().slice(0, 8);
const PASSWORD = `Handed-over-${RUN}-zq!`;
const carol = randomUUID(); // Acme, PRIMARY
const dan = randomUUID(); // Acme, COLLABORATOR
const bo = randomUUID(); // Beta, PRIMARY
const rex = randomUUID(); // Acme, PRIMARY, access ended (REVOKED)
const emailOf = (name: string) => `vsub-${name}-${RUN}@test.invalid`;

const owner = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.owner.memberId) });

const principal = (contactId: string, clientId = acme): PortalPrincipal => ({
  contactId,
  tenantId: f.tenantId,
  clientId,
  gates,
});

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

const login = (over: Partial<PortalLoginInput> = {}): PortalLoginInput => ({
  type: "LOGIN",
  name: `Hosting ${randomUUID().slice(0, 6)}`,
  projectId: null,
  username: "acme-admin",
  url: "panel.example.test/login",
  notes: null,
  secret: { password: PASSWORD },
  ...over,
});

/** The submitted rows for a contact, as the database holds them. */
const sentBy = (contactId: string) =>
  f.platform.credentialItem.findMany({
    where: { tenantId: f.tenantId, submittedByContactId: contactId },
    orderBy: { createdAt: "asc" },
  });

/** The newest login a contact handed over. */
const newestBy = async (contactId: string) => {
  const rows = await sentBy(contactId);
  const row = rows.at(-1);
  if (!row) throw new Error("nothing handed over");
  return row;
};

/** A fresh contact at Acme, for a test whose budget or deletion must be its own. */
const freshContact = async (profile: "CONTACT_PRIMARY" | "CONTACT_COLLABORATOR" = "CONTACT_PRIMARY") => {
  const id = randomUUID();
  await f.platform.contact.create({
    data: {
      id,
      tenantId: f.tenantId,
      clientId: acme,
      name: `Fresh ${id.slice(0, 4)}`,
      email: emailOf(`f${id.slice(0, 8)}`),
      portalProfile: profile,
      portalStatus: "ACTIVE",
      invitedAt: new Date("2026-09-01T09:00:00Z"),
      emailVerified: true,
    },
  });
  return id;
};

const notificationsFor = (memberId: string) =>
  f.platform.notification.findMany({
    where: { tenantId: f.tenantId, kind: "credential.submitted", receiverId: memberId },
  });

beforeAll(async () => {
  f = await setupTenant("vsub");
  acme = randomUUID();
  beta = randomUUID();
  acmeSite = randomUUID();
  acmeDark = randomUUID();
  betaSite = randomUUID();
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: "Acme" },
      { id: beta, tenantId: f.tenantId, name: "Beta" },
    ],
  });
  await f.platform.project.createMany({
    data: [
      { id: acmeSite, tenantId: f.tenantId, clientId: acme, key: "SUBA", name: "Acme site", portalEnabled: true },
      { id: acmeDark, tenantId: f.tenantId, clientId: acme, key: "SUBD", name: "Acme internal", portalEnabled: false },
      { id: betaSite, tenantId: f.tenantId, clientId: beta, key: "SUBB", name: "Beta site", portalEnabled: true },
    ],
  });
  const invitedAt = new Date("2026-09-01T09:00:00Z");
  const contact = (
    id: string,
    clientId: string,
    name: string,
    profile: "CONTACT_PRIMARY" | "CONTACT_COLLABORATOR",
    status: "ACTIVE" | "REVOKED" = "ACTIVE",
  ) => ({
    id,
    tenantId: f.tenantId,
    clientId,
    name,
    email: emailOf(name.toLowerCase()),
    portalProfile: profile,
    portalStatus: status,
    invitedAt,
    emailVerified: true,
  });
  await f.platform.contact.createMany({
    data: [
      contact(carol, acme, "Carol", "CONTACT_PRIMARY"),
      contact(dan, acme, "Dan", "CONTACT_COLLABORATOR"),
      contact(bo, beta, "Bo", "CONTACT_PRIMARY"),
      contact(rex, acme, "Rex", "CONTACT_PRIMARY", "REVOKED"),
    ],
  });
  // The employee looks after Acme directly; the manager works on Acme's
  // portal project only; the admin on nothing of Acme's.
  await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId: acme } });
  await f.platform.memberProject.create({ data: { tenantId: f.tenantId, memberId: f.seats.manager.memberId, projectId: acmeSite } });
  gates = await resolvePortalModuleGates(f.tenantId);
}, 180_000);

afterAll(async () => {
  if (f) {
    await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.credentialItem.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.contact.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.memberProject.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.memberClient.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.project.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.tenantKey.deleteMany({ where: { tenantId: f.tenantId } });
  }
  resetTenantDekCache();
  await f?.cleanup();
}, 180_000);

describe("a client hands a login over (C64)", () => {
  it("lands on their client for the team only, as sent, encrypted, with the contact as the actor", async () => {
    const input = login({ name: "Acme hosting", notes: "Replaces the old one" });
    await submitPortalCredential(principal(carol), input);
    const row = await newestBy(carol);
    expect(row).toMatchObject({
      clientId: acme,
      projectId: null,
      type: "LOGIN",
      name: "Acme hosting",
      submittedName: "Acme hosting",
      username: "acme-admin",
      // A scheme-less address is read as https.
      url: "https://panel.example.test/login",
      notes: "Replaces the old one",
      secretFieldKeys: ["password"],
      hasTotp: false,
      visibility: "INTERNAL",
      sealedAt: null,
      createdByMemberId: null,
      updatedByMemberId: null,
    });
    // The secret is the team's to reveal — and it is the one typed.
    expect(await revealCredentialField(owner(), row.id, "password")).toBe(PASSWORD);
    const secretRow = await f.platform.credentialSecret.findUniqueOrThrow({
      where: { credentialId: row.id },
      omit: { secretCiphertext: false },
    });
    expect(secretRow.secretCiphertext).not.toContain(PASSWORD);
    expect(secretRow.updatedByMemberId).toBeNull();
    // The audit row: the CONTACT acted; ids, type and field names only.
    const audit = await f.platform.auditEvent.findFirstOrThrow({
      where: { tenantId: f.tenantId, action: "credential.submitted", targetId: row.id },
    });
    expect(audit).toMatchObject({ actorType: "CONTACT", actorId: carol, targetType: "CredentialItem" });
    expect(audit.metadata).toEqual({ clientId: acme, projectId: null, type: "LOGIN", fields: ["password"] });
    // INTERNAL: the contact's own transaction reads none of it.
    const seen = await withTenant(f.tenantId, { type: "contact", id: carol, clientId: acme }, (tx) =>
      tx.credentialItem.findMany({ where: { id: row.id }, select: { id: true } }),
    );
    expect(seen).toEqual([]);
  });

  it("a helper at the client may hand one over too (both profiles hold the capability)", async () => {
    await submitPortalCredential(principal(dan), login({ name: "Dan's wifi", type: "WIFI", secret: { password: "wifi-pass" } }));
    expect((await newestBy(dan)).submittedName).toBe("Dan's wifi");
  });

  it("for a project: lands on it; another client's project and one whose portal is off are refused alike", async () => {
    await submitPortalCredential(principal(carol), login({ name: "Site CMS", projectId: acmeSite }));
    const row = await newestBy(carol);
    expect(row).toMatchObject({ clientId: acme, projectId: acmeSite });
    expect(await outcome(submitPortalCredential(principal(carol), login({ projectId: betaSite })))).toBe("NOT_FOUND");
    expect(await outcome(submitPortalCredential(principal(carol), login({ projectId: acmeDark })))).toBe("NOT_FOUND");
    expect(await outcome(submitPortalCredential(principal(carol), login({ projectId: randomUUID() })))).toBe("NOT_FOUND");
  });

  it("what they typed is checked before anything else, and told plainly", async () => {
    expect(await outcome(submitPortalCredential(principal(carol), login({ secret: {} })))).toBe("INVALID_INPUT");
    expect(await outcome(submitPortalCredential(principal(carol), login({ name: "   " })))).toBe("INVALID_INPUT");
    expect(await outcome(submitPortalCredential(principal(carol), login({ type: "CARD" })))).toBe("INVALID_INPUT");
    // A key the type does not have — a seed included — is refused, never stored.
    expect(await outcome(submitPortalCredential(principal(carol), login({ secret: { totp: "JBSWY3DPEHPK3PXP" } })))).toBe(
      "INVALID_INPUT",
    );
    expect(await outcome(submitPortalCredential(principal(carol), login({ url: "javascript:alert(1)" })))).toBe(
      "INVALID_INPUT",
    );
    expect(await outcome(submitPortalCredential(principal(carol), login({ url: "ftp://files.example.test" })))).toBe(
      "INVALID_INPUT",
    );
    expect(await outcome(submitPortalCredential(principal(carol), login({ projectId: 42 })))).toBe("INVALID_INPUT");
  });

  it("an address is read as https unless it STARTS with a scheme — a '://' later on is not one", async () => {
    await submitPortalCredential(principal(carol), login({ name: "Next param", url: "example.test/login?next=https://x.test" }));
    expect((await newestBy(carol)).url).toBe("https://example.test/login?next=https://x.test");
    await submitPortalCredential(principal(carol), login({ name: "Plain http", url: "http://intranet.example.test" }));
    expect((await newestBy(carol)).url).toBe("http://intranet.example.test");
  });

  it("a contact whose access ended, and another client's contact naming this client, are refused", async () => {
    expect(await outcome(submitPortalCredential(principal(rex), login()))).toBe("FORBIDDEN");
    // Bo is Beta's: a principal claiming Acme reads no contact row of Acme's.
    expect(await outcome(submitPortalCredential(principal(bo, acme), login()))).toBe("NOT_FOUND");
    expect(await sentBy(rex)).toEqual([]);
    expect(await sentBy(bo)).toEqual([]);
  });

  it("the agency's switch off refuses the next one — and what was sent stays on the list", async () => {
    const before = (await readPortalSubmissions(principal(carol))).sent.length;
    expect(before).toBeGreaterThan(0);
    await updatePreferences(owner(), { vault: { allowContactSubmission: false } });
    try {
      expect(await portalCanSendLogins(principal(carol))).toBe(false);
      expect(await outcome(submitPortalCredential(principal(carol), login()))).toBe("NOT_FOUND");
      const read = await readPortalSubmissions(principal(carol));
      expect(read.open).toBe(false);
      // The switch is never told by a list emptying (the design review's nit).
      expect(read.sent.length).toBe(before);
    } finally {
      await updatePreferences(owner(), { vault: { allowContactSubmission: true } });
    }
    expect(await portalCanSendLogins(principal(carol))).toBe(true);
  });

  it("the vault module switched off is refused by the SYSTEM side alone (the contact's gates are stale and open)", async () => {
    await setModuleEnabled(owner(), "vault", false);
    try {
      expect(await outcome(submitPortalCredential(principal(carol), login()))).toBe("NOT_FOUND");
      expect(await portalCanSendLogins(principal(carol))).toBe(false);
    } finally {
      await setModuleEnabled(owner(), "vault", true);
    }
  });
});

describe("the client's own list (C64 (b))", () => {
  it("shows the name AS SENT — never what the team renamed it to — binned included, and only their own", async () => {
    await submitPortalCredential(principal(carol), login({ name: "Mail admin" }));
    const row = await newestBy(carol);
    // The team renames it to words a client must never read.
    await updateCredential(owner(), row.id, { name: `ACME root, reused bank pw ${RUN}` });
    const read = await readPortalSubmissions(principal(carol));
    expect(read.open).toBe(true);
    const names = read.sent.map((s) => s.name);
    expect(names[0]).toBe("Mail admin");
    expect(JSON.stringify(read)).not.toContain("reused bank pw");
    // No ids reach the client.
    expect(Object.keys(read.sent[0]!).sort()).toEqual(["name", "sentAt"]);
    // Binned by the team: still on the list, so the list never says so.
    await deleteCredential(owner(), row.id);
    expect((await readPortalSubmissions(principal(carol))).sent.map((s) => s.name)).toContain("Mail admin");
    // Dan's own list holds Dan's only; Bo's holds nothing of Acme's.
    expect((await readPortalSubmissions(principal(dan))).sent.map((s) => s.name)).toEqual(["Dan's wifi"]);
    expect((await readPortalSubmissions(principal(bo, beta))).sent).toEqual([]);
  });
});

describe("who is told (C64 (c))", () => {
  it("the client's people and the owners, each only if they may open it; the client named, never the login", async () => {
    await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
    // Client-level: the employee (Acme directly) and the owner. Not the
    // manager — on Acme's project only, which a client-level login is not.
    await submitPortalCredential(principal(carol), login({ name: "Registrar" }));
    expect((await notificationsFor(f.seats.employee.memberId)).length).toBe(1);
    expect((await notificationsFor(f.seats.owner.memberId)).length).toBe(1);
    expect(await notificationsFor(f.seats.manager.memberId)).toEqual([]);
    expect(await notificationsFor(f.seats.admin.memberId)).toEqual([]);
    const [n] = await notificationsFor(f.seats.owner.memberId);
    expect(n).toMatchObject({ entityType: "Client", entityId: acme, clientId: acme, projectId: null });
    expect(n!.params).toEqual({ clientId: acme });
    // A second one while unread is the same unread row (one per client).
    await submitPortalCredential(principal(dan), login({ name: "Analytics" }));
    expect((await notificationsFor(f.seats.owner.memberId)).length).toBe(1);

    // For the project: its people (the manager) and the owner.
    await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
    await submitPortalCredential(principal(carol), login({ name: "Site FTP", projectId: acmeSite }));
    expect((await notificationsFor(f.seats.manager.memberId)).length).toBe(1);
    expect((await notificationsFor(f.seats.owner.memberId)).length).toBe(1);
    expect(await notificationsFor(f.seats.employee.memberId)).toEqual([]);
  });

  it("the inbox names the client and links to the vault filtered to it — and nothing once the reader cannot open it", async () => {
    await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
    await submitPortalCredential(principal(carol), login({ name: "Domain registrar" }));
    const inboxOf = async (memberId: string) =>
      (await listInbox({ tenantId: f.tenantId, actor: actorFor(memberId) }, { filter: "all" })).rows.find(
        (r) => r.kind === "credential.submitted",
      );
    expect((await inboxOf(f.seats.owner.memberId))?.subject).toEqual({ title: "Acme", href: `/vault?client=${acme}` });
    expect((await inboxOf(f.seats.employee.memberId))?.subject).toEqual({ title: "Acme", href: `/vault?client=${acme}` });
    // The employee reaches Acme only by being assigned to it. Taken off the
    // client, they keep the row — and it names nothing.
    await f.platform.memberClient.deleteMany({ where: { tenantId: f.tenantId, memberId: f.seats.employee.memberId } });
    try {
      const theirs = await inboxOf(f.seats.employee.memberId);
      expect(theirs).toBeDefined();
      expect(theirs!.subject).toBeNull();
    } finally {
      await f.platform.memberClient.create({
        data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId: acme },
      });
    }
  });
});

describe("the budget", () => {
  it(`${SUBMISSIONS_PER_HOUR} an hour, from the contact's own audit rows — refused plainly after`, async () => {
    const fresh = await freshContact();
    const plant = (n: number, minutesAgo: number) =>
      f.platform.auditEvent.createMany({
        data: Array.from({ length: n }, () => ({
          tenantId: f.tenantId,
          action: "credential.submitted",
          actorType: "CONTACT" as const,
          actorId: fresh,
          targetType: "CredentialItem",
          targetId: randomUUID(),
          visibility: "TENANT" as const,
          createdAt: new Date(Date.now() - minutesAgo * 60_000),
        })),
      });
    await plant(SUBMISSIONS_PER_HOUR - 1, 5);
    await submitPortalCredential(principal(fresh), login());
    expect(await outcome(submitPortalCredential(principal(fresh), login()))).toBe("SUBMISSION_RATE_LIMITED");
    // Carol's budget is her own.
    await submitPortalCredential(principal(carol), login());
  });

  it("the LOCKED count holds against a race: three at once with one left in the hour — exactly one lands", async () => {
    // All three pass the unlocked pre-read (19 < 20); only the count taken
    // under the contact's budget lock, inside the write, can stop two of
    // them. Without it, all three would land.
    const fresh = await freshContact();
    await f.platform.auditEvent.createMany({
      data: Array.from({ length: SUBMISSIONS_PER_HOUR - 1 }, () => ({
        tenantId: f.tenantId,
        action: "credential.submitted",
        actorType: "CONTACT" as const,
        actorId: fresh,
        targetType: "CredentialItem",
        targetId: randomUUID(),
        visibility: "TENANT" as const,
        createdAt: new Date(Date.now() - 5 * 60_000),
      })),
    });
    const results = await Promise.all(
      [1, 2, 3].map((i) => outcome(submitPortalCredential(principal(fresh), login({ name: `Race ${i}` })))),
    );
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    for (const r of results.filter((r) => r !== "ok")) expect(["SUBMISSION_RATE_LIMITED", "VAULT_BUSY"]).toContain(r);
    expect(await sentBy(fresh)).toHaveLength(1);
  }, 120_000);

  it(`and ${SUBMISSIONS_PER_DAY} a day, so the hourly bound does not renew forever`, async () => {
    const fresh = await freshContact();
    await f.platform.auditEvent.createMany({
      data: Array.from({ length: SUBMISSIONS_PER_DAY }, (_, i) => ({
        tenantId: f.tenantId,
        action: "credential.submitted",
        actorType: "CONTACT" as const,
        actorId: fresh,
        targetType: "CredentialItem",
        targetId: randomUUID(),
        visibility: "TENANT" as const,
        // Spread over the day, none inside the last hour.
        createdAt: new Date(Date.now() - (90 + i * 15) * 60_000),
      })),
    });
    expect(await outcome(submitPortalCredential(principal(fresh), login()))).toBe("SUBMISSION_RATE_LIMITED");
    expect(await sentBy(fresh)).toEqual([]);
  });
});

describe("what the database holds for any writer (20261006180000)", () => {
  const base = (contactId: string, name = `Forged ${randomUUID().slice(0, 6)}`) => ({
    id: randomUUID(),
    tenantId: f.tenantId,
    clientId: acme,
    type: "LOGIN" as const,
    name,
    submittedName: name,
    submittedByContactId: contactId,
    visibility: "INTERNAL" as "INTERNAL" | "CLIENT_VISIBLE",
  });

  it("a MEMBER cannot make a login read 'sent by the client'", async () => {
    await expect(
      withTenant(f.tenantId, { type: "member", id: f.seats.owner.memberId }, (tx) =>
        tx.credentialItem.create({ data: base(carol), select: { id: true } }),
      ),
    ).rejects.toThrow(/CREDENTIAL_SUBMISSION_GUARD/);
    // …nor attach a sender to a login of theirs afterwards.
    const mine = await withTenant(f.tenantId, { type: "system" }, (tx) =>
      tx.credentialItem.create({
        data: { id: randomUUID(), tenantId: f.tenantId, clientId: acme, type: "LOGIN", name: "Ours", createdByMemberId: f.seats.owner.memberId },
        select: { id: true },
      }),
    );
    await expect(
      withTenant(f.tenantId, { type: "system" }, (tx) =>
        tx.credentialItem.update({
          where: { id: mine.id },
          data: { submittedByContactId: carol, submittedName: "Ours", createdByMemberId: null },
          select: { id: true },
        }),
      ),
    ).rejects.toThrow(/CREDENTIAL_SUBMISSION_GUARD/);
  });

  it("even SYSTEM: born as sent, for the team only, by an active contact of its own client, one author", async () => {
    const sys = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(f.tenantId, { type: "system" }, fn);
    const refuse = (data: ReturnType<typeof base> & Record<string, unknown>, pattern = /CREDENTIAL_SUBMISSION_GUARD/) =>
      expect(sys((tx) => tx.credentialItem.create({ data, select: { id: true } }))).rejects.toThrow(pattern);
    await refuse({ ...base(carol), visibility: "CLIENT_VISIBLE" });
    await refuse({ ...base(carol), sealedAt: new Date() });
    await refuse({ ...base(carol), hasTotp: true });
    await refuse({ ...base(carol), submittedName: "Something else" });
    await refuse({ ...base(carol), updatedByMemberId: f.seats.owner.memberId });
    await refuse({ ...base(carol), createdAt: new Date(Date.now() - 60 * 60_000) });
    await refuse({ ...base(bo) }); // Beta's contact on an Acme login
    await refuse({ ...base(rex) }); // access ended
    await refuse({ ...base(randomUUID()) }); // nobody
    // The CHECKs: one author; the snapshot exactly with the sender.
    await refuse({ ...base(carol), createdByMemberId: f.seats.owner.memberId }, /credential_item_submitted_one_author/);
    await expect(
      sys((tx) =>
        tx.credentialItem.create({
          data: { id: randomUUID(), tenantId: f.tenantId, clientId: acme, type: "LOGIN", name: "x", submittedName: "x" },
          select: { id: true },
        }),
      ),
    ).rejects.toThrow(/credential_item_submitted_name_pair/);
  });

  it("who sent it, what they called it and whose it is never change — the team's own edits go through", async () => {
    await submitPortalCredential(principal(carol), login({ name: "Frozen" }));
    const row = await newestBy(carol);
    const sys = (data: Record<string, unknown>) =>
      withTenant(f.tenantId, { type: "system" }, (tx) =>
        tx.credentialItem.update({ where: { id: row.id }, data, select: { id: true } }),
      );
    await expect(sys({ submittedByContactId: dan })).rejects.toThrow(/CREDENTIAL_SUBMISSION_GUARD/);
    await expect(sys({ submittedName: "Thawed" })).rejects.toThrow(/CREDENTIAL_SUBMISSION_GUARD/);
    await expect(sys({ clientId: beta })).rejects.toThrow(/CREDENTIAL_SUBMISSION_GUARD/);
    // The team's edits are UPDATEs the guard does not read.
    await updateCredential(owner(), row.id, { name: "Renamed by the team", notes: "checked" });
    const after = await f.platform.credentialItem.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ name: "Renamed by the team", submittedName: "Frozen", submittedByContactId: carol });
  });

  it("the row shaper under a MEMBER principal is refused like any other member write", async () => {
    await expect(
      withTenant(f.tenantId, { type: "member", id: f.seats.owner.memberId }, (tx) =>
        insertSubmittedCredential(tx, {
          tenantId: f.tenantId,
          clientId: acme,
          projectId: null,
          contactId: carol,
          type: "LOGIN",
          name: "Shaped",
          username: null,
          url: null,
          notes: null,
          fields: { password: "x" },
        }),
      ),
    ).rejects.toThrow(/CREDENTIAL_SUBMISSION_GUARD/);
  });
});

describe("a contact who handed a login over is not deleted (the founder's rule, 2026-09-23)", () => {
  it("deleteContact refuses once their access has ended", async () => {
    const fresh = await freshContact("CONTACT_COLLABORATOR");
    await submitPortalCredential(principal(fresh), login({ name: "Their login" }));
    await f.platform.contact.update({ where: { id: fresh }, data: { portalStatus: "REVOKED" } });
    expect(await outcome(deleteContact(owner(), fresh))).toBe("CONTACT_HAS_HISTORY");
  });

  it("a hand-over in flight holds the contact's row: ending their access waits for it, and the delete then refuses", async () => {
    const fresh = await freshContact();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const ready = new Promise<void>((r) => (inserted = r));
    // A: the guard locks the contact's row FOR SHARE and holds it open.
    const a = withTenant(
      f.tenantId,
      { type: "system" },
      async (tx) => {
        await insertSubmittedCredential(tx, {
          tenantId: f.tenantId,
          clientId: acme,
          projectId: null,
          contactId: fresh,
          type: "LOGIN",
          name: "In flight",
          username: null,
          url: null,
          notes: null,
          fields: { password: "in-flight" },
        });
        inserted();
        await held;
      },
      { timeoutMs: 30_000 },
    );
    await ready;
    // B: ending their access — an UPDATE of that row — must wait for A.
    let ended = false;
    const b = withTenant(
      f.tenantId,
      { type: "member", id: f.seats.owner.memberId },
      (tx) => tx.contact.update({ where: { id: fresh }, data: { portalStatus: "REVOKED" }, select: { id: true } }),
      { timeoutMs: 30_000 },
    ).then(() => {
      ended = true;
    });
    await new Promise((r) => setTimeout(r, 1500));
    expect(ended).toBe(false);
    release();
    await a;
    await b;
    expect(ended).toBe(true);
    expect(await outcome(deleteContact(owner(), fresh))).toBe("CONTACT_HAS_HISTORY");
  }, 60_000);

  it("the control: a login the TEAM adds takes no lock on any contact, so ending access does not wait for it", async () => {
    // Without this, the test above could pass for a reason that is not the
    // guard's lock (a slow link, any other lock on the row).
    const fresh = await freshContact();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const ready = new Promise<void>((r) => (inserted = r));
    const a = withTenant(
      f.tenantId,
      { type: "system" },
      async (tx) => {
        await tx.credentialItem.create({
          data: {
            id: randomUUID(),
            tenantId: f.tenantId,
            clientId: acme,
            type: "LOGIN",
            name: "Added by the team",
            createdByMemberId: f.seats.owner.memberId,
          },
          select: { id: true },
        });
        inserted();
        await held;
      },
      { timeoutMs: 30_000 },
    );
    await ready;
    try {
      await withTenant(
        f.tenantId,
        { type: "member", id: f.seats.owner.memberId },
        (tx) => tx.contact.update({ where: { id: fresh }, data: { portalStatus: "REVOKED" }, select: { id: true } }),
        { timeoutMs: 10_000, lockTimeoutMs: 1500 },
      );
    } finally {
      release();
      await a;
    }
  }, 60_000);
});
