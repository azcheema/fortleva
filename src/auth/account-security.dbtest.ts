import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { APIError } from "better-auth/api";
import { symmetricDecrypt } from "better-auth/crypto";

/* eslint-disable no-restricted-imports -- dbtest reads/cleans via the raw layer */
import { getPlatformClient } from "@/db/client";
import { AuthzError } from "@/authz/errors";
import { DomainError } from "@/lib/domain-error";
import { setTransport, type MailTransport } from "@/mailer";
import { noMfa, setupTenant } from "@/members/dbtest-fixture";
import { provisionTenant } from "@/members/provisioning";
import { resetLocalLimiter } from "@/ratelimit";

import { backupCodesLeft, listOwnDevices, signOutOtherDevices, signOutOwnDevice } from "./account-security";
import { memberDatabaseHooks, onFactorReplaced, onSessionsRevoked } from "./audit-hooks";
import { replaceOwnFactor } from "./factor-replace";
import { auth } from "./index";
import { resetMemberTwoFactor, signOutMemberEverywhere } from "./member-reset";
import { runWithReplaceIntent } from "./replace-intent";
import { verifyStepUpWithHeaders } from "./step-up";

/**
 * SLICE 84 — ACCOUNT RECOVERY AND "YOUR DEVICES" (founder decision C50),
 * against the real `app_runtime` role and, for the member's own door, the
 * real Better Auth instance:
 *
 *  - an OWNER's reset of a teammate's two-factor and sign-out everywhere
 *    (`./member-reset`): who is refused, what is removed and what is left,
 *    the audit row and the mail;
 *  - the member's own REPLACEMENT (`./factor-replace`): a wrong password
 *    burns nothing, a password or session alone opens nothing, and a
 *    success kills the old factor and every other session;
 *  - "Your devices" (`./account-security`).
 */

const platform = getPlatformClient();
const FUTURE = () => new Date(Date.now() + 24 * 60 * 60_000);

/** Every mail this file causes, instead of the dev outbox. */
const mails: { to: string; subject: string; text: string }[] = [];
let restoreTransport: MailTransport | undefined;

beforeAll(() => {
  restoreTransport = setTransport(async (m) => {
    mails.push({ to: m.to, subject: m.subject, text: m.text });
  });
});

afterAll(() => {
  if (restoreTransport) setTransport(restoreTransport);
});

// The step-up's budget is strict (an in-process floor that counts on the
// harness's no-op limiter too), and this file steps one member up more
// than six times on purpose.
beforeEach(() => resetLocalLimiter());

/**
 * The tags of every planted row set, so cleanup deletes exactly those. An
 * attempt counter's value is a count, not a user — a pattern wide enough to
 * find ours by shape would also find a concurrent run's real sign-in.
 */
const planted: string[] = [];

/** A planted factor, sessions and verification rows — the state a reset must clear. */
async function plantSignIn(userId: string, sessions = 2) {
  await platform.user.update({ where: { id: userId }, data: { twoFactorEnabled: true } });
  await platform.twoFactor.create({
    data: { userId, secret: `planted-${randomUUID()}`, backupCodes: `planted-${randomUUID()}`, verified: true },
  });
  for (let i = 0; i < sessions; i++) {
    await platform.session.create({ data: { token: randomUUID(), userId, expiresAt: FUTURE() } });
  }
  const tag = randomUUID();
  planted.push(tag);
  await platform.verification.createMany({
    data: [
      { identifier: `trust-device-${tag}`, value: userId, expiresAt: FUTURE() },
      { identifier: `2fa-${tag}`, value: userId, expiresAt: FUTURE() },
      // An attempt counter carries a count, not the user: never matched.
      { identifier: `2fa-attempts-2fa-${tag}`, value: "0", expiresAt: FUTURE() },
      // A reset link is not a sign-in: no reset or sign-out touches it.
      { identifier: `pwreset#${tag}`, value: userId, expiresAt: FUTURE() },
    ],
  });
  return tag;
}

async function signInState(userId: string, tag: string) {
  const [user, factor, sessions, marks] = [
    await platform.user.findUniqueOrThrow({ where: { id: userId }, select: { twoFactorEnabled: true } }),
    await platform.twoFactor.findUnique({ where: { userId }, select: { id: true } }),
    await platform.session.count({ where: { userId } }),
    await platform.verification.findMany({
      where: { identifier: { contains: tag } },
      select: { identifier: true },
    }),
  ];
  return {
    enrolled: user.twoFactorEnabled,
    factor: factor !== null,
    sessions,
    // Sorted HERE, after the tag is masked: in SQL the order depended on
    // the random tag under the database's collation (it flaked once).
    marks: marks.map((m) => m.identifier.replace(tag, "<tag>")).sort(),
  };
}

async function clearSignIn(userId: string) {
  await platform.session.deleteMany({ where: { userId } });
  await platform.twoFactor.deleteMany({ where: { userId } });
  await platform.verification.deleteMany({ where: { value: userId } });
  await platform.verification.deleteMany({
    where: { identifier: { in: planted.map((tag) => `2fa-attempts-2fa-${tag}`) } },
  });
  await platform.user.update({ where: { id: userId }, data: { twoFactorEnabled: false, platformRole: null } });
}

const ALL_MARKS = ["2fa-<tag>", "2fa-attempts-2fa-<tag>", "pwreset#<tag>", "trust-device-<tag>"];

describe("the member's own door: replacing the authenticator, and \"Your devices\" (C50)", () => {
  const run = randomUUID().slice(0, 8);
  const email = `acsec-self-${run}@test.invalid`;
  // Per run, never a literal: this repository is public.
  const password = `pw-${randomUUID()}`;
  let userId: string;
  let tenantId: string | undefined;
  let memberId: string;
  let cookie = "";
  let enrolCodes: string[] = [];

  /** A Better Auth response's Set-Cookie headers as a request Cookie header. */
  const cookieJar = (headers: Headers | undefined, prior = ""): string => {
    const jar = new Map<string, string>();
    for (const pair of prior.split(";").map((s) => s.trim()).filter(Boolean)) {
      const [k, ...v] = pair.split("=");
      jar.set(k!, v.join("="));
    }
    for (const sc of headers?.getSetCookie() ?? []) {
      const [nameValue] = sc.split(";");
      const [name, ...rest] = nameValue!.split("=");
      const value = rest.join("=");
      if (value === "" || /Max-Age=0/i.test(sc)) jar.delete(name!);
      else jar.set(name!, value);
    }
    return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  };
  const withCookie = (c: string): Headers => new Headers({ cookie: c });

  const totpFor = async (encrypted: string): Promise<string> => {
    const secret = await symmetricDecrypt({ key: process.env["BETTER_AUTH_SECRET"]!, data: encrypted });
    return (await auth.api.generateTOTP({ body: { secret } })).code;
  };
  const currentTotp = async () => totpFor((await platform.twoFactor.findUniqueOrThrow({ where: { userId } })).secret);
  const currentSessionId = async () => (await auth.api.getSession({ headers: withCookie(cookie) }))!.session.id;
  const plantDevice = (userAgent: string, ipAddress: string | null) =>
    platform.session.create({ data: { token: randomUUID(), userId, expiresAt: FUTURE(), userAgent, ipAddress } });
  const auditRows = (action: string) =>
    platform.auditEvent.findMany({ where: { tenantId, action }, orderBy: { createdAt: "asc" } });
  const factorRow = () => platform.twoFactor.findUniqueOrThrow({ where: { userId } });

  beforeAll(async () => {
    await auth.api.signUpEmail({ body: { email, password, name: "Account security" } });
    userId = (await platform.user.findUniqueOrThrow({ where: { email } })).id;
    await platform.user.update({ where: { id: userId }, data: { emailVerified: true } });
    const t = await provisionTenant({ name: `acsec self ${run}`, slug: `acsec-self-${run}`, ownerUserId: userId });
    tenantId = t.tenantId;
    memberId = t.ownerMemberId;

    const { headers } = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
    cookie = cookieJar(headers);
    const enabled = await auth.api.enableTwoFactor({ body: { password }, headers: withCookie(cookie) });
    enrolCodes = enabled.backupCodes;
    const verified = await auth.api.verifyTOTP({
      body: { code: await currentTotp() },
      headers: withCookie(cookie),
      returnHeaders: true,
    });
    cookie = cookieJar(verified.headers, cookie); // the plugin rotates the session
  });

  /** A user with no membership anywhere, for the platform-log case. */
  const loner = randomUUID();

  afterAll(async () => {
    await platform.verification.deleteMany({ where: { value: userId ?? "-" } });
    // The platform-log rows (no tenant) this describe wrote, by target.
    await platform.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
      await tx.auditEvent.deleteMany({ where: { tenantId: null, targetId: { in: [userId ?? "-", loner] } } });
    });
    await platform.user.deleteMany({ where: { id: loner } });
    if (tenantId !== undefined) {
      await platform.memberRole.deleteMany({ where: { tenantId } });
      await platform.rolePermission.deleteMany({ where: { tenantId } });
      await platform.role.deleteMany({ where: { tenantId } });
      await platform.member.deleteMany({ where: { tenantId } });
      await platform.tenantKey.deleteMany({ where: { tenantId } });
      await platform.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
        await tx.auditEvent.deleteMany({ where: { tenantId } });
      });
      await platform.tenant.delete({ where: { id: tenantId } });
    }
    await platform.user.deleteMany({ where: { email } });
    // No disconnect here: the owner describe below runs next, and its
    // fixture's cleanup disconnects the shared clients last.
  });

  it("a session is stamped with the trusted address — the hop from the right, not the caller's own claim", async () => {
    const create = memberDatabaseHooks.session!.create!.before!;
    const session = { userId, token: "t", expiresAt: FUTURE(), ipAddress: "6.6.6.6" };
    const headers = new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" });
    const out = (await create(session as never, { headers, path: "/sign-in/email" } as never)) as { data: { ipAddress: string | null } };
    expect(out.data.ipAddress).toBe("203.0.113.9");
    const none = (await create(session as never, { headers: new Headers(), path: "/sign-in/email" } as never)) as { data: { ipAddress: string | null } };
    expect(none.data.ipAddress).toBeNull();
  });

  it("a wrong password spends no backup code and changes nothing", async () => {
    const before = await factorRow();
    const other = await plantDevice("other", null);
    const r = await replaceOwnFactor({ headers: withCookie(cookie), code: enrolCodes[0]!, password: `wrong-${randomUUID()}` });
    expect(r).toEqual({ ok: false, reason: "wrong_password" });
    expect(await backupCodesLeft(userId)).toBe(10);
    expect(await factorRow()).toMatchObject({ secret: before.secret, backupCodes: before.backupCodes });
    expect(await platform.session.findUnique({ where: { id: other.id } })).not.toBeNull();
    await platform.session.delete({ where: { id: other.id } });
  });

  it("a session and the password open nothing — nor the marker without fresh proof, nor fresh proof without the marker", async () => {
    const before = await factorRow();
    const headers = withCookie(cookie);
    const refused = "A second factor is already enrolled and cannot be replaced from here.";
    const expectRefused = async (call: () => Promise<unknown>, label: string) => {
      const error = await call().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error, label).toBeInstanceOf(APIError);
      expect((error as APIError).message, label).toBe(refused);
    };
    // A stale stamp: no factor presented in the last five minutes.
    await platform.session.update({
      where: { id: await currentSessionId() },
      data: { mfaVerifiedAt: new Date(Date.now() - 60 * 60_000) },
    });
    await expectRefused(() => auth.api.enableTwoFactor({ body: { password }, headers }), "password alone");
    await expectRefused(
      () => runWithReplaceIntent(() => auth.api.enableTwoFactor({ body: { password }, headers })),
      "marker without proof",
    );
    // Fresh proof, no marker — a stolen session that just stepped up.
    expect((await verifyStepUpWithHeaders(await currentTotp(), headers)).ok).toBe(true);
    await expectRefused(() => auth.api.enableTwoFactor({ body: { password }, headers }), "proof without marker");
    expect(await factorRow()).toMatchObject({ secret: before.secret, backupCodes: before.backupCodes });
  });

  it("a wrong code changes nothing", async () => {
    const before = await factorRow();
    const r = await replaceOwnFactor({ headers: withCookie(cookie), code: "ZZZZZ-ZZZZZ", password });
    expect(r).toEqual({ ok: false, reason: "invalid_code" });
    expect(await factorRow()).toMatchObject({ secret: before.secret, backupCodes: before.backupCodes });
    expect(await backupCodesLeft(userId)).toBe(10);
  });

  it("with a backup code: the old factor dies, fresh codes, every other session and mark ends, this one stays — audited and mailed", async () => {
    const before = await factorRow();
    const oldCodes = (await auth.api.viewBackupCodes({ body: { userId } })).backupCodes;
    const other = await plantDevice("other", null);
    const tag = randomUUID();
    await platform.verification.createMany({
      data: [
        { identifier: `trust-device-${tag}`, value: userId, expiresAt: FUTURE() },
        { identifier: `2fa-${tag}`, value: userId, expiresAt: FUTURE() },
      ],
    });
    const sent = mails.length;

    const r = await replaceOwnFactor({ headers: withCookie(cookie), code: enrolCodes[1]!, password });
    if (!r.ok) throw new Error(`replacement refused: ${r.reason}`);
    expect(r.method).toBe("backup_code");
    expect(r.sessionsEnded).toBe(1);
    expect(r.totpUri).toMatch(/^otpauth:\/\/totp\//);
    expect(r.backupCodes).toHaveLength(10);
    expect(r.backupCodes.filter((c) => oldCodes.includes(c))).toEqual([]);

    const after = await factorRow();
    expect(after.secret).not.toBe(before.secret);
    expect(after.verified).toBe(true);
    expect((await platform.user.findUniqueOrThrow({ where: { id: userId } })).twoFactorEnabled).toBe(true);
    expect(await platform.session.findUnique({ where: { id: other.id } })).toBeNull();
    expect(await auth.api.getSession({ headers: withCookie(cookie) })).not.toBeNull();
    expect(await platform.verification.count({ where: { identifier: { contains: tag } } })).toBe(0);

    // The OLD authenticator no longer passes the step-up; the new one does.
    expect(await verifyStepUpWithHeaders(await totpFor(before.secret), withCookie(cookie))).toEqual({
      ok: false,
      reason: "invalid_code",
    });
    expect((await verifyStepUpWithHeaders(await currentTotp(), withCookie(cookie))).ok).toBe(true);
    // Nor does an old backup code that was never used.
    expect(await verifyStepUpWithHeaders(enrolCodes[2]!, withCookie(cookie))).toEqual({ ok: false, reason: "invalid_code" });

    const rows = await auditRows("auth.factor_replaced");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: "MEMBER", actorId: memberId, metadata: { method: "backup_code", sessionsEnded: 1 } });
    expect(mails.slice(sent)).toEqual([
      expect.objectContaining({ to: email, subject: "Your Fortleva two-factor authenticator was replaced" }),
    ]);
    // Links, not data: no code and no secret in the mail.
    const text = mails.at(-1)!.text;
    for (const code of [...r.backupCodes, ...oldCodes]) expect(text).not.toContain(code);
    expect(text).not.toContain("otpauth");
  });

  it("with a live code from the current app — moving to a new phone", async () => {
    const before = await factorRow();
    const r = await replaceOwnFactor({ headers: withCookie(cookie), code: await currentTotp(), password });
    expect(r).toMatchObject({ ok: true, method: "totp", sessionsEnded: 0 });
    expect((await factorRow()).secret).not.toBe(before.secret);
  });

  it("an account-level change reaches the platform log for a console principal and for an account no workspace recorded — never otherwise", async () => {
    const platformRows = (target: string, action: string) =>
      platform.auditEvent.count({ where: { tenantId: null, targetId: target, action } });
    // A member with an active membership: the workspace's row, nothing more.
    await onSessionsRevoked(userId, "others", 2, null);
    expect(await platformRows(userId, "platform.sessions_revoked")).toBe(0);
    // A console principal: its factor is the console's, so the platform log too.
    await onSessionsRevoked(userId, "others", 2, "SUPERADMIN");
    expect(await platformRows(userId, "platform.sessions_revoked")).toBe(1);
    // No membership at all (the code review's medium): the fan-out writes
    // nothing, so the platform log is the only record — and there is one.
    await platform.user.create({ data: { id: loner, name: "Loner", email: `acsec-loner-${loner}@test.invalid` } });
    await onFactorReplaced(loner, "backup_code", 0, null);
    const rows = await platform.auditEvent.findMany({ where: { targetId: loner } });
    expect(rows).toEqual([
      expect.objectContaining({
        tenantId: null,
        action: "platform.factor_replaced",
        actorId: loner,
        metadata: { method: "backup_code", sessionsEnded: 0 },
      }),
    ]);
  });

  it("\"Your devices\": this device first, no token, a network rather than an address; sign-out never reaches this session or another account's", async () => {
    const current = await currentSessionId();
    const phone = await plantDevice(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      "203.0.113.57",
    );
    const devices = await listOwnDevices(userId, current);
    expect(devices[0]).toMatchObject({ id: current, current: true });
    expect(devices.find((d) => d.id === phone.id)).toMatchObject({
      current: false,
      browser: "Safari",
      os: "iOS",
      kind: "mobile",
      network: "203.0.113.x",
      console: false,
    });
    for (const d of devices) expect(Object.keys(d)).not.toContain("token");

    // Not this session (the ordinary sign-out does that) …
    expect(await signOutOwnDevice(userId, current, current)).toBe(false);
    // … and not by another account's hand: the delete is keyed on both.
    expect(await signOutOwnDevice(randomUUID(), phone.id, current)).toBe(false);
    expect(await platform.session.findUnique({ where: { id: phone.id } })).not.toBeNull();

    expect(await signOutOwnDevice(userId, phone.id, current)).toBe(true);
    expect(await platform.session.findUnique({ where: { id: phone.id } })).toBeNull();

    await plantDevice("a", null);
    await plantDevice("b", null);
    expect(await signOutOtherDevices(userId, current)).toBe(2);
    expect((await listOwnDevices(userId, current)).map((d) => d.id)).toEqual([current]);
  });
});

describe("an owner's two verbs on a teammate's sign-in (C50)", () => {
  let t: Awaited<ReturnType<typeof setupTenant>>;
  /** A second workspace, for the teammate who belongs to two. */
  let otherTenantId: string | undefined;
  const otherOwner = randomUUID();

  beforeAll(async () => {
    t = await setupTenant("acsec");
  });

  afterAll(async () => {
    for (const seat of Object.values(t?.seats ?? {})) await clearSignIn(seat.userId);
    if (otherTenantId !== undefined) {
      await platform.memberRole.deleteMany({ where: { tenantId: otherTenantId } });
      await platform.rolePermission.deleteMany({ where: { tenantId: otherTenantId } });
      await platform.role.deleteMany({ where: { tenantId: otherTenantId } });
      await platform.member.deleteMany({ where: { tenantId: otherTenantId } });
      await platform.tenantKey.deleteMany({ where: { tenantId: otherTenantId } });
      await platform.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
        await tx.auditEvent.deleteMany({ where: { tenantId: otherTenantId } });
      });
      await platform.tenant.delete({ where: { id: otherTenantId } });
    }
    await platform.user.deleteMany({ where: { id: otherOwner } });
    await t?.cleanup();
  });

  const audit = (action: string) =>
    platform.auditEvent.findMany({ where: { tenantId: t.tenantId, action }, orderBy: { createdAt: "asc" } });

  const reset = (actorSeat: "owner" | "admin" | "manager" | "employee", target: "owner" | "admin" | "manager" | "employee") =>
    resetMemberTwoFactor({ tenantId: t.tenantId, actor: t.seats[actorSeat].actor, memberId: t.seats[target].memberId });

  it("is refused to anybody without the code, and changes nothing", async () => {
    const tag = await plantSignIn(t.seats.employee.userId);
    const before = await signInState(t.seats.employee.userId, tag);
    for (const seat of ["admin", "manager"] as const) {
      const error = await reset(seat, "employee").catch((e: unknown) => e);
      expect(error, seat).toBeInstanceOf(AuthzError);
      expect((error as AuthzError).reason, seat).toBe("FORBIDDEN");
      const signOut = await signOutMemberEverywhere({
        tenantId: t.tenantId,
        actor: t.seats[seat].actor,
        memberId: t.seats.employee.memberId,
      }).catch((e: unknown) => e);
      expect((signOut as AuthzError).reason, seat).toBe("FORBIDDEN");
    }
    expect(await signInState(t.seats.employee.userId, tag)).toEqual(before);
    expect(before).toMatchObject({ enrolled: true, factor: true, sessions: 2 });
    await clearSignIn(t.seats.employee.userId);
  });

  it("asks the owner's own fresh factor — the code is ✦", async () => {
    const error = await resetMemberTwoFactor({
      tenantId: t.tenantId,
      actor: noMfa(t.seats.owner.memberId),
      memberId: t.seats.employee.memberId,
    }).catch((e: unknown) => e);
    expect((error as AuthzError).reason).toBe("MFA_REQUIRED");
  });

  it("refuses the owner's own account and a console principal's, for both verbs", async () => {
    const tag = await plantSignIn(t.seats.manager.userId);
    await platform.user.update({ where: { id: t.seats.manager.userId }, data: { platformRole: "SUPERADMIN" } });
    const before = await signInState(t.seats.manager.userId, tag);
    const cases = [
      ["owner", "ACCOUNT_IS_YOURS"],
      ["manager", "ACCOUNT_IS_OPERATORS"],
    ] as const;
    for (const [target, code] of cases) {
      const input = { tenantId: t.tenantId, actor: t.seats.owner.actor, memberId: t.seats[target].memberId };
      for (const verb of [resetMemberTwoFactor, signOutMemberEverywhere]) {
        const error = await verb(input).catch((e: unknown) => e);
        expect(error, `${verb.name} ${target}`).toBeInstanceOf(DomainError);
        expect((error as DomainError).code, `${verb.name} ${target}`).toBe(code);
      }
    }
    expect(await signInState(t.seats.manager.userId, tag)).toEqual(before);
    await clearSignIn(t.seats.manager.userId);
  });

  it("refuses a reset with nothing to reset — and ends no session on the way", async () => {
    await platform.session.create({ data: { token: randomUUID(), userId: t.seats.admin.userId, expiresAt: FUTURE() } });
    const error = await reset("owner", "admin").catch((e: unknown) => e);
    expect((error as DomainError).code).toBe("TWO_FACTOR_NOT_ENROLLED");
    expect(await platform.session.count({ where: { userId: t.seats.admin.userId } })).toBe(1);
    await clearSignIn(t.seats.admin.userId);
  });

  it("refuses to reset a teammate who holds what the resetter does not (grant-subset), and audits the refusal", async () => {
    // A custom role that carries the reset code and nothing else, on the
    // EMPLOYEE — the one way a non-owner can hold it.
    const permission = await platform.permission.findUniqueOrThrow({ where: { code: "member:reset_two_factor" } });
    const role = await platform.role.create({ data: { tenantId: t.tenantId, name: `Resetter ${randomUUID().slice(0, 6)}` } });
    await platform.rolePermission.create({ data: { tenantId: t.tenantId, roleId: role.id, permissionId: permission.id } });
    await platform.memberRole.create({ data: { tenantId: t.tenantId, memberId: t.seats.employee.memberId, roleId: role.id } });
    const tag = await plantSignIn(t.seats.manager.userId);
    const before = await signInState(t.seats.manager.userId, tag);
    try {
      const error = await reset("employee", "manager").catch((e: unknown) => e);
      expect((error as AuthzError).reason).toBe("FORBIDDEN");
      expect(await signInState(t.seats.manager.userId, tag)).toEqual(before);
      const denied = await audit("authz.escalation_denied");
      expect(denied.at(-1)).toMatchObject({
        actorId: t.seats.employee.memberId,
        targetId: t.seats.manager.memberId,
        metadata: expect.objectContaining({ rule: "reset_subset" }),
      });

      // …and still when the teammate is SUSPENDED, whose EFFECTIVE set is
      // empty: suspend → reset → reactivate must not walk round the rule
      // (the security review's low). The roles are what count.
      await platform.member.update({
        where: { id: t.seats.manager.memberId },
        data: { status: "SUSPENDED", suspendedAt: new Date() },
      });
      const suspended = await reset("employee", "manager").catch((e: unknown) => e);
      expect((suspended as AuthzError).reason).toBe("FORBIDDEN");
      expect(await signInState(t.seats.manager.userId, tag)).toEqual(before);
    } finally {
      await platform.member.update({
        where: { id: t.seats.manager.memberId },
        data: { status: "ACTIVE", suspendedAt: null },
      });
      await platform.memberRole.deleteMany({ where: { roleId: role.id } });
      await platform.rolePermission.deleteMany({ where: { roleId: role.id } });
      await platform.role.delete({ where: { id: role.id } });
      await clearSignIn(t.seats.manager.userId);
    }
  });

  it("refuses to reset a teammate who also belongs to another workspace — but may sign them out", async () => {
    await platform.user.create({ data: { id: otherOwner, name: "Other owner", email: `acsec-other-${otherOwner}@test.invalid` } });
    const run = randomUUID().slice(0, 8);
    const other = await provisionTenant({ name: `acsec other ${run}`, slug: `acsec-other-${run}`, ownerUserId: otherOwner });
    otherTenantId = other.tenantId;
    await platform.member.create({ data: { tenantId: other.tenantId, userId: t.seats.employee.userId } });

    const tag = await plantSignIn(t.seats.employee.userId);
    const before = await signInState(t.seats.employee.userId, tag);
    const error = await reset("owner", "employee").catch((e: unknown) => e);
    expect((error as DomainError).code).toBe("ACCOUNT_IN_OTHER_WORKSPACE");
    expect(await signInState(t.seats.employee.userId, tag)).toEqual(before);

    // Signing out only ever reduces access, so it reaches them.
    const done = await signOutMemberEverywhere({
      tenantId: t.tenantId,
      actor: t.seats.owner.actor,
      memberId: t.seats.employee.memberId,
    });
    expect(done).toEqual({ sessionsEnded: 2 });
    expect(await signInState(t.seats.employee.userId, tag)).toEqual({
      enrolled: true,
      factor: true,
      sessions: 0,
      marks: ["2fa-attempts-2fa-<tag>", "pwreset#<tag>"],
    });
    await platform.member.deleteMany({ where: { tenantId: other.tenantId, userId: t.seats.employee.userId } });
    await clearSignIn(t.seats.employee.userId);
  });

  it("resets: the factor, the flag, every session, trusted device and waiting sign-in go — audited with both actors, and mailed", async () => {
    const tag = await plantSignIn(t.seats.employee.userId, 3);
    expect(await signInState(t.seats.employee.userId, tag)).toEqual({
      enrolled: true,
      factor: true,
      sessions: 3,
      marks: ALL_MARKS,
    });
    const sent = mails.length;

    expect(await reset("owner", "employee")).toEqual({ sessionsEnded: 3 });

    expect(await signInState(t.seats.employee.userId, tag)).toEqual({
      enrolled: false,
      factor: false,
      sessions: 0,
      // A reset link and an attempt counter are not sign-ins.
      marks: ["2fa-attempts-2fa-<tag>", "pwreset#<tag>"],
    });
    const rows = await audit("member.two_factor_reset");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: "MEMBER",
      actorId: t.seats.owner.memberId,
      targetId: t.seats.employee.memberId,
      metadata: { sessionsEnded: 3 },
    });
    const email = (await platform.user.findUniqueOrThrow({ where: { id: t.seats.employee.userId } })).email;
    expect(mails.slice(sent)).toEqual([
      expect.objectContaining({ to: email, subject: "Your Fortleva two-factor authentication was reset" }),
    ]);
    // No name in the mail: neither the owner's nor the workspace's (typed text).
    const workspace = (await platform.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).name;
    const owner = (await platform.user.findUniqueOrThrow({ where: { id: t.seats.owner.userId } })).name;
    expect(mails.at(-1)!.text).not.toContain(workspace);
    expect(mails.at(-1)!.text).not.toContain(owner);
    await clearSignIn(t.seats.employee.userId);
  });

  it("signs a teammate out everywhere: sessions and marks end, the factor stays — audited and mailed", async () => {
    const tag = await plantSignIn(t.seats.admin.userId, 2);
    const sent = mails.length;
    const done = await signOutMemberEverywhere({
      tenantId: t.tenantId,
      actor: t.seats.owner.actor,
      memberId: t.seats.admin.memberId,
    });
    expect(done).toEqual({ sessionsEnded: 2 });
    expect(await signInState(t.seats.admin.userId, tag)).toEqual({
      enrolled: true,
      factor: true,
      sessions: 0,
      marks: ["2fa-attempts-2fa-<tag>", "pwreset#<tag>"],
    });
    expect((await audit("member.signed_out_everywhere")).at(-1)).toMatchObject({
      actorId: t.seats.owner.memberId,
      targetId: t.seats.admin.memberId,
      metadata: { sessionsEnded: 2 },
    });
    expect(mails.slice(sent)).toEqual([
      expect.objectContaining({ subject: "You were signed out of Fortleva on every device" }),
    ]);
    await clearSignIn(t.seats.admin.userId);
  });
});
