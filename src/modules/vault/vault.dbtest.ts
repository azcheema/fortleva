import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { MemberActor } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { decryptFieldV2, encryptFieldV2 } from "@/crypto/field-encryption";
import { resetTenantDekCache } from "@/crypto/tenant-key";
import { withTenant } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { actorFor, noMfa, setupTenant } from "@/members/dbtest-fixture";
import { setModuleEnabled, updatePreferences } from "@/preferences/service";
import { getProjectByKey } from "@/projects/service";

import {
  copyCredentialField,
  createCredential,
  deleteCredential,
  generateCredentialTotp,
  getCredential,
  listAllCredentials,
  listCredentials,
  openVault,
  replaceCredentialSecret,
  revealCredentialField,
  updateCredential,
  vaultIndex,
  VAULT_LIST_LIMIT,
} from "./index";
import { VERSIONS_KEPT } from "./secret-store";
import { parseTotpInput, totpCode } from "./totp";

/**
 * THE VAULT CORE against the real database and the real app_runtime role
 * (Phase 3V slice 1). PLAN Phase 3V's "non-negotiable tests before ship —
 * land before UI, no exceptions", the ones this slice can reach:
 *   - a dump of every tenant-scoped table (and the audit trail) holds no
 *     plaintext — not the secret, not the old secret, not the TOTP seed;
 *   - AAD mismatch: a ciphertext moved to another row, another tenant or
 *     the history table fails to decrypt;
 *   - reveal without a recent factor ⇒ MFA_REQUIRED, recorded;
 *   - reveal budget exceeded ⇒ refused and recorded;
 *   - an employee cannot reveal, edit or delete;
 *   - a contact principal gets 0 rows of credential_secret /
 *     credential_version (and of credential_item, INTERNAL in v1 — the
 *     database refuses CLIENT_VISIBLE outright);
 *   - TOTP: the code the service generates is the RFC code for the seed
 *     (vectors: totp.test.ts), and the seed never leaves;
 *   - log-scrub: no console output carries a value, on success or failure.
 * Plus scope (C49: the agency's own logins are tenant-wide-scope only;
 * out of scope is NOT_FOUND before any other answer) and the history.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let other: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let beta: string;
let acmeP1: string;
let acmeP2: string;
let betaP: string;

const RUN = randomUUID().slice(0, 8);
// Values chosen to be unmistakable in a dump and never a substring of an id.
const PASSWORD = `Hunter-pw-${RUN}-zq!`;
const NEW_PASSWORD = `Rotated-pw-${RUN}-xk?`;
const API_SECRET = `sk_live_${RUN}_q7Wv`;
const TOTP_SEED = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"; // 20 bytes, base32
const PLAINTEXTS = [PASSWORD, NEW_PASSWORD, API_SECRET, TOTP_SEED];

// A FRESH factor per call: the fixture stamps its seats' factor once, at
// setup, and this file runs long enough over the Neon link for that stamp
// to age past the vault's ten-minute window mid-run.
const owner = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.owner.memberId) });
const manager = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.manager.memberId) });
const admin = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.admin.memberId) });
const employee = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.employee.memberId) });
const withActor = (actor: MemberActor) => ({ tenantId: f.tenantId, actor });
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
/** What a failed AES-GCM authentication says — and only that, never a gate's refusal. */
const GCM_FAILURE = /unable to authenticate/;

/** "ok" or the deterministic reason/code a call was refused with. */
const outcome = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof AuthzError) return e.reason === "MFA_REQUIRED" ? `MFA_REQUIRED:${e.mfaRemedy}` : e.reason;
    if (e instanceof DomainError) return e.code;
    throw e;
  }
};

const audits = async (action: string, targetId?: string) =>
  (await f.audits(action)).filter((a) => targetId === undefined || a.targetId === targetId);

beforeAll(async () => {
  f = await setupTenant("vault");
  other = await setupTenant("vault");
  acme = randomUUID();
  beta = randomUUID();
  acmeP1 = randomUUID();
  acmeP2 = randomUUID();
  betaP = randomUUID();
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: "Acme" },
      { id: beta, tenantId: f.tenantId, name: "Beta" },
    ],
  });
  await f.platform.project.createMany({
    data: [
      { id: acmeP1, tenantId: f.tenantId, clientId: acme, key: "ACA", name: "Acme site" },
      { id: acmeP2, tenantId: f.tenantId, clientId: acme, key: "ACB", name: "Acme app" },
      { id: betaP, tenantId: f.tenantId, clientId: beta, key: "BET", name: "Beta site" },
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
    await t.platform.credentialItem.deleteMany({ where: { tenantId: t.tenantId } }); // secrets + versions cascade
    await t.platform.memberProject.deleteMany({ where: { tenantId: t.tenantId } });
    await t.platform.project.deleteMany({ where: { tenantId: t.tenantId } });
    await t.platform.client.deleteMany({ where: { tenantId: t.tenantId } });
    await t.platform.tenantPreference.deleteMany({ where: { tenantId: t.tenantId } });
    await t.platform.tenantKey.deleteMany({ where: { tenantId: t.tenantId } });
  }
  resetTenantDekCache();
  await other?.cleanup();
  await f?.cleanup();
}, 120_000);

describe("create, list, read — metadata only, scope by anchor (C49)", () => {
  let p1Login: string;
  let acmeLevel: string;
  let betaLogin: string;
  let agencyOwn: string;

  beforeAll(async () => {
    p1Login = (
      await createCredential(owner(), {
        projectId: acmeP1,
        type: "LOGIN",
        name: "Acme WordPress admin",
        username: "ops@acme.test",
        url: "https://acme.test/wp-admin",
        tags: ["wordpress", "wordpress", " prod "],
        secret: { password: PASSWORD },
        totp: TOTP_SEED,
      })
    ).id;
    acmeLevel = (
      await createCredential(owner(), { clientId: acme, type: "API_KEY", name: "Acme Stripe", secret: { apiKey: "pk_test_x", apiSecret: API_SECRET } })
    ).id;
    betaLogin = (await createCredential(owner(), { projectId: betaP, type: "LOGIN", name: "Beta FTP", secret: { password: "beta-pw" } })).id;
    agencyOwn = (await createCredential(owner(), { type: "LOGIN", name: "Our registrar", secret: { password: "ours-pw" } })).id;
  }, 120_000);

  it("the view carries field NAMES and a TOTP flag — never a value — and tags are cleaned", async () => {
    const view = await getCredential(owner(), p1Login);
    expect(view).toMatchObject({
      clientId: acme,
      projectId: acmeP1,
      type: "LOGIN",
      secretFieldKeys: ["password"],
      hasTotp: true,
      tags: ["wordpress", "prod"],
      needsRotation: false,
    });
    expect(JSON.stringify(view)).not.toContain(PASSWORD);
    expect(JSON.stringify(view)).not.toContain(TOTP_SEED);
    const [created] = await audits("credential.created", p1Login);
    expect(created?.metadata).toEqual({ clientId: acme, projectId: acmeP1, type: "LOGIN", fields: ["password"], hasTotp: true });
  });

  it("a project anchor brings its own client; a mismatched client or an archived project is refused", async () => {
    expect(await outcome(createCredential(owner(), { clientId: beta, projectId: acmeP1, type: "WIFI", name: "x", secret: { password: "p" } }))).toBe(
      "CLIENT_MISMATCH",
    );
    const archived = randomUUID();
    await f.platform.project.create({
      data: { id: archived, tenantId: f.tenantId, clientId: acme, key: "ACZ", name: "Old", status: "ARCHIVED" },
    });
    expect(await outcome(createCredential(owner(), { projectId: archived, type: "WIFI", name: "x", secret: { password: "p" } }))).toBe("ARCHIVED");
    expect(await outcome(createCredential(owner(), { clientId: acme, type: "WIFI", name: "x", secret: {} }))).toBe("INVALID_INPUT");
    expect(await outcome(createCredential(owner(), { clientId: acme, type: "WIFI", name: "x", secret: { apiKey: "k" } }))).toBe("INVALID_INPUT");
    for (const url of ["javascript:alert(1)", "https:example.com", `https://admin:${PASSWORD}@acme.test/`]) {
      expect(await outcome(createCredential(owner(), { clientId: acme, type: "WIFI", name: "x", url, secret: { password: "p" } })), url).toBe(
        "INVALID_INPUT",
      );
    }
  });

  it("an unknown secret key is refused without the key in the error (it may be a value)", async () => {
    try {
      await createCredential(owner(), { clientId: acme, type: "WIFI", name: "x", secret: { [PASSWORD]: "p" } });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      expect(String(e)).not.toContain(PASSWORD);
    }
  });

  it("the database refuses a credential on another client's project (CREDENTIAL_CLIENT_MISMATCH)", async () => {
    await expect(
      f.platform.credentialItem.create({
        data: { tenantId: f.tenantId, clientId: acme, projectId: betaP, type: "LOGIN", name: "forged" },
      }),
    ).rejects.toThrow(/CREDENTIAL_CLIENT_MISMATCH/);
  });

  it("a manager (tenant-wide scope) lists everything, the agency's own included", async () => {
    expect((await listCredentials(manager(), { clientId: acme })).map((c) => c.id).sort()).toEqual([p1Login, acmeLevel].sort());
    expect((await listCredentials(manager(), { agencyOwn: true })).map((c) => c.id)).toEqual([agencyOwn]);
    expect((await getCredential(manager(), agencyOwn)).clientId).toBeNull();
  });

  it("an employee on Acme's P1 sees P1's login only — not Acme's client-level row, not Beta, not the agency's own", async () => {
    expect((await listCredentials(employee(), { clientId: acme })).map((c) => c.id)).toEqual([p1Login]);
    expect((await listCredentials(employee(), { projectId: acmeP1 })).map((c) => c.id)).toEqual([p1Login]);
    expect(await listCredentials(employee(), { projectId: acmeP2 })).toEqual([]);
    expect(await listCredentials(employee(), { clientId: beta })).toEqual([]);
    expect(await listCredentials(employee(), { agencyOwn: true })).toEqual([]);
    for (const id of [acmeLevel, betaLogin, agencyOwn, randomUUID()]) {
      expect(await outcome(getCredential(employee(), id)), id).toBe("NOT_FOUND");
    }
  });

  it("everything (the tenant's /vault): our own first, then by client name — each row naming its client and project", async () => {
    const { rows, cut } = await listAllCredentials(manager());
    expect(cut).toBeNull();
    const ownCount = rows.findIndex((r) => r.clientId !== null);
    expect(ownCount).toBeGreaterThan(0);
    expect(rows.slice(0, ownCount).every((r) => r.clientId === null && r.client === null && r.project === null)).toBe(true);
    expect(rows.slice(ownCount).every((r) => r.clientId !== null)).toBe(true);
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([agencyOwn, p1Login, acmeLevel, betaLogin]));
    // Client by client, Acme before Beta, never interleaved.
    const clientOrder = rows.slice(ownCount).map((r) => r.client!.name);
    expect(clientOrder).toEqual([...clientOrder].sort());
    expect(rows.find((r) => r.id === p1Login)).toMatchObject({
      client: { id: acme, name: "Acme" },
      project: { id: acmeP1, key: "ACA", name: "Acme site" },
    });
    expect(rows.find((r) => r.id === acmeLevel)).toMatchObject({ client: { id: acme, name: "Acme" }, project: null });
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
    // The employee on P1 reaches P1's logins and nothing else — no agency
    // row, no Acme client-level row, no Beta.
    const { rows: theirs } = await listAllCredentials(employee());
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.every((r) => r.projectId === acmeP1)).toBe(true);
    expect(theirs.map((r) => r.id)).toContain(p1Login);
  });

  it("vaultIndex counts what each member reaches — our own only for tenant-wide scope", async () => {
    const forManager = await vaultIndex(manager());
    expect(forManager.agency).toBe((await listCredentials(manager(), { agencyOwn: true })).length);
    expect(forManager.clients.map((c) => c.name)).toEqual(["Acme", "Beta"]);
    for (const c of forManager.clients) {
      expect(c.count, c.name).toBe((await listCredentials(manager(), { clientId: c.id })).length);
    }
    const forEmployee = await vaultIndex(employee());
    expect(forEmployee.agency).toBeNull();
    expect(forEmployee.clients).toEqual([
      { id: acme, name: "Acme", count: (await listCredentials(employee(), { clientId: acme })).length },
    ]);
    // A deleted login is counted nowhere, and a client left with none drops out.
    const gamma = randomUUID();
    await f.platform.client.create({ data: { id: gamma, tenantId: f.tenantId, name: "Gamma" } });
    const gone = (await createCredential(owner(), { clientId: gamma, type: "WIFI", name: "Gamma wifi", secret: { password: "g" } })).id;
    expect((await vaultIndex(manager())).clients.find((c) => c.id === gamma)?.count).toBe(1);
    await deleteCredential(owner(), gone);
    expect((await vaultIndex(manager())).clients.map((c) => c.id)).not.toContain(gamma);
    // Another tenant's logins are never this tenant's, by RLS and by count.
    const otherOwner = { tenantId: other.tenantId, actor: actorFor(other.seats.owner.memberId) };
    await createCredential(otherOwner, { type: "LOGIN", name: "Their registrar", secret: { password: "theirs" } });
    expect((await vaultIndex(manager())).agency).toBe(forManager.agency);
    expect((await listAllCredentials(manager())).rows.map((r) => r.name)).not.toContain("Their registrar");
    expect(await vaultIndex(otherOwner)).toEqual({ agency: 1, clients: [] });
  });

  it("an employee may create in scope, never out of it, and never an agency-own login", async () => {
    expect(await outcome(createCredential(employee(), { projectId: acmeP1, type: "SERVER", name: "P1 box", secret: { password: "e-pw" } }))).toBe("ok");
    expect(await outcome(createCredential(employee(), { projectId: betaP, type: "SERVER", name: "no", secret: { password: "e" } }))).toBe("NOT_FOUND");
    expect(await outcome(createCredential(employee(), { clientId: acme, type: "SERVER", name: "no", secret: { password: "e" } }))).toBe("NOT_FOUND");
    expect(await outcome(createCredential(employee(), { type: "SERVER", name: "no", secret: { password: "e" } }))).toBe("NOT_FOUND");
    // Scope is answered before the anchor's own facts: a mismatch on an
    // out-of-scope project is NOT_FOUND, not CLIENT_MISMATCH.
    expect(await outcome(createCredential(employee(), { clientId: acme, projectId: betaP, type: "SERVER", name: "no", secret: { password: "e" } }))).toBe(
      "NOT_FOUND",
    );
  });

  it("an employee can neither edit nor delete — FORBIDDEN before scope is asked, for any id", async () => {
    expect(await outcome(updateCredential(employee(), betaLogin, { name: "renamed" }))).toBe("FORBIDDEN");
    expect(await outcome(deleteCredential(employee(), randomUUID()))).toBe("FORBIDDEN");
    expect(await outcome(updateCredential(employee(), p1Login, { name: "renamed" }))).toBe("FORBIDDEN");
    expect(await outcome(deleteCredential(employee(), p1Login))).toBe("FORBIDDEN");
    expect(await outcome(replaceCredentialSecret(employee(), p1Login, { secret: { password: "x" } }))).toBe("FORBIDDEN");
  });

  it("an employee cannot reveal: FORBIDDEN in scope, NOT_FOUND out of scope — no factor is ever asked for", async () => {
    expect(await outcome(revealCredentialField(employee(), p1Login, "password"))).toBe("FORBIDDEN");
    expect(await outcome(revealCredentialField(employee(), betaLogin, "password"))).toBe("NOT_FOUND");
    expect(await outcome(revealCredentialField(employee(), agencyOwn, "password"))).toBe("NOT_FOUND");
    expect(await outcome(generateCredentialTotp(employee(), p1Login))).toBe("FORBIDDEN");
    expect(await audits("vault.step_up_required")).toEqual([]);
  });

  it("metadata edits are audited with field NAMES; null clears", async () => {
    const view = await updateCredential(owner(), acmeLevel, { notes: "Rotate after launch", url: "https://dashboard.stripe.test" });
    expect(view.notes).toBe("Rotate after launch");
    expect((await updateCredential(owner(), acmeLevel, { notes: null })).notes).toBeNull();
    // A patch that repeats the current values changes nothing and records nothing.
    await updateCredential(owner(), acmeLevel, { url: "https://dashboard.stripe.test", notes: null, tags: [] });
    const rows = await audits("credential.updated", acmeLevel);
    expect(rows.map((r) => r.metadata)).toEqual([{ changed: ["url", "notes"] }, { changed: ["notes"] }]);
  });

  it("a member assigned DIRECTLY to a client sees its client-level rows and every project's — never the agency's own", async () => {
    const direct = randomUUID();
    const userId = randomUUID();
    await f.platform.user.create({ data: { id: userId, name: "direct", email: `direct-${RUN}@test.invalid` } });
    await f.platform.member.create({ data: { id: direct, tenantId: f.tenantId, userId } });
    await f.platform.memberRole.create({ data: { tenantId: f.tenantId, memberId: direct, roleId: f.roleId("employee") } });
    await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: direct, clientId: acme } });
    try {
      const ctx = withActor(actorFor(direct));
      const ids = (await listCredentials(ctx, { clientId: acme })).map((c) => c.id);
      expect(ids).toEqual(expect.arrayContaining([p1Login, acmeLevel]));
      expect(await listCredentials(ctx, { agencyOwn: true })).toEqual([]);
      expect(await listCredentials(ctx, { clientId: beta })).toEqual([]);
      expect((await getCredential(ctx, acmeLevel)).id).toBe(acmeLevel);
      expect(await outcome(getCredential(ctx, agencyOwn))).toBe("NOT_FOUND");
      expect(await outcome(getCredential(ctx, betaLogin))).toBe("NOT_FOUND");
    } finally {
      await f.platform.memberClient.deleteMany({ where: { memberId: direct } });
      await f.platform.memberRole.deleteMany({ where: { memberId: direct } });
      await f.platform.member.delete({ where: { id: direct } });
      await f.platform.user.delete({ where: { id: userId } });
    }
  });

  it("two concurrent deletes record ONE credential.deleted", async () => {
    const id = (await createCredential(owner(), { clientId: acme, type: "WIFI", name: "Raced delete", secret: { password: "w" } })).id;
    const results = await Promise.all([outcome(deleteCredential(owner(), id)), outcome(deleteCredential(manager(), id))]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "NOT_FOUND")).toHaveLength(1);
    expect(await audits("credential.deleted", id)).toHaveLength(1);
  });

  it("the module switch closes the vault (gate 3) — and the project's Vault tab with it", async () => {
    expect((await getProjectByKey(owner(), "ACA")).caps.viewCredentials).toBe(true);
    await setModuleEnabled(owner(), "vault", false);
    try {
      expect(await outcome(listCredentials(owner(), { clientId: acme }))).toBe("DISABLED_BY_TENANT");
      expect(await outcome(listAllCredentials(owner()))).toBe("DISABLED_BY_TENANT");
      expect(await outcome(vaultIndex(owner()))).toBe("DISABLED_BY_TENANT");
      expect(await outcome(revealCredentialField(owner(), p1Login, "password"))).toBe("DISABLED_BY_TENANT");
      // The tab is drawn on all four gates (slice 86), as Files is.
      expect((await getProjectByKey(owner(), "ACA")).caps.viewCredentials).toBe(false);
    } finally {
      await setModuleEnabled(owner(), "vault", true);
    }
  });
});

describe("reveal, copy, TOTP — step-up, one field, one audit row each", () => {
  let login: string;

  beforeAll(async () => {
    login = (
      await createCredential(owner(), {
        projectId: acmeP2,
        type: "LOGIN",
        name: "Acme app console",
        username: "root",
        secret: { password: PASSWORD },
        totp: `otpauth://totp/Acme:root?secret=${TOTP_SEED}&issuer=Acme`,
      })
    ).id;
  }, 60_000);

  it("Reveal returns the one field and records credential.revealed with the field NAME only", async () => {
    expect(await revealCredentialField(owner(), login, "password")).toBe(PASSWORD);
    const rows = await audits("credential.revealed", login);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toEqual({ field: "password" });
    expect(rows[0]?.actorType).toBe("MEMBER");
    expect(rows[0]?.actorId).toBe(f.seats.owner.memberId);
  });

  it("Copy is a separate act in the trail (credential.copied)", async () => {
    expect(await copyCredentialField(owner(), login, "password")).toBe(PASSWORD);
    expect((await audits("credential.copied", login)).map((r) => r.metadata)).toEqual([{ field: "password" }]);
  });

  it("a field the type has not got, or the credential does not carry, is refused", async () => {
    expect(await outcome(revealCredentialField(owner(), login, "apiSecret"))).toBe("INVALID_INPUT");
    expect(await outcome(revealCredentialField(owner(), login, "__proto__"))).toBe("INVALID_INPUT");
  });

  it("TOTP: the RFC code for the stored seed, its expiry, and credential.totp_generated — the seed never leaves", async () => {
    const before = Date.now();
    const got = await generateCredentialTotp(owner(), login);
    const after = Date.now();
    const params = parseTotpInput(TOTP_SEED);
    const candidates = new Set([totpCode(params, before).code, totpCode(params, after).code]);
    expect(candidates.has(got.code)).toBe(true);
    expect(got.period).toBe(30);
    expect(got.validUntil.getTime() % 30_000).toBe(0);
    expect(JSON.stringify(got)).not.toContain(TOTP_SEED);
    expect((await audits("credential.totp_generated", login)).map((r) => r.metadata)).toEqual([{}]);
  });

  it("no second factor enrolled ⇒ MFA_REQUIRED:enrol, recorded, nothing decrypted", async () => {
    const reveals = (await audits("credential.revealed", login)).length;
    expect(await outcome(revealCredentialField(withActor(noMfa(f.seats.manager.memberId)), login, "password"))).toBe("MFA_REQUIRED:enrol");
    const rows = await audits("vault.step_up_required", login);
    expect(rows.at(-1)?.metadata).toEqual({ remedy: "enrol" });
    expect(rows.at(-1)?.actorId).toBe(f.seats.manager.memberId);
    expect((await audits("credential.revealed", login)).length).toBe(reveals);
  });

  it("a factor older than vault.stepUpMinutes (10) but inside the ✦ window (15) is still refused", async () => {
    const stale12: MemberActor = { memberId: f.seats.manager.memberId, mfa: { enrolled: true, verifiedAt: minutesAgo(12) } };
    const stale20: MemberActor = { memberId: f.seats.manager.memberId, mfa: { enrolled: true, verifiedAt: minutesAgo(20) } };
    const fresh9: MemberActor = { memberId: f.seats.manager.memberId, mfa: { enrolled: true, verifiedAt: minutesAgo(9) } };
    expect(await outcome(revealCredentialField(withActor(stale12), login, "password"))).toBe("MFA_REQUIRED:step_up");
    expect(await outcome(generateCredentialTotp(withActor(stale20), login))).toBe("MFA_REQUIRED:step_up");
    expect(await revealCredentialField(withActor(fresh9), login, "password")).toBe(PASSWORD);
    expect((await audits("vault.step_up_required", login)).slice(-2).map((r) => r.metadata)).toEqual([
      { remedy: "step_up" },
      { remedy: "step_up" },
    ]);
  });

  it("the tenant can tighten the window, never loosen it past the ✦ window", async () => {
    await updatePreferences(owner(), { vault: { stepUpMinutes: 5 } });
    try {
      const at7: MemberActor = { memberId: f.seats.manager.memberId, mfa: { enrolled: true, verifiedAt: minutesAgo(7) } };
      expect(await outcome(revealCredentialField(withActor(at7), login, "password"))).toBe("MFA_REQUIRED:step_up");
      expect(await outcome(updatePreferences(owner(), { vault: { stepUpMinutes: 30 } }))).toBe("INVALID_INPUT");
    } finally {
      await updatePreferences(owner(), { vault: { stepUpMinutes: 10 } });
    }
  });

  it("changing the vault's settings needs a recent second factor — a stolen session cannot loosen them", async () => {
    const stale = { memberId: f.seats.owner.memberId, mfa: { enrolled: true, verifiedAt: minutesAgo(20) } };
    expect(await outcome(updatePreferences(withActor(stale), { vault: { revealBudgetPerHour: 100 } }))).toBe("MFA_REQUIRED:step_up");
    expect(await outcome(updatePreferences(withActor(noMfa(f.seats.admin.memberId)), { vault: { stepUpMinutes: 15 } }))).toBe(
      "MFA_REQUIRED:enrol",
    );
    // Other settings are untouched by the rule.
    expect(await outcome(updatePreferences(withActor(stale), { showIsoWeek: true }))).toBe("ok");
  });

  it("impersonation never reveals", async () => {
    const imp: MemberActor = { ...actorFor(f.seats.owner.memberId), impersonated: true };
    expect(await outcome(revealCredentialField(withActor(imp), login, "password"))).toBe("FORBIDDEN");
    expect(await outcome(generateCredentialTotp(withActor(imp), login))).toBe("FORBIDDEN");
  });

  it("a deleted credential leaves every list and every reveal at once", async () => {
    const doomed = (await createCredential(owner(), { projectId: acmeP2, type: "WIFI", name: "Guest wifi", secret: { password: "guest" } })).id;
    await deleteCredential(manager(), doomed);
    expect(await outcome(revealCredentialField(owner(), doomed, "password"))).toBe("NOT_FOUND");
    expect(await outcome(getCredential(owner(), doomed))).toBe("NOT_FOUND");
    expect((await listCredentials(owner(), { projectId: acmeP2 })).map((c) => c.id)).not.toContain(doomed);
    expect((await audits("credential.deleted", doomed)).map((r) => r.metadata)).toEqual([{ clientId: acme, projectId: acmeP2 }]);
  });
});

describe("the reveal budget — per member, per rolling hour, fail-closed, recorded", () => {
  it("the admin's (N+1)th reveal/copy/code in the hour is refused and recorded; another member is unaffected", async () => {
    const id = (await createCredential(owner(), { projectId: acmeP1, type: "LOGIN", name: "Budgeted", secret: { password: PASSWORD }, totp: TOTP_SEED })).id;
    await updatePreferences(owner(), { vault: { revealBudgetPerHour: 3 } });
    try {
      expect(await revealCredentialField(admin(), id, "password")).toBe(PASSWORD);
      expect(await copyCredentialField(admin(), id, "password")).toBe(PASSWORD);
      await generateCredentialTotp(admin(), id);
      expect(await outcome(revealCredentialField(admin(), id, "password"))).toBe("REVEAL_BUDGET_EXCEEDED");
      expect(await outcome(generateCredentialTotp(admin(), id))).toBe("REVEAL_BUDGET_EXCEEDED");
      const refused = (await audits("vault.reveal_budget_exceeded", id)).filter((r) => r.actorId === f.seats.admin.memberId);
      expect(refused.map((r) => r.metadata)).toEqual([
        { used: 3, budget: 3 },
        { used: 3, budget: 3 },
      ]);
      // The refusals are not reveals: the admin's count stays at three.
      const admins = async (a: string) => (await audits(a, id)).filter((r) => r.actorId === f.seats.admin.memberId).length;
      expect((await admins("credential.revealed")) + (await admins("credential.copied")) + (await admins("credential.totp_generated"))).toBe(3);
      // The budget is the MEMBER's, not the credential's: the manager has
      // one reveal this hour (the fresh-factor case above), under three.
      expect(await revealCredentialField(manager(), id, "password")).toBe(PASSWORD);
    } finally {
      await updatePreferences(owner(), { vault: { revealBudgetPerHour: 30 } });
    }
  }, 60_000);

  it("concurrent reveals by one member cannot overspend: exactly the budget succeeds", async () => {
    const id = (await createCredential(owner(), { projectId: acmeP1, type: "LOGIN", name: "Raced", secret: { password: PASSWORD } })).id;
    const racer: MemberActor = actorFor(f.seats.manager.memberId);
    const used = async () =>
      (
        await f.platform.auditEvent.count({
          where: {
            tenantId: f.tenantId,
            actorId: racer.memberId,
            action: { in: ["credential.revealed", "credential.copied", "credential.totp_generated"] },
            createdAt: { gte: minutesAgo(60) },
          },
        })
      );
    const budget = (await used()) + 2;
    await updatePreferences(owner(), { vault: { revealBudgetPerHour: budget } });
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => outcome(revealCredentialField(withActor(racer), id, "password"))),
      );
      // NEVER MORE THAN THE BUDGET — the property. Over a slow link a racer
      // can spend its bounded lock waits and answer VAULT_BUSY instead of
      // being counted; it then revealed nothing either.
      const ok = results.filter((r) => r === "ok").length;
      expect(ok).toBeLessThanOrEqual(2);
      expect(ok).toBeGreaterThanOrEqual(1);
      expect(results.every((r) => ["ok", "REVEAL_BUDGET_EXCEEDED", "VAULT_BUSY"].includes(r))).toBe(true);
      expect(await used()).toBe(budget - 2 + ok);
    } finally {
      await updatePreferences(owner(), { vault: { revealBudgetPerHour: 30 } });
    }
  }, 90_000);
});

describe("the secret's history — replaced, kept as a version under its own AAD, newest ten", () => {
  it("replacing the secret keeps the old one as a version, returns nothing, and clears needsRotation", async () => {
    const id = (await createCredential(owner(), { clientId: acme, type: "LOGIN", name: "Rotated", secret: { password: PASSWORD } })).id;
    await f.platform.credentialItem.update({ where: { id }, data: { needsRotation: true } });
    const view = await replaceCredentialSecret(admin(), id, { secret: { password: NEW_PASSWORD } });
    expect(view.needsRotation).toBe(false);
    expect(JSON.stringify(view)).not.toContain(NEW_PASSWORD);
    expect(await revealCredentialField(owner(), id, "password")).toBe(NEW_PASSWORD);
    const [audit] = await audits("credential.updated", id);
    expect(audit?.metadata).toEqual({
      secretChanged: true,
      changedFields: ["password"],
      rotated: true,
      totpChanged: false,
      fields: ["password"],
      hasTotp: false,
      version: 2,
    });

    const versions = await f.platform.credentialVersion.findMany({
      where: { tenantId: f.tenantId, credentialId: id },
      omit: { secretCiphertext: false },
    });
    expect(versions.map((v) => v.version)).toEqual([1]);
    const old = await withTenant(f.tenantId, { type: "system" }, (tx) =>
      decryptFieldV2(tx, { tenantId: f.tenantId, model: "credential_version", rowId: versions[0]!.id, field: "secret" }, versions[0]!.secretCiphertext),
    );
    // The version names its credential: its AAD binds it to the version
    // row only, so the history read must check this (security review).
    expect(JSON.parse(old)).toEqual({ v: 1, fields: { password: PASSWORD }, credentialId: id });
  }, 60_000);

  it("a secret change is a PATCH: one field rotates, the other stays; blank means unchanged; null removes", async () => {
    const id = (
      await createCredential(owner(), { clientId: acme, type: "API_KEY", name: "Patched", secret: { apiKey: "pk_1", apiSecret: API_SECRET }, totp: TOTP_SEED })
    ).id;
    // Rotate the secret only — the key survives (it was dropped before the review).
    let view = await replaceCredentialSecret(owner(), id, { secret: { apiSecret: "sk_2" } });
    expect(view.secretFieldKeys).toEqual(["apiKey", "apiSecret"]);
    expect(await revealCredentialField(owner(), id, "apiKey")).toBe("pk_1");
    expect(await revealCredentialField(owner(), id, "apiSecret")).toBe("sk_2");
    // A form posting its blanks, and an empty seed input, changes nothing and records nothing.
    const updates = (await audits("credential.updated", id)).length;
    view = await replaceCredentialSecret(owner(), id, { secret: { apiKey: "", apiSecret: "" }, totp: "" });
    expect(view).toMatchObject({ hasTotp: true, secretFieldKeys: ["apiKey", "apiSecret"] });
    expect((await audits("credential.updated", id)).length).toBe(updates);
    // Writing the same value again is not a rotation either.
    await replaceCredentialSecret(owner(), id, { secret: { apiSecret: "sk_2" } });
    expect((await audits("credential.updated", id)).length).toBe(updates);
    // null removes one field; the seed stays — and a removal is not a rotation.
    await f.platform.credentialItem.update({ where: { id }, data: { needsRotation: true } });
    view = await replaceCredentialSecret(owner(), id, { secret: { apiKey: null } });
    expect(view).toMatchObject({ hasTotp: true, secretFieldKeys: ["apiSecret"], needsRotation: true });
    expect((await audits("credential.updated", id)).at(-1)?.metadata).toMatchObject({ changedFields: ["apiKey"], rotated: false });
    expect(await outcome(revealCredentialField(owner(), id, "apiKey"))).toBe("INVALID_INPUT");
    // The versions are 1 (both fields) and 2 (after the first rotation).
    expect((await f.platform.credentialVersion.findMany({ where: { credentialId: id }, orderBy: { version: "asc" } })).map((v) => v.version)).toEqual([1, 2]);
    // Removing the last field AND the seed would leave nothing: refused.
    expect(await outcome(replaceCredentialSecret(owner(), id, { secret: { apiSecret: null }, totp: null }))).toBe("INVALID_INPUT");
  }, 120_000);

  it("ADDING a seed is not a rotation and keeps no version", async () => {
    const id = (await createCredential(owner(), { clientId: acme, type: "LOGIN", name: "Seed only", secret: { password: PASSWORD } })).id;
    await f.platform.credentialItem.update({ where: { id }, data: { needsRotation: true } });
    const view = await replaceCredentialSecret(owner(), id, { totp: TOTP_SEED });
    expect(view).toMatchObject({ hasTotp: true, needsRotation: true, secretFieldKeys: ["password"] });
    expect(await f.platform.credentialVersion.count({ where: { credentialId: id } })).toBe(0);
    expect((await replaceCredentialSecret(owner(), id, { totp: null })).hasTotp).toBe(false);
    expect(await outcome(generateCredentialTotp(owner(), id))).toBe("INVALID_INPUT");
    // Removing a seed that is not there changes nothing and records nothing.
    const recorded = (await audits("credential.updated", id)).length;
    expect((await replaceCredentialSecret(owner(), id, { totp: null })).hasTotp).toBe(false);
    expect((await audits("credential.updated", id)).length).toBe(recorded);
  }, 60_000);

  it("REPLACING a seed is a rotation; the same seed again is no change", async () => {
    const id = (await createCredential(owner(), { clientId: acme, type: "LOGIN", name: "Seed rotated", secret: { password: PASSWORD }, totp: TOTP_SEED })).id;
    await f.platform.credentialItem.update({ where: { id }, data: { needsRotation: true } });
    const before = (await audits("credential.updated", id)).length;
    expect(await replaceCredentialSecret(owner(), id, { totp: TOTP_SEED.toLowerCase() })).toMatchObject({ needsRotation: true });
    expect((await audits("credential.updated", id)).length).toBe(before);
    const OTHER_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const stampedBefore = (await getCredential(owner(), id)).lastRotatedAt;
    const rotatedView = await replaceCredentialSecret(owner(), id, { totp: OTHER_SEED });
    expect(rotatedView).toMatchObject({ hasTotp: true, needsRotation: false });
    expect(rotatedView.lastRotatedAt!.getTime()).toBeGreaterThan(stampedBefore!.getTime());
    // A whitespace-only seed is a blank input: nothing changes.
    expect((await replaceCredentialSecret(owner(), id, { totp: "   " })).hasTotp).toBe(true);
    expect((await audits("credential.updated", id)).at(-1)?.metadata).toMatchObject({ totpChanged: true, rotated: true, changedFields: [] });
    const got = await generateCredentialTotp(owner(), id);
    expect(got.code).toBe(totpCode(parseTotpInput(OTHER_SEED), got.validUntil.getTime() - 1).code);
  }, 60_000);

  it(`only the newest ${VERSIONS_KEPT} versions are kept`, async () => {
    const id = (await createCredential(owner(), { clientId: acme, type: "OTHER", name: "Churned", secret: { secret: "v1" } })).id;
    for (let i = 2; i <= VERSIONS_KEPT + 3; i++) {
      await replaceCredentialSecret(owner(), id, { secret: { secret: `v${i}` } });
    }
    const kept = await f.platform.credentialVersion.findMany({ where: { credentialId: id }, orderBy: { version: "asc" } });
    expect(kept.map((v) => v.version)).toEqual(Array.from({ length: VERSIONS_KEPT }, (_, i) => i + 3));
    expect(await revealCredentialField(owner(), id, "secret")).toBe(`v${VERSIONS_KEPT + 3}`);
  }, 180_000);
});

describe("ciphertext is bound to its row, tenant and table (AAD)", () => {
  it("a ciphertext copied to another row, another tenant or from the history table does not decrypt", async () => {
    const a = (await createCredential(owner(), { clientId: acme, type: "LOGIN", name: "Row A", secret: { password: PASSWORD } })).id;
    const b = (await createCredential(owner(), { clientId: acme, type: "LOGIN", name: "Row B", secret: { password: "b-pw" } })).id;
    const secretOf = async (id: string) =>
      (await f.platform.credentialSecret.findFirstOrThrow({ where: { credentialId: id }, omit: { secretCiphertext: false } })).secretCiphertext;

    // Row swap, same tenant and table.
    await f.platform.credentialSecret.update({ where: { credentialId: b }, data: { secretCiphertext: await secretOf(a) } });
    await expect(revealCredentialField(owner(), b, "password")).rejects.toThrow(GCM_FAILURE);

    // Table swap: a version row's ciphertext put back on the live row.
    await replaceCredentialSecret(owner(), a, { secret: { password: NEW_PASSWORD } });
    const [version] = await f.platform.credentialVersion.findMany({ where: { credentialId: a }, omit: { secretCiphertext: false } });
    await f.platform.credentialSecret.update({ where: { credentialId: b }, data: { secretCiphertext: version!.secretCiphertext } });
    await expect(revealCredentialField(owner(), b, "password")).rejects.toThrow(GCM_FAILURE);

    // Field swap, same row and table: the seed's ciphertext in the secret's column.
    const c = (await createCredential(owner(), { clientId: acme, type: "LOGIN", name: "Row C", secret: { password: "c-pw" }, totp: TOTP_SEED })).id;
    const seed = (await f.platform.credentialSecret.findFirstOrThrow({ where: { credentialId: c }, omit: { totpSecretCiphertext: false } }))
      .totpSecretCiphertext;
    await f.platform.credentialSecret.update({ where: { credentialId: c }, data: { secretCiphertext: seed! } });
    await expect(revealCredentialField(owner(), c, "password")).rejects.toThrow(GCM_FAILURE);

    // Tenant swap: the other tenant's own credential, given ours. (Its DEK
    // differs too, so this proves the pair — key AND AAD — not the AAD's
    // tenant term alone; two tenants never share a DEK by construction.)
    const theirs = (
      await createCredential({ tenantId: other.tenantId, actor: actorFor(other.seats.owner.memberId) }, { type: "LOGIN", name: "Theirs", secret: { password: "t-pw" } })
    ).id;
    await other.platform.credentialSecret.update({ where: { credentialId: theirs }, data: { secretCiphertext: await secretOf(a) } });
    await expect(
      revealCredentialField({ tenantId: other.tenantId, actor: actorFor(other.seats.owner.memberId) }, theirs, "password"),
    ).rejects.toThrow(GCM_FAILURE);

    // Nothing was recorded as revealed for any of the failures.
    expect(await audits("credential.revealed", b)).toEqual([]);
    expect(await audits("credential.revealed", c)).toEqual([]);
  }, 90_000);
});

describe("what the database itself refuses", () => {
  it("a contact principal reads 0 rows of the secret, its history and the (INTERNAL) metadata, and can write none", async () => {
    const id = (await createCredential(owner(), { clientId: acme, type: "LOGIN", name: "Contact probe", secret: { password: PASSWORD } })).id;
    await replaceCredentialSecret(owner(), id, { secret: { password: NEW_PASSWORD } });
    const contact = { type: "contact", id: randomUUID(), clientId: acme } as const;
    await withTenant(f.tenantId, contact, async (tx) => {
      expect(await tx.credentialSecret.count()).toBe(0);
      expect(await tx.credentialVersion.count()).toBe(0);
      expect(await tx.credentialItem.count()).toBe(0);
      const raw = await tx.$queryRaw<{ n: number }[]>`
        SELECT (SELECT count(*) FROM credential_secret)::int + (SELECT count(*) FROM credential_version)::int AS n`;
      expect(raw[0]?.n).toBe(0);
    });
    const RLS = /row-level security/;
    await expect(
      withTenant(f.tenantId, contact, (tx) =>
        tx.credentialItem.create({ data: { tenantId: f.tenantId, clientId: acme, type: "LOGIN", name: "planted" }, select: { id: true } }),
      ),
    ).rejects.toThrow(RLS);
    const v2 = await withTenant(f.tenantId, { type: "system" }, (tx) =>
      encryptFieldV2(tx, { tenantId: f.tenantId, model: "credential_version", rowId: "planted", field: "secret" }, "x"),
    );
    await expect(
      withTenant(f.tenantId, contact, (tx) =>
        tx.credentialVersion.create({ data: { tenantId: f.tenantId, credentialId: id, version: 99, secretCiphertext: v2 }, select: { id: true } }),
      ),
    ).rejects.toThrow(RLS);
    // The rows are invisible to the contact, so an UPDATE or DELETE finds nothing.
    expect(await withTenant(f.tenantId, contact, (tx) => tx.$executeRaw`UPDATE credential_secret SET version = version + 1 WHERE credential_id = ${id}`)).toBe(0);
    expect(await withTenant(f.tenantId, contact, (tx) => tx.$executeRaw`DELETE FROM credential_secret WHERE credential_id = ${id}`)).toBe(0);
    expect(await f.platform.credentialSecret.count({ where: { credentialId: id } })).toBe(1);
  });

  it("the policies themselves are pinned: portal_deny on the secret tables, the two-term gate on the metadata", async () => {
    const rows = await f.platform.$queryRaw<{ tablename: string; policyname: string; permissive: string; cmd: string; qual: string | null }[]>`
      SELECT tablename::text, policyname::text, permissive, cmd, qual FROM pg_policies
       WHERE schemaname = 'public' AND tablename IN ('credential_secret', 'credential_version', 'credential_item')
       ORDER BY tablename, policyname`;
    const of = (t: string, name: string) => rows.find((r) => r.tablename === t && r.policyname === name);
    for (const t of ["credential_secret", "credential_version"]) {
      expect(rows.filter((r) => r.tablename === t).map((r) => r.policyname)).toEqual(["portal_deny", "tenant_isolation"]);
      const deny = of(t, "portal_deny");
      expect(deny).toMatchObject({ permissive: "RESTRICTIVE", cmd: "ALL" });
      // The whole condition, normalised: the principal is not a contact — nothing OR'd on.
      expect((deny?.qual ?? "").replace(/\s+/g, " ").replace(/[()]/g, "").trim()).toBe(
        "SELECT current_setting'app.principal'::text, true AS current_setting IS DISTINCT FROM 'contact'::text",
      );
    }
    const gate = of("credential_item", "portal_gate");
    expect(gate).toMatchObject({ permissive: "RESTRICTIVE", cmd: "ALL" });
    expect(gate?.qual).toContain("app.client_id");
    expect(gate?.qual).toContain("CLIENT_VISIBLE");
    expect(rows.filter((r) => r.tablename === "credential_item" && r.permissive === "PERMISSIVE").map((r) => r.policyname)).toEqual([
      "tenant_isolation",
    ]);
  });

  it("CLIENT_VISIBLE needs a client (the agency's own logins are never shown), and a plaintext can never sit in a ciphertext column", async () => {
    const id = (await createCredential(owner(), { clientId: acme, type: "LOGIN", name: "Belts", secret: { password: PASSWORD } })).id;
    // Slice 91 dropped `credential_item_internal_only` by name (C52 (d)): a
    // client's login may be shown to them — and put back.
    await f.platform.credentialItem.update({ where: { id }, data: { visibility: "CLIENT_VISIBLE" } });
    await f.platform.credentialItem.update({ where: { id }, data: { visibility: "INTERNAL" } });
    const own = (await createCredential(owner(), { type: "LOGIN", name: "Our own belt", secret: { password: PASSWORD } })).id;
    await expect(f.platform.credentialItem.update({ where: { id: own }, data: { visibility: "CLIENT_VISIBLE" } })).rejects.toThrow(
      /credential_item_client_visible_needs_client/,
    );
    await expect(f.platform.credentialSecret.update({ where: { credentialId: id }, data: { secretCiphertext: PASSWORD } })).rejects.toThrow(
      /credential_secret_is_v2/,
    );
    await expect(
      f.platform.credentialSecret.update({ where: { credentialId: id }, data: { totpSecretCiphertext: `v2.k1.t1.${TOTP_SEED}` } }),
    ).rejects.toThrow(/credential_secret_totp_is_v2/);
  });
});

describe("no plaintext anywhere: a dump of the tenant, and the logs", () => {
  it("every tenant-scoped table and the audit trail hold none of the secrets, old secrets or the seed", async () => {
    const tables = await f.platform.$queryRaw<{ table_name: string }[]>`
      SELECT c.table_name FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'
       ORDER BY c.table_name`;
    expect(tables.map((t) => t.table_name)).toEqual(expect.arrayContaining(["credential_item", "credential_secret", "credential_version", "audit_event"]));
    let scanned = 0;
    for (const { table_name } of tables) {
      if (!/^[a-z_]+$/.test(table_name)) throw new Error(`unexpected table name ${table_name}`);
      const rows = await f.platform.$queryRawUnsafe<{ j: string }[]>(
        `SELECT row_to_json(t)::text AS j FROM "${table_name}" t WHERE t.tenant_id = $1`,
        f.tenantId,
      );
      for (const { j } of rows) {
        scanned += 1;
        for (const p of PLAINTEXTS) expect(j.includes(p), `${table_name} holds a plaintext`).toBe(false);
      }
    }
    // The dump is not vacuous: the vault's own rows were in it.
    expect(scanned).toBeGreaterThan(20);
    expect(await f.platform.credentialSecret.count({ where: { tenantId: f.tenantId } })).toBeGreaterThan(5);
  }, 120_000);

  it("no console output carries a value — on success, on a refusal, or on a failed decrypt", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const errors: string[] = [];
    const render = (args: unknown[]) => args.map((a) => (a instanceof Error ? `${a.message}${a.stack}` : String(a))).join(" ");
    let logged: string[] = [];
    try {
      // The instrument proves it is listening (the code review found the
      // first version read the calls AFTER mockRestore had cleared them).
      console.warn(`canary-${RUN}`);
      const id = (await createCredential(owner(), { clientId: acme, type: "LOGIN", name: "Scrubbed", secret: { password: PASSWORD }, totp: TOTP_SEED })).id;
      await revealCredentialField(owner(), id, "password");
      await generateCredentialTotp(owner(), id);
      await replaceCredentialSecret(owner(), id, { secret: { password: NEW_PASSWORD } });
      await outcome(revealCredentialField(withActor(noMfa(f.seats.manager.memberId)), id, "password"));
      const [v] = await f.platform.credentialVersion.findMany({ where: { credentialId: id }, omit: { secretCiphertext: false } });
      await f.platform.credentialSecret.update({ where: { credentialId: id }, data: { secretCiphertext: v!.secretCiphertext } });
      try {
        await revealCredentialField(owner(), id, "password");
      } catch (e) {
        errors.push(String(e), e instanceof Error ? (e.stack ?? "") : "");
      }
      // Copied BEFORE the spies are restored: `mockRestore` clears `mock.calls`.
      logged = spies.flatMap((sp) => sp.mock.calls.map(render));
    } finally {
      for (const sp of spies) sp.mockRestore();
    }
    expect(logged.some((l) => l.includes(`canary-${RUN}`))).toBe(true);
    for (const text of [...logged, ...errors]) {
      for (const p of PLAINTEXTS) expect(text.includes(p)).toBe(false);
    }
    expect(errors.length).toBeGreaterThan(0); // the failed decrypt did fail
  }, 90_000);
});

describe("the door — the whole vault is locked, the list included (C52 (a))", () => {
  let inside: string;

  beforeAll(async () => {
    inside = (await createCredential(owner(), { clientId: acme, type: "LOGIN", name: "Behind the door", username: "door@acme.test", secret: { password: "d-pw" } })).id;
  }, 60_000);

  // Every metadata service, as one list, so a verb added later without the
  // door is a missing row here rather than a hole nobody noticed.
  const everyVerb = (ctx: ReturnType<typeof withActor>) => [
    ["openVault", () => openVault(ctx)],
    ["list", () => listCredentials(ctx, { clientId: acme })],
    ["listAll", () => listAllCredentials(ctx)],
    ["index", () => vaultIndex(ctx)],
    ["get", () => getCredential(ctx, inside)],
    ["create", () => createCredential(ctx, { clientId: acme, type: "LOGIN", name: "Should not exist", secret: { password: "x" } })],
    ["update", () => updateCredential(ctx, inside, { name: "Renamed through a stale door" })],
    ["replaceSecret", () => replaceCredentialSecret(ctx, inside, { secret: { password: "y" } })],
    ["delete", () => deleteCredential(ctx, inside)],
  ] as const;

  it("a factor older than vault.stepUpMinutes is MFA_REQUIRED:step_up on every verb, and nothing is written", async () => {
    const stale: MemberActor = { memberId: f.seats.owner.memberId, mfa: { enrolled: true, verifiedAt: minutesAgo(12) } };
    const before = await f.audits("credential.created");
    for (const [verb, call] of everyVerb(withActor(stale))) {
      expect(`${verb}:${await outcome(call())}`).toBe(`${verb}:MFA_REQUIRED:step_up`);
    }
    expect((await f.audits("credential.created")).length).toBe(before.length);
    expect((await audits("credential.updated", inside)).length).toBe(0);
    expect((await audits("credential.deleted", inside)).length).toBe(0);
    expect((await getCredential(owner(), inside)).name).toBe("Behind the door");
  });

  it("no factor at all is MFA_REQUIRED:enrol on every verb — and an employee who may view must set one up", async () => {
    for (const [verb, call] of everyVerb(withActor(noMfa(f.seats.manager.memberId)))) {
      expect(`${verb}:${await outcome(call())}`).toBe(`${verb}:MFA_REQUIRED:enrol`);
    }
    // The employee holds view and create only; the verbs they do not hold
    // stay FORBIDDEN — the permission is answered first.
    const employeeNoFactor = withActor(noMfa(f.seats.employee.memberId));
    expect(await outcome(listCredentials(employeeNoFactor, { clientId: acme }))).toBe("MFA_REQUIRED:enrol");
    expect(await outcome(deleteCredential(employeeNoFactor, inside))).toBe("FORBIDDEN");
  });

  it("impersonation never enters, even with a fresh factor", async () => {
    const imp: MemberActor = { ...actorFor(f.seats.owner.memberId), impersonated: true };
    for (const [verb, call] of everyVerb(withActor(imp))) {
      expect(`${verb}:${await outcome(call())}`).toBe(`${verb}:FORBIDDEN`);
    }
  });

  it("the permission is answered before the factor — a closed module is never 'come back with a code'", async () => {
    const stale: MemberActor = { memberId: f.seats.owner.memberId, mfa: { enrolled: true, verifiedAt: minutesAgo(12) } };
    await setModuleEnabled(owner(), "vault", false);
    try {
      expect(await outcome(openVault(withActor(stale)))).toBe("DISABLED_BY_TENANT");
      expect(await outcome(listCredentials(withActor(stale), { clientId: acme }))).toBe("DISABLED_BY_TENANT");
    } finally {
      await setModuleEnabled(owner(), "vault", true);
    }
  });

  it("the window follows the tenant's setting, and openVault says when it closes", async () => {
    await updatePreferences(owner(), { vault: { stepUpMinutes: 5 } });
    try {
      const at7: MemberActor = { memberId: f.seats.manager.memberId, mfa: { enrolled: true, verifiedAt: minutesAgo(7) } };
      expect(await outcome(listCredentials(withActor(at7), { clientId: acme }))).toBe("MFA_REQUIRED:step_up");
      const at3 = minutesAgo(3);
      const open = await openVault(withActor({ memberId: f.seats.manager.memberId, mfa: { enrolled: true, verifiedAt: at3 } }));
      expect(open.locksAt.getTime()).toBe(at3.getTime() + 5 * 60_000);
    } finally {
      await updatePreferences(owner(), { vault: { stepUpMinutes: 10 } });
    }
  });

  it("openVault draws exactly the controls each template's services accept", async () => {
    // `share` (slice 90): `credential:share` ✦ AND `credential:reveal` ✦, with share links on.
    // `showToClient` / `hideFromClient` (slice 91): `credential:change_visibility` ✦ (C A);
    // showing also needs client logins on, which this file's tenant never switches on.
    // `unseal` (slice 92): `credential:unseal` ✦ — the owner's alone (C52 (e), C60 (b)).
    const none = { showToClient: false, hideFromClient: false, unseal: false };
    expect((await openVault(owner())).can).toEqual({ create: true, edit: true, delete: true, reveal: true, share: true, showToClient: false, hideFromClient: true, unseal: true });
    expect((await openVault(manager())).can).toEqual({ create: true, edit: true, delete: true, reveal: true, share: true, ...none });
    expect((await openVault(admin())).can).toEqual({ create: true, edit: true, delete: false, reveal: true, share: true, showToClient: false, hideFromClient: true, unseal: false });
    expect((await openVault(employee())).can).toEqual({ create: true, edit: false, delete: false, reveal: false, share: false, ...none });
    expect((await openVault(owner())).shareMaxHours).toBe(168);
    await updatePreferences(owner(), { vault: { allowExternalShareLinks: false } });
    try {
      expect((await openVault(owner())).can.share).toBe(false);
    } finally {
      await updatePreferences(owner(), { vault: { allowExternalShareLinks: true } });
    }
    await updatePreferences(owner(), { vault: { allowPortalCredentials: true } });
    try {
      expect((await openVault(owner())).can.showToClient).toBe(true);
      expect((await openVault(manager())).can.showToClient).toBe(false);
    } finally {
      await updatePreferences(owner(), { vault: { allowPortalCredentials: false } });
    }
  });
});

describe("the tenant-wide list is capped — our own first, then clients by name (slice 86)", () => {
  it(`stops at VAULT_LIST_LIMIT (${VAULT_LIST_LIMIT}) and says so; the index still counts every row`, async () => {
    // On the OTHER tenant, so no list or count in this file moves. Metadata
    // rows only, inserted directly: a list never reads a secret.
    const t = other.tenantId;
    const ownerOfOther = { tenantId: t, actor: actorFor(other.seats.owner.memberId) };
    const before = (await vaultIndex(ownerOfOther)).agency ?? 0;
    // Two ids, the SMALLER one Zeta's: ordering by client id instead of by
    // name would put Zeta first and fail, every run (code review).
    const [zeta, alpha] = [randomUUID(), randomUUID()].sort();
    if (!zeta || !alpha) throw new Error("two ids");
    await other.platform.client.createMany({
      data: [
        { id: zeta, tenantId: t, name: "Zeta" },
        { id: alpha, tenantId: t, name: "Alpha" },
      ],
    });
    const fill = VAULT_LIST_LIMIT - 2 - before;
    try {
      await other.platform.credentialItem.createMany({
        data: [
          ...Array.from({ length: fill }, (_, i) => ({ tenantId: t, type: "LOGIN" as const, name: `Cap own ${String(i).padStart(3, "0")}` })),
          { tenantId: t, clientId: zeta, type: "LOGIN" as const, name: "Cap Aaa" },
          { tenantId: t, clientId: alpha, type: "LOGIN" as const, name: "Cap Alpha 1" },
          { tenantId: t, clientId: alpha, type: "LOGIN" as const, name: "Cap Alpha 2" },
        ],
      });
      const { rows, cut } = await listAllCredentials(ownerOfOther);
      expect(rows).toHaveLength(VAULT_LIST_LIMIT);
      // Answered by the read itself (one row past the cap), not by a count —
      // and it names where: Zeta's login is the first row left out.
      expect(cut).toEqual({ clientId: zeta });
      // Our own fill all but the last two places; the clients follow by
      // CLIENT name — Alpha's two, though Zeta's login ("Cap Aaa") sorts
      // first by its own name and Zeta's id sorts first too.
      expect(rows.slice(0, VAULT_LIST_LIMIT - 2).every((r) => r.clientId === null)).toBe(true);
      expect(rows.slice(VAULT_LIST_LIMIT - 2).map((r) => r.name)).toEqual(["Cap Alpha 1", "Cap Alpha 2"]);
      const index = await vaultIndex(ownerOfOther);
      expect(index.agency).toBe(before + fill);
      expect(index.clients).toEqual([
        { id: alpha, name: "Alpha", count: 2 },
        { id: zeta, name: "Zeta", count: 1 },
      ]);
      // One anchor is never capped: Zeta's own list has its row.
      expect((await listCredentials(ownerOfOther, { clientId: zeta })).map((r) => r.name)).toEqual(["Cap Aaa"]);
      // Exactly at the cap is not cut: remove Zeta's row and the 200 fit.
      await other.platform.credentialItem.deleteMany({ where: { tenantId: t, clientId: zeta } });
      const exact = await listAllCredentials(ownerOfOther);
      expect(exact.cut).toBeNull();
      expect(exact.rows).toHaveLength(VAULT_LIST_LIMIT);
      // Our own alone filling the cap: the clients' read takes the one row
      // past it, so the cut is Alpha's — and our own card is whole.
      await other.platform.credentialItem.createMany({
        data: [0, 1].map((i) => ({ tenantId: t, type: "LOGIN" as const, name: `Cap own extra ${i}` })),
      });
      const full = await listAllCredentials(ownerOfOther);
      expect(full.rows.every((r) => r.clientId === null)).toBe(true);
      expect(full.cut).toEqual({ clientId: alpha });
      // …and past it: the clients are never read, and the cut is our own.
      await other.platform.credentialItem.create({ data: { tenantId: t, type: "LOGIN", name: "Cap own extra 2" } });
      const over = await listAllCredentials(ownerOfOther);
      expect(over.rows).toHaveLength(VAULT_LIST_LIMIT);
      expect(over.rows.every((r) => r.clientId === null)).toBe(true);
      expect(over.cut).toEqual({ clientId: null });
    } finally {
      await other.platform.credentialItem.deleteMany({ where: { tenantId: t, name: { startsWith: "Cap " } } });
      await other.platform.client.deleteMany({ where: { tenantId: t, id: { in: [zeta, alpha] } } });
    }
  }, 120_000);
});
