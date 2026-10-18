import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MemberActor } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { dateColumn } from "@/lib/duration";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { recomputeTouched } from "@/modules/time/summary";
import { listInbox } from "@/notify/inbox";

import { assignItem, createItem, deleteItem, followMovedKey, getItemDetail, moveItemToProject, readMoveFacts, setItemMilestone } from "./index";
import { createRequest } from "./requests";

/**
 * MOVE A TASK TO ANOTHER PROJECT OF ITS CLIENT (slice 131, founder decision
 * C108) against the real schema, its triggers and the real `app_runtime`
 * role: what moves (the tree, deleted rows too; comments, files, history,
 * hours), what each task becomes there (number, stage, milestone, labels,
 * person, portal stamp), the old keys and who may follow them, the record,
 * the inbox; every refusal; and the database's own rules — a project change
 * only under the move's flag and only within the client, never a client
 * change, a re-parent with children only to the top under the flag.
 *
 * Tenant slugs come from `setupTenant("mv")`; the prefix `mv-` is registered
 * in `DBTEST_PREFIXES` (e2e/fixtures/seed-cli.ts).
 */

const run = randomUUID().slice(0, 8);
const LONG = 240_000;

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let beta: string;
/** The source — its portal ON. */
let pA: string;
/** The target — its portal OFF. */
let pB: string;
/** Acme's, archived. */
let pArchived: string;
/** Beta's: another client. */
let pX: string;
let keyA: string;
let keyB: string;
let cardA: string;
let cardB: string;
let labelWorkspace: string;
let labelOfA: string;
let milestoneA: string;
/** A person at Acme — a request's sender. */
let carol: string;
/** view + create + edit + project:view on Acme — but NOT change_visibility. */
let editor: { memberId: string; actor: MemberActor };
/** view + project:view, reaching pA ONLY — a person who cannot work in pB. */
let pOnly: { memberId: string; actor: MemberActor };
const extraUserIds: string[] = [];

const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const ctxOf = (actor: MemberActor) => ({ tenantId: f.tenantId, actor });

async function seat(label: string, codes: string[], scope: { clientId?: string; projectId?: string }) {
  const userId = randomUUID();
  const email = `mv-${label}-${run}@test.invalid`;
  await f.platform.user.create({ data: { id: userId, name: `${label} ${run}`, email } });
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

const task = async (projectId: string, title: string, parentId?: string) =>
  createItem(ownerCtx(), { projectId, title: `${title} ${run}`, ...(parentId ? { parentId } : {}) });

async function hour(projectId: string, workItemId: string) {
  const startedAt = new Date("2026-09-10T08:00:00Z");
  const e = await f.platform.timeEntry.create({
    data: {
      tenantId: f.tenantId,
      clientId: acme,
      projectId,
      workItemId,
      description: `Work ${run}`,
      memberId: f.seats.owner.memberId,
      startedAt,
      stoppedAt: new Date(startedAt.getTime() + 3600 * 1000),
      durationSeconds: 3600,
      timezone: "Europe/Stockholm",
      localDate: dateColumn("2026-09-10"),
      entryMode: "MANUAL",
      source: "MANUAL",
      billable: true,
      billRate: "1000",
      currency: "SEK",
      rateSource: "PROJECT",
      billRateCardId: cardA,
    },
    select: { id: true },
  });
  return e.id;
}

// The task this file moves, and what hangs on it.
const T: {
  id: string;
  number: number;
  s1: string;
  s1n: number;
  s2: string;
  s2n: number;
  comment: string;
  doc: string;
  /** A file on the subtask that is in the bin — soft-deleted with it, still anchored to it. */
  binnedDoc: string;
  entry: string;
} = {
  id: "",
  number: 0,
  s1: "",
  s1n: 0,
  s2: "",
  s2n: 0,
  comment: "",
  doc: "",
  binnedDoc: "",
  entry: "",
};

beforeAll(async () => {
  f = await setupTenant("mv");
  acme = randomUUID();
  beta = randomUUID();
  pA = randomUUID();
  pB = randomUUID();
  pArchived = randomUUID();
  pX = randomUUID();
  const up = run.slice(0, 3).toUpperCase();
  keyA = `MA${up}`;
  keyB = `MB${up}`;
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: `Acme ${run}` },
      { id: beta, tenantId: f.tenantId, name: `Beta ${run}` },
    ],
  });
  await f.platform.project.createMany({
    data: [
      { id: pA, tenantId: f.tenantId, clientId: acme, key: keyA, name: `Acme site ${run}`, portalEnabled: true },
      { id: pB, tenantId: f.tenantId, clientId: acme, key: keyB, name: `Acme SEO ${run}` },
      { id: pArchived, tenantId: f.tenantId, clientId: acme, key: `MC${up}`, name: `Acme old ${run}`, status: "ARCHIVED", archivedAt: new Date() },
      { id: pX, tenantId: f.tenantId, clientId: beta, key: `MX${up}`, name: `Beta site ${run}` },
    ],
  });
  carol = randomUUID();
  await f.platform.contact.create({
    data: {
      id: carol,
      tenantId: f.tenantId,
      clientId: acme,
      name: `Carol ${run}`,
      email: `mv-carol-${run}@test.invalid`,
      portalProfile: "CONTACT_PRIMARY",
      portalStatus: "ACTIVE",
      invitedAt: new Date("2026-09-01T09:00:00Z"),
      emailVerified: true,
    },
  });
  editor = await seat("editor", ["work_item:view", "work_item:create", "work_item:edit", "project:view"], { clientId: acme });
  pOnly = await seat("ponly", ["work_item:view", "project:view"], { projectId: pA });

  cardA = (
    await f.platform.rateCard.create({
      data: { tenantId: f.tenantId, kind: "BILL", scope: "PROJECT", projectId: pA, amount: "1000", currency: "SEK", effectiveFrom: dateColumn("2026-01-01") },
      select: { id: true },
    })
  ).id;
  cardB = (
    await f.platform.rateCard.create({
      data: { tenantId: f.tenantId, kind: "BILL", scope: "PROJECT", projectId: pB, amount: "1200", currency: "SEK", effectiveFrom: dateColumn("2026-01-01") },
      select: { id: true },
    })
  ).id;
  labelWorkspace = (await f.platform.label.create({ data: { tenantId: f.tenantId, projectId: null, name: `Urgent ${run}` }, select: { id: true } })).id;
  labelOfA = (await f.platform.label.create({ data: { tenantId: f.tenantId, projectId: pA, name: `Homepage ${run}` }, select: { id: true } })).id;
  milestoneA = (
    await f.platform.milestone.create({
      data: { tenantId: f.tenantId, clientId: acme, projectId: pA, name: `Launch ${run}`, rank: "a" },
      select: { id: true },
    })
  ).id;

  // The task: two subtasks (one in the bin), given to a person who cannot
  // reach pB, on a milestone, with both kinds of label, a comment, a file and
  // an hour — and SHARED with the client (it and its first subtask).
  const t = await task(pA, "Rebuild the menu");
  const s1 = await task(pA, "Menu markup", t.id);
  const s2 = await task(pA, "Menu styles", t.id);
  Object.assign(T, { id: t.id, number: t.number, s1: s1.id, s1n: s1.number, s2: s2.id, s2n: s2.number });
  // The binned subtask had a file: `deleteItem` soft-deletes it and keeps it
  // anchored (both reviews' HIGH/MEDIUM — such a tree could not move).
  T.binnedDoc = (
    await f.platform.document.create({
      data: { tenantId: f.tenantId, clientId: acme, projectId: pA, name: `styles.css`, attachedToType: "WORK_ITEM", attachedToId: s2.id },
      select: { id: true },
    })
  ).id;
  await deleteItem(ownerCtx(), s2.id);
  await assignItem(ownerCtx(), t.id, pOnly.memberId);
  // Through the service, so its history row names the milestone (pinned below:
  // after the move that name is the OLD project's and must read as gone).
  await setItemMilestone(ownerCtx(), t.id, milestoneA);
  await f.platform.workItem.update({ where: { id: t.id }, data: { visibility: "CLIENT_VISIBLE" } });
  await f.platform.workItem.update({ where: { id: s1.id }, data: { visibility: "CLIENT_VISIBLE" } });
  await f.platform.workItemLabel.createMany({
    data: [
      { tenantId: f.tenantId, workItemId: t.id, labelId: labelWorkspace },
      { tenantId: f.tenantId, workItemId: t.id, labelId: labelOfA },
    ],
  });
  T.comment = (
    await f.platform.comment.create({
      data: {
        tenantId: f.tenantId,
        clientId: acme,
        projectId: pA,
        subjectType: "WORK_ITEM",
        subjectId: t.id,
        authorMemberId: f.seats.owner.memberId,
        body: { type: "doc", content: [] },
        bodyText: `Note ${run}`,
      },
      select: { id: true },
    })
  ).id;
  T.doc = (
    await f.platform.document.create({
      data: { tenantId: f.tenantId, clientId: acme, projectId: pA, name: `menu.pdf`, attachedToType: "WORK_ITEM", attachedToId: t.id },
      select: { id: true },
    })
  ).id;
  T.entry = await hour(pA, t.id);
  // pA's summary as an entry's own write leaves it — so the move must take the hour OUT of it.
  await withTenant(f.tenantId, { type: "member", id: f.seats.owner.memberId }, (tx) =>
    recomputeTouched(tx, f.tenantId, [{ projectId: pA, localDate: dateColumn("2026-09-10") }]),
  );
  // A notice the EDITOR got about the task while it was in pA.
  await f.platform.notification.create({
    data: {
      tenantId: f.tenantId,
      receiverType: "MEMBER",
      receiverId: editor.memberId,
      kind: "work_item.assigned",
      class: "INSTANT",
      entityType: "WorkItem",
      entityId: t.id,
      clientId: acme,
      projectId: pA,
    },
  });
}, LONG);

afterAll(async () => {
  if (!f?.tenantId) return;
  const db = f.platform;
  const tenantId = f.tenantId;
  await db.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${tenantId}`;
  await db.notification.deleteMany({ where: { tenantId } });
  await db.emailOutbox.deleteMany({ where: { tenantId } });
  await db.comment.deleteMany({ where: { tenantId } });
  await db.document.deleteMany({ where: { tenantId } });
  await db.timeEntry.deleteMany({ where: { tenantId } });
  await db.projectTimeSummary.deleteMany({ where: { tenantId } });
  await db.rateCard.deleteMany({ where: { tenantId } });
  await db.workItemAlias.deleteMany({ where: { tenantId } });
  await db.workItemActivity.deleteMany({ where: { tenantId } });
  await db.workItemLabel.deleteMany({ where: { tenantId } });
  await db.workItem.deleteMany({ where: { tenantId, depth: 2 } });
  await db.workItem.deleteMany({ where: { tenantId, depth: 1 } });
  await db.workItem.deleteMany({ where: { tenantId } });
  await db.label.deleteMany({ where: { tenantId } });
  await db.milestone.deleteMany({ where: { tenantId } });
  await db.workflowState.deleteMany({ where: { tenantId } });
  await db.tenantCounter.deleteMany({ where: { tenantId } });
  await db.memberProject.deleteMany({ where: { tenantId } });
  await db.memberClient.deleteMany({ where: { tenantId } });
  await db.contact.deleteMany({ where: { tenantId } });
  await db.project.deleteMany({ where: { tenantId } });
  await db.client.deleteMany({ where: { tenantId } });
  await db.tenantPreference.deleteMany({ where: { tenantId } });
  await f.cleanup();
  await f.platform.user.deleteMany({ where: { id: { in: extraUserIds } } });
}, LONG);

describe("moveItemToProject — the dialog's read", () => {
  it("offers the client's other projects only, and says what moves and what is shared", async () => {
    const facts = await readMoveFacts(ownerCtx(), T.id, pB);
    expect(facts.targets.map((p) => p.id)).toEqual([pB]);
    expect(facts).toMatchObject({ subtasks: 1, binned: 1, entries: 1, seconds: 3600, teamHours: true, othersHours: false, shared: true, mayShare: true, inTriage: false, hoursBilled: false, tooBig: false });
    expect(facts.target).toMatchObject({ id: pB, labelsLeftOff: [`Homepage ${run}`], milestone: `Launch ${run}` });
    expect(facts.target!.peopleLeftOff).toEqual([`ponly ${run}`]);
    // The editor may not move shared work.
    expect((await readMoveFacts(ctxOf(editor.actor), T.id, null)).mayShare).toBe(false);
    // Neither project shows its client hours: nothing to say. Once pA does, the dialog says so.
    expect(facts.target!.hoursShared).toBe(false);
    await f.platform.project.update({ where: { id: pA }, data: { hoursSharingMode: "HOURS" } });
    try {
      expect((await readMoveFacts(ownerCtx(), T.id, pB)).target!.hoursShared).toBe(true);
    } finally {
      await f.platform.project.update({ where: { id: pA }, data: { hoursSharingMode: "NONE" } });
    }
    // Before the move the history names the milestone.
    const before = await getItemDetail(ownerCtx(), pA, T.number);
    expect(before.activity.rows.find((r) => r.field === "milestoneId")).toMatchObject({ newRef: milestoneA, newRefName: `Launch ${run}` });
  }, LONG);
});

describe("moveItemToProject — the move", () => {
  it("refuses another client's project, an archived one, and shared work without change_visibility", async () => {
    await expect(moveItemToProject(ownerCtx(), T.id, pX)).rejects.toBeInstanceOf(AuthzError);
    await expect(moveItemToProject(ownerCtx(), T.id, pArchived)).rejects.toBeInstanceOf(AuthzError);
    await expect(moveItemToProject(ctxOf(editor.actor), T.id, pB)).rejects.toBeInstanceOf(AuthzError);
    // Nothing moved.
    expect((await f.platform.workItem.findUniqueOrThrow({ where: { id: T.id } })).projectId).toBe(pA);
  }, LONG);

  it("moves the task and its whole tree, with comments, files, history and hours (C108 (a)–(c))", async () => {
    const summaryBefore = await f.platform.projectTimeSummary.findFirst({
      where: { projectId: pA, periodMonth: dateColumn("2026-09-01") },
      select: { billableSeconds: true },
    });
    expect(summaryBefore?.billableSeconds).toBe(3600);
    const done = await moveItemToProject(ownerCtx(), T.id, pB);
    expect(done).toMatchObject({ projectKey: keyB, fromKey: `${keyA}-${T.number}`, subtasks: 2, entries: 1, labelsLeftOff: 1, assigneesLeftOff: 1 });

    const rows = await f.platform.workItem.findMany({
      where: { id: { in: [T.id, T.s1, T.s2] } },
      select: { id: true, projectId: true, number: true, rank: true, parentId: true, depth: true, rootId: true, milestoneId: true, assigneeMemberId: true, visibility: true, portalEnabled: true, stateId: true },
    });
    const by = new Map(rows.map((r) => [r.id, r]));
    // Every row in pB, numbered there; the tree intact; the deleted subtask too.
    expect(rows.every((r) => r.projectId === pB)).toBe(true);
    expect(by.get(T.id)).toMatchObject({ number: done.number, parentId: null, depth: 0, milestoneId: null, assigneeMemberId: null, visibility: "CLIENT_VISIBLE" });
    expect(by.get(T.s1)).toMatchObject({ parentId: T.id, depth: 1, rootId: T.id, visibility: "CLIENT_VISIBLE" });
    // pB's portal is OFF: the stamp re-derived from the new project.
    expect(by.get(T.id)!.portalEnabled).toBe(false);
    expect(by.get(T.s1)!.portalEnabled).toBe(false);
    // At the bottom of pB, parents first.
    expect(by.get(T.id)!.rank < by.get(T.s1)!.rank && by.get(T.id)!.rank < by.get(T.s2)!.rank).toBe(true);
    // Each stage is one of pB's.
    const pbStages = new Set((await f.platform.workflowState.findMany({ where: { projectId: pB }, select: { id: true } })).map((s) => s.id));
    expect(rows.every((r) => pbStages.has(r.stateId))).toBe(true);

    // The old project's label left off; the workspace's kept.
    expect((await f.platform.workItemLabel.findMany({ where: { workItemId: T.id } })).map((l) => l.labelId)).toEqual([labelWorkspace]);
    // The comment, the file and the history went with it.
    expect((await f.platform.comment.findUniqueOrThrow({ where: { id: T.comment } })).projectId).toBe(pB);
    expect((await f.platform.document.findUniqueOrThrow({ where: { id: T.doc } })).projectId).toBe(pB);
    // The binned subtask's file too — soft-deleted, still anchored, now in pB.
    expect(await f.platform.document.findUniqueOrThrow({ where: { id: T.binnedDoc } })).toMatchObject({ projectId: pB, attachedToId: T.s2 });
    expect(await f.platform.workItemActivity.count({ where: { workItemId: { in: [T.id, T.s1, T.s2] }, projectId: { not: pB } } })).toBe(0);

    // The hour: pB's, re-priced at pB's card; pB's summary counts it, pA's no longer does.
    expect(await f.platform.timeEntry.findUniqueOrThrow({ where: { id: T.entry } })).toMatchObject({
      projectId: pB,
      billRateCardId: cardB,
      rateSource: "PROJECT",
    });
    expect(String((await f.platform.timeEntry.findUniqueOrThrow({ where: { id: T.entry } })).billRate)).toBe("1200");
    const summary = (projectId: string) =>
      f.platform.projectTimeSummary.findFirst({ where: { projectId, periodMonth: dateColumn("2026-09-01") }, select: { billableSeconds: true } });
    expect((await summary(pB))?.billableSeconds).toBe(3600);
    expect((await summary(pA))?.billableSeconds ?? 0).toBe(0);

    // The old keys.
    const aliases = await f.platform.workItemAlias.findMany({ where: { projectId: pA }, orderBy: { number: "asc" } });
    expect(aliases.map((a) => [a.number, a.workItemId])).toEqual(
      [
        [T.number, T.id],
        [T.s1n, T.s1],
        [T.s2n, T.s2],
      ].sort((a, b) => (a[0] as number) - (b[0] as number)),
    );

    // The record: one row per moved task, the counts on the one moved.
    const audits = await f.platform.auditEvent.findMany({ where: { tenantId: f.tenantId, action: "work_item.moved" } });
    expect(audits).toHaveLength(3);
    expect(audits.find((a) => a.targetId === T.id)!.metadata).toMatchObject({
      fromProjectId: pA,
      fromNumber: T.number,
      toProjectId: pB,
      toNumber: done.number,
      subtasks: 2,
      entries: 1,
      seconds: 3600,
      labelsLeftOff: 1,
      assigneesLeftOff: 1,
      milestoneCleared: true,
    });
    expect(audits.find((a) => a.targetId === T.s1)!.metadata).toMatchObject({ with: T.id });
    // The hour's own record: what it was billed against before.
    const hourAudit = await f.platform.auditEvent.findFirst({ where: { tenantId: f.tenantId, targetId: T.entry } });
    expect(hourAudit).toMatchObject({ action: "time_entry.updated" });
    expect(hourAudit!.metadata).toMatchObject({ movedWith: T.id, fromProjectId: pA, projectId: pB, fromBillRateCardId: cardA });
  }, LONG);

  it("names where it came from — to a reader who can see that project", async () => {
    const detail = await getItemDetail(ownerCtx(), pB, (await f.platform.workItem.findUniqueOrThrow({ where: { id: T.id } })).number);
    const moved = detail.activity.rows.find((r) => r.field === "moved");
    expect(moved).toMatchObject({ oldRef: pA, oldValue: String(T.number), oldRefName: `${keyA}-${T.number}` });
    // The old project's milestone is named to no one now (the security review's LOW-2).
    expect(detail.activity.rows.find((r) => r.field === "milestoneId")).toMatchObject({ newRef: milestoneA, newRefName: null });
  }, LONG);

  it("follows an old key — only for a reader who can open the task where it is now", async () => {
    const now = await f.platform.workItem.findUniqueOrThrow({ where: { id: T.id }, select: { number: true } });
    expect(await followMovedKey(ownerCtx(), pA, T.number)).toEqual({ projectKey: keyB, number: now.number });
    // pOnly reaches pA only: the old key names nothing for them.
    expect(await followMovedKey(ctxOf(pOnly.actor), pA, T.number)).toBeNull();
    // A number that never moved is no alias.
    expect(await followMovedKey(ownerCtx(), pA, 999_999)).toBeNull();
  }, LONG);

  it("keeps the notice's title and link in the inbox, at the new key", async () => {
    const now = await f.platform.workItem.findUniqueOrThrow({ where: { id: T.id }, select: { number: true } });
    const page = await listInbox(ctxOf(editor.actor), { filter: "unread" });
    const row = page.rows.find((r) => r.subject?.title === `Rebuild the menu ${run}`);
    expect(row?.subject?.href).toBe(`/projects/${keyB}/backlog?item=${keyB}-${now.number}`);
  }, LONG);

  it("moves a task with a subtask out from under its epic, to the top", async () => {
    const epic = await task(pA, "Redesign");
    await f.platform.workItem.update({ where: { id: epic.id }, data: { type: "EPIC" } });
    const mid = await task(pA, "Header", epic.id);
    const leaf = await task(pA, "Logo", mid.id);
    await moveItemToProject(ownerCtx(), mid.id, pB);
    const rows = await f.platform.workItem.findMany({ where: { id: { in: [epic.id, mid.id, leaf.id] } }, select: { id: true, projectId: true, parentId: true, depth: true, rootId: true } });
    const by = new Map(rows.map((r) => [r.id, r]));
    expect(by.get(epic.id)).toMatchObject({ projectId: pA });
    expect(by.get(mid.id)).toMatchObject({ projectId: pB, parentId: null, depth: 0, rootId: mid.id });
    expect(by.get(leaf.id)).toMatchObject({ projectId: pB, parentId: mid.id, depth: 1, rootId: mid.id });
  }, LONG);

  it("lets a member without change_visibility move work that is not shared", async () => {
    const plain = await task(pA, "Internal chore");
    const done = await moveItemToProject(ctxOf(editor.actor), plain.id, pB);
    expect(done.projectKey).toBe(keyB);
  }, LONG);

  it("refuses a request still in Triage, and a task with an hour billed elsewhere", async () => {
    const asked = await withTenant(f.tenantId, { type: "system" }, (tx) =>
      createRequest(tx, f.tenantId, { projectId: pA, title: `Asked ${run}`, body: null, reportedByContactId: carol }),
    );
    await expect(moveItemToProject(ownerCtx(), asked.id, pB)).rejects.toMatchObject({ code: "MOVE_IN_TRIAGE" });
    const billed = await task(pA, "Billed already");
    // Marked AFTER it is made: a new hour is never born billed (TIME_BILLING_GUARD).
    const entry = await hour(pA, billed.id);
    await withTenant(f.tenantId, { type: "member", id: f.seats.owner.memberId }, (tx) =>
      tx.timeEntry.update({ where: { id: entry }, data: { billedExternallyAt: new Date() }, select: { id: true } }),
    );
    await expect(moveItemToProject(ownerCtx(), billed.id, pB)).rejects.toMatchObject({ code: "MOVE_HOURS_BILLED" });
    expect((await f.platform.workItem.findUniqueOrThrow({ where: { id: billed.id } })).projectId).toBe(pA);
  }, LONG);
});

describe("moveItemToProject — the review round's refusals", () => {
  it("asks time:edit_any to carry a colleague's hours", async () => {
    const withHours = await task(pA, "Someone else's hours");
    await hour(pA, withHours.id); // the owner's hour
    await expect(moveItemToProject(ctxOf(editor.actor), withHours.id, pB)).rejects.toBeInstanceOf(AuthzError);
    expect((await readMoveFacts(ctxOf(editor.actor), withHours.id, null)).mayMoveOthersHours).toBe(false);
  }, LONG);

  it("asks work_item:approve to land a done task in a stage that asks for approval", async () => {
    const finished = await task(pA, "Finished thing");
    const doneA = await f.platform.workflowState.findFirstOrThrow({ where: { projectId: pA, category: "DONE" }, select: { id: true } });
    await f.platform.workflowState.update({ where: { id: doneA.id }, data: { requiresApproval: false } });
    try {
      await f.platform.workItem.update({ where: { id: finished.id }, data: { stateId: doneA.id, completedAt: new Date() } });
      // pB's Done keeps the seeded approval; the editor holds no approve.
      await expect(moveItemToProject(ctxOf(editor.actor), finished.id, pB)).rejects.toBeInstanceOf(AuthzError);
    } finally {
      await f.platform.workflowState.update({ where: { id: doneA.id }, data: { requiresApproval: true } });
    }
  }, LONG);

  it("refuses an imported task whose source row the target already holds", async () => {
    const here = await task(pA, "Imported here");
    const there = await task(pB, "Imported there");
    const sourceKey = { source: "IMPORT" as const, sourceSystem: "csv", sourceId: `row-1-${run}` };
    await f.platform.workItem.update({ where: { id: here.id }, data: { ...sourceKey, importJobId: randomUUID() } });
    await f.platform.workItem.update({ where: { id: there.id }, data: { ...sourceKey, importJobId: randomUUID() } });
    await expect(moveItemToProject(ownerCtx(), here.id, pB)).rejects.toMatchObject({ code: "MOVE_SOURCE_TAKEN" });
  }, LONG);
});

describe("the database's own rules (20261101090000, 20261101100000)", () => {
  const asOwner = <T>(fn: (tx: TenantDb) => Promise<T>) =>
    withTenant(f.tenantId, { type: "member", id: f.seats.owner.memberId }, fn);

  it("refuses a bare project change, a move to another client's project and any client change", async () => {
    const lone = await task(pA, "Lone task");
    await expect(asOwner((tx) => tx.$executeRaw`UPDATE work_item SET project_id = ${pB} WHERE id = ${lone.id}`)).rejects.toThrow(
      /service operation/,
    );
    await expect(
      asOwner(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.work_item_move', 'on', true)`;
        return tx.$executeRaw`UPDATE work_item SET project_id = ${pX} WHERE id = ${lone.id}`;
      }),
    ).rejects.toThrow(/WORK_MOVE_CLIENT/);
    await expect(
      asOwner(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.work_item_move', 'on', true)`;
        return tx.$executeRaw`UPDATE work_item SET client_id = ${beta} WHERE id = ${lone.id}`;
      }),
    ).rejects.toThrow(/WORK_MOVE_CLIENT/);
  }, LONG);

  it("refuses re-parenting a task with children, except to the top under the move's flag", async () => {
    const epic = await task(pA, "Another epic");
    await f.platform.workItem.update({ where: { id: epic.id }, data: { type: "EPIC" } });
    const mid = await task(pA, "With a child", epic.id);
    await task(pA, "The child", mid.id);
    await expect(asOwner((tx) => tx.$executeRaw`UPDATE work_item SET parent_id = NULL WHERE id = ${mid.id}`)).rejects.toThrow(
      /WORK_TREE_REPARENT/,
    );
    const flagged = (sql: (tx: TenantDb) => Promise<number>) =>
      asOwner(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.work_item_move', 'on', true)`;
        return sql(tx);
      });
    // Under the flag, still refused: to the top WITHOUT a project change...
    await expect(flagged((tx) => tx.$executeRaw`UPDATE work_item SET parent_id = NULL WHERE id = ${mid.id}`)).rejects.toThrow(
      /WORK_TREE_REPARENT/,
    );
    // ...and under another parent.
    const otherEpic = await task(pA, "A third epic");
    await f.platform.workItem.update({ where: { id: otherEpic.id }, data: { type: "EPIC" } });
    await expect(flagged((tx) => tx.$executeRaw`UPDATE work_item SET parent_id = ${otherEpic.id} WHERE id = ${mid.id}`)).rejects.toThrow(
      /WORK_TREE_REPARENT/,
    );
  }, LONG);
});
