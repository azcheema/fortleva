import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createEmailVerificationToken } from "better-auth/api";
import { verifyPassword } from "better-auth/crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { appUrl } from "@/config";
/* eslint-disable no-restricted-imports -- dbtest exercises the raw layer */
import { getPlatformClient, runtimeClient } from "@/db/client";
import { setTransport } from "@/mailer";

import { auth } from "./index";
import { releaseAuthMail, reserveAuthMail } from "./mail-budget";
import { deliverMemberConfirmation, deliverMemberReset, memberResetHolder, memberResetUrl, nextOf } from "./member-recovery";
import { platformAuth } from "./platform";
import { confirmEmailHolder, confirmMemberEmail, memberPasswordPolicy } from "./member-screens";
import { AUTH_MAILS_PER_HOUR, MEMBER_MIN_PASSWORD_LENGTH, MEMBER_RESET_STORED_PREFIX } from "./recovery-policy";
import { storedResetIdentifierOf } from "./reset-identifier";

/**
 * C30 — MEMBER ACCOUNT RECOVERY, driven through the member instance's real
 * HTTP handler against the real schema: the reset request and the reset, the
 * fresh confirmation link on an unconfirmed sign-in, the confirmation that no
 * longer signs anybody in, and the per-recipient ledger both mails are capped
 * by.
 *
 * WHAT THIS FILE DOES NOT MEASURE: the one-second floor (these tests call
 * `auth.handler` below the route that applies it — `response-floor.test.ts`
 * pins it and its wiring), and "sent after the response" on `after()`'s own
 * branch: a dbtest runs outside any request, where `afterResponse` starts the
 * task detached. The never-settling transport tests prove the endpoint does
 * not wait on the mail either way.
 *
 * No tenant is created: every principal is a bare `user`, like
 * `plane-endpoints.dbtest.ts`'s, registered for cleanup BEFORE its row exists
 * and removed at the end (sessions, accounts and the `auth_mail` ledger
 * cascade; `verification` has no foreign key, so its rows go by user id).
 * Passwords are made per run: this repository is public.
 */

const run = randomUUID().slice(0, 8);
const address = (label: string) => `member-rec-${label}-${run}@test.invalid`;
const password = `pw-${randomUUID()}`;
/** A name nothing but the stranger-typed field could put in a mail. */
const NAME = `Name ${run} visit phish.example`;

const emails: string[] = [];

/** Its own documentation-range address per request, so no per-IP limiter sees this file as one caller. */
let caller = 0;
const request = (path: string, body?: unknown) =>
  new Request(`${appUrl.origin}/api/auth${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "x-forwarded-for": `203.0.113.${(caller++ % 250) + 1}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const member = (path: string, body?: unknown) => auth.handler(request(path, body));
const answer = async (res: Response) => ({ status: res.status, body: await res.text() });

/** Every message the dev transport wrote to `to` (addresses carry `run`). */
const mailTo = (to: string): { subject: string; text: string }[] => {
  const file = join(process.cwd(), ".dev-outbox", "outbox.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as { to?: unknown; subject?: string; text?: string }];
      } catch {
        return [];
      }
    })
    .filter((msg) => msg.to === to)
    .map((msg) => ({ subject: msg.subject ?? "", text: msg.text ?? "" }));
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const RESET_LINK = new RegExp(`${escapeRe(appUrl.origin)}/reset-password/([A-Za-z0-9_-]+)`);
const CONFIRM_LINK = new RegExp(`${escapeRe(appUrl.origin)}/confirm-email/([A-Za-z0-9_.-]+)`);
const resetTokenIn = (text: string) => RESET_LINK.exec(text)?.[1] ?? "";
const confirmTokenIn = (text: string) => CONFIRM_LINK.exec(text)?.[1] ?? "";

/** Mail is sent after the response, so an assertion on it waits. */
const settle = { timeout: 15_000, interval: 100 };

type Made = { id: string; email: string };

/** A user made directly, never through an endpoint this file is testing. */
const makeUser = async (
  label: string,
  opts: { emailVerified?: boolean; platformRole?: string } = {},
): Promise<Made> => {
  const db = getPlatformClient();
  const email = address(label);
  emails.push(email); // first: a failure below must still leave nothing behind
  const user = await db.user.create({
    data: { email, name: NAME, emailVerified: opts.emailVerified ?? true, platformRole: opts.platformRole ?? null },
  });
  await db.account.create({
    data: {
      userId: user.id,
      accountId: user.id,
      providerId: "credential",
      password: await (await auth.$context).password.hash(password),
    },
  });
  return { id: user.id, email };
};

const credentialOf = async (userId: string) =>
  (await getPlatformClient().account.findFirstOrThrow({ where: { userId, providerId: "credential" } })).password!;

const resetRowsOf = (userId: string) =>
  getPlatformClient().verification.findMany({
    where: { value: userId, identifier: { startsWith: MEMBER_RESET_STORED_PREFIX } },
  });

const ledger = (userId: string, kind: "PASSWORD_RESET" | "EMAIL_VERIFICATION") =>
  getPlatformClient().authMail.count({ where: { userId, kind } });

const hour = () => new Date(Date.now() + 60 * 60 * 1000);

afterAll(async () => {
  const db = getPlatformClient();
  const users = await db.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  await db.verification.deleteMany({ where: { value: { in: users.map((u) => u.id) } } });
  await db.user.deleteMany({ where: { email: { in: emails } } });
  await db.$disconnect();
  await runtimeClient.$disconnect();
});

describe("the reset request", () => {
  let alice: Made;
  beforeAll(async () => {
    alice = await makeUser("alice");
  });

  it("mails a member a link to the new-password SCREEN — no name, no library callback — stored only as pwreset#<hash>", async () => {
    const res = await member("/request-password-reset", { email: alice.email });
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(mailTo(alice.email)).toHaveLength(1), settle);
    const [mail] = mailTo(alice.email);
    const token = resetTokenIn(mail!.text);
    expect(token).not.toBe("");
    expect(mail!.text).toContain(memberResetUrl(token));
    expect(mail!.text).not.toContain("/api/auth");
    // A member's name is whatever was typed at sign-up — on a stranger's
    // pre-registration, the stranger's sentence. It never reaches a mail.
    expect(mail!.text).not.toContain(NAME);

    // STORED UNDER OUR PREFIX, AS A HASH: nothing in the table is the token.
    const rows = await resetRowsOf(alice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.identifier).toBe(storedResetIdentifierOf(token));
    expect(rows[0]!.identifier).not.toContain(token);
    expect(rows[0]!.identifier.startsWith("reset-password:")).toBe(false);
    // …and the page's own lookup resolves it through the same hash.
    expect(await memberResetHolder(token)).toEqual({ email: alice.email, twoFactor: false });
    expect(await ledger(alice.id, "PASSWORD_RESET")).toBe(1);
  });

  it("answers a member, an unconfirmed member, a CONSOLE principal and a stranger with the same body — and mails no console", async () => {
    const pending = await makeUser("pending", { emailVerified: false });
    const ops = await makeUser("ops", { platformRole: "SUPERADMIN" });
    const bodies = await Promise.all(
      [alice.email, pending.email, ops.email, address("nobody")].map(async (email) =>
        answer(await member("/request-password-reset", { email })),
      ),
    );
    expect(bodies[0]!.status).toBe(200);
    for (const other of bodies.slice(1)) expect(other).toEqual(bodies[0]);

    // The unconfirmed member IS mailed — that is the owner of an address a
    // stranger signed up first, for whom this is the way in.
    await vi.waitFor(() => expect(mailTo(pending.email)).toHaveLength(1), settle);
    // The console principal is not, and the row the library wrote is gone.
    await vi.waitFor(async () => expect(await resetRowsOf(ops.id)).toHaveLength(0), settle);
    expect(mailTo(ops.email)).toHaveLength(0);
    expect(await ledger(ops.id, "PASSWORD_RESET")).toBe(0);
  });

  it(`sends one person at most ${AUTH_MAILS_PER_HOUR} reset mails an hour, however often asked`, async () => {
    const capped = await makeUser("capped");
    for (let asked = 1; asked <= AUTH_MAILS_PER_HOUR + 2; asked++) {
      expect((await member("/request-password-reset", { email: capped.email })).status).toBe(200);
      // Settle each request before the next, so every assertion is about it:
      // under the cap its mail exists; over it, its row was written and removed.
      if (asked <= AUTH_MAILS_PER_HOUR) {
        await vi.waitFor(() => expect(mailTo(capped.email)).toHaveLength(asked), settle);
      } else {
        await vi.waitFor(async () => expect(await resetRowsOf(capped.id)).toHaveLength(AUTH_MAILS_PER_HOUR), settle);
      }
    }
    expect(mailTo(capped.email)).toHaveLength(AUTH_MAILS_PER_HOUR);
    expect(await ledger(capped.id, "PASSWORD_RESET")).toBe(AUTH_MAILS_PER_HOUR);
  });

  it(`a BURST of simultaneous requests mails exactly ${AUTH_MAILS_PER_HOUR}`, async () => {
    const burst = await makeUser("burst");
    const answers = await Promise.all(
      Array.from({ length: AUTH_MAILS_PER_HOUR + 3 }, () => member("/request-password-reset", { email: burst.email })),
    );
    expect(answers.map((r) => r.status)).toEqual(answers.map(() => 200));
    await vi.waitFor(async () => expect(await resetRowsOf(burst.id)).toHaveLength(AUTH_MAILS_PER_HOUR), settle);
    await vi.waitFor(() => expect(mailTo(burst.email)).toHaveLength(AUTH_MAILS_PER_HOUR), settle);
    expect(await ledger(burst.id, "PASSWORD_RESET")).toBe(AUTH_MAILS_PER_HOUR);
  });

  it("does not count, and does not touch, the two-factor rows that share the table under the same user id", async () => {
    // The portal's count-by-`value` would have refused this person a reset:
    // sign-ins abandoned at the code screen leave their challenges, and every
    // trusted device is a row, all under the user id. (A COMPLETED two-factor
    // sign-in consumes its challenge.)
    const busy = await makeUser("busy");
    const db = getPlatformClient();
    const planted = [
      ...Array.from({ length: 4 }, (_, i) => `2fa-${run}busy${i}000000000`),
      `trust-device-${run}busy0000000000000000000000`,
      `trust-device-${run}busy1111111111111111111111`,
    ];
    for (const identifier of planted) {
      await db.verification.create({ data: { identifier, value: busy.id, expiresAt: hour() } });
    }
    expect((await member("/request-password-reset", { email: busy.email })).status).toBe(200);
    await vi.waitFor(() => expect(mailTo(busy.email)).toHaveLength(1), settle);
    const theirs = await db.verification.findMany({
      where: { value: busy.id, identifier: { in: planted } },
      select: { identifier: true },
    });
    expect(theirs).toHaveLength(planted.length);
  });

  it("answers before the mail is sent — a transport that never answers cannot hold the response", async () => {
    const real = setTransport(() => new Promise<void>(() => {}));
    try {
      const answered = await Promise.race([
        member("/request-password-reset", { email: alice.email }),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 10_000)),
      ]);
      expect(answered).not.toBe("hung");
      expect((answered as Response).status).toBe(200);
    } finally {
      setTransport(real);
    }
  });
});

describe("the reset itself", () => {
  it("sets the password, ends every session, kills the OTHER links and sign-ins in flight, keeps trusted devices", async () => {
    const bob = await makeUser("bob");
    const db = getPlatformClient();
    await auth.api.signInEmail({ body: { email: bob.email, password } });
    expect(await db.session.count({ where: { userId: bob.id } })).toBe(1);

    for (let i = 1; i <= 2; i++) {
      await member("/request-password-reset", { email: bob.email });
      await vi.waitFor(() => expect(mailTo(bob.email)).toHaveLength(i), settle);
    }
    const [first, second] = mailTo(bob.email).map((m) => resetTokenIn(m.text));
    expect(first).not.toBe(second);
    const challenge = `2fa-${run}bobchallenge0000`;
    const device = `trust-device-${run}bobdevice000000000000000`;
    await db.verification.create({ data: { identifier: challenge, value: bob.id, expiresAt: hour() } });
    await db.verification.create({ data: { identifier: device, value: bob.id, expiresAt: hour() } });

    const newPassword = `second-${randomUUID()}`;
    expect((await member("/reset-password", { token: second, newPassword })).status).toBe(200);

    expect(await db.session.count({ where: { userId: bob.id } })).toBe(0);
    expect((await member("/sign-in/email", { email: bob.email, password })).status).toBe(401);
    expect((await member("/sign-in/email", { email: bob.email, password: newPassword })).status).toBe(200);

    // The older mail's link died with the reset.
    expect(await memberResetHolder(first!)).toBeNull();
    expect((await member("/reset-password", { token: first, newPassword: `third-${randomUUID()}` })).status).toBe(400);
    expect(await resetRowsOf(bob.id)).toHaveLength(0);
    // The pending challenge went; the trusted device did not.
    const left = await db.verification.findMany({
      where: { identifier: { in: [challenge, device] } },
      select: { identifier: true },
    });
    expect(left.map((r) => r.identifier)).toEqual([device]);
  });

  it("CLOSES THE PRE-ACCOUNT TAKEOVER for its owner: the reset replaces the stranger's password and confirms the address", async () => {
    // A stranger signs the owner's address up first, with a password only the
    // stranger knows. The owner's reset link — read in the owner's mailbox —
    // is the proof of control a confirmation is; afterwards the stranger's
    // password opens nothing and the owner's does.
    const owner = address("owner");
    emails.push(owner);
    const strangers = `stranger-${randomUUID()}`;
    expect((await member("/sign-up/email", { email: owner, password: strangers, name: "Stranger" })).status).toBe(200);
    const db = getPlatformClient();
    const squatted = await db.user.findUniqueOrThrow({ where: { email: owner } });
    expect(squatted.emailVerified).toBe(false);

    expect((await member("/request-password-reset", { email: owner })).status).toBe(200);
    let token = "";
    await vi.waitFor(() => {
      const reset = mailTo(owner).find((m) => RESET_LINK.test(m.text));
      expect(reset).toBeDefined();
      token = resetTokenIn(reset!.text);
    }, settle);
    const owners = `owner-${randomUUID()}`;
    expect((await member("/reset-password", { token, newPassword: owners })).status).toBe(200);

    expect((await db.user.findUniqueOrThrow({ where: { id: squatted.id } })).emailVerified).toBe(true);
    expect((await member("/sign-in/email", { email: owner, password: strangers })).status).toBe(401);
    expect((await member("/sign-in/email", { email: owner, password: owners })).status).toBe(200);
  });

  it.each([
    // Each case alone, on a console principal of its own, holding ONLY that
    // link: planted together, the first refusal's burn took the second link
    // too, so the second case could not fail (review finding).
    ["stored hashed, sent in the body", "hashed", "body"],
    ["stored PLAIN — the library's fallback would redeem it — sent in the body", "plain", "body"],
    ["stored hashed, sent in the QUERY string", "hashed", "query"],
    ["stored plain, sent in the query string with an empty body token", "plain", "query-empty"],
    ["of a shape Better Auth never mints (dots, plus, slash) — the guard must not filter by shape", "odd", "body"],
  ] as const)("never resets a CONSOLE principal: a link %s is refused exactly like an unknown one", async (_label, form, via) => {
    const ops = await makeUser(`ops-redeem-${form}-${via}`, { platformRole: "SUPERADMIN" });
    const db = getPlatformClient();
    const { internalAdapter } = await auth.$context;
    const stem = `console${form}${via.replace(/-/g, "")}${run.replace(/-/g, "")}`;
    const token = form === "odd" ? `${stem}.a+b/c` : stem;
    if (form === "plain") {
      await db.verification.create({ data: { identifier: `reset-password:${token}`, value: ops.id, expiresAt: hour() } });
    } else {
      // The instance's own adapter stores it the way a live link is stored.
      await internalAdapter.createVerificationValue({ identifier: `reset-password:${token}`, value: ops.id, expiresAt: hour() });
    }
    const before = await credentialOf(ops.id);
    // The screen draws the dead-link state.
    expect(await memberResetHolder(token)).toBeNull();

    const newPassword = `attack-${randomUUID()}`;
    const send = (t: string) =>
      via === "body"
        ? member("/reset-password", { token: t, newPassword })
        : member(`/reset-password?token=${encodeURIComponent(t)}`, via === "query" ? { newPassword } : { token: "", newPassword });
    const unknown = await answer(await send(`nothing${stem}`));
    const refused = await answer(await send(token));
    expect(refused.status).toBe(400);
    expect(refused).toEqual(unknown);
    expect(await credentialOf(ops.id)).toBe(before);
    const left = await db.verification.count({
      where: { value: ops.id, OR: [{ identifier: { startsWith: MEMBER_RESET_STORED_PREFIX } }, { identifier: { startsWith: "reset-password:" } }] },
    });
    expect(left).toBe(0);
  });

  it(`refuses a new password under ${MEMBER_MIN_PASSWORD_LENGTH} characters — and leaves the link live for a better one`, async () => {
    // The instance states the floor (it was the library's eight); the reset
    // screen reads it from the instance, and so does the console's own
    // /change-password, which writes the same credential row.
    expect((await memberPasswordPolicy()).min).toBe(MEMBER_MIN_PASSWORD_LENGTH);
    expect((await platformAuth.$context).password.config.minPasswordLength).toBe(MEMBER_MIN_PASSWORD_LENGTH);
    const pia = await makeUser("pia");
    const { internalAdapter } = await auth.$context;
    const raw = `short${run.replace(/-/g, "")}`;
    await internalAdapter.createVerificationValue({ identifier: `reset-password:${raw}`, value: pia.id, expiresAt: hour() });
    const before = await credentialOf(pia.id);
    const res = await member("/reset-password", { token: raw, newPassword: "x".repeat(MEMBER_MIN_PASSWORD_LENGTH - 1) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("PASSWORD_TOO_SHORT");
    expect(await credentialOf(pia.id)).toBe(before);
    expect(await memberResetHolder(raw)).toEqual({ email: pia.email, twoFactor: false });
  });

  it("a stored link cannot be redeemed by somebody who can only READ the table", async () => {
    // The trap `recovery-policy.ts` records: the library's consume retries the
    // RAW `reset-password:<token>`, so a stored form that began with that
    // prefix would be redeemable by presenting the hash itself.
    const carol = await makeUser("carol");
    await member("/request-password-reset", { email: carol.email });
    await vi.waitFor(async () => expect(await resetRowsOf(carol.id)).toHaveLength(1), settle);
    const [row] = await resetRowsOf(carol.id);
    const before = await credentialOf(carol.id);
    for (const token of [row!.identifier, row!.identifier.slice(MEMBER_RESET_STORED_PREFIX.length)]) {
      expect((await member("/reset-password", { token, newPassword: `attack-${randomUUID()}` })).status).toBe(400);
    }
    expect(await credentialOf(carol.id)).toBe(before);
  });

  it("does not draw the form for an expired link", async () => {
    const dave = await makeUser("dave");
    const { internalAdapter } = await auth.$context;
    const raw = `expired${run.replace(/-/g, "")}`;
    await internalAdapter.createVerificationValue({
      identifier: `reset-password:${raw}`,
      value: dave.id,
      expiresAt: new Date(Date.now() - 1000),
    });
    // The library's lookup returns an expired row without complaint; the
    // holder is what compares `expiresAt`.
    expect(await memberResetHolder(raw)).toBeNull();
  });
});

describe("the reset delivery, awaited directly", () => {
  it("a send that FAILS gives its slot back and removes its row, so lost mails cannot use up the cap", async () => {
    const erin = await makeUser("erin");
    const { internalAdapter } = await auth.$context;
    const raw = `lost${run.replace(/-/g, "")}`;
    await internalAdapter.createVerificationValue({ identifier: `reset-password:${raw}`, value: erin.id, expiresAt: hour() });
    const real = setTransport(async () => {
      throw new Error("transport down");
    });
    try {
      await expect(deliverMemberReset({ id: erin.id, email: erin.email }, raw)).rejects.toThrow("transport down");
    } finally {
      setTransport(real);
    }
    expect(await ledger(erin.id, "PASSWORD_RESET")).toBe(0);
    expect(await resetRowsOf(erin.id)).toHaveLength(0);
  });

  it("declines, and removes the row, when the account is no longer at the address the request named", async () => {
    const fay = await makeUser("fay");
    const { internalAdapter } = await auth.$context;
    const raw = `raced${run.replace(/-/g, "")}`;
    await internalAdapter.createVerificationValue({ identifier: `reset-password:${raw}`, value: fay.id, expiresAt: hour() });
    const old = address("fay-old");
    expect(await deliverMemberReset({ id: fay.id, email: old }, raw)).toBe("declined");
    expect(mailTo(old)).toHaveLength(0);
    expect(await resetRowsOf(fay.id)).toHaveLength(0);
    expect(await ledger(fay.id, "PASSWORD_RESET")).toBe(0);
  });

  it("declines a console principal even when the snapshot did not say so — the re-read", async () => {
    const ops = await makeUser("ops-late", { platformRole: "SUPERADMIN" });
    const { internalAdapter } = await auth.$context;
    const raw = `opslate${run.replace(/-/g, "")}`;
    await internalAdapter.createVerificationValue({ identifier: `reset-password:${raw}`, value: ops.id, expiresAt: hour() });
    expect(await deliverMemberReset({ id: ops.id, email: ops.email }, raw)).toBe("declined");
    expect(mailTo(ops.email)).toHaveLength(0);
    expect(await resetRowsOf(ops.id)).toHaveLength(0);
  });
});

describe("an unconfirmed member who signs in (sendOnSignIn)", () => {
  it("with the RIGHT password gets 403 and a fresh link to the confirmation PAGE; with a wrong one, 401 and nothing", async () => {
    const gus = await makeUser("gus", { emailVerified: false });
    const wrong = await member("/sign-in/email", { email: gus.email, password: `not-${randomUUID()}` });
    expect(wrong.status).toBe(401);

    const right = await member("/sign-in/email", { email: gus.email, password });
    expect(right.status).toBe(403);
    expect(((await right.json()) as { code?: string }).code).toBe("EMAIL_NOT_VERIFIED");

    await vi.waitFor(() => expect(mailTo(gus.email)).toHaveLength(1), settle);
    const [mail] = mailTo(gus.email);
    expect(confirmTokenIn(mail!.text)).not.toBe("");
    expect(mail!.text).not.toContain("/api/auth/verify-email");
    expect(mail!.text).not.toContain(NAME);
    // Nothing more arrives for the wrong password, however long we wait.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(mailTo(gus.email)).toHaveLength(1);
    expect(await getPlatformClient().session.count({ where: { userId: gus.id } })).toBe(0);
  });

  it(`sends one person at most ${AUTH_MAILS_PER_HOUR} confirmation mails an hour — the stranger who knows the password cannot flood the owner`, async () => {
    const hal = await makeUser("hal", { emailVerified: false });
    for (let tried = 1; tried <= AUTH_MAILS_PER_HOUR + 2; tried++) {
      expect((await member("/sign-in/email", { email: hal.email, password })).status).toBe(403);
      if (tried <= AUTH_MAILS_PER_HOUR) {
        await vi.waitFor(() => expect(mailTo(hal.email)).toHaveLength(tried), settle);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(mailTo(hal.email)).toHaveLength(AUTH_MAILS_PER_HOUR);
    expect(await ledger(hal.id, "EMAIL_VERIFICATION")).toBe(AUTH_MAILS_PER_HOUR);
  });

  it("a confirmed member's sign-in sends nothing", async () => {
    const ivy = await makeUser("ivy");
    expect((await member("/sign-in/email", { email: ivy.email, password })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(mailTo(ivy.email)).toHaveLength(0);
  });
});

describe("confirmation (the link's page, and the action behind its button)", () => {
  it("opening the page confirms nothing; the library's /verify-email is refused; only the link AND the password confirm — and signing in is the action's, not this", async () => {
    const email = address("jo");
    emails.push(email);
    const res = await member("/sign-up/email", { email, password, name: "Jo", callbackURL: "/invite/abc123" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(mailTo(email)).toHaveLength(1), settle);
    const text = mailTo(email)[0]!.text;
    const link = new URL(/https?:\/\/\S+/.exec(text)![0]);
    expect(link.pathname.startsWith("/confirm-email/")).toBe(true);
    expect(link.searchParams.get("next")).toBe("/invite/abc123");
    const token = confirmTokenIn(text);

    // The page's read — all a mail scanner does — changes nothing.
    const db = getPlatformClient();
    expect(await confirmEmailHolder(token)).toEqual({ email, confirmed: false });
    expect((await db.user.findUniqueOrThrow({ where: { email } })).emailVerified).toBe(false);
    // The library's link-only endpoint is closed on this plane.
    expect((await member(`/verify-email?token=${encodeURIComponent(token)}`)).status).toBe(404);

    // The link with the WRONG password confirms nothing.
    expect(await confirmMemberEmail(token, `not-${randomUUID()}`)).toEqual({ kind: "password" });
    expect(await confirmMemberEmail(token, "")).toEqual({ kind: "password" });
    expect((await db.user.findUniqueOrThrow({ where: { email } })).emailVerified).toBe(false);

    // The link with the account's password confirms — and mints no session
    // by itself (the page's action signs in afterwards, through the instance).
    expect(await confirmMemberEmail(token, password)).toEqual({ kind: "confirmed", email });
    const user = await db.user.findUniqueOrThrow({ where: { email }, include: { sessions: true } });
    expect(user.emailVerified).toBe(true);
    expect(user.sessions).toEqual([]);
    expect(await confirmEmailHolder(token)).toEqual({ email, confirmed: true });
    expect(await confirmMemberEmail(token, password)).toEqual({ kind: "already" });
  });

  it("A STRANGER'S PRE-REGISTRATION CANNOT BE CONFIRMED BY ITS OWNER: the owner's own password is refused, and the stranger's never goes live", async () => {
    // The review's chain: a stranger signs the owner's address up, then keeps
    // a fresh link in the owner's inbox by signing in (sendOnSignIn); the owner
    // — who has just tried to sign up themselves and been mailed nothing —
    // opens it as their own. With the link alone that turned the stranger's
    // password on. Now the owner's own password is refused at confirmation,
    // and the page sends them to a reset instead.
    const owner = address("owner-confirm");
    emails.push(owner);
    const strangers = `stranger-${randomUUID()}`;
    expect((await member("/sign-up/email", { email: owner, password: strangers, name: "Stranger" })).status).toBe(200);
    expect((await member("/sign-in/email", { email: owner, password: strangers })).status).toBe(403);
    await vi.waitFor(() => expect(mailTo(owner)).toHaveLength(2), settle);
    const token = confirmTokenIn(mailTo(owner).at(-1)!.text);

    const owners = `owner-${randomUUID()}`;
    expect(await confirmMemberEmail(token, owners)).toEqual({ kind: "password" });
    expect((await getPlatformClient().user.findUniqueOrThrow({ where: { email: owner } })).emailVerified).toBe(false);
    // …so the stranger's sign-in still answers "not confirmed", never a session.
    expect((await member("/sign-in/email", { email: owner, password: strangers })).status).toBe(403);
  });

  it("the page refuses every link the endpoint would refuse — and a console principal's", async () => {
    const kim = await makeUser("kim", { emailVerified: false });
    const ops = await makeUser("ops-confirm", { platformRole: "SUPERADMIN", emailVerified: false });
    const secret = (await auth.$context).secret;
    const good = await createEmailVerificationToken(secret, kim.email);
    expect(await confirmEmailHolder(good)).toEqual({ email: kim.email, confirmed: false });

    const expired = await createEmailVerificationToken(secret, kim.email, undefined, -60);
    const changeEmail = await createEmailVerificationToken(secret, kim.email, address("kim-new"), 3600, {
      requestType: "change-email-verification",
    });
    const forged = await createEmailVerificationToken(`not-${secret}`, kim.email);
    // Signed with the right secret under an algorithm `/verify-email` does not accept.
    const b64 = (s: string) => Buffer.from(s).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const head = b64(JSON.stringify({ alg: "HS512" }));
    const body = b64(JSON.stringify({ email: kim.email, iat: now, exp: now + 3600 }));
    const hs512 = `${head}.${body}.${createHmac("sha512", secret).update(`${head}.${body}`).digest("base64url")}`;
    const consoleLink = await createEmailVerificationToken(secret, ops.email);
    // A change-email link whose payload begins with a byte-order mark: jose
    // reads it, Node's JSON.parse does not — the check must fail CLOSED.
    const bomBody = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(JSON.stringify({ email: kim.email, updateTo: address("kim-bom"), iat: now, exp: now + 3600 })),
    ]).toString("base64url");
    const hs256 = b64(JSON.stringify({ alg: "HS256" }));
    const bom = `${hs256}.${bomBody}.${createHmac("sha256", secret).update(`${hs256}.${bomBody}`).digest("base64url")}`;

    for (const token of [expired, changeEmail, forged, hs512, consoleLink, bom, "not-a-token", ""]) {
      expect(await confirmEmailHolder(token)).toBeNull();
      expect(await confirmMemberEmail(token, password)).toEqual({ kind: "dead" });
    }
    expect((await getPlatformClient().user.findUniqueOrThrow({ where: { id: kim.id } })).emailVerified).toBe(false);
  });

  it("a confirmation delivery declines — spending nothing — for an address already confirmed, a changed address, and a console principal", async () => {
    const secret = (await auth.$context).secret;
    const lee = await makeUser("lee");
    const moe = await makeUser("moe", { emailVerified: false });
    const ops = await makeUser("ops-deliver", { platformRole: "SUPERADMIN", emailVerified: false });
    const cases: [Made, string][] = [
      [lee, lee.email], // already confirmed
      [moe, address("moe-old")], // the snapshot's address is not the account's any more
      [ops, ops.email], // a console principal
    ];
    for (const [who, to] of cases) {
      const token = await createEmailVerificationToken(secret, to);
      const url = `${appUrl.origin}/api/auth/verify-email?token=${token}`;
      expect(await deliverMemberConfirmation({ id: who.id, email: to }, url, token)).toBe("declined");
      expect(await ledger(who.id, "EMAIL_VERIFICATION")).toBe(0);
      expect(mailTo(to)).toHaveLength(0);
    }
    // …and the positive control: the unconfirmed member at their own address is mailed.
    const token = await createEmailVerificationToken(secret, moe.email);
    expect(
      await deliverMemberConfirmation(moe, `${appUrl.origin}/api/auth/verify-email?token=${token}`, token),
    ).toBe("sent");
    expect(await ledger(moe.id, "EMAIL_VERIFICATION")).toBe(1);
  });
});

describe("the confirmation delivery, awaited directly", () => {
  it("a send that FAILS gives its slot back, so lost mails cannot use up the cap", async () => {
    const rex = await makeUser("rex", { emailVerified: false });
    const token = await createEmailVerificationToken((await auth.$context).secret, rex.email);
    const real = setTransport(async () => {
      throw new Error("transport down");
    });
    try {
      await expect(
        deliverMemberConfirmation(rex, `${appUrl.origin}/api/auth/verify-email?token=${token}`, token),
      ).rejects.toThrow("transport down");
    } finally {
      setTransport(real);
    }
    expect(await ledger(rex.id, "EMAIL_VERIFICATION")).toBe(0);
  });

  it("a sign-in's link carries the `next` of the /login page it came from — the invitee keeps their invitation", async () => {
    // A sign-in sends no callbackURL, so the library's own link says `/`; the
    // referring `/login?next=…` is where the person was going (review finding:
    // without it an invitee whose first link lapsed landed on an empty
    // dashboard). Through the real handler, with the Referer a browser sends.
    const sal = await makeUser("sal", { emailVerified: false });
    const res = await auth.handler(
      new Request(`${appUrl.origin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": `203.0.113.${(caller++ % 250) + 1}`,
          referer: `${appUrl.origin}/login?next=${encodeURIComponent("/invite/tok123")}`,
        },
        body: JSON.stringify({ email: sal.email, password }),
      }),
    );
    expect(res.status).toBe(403);
    await vi.waitFor(() => expect(mailTo(sal.email)).toHaveLength(1), settle);
    const link = new URL(/https?:\/\/\S+/.exec(mailTo(sal.email)[0]!.text)![0]);
    expect(link.searchParams.get("next")).toBe("/invite/tok123");
  });

  it("takes `next` only from our own /login, and only through the redirect guard", () => {
    const lib = (cb: string) => `${appUrl.origin}/api/auth/verify-email?token=t&callbackURL=${encodeURIComponent(cb)}`;
    const login = (next: string) => `${appUrl.origin}/login?next=${encodeURIComponent(next)}`;
    // Sign-up's own callbackURL wins.
    expect(nextOf(lib("/invite/a"), login("/invite/b"))).toBe("/invite/a");
    // A sign-in's `/` falls back to the referrer's next…
    expect(nextOf(lib("/"), login("/invite/b"))).toBe("/invite/b");
    // …but not from another page, another origin, or past the guard.
    expect(nextOf(lib("/"), `${appUrl.origin}/signup?next=%2Finvite%2Fb`)).toBe("/home");
    expect(nextOf(lib("/"), `https://evil.example/login?next=%2Finvite%2Fb`)).toBe("/home");
    expect(nextOf(lib("/"), login("https://evil.example/x"))).toBe("/home");
    expect(nextOf(lib("/"), login("//evil.example/x"))).toBe("/home");
    expect(nextOf(lib("/"), null)).toBe("/home");
    expect(nextOf(lib("/"), "not a url")).toBe("/home");
  });
});

describe("the ledger (auth_mail)", () => {
  it(`is exact under concurrency: of many simultaneous reservations, exactly ${AUTH_MAILS_PER_HOUR} succeed`, async () => {
    const max = await makeUser("max");
    const slots = await Promise.all(
      Array.from({ length: AUTH_MAILS_PER_HOUR + 4 }, () => reserveAuthMail(max.id, "PASSWORD_RESET")),
    );
    expect(slots.filter((s) => s !== null)).toHaveLength(AUTH_MAILS_PER_HOUR);
    // Kinds are budgeted separately.
    expect(await reserveAuthMail(max.id, "EMAIL_VERIFICATION")).not.toBeNull();
    // A released slot is a slot again.
    await releaseAuthMail(slots.find((s) => s !== null)!);
    expect(await reserveAuthMail(max.id, "PASSWORD_RESET")).not.toBeNull();
  });

  it("prunes what is older than the window, and counts only the window", async () => {
    const ned = await makeUser("ned");
    const db = getPlatformClient();
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await db.authMail.createMany({
      data: Array.from({ length: AUTH_MAILS_PER_HOUR }, () => ({ userId: ned.id, kind: "PASSWORD_RESET" as const, createdAt: old })),
    });
    expect(await reserveAuthMail(ned.id, "PASSWORD_RESET")).not.toBeNull();
    expect(await db.authMail.count({ where: { userId: ned.id, createdAt: { lt: new Date(Date.now() - 60 * 60 * 1000) } } })).toBe(0);
  });

  it("reserves nothing for a person who does not exist", async () => {
    expect(await reserveAuthMail(randomUUID(), "PASSWORD_RESET")).toBeNull();
  });

  it("is readable on the auth path and invisible to a contact principal (portal_deny)", async () => {
    const ola = await makeUser("ola");
    await reserveAuthMail(ola.id, "EMAIL_VERIFICATION");
    expect(await runtimeClient.authMail.count({ where: { userId: ola.id } })).toBe(1);
    const seen = await runtimeClient.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.principal', 'contact', true)`;
      return tx.authMail.count({ where: { userId: ola.id } });
    });
    expect(seen).toBe(0);
  });

  it("holds no token, address or link — a user id, a kind and a time", async () => {
    const cols = await getPlatformClient().$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'auth_mail' ORDER BY column_name`;
    expect(cols.map((c) => c.column_name)).toEqual(["created_at", "id", "kind", "user_id"]);
  });

  it("goes with its person", async () => {
    const pat = await makeUser("pat");
    await reserveAuthMail(pat.id, "PASSWORD_RESET");
    await getPlatformClient().user.delete({ where: { id: pat.id } });
    expect(await getPlatformClient().authMail.count({ where: { userId: pat.id } })).toBe(0);
  });
});

describe("the stored form of a reset link", () => {
  it("is pwreset# and the base64url SHA-256 of the library's whole identifier", async () => {
    // Pinned exactly, because the e2e seed writes it by hand and a drift
    // between the two would strand every seeded link silently.
    const { createHash } = await import("node:crypto");
    expect(storedResetIdentifierOf("abc")).toBe(
      `pwreset#${createHash("sha256").update("reset-password:abc").digest("base64url")}`,
    );
    const quinn = await makeUser("quinn");
    await (await auth.$context).internalAdapter.createVerificationValue({
      identifier: "reset-password:pinnedtoken",
      value: quinn.id,
      expiresAt: hour(),
    });
    expect((await resetRowsOf(quinn.id)).map((r) => r.identifier)).toEqual([storedResetIdentifierOf("pinnedtoken")]);
    // …and it verifies the credential we set is still the one we set.
    expect(await verifyPassword({ hash: await credentialOf(quinn.id), password })).toBe(true);
  });
});
