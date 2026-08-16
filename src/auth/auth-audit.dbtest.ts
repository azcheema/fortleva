import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { symmetricDecrypt } from "better-auth/crypto";

/* eslint-disable no-restricted-imports -- dbtest reads/cleans via the raw layer */
import { getPlatformClient, runtimeClient } from "@/db/client";
import { withRequestContext } from "@/lib/request-context";
import { provisionTenant } from "@/members/provisioning";

import { onLoginSucceeded, onMfaChanged, recordForUserMemberships } from "./audit-hooks";
import { auth } from "./index";
import { verifyStepUpWithHeaders } from "./step-up";

/**
 * Auth audit hooks + step-up against the real Better Auth instance and
 * the real app_runtime role: (1) the hook bodies fan out one TENANT row
 * per ACTIVE membership carrying the request context; (2) the wired
 * hooks fire on the actual sign-in / 2FA / password paths;
 * (3) Session.mfaVerifiedAt is stamped by a fresh factor and by
 * verifyStepUp, and left NULL by a password-only sign-in.
 */

const run = randomUUID().slice(0, 8);
const email = `mfa-${run}@test.invalid`;
const password = "correct-horse-battery-staple-9";
let userId: string;
let tenantId: string;
let memberId: string;

const platform = getPlatformClient();

/** Turn a Better Auth response's Set-Cookie headers into a request Cookie header. */
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

const withCookie = (cookie: string): Headers => new Headers({ cookie });

const auditRows = async (action: string) =>
  platform.auditEvent.findMany({
    where: { tenantId, action },
    orderBy: { createdAt: "asc" },
  });

const memberSessionCookieName = () =>
  // src/config sessionCookieName("member") — read via the auth options
  // to avoid importing config into the test.
  (auth.options.advanced?.cookies as { session_token?: { name?: string } }).session_token!.name!;

/** Current TOTP code for the user, the way the plugin itself would compute it. */
const currentTotp = async (): Promise<string> => {
  const row = await platform.twoFactor.findUniqueOrThrow({ where: { userId } });
  const secret = await symmetricDecrypt({ key: process.env["BETTER_AUTH_SECRET"]!, data: row.secret });
  const { code } = await auth.api.generateTOTP({ body: { secret } });
  return code;
};

const sessionRowFor = async (cookie: string) => {
  const s = await auth.api.getSession({ headers: withCookie(cookie) });
  expect(s).not.toBeNull();
  return platform.session.findUniqueOrThrow({ where: { id: s!.session.id } });
};

beforeAll(async () => {
  const res = await auth.api.signUpEmail({ body: { email, password, name: "MFA Test" } });
  userId = res.user.id;
  await platform.user.update({ where: { id: userId }, data: { emailVerified: true } });
  const t = await provisionTenant({ name: `MFA ${run}`, slug: `mfa-${run}`, ownerUserId: userId });
  tenantId = t.tenantId;
  memberId = t.ownerMemberId;
});

afterAll(async () => {
  await platform.memberInvite.deleteMany({ where: { tenantId } });
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
  await platform.user.deleteMany({ where: { id: userId } });
  await platform.$disconnect();
  await runtimeClient.$disconnect();
});

describe("hook bodies: fan-out per ACTIVE membership, request context on the row", () => {
  it("login_succeeded lands in the tenant log as the member, with requestId/ip/userAgent", async () => {
    const n = await withRequestContext(
      { requestId: `req-${run}`, ip: "203.0.113.7", userAgent: "vitest" },
      () => onLoginSucceeded(userId, "password"),
    );
    expect(n).toBe(1);
    const rows = await auditRows("auth.login_succeeded");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: "MEMBER",
      actorId: memberId,
      targetType: "member",
      targetId: memberId,
      visibility: "TENANT",
      requestId: `req-${run}`,
      ip: "203.0.113.7",
      userAgent: "vitest",
      metadata: { method: "password" },
    });
  });

  it("login_failed is a SYSTEM-actor row (nobody authenticated) targeting the member", async () => {
    await recordForUserMemberships(userId, "auth.login_failed", {
      actor: "system",
      metadata: { reason: "invalid_email_or_password" },
    });
    const rows = await auditRows("auth.login_failed");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: "SYSTEM", actorId: null, targetId: memberId });
    // Outside any request scope: NULL request fields, never a crash.
    expect(rows[0]!.requestId).toBeNull();
  });

  it("a SUSPENDED membership receives nothing", async () => {
    await platform.member.update({ where: { id: memberId }, data: { status: "SUSPENDED" } });
    try {
      expect(await onMfaChanged(userId, true)).toBe(0);
      expect(await auditRows("auth.mfa_enabled")).toHaveLength(0);
    } finally {
      await platform.member.update({ where: { id: memberId }, data: { status: "ACTIVE" } });
    }
  });
});

describe("wired hooks on the real Better Auth paths", () => {
  let cookie = "";

  it("password-only sign-in → login_succeeded(password); mfaVerifiedAt stays NULL", async () => {
    const before = (await auditRows("auth.login_succeeded")).length;
    const { headers } = await auth.api.signInEmail({
      body: { email, password },
      returnHeaders: true,
    });
    cookie = cookieJar(headers);
    expect(cookie).toContain(memberSessionCookieName());

    const rows = await auditRows("auth.login_succeeded");
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)!.metadata).toEqual({ method: "password" });

    const row = await sessionRowFor(cookie);
    expect(row.plane).toBe("MEMBER");
    expect(row.mfaVerifiedAt).toBeNull();
  });

  it("wrong password → login_failed for the existing account; unknown email → nothing", async () => {
    const before = (await auditRows("auth.login_failed")).length;
    await expect(
      auth.api.signInEmail({ body: { email, password: "definitely-not-it-123" } }),
    ).rejects.toThrow();
    const rows = await auditRows("auth.login_failed");
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({ actorType: "SYSTEM", targetId: memberId });
    expect(String((rows.at(-1)!.metadata as { reason: string }).reason)).not.toContain(password);

    await expect(
      auth.api.signInEmail({ body: { email: `nobody-${run}@test.invalid`, password } }),
    ).rejects.toThrow();
    expect(await auditRows("auth.login_failed")).toHaveLength(before + 1);
  });

  it("step-up before enrolment is refused (not_enrolled)", async () => {
    const r = await verifyStepUpWithHeaders("000000", withCookie(cookie));
    expect(r).toEqual({ ok: false, reason: "not_enrolled" });
  });

  it("enrol TOTP: enable + verify → mfa_enabled once, session refreshed with mfaVerifiedAt", async () => {
    await auth.api.enableTwoFactor({ body: { password }, headers: withCookie(cookie) });
    const pending = await platform.twoFactor.findUniqueOrThrow({ where: { userId } });
    expect(pending.verified).toBe(false); // 1.6.26: enrolment pending until first verify

    const code = await currentTotp();
    const { headers } = await auth.api.verifyTOTP({
      body: { code },
      headers: withCookie(cookie),
      returnHeaders: true,
    });
    cookie = cookieJar(headers, cookie); // the plugin rotates the session

    const user = await platform.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.twoFactorEnabled).toBe(true);
    expect((await platform.twoFactor.findUniqueOrThrow({ where: { userId } })).verified).toBe(true);

    const enabled = await auditRows("auth.mfa_enabled");
    expect(enabled).toHaveLength(1);
    expect(enabled[0]).toMatchObject({ actorType: "MEMBER", actorId: memberId });

    // Enrol-time verify is a fresh factor on the rotated session …
    const row = await sessionRowFor(cookie);
    expect(row.mfaVerifiedAt).not.toBeNull();
    // … but it is NOT a login: the count did not move on this path.
    const logins = await auditRows("auth.login_succeeded");
    expect(logins.at(-1)!.metadata).toEqual({ method: "password" });
    expect(logins).toHaveLength(2);
  });

  it("2FA sign-in: challenge (no session, no event) → verify-totp → login_succeeded(totp) + fresh mfaVerifiedAt", async () => {
    const before = (await auditRows("auth.login_succeeded")).length;
    const first = await auth.api.signInEmail({
      body: { email, password },
      returnHeaders: true,
    });
    expect((first.response as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    const challenge = cookieJar(first.headers);
    expect(challenge).not.toContain(memberSessionCookieName());
    expect(await auditRows("auth.login_succeeded")).toHaveLength(before);

    const { headers } = await auth.api.verifyTOTP({
      body: { code: await currentTotp() },
      headers: withCookie(challenge),
      returnHeaders: true,
    });
    cookie = cookieJar(headers);
    expect(cookie).toContain(memberSessionCookieName());

    const rows = await auditRows("auth.login_succeeded");
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)!.metadata).toEqual({ method: "totp" });

    const row = await sessionRowFor(cookie);
    expect(row.mfaVerifiedAt).not.toBeNull();
  });

  it("verifyStepUp: wrong code → invalid_code and no stamp change; right code → stamps now", async () => {
    // Age the stamp so the update is observable.
    const s = await auth.api.getSession({ headers: withCookie(cookie) });
    const stale = new Date(Date.now() - 60 * 60_000);
    await platform.session.update({ where: { id: s!.session.id }, data: { mfaVerifiedAt: stale } });

    const bad = await verifyStepUpWithHeaders("000000", withCookie(cookie));
    expect(bad).toEqual({ ok: false, reason: "invalid_code" });
    expect((await sessionRowFor(cookie)).mfaVerifiedAt?.getTime()).toBe(stale.getTime());

    const good = await verifyStepUpWithHeaders(await currentTotp(), withCookie(cookie));
    expect(good.ok).toBe(true);
    const after = (await sessionRowFor(cookie)).mfaVerifiedAt!;
    expect(after.getTime()).toBeGreaterThan(stale.getTime());
    expect(Date.now() - after.getTime()).toBeLessThan(30_000);
    // Step-up is not a login.
    expect((await auditRows("auth.login_succeeded")).at(-1)!.metadata).toEqual({ method: "totp" });
    // Session round-trips the stamp through Better Auth (additionalField).
    const again = await auth.api.getSession({ headers: withCookie(cookie) });
    expect((again!.session as { mfaVerifiedAt?: Date }).mfaVerifiedAt).toBeInstanceOf(Date);
  });

  it("verifyStepUp without a session → no_session", async () => {
    expect(await verifyStepUpWithHeaders("123456", new Headers())).toEqual({
      ok: false,
      reason: "no_session",
    });
  });

  it("change-password → password_changed(change), no secrets in metadata", async () => {
    const newPassword = "another-long-passphrase-42";
    await auth.api.changePassword({
      body: { currentPassword: password, newPassword, revokeOtherSessions: false },
      headers: withCookie(cookie),
    });
    const rows = await auditRows("auth.password_changed");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: "MEMBER", actorId: memberId, metadata: { via: "change" } });
    expect(JSON.stringify(rows[0]!.metadata)).not.toContain(newPassword);
  });

  it("disable 2FA → mfa_disabled", async () => {
    await auth.api.disableTwoFactor({
      body: { password: "another-long-passphrase-42" },
      headers: withCookie(cookie),
    });
    const rows = await auditRows("auth.mfa_disabled");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: "MEMBER", actorId: memberId });
  });
});
