import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

/* eslint-disable no-restricted-imports -- dbtest exercises the raw layer */
import { getPlatformClient, runtimeClient } from "@/db/client";

import { auth } from "./index";

/**
 * Auth-layer integration: Better Auth against the real schema and the
 * real app_runtime role (AUTH-class tables: no tenant RLS, but
 * portal_deny still applies — see isolation suite).
 */

const email = `auth-${randomUUID().slice(0, 8)}@test.invalid`;
const password = "correct-horse-battery-staple-9";

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
    expect(res.user.email).toBe(email);

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

  it("blocks sign-in until the email is verified", async () => {
    await expect(
      auth.api.signInEmail({ body: { email, password } }),
    ).rejects.toThrow();
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
