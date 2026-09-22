import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { MemberActor } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { DomainError } from "@/lib/domain-error";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { resolvePortalModuleGates, type PortalPrincipal } from "@/portal";

import { assignItem, assignItemToContact, changeItemVisibility, createItem, getItemDetail, listItems } from "./items";
import { listPortalTasks } from "./portal";
import { setPortalTaskDone } from "./portal-writes";
import { changeState } from "./states";

/**
 * A TASK THE AGENCY HANDS TO THE CLIENT, AND THE CLIENT'S ANSWER —
 * Phase 3 slice 6c, end to end against the real schema, the real
 * `app_runtime` role and a real contact principal.
 *
 * It is one file because it is one story told across two planes, and
 * the invariants only exist at the seam between them:
 *
 *  · **Handing over IS sharing, and it is gated as sharing.** The CHECK
 *    `work_item_contact_assignee_visible` leaves no third answer, so
 *    `assignItemToContact` on an INTERNAL row demands
 *    `work_item:change_visibility` (C M A) on top of `work_item:edit`.
 *    Two seats make that measurable one gate at a time — and only a
 *    database can, because the permission resolution is rows.
 *  · **The tick moves nothing.** The founder's 2026-09-22 decision as a
 *    fact about the row: `state_category` is identical before and
 *    after, and the only column that changes is the claim.
 *  · **A claim cannot outlive what it answers.** Three writers clear it
 *    — unassignment, reassignment, and the state machine ARRIVING at
 *    DONE or CANCELLED — and `work_item_contact_completed_has_assignee`
 *    is what makes the first two unforgettable. A CHECK is only real
 *    against Postgres.
 *  · **"Assigned to this contact" is a term of the WRITE, not a
 *    courtesy of the UI.** A colleague of the same client can READ the
 *    task through `portal_gate` and still cannot tick it, which is the
 *    one refusal no read-side test can produce.
 *
 * EVERY REFUSAL CASE IS CHOSEN SO THAT EXACTLY ONE GATE CAN BE THE ONE
 * REFUSING — the lesson both fresh reviews of slice 6b landed on, from
 * opposite directions. Each has a positive twin, so a refusal arriving
 * for the wrong reason cannot pass for a working guard.
 *
 * Tenant slugs come from `setupTenant("ctask")`, and the prefix
 * `ctask-` is registered in `DBTEST_PREFIXES` (e2e/fixtures/seed-cli.ts)
 * so `sweep-dbtests` can collect this suite's orphans. `e2e-` is the
 * BROWSER harness's prefix and is swept by AGE — a dbtest using it
 * would have its fixtures deleted mid-run by a concurrent e2e run.
 */

const run = randomUUID().slice(0, 8);

let f: Awaited<ReturnType<typeof setupTenant>>;
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;
let acme: string;
let beta: string;
/** Portal ON. The employee seat holds a `MemberProject` here. */
let pOn: string;
/** Portal ON, and the employee seat is NOT assigned to it — the scope gate. */
let pUnassigned: string;
/** Portal ON, of the OTHER client. */
let pBeta: string;
/** Anna — ACTIVE, of `acme`. The assignee in almost every case. */
let anna: string;
/** Bea — ACTIVE, of `acme`. Anna's COLLEAGUE: reads everything, ticks nothing. */
let bea: string;
/** Sven — SUSPENDED, of `acme`. */
let sven: string;
/** Bo — ACTIVE, of the OTHER client. */
let bo: string;
/**
 * A CUSTOM SEAT THAT MAY LOOK AND NOT TOUCH — `work_item:view` +
 * `project:view` + `client:view`, scoped DIRECTLY to `acme` (see
 * `seatWith` for why not through the project). Every template role holds
 * `work_item:edit`, so without this seat "the picker offers nobody to a
 * member who cannot edit" has no way to be false. `client:view` is
 * deliberately present: it is the OTHER gate, and a seat missing both
 * could not say which one refused.
 */
let viewerOnly: { memberId: string; actor: MemberActor };
/**
 * A CUSTOM SEAT THAT MAY EDIT THE TASK AND NOT READ THE CLIENT —
 * `work_item:view` + `work_item:edit` + `project:view`, and NOT
 * `client:view`, scoped directly to `acme`. It is the only way the
 * panel's client group can be shown to have a gate of its own: this
 * seat's picker is a working control that simply has no second group.
 */
let noClientView: { memberId: string; actor: MemberActor };
/**
 * The `user` rows of the two seats above. `setupTenant`'s own cleanup
 * deletes only the FOUR template users it made — a custom seat's user
 * is nobody's to collect, and `user` is PLATFORM-level, so leaving one
 * behind is a row `sweep-dbtests` cannot reach by tenant either.
 */
const extraUserIds: string[] = [];

const principal = (contactId: string, over: Partial<PortalPrincipal> = {}): PortalPrincipal => ({
  contactId,
  tenantId: f.tenantId,
  clientId: acme,
  gates,
  ...over,
});

const ctxOf = (seat: "owner" | "admin" | "manager" | "employee") => ({
  tenantId: f.tenantId,
  actor: f.seats[seat].actor,
});

const rowOf = (id: string) =>
  f.platform.workItem.findFirstOrThrow({
    where: { tenantId: f.tenantId, id },
    omit: { description: true, descriptionText: true },
  });

/** A live, INTERNAL task in `pOn`, created by the manager. */
const task = async (title: string, projectId = pOn) =>
  (await createItem(ctxOf("manager"), { projectId, title: `${title} ${run}` })).id;

/** A live task already shared with the client — the employee's starting point. */
const sharedTask = async (title: string, projectId = pOn) => {
  const id = await task(title, projectId);
  await changeItemVisibility(ctxOf("manager"), id, "CLIENT_VISIBLE");
  return id;
};

/** A shared task handed to Anna and ticked by her. */
const claimedTask = async (title: string) => {
  const id = await sharedTask(title);
  await assignItemToContact(ctxOf("manager"), id, anna);
  await setPortalTaskDone(principal(anna), id, true);
  return id;
};

const stateOf = async (projectId: string, seedKey: "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED") =>
  (
    await f.platform.workflowState.findFirstOrThrow({
      where: { tenantId: f.tenantId, projectId, seedKey },
      select: { id: true },
    })
  ).id;

beforeAll(async () => {
  f = await setupTenant("ctask");
  acme = randomUUID();
  beta = randomUUID();
  pOn = randomUUID();
  pUnassigned = randomUUID();
  pBeta = randomUUID();
  anna = randomUUID();
  bea = randomUUID();
  sven = randomUUID();
  bo = randomUUID();

  const up = run.slice(0, 3).toUpperCase();
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: `Acme ${run}` },
      { id: beta, tenantId: f.tenantId, name: `Beta ${run}` },
    ],
  });
  await f.platform.project.createMany({
    data: [
      {
        id: pOn,
        tenantId: f.tenantId,
        clientId: acme,
        key: `CTA${up}`,
        name: `Site ${run}`,
        portalEnabled: true,
        leadMemberId: f.seats.manager.memberId,
      },
      { id: pUnassigned, tenantId: f.tenantId, clientId: acme, key: `CTB${up}`, name: `Shop ${run}`, portalEnabled: true },
      { id: pBeta, tenantId: f.tenantId, clientId: beta, key: `CTC${up}`, name: `Beta ${run}`, portalEnabled: true },
    ],
  });
  // THE EMPLOYEE REACHES `pOn` AND NOT `pUnassigned`, which is what
  // lets the scope gate and the permission gate be told apart: on `pOn`
  // the employee has scope and lacks `work_item:change_visibility`; on
  // `pUnassigned` it lacks scope and the permission never gets a say.
  await f.platform.memberProject.create({
    data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, projectId: pOn },
  });

  const invitedAt = new Date("2026-09-01T09:00:00Z");
  // EXPLICIT, DISTINCT `createdAt`s, because the picker's ORDER is part
  // of what is measured below. `createMany` stamps one `now()` for the
  // whole statement, so four rows written together are tied on the
  // column the list is ordered by and fall through to the id — which is
  // a v7 UUID minted by `randomUUID()` here and therefore arbitrary. A
  // test written against that order passes or fails by luck.
  await f.platform.contact.createMany({
    data: [
      { id: anna, tenantId: f.tenantId, clientId: acme, name: "Anna", email: `ctask-anna-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt, emailVerified: true, createdAt: new Date("2026-09-01T10:00:00Z") },
      { id: bea, tenantId: f.tenantId, clientId: acme, name: "Bea", email: `ctask-bea-${run}@test.invalid`, portalProfile: "CONTACT_COLLABORATOR", portalStatus: "ACTIVE", invitedAt, emailVerified: true, createdAt: new Date("2026-09-02T10:00:00Z") },
      { id: sven, tenantId: f.tenantId, clientId: acme, name: "Sven", email: `ctask-sven-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "SUSPENDED", invitedAt, emailVerified: true, createdAt: new Date("2026-09-03T10:00:00Z") },
      { id: bo, tenantId: f.tenantId, clientId: beta, name: "Bo", email: `ctask-bo-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt, emailVerified: true, createdAt: new Date("2026-09-04T10:00:00Z") },
    ],
  });

  // ── The two custom seats (see their declarations above) ───────────
  //
  // THE CATALOGUE MUST BE SEEDED for either to mean anything: with no
  // `permission` rows a custom role holds nothing, every case below
  // would pass by refusing everybody, and the two gates would be
  // indistinguishable from a missing read. `scripts/seed-catalog.ts` is
  // what puts them there.
  const seatWith = async (label: string, codes: readonly string[]) => {
    const userId = randomUUID();
    await f.platform.user.create({
      data: { id: userId, name: `${label}-${run}@test.invalid`, email: `${label}-${run}@test.invalid` },
    });
    // RECORDED THE MOMENT IT EXISTS, never at the end of the helper. A
    // `user` row is PLATFORM-level, so an orphan is one `sweep-dbtests`
    // cannot reach by tenant — and everything below can throw, including
    // the catalogue assertion this helper's own comment warns about, in
    // which case `afterAll` would see an empty list and leave the row
    // behind for good. Found by a fresh code review.
    extraUserIds.push(userId);
    const member = await f.platform.member.create({ data: { tenantId: f.tenantId, userId } });
    const role = await f.platform.role.create({
      data: { tenantId: f.tenantId, name: `${label} ${run}` },
    });
    const perms = await f.platform.permission.findMany({ where: { code: { in: [...codes] } } });
    expect(perms.map((p) => p.code).sort()).toEqual([...codes].sort());
    await f.platform.rolePermission.createMany({
      data: perms.map((p) => ({ tenantId: f.tenantId, roleId: role.id, permissionId: p.id })),
    });
    await f.platform.memberRole.create({
      data: { tenantId: f.tenantId, memberId: member.id, roleId: role.id },
    });
    // **SCOPE THROUGH THE CLIENT, NOT THE PROJECT**, and the reason is a
    // failure this fixture actually produced: `pOn`'s `MemberProject`
    // rows ARE the notification audience for a request and for a
    // contact's tick (`requestReceivers`), so adding two seats there
    // silently widened the audience an existing case asserts exactly.
    // A fixture may not change what another test measures. Direct client
    // scope reaches every project of the client and notifies nobody.
    // The LIFT — project scope reaching the client — is exercised by the
    // employee seat instead, which has it and holds `client:view`.
    await f.platform.memberClient.create({
      data: { tenantId: f.tenantId, memberId: member.id, clientId: acme },
    });
    return { memberId: member.id, actor: actorFor(member.id) };
  };
  viewerOnly = await seatWith("ctask-viewer", ["work_item:view", "project:view", "client:view"]);
  noClientView = await seatWith("ctask-noclient", ["work_item:view", "work_item:edit", "project:view"]);

  gates = await resolvePortalModuleGates(f.tenantId);
});

beforeEach(async () => {
  await f.platform.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${f.tenantId}`;
  await f.platform.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.workItem.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
    await tx.auditEvent.deleteMany({ where: { tenantId: f.tenantId } });
  });
});

afterAll(async () => {
  if (!f) return;
  await f.platform.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${f.tenantId}`;
  await f.platform.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.workItem.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
  // `nextCounter` mints a `tenant_counter` row per project and its FK to
  // `tenant` is RESTRICT, so without this the tenant delete inside
  // `setupTenant`'s cleanup fails with 23001 and strands the fixture.
  await f.platform.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.memberProject.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.memberClient.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.contact.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.project.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
  // AFTER `cleanup()`, never before: `member` has a foreign key to
  // `user`, and it is `cleanup()` that deletes this tenant's members.
  // Prisma reconnects lazily, so the disconnect inside it is not a wall.
  await f.platform.user.deleteMany({ where: { id: { in: extraUserIds } } });
});

describe("handing a task to a client's contact", () => {
  it("publishes the task and audits the share, for a member who may share", async () => {
    const id = await task("Send us your logo");
    const before = await rowOf(id);
    expect(before.visibility).toBe("INTERNAL");

    const out = await assignItemToContact(ctxOf("manager"), id, anna);
    expect(out).toMatchObject({ assigneeContactId: anna, assigneeName: "Anna", shared: true, changed: true });

    const after = await rowOf(id);
    expect(after.assigneeContactId).toBe(anna);
    expect(after.visibility).toBe("CLIENT_VISIBLE");
    // The CHECK's other half: the XOR took the task off the agency.
    expect(after.assigneeMemberId).toBeNull();

    // THE SHARE IS AUDITED AS A SHARE. An operator reading the log must
    // not have to know that assignment is a way to publish — `via` is
    // what says nobody pressed "share".
    const events = await f.audits("work_item.visibility_changed");
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toMatchObject({
      from: "INTERNAL",
      to: "CLIENT_VISIBLE",
      projectId: pOn,
      via: "contact_assignment",
    });
  });

  it("REFUSES a member who may edit but may not share — the one gate that can be refusing", async () => {
    const id = await task("Approve the copy");
    // The employee has scope on `pOn` (a MemberProject row) and holds
    // `work_item:edit` (C M A E). The ONLY thing it lacks is
    // `work_item:change_visibility` (C M A) — so this refusal has one
    // possible author.
    await expect(assignItemToContact(ctxOf("employee"), id, anna)).rejects.toMatchObject({
      reason: "FORBIDDEN",
    });
    const after = await rowOf(id);
    expect(after.assigneeContactId).toBeNull();
    expect(after.visibility).toBe("INTERNAL");
  });

  it("ALLOWS that same member on a task the client can already see — the positive twin", async () => {
    // Same seat, same project, same contact: the only thing that moved
    // is that no flip is needed. A refusal above that survived this
    // would be a refusal about something else.
    const id = await sharedTask("Review the draft");
    const out = await assignItemToContact(ctxOf("employee"), id, anna);
    expect(out).toMatchObject({ shared: false, changed: true });
    expect((await rowOf(id)).assigneeContactId).toBe(anna);
    // Nothing was published by THIS call, so nothing it wrote is
    // audited as a publication. The fixture's own share is one such
    // event already, which is why this filters on `via` rather than
    // counting: a bare `toHaveLength(0)` here was measuring the setup.
    const shares = await f.audits("work_item.visibility_changed");
    expect(shares.filter((e) => JSON.stringify(e.metadata).includes("contact_assignment"))).toHaveLength(0);
  });

  it("refuses a project the member's scope does not reach — the OTHER gate", async () => {
    // Already shared, so `work_item:change_visibility` is not consulted
    // at all; the employee holds `work_item:edit`. Only scope is left,
    // and out-of-scope is NOT_FOUND rather than FORBIDDEN (AUTHZ §4:
    // existence must not leak).
    const id = await sharedTask("Out of reach", pUnassigned);
    await expect(assignItemToContact(ctxOf("employee"), id, anna)).rejects.toMatchObject({
      reason: "NOT_FOUND",
    });
  });

  it("refuses a contact of ANOTHER client, and every status that is not ACTIVE or INVITED", async () => {
    const id = await sharedTask("Wrong audience");
    // The read that resolves the contact is bound to the ITEM's client,
    // which is what keeps a cross-client assignment out — the schema's
    // FK carries no `client_id` term and would have accepted the row.
    await expect(assignItemToContact(ctxOf("manager"), id, bo)).rejects.toBeInstanceOf(AuthzError);

    // AN ALLOWLIST, DRIVEN AS ONE. The first cut refused `SUSPENDED`
    // alone and admitted the other three — including `NO_ACCESS`, which
    // is the column's DEFAULT and therefore what every contact on a
    // live tenant holds until an invite flow ships. Each of these would
    // have published the task to the client for somebody who can never
    // open it. Both fresh reviews found it.
    // try/finally, because `sven` is a SHARED fixture: a failed
    // assertion inside the loop would otherwise leave him at NO_ACCESS
    // for every later test in the file, turning one red test into a
    // cascade whose cause is invisible.
    try {
      for (const status of ["NO_ACCESS", "SUSPENDED", "REVOKED"] as const) {
        await f.platform.contact.update({ where: { id: sven }, data: { portalStatus: status } });
        await expect(assignItemToContact(ctxOf("manager"), id, sven)).rejects.toBeInstanceOf(AuthzError);
      }
    } finally {
      await f.platform.contact.update({ where: { id: sven }, data: { portalStatus: "SUSPENDED" } });
    }
    expect((await rowOf(id)).assigneeContactId).toBeNull();
  });

  it("ACCEPTS a contact who has been invited and has not signed in yet", async () => {
    // The positive twin of the loop above, and the one status the
    // allowlist deliberately admits beyond ACTIVE: preparing work for a
    // client you have just invited is ordinary, and INVITED becomes
    // ACTIVE without anything touching this row.
    const id = await sharedTask("Invited");
    await f.platform.contact.update({ where: { id: sven }, data: { portalStatus: "INVITED" } });
    try {
      const out = await assignItemToContact(ctxOf("manager"), id, sven);
      expect(out).toMatchObject({ assigneeContactId: sven, changed: true });
    } finally {
      await f.platform.contact.update({ where: { id: sven }, data: { portalStatus: "SUSPENDED" } });
    }
  });

  it("writes a CLIENT-VISIBLE history row naming the contact, and no audit event for the assignment", async () => {
    const id = await sharedTask("History");
    await assignItemToContact(ctxOf("manager"), id, anna);

    const rows = await f.platform.workItemActivity.findMany({
      where: { tenantId: f.tenantId, workItemId: id, field: "assigneeContactId" },
    });
    expect(rows).toHaveLength(1);
    // On the portal-safe list (DATA_MODEL §6.14) and the item is
    // client-visible, so the client's own history row is theirs to read.
    expect(rows[0]!.visibility).toBe("CLIENT_VISIBLE");
    expect(rows[0]!.newRef).toBe(anna);
    expect(rows[0]!.oldRef).toBeNull();
    // Routine edit, founder's 2026-09-12 rule: history, never an audit
    // event. The SHARE is audited; the assignment is not.
    expect(await f.audits("work_item.assigned")).toHaveLength(0);
  });

  it("is a no-op when that contact already holds it — nothing written", async () => {
    const id = await sharedTask("Twice");
    await assignItemToContact(ctxOf("manager"), id, anna);
    const before = await rowOf(id);

    const again = await assignItemToContact(ctxOf("manager"), id, anna);
    expect(again).toMatchObject({ changed: false, shared: false, assigneeName: "Anna" });

    const after = await rowOf(id);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(
      await f.platform.workItemActivity.count({
        where: { tenantId: f.tenantId, workItemId: id, field: "assigneeContactId" },
      }),
    ).toBe(1);
  });
});

describe("the client's claim", () => {
  it("stamps the column and MOVES NOTHING", async () => {
    const id = await sharedTask("Send the files");
    await assignItemToContact(ctxOf("manager"), id, anna);
    const before = await rowOf(id);

    const out = await setPortalTaskDone(principal(anna), id, true);
    expect(out.changed).toBe(true);
    expect(out.markedDoneAt).toBeInstanceOf(Date);

    const after = await rowOf(id);
    // THE WHOLE FOUNDER DECISION, AS A FACT ABOUT THE ROW. `DONE` means
    // work the AGENCY has accepted, for everyone; a client's tick is a
    // claim and not a transition.
    expect(after.stateCategory).toBe(before.stateCategory);
    expect(after.stateId).toBe(before.stateId);
    expect(after.completedAt).toBeNull();
    expect(after.contactCompletedAt).toEqual(out.markedDoneAt);
  });

  it("audits the CONTACT and notifies the agency, with no free text anywhere", async () => {
    const title = `Send the files ${run}`;
    const id = await sharedTask("Send the files");
    await assignItemToContact(ctxOf("manager"), id, anna);
    await setPortalTaskDone(principal(anna), id, true);

    const events = await f.audits("portal.task_completed");
    expect(events).toHaveLength(1);
    // The transaction is a SYSTEM one; without `brokeredForContactId`
    // the row would read SYSTEM with no actor at all.
    expect(events[0]!.actorType).toBe("CONTACT");
    expect(events[0]!.actorId).toBe(anna);
    expect(events[0]!.targetId).toBe(id);
    expect(JSON.stringify(events[0]!.metadata)).not.toContain(title);

    const notes = await f.platform.notification.findMany({
      where: { tenantId: f.tenantId, kind: "work_item.completed_by_contact" },
    });
    // The project's lead (manager) and its assigned member (employee) —
    // `requestReceivers`' union, and no actor is dropped because no
    // member acted.
    expect(notes.map((n) => n.receiverId).sort()).toEqual(
      [f.seats.manager.memberId, f.seats.employee.memberId].sort(),
    );
    expect(JSON.stringify(notes[0]!.params)).not.toContain(title);
  });

  it("can be withdrawn, which audits separately and notifies nobody", async () => {
    const id = await claimedTask("Changed my mind");
    await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });

    const out = await setPortalTaskDone(principal(anna), id, false);
    expect(out).toMatchObject({ markedDoneAt: null, changed: true });
    expect((await rowOf(id)).contactCompletedAt).toBeNull();

    expect(await f.audits("portal.task_completion_withdrawn")).toHaveLength(1);
    // "Never mind" is not news: the surface going quiet is the message.
    expect(
      await f.platform.notification.count({
        where: { tenantId: f.tenantId, kind: "work_item.completed_by_contact" },
      }),
    ).toBe(0);
  });

  it("is a no-op when it is already so — nothing audited, nobody told twice", async () => {
    const id = await claimedTask("Double click");
    const before = await rowOf(id);
    await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
      await tx.auditEvent.deleteMany({ where: { tenantId: f.tenantId } });
    });

    const again = await setPortalTaskDone(principal(anna), id, true);
    expect(again.changed).toBe(false);
    expect(again.markedDoneAt).toEqual(before.contactCompletedAt);
    expect(await f.audits("portal.task_completed")).toHaveLength(0);
    expect(await f.platform.notification.count({ where: { tenantId: f.tenantId } })).toBe(0);
  });

  it("REFUSES a colleague of the same client who can READ the task — the assignee term", async () => {
    const id = await sharedTask("Not yours");
    await assignItemToContact(ctxOf("manager"), id, anna);

    // Bea passes `authorizePortal` outright: she is ACTIVE, her profile
    // holds `portal.work_item.act`, and the work-item ref resolves for
    // her under `portal_gate` because the task is her client's and
    // client-visible. The ONLY thing refusing is the write's
    // `assigneeContactId` term — which is the one gate no read-side
    // test can exercise.
    await expect(setPortalTaskDone(principal(bea), id, true)).rejects.toMatchObject({
      reason: "NOT_FOUND",
    });
    expect((await rowOf(id)).contactCompletedAt).toBeNull();

    // And she really can read it, so the refusal above is about the
    // assignment and not about visibility.
    const list = await listPortalTasks(principal(bea));
    expect(list.projects.flatMap((p) => p.tasks).some((t) => t.id === id)).toBe(true);
  });

  it("REFUSES a SUSPENDED contact who IS the assignee — the authorization gate", async () => {
    const id = await sharedTask("Suspended");
    // Assigned while ACTIVE would be the ordinary route; the fixture's
    // suspended seat is assigned directly so that the system read's own
    // `where` would be SATISFIED. `authorizePortal` is therefore the
    // only thing that can refuse — delete that call and this test goes
    // green while nothing else does.
    await changeItemVisibility(ctxOf("manager"), id, "CLIENT_VISIBLE");
    await f.platform.workItem.update({
      where: { id },
      data: { assigneeContactId: sven, assigneeMemberId: null },
    });

    await expect(setPortalTaskDone(principal(sven), id, true)).rejects.toBeInstanceOf(AuthzError);
    expect((await rowOf(id)).contactCompletedAt).toBeNull();
  });

  it("refuses a contact of another client outright", async () => {
    const id = await sharedTask("Beta's business");
    await assignItemToContact(ctxOf("manager"), id, anna);
    await expect(
      setPortalTaskDone(principal(bo, { clientId: beta }), id, true),
    ).rejects.toBeInstanceOf(AuthzError);
  });

  it("refuses a task the agency has already finished or dropped", async () => {
    const id = await sharedTask("Too late");
    await assignItemToContact(ctxOf("manager"), id, anna);
    await changeState(ctxOf("owner"), id, await stateOf(pOn, "DONE"));

    await expect(setPortalTaskDone(principal(anna), id, true)).rejects.toBeInstanceOf(DomainError);
    expect((await rowOf(id)).contactCompletedAt).toBeNull();
  });

  it("refuses once the project's portal has been switched off", async () => {
    const id = await sharedTask("Switched off");
    await assignItemToContact(ctxOf("manager"), id, anna);
    await f.platform.project.update({ where: { id: pOn }, data: { portalEnabled: false } });
    try {
      await expect(setPortalTaskDone(principal(anna), id, true)).rejects.toBeInstanceOf(AuthzError);
    } finally {
      await f.platform.project.update({ where: { id: pOn }, data: { portalEnabled: true } });
    }
  });
});

describe("a claim never outlives what it answers", () => {
  it("survives an ordinary live move", async () => {
    const id = await claimedTask("Still waiting");
    const claim = (await rowOf(id)).contactCompletedAt;
    expect(claim).not.toBeNull();

    // The agency picking the work up is not an answer to the claim.
    // Clearing here would silently delete the client's own statement,
    // which is the silent-vanish class slice 6b exists to end.
    await changeState(ctxOf("owner"), id, await stateOf(pOn, "IN_PROGRESS"));
    expect((await rowOf(id)).contactCompletedAt).toEqual(claim);
  });

  it("is cleared when the agency finishes the work", async () => {
    const id = await claimedTask("Accepted");
    await changeState(ctxOf("owner"), id, await stateOf(pOn, "DONE"));
    const after = await rowOf(id);
    expect(after.contactCompletedAt).toBeNull();
    expect(after.stateCategory).toBe("DONE");
  });

  it("is cleared when the agency drops the work", async () => {
    const id = await claimedTask("Dropped");
    await changeState(ctxOf("owner"), id, await stateOf(pOn, "CANCELLED"));
    expect((await rowOf(id)).contactCompletedAt).toBeNull();
  });

  it("is cleared when the task is unassigned, which the CHECK insists on", async () => {
    const id = await claimedTask("Taken back");
    // `assignItem(…, null)` clears BOTH assignee columns. Before slice
    // 6c its no-op test read the member column alone, so this call
    // would have reported "unchanged" and left the client holding the
    // task — and the claim with it.
    const out = await assignItem(ctxOf("manager"), id, null);
    expect(out.changed).toBe(true);
    const after = await rowOf(id);
    expect(after.assigneeContactId).toBeNull();
    expect(after.contactCompletedAt).toBeNull();
  });

  it("is cleared when the task is handed to a different contact", async () => {
    const id = await claimedTask("Reassigned");
    await assignItemToContact(ctxOf("manager"), id, bea);
    const after = await rowOf(id);
    expect(after.assigneeContactId).toBe(bea);
    // A claim is ONE person's statement about what they were asked to
    // do. The CHECK cannot see names, so this is the service's to hold.
    expect(after.contactCompletedAt).toBeNull();
  });

  it("is cleared by MAKING THE TASK PRIVATE, which must never fail", async () => {
    const id = await claimedTask("Retracted");
    // THE SAFETY LEVER. `work_item_contact_assignee_visible` says a
    // contact-assigned row must be CLIENT_VISIBLE, so before this fix a
    // plain make-private on a handed-over task raised an unmapped 23514
    // — a 500 on the one flip whose entire purpose is to stop showing a
    // client something, leaving the row published while the member
    // worked out that they had to unassign first. Both fresh reviews
    // found it, from opposite directions.
    const out = await changeItemVisibility(ctxOf("manager"), id, "INTERNAL");
    expect(out).toMatchObject({ visibility: "INTERNAL", changed: true });

    const after = await rowOf(id);
    expect(after.visibility).toBe("INTERNAL");
    expect(after.assigneeContactId).toBeNull();
    expect(after.contactCompletedAt).toBeNull();
    // The end of the assignment is in the trail, not silent, and the
    // row is INTERNAL — written AFTER the update, against the row's new
    // visibility. Not by the downgrade trigger: that is a BEFORE
    // trigger and this row does not exist while it runs. A first draft
    // of this comment said otherwise, which is the exact mental model
    // `items.ts` records as having broken the make-private lever a
    // second time — the denorm guard refuses a CLIENT_VISIBLE activity
    // row on an item the client cannot see, so the whole flip rolls
    // back.
    const rows = await f.platform.workItemActivity.findMany({
      where: { tenantId: f.tenantId, workItemId: id, field: "assigneeContactId" },
      orderBy: { id: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ oldRef: anna, newRef: null, visibility: "INTERNAL" });
  });

  it("records the removal against the CONTACT field, never the member one", async () => {
    const id = await claimedTask("Attribution");
    await assignItem(ctxOf("manager"), id, null);
    // `readItemActivity` resolves an `assignee` ref against the MEMBER
    // table, so a contact id written there renders "Unknown" in the
    // panel — an attribution silently lost in the history trail. The
    // fields are separate precisely so their refs stay homogeneous.
    const rows = await f.platform.workItemActivity.findMany({
      where: { tenantId: f.tenantId, workItemId: id },
    });
    expect(rows.filter((r) => r.field === "assigneeContactId").at(-1)).toMatchObject({
      oldRef: anna,
      newRef: null,
    });
    // Nothing moved on the member side, so no `assignee` row was
    // written at all: the task went from a contact to nobody.
    expect(rows.some((r) => r.field === "assignee")).toBe(false);
  });

  it("writes BOTH rows when a task goes from the client back to a colleague", async () => {
    const id = await claimedTask("Back inside");
    await assignItem(ctxOf("manager"), id, f.seats.employee.memberId);
    const rows = await f.platform.workItemActivity.findMany({
      where: { tenantId: f.tenantId, workItemId: id },
    });
    expect(rows.filter((r) => r.field === "assigneeContactId").at(-1)).toMatchObject({
      oldRef: anna,
      newRef: null,
    });
    expect(rows.filter((r) => r.field === "assignee").at(-1)).toMatchObject({
      oldRef: null,
      newRef: f.seats.employee.memberId,
    });
    expect((await rowOf(id)).contactCompletedAt).toBeNull();
  });

  it("cannot be left behind by a hand-written UPDATE either", async () => {
    const id = await claimedTask("Constraint");
    await expect(
      f.platform.workItem.update({ where: { id }, data: { assigneeContactId: null } }),
    ).rejects.toThrow(/work_item_contact_completed_has_assignee/);
  });
});

describe("what the contact's own list says", () => {
  it("marks their task as theirs, and a colleague's as not", async () => {
    const mine = await sharedTask("Mine");
    const theirs = await sharedTask("Bea's");
    await assignItemToContact(ctxOf("manager"), mine, anna);
    await assignItemToContact(ctxOf("manager"), theirs, bea);

    const tasks = (await listPortalTasks(principal(anna))).projects.flatMap((p) => p.tasks);
    expect(tasks.find((t) => t.id === mine)!.assignedToYou).toBe(true);
    // Bea's task is on Anna's list — a client is a company and the list
    // is the company's — but nothing on it says whose it is.
    const hers = tasks.find((t) => t.id === theirs)!;
    expect(hers.assignedToYou).toBe(false);
    expect(Object.values(hers)).not.toContain(bea);
  });

  it("shows the claim back to the client without it becoming a category", async () => {
    const id = await claimedTask("Ticked");
    const task = (await listPortalTasks(principal(anna))).projects
      .flatMap((p) => p.tasks)
      .find((t) => t.id === id)!;
    expect(task.markedDoneAt).toBeInstanceOf(Date);
    // Still where the AGENCY has it. The two facts are separate on
    // purpose and the page draws both.
    expect(task.category).toBe("PLANNED");
    expect(task.completedAt).toBeNull();
  });

  it("never carries a member assignee onto the plane", async () => {
    const id = await sharedTask("Agency's");
    await assignItem(ctxOf("manager"), id, f.seats.employee.memberId);
    const task = (await listPortalTasks(principal(anna))).projects
      .flatMap((p) => p.tasks)
      .find((t) => t.id === id)!;
    // The XOR makes this structural rather than hopeful, and the
    // projection's own type has no field that could carry it.
    expect(task.assignedToYou).toBe(false);
    expect(Object.values(task)).not.toContain(f.seats.employee.memberId);
  });
});

/**
 * THE MEMBER PLANE'S SIDE OF THE SAME ROW — Phase 3 slice 6c's second
 * commit. The surfaces are the picker that hands a task over and the
 * board and backlog that must then say who holds it; these are the two
 * reads behind them, and each has exactly one gate of its own.
 *
 * WHY THIS NEEDS TWO CUSTOM SEATS. Every template role holds both
 * `work_item:edit` and `client:view` (AUTHZ §3.2, C M A E), so the four
 * seats of the fixture cannot tell either gate from the other — or from
 * no gate at all. A test that deleted one of them and stayed green is
 * the vacuous shape the slice-6b reviews found twice; both seats below
 * were mutation-checked, and each mutation reddens exactly its own case.
 */
describe("what the member plane can see and offer", () => {
  /** The number `getItemDetail` is addressed by. */
  const numberOf = async (id: string) => (await rowOf(id)).number;

  it("offers the client's ACTIVE and INVITED people, and nobody else", async () => {
    const id = await task("Who can hold this");
    const detail = await getItemDetail(ctxOf("manager"), pOn, await numberOf(id));
    // ANNA AND BEA, BY THE ORDER THE CLIENT'S OWN CARD LISTS THEM.
    expect(detail.contacts.map((c) => c.name)).toEqual(["Anna", "Bea"]);
    // SVEN IS SUSPENDED and BO BELONGS TO ANOTHER CLIENT of this tenant.
    // Both are refusals `assignItemToContact` already makes, and a
    // picker that offered either would be a row whose only outcome is an
    // error — the second is also the one that would be a cross-client
    // write if the service ever stopped binding the read to the item.
    const ids = detail.contacts.map((c) => c.id);
    expect(ids).not.toContain(sven);
    expect(ids).not.toContain(bo);
  });

  it("offers them to a member whose client scope is LIFTED from one project", async () => {
    const id = await task("Reached by the lift");
    // THE EMPLOYEE SEAT HAS NO `MemberClient` ROW — it reaches `acme`
    // only because it is assigned to `pOn`, which is the shape
    // `getItemDetail`'s `assertInScope({ clientId, lifted: true })` is
    // written for. Drop the `lifted` flag there and this is the case
    // that goes red; every other seat in the file has direct scope or
    // `client:view_all` and would not notice.
    const detail = await getItemDetail(ctxOf("employee"), pOn, await numberOf(id));
    expect(detail.contacts.map((c) => c.name)).toEqual(["Anna", "Bea"]);
  });

  it("offers nobody to a member who may view the task but not edit it", async () => {
    const id = await task("Read only");
    const detail = await getItemDetail(
      { tenantId: f.tenantId, actor: viewerOnly.actor },
      pOn,
      await numberOf(id),
    );
    // The members' own rule, and for the same reason: a viewer's panel
    // renders the assignee as text and never lists anyone.
    expect(detail.caps.edit).toBe(false);
    expect(detail.contacts).toEqual([]);
    expect(detail.members).toEqual([]);
  });

  it("offers nobody to a member who may edit the task but not view clients", async () => {
    const id = await task("No client view");
    const detail = await getItemDetail(
      { tenantId: f.tenantId, actor: noClientView.actor },
      pOn,
      await numberOf(id),
    );
    // THE GATE IS ITS OWN, and this seat is what proves it: it CAN edit,
    // so the members are offered and the panel is a working control —
    // only the client's own rows are absent, because those are `Contact`
    // rows and `client:view` is the code they are read under.
    expect(detail.caps.edit).toBe(true);
    expect(detail.members.length).toBeGreaterThan(0);
    expect(detail.contacts).toEqual([]);
  });

  it("still NAMES the contact who holds a task to that same member", async () => {
    const id = await sharedTask("Held, and named anyway");
    await assignItemToContact(ctxOf("manager"), id, anna);
    const ctx = { tenantId: f.tenantId, actor: noClientView.actor };

    // **THE ASYMMETRY IS DELIBERATE AND THIS IS WHAT PINS IT.** An
    // independent security review found the two doors carrying different
    // gates and asked for one rule; this is the rule, written as a test
    // so the other resolution cannot be applied by accident. Naming the
    // person attached to a row the member is ALREADY READING is part of
    // reading the row — the door comment bylines, activity refs and the
    // triage lane's `reportedBy` have always used — while LISTING the
    // client's people is a directory of a company the member may have no
    // business browsing. Gate this one too and the board says
    // "Unassigned" over a task somebody holds, for exactly the seat that
    // can see the task: the defect this slice exists to end, arriving by
    // a different door.
    const detail = await getItemDetail(ctx, pOn, await numberOf(id));
    expect(detail.contacts).toEqual([]);
    expect(detail.item.assigneeContactName).toBe("Anna");
    const row = (await listItems(ctx, pOn)).items.find((r) => r.id === id)!;
    expect(row.assigneeContactName).toBe("Anna");
  });

  it("names the contact on the panel and on the list, where a member-held row names the member", async () => {
    const handed = await sharedTask("With the client");
    const kept = await sharedTask("With us");
    await assignItemToContact(ctxOf("manager"), handed, anna);
    await assignItem(ctxOf("manager"), kept, f.seats.employee.memberId);

    const detail = await getItemDetail(ctxOf("manager"), pOn, await numberOf(handed));
    expect(detail.item.assigneeContactId).toBe(anna);
    expect(detail.item.assigneeContactName).toBe("Anna");
    // THE PAIR, READ BACK: the member half is empty on this row, which
    // is what lets a surface render whichever is set without asking
    // which. `work_item_single_assignee` is "at most one", so BOTH null
    // is legal and ordinary — it is Unassigned — and only "both set" is
    // the state the database refuses.
    expect(detail.item.assigneeMemberId).toBeNull();
    expect(detail.item.assigneeName).toBeNull();

    const rows = (await listItems(ctxOf("manager"), pOn)).items;
    const handedRow = rows.find((r) => r.id === handed)!;
    const keptRow = rows.find((r) => r.id === kept)!;
    // Before this pair reached the list, a task the agency had handed to
    // its client read "Unassigned" on the agency's own board.
    expect(handedRow.assigneeContactName).toBe("Anna");
    expect(handedRow.assigneeName).toBeNull();
    expect(keptRow.assigneeContactName).toBeNull();
    expect(keptRow.assigneeName).not.toBeNull();
  });

  it("stops naming the contact the moment the task comes back", async () => {
    const id = await claimedTask("Handed and ticked");
    await assignItem(ctxOf("manager"), id, null);

    const detail = await getItemDetail(ctxOf("manager"), pOn, await numberOf(id));
    expect(detail.item.assigneeContactId).toBeNull();
    expect(detail.item.assigneeContactName).toBeNull();
    const row = (await listItems(ctxOf("manager"), pOn)).items.find((r) => r.id === id)!;
    expect(row.assigneeContactName).toBeNull();
  });
});
