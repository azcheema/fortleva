import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { resetTenantDekCache } from "@/crypto/tenant-key";
import { withTenant, type TenantDb } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { setTransport, type MailTransport } from "@/mailer";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { updatePreferences } from "@/preferences/service";
import { resetLocalLimiter } from "@/ratelimit";

import {
  createCredential,
  createShareLink,
  deleteCredential,
  getCredential,
  previewShareLink,
  replaceCredentialSecret,
  revealCredentialField,
  revokeShareLink,
  sealLogin,
  showLoginToClient,
  unsealLogin,
  updateCredential,
} from "./index";
import { mintShareToken } from "./share-token";

/**
 * THE SEALED LAYER'S STAFF SIDE against the real database and the real
 * app_runtime role (Phase 3V slice 92; founder decisions C52 (e), C60):
 *   - anyone who can EDIT a login seals it; only an OWNER unseals it;
 *   - a seal is kept FOR a client — never on the agency's own logins;
 *   - staff use a sealed login as before (reveal, edit, change the secret);
 *   - a sealed login is never shown to the client — sealing a shown one
 *     hides it, and asks who may hide it;
 *   - never shared (C60 (a)): no new link, every open link revoked by the
 *     seal, its page dead — and a link made WHILE the login is being sealed
 *     never survives it;
 *   - only an owner deletes a sealed login (C60 (b)), and the delete
 *     clears the seal;
 *   - the database's three CHECKs and its share-link trigger hold on their
 *     own, whatever a service does.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;

const RUN = randomUUID().slice(0, 8);
const RECIPIENT = `seal-${RUN}@example.test`;

const owner = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.owner.memberId) });
const manager = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.manager.memberId) });
const admin = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.admin.memberId) });
const employee = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.employee.memberId) });

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

/** A database refusal, by the constraint or trigger it names. */
const refusedBy = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "accepted";
  } catch (e) {
    return String((e as Error).message);
  }
};

let n = 0;
/** A fresh client-level LOGIN at Acme, as the owner. */
const freshLogin = async (name = `Login ${++n}`) =>
  (
    await createCredential(owner(), {
      clientId: acme,
      type: "LOGIN",
      name,
      username: "acme-admin",
      url: "https://panel.example.test",
      secret: { password: `pw-${RUN}-${n}` },
    })
  ).id;

/** A row, read past RLS (setup and assertions only). */
const item = (id: string) =>
  f.platform.credentialItem.findUniqueOrThrow({
    where: { id },
    select: { sealedAt: true, visibility: true, deletedAt: true },
  });

const auditsFor = async (action: string, targetId: string) =>
  (await f.audits(action)).filter((a) => a.targetId === targetId);

const link = (credentialId: string, ctx = owner()) =>
  createShareLink(ctx, credentialId, {
    field: "password",
    recipientEmail: RECIPIENT,
    expiresInHours: 24,
    includeUsername: false,
  });

const tokenOf = (url: string) => url.slice(url.indexOf("/portal/share/") + "/portal/share/".length);

/**
 * A member's transaction held OPEN: `first` runs in it, then it waits until
 * `release()`, which runs `last` (if any) in it and commits. `xid` is its
 * transaction id, for `waitsOn`.
 */
const holdOpen = async (
  memberId: string,
  first: (tx: TenantDb) => Promise<unknown>,
  last?: (tx: TenantDb) => Promise<unknown>,
) => {
  let go!: () => void;
  const gate = new Promise<void>((resolve) => (go = resolve));
  let ready!: (xid: string) => void;
  const xidP = new Promise<string>((resolve) => (ready = resolve));
  const done = withTenant(f.tenantId, { type: "member", id: memberId }, async (tx) => {
    await first(tx);
    const [mine] = await tx.$queryRaw<{ xid: string }[]>`SELECT pg_current_xact_id()::xid::text AS xid`;
    ready(mine!.xid);
    await gate;
    if (last) await last(tx);
  });
  // A failure before `ready` must not leave the caller waiting forever —
  // and the end of a normal run must not be an unhandled rejection.
  const early = done.then(() => {
    throw new Error("held transaction ended early");
  });
  early.catch(() => {});
  const xid = await Promise.race([xidP, early]);
  return {
    xid,
    release: async () => {
      go();
      await done;
    },
  };
};

/**
 * Is some transaction WAITING on `xid`'s lock? `pg_locks` shows every
 * role's locks: a waiter on a row another transaction changed or locked
 * waits for that transaction's id. Polled for at most 2 s of WALL time (a
 * count of tries would stretch with every round trip over the Neon link) —
 * inside the held transaction's budget and the vault's bounded lock wait.
 */
const waitsOn = async (xid: string): Promise<boolean> => {
  const until = Date.now() + 2_000;
  while (Date.now() < until) {
    const [row] = await f.platform.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_locks
       WHERE locktype = 'transactionid' AND NOT granted AND transactionid::text = ${xid}`;
    if ((row?.n ?? 0) > 0) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

/** A seal's write with no service around it. */
const rawSeal = (tx: TenantDb, id: string) =>
  tx.$executeRaw`UPDATE credential_item SET sealed_at = clock_timestamp() WHERE tenant_id = ${f.tenantId} AND id = ${id}`;

/** A well-formed link inserted directly, as the member themselves (the guard's rule), on the database's clock; its id. */
const rawLink = async (tx: TenantDb, credentialId: string, memberId: string): Promise<string> => {
  const [secret] = await tx.$queryRaw<{ version: number }[]>`
    SELECT version FROM credential_secret WHERE tenant_id = ${f.tenantId} AND credential_id = ${credentialId}`;
  const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  const { tokenHash } = mintShareToken(f.tenantId);
  const created = await tx.credentialShareLink.create({
    data: {
      tenantId: f.tenantId,
      credentialId,
      tokenHash,
      field: "password",
      includeUsername: false,
      recipientEmail: RECIPIENT,
      secretVersion: secret!.version,
      expiresAt: new Date(clock!.now.getTime() + 3_600_000),
      createdByMemberId: memberId,
      createdAt: clock!.now,
    },
    select: { id: true },
  });
  return created.id;
};

let previousTransport: MailTransport;

beforeAll(async () => {
  f = await setupTenant("vseal");
  acme = randomUUID();
  await f.platform.client.create({ data: { id: acme, tenantId: f.tenantId, name: "Acme" } });
  previousTransport = setTransport(async () => {});
  // Every share link is one of its maker's reveals for the hour (slice 90).
  await updatePreferences(owner(), { vault: { revealBudgetPerHour: 100 } });
}, 180_000);

beforeEach(() => resetLocalLimiter());

afterAll(async () => {
  if (previousTransport) setTransport(previousTransport);
  if (f) {
    await f.platform.credentialItem.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.tenantKey.deleteMany({ where: { tenantId: f.tenantId } });
  }
  resetTenantDekCache();
  await f?.cleanup();
}, 180_000);

describe("sealing — anyone who can edit; unsealing — owners only (C52 (e))", () => {
  it("owner, manager and admin seal; an employee cannot; each seal is audited once", async () => {
    const a = await freshLogin();
    const b = await freshLogin();
    const c = await freshLogin();
    expect(await outcome(sealLogin(employee(), a))).toBe("FORBIDDEN");
    expect((await item(a)).sealedAt).toBeNull();
    expect(await outcome(sealLogin(owner(), a))).toBe("ok");
    expect(await outcome(sealLogin(manager(), b))).toBe("ok");
    expect(await outcome(sealLogin(admin(), c))).toBe("ok");
    for (const id of [a, b, c]) expect((await item(id)).sealedAt).not.toBeNull();
    const [audit] = await auditsFor("credential.sealed", a);
    expect(audit?.actorId).toBe(f.seats.owner.memberId);
    expect(audit?.metadata).toEqual({ clientId: acme, wasShown: false });
    // Idempotent: a second seal writes and records nothing.
    const stamped = (await item(a)).sealedAt;
    expect(await outcome(sealLogin(manager(), a))).toBe("ok");
    expect((await item(a)).sealedAt).toEqual(stamped);
    expect(await auditsFor("credential.sealed", a)).toHaveLength(1);
  });

  it("only an owner unseals — the manager and admin who may seal may not; idempotent", async () => {
    const id = await freshLogin();
    await sealLogin(manager(), id);
    expect(await outcome(unsealLogin(manager(), id))).toBe("FORBIDDEN");
    expect(await outcome(unsealLogin(admin(), id))).toBe("FORBIDDEN");
    expect(await outcome(unsealLogin(employee(), id))).toBe("FORBIDDEN");
    expect((await item(id)).sealedAt).not.toBeNull();
    expect(await outcome(unsealLogin(owner(), id))).toBe("ok");
    expect((await item(id)).sealedAt).toBeNull();
    const [audit] = await auditsFor("credential.unsealed", id);
    expect(audit?.actorId).toBe(f.seats.owner.memberId);
    expect(audit?.metadata).toEqual({ clientId: acme });
    // Not sealed: nothing to do, nothing recorded.
    expect(await outcome(unsealLogin(owner(), id))).toBe("ok");
    expect(await auditsFor("credential.unsealed", id)).toHaveLength(1);
    // And sealed again, by anyone who may edit.
    expect(await outcome(sealLogin(manager(), id))).toBe("ok");
    expect(await auditsFor("credential.sealed", id)).toHaveLength(2);
  });

  it("the agency's own logins are never sealed — refused by the service AND the database", async () => {
    const own = (
      await createCredential(owner(), { type: "LOGIN", name: "Our registrar", secret: { password: "x" } })
    ).id;
    expect(await outcome(sealLogin(owner(), own))).toBe("LOGIN_HAS_NO_CLIENT");
    expect(await refusedBy(f.platform.credentialItem.update({ where: { id: own }, data: { sealedAt: new Date() } }))).toContain(
      "credential_item_sealed_needs_client",
    );
  });

  it("a login that is gone, or another tenant's id, is NOT_FOUND", async () => {
    const id = await freshLogin();
    await deleteCredential(owner(), id);
    expect(await outcome(sealLogin(owner(), id))).toBe("NOT_FOUND");
    expect(await outcome(unsealLogin(owner(), id))).toBe("NOT_FOUND");
    expect(await outcome(sealLogin(owner(), randomUUID()))).toBe("NOT_FOUND");
  });
});

describe("staff never ask (C52 (e))", () => {
  it("a sealed login is revealed, edited and has its secret changed exactly as before", async () => {
    const id = await freshLogin("Staff use");
    await sealLogin(manager(), id);
    expect(await revealCredentialField(manager(), id, "password")).toBe(`pw-${RUN}-${n}`);
    await updateCredential(manager(), id, { notes: "still ours to use" });
    await replaceCredentialSecret(manager(), id, { secret: { password: "rotated" } });
    expect(await revealCredentialField(owner(), id, "password")).toBe("rotated");
    const view = await getCredential(manager(), id);
    expect(view.sealedAt).not.toBeNull();
    expect(view.notes).toBe("still ours to use");
  });
});

describe("never shown to the client (C60 (a))", () => {
  beforeAll(async () => {
    await updatePreferences(owner(), { vault: { allowPortalCredentials: true } });
  });
  afterAll(async () => {
    await updatePreferences(owner(), { vault: { allowPortalCredentials: false } });
  });

  it("a sealed login cannot be shown — by the service and by the database", async () => {
    const id = await freshLogin();
    await sealLogin(owner(), id);
    expect(await outcome(showLoginToClient(owner(), id))).toBe("LOGIN_SEALED");
    expect((await item(id)).visibility).toBe("INTERNAL");
    expect(
      await refusedBy(f.platform.credentialItem.update({ where: { id }, data: { visibility: "CLIENT_VISIBLE" } })),
    ).toContain("credential_item_sealed_is_internal");
  });

  it("a show that waits on a seal is refused once the seal commits — never shown sealed", async () => {
    // `showLoginToClient` reads the login unsealed (the seal is not yet
    // committed), then its conditional write waits on the seal's row and
    // finds it sealed: LOGIN_SEALED, from its "sealed in between" branch.
    const id = await freshLogin("Show races a seal");
    const seal = await holdOpen(f.seats.owner.memberId, (tx) => rawSeal(tx, id));
    const show = outcome(showLoginToClient(owner(), id));
    const waited = await waitsOn(seal.xid);
    await seal.release();
    expect(waited, "the show waited on the seal's row").toBe(true);
    expect(await show).toBe("LOGIN_SEALED");
    expect(await item(id)).toMatchObject({ visibility: "INTERNAL" });
    expect((await item(id)).sealedAt).not.toBeNull();
    expect(await auditsFor("credential.visibility_changed", id)).toHaveLength(0);
  });

  it("a manager's seal that waits on a SHOW checks the state it finds — refused, never a hide by someone who may not", async () => {
    // The seal reads scope plainly, then LOCKS the row (`lockedState`) and
    // decides on what is committed: a show committing while it waits makes
    // the login shown, so a manager (no `credential:change_visibility`) is
    // refused (C60 (c)). A plain read here would have hidden it unasked.
    const id = await freshLogin("Seal races a show");
    const show = await holdOpen(f.seats.admin.memberId, (tx) =>
      tx.$executeRaw`UPDATE credential_item SET visibility = 'CLIENT_VISIBLE' WHERE tenant_id = ${f.tenantId} AND id = ${id}`,
    );
    const seal = outcome(sealLogin(manager(), id));
    const waited = await waitsOn(show.xid);
    await show.release();
    expect(waited, "the seal waited on the show's row").toBe(true);
    expect(await seal).toBe("FORBIDDEN");
    expect(await item(id)).toMatchObject({ visibility: "CLIENT_VISIBLE", sealedAt: null });
    expect(await auditsFor("credential.sealed", id)).toHaveLength(0);
  });

  it("sealing a SHOWN login hides it — which asks who may hide it: a manager may not, an admin may", async () => {
    const id = await freshLogin();
    await showLoginToClient(owner(), id);
    expect((await item(id)).visibility).toBe("CLIENT_VISIBLE");
    // A manager may edit (and so seal) but may not decide what a client sees.
    expect(await outcome(sealLogin(manager(), id))).toBe("FORBIDDEN");
    expect(await item(id)).toMatchObject({ sealedAt: null, visibility: "CLIENT_VISIBLE" });
    expect(await outcome(sealLogin(admin(), id))).toBe("ok");
    expect((await item(id)).visibility).toBe("INTERNAL");
    expect((await item(id)).sealedAt).not.toBeNull();
    expect((await auditsFor("credential.sealed", id)).map((a) => a.metadata)).toEqual([{ clientId: acme, wasShown: true }]);
    const changed = await auditsFor("credential.visibility_changed", id);
    expect(changed.at(-1)?.metadata).toEqual({ visibility: "INTERNAL", clientId: acme, cause: "sealed" });
    expect(changed.at(-1)?.actorId).toBe(f.seats.admin.memberId);
  });
});

describe("never shared (C60 (a))", () => {
  it("sealing revokes every OPEN link, as the sealer, and leaves closed ones as they ended", async () => {
    const id = await freshLogin("Shared then sealed");
    const open1 = await link(id);
    const open2 = await link(id, manager());
    const closed = await link(id);
    await revokeShareLink(owner(), closed.id);
    expect(await previewShareLink(tokenOf(open1.url))).not.toBeNull();

    // The manager seals without holding anything about links beyond edit.
    await sealLogin(manager(), id);
    const rows = await f.platform.credentialShareLink.findMany({
      where: { credentialId: id },
      select: { id: true, revokedAt: true, revokedByMemberId: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const l of [open1, open2]) {
      expect(byId.get(l.id)?.revokedAt).not.toBeNull();
      expect(byId.get(l.id)?.revokedByMemberId).toBe(f.seats.manager.memberId);
      const [audit] = await auditsFor("credential.share_revoked", l.id);
      expect(audit?.actorId).toBe(f.seats.manager.memberId);
      expect(audit?.metadata).toEqual({ credentialId: id, cause: "sealed" });
    }
    // The one already revoked keeps its own revoke, by the owner, recorded once.
    expect(byId.get(closed.id)?.revokedByMemberId).toBe(f.seats.owner.memberId);
    expect(await auditsFor("credential.share_revoked", closed.id)).toHaveLength(1);
    // Their page opens nothing.
    expect(await previewShareLink(tokenOf(open1.url))).toBeNull();
    expect(await previewShareLink(tokenOf(open2.url))).toBeNull();
  });

  it("no new link to a sealed login — by the service and by the database's trigger", async () => {
    const id = await freshLogin();
    await sealLogin(owner(), id);
    expect(await outcome(link(id))).toBe("LOGIN_SEALED");
    expect(await f.platform.credentialShareLink.count({ where: { credentialId: id } })).toBe(0);

    // A writer that skips the service: a well-formed link, inserted as the
    // member themselves (the guard's rule), is still refused.
    const secret = await f.platform.credentialSecret.findUniqueOrThrow({ where: { credentialId: id } });
    const { tokenHash } = mintShareToken(f.tenantId);
    const memberId = f.seats.owner.memberId;
    const refusal = await refusedBy(
      withTenant(f.tenantId, { type: "member", id: memberId }, (tx) =>
        tx.credentialShareLink.create({
          data: {
            tenantId: f.tenantId,
            credentialId: id,
            tokenHash,
            field: "password",
            includeUsername: false,
            recipientEmail: RECIPIENT,
            secretVersion: secret.version,
            expiresAt: new Date(Date.now() + 3_600_000),
            createdByMemberId: memberId,
            createdAt: new Date(),
          },
          select: { id: true },
        }),
      ),
    );
    expect(refusal).toContain("CRED_SHARE_LINK_SEALED");

    // Unsealed, the same login shares again: the seal was the only refusal.
    await unsealLogin(owner(), id);
    expect(await outcome(link(id))).toBe("ok");
  });

  it("the trigger is a BEFORE INSERT row trigger that LOCKS the login — pinned in the catalogue", async () => {
    // The race test below goes through `createShareLink`, which holds the
    // login FOR SHARE itself; this pin is what notices the trigger losing
    // its own lock (the migration's second review). INSERT only: on the
    // UPDATE path a FOR SHARE would deadlock against a seal (the header).
    const [fn] = await f.platform.$queryRaw<{ src: string; volatile: string; config: string[] | null }[]>`
      SELECT pg_get_functiondef(p.oid) AS src, p.provolatile::text AS volatile, p.proconfig AS config
        FROM pg_proc p WHERE p.oid = 'credential_share_link_not_sealed'::regproc`;
    expect(fn?.src).toContain("FOR SHARE");
    expect(fn?.src).toContain("sealed_at IS NULL");
    expect(fn?.src).toContain("IF NOT FOUND THEN");
    expect(fn?.volatile).toBe("v");
    expect(fn?.config).toContain("search_path=public, pg_temp");
    const [trig] = await f.platform.$queryRaw<{ tgtype: number }[]>`
      SELECT t.tgtype::int AS tgtype FROM pg_trigger t
       WHERE t.tgrelid = 'credential_share_link'::regclass AND t.tgname = 'credential_share_link_not_sealed'`;
    const tgtype = trig?.tgtype ?? 0;
    expect(tgtype & 1, "FOR EACH ROW").toBe(1);
    expect(tgtype & 2, "BEFORE").toBe(2);
    expect(tgtype & 60, "INSERT, and no other event").toBe(4);
  });

  it("a raw link inserted while a seal is uncommitted waits for it, then is refused", async () => {
    const id = await freshLogin("Raw writer races a seal");
    const memberId = f.seats.owner.memberId;
    // A: the seal's write, held open before its commit.
    const a = await holdOpen(memberId, (tx) => rawSeal(tx, id));
    // B: a writer that skips the service — no FOR SHARE of its own.
    const b = refusedBy(withTenant(f.tenantId, { type: "member", id: memberId }, (tx) => rawLink(tx, id, memberId)));
    // B must be WAITING on A before A commits — the trigger's lock is what
    // makes it wait (an unlocked read would have passed and inserted already).
    const waited = await waitsOn(a.xid);
    await a.release();
    expect(waited, "the raw insert waited on the seal's row lock").toBe(true);
    expect(await b).toContain("CRED_SHARE_LINK_SEALED");
    expect(await f.platform.credentialShareLink.count({ where: { credentialId: id } })).toBe(0);
  });

  it("a seal waits for a link being MADE, then revokes it — the service's order, made deterministic", async () => {
    // The race test below passes in whichever order the two land; this one
    // holds a link-maker at the point `createShareLink` holds the login FOR
    // SHARE, starts the seal, and only lets the link in once the seal is
    // seen waiting on it (the code review's low).
    const id = await freshLogin("Seal waits for a link");
    const ownerId = f.seats.owner.memberId;
    let made = "";
    const maker = await holdOpen(
      ownerId,
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM credential_item WHERE tenant_id = ${f.tenantId} AND id = ${id} FOR SHARE`;
      },
      async (tx) => {
        made = await rawLink(tx, id, ownerId);
      },
    );
    const seal = outcome(sealLogin(manager(), id));
    const waited = await waitsOn(maker.xid);
    await maker.release();
    expect(waited, "the seal waited for the link being made").toBe(true);
    expect(await seal).toBe("ok");
    const link = await f.platform.credentialShareLink.findUniqueOrThrow({ where: { id: made } });
    expect(link.revokedAt).not.toBeNull();
    expect(link.revokedByMemberId).toBe(f.seats.manager.memberId);
    expect(link.revokedAt!.getTime()).toBeGreaterThanOrEqual(link.createdAt.getTime());
    expect((await item(id)).sealedAt!.getTime()).toBeGreaterThanOrEqual(link.createdAt.getTime());
  });

  it("a link made WHILE the login is being sealed never survives the seal", async () => {
    // The share lock orders them (createShareLink reads the login FOR
    // SHARE; the seal's UPDATE waits it out, then revokes) — whichever
    // wins, no OPEN link is left on a sealed login.
    for (let round = 0; round < 4; round++) {
      const id = await freshLogin(`Race ${round}`);
      const [made, sealed] = await Promise.allSettled([link(id), sealLogin(manager(), id)]);
      expect(sealed.status).toBe("fulfilled");
      if (made.status === "rejected") {
        expect(made.reason).toBeInstanceOf(DomainError);
        expect((made.reason as DomainError).code).toBe("LOGIN_SEALED");
      }
      expect((await item(id)).sealedAt).not.toBeNull();
      const open = await f.platform.credentialShareLink.count({
        where: { credentialId: id, viewedAt: null, revokedAt: null },
      });
      expect(open, `round ${round}`).toBe(0);
    }
  });
});

describe("deleting a sealed login — owners only (C60 (b))", () => {
  it("a manager who may delete logins may not delete a sealed one; an owner may, and the seal goes with it", async () => {
    const id = await freshLogin("Sealed and deleted");
    await sealLogin(manager(), id);
    expect(await outcome(deleteCredential(manager(), id))).toBe("FORBIDDEN");
    expect(await item(id)).toMatchObject({ deletedAt: null });
    expect(await outcome(deleteCredential(owner(), id))).toBe("ok");
    const after = await item(id);
    expect(after.deletedAt).not.toBeNull();
    expect(after.sealedAt).toBeNull();
    expect((await auditsFor("credential.deleted", id)).map((a) => a.metadata)).toEqual([
      { clientId: acme, projectId: null, sealed: true },
    ]);
  });

  it("an unsealed login is deleted by a manager as before, with no `sealed` in its trail", async () => {
    const id = await freshLogin();
    expect(await outcome(deleteCredential(manager(), id))).toBe("ok");
    expect((await auditsFor("credential.deleted", id)).map((a) => a.metadata)).toEqual([{ clientId: acme, projectId: null }]);
  });

  it("a delete that waits on a seal checks the seal it finds — a manager's is then refused", async () => {
    // The delete locks the row before it reads the seal (`lockedState`), so
    // a seal committing while it waits is the state its permission is
    // checked against: FORBIDDEN for a manager, the login untouched.
    const id = await freshLogin("Delete races a seal");
    const seal = await holdOpen(f.seats.owner.memberId, (tx) => rawSeal(tx, id));
    const del = outcome(deleteCredential(manager(), id));
    const waited = await waitsOn(seal.xid);
    await seal.release();
    expect(waited, "the delete waited on the seal's row").toBe(true);
    expect(await del).toBe("FORBIDDEN");
    expect((await item(id)).deletedAt).toBeNull();
    expect(await auditsFor("credential.deleted", id)).toHaveLength(0);
  });

  it("the database keeps no seal in the bin", async () => {
    const id = await freshLogin();
    await sealLogin(owner(), id);
    expect(await refusedBy(f.platform.credentialItem.update({ where: { id }, data: { deletedAt: new Date() } }))).toContain(
      "credential_item_sealed_is_live",
    );
  });
});
