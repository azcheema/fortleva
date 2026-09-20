import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getPlatformClient, runtimeClient } from "./client";
import { portalAuthClient, PortalIdentityRefused } from "./portal-identity";
import { withTenant } from "./index";

/**
 * The portal auth path's reach into `contact`, measured as the real
 * app_runtime role (a local owner role false-passes RLS, TENANCY.md
 * §11). Migration 20260920210000 and src/db/portal-identity.ts are the
 * subjects.
 *
 * WHAT THIS FILE IS EVIDENCE FOR. Three claims, in descending order of
 * how badly a mistake would hurt:
 *   1. The admission is NARROW — it opens exactly the row whose address
 *      or id the request already supplied, in any tenant, and nothing
 *      else. Cross-tenant included: the whole point of an email lookup
 *      is that it crosses tenants, so "and nothing else" has to be
 *      measured, not assumed.
 *   2. Invite-only is a DATABASE fact. There is no INSERT policy for
 *      this path, so even a mounted signup endpoint could not create a
 *      contact.
 *   3. A login cannot re-tenant its own principal. The trigger refuses
 *      a tenancy, client, profile or status change on the auth path.
 * And the control that makes 1 meaningful: with NO GUC set, this path
 * sees nothing at all.
 */

const run = randomUUID().slice(0, 8);
const T1 = randomUUID();
const T2 = randomUUID();
const client1 = randomUUID();
const client2 = randomUUID();
const contact1 = { id: randomUUID(), email: `e2e-pi-a-${run}@test.invalid` };
// Same run, different tenant: the cross-tenant control for the email GUC.
const contact2 = { id: randomUUID(), email: `e2e-pi-b-${run}@test.invalid` };

/** One auth-path unit of work, straight through the policies — the raw
 * equivalent of what portal-identity.ts wraps every delegate call in. */
const asAuthPath = async <T>(
  keys: { email?: string; id?: string },
  fn: (tx: typeof runtimeClient) => Promise<T>,
): Promise<T> =>
  runtimeClient.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('app.auth_contact_email', ${keys.email ?? ""}, true),
             set_config('app.auth_contact_id', ${keys.id ?? ""}, true)`;
    return fn(tx as unknown as typeof runtimeClient);
  });

beforeAll(async () => {
  const db = getPlatformClient();
  for (const [t, c, contact] of [
    [T1, client1, contact1],
    [T2, client2, contact2],
  ] as const) {
    await db.tenant.create({
      data: { id: t, name: `e2e-portal-identity-${run}`, slug: `e2e-pi-${t.slice(0, 8)}`, entitlements: {} },
    });
    await db.client.create({ data: { id: c, tenantId: t, name: "Acme" } });
    await db.contact.create({
      data: {
        id: contact.id,
        tenantId: t,
        clientId: c,
        name: "Casey Contact",
        email: contact.email,
        emailVerified: true,
        portalStatus: "ACTIVE",
      },
    });
  }
});

afterAll(async () => {
  const db = getPlatformClient();
  await db.contactSession.deleteMany({ where: { contactId: { in: [contact1.id, contact2.id] } } });
  await db.contactAccount.deleteMany({ where: { contactId: { in: [contact1.id, contact2.id] } } });
  await db.contact.deleteMany({ where: { tenantId: { in: [T1, T2] } } });
  await db.client.deleteMany({ where: { tenantId: { in: [T1, T2] } } });
  await db.tenant.deleteMany({ where: { id: { in: [T1, T2] } } });
  await db.$disconnect();
  await runtimeClient.$disconnect();
});

describe("contact: the auth path sees one row, or none", () => {
  it("WITHOUT any GUC, sees nothing — the control the rest rests on", async () => {
    // This is the measurement the dev database could not provide before
    // this file existed: it held zero contacts, so "0 rows" proved
    // nothing. Here the rows demonstrably exist (the platform client
    // just created them) and the app_runtime role still reads none.
    const rows = await runtimeClient.contact.findMany({
      where: { id: { in: [contact1.id, contact2.id] } },
    });
    expect(rows).toEqual([]);
  });

  it("with the EMAIL guc, sees exactly that contact — and across the tenant boundary", async () => {
    const rows = await asAuthPath({ email: contact1.email }, (tx) =>
      tx.contact.findMany({ select: { id: true, tenantId: true, clientId: true } }),
    );
    expect(rows).toEqual([{ id: contact1.id, tenantId: T1, clientId: client1 }]);
    // Crossing tenants is the FEATURE (sign-in has no tenant yet), so
    // the other tenant's contact must be absent by ADDRESS, not by luck
    // of tenancy.
    expect(rows.map((r) => r.id)).not.toContain(contact2.id);
  });

  it("with the ID guc, sees exactly that contact", async () => {
    const rows = await asAuthPath({ id: contact2.id }, (tx) =>
      tx.contact.findMany({ select: { id: true, tenantId: true } }),
    );
    expect(rows).toEqual([{ id: contact2.id, tenantId: T2 }]);
  });

  it("an email that belongs to no contact opens nothing", async () => {
    const rows = await asAuthPath({ email: `e2e-nobody-${run}@test.invalid` }, (tx) =>
      tx.contact.findMany({}),
    );
    expect(rows).toEqual([]);
  });

  it("an EMPTY guc is not a wildcard — even against a row that really is empty", async () => {
    // The delegate emits "" for the key it was not given. If "" ever
    // matched, every sign-in would hand over every contact in the
    // product, so this is the single most important negative here.
    //
    // The first version of this test proved only that no row HAPPENED
    // to have an empty email — a property of the data, not the schema
    // (security review). `contact.email` is TEXT NOT NULL with no
    // non-empty constraint, so the row below is representable. The
    // policy now compares against `nullif(guc, '')`, and NULL matches
    // nothing; this is what says so.
    const db = getPlatformClient();
    const blank = await db.contact.create({
      data: { tenantId: T2, clientId: client2, name: "Blank", email: "" },
    });
    try {
      const rows = await asAuthPath({ email: "", id: "" }, (tx) => tx.contact.findMany({}));
      expect(rows).toEqual([]);
    } finally {
      await db.contact.delete({ where: { id: blank.id } });
    }
  });

  it("does not leak the contact table to a CONTACT principal via these policies", async () => {
    // A portal read runs under withTenant as a contact principal, where
    // neither auth GUC is set. It must still see only its own client's
    // contacts — the portal_gate RESTRICTIVE policy, unchanged by this
    // migration.
    const rows = await withTenant(
      T1,
      { type: "contact", id: contact1.id, clientId: client1 },
      (tx) => tx.contact.findMany({ select: { id: true } }),
    );
    expect(rows).toEqual([{ id: contact1.id }]);
  });
});

describe("contact: what the auth path may write", () => {
  it("cannot INSERT — invite-only is enforced by the ABSENCE of a policy", async () => {
    await expect(
      asAuthPath({ email: `e2e-intruder-${run}@test.invalid` }, (tx) =>
        tx.contact.create({
          data: {
            tenantId: T1,
            clientId: client1,
            name: "Intruder",
            email: `e2e-intruder-${run}@test.invalid`,
          },
        }),
      ),
    ).rejects.toThrow();
    const db = getPlatformClient();
    expect(await db.contact.count({ where: { tenantId: T1 } })).toBe(1);
  });

  it("cannot UPDATE with the auth GUC alone — there is no UPDATE policy", async () => {
    // The read admission is read-only. This is what forces a write onto
    // the brokered seam instead, and it is checked because a later
    // "small" policy addition here would silently undo that design.
    await expect(
      asAuthPath({ id: contact1.id }, (tx) =>
        tx.contact.update({ where: { id: contact1.id }, data: { name: "Nope" } }),
      ),
    ).rejects.toThrow();
  });

  it("a tenant-less write matches no row at all — it never reaches the search feed", async () => {
    // THIS TEST REPLACES ONE THAT TESTED THE OPPOSITE OF ITS OWN NAME.
    // It was called "a tenant-less write would die on the search feed
    // anyway", and then SET `app.tenant_id` and asserted the update
    // RESOLVED — measuring nothing, while three comments elsewhere
    // asserted the 42501 in the present tense. The code review caught
    // both halves.
    //
    // The truth, and the reason those comments are now in the past
    // tense: the search-index failure belongs to the FIRST design,
    // which had an auth-path UPDATE policy. With the shipped policy set
    // the update matches zero rows — `contact_auth_lookup` is SELECT
    // only and `tenant_isolation`'s qual is NULL without a tenant — so
    // it dies on `contact` itself as a Prisma P2025, long before any
    // trigger runs. Asserted on the CODE, because "some error" would
    // pass either way and that is exactly how the wrong claim survived.
    await expect(
      runtimeClient.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.auth_contact_id', ${contact1.id}, true)`;
        return tx.contact.update({ where: { id: contact1.id }, data: { name: "Nope" } });
      }),
    ).rejects.toMatchObject({ code: "P2025" });
  });

  it("the brokered write path updates an ordinary identity column", async () => {
    const updated = (await portalAuthClient.contact.update({
      where: { id: contact1.id },
      data: { name: "Casey Brokered" },
    })) as { name: string };
    expect(updated.name).toBe("Casey Brokered");
  });

  it("cannot move a contact into another tenant, even under the system principal", async () => {
    // The trigger, not a policy: a system transaction may write any
    // column of its tenant, so the fact that the write CAME FROM the
    // auth path has to travel with it. portal-identity.ts re-asserts
    // the GUC inside the brokered transaction; this is that guard.
    await expect(
      withTenant(T1, { type: "system" }, async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.auth_contact_id', ${contact1.id}, true)`;
        return tx.contact.update({ where: { id: contact1.id }, data: { tenantId: T2 } });
      }),
    ).rejects.toThrow(/CONTACT_AUTH_IMMUTABLE/);
  });

  it("cannot move a contact to another client, nor promote its profile or status", async () => {
    for (const data of [
      { clientId: client2 },
      { portalProfile: "CONTACT_PRIMARY" as const },
      { portalStatus: "SUSPENDED" as const },
    ]) {
      await expect(
        withTenant(T1, { type: "system" }, async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.auth_contact_id', ${contact1.id}, true)`;
          return tx.contact.update({ where: { id: contact1.id }, data });
        }),
      ).rejects.toThrow(/CONTACT_AUTH_IMMUTABLE/);
    }
  });

  it("leaves the MEMBER path free to change all of those", async () => {
    // The trigger returns early when the auth GUC is unset, so the
    // tenant path (client:manage_contacts) is untouched. Without this,
    // the guard above would have been a bug rather than a control.
    const updated = await withTenant(T1, { type: "system" }, (tx) =>
      tx.contact.update({
        where: { id: contact1.id },
        data: { portalStatus: "SUSPENDED", portalProfile: "CONTACT_PRIMARY" },
      }),
    );
    expect(updated.portalStatus).toBe("SUSPENDED");
    await withTenant(T1, { type: "system" }, (tx) =>
      tx.contact.update({ where: { id: contact1.id }, data: { portalStatus: "ACTIVE" } }),
    );
  });
});

describe("portalAuthClient: the delegate the portal instance is built on", () => {
  it("finds a contact by email and returns the tenancy columns", async () => {
    const found = (await portalAuthClient.contact.findFirst({
      where: { email: { equals: contact1.email } },
    })) as { id: string; tenantId: string; clientId: string } | null;
    expect(found?.id).toBe(contact1.id);
    expect(found?.tenantId).toBe(T1);
    expect(found?.clientId).toBe(client1);
  });

  it("handles the bare-value where shape the adapter emits for updates", async () => {
    const found = (await portalAuthClient.contact.findFirst({
      where: { id: contact2.id },
    })) as { id: string } | null;
    expect(found?.id).toBe(contact2.id);
  });

  it("fails CLOSED on a where it cannot key — no rows, never all rows", async () => {
    const found = await portalAuthClient.contact.findFirst({ where: { name: "Casey Renamed" } });
    expect(found).toBeNull();
  });

  it("refuses to create a contact", async () => {
    await expect(portalAuthClient.contact.create()).rejects.toThrow(PortalIdentityRefused);
  });

  it("refuses to delete a contact", async () => {
    await expect(portalAuthClient.contact.delete()).rejects.toThrow(PortalIdentityRefused);
    await expect(portalAuthClient.contact.deleteMany()).rejects.toThrow(PortalIdentityRefused);
  });

  it("intersects an updateMany's where with the admitted id", async () => {
    // The brokered write runs with the whole tenant in reach, so a
    // `where` that matched more than the row the lookup admitted would
    // otherwise rewrite every contact of that tenant that matched it.
    // Here the OR branch matches BOTH contacts of tenant 1; only the
    // named one may change.
    const db = getPlatformClient();
    const other = await db.contact.create({
      data: {
        tenantId: T1,
        clientId: client1,
        name: "Bystander",
        email: `e2e-bystander-${run}@test.invalid`,
      },
    });

    const result = (await portalAuthClient.contact.updateMany({
      where: { OR: [{ id: contact1.id }, { tenantId: T1 }] },
      data: { name: "Swept" },
    })) as { count: number };

    expect(result.count).toBe(1);
    expect((await db.contact.findUnique({ where: { id: other.id } }))?.name).toBe("Bystander");
    expect((await db.contact.findUnique({ where: { id: contact1.id } }))?.name).toBe("Swept");

    await db.contact.delete({ where: { id: other.id } });
  });

  it("refuses an update that does not name the contact by id", async () => {
    await expect(
      portalAuthClient.contact.update({
        where: { email: contact1.email },
        data: { name: "Nope" },
      }),
    ).rejects.toThrow(PortalIdentityRefused);
  });

  it("refuses a write naming a column outside the allow-list, before touching the database", async () => {
    await expect(
      portalAuthClient.contact.update({
        where: { id: contact1.id },
        data: { portalStatus: "ACTIVE" },
      }),
    ).rejects.toThrow(PortalIdentityRefused);
  });
});

describe("the three AUTH-class tables", () => {
  it("are readable by the auth path and invisible to a contact principal — ALL THREE", async () => {
    // The first version probed `contact_session` only. The two it
    // skipped are the sensitive ones — `contact_account` holds the
    // scrypt password hashes and `contact_verification` holds live
    // reset and invite tokens — and "the loop in the migration builds
    // them identically" is an argument, not a measurement (review).
    const db = getPlatformClient();
    const token = `e2e-token-${run}`;
    await db.contactSession.create({
      data: { contactId: contact1.id, token, expiresAt: new Date(Date.now() + 60_000) },
    });
    await db.contactAccount.create({
      data: { contactId: contact1.id, accountId: contact1.id, providerId: "credential", password: "hash" },
    });
    await db.contactVerification.create({
      data: {
        identifier: `reset-password:${token}`,
        value: contact1.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    // No tenant context at all — the auth plane's normal condition.
    expect(await runtimeClient.contactSession.count({ where: { token } })).toBe(1);
    expect(await runtimeClient.contactAccount.count({ where: { contactId: contact1.id } })).toBe(1);
    expect(
      await runtimeClient.contactVerification.count({ where: { identifier: `reset-password:${token}` } }),
    ).toBe(1);

    // portal_deny: a contact-principal transaction sees no session,
    // credential or token rows — its OWN included.
    const seen = await withTenant(
      T1,
      { type: "contact", id: contact1.id, clientId: client1 },
      async (tx) => ({
        sessions: await tx.contactSession.count({ where: { token } }),
        accounts: await tx.contactAccount.count({ where: { contactId: contact1.id } }),
        tokens: await tx.contactVerification.count({
          where: { identifier: `reset-password:${token}` },
        }),
      }),
    );
    expect(seen).toEqual({ sessions: 0, accounts: 0, tokens: 0 });

    await db.contactAccount.deleteMany({ where: { contactId: contact1.id } });
    await db.contactVerification.deleteMany({ where: { identifier: `reset-password:${token}` } });
  });

  it("a credential cannot be created for a contact nobody invited — the HIGH finding", async () => {
    // Better Auth's /reset-password CREATES a credential when none
    // exists (password.mjs), and merely configuring `sendResetPassword`
    // mounts the unauthenticated /request-password-reset that issues
    // the token. So the three refusals guarding `contact` INSERT did
    // not guard `contact_account`, and a contact a member had merely
    // RECORDED could have set themselves a portal password — bypassing
    // the invitation, its token, its expiry and its audit trail, and
    // lying dormant until somebody activated them.
    const db = getPlatformClient();
    const never = await db.contact.create({
      data: {
        tenantId: T1,
        clientId: client1,
        name: "Never Invited",
        email: `e2e-never-${run}@test.invalid`,
        // portalStatus defaults to NO_ACCESS — the whole point.
      },
    });

    await expect(
      db.contactAccount.create({
        data: { contactId: never.id, accountId: never.id, providerId: "credential", password: "x" },
      }),
    ).rejects.toThrow(/CONTACT_ACCOUNT_REQUIRES_INVITE/);
    expect(await db.contactAccount.count({ where: { contactId: never.id } })).toBe(0);

    // SUSPENDED and REVOKED are refused for the same reason: a
    // credential may exist only for someone deliberately invited.
    for (const portalStatus of ["SUSPENDED", "REVOKED"] as const) {
      await db.contact.update({ where: { id: never.id }, data: { portalStatus } });
      await expect(
        db.contactAccount.create({
          data: { contactId: never.id, accountId: never.id, providerId: "credential", password: "x" },
        }),
      ).rejects.toThrow(/CONTACT_ACCOUNT_REQUIRES_INVITE/);
    }

    // INVITED and ACTIVE are allowed — invite acceptance runs in the
    // first, a re-issued credential in the second. Blocking these would
    // have made the guard a bug rather than a control.
    for (const portalStatus of ["INVITED", "ACTIVE"] as const) {
      await db.contact.update({ where: { id: never.id }, data: { portalStatus } });
      const created = await db.contactAccount.create({
        data: {
          contactId: never.id,
          accountId: `${never.id}-${portalStatus}`,
          providerId: "credential",
          password: "x",
        },
      });
      expect(created.contactId).toBe(never.id);
    }

    await db.contactAccount.deleteMany({ where: { contactId: never.id } });
    await db.contact.delete({ where: { id: never.id } });
  });

  it("cascade with the contact record — revocation takes the sessions with it", async () => {
    const db = getPlatformClient();
    const doomed = await db.contact.create({
      data: {
        tenantId: T1,
        clientId: client1,
        name: "Doomed",
        email: `e2e-doomed-${run}@test.invalid`,
        // ACTIVE because this contact gets a CREDENTIAL below, and
        // `contact_account_requires_invite` refuses one for anybody who
        // was never invited. A revocation test needs a contact who had
        // something to revoke.
        portalStatus: "ACTIVE",
      },
    });
    await db.contactSession.create({
      data: { contactId: doomed.id, token: `e2e-doomed-${run}`, expiresAt: new Date(Date.now() + 60_000) },
    });
    await db.contactAccount.create({
      data: { contactId: doomed.id, accountId: doomed.id, providerId: "credential", password: "x" },
    });

    await db.contact.delete({ where: { id: doomed.id } });

    expect(await db.contactSession.count({ where: { contactId: doomed.id } })).toBe(0);
    expect(await db.contactAccount.count({ where: { contactId: doomed.id } })).toBe(0);
  });
});
