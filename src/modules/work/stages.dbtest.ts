import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { ranksBetween } from "@/lib/rank";
import { setupTenant } from "@/members/dbtest-fixture";

import {
  addProjectStage,
  addWorkspaceStage,
  createItem,
  getProjectStages,
  listItems,
  moveProjectStage,
  removeProjectStage,
  renameProjectStage,
  renameWorkspaceStage,
  restoreWorkspaceStages,
  setProjectDefaultStage,
  setProjectStageApproval,
  setWorkspaceDefaultStage,
  setWorkspaceStageApproval,
} from "./index";

/**
 * The stage editors against the real database and the real app_runtime
 * role (slice 123, founder decision C99 (a); design doc §3–§6): the
 * workspace default is what a NEW project copies (an existing one keeps
 * its stages); a project's own stages are renamed one way, added at the
 * end of their kind, moved within it, and removed only into another stage
 * of the same kind — the tasks moved with INTERNAL history rows and a
 * `work_item.state_changed` audit each; every kind but Backlog keeps a
 * stage; "new tasks start here" is one Backlog or To do stage, held by the
 * database too; and `workflow:manage` is the gate.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let clientId: string;

beforeAll(async () => {
  f = await setupTenant("stg");
  clientId = randomUUID();
  await f.platform.client.create({ data: { id: clientId, tenantId: f.tenantId, name: "Acme" } });
}, 60_000);

afterAll(async () => {
  if (!f?.tenantId) return;
  const db = f.platform;
  await db.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItem.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workflowPreset.deleteMany({ where: { tenantId: f.tenantId } });
  await db.project.deleteMany({ where: { tenantId: f.tenantId } });
  await db.client.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 60_000);

const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const employeeCtx = () => ({ tenantId: f.tenantId, actor: f.seats.employee.actor });

let keyN = 0;
/** A fresh project, its stages not yet seeded. */
async function newProject(): Promise<string> {
  const id = randomUUID();
  keyN += 1;
  await f.platform.project.create({
    data: { id, tenantId: f.tenantId, clientId, key: `STG${keyN}`, name: `Stages ${keyN}` },
  });
  return id;
}

const states = (projectId: string) =>
  f.platform.workflowState.findMany({
    where: { tenantId: f.tenantId, projectId },
    orderBy: { rank: "asc" },
    select: { id: true, name: true, seedKey: true, category: true, isDefault: true, requiresApproval: true },
  });

const seedState = async (projectId: string, seedKey: string) =>
  (await states(projectId)).find((s) => s.seedKey === seedKey)!;

const audits = (action: string) =>
  f.platform.auditEvent.findMany({ where: { tenantId: f.tenantId, action }, orderBy: { id: "asc" } });

describe("the workspace default", () => {
  it("is what a NEW project copies — an existing one keeps its stages — and Restore brings the original back", async () => {
    const before = await newProject();
    await listItems(ownerCtx(), before); // seeded from the built-in set

    await renameWorkspaceStage(ownerCtx(), "seed-TODO", "Next up");
    await addWorkspaceStage(ownerCtx(), { name: "QA", kind: "IN_PROGRESS" });

    const after = await newProject();
    await listItems(ownerCtx(), after);
    const copied = await states(after);
    expect(copied.map((s) => [s.name, s.seedKey, s.category])).toEqual([
      [null, "BACKLOG", "BACKLOG"],
      ["Next up", "TODO", "TODO"],
      [null, "IN_PROGRESS", "IN_PROGRESS"],
      [null, "IN_REVIEW", "IN_PROGRESS"],
      ["QA", null, "IN_PROGRESS"],
      [null, "DONE", "DONE"],
      [null, "CANCELLED", "CANCELLED"],
      [null, "TRIAGE", "TRIAGE"], // always last, never part of the default
    ]);
    // The renamed To do still carries the mark, and a new Done-free stage is ungated.
    expect(copied.find((s) => s.name === "Next up")!.isDefault).toBe(true);
    expect(copied.find((s) => s.name === "QA")!.requiresApproval).toBe(false);

    // The project made BEFORE the edit is untouched.
    expect((await states(before)).every((s) => s.name === null)).toBe(true);

    const changes = await audits("workflow.changed");
    expect(changes.map((a) => (a.metadata as { scope: string; change: string }).change)).toEqual(["renamed", "added"]);
    expect(changes.every((a) => (a.metadata as { scope: string }).scope === "workspace")).toBe(true);

    await restoreWorkspaceStages(ownerCtx());
    const third = await newProject();
    await listItems(ownerCtx(), third);
    expect((await states(third)).every((s) => s.name === null)).toBe(true);
    expect((await audits("workflow.changed")).length).toBe(3);
  });

  it("is workflow:manage's — an employee is refused", async () => {
    await expect(renameWorkspaceStage(employeeCtx(), "seed-TODO", "Mine")).rejects.toBeInstanceOf(AuthzError);
  });
});

describe("a project's own stages", () => {
  it("renames one way, refuses a blank or taken name, and the database refuses NULL", async () => {
    const p = await newProject();
    await listItems(ownerCtx(), p);
    const todo = await seedState(p, "TODO");
    await renameProjectStage(ownerCtx(), p, todo.id, "  Ready  ");
    expect((await seedState(p, "TODO")).name).toBe("Ready");
    await expect(renameProjectStage(ownerCtx(), p, todo.id, "   ")).rejects.toMatchObject({ code: "NAME_REQUIRED" });
    const review = await seedState(p, "IN_REVIEW");
    await expect(renameProjectStage(ownerCtx(), p, review.id, "READY")).rejects.toMatchObject({
      code: "STAGE_NAME_TAKEN",
    });
    // The database's own copies: no blank name, nothing named alike.
    await expect(
      f.platform.workflowState.update({ where: { id: review.id }, data: { name: "ready" } }),
    ).rejects.toThrow();
    await expect(f.platform.workflowState.update({ where: { id: review.id }, data: { name: " " } })).rejects.toThrow();
  });

  it("adds at the end of a kind and moves only within it", async () => {
    const p = await newProject();
    await listItems(ownerCtx(), p);
    const { id: qa } = await addProjectStage(ownerCtx(), p, { name: "QA", kind: "IN_PROGRESS" });
    const { id: shipped } = await addProjectStage(ownerCtx(), p, { name: "Shipped", kind: "DONE" });
    let order = (await states(p)).map((s) => s.name ?? s.seedKey);
    expect(order).toEqual(["BACKLOG", "TODO", "IN_PROGRESS", "IN_REVIEW", "QA", "DONE", "Shipped", "CANCELLED", "TRIAGE"]);
    // A new Done stage is gated, like the seeded one.
    expect((await states(p)).find((s) => s.id === shipped)!.requiresApproval).toBe(true);

    await moveProjectStage(ownerCtx(), p, qa, "up");
    await moveProjectStage(ownerCtx(), p, qa, "up");
    order = (await states(p)).map((s) => s.name ?? s.seedKey);
    expect(order).toEqual(["BACKLOG", "TODO", "QA", "IN_PROGRESS", "IN_REVIEW", "DONE", "Shipped", "CANCELLED", "TRIAGE"]);
    // First of its kind: no further up, never into To do.
    await expect(moveProjectStage(ownerCtx(), p, qa, "up")).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await setProjectStageApproval(ownerCtx(), p, shipped, false);
    expect((await states(p)).find((s) => s.id === shipped)!.requiresApproval).toBe(false);
  });

  it("removes a stage into another of its kind: tasks moved, INTERNAL history, an audit per task", async () => {
    const p = await newProject();
    await listItems(ownerCtx(), p);
    const review = await seedState(p, "IN_REVIEW");
    const progress = await seedState(p, "IN_PROGRESS");
    // A NAMED stage, so "no name in the audit row" below is a claim about
    // something that could have been there (the code review's LOW).
    const sentinel = `SENTINELSTAGE${randomUUID().slice(0, 8)}`;
    await renameProjectStage(ownerCtx(), p, review.id, sentinel);
    const a = await createItem(ownerCtx(), { projectId: p, title: "One", stateId: review.id });
    const b = await createItem(ownerCtx(), { projectId: p, title: "Two", stateId: review.id });
    const auditsBefore = (await audits("work_item.state_changed")).length;

    // A target of another kind is refused before anything moves.
    const done = await seedState(p, "DONE");
    await expect(removeProjectStage(ownerCtx(), p, review.id, done.id)).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const { moved } = await removeProjectStage(ownerCtx(), p, review.id, progress.id);
    expect(moved).toBe(2);
    const items = await f.platform.workItem.findMany({
      where: { tenantId: f.tenantId, id: { in: [a.id, b.id] } },
      select: { stateId: true, stateCategory: true },
    });
    expect(items.every((i) => i.stateId === progress.id && i.stateCategory === "IN_PROGRESS")).toBe(true);
    expect((await states(p)).some((s) => s.id === review.id)).toBe(false);

    const history = await f.platform.workItemActivity.findMany({
      where: { tenantId: f.tenantId, workItemId: { in: [a.id, b.id] }, oldRef: review.id, newRef: progress.id },
      select: { visibility: true, oldValue: true, newValue: true },
    });
    expect(history).toHaveLength(2);
    expect(history.every((h) => h.visibility === "INTERNAL" && h.oldValue === "IN_PROGRESS" && h.newValue === "IN_PROGRESS")).toBe(true);
    expect((await audits("work_item.state_changed")).length).toBe(auditsBefore + 2);
    const removal = (await audits("workflow.changed")).at(-1)!;
    expect(removal.metadata).toMatchObject({ scope: "project", projectId: p, change: "removed", movedTasks: 2, into: progress.id });
    expect(removal.metadata).toMatchObject({ binnedTasks: 0 });
    expect(JSON.stringify(removal.metadata)).not.toContain(sentinel); // ids and kinds, never a name
  });

  it("keeps a stage of every kind but Backlog, and the start-here mark on Backlog or To do", async () => {
    const p = await newProject();
    await listItems(ownerCtx(), p);
    const done = await seedState(p, "DONE");
    const todo = await seedState(p, "TODO");
    const backlog = await seedState(p, "BACKLOG");
    await expect(removeProjectStage(ownerCtx(), p, done.id, null)).rejects.toMatchObject({ code: "STAGE_LAST_OF_KIND" });
    await expect(removeProjectStage(ownerCtx(), p, todo.id, null)).rejects.toMatchObject({ code: "STAGE_LAST_OF_KIND" });
    await expect(setProjectDefaultStage(ownerCtx(), p, done.id)).rejects.toMatchObject({ code: "STAGE_DEFAULT_KIND" });

    // The mark moves, and the database holds one — of the right kind.
    await setProjectDefaultStage(ownerCtx(), p, backlog.id);
    expect((await states(p)).filter((s) => s.isDefault).map((s) => s.id)).toEqual([backlog.id]);
    await expect(
      f.platform.workflowState.update({ where: { id: todo.id }, data: { isDefault: true } }),
    ).rejects.toThrow(); // two defaults
    await setProjectDefaultStage(ownerCtx(), p, todo.id);
    await expect(
      f.platform.workflowState.update({ where: { id: todo.id }, data: { isDefault: false } }).then(() =>
        f.platform.workflowState.update({ where: { id: done.id }, data: { isDefault: true } }),
      ),
    ).rejects.toThrow(); // a Done default
    await f.platform.workflowState.update({ where: { id: todo.id }, data: { isDefault: true } });

    // The last Backlog may go when empty — and an added To do inherits
    // the mark when the marked one is removed.
    await removeProjectStage(ownerCtx(), p, backlog.id, null);
    const { id: ready } = await addProjectStage(ownerCtx(), p, { name: "Ready", kind: "TODO" });
    await removeProjectStage(ownerCtx(), p, todo.id, null);
    expect((await states(p)).filter((s) => s.isDefault).map((s) => s.id)).toEqual([ready]);
    // ...so a new task lands there.
    const { id } = await createItem(ownerCtx(), { projectId: p, title: "Born" });
    expect((await f.platform.workItem.findUniqueOrThrow({ where: { id }, select: { stateId: true } })).stateId).toBe(ready);
  });

  it("is workflow:manage's — an employee is refused, and the page's read is too", async () => {
    const p = await newProject();
    await listItems(ownerCtx(), p);
    const todo = await seedState(p, "TODO");
    await expect(renameProjectStage(employeeCtx(), p, todo.id, "Mine")).rejects.toBeInstanceOf(AuthzError);
    await expect(getProjectStages(employeeCtx(), p)).rejects.toBeInstanceOf(AuthzError);
    const page = await getProjectStages(ownerCtx(), p);
    expect(page.stages.some((s) => s.category === "TRIAGE")).toBe(false);
  });
});

describe("where new tasks start is never gated (the security review's LOW)", () => {
  it("a gated stage cannot become the default, the default cannot be gated, and the database agrees", async () => {
    const p = await newProject();
    await listItems(ownerCtx(), p);
    const todo = await seedState(p, "TODO");
    const backlog = await seedState(p, "BACKLOG");
    await setProjectStageApproval(ownerCtx(), p, backlog.id, true);
    await expect(setProjectDefaultStage(ownerCtx(), p, backlog.id)).rejects.toMatchObject({ code: "STAGE_DEFAULT_GATED" });
    await expect(setProjectStageApproval(ownerCtx(), p, todo.id, true)).rejects.toMatchObject({ code: "STAGE_DEFAULT_GATED" });
    await expect(
      f.platform.workflowState.update({ where: { id: todo.id }, data: { requiresApproval: true } }),
    ).rejects.toThrow();
    // A removed default's mark skips a gated stage of its kind.
    const { id: gatedTodo } = await addProjectStage(ownerCtx(), p, { name: "Gated next", kind: "TODO" });
    await setProjectStageApproval(ownerCtx(), p, gatedTodo, true);
    const { id: openTodo } = await addProjectStage(ownerCtx(), p, { name: "Open next", kind: "TODO" });
    await removeProjectStage(ownerCtx(), p, todo.id, gatedTodo);
    expect((await states(p)).filter((s) => s.isDefault).map((s) => s.id)).toEqual([openTodo]);
  });

  it("the workspace default refuses the same pair, and a no-op writes and audits nothing", async () => {
    await expect(setWorkspaceStageApproval(ownerCtx(), "seed-TODO", true)).rejects.toMatchObject({
      code: "STAGE_DEFAULT_GATED",
    });
    const before = (await audits("workflow.changed")).length;
    await restoreWorkspaceStages(ownerCtx());
    const afterRestore = (await audits("workflow.changed")).length;
    // Already the default, and Done already gated: nothing to write, nothing to say — and no row made.
    await setWorkspaceDefaultStage(ownerCtx(), "seed-TODO");
    await setWorkspaceStageApproval(ownerCtx(), "seed-DONE", true);
    expect((await audits("workflow.changed")).length).toBe(afterRestore);
    expect(await f.platform.workflowPreset.count({ where: { tenantId: f.tenantId } })).toBe(0);
    // A real change says which entry and which way.
    await setWorkspaceStageApproval(ownerCtx(), "seed-DONE", false);
    const changed = (await audits("workflow.changed")).at(-1)!;
    expect(changed.metadata).toMatchObject({ scope: "workspace", change: "approval", key: "seed-DONE", category: "DONE", on: false });
    expect((await audits("workflow.changed")).length).toBeGreaterThan(before);
    // A no-op on an EXISTING row keeps the row — and with it the workspace's
    // own set: only a row the no-op itself just made is taken away (the
    // `xmax = 0` branch, the fix review's LOW).
    const afterChange = (await audits("workflow.changed")).length;
    await setWorkspaceStageApproval(ownerCtx(), "seed-DONE", false);
    await setWorkspaceDefaultStage(ownerCtx(), "seed-TODO");
    expect(await f.platform.workflowPreset.count({ where: { tenantId: f.tenantId } })).toBe(1);
    expect((await audits("workflow.changed")).length).toBe(afterChange);
    const stored = await f.platform.workflowPreset.findFirstOrThrow({ where: { tenantId: f.tenantId }, select: { states: true } });
    expect((stored.states as { key: string; requiresApproval: boolean }[]).find((s) => s.key === "seed-DONE")?.requiresApproval).toBe(false);
    await restoreWorkspaceStages(ownerCtx());
  });
});

describe("a removal near its bound, and the bin", () => {
  it("moves 400 tasks inside its minute's budget, narrating exactly the rows it moved", async () => {
    const p = await newProject();
    await listItems(ownerCtx(), p);
    const review = await seedState(p, "IN_REVIEW");
    const progress = await seedState(p, "IN_PROGRESS");
    const n = 400;
    const ranks = ranksBetween(null, null, n);
    const ids = Array.from({ length: n }, () => randomUUID());
    await f.platform.workItem.createMany({
      data: ids.map((id, i) => ({
        id,
        tenantId: f.tenantId,
        clientId,
        projectId: p,
        number: 10_000 + i,
        title: `Planted ${i}`,
        stateId: review.id,
        stateCategory: "IN_PROGRESS" as const,
        rootId: id,
        rank: ranks[i]!,
      })),
    });
    const started = Date.now();
    const { moved } = await removeProjectStage(ownerCtx(), p, review.id, progress.id);
    const took = Date.now() - started;
    expect(moved).toBe(n);
    expect(took).toBeLessThan(60_000);
    expect(await f.platform.workItem.count({ where: { tenantId: f.tenantId, projectId: p, stateId: progress.id } })).toBe(n);
    expect(
      await f.platform.workItemActivity.count({ where: { tenantId: f.tenantId, projectId: p, oldRef: review.id, newRef: progress.id } }),
    ).toBe(n);
  }, 120_000);

  it("the last Backlog stage with only deleted tasks says so, rather than 'move its tasks first'", async () => {
    const p = await newProject();
    await listItems(ownerCtx(), p);
    const backlog = await seedState(p, "BACKLOG");
    const { id } = await createItem(ownerCtx(), { projectId: p, title: "In the bin", stateId: backlog.id });
    await f.platform.workItem.update({ where: { id }, data: { deletedAt: new Date() } });
    await expect(removeProjectStage(ownerCtx(), p, backlog.id, null)).rejects.toMatchObject({ code: "STAGE_IN_BIN" });
  });
});
