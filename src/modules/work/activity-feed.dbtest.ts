import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MemberActor } from "@/authz/authorize";
import { todayIn } from "@/lib/due-date";
import { localDateString } from "@/lib/duration";
import { addDays } from "@/lib/week";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { completeMilestone, createMilestone } from "@/projects/milestones";
import { createVersion, shipVersion } from "@/projects/versions";

import { readActivityFeed, type ActivityFeedRead } from "./activity-feed";
import { createItem, deleteItem } from "./items";
import { changeState } from "./states";
import { createUpdateDraft, publishUpdate } from "./updates";

/**
 * THE ACTIVITY PAGE'S READ (slice 133, founder decision C110) against the real
 * schema and the real `app_runtime` role: every kind of event appears, named;
 * a task made straight into Done is "added", never "finished"; a report and
 * an export are never "a file added"; a client's person is named only within
 * the event's client; a member reaching one project sees NONE of another's
 * events of any kind, and one without `document:view` / `project_update:view`
 * sees no file or update events; a task in the bin takes its events with it;
 * the filters are found in scope or are none; and the window — a week ahead
 * shows nothing and names the day of the newest event as the earlier day.
 *
 * Tenant slugs come from `setupTenant("af")`; the prefix `af-` is registered
 * in `DBTEST_PREFIXES` (e2e/fixtures/seed-cli.ts).
 */

const run = randomUUID().slice(0, 8);
const LONG = 240_000;
const ZONE = "Europe/Stockholm";

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let beta: string;
/** The busy project's client — apart, so its 311 events crowd no other test's page. */
let gamma: string;
let pA: string;
let pB: string;
/** One task and 310 more `created` rows of it, today: a page and a bit. */
let pC: string;
/** An import's batch of births into Done, 40 days ahead — the probe's case. */
let pD: string;
/** The import batch's day, in the zone the test reads in — taken from the instant itself, never from a clock (DST). */
let aheadDay: string;
let keyA: string;
let keyB: string;
let keyC: string;
let keyD: string;
/** Acme's person. */
let carol: string;
/** Beta's person. */
let bert: string;
/** Every view code, reaching pA only. */
let onlyA: { memberId: string; actor: MemberActor };
/** Tasks and projects only — no `document:view`, no `project_update:view` — on Acme. */
let noFiles: { memberId: string; actor: MemberActor };
const extraUserIds: string[] = [];

const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const ctxOf = (actor: MemberActor) => ({ tenantId: f.tenantId, actor });
const today = () => todayIn(ZONE);
const read = async (actor: MemberActor, params: { project?: string; client?: string; until?: string; skip?: number } = {}, onDay = today()) => {
  const r = await readActivityFeed(ctxOf(actor), {
    params: { project: params.project ?? null, client: params.client ?? null, until: params.until ?? null, skip: params.skip ?? 0 },
    timeZone: ZONE,
    today: onDay,
  });
  if (!r) throw new Error("refused");
  return r;
};
const kinds = (r: ActivityFeedRead) => r.events.map((e) => e.kind);
const mentions = (r: ActivityFeedRead, text: string) => r.events.some((e) => JSON.stringify(e).includes(text));

async function seat(label: string, codes: string[], scope: { clientId?: string; projectId?: string }) {
  const userId = randomUUID();
  await f.platform.user.create({ data: { id: userId, name: `${label} ${run}`, email: `af-${label}-${run}@test.invalid` } });
  extraUserIds.push(userId);
  const m = await f.platform.member.create({ data: { tenantId: f.tenantId, userId } });
  const role = await f.platform.role.create({ data: { tenantId: f.tenantId, name: `${label} ${run}` } });
  const perms = await f.platform.permission.findMany({ where: { code: { in: codes } } });
  expect(perms.map((p) => p.code).sort()).toEqual([...codes].sort());
  await f.platform.rolePermission.createMany({ data: perms.map((p) => ({ tenantId: f.tenantId, roleId: role.id, permissionId: p.id })) });
  await f.platform.memberRole.create({ data: { tenantId: f.tenantId, memberId: m.id, roleId: role.id } });
  if (scope.clientId) await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: m.id, clientId: scope.clientId } });
  if (scope.projectId) await f.platform.memberProject.create({ data: { tenantId: f.tenantId, memberId: m.id, projectId: scope.projectId } });
  return { memberId: m.id, actor: actorFor(m.id) };
}

const doneState = async (projectId: string) =>
  (await f.platform.workflowState.findFirstOrThrow({ where: { tenantId: f.tenantId, projectId, category: "DONE" }, select: { id: true } })).id;

/** A `created` history row naming a client's person — as a portal request writes one. */
const createdBy = (workItemId: string, projectId: string, clientId: string, contactId: string) =>
  f.platform.workItemActivity.create({
    data: { tenantId: f.tenantId, workItemId, projectId, clientId, field: "created", actorContactId: contactId },
  });

const contactComment = (subjectType: "WORK_ITEM" | "DOCUMENT", subjectId: string, contactId: string, text: string) =>
  f.platform.comment.create({
    data: { tenantId: f.tenantId, subjectType, subjectId, authorContactId: contactId, body: {}, bodyText: text, visibility: "INTERNAL" },
  });

/** One of every kind of event in `projectId`, its words carrying `tag`. */
async function everyKind(projectId: string, clientId: string, contactId: string, tag: string) {
  const added = await createItem(ownerCtx(), { projectId, title: `Added ${tag}` });
  const finished = await createItem(ownerCtx(), { projectId, title: `Finished ${tag}` });
  // A finish seconds after the task was made, as a person's is: sooner it
  // would read as the task's birth (`BIRTH_WINDOW_MS`, five seconds).
  await new Promise((resolve) => setTimeout(resolve, 5_100));
  await changeState(ownerCtx(), finished.id, await doneState(projectId));
  await contactComment("WORK_ITEM", added.id, contactId, `On a task ${tag}`);
  // A request: a `created` row by a client's person (newer than the task's own).
  const asked = await createItem(ownerCtx(), { projectId, title: `Asked ${tag}` });
  await createdBy(asked.id, projectId, clientId, contactId);
  const brief = await f.platform.document.create({
    data: { tenantId: f.tenantId, clientId, projectId, name: `brief ${tag}.pdf`, createdByMemberId: f.seats.owner.memberId },
    select: { id: true },
  });
  await contactComment("DOCUMENT", brief.id, contactId, `On a file ${tag}`);
  await f.platform.document.create({
    data: {
      tenantId: f.tenantId,
      clientId,
      projectId,
      name: `approved ${tag}.pdf`,
      kind: "DELIVERABLE",
      approvalStatus: "APPROVED",
      approvalRequestedAt: new Date(Date.now() - 60_000),
      approvalDecidedAt: new Date(),
      approvalByContactId: contactId,
      approvalVersionNumber: 1,
    },
  });
  const draft = await createUpdateDraft(ownerCtx(), projectId, {
    health: "ON_TRACK",
    title: `Week ${tag}`,
    periodStart: null,
    periodEnd: null,
    body: { sections: [{ key: "SUMMARY", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `Going well ${tag}` }] }] } }] },
  });
  await publishUpdate(ownerCtx(), draft.id, { visibility: "INTERNAL" });
  const m = await createMilestone(ownerCtx(), { projectId, name: `Design ${tag}` });
  await completeMilestone(ownerCtx(), m.id);
  const v = await createVersion(ownerCtx(), { projectId, version: `1.0-${tag}` });
  await shipVersion(ownerCtx(), v.id);
  await f.platform.projectVersion.update({
    where: { id: v.id },
    data: { approvalStatus: "CHANGES_REQUESTED", approvalRequestedAt: new Date(Date.now() - 60_000), approvalDecidedAt: new Date(), approvalByContactId: contactId },
  });
  return { added, finished };
}

const ALL_KINDS = ["task_added", "task_done", "client_comment", "file_added", "file_decided", "update_published", "milestone_done", "version_shipped", "version_decided"];

beforeAll(async () => {
  f = await setupTenant("af");
  acme = randomUUID();
  beta = randomUUID();
  gamma = randomUUID();
  pA = randomUUID();
  pB = randomUUID();
  const up = run.slice(0, 3).toUpperCase();
  keyA = `FA${up}`;
  keyB = `FB${up}`;
  keyC = `FC${up}`;
  keyD = `FD${up}`;
  pC = randomUUID();
  pD = randomUUID();
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: `Acme ${run}` },
      { id: beta, tenantId: f.tenantId, name: `Beta ${run}` },
      { id: gamma, tenantId: f.tenantId, name: `Gamma ${run}` },
    ],
  });
  await f.platform.project.createMany({
    data: [
      { id: pA, tenantId: f.tenantId, clientId: acme, key: keyA, name: `Acme site ${run}`, portalEnabled: true },
      { id: pB, tenantId: f.tenantId, clientId: beta, key: keyB, name: `Beta site ${run}` },
      { id: pC, tenantId: f.tenantId, clientId: gamma, key: keyC, name: `Gamma busy ${run}` },
      { id: pD, tenantId: f.tenantId, clientId: acme, key: keyD, name: `Acme import ${run}` },
    ],
  });
  carol = randomUUID();
  bert = randomUUID();
  const person = (id: string, clientId: string, name: string) => ({
    id,
    tenantId: f.tenantId,
    clientId,
    name: `${name} ${run}`,
    email: `af-${name.toLowerCase()}-${run}@test.invalid`,
    portalProfile: "CONTACT_PRIMARY" as const,
    portalStatus: "ACTIVE" as const,
    invitedAt: new Date("2026-09-01T09:00:00Z"),
    emailVerified: true,
  });
  await f.platform.contact.createMany({ data: [person(carol, acme, "Carol"), person(bert, beta, "Bert")] });
  onlyA = await seat("onlya", ["work_item:view", "project:view", "document:view", "project_update:view"], { projectId: pA });
  noFiles = await seat("nofiles", ["work_item:view", "project:view"], { clientId: acme });

  // ── what happens today: every kind in each project ──
  await everyKind(pA, acme, carol, `A ${run}`);
  await everyKind(pB, beta, bert, `B ${run}`);
  // Not events: a task in the bin, a deleted file, an export, a report — and
  // a task made straight into Done is "added", not "finished".
  const binned = await createItem(ownerCtx(), { projectId: pA, title: `Binned ${run}` });
  await deleteItem(ownerCtx(), binned.id);
  await createItem(ownerCtx(), { projectId: pA, title: `Born done ${run}`, stateId: await doneState(pA) });
  await f.platform.document.createMany({
    data: [
      { tenantId: f.tenantId, clientId: acme, projectId: pA, name: `gone ${run}.pdf`, deletedAt: new Date() },
      { tenantId: f.tenantId, clientId: acme, projectId: pA, name: `export ${run}.zip`, kind: "EXPORT" },
      // A report is the client's, never a project's (`document_report_company_level`).
      {
        tenantId: f.tenantId,
        clientId: acme,
        projectId: null,
        name: `report ${run}.pdf`,
        kind: "REPORT",
        reportMonth: new Date("2026-09-01T00:00:00Z"),
      },
    ],
  });
  // A Beta person's id on an Acme event — never named as Beta's person there.
  const misattributed = await createItem(ownerCtx(), { projectId: pA, title: `Misattributed ${run}` });
  await createdBy(misattributed.id, pA, acme, bert);

  // A busy day: one task's `created` row and 310 more in one statement.
  const busy = await createItem(ownerCtx(), { projectId: pC, title: `Busy ${run}` });
  await f.platform.workItemActivity.createMany({
    data: Array.from({ length: 310 }, () => ({ tenantId: f.tenantId, workItemId: busy.id, projectId: pC, clientId: gamma, field: "created", actorMemberId: f.seats.owner.memberId })),
  });

  // An import's batch, 40 days ahead: six tasks' `created` rows and then
  // their births into Done in ONE statement — one instant, the Done rows
  // newest by id. The probe must still find that day.
  const ahead = new Date(Date.now() + 40 * 86_400_000);
  aheadDay = localDateString(ahead, ZONE);
  const imported = [];
  for (let k = 0; k < 6; k++) imported.push(await createItem(ownerCtx(), { projectId: pD, title: `Imported ${k} ${run}` }));
  await f.platform.workItemActivity.deleteMany({ where: { tenantId: f.tenantId, projectId: pD } });
  const row = (workItemId: string, done: boolean) => ({
    tenantId: f.tenantId,
    workItemId,
    projectId: pD,
    clientId: acme,
    createdAt: ahead,
    actorMemberId: f.seats.owner.memberId,
    ...(done ? { field: "stateCategory", oldValue: "TODO", newValue: "DONE" } : { field: "created" }),
  });
  await f.platform.workItemActivity.createMany({ data: [...imported.map((t) => row(t.id, false)), ...imported.map((t) => row(t.id, true))] });
}, LONG);

afterAll(async () => {
  if (!f) return;
  // The updates suite's teardown: a published update is deleted only under the maintenance flag.
  await f.platform.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.work_maintenance', 'on', true)`;
    await tx.projectUpdate.deleteMany({ where: { tenantId: f.tenantId } });
  });
  await f.platform.comment.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.document.deleteMany({ where: { tenantId: f.tenantId } });
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
  await f.platform.user.deleteMany({ where: { id: { in: extraUserIds } } });
}, LONG);

describe("readActivityFeed", () => {
  it("shows every kind of event, newest first, named", async () => {
    const r = await read(f.seats.owner.actor, { project: keyA });
    expect(new Set(kinds(r))).toEqual(new Set(ALL_KINDS));
    const times = r.events.map((e) => e.at.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));

    const byText = (text: string) => r.events.filter((e) => JSON.stringify(e).includes(text));
    expect(byText(`On a task A ${run}`)[0]).toMatchObject({
      kind: "client_comment",
      actor: { kind: "contact", name: `Carol ${run}`, clientName: `Acme ${run}` },
      on: { type: "task", task: { title: `Added A ${run}` } },
      place: { projectKey: keyA },
    });
    expect(byText(`On a file A ${run}`)[0]).toMatchObject({ kind: "client_comment", on: { type: "file", name: `brief A ${run}.pdf` } });
    expect(byText(`Asked A ${run}`)[0]).toMatchObject({ kind: "task_added", request: true, actor: { kind: "contact", name: `Carol ${run}` } });
    expect(r.events.find((e) => e.kind === "task_done")).toMatchObject({ actor: { kind: "member", id: f.seats.owner.memberId }, task: { title: `Finished A ${run}` } });
    expect(r.events.find((e) => e.kind === "file_decided")).toMatchObject({ approved: true, file: `approved A ${run}.pdf` });
    expect(r.events.find((e) => e.kind === "update_published")).toMatchObject({ seq: 1, shared: false, title: `Week A ${run}` });
    expect(r.events.find((e) => e.kind === "milestone_done")).toMatchObject({ actor: { kind: "system" }, milestone: `Design A ${run}` });
    expect(r.events.find((e) => e.kind === "version_decided")).toMatchObject({ approved: false, actor: { kind: "contact", name: `Carol ${run}` } });
    expect(r.applied).toEqual({ project: keyA, client: null, until: null, skip: 0 });
  }, LONG);

  it("never shows a task in the bin, a deleted file, an export or a report — and a task born in Done is added, not finished", async () => {
    const r = await read(f.seats.owner.actor, { client: acme });
    expect(mentions(r, `Binned ${run}`)).toBe(false);
    expect(mentions(r, `gone ${run}`)).toBe(false);
    expect(mentions(r, `export ${run}`)).toBe(false);
    expect(mentions(r, `report ${run}`)).toBe(false);
    const born = r.events.filter((e) => JSON.stringify(e).includes(`Born done ${run}`));
    expect(born.map((e) => e.kind)).toEqual(["task_added"]);
  }, LONG);

  it("names a client's person only within the event's own client", async () => {
    const r = await read(f.seats.owner.actor, { client: acme });
    const e = r.events.find((x) => JSON.stringify(x).includes(`Misattributed ${run}`));
    expect(e).toMatchObject({ kind: "task_added", actor: { kind: "contact", name: null, clientName: null } });
    expect(JSON.stringify(e)).not.toContain(`Bert ${run}`);
  }, LONG);

  it("a member reaching one project sees NONE of another project's events, of any kind", async () => {
    const r = await read(onlyA.actor);
    expect(new Set(kinds(r))).toEqual(new Set(ALL_KINDS));
    expect(r.events.every((e) => e.place.projectKey === keyA)).toBe(true);
    expect(mentions(r, ` B ${run}`)).toBe(false);
    expect(mentions(r, `Bert ${run}`)).toBe(false);
    expect(r.projects.map((p) => p.key)).toEqual([keyA]);
    // A key out of scope is no filter — never a way to learn of pB.
    const asked = await read(onlyA.actor, { project: keyB });
    expect(asked.applied.project).toBeNull();
    expect(mentions(asked, ` B ${run}`)).toBe(false);
  }, LONG);

  it("without document:view and project_update:view there are no file or update events, nor comments on files", async () => {
    const r = await read(noFiles.actor);
    expect(kinds(r)).not.toContain("file_added");
    expect(kinds(r)).not.toContain("file_decided");
    expect(kinds(r)).not.toContain("update_published");
    expect(mentions(r, `On a file A ${run}`)).toBe(false);
    expect(mentions(r, `On a task A ${run}`)).toBe(true);
  }, LONG);

  it("filters by project and by client, found in scope", async () => {
    const byB = await read(f.seats.owner.actor, { project: keyB });
    expect(byB.applied.project).toBe(keyB);
    expect(byB.events.every((e) => e.place.projectKey === keyB)).toBe(true);
    const byAcme = await read(f.seats.owner.actor, { client: acme });
    expect(byAcme.applied.client).toBe(acme);
    expect(byAcme.events.every((e) => e.place.clientId === acme)).toBe(true);
  }, LONG);

  it("a week with nothing in it names the day of the newest event as the earlier day — and that day's window shows it", async () => {
    const newest = (await read(f.seats.owner.actor, { client: acme })).events[0]!;
    const itsDay = localDateString(newest.at, ZONE);
    const later = addDays(itsDay, 10);
    const empty = await read(f.seats.owner.actor, { client: acme }, later);
    expect(empty.events).toHaveLength(0);
    expect(empty.earlier).toEqual({ until: itsDay, skip: 0 });
    const back = await read(f.seats.owner.actor, { client: acme, until: itsDay }, later);
    expect(back.window.to).toBe(itsDay);
    expect(back.applied.until).toBe(itsDay);
    expect(back.events.some((e) => e.id === newest.id)).toBe(true);
    // Nothing a year before it, and the workspace is younger than that: the history ends.
    expect(back.earlier).toBeNull();
  }, LONG);

  it("a page cut at the cap goes on inside its day — every event exactly once, in order (the code review's L1)", async () => {
    // The day from the data, never the clock: midnight may pass after `beforeAll`.
    const busyDay = localDateString((await read(f.seats.owner.actor, { project: keyC })).events[0]!.at, ZONE);
    const first = await read(f.seats.owner.actor, { project: keyC }, busyDay);
    expect(first.events).toHaveLength(300);
    expect(first.earlier).toEqual({ until: busyDay, skip: 300 });
    const second = await read(f.seats.owner.actor, { project: keyC, until: busyDay, skip: 300 }, busyDay);
    expect(second.applied).toMatchObject({ until: busyDay, skip: 300 });
    expect(second.events).toHaveLength(11);
    const ids = [...first.events, ...second.events].map((e) => e.id);
    expect(new Set(ids).size).toBe(311);
    expect(first.events.at(-1)!.at.getTime()).toBeGreaterThanOrEqual(second.events[0]!.at.getTime());
    expect(second.earlier).toBeNull();
  }, LONG);

  it("the earlier check finds an import's day though its newest rows are all births into Done (the re-check's MEDIUM)", async () => {
    const r = await read(f.seats.owner.actor, { project: keyD }, addDays(aheadDay, 10));
    expect(r.events).toHaveLength(0);
    expect(r.earlier).toEqual({ until: aheadDay, skip: 0 });
    // And that day's page shows the six as added — none as finished.
    const day = await read(f.seats.owner.actor, { project: keyD, until: aheadDay }, addDays(aheadDay, 10));
    expect(kinds(day).sort()).toEqual(Array.from({ length: 6 }, () => "task_added"));
  }, LONG);

  it("refuses a member who cannot see tasks — null, the page's forbidden state", async () => {
    const none = await seat("none", ["project:view"], { clientId: acme });
    expect(
      await readActivityFeed(ctxOf(none.actor), { params: { project: null, client: null, until: null, skip: 0 }, timeZone: ZONE, today: today() }),
    ).toBeNull();
  }, LONG);
});
