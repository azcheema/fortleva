import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError, type DenialReason } from "@/authz/errors";
/* eslint-disable no-restricted-imports -- dbtest setup/cleanup uses the raw layer */
import { getPlatformClient } from "@/db/client";
import { withTenant } from "@/db";

import { authorizePortal, withPortalRead, type PortalPrincipal } from "./authorize";
import { PORTAL_MODULES } from "./capabilities";
import { resolvePortalModuleGates } from "./module-gates";
import type { PortalModuleGates } from "./policy";

/**
 * THE PORTAL DENY MATRIX (work-management plan §3, "portal deny-matrix:
 * cross-client, cross-tenant, INTERNAL rows, audience rejection,
 * self-signup") — against the real database, as the real `app_runtime`
 * role, under the real contact principal.
 *
 * The audience half and the status half are matrixed exhaustively in
 * `policy.test.ts`, which needs no connection. What can only be proven
 * here is everything that depends on a POLICY rather than on a value:
 * that a project of another client, of another tenant, or of a
 * portal-disabled project is NOT_FOUND because the row does not come
 * back; that a session whose GUCs disagree with the contact row dies at
 * the first read; and that the module gates — which a contact principal
 * structurally cannot read — resolve correctly through their own seam.
 *
 * The self-signup half lives next door in `census.dbtest.ts`, with the
 * rest of the contact-writable census.
 */

const run = randomUUID().slice(0, 8);
const T = randomUUID(); // the tenant under test
const T2 = randomUUID(); // a neighbour
const acme = randomUUID();
const beta = randomUUID(); // another client of T
const gamma = randomUUID(); // a client of T2
const pAcmeOn = randomUUID();
const pAcmeOff = randomUUID(); // portalEnabled = false
const pBetaOn = randomUUID();
const pGammaOn = randomUUID();

const ids = {
  primary: randomUUID(),
  collaborator: randomUUID(),
  suspended: randomUUID(),
  neverInvited: randomUUID(),
  betaContact: randomUUID(),
  gammaContact: randomUUID(),
};

const invitedAt = new Date("2026-09-01T09:00:00Z");
let okGates: PortalModuleGates;

const principal = (
  contactId: string,
  overrides: Partial<PortalPrincipal> = {},
): PortalPrincipal => ({
  contactId,
  tenantId: T,
  clientId: acme,
  gates: okGates,
  ...overrides,
});

/** The refusal, or null when the call was allowed. */
const refusalOf = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return null;
  } catch (e) {
    if (e instanceof AuthzError) return { reason: e.reason as DenialReason, detail: e.detail };
    throw e;
  }
};

beforeAll(async () => {
  const db = getPlatformClient();
  for (const [id, slug] of [
    [T, `pauthz-${run}`],
    [T2, `pauthz2-${run}`],
  ] as const) {
    await db.tenant.create({ data: { id, name: slug, slug, entitlements: {} } });
  }
  await db.client.createMany({
    data: [
      { id: acme, tenantId: T, name: "Acme" },
      { id: beta, tenantId: T, name: "Beta" },
      { id: gamma, tenantId: T2, name: "Gamma" },
    ],
  });
  await db.project.createMany({
    data: [
      { id: pAcmeOn, tenantId: T, clientId: acme, key: "ACMEON", name: "Acme (portal on)", portalEnabled: true },
      { id: pAcmeOff, tenantId: T, clientId: acme, key: "ACMEOFF", name: "Acme (portal off)" },
      { id: pBetaOn, tenantId: T, clientId: beta, key: "BETAON", name: "Beta", portalEnabled: true },
      { id: pGammaOn, tenantId: T2, clientId: gamma, key: "GAMMA", name: "Gamma", portalEnabled: true },
    ],
  });
  // Two milestones on the portal-enabled Acme project, so `withPortalRead`
  // can be shown to be running under the contact principal rather than
  // merely inside the right tenant.
  await db.milestone.createMany({
    data: [
      { tenantId: T, clientId: acme, projectId: pAcmeOn, name: "Shared", rank: "a0", visibility: "CLIENT_VISIBLE" },
      { tenantId: T, clientId: acme, projectId: pAcmeOn, name: "Internal QA", rank: "a1", visibility: "INTERNAL" },
    ],
  });
  await db.contact.createMany({
    data: [
      { id: ids.primary, tenantId: T, clientId: acme, name: "Primary", email: `primary-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt },
      { id: ids.collaborator, tenantId: T, clientId: acme, name: "Collaborator", email: `collab-${run}@test.invalid`, portalProfile: "CONTACT_COLLABORATOR", portalStatus: "ACTIVE", invitedAt },
      { id: ids.suspended, tenantId: T, clientId: acme, name: "Suspended", email: `susp-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "SUSPENDED", invitedAt },
      { id: ids.neverInvited, tenantId: T, clientId: acme, name: "Never invited", email: `noinv-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE" },
      { id: ids.betaContact, tenantId: T, clientId: beta, name: "Beta contact", email: `beta-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt },
      { id: ids.gammaContact, tenantId: T2, clientId: gamma, name: "Gamma contact", email: `gamma-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt },
    ],
  });
  okGates = await resolvePortalModuleGates(T);
});

afterAll(async () => {
  const db = getPlatformClient();
  for (const tenantId of [T, T2]) {
    await db.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${tenantId}`;
    await db.milestone.deleteMany({ where: { tenantId } });
    await db.contact.deleteMany({ where: { tenantId } });
    await db.project.deleteMany({ where: { tenantId } });
    await db.client.deleteMany({ where: { tenantId } });
    await db.tenantPreference.deleteMany({ where: { tenantId } });
    await db.tenant.delete({ where: { id: tenantId } });
  }
});

describe("module gates resolve through their own seam", () => {
  it("returns an enum map over exactly the portal modules — and no row data", () => {
    // The shape IS the safety argument for reading this under the system
    // principal (module-gates.ts): there is no id, no name and no string
    // from the database anywhere in the result, so a projection cannot
    // be smuggled out through it.
    expect(Object.keys(okGates).sort()).toEqual([...PORTAL_MODULES].sort());
    for (const value of Object.values(okGates)) {
      expect(["ok", "FEATURE_DISABLED", "NOT_ENTITLED", "DISABLED_BY_TENANT"]).toContain(value);
    }
    expect(okGates).toEqual(
      Object.fromEntries(PORTAL_MODULES.map((m) => [m, "ok"])),
    );
  });

  it("sees a tenant preference and an entitlement that a contact principal CANNOT see", async () => {
    // This is the finding this seam exists for. `tenant_preference` and
    // `tenant` both carry portal_deny, so the same two reads under the
    // contact principal return nothing — and "nothing" means ENABLED to
    // every reader in the product. Measured here in both directions so
    // the claim is not left as a comment.
    const db = getPlatformClient();
    await db.tenantPreference.create({
      data: { tenantId: T, key: "module.work.enabled", value: false },
    });
    await db.tenant.update({
      where: { id: T },
      data: { entitlements: { schemaVersion: 2, modules: { vault: false } } },
    });
    try {
      const gates = await resolvePortalModuleGates(T);
      expect(gates.work).toBe("DISABLED_BY_TENANT");
      expect(gates.vault).toBe("NOT_ENTITLED");
      expect(gates.portal).toBe("ok");

      // …and the contact principal's own view of the same two rows:
      const blind = await withTenant(
        T,
        { type: "contact", id: ids.primary, clientId: acme },
        async (tx) => ({
          preferences: await tx.tenantPreference.count({ where: { tenantId: T } }),
          tenants: await tx.tenant.count({ where: { id: T } }),
          flags: await tx.featureFlag.count({}),
        }),
      );
      expect(blind).toEqual({ preferences: 0, tenants: 0, flags: 0 });
    } finally {
      await db.tenantPreference.deleteMany({ where: { tenantId: T } });
      await db.tenant.update({ where: { id: T }, data: { entitlements: {} } });
    }
  });

  it("denies everything when the tenant row does not come back", async () => {
    // The fail-open this file's own argument would otherwise have walked
    // into: `parseEntitlements(undefined)` is the everything-on default,
    // so a null tenant row resolved every gate to "ok" — "absent means
    // enabled" reproduced in the fallback of the function that exists to
    // refuse exactly that (code review, 2026-09-20).
    const gates = await resolvePortalModuleGates(randomUUID());
    expect(gates).toEqual(Object.fromEntries(PORTAL_MODULES.map((m) => [m, "NOT_ENTITLED"])));
  });

  it("honours a per-tenant kill-switch override without touching the global default", async () => {
    const db = getPlatformClient();
    const key = "module.portal";
    const existing = await db.featureFlag.findFirst({ where: { key } });
    const before = (existing?.tenantOverrides ?? {}) as Record<string, boolean>;
    if (existing) {
      await db.featureFlag.update({
        where: { id: existing.id },
        data: { tenantOverrides: { ...before, [T]: false } },
      });
    } else {
      await db.featureFlag.create({
        data: { key, description: `deny-matrix ${run}`, defaultOn: true, tenantOverrides: { [T]: false } },
      });
    }
    try {
      expect((await resolvePortalModuleGates(T)).portal).toBe("FEATURE_DISABLED");
      // The neighbour is untouched: the override is per tenant.
      expect((await resolvePortalModuleGates(T2)).portal).toBe("ok");
    } finally {
      if (existing) {
        await db.featureFlag.update({ where: { id: existing.id }, data: { tenantOverrides: before } });
      } else {
        await db.featureFlag.deleteMany({ where: { key } });
      }
    }
  });
});

describe("authorizePortal — the resource half", () => {
  const authorize = (
    p: PortalPrincipal,
    capability: Parameters<typeof authorizePortal>[2],
    ref?: Parameters<typeof authorizePortal>[3],
  ) => withPortalRead(p, (tx) => authorizePortal(tx, p, capability, ref));

  it("allows a primary contact on its own portal-enabled project", async () => {
    expect(
      await refusalOf(() =>
        authorize(principal(ids.primary), "portal.project.view", { kind: "project", projectId: pAcmeOn }),
      ),
    ).toBeNull();
  });

  it("allows the contact's own client as a resource, and no other", async () => {
    expect(
      await refusalOf(() =>
        authorize(principal(ids.primary), "portal.project.view", { kind: "client", clientId: acme }),
      ),
    ).toBeNull();
    expect(
      await refusalOf(() =>
        authorize(principal(ids.primary), "portal.project.view", { kind: "client", clientId: beta }),
      ),
    ).toEqual({ reason: "NOT_FOUND", detail: "client" });
  });

  it("404s a project of ANOTHER CLIENT in the same tenant", async () => {
    expect(
      await refusalOf(() =>
        authorize(principal(ids.primary), "portal.project.view", { kind: "project", projectId: pBetaOn }),
      ),
    ).toEqual({ reason: "NOT_FOUND", detail: "project" });
  });

  it("404s a project of ANOTHER TENANT", async () => {
    expect(
      await refusalOf(() =>
        authorize(principal(ids.primary), "portal.project.view", { kind: "project", projectId: pGammaOn }),
      ),
    ).toEqual({ reason: "NOT_FOUND", detail: "project" });
  });

  it("404s its OWN client's project while the portal switch is off", async () => {
    // The per-project master switch, reached through the same NOT_FOUND
    // as a stranger's project: a contact must not be able to tell "not
    // shared with you" from "does not exist".
    expect(
      await refusalOf(() =>
        authorize(principal(ids.primary), "portal.project.view", { kind: "project", projectId: pAcmeOff }),
      ),
    ).toEqual({ reason: "NOT_FOUND", detail: "project" });
  });

  it("404s a project id that does not exist at all — indistinguishably", async () => {
    expect(
      await refusalOf(() =>
        authorize(principal(ids.primary), "portal.project.view", {
          kind: "project",
          projectId: randomUUID(),
        }),
      ),
    ).toEqual({ reason: "NOT_FOUND", detail: "project" });
  });
});

describe("authorizePortal — the principal half, re-read from the row", () => {
  const authorize = (p: PortalPrincipal, capability: Parameters<typeof authorizePortal>[2]) =>
    withPortalRead(p, (tx) => authorizePortal(tx, p, capability));

  it("refuses a SUSPENDED contact even with a live principal", async () => {
    expect(await refusalOf(() => authorize(principal(ids.suspended), "portal.project.view"))).toEqual({
      reason: "FORBIDDEN",
      detail: "contact is not ACTIVE",
    });
  });

  it("refuses an ACTIVE contact with no invitation stamp", async () => {
    expect(
      await refusalOf(() => authorize(principal(ids.neverInvited), "portal.project.view")),
    ).toEqual({ reason: "FORBIDDEN", detail: "contact was never invited" });
  });

  it("follows a status change made by staff mid-session", async () => {
    // The reason the row is re-read instead of trusted from the session:
    // a member who suspends a contact expects that to bite now.
    const db = getPlatformClient();
    expect(await refusalOf(() => authorize(principal(ids.primary), "portal.project.view"))).toBeNull();
    await db.contact.update({ where: { id: ids.primary }, data: { portalStatus: "REVOKED" } });
    try {
      expect(await refusalOf(() => authorize(principal(ids.primary), "portal.project.view"))).toEqual({
        reason: "FORBIDDEN",
        detail: "contact is not ACTIVE",
      });
    } finally {
      await db.contact.update({ where: { id: ids.primary }, data: { portalStatus: "ACTIVE" } });
    }
  });

  it("refuses the audience it is not in", async () => {
    expect(
      await refusalOf(() => authorize(principal(ids.collaborator), "portal.hours.view")),
    ).toEqual({ reason: "FORBIDDEN", detail: "capability not in profile" });
    expect(
      await refusalOf(() => authorize(principal(ids.collaborator), "portal.invoice.pay")),
    ).toEqual({ reason: "FORBIDDEN", detail: "capability not in profile" });
    // …and holds the ones it is in.
    expect(
      await refusalOf(() => authorize(principal(ids.collaborator), "portal.request.create")),
    ).toBeNull();
  });

  it("follows a profile change made by staff mid-session", async () => {
    const db = getPlatformClient();
    await db.contact.update({
      where: { id: ids.primary },
      data: { portalProfile: "CONTACT_COLLABORATOR" },
    });
    try {
      expect(await refusalOf(() => authorize(principal(ids.primary), "portal.hours.view"))).toEqual({
        reason: "FORBIDDEN",
        detail: "capability not in profile",
      });
    } finally {
      await db.contact.update({
        where: { id: ids.primary },
        data: { portalProfile: "CONTACT_PRIMARY" },
      });
    }
  });

  it("dies at the first read when the principal and the row disagree", async () => {
    // A contact of Beta carried under Acme's client GUC. `portal_gate`
    // on `contact` is `client_id = app.client_id`, so the row simply is
    // not there — and the failure is the same NOT_FOUND a stranger gets.
    expect(
      await refusalOf(() =>
        authorize(principal(ids.betaContact), "portal.project.view"),
      ),
    ).toEqual({ reason: "NOT_FOUND", detail: "contact not reachable under this principal" });

    // A contact of another TENANT, carried with its own client id.
    expect(
      await refusalOf(() =>
        authorize(principal(ids.gammaContact, { clientId: gamma }), "portal.project.view"),
      ),
    ).toEqual({ reason: "NOT_FOUND", detail: "contact not reachable under this principal" });

    // A contact id that names nothing.
    expect(
      await refusalOf(() => authorize(principal(randomUUID()), "portal.project.view")),
    ).toEqual({ reason: "NOT_FOUND", detail: "contact not reachable under this principal" });
  });

  it("refuses a capability whose module the tenant has switched off", async () => {
    const db = getPlatformClient();
    await db.tenantPreference.create({
      data: { tenantId: T, key: "module.portal.enabled", value: false },
    });
    try {
      const p = principal(ids.primary, { gates: await resolvePortalModuleGates(T) });
      expect(
        await refusalOf(() => withPortalRead(p, (tx) => authorizePortal(tx, p, "portal.project.view"))),
      ).toEqual({ reason: "DISABLED_BY_TENANT", detail: "portal" });
    } finally {
      await db.tenantPreference.deleteMany({ where: { tenantId: T } });
    }
  });

  it("refuses when the gates were never resolved, rather than passing them", async () => {
    const p = { ...principal(ids.primary), gates: undefined as unknown as PortalModuleGates };
    expect(
      await refusalOf(() => withPortalRead(p, (tx) => authorizePortal(tx, p, "portal.project.view"))),
    ).toEqual({ reason: "FORBIDDEN", detail: "module gates unresolved: portal" });
  });
});

describe("authorizePortal refuses a transaction that is not this contact's", () => {
  it("refuses a SYSTEM-principal transaction, which would pass every gate", async () => {
    // The misuse is plausible rather than exotic: brokered writes run as
    // `system` by design, so that shape is always nearby. Under it the
    // contact row, the project row and the visibility term all come back
    // regardless of who the contact is, and `authorizePortal` would be
    // checking a profile against rows nobody checked the ownership of.
    const p = principal(ids.primary);
    expect(
      await refusalOf(() =>
        withTenant(T, { type: "system" }, (tx) =>
          authorizePortal(tx, p, "portal.project.view", { kind: "project", projectId: pAcmeOn }),
        ),
      ),
    ).toEqual({ reason: "FORBIDDEN", detail: "authorizePortal outside this contact's transaction" });
  });

  it("refuses ANOTHER contact's transaction", async () => {
    const p = principal(ids.primary);
    expect(
      await refusalOf(() =>
        withTenant(T, { type: "contact", id: ids.collaborator, clientId: acme }, (tx) =>
          authorizePortal(tx, p, "portal.project.view"),
        ),
      ),
    ).toEqual({ reason: "FORBIDDEN", detail: "authorizePortal outside this contact's transaction" });
  });

  it("refuses a SYSTEM tx captured from an enclosing scope, which the ambient check alone would have passed", async () => {
    // The shape both reviews named: the ambient AsyncLocalStorage says
    // "contact" because we ARE inside withPortalRead, while the handle
    // passed as `tx` belongs to a system transaction opened outside it.
    // Every read in authorizePortal — and in whatever projection follows
    // — would run as `system`, which satisfies every portal_gate. Only
    // the stamp on the handle can see this.
    const p = principal(ids.primary);
    expect(
      await refusalOf(() =>
        withTenant(T, { type: "system" }, (systemTx) =>
          withPortalRead(p, () => authorizePortal(systemTx, p, "portal.project.view")),
        ),
      ),
    ).toEqual({ reason: "FORBIDDEN", detail: "authorizePortal outside this contact's transaction" });
  });

  it("refuses a transaction in the wrong TENANT", async () => {
    const p = principal(ids.primary, { tenantId: T2 });
    expect(
      await refusalOf(() =>
        withTenant(T, { type: "contact", id: ids.primary, clientId: acme }, (tx) =>
          authorizePortal(tx, p, "portal.project.view"),
        ),
      ),
    ).toEqual({ reason: "FORBIDDEN", detail: "authorizePortal outside this contact's transaction" });
  });
});

describe("withPortalRead runs under the contact principal", () => {
  it("sees CLIENT_VISIBLE rows of its own client and no INTERNAL fact", async () => {
    // Not a duplicate of portal-gate.dbtest.ts, which proves the policy:
    // this proves the SEAM hands the policy the right principal. A
    // system-principal transaction here would return both rows and every
    // test above would still pass.
    const names = await withPortalRead(principal(ids.primary), (tx) =>
      tx.milestone.findMany({ select: { name: true }, orderBy: { rank: "asc" } }),
    );
    expect(names.map((m) => m.name)).toEqual(["Shared"]);
  });
});
