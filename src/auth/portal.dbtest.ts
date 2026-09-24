import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/* eslint-disable no-restricted-imports -- dbtest exercises the raw layer */
import { getPlatformClient, runtimeClient } from "@/db/client";
import { setTransport } from "@/mailer";

import { auth } from "./index";
import {
  deliverPortalReset,
  portalAuth,
  portalResetHolder,
  portalResetUrl,
  RESET_MAILS_PER_HOUR,
  SIGN_IN_REFUSED,
} from "./portal";

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
// Per run, never a literal: the repository is public, and a run killed before
// afterAll would leave a working credential behind with its password printed here.
const password = `pw-${randomUUID()}`;
const memberPassword = `pw-${randomUUID()}`;

let contactId = "";
/**
 * Contacts whose reset rows must go at the end. `contact_verification` has
 * no foreign key to `contact` — a row is looked up BY its token — so
 * deleting the contact takes nothing with it.
 */
const resetContactIds: string[] = [];

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
  await db.contactVerification.deleteMany({ where: { value: { in: resetContactIds } } });
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

/** Drive an endpoint through the real HTTP handler, as a browser would. */
const post = (path: string, body: unknown) =>
  portalAuth.handler(
    new Request(`http://localhost:3000/api/portal-auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

/**
 * Every message the dev transport wrote to `address`. A dbtest runs
 * outside production, so `send()` appends to `.dev-outbox/outbox.jsonl`
 * exactly as it does under `pnpm dev`; the addresses carry `run`, so no
 * earlier run's mail can be mistaken for this one's.
 */
const mailTo = (address: string): { subject: string; text: string }[] => {
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
    .filter((msg) => msg.to === address)
    .map((msg) => ({ subject: msg.subject ?? "", text: msg.text ?? "" }));
};

const RESET_LINK = new RegExp("/portal/reset-password/([A-Za-z0-9_-]+)");
const tokenIn = (text: string): string => RESET_LINK.exec(text)?.[1] ?? "";

/** The mail is sent off the response path, so every assertion on it waits. */
const settle = { timeout: 15_000, interval: 100 };

describe("the password reset (the portal's reset screens)", () => {
  /**
   * A contact of its own, because a reset REVOKES every session and
   * replaces the password — the sign-in tests above must not have either
   * pulled out from under them, whatever order a runner picks.
   */
  const resetEmail = `e2e-portal-reset-${run}@test.invalid`;
  const pausedEmail = `e2e-portal-paused-${run}@test.invalid`;
  const burstEmail = `e2e-portal-burst-${run}@test.invalid`;
  const firstPassword = `first-${randomUUID()}`;
  const newPassword = `second-${randomUUID()}`;
  let resetId = "";
  let pausedId = "";
  let burstId = "";

  beforeAll(async () => {
    const db = getPlatformClient();
    const ctx = await portalAuth.$context;
    const make = async (email: string, portalStatus: "ACTIVE" | "SUSPENDED") => {
      // ACTIVE first, whatever it ends as: `contact_account_requires_invite`
      // admits a credential only for an INVITED or ACTIVE contact, so a
      // paused contact's password exists because they were active once —
      // which is the order this builds them in.
      const c = await db.contact.create({
        data: {
          tenantId: T,
          clientId: CLIENT,
          name: "Robin Reset",
          email,
          emailVerified: true,
          portalStatus: "ACTIVE",
          portalProfile: "CONTACT_COLLABORATOR",
        },
      });
      await db.contactAccount.create({
        data: {
          contactId: c.id,
          accountId: c.id,
          providerId: "credential",
          password: await ctx.password.hash(firstPassword),
        },
      });
      if (portalStatus !== "ACTIVE") {
        await db.contact.update({ where: { id: c.id }, data: { portalStatus } });
      }
      return c.id;
    };
    resetId = await make(resetEmail, "ACTIVE");
    pausedId = await make(pausedEmail, "SUSPENDED");
    burstId = await make(burstEmail, "ACTIVE");
    resetContactIds.push(resetId, pausedId, burstId);
  });

  it("mails an ACTIVE contact a link to the new-password SCREEN, and keeps only a hash of it", async () => {
    const res = await post("/request-password-reset", { email: resetEmail });
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(mailTo(resetEmail)).toHaveLength(1), settle);
    const [mail] = mailTo(resetEmail);
    // The screen, not Better Auth's `/reset-password/:token` callback — no
    // caller-supplied `redirectTo` is anywhere in the chain.
    expect(mail!.text).toContain(portalResetUrl(tokenIn(mail!.text)));
    expect(mail!.text).not.toContain("/api/portal-auth");
    // The agency is named, because it is what makes the mail trustworthy.
    expect(mail!.subject).toContain(`e2e-portal-${run}`);

    const token = tokenIn(mail!.text);
    expect(token).not.toBe("");
    // STORED AS A HASH: nothing in the table is the token, or contains it.
    const db = getPlatformClient();
    const rows = await db.contactVerification.findMany({ where: { value: resetId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.identifier).not.toContain(token);
    // …and the page's own lookup still resolves it, through the same hash.
    expect(await portalResetHolder(token)).toEqual({ email: resetEmail });
  });

  it("answers an unknown address, a paused contact and an active one with the SAME body", async () => {
    const answer = async (email: string) => {
      const res = await post("/request-password-reset", { email });
      return { status: res.status, body: await res.json() };
    };
    const active = await answer(resetEmail);
    const paused = await answer(pausedEmail);
    const unknown = await answer(`e2e-portal-nobody-${run}@test.invalid`);
    expect(paused).toEqual(active);
    expect(unknown).toEqual(active);

    // …and only the active one is mailed. The paused contact's row was
    // written by the library before our code ran; declining removes it,
    // so a flood aimed at a paused address grows nothing.
    const db = getPlatformClient();
    await vi.waitFor(
      async () => expect(await db.contactVerification.count({ where: { value: pausedId } })).toBe(0),
      settle,
    );
    await vi.waitFor(() => expect(mailTo(resetEmail)).toHaveLength(2), settle);
    expect(mailTo(pausedEmail)).toHaveLength(0);
  });

  it(`sends one contact at most ${RESET_MAILS_PER_HOUR} mails an hour, however many times it is asked`, async () => {
    const db = getPlatformClient();
    // Two were sent by the tests above; ask twice more than the cap allows.
    for (let asked = 3; asked <= RESET_MAILS_PER_HOUR + 2; asked++) {
      const res = await post("/request-password-reset", { email: resetEmail });
      expect(res.status).toBe(200);
      // SETTLE EACH REQUEST BEFORE THE NEXT, so every assertion below is
      // about THIS request. The cap counts by creation order, so an overlap
      // would not change WHICH requests are mailed (the burst test below
      // pins that); settling is what lets this one say, request by request,
      // that the first three went and the rest did not. Under the cap, a
      // request has settled when its mail exists; over it, when its row
      // has been written and removed again.
      if (asked <= RESET_MAILS_PER_HOUR) {
        await vi.waitFor(() => expect(mailTo(resetEmail)).toHaveLength(asked), settle);
      } else {
        await vi.waitFor(
          async () =>
            expect(await db.contactVerification.count({ where: { value: resetId } })).toBe(
              RESET_MAILS_PER_HOUR,
            ),
          settle,
        );
      }
    }
    await vi.waitFor(
      () => expect(mailTo(resetEmail)).toHaveLength(RESET_MAILS_PER_HOUR),
      settle,
    );
  });

  it("a reset sets the password, ends every session, kills the OTHER links, and is audited as the contact", async () => {
    const db = getPlatformClient();
    await portalAuth.api.signInEmail({ body: { email: resetEmail, password: firstPassword } });
    expect(await db.contactSession.count({ where: { contactId: resetId } })).toBe(1);

    const mails = mailTo(resetEmail);
    const newest = tokenIn(mails.at(-1)!.text);
    const older = tokenIn(mails[0]!.text);
    expect(newest).not.toBe(older);

    const res = await post("/reset-password", { token: newest, newPassword });
    expect(res.status).toBe(200);

    // revokeSessionsOnPasswordReset: the session held before is gone.
    expect(await db.contactSession.count({ where: { contactId: resetId } })).toBe(0);
    // The new password works and the old one does not.
    await expect(
      portalAuth.api.signInEmail({ body: { email: resetEmail, password: firstPassword } }),
    ).rejects.toThrow();
    const signedIn = await portalAuth.api.signInEmail({
      body: { email: resetEmail, password: newPassword },
    });
    expect(signedIn.token).toBeTruthy();

    // THE OTHER LINKS DIED WITH IT. Better Auth consumes only the one used;
    // an older mail in the same inbox must not reset the password again.
    expect(await db.contactVerification.count({ where: { value: resetId } })).toBe(0);
    expect(await portalResetHolder(older)).toBeNull();
    const again = await post("/reset-password", { token: older, newPassword: "third-correct-horse-3" });
    expect(again.status).toBe(400);

    // AUDITED, as the contact, in the tenant's own log. Until this slice
    // the portal wrote no row for a reset at all: the shared hook passed
    // the sink an id, and the portal sink finds its tenant on the USER.
    const audits = await db.auditEvent.findMany({
      where: { tenantId: T, action: "auth.password_changed", targetId: resetId },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorType).toBe("CONTACT");
    expect(audits[0]!.actorId).toBe(resetId);
    expect(audits[0]!.metadata).toEqual({ via: "reset" });
  });

  it("refuses a live link whose contact was paused behind the purge's back — with the library's own refusal", async () => {
    // The purge in `setContactPortalAccess` is what normally kills these;
    // this writes the status DIRECTLY, as a purge that matched nothing
    // would leave it, to prove the redemption checks for itself.
    const db = getPlatformClient();
    const { internalAdapter } = await portalAuth.$context;
    const raw = `leakedtoken${run.replace(/-/g, "")}`;
    await internalAdapter.createVerificationValue({
      identifier: `reset-password:${raw}`,
      value: resetId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await db.contact.update({ where: { id: resetId }, data: { portalStatus: "SUSPENDED" } });
    const before = await db.contactAccount.findFirstOrThrow({ where: { contactId: resetId } });

    try {
      // The page draws the dead-link state, not a form.
      expect(await portalResetHolder(raw)).toBeNull();

      const refused = await post("/reset-password", { token: raw, newPassword: "attacker-password-12" });
      const unknown = await post("/reset-password", {
        token: `nonexistent${run.replace(/-/g, "")}`,
        newPassword: "attacker-password-12",
      });
      // BYTE-IDENTICAL to a link that never existed: the guard burns the
      // token and lets the library refuse, so there is no hand-copied body.
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual(await unknown.json());

      const after = await db.contactAccount.findFirstOrThrow({ where: { contactId: resetId } });
      expect(after.password).toBe(before.password);
      expect(await db.contactVerification.count({ where: { value: resetId } })).toBe(0);
    } finally {
      await db.contact.update({ where: { id: resetId }, data: { portalStatus: "ACTIVE" } });
    }
  });

  it("mails NOBODY from /send-verification-email — a merely recorded contact least of all", async () => {
    // The library's unauthenticated branch mails any UNVERIFIED user it
    // finds, which on this plane is every contact never invited; and the
    // link could only lead to a `/verify-email` that fails here by design.
    const db = getPlatformClient();
    const email = `e2e-portal-recorded-${run}@test.invalid`;
    const recorded = await db.contact.create({
      data: { tenantId: T, clientId: CLIENT, name: "Recorded Only", email }, // NO_ACCESS, unverified
    });
    resetContactIds.push(recorded.id);

    const found = await post("/send-verification-email", { email });
    const nobody = await post("/send-verification-email", {
      email: `e2e-portal-nobody-${run}@test.invalid`,
    });
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual(await nobody.json());
    expect(mailTo(email)).toHaveLength(0);
  });

  it("burns a link stored BEFORE hashing was switched on, too", async () => {
    // Lookup and consume both fall back to the plain identifier, so a row
    // written in the old form is still redeemable for its hour. The first
    // burn deleted by the HASHED identifier only and left this one standing
    // (review finding); it burns by contact now.
    const db = getPlatformClient();
    const raw = `plaintoken${run.replace(/-/g, "")}`;
    await db.contactVerification.create({
      data: {
        identifier: `reset-password:${raw}`,
        value: resetId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    await db.contact.update({ where: { id: resetId }, data: { portalStatus: "SUSPENDED" } });
    const before = await db.contactAccount.findFirstOrThrow({ where: { contactId: resetId } });
    try {
      const refused = await post("/reset-password", { token: raw, newPassword: "attacker-password-12" });
      expect(refused.status).toBe(400);
      const after = await db.contactAccount.findFirstOrThrow({ where: { contactId: resetId } });
      expect(after.password).toBe(before.password);
      expect(await db.contactVerification.count({ where: { value: resetId } })).toBe(0);
    } finally {
      await db.contact.update({ where: { id: resetId }, data: { portalStatus: "ACTIVE" } });
    }
  });

  it("does not draw the form for an expired link", async () => {
    const { internalAdapter } = await portalAuth.$context;
    const raw = `expiredtoken${run.replace(/-/g, "")}`;
    await internalAdapter.createVerificationValue({
      identifier: `reset-password:${raw}`,
      value: resetId,
      expiresAt: new Date(Date.now() - 1000),
    });
    // `findVerificationValue` returns an expired row without complaint;
    // the holder is what compares `expiresAt`.
    expect(await portalResetHolder(raw)).toBeNull();
  });

  it("a never-invited contact cannot obtain a credential through reset-password", async () => {
    /**
     * Better Auth's `/reset-password` CREATES a credential when none
     * exists, and configuring `sendResetPassword` is what makes the
     * unauthenticated `/request-password-reset` issue the token (the
     * endpoint is mounted either way). So
     * the refusals in front of `contact` INSERT did not cover
     * `contact_account`, and a contact a member had merely RECORDED could
     * have given themselves a portal password (the HIGH finding of the
     * portal's first slice).
     *
     * The token is written DIRECTLY here, because since the reset screens'
     * slice a request for a NO_ACCESS address leaves no row behind to
     * find — and a test that found no token used to pass by skipping its
     * own assertion. The trigger that refuses the credential at the
     * database is pinned on its own in `portal-identity.dbtest.ts`; this
     * proves the endpoint refuses before it gets that far.
     */
    const db = getPlatformClient();
    const email = `e2e-uninvited-${run}@test.invalid`;
    const uninvited = await db.contact.create({
      data: { tenantId: T, clientId: CLIENT, name: "Uninvited", email }, // NO_ACCESS
    });
    resetContactIds.push(uninvited.id);

    // Accepted with the constant answer, and no row survives it.
    const requested = await post("/request-password-reset", { email });
    expect(requested.status).toBe(200);
    await vi.waitFor(
      async () =>
        expect(await db.contactVerification.count({ where: { value: uninvited.id } })).toBe(0),
      settle,
    );
    expect(mailTo(email)).toHaveLength(0);

    // Even handed a live token, the endpoint refuses and no credential appears.
    const { internalAdapter } = await portalAuth.$context;
    const raw = `uninvitedtoken${run.replace(/-/g, "")}`;
    await internalAdapter.createVerificationValue({
      identifier: `reset-password:${raw}`,
      value: uninvited.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const reset = await post("/reset-password", {
      token: raw,
      newPassword: "attacker-chosen-password-1",
    });
    expect(reset.status).toBe(400);
    expect(await db.contactAccount.count({ where: { contactId: uninvited.id } })).toBe(0);
  });

  it("delivers nothing, and removes the row, when asked directly for a paused contact", async () => {
    // The unit under the endpoint, awaited: the endpoint cannot be, since
    // it hands this off. Proves the decline path on its own terms.
    const db = getPlatformClient();
    const { internalAdapter } = await portalAuth.$context;
    const raw = `directtoken${run.replace(/-/g, "")}`;
    await internalAdapter.createVerificationValue({
      identifier: `reset-password:${raw}`,
      value: pausedId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const outcome = await deliverPortalReset(
      {
        id: pausedId,
        email: pausedEmail,
        name: "Robin Reset",
        tenantId: T,
        portalStatus: "SUSPENDED",
      },
      raw,
    );
    expect(outcome).toBe("declined");
    expect(await db.contactVerification.count({ where: { value: pausedId } })).toBe(0);
    expect(mailTo(pausedEmail)).toHaveLength(0);
  });

  it("declines a request that RACED an address change — the delivery re-reads the contact", async () => {
    // Simulates the window the fix review found: Better Auth read the
    // contact at the OLD address, a member changed it (and purged), and the
    // row landed after the purge. The delivery must not mail the old box.
    const { internalAdapter } = await portalAuth.$context;
    const raw = `racedtoken${run.replace(/-/g, "")}`;
    await internalAdapter.createVerificationValue({
      identifier: `reset-password:${raw}`,
      value: resetId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const oldAddress = `e2e-portal-old-${run}@test.invalid`;
    const outcome = await deliverPortalReset(
      { id: resetId, email: oldAddress, name: "Robin Reset", tenantId: T, portalStatus: "ACTIVE" },
      raw,
    );
    expect(outcome).toBe("declined");
    expect(mailTo(oldAddress)).toHaveLength(0);
    expect(await portalResetHolder(raw)).toBeNull();
  });

  it("declines a request whose contact was PAUSED after it arrived — the re-read's other half", async () => {
    // The snapshot says ACTIVE (it was, when Better Auth read it); the
    // database says SUSPENDED (a member pressed Pause, and the purge ran
    // before this row landed). Only the re-read can see the difference.
    const db = getPlatformClient();
    const { internalAdapter } = await portalAuth.$context;
    const raw = `pausedlatetoken${run.replace(/-/g, "")}`;
    await internalAdapter.createVerificationValue({
      identifier: `reset-password:${raw}`,
      value: resetId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await db.contact.update({ where: { id: resetId }, data: { portalStatus: "SUSPENDED" } });
    const before = mailTo(resetEmail).length;
    try {
      const outcome = await deliverPortalReset(
        { id: resetId, email: resetEmail, name: "Robin Reset", tenantId: T, portalStatus: "ACTIVE" },
        raw,
      );
      expect(outcome).toBe("declined");
      expect(mailTo(resetEmail)).toHaveLength(before);
      expect(await db.contactVerification.count({ where: { value: resetId } })).toBe(0);
    } finally {
      await db.contact.update({ where: { id: resetId }, data: { portalStatus: "ACTIVE" } });
    }
  });

  it("a send that FAILS removes its row, so lost mails cannot use up the cap", async () => {
    const db = getPlatformClient();
    const email = `e2e-portal-lostmail-${run}@test.invalid`;
    const c = await db.contact.create({
      data: {
        tenantId: T,
        clientId: CLIENT,
        name: "Lost Mail",
        email,
        emailVerified: true,
        portalStatus: "ACTIVE",
      },
    });
    resetContactIds.push(c.id);
    const { internalAdapter } = await portalAuth.$context;
    const raw = `losttoken${run.replace(/-/g, "")}`;
    await internalAdapter.createVerificationValue({
      identifier: `reset-password:${raw}`,
      value: c.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const real = setTransport(async () => {
      throw new Error("transport down");
    });
    try {
      await expect(
        deliverPortalReset(
          { id: c.id, email, name: "Lost Mail", tenantId: T, portalStatus: "ACTIVE" },
          raw,
        ),
      ).rejects.toThrow("transport down");
    } finally {
      setTransport(real);
    }
    expect(await db.contactVerification.count({ where: { value: c.id } })).toBe(0);
  });

  it(`a BURST of overlapping requests still mails exactly the first ${RESET_MAILS_PER_HOUR}`, async () => {
    // The cap counts rows created BEFORE each request's own, so requests
    // that overlap cannot race each other into all declining — which the
    // first version, counting every row it could see, did.
    const db = getPlatformClient();
    const burst = await Promise.all(
      Array.from({ length: RESET_MAILS_PER_HOUR + 2 }, () =>
        post("/request-password-reset", { email: burstEmail }),
      ),
    );
    expect(burst.map((r) => r.status)).toEqual(burst.map(() => 200));
    await vi.waitFor(
      async () =>
        expect(await db.contactVerification.count({ where: { value: burstId } })).toBe(
          RESET_MAILS_PER_HOUR,
        ),
      settle,
    );
    await vi.waitFor(() => expect(mailTo(burstEmail)).toHaveLength(RESET_MAILS_PER_HOUR), settle);
  });

  it("answers before the mail is sent — a transport that never answers cannot hold the response", async () => {
    // The endpoint must not wait on the mail: a transport round trip on the
    // response path is a stopwatch that says which addresses are clients.
    // A transport that NEVER settles makes that a yes/no question rather
    // than a timing one — if the send were awaited, this would hang.
    const real = setTransport(() => new Promise<void>(() => {}));
    try {
      const answered = await Promise.race([
        post("/request-password-reset", { email: resetEmail }),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 10_000)),
      ]);
      expect(answered).not.toBe("hung");
      expect((answered as Response).status).toBe(200);
    } finally {
      setTransport(real);
    }
    // There used to be a second half here, with a transport that THROWS. A
    // fix review showed it could not fail: the library swallows a throwing
    // `sendResetPassword` whether or not it is awaited, and the delivery
    // often had not reached the transport before the test put the real one
    // back. A test that passes both ways is not evidence, so it is gone.
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
