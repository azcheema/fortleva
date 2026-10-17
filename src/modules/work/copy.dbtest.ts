import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MemberActor } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { withTenant } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { ranksBetween } from "@/lib/rank";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";

import { nameCopyRefs, readItemActivity } from "./activity";
import { getItemDetail } from "./items";
import { COPY_MAX_SUBTASKS, copyItem, readCopySource, type CopyPart } from "./copy";
import { changeItemVisibility, createItem, createLabel, deleteItem, setItemLabel, setItemRepeat } from "./index";
import { createRequest } from "./requests";

/**
 * COPYING A TASK and THE "NEW TASK" FORM (slice 129, founder decision C106)
 * against the real schema, the real `app_runtime` role and the real
 * triggers: what a copy carries for each part ticked, and what it never
 * carries — who can see it above all (always INTERNAL); where it lands; what
 * a copy into ANOTHER project leaves off (a label of the old project, a
 * person who cannot work there) and what it becomes (a subtask → a task);
 * who may copy, and what is refused; the history and the audit both ends
 * leave. And `createItem`'s fields at birth: stored, asked `work_item:edit`,
 * the assignee told.
 *
 * Tenant slugs come from `setupTenant("cpy")`; the prefix `cpy-` is
 * registered in `DBTEST_PREFIXES` (e2e/fixtures/seed-cli.ts).
 */

const run = randomUUID().slice(0, 8);
const LONG = 240_000;

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let beta: string;
/** Acme's project, portal on. */
let pA: string;
let keyA: string;
/** Beta's project. */
let pB: string;
let keyB: string;
/** Acme's ARCHIVED project. */
let pArchived: string;
/** A label of the whole workspace, and one of pA only. */
let wide: string;
let ownA: string;
/** `work_item:view` + `work_item:create` — no `work_item:edit`. */
let createOnly: { memberId: string; actor: MemberActor };
/** view + create + edit, scoped to ACME only — beta's project is out of reach. */
let acmeSeat: { memberId: string; actor: MemberActor };
/** create + edit, NO `work_item:view` — a custom role with view revoked. */
let noView: { memberId: string; actor: MemberActor };
/** Carol — ACTIVE, CONTACT_PRIMARY, of acme: the client who asks. */
let carol: string;
const extraUserIds: string[] = [];

const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const ctxOf = (actor: MemberActor) => ({ tenantId: f.tenantId, actor });
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const ALL: ReadonlySet<CopyPart> = new Set(["description", "subtasks", "labels", "assignee", "dates"]);
const NONE: ReadonlySet<CopyPart> = new Set();

async function task(title: string, opts: { parentId?: string; projectId?: string } = {}) {
  return createItem(ownerCtx(), {
    projectId: opts.projectId ?? pA,
    title: `${title} ${run}`,
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
  });
}

const row = (id: string) => f.platform.workItem.findUniqueOrThrow({ where: { id }, include: { labels: true } });

const checklist = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "The brief" }] },
    {
      type: "taskList",
      content: [
        { type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "Done step" }] }] },
        { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Open step" }] }] },
      ],
    },
  ],
};

/** A task with everything a copy can carry: a ticked checklist, both labels, the employee, dates, a priority, an estimate, two subtasks. */
async function fullTask(title: string) {
  const top = await task(title);
  await f.platform.workItem.update({
    where: { id: top.id },
    data: {
      description: checklist,
      descriptionText: "The brief Done step Open step",
      checklistTotal: 2,
      checklistDone: 1,
      assigneeMemberId: f.seats.employee.memberId,
      startDate: at("2026-11-02"),
      targetDate: at("2026-11-20"),
      priority: "HIGH",
      estimateMinutes: 120,
    },
  });
  await setItemLabel(ownerCtx(), top.id, wide, true);
  await setItemLabel(ownerCtx(), top.id, ownA, true);
  const sub1 = await task(`${title} step one`, { parentId: top.id });
  const sub2 = await task(`${title} step two`, { parentId: top.id });
  await setItemLabel(ownerCtx(), sub1.id, ownA, true);
  await f.platform.workItem.update({ where: { id: sub2.id }, data: { assigneeMemberId: f.seats.employee.memberId } });
  return { top, sub1, sub2 };
}

async function seat(label: string, codes: string[], scope: { clientId?: string } = {}) {
  const userId = randomUUID();
  const email = `cpy-${label}-${run}@test.invalid`;
  await f.platform.user.create({ data: { id: userId, name: email, email } });
  extraUserIds.push(userId);
  const m = await f.platform.member.create({ data: { tenantId: f.tenantId, userId } });
  const role = await f.platform.role.create({ data: { tenantId: f.tenantId, name: `${label} ${run}` } });
  // THE CATALOGUE MUST BE SEEDED — with no `permission` rows the role holds
  // nothing and every refusal would pass for the wrong reason.
  const perms = await f.platform.permission.findMany({ where: { code: { in: codes } } });
  expect(perms.map((p) => p.code).sort()).toEqual([...codes].sort());
  await f.platform.rolePermission.createMany({
    data: perms.map((p) => ({ tenantId: f.tenantId, roleId: role.id, permissionId: p.id })),
  });
  await f.platform.memberRole.create({ data: { tenantId: f.tenantId, memberId: m.id, roleId: role.id } });
  if (scope.clientId) await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: m.id, clientId: scope.clientId } });
  return { memberId: m.id, actor: actorFor(m.id) };
}

beforeAll(async () => {
  f = await setupTenant("cpy");
  acme = randomUUID();
  beta = randomUUID();
  pA = randomUUID();
  pB = randomUUID();
  pArchived = randomUUID();
  const up = run.slice(0, 3).toUpperCase();
  keyA = `CPA${up}`;
  keyB = `CPB${up}`;
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: `Acme ${run}` },
      { id: beta, tenantId: f.tenantId, name: `Beta ${run}` },
    ],
  });
  await f.platform.project.createMany({
    data: [
      { id: pA, tenantId: f.tenantId, clientId: acme, key: keyA, name: `Site ${run}`, portalEnabled: true },
      { id: pB, tenantId: f.tenantId, clientId: beta, key: keyB, name: `Shop ${run}` },
      { id: pArchived, tenantId: f.tenantId, clientId: acme, key: `CPX${up}`, name: `Old ${run}`, status: "ARCHIVED", archivedAt: new Date() },
    ],
  });
  wide = (await createLabel(ownerCtx(), { name: `Wide ${run}` })).label.id;
  ownA = (await f.platform.label.create({ data: { tenantId: f.tenantId, projectId: pA, name: `Own ${run}` }, select: { id: true } })).id;
  createOnly = await seat("createonly", ["work_item:view", "work_item:create"], { clientId: acme });
  acmeSeat = await seat("acme", ["work_item:view", "work_item:create", "work_item:edit"], { clientId: acme });
  noView = await seat("noview", ["work_item:create", "work_item:edit"], { clientId: acme });
  carol = randomUUID();
  await f.platform.contact.create({
    data: {
      id: carol,
      tenantId: f.tenantId,
      clientId: acme,
      name: "Carol",
      email: `cpy-carol-${run}@test.invalid`,
      portalProfile: "CONTACT_PRIMARY",
      portalStatus: "ACTIVE",
      invitedAt: new Date("2026-09-01T09:00:00Z"),
      emailVerified: true,
    },
  });
  // The EMPLOYEE reaches ACME only: a person who can take a copy in pA and
  // not in pB.
  await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId: acme } });
}, LONG);

afterAll(async () => {
  if (!f?.tenantId) return;
  const db = f.platform;
  const tenantId = f.tenantId;
  await db.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${tenantId}`;
  await db.notification.deleteMany({ where: { tenantId } });
  await db.emailOutbox.deleteMany({ where: { tenantId } });
  await db.comment.deleteMany({ where: { tenantId } });
  await db.workItemActivity.deleteMany({ where: { tenantId } });
  await db.workItem.deleteMany({ where: { tenantId, depth: 2 } });
  await db.workItem.deleteMany({ where: { tenantId, depth: 1 } });
  await db.workItem.deleteMany({ where: { tenantId } });
  await db.label.deleteMany({ where: { tenantId } });
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

describe("the New task form's fields at birth (createItem)", () => {
  it("stores the description, person, priority and due date; the person is told; history and audit say what was set", async () => {
    const made = await createItem(ownerCtx(), {
      projectId: pA,
      title: `Born full ${run}`,
      fields: {
        descriptionText: "What to do.\n\n- [ ] first\n- [x] second",
        assigneeMemberId: f.seats.employee.memberId,
        priority: "HIGH",
        targetDate: at("2026-12-01"),
      },
    });
    const r = await row(made.id);
    expect(r).toMatchObject({
      assigneeMemberId: f.seats.employee.memberId,
      priority: "HIGH",
      visibility: "INTERNAL",
      checklistTotal: 2,
      checklistDone: 1,
    });
    expect(r.descriptionText).toContain("What to do.");
    expect(day(r.targetDate)).toBe("2026-12-01");
    const history = await f.platform.workItemActivity.findMany({ where: { tenantId: f.tenantId, workItemId: made.id } });
    expect(history.map((h) => h.field).sort()).toEqual(["assignee", "created"]);
    for (const h of history) expect(h.visibility).toBe("INTERNAL");
    const audit = (await f.audits("work_item.created")).find((a) => a.targetId === made.id);
    expect(audit!.metadata).toMatchObject({ fields: ["description", "assignee", "priority", "targetDate"], visibility: "INTERNAL" });
    const told = await f.platform.notification.findMany({
      where: { tenantId: f.tenantId, receiverId: f.seats.employee.memberId, kind: "work_item.assigned", entityId: made.id },
    });
    expect(told).toHaveLength(1);
  }, LONG);

  it("a NONE priority and an empty description are no fields at all — a title-only create asks no edit right", async () => {
    const made = await createItem(ctxOf(createOnly.actor), {
      projectId: pA,
      title: `Bare ${run}`,
      fields: { priority: "NONE", descriptionText: "  \n " },
    });
    const audit = (await f.audits("work_item.created")).find((a) => a.targetId === made.id);
    expect(audit!.metadata).not.toHaveProperty("fields");
  }, LONG);

  it("setting a field asks work_item:edit; an assignee who is not an ACTIVE member is refused", async () => {
    await expect(
      createItem(ctxOf(createOnly.actor), { projectId: pA, title: `No edit ${run}`, fields: { priority: "LOW" } }),
    ).rejects.toBeInstanceOf(AuthzError);
    // A description is a field too — refused before it is ever parsed.
    await expect(
      createItem(ctxOf(createOnly.actor), { projectId: pA, title: `No edit ${run}`, fields: { descriptionText: "words" } }),
    ).rejects.toBeInstanceOf(AuthzError);
    await expect(
      createItem(ownerCtx(), { projectId: pA, title: `Ghost ${run}`, fields: { assigneeMemberId: randomUUID() } }),
    ).rejects.toBeInstanceOf(AuthzError);
    // Neither wrote a task.
    expect(await f.platform.workItem.count({ where: { tenantId: f.tenantId, title: { in: [`No edit ${run}`, `Ghost ${run}`] } } })).toBe(0);
  }, LONG);
});

describe("copying a task (copyItem)", () => {
  it("everything ticked, same project: the work comes, unticked, PRIVATE, at the bottom, where new tasks start", async () => {
    const { top, sub1, sub2 } = await fullTask("Full");
    // The source is SHARED: the copy must not be.
    await changeItemVisibility(ownerCtx(), top.id, "CLIENT_VISIBLE");
    const done = await copyItem(ownerCtx(), top.id, { projectId: pA, title: `  Full copy ${run}  `.trim(), bring: ALL });
    expect(done).toMatchObject({ projectKey: keyA, subtasks: 2, labelsLeftOff: 0, assigneesLeftOff: 0 });

    const copy = await row(done.id);
    const start = await f.platform.workflowState.findFirstOrThrow({ where: { tenantId: f.tenantId, projectId: pA, isDefault: true } });
    expect(copy).toMatchObject({
      number: done.number,
      title: `Full copy ${run}`,
      visibility: "INTERNAL",
      type: "TASK",
      kind: "TASK",
      parentId: null,
      stateId: start.id,
      priority: "HIGH",
      estimateMinutes: 120,
      assigneeMemberId: f.seats.employee.memberId,
      checklistTotal: 2,
      checklistDone: 0,
      createdByMemberId: f.seats.owner.memberId,
    });
    expect([day(copy.startDate), day(copy.targetDate)]).toEqual(["2026-11-02", "2026-11-20"]);
    expect(copy.labels.map((l) => l.labelId).sort()).toEqual([wide, ownA].sort());
    expect(JSON.stringify(copy.description)).not.toContain('"checked":true');
    // At the bottom of the project.
    const last = await f.platform.workItem.findFirst({ where: { tenantId: f.tenantId, projectId: pA }, orderBy: { rank: "desc" }, select: { id: true, parentId: true } });
    expect([done.id, ...(await f.platform.workItem.findMany({ where: { parentId: done.id }, select: { id: true } })).map((c) => c.id)]).toContain(last!.id);

    // The subtasks, under the copy, each private, each its own.
    const children = await f.platform.workItem.findMany({ where: { tenantId: f.tenantId, parentId: done.id }, include: { labels: true }, orderBy: { rank: "asc" } });
    expect(children.map((c) => c.title)).toEqual([`Full step one ${run}`, `Full step two ${run}`]);
    for (const c of children) expect(c).toMatchObject({ visibility: "INTERNAL", type: "SUBTASK", projectId: pA });
    expect(children[0]!.labels.map((l) => l.labelId)).toEqual([ownA]);
    expect(children[1]!.assigneeMemberId).toBe(f.seats.employee.memberId);

    // History: both ends, INTERNAL — the shared source's row included.
    const fromRow = await f.platform.workItemActivity.findFirst({ where: { tenantId: f.tenantId, workItemId: done.id, field: "copiedFrom" } });
    expect(fromRow).toMatchObject({ oldRef: top.id, oldValue: null, visibility: "INTERNAL", actorMemberId: f.seats.owner.memberId });
    const toRow = await f.platform.workItemActivity.findFirst({ where: { tenantId: f.tenantId, workItemId: top.id, field: "copiedTo" } });
    expect(toRow).toMatchObject({ newRef: done.id, newValue: null, visibility: "INTERNAL" });

    // Audit: the copy names its source and what was brought; each subtask its own source.
    const created = await f.audits("work_item.created");
    expect(created.find((a) => a.targetId === done.id)).toMatchObject({
      actorType: "MEMBER",
      actorId: f.seats.owner.memberId,
      metadata: expect.objectContaining({ copiedFromId: top.id, brought: [...ALL], visibility: "INTERNAL" }),
    });
    const subAudits = created.filter((a) => children.some((c) => c.id === a.targetId));
    expect(subAudits.map((a) => (a.metadata as { copyOf: string }).copyOf).sort()).toEqual([sub1.id, sub2.id].sort());

    // Told ONCE, about the first task they hold in it.
    const told = await f.platform.notification.findMany({
      where: { tenantId: f.tenantId, receiverId: f.seats.employee.memberId, kind: "work_item.assigned", entityId: { in: [done.id, ...children.map((c) => c.id)] } },
    });
    expect(told).toEqual([expect.objectContaining({ entityId: done.id, reason: "ASSIGNEE" })]);
  }, LONG);

  it("nothing ticked: the title, type, priority and estimate — no description, subtasks, labels, person or dates", async () => {
    const { top } = await fullTask("Bare");
    const done = await copyItem(ownerCtx(), top.id, { projectId: pA, title: `Bare copy ${run}`, bring: NONE });
    expect(done.subtasks).toBe(0);
    const copy = await row(done.id);
    expect(copy).toMatchObject({
      priority: "HIGH",
      estimateMinutes: 120,
      assigneeMemberId: null,
      startDate: null,
      targetDate: null,
      description: null,
      checklistTotal: 0,
    });
    expect(copy.labels).toEqual([]);
    expect(await f.platform.workItem.count({ where: { parentId: done.id } })).toBe(0);
    const audit = (await f.audits("work_item.created")).find((a) => a.targetId === done.id);
    expect(audit!.metadata).toMatchObject({ brought: [] });
  }, LONG);

  it("into ANOTHER project: a label of the old project and a person who cannot work there are left off, and counted", async () => {
    const { top } = await fullTask("Away");
    const done = await copyItem(ownerCtx(), top.id, { projectId: pB, title: `Away copy ${run}`, bring: ALL });
    // ownA on the top and on step one; the employee on the top and on step two.
    expect(done).toMatchObject({ projectKey: keyB, subtasks: 2, labelsLeftOff: 2, assigneesLeftOff: 2 });
    const copy = await row(done.id);
    expect(copy).toMatchObject({ projectId: pB, clientId: beta, assigneeMemberId: null, visibility: "INTERNAL" });
    expect(copy.labels.map((l) => l.labelId)).toEqual([wide]);
    const children = await f.platform.workItem.findMany({ where: { parentId: done.id }, include: { labels: true } });
    for (const c of children) expect(c).toMatchObject({ projectId: pB, clientId: beta, assigneeMemberId: null, labels: [] });
    const audit = (await f.audits("work_item.created")).find((a) => a.targetId === done.id);
    expect(audit!.metadata).toMatchObject({ labelsLeftOff: 2, assigneesLeftOff: 2, projectId: pB });
    // The source's own row names the copy by its id, never another project's key.
    const toRow = await f.platform.workItemActivity.findFirst({ where: { tenantId: f.tenantId, workItemId: top.id, field: "copiedTo" } });
    expect(toRow).toMatchObject({ newRef: done.id, newValue: null });
  }, LONG);

  it("a subtask: in place it stays under its parent; in another project it becomes a task at the top", async () => {
    const parent = await task("Parent");
    const child = await task("Child", { parentId: parent.id });
    const here = await copyItem(ownerCtx(), child.id, { projectId: pA, title: `Child here ${run}`, bring: NONE });
    expect(await row(here.id)).toMatchObject({ parentId: parent.id, type: "SUBTASK", depth: 1 });
    const there = await copyItem(ownerCtx(), child.id, { projectId: pB, title: `Child there ${run}`, bring: NONE });
    expect(await row(there.id)).toMatchObject({ parentId: null, type: "TASK", depth: 0, projectId: pB });
  }, LONG);

  it("readCopySource: the facts the dialog offers, over the tree a copy would take", async () => {
    const { top } = await fullTask("Facts");
    expect(await readCopySource(ownerCtx(), top.id)).toMatchObject({
      id: top.id,
      number: top.number,
      projectId: pA,
      projectKey: keyA,
      title: `Facts ${run}`,
      description: true,
      subtasks: 2,
      tooManySubtasks: false,
      labels: true,
      assignee: true,
      assigneeName: expect.any(String),
      dates: true,
    });
    const plain = await task("Plain");
    expect(await readCopySource(ownerCtx(), plain.id)).toMatchObject({
      description: false,
      subtasks: 0,
      labels: false,
      assignee: false,
      assigneeName: null,
      dates: false,
    });
  }, LONG);

  it("refused: no edit right, a project out of reach, an archived project, a deleted task", async () => {
    const { id } = await task("Refused");
    await expect(copyItem(ctxOf(createOnly.actor), id, { projectId: pA, title: "x", bring: NONE })).rejects.toBeInstanceOf(AuthzError);
    await expect(readCopySource(ctxOf(createOnly.actor), id)).rejects.toBeInstanceOf(AuthzError);
    // ACME's seat reaches the source, not beta's project.
    await expect(copyItem(ctxOf(acmeSeat.actor), id, { projectId: pB, title: "x", bring: NONE })).rejects.toBeInstanceOf(AuthzError);
    // …and can copy within acme.
    const ok = await copyItem(ctxOf(acmeSeat.actor), id, { projectId: pA, title: `Acme seat ${run}`, bring: NONE });
    expect(ok.projectKey).toBe(keyA);
    await expect(copyItem(ownerCtx(), id, { projectId: pArchived, title: "x", bring: NONE })).rejects.toBeInstanceOf(AuthzError);
    await deleteItem(ownerCtx(), ok.id);
    await expect(copyItem(ownerCtx(), ok.id, { projectId: pA, title: "x", bring: NONE })).rejects.toBeInstanceOf(AuthzError);
    // Nothing landed in beta or the archived project.
    expect(await f.platform.workItem.count({ where: { tenantId: f.tenantId, projectId: { in: [pArchived] } } })).toBe(0);
  }, LONG);

  it("past the bound with Subtasks ticked it is refused, never cut short; unticked it copies", async () => {
    const big = await task("Big");
    const n = COPY_MAX_SUBTASKS + 1;
    await plantSubtasks(big.id, n);
    expect(await readCopySource(ownerCtx(), big.id)).toMatchObject({ subtasks: n, tooManySubtasks: true });
    const before = await f.platform.workItem.count({ where: { tenantId: f.tenantId, projectId: pA } });
    const refused = await copyItem(ownerCtx(), big.id, { projectId: pA, title: "x", bring: new Set(["subtasks"]) }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(DomainError);
    expect((refused as DomainError).code).toBe("COPY_TOO_BIG");
    expect(await f.platform.workItem.count({ where: { tenantId: f.tenantId, projectId: pA } })).toBe(before);
    const alone = await copyItem(ownerCtx(), big.id, { projectId: pA, title: `Big alone ${run}`, bring: NONE });
    expect(alone.subtasks).toBe(0);
  }, LONG);

  it("descriptions past the budget with Subtasks AND Description ticked are refused; either alone copies", async () => {
    // ~99 KB each as stored JSON (the repeat dbtest's measure): 22 pass 2 MiB.
    const heavy = await task("Heavy");
    await plantSubtasks(heavy.id, 22, () => bigDoc(99_000));
    expect(await readCopySource(ownerCtx(), heavy.id)).toMatchObject({ subtasks: 22, tooManySubtasks: false, descriptionsTooBig: true });
    const refused = await copyItem(ownerCtx(), heavy.id, { projectId: pA, title: "x", bring: new Set(["subtasks", "description"]) }).catch(
      (e: unknown) => e,
    );
    expect((refused as DomainError).code).toBe("COPY_TOO_BIG");
    expect((await copyItem(ownerCtx(), heavy.id, { projectId: pA, title: `Heavy tree ${run}`, bring: new Set(["subtasks"]) })).subtasks).toBe(22);
    const words = await copyItem(ownerCtx(), heavy.id, { projectId: pA, title: `Heavy words ${run}`, bring: new Set(["description"]) });
    expect(words.subtasks).toBe(0);
  }, LONG);

  it("a SHARED subtask is copied private too; a subtask that repeats is copied as a plain task; a client's request becomes a task", async () => {
    const top = await task("Shared tree");
    const shared = await task("Shared step", { parentId: top.id });
    const repeating = await task("Repeating step", { parentId: top.id });
    await changeItemVisibility(ownerCtx(), top.id, "CLIENT_VISIBLE");
    await changeItemVisibility(ownerCtx(), shared.id, "CLIENT_VISIBLE");
    await setItemRepeat(ownerCtx(), repeating.id, { rhythm: "WEEKLY" });
    expect((await row(shared.id)).visibility).toBe("CLIENT_VISIBLE");

    const done = await copyItem(ownerCtx(), top.id, { projectId: pA, title: `Shared tree copy ${run}`, bring: new Set(["subtasks"]) });
    const children = await f.platform.workItem.findMany({ where: { parentId: done.id }, select: { id: true, title: true, visibility: true } });
    expect(children.map((c) => c.title).sort()).toEqual([`Repeating step ${run}`, `Shared step ${run}`]);
    for (const c of children) expect(c.visibility).toBe("INTERNAL");
    // The repeating step's copy is not part of any series.
    expect(await f.platform.workItemRepeat.count({ where: { tenantId: f.tenantId, workItemId: { in: children.map((c) => c.id) } } })).toBe(0);
    expect(await f.platform.workItemRepeatItem.count({ where: { tenantId: f.tenantId, workItemId: { in: children.map((c) => c.id) } } })).toBe(0);

    const asked = await withTenant(f.tenantId, { type: "system" }, (tx) =>
      createRequest(tx, f.tenantId, { projectId: pA, title: `Asked ${run}`, body: null, reportedByContactId: carol }),
    );
    const fromRequest = await copyItem(ownerCtx(), asked.id, { projectId: pA, title: `From a request ${run}`, bring: NONE });
    expect(await row(fromRequest.id)).toMatchObject({ kind: "TASK", visibility: "INTERNAL", assigneeContactId: null });
  }, LONG);

  it("the history names the other end by its key within a project, and as 'another project' across projects", async () => {
    const source = await task("Named");
    const here = await copyItem(ownerCtx(), source.id, { projectId: pA, title: `Named here ${run}`, bring: NONE });
    const there = await copyItem(ownerCtx(), source.id, { projectId: pB, title: `Named there ${run}`, bring: NONE });
    // As `getItemDetail` reads it: the page, then its copy refs named for
    // the task's own project.
    const read = (id: string, clientId: string) =>
      withTenant(f.tenantId, { type: "member", id: f.seats.owner.memberId }, async (tx) => {
        const projectId = (await tx.workItem.findFirstOrThrow({ where: { id }, select: { projectId: true } })).projectId;
        return nameCopyRefs(tx, f.tenantId, projectId, await readItemActivity(tx, f.tenantId, id, clientId, null));
      });

    const onSource = (await read(source.id, acme)).rows.filter((r) => r.field === "copiedTo");
    expect(onSource.map((r) => r.newRef).sort()).toEqual([here.id, there.id].sort());
    expect(onSource.find((r) => r.newRef === here.id)!.newRefName).toBe(`${keyA}-${here.number}`);
    // Across projects: no key, whoever reads.
    expect(onSource.find((r) => r.newRef === there.id)!.newRefName).toBeNull();
    for (const r of onSource) expect(r).toMatchObject({ oldValue: null, newValue: null, visibility: "INTERNAL" });

    const onHere = (await read(here.id, acme)).rows.find((r) => r.field === "copiedFrom");
    expect(onHere).toMatchObject({ oldRef: source.id, oldRefName: `${keyA}-${source.number}` });
    const onThere = (await read(there.id, beta)).rows.find((r) => r.field === "copiedFrom");
    expect(onThere).toMatchObject({ oldRef: source.id, oldRefName: null });

    // The panel's own read names them the same way (`getItemDetail`, which
    // names the refs after its batch).
    const panel = await getItemDetail(ownerCtx(), pA, source.number);
    const named = panel.activity.rows.filter((r) => r.field === "copiedTo");
    expect(named.find((r) => r.newRef === here.id)!.newRefName).toBe(`${keyA}-${here.number}`);
    expect(named.find((r) => r.newRef === there.id)!.newRefName).toBeNull();
  }, LONG);

  it("the dialog's read and the copy ask work_item:view too", async () => {
    const { id } = await task("Unviewable");
    await expect(readCopySource(ctxOf(noView.actor), id)).rejects.toBeInstanceOf(AuthzError);
    await expect(copyItem(ctxOf(noView.actor), id, { projectId: pA, title: "x", bring: NONE })).rejects.toBeInstanceOf(AuthzError);
  }, LONG);
});

/** `n` subtasks planted under `parentId` in one statement, with REAL order keys after the project's last (the repeat dbtest's helper). */
async function plantSubtasks(parentId: string, n: number, description?: (i: number) => object | null): Promise<string[]> {
  const state = await f.platform.workflowState.findFirstOrThrow({ where: { tenantId: f.tenantId, projectId: pA, isDefault: true } });
  const last = await f.platform.workItem.findFirst({ where: { tenantId: f.tenantId, projectId: pA }, orderBy: { rank: "desc" }, select: { rank: true } });
  const top = await f.platform.workItem.findFirst({ where: { tenantId: f.tenantId, projectId: pA }, orderBy: { number: "desc" }, select: { number: true } });
  const keys = ranksBetween(last?.rank ?? null, null, n);
  const ids = Array.from({ length: n }, () => randomUUID());
  await f.platform.workItem.createMany({
    data: ids.map((id, i) => {
      const doc = description?.(i) ?? null;
      return {
        id,
        tenantId: f.tenantId,
        clientId: acme,
        projectId: pA,
        // Far past the counter, so a later create never meets them.
        number: Math.max(top?.number ?? 0, 500_000) + 1 + i,
        type: "SUBTASK" as const,
        title: `Planted ${i} ${run}`,
        stateId: state.id,
        stateCategory: state.category,
        parentId,
        rootId: id,
        rank: keys[i]!,
        ...(doc ? { description: doc } : {}),
      };
    }),
  });
  return ids;
}

/** A description of about `bytes` bytes as stored JSON. */
const bigDoc = (bytes: number) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(bytes) }] }] });
