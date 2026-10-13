import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { MemberActor } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { defaultFakeCompany, fakeCompanyTenantIdFor, fakeConsent, removeFakeCompany, setFakeCompany } from "@/integrations/fortnox/fake";
import { DomainError } from "@/lib/domain-error";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { INTEGRATION_CONNECTED_MAIL, INTEGRATION_DISCONNECTED_MAIL } from "@/notify/integration-mail-keys";
import { resetLocalLimiter } from "@/ratelimit";

import {
  beginFortnoxConnect,
  checkFortnox,
  completeFortnoxConnect,
  disconnectFortnox,
  readFortnoxCard,
} from "./fortnox-connection";

/**
 * THE DIRECT FORTNOX CONNECTION, part 1 — connecting — against the real
 * database and the FAKE Fortnox (Phase 4 slice 114; founder decision C89;
 * the design's §4 as amended by §10):
 *   - only an owner (`invoice:connect_bookkeeping` ✦) with a code a minute
 *     old connects or disconnects; never under impersonation;
 *   - the callback spends the attempt ONCE, of this member, and connects only
 *     a SERVICE consent of the company whose org. number is the workspace's;
 *     every refusal is the attempt's outcome, audited;
 *   - one live connection per workspace, and one live per Fortnox company
 *     across every workspace;
 *   - a BROKEN connection to the same company is reconnected in place;
 *   - every owner mailed at a connect and a disconnect;
 *   - the database's guards hold the rules on the runtime role;
 *   - "Is Fortnox ready?" reads the company and writes nothing.
 */

const ORG = "556677-8899";

let f: Awaited<ReturnType<typeof setupTenant>>;
let g: Awaited<ReturnType<typeof setupTenant>>;
/** The first connect's state and attempt — replayed later. */
let firstWalk: { state: string; attemptId: string };
const owner = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.owner.memberId) });
const ctxOf = (memberId: string, tenantId = f.tenantId) => ({ tenantId, actor: actorFor(memberId) });
/** A factor verified `seconds` ago. */
const aged = (memberId: string, seconds: number) => ({
  tenantId: f.tenantId,
  actor: { memberId, mfa: { enrolled: true, verifiedAt: new Date(Date.now() - seconds * 1000) } } satisfies MemberActor,
});

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

/**
 * A raw write's refusal by its GUARD's token — read from the error's META,
 * never its message (outside production Prisma prints the CALLER'S SOURCE in
 * the message, so a token in an assertion would match itself — memory
 * `prisma-code-frame-trap`).
 */
const guard = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    const meta = JSON.stringify((e as { meta?: unknown }).meta ?? {});
    for (const token of ["INTEGRATION_CONNECTION_GUARD", "INTEGRATION_CONNECT_ATTEMPT_GUARD"]) if (meta.includes(token)) return token;
    if (meta.includes("integration_connection_live_per_workspace")) return "live_per_workspace";
    // No DELETE grant at all on the runtime role: the database refuses before any trigger.
    if (meta.includes("permission denied")) return "permission denied";
    if (meta.includes("integration_connection_broken")) return "check:broken";
    throw e;
  }
};

/** Press Connect, approve at the fake Fortnox, and come back — the whole walk. */
async function connectWalk(
  ctx: { tenantId: string; actor: MemberActor },
  opts: { readonly company?: string; readonly deny?: boolean } = {},
): Promise<{ state: string; result: Awaited<ReturnType<typeof completeFortnoxConnect>> }> {
  const { url } = await beginFortnoxConnect(ctx);
  const q = new URL(url).searchParams;
  const state = q.get("state")!;
  const answer = fakeConsent({
    companyTenantId: opts.company ?? q.get("company")!,
    name: q.get("name")!,
    orgNr: q.get("org")!,
    codeChallenge: q.get("code_challenge")!,
  });
  const result = await completeFortnoxConnect(ctx, {
    state,
    code: "code" in answer ? answer.code : null,
    error: "error" in answer ? answer.error : null,
  });
  return { state, result };
}

const live = (tenantId = f.tenantId) =>
  f.platform.integrationConnection.findFirst({ where: { tenantId, status: { not: "DISCONNECTED" } } });

/** Mark the live connection BROKEN as the nightly send would (slice 114b's upkeep path). */
async function breakIt(kind: string) {
  await withTenant(f.tenantId, { type: "system" }, async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.fortnox_sending', 'on', true)`;
    await tx.$executeRaw`
      UPDATE integration_connection
         SET status = 'BROKEN'::integration_status, broken_since = now(), broken_reason = ${JSON.stringify({ kind })}::jsonb
       WHERE tenant_id = ${f.tenantId} AND status <> 'DISCONNECTED'`;
  });
}

beforeAll(async () => {
  f = await setupTenant("fnx");
  g = await setupTenant("fnxb");
  // The company cards: the org. number Fortnox's company must match.
  await f.platform.tenant.update({ where: { id: f.tenantId }, data: { legalName: "Fnx AB", orgNr: ORG } });
  await g.platform.tenant.update({ where: { id: g.tenantId }, data: { legalName: "Fnx B AB", orgNr: ORG } });
}, 180_000);

beforeEach(() => {
  // Ten connects an hour per member is the floor; this suite connects more.
  resetLocalLimiter();
});

afterAll(async () => {
  removeFakeCompany(f ? fakeCompanyTenantIdFor(f.tenantId) : "");
  removeFakeCompany(g ? fakeCompanyTenantIdFor(g.tenantId) : "");
  for (const t of [f, g]) {
    if (!t) continue;
    await t.platform.emailOutbox.deleteMany({ where: { tenantId: t.tenantId } });
    await t.platform.tenantPreference.deleteMany({ where: { tenantId: t.tenantId } });
    await t.cleanup();
  }
}, 180_000);

describe("who may connect (C89 (d))", () => {
  it("the card reads for settings:view; only the owner may connect; an admin may check", async () => {
    const card = await readFortnoxCard(owner());
    expect(card).toMatchObject({ available: true, canConnect: true, canCheck: true, connection: null, outcome: null });
    const admin = await readFortnoxCard(ctxOf(f.seats.admin.memberId));
    expect(admin).toMatchObject({ canConnect: false, canCheck: true });
    expect(await outcome(readFortnoxCard(ctxOf(f.seats.employee.memberId)))).toBe("FORBIDDEN");
  });

  it("Connect wants the owner's code of a minute ago, never an admin, never impersonation", async () => {
    expect(await outcome(beginFortnoxConnect(aged(f.seats.owner.memberId, 120)))).toBe("MFA_REQUIRED");
    expect(await outcome(beginFortnoxConnect(ctxOf(f.seats.admin.memberId)))).toBe("FORBIDDEN");
    expect(await outcome(beginFortnoxConnect({ tenantId: f.tenantId, actor: { ...actorFor(f.seats.owner.memberId), impersonated: true } }))).toBe(
      "FORBIDDEN",
    );
    expect(await f.platform.integrationConnectAttempt.count({ where: { tenantId: f.tenantId } })).toBe(0);
  });

  it("Connect wants an org. number on the company card", async () => {
    await f.platform.tenant.update({ where: { id: f.tenantId }, data: { orgNr: null } });
    try {
      expect(await outcome(beginFortnoxConnect(owner()))).toBe("FORTNOX_NO_ORG_NR");
    } finally {
      await f.platform.tenant.update({ where: { id: f.tenantId }, data: { orgNr: ORG } });
    }
  });
});

describe("connecting", () => {
  it("a press writes an attempt — the state's hash and the verifier — audited, and answers the consent screen", async () => {
    const { url } = await beginFortnoxConnect(owner());
    const q = new URL(url).searchParams;
    expect(new URL(url).pathname).toBe("/settings/invoicing/fortnox/fake-consent");
    expect(q.get("company")).toBe(fakeCompanyTenantIdFor(f.tenantId));
    const attempt = await f.platform.integrationConnectAttempt.findFirstOrThrow({ where: { tenantId: f.tenantId }, orderBy: { createdAt: "desc" } });
    expect(attempt.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(attempt.stateHash).not.toBe(q.get("state"));
    expect(attempt.pkceVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(attempt.expiresAt.getTime() - attempt.createdAt.getTime()).toBe(10 * 60_000);
    expect(attempt.usedAt).toBeNull();
    expect((await f.audits("integration.connect_started")).some((a) => a.targetId === attempt.id)).toBe(true);
  });

  it("the walk connects: ACTIVE, the fake's tags, the workspace's org. number, the first night tomorrow — audited without the org. number, every owner mailed", async () => {
    const { state, result } = await connectWalk(owner());
    firstWalk = { state, attemptId: result.attemptId! };
    expect(result.outcome).toBe("CONNECTED");
    const row = await live();
    expect(row).toMatchObject({
      status: "ACTIVE",
      transport: "fake",
      appClientId: "fortleva-fake",
      externalTenantId: fakeCompanyTenantIdFor(f.tenantId),
      companyName: "Fnx AB",
      companyOrgNr: ORG,
      connectedByMemberId: f.seats.owner.memberId,
      connectAttemptId: result.attemptId,
    });
    // The connect day in the workspace's zone — within a day of UTC's (S5: the first night is the next).
    const day = Date.parse(`${row!.lastNight!.toISOString().slice(0, 10)}T00:00:00Z`);
    expect(Math.abs(day - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`))).toBeLessThanOrEqual(86_400_000);
    const attempt = await f.platform.integrationConnectAttempt.findUniqueOrThrow({ where: { id: result.attemptId! } });
    expect(attempt).toMatchObject({ outcome: "CONNECTED", pkceVerifier: null });
    expect(attempt.usedAt).not.toBeNull();
    const connected = (await f.audits("integration.connected")).at(-1);
    expect(connected?.metadata).toEqual({ provider: "FORTNOX", externalTenantId: fakeCompanyTenantIdFor(f.tenantId) });
    expect(JSON.stringify(connected?.metadata)).not.toContain("556677");
    expect(await f.platform.emailOutbox.count({ where: { tenantId: f.tenantId, kind: INTEGRATION_CONNECTED_MAIL } })).toBe(1);

    // The card names the company; the outcome only for the owner who pressed it.
    const card = await readFortnoxCard(owner(), { attemptId: result.attemptId });
    expect(card.connection).toMatchObject({ status: "ACTIVE", companyName: "Fnx AB", companyOrgNr: ORG, foreign: false });
    expect(card.outcome?.outcome).toBe("CONNECTED");
    expect((await readFortnoxCard(ctxOf(f.seats.admin.memberId), { attemptId: result.attemptId })).outcome).toBeNull();
  });

  it("a state is spent once; another member's, or an unknown one, finds nothing", async () => {
    // A second press while connected is refused before Fortnox.
    expect(await outcome(beginFortnoxConnect(owner()))).toBe("FORTNOX_ALREADY_CONNECTED");
    const attemptsBefore = await f.platform.integrationConnectAttempt.count({ where: { tenantId: f.tenantId } });
    // The SAME callback again — a refresh, a replay: EXPIRED, the first outcome untouched.
    expect(await completeFortnoxConnect(owner(), { state: firstWalk.state, code: "c".repeat(20), error: null })).toEqual({
      attemptId: null,
      outcome: "EXPIRED",
    });
    expect((await f.platform.integrationConnectAttempt.findUniqueOrThrow({ where: { id: firstWalk.attemptId } })).outcome).toBe("CONNECTED");
    // Another member never finishes it.
    expect(await outcome(completeFortnoxConnect(ctxOf(f.seats.admin.memberId), { state: firstWalk.state, code: null, error: null }))).toBe("FORBIDDEN");
    expect(await completeFortnoxConnect(owner(), { state: "x".repeat(43), code: "c".repeat(20), error: null })).toEqual({
      attemptId: null,
      outcome: "EXPIRED",
    });
    expect(await completeFortnoxConnect(owner(), { state: "not-a-state", code: null, error: null })).toEqual({ attemptId: null, outcome: "EXPIRED" });
    expect(await f.platform.integrationConnectAttempt.count({ where: { tenantId: f.tenantId } })).toBe(attemptsBefore);
  });

  it("is the kill switch: Disconnect wants the code, keeps the row as history, audits and mails every owner", async () => {
    expect(await outcome(disconnectFortnox(aged(f.seats.owner.memberId, 120)))).toBe("MFA_REQUIRED");
    expect(await outcome(disconnectFortnox(ctxOf(f.seats.admin.memberId)))).toBe("FORBIDDEN");
    await disconnectFortnox(owner());
    expect(await live()).toBeNull();
    const gone = await f.platform.integrationConnection.findFirstOrThrow({ where: { tenantId: f.tenantId }, orderBy: { createdAt: "desc" } });
    expect(gone).toMatchObject({ status: "DISCONNECTED", disconnectedByMemberId: f.seats.owner.memberId });
    expect((await f.audits("integration.disconnected")).length).toBe(1);
    expect(await f.platform.emailOutbox.count({ where: { tenantId: f.tenantId, kind: INTEGRATION_DISCONNECTED_MAIL } })).toBe(1);
    expect(await outcome(disconnectFortnox(owner()))).toBe("FORTNOX_NOT_CONNECTED");
  });
});

describe("what does not connect — each the attempt's outcome, audited", () => {
  const refusedReasons = async () => (await f.audits("integration.connect_refused")).map((a) => (a.metadata as { reason: string }).reason);

  it("another company's org. number: ORG_MISMATCH, naming the company it met", async () => {
    const company = fakeCompanyTenantIdFor(f.tenantId);
    setFakeCompany({ ...defaultFakeCompany(company, "Someone Else AB", "559999-0006") });
    try {
      const { result } = await connectWalk(owner());
      expect(result.outcome).toBe("ORG_MISMATCH");
      const card = await readFortnoxCard(owner(), { attemptId: result.attemptId });
      expect(card.outcome).toEqual({ outcome: "ORG_MISMATCH", seenCompanyName: "Someone Else AB", seenOrgNr: "559999-0006" });
      expect(await live()).toBeNull();
      expect(await refusedReasons()).toContain("ORG_MISMATCH");
    } finally {
      removeFakeCompany(company);
    }
  });

  it("a person's consent, a refusal at Fortnox, no licence: NOT_SERVICE, DENIED, NO_LICENCE", async () => {
    const company = fakeCompanyTenantIdFor(f.tenantId);
    const base = defaultFakeCompany(company, "Fnx AB", ORG);
    try {
      setFakeCompany({ ...base, serviceAccount: false });
      expect((await connectWalk(owner())).result.outcome).toBe("NOT_SERVICE");
      setFakeCompany({ ...base, denies: true });
      expect((await connectWalk(owner())).result.outcome).toBe("DENIED");
      setFakeCompany({ ...base, licence: false });
      expect((await connectWalk(owner())).result.outcome).toBe("NO_LICENCE");
      expect(await live()).toBeNull();
      expect(await refusedReasons()).toEqual(expect.arrayContaining(["NOT_SERVICE", "DENIED", "NO_LICENCE"]));
    } finally {
      removeFakeCompany(company);
    }
  });

  it("a token whose own claim names another company: FAILED", async () => {
    const company = fakeCompanyTenantIdFor(f.tenantId);
    setFakeCompany({ ...defaultFakeCompany(company, "Fnx AB", ORG), claimOverride: "90000000001" });
    try {
      expect((await connectWalk(owner())).result.outcome).toBe("FAILED");
      expect(await live()).toBeNull();
    } finally {
      removeFakeCompany(company);
    }
  });

  it("one live connection per Fortnox company, across workspaces: ELSEWHERE", async () => {
    // Workspace B connects its own fake company…
    const companyB = fakeCompanyTenantIdFor(g.tenantId);
    const b = { tenantId: g.tenantId, actor: actorFor(g.seats.owner.memberId) };
    expect((await connectWalk(b)).result.outcome).toBe("CONNECTED");
    // …and then workspace A's administrator approves the SAME company for A.
    const { result } = await connectWalk(owner(), { company: companyB });
    expect(result.outcome).toBe("ELSEWHERE");
    expect(await live()).toBeNull();
    expect(await refusedReasons()).toContain("ELSEWHERE");
    await disconnectFortnox(b);
  });
});

describe("two connects at once (the code review's 5)", () => {
  it("the second to come back finds the first's connection: ALREADY, nothing written twice", async () => {
    // Both pressed while nothing is connected…
    const pressA = await beginFortnoxConnect(owner());
    const pressB = await beginFortnoxConnect(owner());
    const finish = async (url: string) => {
      const q = new URL(url).searchParams;
      const answer = fakeConsent({ companyTenantId: q.get("company")!, name: q.get("name")!, orgNr: q.get("org")!, codeChallenge: q.get("code_challenge")! });
      if (!("code" in answer)) throw new Error("expected a code");
      return completeFortnoxConnect(owner(), { state: q.get("state"), code: answer.code, error: null });
    };
    // …and both approved at Fortnox.
    expect((await finish(pressA.url)).outcome).toBe("CONNECTED");
    expect((await finish(pressB.url)).outcome).toBe("ALREADY");
    expect(await f.platform.integrationConnection.count({ where: { tenantId: f.tenantId, status: { not: "DISCONNECTED" } } })).toBe(1);
    await disconnectFortnox(owner());
  });
});

describe("a stopped connection to the same company is reconnected in place (R2, S3)", () => {
  it("BROKEN → Connect again → RECONNECTED: the same row, ACTIVE, its breakage gone", async () => {
    expect((await connectWalk(owner())).result.outcome).toBe("CONNECTED");
    const before = (await live())!;
    await breakIt("CONSENT_GONE");
    expect((await readFortnoxCard(owner())).connection).toMatchObject({ status: "BROKEN", brokenKind: "CONSENT_GONE" });
    const { result } = await connectWalk(owner());
    expect(result.outcome).toBe("RECONNECTED");
    const after = (await live())!;
    expect(after.id).toBe(before.id);
    expect(after).toMatchObject({ status: "ACTIVE", brokenSince: null, brokenReason: null, connectAttemptId: result.attemptId });
    expect((await f.audits("integration.reconnected")).length).toBe(1);
  });

  it("a BROKEN connection is never moved to another company: OTHER_COMPANY", async () => {
    await breakIt("CONSENT_GONE");
    const elsewhere = "91234567890";
    setFakeCompany(defaultFakeCompany(elsewhere, "Fnx AB", ORG));
    try {
      expect((await connectWalk(owner(), { company: elsewhere })).result.outcome).toBe("OTHER_COMPANY");
      expect((await live())?.externalTenantId).toBe(fakeCompanyTenantIdFor(f.tenantId));
    } finally {
      removeFakeCompany(elsewhere);
    }
    // Back to ACTIVE for what follows.
    expect((await connectWalk(owner())).result.outcome).toBe("RECONNECTED");
  });
});

describe("Is Fortnox ready? — read-only (§4.4)", () => {
  it("asks the company, answers item by item, writes nothing", async () => {
    const auditsBefore = await f.platform.auditEvent.count({ where: { tenantId: f.tenantId } });
    const ready = await checkFortnox(owner());
    expect(ready.ok).toBe(true);
    expect(ready.items.filter((i) => i.key === "account")).toHaveLength(10);
    // An admin may ask (they make the bookkeeping file); an employee may not.
    expect((await checkFortnox(ctxOf(f.seats.admin.memberId))).ok).toBe(true);
    expect(await outcome(checkFortnox(ctxOf(f.seats.employee.memberId)))).toBe("FORBIDDEN");
    expect(await f.platform.auditEvent.count({ where: { tenantId: f.tenantId } })).toBe(auditsBefore);
  });

  it("names what Fortnox lacks: no year, a series not manual, a missing and an inactive account", async () => {
    const company = fakeCompanyTenantIdFor(f.tenantId);
    const base = defaultFakeCompany(company, "Fnx AB", ORG);
    setFakeCompany({ ...base, series: { F: { manual: false } }, missingAccounts: ["3308"], inactiveAccounts: ["2611"] });
    let r = await checkFortnox(owner());
    expect(r.ok).toBe(false);
    expect(r.items).toEqual(
      expect.arrayContaining([
        { key: "series", ok: false, series: "F", problem: "notManual" },
        { key: "account", ok: false, role: "salesEu", account: "3308", problem: "missing" },
        { key: "account", ok: false, role: "vat25", account: "2611", problem: "inactive" },
      ]),
    );
    setFakeCompany({ ...base, years: [] });
    r = await checkFortnox(owner());
    expect(r.items).toEqual(expect.arrayContaining([expect.objectContaining({ key: "year", ok: false })]));
    setFakeCompany({ ...base, consentRevoked: true });
    r = await checkFortnox(owner());
    expect(r.items).toEqual([{ key: "consent", ok: false, problem: "gone" }]);
    setFakeCompany(base);
  });
});

describe("the database holds the rules on the runtime role (migration 20261019090000)", () => {
  const asMember = (memberId: string) => (sql: (tx: TenantDb) => Promise<unknown>) =>
    withTenant(f.tenantId, { type: "member", id: memberId }, sql);

  it("an attempt is started only by a holder of the code, as themselves", async () => {
    const insert = (by: string) =>
      asMember(by)((tx) =>
        tx.$executeRaw`INSERT INTO integration_connect_attempt (id, tenant_id, provider, member_id, state_hash, pkce_verifier, expires_at)
                       VALUES (gen_random_uuid()::text, ${f.tenantId}, 'FORTNOX', ${by}, ${"a".repeat(64)}, ${"v".repeat(43)}, now())`,
      );
    expect(await guard(insert(f.seats.admin.memberId))).toBe("INTEGRATION_CONNECT_ATTEMPT_GUARD");
  });

  it("a connection is made only through an attempt given its outcome in the same transaction", async () => {
    const row = (await live())!;
    // Even the owner, with a spent attempt of an EARLIER transaction, cannot insert one.
    expect(
      await guard(
        asMember(f.seats.owner.memberId)((tx) =>
          tx.$executeRaw`INSERT INTO integration_connection (id, tenant_id, provider, transport, app_client_id, external_tenant_id, company_name,
                                                            company_org_nr, connect_attempt_id, connected_by_member_id, connected_at, last_night)
                         VALUES (gen_random_uuid()::text, ${f.tenantId}, 'FORTNOX', 'fake', 'fortleva-fake', '91111111111', 'X AB',
                                 ${ORG}, ${row.connectAttemptId}, ${f.seats.owner.memberId}, now(), current_date)`,
        ),
      ),
    ).toBe("INTEGRATION_CONNECTION_GUARD");
  });

  it("a member never changes the company, nor anything but a disconnect; the sender only its own columns behind its GUC", async () => {
    const row = (await live())!;
    const ownerSql = asMember(f.seats.owner.memberId);
    expect(
      await guard(ownerSql((tx) => tx.$executeRaw`UPDATE integration_connection SET company_org_nr = '559999-0006' WHERE id = ${row.id}`)),
    ).toBe("INTEGRATION_CONNECTION_GUARD");
    expect(await guard(ownerSql((tx) => tx.$executeRaw`UPDATE integration_connection SET company_name = 'Y AB' WHERE id = ${row.id}`))).toBe(
      "INTEGRATION_CONNECTION_GUARD",
    );
    expect(await guard(ownerSql((tx) => tx.$executeRaw`DELETE FROM integration_connection WHERE id = ${row.id}`))).toBe("permission denied");
    expect(await guard(f.platform.$executeRaw`DELETE FROM integration_connection WHERE id = ${row.id}`)).toBe("INTEGRATION_CONNECTION_GUARD");
    expect(await guard(f.platform.$executeRaw`DELETE FROM integration_connect_attempt WHERE id = ${row.connectAttemptId}`)).toBe(
      "INTEGRATION_CONNECT_ATTEMPT_GUARD",
    );
    // The system principal WITHOUT the sender's GUC writes nothing…
    expect(
      await guard(
        withTenant(f.tenantId, { type: "system" }, (tx) => tx.$executeRaw`UPDATE integration_connection SET last_ok_at = now() WHERE id = ${row.id}`),
      ),
    ).toBe("INTEGRATION_CONNECTION_GUARD");
    // …and WITH it, its own columns only — never a disconnect.
    const sender = (sql: (tx: TenantDb) => Promise<unknown>) =>
      withTenant(f.tenantId, { type: "system" }, async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.fortnox_sending', 'on', true)`;
        return sql(tx);
      });
    expect(await guard(sender((tx) => tx.$executeRaw`UPDATE integration_connection SET last_ok_at = now() WHERE id = ${row.id}`))).toBe("ok");
    // It stops a connection and starts it again — but never one Fortnox no longer accepts (S3).
    const stop = (kind: string) =>
      sender((tx) => tx.$executeRaw`UPDATE integration_connection SET status = 'BROKEN', broken_since = now(), broken_reason = ${JSON.stringify({ kind })}::jsonb WHERE id = ${row.id}`);
    const restart = () =>
      sender((tx) => tx.$executeRaw`UPDATE integration_connection SET status = 'ACTIVE', broken_since = NULL, broken_reason = NULL WHERE id = ${row.id}`);
    expect(await guard(stop("NO_FINANCIAL_YEAR"))).toBe("ok");
    // A kind is a string, or the row is refused (the pre-apply review's 2).
    expect(
      await guard(sender((tx) => tx.$executeRaw`UPDATE integration_connection SET broken_reason = '{"code":"x"}'::jsonb WHERE id = ${row.id}`)),
    ).toBe("check:broken");
    expect(await guard(restart())).toBe("ok");
    expect(await guard(stop("CONSENT_GONE"))).toBe("ok");
    expect(await guard(restart())).toBe("INTEGRATION_CONNECTION_GUARD");
    // …nor by rewriting the reason first and restarting after (the re-check's 3): a stop
    // only a person mends keeps its reason and its start; the upkeep around it still moves.
    expect(
      await guard(sender((tx) => tx.$executeRaw`UPDATE integration_connection SET broken_reason = '{"kind":"NO_FINANCIAL_YEAR"}'::jsonb WHERE id = ${row.id}`)),
    ).toBe("INTEGRATION_CONNECTION_GUARD");
    expect(await guard(sender((tx) => tx.$executeRaw`UPDATE integration_connection SET broken_since = now() - interval '1 day' WHERE id = ${row.id}`))).toBe(
      "INTEGRATION_CONNECTION_GUARD",
    );
    expect(await guard(sender((tx) => tx.$executeRaw`UPDATE integration_connection SET last_ok_at = now() WHERE id = ${row.id}`))).toBe("ok");
    // Back to ACTIVE the way a person does it, for what follows.
    expect((await connectWalk(owner())).result.outcome).toBe("RECONNECTED");
    expect(await guard(sender((tx) => tx.$executeRaw`UPDATE integration_connection SET company_name = 'Z AB' WHERE id = ${row.id}`))).toBe(
      "INTEGRATION_CONNECTION_GUARD",
    );
    expect(
      await guard(
        sender((tx) => tx.$executeRaw`UPDATE integration_connection SET status = 'DISCONNECTED', disconnected_at = now(), disconnected_by_member_id = 'x' WHERE id = ${row.id}`),
      ),
    ).toBe("INTEGRATION_CONNECTION_GUARD");
  });

  it("a disconnected connection is history, and a second live one per workspace is refused", async () => {
    await disconnectFortnox(owner());
    const gone = await f.platform.integrationConnection.findFirstOrThrow({ where: { tenantId: f.tenantId, status: "DISCONNECTED" }, orderBy: { createdAt: "desc" } });
    expect(
      await guard(
        asMember(f.seats.owner.memberId)((tx) => tx.$executeRaw`UPDATE integration_connection SET status = 'ACTIVE', disconnected_at = NULL, disconnected_by_member_id = NULL WHERE id = ${gone.id}`),
      ),
    ).toBe("INTEGRATION_CONNECTION_GUARD");
    // Two live rows for one workspace: the partial unique (written by the platform role, which the guard does not judge).
    expect((await connectWalk(owner())).result.outcome).toBe("CONNECTED");
    const current = (await live())!;
    // A fresh attempt of its own (one connection per attempt is a unique of its own).
    const spare = await f.platform.integrationConnectAttempt.create({
      data: { tenantId: f.tenantId, provider: "FORTNOX", memberId: f.seats.owner.memberId, stateHash: randomBytes(32).toString("hex"), expiresAt: new Date() },
      select: { id: true },
    });
    expect(
      await guard(
        f.platform.$executeRaw`INSERT INTO integration_connection (id, tenant_id, provider, transport, app_client_id, external_tenant_id, company_name,
                                                                  company_org_nr, connect_attempt_id, connected_by_member_id, connected_at, last_night)
                               SELECT gen_random_uuid()::text, tenant_id, provider, transport, app_client_id, '92222222222', company_name,
                                      company_org_nr, ${spare.id}, connected_by_member_id, now(), current_date
                                 FROM integration_connection WHERE id = ${current.id}`,
      ),
    ).toBe("live_per_workspace");
  });
});
