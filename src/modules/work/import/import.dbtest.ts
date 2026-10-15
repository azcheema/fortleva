import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { setupTenant } from "@/members/dbtest-fixture";

import { changeItemVisibility, createItem, updateItemFields } from "../index";
import type { ImportRow } from "./rules";
import {
  finishImport,
  importBatch,
  listImports,
  matchImportPeople,
  previewImportMatches,
  readImportForm,
  restoreImport,
  startImport,
  undoImport,
} from "./service";

/**
 * IMPORTS against the real database and the real `app_runtime` role (Phase 6
 * slice 121; founder decision C97; design §8). What is at stake:
 *   · an imported task is born exactly as a hand-made one — numbered, ranked
 *     at the bottom, in its state with the state machine's stamps, PRIVATE,
 *     with its history and audit rows — and nobody is told;
 *   · the gates (create + edit, scope, approve for a gated state,
 *     label:manage for a new label, delete for undo) hold;
 *   · a re-import updates only a task still private and untouched since an
 *     import wrote it — a microsecond-exact comparison through the pg
 *     adapter, which the pre-apply review asked to be pinned;
 *   · undo removes only what nobody has worked on, Bring back restores
 *     exactly what that undo removed, and an undone import takes no rows.
 * Prefix `imp-` (registered in DBTEST_PREFIXES).
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let clientId: string;
let projectId: string;
let archivedProjectId: string;
let foreignProjectId: string;

const owner = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const manager = () => ({ tenantId: f.tenantId, actor: f.seats.manager.actor });
const employee = () => ({ tenantId: f.tenantId, actor: f.seats.employee.actor });
const LINK = { linkLabel: "Imported from Trello:" };

let states: { id: string; category: string; isDefault: boolean; requiresApproval: boolean }[] = [];
const stateOf = (category: string) => states.find((s) => s.category === category && !s.requiresApproval) ?? states.find((s) => s.category === category)!;

const row = (over: Partial<ImportRow> = {}): ImportRow => ({
  sourceId: null,
  title: "Task",
  text: "",
  checklists: [],
  link: null,
  stateId: states.find((s) => s.isDefault)!.id,
  targetDate: null,
  assigneeMemberId: null,
  labels: [],
  ...over,
});

const items = (ids?: string[]) =>
  f.platform.workItem.findMany({
    where: { tenantId: f.tenantId, projectId, ...(ids ? { id: { in: ids } } : {}) },
    orderBy: { number: "asc" },
    include: { labels: { include: { label: true } } },
  });
const bySource = (sourceId: string) =>
  f.platform.workItem.findFirstOrThrow({ where: { tenantId: f.tenantId, projectId, sourceId, deletedAt: null } });

async function run(ctx: ReturnType<typeof owner>, rows: ImportRow[], source: "CSV" | "TRELLO" = "CSV") {
  const { jobId } = await startImport(ctx, { projectId, source, fileName: "tasks.csv", rowCount: rows.length });
  const result = await importBatch(ctx, jobId, rows, LINK);
  await finishImport(ctx, jobId);
  return { jobId, result };
}

beforeAll(async () => {
  f = await setupTenant("imp");
  clientId = randomUUID();
  projectId = randomUUID();
  archivedProjectId = randomUUID();
  foreignProjectId = randomUUID();
  const foreignClient = randomUUID();
  await f.platform.client.create({ data: { id: clientId, tenantId: f.tenantId, name: "Import Co" } });
  await f.platform.client.create({ data: { id: foreignClient, tenantId: f.tenantId, name: "Not yours" } });
  await f.platform.project.createMany({
    data: [
      { id: projectId, tenantId: f.tenantId, clientId, key: "IMP", name: "Import project" },
      { id: archivedProjectId, tenantId: f.tenantId, clientId, key: "IMPA", name: "Archived", status: "ARCHIVED" },
      { id: foreignProjectId, tenantId: f.tenantId, clientId: foreignClient, key: "IMPX", name: "Foreign" },
    ],
  });
  // The employee works for Import Co, not for the foreign client.
  await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId } });
  await f.platform.label.create({ data: { tenantId: f.tenantId, projectId: null, name: "Design" } });
  const form = await readImportForm(owner(), projectId);
  states = form.states.map((s) => ({ id: s.id, category: s.category, isDefault: s.isDefault, requiresApproval: s.requiresApproval }));
}, 120_000);

afterAll(async () => {
  const db = f.platform;
  await db.comment.deleteMany({ where: { tenantId: f.tenantId } });
  await db.timeEntry.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItemLabel.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
  await db.importJobItem.deleteMany({ where: { tenantId: f.tenantId } });
  await db.importJob.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItem.deleteMany({ where: { tenantId: f.tenantId, parentId: { not: null } } });
  await db.workItem.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
  await db.label.deleteMany({ where: { tenantId: f.tenantId } });
  await db.notification.deleteMany({ where: { tenantId: f.tenantId } });
  await db.memberClient.deleteMany({ where: { tenantId: f.tenantId } });
  await db.project.deleteMany({ where: { tenantId: f.tenantId } });
  await db.client.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 120_000);

describe("the gates", () => {
  it("a member outside the project's scope cannot start one; an archived project refuses one", async () => {
    await expect(
      startImport(employee(), { projectId: foreignProjectId, source: "CSV", fileName: "x.csv", rowCount: 1 }),
    ).rejects.toBeInstanceOf(AuthzError);
    await expect(
      startImport(owner(), { projectId: archivedProjectId, source: "CSV", fileName: "x.csv", rowCount: 1 }),
    ).rejects.toMatchObject({ code: "ARCHIVED" });
  });

  it("nobody writes into a colleague's import", async () => {
    const { jobId } = await startImport(owner(), { projectId, source: "CSV", fileName: "x.csv", rowCount: 1 });
    await expect(importBatch(manager(), jobId, [row({ title: "Not mine" })], LINK)).rejects.toMatchObject({ code: "IMPORT_CLOSED" });
    await finishImport(owner(), jobId);
  });

  it("an import takes no more rows than it declared", async () => {
    const { jobId } = await startImport(owner(), { projectId, source: "CSV", fileName: "x.csv", rowCount: 1 });
    await expect(importBatch(owner(), jobId, [row({ title: "a" }), row({ title: "b" })], LINK)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await finishImport(owner(), jobId);
  });

  it("a row into an approval-gated state needs the approve code — and nothing is written", async () => {
    const done = states.find((s) => s.requiresApproval)!;
    const { jobId } = await startImport(employee(), { projectId, source: "CSV", fileName: "x.csv", rowCount: 1 });
    await expect(importBatch(employee(), jobId, [row({ title: "Gate", stateId: done.id })], LINK)).rejects.toMatchObject({
      code: "APPROVAL_REQUIRED",
    });
    expect((await items()).some((i) => i.title === "Gate")).toBe(false);
    await finishImport(employee(), jobId);
  });

  it("a row whose state is another project's, or triage, is refused", async () => {
    const { jobId } = await startImport(owner(), { projectId, source: "CSV", fileName: "x.csv", rowCount: 2 });
    await expect(importBatch(owner(), jobId, [row({ stateId: randomUUID() })], LINK)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const triage = states.find((s) => s.category === "TRIAGE");
    if (triage) {
      await expect(importBatch(owner(), jobId, [row({ stateId: triage.id })], LINK)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    await finishImport(owner(), jobId);
  });
});

describe("a batch", () => {
  it("makes tasks as a hand-made one is made — numbered, at the bottom, in their state, PRIVATE — and tells nobody", async () => {
    const before = await createItem(owner(), { projectId, title: "Hand-made first" });
    const doing = stateOf("IN_PROGRESS");
    const done = states.find((s) => s.category === "DONE")!;
    const { jobId, result } = await run(owner(), [
      row({ sourceId: "B1", title: "Plain" }),
      row({
        sourceId: "B2",
        title: "Doing it",
        stateId: doing.id,
        assigneeMemberId: f.seats.manager.memberId,
        targetDate: "2026-11-30",
        labels: ["design", "Brand-new"],
        text: "- [ ] one\n- [x] two",
      }),
      row({ sourceId: "B3", title: "Finished", stateId: done.id }),
    ]);
    expect(result).toEqual({ created: 3, updated: 0, kept: 0, unchanged: 0 });

    const [b1, b2, b3] = await Promise.all(["B1", "B2", "B3"].map(bySource));
    expect([b1!.number, b2!.number, b3!.number]).toEqual([before.number + 1, before.number + 2, before.number + 3]);
    const handRank = (await f.platform.workItem.findUniqueOrThrow({ where: { id: before.id } })).rank;
    expect(handRank < b1!.rank && b1!.rank < b2!.rank && b2!.rank < b3!.rank).toBe(true);
    for (const t of [b1!, b2!, b3!]) {
      expect(t).toMatchObject({ visibility: "INTERNAL", source: "IMPORT", sourceSystem: "csv", importJobId: jobId, type: "TASK", kind: "TASK" });
      expect(t.createdByMemberId).toBe(f.seats.owner.memberId);
    }
    expect(b2).toMatchObject({ stateId: doing.id, stateCategory: "IN_PROGRESS", assigneeMemberId: f.seats.manager.memberId, checklistTotal: 2, checklistDone: 1 });
    expect(b2!.startedAt).not.toBeNull();
    expect(b2!.targetDate!.toISOString().slice(0, 10)).toBe("2026-11-30");
    expect(b3!.completedAt).not.toBeNull();
    expect(b1!.startedAt).toBeNull();

    // Labels: the existing one matched case-insensitively, the new one MADE (the owner holds label:manage) and audited.
    const withLabels = (await items([b2!.id]))[0]!;
    expect(withLabels.labels.map((l) => l.label.name).sort()).toEqual(["Brand-new", "Design"]);
    expect((await f.audits("label.created")).map((a) => (a.metadata as { name: string }).name)).toContain("Brand-new");

    // History and audit, per task; NO notification to the assignee.
    const activity = await f.platform.workItemActivity.findMany({ where: { tenantId: f.tenantId, workItemId: { in: [b1!.id, b2!.id, b3!.id] } } });
    expect(activity.filter((a) => a.field === "created")).toHaveLength(3);
    expect(activity.filter((a) => a.field === "stateCategory")).toHaveLength(2);
    expect(activity.every((a) => a.visibility === "INTERNAL")).toBe(true);
    const created = (await f.audits("work_item.created")).filter((a) => (a.metadata as { importJobId?: string }).importJobId === jobId);
    expect(created).toHaveLength(3);
    const stateAudits = (await f.audits("work_item.state_changed")).filter((a) => [b2!.id, b3!.id].includes(a.targetId!));
    expect(stateAudits).toHaveLength(2);
    expect(await f.platform.notification.count({ where: { tenantId: f.tenantId, receiverType: "MEMBER", receiverId: f.seats.manager.memberId } })).toBe(0);
    expect((await f.audits("import_job.started")).some((a) => a.targetId === jobId)).toBe(true);
    const finished = (await f.audits("import_job.finished")).filter((a) => a.targetId === jobId);
    expect(finished).toHaveLength(1);
    // Finishing again is a no-op.
    await finishImport(owner(), jobId);
    expect((await f.audits("import_job.finished")).filter((a) => a.targetId === jobId)).toHaveLength(1);
    // No audit row carries the file's name.
    for (const a of await f.audits("import_job.started")) expect(JSON.stringify(a.metadata)).not.toContain("tasks.csv");
  });

  it("a description the gate would refuse falls back to its words as one paragraph — the row is never refused", async () => {
    // 10 000 one-word bullets: 40 000 characters of text, but ~0.9 MB of
    // list JSON — past DESCRIPTION_JSON_BYTES (the code review's finding).
    const text = Array.from({ length: 10_000 }, () => "- a").join("\n");
    await run(owner(), [row({ sourceId: "F1", title: "Fallback", text })]);
    const t = await bySource("F1");
    const doc = t.description as { content: { type: string }[] };
    expect(doc.content.map((n) => n.type)).toEqual(["paragraph"]);
    expect(t.descriptionText!.startsWith("- a - a")).toBe(true);
  });

  it("a run a refused batch stopped short is listed as stopped part-way, and its finish says so", async () => {
    const { jobId } = await startImport(owner(), { projectId, source: "CSV", fileName: "short.csv", rowCount: 2 });
    await importBatch(owner(), jobId, [row({ sourceId: "P1", title: "First half" })], LINK);
    await expect(importBatch(owner(), jobId, [row({ sourceId: "P2", stateId: randomUUID() })], LINK)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await finishImport(owner(), jobId);
    expect((await listImports(owner(), projectId)).find((j) => j.id === jobId)).toMatchObject({ status: "STOPPED", canUndo: true });
    const finished = (await f.audits("import_job.finished")).find((a) => a.targetId === jobId)!;
    expect(finished.metadata).toMatchObject({ rows: 2, created: 1, stopped: true });
  });

  it("a member without label:manage gets existing labels only", async () => {
    await run(employee(), [row({ sourceId: "E1", title: "Employee's", labels: ["Design", "Unknown-label"] })]);
    const t = (await items([(await bySource("E1")).id]))[0]!;
    expect(t.labels.map((l) => l.label.name)).toEqual(["Design"]);
    expect(await f.platform.label.count({ where: { tenantId: f.tenantId, name: "Unknown-label" } })).toBe(0);
  });

  it("matches people by email on the server, ACTIVE members only, answering the matches alone", async () => {
    const managerEmail = (await f.platform.user.findUniqueOrThrow({ where: { id: f.seats.manager.userId } })).email;
    const match = await matchImportPeople(owner(), projectId, [managerEmail.toUpperCase(), "nobody@example.se"]);
    expect(match).toEqual({ [managerEmail.toLowerCase()]: f.seats.manager.memberId });
  });
});

describe("importing again", () => {
  it("updates a task still private and untouched, keeps one a person changed, and writes nothing for an identical one", async () => {
    await run(owner(), [
      row({ sourceId: "R1", title: "Untouched" }),
      row({ sourceId: "R2", title: "Edited by hand" }),
      row({ sourceId: "R3", title: "Identical" }),
      row({ sourceId: "R4", title: "Shared" }),
    ]);
    await updateItemFields(owner(), (await bySource("R2")).id, { title: "Changed in Fortleva" });
    await changeItemVisibility(owner(), (await bySource("R4")).id, "CLIENT_VISIBLE");

    expect(await previewImportMatches(owner(), { projectId, source: "CSV", sourceIds: ["R1", "R2", "R3", "R4", "NEW"] })).toEqual({
      willUpdate: 2,
      willKeep: 2,
    });
    const { result } = await run(owner(), [
      row({ sourceId: "R1", title: "Untouched, renamed in the file", text: "Now with words" }),
      row({ sourceId: "R2", title: "Edited by hand, renamed in the file" }),
      row({ sourceId: "R3", title: "Identical" }),
      row({ sourceId: "R4", title: "Shared, renamed in the file" }),
      row({ sourceId: "R5", title: "New in the second file" }),
    ]);
    expect(result).toEqual({ created: 1, updated: 1, kept: 2, unchanged: 1 });
    expect((await bySource("R1")).title).toBe("Untouched, renamed in the file");
    expect((await bySource("R1")).descriptionText).toBe("Now with words");
    expect((await bySource("R2")).title).toBe("Changed in Fortleva");
    expect((await bySource("R4")).title).toBe("Shared");
    // One live task per (project, source, id): no copies were made.
    expect(await f.platform.workItem.count({ where: { tenantId: f.tenantId, projectId, sourceId: { in: ["R1", "R2", "R3", "R4"] }, deletedAt: null } })).toBe(4);
  });

  it("a task a re-import updated stays updatable — the microsecond-exact stamp survives the description's `now()`", async () => {
    await run(owner(), [row({ sourceId: "M1", title: "Micro", text: "first" })]);
    expect((await run(owner(), [row({ sourceId: "M1", title: "Micro", text: "second" })])).result.updated).toBe(1);
    expect((await run(owner(), [row({ sourceId: "M1", title: "Micro", text: "third" })])).result.updated).toBe(1);
    expect((await bySource("M1")).descriptionText).toBe("third");
  });

  it("a re-import's status change goes through the state machine", async () => {
    await run(owner(), [row({ sourceId: "S1", title: "Moves" })]);
    const doing = stateOf("IN_PROGRESS");
    expect((await run(owner(), [row({ sourceId: "S1", title: "Moves", stateId: doing.id })])).result.updated).toBe(1);
    const t = await bySource("S1");
    expect(t.stateCategory).toBe("IN_PROGRESS");
    expect(t.startedAt).not.toBeNull();
    expect((await f.audits("work_item.state_changed")).some((a) => a.targetId === t.id)).toBe(true);
  });
});

describe("undo and Bring back", () => {
  it("removes what nobody has worked on, keeps the rest, once, within 7 days", async () => {
    const { jobId } = await run(owner(), [
      row({ sourceId: "U1", title: "Plain" }),
      row({ sourceId: "U2", title: "Commented" }),
      row({ sourceId: "U3", title: "Has a subtask" }),
      row({ sourceId: "U4", title: "Shared" }),
      row({ sourceId: "U5", title: "Hours" }),
    ]);
    const [u2, u3, u4, u5] = await Promise.all(["U2", "U3", "U4", "U5"].map(bySource));
    await f.platform.comment.create({
      data: {
        tenantId: f.tenantId,
        clientId,
        projectId,
        subjectType: "WORK_ITEM",
        subjectId: u2!.id,
        authorMemberId: f.seats.owner.memberId,
        body: { type: "doc", content: [] },
        bodyText: "A word",
      },
    });
    await createItem(owner(), { projectId, title: "Child", parentId: u3!.id });
    await changeItemVisibility(owner(), u4!.id, "CLIENT_VISIBLE");
    const started = new Date("2026-10-01T08:00:00Z");
    await f.platform.timeEntry.create({
      data: {
        tenantId: f.tenantId,
        clientId,
        projectId,
        workItemId: u5!.id,
        memberId: f.seats.owner.memberId,
        startedAt: started,
        stoppedAt: new Date(started.getTime() + 3600_000),
        durationSeconds: 3600,
        timezone: "Europe/Stockholm",
        localDate: new Date("2026-10-01T00:00:00Z"),
        entryMode: "MANUAL",
        source: "MANUAL",
        billable: false,
      },
    });

    // An employee may import but not undo (work_item:delete is C M).
    await expect(undoImport(employee(), jobId)).rejects.toBeInstanceOf(AuthzError);
    expect(await undoImport(manager(), jobId)).toEqual({ removed: 1, kept: 4 });
    const u1 = await f.platform.workItem.findFirstOrThrow({ where: { tenantId: f.tenantId, sourceId: "U1" } });
    expect(u1.deletedAt).not.toBeNull();
    const job = await f.platform.importJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("UNDONE");
    expect(job.undoneAt!.getTime()).toBe(u1.deletedAt!.getTime());
    const deleted = (await f.audits("work_item.deleted")).filter((a) => a.targetId === u1.id);
    expect(deleted[0]!.metadata).toMatchObject({ reason: "import_undone", importJobId: jobId });
    await expect(undoImport(manager(), jobId)).rejects.toMatchObject({ code: "IMPORT_UNDO_CLOSED" });
    // An undone import takes no more rows.
    await expect(importBatch(owner(), jobId, [row()], LINK)).rejects.toMatchObject({ code: "IMPORT_CLOSED" });
    const listed = (await listImports(manager(), projectId)).find((j) => j.id === jobId)!;
    expect(listed).toMatchObject({ status: "UNDONE", undone: 1, canUndo: false, canRestore: true });
  });

  it("refuses an undo after 7 days", async () => {
    const { jobId } = await run(owner(), [row({ sourceId: "W1", title: "Old" })]);
    await f.platform.importJob.update({
      where: { id: jobId },
      data: { startedAt: new Date(Date.now() - 9 * 86_400_000), lastWriteAt: new Date(Date.now() - 8 * 86_400_000) },
    });
    await expect(undoImport(owner(), jobId)).rejects.toMatchObject({ code: "IMPORT_UNDO_CLOSED" });
    expect((await listImports(owner(), projectId)).find((j) => j.id === jobId)!.canUndo).toBe(false);
  });

  it("Bring back restores exactly what the undo removed — skipping a task with a live twin — and a re-import can still update it", async () => {
    const { jobId } = await run(owner(), [
      row({ sourceId: "K1", title: "Comes back" }),
      row({ sourceId: "K2", title: "Gets a twin" }),
      row({ title: "No id" }),
    ]);
    expect((await undoImport(owner(), jobId)).removed).toBe(3);
    // A re-import after the undo makes a NEW K2 (a binned task is never matched).
    expect((await run(owner(), [row({ sourceId: "K2", title: "The twin" })])).result.created).toBe(1);

    expect(await restoreImport(owner(), jobId)).toEqual({ restored: 2, skipped: 1 });
    expect((await bySource("K1")).deletedAt).toBeNull();
    expect((await bySource("K2")).title).toBe("The twin");
    const job = await f.platform.importJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job).toMatchObject({ status: "DONE" });
    expect(job.restoredAt).not.toBeNull();
    expect((await f.audits("work_item.restored")).filter((a) => (a.metadata as { importJobId?: string }).importJobId === jobId)).toHaveLength(2);
    // One undo per import.
    await expect(undoImport(owner(), jobId)).rejects.toMatchObject({ code: "IMPORT_UNDO_CLOSED" });
    await expect(restoreImport(owner(), jobId)).rejects.toMatchObject({ code: "IMPORT_RESTORE_CLOSED" });
    // The undo and the Bring back were the import's own acts, not a person's
    // change: the restored, untouched task is still one a re-import updates.
    expect((await run(owner(), [row({ sourceId: "K1", title: "Comes back, renamed" })])).result.updated).toBe(1);
  });

  it("refuses a Bring back after 30 days", async () => {
    const { jobId } = await run(owner(), [row({ sourceId: "X1", title: "Gone for good" })]);
    await undoImport(owner(), jobId);
    const long = new Date(Date.now() - 31 * 86_400_000);
    // The stamps move together, as the undo wrote them.
    await f.platform.$transaction([
      f.platform.workItem.updateMany({ where: { tenantId: f.tenantId, sourceId: "X1" }, data: { deletedAt: long } }),
      f.platform.importJob.update({ where: { id: jobId }, data: { startedAt: long, lastWriteAt: long, finishedAt: long, undoneAt: long } }),
    ]);
    await expect(restoreImport(owner(), jobId)).rejects.toMatchObject({ code: "IMPORT_RESTORE_CLOSED" });
  });
});

describe("the database's own rules", () => {
  it("refuses a second live task with one source id in a project, and an IMPORT row without its job", async () => {
    const t = await bySource("B1");
    await expect(
      f.platform.workItem.create({
        data: {
          tenantId: f.tenantId,
          clientId,
          projectId,
          number: 99_999,
          title: "Twin",
          stateId: t.stateId,
          stateCategory: t.stateCategory,
          rootId: randomUUID(),
          rank: "zzzzzz",
          source: "IMPORT",
          sourceSystem: "csv",
          sourceId: "B1",
          importJobId: t.importJobId,
        },
      }),
    ).rejects.toThrow();
    await expect(
      f.platform.workItem.updateMany({ where: { id: t.id }, data: { importJobId: null } }),
    ).rejects.toThrow();
  });

});
