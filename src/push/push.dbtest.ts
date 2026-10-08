import { createDecipheriv, createECDH, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant } from "@/db";
import { deliverPushes, forgetStaleDevices } from "@/jobs/push";
import { DomainError } from "@/lib/domain-error";
import { setupTenant } from "@/members/dbtest-fixture";
import type { NotificationKind } from "@/notify/catalog";
import { emit } from "@/notify/emit";
import { updateOwnPreferences } from "@/notify/preferences";
import { resetLocalLimiter } from "@/ratelimit";

import { MAX_PUSH_DEVICES, listOwnPushDevices, registerPushDevice, removePushDevice, resumePushDevices } from "./devices";
import { serverVapid } from "./keys";
import { classifyPushStatus, type PushOutcome, type PushTransport } from "./send";
import type { PushRequest } from "./web-push";

/**
 * PHONE AND BROWSER NOTIFICATIONS against the real database and app_runtime
 * (Phase 5 slice 106; founder decision C74 (a)–(k)): a member's own devices
 * (turn on, re-link, remove — and nobody else's, `own_device`); the push
 * ledger only the drain may write (`notification_pushed_at_guard`); the drain
 * — at most once, quiet hours never later, a live sign-in of the member's own,
 * this server's key only, the push service's answers, the window, the release
 * of what a pass never attempted; the housekeeping.
 *
 * NO NETWORK: every drain gets a RECORDING transport, and the receiving
 * "browser" is a key pair made here, so each body is decrypted as a browser
 * would. Only its own tenant is ever drained (`deliverPushes(f.tenantId, …)`).
 * `emit` runs outside a request here, where the kick does nothing — which one
 * test pins.
 *
 * THE CLOCK. The employee's zone is UTC, and quiet hours are placed around the
 * CURRENT UTC hour, as `quiet-hours.dbtest.ts` does.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let employee: string;
let manager: string;
let employeeUser: string;
let managerUser: string;
let employeeSession: string;

const hourNow = () => new Date().getUTCHours();

/** A "browser": its subscription as `toJSON()` gives it, and the private half to read what it receives. */
function browser() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/pushd-${randomUUID()}`,
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: auth.toString("base64url"),
    read(body: Buffer): unknown {
      const salt = body.subarray(0, 16);
      const idlen = body.readUInt8(20);
      const asPublic = body.subarray(21, 21 + idlen);
      const record = body.subarray(21 + idlen);
      const secret = ecdh.computeSecret(asPublic);
      const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic]);
      const ikm = Buffer.from(hkdfSync("sha256", secret, auth, keyInfo, 32));
      const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
      const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
      const d = createDecipheriv("aes-128-gcm", cek, nonce);
      d.setAuthTag(record.subarray(record.length - 16));
      const padded = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()]);
      return JSON.parse(padded.subarray(0, padded.lastIndexOf(0x02)).toString("utf8"));
    },
  };
}

/** A member-plane session row for a user, as Better Auth would hold it. */
async function sessionFor(userId: string, opts: { expired?: boolean; impersonatedBy?: string } = {}): Promise<string> {
  const id = randomUUID();
  await f.platform.session.create({
    data: {
      id,
      token: `pushd-${randomUUID()}`,
      userId,
      plane: "MEMBER",
      expiresAt: new Date(Date.now() + (opts.expired ? -60_000 : 7 * 86_400_000)),
      ...(opts.impersonatedBy ? { impersonatedBy: opts.impersonatedBy } : {}),
    },
  });
  return id;
}

const ctxOf = (memberId: string, sessionId: string, extra: { impersonated?: boolean } = {}) => ({
  tenantId: f.tenantId,
  actor: { memberId, mfa: { enrolled: true, verifiedAt: new Date() }, ...(extra.impersonated ? { impersonated: true } : {}) },
  sessionId,
  userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36",
});

const register = (b: ReturnType<typeof browser>, memberId = employee, sessionId = employeeSession) =>
  registerPushDevice(ctxOf(memberId, sessionId), { endpoint: b.endpoint, p256dh: b.p256dh, auth: b.auth });

/** A recording transport: every request kept, each answered by `answer` (delivered by default). */
function recorder(answer: (req: PushRequest, n: number) => PushOutcome | Promise<PushOutcome> = () => ({ kind: "delivered" })) {
  const sent: PushRequest[] = [];
  const transport: PushTransport = async (req) => {
    sent.push(req);
    return answer(req, sent.length);
  };
  return { sent, transport };
}

/** A notification to the employee, as the manager (or the system), outside any request. */
async function notify(kind: NotificationKind = "comment.mentioned", opts: { system?: boolean; to?: string } = {}): Promise<string> {
  const to = opts.to ?? employee;
  const entity = { type: "WorkItem", id: randomUUID() };
  await withTenant(f.tenantId, opts.system ? { type: "system" } : { type: "member", id: manager }, (tx) =>
    emit(tx, f.tenantId, {
      kind,
      entity,
      ...(opts.system ? {} : { actorMemberId: manager }),
      receivers: new Map([[to, "ASSIGNEE"]]),
    }),
  );
  const note = await f.platform.notification.findFirstOrThrow({ where: { tenantId: f.tenantId, entityId: entity.id }, select: { id: true } });
  return note.id;
}

const pushedAt = async (id: string) => (await f.platform.notification.findUniqueOrThrow({ where: { id }, select: { pushedAt: true } })).pushedAt;
const deliver = (transport: PushTransport, opts: { ids?: string[]; budgetMs?: number } = {}) =>
  deliverPushes(f.tenantId, { transport, ...opts });

beforeAll(async () => {
  f = await setupTenant("pushd");
  employee = f.seats.employee.memberId;
  manager = f.seats.manager.memberId;
  employeeUser = f.seats.employee.userId;
  managerUser = f.seats.manager.userId;
  await f.platform.member.update({ where: { id: employee }, data: { timezone: "UTC" } });
}, 120_000);

beforeEach(async () => {
  resetLocalLimiter();
  employeeSession = await sessionFor(employeeUser);
});

afterEach(async () => {
  if (!f) return;
  await f.platform.pushSubscription.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.notificationPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.session.deleteMany({ where: { token: { startsWith: "pushd-" }, userId: { in: Object.values(f.seats).map((s) => s.userId) } } });
  await f.platform.member.update({ where: { id: employee }, data: { status: "ACTIVE" } });
});

afterAll(async () => {
  if (!f) return;
  await f.platform.pushSubscription.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.notificationPreference.deleteMany({ where: { tenantId: f.tenantId } });
  // The tenant's data key, minted by the first device's encrypted keys: it RESTRICTs the tenant.
  await f.platform.tenantKey.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 120_000);

describe("a member's own devices", () => {
  it("turns a device on: keys encrypted, this server's key, a label, the session, one audit row naming no endpoint", async () => {
    const since = new Date(Date.now() - 1_000);
    const b = browser();
    const { id } = await register(b);
    const row = await f.platform.pushSubscription.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ tenantId: f.tenantId, memberId: employee, endpoint: b.endpoint, sessionId: employeeSession, failCount: 0 });
    expect(row.keysCiphertext.startsWith("v2.")).toBe(true);
    expect(row.keysCiphertext).not.toContain(b.p256dh);
    expect(row.vapidKey).toBe(serverVapid()!.fingerprint);
    expect(row.label).toBe("Chrome · Android");
    const audits = await f.platform.auditEvent.findMany({ where: { tenantId: f.tenantId, action: "push_device.added", createdAt: { gte: since } } });
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!.metadata)).not.toContain(b.endpoint);
    // The same browser again: the same row, re-linked, no second audit row.
    const session2 = await sessionFor(employeeUser);
    expect((await register(b, employee, session2)).id).toBe(id);
    expect((await f.platform.pushSubscription.findUniqueOrThrow({ where: { id } })).sessionId).toBe(session2);
    expect(await f.platform.auditEvent.count({ where: { tenantId: f.tenantId, action: "push_device.added", createdAt: { gte: since } } })).toBe(1);
  });

  it("refuses an endpoint that is not a push service, keys no push could use, and impersonation", async () => {
    const b = browser();
    for (const endpoint of ["https://evil.example/push", "http://fcm.googleapis.com/x", "https://fcm.googleapis.com.evil.example/x"]) {
      await expect(registerPushDevice(ctxOf(employee, employeeSession), { endpoint, p256dh: b.p256dh, auth: b.auth })).rejects.toMatchObject({
        code: "PUSH_DEVICE_INVALID",
      });
    }
    await expect(registerPushDevice(ctxOf(employee, employeeSession), { endpoint: b.endpoint, p256dh: "AAAA", auth: b.auth })).rejects.toBeInstanceOf(
      DomainError,
    );
    await expect(
      registerPushDevice(ctxOf(employee, employeeSession, { impersonated: true }), { endpoint: b.endpoint, p256dh: b.p256dh, auth: b.auth }),
    ).rejects.toBeInstanceOf(AuthzError);
    expect(await f.platform.pushSubscription.count({ where: { tenantId: f.tenantId } })).toBe(0);
  });

  it(`holds ${MAX_PUSH_DEVICES} devices and refuses the next`, async () => {
    for (let i = 0; i < MAX_PUSH_DEVICES; i += 1) await register(browser());
    await expect(register(browser())).rejects.toMatchObject({ code: "PUSH_DEVICE_LIMIT" });
  });

  it("is invisible and untouchable to a colleague (own_device); the system sees it", async () => {
    const { id } = await register(browser());
    const seen = await withTenant(f.tenantId, { type: "member", id: manager }, async (tx) => ({
      rows: await tx.pushSubscription.findMany({ where: { tenantId: f.tenantId } }),
      updated: (await tx.pushSubscription.updateMany({ where: { id }, data: { failCount: 2 } })).count,
      deleted: (await tx.pushSubscription.deleteMany({ where: { id } })).count,
    }));
    expect(seen).toEqual({ rows: [], updated: 0, deleted: 0 });
    // Nor can a colleague write a row that names someone else.
    await expect(
      withTenant(f.tenantId, { type: "member", id: manager }, (tx) =>
        tx.pushSubscription.createMany({
          data: [{ id: randomUUID(), tenantId: f.tenantId, memberId: employee, endpoint: browser().endpoint, keysCiphertext: "x", vapidKey: "x", label: "x", sessionId: "x", boundAt: new Date() }],
        }),
      ),
    ).rejects.toThrow();
    expect(await withTenant(f.tenantId, { type: "system" }, (tx) => tx.pushSubscription.count({ where: { id } }))).toBe(1);
    expect(await removePushDevice({ tenantId: f.tenantId, actor: f.seats.manager.actor }, id)).toBeNull();
    const since = new Date(Date.now() - 1_000);
    expect(await removePushDevice({ tenantId: f.tenantId, actor: f.seats.employee.actor }, id)).not.toBeNull();
    expect(await f.platform.auditEvent.count({ where: { tenantId: f.tenantId, action: "push_device.removed", createdAt: { gte: since } } })).toBe(1);
  });

  it("re-links the person's OWN row to a new sign-in, in place — never another member's, never a new row", async () => {
    const b = browser();
    const { id } = await register(b);
    // Audit rows outlive each test; this one counts only its own, after the turn-on.
    const since = new Date();
    const later = await sessionFor(employeeUser);
    const asEmployee = { sessionId: later, impersonated: false, memberships: [{ tenantId: f.tenantId, memberId: employee }] };
    expect(await resumePushDevices(asEmployee, { endpoint: b.endpoint, p256dh: b.p256dh, auth: b.auth })).toBe(1);
    expect((await f.platform.pushSubscription.findUniqueOrThrow({ where: { id } })).sessionId).toBe(later);
    // Again on the same session: nothing to do.
    expect(await resumePushDevices(asEmployee, { endpoint: b.endpoint, p256dh: b.p256dh, auth: b.auth })).toBe(0);
    // The manager signing in on that browser re-links nothing and creates nothing.
    const managerSession = await sessionFor(managerUser);
    expect(
      await resumePushDevices(
        { sessionId: managerSession, impersonated: false, memberships: [{ tenantId: f.tenantId, memberId: manager }] },
        { endpoint: b.endpoint, p256dh: b.p256dh, auth: b.auth },
      ),
    ).toBe(0);
    expect(await f.platform.pushSubscription.count({ where: { tenantId: f.tenantId } })).toBe(1);
    // Impersonated: nothing.
    expect(await resumePushDevices({ ...asEmployee, sessionId: managerSession, impersonated: true }, { endpoint: b.endpoint, p256dh: b.p256dh, auth: b.auth })).toBe(0);
    // A row made under another key is not this server's to re-link.
    await f.platform.pushSubscription.update({ where: { id }, data: { vapidKey: "another-key" } });
    expect(await resumePushDevices({ ...asEmployee, sessionId: managerSession }, { endpoint: b.endpoint, p256dh: b.p256dh, auth: b.auth })).toBe(0);
    // No audit row for any re-link (C74 (k)).
    expect(await f.platform.auditEvent.count({ where: { tenantId: f.tenantId, action: { startsWith: "push_device." }, createdAt: { gte: since } } })).toBe(0);
  });

  it("lists the member's devices with whether each one's sign-in is alive", async () => {
    const live = browser();
    const dormant = browser();
    await register(live);
    const ended = await sessionFor(employeeUser);
    await register(dormant, employee, ended);
    await f.platform.session.delete({ where: { id: ended } });
    const rows = await listOwnPushDevices({ tenantId: f.tenantId, actor: f.seats.employee.actor, userId: employeeUser });
    expect(rows.map((r) => r.signedIn).sort()).toEqual([false, true]);
    expect(JSON.stringify(rows)).not.toContain(live.endpoint);
  });
});

describe("the push ledger is the drain's alone", () => {
  it("refuses a member setting or clearing pushed_at, by update or insert; the system may", async () => {
    const id = await notify();
    await expect(
      withTenant(f.tenantId, { type: "member", id: employee }, (tx) => tx.notification.updateMany({ where: { id }, data: { pushedAt: new Date() } })),
    ).rejects.toThrow(/pushed_at is written by the push drain only/);
    await expect(
      withTenant(f.tenantId, { type: "member", id: manager }, (tx) =>
        tx.notification.createMany({
          data: [
            {
              id: randomUUID(),
              tenantId: f.tenantId,
              receiverType: "MEMBER",
              receiverId: employee,
              kind: "comment.mentioned",
              class: "INSTANT",
              entityType: "WorkItem",
              entityId: randomUUID(),
              reason: "ASSIGNEE",
              pushedAt: new Date(),
            },
          ],
        }),
      ),
    ).rejects.toThrow(/pushed_at is written by the push drain only/);
    // A member's ordinary write to their own row still works.
    await withTenant(f.tenantId, { type: "member", id: employee }, (tx) => tx.notification.updateMany({ where: { id }, data: { readAt: new Date() } }));
    expect(await withTenant(f.tenantId, { type: "system" }, (tx) => tx.notification.updateMany({ where: { id }, data: { pushedAt: new Date() } }))).toMatchObject({
      count: 1,
    });
  });

  it("refuses a CONTACT setting pushed_at on its own row — the census lists the column, the trigger holds it", async () => {
    const clientId = randomUUID();
    const contactId = randomUUID();
    const id = randomUUID();
    await f.platform.client.create({ data: { id: clientId, tenantId: f.tenantId, name: "Pushd Client" } });
    await f.platform.contact.create({
      data: { id: contactId, tenantId: f.tenantId, clientId, name: "Pushd Contact", email: `pushd-${randomUUID()}@test.invalid` },
    });
    try {
      await f.platform.notification.create({
        data: {
          id,
          tenantId: f.tenantId,
          receiverType: "CONTACT",
          receiverId: contactId,
          clientId,
          kind: "work_item.commented",
          class: "INSTANT",
          entityType: "WorkItem",
          entityId: randomUUID(),
        },
      });
      const asContact = { type: "contact" as const, id: contactId, clientId };
      await expect(
        withTenant(f.tenantId, asContact, (tx) => tx.notification.updateMany({ where: { id }, data: { pushedAt: new Date() } })),
      ).rejects.toThrow(/pushed_at is written by the push drain only/);
      // The positive control: its own inbox flag still writes, so the refusal above is the trigger, not RLS.
      expect(await withTenant(f.tenantId, asContact, (tx) => tx.notification.updateMany({ where: { id }, data: { readAt: new Date() } }))).toMatchObject({
        count: 1,
      });
    } finally {
      await f.platform.notification.deleteMany({ where: { id } });
      await f.platform.contact.deleteMany({ where: { id: contactId } });
      await f.platform.client.deleteMany({ where: { id: clientId } });
    }
  });
});

describe("the drain", () => {
  it("sends a mention to the member's live device: the inbox's own line, no name, an open link, a TTL inside the window", async () => {
    const b = browser();
    const { id: deviceId } = await register(b);
    const id = await notify("comment.mentioned");
    const r = recorder();
    expect(await deliver(r.transport)).toMatchObject({ sent: 1, dropped: 0, failed: 0 });
    expect(r.sent).toHaveLength(1);
    const req = r.sent[0]!;
    expect(req.endpoint.toString()).toBe(b.endpoint);
    expect(req.headers["Authorization"]).toMatch(/^vapid t=/);
    expect(Number(req.headers["TTL"])).toBeGreaterThan(0);
    expect(Number(req.headers["TTL"])).toBeLessThanOrEqual(900);
    expect(b.read(req.body)).toEqual({ v: 1, id, title: "Fortleva", body: "You were mentioned", url: `/inbox/open/${id}` });
    expect(await pushedAt(id)).not.toBeNull();
    expect((await f.platform.pushSubscription.findUniqueOrThrow({ where: { id: deviceId } })).lastSentAt).not.toBeNull();
  });

  it("pushes at most once — again, and from two drains at the same moment", async () => {
    await register(browser());
    await notify();
    const r = recorder();
    await deliver(r.transport);
    await deliver(r.transport);
    expect(r.sent).toHaveLength(1);
    await notify();
    const both = recorder();
    await Promise.all([deliver(both.transport), deliver(both.transport)]);
    expect(both.sent).toHaveLength(1);
  });

  it("follows the PHONE level: Nothing sends nothing, Mentions sends a mention and not an assignment — each stamped and done", async () => {
    await register(browser());
    await updateOwnPreferences({ tenantId: f.tenantId, actor: f.seats.employee.actor }, { pushLevel: "NONE" });
    const muted = await notify("comment.mentioned");
    const r = recorder();
    expect(await deliver(r.transport)).toMatchObject({ sent: 0, dropped: 1 });
    expect(await pushedAt(muted)).not.toBeNull();
    await updateOwnPreferences({ tenantId: f.tenantId, actor: f.seats.employee.actor }, { pushLevel: "MENTIONS" });
    const assigned = await notify("work_item.assigned");
    const mentioned = await notify("comment.mentioned");
    await deliver(r.transport);
    expect(r.sent).toHaveLength(1);
    expect(await pushedAt(assigned)).not.toBeNull();
    expect(await pushedAt(mentioned)).not.toBeNull();
    // The email level is a different setting: the mail for the mention is queued as ever.
    expect(await f.platform.emailOutbox.count({ where: { tenantId: f.tenantId, kind: "comment.mentioned" } })).toBe(2);
  });

  it("buzzes the owners' logins alarm at Mentions (C74 (i))", async () => {
    await register(browser());
    await updateOwnPreferences({ tenantId: f.tenantId, actor: f.seats.employee.actor }, { pushLevel: "MENTIONS" });
    await notify("contact.logins_alarm", { system: true });
    const r = recorder();
    expect(await deliver(r.transport)).toMatchObject({ sent: 1 });
  });

  it("drops a push inside quiet hours and never sends it later (C74 (c))", async () => {
    await register(browser());
    await updateOwnPreferences({ tenantId: f.tenantId, actor: f.seats.employee.actor }, { quietHours: { from: hourNow(), to: (hourNow() + 2) % 24 } });
    const id = await notify();
    const r = recorder();
    expect(await deliver(r.transport)).toMatchObject({ sent: 0, dropped: 1 });
    await updateOwnPreferences({ tenantId: f.tenantId, actor: f.seats.employee.actor }, { quietHours: null });
    await deliver(r.transport);
    expect(r.sent).toHaveLength(0);
    expect(await pushedAt(id)).not.toBeNull();
  });

  it("drops what was already read in the inbox", async () => {
    await register(browser());
    const id = await notify();
    await f.platform.notification.update({ where: { id }, data: { readAt: new Date() } });
    const r = recorder();
    expect(await deliver(r.transport)).toMatchObject({ sent: 0, dropped: 1 });
  });

  it("sends only to a LIVE sign-in of the member's own user — not ended, expired, another user's, or impersonated (C74 (d))", async () => {
    const r = recorder();
    const cases: Array<() => Promise<string>> = [
      async () => {
        const s = await sessionFor(employeeUser);
        await register(browser(), employee, s);
        await f.platform.session.delete({ where: { id: s } });
        return "ended";
      },
      async () => {
        await register(browser(), employee, await sessionFor(employeeUser, { expired: true }));
        return "expired";
      },
      async () => {
        await register(browser(), employee, await sessionFor(managerUser));
        return "another user's";
      },
      async () => {
        await register(browser(), employee, await sessionFor(employeeUser, { impersonatedBy: randomUUID() }));
        return "impersonated";
      },
    ];
    for (const make of cases) {
      const label = await make();
      const id = await notify();
      await deliver(r.transport);
      expect(r.sent, label).toHaveLength(0);
      expect(await pushedAt(id), label).not.toBeNull();
      await f.platform.pushSubscription.deleteMany({ where: { tenantId: f.tenantId } });
    }
  });

  it("drops it for a member no longer active", async () => {
    await register(browser());
    await notify();
    await f.platform.member.update({ where: { id: employee }, data: { status: "SUSPENDED" } });
    const r = recorder();
    expect(await deliver(r.transport)).toMatchObject({ sent: 0, dropped: 1 });
  });

  it("acts on the push service's answer, through the real classifier: gone deletes, three refusals delete, 401/403/406/429/5xx count for nothing", async () => {
    /** A transport that answers with an HTTP status, classified exactly as the real one classifies it. */
    const answering = (status: number) => recorder(() => classifyPushStatus(status)).transport;

    const gone = await register(browser());
    await notify();
    await deliver(answering(410));
    expect(await f.platform.pushSubscription.count({ where: { id: gone.id } })).toBe(0);

    const refused = await register(browser());
    for (let i = 1; i <= 3; i += 1) {
      await notify();
      await deliver(answering(400));
      expect(await f.platform.pushSubscription.count({ where: { id: refused.id } }), `after ${i}`).toBe(i < 3 ? 1 : 0);
    }

    // Ours or the vendor's, never the device's (both reviews' medium): a VAPID
    // signature refused, Microsoft's throttling, a rate limit, an outage.
    const troubled = await register(browser());
    for (const status of [401, 403, 403, 403, 406, 429, 503]) {
      await notify();
      await deliver(answering(status));
    }
    await notify();
    await deliver(recorder(() => ({ kind: "transient", status: null, error: "TimeoutError" })).transport);
    expect((await f.platform.pushSubscription.findUniqueOrThrow({ where: { id: troubled.id } })).failCount).toBe(0);
  });

  it("never writes a refusal count from a snapshot: another drain's count, changed mid-pass, is kept or added to (the code review's low)", async () => {
    const d = await register(browser());
    /** The device's count moved by "another drain" while this pass's send is in flight — after the claim read it. */
    const meanwhile = (status: number) =>
      recorder(async () => {
        await f.platform.pushSubscription.update({ where: { id: d.id }, data: { failCount: 2 } });
        return classifyPushStatus(status);
      }).transport;
    await notify();
    await deliver(meanwhile(503));
    // The vendor's trouble wrote nothing: not the 0 this pass read at its claim.
    expect((await f.platform.pushSubscription.findUniqueOrThrow({ where: { id: d.id } })).failCount).toBe(2);
    await f.platform.pushSubscription.update({ where: { id: d.id }, data: { failCount: 0 } });
    await notify();
    await deliver(meanwhile(400));
    // A refusal ADDS to what the row holds now (2 + 1): forgotten — not 0 + 1 from the claim.
    expect(await f.platform.pushSubscription.count({ where: { id: d.id } })).toBe(0);
  });

  it("a delivery resets the refusal count", async () => {
    const d = await register(browser());
    await notify();
    await deliver(recorder(() => ({ kind: "refused", status: 400 })).transport);
    expect((await f.platform.pushSubscription.findUniqueOrThrow({ where: { id: d.id } })).failCount).toBe(1);
    await notify();
    await deliver(recorder().transport);
    expect((await f.platform.pushSubscription.findUniqueOrThrow({ where: { id: d.id } })).failCount).toBe(0);
  });

  it("never claims what is older than the window, nor a device made under another key", async () => {
    await register(browser());
    const old = await notify();
    await f.platform.notification.update({ where: { id: old }, data: { createdAt: new Date(Date.now() - 16 * 60_000) } });
    const r = recorder();
    await deliver(r.transport);
    expect(r.sent).toHaveLength(0);
    expect(await pushedAt(old)).toBeNull();

    await f.platform.pushSubscription.updateMany({ where: { tenantId: f.tenantId }, data: { vapidKey: "another-environment" } });
    const fresh = await notify();
    await deliver(r.transport);
    expect(r.sent).toHaveLength(0);
    // Not this server's to decide: left for the server that holds that key.
    expect(await pushedAt(fresh)).toBeNull();
  });

  it("a kick delivers only the ids it was given", async () => {
    await register(browser());
    const mine = await notify();
    const other = await notify();
    const r = recorder();
    await deliver(r.transport, { ids: [mine] });
    expect(r.sent).toHaveLength(1);
    expect(await pushedAt(mine)).not.toBeNull();
    expect(await pushedAt(other)).toBeNull();
  });

  it("hands back what a pass claimed and never got to (the budget ran out before its send started)", async () => {
    await register(browser());
    const first = await notify();
    const second = await notify();
    // The first send outlasts the whole budget; the second is never started.
    const r = recorder(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5_400));
      return { kind: "delivered" };
    });
    const result = await deliver(r.transport, { budgetMs: 5_100 });
    expect(r.sent).toHaveLength(1);
    expect(result.released).toBe(1);
    const stamped = [await pushedAt(first), await pushedAt(second)];
    expect(stamped.filter((s) => s === null)).toHaveLength(1);
  }, 30_000);

  it("on one browser shared by two members, only the most recently linked one's row gets pushes (L2)", async () => {
    const b = browser();
    await register(b, employee, employeeSession);
    // The manager signs in there later (the employee's session row outlived its cookie) and turns it on.
    await register(b, manager, await sessionFor(managerUser));
    await notify("comment.mentioned");
    const r = recorder();
    await deliver(r.transport);
    expect(r.sent).toHaveLength(0);
  });

  it("a notification made outside a request is never kicked — only a drain sends it", async () => {
    await register(browser());
    const id = await notify();
    // Long enough for a detached drain to have claimed it over the slowest
    // link this suite runs on (the code review's low: 200 ms proved nothing
    // on Neon). `kick.test.ts` pins the rule itself.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    expect(await pushedAt(id)).toBeNull();
  });
});

describe("housekeeping", () => {
  it("forgets a device dormant 90 days, or whose member is no longer active — and keeps the rest", async () => {
    const dormantOld = await register(browser(), employee, await sessionFor(employeeUser));
    const dormantNew = await register(browser(), employee, await sessionFor(employeeUser));
    const live = await register(browser());
    await f.platform.session.deleteMany({
      where: { id: { in: (await f.platform.pushSubscription.findMany({ where: { id: { in: [dormantOld.id, dormantNew.id] } } })).map((r) => r.sessionId) } },
    });
    await f.platform.pushSubscription.update({ where: { id: dormantOld.id }, data: { boundAt: new Date(Date.now() - 91 * 86_400_000) } });
    await f.platform.pushSubscription.update({ where: { id: live.id }, data: { boundAt: new Date(Date.now() - 200 * 86_400_000) } });
    expect(await forgetStaleDevices(f.tenantId)).toBe(1);
    expect((await f.platform.pushSubscription.findMany({ where: { tenantId: f.tenantId }, select: { id: true } })).map((r) => r.id).sort()).toEqual(
      [dormantNew.id, live.id].sort(),
    );
    await f.platform.member.update({ where: { id: employee }, data: { status: "SUSPENDED" } });
    expect(await forgetStaleDevices(f.tenantId)).toBe(2);
  });
});
