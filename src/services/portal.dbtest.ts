import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { readPortalCompany } from "@/clients/portal";
import { setupTenant } from "@/members/dbtest-fixture";
import { resolvePortalModuleGates, type PortalPrincipal } from "@/portal";

import { listPortalServices, type PortalService } from "./portal";
import { createService, setServiceStatus } from "./service";

/**
 * `/portal/company`'S TWO READS AGAINST THE REAL SCHEMA (Phase 3, the
 * portal files-and-services slice): the agreements a client holds, as
 * the client reads them, and the client's own company record.
 *
 * THE CENTRAL ASSERTION IS THE SENTINEL WALK: the staff-only notes on a
 * SHARED agreement (the one string on a row the client reads that they
 * must not), the staff-only notes on the client's own record, an
 * INTERNAL agreement, agreements on a switched-off project, an archived
 * project and another client, and the client's status in the agency's
 * pipeline — each planted as a string that appears nowhere else, and
 * the serialised output of both reads searched for each.
 *
 * WHAT ONLY A DATABASE CAN SAY: that a collaborator is refused the
 * agreements outright (money — `portal.service.view` is PRIMARY only)
 * while reading the record, that another client's contact reads THEIR
 * company and THEIR agreements and nothing of this one's, and that the
 * client-root gate on `client` returns the contact's own row alone.
 *
 * Tenant slug prefix `pser-` is registered in `DBTEST_PREFIXES`
 * (e2e/fixtures/seed-cli.ts) so `sweep-dbtests` collects orphans.
 */

const run = randomUUID().slice(0, 8);

let f: Awaited<ReturnType<typeof setupTenant>>;
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;
let acme: string;
let beta: string;
let pOn: string;
let pOff: string;
let pArchived: string;
let pBeta: string;
let carol: string;
let dan: string;
let bo: string;
let sue: string;
let endedId: string;

/** Strings a contact IS meant to read. */
const SHOWN = {
  retainer: `Maintenance ${run}`,
  retainerDescription: `Updates, security patches and support ${run}`,
  projectService: `Migration ${run}`,
  bare: `Advice ${run}`,
  ended: `Old hosting ${run}`,
  betaService: `Beta retainer ${run}`,
  orgNr: `556${run.slice(0, 3)}-${run.slice(3, 7)}`,
  city: `Stockholm ${run}`,
} as const;

/** Strings that exist nowhere but where a contact must never read. */
const S = {
  notesOnShared: `SENTINELNOTES-${run}`,
  notesOnClient: `SENTINELCLIENTNOTES-${run}`,
  internal: `SENTINELINTERNAL-${run}`,
  off: `SENTINELOFF-${run}`,
  archived: `SENTINELARCHIVED-${run}`,
  betaNotes: `SENTINELBETANOTES-${run}`,
} as const;

const RENEWS = new Date("2027-01-01T00:00:00Z");
const ENDS = new Date("2026-03-31T00:00:00Z");

const ctxOf = (seat: "owner") => ({ tenantId: f.tenantId, actor: f.seats[seat].actor });

const principal = (contactId: string, clientId = acme): PortalPrincipal => ({
  contactId,
  tenantId: f.tenantId,
  clientId,
  gates,
});

const authzReason = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    if (e instanceof AuthzError) return e.reason;
    throw e;
  }
};

const expectNoSentinel = (value: unknown) => {
  const json = JSON.stringify(value);
  for (const [name, sentinel] of Object.entries(S)) {
    expect(json, `sentinel ${name} leaked`).not.toContain(sentinel);
  }
};

beforeAll(async () => {
  f = await setupTenant("pser");
  gates = await resolvePortalModuleGates(f.tenantId);
  acme = randomUUID();
  beta = randomUUID();
  pOn = randomUUID();
  pOff = randomUUID();
  pArchived = randomUUID();
  pBeta = randomUUID();
  carol = randomUUID();
  dan = randomUUID();
  bo = randomUUID();
  sue = randomUUID();
  const up = run.slice(0, 3).toUpperCase();

  await f.platform.client.createMany({
    data: [
      {
        id: acme,
        tenantId: f.tenantId,
        name: `Acme ${run}`,
        orgNr: SHOWN.orgNr,
        vatNumber: `SE${run}01`,
        addressLine1: "Storgatan 1",
        postalCode: "111 22",
        city: SHOWN.city,
        countryCode: "SE",
        billingEmail: `billing-${run}@test.invalid`,
        internalNotes: S.notesOnClient,
      },
      { id: beta, tenantId: f.tenantId, name: `Beta ${run}`, internalNotes: S.betaNotes },
    ],
  });
  await f.platform.project.createMany({
    data: [
      { id: pOn, tenantId: f.tenantId, clientId: acme, key: `PSR${up}`, name: `Site ${run}`, portalEnabled: true },
      { id: pOff, tenantId: f.tenantId, clientId: acme, key: `PSO${up}`, name: `Off ${run}`, portalEnabled: false },
      {
        id: pArchived,
        tenantId: f.tenantId,
        clientId: acme,
        key: `PSA${up}`,
        name: `Archived ${run}`,
        portalEnabled: true,
        status: "ARCHIVED",
        archivedAt: new Date("2026-01-01T00:00:00Z"),
      },
      { id: pBeta, tenantId: f.tenantId, clientId: beta, key: `PSB${up}`, name: `Beta site ${run}`, portalEnabled: true },
    ],
  });
  const invitedAt = new Date("2026-09-01T09:00:00Z");
  await f.platform.contact.createMany({
    data: [
      { id: carol, tenantId: f.tenantId, clientId: acme, name: "Carol", email: `pser-carol-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt, emailVerified: true },
      { id: dan, tenantId: f.tenantId, clientId: acme, name: "Dan", email: `pser-dan-${run}@test.invalid`, portalProfile: "CONTACT_COLLABORATOR", portalStatus: "ACTIVE", invitedAt, emailVerified: true },
      { id: bo, tenantId: f.tenantId, clientId: beta, name: "Bo", email: `pser-bo-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt, emailVerified: true },
      { id: sue, tenantId: f.tenantId, clientId: acme, name: "Sue", email: `pser-sue-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "SUSPENDED", invitedAt, emailVerified: true },
    ],
  });

  // ── The agreements, through the real service ───────────────────────
  const owner = ctxOf("owner");
  await createService(owner, {
    clientId: acme,
    name: SHOWN.retainer,
    description: SHOWN.retainerDescription,
    kind: "RECURRING",
    billingInterval: "MONTHLY",
    priceExVat: "7500.00",
    currency: "SEK",
    renewsAt: RENEWS,
    internalNotes: S.notesOnShared,
    visibility: "CLIENT_VISIBLE",
  });
  await createService(owner, {
    clientId: acme,
    projectId: pOn,
    name: SHOWN.projectService,
    kind: "ONE_TIME",
    priceExVat: "42000.00",
    currency: "SEK",
    visibility: "CLIENT_VISIBLE",
  });
  // An amount with no currency: not a fact the portal can state.
  await createService(owner, {
    clientId: acme,
    name: SHOWN.bare,
    kind: "ONE_TIME",
    priceExVat: "100.00",
    visibility: "CLIENT_VISIBLE",
  });
  endedId = (
    await createService(owner, {
      clientId: acme,
      name: SHOWN.ended,
      kind: "RECURRING",
      billingInterval: "YEARLY",
      priceExVat: "1200.00",
      currency: "SEK",
      endsAt: ENDS,
      visibility: "CLIENT_VISIBLE",
    })
  ).id;
  await setServiceStatus(owner, endedId, "ENDED");
  // ── Sentinels ──────────────────────────────────────────────────────
  await createService(owner, { clientId: acme, name: S.internal, kind: "ONE_TIME", priceExVat: "9.00", currency: "SEK" });
  await createService(owner, { clientId: acme, projectId: pOff, name: S.off, kind: "ONE_TIME", visibility: "CLIENT_VISIBLE" });
  // `createService` refuses nothing about an archived project, so it
  // goes through the service too — planted only to be NOT read.
  await createService(owner, { clientId: acme, projectId: pArchived, name: S.archived, kind: "ONE_TIME", visibility: "CLIENT_VISIBLE" });
  await createService(owner, { clientId: beta, name: SHOWN.betaService, kind: "RECURRING", billingInterval: "MONTHLY", priceExVat: "500.00", currency: "EUR", visibility: "CLIENT_VISIBLE", internalNotes: S.betaNotes });
}, 120_000);

afterAll(async () => {
  if (!f) return;
  await f.platform.service.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.contact.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.project.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 60_000);

describe("the agreements", () => {
  it("are every shared agreement of the client, running first, with the fee only where it has a currency", async () => {
    const out = await listPortalServices(principal(carol));
    expect(out.map((s) => s.name)).toEqual([SHOWN.bare, SHOWN.retainer, SHOWN.projectService, SHOWN.ended]);
    const retainer = out.find((s) => s.name === SHOWN.retainer)!;
    expect(retainer).toMatchObject({
      description: SHOWN.retainerDescription,
      kind: "RECURRING",
      billingInterval: "MONTHLY",
      price: { amount: "7500", currency: "SEK" },
      status: "ACTIVE",
      renewsAt: RENEWS,
      endsAt: null,
      project: null,
    });
    expect(out.find((s) => s.name === SHOWN.projectService)).toMatchObject({
      kind: "ONE_TIME",
      billingInterval: null,
      price: { amount: "42000", currency: "SEK" },
      project: { key: `PSR${run.slice(0, 3).toUpperCase()}`, name: `Site ${run}` },
    });
    // An amount without a currency is no fee at all.
    expect(out.find((s) => s.name === SHOWN.bare)!.price).toBeNull();
    // The ended one is last, and says when it ended.
    expect(out.at(-1)).toMatchObject({ id: endedId, status: "ENDED", endsAt: ENDS });
  });

  it("carries exactly its keys and no staff-only fact — the sentinel walk, notes included", async () => {
    const out = await listPortalServices(principal(carol));
    expectNoSentinel(out);
    const keysOf = (s: PortalService) => Object.keys(s).sort();
    expect(keysOf(out[0]!)).toEqual([
      "billingInterval",
      "description",
      "endsAt",
      "id",
      "kind",
      "name",
      "price",
      "project",
      "renewsAt",
      "status",
    ]);
  });

  it("is money, so a collaborator is refused outright, as is a suspended contact", async () => {
    expect(await authzReason(listPortalServices(principal(dan)))).toBe("FORBIDDEN");
    expect(await authzReason(listPortalServices(principal(sue)))).toBe("FORBIDDEN");
  });

  it("another client's contact reads their own agreements and none of this client's", async () => {
    const bos = await listPortalServices(principal(bo, beta));
    expect(bos.map((s) => s.name)).toEqual([SHOWN.betaService]);
    expect(bos[0]!.price).toEqual({ amount: "500", currency: "EUR" });
    const json = JSON.stringify(bos);
    for (const shown of [SHOWN.retainer, SHOWN.projectService, SHOWN.bare, SHOWN.ended]) {
      expect(json).not.toContain(shown);
    }
    expectNoSentinel(bos);
  });
});

describe("the company record", () => {
  it("is the client's own facts and nothing the agency wrote for itself", async () => {
    const company = await readPortalCompany(principal(carol));
    expect(company).toEqual({
      id: acme,
      name: `Acme ${run}`,
      orgNr: SHOWN.orgNr,
      vatNumber: `SE${run}01`,
      address: { line1: "Storgatan 1", line2: null, postalCode: "111 22", city: SHOWN.city, countryCode: "SE" },
    });
    expectNoSentinel(company);
    // The billing email is not the client's own record on THIS surface —
    // Phase 4's invoice surface owns it.
    expect(JSON.stringify(company)).not.toContain("billing-");
  });

  it("both profiles read it; a suspended contact does not", async () => {
    expect(await readPortalCompany(principal(dan))).toEqual(await readPortalCompany(principal(carol)));
    expect(await authzReason(readPortalCompany(principal(sue)))).toBe("FORBIDDEN");
  });

  it("another client's contact reads THEIR company, with no address to draw", async () => {
    const company = await readPortalCompany(principal(bo, beta));
    expect(company).toEqual({ id: beta, name: `Beta ${run}`, orgNr: null, vatNumber: null, address: null });
    expectNoSentinel(company);
  });
});
