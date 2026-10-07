import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resetTenantDekCache } from "@/crypto/tenant-key";
import { withTenant } from "@/db";
import { setTransport, type MailTransport } from "@/mailer";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { listInbox } from "@/notify/inbox";
import { resolvePortalModuleGates, type PortalPrincipal } from "@/portal";
import { lockContactBudget } from "@/portal/contact-budget-lock";
import { updatePreferences } from "@/preferences/service";
import { resetLocalLimiter } from "@/ratelimit";

import {
  askToOpenSealedLogins,
  doorAlarmSubjects,
  openPortalLoginsDoor,
  startPortalLoginsDoor,
  type LoginsCodeMail,
  type PasswordCheck,
} from "./index";

/**
 * THE DOOR'S ALARM against the real database (Phase 3V slice 99; founder
 * decision C67 (b)–(e)). Five wrong portal passwords in a day at a client's
 * logins page — the door's and the sealed ask's counted together — or five
 * wrong mailed codes in a day, over any number of openings, tell the OWNERS
 * (an inbox row, and a security mail whatever their email level) and the
 * client PERSON (a mail in their language); at most once per SIGN per
 * person a day; nobody else hears. Two refusals at once raise one alarm. An
 * alarm that cannot be checked changes nothing about the refusal, and the
 * next refusal raises it from what is stored. A check that failed for a
 * reason that says nothing about the password records nothing and raises
 * nothing. The windows are a day: rows older than it count for nothing. The
 * inbox names the person and their client only to a reader who reaches that
 * client.
 *
 * Every case takes its OWN contact: the rules count a day of a contact's
 * audit rows, which a test cannot delete.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;
let acme: string;

const RUN = randomUUID().slice(0, 8);
const HOUR_MS = 60 * 60_000;
const ownerCtx = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.owner.memberId) });
const principal = (contactId: string): PortalPrincipal => ({ contactId, tenantId: f.tenantId, clientId: acme, gates });
const at = (contactId: string, sessionId: string = randomUUID()) => ({ principal: principal(contactId), sessionId });

const right: PasswordCheck = async () => "ok";
const wrong: PasswordCheck = async () => "wrong";
const unavailable: PasswordCheck = async () => "unavailable";

const mailbox: { to: string; text: string }[] = [];
let previousTransport: MailTransport | undefined;
const compose: LoginsCodeMail = ({ code }) => ({ subject: "Your code", text: `code ${code}` });
const lastCodeTo = (to: string): string => {
  const code = mailbox.filter((m) => m.to === to).at(-1)?.text.match(/code ([0-9]{6})/)?.[1];
  if (!code) throw new Error(`no code mailed to ${to}`);
  return code;
};

/** A fresh MAIN contact at Acme, for one case. */
const person = async (label: string): Promise<{ id: string; email: string; name: string }> => {
  const id = randomUUID();
  const email = `valarm-${label}-${RUN}@test.invalid`;
  const name = `Person ${label} ${RUN}`;
  await f.platform.contact.create({
    data: {
      id,
      tenantId: f.tenantId,
      clientId: acme,
      name,
      email,
      locale: "sv",
      portalProfile: "CONTACT_PRIMARY",
      portalStatus: "ACTIVE",
      invitedAt: new Date("2026-09-01T09:00:00Z"),
      emailVerified: true,
    },
  });
  return { id, email, name };
};

const alarms = (contactId: string) =>
  f.platform.auditEvent.findMany({
    where: { tenantId: f.tenantId, action: "portal.logins_alarm_raised", targetId: contactId, actorType: "SYSTEM" },
    select: { actorType: true, actorId: true, targetType: true, metadata: true },
    orderBy: { createdAt: "asc" },
  });
const signsOf = async (contactId: string) =>
  (await alarms(contactId)).map((a) => (a.metadata as { signs: string[] }).signs);
const inboxRows = (contactId: string) =>
  f.platform.notification.findMany({
    where: { tenantId: f.tenantId, kind: "contact.logins_alarm", entityId: contactId },
    select: { receiverType: true, receiverId: true, entityType: true, clientId: true, dedupeKey: true },
  });
const mails = (receiverIdOrEmail: string) =>
  f.platform.emailOutbox.findMany({
    where: {
      tenantId: f.tenantId,
      kind: { in: ["vault.door_alarm", "portal.logins_alarm"] },
      OR: [{ receiverId: receiverIdOrEmail }, { toEmail: receiverIdOrEmail }],
    },
    select: { receiverType: true, receiverId: true, toEmail: true, kind: true, locale: true, params: true, idempotencyKey: true },
  });
const alarmMailsFor = async (contactId: string) => {
  const ids = (await alarms(contactId)).map((a) => (a.metadata as { alarmId: string }).alarmId);
  return f.platform.emailOutbox.findMany({
    where: { tenantId: f.tenantId, OR: ids.map((id) => ({ idempotencyKey: { startsWith: `logins_alarm:${id}:` } })) },
    select: { receiverType: true, receiverId: true, kind: true },
  });
};

const wrongPasswords = async (contactId: string, n: number) => {
  for (let i = 0; i < n; i += 1) {
    expect(await startPortalLoginsDoor(at(contactId), wrong, compose)).toEqual({ ok: false, reason: "wrong_password" });
  }
};

/** Start a door with the right password, then type `n` wrong codes at it. */
const wrongCodes = async (c: { id: string; email: string }, n: number) => {
  const session = randomUUID();
  expect(await startPortalLoginsDoor(at(c.id, session), right, compose)).toEqual({ ok: true });
  const code = lastCodeTo(c.email);
  const wrongCode = code === "000000" ? "111111" : "000000";
  for (let i = 0; i < n; i += 1) await openPortalLoginsDoor(at(c.id, session), wrongCode);
};

/** Audit rows of a contact's, dated `hoursAgo` back — the window's far side. */
const plant = (
  contactId: string,
  action: string,
  n: number,
  hoursAgo: number,
  extra: { actorType?: "SYSTEM" | "MEMBER" | "CONTACT"; metadata?: Record<string, string | string[]> } = {},
) =>
  f.platform.auditEvent.createMany({
    data: Array.from({ length: n }, () => ({
      tenantId: f.tenantId,
      action,
      actorType: extra.actorType ?? ("CONTACT" as const),
      actorId: (extra.actorType ?? "CONTACT") === "CONTACT" ? contactId : (extra.actorType === "MEMBER" ? f.seats.owner.memberId : null),
      targetType: "Contact",
      targetId: contactId,
      visibility: "TENANT" as const,
      ...(extra.metadata ? { metadata: extra.metadata } : {}),
      createdAt: new Date(Date.now() - hoursAgo * HOUR_MS),
    })),
  });

beforeAll(async () => {
  f = await setupTenant("valarm");
  acme = randomUUID();
  await f.platform.client.create({ data: { id: acme, tenantId: f.tenantId, name: "Acme" } });
  gates = await resolvePortalModuleGates(f.tenantId);
  previousTransport = setTransport(async (msg) => {
    mailbox.push({ to: msg.to, text: msg.text });
  });
  // The door needs something behind it: client logins switched on.
  await updatePreferences(ownerCtx(), { vault: { allowPortalCredentials: true } });
  // The owner has chosen NO mail at all — the alarm's mail is a security
  // notice and goes anyway (C63 (b)'s precedent).
  await f.platform.notificationPreference.create({
    data: { tenantId: f.tenantId, receiverType: "MEMBER", receiverId: f.seats.owner.memberId, emailLevel: "NONE" },
  });
}, 180_000);

beforeEach(() => resetLocalLimiter());

afterAll(async () => {
  if (previousTransport) setTransport(previousTransport);
  if (f) {
    await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.notificationPreference.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
    // Doors go with their contact (FK cascade).
    await f.platform.contact.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.tenantKey.deleteMany({ where: { tenantId: f.tenantId } });
  }
  resetTenantDekCache();
  await f?.cleanup();
}, 180_000);

describe("the door's alarm — what raises it", () => {
  it("four wrong passwords raise nothing; the fifth tells the owners and the person, once", async () => {
    const c = await person("five");
    await wrongPasswords(c.id, 4);
    expect(await alarms(c.id)).toEqual([]);

    await wrongPasswords(c.id, 1);
    const raised = await alarms(c.id);
    expect(raised).toHaveLength(1);
    const meta = raised[0]!.metadata as { clientId: string; alarmId: string; signs: string[] };
    expect(raised[0]).toMatchObject({ actorType: "SYSTEM", actorId: null, targetType: "Contact" });
    expect(meta).toEqual({ clientId: acme, alarmId: expect.any(String), signs: ["passwords"] });

    // The owners' inbox — the owner only; no admin, manager or employee.
    expect(await inboxRows(c.id)).toEqual([
      {
        receiverType: "MEMBER",
        receiverId: f.seats.owner.memberId,
        entityType: "Contact",
        clientId: acme,
        dedupeKey: `logins_alarm:${meta.alarmId}`,
      },
    ]);
    // Two mails: the owner's security notice (whatever their level — NONE
    // here) and the person's, in their language.
    const sent = await alarmMailsFor(c.id);
    expect(sent.sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      { receiverType: "CONTACT", receiverId: c.id, kind: "portal.logins_alarm" },
      { receiverType: "MEMBER", receiverId: f.seats.owner.memberId, kind: "vault.door_alarm" },
    ]);
    expect(await mails(c.email)).toEqual([
      expect.objectContaining({ toEmail: c.email, kind: "portal.logins_alarm", locale: "sv", params: {} }),
    ]);
    const toOwner = (await mails(f.seats.owner.memberId)).filter((m) => m.idempotencyKey.startsWith(`logins_alarm:${meta.alarmId}:`));
    expect(toOwner).toEqual([expect.objectContaining({ kind: "vault.door_alarm", params: { clientId: acme } })]);

    // The sixth, the same day: nothing new.
    await wrongPasswords(c.id, 1);
    expect(await alarms(c.id)).toHaveLength(1);
    expect(await inboxRows(c.id)).toHaveLength(1);
  });

  it("an opening whose five tries are all spent raises it — the fourth wrong code does not", async () => {
    const c = await person("codes");
    const session = randomUUID();
    expect(await startPortalLoginsDoor(at(c.id, session), right, compose)).toEqual({ ok: true });
    const code = lastCodeTo(c.email);
    const wrongCode = code === "000000" ? "111111" : "000000";
    for (let i = 4; i >= 1; i -= 1) {
      expect(await openPortalLoginsDoor(at(c.id, session), wrongCode)).toEqual({ ok: false, reason: "wrong_code", attemptsLeft: i });
    }
    expect(await alarms(c.id)).toEqual([]);
    // The fifth spends the door; what the person is told is unchanged.
    expect(await openPortalLoginsDoor(at(c.id, session), wrongCode)).toEqual({ ok: false, reason: "start_again" });
    expect(await signsOf(c.id)).toEqual([["codes"]]);
    expect(await inboxRows(c.id)).toHaveLength(1);
  });

  it("five wrong codes in a day raise it however many openings they are spread over (C67 (d))", async () => {
    const c = await person("spread");
    // Four tries at one opening and none spent — the gap the security review found.
    await wrongCodes(c, 4);
    expect(await alarms(c.id)).toEqual([]);
    await wrongCodes(c, 1);
    expect(await signsOf(c.id)).toEqual([["codes"]]);
  });

  it("the sealed ask's wrong passwords count toward the five", async () => {
    const c = await person("sealed");
    await wrongPasswords(c.id, 3);
    for (let i = 0; i < 2; i += 1) {
      expect(await askToOpenSealedLogins(at(c.id), wrong, "We need them")).toEqual({ ok: false, reason: "wrong_password" });
    }
    expect(await signsOf(c.id)).toEqual([["passwords"]]);
  });

  it("a right password and a right code raise nothing", async () => {
    const c = await person("right");
    const session = randomUUID();
    expect(await startPortalLoginsDoor(at(c.id, session), right, compose)).toEqual({ ok: true });
    expect((await openPortalLoginsDoor(at(c.id, session), lastCodeTo(c.email))).ok).toBe(true);
    expect(await alarms(c.id)).toEqual([]);
  });

  it("a check that failed for another reason says 'try again', records no refusal and raises nothing", async () => {
    const c = await person("unavailable");
    for (let i = 0; i < 6; i += 1) {
      expect(await startPortalLoginsDoor(at(c.id), unavailable, compose)).toEqual({ ok: false, reason: "busy" });
    }
    expect(await askToOpenSealedLogins(at(c.id), unavailable, "We need them")).toEqual({ ok: false, reason: "busy" });
    expect(
      await f.platform.auditEvent.count({
        where: { tenantId: f.tenantId, action: "portal.logins_password_refused", actorId: c.id },
      }),
    ).toBe(0);
    expect(await alarms(c.id)).toEqual([]);
  });
});

describe("the door's alarm — how often", () => {
  it("one alarm per SIGN per person a day: wrong codes after a password alarm still reach the owners, nothing after both (C67 (e))", async () => {
    const c = await person("kinds");
    await wrongPasswords(c.id, 5);
    expect(await signsOf(c.id)).toEqual([["passwords"]]);
    // They now know the password: the codes are a new, worse sign.
    await wrongCodes(c, 5);
    expect(await signsOf(c.id)).toEqual([["passwords"], ["codes"]]);
    expect(await inboxRows(c.id)).toHaveLength(2);
    // Both reported today: nothing more, of either kind.
    await wrongPasswords(c.id, 2);
    await wrongCodes(c, 5);
    expect(await alarms(c.id)).toHaveLength(2);
  });

  it("two fifth refusals at once raise one alarm", async () => {
    const c = await person("race");
    await wrongPasswords(c.id, 4);
    const both = await Promise.all([
      startPortalLoginsDoor(at(c.id), wrong, compose),
      startPortalLoginsDoor(at(c.id), wrong, compose),
    ]);
    expect(both).toEqual([
      { ok: false, reason: "wrong_password" },
      { ok: false, reason: "wrong_password" },
    ]);
    expect(await alarms(c.id)).toHaveLength(1);
    expect(await inboxRows(c.id)).toHaveLength(1);
  });

  it("an alarm that cannot be checked leaves the refusal standing, and the next refusal raises it", async () => {
    const c = await person("busy");
    await wrongPasswords(c.id, 4);
    // Hold the alarm's own key, so the fifth refusal's check waits out its
    // bound and is skipped.
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held!: () => void;
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });
    const holder = withTenant(
      f.tenantId,
      { type: "system" },
      async (tx) => {
        await lockContactBudget(tx, "portal_logins_alarm", c.id);
        held();
        await released;
      },
      { timeoutMs: 60_000 },
    );
    await holding;
    try {
      expect(await startPortalLoginsDoor(at(c.id), wrong, compose)).toEqual({ ok: false, reason: "wrong_password" });
    } finally {
      release();
      await holder;
    }
    // The refusal is counted; the alarm is not raised yet.
    expect(
      await f.platform.auditEvent.count({
        where: { tenantId: f.tenantId, action: "portal.logins_password_refused", actorId: c.id },
      }),
    ).toBe(5);
    expect(await alarms(c.id)).toEqual([]);
    // The next refusal reads what is stored and raises it.
    await wrongPasswords(c.id, 1);
    expect(await alarms(c.id)).toHaveLength(1);
  }, 60_000);
});

describe("the door's alarm — the day is a day", () => {
  it("refusals older than a day count for nothing: five wrong passwords 25 hours ago and one now raise nothing", async () => {
    const c = await person("old-passwords");
    await plant(c.id, "portal.logins_password_refused", 5, 25);
    await wrongPasswords(c.id, 1);
    expect(await alarms(c.id)).toEqual([]);
  });

  it("…nor do wrong codes 25 hours ago", async () => {
    const c = await person("old-codes");
    await plant(c.id, "portal.logins_code_refused", 5, 25);
    await wrongCodes(c, 1);
    expect(await alarms(c.id)).toEqual([]);
  });

  it("an alarm older than a day does not silence a new one; nor does an alarm row not written by the system", async () => {
    const c = await person("old-alarm");
    await plant(c.id, "portal.logins_alarm_raised", 1, 25, { actorType: "SYSTEM", metadata: { clientId: acme, alarmId: randomUUID(), signs: ["passwords"] } });
    await plant(c.id, "portal.logins_alarm_raised", 1, 1, { actorType: "MEMBER", metadata: { clientId: acme, alarmId: randomUUID(), signs: ["passwords"] } });
    await wrongPasswords(c.id, 5);
    // The two planted rows, then the one raised now.
    const fresh = (await alarms(c.id)).filter((a) => a.actorType === "SYSTEM");
    expect(fresh).toHaveLength(2);
    expect(await inboxRows(c.id)).toHaveLength(1);
  });
});

describe("the door's alarm — in the inbox", () => {
  it("the owner's inbox names the person and their client and links to the Contacts tab; a reader who does not reach the client gets no name", async () => {
    const c = await person("named");
    await wrongPasswords(c.id, 5);
    const rows = (await listInbox({ tenantId: f.tenantId, actor: actorFor(f.seats.owner.memberId) }, { filter: "all" })).rows;
    const mine = rows.filter((r) => r.kind === "contact.logins_alarm" && r.subject?.title === `${c.name} · Acme`);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.subject).toEqual({ title: `${c.name} · Acme`, href: `/clients/${acme}/contacts` });

    // The resolver itself, for a reader the row was never sent to: the
    // employee is assigned to no client, so it names nobody.
    const [row] = await f.platform.notification.findMany({
      where: { tenantId: f.tenantId, kind: "contact.logins_alarm", entityId: c.id },
      select: { id: true, kind: true, entityType: true, entityId: true },
    });
    const asEmployee = await withTenant(f.tenantId, { type: "member", id: f.seats.employee.memberId }, (tx) =>
      doorAlarmSubjects(tx, f.tenantId, actorFor(f.seats.employee.memberId), [row!]),
    );
    expect(asEmployee.size).toBe(0);
  });
});
