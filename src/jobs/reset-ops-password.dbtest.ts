import { randomBytes, randomUUID } from "node:crypto";

import { hashPassword, verifyPassword } from "better-auth/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { storedResetIdentifierOf } from "@/auth/reset-identifier";
/* eslint-disable no-restricted-imports -- dbtest provisions bare users on the raw layer */
import { getPlatformClient, runtimeClient } from "@/db/client";

import { RESET_OPS_PASSWORD_JOB, resetOpsPassword } from "./reset-ops-password";

/**
 * THE OPERATOR'S CONSOLE-PASSWORD RESET (C30e) against the real schema: what
 * `resetOpsPassword` changes, what it must leave alone, and that a refusal or a
 * dry run changes nothing. The script around it is only plumbing; its shape is
 * pinned by `reset-ops-password.test.ts`.
 *
 * No tenant is created: every principal here is a bare `user`, like
 * `src/auth/plane-endpoints.dbtest.ts`'s, removed at the end — sessions,
 * accounts and the `two_factor` row cascade with the user; `verification` has
 * no foreign key, so its rows go by user id; the audit rows go by target id
 * and, for the seam's own `platform.system_job` rows (which name no target), by
 * this run's marker in their reason. Each address is registered for cleanup
 * BEFORE its row exists, and both passwords are made per run, so an
 * interrupted run leaves no account whose password is printed in this public
 * repository.
 */

const run = randomUUID().slice(0, 8);
const address = (label: string) => `ops-reset-${label}-${run}@test.invalid`;
/** A reason unique to one call, so the seam's rows for it can be found and removed. */
const reasonFor = (label: string) => `dbtest ${run} [${label}]`;
const oldPassword = `old-${randomUUID()}`;
const newPassword = `new-${randomUUID()}`;

const emails: string[] = [];
const db = () => getPlatformClient();

type Fixture = { id: string; email: string };

async function makeUser(
  label: string,
  opts: { platformRole?: string | null; emailVerified?: boolean; credential?: boolean; twoFactor?: boolean },
): Promise<Fixture> {
  const email = address(label);
  emails.push(email); // first: a failure below must still leave nothing behind
  const user = await db().user.create({
    data: {
      email,
      name: `Ops reset ${label}`,
      emailVerified: opts.emailVerified ?? true,
      platformRole: opts.platformRole ?? null,
      twoFactorEnabled: opts.twoFactor ?? false,
    },
  });
  if (opts.credential !== false) {
    await db().account.create({
      data: { userId: user.id, accountId: user.id, providerId: "credential", password: await hashPassword(oldPassword) },
    });
  }
  if (opts.twoFactor) {
    // Never decrypted here: the job must not touch this row at all.
    await db().twoFactor.create({
      data: { userId: user.id, secret: `dbtest-${run}`, backupCodes: `dbtest-${run}`, verified: true },
    });
  }
  return { id: user.id, email };
}

/**
 * Everything a live account can have in flight: a session on each plane, a
 * trusted device, a sign-in waiting for its code, and a reset link in each
 * stored form. Returns the trusted device's identifier — the one row of the
 * four in `verification` that must survive a reset.
 */
async function plantInFlight(userId: string, tag: string): Promise<string> {
  const soon = new Date(Date.now() + 10 * 60_000);
  const later = new Date(Date.now() + 30 * 24 * 60 * 60_000);
  const random = () => randomBytes(16).toString("hex");
  for (const plane of ["MEMBER", "PLATFORM"] as const) {
    await db().session.create({ data: { userId, token: `ops-reset-${tag}-${random()}`, plane, expiresAt: later } });
  }
  const trustDevice = `trust-device-${random()}`;
  await db().verification.createMany({
    data: [
      { identifier: trustDevice, value: userId, expiresAt: later },
      { identifier: `2fa-${random()}`, value: userId, expiresAt: soon },
      { identifier: storedResetIdentifierOf(random()), value: userId, expiresAt: soon },
      { identifier: `reset-password:${random()}`, value: userId, expiresAt: soon },
    ],
  });
  return trustDevice;
}

/** Everything the job could change about one user. */
async function stateOf(userId: string) {
  const credentials = await db().account.findMany({
    where: { userId, providerId: "credential" },
    select: { password: true, accountId: true },
  });
  const verification = await db().verification.findMany({
    where: { value: userId },
    select: { identifier: true },
    orderBy: { identifier: "asc" },
  });
  const user = await db().user.findUniqueOrThrow({
    where: { id: userId },
    select: { twoFactorEnabled: true, emailVerified: true, platformRole: true },
  });
  return {
    credentials,
    sessions: await db().session.count({ where: { userId } }),
    verification: verification.map((v) => v.identifier),
    twoFactorRows: await db().twoFactor.count({ where: { userId } }),
    user,
  };
}

const passwordChangedOf = (targetId: string) =>
  db().auditEvent.findMany({ where: { action: "platform.password_changed", targetId } });

const seamRowsOf = (label: string) =>
  db().auditEvent.findMany({
    where: { action: "platform.system_job", metadata: { path: ["reason"], string_contains: reasonFor(label) } },
  });

const credentialOf = async (userId: string): Promise<string> =>
  (await db().account.findFirstOrThrow({ where: { userId, providerId: "credential" }, select: { password: true } }))
    .password!;

let target: Fixture = { id: "", email: "" };
let targetTrustDevice = "";
let other: Fixture = { id: "", email: "" };
let member: Fixture = { id: "", email: "" };
let unverified: Fixture = { id: "", email: "" };
let noCredential: Fixture = { id: "", email: "" };

beforeAll(async () => {
  target = await makeUser("target", { platformRole: "SUPERADMIN", twoFactor: true });
  targetTrustDevice = await plantInFlight(target.id, "target");
  other = await makeUser("other", { twoFactor: true });
  await plantInFlight(other.id, "other");
  member = await makeUser("member", { platformRole: null });
  await plantInFlight(member.id, "member");
  unverified = await makeUser("unverified", { platformRole: "SUPERADMIN", emailVerified: false });
  noCredential = await makeUser("nocred", { platformRole: "SUPERADMIN", credential: false });
});

afterAll(async () => {
  const platform = db();
  const ids = (await platform.user.findMany({ where: { email: { in: emails } }, select: { id: true } })).map(
    (u) => u.id,
  );
  await platform.verification.deleteMany({ where: { value: { in: ids } } });
  await platform.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
    await tx.auditEvent.deleteMany({
      where: {
        OR: [
          { targetId: { in: ids } },
          { action: "platform.system_job", metadata: { path: ["reason"], string_contains: `dbtest ${run} [` } },
        ],
      },
    });
  });
  await platform.user.deleteMany({ where: { email: { in: emails } } });
  await platform.$disconnect();
  await runtimeClient.$disconnect();
});

describe("a refusal writes nothing", () => {
  it.each([
    ["not-superadmin", (): string => member.email, (): string => newPassword, "not_superadmin"],
    ["unverified", (): string => unverified.email, (): string => newPassword, "unverified"],
    ["missing", (): string => address("missing"), (): string => newPassword, "no_such_user"],
    ["too-short", (): string => target.email, (): string => "eleven-char", "password_too_short"],
    ["is-address", (): string => target.email, (): string => target.email, "password_is_address"],
  ] as const)("%s", async (label, email, password, refusal) => {
    const watched = [target, member, unverified];
    const before = await Promise.all(watched.map((u) => stateOf(u.id)));

    const outcome = await resetOpsPassword({ email: email(), password: password(), reason: reasonFor(label) });

    expect(outcome).toEqual({ ok: false, refusal });
    expect(await Promise.all(watched.map((u) => stateOf(u.id)))).toEqual(before);
    for (const u of watched) expect(await passwordChangedOf(u.id)).toEqual([]);
    // Not even the seam's own row: the account refusals roll the writing
    // transaction back, and the input refusals never open one.
    expect(await seamRowsOf(label)).toEqual([]);
  });

  it("a blank reason", async () => {
    const before = await stateOf(target.id);
    expect(await resetOpsPassword({ email: target.email, password: newPassword, reason: "  " })).toEqual({
      ok: false,
      refusal: "reason_missing",
    });
    expect(await stateOf(target.id)).toEqual(before);
    expect(await passwordChangedOf(target.id)).toEqual([]);
  });
});

describe("a dry run", () => {
  it("reports what a reset would end, and changes nothing", async () => {
    const before = await stateOf(target.id);

    const outcome = await resetOpsPassword({
      email: target.email,
      password: newPassword,
      reason: reasonFor("dry-run"),
      dryRun: true,
    });

    expect(outcome).toEqual({
      ok: true,
      dryRun: true,
      userId: target.id,
      email: target.email,
      credential: "replaced",
      sessionsEnded: 2,
      challengesCancelled: 1,
      resetLinksRevoked: 2,
      secondFactorEnrolled: true,
    });
    expect(await stateOf(target.id)).toEqual(before);
    expect(await verifyPassword({ hash: await credentialOf(target.id), password: oldPassword })).toBe(true);
    expect(await passwordChangedOf(target.id)).toEqual([]);
    // Its only write is the seam's audit of the read — TENANCY.md §12's rule
    // that every `withPlatform` invocation is recorded, not this job's.
    const seam = await seamRowsOf("dry-run");
    expect(seam).toHaveLength(1);
    expect(seam[0]).toMatchObject({
      tenantId: null,
      actorType: "SYSTEM",
      actorId: null,
      visibility: "PLATFORM",
      metadata: { readOnly: true, job: RESET_OPS_PASSWORD_JOB },
    });
  });

  it("refuses what the real run would refuse", async () => {
    const before = await stateOf(member.id);
    expect(
      await resetOpsPassword({ email: member.email, password: newPassword, reason: reasonFor("dry-member"), dryRun: true }),
    ).toEqual({ ok: false, refusal: "not_superadmin" });
    expect(await stateOf(member.id)).toEqual(before);
  });
});

describe("the reset", () => {
  it("sets the password, ends everything in flight, leaves the factor and trusted devices — and audits", async () => {
    const otherBefore = await stateOf(other.id);
    const memberBefore = await stateOf(member.id);

    // The address as an operator might type it: the job normalises it.
    const outcome = await resetOpsPassword({
      email: `  ${target.email.toUpperCase()} `,
      password: newPassword,
      reason: reasonFor("reset"),
    });

    expect(outcome).toEqual({
      ok: true,
      dryRun: false,
      userId: target.id,
      email: target.email,
      credential: "replaced",
      sessionsEnded: 2,
      challengesCancelled: 1,
      resetLinksRevoked: 2,
      secondFactorEnrolled: true,
    });

    // The credential: the new password verifies, the old one no longer does.
    const hash = await credentialOf(target.id);
    expect(await verifyPassword({ hash, password: newPassword })).toBe(true);
    expect(await verifyPassword({ hash, password: oldPassword })).toBe(false);

    // Everything in flight is gone except the trusted device; the factor stands.
    const after = await stateOf(target.id);
    expect(after.sessions).toBe(0);
    expect(after.verification).toEqual([targetTrustDevice]);
    expect(after.twoFactorRows).toBe(1);
    expect(after.user).toEqual({ twoFactorEnabled: true, emailVerified: true, platformRole: "SUPERADMIN" });

    // Nobody else's rows moved.
    expect(await stateOf(other.id)).toEqual(otherBefore);
    expect(await stateOf(member.id)).toEqual(memberBefore);

    // One audit row, SYSTEM, counts only.
    const rows = await passwordChangedOf(target.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: null,
      actorType: "SYSTEM",
      actorId: null,
      targetType: "user",
      targetId: target.id,
      visibility: "PLATFORM",
      metadata: { via: "operator", sessionsEnded: 2, challengesCancelled: 1, resetLinksRevoked: 2 },
    });
    const logged = JSON.stringify(rows[0]);
    for (const secret of [newPassword, oldPassword, hash, target.email]) expect(logged).not.toContain(secret);

    // Beside it, the seam's row — the reason — from the same transaction.
    const seam = await seamRowsOf("reset");
    expect(seam).toHaveLength(1);
    expect(seam[0]).toMatchObject({
      actorType: "SYSTEM",
      metadata: { readOnly: false, job: RESET_OPS_PASSWORD_JOB, reason: `operator password reset: ${reasonFor("reset")}` },
    });

    // What the CLI prints carries no secret either.
    const printed = JSON.stringify(outcome);
    for (const secret of [newPassword, oldPassword, hash]) expect(printed).not.toContain(secret);
  });

  it("creates the credential when the account has none, as Better Auth's own reset does", async () => {
    const outcome = await resetOpsPassword({
      email: noCredential.email,
      password: newPassword,
      reason: reasonFor("no-credential"),
    });
    expect(outcome).toMatchObject({ ok: true, credential: "created", secondFactorEnrolled: false });
    const accounts = await db().account.findMany({ where: { userId: noCredential.id } });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ providerId: "credential", accountId: noCredential.id });
    expect(await verifyPassword({ hash: accounts[0]!.password!, password: newPassword })).toBe(true);
  });
});
