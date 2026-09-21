import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { DomainError } from "@/lib/domain-error";
import { listPortalTasks } from "@/modules/work";
import { resolvePortalModuleGates, synthesiseContactPrincipal, type PortalPrincipal } from "@/portal";

import { enterViewAs, resolveViewAs } from "./view-as";

/**
 * VIEW-AS-CONTACT, measured against the real schema, the real
 * `app_runtime` role and a real contact principal (Phase 3 slice 5).
 *
 * THE FILE EXISTS FOR TWO CLAIMS THAT ONLY A DATABASE CAN SETTLE.
 *
 * ONE — THE JSON HALF OF BYTE-IDENTITY. SECURITY.md §5.1 and PLAN §12
 * both say View-as must return "byte-identical JSON to a real contact
 * session". Asserting that two calls to one function agree would be
 * tautological, so what is compared here is the PRINCIPAL: the object
 * `synthesiseContactPrincipal()` builds against the object
 * `requirePortalContext()` would build for the same contact — field for
 * field, gates included. That is the whole content of the claim, because
 * `listPortalTasks` takes nothing else (`withPortalRead` derives the
 * transaction's GUCs from exactly those four fields), so two equal
 * principals cannot produce different rows. The rendered half — the one
 * that actually turns on locale and time zone — is `e2e/view-as.spec.ts`,
 * against a real signed-in contact.
 *
 * TWO — THE SCOPE GATE, which is the entire safety argument for View-as
 * spanning a CLIENT rather than a project. `project:manage_portal` is
 * scoped, a member can be assigned to one project of a client, and an
 * unnarrowed `listPortalTasks` materialises every portal-enabled project
 * that client has. So entry runs `assertInScope(tx, actor, { clientId })`
 * with `lifted` LEFT OFF — the arm that takes a DIRECT client assignment
 * or `client:view_all` and refuses the project→client lift.
 *
 * THAT GATE IS UNREACHABLE WITH SEEDED TEMPLATES, which is why this file
 * builds a role by hand. `project:manage_portal` is C M and
 * `client:view_all` is C M A, so every template that holds the first
 * holds the second and resolves `scope.all` — a fixture using the
 * manager seat alone would assert nothing and pass whatever the gate
 * said. The custom "Portal manager" below holds the one code and not the
 * other, which is the only shape in which the lift can be observed being
 * refused. (Mutation-checked: adding `lifted: true` to the service turns
 * the refusal into a pass.)
 *
 * Tenant slugs come from `setupTenant("pvas")`, and the prefix `pvas-`
 * is registered in `DBTEST_PREFIXES` (e2e/fixtures/seed-cli.ts) so
 * `sweep-dbtests` can collect this suite's orphans. `e2e-` is the
 * BROWSER harness's prefix and is swept by AGE — a dbtest using it would
 * have its fixtures deleted mid-run by a concurrent e2e run.
 */

const run = randomUUID().slice(0, 8);

const SHOWN = { a: `Shared A ${run}`, b: `Shared B ${run}` };
const HIDDEN = { internal: `PVASINTERNAL-${run}` };

let f: Awaited<ReturnType<typeof setupTenant>>;
let clientId: string;
let otherClientId: string;
let projectA: string;
let projectB: string;
/** A project of the OTHER client — the coherent door for a Beta contact. */
let projectBeta: string;
let contactId: string;
let unverifiedId: string;
let otherClientContactId: string;
/** Holds `project:manage_portal`, never `client:view_all`. */
let portalManager: { memberId: string; actor: ReturnType<typeof actorFor> };
/** Holds `project:view` and NOT `project:manage_portal` — the permission axis. */
let viewerOnly: { memberId: string; actor: ReturnType<typeof actorFor> };
const states: Record<string, string> = {};

const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const managerCtx = () => ({ tenantId: f.tenantId, actor: portalManager.actor });

let nextNumber = 1;
async function item(input: {
  projectId: string;
  title: string;
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
  targetDate?: Date;
}): Promise<void> {
  const id = randomUUID();
  // `portalEnabled` is NEVER written here: it is trigger-derived from
  // the project (`stamp_portal_enabled`, BEFORE INSERT), the rule
  // AGENTS.md states and which this fixture therefore exercises.
  await f.platform.workItem.create({
    data: {
      id,
      tenantId: f.tenantId,
      clientId,
      projectId: input.projectId,
      number: nextNumber++,
      title: input.title,
      stateId: states[`${input.projectId}:TODO`]!,
      stateCategory: "TODO",
      rootId: id,
      rank: `Zz${randomUUID().replace(/-/g, "")}1`,
      visibility: input.visibility,
      targetDate: input.targetDate ?? null,
    },
  });
}

async function statesFor(pid: string) {
  let rank = 0;
  for (const category of ["BACKLOG", "TODO", "IN_PROGRESS", "DONE", "CANCELLED", "TRIAGE"] as const) {
    const id = randomUUID();
    states[`${pid}:${category}`] = id;
    await f.platform.workflowState.create({
      data: {
        id,
        tenantId: f.tenantId,
        projectId: pid,
        name: `${category}-${run}`,
        category,
        rank: `a${(rank++).toString().padStart(4, "0")}`,
        isDefault: category === "BACKLOG",
      },
    });
  }
}

beforeAll(async () => {
  f = await setupTenant("pvas");
  clientId = randomUUID();
  otherClientId = randomUUID();
  projectA = randomUUID();
  projectB = randomUUID();
  projectBeta = randomUUID();
  contactId = randomUUID();
  unverifiedId = randomUUID();
  otherClientContactId = randomUUID();

  const up = run.slice(0, 2).toUpperCase();
  await f.platform.client.createMany({
    data: [
      { id: clientId, tenantId: f.tenantId, name: `Acme ${run}` },
      { id: otherClientId, tenantId: f.tenantId, name: `Beta ${run}` },
    ],
  });
  await f.platform.project.createMany({
    data: [
      { id: projectA, tenantId: f.tenantId, clientId, key: `PWA${up}`, name: `Site ${run}`, portalEnabled: true },
      { id: projectB, tenantId: f.tenantId, clientId, key: `PWB${up}`, name: `Shop ${run}`, portalEnabled: true },
      { id: projectBeta, tenantId: f.tenantId, clientId: otherClientId, key: `PWC${up}`, name: `Beta ${run}`, portalEnabled: true },
    ],
  });
  await statesFor(projectA);
  await statesFor(projectB);

  const invitedAt = new Date("2026-09-01T09:00:00Z");
  await f.platform.contact.createMany({
    data: [
      {
        id: contactId,
        tenantId: f.tenantId,
        clientId,
        name: "Anna",
        email: `pvas-anna-${run}@test.invalid`,
        portalProfile: "CONTACT_PRIMARY",
        portalStatus: "ACTIVE",
        invitedAt,
        emailVerified: true,
        // SET DELIBERATELY, and it is the only contact in the product
        // with one: nothing in application code writes `Contact.locale`
        // (the auth path declares it `input: false`), so a fixture that
        // left it null would make the locale pin untestable and the
        // byte-identity claim unmeasurable in the direction that matters.
        locale: "sv",
      },
      {
        id: unverifiedId,
        tenantId: f.tenantId,
        clientId,
        name: "Never verified",
        email: `pvas-unver-${run}@test.invalid`,
        portalProfile: "CONTACT_PRIMARY",
        portalStatus: "ACTIVE",
        invitedAt,
        emailVerified: false,
      },
      {
        id: otherClientContactId,
        tenantId: f.tenantId,
        clientId: otherClientId,
        name: "Beta contact",
        email: `pvas-beta-${run}@test.invalid`,
        portalProfile: "CONTACT_PRIMARY",
        portalStatus: "ACTIVE",
        invitedAt,
        emailVerified: true,
      },
    ],
  });

  // The custom role: `project:manage_portal` and nothing else. Seated on
  // a bare member with no system role, so `client:view_all` cannot reach
  // them by any path.
  const userId = randomUUID();
  await f.platform.user.create({
    data: { id: userId, name: `pm-${run}@test.invalid`, email: `pm-${run}@test.invalid` },
  });
  const member = await f.platform.member.create({ data: { tenantId: f.tenantId, userId } });
  const role = await f.platform.role.create({
    data: { tenantId: f.tenantId, name: `Portal manager ${run}` },
  });
  const perms = await f.platform.permission.findMany({
    where: { code: { in: ["project:manage_portal", "project:view"] } },
  });
  // The catalogue must be seeded for this suite to mean anything: with
  // no `permission` rows the role holds nothing and every case below
  // would pass by refusing everybody.
  expect(perms.map((p) => p.code).sort()).toEqual(["project:manage_portal", "project:view"]);
  await f.platform.rolePermission.createMany({
    data: perms.map((p) => ({ tenantId: f.tenantId, roleId: role.id, permissionId: p.id })),
  });
  await f.platform.memberRole.create({
    data: { tenantId: f.tenantId, memberId: member.id, roleId: role.id },
  });
  // ONE PROJECT of Acme — so their client scope is LIFTED, never direct.
  await f.platform.memberProject.create({
    data: { tenantId: f.tenantId, memberId: member.id, projectId: projectA },
  });
  portalManager = { memberId: member.id, actor: actorFor(member.id) };

  // A SECOND custom seat, for the PERMISSION axis. Every other actor in
  // this file holds `project:manage_portal`, so nothing measured
  // `requireAccess` denying — and the service documents an ORDER that
  // depends on it ("the permission is checked before the scope, so a
  // member without it gets FORBIDDEN on any client rather than NOT_FOUND
  // on the ones they cannot reach"). That was prose until a code review
  // asked for it. This seat holds `project:view` only and is assigned
  // DIRECTLY to the client, so scope cannot be what refuses it.
  const viewerUserId = randomUUID();
  await f.platform.user.create({
    data: { id: viewerUserId, name: `vo-${run}@test.invalid`, email: `vo-${run}@test.invalid` },
  });
  const viewerMember = await f.platform.member.create({
    data: { tenantId: f.tenantId, userId: viewerUserId },
  });
  const viewerRole = await f.platform.role.create({
    data: { tenantId: f.tenantId, name: `Viewer only ${run}` },
  });
  const viewPerm = await f.platform.permission.findFirstOrThrow({
    where: { code: "project:view" },
  });
  await f.platform.rolePermission.create({
    data: { tenantId: f.tenantId, roleId: viewerRole.id, permissionId: viewPerm.id },
  });
  await f.platform.memberRole.create({
    data: { tenantId: f.tenantId, memberId: viewerMember.id, roleId: viewerRole.id },
  });
  await f.platform.memberClient.create({
    data: { tenantId: f.tenantId, memberId: viewerMember.id, clientId },
  });
  viewerOnly = { memberId: viewerMember.id, actor: actorFor(viewerMember.id) };

  await item({ projectId: projectA, title: SHOWN.a, visibility: "CLIENT_VISIBLE", targetDate: new Date("2026-02-01T00:00:00Z") });
  await item({ projectId: projectA, title: HIDDEN.internal, visibility: "INTERNAL" });
  await item({ projectId: projectB, title: SHOWN.b, visibility: "CLIENT_VISIBLE", targetDate: new Date("2026-01-01T00:00:00Z") });
});

afterAll(async () => {
  if (!f) return;
  await f.platform.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${f.tenantId}`;
  await f.platform.workItem.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.memberProject.deleteMany({ where: { tenantId: f.tenantId } });
  // `setupTenant`'s cleanup sweeps memberRole/rolePermission/role/member
  // but NOT memberClient, and this suite creates one for the viewer-only
  // seat plus two inside tests. A left-behind row would block the member
  // delete on its foreign key and strand the whole tenant.
  await f.platform.memberClient.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.contact.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.project.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
});

/** The principal `requirePortalContext()` builds from a contact session. */
async function sessionPrincipal(id: string): Promise<PortalPrincipal> {
  const row = await f.platform.contact.findUniqueOrThrow({
    where: { id },
    select: { id: true, tenantId: true, clientId: true },
  });
  return {
    contactId: row.id,
    tenantId: row.tenantId,
    clientId: row.clientId,
    gates: await resolvePortalModuleGates(row.tenantId),
  };
}

const titles = (l: Awaited<ReturnType<typeof listPortalTasks>>) =>
  l.projects.flatMap((p) => p.tasks.map((t) => t.title)).sort();

describe("view-as-contact is the contact's own read", () => {
  it("synthesises the very principal a contact session would carry", async () => {
    const target = await enterViewAs(ownerCtx(), { contactId, fromProjectId: projectA });
    const synthesised = await synthesiseContactPrincipal(target.tenantId, {
      id: target.contactId,
      tenantId: target.tenantId,
      clientId: target.clientId,
    });

    // FIELD FOR FIELD, gates included. This is the assertion the JSON
    // half of the pins reduces to: `withPortalRead` derives the
    // transaction's GUCs from exactly these four values, so equal
    // principals cannot read different rows.
    expect(synthesised).toEqual(await sessionPrincipal(contactId));
    // And byte-identical when serialised, which is the word the
    // documents actually use.
    expect(JSON.stringify(synthesised)).toBe(JSON.stringify(await sessionPrincipal(contactId)));
    // THE FIELD SET, pinned separately — because `sessionPrincipal()`
    // above is a hand-built copy of `requirePortalContext()`'s body, not
    // a call to it (it needs a real contact session, which a dbtest
    // cannot mint). A field added to `PortalPrincipal` and wired into
    // the real builder but not into this copy would otherwise leave both
    // assertions green while the two principals diverged (code review).
    expect(Object.keys(synthesised).sort()).toEqual(
      ["clientId", "contactId", "gates", "tenantId"],
    );
  });

  it("returns byte-identical JSON to the contact's own request", async () => {
    const target = await enterViewAs(ownerCtx(), { contactId, fromProjectId: projectA });
    const asMember = await listPortalTasks(
      await synthesiseContactPrincipal(target.tenantId, {
        id: target.contactId,
        tenantId: target.tenantId,
        clientId: target.clientId,
      }),
    );
    const asContact = await listPortalTasks(await sessionPrincipal(contactId));
    expect(JSON.stringify(asMember)).toBe(JSON.stringify(asContact));
    // …and it is not vacuously equal because both are empty.
    expect(asContact.projects.length).toBeGreaterThan(0);
  });

  it("spans the whole CLIENT, which is what the preview does not", async () => {
    // The Portal tab narrows to one project; View-as must not, because
    // what a contact sees is their portal — every portal-enabled project
    // their client has. This is the behavioural difference the whole
    // slice turns on.
    const list = await listPortalTasks(await sessionPrincipal(contactId));
    expect(titles(list)).toEqual([SHOWN.b, SHOWN.a].sort());
    expect(list.projects.map((p) => p.projectId).sort()).toEqual([projectA, projectB].sort());
    // INTERNAL never crosses, and it is `portal_gate` that says so, not
    // a filter in TypeScript.
    expect(titles(list)).not.toContain(HIDDEN.internal);
  });
});

describe("who may enter", () => {
  it("refuses a member who reaches only ONE project of the client", async () => {
    // The custom role holds `project:manage_portal`, so this is not a
    // permission refusal — it is the `lifted` arm of `assertInScope`
    // being declined. NOT_FOUND, because existence must not leak across
    // the client boundary (AUTHZ §4).
    await expect(
      enterViewAs(managerCtx(), { contactId, fromProjectId: projectA }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
  });

  it("admits the same member once the CLIENT itself is assigned", async () => {
    // The other half of the same measurement: without it, the case above
    // would pass for any reason at all — a typo in the permission code
    // included.
    await f.platform.memberClient.create({
      data: { tenantId: f.tenantId, memberId: portalManager.memberId, clientId },
    });
    try {
      const target = await enterViewAs(managerCtx(), { contactId, fromProjectId: projectA });
      expect(target.contactId).toBe(contactId);
    } finally {
      await f.platform.memberClient.deleteMany({
        where: { tenantId: f.tenantId, memberId: portalManager.memberId },
      });
    }
  });

  it("refuses a member who lacks the permission, on the PERMISSION and not the scope", async () => {
    // `viewerOnly` is assigned DIRECTLY to this client, so the scope arm
    // would admit them; the refusal can only be `requireAccess`. And it
    // is FORBIDDEN rather than NOT_FOUND, which is the documented order:
    // the permission is checked first, so a member without it learns
    // nothing about which clients or contacts exist.
    await expect(
      enterViewAs({ tenantId: f.tenantId, actor: viewerOnly.actor }, {
        contactId,
        fromProjectId: projectA,
      }),
    ).rejects.toMatchObject({ reason: "FORBIDDEN" });
    // The render-time gate agrees — null, not a throw.
    expect(
      await resolveViewAs({ tenantId: f.tenantId, actor: viewerOnly.actor }, contactId),
    ).toBeNull();
  });

  it("refuses a contact who could not sign in", async () => {
    // `authorizePortal()` admits ACTIVE + invited, but
    // `portalGateDecision` refuses an unverified address before any
    // portal page runs — so viewing as this person would be a preview of
    // a page that does not exist. A DomainError, not an AuthzError: the
    // member IS the agency and this is their own tenant's state to fix.
    await expect(
      enterViewAs(ownerCtx(), { contactId: unverifiedId, fromProjectId: projectA }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("refuses a project that belongs to a DIFFERENT client than the contact", async () => {
    // Found by this test, not by a reading: an owner holds
    // `client:view_all`, so `assertInScope` accepts Acme's project AND
    // Beta's contact, and the audit row would then have said "from
    // Acme's project, viewed as a contact of Beta" — a sentence
    // describing nothing that happened. The service refuses the pair.
    await expect(
      enterViewAs(ownerCtx(), { contactId: otherClientContactId, fromProjectId: projectA }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
  });

  it("lets a member who reaches EVERY client enter any of them, from that client's own project", async () => {
    // The other half, and it is what stops the case above from passing
    // for the wrong reason. `client:view_all` genuinely reaches Beta,
    // so the refusal there is about the PAIR and not about the client.
    const target = await enterViewAs(ownerCtx(), {
      contactId: otherClientContactId,
      fromProjectId: projectBeta,
    });
    expect(target.clientId).toBe(otherClientId);
  });

  it("refuses a cross-CLIENT contact to a member scoped to one client", async () => {
    // Directly assigned to Acme — so this is not the lift being refused
    // (that is the first case in this block); it is the client boundary.
    await f.platform.memberClient.create({
      data: { tenantId: f.tenantId, memberId: portalManager.memberId, clientId },
    });
    try {
      await expect(
        enterViewAs(managerCtx(), {
          contactId: otherClientContactId,
          fromProjectId: projectBeta,
        }),
      ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    } finally {
      await f.platform.memberClient.deleteMany({
        where: { tenantId: f.tenantId, memberId: portalManager.memberId },
      });
    }
  });

  it("refuses a contact that does not exist, identically", async () => {
    await expect(
      enterViewAs(ownerCtx(), { contactId: randomUUID(), fromProjectId: projectA }),
    ).rejects.toBeInstanceOf(AuthzError);
  });

  it("refuses a principal whose tenant disagrees with the caller's", async () => {
    // Under `tenant_isolation` this cannot happen from a real read, so
    // it can only fire when a GUC and a row disagree — which is exactly
    // when one wants it to. The belt is in the builder, where the next
    // member-plane surface cannot bypass it.
    await expect(
      synthesiseContactPrincipal(randomUUID(), {
        id: contactId,
        tenantId: f.tenantId,
        clientId,
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
  });
});

describe("the audit row", () => {
  it("is written once per ENTRY and never by a render", async () => {
    const before = (await f.audits("project.viewed_as_contact")).length;

    await enterViewAs(ownerCtx(), { contactId, fromProjectId: projectA });
    const afterOne = await f.audits("project.viewed_as_contact");
    expect(afterOne.length).toBe(before + 1);

    const row = afterOne.at(-1)!;
    expect(row.actorType).toBe("MEMBER");
    expect(row.actorId).toBe(f.seats.owner.memberId);
    expect(row.targetType).toBe("Project");
    expect(row.targetId).toBe(projectA);
    // Ids and an enum; never the name the banner renders.
    expect(row.metadata).toMatchObject({ contactId, clientId, portalProfile: "CONTACT_PRIMARY" });
    expect(JSON.stringify(row.metadata)).not.toContain("Anna");

    // THE RENDER PATH WRITES NOTHING, which is what makes "once per
    // entry" true rather than aspirational: `/view-as` re-authorises on
    // every navigation, and a row per render would bury the act.
    await resolveViewAs(ownerCtx(), contactId);
    await resolveViewAs(ownerCtx(), contactId);
    expect((await f.audits("project.viewed_as_contact")).length).toBe(before + 1);
  });

  it("writes nothing when entry is refused", async () => {
    const before = (await f.audits("project.viewed_as_contact")).length;
    await expect(
      enterViewAs(ownerCtx(), { contactId: unverifiedId, fromProjectId: projectA }),
    ).rejects.toBeInstanceOf(DomainError);
    expect((await f.audits("project.viewed_as_contact")).length).toBe(before);
  });
});

describe("the render-time gate", () => {
  it("returns the contact while the member still qualifies", async () => {
    const target = await resolveViewAs(ownerCtx(), contactId);
    expect(target?.contactId).toBe(contactId);
    // The locale the page is pinned to — null everywhere else in the
    // product, which is why the fixture sets it.
    expect(target?.locale).toBe("sv");
  });

  it("goes null rather than throwing when the member no longer does", async () => {
    // A member who has lost the permission must land back in their own
    // application, not on an error boundary rendered inside a portal
    // frame under a red banner still claiming they are looking at Acme.
    expect(await resolveViewAs(managerCtx(), contactId)).toBeNull();
    // …and the same for a contact who can no longer sign in.
    expect(await resolveViewAs(ownerCtx(), unverifiedId)).toBeNull();
  });
});
