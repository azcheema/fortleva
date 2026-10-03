import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MemberActor } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { getClient } from "@/clients/service";
import { withTenant, type TenantDb } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { setModuleEnabled } from "@/preferences/service";

import { createAsset, deleteAsset, listAssets, updateAsset } from "./index";

/**
 * THE ASSET REGISTRY against the real database and the real app_runtime
 * role (Phase 3V slice 87; DATA_MODEL.md §6.17 `ClientAsset`):
 *   - the house recipe on every verb — `asset:*` on all four gates (the
 *     module is `vault`), scope, the write, `asset.*` in the same
 *     transaction, the changed field NAMES on an edit and nothing on a
 *     no-op;
 *   - scope by anchor: a project's asset on the project axis, a client-
 *     level one for DIRECT assignment only; out of scope is NOT_FOUND,
 *     indistinguishable from a missing id, and asked before any fact
 *     about the anchor is told;
 *   - the money pair, the renewal day, the per-type facts, a type change;
 *   - what the database refuses by itself: a contact principal reads and
 *     writes nothing (INTERNAL only), a project of another client, a url
 *     with a user in it, a cost without a currency, CLIENT_VISIBLE.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let other: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let beta: string;
let acmeP1: string;
let acmeP2: string;
let betaP: string;
let archivedClient: string;
let archivedProject: string;

const owner = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.owner.memberId) });
const manager = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.manager.memberId) });
const admin = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.admin.memberId) });
const employee = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.employee.memberId) });
const withActor = (actor: MemberActor) => ({ tenantId: f.tenantId, actor });

/** "ok" or the deterministic reason/code a call was refused with. */
const outcome = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof AuthzError) return e.reason;
    if (e instanceof DomainError) return e.code;
    throw e;
  }
};

const audits = async (action: string, targetId?: string) =>
  (await f.audits(action)).filter((a) => targetId === undefined || a.targetId === targetId);

/** Give the employee's role in THIS throwaway tenant one more code. */
async function grantEmployee(code: string) {
  const permission = await f.platform.permission.findUniqueOrThrow({ where: { code }, select: { id: true } });
  await f.platform.rolePermission.create({
    data: { tenantId: f.tenantId, roleId: f.seats.employee.roleId, permissionId: permission.id, source: "TENANT_GRANT" },
  });
}

beforeAll(async () => {
  f = await setupTenant("assets");
  other = await setupTenant("assets");
  acme = randomUUID();
  beta = randomUUID();
  archivedClient = randomUUID();
  acmeP1 = randomUUID();
  acmeP2 = randomUUID();
  betaP = randomUUID();
  archivedProject = randomUUID();
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: "Acme" },
      { id: beta, tenantId: f.tenantId, name: "Beta" },
      { id: archivedClient, tenantId: f.tenantId, name: "Gone", status: "ARCHIVED" },
    ],
  });
  await f.platform.project.createMany({
    data: [
      { id: acmeP1, tenantId: f.tenantId, clientId: acme, key: "ACA", name: "Acme site" },
      { id: acmeP2, tenantId: f.tenantId, clientId: acme, key: "ACB", name: "Acme app" },
      { id: betaP, tenantId: f.tenantId, clientId: beta, key: "BET", name: "Beta site" },
      { id: archivedProject, tenantId: f.tenantId, clientId: acme, key: "ACZ", name: "Old", status: "ARCHIVED" },
    ],
  });
  // The employee works on ONE project of Acme and nothing else.
  await f.platform.memberProject.create({
    data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, projectId: acmeP1 },
  });
}, 120_000);

afterAll(async () => {
  for (const t of [f, other]) {
    if (!t) continue;
    await t.platform.clientAsset.deleteMany({ where: { tenantId: t.tenantId } });
    await t.platform.memberProject.deleteMany({ where: { tenantId: t.tenantId } });
    await t.platform.memberClient.deleteMany({ where: { tenantId: t.tenantId } });
    await t.platform.project.deleteMany({ where: { tenantId: t.tenantId } });
    await t.platform.client.deleteMany({ where: { tenantId: t.tenantId } });
    await t.platform.tenantPreference.deleteMany({ where: { tenantId: t.tenantId } });
  }
  await other?.cleanup();
  await f?.cleanup();
}, 120_000);

describe("create and list — the view, the trail, the money pair", () => {
  let domain: string;

  beforeAll(async () => {
    domain = (
      await createAsset(owner(), {
        clientId: acme,
        type: "DOMAIN",
        name: "acme.se",
        provider: "Loopia",
        identifier: "acme.se",
        url: "https://acme.se",
        expiresAt: new Date("2027-03-01T13:45:00Z"),
        autoRenew: true,
        renewalCost: "149",
        fields: { nameservers: "ns1.loopia.se, ns2.loopia.se" },
        notes: "Renewed by the client's card.",
      })
    ).id;
  }, 60_000);

  it("stores the renewal DAY at UTC midnight, a cost with the tenant's default currency, and the facts typed", async () => {
    const [a] = (await listAssets(owner(), { clientId: acme })).filter((x) => x.id === domain);
    expect(a).toMatchObject({
      clientId: acme,
      projectId: null,
      project: null,
      type: "DOMAIN",
      status: "ACTIVE",
      provider: "Loopia",
      autoRenew: true,
      renewalCost: "149.00",
      currency: "SEK",
      fields: { nameservers: ["ns1.loopia.se", "ns2.loopia.se"] },
    });
    expect(a?.expiresAt?.toISOString()).toBe("2027-03-01T00:00:00.000Z");
    const [created] = await audits("asset.created", domain);
    expect(created?.metadata).toEqual({ clientId: acme, projectId: null, type: "DOMAIN" });
  });

  it("a project anchor brings its client; a mismatch, an archived anchor or a bad value is refused", async () => {
    const p = await createAsset(owner(), { clientId: acme, projectId: acmeP1, type: "HOSTING", name: "Acme hosting", fields: { plan: "Pro" } });
    expect(p).toMatchObject({ clientId: acme, projectId: acmeP1, project: { key: "ACA" }, fields: { plan: "Pro" } });
    expect(await outcome(createAsset(owner(), { clientId: beta, projectId: acmeP1, type: "HOSTING", name: "x" }))).toBe("CLIENT_MISMATCH");
    expect(await outcome(createAsset(owner(), { clientId: acme, projectId: archivedProject, type: "HOSTING", name: "x" }))).toBe("ARCHIVED");
    expect(await outcome(createAsset(owner(), { clientId: archivedClient, type: "HOSTING", name: "x" }))).toBe("ARCHIVED");
    expect(await outcome(createAsset(owner(), { clientId: randomUUID(), type: "HOSTING", name: "x" }))).toBe("NOT_FOUND");
    expect(await outcome(createAsset(owner(), { clientId: acme, type: "CUSTOM", name: "x", fields: { plan: "p" } }))).toBe("INVALID_INPUT");
    expect(await outcome(createAsset(owner(), { clientId: acme, type: "DOMAIN", name: "  " }))).toBe("NAME_REQUIRED");
    for (const url of ["javascript:alert(1)", "https://admin:pw@acme.se", "https://@acme.se"]) {
      expect(await outcome(createAsset(owner(), { clientId: acme, type: "DOMAIN", name: "x", url })), url).toBe("INVALID_INPUT");
    }
    expect(await outcome(createAsset(owner(), { clientId: acme, type: "DOMAIN", name: "x", renewalCost: "-1" }))).toBe("INVALID_INPUT");
  });

  it("lists in use first, then by type, then by name", async () => {
    await createAsset(owner(), { clientId: acme, type: "DOMAIN", name: "acme.com" });
    const ssl = await createAsset(owner(), { clientId: acme, type: "SSL_CERT", name: "acme.se certificate" });
    await updateAsset(owner(), ssl.id, { status: "RETIRED" });
    const names = (await listAssets(owner(), { clientId: acme })).map((a) => `${a.status}:${a.type}:${a.name}`);
    const statuses = names.map((n) => n.split(":")[0]);
    expect(statuses).toEqual([...statuses].sort()); // ACTIVE < RETIRED
    expect(statuses).toContain("RETIRED");
    expect(names.indexOf("ACTIVE:DOMAIN:acme.com")).toBeLessThan(names.indexOf("ACTIVE:DOMAIN:acme.se"));
    expect(names.indexOf("ACTIVE:DOMAIN:acme.se")).toBeLessThan(names.indexOf("ACTIVE:HOSTING:Acme hosting"));
  });
});

describe("edits — only what changed, by name", () => {
  it("a patch writes and records the changed fields only; the same values again write nothing", async () => {
    const a = await createAsset(owner(), { clientId: acme, type: "EMAIL", name: "Acme mail", fields: { plan: "Basic", mailboxes: 3 } });
    const after = await updateAsset(owner(), a.id, { name: "Acme mail", provider: "Google", fields: { mailboxes: "4", plan: "Basic" } });
    expect(after).toMatchObject({ provider: "Google", fields: { plan: "Basic", mailboxes: 4 } });
    const rows = await audits("asset.updated", a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toEqual({ clientId: acme, projectId: null, type: "EMAIL", changed: ["provider", "fields"] });
    await updateAsset(owner(), a.id, { name: "Acme mail", provider: "Google", fields: { mailboxes: 4 } });
    expect(await audits("asset.updated", a.id)).toHaveLength(1);
  });

  it("a cost and its currency are set and cleared together", async () => {
    const a = await createAsset(owner(), { clientId: acme, type: "LICENSE", name: "Elementor", renewalCost: "59", currency: "usd" });
    expect(a).toMatchObject({ renewalCost: "59.00", currency: "USD" });
    const cleared = await updateAsset(owner(), a.id, { renewalCost: null, currency: "EUR" });
    expect(cleared).toMatchObject({ renewalCost: null, currency: null });
    const back = await updateAsset(owner(), a.id, { renewalCost: "1 200,50" });
    expect(back).toMatchObject({ renewalCost: "1200.50", currency: "SEK" });
  });

  it("a type change keeps only the facts the new type has", async () => {
    const a = await createAsset(owner(), { clientId: acme, type: "DOMAIN", name: "acme.nu", fields: { nameservers: "ns1.x.se" } });
    expect((await updateAsset(owner(), a.id, { type: "DNS_ZONE" })).fields).toEqual({ nameservers: ["ns1.x.se"] });
    const lic = await updateAsset(owner(), a.id, { type: "LICENSE", fields: { seats: 2 } });
    expect(lic).toMatchObject({ type: "LICENSE", fields: { seats: 2 } });
    // A fact of the OLD type is refused, not stored.
    expect(await outcome(updateAsset(owner(), a.id, { fields: { nameservers: "ns9.x.se" } }))).toBe("INVALID_INPUT");
  });

  it("retire and bring back are status edits, audited as such", async () => {
    const a = await createAsset(owner(), { clientId: acme, type: "THIRD_PARTY_SERVICE", name: "Mailchimp" });
    await updateAsset(owner(), a.id, { status: "RETIRED" });
    await updateAsset(owner(), a.id, { status: "ACTIVE" });
    expect((await audits("asset.updated", a.id)).map((r) => (r.metadata as { changed: string[] }).changed)).toEqual([["status"], ["status"]]);
  });
});

describe("an untouched row's save writes nothing", () => {
  /**
   * The tab's AutoForm posts EVERY field of the row on every blur, so a
   * save of one field re-sends all the others exactly as the row shows
   * them. That shape — built here as `updateAssetAction` builds it — must
   * be a no-op, with and without a cost (the currency input exists only
   * beside a cost). Pinned because no other test sends it (the code review).
   */
  const atRest = (v: Awaited<ReturnType<typeof listAssets>>[number]) => ({
    type: v.type,
    fields: Object.fromEntries(Object.entries(v.fields).map(([k, x]) => [k, Array.isArray(x) ? x.join(", ") : String(x)])),
    name: v.name,
    provider: v.provider ?? "",
    identifier: v.identifier ?? "",
    url: v.url ?? "",
    expiresAt: v.expiresAt === null ? null : new Date(`${v.expiresAt.toISOString().slice(0, 10)}T00:00:00Z`),
    autoRenew: v.autoRenew,
    renewalCost: v.renewalCost ?? "",
    ...(v.renewalCost === null ? {} : { currency: v.currency ?? "SEK" }),
    notes: v.notes ?? "",
  });

  it("a full at-rest post, with a cost and with none, records nothing", async () => {
    const withCost = await createAsset(owner(), {
      clientId: acme,
      type: "DOMAIN",
      name: "at-rest.se",
      provider: "Loopia",
      url: "https://at-rest.se",
      expiresAt: new Date("2027-05-05T00:00:00Z"),
      autoRenew: false,
      renewalCost: "1 200,5",
      currency: "EUR",
      fields: { nameservers: ["ns1.x.se", "ns2.x.se"] },
      notes: "Note",
    });
    const bare = await createAsset(owner(), { clientId: acme, type: "LICENSE", name: "at-rest licence", fields: { seats: 2 } });
    for (const id of [withCost.id, bare.id]) {
      const [v] = (await listAssets(owner(), { clientId: acme })).filter((x) => x.id === id);
      await updateAsset(owner(), id, atRest(v!));
      expect(await audits("asset.updated", id), id).toEqual([]);
    }
  });
});

describe("delete — hard, once", () => {
  it("removes the row and records one asset.deleted; a second delete is NOT_FOUND", async () => {
    const a = await createAsset(owner(), { clientId: acme, projectId: acmeP2, type: "CMS_APP", name: "Acme WordPress" });
    const [first, second] = await Promise.all([
      outcome(deleteAsset(manager(), a.id)),
      outcome(deleteAsset(manager(), a.id)),
    ]);
    expect([first, second].sort()).toEqual(["NOT_FOUND", "ok"]);
    expect(await f.platform.clientAsset.count({ where: { id: a.id } })).toBe(0);
    const rows = await audits("asset.deleted", a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toEqual({ clientId: acme, projectId: acmeP2, type: "CMS_APP" });
  });
});

describe("gates and scope", () => {
  let clientLevel: string;
  let onP1: string;
  let onP2: string;
  let onBeta: string;

  beforeAll(async () => {
    clientLevel = (await createAsset(owner(), { clientId: acme, type: "DOMAIN", name: "scope-client-level" })).id;
    onP1 = (await createAsset(owner(), { clientId: acme, projectId: acmeP1, type: "HOSTING", name: "scope-p1" })).id;
    // A SIBLING project of the employee's — the canonical AUTHZ §4 case (the security review).
    onP2 = (await createAsset(owner(), { clientId: acme, projectId: acmeP2, type: "HOSTING", name: "scope-p2" })).id;
    onBeta = (await createAsset(owner(), { clientId: beta, projectId: betaP, type: "HOSTING", name: "scope-beta" })).id;
  }, 60_000);

  it("the seeded codes: an employee views but cannot add, edit or delete; an admin cannot delete", async () => {
    expect(await outcome(createAsset(employee(), { clientId: acme, projectId: acmeP1, type: "DOMAIN", name: "x" }))).toBe("FORBIDDEN");
    expect(await outcome(updateAsset(employee(), onP1, { name: "x" }))).toBe("FORBIDDEN");
    expect(await outcome(deleteAsset(employee(), onP1))).toBe("FORBIDDEN");
    expect(await outcome(deleteAsset(admin(), onP1))).toBe("FORBIDDEN");
    expect(await outcome(updateAsset(admin(), onP1, { provider: "Hetzner" }))).toBe("ok");
  });

  it("an employee on one project sees that project's assets only — never the client's own, never another client's", async () => {
    const acmeSeen = (await listAssets(employee(), { clientId: acme })).map((a) => a.id);
    expect(acmeSeen).toContain(onP1);
    expect(acmeSeen).not.toContain(clientLevel);
    expect(acmeSeen).not.toContain(onP2);
    for (const a of await listAssets(employee(), { clientId: acme })) expect(a.projectId).toBe(acmeP1);
    expect(await listAssets(employee(), { clientId: beta })).toEqual([]);
  });

  it("with the codes granted, the same scope holds on every write — out of scope answers like a missing id", async () => {
    await grantEmployee("asset:manage");
    await grantEmployee("asset:delete");
    expect(await outcome(createAsset(employee(), { clientId: acme, projectId: acmeP1, type: "DOMAIN", name: "emp-on-p1" }))).toBe("ok");
    // The client-level anchor needs DIRECT assignment; another client's project is out of reach.
    expect(await outcome(createAsset(employee(), { clientId: acme, type: "DOMAIN", name: "x" }))).toBe("NOT_FOUND");
    expect(await outcome(createAsset(employee(), { clientId: beta, projectId: betaP, type: "DOMAIN", name: "x" }))).toBe("NOT_FOUND");
    // Scope is asked FIRST: an out-of-reach project of ANOTHER client says NOT_FOUND, not CLIENT_MISMATCH.
    expect(await outcome(createAsset(employee(), { clientId: acme, projectId: betaP, type: "DOMAIN", name: "x" }))).toBe("NOT_FOUND");
    const missing = randomUUID();
    for (const id of [clientLevel, onP2, onBeta, missing]) {
      expect(await outcome(updateAsset(employee(), id, { name: "x" })), id).toBe("NOT_FOUND");
      expect(await outcome(deleteAsset(employee(), id)), id).toBe("NOT_FOUND");
    }
    expect(await outcome(updateAsset(employee(), onP1, { notes: "checked" }))).toBe("ok");
  });

  it("a member assigned to the client DIRECTLY reaches its client-level assets and every project's — and still nothing of another client", async () => {
    await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId: acme } });
    try {
      const seen = (await listAssets(employee(), { clientId: acme })).map((a) => a.id);
      for (const id of [clientLevel, onP1, onP2]) expect(seen, id).toContain(id);
      expect(await listAssets(employee(), { clientId: beta })).toEqual([]);
      expect(await outcome(createAsset(employee(), { clientId: acme, type: "DOMAIN", name: "emp-direct" }))).toBe("ok");
      expect(await outcome(updateAsset(employee(), clientLevel, { notes: "direct" }))).toBe("ok");
      expect(await outcome(updateAsset(employee(), onBeta, { notes: "x" }))).toBe("NOT_FOUND");
      expect(await outcome(createAsset(employee(), { clientId: beta, type: "DOMAIN", name: "x" }))).toBe("NOT_FOUND");
    } finally {
      await f.platform.memberClient.deleteMany({ where: { tenantId: f.tenantId, memberId: f.seats.employee.memberId } });
    }
  });

  it("impersonation reads but never writes", async () => {
    const imp: MemberActor = { ...actorFor(f.seats.owner.memberId), impersonated: true };
    expect(await outcome(listAssets(withActor(imp), { clientId: acme }))).toBe("ok");
    expect(await outcome(createAsset(withActor(imp), { clientId: acme, type: "DOMAIN", name: "x" }))).toBe("FORBIDDEN");
    expect(await outcome(updateAsset(withActor(imp), onP1, { name: "x" }))).toBe("FORBIDDEN");
  });

  it("switching the vault off closes the registry and the client's Assets tab with it", async () => {
    expect((await getClient(owner(), acme)).caps).toMatchObject({ viewAssets: true, manageAssets: true, deleteAssets: true });
    await setModuleEnabled(owner(), "vault", false);
    try {
      expect(await outcome(listAssets(owner(), { clientId: acme }))).toBe("DISABLED_BY_TENANT");
      expect(await outcome(createAsset(owner(), { clientId: acme, type: "DOMAIN", name: "x" }))).toBe("DISABLED_BY_TENANT");
      expect(await outcome(deleteAsset(owner(), onP1))).toBe("DISABLED_BY_TENANT");
      expect((await getClient(owner(), acme)).caps).toMatchObject({ viewAssets: false, manageAssets: false, deleteAssets: false });
    } finally {
      await setModuleEnabled(owner(), "vault", true);
    }
  });

  it("another tenant reaches nothing", async () => {
    const theirs = { tenantId: other.tenantId, actor: actorFor(other.seats.owner.memberId) };
    expect(await listAssets(theirs, { clientId: acme })).toEqual([]);
    expect(await outcome(updateAsset(theirs, onP1, { name: "x" }))).toBe("NOT_FOUND");
    expect(await outcome(deleteAsset(theirs, onP1))).toBe("NOT_FOUND");
    expect(await outcome(createAsset(theirs, { clientId: acme, type: "DOMAIN", name: "x" }))).toBe("NOT_FOUND");
  });
});

describe("what the database itself refuses", () => {
  const RLS = /row-level security/;
  const base = () => ({ tenantId: f.tenantId, clientId: acme, type: "DOMAIN" as const, name: "db-probe" });

  it("a contact principal reads 0 rows and writes none", async () => {
    const contact = { type: "contact", id: randomUUID(), clientId: acme } as const;
    expect(await f.platform.clientAsset.count({ where: { tenantId: f.tenantId, clientId: acme } })).toBeGreaterThan(0);
    await withTenant(f.tenantId, contact, async (tx) => {
      expect(await tx.clientAsset.count()).toBe(0);
      const raw = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM client_asset`;
      expect(raw[0]?.n).toBe(0);
    });
    await expect(withTenant(f.tenantId, contact, (tx) => tx.clientAsset.create({ data: base(), select: { id: true } }))).rejects.toThrow(RLS);
    expect(await withTenant(f.tenantId, contact, (tx) => tx.$executeRaw`UPDATE client_asset SET name = 'x' WHERE client_id = ${acme}`)).toBe(0);
    expect(await withTenant(f.tenantId, contact, (tx) => tx.$executeRaw`DELETE FROM client_asset WHERE client_id = ${acme}`)).toBe(0);
  });

  it("refuses CLIENT_VISIBLE, a project of another client, a url with a user, and a cost without its currency", async () => {
    const sys = <T,>(fn: (tx: TenantDb) => Promise<T>) => withTenant(f.tenantId, { type: "system" }, fn);
    await expect(sys((tx) => tx.clientAsset.create({ data: { ...base(), visibility: "CLIENT_VISIBLE" }, select: { id: true } }))).rejects.toThrow(
      /client_asset_internal_only/,
    );
    await expect(sys((tx) => tx.clientAsset.create({ data: { ...base(), projectId: betaP }, select: { id: true } }))).rejects.toThrow(
      /ASSET_CLIENT_MISMATCH/,
    );
    await expect(sys((tx) => tx.clientAsset.create({ data: { ...base(), url: "https://u:p@acme.se" }, select: { id: true } }))).rejects.toThrow(
      /client_asset_url_http/,
    );
    await expect(sys((tx) => tx.clientAsset.create({ data: { ...base(), renewalCost: "10" }, select: { id: true } }))).rejects.toThrow(
      /client_asset_cost_currency/,
    );
    await expect(sys((tx) => tx.clientAsset.create({ data: { ...base(), currency: "SEK" }, select: { id: true } }))).rejects.toThrow(
      /client_asset_cost_currency/,
    );
    // …and a path `@` is not a user.
    const ok = await sys((tx) => tx.clientAsset.create({ data: { ...base(), url: "https://medium.com/@acme" }, select: { id: true } }));
    await f.platform.clientAsset.delete({ where: { id: ok.id } });
  });

  it("the policies are pinned: the two-term gate and the census's three named denies", async () => {
    const rows = await f.platform.$queryRaw<{ policyname: string; permissive: string; cmd: string }[]>`
      SELECT policyname::text, permissive, cmd FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'client_asset' ORDER BY policyname`;
    expect(rows.map((r) => `${r.policyname}:${r.permissive}:${r.cmd}`)).toEqual([
      "portal_gate:RESTRICTIVE:ALL",
      "portal_no_delete:RESTRICTIVE:DELETE",
      "portal_no_insert:RESTRICTIVE:INSERT",
      "portal_no_update:RESTRICTIVE:UPDATE",
      "tenant_isolation:PERMISSIVE:ALL",
    ]);
  });
});
