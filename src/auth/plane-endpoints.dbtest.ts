import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createEmailVerificationToken } from "better-auth/api";
import { verifyJWT } from "better-auth/crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { appUrl, opsUrl } from "@/config";
/* eslint-disable no-restricted-imports -- dbtest exercises the raw layer */
import { getPlatformClient, runtimeClient } from "@/db/client";
import { setTransport } from "@/mailer";

import { auth } from "./index";
import { platformAuth } from "./platform";

/**
 * SLICE 58: the member and platform planes' unauthenticated mail endpoints,
 * driven through each instance's real HTTP handler against the real schema.
 *
 * Two halves, and the second matters as much as the first:
 *   - what is CLOSED answers every address with the same 404 — on both
 *     planes, including links minted on the other one (the two instances
 *     share `verification` and `BETTER_AUTH_SECRET`);
 *   - what is LIVE still works: a new member signs up, gets their link after
 *     the response rather than before it, and the link signs them in — while
 *     an address that is already registered gets the same answer, byte for
 *     byte, whatever the caller sends.
 *
 * WHAT THIS FILE DOES NOT MEASURE: the one-second floor on sign-up. These
 * tests call `auth.handler` directly, below the route that applies it; the
 * floor's behaviour and its wiring are pinned in `response-floor.test.ts`.
 * And the verification mail is proven "not awaited" on `afterResponse`'s
 * fallback branch (a dbtest runs outside any request, where `after()` throws
 * and the task starts detached) — the portal's reset has the same limit.
 *
 * No tenant is created: every principal here is a bare `user`, like
 * `auth.dbtest.ts`'s, removed at the end (sessions and accounts cascade;
 * `verification` has no foreign key, so its rows go by user id). Each address
 * is registered for cleanup BEFORE its row exists, and the password is made
 * per run, so an interrupted run leaves no account whose password is
 * printed in this public repository.
 */

const run = randomUUID().slice(0, 8);
const address = (label: string) => `plane-ep-${label}-${run}@test.invalid`;
const password = `pw-${randomUUID()}`;

const emails: string[] = [];

/**
 * Each request comes from its own address (a documentation-range IP, RFC
 * 5737), so the per-IP limiter never sees this file as one caller: with
 * Upstash provisioned, a dozen sign-ups from "unknown" would spend
 * `auth.sign_up`'s five an hour and turn the later tests' 200s into 429s.
 */
let caller = 0;
const request = (base: string, path: string, body?: unknown) =>
  new Request(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "x-forwarded-for": `198.51.100.${(caller++ % 250) + 1}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const member = (path: string, body?: unknown) => auth.handler(request(`${appUrl.origin}/api/auth`, path, body));
const platform = (path: string, body?: unknown) =>
  platformAuth.handler(request(`${opsUrl.origin}/api/platform-auth`, path, body));

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

/** Mail is sent after the response, so an assertion on it waits. */
const settle = { timeout: 15_000, interval: 100 };

/** A user made directly, never through an endpoint this file is testing. */
const makeUser = async (label: string, emailVerified: boolean) => {
  const db = getPlatformClient();
  const email = address(label);
  emails.push(email); // first: a failure below must still leave nothing behind
  const user = await db.user.create({ data: { email, name: `Plane ${label}`, emailVerified } });
  await db.account.create({
    data: {
      userId: user.id,
      accountId: user.id,
      providerId: "credential",
      password: await (await auth.$context).password.hash(password),
    },
  });
  return user;
};

const credentialOf = async (userId: string) =>
  (await getPlatformClient().account.findFirstOrThrow({ where: { userId, providerId: "credential" } }))
    .password;

let verified = { id: "", email: "" };
let unverified = { id: "", email: "" };

beforeAll(async () => {
  verified = await makeUser("verified", true);
  unverified = await makeUser("unverified", false);
});

afterAll(async () => {
  const db = getPlatformClient();
  const users = await db.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  await db.verification.deleteMany({ where: { value: { in: users.map((u) => u.id) } } });
  await db.user.deleteMany({ where: { email: { in: emails } } });
  await db.$disconnect();
  await runtimeClient.$disconnect();
});

describe.each([
  ["member", member],
  ["platform", platform],
] as const)("the %s plane serves no password reset", (plane, call) => {
  it("answers a member and a stranger with the same 404", async () => {
    // Only the status and the equality can fail here, and that is the point:
    // with the refusal unwired, the library itself answers 400 (no
    // `sendResetPassword`) before writing or mailing anything — so what this
    // pins is that OUR refusal answers first, and identically for everybody.
    const known = await answer(await call("/request-password-reset", { email: verified.email }));
    const stranger = await answer(await call("/request-password-reset", { email: address(`nobody-${plane}`) }));
    expect(known.status).toBe(404);
    expect(known).toEqual(stranger);
  });

  it("will not redeem a live link, by POST or by the GET callback", async () => {
    // Planted the way the library would have written one, through the
    // instance's own adapter: the endpoints that issued these are closed,
    // so a link can only already exist — from before this slice, or from
    // the OTHER plane, which reads the same table. `/reset-password` never
    // asks whether reset is configured; without the refusal this one works.
    const { internalAdapter } = await auth.$context;
    const raw = `plantedtoken${plane}${run.replace(/-/g, "")}`;
    await internalAdapter.createVerificationValue({
      identifier: `reset-password:${raw}`,
      value: verified.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const credential = await credentialOf(verified.id);

    const posted = await call("/reset-password", { token: raw, newPassword: `attacker-${randomUUID()}` });
    const got = await call(`/reset-password/${raw}?callbackURL=%2F`);
    expect(posted.status).toBe(404);
    expect(got.status).toBe(404);
    expect(await credentialOf(verified.id)).toBe(credential);
  });
});

describe("the member plane mails nobody on a stranger's say-so", () => {
  it("/send-verification-email is the same 404 for an unverified user and a stranger", async () => {
    // Before this slice an unverified user's address got a mail — and, with
    // no transport, a 500 where every other address got 200. The refusal
    // now answers before any lookup, so the status and the equality are
    // what can fail.
    const pending = await answer(await member("/send-verification-email", { email: unverified.email }));
    const stranger = await answer(await member("/send-verification-email", { email: address("nobody-verify") }));
    expect(pending.status).toBe(404);
    expect(pending).toEqual(stranger);
  });

  it("has no /change-email — refused before it even asks for a session", async () => {
    // Without the closure this is the library's 401 for a missing session;
    // the 404 is what proves the refusal runs first, for everybody.
    const res = await member("/change-email", { newEmail: address("hijack") });
    expect(res.status).toBe(404);
  });

  it.each([
    ["change-email-verification", { requestType: "change-email-verification" }],
    ["legacy (no requestType)", undefined],
  ] as const)(
    "refuses a validly SIGNED %s link at /verify-email — no session, no new address",
    async (_label, extra) => {
      // Nothing on this plane mints these any more (/change-email is refused),
      // so the only one that can arrive was signed by whoever holds the
      // secret. Signed here with the real one, to prove the refusal is not
      // merely the library rejecting a bad signature: for such a link the
      // library would create a session for the named user and rewrite the
      // address, with no password and no second factor.
      const db = getPlatformClient();
      const newAddress = address(`taken-${extra ? "v" : "legacy"}`);
      emails.push(newAddress);
      const token = await createEmailVerificationToken(
        (await auth.$context).secret,
        verified.email,
        newAddress,
        3600,
        extra,
      );
      const before = await db.session.count({ where: { userId: verified.id } });

      const res = await member(`/verify-email?token=${encodeURIComponent(token)}&callbackURL=%2F`);
      expect((await db.user.findUniqueOrThrow({ where: { id: verified.id } })).email).toBe(verified.email);
      expect(await db.session.count({ where: { userId: verified.id } })).toBe(before);
      expect(res.status).toBe(404);
    },
  );
});

describe("a change-email link the member plane cannot read is refused too — it fails closed", () => {
  it("refuses a validly SIGNED link whose payload begins with a byte-order mark", async () => {
    // The fix review's bypass of the first version: Node's decode keeps the
    // mark and JSON.parse throws, so the refusal let the token through "for
    // the library to refuse" — but jose strips the mark, verifies, and the
    // library takes the change-email branch that creates the session. Signed
    // here with the instance's real secret, byte for byte as jose checks it.
    const db = getPlatformClient();
    const newAddress = address("taken-bom");
    emails.push(newAddress);
    const secret = (await auth.$context).secret;
    const b64 = (bytes: Buffer) => bytes.toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const header = b64(Buffer.from(JSON.stringify({ alg: "HS256" })));
    const claims = Buffer.from(
      JSON.stringify({ email: verified.email, updateTo: newAddress, requestType: "change-email-verification", iat: now, exp: now + 3600 }),
    );
    const payload = b64(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), claims]));
    const signature = b64(createHmac("sha256", secret).update(`${header}.${payload}`).digest());
    const token = `${header}.${payload}.${signature}`;
    // THE POSITIVE CONTROL: the library's own verifier accepts this token and
    // reads the change-email claim through the mark. Without it, a signature
    // that silently drifted would make the refusal below pass for the wrong
    // reason — the library rejecting a bad token, not our check refusing a
    // good one.
    expect((await verifyJWT(token, secret))?.["updateTo"]).toBe(newAddress);
    const before = await db.session.count({ where: { userId: verified.id } });

    const res = await member(`/verify-email?token=${encodeURIComponent(token)}&callbackURL=%2F`);
    // The STATE first: it is the claim, and a 302 alone cannot tell a
    // refused link from an honoured one — the library redirects on both.
    expect((await db.user.findUniqueOrThrow({ where: { id: verified.id } })).email).toBe(verified.email);
    expect(await db.session.count({ where: { userId: verified.id } })).toBe(before);
    expect(res.status).toBe(404);
  });
});

describe("the platform plane accepts no email-verification link", () => {
  it("/send-verification-email is a 404 for every address", async () => {
    const pending = await answer(await platform("/send-verification-email", { email: unverified.email }));
    const stranger = await answer(await platform("/send-verification-email", { email: address("nobody-ops-verify") }));
    expect(pending.status).toBe(404);
    expect(pending).toEqual(stranger);
  });
});

describe("what stays open", () => {
  it("both planes still answer a sign-in — the closure is a list, not a wall", async () => {
    // A stranger's address, so neither plane's audit hook has anybody to
    // record against. A 401 rather than a 404 is the whole assertion.
    const body = { email: address("nobody-signin"), password: `not-${randomUUID()}` };
    expect((await member("/sign-in/email", body)).status).toBe(401);
    expect((await platform("/sign-in/email", body)).status).toBe(401);
  });

  it("a new member signs up, is mailed a link after the response, and the link signs them in — on the member plane only", async () => {
    const email = address("signup");
    emails.push(email);
    const res = await member("/sign-up/email", { email, password, name: "Plane Signup" });
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(mailTo(email)).toHaveLength(1), settle);
    const link = new URL(/https?:\/\/\S+/.exec(mailTo(email)[0]!.text)![0]);
    expect(link.pathname).toBe("/api/auth/verify-email");
    const token = link.searchParams.get("token")!;
    expect(token).toBeTruthy();

    // THE CONSOLE REFUSES IT. The two instances share a secret, so before
    // this slice the platform's /verify-email accepted a member-signed link
    // (and a change-email link minted a PLATFORM session outright).
    const db = getPlatformClient();
    const onOps = await platform(`/verify-email?token=${encodeURIComponent(token)}&callbackURL=%2F`);
    expect(onOps.status).toBe(404);
    expect((await db.user.findUniqueOrThrow({ where: { email } })).emailVerified).toBe(false);

    // …and the member plane, where the link was meant to land, honours it —
    // which is also what proves the change-email refusal lets sign-up's own
    // link through.
    const onApp = await member(`/verify-email?token=${encodeURIComponent(token)}&callbackURL=%2F`);
    expect(onApp.status).toBeLessThan(400);
    const user = await db.user.findUniqueOrThrow({ where: { email }, include: { sessions: true } });
    expect(user.emailVerified).toBe(true);
    expect(user.sessions.map((s) => s.plane)).toEqual(["MEMBER"]);
  });

  it("answers an address that is ALREADY registered byte for byte as it answers a new one", async () => {
    const email = address("twice");
    emails.push(email);
    const name = "Plane Twice";
    const fresh = await answer(await member("/sign-up/email", { email, password, name }));
    const again = await answer(await member("/sign-up/email", { email, password: `other-${randomUUID()}`, name }));
    // Not "shaped alike": IDENTICAL. The stand-in user the library builds for
    // a registered address carried an id from another generator than the
    // database row's, and the first cut of this slice mimicked the layout —
    // which the review measured to be recognisable half the time. Now the
    // answer names nobody.
    expect(again).toEqual(fresh);
    expect(JSON.parse(fresh.body)).toEqual({ token: null, user: null });

    // Only the real sign-up wrote a user and sent a mail.
    await vi.waitFor(() => expect(mailTo(email)).toHaveLength(1), settle);
    expect(await getPlatformClient().user.count({ where: { email } })).toBe(1);
  });

  it.each([
    ["a NUL in the name, which Postgres text cannot hold", { name: "Plane\u0000Nul" }],
    ["a locale that is not a string", { name: "Plane Locale", locale: 1 }],
    ["an image", { name: "Plane Image", image: "\u0000" }],
    [
      "a lone surrogate in callbackURL, on which encodeURIComponent throws",
      { name: "Plane Surrogate", callbackURL: `${appUrl.origin}/\ud800` },
    ],
    [
      "a field the page never sends (pins the allowlist: the library would default this one on both branches)",
      { name: "Plane Extra", twoFactorEnabled: true },
    ],
  ])("refuses %s alike for a new and a registered address — and creates nobody", async (_label, extra) => {
    // The first four reached a step that throws on the new-address branch
    // only — the INSERT, or the callbackURL's encoding after it — so a new
    // address answered 422 or 500 and a registered one 200, with nothing
    // mailed: a silent, repeatable membership test. The surrogate was found
    // by the SECOND review, after the first fix had checked only the name.
    const db = getPlatformClient();
    const fresh = address(`hostile-${randomUUID().slice(0, 6)}`);
    emails.push(fresh);
    const forNew = await answer(await member("/sign-up/email", { email: fresh, password, ...extra }));
    const forKnown = await answer(await member("/sign-up/email", { email: verified.email, password, ...extra }));
    expect(forNew.status).toBe(400);
    expect(forNew).toEqual(forKnown);
    expect(await db.user.count({ where: { email: fresh } })).toBe(0);
  });

  it("answers a sign-up before the mail is sent — a transport that never answers cannot hold it", async () => {
    // Better Auth awaits the verification callback on a NEW address only, so
    // a send on the response path was a stopwatch for who is not yet a member.
    const email = address("hung");
    emails.push(email);
    const real = setTransport(() => new Promise<void>(() => {}));
    try {
      const answered = await Promise.race([
        member("/sign-up/email", { email, password, name: "Plane Hung" }),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 10_000)),
      ]);
      expect(answered).not.toBe("hung");
      expect((answered as Response).status).toBe(200);
    } finally {
      setTransport(real);
    }
  });
});
