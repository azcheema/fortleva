import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { portalAuditSink } from "@/auth/portal-audit";
import type { MemberActor } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";

import { readContactSignIns } from "./contact-sign-ins";

/**
 * A CONTACT'S LAST SIGN-IN (Phase 3 slice 77), against the real
 * `audit_event` table, its RLS and the real portal audit sink.
 *
 * The sign-ins are written by `portalAuditSink` — the writer Better
 * Auth's portal instance calls — not by hand, so a change to the actor
 * the sink stamps (`CONTACT` + the contact's id) fails here rather than
 * silently emptying the column.
 *
 * Tenant slugs come from `setupTenant("csign")`; `csign-` is registered
 * in `DBTEST_PREFIXES` (e2e/fixtures/seed-cli.ts).
 */

const run = randomUUID().slice(0, 8);

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let beta: string;
/** Of `acme`: signs in twice, then fails once. */
let anna: string;
/** Of `acme`: invited, never accepted, never signs in. */
let carl: string;
/** Of `acme`: never given access. */
let dora: string;
/** Of `beta`: signs in — must never appear under `acme`. */
let bo: string;
/** `client:manage_contacts` alone, assigned to `beta` alone: the scope control. */
let scoped: { memberId: string; actor: MemberActor };
const extraUserIds: string[] = [];

const ctxOf = (seat: "owner" | "manager" | "employee") => ({ tenantId: f.tenantId, actor: f.seats[seat].actor });
const user = () => ({ tenantId: f.tenantId });

/** The newest `auth.login_succeeded` the sink wrote for a contact, read past RLS. */
const newestSuccess = async (contactId: string) =>
  (
    await f.platform.auditEvent.findFirstOrThrow({
      where: { tenantId: f.tenantId, action: "auth.login_succeeded", actorId: contactId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    })
  ).createdAt;

beforeAll(async () => {
  f = await setupTenant("csign");
  acme = randomUUID();
  beta = randomUUID();
  anna = randomUUID();
  carl = randomUUID();
  dora = randomUUID();
  bo = randomUUID();
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: `Acme ${run}` },
      { id: beta, tenantId: f.tenantId, name: `Beta ${run}` },
    ],
  });
  await f.platform.contact.createMany({
    data: [
      // Anna and Bo accepted (`activatedAt`); Carl was invited and has not.
      { id: anna, tenantId: f.tenantId, clientId: acme, name: "Anna", email: `csign-anna-${run}@test.invalid`, portalStatus: "ACTIVE", invitedAt: new Date(), activatedAt: new Date() },
      { id: carl, tenantId: f.tenantId, clientId: acme, name: "Carl", email: `csign-carl-${run}@test.invalid`, portalStatus: "INVITED", invitedAt: new Date() },
      { id: dora, tenantId: f.tenantId, clientId: acme, name: "Dora", email: `csign-dora-${run}@test.invalid` },
      { id: bo, tenantId: f.tenantId, clientId: beta, name: "Bo", email: `csign-bo-${run}@test.invalid`, portalStatus: "ACTIVE", invitedAt: new Date(), activatedAt: new Date() },
    ],
  });

  // The scope seat: a custom role holding exactly the one code, and a
  // `MemberClient` row for `beta` only. Every template role holding the
  // code also holds `client:view_all`, so without it nothing here could
  // be out of scope.
  const scopedUserId = randomUUID();
  await f.platform.user.create({
    data: { id: scopedUserId, name: `csign-scoped-${run}@test.invalid`, email: `csign-scoped-${run}@test.invalid` },
  });
  extraUserIds.push(scopedUserId);
  const scopedMember = await f.platform.member.create({ data: { tenantId: f.tenantId, userId: scopedUserId } });
  const scopedRole = await f.platform.role.create({ data: { tenantId: f.tenantId, name: `Contacts only ${run}` } });
  const perm = await f.platform.permission.findFirstOrThrow({ where: { code: "client:manage_contacts" } });
  await f.platform.rolePermission.create({
    data: { tenantId: f.tenantId, roleId: scopedRole.id, permissionId: perm.id },
  });
  await f.platform.memberRole.create({
    data: { tenantId: f.tenantId, memberId: scopedMember.id, roleId: scopedRole.id },
  });
  await f.platform.memberClient.create({
    data: { tenantId: f.tenantId, memberId: scopedMember.id, clientId: beta },
  });
  scoped = { memberId: scopedMember.id, actor: actorFor(scopedMember.id) };

  // Anna signs in twice, then a wrong password is typed for her; Bo, at
  // the other client, signs in once. In sequence, so each row's DB-side
  // `now()` is later than the last.
  await portalAuditSink.loginSucceeded(anna, "password", user());
  await portalAuditSink.loginSucceeded(anna, "password", user());
  await portalAuditSink.loginFailed(anna, "INVALID_PASSWORD", user());
  await portalAuditSink.loginSucceeded(bo, "password", user());
});

afterAll(async () => {
  if (!f) return;
  await f.platform.contact.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.memberClient.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
  // `cleanup()` takes the audit rows (under `app.audit_maintenance`),
  // the members and the roles.
  await f.cleanup();
  await f.platform.user.deleteMany({ where: { id: { in: extraUserIds } } });
});

describe("a contact's last sign-in", () => {
  it("is the LATER of two sign-ins; a failed one after them does not count", async () => {
    const states = await readContactSignIns(ctxOf("owner"), acme);
    expect(states).not.toBeNull();
    const failed = await f.platform.auditEvent.findFirstOrThrow({
      where: { tenantId: f.tenantId, action: "auth.login_failed", targetId: anna },
      select: { createdAt: true, actorType: true },
    });
    // The failure is a different ACTION, and the SYSTEM's row with Anna
    // only as its target — nobody authenticated — so it is excluded twice
    // over, and it is the newest row about her.
    expect(failed.actorType).toBe("SYSTEM");
    const newest = await newestSuccess(anna);
    expect(failed.createdAt.getTime()).toBeGreaterThan(newest.getTime());
    expect(states!.get(anna)).toEqual({ kind: "at", at: newest });
  });

  it("says Never for a contact who never accepted, and nothing for one never given access", async () => {
    const states = await readContactSignIns(ctxOf("owner"), acme);
    expect(states!.get(carl)).toEqual({ kind: "never" });
    expect(states!.get(dora)).toEqual({ kind: "none" });
  });

  it("covers exactly this client's contacts, never another's", async () => {
    const acmeView = await readContactSignIns(ctxOf("owner"), acme);
    expect([...acmeView!.keys()].sort()).toEqual([anna, carl, dora].sort());
    const betaView = await readContactSignIns(ctxOf("owner"), beta);
    expect([...betaView!.keys()]).toEqual([bo]);
    expect(betaView!.get(bo)).toEqual({ kind: "at", at: await newestSuccess(bo) });
  });

  it("covers twelve months back from `now`: past them, an accepted contact is 'not for a year'", async () => {
    const later = new Date(await newestSuccess(anna));
    later.setUTCMonth(later.getUTCMonth() + 13);
    const states = await readContactSignIns(ctxOf("owner"), acme, later);
    // Her sign-ins are older than the window and her record is too, so
    // the log can no longer prove Never.
    expect(states!.get(anna)).toEqual({ kind: "notWithin" });
    // Carl never accepted: Never stays provable at any age.
    expect(states!.get(carl)).toEqual({ kind: "never" });
  });
});

describe("who may read it (OPEN_QUESTIONS C46)", () => {
  it("a manager may", async () => {
    expect(await readContactSignIns(ctxOf("manager"), acme)).not.toBeNull();
  });

  it("an employee — who can see the contact list — may not", async () => {
    expect(await readContactSignIns(ctxOf("employee"), acme)).toBeNull();
  });

  it("nobody may while the workspace's portal module is switched off", async () => {
    await f.platform.tenantPreference.create({
      data: { tenantId: f.tenantId, key: "module.portal.enabled", value: false },
    });
    try {
      expect(await readContactSignIns(ctxOf("owner"), acme)).toBeNull();
    } finally {
      await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId, key: "module.portal.enabled" } });
    }
  });

  it("the permission alone reaches only the clients in the holder's scope", async () => {
    const ctx = { tenantId: f.tenantId, actor: scoped.actor };
    expect([...(await readContactSignIns(ctx, beta))!.keys()]).toEqual([bo]);
    const refused = await readContactSignIns(ctx, acme).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(AuthzError);
    expect((refused as AuthzError).reason).toBe("NOT_FOUND");
  });
});
