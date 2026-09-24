import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { portalAuth } from "@/auth/portal";
import { DomainError } from "@/lib/domain-error";
import type { MemberActor } from "@/authz/authorize";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";

import { inviteContact, setContactPortalAccess } from "./contact-access";
import { hashToken } from "./contact-invite-secret";
import { acceptContactInvite, previewContactInvite } from "./contact-invite-token";
import { deleteContact, updateContact } from "./service";

/**
 * THE CLIENT PORTAL'S INVITATION, END TO END — Phase 3's invite slice,
 * against the real schema, the real `app_runtime` role, the real
 * triggers and the real Better Auth portal instance.
 *
 * **THIS IS THE SLICE THAT MAKES EVERY EARLIER PORTAL SLICE REACHABLE.**
 * Nothing in the product wrote `Contact.portal_status` before it, so no
 * client could hold a session, and the request intake, the triage lane
 * and the hand-over have all been dark on every live tenant. What that
 * means for a test is that the invariants below were previously true by
 * ACCIDENT — no code could reach the states that break them — and are
 * true by enforcement from here on.
 *
 * WHAT ONLY A DATABASE CAN SAY:
 *
 *  · **Invite-only is enforced BELOW this service.** The trigger
 *    `contact_account_requires_invite` refuses a credential for a
 *    contact that is neither INVITED nor ACTIVE, and `portalAuth`'s
 *    `session.create` hook admits the literal `ACTIVE` and nothing else.
 *    Both are driven here against the real objects, because a service
 *    that happens to be correct today is not the guarantee AUTHZ §8
 *    claims — the guarantee is that a wrong service cannot get past
 *    them.
 *  · **Removing access releases the work, in the same transaction.**
 *    `work_item.assignee_contact_id` has an ON DELETE RESTRICT FK, so
 *    without the sweep a removed contact's record becomes undeletable.
 *    Only a real FK can fail that way.
 *  · **A pause keeps the work and a removal returns it** (founder
 *    decision, 2026-09-23) — a difference between two verbs that is
 *    visible only in rows.
 *  · **Tokens are single-use and superseded**, which is a uniqueness and
 *    a status transition rather than a branch.
 *
 * Tenant slugs come from `setupTenant("cinv")`, and the prefix `cinv-`
 * is registered in `DBTEST_PREFIXES` (e2e/fixtures/seed-cli.ts) so
 * `sweep-dbtests` can collect this suite's orphans. `e2e-` is the
 * BROWSER harness's prefix and is swept BY AGE — a dbtest using it
 * would have its fixtures deleted mid-run by a concurrent e2e run.
 */

const run = randomUUID().slice(0, 8);
/** Long enough for Better Auth's own minimum; never printed. */
const PASSWORD = `Cinv-${randomUUID()}`;

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let beta: string;
/** Of `acme`. The contact almost every case invites. */
let anna: string;
/** Of the OTHER client — the scope control. */
let bo: string;
/**
 * A seat holding `client:manage_contacts` and assigned to `acme` ALONE.
 * Every template role that holds the code also holds `client:view_all`
 * (C M A both ways), so without this seat no caller in the fixture can
 * be out of scope and `assertInScope` is asserted by nothing.
 */
let scoped: { memberId: string; actor: MemberActor };
/** The custom seat's PLATFORM-level `user` row — `setupTenant`'s cleanup collects only its own four. */
const extraUserIds: string[] = [];
/** A project of `acme`, for the tasks the removal sweep has to release. */
let project: string;
let todo: string;
let nextNumber = 1;

const ctxOf = (seat: "owner" | "admin" | "manager" | "employee") => ({
  tenantId: f.tenantId,
  actor: f.seats[seat].actor,
});

const contactRow = (id: string) =>
  f.platform.contact.findFirstOrThrow({ where: { tenantId: f.tenantId, id } });

/** The one live invitation's raw token, recovered the only way a test can: by hashing candidates. */
const liveInvite = (contactId: string) =>
  f.platform.contactInvite.findFirstOrThrow({
    where: { tenantId: f.tenantId, contactId, status: "PENDING" },
    orderBy: { createdAt: "desc" },
  });

beforeAll(async () => {
  f = await setupTenant("cinv");
  acme = randomUUID();
  beta = randomUUID();
  anna = randomUUID();
  bo = randomUUID();
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: `Acme ${run}` },
      { id: beta, tenantId: f.tenantId, name: `Beta ${run}` },
    ],
  });
  project = randomUUID();
  todo = randomUUID();
  const up = run.slice(0, 3).toUpperCase();
  await f.platform.project.create({
    data: {
      id: project,
      tenantId: f.tenantId,
      clientId: acme,
      key: `CIV${up}`,
      name: `Site ${run}`,
      portalEnabled: true,
    },
  });
  await f.platform.workflowState.create({
    data: {
      id: todo,
      tenantId: f.tenantId,
      projectId: project,
      name: "To do",
      seedKey: "TODO",
      category: "TODO",
      rank: "a1",
      isDefault: true,
    },
  });
  // The scope seat (see its declaration). A custom role holding exactly
  // the one code, and a `MemberClient` row for `acme` only.
  const scopedUserId = randomUUID();
  await f.platform.user.create({
    data: { id: scopedUserId, name: `cinv-scoped-${run}@test.invalid`, email: `cinv-scoped-${run}@test.invalid` },
  });
  const scopedMember = await f.platform.member.create({
    data: { tenantId: f.tenantId, userId: scopedUserId },
  });
  const scopedRole = await f.platform.role.create({
    data: { tenantId: f.tenantId, name: `Contacts only ${run}` },
  });
  const perm = await f.platform.permission.findFirstOrThrow({
    where: { code: "client:manage_contacts" },
  });
  await f.platform.rolePermission.create({
    data: { tenantId: f.tenantId, roleId: scopedRole.id, permissionId: perm.id },
  });
  await f.platform.memberRole.create({
    data: { tenantId: f.tenantId, memberId: scopedMember.id, roleId: scopedRole.id },
  });
  await f.platform.memberClient.create({
    data: { tenantId: f.tenantId, memberId: scopedMember.id, clientId: acme },
  });
  extraUserIds.push(scopedUserId);
  scoped = { memberId: scopedMember.id, actor: actorFor(scopedMember.id) };

  await f.platform.contact.createMany({
    data: [
      { id: anna, tenantId: f.tenantId, clientId: acme, name: "Anna", email: `cinv-anna-${run}@test.invalid` },
      { id: bo, tenantId: f.tenantId, clientId: beta, name: "Bo", email: `cinv-bo-${run}@test.invalid` },
    ],
  });
});

beforeEach(async () => {
  // Every case starts from a contact with NO access, which is the state
  // every contact on every live tenant is in today.
  // **SCOPED BY CONTACT, never `deleteMany({})`.** `contact_session` and
  // `contact_account` are AUTH-class and carry no tenant column, so
  // there is nothing to filter by tenant — and the seam's own guard
  // refuses an unfiltered bulk write outright, which is the rule that
  // exists because a cleanup hook after a failed `beforeAll` once wiped
  // the shared dev database.
  await f.platform.contactSession.deleteMany({ where: { contactId: { in: [anna, bo] } } });
  await f.platform.contactAccount.deleteMany({ where: { contactId: { in: [anna, bo] } } });
  // No FK to `contact` — a reset row is looked up by its token — so it is
  // scoped by `value`, which is the contact id on every one.
  await f.platform.contactVerification.deleteMany({ where: { value: { in: [anna, bo] } } });
  await f.platform.contactInvite.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.comment.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.workItem.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.contact.updateMany({
    where: { tenantId: f.tenantId },
    data: { portalStatus: "NO_ACCESS", invitedAt: null, activatedAt: null, emailVerified: false },
  });
  await f.platform.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
    await tx.auditEvent.deleteMany({ where: { tenantId: f.tenantId } });
  });
});

afterAll(async () => {
  if (!f) return;
  // Scoped by contact, for the reason `beforeEach` states.
  await f.platform.contactSession.deleteMany({ where: { contactId: { in: [anna, bo] } } });
  await f.platform.contactAccount.deleteMany({ where: { contactId: { in: [anna, bo] } } });
  // No FK to `contact` — a reset row is looked up by its token — so it is
  // scoped by `value`, which is the contact id on every one.
  await f.platform.contactVerification.deleteMany({ where: { value: { in: [anna, bo] } } });
  await f.platform.contactInvite.deleteMany({ where: { tenantId: f.tenantId } });
  // BEFORE the work items and the project: `comment` has a RESTRICT FK
  // to both, so the deletion-guard case's fixture strands the teardown
  // otherwise — and a teardown that fails leaves the tenant for the
  // sweep rather than cleaning up after itself.
  await f.platform.comment.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.workItem.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
  // `nextCounter` mints a `tenant_counter` row per project and its FK to
  // `tenant` is RESTRICT, so without this the tenant delete strands.
  await f.platform.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.contact.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.project.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.memberClient.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
  // AFTER `cleanup()`: `member` has an FK to `user`, and cleanup is what
  // deletes this tenant's members.
  await f.platform.user.deleteMany({ where: { id: { in: extraUserIds } } });
});

describe("issuing a portal invitation", () => {
  it("stamps BOTH the status and the invitedAt, and audits it", async () => {
    await inviteContact(ctxOf("manager"), anna);

    const after = await contactRow(anna);
    expect(after.portalStatus).toBe("INVITED");
    // `authorizePortal()` requires this stamp in addition to the status,
    // so an activation path that forgets it produces a contact who can
    // hold a session and do nothing. It is the half a service is most
    // likely to drop.
    expect(after.invitedAt).toBeInstanceOf(Date);
    expect(after.invitedById).toBe(f.seats.manager.memberId);

    const events = await f.audits("contact.invited");
    expect(events).toHaveLength(1);
    // Ids, never the address (SECURITY.md §7 minimisation).
    expect(JSON.stringify(events[0]!.metadata)).not.toContain("@");
  });

  it("stores only the token's HASH, never the token", async () => {
    await inviteContact(ctxOf("manager"), anna);
    const invite = await liveInvite(anna);
    expect(invite.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // The raw token is 32 random bytes base64url — 43 characters — and
    // nothing on the row is that shape.
    for (const value of Object.values(invite)) {
      if (typeof value === "string") expect(value).not.toMatch(/^[\w-]{43}$/);
    }
  });

  it("supersedes the previous invitation, so one live token per contact", async () => {
    await inviteContact(ctxOf("manager"), anna);
    const first = await liveInvite(anna);
    await inviteContact(ctxOf("manager"), anna);

    const superseded = await f.platform.contactInvite.findFirstOrThrow({ where: { id: first.id } });
    // A forwarded link stops working the moment a new one is sent.
    expect(superseded.status).toBe("REVOKED");
    expect(
      await f.platform.contactInvite.count({
        where: { tenantId: f.tenantId, contactId: anna, status: "PENDING" },
      }),
    ).toBe(1);
  });

  it("refuses a second live invitation — the partial unique, not the ordering", async () => {
    // The supersede is revoke-then-insert under READ COMMITTED, so two
    // overlapping re-invites would each revoke what they can see and each
    // insert a row the other cannot: two live tokens, on exactly the
    // double-submit a resend button invites. The index is what makes it
    // impossible; this drives it by leaving a PENDING row in place.
    await inviteContact(ctxOf("manager"), anna);
    const first = await liveInvite(anna);
    await expect(
      f.platform.contactInvite.create({
        data: {
          tenantId: f.tenantId,
          contactId: anna,
          tokenHash: hashToken(randomUUID()),
          email: `cinv-anna-${run}@test.invalid`,
          invitedByMemberId: f.seats.manager.memberId,
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow();
    // The history is still legitimate: many ACCEPTED/REVOKED rows, one
    // PENDING. A plain unique would have forbidden the re-invite itself.
    await inviteContact(ctxOf("manager"), anna);
    expect(
      await f.platform.contactInvite.count({ where: { tenantId: f.tenantId, contactId: anna } }),
    ).toBe(2);
    expect(
      (await f.platform.contactInvite.findFirstOrThrow({ where: { id: first.id } })).status,
    ).toBe("REVOKED");
  });

  it("refuses an ARCHIVED client, as recording a contact there already is", async () => {
    await f.platform.client.update({ where: { id: acme }, data: { archivedAt: new Date() } });
    try {
      await expect(inviteContact(ctxOf("manager"), anna)).rejects.toMatchObject({
        code: "ARCHIVED",
      });
    } finally {
      await f.platform.client.update({ where: { id: acme }, data: { archivedAt: null } });
    }
  });

  it("refuses a contact who already has access", async () => {
    await inviteContact(ctxOf("manager"), anna);
    await f.platform.contact.update({
      where: { tenantId_id: { tenantId: f.tenantId, id: anna } },
      data: { portalStatus: "ACTIVE" },
    });
    // THE CODE, not merely the class. The surface reads it: the row
    // menu picks its verbs from `portalStatus` so this refusal should
    // be unreachable, and when a member does meet it the toast has to
    // say something they can act on. Until the surfaces shipped these
    // were all `INVALID_INPUT`, which renders as "Invalid input."
    await expect(inviteContact(ctxOf("manager"), anna)).rejects.toMatchObject({
      code: "CONTACT_NOT_INVITABLE",
    });
  });

  it("refuses a member without the permission, and a contact out of scope", async () => {
    // THE PERMISSION: `client:manage_contacts` is C M A, so the EMPLOYEE
    // seat is the one that can only fail on the code.
    await expect(inviteContact(ctxOf("employee"), anna)).rejects.toMatchObject({
      reason: "FORBIDDEN",
    });
    // **THE SCOPE, WITH A CALLER THAT IS ACTUALLY OUT OF IT.** The first
    // cut asserted only that the ADMIN is allowed — which is the
    // positive control and nothing more, so deleting `assertInScope`
    // from either writer left the whole suite green. A fresh code review
    // caught it: the one thing a dbtest over a cross-client write exists
    // to prevent. `scoped` holds the permission and is assigned to
    // `acme` alone, so `bo` — of the OTHER client — can only be refused
    // by the scope, and out of scope is NOT_FOUND, never FORBIDDEN.
    await expect(
      inviteContact({ tenantId: f.tenantId, actor: scoped.actor }, bo),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await expect(
      setContactPortalAccess({ tenantId: f.tenantId, actor: scoped.actor }, bo, "REMOVE"),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    // The positive twin, so a refusal cannot pass for a working gate:
    // the same seat reaches its OWN client's contact.
    await expect(
      inviteContact({ tenantId: f.tenantId, actor: scoped.actor }, anna),
    ).resolves.toMatchObject({ inviteId: expect.any(String) });
  });
});

describe("accepting it", () => {
  /** Invite Anna and hand back the raw token, by driving the service and reading the hash back. */
  const inviteAndToken = async (): Promise<string> => {
    // The service never returns the token — it goes to the mail body —
    // so the test mints its own and proves the hash matches, which is
    // the same thing the acceptance path does.
    await inviteContact(ctxOf("manager"), anna);
    const invite = await liveInvite(anna);
    // Recovering the raw token is impossible by design. So: replace the
    // row's hash with one of a token the test knows. That keeps every
    // OTHER property of the invitation real — status, expiry, contact,
    // tenant — and swaps only the secret, which is the one thing the
    // test cannot be given.
    const token = randomUUID().replace(/-/g, "");
    await f.platform.contactInvite.update({
      where: { id: invite.id },
      data: { tokenHash: hashToken(token) },
    });
    return token;
  };

  it("previews without a session, and says nothing about a token it does not know", async () => {
    const token = await inviteAndToken();
    const preview = await previewContactInvite(token);
    expect(preview).toMatchObject({ contactName: "Anna", status: "PENDING", expired: false });
    expect(preview!.tenantName).toContain("cinv");
    // An unknown token is `null`, not a refusal that could be told from
    // a token of another tenant.
    expect(await previewContactInvite(randomUUID())).toBeNull();
    expect(await previewContactInvite("")).toBeNull();
  });

  it("activates the contact, writes the credential, and lets them sign in", async () => {
    const token = await inviteAndToken();
    const { contactId } = await acceptContactInvite({ token, password: PASSWORD });
    expect(contactId).toBe(anna);

    const after = await contactRow(anna);
    expect(after.portalStatus).toBe("ACTIVE");
    expect(after.activatedAt).toBeInstanceOf(Date);
    expect(after.emailVerified).toBe(true);

    // **THE WHOLE POINT OF THE SLICE**: a real session, from the real
    // Better Auth portal instance, whose `session.create` hook admits
    // only the literal ACTIVE. Before this slice no code path could
    // produce a contact that got this far.
    const signIn = await portalAuth.api.signInEmail({
      body: { email: after.email, password: PASSWORD },
    });
    expect(signIn.user).toBeTruthy();

    // The actor is the CONTACT — one of the few events in the product
    // whose actor is not an employee.
    const events = await f.audits("contact.activated");
    expect(events).toHaveLength(1);
    expect(events[0]!.actorType).toBe("CONTACT");
    expect(events[0]!.actorId).toBe(anna);
  });

  it("is single-use, and a superseded or expired token is refused", async () => {
    const token = await inviteAndToken();
    await acceptContactInvite({ token, password: PASSWORD });
    // SINGLE USE: the row is ACCEPTED, so the same link cannot be
    // replayed — by the recipient or by anyone the mail was forwarded to.
    await expect(acceptContactInvite({ token, password: PASSWORD })).rejects.toBeInstanceOf(
      DomainError,
    );

    // EXPIRY is a property of the row, not of a cron: an old invitation
    // is refused when it is PRESENTED, and the row is left alone — see
    // the assertion below and the service's own note on why the
    // "mark it EXPIRED" write was removed as dead code.
    await f.platform.contact.update({
      where: { tenantId_id: { tenantId: f.tenantId, id: anna } },
      data: { portalStatus: "NO_ACCESS" },
    });
    const stale = await inviteAndToken();
    const staleRow = await liveInvite(anna);
    await f.platform.contactInvite.update({
      where: { id: staleRow.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(acceptContactInvite({ token: stale, password: PASSWORD })).rejects.toBeInstanceOf(
      DomainError,
    );
    // **AND IT IS STILL `PENDING`, which is the honest answer.** The
    // first cut stamped `EXPIRED` here and then refused — but the
    // refusal throws, so the stamp rolled back with the transaction: a
    // write that can only ever be undone. `expires_at` is the authority
    // and every reader derives expiry from it, so the row needs no
    // correction for a surface to tell the truth.
    expect((await f.platform.contactInvite.findFirstOrThrow({ where: { id: staleRow.id } })).status).toBe(
      "PENDING",
    );
  });

  it("refuses a password the plane's own policy would refuse", async () => {
    // **THE ONLY PLACE THE POLICY IS APPLIED.** Better Auth keeps
    // `minPasswordLength` in `password.config`, BESIDE `password.hash`,
    // and only its own route handlers consult it — so writing
    // `contact_account` directly (which the invite-only invariant
    // requires) steps around it. This is the sole path that ever sets a
    // portal password for the first time, so a one-character password
    // here opens the whole client company's shared list. Found by a
    // fresh security review; nothing in the suite had noticed.
    const token = await inviteAndToken();
    await expect(acceptContactInvite({ token, password: "a" })).rejects.toBeInstanceOf(DomainError);
    await expect(acceptContactInvite({ token, password: "" })).rejects.toBeInstanceOf(DomainError);
    // The long half matters too: without it an unauthenticated caller
    // hands scrypt a megabyte.
    await expect(
      acceptContactInvite({ token, password: "x".repeat(200) }),
    ).rejects.toBeInstanceOf(DomainError);
    // And the contact is untouched by any of it — a refused acceptance
    // must not half-activate anybody.
    expect((await contactRow(anna)).portalStatus).toBe("INVITED");
    expect(await f.platform.contactAccount.count({ where: { contactId: anna } })).toBe(0);
  });

  it("refuses a token whose contact has been renamed to somebody else", async () => {
    // SECURITY.md §3.4 says the token is "bound to the invited email".
    // It names a ROW, and `updateContact` may change that row's address
    // while the link is in flight — so without the binding the mail sent
    // to one person would activate a contact who is now another, and
    // acceptance would stamp `emailVerified` for an address nobody
    // proved control of.
    const token = await inviteAndToken();
    await f.platform.contact.update({
      where: { tenantId_id: { tenantId: f.tenantId, id: anna } },
      data: { email: `cinv-someone-else-${run}@test.invalid` },
    });
    await expect(acceptContactInvite({ token, password: PASSWORD })).rejects.toBeInstanceOf(
      DomainError,
    );
    expect((await contactRow(anna)).portalStatus).toBe("INVITED");
    await f.platform.contact.update({
      where: { tenantId_id: { tenantId: f.tenantId, id: anna } },
      data: { email: `cinv-anna-${run}@test.invalid` },
    });
  });

  it("cannot mint a credential for a contact nobody invited — the DATABASE refuses it", async () => {
    // INVITE-ONLY AS AN INVARIANT, not a convention. This is the hole
    // `/reset-password` would otherwise have opened: Better Auth creates
    // a credential when none exists, so a contact a member had merely
    // RECORDED could have set themselves a password. The trigger is what
    // closes it, and it is driven here directly rather than trusted.
    const authCtx = await portalAuth.$context;
    await expect(
      f.platform.contactAccount.create({
        data: {
          contactId: anna, // still NO_ACCESS — `beforeEach` reset it
          accountId: anna,
          providerId: "credential",
          password: await authCtx.password.hash(PASSWORD),
        },
      }),
    ).rejects.toThrow();
  });
});


describe("taking access away, and giving it back", () => {
  /** An ACTIVE contact with a credential — the state every case here starts from. */
  const activate = async (): Promise<void> => {
    await inviteContact(ctxOf("manager"), anna);
    const invite = await liveInvite(anna);
    const token = randomUUID().replace(/-/g, "");
    await f.platform.contactInvite.update({
      where: { id: invite.id },
      data: { tokenHash: hashToken(token) },
    });
    await acceptContactInvite({ token, password: PASSWORD });
  };

  /** A live task handed to Anna, returning its id. */
  const handOver = async (title: string): Promise<string> => {
    const id = randomUUID();
    await f.platform.workItem.create({
      data: {
        id,
        tenantId: f.tenantId,
        clientId: acme,
        projectId: project,
        number: nextNumber++,
        title: `${title} ${run}`,
        type: "TASK",
        kind: "TASK",
        stateId: todo,
        stateCategory: "TODO",
        rank: `a${nextNumber}`,
        // Self-rooted, as every top-level item is: the column is NOT
        // NULL and `createItem` sets it to the row's own id.
        rootId: id,
        // The CHECK `work_item_contact_assignee_visible` admits no other
        // value on a contact-assigned row.
        visibility: "CLIENT_VISIBLE",
        assigneeContactId: anna,
        createdByMemberId: f.seats.manager.memberId,
      },
    });
    return id;
  };

  it("PAUSE keeps their work and their credential, and kills the session", async () => {
    await activate();
    const task = await handOver("Still theirs");
    const signIn = await portalAuth.api.signInEmail({
      body: { email: (await contactRow(anna)).email, password: PASSWORD },
    });
    expect(signIn.user).toBeTruthy();
    expect(await f.platform.contactSession.count({ where: { contactId: anna } })).toBeGreaterThan(0);

    const out = await setContactPortalAccess(ctxOf("manager"), anna, "PAUSE");
    expect(out).toEqual({ status: "SUSPENDED", releasedTasks: 0 });

    // **THE WORK STAYS**, which is what makes the resume honest: a pause
    // is "they will be back", and taking their tasks away would make the
    // one-click return a lie (founder decision, 2026-09-23).
    expect((await f.platform.workItem.findFirstOrThrow({ where: { id: task } })).assigneeContactId).toBe(
      anna,
    );
    // The credential survives, so resuming needs no new invitation.
    expect(await f.platform.contactAccount.count({ where: { contactId: anna } })).toBe(1);
    // The session does not. `session.create` already refuses a
    // non-ACTIVE contact, so a live cookie dies at its next check
    // anyway — but "anyway" is not a guarantee to reason about when the
    // act is "cut this person off now".
    expect(await f.platform.contactSession.count({ where: { contactId: anna } })).toBe(0);
    await expect(f.audits("contact.suspended")).resolves.toHaveLength(1);
  });

  it("cannot sign in while paused, and can again after RESUME", async () => {
    await activate();
    const email = (await contactRow(anna)).email;
    await setContactPortalAccess(ctxOf("manager"), anna, "PAUSE");

    // THE HOOK, not the service: `portalAuth`'s `session.create` admits
    // the literal ACTIVE and nothing else, AFTER password verification
    // so it cannot be used to enumerate addresses.
    await expect(
      portalAuth.api.signInEmail({ body: { email, password: PASSWORD } }),
    ).rejects.toThrow();

    const out = await setContactPortalAccess(ctxOf("manager"), anna, "RESUME");
    expect(out.status).toBe("ACTIVE");
    const back = await portalAuth.api.signInEmail({ body: { email, password: PASSWORD } });
    expect(back.user).toBeTruthy();
    // The resume has its own audit row: an operator must be able to SEE
    // that access came back, not infer it from the absence of a later
    // event.
    await expect(f.audits("contact.access_restored")).resolves.toHaveLength(1);
  });

  it.each(["PAUSE", "REMOVE"] as const)(
    "%s kills an outstanding password-reset link, so the person cannot take the credential back",
    async (action) => {
      await activate();
      // A link mailed while they were ACTIVE, written through the instance's
      // own adapter so it is stored exactly as a real one is — HASHED, since
      // the portal's reset screens shipped.
      const { internalAdapter } = await portalAuth.$context;
      const raw = `cinvreset${randomUUID().replace(/-/g, "")}`;
      await internalAdapter.createVerificationValue({
        identifier: `reset-password:${raw}`,
        value: anna,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      expect(await f.platform.contactVerification.count({ where: { value: anna } })).toBe(1);

      await setContactPortalAccess(ctxOf("manager"), anna, action);

      // THE PURGE, and until this test nothing covered it. It is keyed on
      // `value` — the first version keyed it on the address and matched
      // nothing — and hashed storage changed the IDENTIFIER, not the value,
      // which is why it still holds. This is what says so.
      expect(await f.platform.contactVerification.count({ where: { value: anna } })).toBe(0);
      const res = await portalAuth.api.resetPassword({
        body: { token: raw, newPassword: "a-new-password-123" },
        asResponse: true,
      });
      expect(res.status).toBe(400);
    },
  );

  it("a NEW ADDRESS kills the reset links mailed to the old one — and a new title does not", async () => {
    await activate();
    const { internalAdapter } = await portalAuth.$context;
    const live = async () => {
      await internalAdapter.createVerificationValue({
        identifier: `reset-password:cinvaddr${randomUUID().replace(/-/g, "")}`,
        value: anna,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
    };
    await live();

    // Nothing to do with where the mail went: the link stays.
    await updateContact(ctxOf("manager"), anna, { title: "Head of marketing" });
    expect(await f.platform.contactVerification.count({ where: { value: anna } })).toBe(1);

    // The address a member changes to cut the old mailbox off: every link
    // mailed to it dies with the change, in the same transaction.
    const before = (await contactRow(anna)).email;
    try {
      await updateContact(ctxOf("manager"), anna, { email: `moved-${before}` });
      expect(await f.platform.contactVerification.count({ where: { value: anna } })).toBe(0);
    } finally {
      // Restored for the suite's other cases, which share the fixture.
      await f.platform.contact.update({
        where: { tenantId_id: { tenantId: f.tenantId, id: anna } },
        data: { email: before, title: null },
      });
    }
  });

  it("REMOVE returns every task, deletes the credential, and kills any open invitation", async () => {
    await activate();
    const held = await handOver("Coming back");
    const other = await handOver("Coming back too");
    // **ONE OF THEM CARRIES A CLAIM**, or the `contactCompletedAt: null`
    // assertion below is vacuous — it was already null on every fixture
    // row, so deleting that line from the sweep left the suite green. It
    // is the line guarding `work_item_contact_completed_has_assignee`
    // (`contact_completed_at IS NULL OR assignee_contact_id IS NOT NULL`),
    // whose violation would roll the whole removal back. Found by a
    // fresh code review.
    await f.platform.workItem.update({
      where: { id: held },
      data: { contactCompletedAt: new Date() },
    });
    // And one of them is NOT live: the sweep is documented to take every
    // row, because a DONE or soft-deleted task still holds the FK that
    // blocks erasure.
    await f.platform.workItem.update({
      where: { id: other },
      data: { stateCategory: "DONE", archivedAt: new Date() },
    });

    const out = await setContactPortalAccess(ctxOf("manager"), anna, "REMOVE");
    expect(out).toEqual({ status: "REVOKED", releasedTasks: 2 });

    for (const id of [held, other]) {
      const row = await f.platform.workItem.findFirstOrThrow({ where: { id } });
      expect(row.assigneeContactId).toBeNull();
      expect(row.contactCompletedAt).toBeNull();
      // **THE VISIBILITY IS LEFT ALONE.** Taking one person's access away
      // is not a decision to hide the work from their COMPANY — a
      // colleague may still be reading it, and `portal_gate` is
      // client-scoped.
      expect(row.visibility).toBe("CLIENT_VISIBLE");
    }
    // One history row per released task, so the trail says where the
    // work went.
    expect(
      await f.platform.workItemActivity.count({
        where: { tenantId: f.tenantId, field: "assigneeContactId" },
      }),
    ).toBeGreaterThanOrEqual(2);
    expect(await f.platform.contactAccount.count({ where: { contactId: anna } })).toBe(0);
    expect(await f.platform.contactSession.count({ where: { contactId: anna } })).toBe(0);
    const events = await f.audits("contact.access_revoked");
    expect(events).toHaveLength(1);
    // A COUNT, never the ids or the titles (SECURITY.md §7).
    expect(events[0]!.metadata).toMatchObject({ releasedTasks: 2, from: "ACTIVE", to: "REVOKED" });
  });

  it("the sweep is what makes a removed contact deletable at all", async () => {
    // **THE ERASURE CONTROL, and it is the residue slice 6c's review
    // named.** `work_item.assignee_contact_id` has an ON DELETE RESTRICT
    // FK, so a contact still holding a task cannot be deleted at any
    // price — a person's record undeletable because of work nobody can
    // see. Only a real foreign key fails this way.
    await activate();
    await handOver("Blocks the delete");
    await setContactPortalAccess(ctxOf("manager"), anna, "REMOVE");

    // `deleteContact` admits NO_ACCESS or REVOKED — both mean "no live
    // access", which is what that guard is actually protecting.
    await deleteContact({ tenantId: f.tenantId, actor: f.seats.manager.actor }, anna);
    expect(
      await f.platform.contact.count({ where: { tenantId: f.tenantId, id: anna } }),
    ).toBe(0);

    // Restored for the suite's other cases, which share the fixture.
    await f.platform.contact.create({
      data: {
        id: anna,
        tenantId: f.tenantId,
        clientId: acme,
        name: "Anna",
        email: `cinv-anna-${run}@test.invalid`,
      },
    });
  });

  it("refuses a move that makes no sense, rather than inventing one", async () => {
    // NO_ACCESS cannot be paused, and there is nothing to remove.
    await expect(setContactPortalAccess(ctxOf("manager"), anna, "PAUSE")).rejects.toMatchObject({
      code: "ACCESS_TRANSITION_INVALID",
    });
    await expect(setContactPortalAccess(ctxOf("manager"), anna, "REMOVE")).rejects.toMatchObject({
      code: "ACCESS_TRANSITION_INVALID",
    });
    await activate();
    // ACTIVE cannot be resumed — only a pause can.
    await expect(setContactPortalAccess(ctxOf("manager"), anna, "RESUME")).rejects.toMatchObject({
      code: "ACCESS_TRANSITION_INVALID",
    });
  });

  it("writes the portal's OWN sign-in trail — the obligation this slice was gated on", async () => {
    // AUTHZ §8 deferred the portal auth audit "only because no contact
    // can sign in today", and required it to land with the first path
    // that can activate one. This is that path (founder decision,
    // 2026-09-23, after two reviews raised it). Driven through the real
    // Better Auth instance, because the plugin's hooks are what fire —
    // a test of the sink alone would prove the sink and not the wiring.
    await activate();
    const email = (await contactRow(anna)).email;

    await portalAuth.api.signInEmail({ body: { email, password: PASSWORD } });
    const ok = await f.audits("auth.login_succeeded");
    expect(ok).toHaveLength(1);
    // THE CONTACT is the actor, not `system` — `record()` would have
    // stamped SYSTEM, since a portal write's principal is a system one.
    expect(ok[0]!.actorType).toBe("CONTACT");
    expect(ok[0]!.actorId).toBe(anna);
    // No address anywhere on the row (SECURITY.md §7): an audit log that
    // records which addresses were tried is a list worth stealing.
    expect(JSON.stringify(ok[0]!.metadata)).not.toContain("@");

    await expect(
      portalAuth.api.signInEmail({ body: { email, password: "not-the-password" } }),
    ).rejects.toThrow();
    const bad = await f.audits("auth.login_failed");
    expect(bad).toHaveLength(1);
    // NOBODY AUTHENTICATED, so the actor is the system and the contact is
    // the TARGET — the member sink draws the same line.
    expect(bad[0]!.actorType).toBe("SYSTEM");
    expect(bad[0]!.targetId).toBe(anna);
  });

  it("refuses to DELETE a contact who has written anything", async () => {
    // The founder's answer of 2026-09-23: keep the name, refuse the
    // delete. Admitting REVOKED to `deleteContact` made it possible for
    // the first time to hard-delete somebody who had actually used the
    // portal — and their comments and requests carry attribution with no
    // foreign key, so the delete would leave their words in the portal
    // their COLLEAGUES still read, authored by nobody.
    await activate();
    const id = await handOver("They commented on this");
    await f.platform.comment.create({
      data: {
        tenantId: f.tenantId,
        clientId: acme,
        projectId: project,
        subjectType: "WORK_ITEM",
        subjectId: id,
        authorContactId: anna,
        body: { type: "doc", content: [] },
        bodyText: "Looks good to me",
        visibility: "CLIENT_VISIBLE",
      },
    });
    await setContactPortalAccess(ctxOf("manager"), anna, "REMOVE");

    // The sweep released the task, so the RESTRICT FK is no longer what
    // refuses — this is the new guard, and only it.
    await expect(
      deleteContact({ tenantId: f.tenantId, actor: f.seats.manager.actor }, anna),
    ).rejects.toMatchObject({ code: "CONTACT_HAS_HISTORY" });
    expect(await f.platform.contact.count({ where: { tenantId: f.tenantId, id: anna } })).toBe(1);
  });

  it("refuses a member without the permission", async () => {
    await activate();
    await expect(setContactPortalAccess(ctxOf("employee"), anna, "PAUSE")).rejects.toMatchObject({
      reason: "FORBIDDEN",
    });
  });

  it("A REVOKED CONTACT CAN BE INVITED AGAIN, and accept again (founder decision C28)", async () => {
    // **THE CASE THIS EXISTS FOR.** Ending somebody's access used to be
    // an ABSORBING state: `inviteContact` admitted NO_ACCESS and INVITED
    // only, and `deleteContact` refuses anybody who has written in the
    // portal — so a client contact who left and came back, or one whose
    // access was ended by mistake, had no route to portal access at all.
    // The founder settled it the other way (OPEN_QUESTIONS C28): a fresh
    // invitation is the way back.
    await activate();
    const removed = await setContactPortalAccess(ctxOf("manager"), anna, "REMOVE");
    expect(removed.status).toBe("REVOKED");
    // The credential really is gone, so this is not "re-inviting somebody
    // who could still sign in".
    expect(await f.platform.contactAccount.count({ where: { contactId: anna } })).toBe(0);

    // WHAT REMOVE LEAVES BEHIND, asserted against a real REMOVE rather
    // than against the fixture's own reset — `beforeEach` clears exactly
    // these three columns, so a test that leaned on it would be measuring
    // the fixture. `setContactPortalAccess` writes `portalStatus` and
    // nothing else on the row: the stamps still describe the OLD
    // invitation. Harmless, but not for the reason a first draft of this
    // comment gave: acceptance rewrites `portalStatus`, `activatedAt`
    // and `emailVerified` and never touches `invitedAt` — the RE-INVITE
    // is what re-stamps that, which is what the assertion below
    // measures. Asserted so a future change to either write is noticed.
    const afterRemove = await contactRow(anna);
    expect(afterRemove.emailVerified).toBe(true);
    expect(afterRemove.activatedAt).not.toBeNull();
    const staleInvitedAt = afterRemove.invitedAt;
    expect(staleInvitedAt).not.toBeNull();

    // THE RE-INVITE. A fresh token, not a resend. Nothing collides with
    // the partial unique here because the previous invitation was
    // ACCEPTED by `activate()` — REMOVE's own revoke-any-PENDING leg
    // matched zero rows in this test, and the case where it matters has
    // its own test below. (A review caught this comment claiming the
    // opposite, and the gap behind it.)
    const { mailed } = await inviteContact(ctxOf("manager"), anna);
    expect(mailed).toBe(true);
    const reinvited = await contactRow(anna);
    expect(reinvited.portalStatus).toBe("INVITED");
    expect(reinvited.invitedAt!.getTime()).toBeGreaterThan(staleInvitedAt!.getTime());

    // AND IT ACCEPTS. The credential trigger admits INVITED or ACTIVE and
    // `acceptContactInvite` flips the row to ACTIVE before the insert, so
    // the upsert takes its CREATE path against a row that has none.
    const invite = await liveInvite(anna);
    const token = randomUUID().replace(/-/g, "");
    await f.platform.contactInvite.update({
      where: { id: invite.id },
      data: { tokenHash: hashToken(token) },
    });
    await acceptContactInvite({ token, password: PASSWORD });
    expect((await contactRow(anna)).portalStatus).toBe("ACTIVE");
    expect(await f.platform.contactAccount.count({ where: { contactId: anna } })).toBe(1);

    // AND THEY CAN REALLY SIGN IN — the claim no column check makes.
    const res = await portalAuth.api.signInEmail({
      body: { email: (await contactRow(anna)).email, password: PASSWORD },
    });
    expect(res.token).toBeTruthy();
  });

  it("re-inviting does NOT give the released assignments back", async () => {
    // The other half of C28, and the reason the docblock says so: a
    // removal released the work to the agency, and restoring access is
    // not restoring history. A member reassigns deliberately.
    await activate();
    const itemId = await handOver("Work Anna held");
    await setContactPortalAccess(ctxOf("manager"), anna, "REMOVE");
    expect(
      (await f.platform.workItem.findUniqueOrThrow({ where: { id: itemId } })).assigneeContactId,
    ).toBeNull();

    await inviteContact(ctxOf("manager"), anna);
    expect(
      (await f.platform.workItem.findUniqueOrThrow({ where: { id: itemId } })).assigneeContactId,
    ).toBeNull();
  });

  it("still refuses an ACTIVE or SUSPENDED contact — C28 widened the list, it did not open it", async () => {
    await activate();
    await expect(inviteContact(ctxOf("manager"), anna)).rejects.toMatchObject({
      code: "CONTACT_NOT_INVITABLE",
    });
    await setContactPortalAccess(ctxOf("manager"), anna, "PAUSE");
    // A paused contact is RESUMED, never re-invited: re-inviting would
    // undo the pause through a door that audits `contact.invited` and
    // leaves `RESUME` throwing.
    await expect(inviteContact(ctxOf("manager"), anna)).rejects.toMatchObject({
      code: "CONTACT_NOT_INVITABLE",
    });
  });


  it("REMOVE REVOKES A PENDING INVITATION, so the re-invite C28 allows cannot trip the live-token unique", async () => {
    // **THE LEG NOTHING COVERED, and C28 is what made it load-bearing.**
    // `setContactPortalAccess`'s REMOVE flips any PENDING invitation to
    // REVOKED. Until C28 that write was inert in practice: a REVOKED
    // contact could not be invited at all, so a stale PENDING row could
    // never collide with anything. Now it can.
    //
    // The scenario is the ordinary undo: a member invites the wrong
    // person and ends their access straight away, before the invitation
    // is accepted. If REMOVE stopped revoking that row, the re-invite
    // would trip `contact_invite_one_live_idx` and fail INVITE_IN_FLIGHT
    // FOREVER — which is exactly the dead end C28 was decided to remove,
    // reached through a different door. Every other test in this file
    // reaches REVOKED through `activate()`, where the invitation is
    // ACCEPTED and REMOVE's leg matches nothing. Found by a fresh review.
    await inviteContact(ctxOf("manager"), anna);
    expect((await liveInvite(anna)).status).toBe("PENDING");

    await setContactPortalAccess(ctxOf("manager"), anna, "REMOVE");
    expect((await contactRow(anna)).portalStatus).toBe("REVOKED");
    const invites = await f.platform.contactInvite.findMany({
      where: { tenantId: f.tenantId, contactId: anna },
      select: { status: true },
    });
    expect(invites).toHaveLength(1);
    expect(invites[0]!.status).toBe("REVOKED");

    // And the re-invite therefore succeeds rather than colliding.
    await inviteContact(ctxOf("manager"), anna);
    expect((await contactRow(anna)).portalStatus).toBe("INVITED");
    expect((await liveInvite(anna)).status).toBe("PENDING");
  });

});
