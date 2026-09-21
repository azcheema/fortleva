import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
/* eslint-disable no-restricted-imports -- dbtest setup/cleanup uses the raw layer */
import { getPlatformClient } from "@/db/client";
import { withTenant } from "@/db";
import {
  authorizePortal,
  resolvePortalModuleGates,
  withPortalRead,
  type PortalPrincipal,
} from "@/portal";

import { listPortalTasks } from "./portal";

/**
 * "NO INTERNAL FACT TO A CONTACT" — the fixture suite the pins require in
 * the same commit as each portal feature (work-management plan §3.2,
 * PLAN.md Phase 3 tests), against the real schema, the real `app_runtime`
 * role and the real contact principal.
 *
 * ITS CENTRAL ASSERTION IS NOT A FIELD LIST. Every internal fact in this
 * fixture is planted as a SENTINEL STRING that appears nowhere else —
 * the state's name, the internal milestone's name, the label, the
 * client's internal notes, the project's repo and hosting pointers, the
 * titles of the rows a contact must not see — and the test serialises
 * the whole projection and asserts that not one of them appears in it.
 * That is deliberately stronger than "the shape has no `stateId` key":
 * a leak through a field this test has never heard of, through a nested
 * relation, through a future column, still fails. The forbidden-columns
 * grep and the structural allow-list check
 * (`src/authz/portal-projections.test.ts`) are the static half; this is
 * the half that reads what actually came out of Postgres.
 *
 * WHAT ONLY A DATABASE CAN SAY, and is therefore here rather than in a
 * unit test: that an INTERNAL child of a shared parent is absent because
 * `portal_gate` refused it; that flipping `portalEnabled` off empties
 * the list; that another client's and another tenant's shared work is
 * not merely filtered out in TypeScript but unreachable.
 *
 * Tenant slugs are spelled out literally at the `slug:` key and the
 * prefix `pwork-` is registered in `DBTEST_PREFIXES` (e2e/fixtures/seed-cli.ts)
 * so `sweep-dbtests` can collect this suite's orphans. `e2e-` is the
 * BROWSER harness's prefix and is swept by age — a dbtest using it would
 * have its fixtures deleted mid-run by a concurrent e2e run.
 */

const run = randomUUID().slice(0, 8);

/** Strings that exist nowhere but on an INTERNAL-only column. */
const S = {
  stateName: `SENTINELSTATE-${run}`,
  internalPhase: `SENTINELPHASE-${run}`,
  label: `SENTINELLABEL-${run}`,
  clientNote: `SENTINELNOTE-${run}`,
  repo: `SENTINELREPO-${run}`,
  hosting: `SENTINELHOST-${run}`,
  internalTask: `SENTINELINTERNALTASK-${run}`,
  hiddenProject: `SENTINELHIDDENPROJECT-${run}`,
  archivedProject: `SENTINELARCHIVEDPROJECT-${run}`,
  otherClientTask: `SENTINELOTHERCLIENT-${run}`,
  otherTenantTask: `SENTINELOTHERTENANT-${run}`,
  deletedTask: `SENTINELDELETED-${run}`,
  archivedTask: `SENTINELARCHIVED-${run}`,
  cancelledTask: `SENTINELCANCELLED-${run}`,
} as const;

/** Titles a contact IS meant to read. */
const SHOWN = {
  planned: `Shared planned ${run}`,
  started: `Shared in progress ${run}`,
  done: `Shared done ${run}`,
  triaged: `Shared request ${run}`,
  dated: `Shared dated ${run}`,
  sharedPhase: `Design ${run}`,
} as const;

const T = randomUUID();
const T2 = randomUUID();
const acme = randomUUID();
const beta = randomUUID();
const gamma = randomUUID();
const pOn = randomUUID();
const pOff = randomUUID();
const pArchived = randomUUID(); // portalEnabled TRUE, project archived
const pBeta = randomUUID();
const pGamma = randomUUID();

/** Stands in for a Member id — no FK on `Contact.invitedById`, by design. */
const memberId = randomUUID();

const ids = {
  primary: randomUUID(),
  collaborator: randomUUID(),
  suspended: randomUUID(),
  betaContact: randomUUID(),
  gammaContact: randomUUID(),
  sharedPhase: randomUUID(),
  internalPhase: randomUUID(),
  label: randomUUID(),
};

const states: Record<string, string> = {};
const invitedAt = new Date("2026-09-01T09:00:00Z");
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;

const principal = (contactId: string, over: Partial<PortalPrincipal> = {}): PortalPrincipal => ({
  contactId,
  tenantId: T,
  clientId: acme,
  gates,
  ...over,
});

/** A raw work-item row. `portalEnabled` is NEVER written here: it is
 *  trigger-derived from the project (`stamp_portal_enabled`, BEFORE
 *  INSERT), which is the rule AGENTS.md states and which this fixture
 *  therefore also exercises. */
let nextNumber = 1;
async function item(input: {
  tenantId: string;
  clientId: string;
  projectId: string;
  title: string;
  category: "BACKLOG" | "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED" | "TRIAGE";
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
  milestoneId?: string;
  targetDate?: Date;
  completedAt?: Date;
  deletedAt?: Date;
  archivedAt?: Date;
}): Promise<string> {
  const db = getPlatformClient();
  const id = randomUUID();
  await db.workItem.create({
    data: {
      id,
      tenantId: input.tenantId,
      clientId: input.clientId,
      projectId: input.projectId,
      number: nextNumber++,
      title: input.title,
      stateId: states[`${input.projectId}:${input.category}`]!,
      stateCategory: input.category,
      // `work_item_triage_has_status`: a TRIAGE row must carry one.
      triageStatus: input.category === "TRIAGE" ? "PENDING" : null,
      rootId: id,
      // A valid fractional key that sorts before every generated one —
      // the shape `tree-guards.dbtest.ts` settled on.
      rank: `Zz${randomUUID().replace(/-/g, "")}1`,
      visibility: input.visibility,
      milestoneId: input.milestoneId ?? null,
      targetDate: input.targetDate ?? null,
      completedAt: input.completedAt ?? null,
      deletedAt: input.deletedAt ?? null,
      archivedAt: input.archivedAt ?? null,
    },
  });
  return id;
}

beforeAll(async () => {
  const db = getPlatformClient();
  await db.tenant.create({
    data: { id: T, name: `pwork-a-${run}`, slug: `pwork-a-${run}`, entitlements: {} },
  });
  await db.tenant.create({
    data: { id: T2, name: `pwork-b-${run}`, slug: `pwork-b-${run}`, entitlements: {} },
  });
  await db.client.createMany({
    data: [
      { id: acme, tenantId: T, name: "Acme", internalNotes: S.clientNote },
      { id: beta, tenantId: T, name: "Beta" },
      { id: gamma, tenantId: T2, name: "Gamma" },
    ],
  });
  await db.project.createMany({
    data: [
      {
        id: pOn,
        tenantId: T,
        clientId: acme,
        key: "PWON",
        name: `Acme website ${run}`,
        portalEnabled: true,
        repoUrl: S.repo,
        hostingNotes: S.hosting,
      },
      { id: pOff, tenantId: T, clientId: acme, key: "PWOFF", name: S.hiddenProject },
      // PORTAL ON *AND* ARCHIVED — the combination `project`'s own
      // `portal_gate` does not separate (it binds client + portal_enabled
      // and nothing else) and `archiveProject` leaves `portalEnabled`
      // true. Without the projection's own filter this project would go
      // on publishing to the client for ever.
      {
        id: pArchived,
        tenantId: T,
        clientId: acme,
        key: "PWARCH",
        name: "Archived but still switched on",
        portalEnabled: true,
        status: "ARCHIVED",
        archivedAt: new Date("2026-01-01T00:00:00Z"),
      },
      { id: pBeta, tenantId: T, clientId: beta, key: "PWBETA", name: "Beta site", portalEnabled: true },
      { id: pGamma, tenantId: T2, clientId: gamma, key: "PWGAM", name: "Gamma site", portalEnabled: true },
    ],
  });

  // One state per (project, category). EVERY state carries a sentinel
  // name, including the ones the shared rows sit in: a state NAME is on
  // the never-shown list whatever the row's visibility is.
  const categories = ["BACKLOG", "TODO", "IN_PROGRESS", "DONE", "CANCELLED", "TRIAGE"] as const;
  let rank = 0;
  for (const [tenantId, projectId] of [
    [T, pOn],
    [T, pOff],
    [T, pArchived],
    [T, pBeta],
    [T2, pGamma],
  ] as const) {
    for (const category of categories) {
      const id = randomUUID();
      states[`${projectId}:${category}`] = id;
      await db.workflowState.create({
        data: {
          id,
          tenantId,
          projectId,
          // Unique per (tenant, project, name), so the sentinel carries
          // the category — the sweep below matches on its PREFIX.
          name: `${S.stateName}-${category}`,
          category,
          rank: `a${(rank++).toString().padStart(4, "0")}`,
          isDefault: category === "BACKLOG",
        },
      });
    }
  }

  await db.milestone.createMany({
    data: [
      {
        id: ids.sharedPhase,
        tenantId: T,
        clientId: acme,
        projectId: pOn,
        name: SHOWN.sharedPhase,
        rank: "a0",
        visibility: "CLIENT_VISIBLE",
      },
      {
        id: ids.internalPhase,
        tenantId: T,
        clientId: acme,
        projectId: pOn,
        name: S.internalPhase,
        rank: "a1",
        visibility: "INTERNAL",
      },
    ],
  });
  await db.label.create({ data: { id: ids.label, tenantId: T, projectId: pOn, name: S.label } });

  await db.contact.createMany({
    data: [
      { id: ids.primary, tenantId: T, clientId: acme, name: "Primary", email: `pw-primary-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt },
      // Invited BY a member, which is the hazard the forbidden-columns
      // list names: the id is a `Member.id` sitting on a row every
      // contact of this client may read. Measured below.
      { id: ids.collaborator, tenantId: T, clientId: acme, name: "Collab", email: `pw-collab-${run}@test.invalid`, portalProfile: "CONTACT_COLLABORATOR", portalStatus: "ACTIVE", invitedAt, invitedById: memberId },
      { id: ids.suspended, tenantId: T, clientId: acme, name: "Suspended", email: `pw-susp-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "SUSPENDED", invitedAt },
      { id: ids.betaContact, tenantId: T, clientId: beta, name: "Beta", email: `pw-beta-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt },
      { id: ids.gammaContact, tenantId: T2, clientId: gamma, name: "Gamma", email: `pw-gamma-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt },
    ],
  });

  // ── what a contact SHOULD see ────────────────────────────────────
  const shared = await item({ tenantId: T, clientId: acme, projectId: pOn, title: SHOWN.planned, category: "TODO", visibility: "CLIENT_VISIBLE", milestoneId: ids.sharedPhase });
  // …wearing a label, so "a shared row's own INTERNAL children never
  // travel with it" is measured rather than assumed. `Label` is class A:
  // a contact cannot read the join row at all, and the projection never
  // asks — both halves matter, and only one of them is this file's.
  await getPlatformClient().workItemLabel.create({
    data: { tenantId: T, workItemId: shared, labelId: ids.label },
  });
  await item({ tenantId: T, clientId: acme, projectId: pOn, title: SHOWN.started, category: "IN_PROGRESS", visibility: "CLIENT_VISIBLE" });
  await item({ tenantId: T, clientId: acme, projectId: pOn, title: SHOWN.done, category: "DONE", visibility: "CLIENT_VISIBLE", completedAt: new Date("2026-09-10T10:00:00Z") });
  await item({ tenantId: T, clientId: acme, projectId: pOn, title: SHOWN.triaged, category: "TRIAGE", visibility: "CLIENT_VISIBLE" });
  await item({ tenantId: T, clientId: acme, projectId: pOn, title: SHOWN.dated, category: "TODO", visibility: "CLIENT_VISIBLE", targetDate: new Date("2026-09-25T00:00:00Z") });

  // ── what a contact must NOT see ──────────────────────────────────
  await item({ tenantId: T, clientId: acme, projectId: pOn, title: S.internalTask, category: "TODO", visibility: "INTERNAL" });
  // A CLIENT_VISIBLE row carrying an INTERNAL milestone: the ROW is
  // shared, the PHASE is not, and the name must not ride along.
  await item({ tenantId: T, clientId: acme, projectId: pOn, title: `Shared, internal phase ${run}`, category: "TODO", visibility: "CLIENT_VISIBLE", milestoneId: ids.internalPhase });
  await item({ tenantId: T, clientId: acme, projectId: pOff, title: S.hiddenProject, category: "TODO", visibility: "CLIENT_VISIBLE" });
  await item({ tenantId: T, clientId: acme, projectId: pArchived, title: S.archivedProject, category: "TODO", visibility: "CLIENT_VISIBLE" });
  await item({ tenantId: T, clientId: beta, projectId: pBeta, title: S.otherClientTask, category: "TODO", visibility: "CLIENT_VISIBLE" });
  await item({ tenantId: T2, clientId: gamma, projectId: pGamma, title: S.otherTenantTask, category: "TODO", visibility: "CLIENT_VISIBLE" });
  await item({ tenantId: T, clientId: acme, projectId: pOn, title: S.deletedTask, category: "TODO", visibility: "CLIENT_VISIBLE", deletedAt: new Date() });
  await item({ tenantId: T, clientId: acme, projectId: pOn, title: S.archivedTask, category: "TODO", visibility: "CLIENT_VISIBLE", archivedAt: new Date() });
  await item({ tenantId: T, clientId: acme, projectId: pOn, title: S.cancelledTask, category: "CANCELLED", visibility: "CLIENT_VISIBLE" });

  gates = await resolvePortalModuleGates(T);
});

afterAll(async () => {
  const db = getPlatformClient();
  for (const tenantId of [T, T2]) {
    await db.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${tenantId}`;
    await db.workItemLabel.deleteMany({ where: { tenantId } });
    await db.workItem.deleteMany({ where: { tenantId } });
    await db.label.deleteMany({ where: { tenantId } });
    await db.milestone.deleteMany({ where: { tenantId } });
    await db.workflowState.deleteMany({ where: { tenantId } });
    await db.contact.deleteMany({ where: { tenantId } });
    await db.project.deleteMany({ where: { tenantId } });
    await db.client.deleteMany({ where: { tenantId } });
    await db.tenantPreference.deleteMany({ where: { tenantId } });
    await db.tenant.delete({ where: { id: tenantId } });
  }
});

const titles = (list: Awaited<ReturnType<typeof listPortalTasks>>) =>
  list.projects.flatMap((p) => p.tasks.map((t) => t.title)).sort();

describe("the client-visible task list", () => {
  it("returns exactly the shared, live, non-cancelled tasks of portal-enabled projects", async () => {
    const list = await listPortalTasks(principal(ids.primary));
    expect(titles(list)).toEqual(
      [SHOWN.planned, SHOWN.started, SHOWN.done, SHOWN.triaged, SHOWN.dated, `Shared, internal phase ${run}`].sort(),
    );
    expect(list.shown).toBe(6);
    expect(list.truncated).toBe(false);
    // One project, because the other three are off, another client's, or
    // another tenant's.
    expect(list.projects).toHaveLength(1);
    expect(list.projects[0]!.projectName).toBe(`Acme website ${run}`);
  });

  it("speaks the portal's four categories and never the tenant's", async () => {
    const list = await listPortalTasks(principal(ids.primary));
    const byTitle = new Map(list.projects.flatMap((p) => p.tasks).map((t) => [t.title, t]));
    expect(byTitle.get(SHOWN.planned)?.category).toBe("PLANNED");
    expect(byTitle.get(SHOWN.started)?.category).toBe("IN_PROGRESS");
    expect(byTitle.get(SHOWN.done)?.category).toBe("DONE");
    // TRIAGE is "Requested", not "Planned": it is the client's own
    // submission and nobody has agreed to it yet (portal.ts).
    expect(byTitle.get(SHOWN.triaged)?.category).toBe("REQUESTED");
  });

  it("shows a CLIENT_VISIBLE phase and never an INTERNAL one", async () => {
    const list = await listPortalTasks(principal(ids.primary));
    const byTitle = new Map(list.projects.flatMap((p) => p.tasks).map((t) => [t.title, t]));
    expect(byTitle.get(SHOWN.planned)?.phase).toBe(SHOWN.sharedPhase);
    // The ROW is shared; its milestone is not. RLS returns no milestone
    // row under this principal, so the name cannot be resolved — and the
    // projection renders that as "no phase", not as a blank name.
    expect(byTitle.get(`Shared, internal phase ${run}`)?.phase).toBeNull();
  });

  it("orders by the agreed day, soonest first, undated last — never by rank", async () => {
    const list = await listPortalTasks(principal(ids.primary));
    const tasks = list.projects[0]!.tasks;
    expect(tasks[0]!.title).toBe(SHOWN.dated);
    expect(tasks.slice(1).every((t) => t.targetDate === null)).toBe(true);
  });

  it("gives a COLLABORATOR the same list — the capability is in both profiles", async () => {
    const collab = await listPortalTasks(principal(ids.collaborator));
    const primary = await listPortalTasks(principal(ids.primary));
    expect(titles(collab)).toEqual(titles(primary));
  });
});

describe("no INTERNAL fact reaches a contact", () => {
  it("no sentinel appears anywhere in the serialised projection", async () => {
    const serialised = JSON.stringify(await listPortalTasks(principal(ids.primary)));
    const leaked = Object.entries(S)
      .filter(([, value]) => serialised.includes(value))
      .map(([key]) => key);
    expect(leaked).toEqual([]);
  });

  it("the projection carries no key that is not on the contract", async () => {
    // The sentinel sweep catches a leaked VALUE; this catches a leaked
    // SHAPE — an id, a tenant, a flag that says something about how the
    // tenant works. Together they are what "allow-list" means at runtime.
    const list = await listPortalTasks(principal(ids.primary));
    expect(Object.keys(list).sort()).toEqual(["projects", "shown", "truncated"]);
    for (const project of list.projects) {
      expect(Object.keys(project).sort()).toEqual(["projectId", "projectName", "tasks"]);
      for (const task of project.tasks) {
        expect(Object.keys(task).sort()).toEqual([
          "category",
          "completedAt",
          "id",
          "phase",
          "targetDate",
          "title",
        ]);
      }
    }
  });

  it("an ARCHIVED project stops publishing, even with its portal switch still on", async () => {
    // The policy does NOT do this and cannot be relied on to: `project`'s
    // `portal_gate` is `client_id = app.client_id AND portal_enabled`
    // with no archive term, and `archiveProject` leaves `portalEnabled`
    // true. Measured from both ends — the row is reachable to the tenant
    // and absent from the client's list.
    const list = await listPortalTasks(principal(ids.primary));
    expect(titles(list)).not.toContain(S.archivedProject);
    const db = getPlatformClient();
    expect(
      await db.workItem.count({ where: { tenantId: T, title: S.archivedProject } }),
    ).toBe(1);
    expect(
      (await db.project.findFirstOrThrow({
        where: { tenantId: T, id: pArchived },
        select: { portalEnabled: true },
      })).portalEnabled,
    ).toBe(true);
  });

  it("turning the project's portal switch off empties the list", async () => {
    const db = getPlatformClient();
    await db.project.update({ where: { tenantId_id: { tenantId: T, id: pOn } }, data: { portalEnabled: false } });
    try {
      const list = await listPortalTasks(principal(ids.primary));
      expect(list.projects).toEqual([]);
      expect(list.shown).toBe(0);
    } finally {
      await db.project.update({ where: { tenantId_id: { tenantId: T, id: pOn } }, data: { portalEnabled: true } });
    }
  });

  it("another client's contact sees its own client's work and nothing of Acme's", async () => {
    const list = await listPortalTasks(
      principal(ids.betaContact, { clientId: beta }),
    );
    expect(titles(list)).toEqual([S.otherClientTask]);
  });

  it("another tenant's contact reaches nothing here at all", async () => {
    const list = await listPortalTasks(
      principal(ids.gammaContact, { tenantId: T2, clientId: gamma, gates: await resolvePortalModuleGates(T2) }),
    );
    expect(titles(list)).toEqual([S.otherTenantTask]);
  });

  it("a suspended contact is refused before any row is read", async () => {
    await expect(listPortalTasks(principal(ids.suspended))).rejects.toBeInstanceOf(AuthzError);
  });

  it("a principal claiming another client's scope reads nothing of it", async () => {
    // The session and the row disagree: `authorizePortal` step 1 reads
    // the contact row under the claimed GUCs and refuses when they do
    // not match. NOT_FOUND, never FORBIDDEN — existence must not leak.
    const refusal = await listPortalTasks(principal(ids.primary, { clientId: beta })).catch(
      (e: unknown) => e,
    );
    expect(refusal).toBeInstanceOf(AuthzError);
    expect((refusal as AuthzError).reason).toBe("NOT_FOUND");
  });
});

describe("why Contact.invitedById is on the forbidden-columns list", () => {
  it("a contact really can read its client's OTHER contact rows, member id and all", async () => {
    // MEASURED, because the reason this column is forbidden is a claim
    // about a POLICY and not about a projection: `portal_gate` on
    // `contact` is structural — client match only, no visibility term
    // (migration 20260816180000) — so RLS hands a contact the whole row
    // of every colleague at its own client, and the only thing standing
    // between a `Member.id` and a client's browser is the allow-list in
    // a `portal.ts`. If this test ever starts returning zero rows, the
    // policy changed and the entry can be revisited; until then it is
    // load-bearing.
    const rows = await withPortalRead(principal(ids.primary), (tx) =>
      tx.contact.findMany({ select: { id: true, invitedById: true } }),
    );
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.find((r) => r.id === ids.collaborator)?.invitedById).toBe(memberId);
    // …and never a contact of another client, which is the half that
    // makes the row-level grant safe at all.
    expect(rows.some((r) => r.id === ids.betaContact)).toBe(false);
  });
});

describe("the projection cannot be run under the wrong principal", () => {
  it("refuses a system transaction — a projection built as system has lost the RLS net", async () => {
    // The mistake this guards is a plausible one, not a hypothetical:
    // brokered WRITES legitimately run as `system`, so that shape is
    // always nearby. `withPortalRead` stamps the handle it hands out and
    // `authorizePortal` refuses any other.
    await expect(
      withTenant(T, { type: "system" }, (tx) =>
        authorizePortal(tx, principal(ids.primary), "portal.work_item.view"),
      ),
    ).rejects.toBeInstanceOf(AuthzError);
  });

  it("reads under the contact principal, not merely inside the right tenant", async () => {
    // The control for the above: the INTERNAL task IS in this tenant and
    // IS in this client, so a read that merely scoped the tenant would
    // return it. Only the contact principal's `portal_gate` does not.
    const list = await listPortalTasks(principal(ids.primary));
    expect(titles(list)).not.toContain(S.internalTask);
    const db = getPlatformClient();
    expect(
      await db.workItem.count({ where: { tenantId: T, clientId: acme, title: S.internalTask } }),
    ).toBe(1);
  });
});
