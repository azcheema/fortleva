import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setupTenant } from "@/members/dbtest-fixture";
import { listPortalTasks, listPortalTimeline, listPortalUpdates } from "@/modules/work";
import { createUpdateDraft, publishUpdate } from "@/modules/work/updates";
import { resolvePortalModuleGates, type PortalPrincipal } from "@/portal";

import { completeMilestone, createMilestone } from "./milestones";
import { findPortalProjectByKey } from "./portal";
import { readPortalPreview } from "./portal-preview";
import { getProjectByKey, setPortalSection, type ProjectCtx } from "./service";
import { createVersion, shipVersion } from "./versions";

/**
 * THE PER-SECTION PORTAL SWITCHES AGAINST THE REAL SCHEMA (Phase 3 slice
 * 80, founder decision C47).
 *
 * TWO HALVES. The WRITER — `setPortalSection` — is a mutation like any
 * other: `project:manage_portal` first, then scope, then one audited
 * update in the same transaction, and a no-op that writes nothing. The
 * READERS are the portal's projections, each asked the one question the
 * switches put to it: does a hidden section leave what it draws, and ONLY
 * that — the client's own requests stay under Tasks (C47c), the unfiltered
 * reads the "Waiting on you" card and the all-updates page make still see
 * everything (C47b), and one project's switch never reaches another's.
 *
 * WHAT ONLY A DATABASE CAN SAY: that the request test is a `kind` term
 * Postgres evaluates (the column is never selected on this plane, so no
 * unit test over a mapper could see it), that the switch is read off the
 * PROJECT row under the contact principal, and that the new columns
 * default to true on a row nobody wrote them on.
 *
 * Tenant slug prefix `psect-` is registered in `DBTEST_PREFIXES`
 * (e2e/fixtures/seed-cli.ts) so `sweep-dbtests` collects orphans.
 */

const run = randomUUID().slice(0, 8);
const up = run.slice(0, 3).toUpperCase();

let f: Awaited<ReturnType<typeof setupTenant>>;
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;
let owner: ProjectCtx;
let employee: ProjectCtx;
let acme: string;
let pA: string;
let pB: string;
let carol: string;
const keyA = `PSA${up}`;
const states: Record<string, string> = {};

/** What each row is called, so an assertion reads as the fixture does. */
const T = {
  task: `Shared task ${run}`,
  pending: `Pending request ${run}`,
  accepted: `Accepted request ${run}`,
  declined: `Declined request ${run}`,
  otherProjectTask: `Other project task ${run}`,
  /** INTERNAL: a request nobody shared — on no answer, whatever the switches say. */
  internalRequest: `SENTINELINTERNALREQUEST-${run}`,
} as const;

const principal = (): PortalPrincipal => ({ contactId: carol, tenantId: f.tenantId, clientId: acme, gates });

const notFound = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ reason: "NOT_FOUND" });
const forbidden = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ reason: "FORBIDDEN" });

const titles = (list: Awaited<ReturnType<typeof listPortalTasks>>, projectId: string) =>
  (list.projects.find((p) => p.projectId === projectId)?.tasks ?? []).map((t) => t.title).sort();

const kinds = (entries: Awaited<ReturnType<typeof listPortalTimeline>>["entries"]) =>
  [...new Set(entries.map((e) => (e.kind === "approval_decided" ? `approval_decided:${e.subject}` : e.kind)))].sort();

/** Show every section again — each test starts from the default. */
const showAll = async (projectId: string) => {
  for (const s of ["tasks", "updates", "milestones", "files"] as const) await setPortalSection(owner, projectId, s, true);
};

let nextNumber = 1;
async function item(input: {
  projectId: string;
  title: string;
  category: "TODO" | "IN_PROGRESS" | "CANCELLED" | "TRIAGE";
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
  kind?: "TASK" | "REQUEST";
  triageStatus?: "DECLINED";
  triageReason?: string;
  acceptedAt?: Date;
}): Promise<string> {
  const id = randomUUID();
  await f.platform.workItem.create({
    data: {
      id,
      tenantId: f.tenantId,
      clientId: acme,
      projectId: input.projectId,
      number: nextNumber++,
      title: input.title,
      stateId: states[`${input.projectId}:${input.category}`]!,
      stateCategory: input.category,
      kind: input.kind ?? "TASK",
      triageStatus: input.triageStatus ?? (input.category === "TRIAGE" ? "PENDING" : null),
      triageReason: input.triageReason ?? null,
      acceptedAt: input.acceptedAt ?? null,
      type: "TASK",
      rootId: id,
      rank: `Zz${randomUUID().replace(/-/g, "")}1`,
      visibility: input.visibility,
    },
  });
  return id;
}

beforeAll(async () => {
  f = await setupTenant("psect");
  gates = await resolvePortalModuleGates(f.tenantId);
  owner = { tenantId: f.tenantId, actor: f.seats.owner.actor };
  employee = { tenantId: f.tenantId, actor: f.seats.employee.actor };
  acme = randomUUID();
  pA = randomUUID();
  pB = randomUUID();
  carol = randomUUID();

  await f.platform.client.create({ data: { id: acme, tenantId: f.tenantId, name: `Acme ${run}` } });
  // The four section columns are NOT written here: a row nobody set them
  // on is what the default-true assertion below reads.
  await f.platform.project.createMany({
    data: [
      { id: pA, tenantId: f.tenantId, clientId: acme, key: keyA, name: `Site ${run}`, portalEnabled: true },
      { id: pB, tenantId: f.tenantId, clientId: acme, key: `PSB${up}`, name: `App ${run}`, portalEnabled: true },
    ],
  });
  await f.platform.contact.create({
    data: {
      id: carol,
      tenantId: f.tenantId,
      clientId: acme,
      name: "Carol",
      email: `psect-carol-${run}@test.invalid`,
      portalProfile: "CONTACT_PRIMARY",
      portalStatus: "ACTIVE",
      invitedAt: new Date("2026-09-01T09:00:00Z"),
      emailVerified: true,
    },
  });

  let rank = 0;
  for (const projectId of [pA, pB]) {
    for (const category of ["BACKLOG", "TODO", "IN_PROGRESS", "CANCELLED", "TRIAGE"] as const) {
      const id = randomUUID();
      states[`${projectId}:${category}`] = id;
      await f.platform.workflowState.create({
        data: {
          id,
          tenantId: f.tenantId,
          projectId,
          name: `psect-${category}`,
          category,
          rank: `a${(rank++).toString().padStart(4, "0")}`,
          isDefault: category === "BACKLOG",
        },
      });
    }
  }

  // ── Project A: one shared task, the client's requests in three states,
  // and an INTERNAL request that must never be read. ──────────────────
  await item({ projectId: pA, title: T.task, category: "TODO", visibility: "CLIENT_VISIBLE" });
  await item({ projectId: pA, title: T.pending, category: "TRIAGE", visibility: "CLIENT_VISIBLE", kind: "REQUEST" });
  await item({
    projectId: pA,
    title: T.accepted,
    category: "IN_PROGRESS",
    visibility: "CLIENT_VISIBLE",
    kind: "REQUEST",
    acceptedAt: new Date("2026-09-10T10:00:00Z"),
  });
  await item({
    projectId: pA,
    title: T.declined,
    category: "CANCELLED",
    visibility: "CLIENT_VISIBLE",
    kind: "REQUEST",
    triageStatus: "DECLINED",
    triageReason: `Not this quarter ${run}`,
  });
  await item({ projectId: pA, title: T.internalRequest, category: "TRIAGE", visibility: "INTERNAL", kind: "REQUEST" });
  // ── Project B: one shared task, so the home read has a second project
  // whose switches were never touched. ────────────────────────────────
  await item({ projectId: pB, title: T.otherProjectTask, category: "TODO", visibility: "CLIENT_VISIBLE" });

  // ── Project A's rail: a reached and an open milestone, a shipped
  // version, a published post, and a deliverable the client approved. ──
  const reached = (
    await createMilestone(owner, { projectId: pA, name: `Design ${run}`, visibility: "CLIENT_VISIBLE" })
  ).id;
  await completeMilestone(owner, reached);
  await createMilestone(owner, {
    projectId: pA,
    name: `Launch ${run}`,
    dueAt: new Date("2027-03-10T12:00:00Z"),
    visibility: "CLIENT_VISIBLE",
  });
  const version = (await createVersion(owner, { projectId: pA, version: `1.${up}`, title: `Go live ${run}` })).id;
  await shipVersion(owner, version, { shippedAt: new Date("2026-06-15T10:00:00Z") });
  const draft = await createUpdateDraft(owner, pA, {
    health: "AT_RISK",
    title: `Update ${run}`,
    periodStart: null,
    periodEnd: null,
    body: {
      sections: [
        { key: "SUMMARY", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `Summary ${run}` }] }] } },
      ],
    },
  });
  await publishUpdate(owner, draft.id, { visibility: "CLIENT_VISIBLE" });
  // Planted raw: the timeline's deliverable answer is read off the
  // document row alone, and the file layer is `documents/`'s to exercise.
  await f.platform.document.create({
    data: {
      tenantId: f.tenantId,
      clientId: acme,
      projectId: pA,
      name: `Brand book ${run}`,
      kind: "DELIVERABLE",
      visibility: "CLIENT_VISIBLE",
      approvalStatus: "APPROVED",
      approvalRequestedAt: new Date("2026-09-01T10:00:00Z"),
      approvalDecidedAt: new Date("2026-09-02T10:00:00Z"),
      approvalByContactId: carol,
      approvalVersionNumber: 1,
    },
  });
}, 120_000);

afterAll(async () => {
  if (!f) return;
  await f.platform.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.work_maintenance', 'on', true)`;
    await tx.projectUpdate.deleteMany({ where: { tenantId: f.tenantId } });
  });
  await f.platform.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${f.tenantId}`;
  await f.platform.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.workItem.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.document.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.milestone.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.projectVersion.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.contact.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.project.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 60_000);

describe("the writer", () => {
  it("every section starts shown, on a row nobody set them on", async () => {
    expect((await getProjectByKey(owner, keyA)).portalSections).toEqual({
      tasks: true,
      updates: true,
      milestones: true,
      files: true,
    });
    const found = await findPortalProjectByKey(principal(), keyA);
    // The resolver's whole shape: the switches ride along, nothing else new.
    expect(Object.keys(found ?? {}).sort()).toEqual(["id", "key", "name", "sections"]);
    expect(found?.sections).toEqual({ tasks: true, updates: true, milestones: true, files: true });
  });

  it("is project:manage_portal, audited once per change, and a no-op writes nothing", async () => {
    expect(await setPortalSection(owner, pA, "files", false)).toEqual({ changed: true });
    expect(await setPortalSection(owner, pA, "files", false)).toEqual({ changed: false });
    const rows = await f.audits("project.portal_section_changed");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ targetType: "Project", targetId: pA, metadata: { section: "files", shown: false } });
    expect((await getProjectByKey(owner, keyA)).portalSections.files).toBe(false);
    // The contact reads the same column off the same row.
    expect((await findPortalProjectByKey(principal(), keyA))?.sections.files).toBe(false);
    // …and it is one column: the others are untouched.
    expect((await getProjectByKey(owner, keyA)).portalSections).toMatchObject({ tasks: true, updates: true, milestones: true });

    expect(await setPortalSection(owner, pA, "files", true)).toEqual({ changed: true });
    expect((await f.audits("project.portal_section_changed")).map((e) => e.metadata)).toContainEqual({
      section: "files",
      shown: true,
    });
  });

  it("refuses a member without the permission before it looks at scope, and a project it cannot see", async () => {
    // FORBIDDEN, not NOT_FOUND — the recipe runs `requireAccess` before
    // `assertInScope`, so an employee learns nothing about which projects
    // exist (the portal switch's own test says the same).
    await forbidden(setPortalSection(employee, pA, "tasks", false));
    await forbidden(setPortalSection(employee, randomUUID(), "tasks", false));
    await notFound(setPortalSection(owner, randomUUID(), "tasks", false));
    expect((await getProjectByKey(owner, keyA)).portalSections.tasks).toBe(true);
    expect(await f.audits("project.portal_section_changed")).toHaveLength(2);
  });
});

describe("the portal's reads", () => {
  it("Tasks hidden: the section keeps the client's own requests, in every state, and nothing else", async () => {
    await setPortalSection(owner, pA, "tasks", false);
    try {
      const shown = await listPortalTasks(principal(), { projectId: pA, followSectionSwitches: true });
      // The accepted request is IN PROGRESS now and still listed (C47c):
      // "request" is what it began as, not where it is.
      expect(titles(shown, pA)).toEqual([T.accepted, T.declined, T.pending].sort());
      // The unfiltered read — "Waiting on you" — still has the task (C47b).
      const whole = await listPortalTasks(principal(), { projectId: pA });
      expect(titles(whole, pA)).toEqual([T.accepted, T.declined, T.pending, T.task].sort());
      // The home's read spans projects: B's switch was never touched.
      const home = await listPortalTasks(principal(), { followSectionSwitches: true });
      expect(titles(home, pA)).toEqual([T.accepted, T.declined, T.pending].sort());
      expect(titles(home, pB)).toEqual([T.otherProjectTask]);
      // An INTERNAL request is on no answer, followed or not.
      for (const list of [shown, whole, home]) expect(JSON.stringify(list)).not.toContain(T.internalRequest);
    } finally {
      await showAll(pA);
    }
    // Shown again, the followed read is the whole list.
    const again = await listPortalTasks(principal(), { projectId: pA, followSectionSwitches: true });
    expect(titles(again, pA)).toEqual([T.accepted, T.declined, T.pending, T.task].sort());
  });

  it("Updates hidden: the cards' read leaves the post out; the all-updates page's does not", async () => {
    expect(await listPortalUpdates(principal(), { projectId: pA, latestOnly: true, followSectionSwitches: true })).toHaveLength(1);
    await setPortalSection(owner, pA, "updates", false);
    try {
      expect(await listPortalUpdates(principal(), { projectId: pA, latestOnly: true, followSectionSwitches: true })).toEqual([]);
      expect(await listPortalUpdates(principal(), { latestOnly: true, followSectionSwitches: true })).toEqual([]);
      expect(await listPortalUpdates(principal(), { projectId: pA })).toHaveLength(1);
      expect(kinds((await listPortalTimeline(principal(), { projectId: pA })).entries)).not.toContain("update");
    } finally {
      await showAll(pA);
    }
  });

  it("the rail drops exactly the hidden sections' entries, and a shipped version has no switch", async () => {
    const all = ["approval_decided:deliverable", "milestone_done", "milestone_due", "update", "version_shipped"];
    expect(kinds((await listPortalTimeline(principal(), { projectId: pA })).entries)).toEqual(all);
    try {
      await setPortalSection(owner, pA, "milestones", false);
      expect(kinds((await listPortalTimeline(principal(), { projectId: pA })).entries)).toEqual(
        all.filter((k) => !k.startsWith("milestone_")),
      );
      await setPortalSection(owner, pA, "files", false);
      await setPortalSection(owner, pA, "updates", false);
      // Everything hidden that can be: the version is what is left.
      expect(kinds((await listPortalTimeline(principal(), { projectId: pA })).entries)).toEqual(["version_shipped"]);
    } finally {
      await showAll(pA);
    }
    expect(kinds((await listPortalTimeline(principal(), { projectId: pA })).entries)).toEqual(all);
  });
});

describe("the Portal tab's preview", () => {
  it("draws the home's card as the switches leave it, and says why when they leave nothing", async () => {
    // Project B: one shared task, no post. Hiding Tasks leaves the card
    // with nothing to draw — shared, but hidden, which is not "nothing
    // shared" and must not send the member off to share something.
    expect((await readPortalPreview(owner, pB)).blockers).toEqual([]);
    await setPortalSection(owner, pB, "tasks", false);
    try {
      const hidden = await readPortalPreview(owner, pB);
      expect(hidden.blockers).toEqual(["SECTIONS_HIDDEN"]);
      expect(hidden.tasks).toBeNull();
      // Project A with Tasks hidden: the card is its requests and its post.
      await setPortalSection(owner, pA, "tasks", false);
      const a = await readPortalPreview(owner, pA);
      expect(a.blockers).toEqual([]);
      expect((a.tasks?.tasks ?? []).map((t) => t.title).sort()).toEqual([T.accepted, T.declined, T.pending].sort());
      expect(a.update).not.toBeNull();
      await setPortalSection(owner, pA, "updates", false);
      expect((await readPortalPreview(owner, pA)).update).toBeNull();
    } finally {
      await showAll(pA);
      await showAll(pB);
    }
  });
});
