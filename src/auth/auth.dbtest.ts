import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

/* eslint-disable no-restricted-imports -- dbtest exercises the raw layer */
import { getPlatformClient, runtimeClient } from "@/db/client";

import { auth } from "./index";

/**
 * Auth-layer integration: Better Auth against the real schema and the
 * real app_runtime role (AUTH-class tables: no tenant RLS, but
 * portal_deny still applies — see isolation suite).
 */

const email = `auth-${randomUUID().slice(0, 8)}@test.invalid`;
// Per run, never a literal: this repository is public, and a run killed before
// afterAll would leave a verified account behind with its password printed here.
const password = `pw-${randomUUID()}`;

afterAll(async () => {
  const platform = getPlatformClient();
  await platform.user.deleteMany({ where: { email } });
  await platform.$disconnect();
  await runtimeClient.$disconnect();
});

describe("member auth (Better Auth, email+password)", () => {
  it("signs up: user + credential account rows, uuid ids, hashed password", async () => {
    const res = await auth.api.signUpEmail({
      body: { email, password, name: "Auth Test" },
    });
    // Sign-up names nobody in its answer, a new address or a registered one
    // alike (slice 58, src/auth/sign-up-answer.ts) — so the row is read below.
    expect(res).toEqual({ token: null, user: null });

    const platform = getPlatformClient();
    const user = await platform.user.findUnique({
      where: { email },
      include: { accounts: true },
    });
    expect(user).not.toBeNull();
    expect(user?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(user?.emailVerified).toBe(false);
    expect(user?.platformRole).toBeNull();
    const cred = user?.accounts.find((a) => a.providerId === "credential");
    expect(cred?.password).toBeTruthy();
    expect(cred?.password).not.toContain(password);
  });

  it("blocks sign-in until the email is verified — and mails a fresh link for the right password (C30)", async () => {
    await expect(
      auth.api.signInEmail({ body: { email, password } }),
    ).rejects.toThrow();
    // Both confirmation mails — sign-up's and this sign-in's — run after the
    // response. Waiting for their ledger rows keeps either from still being in
    // flight when the next test confirms the address, or when `afterAll`
    // disconnects the client under it.
    await vi.waitFor(
      async () =>
        expect(await getPlatformClient().authMail.count({ where: { user: { email } } })).toBe(2),
      { timeout: 15_000, interval: 100 },
    );
  });

  it("signs in once verified; session carries plane MEMBER", async () => {
    const platform = getPlatformClient();
    await platform.user.update({
      where: { email },
      data: { emailVerified: true },
    });

    const res = await auth.api.signInEmail({ body: { email, password } });
    expect(res.token).toBeTruthy();

    const session = await platform.session.findFirst({
      where: { user: { email } },
      orderBy: { createdAt: "desc" },
    });
    expect(session?.plane).toBe("MEMBER");
    expect(session?.impersonatedBy).toBeNull();
  });

  it("rejects a wrong password", async () => {
    await expect(
      auth.api.signInEmail({ body: { email, password: "wrong-password-123" } }),
    ).rejects.toThrow();
  });
});
