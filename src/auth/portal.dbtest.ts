import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/* eslint-disable no-restricted-imports -- dbtest exercises the raw layer */
import { getPlatformClient, runtimeClient } from "@/db/client";

import { auth } from "./index";
import { portalAuth, SIGN_IN_REFUSED } from "./portal";

/**
 * The portal Better Auth instance, end to end, against the real schema
 * and the real app_runtime role.
 *
 * MOST OF THIS FILE EXISTS BECAUSE THE PARTS IT COVERS ARE DERIVED
 * RATHER THAN DECLARED, and a derived name that is wrong fails only at
 * runtime, on the first real sign-in:
 *   - the `contactaccounts` include key the adapter computes from the
 *     model name (see prisma/schema.prisma, Contact);
 *   - the additional fields, which come back `undefined` rather than
 *     missing if the instance schema forgets them — the failure that
 *     made /ops unreachable in 2026-09-09, and which here would mean a
 *     session with no client scope;
 *   - that the cookie NAME is not a barrier and the TABLE is.
 * Reading the library's source can tell you what these should be; only
 * this file tells you what they are.
 */

const run = randomUUID().slice(0, 8);
const T = randomUUID();
const CLIENT = randomUUID();
const contactEmail = `e2e-portal-${run}@test.invalid`;
const memberEmail = `e2e-member-${run}@test.invalid`;
const password = "correct-horse-battery-staple-9";
const memberPassword = "another-correct-horse-42";

let contactId = "";

/** The session cookie value out of a Better Auth response. */
const cookieValueOf = (res: Response, name: string): string | null => {
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1);
  }
  return null;
};

const headersWith = (name: string, value: string): Headers =>
  new Headers({ cookie: `${name}=${value}` });

beforeAll(async () => {
  const db = getPlatformClient();
  await db.tenant.create({
    data: { id: T, name: `e2e-portal-${run}`, slug: `e2e-portal-${run}`, entitlements: {} },
  });
  await db.client.create({ data: { id: CLIENT, tenantId: T, name: "Acme" } });
  const contact = await db.contact.create({
    data: {
      tenantId: T,
      clientId: CLIENT,
      name: "Casey Contact",
      email: contactEmail,
      emailVerified: true,
      portalStatus: "ACTIVE",
      portalProfile: "CONTACT_PRIMARY",
    },
  });
  contactId = contact.id;
  // The credential, created the way invite acceptance will create it:
  // directly, never through a signup endpoint (there is none).
  const ctx = await portalAuth.$context;
  await db.contactAccount.create({
    data: {
      contactId: contact.id,
      accountId: contact.id,
      providerId: "credential",
      password: await ctx.password.hash(password),
    },
  });
});

afterAll(async () => {
  const db = getPlatformClient();
  await db.contactSession.deleteMany({ where: { contactId } });
  await db.contactAccount.deleteMany({ where: { contactId } });
  await db.contact.deleteMany({ where: { tenantId: T } });
  await db.client.deleteMany({ where: { tenantId: T } });
  await db.tenant.deleteMany({ where: { id: T } });
  await db.user.deleteMany({ where: { email: memberEmail } });
  await db.$disconnect();
  await runtimeClient.$disconnect();
});

describe("portal sign-in", () => {
  it("signs a contact in and writes a row in contact_session, not session", async () => {
    const res = await portalAuth.api.signInEmail({ body: { email: contactEmail, password } });
    expect(res.token).toBeTruthy();

    const db = getPlatformClient();
    expect(await db.contactSession.count({ where: { contactId } })).toBe(1);
    // The member table is untouched — the planes do not share storage.
    expect(await db.session.count({ where: { userId: contactId } })).toBe(0);
  });

  it("carries tenantId, clientId and portalProfile onto the session user", async () => {
    // THE additionalFields TRAP. Better Auth copies only the columns an
    // instance declares; an undeclared one reads `undefined` however
    // full the row is. Here that would be a session with no client
    // scope, against a portal_gate whose predicate IS the client.
    const res = await portalAuth.api.signInEmail({
      body: { email: contactEmail, password },
      asResponse: true,
    });
    const value = cookieValueOf(res, "__Host-flv.portal");
    expect(value).toBeTruthy();

    const session = await portalAuth.api.getSession({
      headers: headersWith("__Host-flv.portal", value as string),
    });
    const user = session?.user as unknown as Record<string, unknown>;
    expect(user?.["tenantId"]).toBe(T);
    expect(user?.["clientId"]).toBe(CLIENT);
    expect(user?.["portalStatus"]).toBe("ACTIVE");
    expect(user?.["portalProfile"]).toBe("CONTACT_PRIMARY");
  });

  it("rejects a wrong password", async () => {
    await expect(
      portalAuth.api.signInEmail({ body: { email: contactEmail, password: "wrong-password-1" } }),
    ).rejects.toThrow();
  });

  it("rejects an address that belongs to no contact", async () => {
    await expect(
      portalAuth.api.signInEmail({ body: { email: `e2e-nobody-${run}@test.invalid`, password } }),
    ).rejects.toThrow();
  });

  it("has NO signup endpoint — invite-only is the invariant", async () => {
    const res = await portalAuth.handler(
      new Request("http://localhost:3000/api/portal-auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: `e2e-intruder-${run}@test.invalid`,
          password,
          name: "Intruder",
        }),
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    const db = getPlatformClient();
    expect(await db.contact.count({ where: { email: `e2e-intruder-${run}@test.invalid` } })).toBe(0);
  });
});

describe("portal admission: only an ACTIVE contact gets a session", () => {
  const setStatus = async (portalStatus: "ACTIVE" | "SUSPENDED" | "REVOKED" | "INVITED") => {
    const db = getPlatformClient();
    await db.contact.update({ where: { id: contactId }, data: { portalStatus } });
  };

  afterAll(async () => setStatus("ACTIVE"));

  it("refuses a SUSPENDED contact even with the right password, and mints nothing", async () => {
    const db = getPlatformClient();
    await db.contactSession.deleteMany({ where: { contactId } });
    await setStatus("SUSPENDED");

    await expect(
      portalAuth.api.signInEmail({ body: { email: contactEmail, password } }),
    ).rejects.toThrow();
    expect(await db.contactSession.count({ where: { contactId } })).toBe(0);
  });

  it("refuses REVOKED and INVITED too — nothing but the literal ACTIVE opens it", async () => {
    const db = getPlatformClient();
    for (const status of ["REVOKED", "INVITED"] as const) {
      await setStatus(status);
      await expect(
        portalAuth.api.signInEmail({ body: { email: contactEmail, password } }),
      ).rejects.toThrow();
      expect(await db.contactSession.count({ where: { contactId } })).toBe(0);
    }
  });

  it("refuses a SUSPENDED contact with a body IDENTICAL to a wrong password", async () => {
    // The claim in portal.ts is that the two are indistinguishable from
    // outside. The first cut's refusal was byte-different (its own
    // message, and no `code` field), and BOTH reviews caught it. The
    // constant is hand-copied from the library — `BASE_ERROR_CODES` is
    // not re-exported by `better-auth` or `better-auth/api` — so this
    // compares against a REAL wrong-password response and fails if the
    // library ever rewords it.
    const body = async (res: Response) => {
      const parsed = (await res.json()) as Record<string, unknown>;
      return { status: res.status, code: parsed["code"], message: parsed["message"] };
    };
    const call = (pwd: string) =>
      portalAuth.handler(
        new Request("http://localhost:3000/api/portal-auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: contactEmail, password: pwd }),
        }),
      );

    await setStatus("ACTIVE");
    const wrongPassword = await body(await call("definitely-not-the-password"));
    await setStatus("SUSPENDED");
    const suspended = await body(await call(password));

    expect(suspended).toEqual(wrongPassword);
    expect(suspended.code).toBe(SIGN_IN_REFUSED.code);
    expect(suspended.message).toBe(SIGN_IN_REFUSED.message);
  });
});

describe("invite-only survives the password-reset endpoints (the HIGH finding)", () => {
  /**
   * Better Auth's `/reset-password` CREATES a credential when none
   * exists, and configuring `sendResetPassword` is what mounts the
   * unauthenticated `/request-password-reset` that issues the token. So
   * the three refusals this slice put in front of `contact` INSERT did
   * not cover `contact_account`, and a contact a member had merely
   * RECORDED could have given themselves a portal password.
   *
   * Driven through the real HTTP handler rather than the adapter, since
   * the endpoints are the thing under test.
   */
  const post = (path: string, body: unknown) =>
    portalAuth.handler(
      new Request(`http://localhost:3000/api/portal-auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  it("a never-invited contact cannot obtain a credential through reset-password", async () => {
    const db = getPlatformClient();
    const email = `e2e-uninvited-${run}@test.invalid`;
    const uninvited = await db.contact.create({
      data: { tenantId: T, clientId: CLIENT, name: "Uninvited", email }, // NO_ACCESS
    });

    // The request is accepted — deliberately, because the response is
    // constant whether or not the address matches anyone. Answering
    // differently here would turn it into an account-enumeration oracle
    // for every agency's client list.
    const requested = await post("/request-password-reset", { email, redirectTo: "/portal" });
    expect(requested.status).toBeLessThan(400);

    // No mail was sent, because sendResetPassword refuses a contact
    // that is not ACTIVE.
    const token = await db.contactVerification.findFirst({
      where: { value: uninvited.id },
      orderBy: { createdAt: "desc" },
    });

    // Even handed the token directly, the database refuses the
    // credential. This is the control that does not depend on our
    // guard being reached.
    if (token) {
      const reset = await post("/reset-password", {
        token: token.identifier.replace(/^reset-password:/, ""),
        newPassword: "attacker-chosen-password-1",
      });
      expect(reset.status).toBeGreaterThanOrEqual(400);
    }
    expect(await db.contactAccount.count({ where: { contactId: uninvited.id } })).toBe(0);

    await db.contactVerification.deleteMany({ where: { value: uninvited.id } });
    await db.contact.delete({ where: { id: uninvited.id } });
  });
});

describe("the planes do not leak into each other", () => {
  it("a MEMBER session token replayed under the portal cookie name is not a session", async () => {
    // The trap this measures: better-call signs the cookie VALUE alone
    // and all three instances share one BETTER_AUTH_SECRET, so the
    // signature below verifies perfectly under the wrong name. What
    // refuses it is that `contact_session` has no such row.
    await auth.api.signUpEmail({
      body: { email: memberEmail, password: memberPassword, name: "Member" },
    });
    const db = getPlatformClient();
    await db.user.update({ where: { email: memberEmail }, data: { emailVerified: true } });

    const res = await auth.api.signInEmail({
      body: { email: memberEmail, password: memberPassword },
      asResponse: true,
    });
    const memberCookie = cookieValueOf(res, "__Host-flv.member");
    expect(memberCookie).toBeTruthy();

    // Sanity: the value really is a live session on its own plane.
    expect(
      await auth.api.getSession({ headers: headersWith("__Host-flv.member", memberCookie as string) }),
    ).not.toBeNull();

    // The same value, renamed. No portal session.
    expect(
      await portalAuth.api.getSession({
        headers: headersWith("__Host-flv.portal", memberCookie as string),
      }),
    ).toBeNull();
  });

  it("a portal session token is not a member session", async () => {
    const res = await portalAuth.api.signInEmail({
      body: { email: contactEmail, password },
      asResponse: true,
    });
    const portalCookie = cookieValueOf(res, "__Host-flv.portal");
    expect(portalCookie).toBeTruthy();
    expect(
      await auth.api.getSession({
        headers: headersWith("__Host-flv.member", portalCookie as string),
      }),
    ).toBeNull();
  });
});
