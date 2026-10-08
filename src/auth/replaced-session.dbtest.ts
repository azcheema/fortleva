import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/* eslint-disable no-restricted-imports -- dbtest creates and reads its users through the raw layer */
import { getPlatformClient, runtimeClient } from "@/db/client";
import { resetLocalLimiter } from "@/ratelimit";

import { auth } from "./index";

/**
 * A NEW SIGN-IN ENDS A DIFFERENT PERSON'S SESSION THE BROWSER STILL CARRIED
 * (Phase 5 slice 106; founder decision C74 (l); `./replaced-session.ts`) —
 * against the real Better Auth instance and schema. The same person signing
 * in again keeps their earlier session. Two users of this file's own, no
 * tenant: sessions belong to users.
 */

const platform = getPlatformClient();
const run = randomUUID().slice(0, 8);
const password = `pw-${randomUUID()}`;
/** Carl has a second factor: his password step ends in a challenge, never a session. */
const users = { anna: randomUUID(), bert: randomUUID(), carl: randomUUID() };
const emailOf = (who: keyof typeof users) => `${who}-replaced-${run}@test.invalid`;

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

/** Sign in as someone, from a browser carrying `cookie` (or none); the new cookie jar. */
async function signIn(who: keyof typeof users, cookie = ""): Promise<string> {
  const { headers } = await auth.api.signInEmail({
    body: { email: emailOf(who), password },
    headers: new Headers(cookie ? { cookie } : {}),
    returnHeaders: true,
  });
  return cookieJar(headers, cookie);
}

const sessionsOf = (who: keyof typeof users) => platform.session.count({ where: { userId: users[who] } });

beforeAll(async () => {
  resetLocalLimiter();
  const hash = await hashPassword(password);
  for (const who of Object.keys(users) as (keyof typeof users)[]) {
    const id = users[who];
    await platform.user.create({ data: { id, name: who, email: emailOf(who), emailVerified: true, twoFactorEnabled: who === "carl" } });
    await platform.account.create({ data: { id: randomUUID(), userId: id, accountId: id, providerId: "credential", password: hash } });
  }
});

afterAll(async () => {
  // Carl's challenges: twoFactor writes `2fa-<id>` (value = his id) and its
  // `2fa-attempts-2fa-<id>` sibling for each password step.
  const challenges = await platform.verification.findMany({ where: { value: users.carl }, select: { identifier: true } });
  await platform.verification.deleteMany({
    where: { identifier: { in: challenges.flatMap((c) => [c.identifier, `2fa-attempts-${c.identifier}`]) } },
  });
  await platform.session.deleteMany({ where: { userId: { in: Object.values(users) } } });
  await platform.account.deleteMany({ where: { userId: { in: Object.values(users) } } });
  await platform.user.deleteMany({ where: { id: { in: Object.values(users) } } });
  await platform.$disconnect();
  await runtimeClient.$disconnect();
});

describe("a sign-in over someone else's live session (C74 (l))", () => {
  it("ends the previous person's session on that browser — and only theirs", async () => {
    const annasBrowser = await signIn("anna");
    // Anna also signed in elsewhere: that session is not this browser's.
    await signIn("anna");
    expect(await sessionsOf("anna")).toBe(2);

    // Bert signs in on Anna's browser, whose cookie still names her live session.
    const bertsBrowser = await signIn("bert", annasBrowser);
    expect(await sessionsOf("bert")).toBe(1);
    // Hers on THIS browser is gone; the other one stays.
    expect(await sessionsOf("anna")).toBe(1);
    expect(bertsBrowser).not.toBe(annasBrowser);
  });

  it("ends it for a sign-in that asks for a second factor too — at the password step (the fix-pass review's medium)", async () => {
    const annasBrowser = await signIn("anna");
    const annaBefore = await sessionsOf("anna");
    // Carl's correct password over Anna's live cookie: a challenge, no session yet.
    const challenged = await auth.api.signInEmail({
      body: { email: emailOf("carl"), password },
      headers: new Headers({ cookie: annasBrowser }),
    });
    expect(challenged).toMatchObject({ twoFactorRedirect: true });
    expect(await sessionsOf("carl")).toBe(0);
    // Anna's session on this browser is gone already: the browser's cookie was
    // expired by the challenge, so it could never be used from here again.
    expect(await sessionsOf("anna")).toBe(annaBefore - 1);
  });

  it("a WRONG password over someone's cookie ends nothing", async () => {
    const annasBrowser = await signIn("anna");
    const annaBefore = await sessionsOf("anna");
    await expect(
      auth.api.signInEmail({ body: { email: emailOf("bert"), password: `wrong-${password}` }, headers: new Headers({ cookie: annasBrowser }) }),
    ).rejects.toThrow();
    expect(await sessionsOf("anna")).toBe(annaBefore);
  });

  it("keeps the same person's earlier session when they sign in again", async () => {
    const before = await sessionsOf("bert");
    const first = await signIn("bert");
    await signIn("bert", first);
    expect(await sessionsOf("bert")).toBe(before + 2);
  });

  it("does nothing for a browser that carried no session, or a cookie naming none", async () => {
    const before = await sessionsOf("anna");
    await signIn("anna");
    expect(await sessionsOf("anna")).toBe(before + 1);
    await signIn("anna", "fortleva.session_token=not-a-real-signed-token");
    expect(await sessionsOf("anna")).toBe(before + 2);
  });
});
