import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { record } from "@/audit/record";
import { withTenant } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { setupTenant } from "@/members/dbtest-fixture";
import { resolvePortalModuleGates, type PortalPrincipal } from "@/portal";

import { getItemDetail } from "./items";
import { listPortalTasks } from "./portal";
import { createPortalRequest } from "./portal-writes";
import { REQUEST_BODY_MAX, REQUEST_TITLE_MAX } from "./request-limits";
import { REQUEST_WINDOW_LIMIT, createRequest } from "./requests";

/**
 * THE BROKERED WRITE, against the real schema, the real `app_runtime`
 * role and a real contact principal (Phase 3 slice 6a).
 *
 * WHAT ONLY A DATABASE CAN SETTLE HERE, and is therefore in this file
 * rather than a unit test:
 *
 *  · **That the write is the ONLY way in.** The last case in this file
 *    hands a contact principal a transaction and asks it to INSERT a
 *    `work_item` itself. RLS refuses. That is the whole justification
 *    for brokering: if a contact could write the row directly, every
 *    forced column above would be a suggestion.
 *  · **That the forced columns are forced by the row, not by the
 *    caller.** `client_id` comes off the project, visibility is
 *    CLIENT_VISIBLE, `portal_enabled` is stamped by the trigger and
 *    never written — so the submitted request is readable by the
 *    submitter through `portal_gate`, which the second case measures by
 *    reading it back through the projection rather than by inspecting
 *    the row.
 *  · **That the gate is the policy.** A request into another client's
 *    project and one into a portal-off project are refused before any
 *    of this code's own opinions apply, because `authorizePortal`'s
 *    project ref is resolved under the contact's own principal.
 *  · **That the audit row names the CONTACT** even though the
 *    transaction is a system one — the property `record()`'s
 *    `brokeredForContactId` exists for, and the one an operator needs
 *    in the single event family whose actor is not an employee.
 *  · **That the rate budget is exact.** It is a Postgres count behind an
 *    advisory lock, so it can only be measured against a database.
 *
 * Tenant slugs come from `setupTenant("preq")`, and the prefix `preq-`
 * is registered in `DBTEST_PREFIXES` (e2e/fixtures/seed-cli.ts) so
 * `sweep-dbtests` can collect this suite's orphans. `e2e-` is the
 * BROWSER harness's prefix and is swept by AGE — a dbtest using it would
 * have its fixtures deleted mid-run by a concurrent e2e run.
 */

const run = randomUUID().slice(0, 8);

let f: Awaited<ReturnType<typeof setupTenant>>;
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;
let acme: string;
let beta: string;
/** Portal ON, not archived — the one a request may land in. */
let pOn: string;
/** Portal OFF. */
let pOff: string;
/** Portal ON *and* archived — `project.portal_gate` has no archive term. */
let pArchived: string;
/** Portal ON, of the OTHER client. */
let pBeta: string;
/** Portal ON, and deliberately given NO workflow states — the lazy seed. */
let pFresh: string;
let contactId: string;
let suspendedId: string;
let betaContactId: string;
/** Assigned to `pOn` through MemberProject — a receiver. */
let assignedMemberId: string;
/** The lead of `pOn` — a receiver. */
let leadMemberId: string;

const principal = (over: Partial<PortalPrincipal> = {}): PortalPrincipal => ({
  contactId,
  tenantId: f.tenantId,
  clientId: acme,
  gates,
  ...over,
});

const requestsOf = (projectId: string) =>
  f.platform.workItem.findMany({
    where: { tenantId: f.tenantId, projectId },
    orderBy: { number: "asc" },
  });

beforeAll(async () => {
  f = await setupTenant("preq");
  acme = randomUUID();
  beta = randomUUID();
  pOn = randomUUID();
  pOff = randomUUID();
  pArchived = randomUUID();
  pBeta = randomUUID();
  pFresh = randomUUID();
  contactId = randomUUID();
  suspendedId = randomUUID();
  betaContactId = randomUUID();

  const up = run.slice(0, 3).toUpperCase();
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: `Acme ${run}` },
      { id: beta, tenantId: f.tenantId, name: `Beta ${run}` },
    ],
  });
  // The LEAD and the ASSIGNED member are two different seats, so the
  // receiver rule is measured as a union rather than as either half.
  leadMemberId = f.seats.manager.memberId;
  assignedMemberId = f.seats.employee.memberId;
  await f.platform.project.createMany({
    data: [
      { id: pOn, tenantId: f.tenantId, clientId: acme, key: `RQA${up}`, name: `Site ${run}`, portalEnabled: true, leadMemberId },
      { id: pOff, tenantId: f.tenantId, clientId: acme, key: `RQB${up}`, name: `Shop ${run}` },
      {
        id: pArchived,
        tenantId: f.tenantId,
        clientId: acme,
        key: `RQC${up}`,
        name: `Done ${run}`,
        portalEnabled: true,
        status: "ARCHIVED",
        archivedAt: new Date("2026-01-01T00:00:00Z"),
      },
      { id: pBeta, tenantId: f.tenantId, clientId: beta, key: `RQD${up}`, name: `Beta ${run}`, portalEnabled: true },
      { id: pFresh, tenantId: f.tenantId, clientId: acme, key: `RQE${up}`, name: `New ${run}`, portalEnabled: true },
    ],
  });
  await f.platform.memberProject.create({
    data: { tenantId: f.tenantId, memberId: assignedMemberId, projectId: pOn },
  });

  const invitedAt = new Date("2026-09-01T09:00:00Z");
  await f.platform.contact.createMany({
    data: [
      { id: contactId, tenantId: f.tenantId, clientId: acme, name: "Anna", email: `preq-anna-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt, emailVerified: true },
      { id: suspendedId, tenantId: f.tenantId, clientId: acme, name: "Sven", email: `preq-sven-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "SUSPENDED", invitedAt, emailVerified: true },
      { id: betaContactId, tenantId: f.tenantId, clientId: beta, name: "Bo", email: `preq-bo-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt, emailVerified: true },
    ],
  });

  gates = await resolvePortalModuleGates(f.tenantId);
});

/**
 * EVERY CASE STARTS WITH AN EMPTY BUDGET. The limiter counts rows inside
 * a time window, so without this the fourteenth assertion in the file
 * would start failing for a reason none of them is about — and it would
 * fail as an ordering-dependent flake, which is the worst shape a
 * security test can take.
 */
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
  // `nextCounter` mints a `tenant_counter` row per project, and its FK to
  // `tenant` is RESTRICT — so without this the tenant delete inside
  // `setupTenant`'s own cleanup fails with 23001 and strands the whole
  // fixture. Measured the first time this suite ran, and it is the same
  // sweep `drop-project` does in the browser harness.
  await f.platform.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.memberProject.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.contact.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.project.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
});

describe("the portal request intake", () => {
  it("forces every column the submitter does not get to choose", async () => {
    const created = await createPortalRequest(principal(), {
      projectId: pOn,
      title: `  A new landing page ${run}  `,
      body: `  Something about the spring campaign ${run}  `,
    });

    const rows = await requestsOf(pOn);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(created.id).toBe(row.id);
    expect(created.number).toBe(row.number);
    // The human key the portal never shows and the member app does.
    expect(created.projectKey).toBe(`RQA${run.slice(0, 3).toUpperCase()}`);

    expect(row.kind).toBe("REQUEST");
    expect(row.source).toBe("PORTAL");
    expect(row.type).toBe("TASK");
    expect(row.visibility).toBe("CLIENT_VISIBLE");
    expect(row.stateCategory).toBe("TRIAGE");
    expect(row.triageStatus).toBe("PENDING");
    // From the PROJECT, never from the caller.
    expect(row.clientId).toBe(acme);
    expect(row.reportedByContactId).toBe(contactId);
    // Nobody at the agency did this and nobody owns it yet.
    expect(row.createdByMemberId).toBeNull();
    expect(row.assigneeMemberId).toBeNull();
    expect(row.assigneeContactId).toBeNull();
    // TRIGGER-DERIVED, never written by the service (AGENTS.md).
    expect(row.portalEnabled).toBe(true);
    // Trimmed, and the body is PLAIN TEXT with no document beside it.
    expect(row.title).toBe(`A new landing page ${run}`);
    expect(row.descriptionText).toBe(`Something about the spring campaign ${run}`);
    expect(row.description).toBeNull();
  });

  it("is readable by the submitter through the projection, as 'Requested'", async () => {
    const title = `Please add a page ${run}`;
    await createPortalRequest(principal(), { projectId: pOn, title, body: null });

    // READ BACK THROUGH `portal_gate`, not through the platform client:
    // the claim is that the row the client submitted is one the client
    // can see, and only the contact principal can establish that.
    const list = await listPortalTasks(principal());
    const tasks = list.projects.flatMap((p) => p.tasks);
    const mine = tasks.find((t) => t.title === title);
    expect(mine).toBeDefined();
    expect(mine!.category).toBe("REQUESTED");
  });

  it("writes an audit row that names the CONTACT, with no free text in it", async () => {
    const title = `Audited request ${run}`;
    const created = await createPortalRequest(principal(), { projectId: pOn, title, body: "a body" });

    const events = await f.audits("portal.request_created");
    expect(events).toHaveLength(1);
    const event = events[0]!;
    // THE POINT OF THE FIELD: the transaction is a system one, and a
    // row reading SYSTEM with a null actor would be the whole trail for
    // the only thing a client can do.
    expect(event.actorType).toBe("CONTACT");
    expect(event.actorId).toBe(contactId);
    expect(event.targetType).toBe("WorkItem");
    expect(event.targetId).toBe(created.id);
    expect(event.visibility).toBe("TENANT");
    // Ids and a number; never what the client typed.
    expect(JSON.stringify(event.metadata)).not.toContain(title);
    expect(event.metadata).toMatchObject({ projectId: pOn, clientId: acme, number: created.number });
  });

  it("writes a history row attributed to the contact, and holds it INTERNAL", async () => {
    const created = await createPortalRequest(principal(), {
      projectId: pOn,
      title: `History ${run}`,
      body: null,
    });
    const rows = await f.platform.workItemActivity.findMany({
      where: { tenantId: f.tenantId, workItemId: created.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.field).toBe("created");
    expect(rows[0]!.actorContactId).toBe(contactId);
    // No employee did this: a member id here would put somebody's name
    // against a client's act in the panel's own timeline.
    expect(rows[0]!.actorMemberId).toBeNull();
    // "created" is not on the portal-safe field list, exactly as the
    // member-side create forces.
    expect(rows[0]!.visibility).toBe("INTERNAL");
  });

  it("tells the project's people and nobody else", async () => {
    const created = await createPortalRequest(principal(), {
      projectId: pOn,
      title: `Notified ${run}`,
      body: null,
    });
    const rows = await f.platform.notification.findMany({ where: { tenantId: f.tenantId } });
    expect(rows.map((r) => r.receiverId).sort()).toEqual([assignedMemberId, leadMemberId].sort());
    expect(rows.every((r) => r.kind === "work_item.request_received")).toBe(true);
    expect(rows.every((r) => r.entityId === created.id)).toBe(true);
    // NO ACTOR: `emit` only knows how to name a member, and no member
    // did this.
    expect(rows.every((r) => r.actorId === null && r.actorType === null)).toBe(true);
    // The owner and the admin work at the agency but not on this
    // project. A notification is not an announcement.
    const others = rows.filter(
      (r) => r.receiverId === f.seats.owner.memberId || r.receiverId === f.seats.admin.memberId,
    );
    expect(others).toEqual([]);
    // INSTANT, so the mail is queued in the same transaction. It stays
    // QUEUED: SES is not provisioned (PLAN §0), which is exactly why the
    // in-app row above is the one that matters.
    const outbox = await f.platform.emailOutbox.findMany({ where: { tenantId: f.tenantId } });
    expect(outbox).toHaveLength(2);
    expect(outbox.every((o) => o.status === "QUEUED")).toBe(true);
    expect(JSON.stringify(outbox.map((o) => o.params))).not.toContain(`Notified ${run}`);
  });

  it("is legible on the member side, attributed to the client by NAME", async () => {
    // THE ATTRIBUTION HAS TO SURVIVE THE READ, not merely the write. The
    // history row stores `actorContactId`, and `readItemActivity`
    // resolves a contact actor bound to the item's own client — so the
    // panel says "Astrid created this" rather than "Unknown". Without
    // this case the row could carry a perfectly good id that no member
    // surface ever turned into a name, which is the failure mode this
    // repo keeps finding: the write is right and nothing reads it.
    const created = await createPortalRequest(principal(), {
      projectId: pOn,
      title: `Legible ${run}`,
      body: null,
    });
    const rows = await requestsOf(pOn);
    const detail = await getItemDetail(
      { tenantId: f.tenantId, actor: f.seats.owner.actor },
      pOn,
      rows[0]!.number,
    );
    expect(detail.item.id).toBe(created.id);
    // The panel's own vocabulary for the row: a REQUEST, not a task
    // somebody at the agency typed.
    expect(detail.item.kind).toBe("REQUEST");
    expect(detail.item.visibility).toBe("CLIENT_VISIBLE");
    const entry = detail.activity.rows.find((r) => r.field === "created");
    expect(entry).toBeDefined();
    expect(entry!.actor.kind).toBe("contact");
    expect(entry!.actor.name).toBe("Anna");
  });

  it("seeds a fresh project's states rather than assuming a triage state exists", async () => {
    // A client can legitimately be the first person to touch a project's
    // work, and a project whose board has never been opened has no
    // `workflow_state` rows at all.
    expect(
      await f.platform.workflowState.count({ where: { tenantId: f.tenantId, projectId: pFresh } }),
    ).toBe(0);
    await createPortalRequest(principal(), { projectId: pFresh, title: `First ${run}`, body: null });
    const rows = await requestsOf(pFresh);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stateCategory).toBe("TRIAGE");
    const triage = await f.platform.workflowState.findFirst({
      where: { tenantId: f.tenantId, projectId: pFresh, category: "TRIAGE" },
    });
    expect(triage).not.toBeNull();
    expect(rows[0]!.stateId).toBe(triage!.id);
    // The seeded triage state is HIDDEN until it has items — which is
    // the behaviour this row turns on.
    expect(triage!.isHidden).toBe(true);
  });
});

describe("what the gate refuses", () => {
  const refused = async (p: PortalPrincipal, projectId: string) => {
    await expect(
      createPortalRequest(p, { projectId, title: `Refused ${run}`, body: null }),
    ).rejects.toBeInstanceOf(AuthzError);
    expect(await requestsOf(projectId)).toHaveLength(0);
  };

  it("another client's project — resolved under the contact's own principal", async () => {
    await refused(principal(), pBeta);
  });

  it("a project whose portal is switched off", async () => {
    await refused(principal(), pOff);
  });

  it("a contact who is not ACTIVE", async () => {
    await refused(principal({ contactId: suspendedId }), pOn);
  });

  it("a principal claiming another client than its own contact row", async () => {
    // The belt in `authorizePortal` step 1: the GUCs and the row must
    // agree. A session that named Beta while holding Anna's id would
    // otherwise file into Beta's project.
    await refused(principal({ contactId: betaContactId }), pOn);
  });

  it("an ARCHIVED project — by the SERVICE, because the policy has no archive term", async () => {
    // This one is worth spelling out. `project.portal_gate` is
    // `client_id = app.client_id AND portal_enabled` and nothing else,
    // so the ref ADMITS an archived project; it is `createRequest`'s own
    // re-read under the system principal that refuses it. A reviewer
    // reading only the policy would conclude the opposite, and the two
    // layers disagree on purpose.
    await expect(
      createPortalRequest(principal(), { projectId: pArchived, title: `Nope ${run}`, body: null }),
    ).rejects.toMatchObject({ code: "ARCHIVED" });
    expect(await requestsOf(pArchived)).toHaveLength(0);
  });

  it("a project switched off BETWEEN the two transactions — the window a broker cannot close", async () => {
    // THE ONE CASE THE BROKER CANNOT PRODUCE, so it is driven against
    // the service directly. `authorizePortal` would have refused a
    // portal-off project under the contact's own principal; this is what
    // happens when the agency throws the switch in the gap between that
    // transaction and the write, where the principal is `system` and
    // every policy is satisfied. The re-read is the whole answer.
    await expect(
      withTenant(f.tenantId, { type: "system" }, (tx) =>
        createRequest(tx, f.tenantId, {
          projectId: pOff,
          title: `Raced ${run}`,
          body: null,
          reportedByContactId: contactId,
        }),
      ),
    ).rejects.toBeInstanceOf(AuthzError);
    expect(await requestsOf(pOff)).toHaveLength(0);
  });

  it("an empty or oversized title, and an oversized body — before any transaction opens", async () => {
    // "BEFORE ANY TRANSACTION OPENS" IS NOW MEASURED, not merely in the
    // name (code review). A blank title against ANOTHER CLIENT'S project
    // separates the two orders: if the input is parsed first the answer
    // is INVALID_INPUT, and if authorization ran first it would be the
    // AuthzError NOT_FOUND that `pBeta` earns in the case above. The
    // previous assertions were all satisfied either way.
    await expect(
      createPortalRequest(principal(), { projectId: pBeta, title: "  ", body: null }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    for (const title of ["", "   "]) {
      await expect(
        createPortalRequest(principal(), { projectId: pOn, title, body: null }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    // An empty project id is refused by the same parse, and never
    // reaches a `where` where Prisma would drop it.
    await expect(
      createPortalRequest(principal(), { projectId: "", title: "ok", body: null }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      createPortalRequest(principal(), { projectId: pOn, title: "x".repeat(REQUEST_TITLE_MAX + 1), body: null }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      createPortalRequest(principal(), { projectId: pOn, title: "ok", body: "y".repeat(REQUEST_BODY_MAX + 1) }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await requestsOf(pOn)).toHaveLength(0);
  });
});

describe("the rate budget", () => {
  it("lets the window's worth through and refuses the next one, writing nothing", async () => {
    for (let i = 0; i < REQUEST_WINDOW_LIMIT; i++) {
      await createPortalRequest(principal(), { projectId: pOn, title: `Budget ${i} ${run}`, body: null });
    }
    await expect(
      createPortalRequest(principal(), { projectId: pOn, title: `One too many ${run}`, body: null }),
    ).rejects.toMatchObject({ code: "REQUEST_RATE_LIMITED" });
    expect(await requestsOf(pOn)).toHaveLength(REQUEST_WINDOW_LIMIT);
    // A refusal must not consume a counter value either: the next
    // accepted request takes the number the refused one did not.
    const numbers = (await requestsOf(pOn)).map((r) => r.number);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  });

  it("is per CONTACT, not per tenant or per project", async () => {
    for (let i = 0; i < REQUEST_WINDOW_LIMIT; i++) {
      await createPortalRequest(principal(), { projectId: pOn, title: `Mine ${i} ${run}`, body: null });
    }
    // Another project of the same client, same contact: still refused —
    // the budget is about how often somebody may submit.
    await expect(
      createPortalRequest(principal(), { projectId: pFresh, title: `Elsewhere ${run}`, body: null }),
    ).rejects.toMatchObject({ code: "REQUEST_RATE_LIMITED" });
    // A different contact is unaffected.
    await createPortalRequest(
      { contactId: betaContactId, tenantId: f.tenantId, clientId: beta, gates },
      { projectId: pBeta, title: `Theirs ${run}`, body: null },
    );
    expect(await requestsOf(pBeta)).toHaveLength(1);
  });
});

describe("the reason the write has to be brokered at all", () => {
  it("a contact principal cannot INSERT a work item — but the TRIGGER is what refuses it", async () => {
    // THIS CASE IS HERE TO RECORD WHAT IT DOES *NOT* PROVE, which is the
    // opposite of what its first version claimed (code review, and it was
    // right). `work_item_state_sync` is a BEFORE INSERT trigger that
    // resolves `state_id` against `workflow_state` — a class-A table
    // carrying `portal_deny` — so under a CONTACT principal that lookup
    // returns nothing even for the project's real triage state, and the
    // trigger raises before RLS's WITH CHECK is ever evaluated. A bare
    // `.rejects.toThrow()` here is therefore satisfied by the trigger,
    // and would stay green if `portal_gate`'s WITH CHECK were replaced
    // with `WITH CHECK (true)` — i.e. if the census were opened on the
    // product's biggest table.
    //
    // So it asserts the TRIGGER's own message, which is the honest
    // description of what happens, and the two cases below carry the
    // census claim on tables where the policy is actually reachable.
    const id = randomUUID();
    await expect(
      withTenant(f.tenantId, { type: "contact", id: contactId, clientId: acme }, (tx) =>
        tx.workItem.create({
          data: {
            id,
            tenantId: f.tenantId,
            clientId: acme,
            projectId: pOn,
            number: 9_999,
            title: `Direct ${run}`,
            stateId: randomUUID(),
            stateCategory: "TRIAGE",
            triageStatus: "PENDING",
            rootId: id,
            rank: "zz",
            visibility: "CLIENT_VISIBLE",
          },
          select: { id: true },
        }),
      ),
    ).rejects.toThrow(/state does not belong/);
    expect(await requestsOf(pOn)).toHaveLength(0);
  });

  it("a contact principal cannot INSERT a history row — and HERE it is the POLICY", async () => {
    // THE CENSUS CLAIM, on a table where the WITH CHECK is reachable.
    // `work_item_activity` carries the same `portal_gate` WITH CHECK
    // (`principal IS DISTINCT FROM 'contact'`), created in the same loop
    // of the same migration, and its only BEFORE trigger is
    // `stamp_portal_enabled`, which reads `project` — a table a contact
    // CAN read — and COALESCEs rather than raising. So the trigger
    // succeeds and the policy is what refuses, which the message proves.
    //
    // Replace that WITH CHECK with `true` and this goes red. That is the
    // property three documents cite and the case that now carries it.
    const created = await createPortalRequest(principal(), {
      projectId: pOn,
      title: `Policy ${run}`,
      body: null,
    });
    await expect(
      withTenant(f.tenantId, { type: "contact", id: contactId, clientId: acme }, (tx) =>
        tx.workItemActivity.create({
          data: {
            tenantId: f.tenantId,
            clientId: acme,
            projectId: pOn,
            workItemId: created.id,
            field: "title",
            visibility: "CLIENT_VISIBLE",
          },
          select: { id: true },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);

    // THE POSITIVE CONTROL, which is the only assertion that can tell
    // "the policy refused it" from "the row was malformed". The SAME
    // insert under a SYSTEM principal succeeds, so the one thing that
    // changed between the two attempts is who was asking.
    const ok = await withTenant(f.tenantId, { type: "system" }, (tx) =>
      tx.workItemActivity.create({
        data: {
          tenantId: f.tenantId,
          clientId: acme,
          projectId: pOn,
          workItemId: created.id,
          field: "title",
          visibility: "CLIENT_VISIBLE",
        },
        select: { id: true },
      }),
    );
    expect(ok.id).toBeTruthy();
  });

  it("a contact cannot DELETE the very row they submitted", async () => {
    // The other half of the census, and the one a contact is closest to
    // reaching: the request IS theirs, it IS CLIENT_VISIBLE, and
    // `portal_gate`'s USING admits it for READING. `portal_no_delete` is
    // a RESTRICTIVE `FOR DELETE ... USING (principal IS DISTINCT FROM
    // 'contact')`, so the row is simply invisible to the DELETE — which
    // means the refusal is a COUNT OF ZERO and not an exception. A test
    // that only asserted `rejects` would pass whether the policy existed
    // or not, by never throwing either way.
    const created = await createPortalRequest(principal(), {
      projectId: pOn,
      title: `Undeletable ${run}`,
      body: null,
    });
    const { count } = await withTenant(
      f.tenantId,
      { type: "contact", id: contactId, clientId: acme },
      (tx) => tx.workItem.deleteMany({ where: { tenantId: f.tenantId, id: created.id } }),
    );
    expect(count).toBe(0);
    // ...and the row is still there, read back with the platform client
    // so the assertion does not depend on the same policy it is testing.
    expect(await requestsOf(pOn)).toHaveLength(1);
  });

  it("an audit row cannot be attributed to a contact outside a system transaction", async () => {
    // `brokeredForContactId` is the escape that makes the trail honest,
    // and an escape that any principal could use would make it the
    // opposite: a member attributing their own act to a client, in the
    // one table SECURITY.md §7 treats as evidentiary.
    await expect(
      withTenant(f.tenantId, { type: "member", id: f.seats.owner.memberId }, (tx) =>
        record(tx, {
          action: "portal.request_created",
          targetType: "WorkItem",
          targetId: randomUUID(),
          brokeredForContactId: contactId,
        }),
      ),
    ).rejects.toThrow(/brokeredForContactId/);
    expect(await f.audits("portal.request_created")).toHaveLength(0);
  });

  it("the same record() call inside a system transaction is accepted", async () => {
    // The positive control. Without it, the refusal above would pass
    // just as well if the field had been dropped from `AuditInput`
    // entirely — which is the failure mode a deny-only test cannot see.
    const target = randomUUID();
    await withTenant(f.tenantId, { type: "system" }, (tx) =>
      record(tx, {
        action: "portal.request_created",
        targetType: "WorkItem",
        targetId: target,
        brokeredForContactId: contactId,
      }),
    );
    const events = await f.audits("portal.request_created");
    expect(events).toHaveLength(1);
    expect(events[0]!.actorType).toBe("CONTACT");
    expect(events[0]!.actorId).toBe(contactId);
  });
});

describe("the DomainError a contact may actually be told", () => {
  it("is the rate limit and the input check, and nothing the agency owns", async () => {
    // A companion to `src/portal/action.test.ts`, which pins the
    // disclosure list itself. What is measured HERE is that the two
    // codes that list admits are the two codes this path can raise — so
    // the list cannot quietly stop covering the refusals a client meets.
    const raised = new Set<string>();
    const capture = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        if (e instanceof DomainError) raised.add(e.code);
        else if (e instanceof AuthzError) raised.add(`authz:${e.reason}`);
      }
    };
    await capture(() => createPortalRequest(principal(), { projectId: pOn, title: "", body: null }));
    for (let i = 0; i < REQUEST_WINDOW_LIMIT; i++) {
      await createPortalRequest(principal(), { projectId: pOn, title: `Fill ${i} ${run}`, body: null });
    }
    await capture(() => createPortalRequest(principal(), { projectId: pOn, title: `Over ${run}`, body: null }));
    expect([...raised].sort()).toEqual(["INVALID_INPUT", "REQUEST_RATE_LIMITED"]);
  });
});
