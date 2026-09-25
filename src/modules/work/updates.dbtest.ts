import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { dateColumn } from "@/lib/duration";
import { setupTenant } from "@/members/dbtest-fixture";
import { resolvePortalModuleGates, type PortalPrincipal } from "@/portal";
import { completeMilestone, createMilestone } from "@/projects/milestones";
import { createVersion, shipVersion } from "@/projects/versions";

import { changeItemVisibility, createItem } from "./items";
import { listPortalUpdates } from "./portal";
import { createPortalRequest } from "./portal-writes";
import { changeState } from "./states";
import { foreignPortalSnapshotKeys, type PortalSnapshot } from "./update-snapshot";
import {
  annotateUpdate,
  archiveUpdate,
  createUpdateDraft,
  discardUpdateDraft,
  getUpdate,
  listUpdates,
  publishUpdate,
  readComposerContext,
  retractUpdate,
  setUpdateVisibility,
  updateUpdateDraft,
} from "./updates";

/**
 * PROGRESS UPDATES AGAINST THE REAL SCHEMA (Phase 3, DATA_MODEL §6.16):
 * the publish path end to end, the immutability trigger, the retraction
 * window, the four-term portal gate under a real contact principal, and
 * the sentinel walk over the frozen portal snapshot.
 *
 * THE CENTRAL ASSERTION IS THE SENTINEL WALK, as in `portal.dbtest.ts`:
 * every fact the client must never read is planted as a string that
 * appears nowhere else — the INTERNAL task's title, the INTERNAL
 * milestone's name, the member's display name (which the internal
 * snapshot carries by design) — and the published row's
 * `portal_snapshot`, the projection's whole output and the JSON the
 * contact can reach are searched for them. That is stronger than a
 * field list: a leak through a key this test never heard of still
 * fails.
 *
 * Tenant slug prefix `pupd-` is registered in `DBTEST_PREFIXES`
 * (e2e/fixtures/seed-cli.ts) so `sweep-dbtests` collects orphans.
 */

const run = randomUUID().slice(0, 8);

let f: Awaited<ReturnType<typeof setupTenant>>;
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;
let acme: string;
let beta: string;
let pOn: string;
let pOff: string;
let pBeta: string;
let carol: string;
let bo: string;
let dan: string;
let ownerName: string;

const S = {
  internalTask: `SENTINELINTERNALTASK-${run}`,
  internalMilestone: `SENTINELINTERNALPHASE-${run}`,
  sharedMilestone: `Design review ${run}`,
  sharedTask: `Shared done task ${run}`,
  version: `1.${run.slice(0, 3)}`,
} as const;

const ctxOf = (seat: "owner" | "admin" | "manager" | "employee") => ({
  tenantId: f.tenantId,
  actor: f.seats[seat].actor,
});

const principal = (contactId: string, over: Partial<PortalPrincipal> = {}): PortalPrincipal => ({
  contactId,
  tenantId: f.tenantId,
  clientId: acme,
  gates,
  ...over,
});

const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const body = (sections: Record<string, string>) => ({
  sections: Object.entries(sections).map(([key, text]) => ({ key, body: doc(text) })),
});

const domainCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
};
const authzReason = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    if (e instanceof AuthzError) return e.reason;
    throw e;
  }
};

const rowOf = (id: string) =>
  f.platform.projectUpdate.findFirstOrThrow({
    where: { tenantId: f.tenantId, id },
    include: { internalSnapshot: true },
  });

const auditActions = async (targetId: string): Promise<string[]> =>
  (
    await f.platform.auditEvent.findMany({
      where: { tenantId: f.tenantId, targetType: "ProjectUpdate", targetId },
      select: { action: true },
      orderBy: { createdAt: "asc" },
    })
  ).map((r) => r.action);

const draftOn = async (projectId: string, sections: Record<string, string>, seat: "owner" | "employee" = "owner") =>
  (
    await createUpdateDraft(ctxOf(seat), projectId, {
      health: "ON_TRACK",
      title: `Update ${run}`,
      periodStart: null,
      periodEnd: null,
      body: body(sections),
    })
  ).id;

beforeAll(async () => {
  f = await setupTenant("pupd");
  gates = await resolvePortalModuleGates(f.tenantId);
  acme = randomUUID();
  beta = randomUUID();
  pOn = randomUUID();
  pOff = randomUUID();
  pBeta = randomUUID();
  carol = randomUUID();
  bo = randomUUID();
  dan = randomUUID();
  const up = run.slice(0, 3).toUpperCase();

  ownerName = (await f.platform.user.findFirstOrThrow({ where: { id: f.seats.owner.userId }, select: { name: true } })).name;

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
        key: `PUP${up}`,
        name: `Site ${run}`,
        portalEnabled: true,
        hoursSharingMode: "BILLABLE_AMOUNT",
        billingCurrency: "SEK",
        createdAt: new Date("2026-08-01T08:00:00Z"),
      },
      { id: pOff, tenantId: f.tenantId, clientId: acme, key: `PUO${up}`, name: `Off ${run}`, portalEnabled: false },
      { id: pBeta, tenantId: f.tenantId, clientId: beta, key: `PUB${up}`, name: `Beta site ${run}`, portalEnabled: true },
    ],
  });
  // The employee seat is SCOPED (AUTHZ.md §4): assigned to the project,
  // so what the permission gates decide below is the permission and
  // not the scope. Owner, admin and manager see the whole tenant.
  await f.platform.memberProject.create({
    data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, projectId: pOn },
  });
  const invitedAt = new Date("2026-09-01T09:00:00Z");
  await f.platform.contact.createMany({
    data: [
      { id: carol, tenantId: f.tenantId, clientId: acme, name: "Carol", email: `pupd-carol-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt, emailVerified: true },
      { id: bo, tenantId: f.tenantId, clientId: beta, name: "Bo", email: `pupd-bo-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt, emailVerified: true },
      // A COLLABORATOR of Acme: reads updates, never hours or money (AUTHZ.md §8).
      { id: dan, tenantId: f.tenantId, clientId: acme, name: "Dan", email: `pupd-dan-${run}@test.invalid`, portalProfile: "CONTACT_COLLABORATOR", portalStatus: "ACTIVE", invitedAt, emailVerified: true },
    ],
  });
  // An ACTIVE money budget, so the frozen hours block carries an amount
  // and a budget — the two figures the gates on both planes must withhold.
  await f.platform.projectBudget.create({
    data: { tenantId: f.tenantId, clientId: acme, projectId: pOn, kind: "MONEY", amount: "50000", currency: "SEK", period: "NONE" },
  });

  // Work the snapshot counts: one shared task DONE, one INTERNAL task
  // DONE (the sentinel), one shared task still planned.
  const shared = (await createItem(ctxOf("owner"), { projectId: pOn, title: S.sharedTask })).id;
  await changeItemVisibility(ctxOf("owner"), shared, "CLIENT_VISIBLE");
  const internal = (await createItem(ctxOf("owner"), { projectId: pOn, title: S.internalTask })).id;
  const planned = (await createItem(ctxOf("owner"), { projectId: pOn, title: `Planned ${run}` })).id;
  await changeItemVisibility(ctxOf("owner"), planned, "CLIENT_VISIBLE");
  const done = await f.platform.workflowState.findFirstOrThrow({
    where: { tenantId: f.tenantId, projectId: pOn, seedKey: "DONE" },
    select: { id: true },
  });
  await changeState(ctxOf("owner"), shared, done.id);
  await changeState(ctxOf("owner"), internal, done.id);

  // Milestones: one shared and reached, one INTERNAL and reached.
  const m1 = (await createMilestone(ctxOf("owner"), { projectId: pOn, name: S.sharedMilestone, visibility: "CLIENT_VISIBLE" })).id;
  await completeMilestone(ctxOf("owner"), m1);
  const m2 = (await createMilestone(ctxOf("owner"), { projectId: pOn, name: S.internalMilestone })).id;
  await completeMilestone(ctxOf("owner"), m2);

  // One shipped version, one open request from the contact.
  const v = (await createVersion(ctxOf("owner"), { projectId: pOn, version: S.version })).id;
  await shipVersion(ctxOf("owner"), v);
  await createPortalRequest(principal(carol), { projectId: pOn, title: `Request ${run}`, body: null });

  // One closed hour of the owner's, planted as the row the summary
  // reads (no service — the notice gate is another suite's business).
  const stoppedAt = new Date();
  const startedAt = new Date(stoppedAt.getTime() - 3600 * 1000);
  await f.platform.timeEntry.create({
    data: {
      tenantId: f.tenantId,
      clientId: acme,
      projectId: pOn,
      memberId: f.seats.owner.memberId,
      workItemId: shared,
      startedAt,
      stoppedAt,
      durationSeconds: 3600,
      timezone: "Europe/Stockholm",
      localDate: dateColumn(stoppedAt.toISOString().slice(0, 10)),
      entryMode: "MANUAL",
      source: "MANUAL",
      billable: true,
      billRate: "1000",
      currency: "SEK",
    },
  });
}, 120_000);

afterAll(async () => {
  if (!f) return;
  await f.platform.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.work_maintenance', 'on', true)`;
    await tx.projectUpdate.deleteMany({ where: { tenantId: f.tenantId } });
  });
  await f.platform.timeEntry.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.projectBudget.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${f.tenantId}`;
  await f.platform.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.workItem.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.milestone.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.projectVersion.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.memberProject.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.memberClient.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.contact.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.project.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 60_000);

describe("draft → publish", () => {
  let id: string;

  it("an employee may draft; only C M may publish; a draft says nothing until it does", async () => {
    id = await draftOn(pOn, { SUMMARY: `Going well ${run}`, DONE: `Shipped the thing ${run}` }, "employee");
    const before = await rowOf(id);
    expect(before).toMatchObject({ status: "DRAFT", visibility: "INTERNAL", seq: null, publishedAt: null });
    expect(before.bodyText).toContain(`Going well ${run}`);
    expect(await authzReason(publishUpdate(ctxOf("employee"), id, { visibility: "CLIENT_VISIBLE" }))).toBe("FORBIDDEN");
    expect(await authzReason(publishUpdate(ctxOf("admin"), id, { visibility: "CLIENT_VISIBLE" }))).toBe("FORBIDDEN");
    const empty = await draftOn(pOn, { SUMMARY: "   " });
    expect(await domainCode(publishUpdate(ctxOf("owner"), empty, { visibility: "INTERNAL" }))).toBe("UPDATE_EMPTY");
    await discardUpdateDraft(ctxOf("owner"), empty);
    expect(await auditActions(empty)).toEqual(["project_update.drafted", "project_update.draft_discarded"]);
  });

  it("publishing allocates #1, freezes both snapshots, audits, and the portal one carries no internal fact", async () => {
    const published = await publishUpdate(ctxOf("owner"), id, { visibility: "CLIENT_VISIBLE" });
    expect(published).toMatchObject({ id, seq: 1, visibility: "CLIENT_VISIBLE", portalEnabled: true });
    const row = await rowOf(id);
    expect(row).toMatchObject({ status: "PUBLISHED", visibility: "CLIENT_VISIBLE", seq: 1 });
    expect(row.publishedAt).not.toBeNull();
    expect(row.publishedByMemberId).toBe(f.seats.owner.memberId);
    expect(await auditActions(id)).toEqual(["project_update.drafted", "project_update.published"]);

    const portal = row.portalSnapshot as unknown as PortalSnapshot;
    expect(portal.tasks).toEqual({ done: 1, total: 2, doneInPeriod: 1 });
    expect(portal.milestones).toEqual({ done: 1, total: 1, hitInPeriod: [S.sharedMilestone] });
    expect(portal.versions?.shippedInPeriod).toEqual([{ version: S.version, title: null }]);
    expect(portal.requests).toEqual({ open: 1, acceptedInPeriod: 0 });
    expect(portal.hours).toMatchObject({ mode: "BILLABLE_AMOUNT", currency: "SEK", budgetSeconds: null, budgetAmount: "50000.00" });
    expect(portal.hours?.inPeriod).toEqual({ seconds: 3600, billableSeconds: 3600, amount: "1000.00" });
    expect(portal.hours?.toDate).toEqual({ seconds: 3600, billableSeconds: 3600, amount: "1000.00" });
    expect(foreignPortalSnapshotKeys(portal)).toEqual([]);
    const serialised = JSON.stringify(portal);
    for (const sentinel of [S.internalTask, S.internalMilestone, ownerName, f.seats.owner.memberId]) {
      expect(serialised, sentinel).not.toContain(sentinel);
    }

    // The class-A twin holds what the portal one may not.
    expect(row.internalSnapshot).not.toBeNull();
    const byMember = row.internalSnapshot!.byMember as { memberId: string; name: string; seconds: number }[];
    expect(byMember).toEqual([{ memberId: f.seats.owner.memberId, name: ownerName, seconds: 3600, billableSeconds: 3600 }]);
    expect(row.internalSnapshot!.budget).toMatchObject({
      kind: "MONEY",
      amount: "50000",
      currency: "SEK",
      periodKey: "ALL",
      usedSeconds: 3600,
      usedAmount: "1000.00",
      usedPercent: 2,
    });
  });

  it("the member read gates the twin's parts on the codes that gate their live sources", async () => {
    const owner = await getUpdate(ctxOf("owner"), id);
    expect(owner.internal?.byMember?.[0]?.name).toBe(ownerName);
    expect(owner.metrics?.tasks).toEqual({ done: 1, total: 2, doneInPeriod: 1 });
    expect(owner.caps).toEqual({ create: true, publish: true, changeVisibility: true });
    expect(owner.retractUntil).not.toBeNull();
    // An employee reads the post and its portal-safe numbers, never the team's hours.
    const employee = await getUpdate(ctxOf("employee"), id);
    expect(employee.internal?.byMember).toBeNull();
    expect(employee.metrics?.tasks).toEqual({ done: 1, total: 2, doneInPeriod: 1 });
    // THE HOURS BLOCK FOLLOWS THE READER'S CODES ON BOTH READS (security
    // review): the owner reads the amount and the budget off the frozen
    // row, the employee reads no hours at all — the Time tab, the budget
    // card and the Money page would refuse them the same figures live.
    expect(owner.metrics?.hours).toMatchObject({ mode: "BILLABLE_AMOUNT", budgetAmount: "50000.00" });
    expect(owner.metrics?.hours?.toDate.amount).toBe("1000.00");
    expect(owner.internal?.budget).toMatchObject({ kind: "MONEY", usedAmount: "1000.00" });
    expect(employee.metrics?.hours).toBeUndefined();
    expect(employee.internal?.budget).toBeNull();
    const ownerContext = await readComposerContext(ctxOf("owner"), pOn, { periodStart: null, periodEnd: null });
    expect(ownerContext.metrics.hours?.toDate.amount).toBe("1000.00");
    const employeeContext = await readComposerContext(ctxOf("employee"), pOn, { periodStart: null, periodEnd: null });
    expect(employeeContext.metrics.hours).toBeUndefined();
    expect(JSON.stringify(employeeContext)).not.toContain("50000");
    expect(employee.caps).toEqual({ create: true, publish: false, changeVisibility: false });
  });

  it("a published post is immutable at the database, archive-only, and edits map to UPDATE_NOT_DRAFT", async () => {
    await expect(
      f.platform.projectUpdate.update({ where: { id }, data: { title: "changed" } }),
    ).rejects.toThrow(/UPDATE_IMMUTABLE/);
    await expect(
      f.platform.projectUpdate.update({ where: { id }, data: { health: "OFF_TRACK" } }),
    ).rejects.toThrow(/UPDATE_IMMUTABLE/);
    await expect(f.platform.projectUpdate.delete({ where: { id } })).rejects.toThrow(/UPDATE_IMMUTABLE/);
    expect(
      await domainCode(
        updateUpdateDraft(ctxOf("owner"), id, {
          health: "OFF_TRACK",
          title: "x",
          periodStart: null,
          periodEnd: null,
          body: body({ SUMMARY: "y" }),
        }),
      ),
    ).toBe("UPDATE_NOT_DRAFT");
    expect(await domainCode(discardUpdateDraft(ctxOf("owner"), id))).toBe("UPDATE_NOT_DRAFT");
  });

  it("the second post is #2 and its window starts at the first one's publishing", async () => {
    const second = await draftOn(pOn, { NEXT: `Launch ${run}` });
    const context = await readComposerContext(ctxOf("owner"), pOn, { periodStart: null, periodEnd: null, excludeId: second });
    const first = await rowOf(id);
    expect(context.changes.window.from).toBe(first.publishedAt!.toISOString());
    expect(context.previousHealth).toBe("ON_TRACK");
    // Everything counted in #1 happened before it was published.
    expect(context.changes.doneItems).toEqual([]);
    expect(context.metrics.tasks).toEqual({ done: 1, total: 2, doneInPeriod: 0 });
    const published = await publishUpdate(ctxOf("owner"), second, { visibility: "INTERNAL" });
    expect(published.seq).toBe(2);
    const list = await listUpdates(ctxOf("employee"), pOn);
    expect(list.updates.map((u) => u.seq)).toEqual([2, 1]);
    expect(list.latest?.seq).toBe(2);
  });
});

describe("what the contact reads", () => {
  it("only PUBLISHED + CLIENT_VISIBLE posts of a portal-enabled project of its own client, and no sentinel", async () => {
    const draft = await draftOn(pOn, { SUMMARY: `Draft ${run}` });
    const offDraft = await draftOn(pOff, { SUMMARY: `Off ${run}` });
    await publishUpdate(ctxOf("owner"), offDraft, { visibility: "CLIENT_VISIBLE" });

    const seen = await listPortalUpdates(principal(carol));
    expect(seen.map((u) => u.seq)).toEqual([1]);
    expect(seen[0]).toMatchObject({ projectId: pOn, health: "ON_TRACK" });
    // The PRIMARY contact holds `portal.hours.view`: the frozen hours,
    // amount and budget are theirs to read.
    expect((seen[0]!.metrics as { hours?: { toDate: { amount: string | null } } }).hours?.toDate.amount).toBe("1000.00");
    // A COLLABORATOR does not (AUTHZ.md §8, "no money, no hours"): the
    // same post, minus the block, and neither figure anywhere in it.
    const collaborator = await listPortalUpdates(principal(dan));
    expect(collaborator.map((u) => u.seq)).toEqual([1]);
    expect(collaborator[0]!.metrics).not.toHaveProperty("hours");
    // The two decimals cannot occur inside a uuid or the run's hex, so
    // the whole row is searched; the bare seconds could (the "600 inside
    // a random id" flake, `cab5f02`), so only the numbers block is.
    for (const figure of ["1000.00", "50000.00"]) {
      expect(JSON.stringify(collaborator), figure).not.toContain(figure);
    }
    expect(JSON.stringify(collaborator[0]!.metrics)).not.toContain("3600");
    const serialised = JSON.stringify(seen);
    for (const sentinel of [S.internalTask, S.internalMilestone, ownerName, f.seats.owner.memberId, `Draft ${run}`, `Off ${run}`, `Launch ${run}`]) {
      expect(serialised, sentinel).not.toContain(sentinel);
    }
    expect(Object.keys(seen[0]!).sort()).toEqual(
      ["body", "editNote", "health", "id", "metrics", "periodEnd", "periodStart", "projectId", "projectKey", "projectName", "publishedAt", "seq", "title"].sort(),
    );
    expect(foreignPortalSnapshotKeys(seen[0]!.metrics)).toEqual([]);
    // Narrowed to one project, and latest-only, agree with the full read.
    expect((await listPortalUpdates(principal(carol), { projectId: pOn, latestOnly: true })).map((u) => u.seq)).toEqual([1]);
    // Naming a switched-off project is a refusal, not an empty list: the
    // ref check proves the project is reachable, and the page turns the
    // NOT_FOUND into the plane's one empty surface (`portalReadOrNull`).
    expect(await authzReason(listPortalUpdates(principal(carol), { projectId: pOff }))).toBe("NOT_FOUND");
    // Another client's contact sees nothing of Acme.
    expect(await listPortalUpdates(principal(bo, { clientId: beta }))).toEqual([]);
    await discardUpdateDraft(ctxOf("owner"), draft);
  });

  it("the class-A twin is unreachable under the contact principal, whatever is asked for", async () => {
    await withTenant(f.tenantId, { type: "contact", id: carol, clientId: acme }, async (tx) => {
      expect(await tx.projectUpdateInternalSnapshot.count()).toBe(0);
      expect(await tx.projectUpdate.count()).toBe(1);
      expect(await tx.projectUpdate.count({ where: { status: "DRAFT" } })).toBe(0);
    });
  });

  it("hiding, showing, annotating and archiving change what the contact reads, each audited", async () => {
    const list = await listUpdates(ctxOf("owner"), pOn);
    const first = list.updates.find((u) => u.seq === 1)!;
    expect(await authzReason(setUpdateVisibility(ctxOf("employee"), first.id, "INTERNAL"))).toBe("FORBIDDEN");
    await setUpdateVisibility(ctxOf("admin"), first.id, "INTERNAL");
    expect(await listPortalUpdates(principal(carol))).toEqual([]);
    await setUpdateVisibility(ctxOf("admin"), first.id, "CLIENT_VISIBLE");
    expect((await listPortalUpdates(principal(carol))).map((u) => u.seq)).toEqual([1]);

    await annotateUpdate(ctxOf("owner"), first.id, `  Correction ${run}  `);
    expect((await listPortalUpdates(principal(carol)))[0]?.editNote).toBe(`Correction ${run}`);
    expect(await authzReason(annotateUpdate(ctxOf("employee"), first.id, "no"))).toBe("FORBIDDEN");

    await archiveUpdate(ctxOf("owner"), first.id);
    expect(await rowOf(first.id)).toMatchObject({ status: "ARCHIVED", visibility: "INTERNAL", seq: 1 });
    expect(await listPortalUpdates(principal(carol))).toEqual([]);
    expect(await domainCode(setUpdateVisibility(ctxOf("owner"), first.id, "CLIENT_VISIBLE"))).toBe("UPDATE_NOT_PUBLISHED");
    expect(await auditActions(first.id)).toEqual([
      "project_update.drafted",
      "project_update.published",
      "project_update.visibility_changed",
      "project_update.visibility_changed",
      "project_update.annotated",
      "project_update.archived",
    ]);
    // Archived stays: no delete, and no way back to PUBLISHED.
    await expect(f.platform.projectUpdate.delete({ where: { id: first.id } })).rejects.toThrow(/UPDATE_IMMUTABLE/);
    await expect(
      f.platform.projectUpdate.update({ where: { id: first.id }, data: { status: "PUBLISHED", visibility: "CLIENT_VISIBLE" } }),
    ).rejects.toThrow(/UPDATE_IMMUTABLE/);
  });
});

describe("the fifteen-minute retraction", () => {
  it("within the window: back to DRAFT, the number and both snapshots gone, and a republish takes a fresh number", async () => {
    const id = await draftOn(pOn, { SUMMARY: `Retract me ${run}` });
    await publishUpdate(ctxOf("owner"), id, { visibility: "CLIENT_VISIBLE" });
    expect((await listPortalUpdates(principal(carol))).map((u) => u.id)).toEqual([id]);
    expect(await authzReason(retractUpdate(ctxOf("admin"), id))).toBe("FORBIDDEN");
    await retractUpdate(ctxOf("owner"), id);
    const row = await rowOf(id);
    expect(row).toMatchObject({ status: "DRAFT", visibility: "INTERNAL", seq: null, publishedAt: null, publishedByMemberId: null });
    expect(row.portalSnapshot).toBeNull();
    expect(row.changesSinceLast).toBeNull();
    expect(row.internalSnapshot).toBeNull();
    expect(await listPortalUpdates(principal(carol))).toEqual([]);
    expect(await auditActions(id)).toEqual(["project_update.drafted", "project_update.published", "project_update.retracted"]);
    const again = await publishUpdate(ctxOf("owner"), id, { visibility: "INTERNAL" });
    expect(again.seq).toBeGreaterThan(3);
    expect(await domainCode(retractUpdate(ctxOf("owner"), id))).toBe("resolved");
  });

  it("past the window: the service refuses, and so does the trigger", async () => {
    const id = randomUUID();
    const publishedAt = new Date(Date.now() - 16 * 60 * 1000);
    await f.platform.projectUpdate.create({
      data: {
        id,
        tenantId: f.tenantId,
        clientId: acme,
        projectId: pOn,
        seq: 900,
        health: "ON_HOLD",
        body: { sections: [] },
        bodyText: "old",
        portalSnapshot: { version: 1 },
        status: "PUBLISHED",
        visibility: "INTERNAL",
        authorMemberId: f.seats.owner.memberId,
        publishedAt,
        publishedByMemberId: f.seats.owner.memberId,
      },
    });
    expect(await domainCode(retractUpdate(ctxOf("owner"), id))).toBe("UPDATE_RETRACT_WINDOW_CLOSED");
    await expect(
      f.platform.$executeRaw`
        UPDATE project_update
           SET status = 'DRAFT', visibility = 'INTERNAL', seq = NULL, published_at = NULL,
               published_by_member_id = NULL, portal_snapshot = NULL, changes_since_last = NULL
         WHERE id = ${id}`,
    ).rejects.toThrow(/UPDATE_IMMUTABLE/);
    // ...and a retraction that keeps its number is refused even inside the window.
    const fresh = await draftOn(pOn, { SUMMARY: `Keep number ${run}` });
    await publishUpdate(ctxOf("owner"), fresh, { visibility: "INTERNAL" });
    await expect(
      f.platform.$executeRaw`
        UPDATE project_update SET status = 'DRAFT', published_at = NULL, published_by_member_id = NULL,
               portal_snapshot = NULL, changes_since_last = NULL
         WHERE id = ${fresh}`,
    ).rejects.toThrow(/UPDATE_IMMUTABLE|project_update_draft_unnumbered/);
  });
});
