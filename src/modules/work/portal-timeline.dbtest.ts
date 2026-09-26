import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { setupTenant } from "@/members/dbtest-fixture";
import { resolvePortalModuleGates, type PortalPrincipal } from "@/portal";
import { cancelMilestone, completeMilestone, createMilestone, setMilestoneStatus } from "@/projects/milestones";
import { readPortalProjectSummary } from "@/projects/portal";
import { createVersion, shipVersion } from "@/projects/versions";

import { changeItemVisibility, createItem } from "./items";
import { listPortalTasks, listPortalTimeline, type PortalTimelineEntry } from "./portal";
import { archiveUpdate, createUpdateDraft, publishUpdate } from "./updates";

/**
 * THE CLIENT TIMELINE AGAINST THE REAL SCHEMA (Phase 3, DATA_MODEL
 * §6.16): a union over three class-B tables, read under a real contact
 * principal, and the header summary the one-screen project page draws
 * above it.
 *
 * THE CENTRAL ASSERTION IS THE SENTINEL WALK, as in `portal.dbtest.ts`:
 * every fact a client must never read is planted as a string that
 * appears nowhere else — the INTERNAL milestone that was reached, the
 * shared milestone the agency CANCELLED, the version still in draft, the
 * update published INTERNAL, the draft update, the archived update, and
 * the shared rows of a switched-off project, an archived project and
 * another client's project — and the serialised output of both
 * projections is searched for each. A leak through a branch this test
 * never heard of still fails.
 *
 * WHAT ONLY A DATABASE CAN SAY: that another client's contact is refused
 * the project outright (`portal_gate` on `project`), that a switched-off
 * project is unreachable rather than filtered, and that the archive
 * term — which the policy does not carry — empties an archived project's
 * rail.
 *
 * Tenant slug prefix `ptl-` is registered in `DBTEST_PREFIXES`
 * (e2e/fixtures/seed-cli.ts) so `sweep-dbtests` collects orphans.
 */

const run = randomUUID().slice(0, 8);

let f: Awaited<ReturnType<typeof setupTenant>>;
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;
let acme: string;
let beta: string;
let pOn: string;
let pOff: string;
let pArchived: string;
let pBeta: string;
let carol: string;
let dan: string;
let bo: string;
let sue: string;
let sharedUpdateId: string;
let phaseId: string;
let upcomingId: string;

/** Strings a contact IS meant to read. */
const SHOWN = {
  reached: `Design review ${run}`,
  phase: `Build ${run}`,
  upcoming: `Launch ${run}`,
  /** Shared, planned, undated: counts in the header's total, never on the rail. */
  undated: `Handover ${run}`,
  version: `1.${run.slice(0, 3)}`,
  versionTitle: `Go live ${run}`,
  notes: `Forms and search are next ${run}`,
  update: `Shared update ${run}`,
} as const;

/** Strings that exist nowhere but on rows a contact must never reach. */
const S = {
  internalReached: `SENTINELINTERNALPHASE-${run}`,
  cancelledShared: `SENTINELCANCELLED-${run}`,
  draftVersion: `SENTINELDRAFTVERSION-${run}`,
  internalUpdate: `SENTINELINTERNALUPDATE-${run}`,
  draftUpdate: `SENTINELDRAFTUPDATE-${run}`,
  archivedUpdate: `SENTINELARCHIVEDUPDATE-${run}`,
  offMilestone: `SENTINELOFF-${run}`,
  archivedProjectMilestone: `SENTINELARCHIVEDPROJECT-${run}`,
  archivedProjectVersion: `SENTINELARCHIVEDVERSION-${run}`,
  betaMilestone: `SENTINELBETA-${run}`,
} as const;

/** Fixed instants, so the rail's order is a fact and not a race. Midday, so a zone cannot move its day. */
const UPCOMING_DUE = new Date("2027-03-10T12:00:00Z");
const SHIPPED_AT = new Date("2026-06-15T10:00:00Z");
const REACHED_DUE = new Date("2026-05-01T00:00:00Z");

const ctxOf = (seat: "owner" | "employee") => ({ tenantId: f.tenantId, actor: f.seats[seat].actor });

const principal = (contactId: string, clientId = acme): PortalPrincipal => ({
  contactId,
  tenantId: f.tenantId,
  clientId,
  gates,
});

const authzReason = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    if (e instanceof AuthzError) return e.reason;
    throw e;
  }
};

const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const draftOn = async (projectId: string, title: string) =>
  (
    await createUpdateDraft(ctxOf("owner"), projectId, {
      health: "ON_TRACK",
      title,
      periodStart: null,
      periodEnd: null,
      body: { sections: [{ key: "SUMMARY", body: doc(`${title} body`) }] },
    })
  ).id;

/** Every string in `S`, checked against a serialised projection. */
const expectNoSentinel = (value: unknown) => {
  const json = JSON.stringify(value);
  for (const [name, sentinel] of Object.entries(S)) {
    expect(json, `sentinel ${name} leaked`).not.toContain(sentinel);
  }
};

beforeAll(async () => {
  f = await setupTenant("ptl");
  gates = await resolvePortalModuleGates(f.tenantId);
  acme = randomUUID();
  beta = randomUUID();
  pOn = randomUUID();
  pOff = randomUUID();
  pArchived = randomUUID();
  pBeta = randomUUID();
  carol = randomUUID();
  dan = randomUUID();
  bo = randomUUID();
  sue = randomUUID();
  const up = run.slice(0, 3).toUpperCase();

  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: `Acme ${run}` },
      { id: beta, tenantId: f.tenantId, name: `Beta ${run}` },
    ],
  });
  await f.platform.project.createMany({
    data: [
      { id: pOn, tenantId: f.tenantId, clientId: acme, key: `PTL${up}`, name: `Site ${run}`, portalEnabled: true },
      { id: pOff, tenantId: f.tenantId, clientId: acme, key: `PTO${up}`, name: `Off ${run}`, portalEnabled: false },
      // Portal ON and ARCHIVED: `portal_gate` has no archive term, so the
      // project itself is reachable; the projections' own `where` is
      // what keeps its rows off the rail.
      {
        id: pArchived,
        tenantId: f.tenantId,
        clientId: acme,
        key: `PTA${up}`,
        name: `Archived ${run}`,
        portalEnabled: true,
        status: "ARCHIVED",
        archivedAt: new Date("2026-01-01T00:00:00Z"),
      },
      { id: pBeta, tenantId: f.tenantId, clientId: beta, key: `PTB${up}`, name: `Beta site ${run}`, portalEnabled: true },
    ],
  });
  const invitedAt = new Date("2026-09-01T09:00:00Z");
  await f.platform.contact.createMany({
    data: [
      { id: carol, tenantId: f.tenantId, clientId: acme, name: "Carol", email: `ptl-carol-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt, emailVerified: true },
      { id: dan, tenantId: f.tenantId, clientId: acme, name: "Dan", email: `ptl-dan-${run}@test.invalid`, portalProfile: "CONTACT_COLLABORATOR", portalStatus: "ACTIVE", invitedAt, emailVerified: true },
      { id: bo, tenantId: f.tenantId, clientId: beta, name: "Bo", email: `ptl-bo-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt, emailVerified: true },
      { id: sue, tenantId: f.tenantId, clientId: acme, name: "Sue", email: `ptl-sue-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "SUSPENDED", invitedAt, emailVerified: true },
    ],
  });

  // ── The plan, through the real services ────────────────────────────
  const owner = ctxOf("owner");
  const reached = (await createMilestone(owner, { projectId: pOn, name: SHOWN.reached, dueAt: REACHED_DUE, visibility: "CLIENT_VISIBLE" })).id;
  await completeMilestone(owner, reached);
  phaseId = (await createMilestone(owner, { projectId: pOn, name: SHOWN.phase, visibility: "CLIENT_VISIBLE" })).id;
  await setMilestoneStatus(owner, phaseId, "IN_PROGRESS");
  upcomingId = (await createMilestone(owner, { projectId: pOn, name: SHOWN.upcoming, dueAt: UPCOMING_DUE, visibility: "CLIENT_VISIBLE" })).id;
  await createMilestone(owner, { projectId: pOn, name: SHOWN.undated, visibility: "CLIENT_VISIBLE" });
  // Sentinels on the reachable project: an INTERNAL milestone that was
  // reached, and a shared one the agency dropped.
  const internal = (await createMilestone(owner, { projectId: pOn, name: S.internalReached })).id;
  await completeMilestone(owner, internal);
  const cancelled = (await createMilestone(owner, { projectId: pOn, name: S.cancelledShared, dueAt: UPCOMING_DUE, visibility: "CLIENT_VISIBLE" })).id;
  await cancelMilestone(owner, cancelled);

  const shipped = (await createVersion(owner, { projectId: pOn, version: SHOWN.version, title: SHOWN.versionTitle, releaseNotes: SHOWN.notes })).id;
  await shipVersion(owner, shipped, { shippedAt: SHIPPED_AT });
  await createVersion(owner, { projectId: pOn, version: `2.${run.slice(0, 3)}`, title: S.draftVersion });

  sharedUpdateId = await draftOn(pOn, SHOWN.update);
  await publishUpdate(owner, sharedUpdateId, { visibility: "CLIENT_VISIBLE" });
  const internalUpdate = await draftOn(pOn, S.internalUpdate);
  await publishUpdate(owner, internalUpdate, { visibility: "INTERNAL" });
  await draftOn(pOn, S.draftUpdate);
  const archived = await draftOn(pOn, S.archivedUpdate);
  await publishUpdate(owner, archived, { visibility: "CLIENT_VISIBLE" });
  await archiveUpdate(owner, archived);

  // ── Shared rows the gate must keep out of reach ────────────────────
  // Planted directly: `createMilestone` refuses an archived project, and
  // these rows exist only to be NOT read. `rank` is the plan's own
  // ordering key and is never projected.
  await f.platform.milestone.createMany({
    data: [
      { tenantId: f.tenantId, clientId: acme, projectId: pOff, name: S.offMilestone, status: "DONE", completedAt: SHIPPED_AT, rank: "a", visibility: "CLIENT_VISIBLE" },
      { tenantId: f.tenantId, clientId: acme, projectId: pArchived, name: S.archivedProjectMilestone, status: "DONE", completedAt: SHIPPED_AT, rank: "a", visibility: "CLIENT_VISIBLE" },
      { tenantId: f.tenantId, clientId: beta, projectId: pBeta, name: S.betaMilestone, status: "DONE", completedAt: SHIPPED_AT, rank: "a", visibility: "CLIENT_VISIBLE" },
    ],
  });
  await f.platform.projectVersion.create({
    data: { tenantId: f.tenantId, clientId: acme, projectId: pArchived, version: "9.0", title: S.archivedProjectVersion, status: "SHIPPED", shippedAt: SHIPPED_AT },
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
  await f.platform.milestone.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.projectVersion.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.contact.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.project.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 60_000);

describe("the client timeline", () => {
  it("is every kind of shared event, newest first, with the plan's future above the past", async () => {
    const { entries, truncated } = await listPortalTimeline(principal(carol), { projectId: pOn });
    expect(truncated).toBe(false);
    // Four rows and no more: the reached milestone, the phase-less rail
    // (the IN_PROGRESS phase has no date and the undated one no date
    // either, so neither is an event), the upcoming due, the shipped
    // version and the one shared post.
    expect(entries.map((e) => e.kind).sort()).toEqual(
      ["milestone_done", "milestone_due", "update", "version_shipped"].sort(),
    );
    // Newest first, never increasing.
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i - 1]!.at.getTime()).toBeGreaterThanOrEqual(entries[i]!.at.getTime());
    }
    // The future due sits at the top; the oldest instant — the ship — at the foot.
    expect(entries[0]).toMatchObject({ kind: "milestone_due", id: upcomingId, name: SHOWN.upcoming, at: UPCOMING_DUE });
    expect(entries.at(-1)).toMatchObject({
      kind: "version_shipped",
      version: SHOWN.version,
      title: SHOWN.versionTitle,
      releaseNotes: SHOWN.notes,
      at: SHIPPED_AT,
    });
    const update = entries.find((e) => e.kind === "update");
    expect(update).toMatchObject({ id: sharedUpdateId, seq: 1, health: "ON_TRACK", title: SHOWN.update });
    expect(entries.find((e) => e.kind === "milestone_done")).toMatchObject({ name: SHOWN.reached });
  });

  it("carries no internal fact — the sentinel walk over the whole output", async () => {
    const out = await listPortalTimeline(principal(carol), { projectId: pOn });
    expectNoSentinel(out);
    const json = JSON.stringify(out);
    for (const shown of [SHOWN.reached, SHOWN.upcoming, SHOWN.version, SHOWN.notes, SHOWN.update]) {
      expect(json).toContain(shown);
    }
    // The undated shared milestone is real but is not an EVENT.
    expect(json).not.toContain(SHOWN.undated);
    // …and neither is the phase, which has no date; the header names it.
    expect(json).not.toContain(SHOWN.phase);
  });

  it("each kind carries exactly its keys — the contract a page renders", async () => {
    const { entries } = await listPortalTimeline(principal(carol), { projectId: pOn });
    const keysOf = (kind: PortalTimelineEntry["kind"]) =>
      Object.keys(entries.find((e) => e.kind === kind)!).sort();
    expect(keysOf("update")).toEqual(["at", "health", "id", "kind", "seq", "title"]);
    expect(keysOf("milestone_done")).toEqual(["at", "id", "kind", "name"]);
    expect(keysOf("milestone_due")).toEqual(["at", "id", "kind", "name"]);
    expect(keysOf("version_shipped")).toEqual(["at", "id", "kind", "releaseNotes", "title", "version"]);
  });

  it("a collaborator reads the same rail as the primary contact", async () => {
    const primary = await listPortalTimeline(principal(carol), { projectId: pOn });
    const collaborator = await listPortalTimeline(principal(dan), { projectId: pOn });
    expect(collaborator).toEqual(primary);
  });

  it("refuses another client's project, a switched-off project, and a suspended contact", async () => {
    // Bo belongs to Beta: Acme's project does not exist for him.
    expect(await authzReason(listPortalTimeline(principal(bo, beta), { projectId: pOn }))).toBe("NOT_FOUND");
    // Carol cannot reach Beta's project, nor Acme's switched-off one.
    expect(await authzReason(listPortalTimeline(principal(carol), { projectId: pBeta }))).toBe("NOT_FOUND");
    expect(await authzReason(listPortalTimeline(principal(carol), { projectId: pOff }))).toBe("NOT_FOUND");
    // Sue's access is paused: refused before any row is read.
    expect(await authzReason(listPortalTimeline(principal(sue), { projectId: pOn }))).toBe("FORBIDDEN");
  });

  it("an archived project's rail is empty — the projection's own term, since the policy has none", async () => {
    const out = await listPortalTimeline(principal(carol), { projectId: pArchived });
    expect(out).toEqual({ entries: [], truncated: false });
  });
});

describe("the project header's summary", () => {
  it("names the phase, the next milestone, and counts done over everything not cancelled", async () => {
    const summary = await readPortalProjectSummary(principal(carol), pOn);
    expect(summary.phase).toEqual({ id: phaseId, name: SHOWN.phase, dueAt: null });
    expect(summary.nextMilestone).toEqual({ id: upcomingId, name: SHOWN.upcoming, dueAt: UPCOMING_DUE });
    // "Next" is decided by CALENDAR DAY in the reader's zone, not by the
    // instant: later on its own day the milestone is still next; from
    // the day after, nothing is, while the phase and the count stand.
    const sameDay = await readPortalProjectSummary(principal(carol), pOn, {
      now: new Date("2027-03-10T20:00:00Z"),
      timeZone: "UTC",
    });
    expect(sameDay.nextMilestone).toEqual(summary.nextMilestone);
    const later = await readPortalProjectSummary(principal(carol), pOn, {
      now: new Date("2027-03-11T00:00:01Z"),
      timeZone: "UTC",
    });
    expect(later.nextMilestone).toBeNull();
    expect(later.phase).toEqual(summary.phase);
    expect(later.milestones).toEqual(summary.milestones);
    // reached + phase + upcoming + undated; the cancelled one and the
    // INTERNAL one are not the client's to count.
    expect(summary.milestones).toEqual({ done: 1, total: 4 });
    expectNoSentinel(summary);
    expect(Object.keys(summary).sort()).toEqual(["milestones", "nextMilestone", "phase"]);
  });

  it("is refused exactly where the timeline is, and is empty on an archived project", async () => {
    expect(await authzReason(readPortalProjectSummary(principal(bo, beta), pOn))).toBe("NOT_FOUND");
    expect(await authzReason(readPortalProjectSummary(principal(carol), pOff))).toBe("NOT_FOUND");
    expect(await authzReason(readPortalProjectSummary(principal(sue), pOn))).toBe("FORBIDDEN");
    expect(await readPortalProjectSummary(principal(carol), pArchived)).toEqual({
      phase: null,
      nextMilestone: null,
      milestones: { done: 0, total: 0 },
    });
  });
});

describe("the task list's project group", () => {
  it("carries the project's key, so the card can link to its page", async () => {
    // One shared task, so the group exists to be asserted on — the first
    // cut of this test asserted an EMPTY list and so pinned nothing (a
    // review caught it). `portal.dbtest.ts` pins the same key list over
    // its own fixture; this is the shape where the key is used.
    const shared = (await createItem(ctxOf("owner"), { projectId: pOn, title: `Shared task ${run}` })).id;
    await changeItemVisibility(ctxOf("owner"), shared, "CLIENT_VISIBLE");
    const list = await listPortalTasks(principal(carol), { projectId: pOn });
    expect(list.projects).toHaveLength(1);
    const group = list.projects[0]!;
    expect(Object.keys(group).sort()).toEqual(["projectId", "projectKey", "projectName", "tasks"]);
    expect(group).toMatchObject({ projectId: pOn, projectKey: `PTL${run.slice(0, 3).toUpperCase()}` });
    expect(group.tasks.map((t) => t.id)).toEqual([shared]);
  });
});
