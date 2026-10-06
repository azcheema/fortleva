import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { resetTenantDekCache } from "@/crypto/tenant-key";
import { DomainError } from "@/lib/domain-error";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { reactivateMember, suspendMember } from "@/members/admin";

import {
  copyCredentialField,
  createCredential,
  createShareLink,
  deleteCredential,
  generateCredentialTotp,
  listAllCredentials,
  replaceCredentialSecret,
  revealCredentialField,
  updateCredential,
  vaultIndex,
} from "./index";

/**
 * OFFBOARDING FLAGS (Phase 3V slice 94) against the real database and the
 * real app_runtime role. Removing a member marks every login they could
 * know the secret of — revealed, copied, shared or typed in the last 90
 * days — "Change soon", one `credential.rotation_flagged` each, in the
 * removal's transaction; and the reveal lock closes the race between a
 * reveal and the removal from both sides.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let acmeP: string;

const TOTP_SEED = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const ctxOf = (memberId: string) => ({ tenantId: f.tenantId, actor: actorFor(memberId) });
const owner = () => ctxOf(f.seats.owner.memberId);
const admin = () => ctxOf(f.seats.admin.memberId);
const manager = () => ctxOf(f.seats.manager.memberId);
const employee = () => ctxOf(f.seats.employee.memberId);
const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60_000);

/** "ok", or the reason — with the detail for FORBIDDEN, which has several. */
const outcome = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof AuthzError) return e.reason === "FORBIDDEN" ? `FORBIDDEN:${e.detail ?? ""}` : e.reason;
    if (e instanceof DomainError) return e.code;
    throw e;
  }
};

const login = async (name: string, extra: { totp?: string } = {}) =>
  (await createCredential(owner(), { clientId: acme, type: "LOGIN", name, secret: { password: `${name}-pw` }, ...extra })).id;

const flagOf = async (id: string) =>
  (await f.platform.credentialItem.findUniqueOrThrow({ where: { id }, select: { needsRotation: true } })).needsRotation;

const flaggedRows = async (targetId?: string) =>
  (await f.audits("credential.rotation_flagged")).filter((a) => targetId === undefined || a.targetId === targetId);

/** A reveal row as the reveal path writes it, at a chosen time (setup only — past RLS). */
const plantReveal = (memberId: string, credentialId: string, createdAt: Date) =>
  f.platform.auditEvent.create({
    data: {
      tenantId: f.tenantId,
      actorType: "MEMBER",
      actorId: memberId,
      action: "credential.revealed",
      targetType: "CredentialItem",
      targetId: credentialId,
      metadata: { field: "password" },
      visibility: "TENANT",
      createdAt,
    },
  });

/** The reveal lock's key, exactly as `budget.ts` builds it. */
const revealKey = (memberId: string) => `vault_reveal:${f.tenantId}:${memberId}`;

/**
 * Until another session is WAITING on `key`'s advisory lock (pg_locks
 * shows a bigint key's low 32 bits as `objid`). Gives up after ten
 * seconds; the assertion that follows then fails on its own terms.
 */
async function waitForWaiter(key: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await f.platform.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
        AND objid::text::bigint = (hashtext(${key})::bigint & 4294967295)`;
    if ((row?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  f = await setupTenant("voff");
  acme = randomUUID();
  acmeP = randomUUID();
  await f.platform.client.create({ data: { id: acme, tenantId: f.tenantId, name: "Acme" } });
  await f.platform.project.create({ data: { id: acmeP, tenantId: f.tenantId, clientId: acme, key: "OFF", name: "Acme site" } });
  // The employee works on the one project, and so may add logins to it.
  await f.platform.memberProject.create({
    data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, projectId: acmeP },
  });
}, 120_000);

afterAll(async () => {
  if (f) {
    // Share links, secrets and versions go with their login (FK cascade).
    await f.platform.credentialItem.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.memberProject.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.project.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.tenantKey.deleteMany({ where: { tenantId: f.tenantId } });
  }
  resetTenantDekCache();
  await f?.cleanup();
}, 120_000);

describe("removing a member flags what they could know", () => {
  const L: Record<string, string> = {};

  beforeAll(async () => {
    for (const name of ["revealed", "copied", "shared", "rotatedBy", "seedSet", "seedRemoved", "renamed", "codeOnly", "colleague", "old", "recent", "already", "binned"]) {
      L[name] = await login(name, name === "codeOnly" || name === "seedRemoved" ? { totp: TOTP_SEED } : {});
    }
    // What the leaving admin did, through the real services.
    await revealCredentialField(admin(), L.revealed!, "password");
    await copyCredentialField(admin(), L.copied!, "password");
    await createShareLink(admin(), L.shared!, {
      field: "password",
      recipientEmail: "someone@test.invalid",
      expiresInHours: 1,
      includeUsername: false,
    });
    await replaceCredentialSecret(admin(), L.rotatedBy!, { secret: { password: "typed-by-the-admin" } });
    // A seed typed in (secretChanged false, a seed left) counts; one removed does not.
    await replaceCredentialSecret(admin(), L.seedSet!, { totp: TOTP_SEED });
    await replaceCredentialSecret(admin(), L.seedRemoved!, { totp: null });
    await updateCredential(admin(), L.renamed!, { name: "renamed again" });
    await generateCredentialTotp(admin(), L.codeOnly!);
    await revealCredentialField(manager(), L.colleague!, "password");
    await plantReveal(f.seats.admin.memberId, L.old!, daysAgo(91));
    await plantReveal(f.seats.admin.memberId, L.recent!, daysAgo(89));
    await f.platform.credentialItem.update({ where: { id: L.already! }, data: { needsRotation: true } });
    await revealCredentialField(admin(), L.already!, "password");
    await revealCredentialField(admin(), L.binned!, "password");
    await deleteCredential(owner(), L.binned!);
  }, 180_000);

  it("flags each login they revealed, copied, shared or typed in the last 90 days — and returns how many", async () => {
    expect(await suspendMember({ tenantId: f.tenantId, actor: owner().actor, memberId: f.seats.admin.memberId })).toEqual({
      flagged: 7,
    });
    for (const name of ["revealed", "copied", "shared", "rotatedBy", "seedSet", "recent", "binned"]) {
      expect(await flagOf(L[name]!), name).toBe(true);
    }
  });

  it("leaves a TOTP code, a removed seed, a metadata edit, a colleague's reveal and anything older than 90 days alone", async () => {
    for (const name of ["codeOnly", "seedRemoved", "renamed", "colleague", "old"]) {
      expect(await flagOf(L[name]!), name).toBe(false);
    }
  });

  it("records one row per newly flagged login, the remover as actor — none for one already flagged", async () => {
    const rows = await flaggedRows();
    expect(rows.map((r) => r.targetId).sort()).toEqual(
      ["revealed", "copied", "shared", "rotatedBy", "seedSet", "recent", "binned"].map((n) => L[n]!).sort(),
    );
    for (const r of rows) {
      expect(r).toMatchObject({
        actorType: "MEMBER",
        actorId: f.seats.owner.memberId,
        targetType: "CredentialItem",
        metadata: { memberId: f.seats.admin.memberId, cause: "member_removed" },
      });
    }
    expect(await flaggedRows(L.already!)).toHaveLength(0);
    expect(await flagOf(L.already!)).toBe(true);
  });

  it("a second removal flags nothing again; reactivating keeps the flags", async () => {
    const before = (await flaggedRows()).length;
    expect(await suspendMember({ tenantId: f.tenantId, actor: owner().actor, memberId: f.seats.admin.memberId })).toEqual({
      flagged: 0,
    });
    await reactivateMember({ tenantId: f.tenantId, actor: owner().actor, memberId: f.seats.admin.memberId });
    expect(await flagOf(L.revealed!)).toBe(true);
    expect(await suspendMember({ tenantId: f.tenantId, actor: owner().actor, memberId: f.seats.admin.memberId })).toEqual({
      flagged: 0,
    });
    expect(await flaggedRows()).toHaveLength(before);
  });

  it("the vault's index counts the live flagged logins, and the list narrows to them", async () => {
    const index = await vaultIndex(owner());
    // Seven flagged by the removal plus the one already flagged, less the binned one.
    expect(index.changeSoon).toBe(7);
    const listed = await listAllCredentials(owner(), { changeSoon: true });
    expect(listed.cut).toBeNull();
    expect(listed.rows.map((r) => r.id).sort()).toEqual(
      ["revealed", "copied", "shared", "rotatedBy", "seedSet", "recent", "already"].map((n) => L[n]!).sort(),
    );
    expect(listed.rows.every((r) => r.needsRotation)).toBe(true);
  });

  it("an employee who only ADDED a login has it flagged when they leave", async () => {
    const theirs = (
      await createCredential(employee(), { projectId: acmeP, type: "LOGIN", name: "added by the employee", secret: { password: "e-pw" } })
    ).id;
    expect(await suspendMember({ tenantId: f.tenantId, actor: owner().actor, memberId: f.seats.employee.memberId })).toEqual({
      flagged: 1,
    });
    expect(await flagOf(theirs)).toBe(true);
  });
});

describe("the reveal lock closes the race with a removal, from both sides", () => {
  let target: string;
  let waited: string;

  beforeAll(async () => {
    target = await login("race target");
    waited = await login("race waited");
  }, 120_000);

  it("a reveal waiting on the lock while the member is removed is refused once it gets it", async () => {
    const managerId = f.seats.manager.memberId;
    let pending: Promise<string> | undefined;
    // Stands in for a removal: hold the member's reveal key, let the reveal
    // pass every gate before it and park on the key, then commit the
    // suspension. The reveal's gates were all answered while the member was
    // active; only the re-read after the lock can refuse it.
    await f.platform.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${revealKey(managerId)}))`;
        pending = outcome(revealCredentialField(manager(), waited, "password"));
        await waitForWaiter(revealKey(managerId));
        await tx.member.update({ where: { id: managerId }, data: { status: "SUSPENDED", suspendedAt: new Date() } });
      },
      { timeout: 30_000 },
    );
    expect(await pending).toBe("FORBIDDEN:the member is no longer active");
    const reveals = (await f.audits("credential.revealed")).filter((a) => a.targetId === waited);
    expect(reveals).toHaveLength(0);
    await f.platform.member.update({ where: { id: managerId }, data: { status: "ACTIVE", suspendedAt: null } });
  }, 60_000);

  /**
   * The same as the test above for a secret the member TYPES (slice 94's
   * security review): hold the key as a removal would, let the write park
   * on it, commit the suspension, and the write is refused once it gets
   * the key — so a change queued behind the removal can never clear the
   * flag the removal set, nor a new login escape it.
   */
  const suspendedWhileWaiting = async (write: () => Promise<unknown>): Promise<string> => {
    const managerId = f.seats.manager.memberId;
    let pending: Promise<string> | undefined;
    try {
      await f.platform.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${revealKey(managerId)}))`;
          pending = outcome(write());
          // Not left unhandled if the transaction below throws first.
          pending.catch(() => undefined);
          await waitForWaiter(revealKey(managerId));
          await tx.member.update({ where: { id: managerId }, data: { status: "SUSPENDED", suspendedAt: new Date() } });
        },
        { timeout: 30_000 },
      );
      return await pending!;
    } finally {
      // Whatever happened, the manager is ACTIVE again for the test after,
      // which removes them for real and would otherwise misread a failure here.
      await f.platform.member.update({ where: { id: managerId }, data: { status: "ACTIVE", suspendedAt: null } });
    }
  };

  it("a secret change waiting on the lock while the member is removed is refused, and the flag stays", async () => {
    const kept = await login("race kept");
    await f.platform.credentialItem.update({ where: { id: kept }, data: { needsRotation: true } });
    expect(await suspendedWhileWaiting(() => replaceCredentialSecret(manager(), kept, { secret: { password: "chosen-on-the-way-out" } }))).toBe(
      "FORBIDDEN:the member is no longer active",
    );
    expect(await flagOf(kept)).toBe(true);
    expect((await f.audits("credential.updated")).filter((a) => a.targetId === kept)).toHaveLength(0);
  }, 60_000);

  it("a new login waiting on the lock while the member is removed is refused", async () => {
    const name = "race created on the way out";
    expect(
      await suspendedWhileWaiting(() => createCredential(manager(), { clientId: acme, type: "LOGIN", name, secret: { password: "p" } })),
    ).toBe("FORBIDDEN:the member is no longer active");
    expect(await f.platform.credentialItem.count({ where: { tenantId: f.tenantId, name } })).toBe(0);
  }, 60_000);

  it("a reveal that commits while the removal waits on the lock is flagged by it", async () => {
    const managerId = f.seats.manager.memberId;
    let pending: Promise<{ flagged: number }> | undefined;
    // Stands in for a reveal mid-flight: hold the key, let the removal park
    // on it, then write the reveal's row and commit — the removal must read
    // it after the wait.
    await f.platform.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${revealKey(managerId)}))`;
        pending = suspendMember({ tenantId: f.tenantId, actor: owner().actor, memberId: managerId });
        // Not left unhandled if the transaction below throws first.
        pending.catch(() => undefined);
        await waitForWaiter(revealKey(managerId));
        await tx.auditEvent.create({
          data: {
            tenantId: f.tenantId,
            actorType: "MEMBER",
            actorId: managerId,
            action: "credential.revealed",
            targetType: "CredentialItem",
            targetId: target,
            metadata: { field: "password" },
            visibility: "TENANT",
          },
        });
      },
      { timeout: 30_000 },
    );
    await pending;
    expect(await flagOf(target)).toBe(true);
    // The refused reveal of the test before left no row, so nothing flags it.
    expect(await flagOf(waited)).toBe(false);
  }, 60_000);
});
