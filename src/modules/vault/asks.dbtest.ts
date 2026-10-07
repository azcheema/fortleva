import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { deleteContact } from "@/clients/service";
import { resetTenantDekCache } from "@/crypto/tenant-key";
import { withTenant } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { actorFor, noMfa, setupTenant } from "@/members/dbtest-fixture";
import { listInbox } from "@/notify/inbox";
import { LOGIN_ASK_MAIL } from "@/notify/login-ask-mail-key";
import { resolvePortalModuleGates, type PortalPrincipal } from "@/portal";
import { setModuleEnabled, updatePreferences } from "@/preferences/service";
import { setPortalEnabled } from "@/projects/service";

import {
  ASKS_OPEN_PER_CONTACT,
  ASKS_PER_CONTACT_PER_DAY,
  askForLogin,
  cancelLoginAsk,
  countPortalLoginAsks,
  declinePortalLoginAsk,
  deleteCredential,
  listLoginAsks,
  listPortalLoginAsks,
  loginAskTargets,
  readPortalLoginAsk,
  revealCredentialField,
  submitPortalCredential,
  type AskForLoginInput,
  type PortalLoginInput,
} from "./index";
import { insertSubmittedCredential } from "./submission";

/**
 * THE AGENCY ASKS A CLIENT FOR A NAMED LOGIN, against the real database and
 * the real app_runtime role (Phase 3V slice 98; founder decision C66). The
 * team's side — who may ask (C66 (d): `credential:create` and the vault's
 * reach, through the door), whom (C66 (a): one contact of the client who
 * may send a login), where (the client or a project whose portal is on),
 * the one mail (C66 (b)), the bounds — and the client's: only the person
 * asked sees it, they send it (landing where the ASK says) or decline it
 * (C66 (c)), and the team is told, the asker included. Then what the
 * migration's guard holds for ANY writer (20261007180000): a member asks
 * and cancels as themselves, only SYSTEM records a send or a decline, what
 * was asked never changes, an ask ends once, one login answers one ask.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;
let acme: string;
let beta: string;
let acmeSite: string; // Acme project, portal ON — the employee's and the manager's
let acmeDark: string; // Acme project, portal OFF
let acmeLater: string; // Acme project, portal ON, switched off in a test

const RUN = randomUUID().slice(0, 8);
const carol = randomUUID(); // Acme, PRIMARY
const dan = randomUUID(); // Acme, COLLABORATOR
const bo = randomUUID(); // Beta, PRIMARY
const rex = randomUUID(); // Acme, PRIMARY, access ended (REVOKED)
const emailOf = (name: string) => `vask-${name}-${RUN}@test.invalid`;

const as = (memberId: string) => ({ tenantId: f.tenantId, actor: actorFor(memberId) });
const owner = () => as(f.seats.owner.memberId);

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

const ask = (over: Partial<AskForLoginInput> = {}): AskForLoginInput => ({
  clientId: acme,
  projectId: null,
  contactId: carol,
  type: "LOGIN",
  name: `Hosting panel ${randomUUID().slice(0, 6)}`,
  note: null,
  ...over,
});

const login = (over: Partial<PortalLoginInput> = {}): PortalLoginInput => ({
  type: "LOGIN",
  name: `Sent ${randomUUID().slice(0, 6)}`,
  projectId: null,
  username: "acme-admin",
  url: "panel.example.test",
  notes: null,
  secret: { password: `Asked-for-${RUN}-zq!` },
  ...over,
});

const row = (id: string) => f.platform.credentialAsk.findUniqueOrThrow({ where: { id } });

/** A fresh contact at Acme, for a test whose bounds or deletion must be its own. */
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

const notices = (kind: string, memberId: string) =>
  f.platform.notification.findMany({ where: { tenantId: f.tenantId, kind, receiverId: memberId } });

beforeAll(async () => {
  f = await setupTenant("vask");
  acme = randomUUID();
  beta = randomUUID();
  acmeSite = randomUUID();
  acmeDark = randomUUID();
  acmeLater = randomUUID();
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: "Acme" },
      { id: beta, tenantId: f.tenantId, name: "Beta" },
    ],
  });
  await f.platform.project.createMany({
    data: [
      { id: acmeSite, tenantId: f.tenantId, clientId: acme, key: "ASKA", name: "Acme site", portalEnabled: true },
      { id: acmeDark, tenantId: f.tenantId, clientId: acme, key: "ASKD", name: "Acme internal", portalEnabled: false },
      { id: acmeLater, tenantId: f.tenantId, clientId: acme, key: "ASKL", name: "Acme later", portalEnabled: true },
    ],
  });
  const invitedAt = new Date("2026-09-01T09:00:00Z");
  const contact = (
    id: string,
    clientId: string,
    name: string,
    profile: "CONTACT_PRIMARY" | "CONTACT_COLLABORATOR",
    status: "ACTIVE" | "REVOKED" = "ACTIVE",
    locale: string | null = null,
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
    locale,
  });
  await f.platform.contact.createMany({
    data: [
      contact(carol, acme, "Carol", "CONTACT_PRIMARY", "ACTIVE", "sv"),
      contact(dan, acme, "Dan", "CONTACT_COLLABORATOR"),
      contact(bo, beta, "Bo", "CONTACT_PRIMARY"),
      contact(rex, acme, "Rex", "CONTACT_PRIMARY", "REVOKED"),
    ],
  });
  // The owner, the admin and the manager hold `client:view_all` (the whole
  // tenant is in reach); the employee does not. The employee and the
  // manager work on Acme's site — so the employee reaches Acme ONLY through
  // it — and nobody is assigned to Acme directly. The admin is assigned to
  // nothing: a hand-over at Acme tells them only when they asked for it.
  await f.platform.memberProject.createMany({
    data: [
      { tenantId: f.tenantId, memberId: f.seats.employee.memberId, projectId: acmeSite },
      { tenantId: f.tenantId, memberId: f.seats.manager.memberId, projectId: acmeSite },
    ],
  });
  gates = await resolvePortalModuleGates(f.tenantId);
}, 180_000);

afterAll(async () => {
  if (f) {
    await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.credentialAsk.deleteMany({ where: { tenantId: f.tenantId } });
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

describe("asking (C66 (a), (d))", () => {
  it("a member who may add a login asks one person: the row, the audit (no words), the one mail (no words)", async () => {
    const made = await askForLogin(owner(), ask({ name: "Hosting control panel", note: "For the PHP upgrade" }));
    expect(await row(made.id)).toMatchObject({
      clientId: acme,
      projectId: null,
      contactId: carol,
      type: "LOGIN",
      name: "Hosting control panel",
      note: "For the PHP upgrade",
      requestedByMemberId: f.seats.owner.memberId,
      sentAt: null,
      declinedAt: null,
      cancelledAt: null,
    });
    const [audit] = await f.platform.auditEvent.findMany({
      where: { tenantId: f.tenantId, action: "credential.asked", targetId: made.id },
    });
    expect(audit).toMatchObject({ actorType: "MEMBER", actorId: f.seats.owner.memberId, targetType: "CredentialAsk" });
    expect(audit!.metadata).toEqual({ clientId: acme, projectId: null, contactId: carol, type: "LOGIN" });
    const mails = await f.platform.emailOutbox.findMany({
      where: { tenantId: f.tenantId, receiverType: "CONTACT", receiverId: carol, kind: LOGIN_ASK_MAIL },
    });
    const mail = mails.find((m) => (m.params as { askId?: string } | null)?.askId === made.id);
    expect(mail).toMatchObject({ toEmail: emailOf("carol"), locale: "sv", params: { askId: made.id } });
    // The mail names nothing: the ask's id is all it carries.
    expect(JSON.stringify(mail!.params)).not.toContain("Hosting");
  });

  it("one mail per person per 12 hours, none to a suppressed address — and the member is told which", async () => {
    // Carol was mailed by the test above: a second ask now waits in her
    // portal and sends nothing new (the security review's low).
    const before = await f.platform.emailOutbox.count({
      where: { tenantId: f.tenantId, receiverId: carol, kind: LOGIN_ASK_MAIL },
    });
    expect(before).toBeGreaterThan(0);
    const again = await askForLogin(owner(), ask());
    expect(again.mail).toBe("recent");
    expect(await f.platform.emailOutbox.count({ where: { tenantId: f.tenantId, receiverId: carol, kind: LOGIN_ASK_MAIL } })).toBe(
      before,
    );
    expect(await countPortalLoginAsks(principal(carol))).toBeGreaterThanOrEqual(2);
    // PER PERSON, not per workspace: someone else is mailed meanwhile.
    const other = await freshContact();
    expect((await askForLogin(owner(), ask({ contactId: other }))).mail).toBe("sent");
    // A mail that DIED reached nobody: it holds nothing back.
    await f.platform.emailOutbox.updateMany({
      where: { tenantId: f.tenantId, receiverId: other, kind: LOGIN_ASK_MAIL },
      data: { status: "DEAD" },
    });
    expect((await askForLogin(owner(), ask({ contactId: other }))).mail).toBe("sent");
    // And only for the window: Carol's mails moved 13 hours back, she is mailed again.
    await f.platform.emailOutbox.updateMany({
      where: { tenantId: f.tenantId, receiverId: carol, kind: LOGIN_ASK_MAIL },
      data: { createdAt: new Date(Date.now() - 13 * 60 * 60_000) },
    });
    expect((await askForLogin(owner(), ask())).mail).toBe("sent");
    // An address that takes no mail from us: the ask stands, no mail, said.
    const quiet = await freshContact();
    const address = (await f.platform.contact.findUniqueOrThrow({ where: { id: quiet } })).email.toLowerCase();
    await f.platform.emailSuppression.create({ data: { email: address, reason: "MANUAL", source: "manual" } });
    try {
      const made = await askForLogin(owner(), ask({ contactId: quiet }));
      expect(made.mail).toBe("suppressed");
      expect(await f.platform.emailOutbox.count({ where: { tenantId: f.tenantId, receiverId: quiet } })).toBe(0);
      expect(await countPortalLoginAsks(principal(quiet))).toBe(1);
    } finally {
      await f.platform.emailSuppression.delete({ where: { email: address } });
    }
  });

  it("a helper may be asked; another client's contact, one whose access ended, and nobody are refused alike", async () => {
    expect(await outcome(askForLogin(owner(), ask({ contactId: dan })))).toBe("ok");
    expect(await outcome(askForLogin(owner(), ask({ contactId: bo })))).toBe("LOGIN_ASK_CONTACT");
    expect(await outcome(askForLogin(owner(), ask({ contactId: rex })))).toBe("LOGIN_ASK_CONTACT");
    expect(await outcome(askForLogin(owner(), ask({ contactId: randomUUID() })))).toBe("LOGIN_ASK_CONTACT");
    expect(await f.platform.credentialAsk.count({ where: { tenantId: f.tenantId, contactId: { in: [bo, rex] } } })).toBe(0);
  });

  it("where: the client or a project whose portal is on — never our own, a dark project, or out of reach", async () => {
    const onSite = await askForLogin(owner(), ask({ clientId: null, projectId: acmeSite }));
    expect(await row(onSite.id)).toMatchObject({ clientId: acme, projectId: acmeSite });
    expect(await outcome(askForLogin(owner(), ask({ clientId: null, projectId: acmeDark })))).toBe("INVALID_INPUT");
    expect(await outcome(askForLogin(owner(), ask({ clientId: null, projectId: null })))).toBe("INVALID_INPUT");
    // The employee reaches Acme only through its site: the client itself is
    // out of reach (NOT_FOUND, before anything else is answered), the site is not.
    expect(await outcome(askForLogin(as(f.seats.employee.memberId), ask()))).toBe("NOT_FOUND");
    expect(await outcome(askForLogin(as(f.seats.employee.memberId), ask({ clientId: null, projectId: acmeSite })))).toBe(
      "ok",
    );
    expect(await outcome(askForLogin(owner(), ask({ name: "   " })))).toBe("NAME_REQUIRED");
    expect(await outcome(askForLogin(owner(), ask({ type: "CARD" })))).toBe("INVALID_INPUT");
    expect(await outcome(askForLogin(owner(), ask({ note: "x".repeat(1001) })))).toBe("INVALID_INPUT");
    // A character Postgres cannot store is refused as what was typed, never
    // an error page (the security review's nit).
    expect(await outcome(askForLogin(owner(), ask({ name: `Panel${String.fromCharCode(0)}` })))).toBe("INVALID_INPUT");
  });

  it("an archived client takes no ask — not even on a project of it that is still live (the code review's low)", async () => {
    const gone = randomUUID();
    const goneSite = randomUUID();
    await f.platform.client.create({ data: { id: gone, tenantId: f.tenantId, name: "Gone", status: "ARCHIVED" } });
    await f.platform.project.create({
      data: { id: goneSite, tenantId: f.tenantId, clientId: gone, key: "ASKG", name: "Gone site", portalEnabled: true },
    });
    const goneContact = randomUUID();
    await f.platform.contact.create({
      data: {
        id: goneContact,
        tenantId: f.tenantId,
        clientId: gone,
        name: "Gone contact",
        email: emailOf("gone"),
        portalProfile: "CONTACT_PRIMARY",
        portalStatus: "ACTIVE",
        invitedAt: new Date("2026-09-01T09:00:00Z"),
        emailVerified: true,
      },
    });
    expect(
      await outcome(askForLogin(owner(), ask({ clientId: null, projectId: goneSite, contactId: goneContact }))),
    ).toBe("ARCHIVED");
    expect(await outcome(askForLogin(owner(), ask({ clientId: gone, contactId: goneContact })))).toBe("ARCHIVED");
  });

  it("an ask stuck on a client archived since is still cancellable — where nothing can be asked (the code review's medium)", async () => {
    const later = randomUUID();
    const laterContact = randomUUID();
    await f.platform.client.create({ data: { id: later, tenantId: f.tenantId, name: "Archived later" } });
    await f.platform.contact.create({
      data: {
        id: laterContact,
        tenantId: f.tenantId,
        clientId: later,
        name: "Later contact",
        email: emailOf("later"),
        portalProfile: "CONTACT_PRIMARY",
        portalStatus: "ACTIVE",
        invitedAt: new Date("2026-09-01T09:00:00Z"),
        emailVerified: true,
      },
    });
    const stuck = await askForLogin(owner(), ask({ clientId: later, contactId: laterContact }));
    await f.platform.client.update({ where: { id: later }, data: { status: "ARCHIVED" } });
    expect(await loginAskTargets(owner(), { clientId: later, projectId: null })).toMatchObject({
      canAsk: false,
      canCancel: true,
    });
    expect((await listLoginAsks(owner(), { clientId: later })).find((a) => a.id === stuck.id)).toMatchObject({
      stuck: true,
    });
    expect(await outcome(cancelLoginAsk(owner(), stuck.id))).toBe("ok");
  });

  it("through the door, as themselves: a stale factor, impersonation, and a revoked credential:create are refused", async () => {
    expect(
      await outcome(askForLogin({ tenantId: f.tenantId, actor: noMfa(f.seats.employee.memberId) }, ask())),
    ).toBe("MFA_REQUIRED");
    expect(
      await outcome(
        askForLogin({ tenantId: f.tenantId, actor: { ...actorFor(f.seats.owner.memberId), impersonated: true } }, ask()),
      ),
    ).toBe("FORBIDDEN");
    // Revoked the way the product revokes a template code: the row stays,
    // its `source` becomes TENANT_REVOKE.
    const perm = await f.platform.permission.findFirstOrThrow({ where: { code: "credential:create" } });
    const grant = { tenantId: f.tenantId, roleId: f.seats.employee.roleId, permissionId: perm.id };
    const { source } = await f.platform.rolePermission.findFirstOrThrow({ where: grant, select: { source: true } });
    await f.platform.rolePermission.updateMany({ where: grant, data: { source: "TENANT_REVOKE" } });
    try {
      expect(await outcome(askForLogin(as(f.seats.employee.memberId), ask()))).toBe("FORBIDDEN");
      // …and the database refuses the same member writing the row directly.
      await expect(
        withTenant(f.tenantId, { type: "member", id: f.seats.employee.memberId }, (tx) =>
          tx.credentialAsk.create({
            data: {
              tenantId: f.tenantId,
              clientId: acme,
              contactId: carol,
              type: "LOGIN",
              name: "Forged",
              requestedByMemberId: f.seats.employee.memberId,
            },
          }),
        ),
      ).rejects.toThrow(/CREDENTIAL_ASK_GUARD/);
    } finally {
      await f.platform.rolePermission.updateMany({ where: grant, data: { source } });
    }
    expect(await outcome(askForLogin(as(f.seats.employee.memberId), ask({ clientId: null, projectId: acmeSite })))).toBe(
      "ok",
    );
  });

  it("nobody could answer: the switch off, or the portal module closed — refused, and said why", async () => {
    await updatePreferences(owner(), { vault: { allowContactSubmission: false } });
    try {
      expect(await outcome(askForLogin(owner(), ask()))).toBe("LOGIN_ASKS_OFF");
    } finally {
      await updatePreferences(owner(), { vault: { allowContactSubmission: true } });
    }
    await setModuleEnabled(owner(), "portal", false);
    try {
      expect(await outcome(askForLogin(owner(), ask()))).toBe("LOGIN_ASKS_OFF");
    } finally {
      await setModuleEnabled(owner(), "portal", true);
    }
  });

  it(`at most ${ASKS_OPEN_PER_CONTACT} open asks to one person, and ${ASKS_PER_CONTACT_PER_DAY} made in a day — cancelling frees only the first`, async () => {
    const fresh = await freshContact();
    const made: string[] = [];
    for (let i = 0; i < ASKS_OPEN_PER_CONTACT; i += 1) made.push((await askForLogin(owner(), ask({ contactId: fresh }))).id);
    expect(await outcome(askForLogin(owner(), ask({ contactId: fresh })))).toBe("LOGIN_ASK_LIMIT");
    // Cancel ten: open falls to ten, so ten more may be made — then the
    // DAY's bound holds, whatever is cancelled (ask → cancel → ask would
    // otherwise mail a client without end).
    for (const id of made.slice(0, 10)) await cancelLoginAsk(owner(), id);
    for (let i = ASKS_OPEN_PER_CONTACT; i < ASKS_PER_CONTACT_PER_DAY; i += 1) {
      await askForLogin(owner(), ask({ contactId: fresh }));
    }
    for (const id of made.slice(10, 20)) await cancelLoginAsk(owner(), id);
    expect(await outcome(askForLogin(owner(), ask({ contactId: fresh })))).toBe("LOGIN_ASK_LIMIT");
    // Carol's bounds are her own.
    expect(await outcome(askForLogin(owner(), ask()))).toBe("ok");
  }, 240_000);

  it("two members asking one person at once are counted one after the other", async () => {
    const fresh = await freshContact();
    const onSite = { contactId: fresh, clientId: null, projectId: acmeSite };
    for (let i = 0; i < ASKS_OPEN_PER_CONTACT - 1; i += 1) await askForLogin(owner(), ask(onSite));
    // DETERMINISTIC, not a timing race (a mutation check found the first
    // cut passing with the lock removed): the test holds the per-person
    // lock, BOTH asks are seen queued on it in `pg_locks` — which only
    // happens if the service takes it before it counts — and only then is
    // it released, so the two are counted one after the other.
    const key = `credential_ask:${f.tenantId}:${fresh}`;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const holder = withTenant(f.tenantId, { type: "member", id: f.seats.owner.memberId }, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
      held();
      await gate;
    });
    await holding;
    const both = Promise.all([
      outcome(askForLogin(owner(), ask(onSite))),
      outcome(askForLogin(as(f.seats.employee.memberId), ask(onSite))),
    ]);
    let queued = 0;
    for (const until = Date.now() + 2_500; Date.now() < until && queued < 2; ) {
      const [r] = await f.platform.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks
         WHERE locktype = 'advisory' AND NOT granted
           AND objid = (hashtext(${key})::bigint & 4294967295)::oid`;
      queued = r?.n ?? 0;
      if (queued < 2) await new Promise((res) => setTimeout(res, 50));
    }
    release();
    await holder;
    expect(queued, "both asks waited on the per-person lock").toBe(2);
    const results = await both;
    expect(results.sort()).toEqual(["LOGIN_ASK_LIMIT", "ok"]);
    expect(
      await f.platform.credentialAsk.count({ where: { tenantId: f.tenantId, contactId: fresh, cancelledAt: null } }),
    ).toBe(ASKS_OPEN_PER_CONTACT);
  }, 120_000);
});

describe("the client's side (C66 (a))", () => {
  it("only the person asked sees it — by name on the send page, as a count on the home", async () => {
    const fresh = await freshContact();
    const made = await askForLogin(owner(), ask({ contactId: fresh, name: "Registrar", note: "We renew the domain" }));
    const mine = await listPortalLoginAsks(principal(fresh));
    expect(mine).toEqual([
      { id: made.id, type: "LOGIN", name: "Registrar", note: "We renew the domain", project: null, askedAt: expect.any(Date) },
    ]);
    // Never who asked, never anything about a login.
    expect(Object.keys(mine[0]!).sort()).toEqual(["askedAt", "id", "name", "note", "project", "type"]);
    expect(await countPortalLoginAsks(principal(fresh))).toBe(1);
    expect(await readPortalLoginAsk(principal(fresh), made.id)).toMatchObject({ id: made.id, name: "Registrar" });
    // Another person at the same client, another client's, a made-up id, a malformed one: nothing.
    expect((await listPortalLoginAsks(principal(dan))).map((a) => a.id)).not.toContain(made.id);
    expect(await readPortalLoginAsk(principal(dan), made.id)).toBeNull();
    expect(await readPortalLoginAsk(principal(bo, beta), made.id)).toBeNull();
    expect(await readPortalLoginAsk(principal(fresh), randomUUID())).toBeNull();
    expect(await readPortalLoginAsk(principal(fresh), ["x"])).toBeNull();
    // A contact principal's own transaction reads no row of it (class A).
    const seen = await withTenant(f.tenantId, { type: "contact", id: fresh, clientId: acme }, (tx) =>
      tx.credentialAsk.findMany({ select: { id: true } }),
    );
    expect(seen).toEqual([]);
  });

  it("hidden while it cannot be answered: the switch off, or its project's portal switched off", async () => {
    const fresh = await freshContact();
    const onLater = await askForLogin(owner(), ask({ contactId: fresh, clientId: null, projectId: acmeLater }));
    expect(await countPortalLoginAsks(principal(fresh))).toBe(1);
    await updatePreferences(owner(), { vault: { allowContactSubmission: false } });
    try {
      expect(await listPortalLoginAsks(principal(fresh))).toEqual([]);
      expect(await countPortalLoginAsks(principal(fresh))).toBe(0);
      expect(await readPortalLoginAsk(principal(fresh), onLater.id)).toBeNull();
    } finally {
      await updatePreferences(owner(), { vault: { allowContactSubmission: true } });
    }
    await setPortalEnabled(owner(), acmeLater, false);
    try {
      expect(await countPortalLoginAsks(principal(fresh))).toBe(0);
      expect(await outcome(submitPortalCredential(principal(fresh), login({ askId: onLater.id })))).toBe("NOT_FOUND");
      expect(await outcome(declinePortalLoginAsk(principal(fresh), onLater.id, null))).toBe("NOT_FOUND");
      // The team sees it as one the client cannot answer now — and may
      // still cancel it from the project's page, where nothing can be asked
      // (the code review's medium).
      const listed = (await listLoginAsks(owner(), { clientId: acme })).find((a) => a.id === onLater.id);
      expect(listed).toMatchObject({ state: { kind: "open" }, stuck: true });
      const onItsPage = await loginAskTargets(owner(), { clientId: acme, projectId: acmeLater });
      expect(onItsPage).toMatchObject({ canAsk: false, canCancel: true, places: [] });
    } finally {
      await setPortalEnabled(owner(), acmeLater, true);
    }
    expect(await countPortalLoginAsks(principal(fresh))).toBe(1);
  });
});

describe("the answer: sent (C66 (c))", () => {
  it("lands where the ASK says, ends it naming the login, audits the ask, tells the asker too", async () => {
    await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
    // The admin asks — assigned to nothing of Acme's, so a hand-over would
    // not otherwise tell them.
    const made = await askForLogin(as(f.seats.admin.memberId), ask({ clientId: null, projectId: acmeSite }));
    // A project on the form is ignored: the ask's anchor wins.
    await submitPortalCredential(principal(carol), login({ name: "Site admin", projectId: acmeDark, askId: made.id }));
    const asked = await row(made.id);
    expect(asked.sentAt).not.toBeNull();
    const item = await f.platform.credentialItem.findUniqueOrThrow({ where: { id: asked.sentCredentialId! } });
    expect(item).toMatchObject({ clientId: acme, projectId: acmeSite, submittedByContactId: carol, submittedName: "Site admin" });
    expect(await revealCredentialField(owner(), item.id, "password")).toBe(`Asked-for-${RUN}-zq!`);
    const audit = await f.platform.auditEvent.findFirstOrThrow({
      where: { tenantId: f.tenantId, action: "credential.submitted", targetId: item.id },
    });
    expect(audit.metadata).toEqual({ clientId: acme, projectId: acmeSite, type: "LOGIN", fields: ["password"], askId: made.id });
    expect((await notices("credential.submitted", f.seats.admin.memberId)).length).toBe(1);
    expect((await notices("credential.submitted", f.seats.manager.memberId)).length).toBe(1);
    // Gone from the client's list; on the team's, as sent, naming the login.
    expect((await listPortalLoginAsks(principal(carol))).map((a) => a.id)).not.toContain(made.id);
    const listed = (await listLoginAsks(owner(), { projectId: acmeSite })).find((a) => a.id === made.id);
    expect(listed?.state).toEqual({ kind: "sent", at: asked.sentAt, credentialId: item.id });
    // Binned by the team: still "sent", but no link to a row that is gone
    // (the code review's low).
    await deleteCredential(owner(), item.id);
    const after = (await listLoginAsks(owner(), { projectId: acmeSite })).find((a) => a.id === made.id);
    expect(after?.state).toEqual({ kind: "sent", at: asked.sentAt, credentialId: null });
  });

  it("another person's ask, an ended ask, a made-up id: refused alike, and nothing lands", async () => {
    const made = await askForLogin(owner(), ask());
    const before = await f.platform.credentialItem.count({ where: { tenantId: f.tenantId } });
    expect(await outcome(submitPortalCredential(principal(dan), login({ askId: made.id })))).toBe("NOT_FOUND");
    expect(await outcome(submitPortalCredential(principal(bo, beta), login({ askId: made.id })))).toBe("NOT_FOUND");
    expect(await outcome(submitPortalCredential(principal(carol), login({ askId: randomUUID() })))).toBe("NOT_FOUND");
    await cancelLoginAsk(owner(), made.id);
    expect(await outcome(submitPortalCredential(principal(carol), login({ askId: made.id })))).toBe("NOT_FOUND");
    expect(await f.platform.credentialItem.count({ where: { tenantId: f.tenantId } })).toBe(before);
  });

  it("two sends of one ask at once: exactly one login", async () => {
    const fresh = await freshContact();
    const made = await askForLogin(owner(), ask({ contactId: fresh }));
    const results = await Promise.all([
      outcome(submitPortalCredential(principal(fresh), login({ askId: made.id }))),
      outcome(submitPortalCredential(principal(fresh), login({ askId: made.id }))),
    ]);
    expect(results.sort()).toEqual(["NOT_FOUND", "ok"]);
    expect(await f.platform.credentialItem.count({ where: { tenantId: f.tenantId, submittedByContactId: fresh } })).toBe(1);
  });

  it("a send racing the team's cancel: one of them ends it, and a cancelled ask gets no login", async () => {
    const fresh = await freshContact();
    const made = await askForLogin(owner(), ask({ contactId: fresh }));
    const [sent, cancelled] = await Promise.all([
      outcome(submitPortalCredential(principal(fresh), login({ askId: made.id }))),
      outcome(cancelLoginAsk(owner(), made.id)),
    ]);
    const ended = await row(made.id);
    expect([sent, cancelled].filter((r) => r === "ok").length).toBe(1);
    if (sent === "ok") {
      expect(cancelled).toBe("LOGIN_ASK_ENDED");
      expect(ended.sentAt).not.toBeNull();
    } else {
      expect(sent).toBe("NOT_FOUND");
      expect(ended.cancelledAt).not.toBeNull();
      expect(await f.platform.credentialItem.count({ where: { tenantId: f.tenantId, submittedByContactId: fresh } })).toBe(0);
    }
  });
});

describe("the answer: we don't have this (C66 (c))", () => {
  it("ends it with the note, audits no words, tells the asker and the anchor's people; the inbox names the client", async () => {
    await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
    const made = await askForLogin(as(f.seats.admin.memberId), ask());
    await declinePortalLoginAsk(principal(carol), made.id, "  Ask our IT person, Sam  ");
    expect(await row(made.id)).toMatchObject({
      declinedByContactId: carol,
      declineNote: "Ask our IT person, Sam",
      sentAt: null,
      cancelledAt: null,
    });
    const audit = await f.platform.auditEvent.findFirstOrThrow({
      where: { tenantId: f.tenantId, action: "credential.ask_declined", targetId: made.id },
    });
    expect(audit).toMatchObject({ actorType: "CONTACT", actorId: carol, targetType: "CredentialAsk" });
    expect(audit.metadata).toEqual({ clientId: acme, projectId: null });
    // The asker (the admin) and the owner — nobody is assigned to Acme
    // directly; the site's people are not told about a client-level ask.
    for (const m of [f.seats.admin, f.seats.owner]) {
      expect((await notices("credential.ask_declined", m.memberId)).length).toBe(1);
    }
    expect(await notices("credential.ask_declined", f.seats.manager.memberId)).toEqual([]);
    expect(await notices("credential.ask_declined", f.seats.employee.memberId)).toEqual([]);
    const inbox = await listInbox({ tenantId: f.tenantId, actor: actorFor(f.seats.admin.memberId) }, { filter: "all" });
    expect(inbox.rows.find((r) => r.kind === "credential.ask_declined")?.subject).toEqual({
      title: "Acme",
      href: `/clients/${acme}/vault`,
    });
    // Once.
    expect(await outcome(declinePortalLoginAsk(principal(carol), made.id, null))).toBe("NOT_FOUND");
  });

  it("a project's ask leads to the project's tab; only the person asked may decline; the note is bounded", async () => {
    await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
    const made = await askForLogin(owner(), ask({ clientId: null, projectId: acmeSite }));
    expect(await outcome(declinePortalLoginAsk(principal(dan), made.id, null))).toBe("NOT_FOUND");
    expect(await outcome(declinePortalLoginAsk(principal(carol), made.id, "x".repeat(501)))).toBe("INVALID_INPUT");
    await declinePortalLoginAsk(principal(carol), made.id, null);
    expect((await row(made.id)).declineNote).toBeNull();
    // The employee reaches only the site — told, and led to its tab.
    const inbox = await listInbox({ tenantId: f.tenantId, actor: actorFor(f.seats.employee.memberId) }, { filter: "all" });
    expect(inbox.rows.find((r) => r.kind === "credential.ask_declined")?.subject).toEqual({
      title: "Acme · ASKA",
      href: "/projects/ASKA/vault",
    });
  });
});

describe("the team's side: cancel, the list, the form's offer", () => {
  it("anyone who may ask THERE cancels; out of reach is NOT_FOUND; a second cancel says it ended", async () => {
    const made = await askForLogin(owner(), ask());
    // The employee reaches Acme's site only; the manager reaches everything.
    expect(await outcome(cancelLoginAsk(as(f.seats.employee.memberId), made.id))).toBe("NOT_FOUND");
    await cancelLoginAsk(as(f.seats.manager.memberId), made.id);
    expect(await row(made.id)).toMatchObject({ cancelledByMemberId: f.seats.manager.memberId });
    expect(await outcome(cancelLoginAsk(owner(), made.id))).toBe("LOGIN_ASK_ENDED");
    expect(await readPortalLoginAsk(principal(carol), made.id)).toBeNull();
    const audit = await f.platform.auditEvent.findFirstOrThrow({
      where: { tenantId: f.tenantId, action: "credential.ask_cancelled", targetId: made.id },
    });
    expect(audit.metadata).toEqual({ clientId: acme, projectId: null });
  });

  it("the list: open first; by the vault's reach; stuck when nobody could answer", async () => {
    const open = await askForLogin(owner(), ask({ name: "Analytics" }));
    const listed = await listLoginAsks(owner(), { clientId: acme });
    const firstClosed = listed.findIndex((a) => a.state.kind !== "open");
    const lastOpen = listed.map((a) => a.state.kind).lastIndexOf("open");
    expect(firstClosed === -1 || lastOpen < firstClosed).toBe(true);
    expect(listed.find((a) => a.id === open.id)).toMatchObject({
      name: "Analytics",
      contact: { name: "Carol" },
      askedBy: expect.any(String),
      stuck: false,
    });
    // The employee reaches Acme's site only: no client-level ask is listed.
    const theirs = await listLoginAsks(as(f.seats.employee.memberId), { clientId: acme });
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.every((a) => a.projectId === acmeSite)).toBe(true);
    await updatePreferences(owner(), { vault: { allowContactSubmission: false } });
    try {
      expect((await listLoginAsks(owner(), { clientId: acme })).find((a) => a.id === open.id)?.stuck).toBe(true);
    } finally {
      await updatePreferences(owner(), { vault: { allowContactSubmission: true } });
    }
  });

  it("what the form may offer: who (main contacts first) and where (the client, portal projects in reach)", async () => {
    const all = await loginAskTargets(owner(), { clientId: acme, projectId: null });
    expect(all.canAsk).toBe(true);
    expect(all.open).toBe(true);
    expect(all.contacts[0]!.primary).toBe(true);
    expect(all.contacts.map((c) => c.id)).toContain(dan);
    expect(all.contacts.map((c) => c.id)).not.toContain(rex);
    expect(all.contacts.map((c) => c.id)).not.toContain(bo);
    expect(all.places).toEqual([
      { projectId: null },
      { projectId: acmeSite, label: "ASKA · Acme site" },
      { projectId: acmeLater, label: "ASKL · Acme later" },
    ]);
    // The employee, on Acme's page: Acme's site only. On the site's page: it.
    const employee = await loginAskTargets(as(f.seats.employee.memberId), { clientId: acme, projectId: null });
    expect(employee.places).toEqual([{ projectId: acmeSite, label: "ASKA · Acme site" }]);
    const onSite = await loginAskTargets(as(f.seats.employee.memberId), { clientId: acme, projectId: acmeSite });
    expect(onSite.places).toEqual([{ projectId: acmeSite, label: "ASKA · Acme site" }]);
    // Out of reach on a project's page is the page's NOT_FOUND.
    expect(await outcome(loginAskTargets(as(f.seats.employee.memberId), { clientId: acme, projectId: acmeLater }))).toBe(
      "NOT_FOUND",
    );
  });
});

describe("the guard, for any writer (migration 20261007180000)", () => {
  it("a member cannot record a send or a decline, nor change what was asked; SYSTEM cannot cancel", async () => {
    const made = await askForLogin(owner(), ask());
    const asMember = (data: Record<string, unknown>) =>
      withTenant(f.tenantId, { type: "member", id: f.seats.owner.memberId }, (tx) =>
        tx.credentialAsk.update({ where: { id: made.id }, data, select: { id: true } }),
      );
    const asSystem = (data: Record<string, unknown>) =>
      withTenant(f.tenantId, { type: "system" }, (tx) =>
        tx.credentialAsk.update({ where: { id: made.id }, data, select: { id: true } }),
      );
    await expect(asMember({ sentAt: new Date(), sentCredentialId: randomUUID() })).rejects.toThrow(/CREDENTIAL_ASK_GUARD/);
    await expect(asMember({ declinedAt: new Date(), declinedByContactId: carol })).rejects.toThrow(/CREDENTIAL_ASK_GUARD/);
    await expect(asMember({ name: "Something else" })).rejects.toThrow(/CREDENTIAL_ASK_GUARD/);
    await expect(asMember({ cancelledAt: new Date(), cancelledByMemberId: f.seats.admin.memberId })).rejects.toThrow(
      /CREDENTIAL_ASK_GUARD/,
    );
    await expect(asSystem({ cancelledAt: new Date(), cancelledByMemberId: f.seats.owner.memberId })).rejects.toThrow(
      /CREDENTIAL_ASK_GUARD/,
    );
    // A send naming a login the asked contact did not just hand over.
    await expect(asSystem({ sentAt: new Date(), sentCredentialId: randomUUID() })).rejects.toThrow(/CREDENTIAL_ASK_GUARD/);
    // A member asking as somebody else.
    await expect(
      withTenant(f.tenantId, { type: "member", id: f.seats.owner.memberId }, (tx) =>
        tx.credentialAsk.create({
          data: {
            tenantId: f.tenantId,
            clientId: acme,
            contactId: carol,
            type: "LOGIN",
            name: "As the admin",
            requestedByMemberId: f.seats.admin.memberId,
          },
        }),
      ),
    ).rejects.toThrow(/CREDENTIAL_ASK_GUARD/);
    // Ended once: nothing more, by anyone.
    await cancelLoginAsk(owner(), made.id);
    await expect(asSystem({ declinedAt: new Date(), declinedByContactId: carol })).rejects.toThrow(/CREDENTIAL_ASK_ENDED/);
  });

  it("a contact principal writes nothing; one login answers one ask", async () => {
    await expect(
      withTenant(f.tenantId, { type: "contact", id: carol, clientId: acme }, (tx) =>
        tx.credentialAsk.create({
          data: { tenantId: f.tenantId, clientId: acme, contactId: carol, type: "LOGIN", name: "Mine", requestedByMemberId: carol },
        }),
      ),
    ).rejects.toThrow();
    const fresh = await freshContact();
    const first = await askForLogin(owner(), ask({ contactId: fresh }));
    const second = await askForLogin(owner(), ask({ contactId: fresh }));
    await submitPortalCredential(principal(fresh), login({ askId: first.id }));
    const { sentCredentialId } = await row(first.id);
    // A login handed over in ANOTHER transaction never answers an ask — the
    // guard's `xmin` test (the pre-apply review's low)…
    await expect(
      withTenant(f.tenantId, { type: "system" }, (tx) =>
        tx.credentialAsk.update({
          where: { id: second.id },
          data: { sentAt: new Date(), sentCredentialId },
          select: { id: true },
        }),
      ),
    ).rejects.toThrow(/CREDENTIAL_ASK_GUARD/);
    // …and within one, the partial UNIQUE stops one login answering two.
    const third = await askForLogin(owner(), ask({ contactId: fresh }));
    await expect(
      withTenant(f.tenantId, { type: "system" }, async (tx) => {
        const made = await insertSubmittedCredential(tx, {
          tenantId: f.tenantId,
          clientId: acme,
          projectId: null,
          contactId: fresh,
          type: "LOGIN",
          name: "Twice",
          username: null,
          url: null,
          notes: null,
          fields: { password: "twice" },
        });
        for (const id of [second.id, third.id]) {
          await tx.credentialAsk.update({
            where: { id },
            data: { sentAt: new Date(), sentCredentialId: made.id },
            select: { id: true },
          });
        }
      }),
    ).rejects.toThrow(/credential_ask_sent_credential_unique|Unique constraint/);
    expect((await row(second.id)).sentAt).toBeNull();
    expect((await row(third.id)).sentAt).toBeNull();
  });
});

describe("deleteContact (C66 (c): a decline is the contact's writing)", () => {
  it("an unanswered ask goes with the contact; one they declined keeps them", async () => {
    const quiet = await freshContact();
    const unanswered = await askForLogin(owner(), ask({ contactId: quiet }));
    await f.platform.contact.update({ where: { id: quiet }, data: { portalStatus: "REVOKED" } });
    await deleteContact(owner(), quiet);
    expect(await f.platform.credentialAsk.findUnique({ where: { id: unanswered.id } })).toBeNull();

    const wrote = await freshContact();
    const declined = await askForLogin(owner(), ask({ contactId: wrote }));
    await declinePortalLoginAsk(principal(wrote), declined.id, "Not ours");
    await f.platform.contact.update({ where: { id: wrote }, data: { portalStatus: "REVOKED" } });
    expect(await outcome(deleteContact(owner(), wrote))).toBe("CONTACT_HAS_HISTORY");
  });
});
