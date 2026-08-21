import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { DomainError } from "@/lib/domain-error";
import { setupTenant } from "@/members/dbtest-fixture";
import {
  changeState,
  createItem,
  deleteItem,
  listItems,
  moveItem,
  projectWorkVersion,
  rebalanceProjectRanks,
} from "./index";

/**
 * Ordering (ARC-17) against the real database and the real app_runtime
 * role: anchor semantics (after / before / bottom), a board drop as
 * state + rank in one transaction through the state machine, concurrent
 * drops into ONE gap (unique ranks, intent preserved), stale anchors,
 * scoping, the rebalance, a column-targeted create, and the freshness
 * token.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let clientId: string;
let projectId: string;
let otherProjectId: string;

beforeAll(async () => {
  f = await setupTenant("ordering");
  clientId = randomUUID();
  projectId = randomUUID();
  otherProjectId = randomUUID();
  await f.platform.client.create({ data: { id: clientId, tenantId: f.tenantId, name: "Acme" } });
  await f.platform.project.create({
    data: { id: projectId, tenantId: f.tenantId, clientId, key: "ORD", name: "Ordering" },
  });
  await f.platform.project.create({
    data: { id: otherProjectId, tenantId: f.tenantId, clientId, key: "OTH", name: "Other" },
  });
}, 60_000);

afterAll(async () => {
  const db = f.platform;
  await db.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItem.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
  await db.memberClient.deleteMany({ where: { tenantId: f.tenantId } });
  await db.project.deleteMany({ where: { tenantId: f.tenantId } });
  await db.client.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 60_000);

const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const employeeCtx = () => ({ tenantId: f.tenantId, actor: f.seats.employee.actor });

/** Project order as the board/backlog read it: ids by rank. */
const order = async (pid = projectId): Promise<string[]> => {
  const rows = await f.platform.workItem.findMany({
    where: { tenantId: f.tenantId, projectId: pid, deletedAt: null },
    orderBy: { rank: "asc" },
    select: { id: true, rank: true },
  });
  // The unique index is one belt; the read is the other.
  expect(new Set(rows.map((r) => r.rank)).size).toBe(rows.length);
  return rows.map((r) => r.id);
};

const stateOf = async (category: "BACKLOG" | "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED" | "TRIAGE") =>
  f.platform.workflowState.findFirstOrThrow({
    where: { tenantId: f.tenantId, projectId, category },
  });

describe("moveItem: anchors", () => {
  it("after / before / bottom land exactly where the names say; a no-op move rewrites nothing", async () => {
    const ids: string[] = [];
    for (const title of ["A", "B", "C", "D"]) {
      ids.push((await createItem(ownerCtx(), { projectId, title })).id);
    }
    const [a, b, c, d] = ids as [string, string, string, string];
    expect(await order()).toEqual([a, b, c, d]);

    // D after A → A D B C
    await moveItem(ownerCtx(), { itemId: d, afterId: a });
    expect(await order()).toEqual([a, d, b, c]);

    // A before C → D B A C
    await moveItem(ownerCtx(), { itemId: a, beforeId: c });
    expect(await order()).toEqual([d, b, a, c]);

    // B, no anchor → bottom: D A C B
    await moveItem(ownerCtx(), { itemId: b });
    expect(await order()).toEqual([d, a, c, b]);

    // "after D" when already directly after D: rank untouched.
    const before = await f.platform.workItem.findUniqueOrThrow({ where: { id: a }, select: { rank: true, updatedAt: true } });
    await moveItem(ownerCtx(), { itemId: a, afterId: d });
    const after = await f.platform.workItem.findUniqueOrThrow({ where: { id: a }, select: { rank: true, updatedAt: true } });
    expect(after.rank).toBe(before.rank);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(await order()).toEqual([d, a, c, b]);

    // After yourself is no anchor either.
    await moveItem(ownerCtx(), { itemId: c, afterId: c });
    expect(await order()).toEqual([d, a, c, b]);
  });

  it("a board drop is state + rank in ONE call through the state machine (stamps, activity, audit)", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Drop me" });
    const inProgress = await stateOf("IN_PROGRESS");
    const first = (await order())[0]!;
    const moved = await moveItem(ownerCtx(), { itemId: id, stateId: inProgress.id, beforeId: first });
    expect(moved.stateCategory).toBe("IN_PROGRESS");
    expect(moved.stateId).toBe(inProgress.id);
    expect((await order())[0]).toBe(id);
    const row = await f.platform.workItem.findUniqueOrThrow({ where: { id } });
    expect(row.stateCategory).toBe("IN_PROGRESS");
    expect(row.startedAt).not.toBeNull();
    const activity = await f.platform.workItemActivity.findMany({
      where: { tenantId: f.tenantId, workItemId: id, field: "stateCategory" },
    });
    expect(activity).toHaveLength(1);
    const audits = await f.audits("work_item.state_changed");
    expect(audits.some((e) => e.targetId === id)).toBe(true);
  });

  it("a stale anchor (deleted, or another project's item) is INVALID_INPUT; another project's state is NOT_FOUND", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Stale" });
    const { id: foreign } = await createItem(ownerCtx(), { projectId: otherProjectId, title: "Foreign" });
    await expect(moveItem(ownerCtx(), { itemId: id, afterId: foreign })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    } satisfies Partial<DomainError>);
    await expect(moveItem(ownerCtx(), { itemId: id, beforeId: randomUUID() })).rejects.toBeInstanceOf(DomainError);
    const foreignState = await f.platform.workflowState.findFirstOrThrow({
      where: { tenantId: f.tenantId, projectId: otherProjectId, category: "DONE" },
    });
    await expect(moveItem(ownerCtx(), { itemId: id, stateId: foreignState.id })).rejects.toMatchObject({
      reason: "NOT_FOUND",
    } satisfies Partial<AuthzError>);
  });

  it("an employee without an assignment cannot move (NOT_FOUND, never FORBIDDEN)", async () => {
    const ids = await order();
    await expect(moveItem(employeeCtx(), { itemId: ids[0]!, afterId: ids[1]! })).rejects.toMatchObject({
      reason: "NOT_FOUND",
    } satisfies Partial<AuthzError>);
  });
});

describe("moveItem: soft-deleted rows keep their slot (review 2026-08-21)", () => {
  it("a move into the gap a deleted item held, a create after the deleted bottom row, and a rebalance with tombstones all succeed", async () => {
    const a = (await createItem(ownerCtx(), { projectId, title: "Tomb A" })).id;
    const b = (await createItem(ownerCtx(), { projectId, title: "Tomb B" })).id;
    const c = (await createItem(ownerCtx(), { projectId, title: "Tomb C" })).id;
    await deleteItem(ownerCtx(), b); // soft: the row keeps its rank under the unique index
    // C directly after A: the only free key is on the far side of B's tombstone.
    await moveItem(ownerCtx(), { itemId: c, afterId: a });
    const live = await order();
    expect(live.indexOf(c)).toBe(live.indexOf(a) + 1);
    // The deleted row is not a legal anchor for the client.
    await expect(moveItem(ownerCtx(), { itemId: a, afterId: b })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    } satisfies Partial<DomainError>);
    // Delete the bottom row, then create: the new row lands after the tombstone's key.
    const last = (await order()).at(-1)!;
    await deleteItem(ownerCtx(), last);
    const { id: fresh } = await createItem(ownerCtx(), { projectId, title: "After a tombstone" });
    expect((await order()).at(-1)).toBe(fresh);
    // A rebalance rewrites tombstones too, so every rank — live or not — stays unique.
    await rebalanceProjectRanks(ownerCtx(), projectId);
    const all = await f.platform.workItem.findMany({
      where: { tenantId: f.tenantId, projectId },
      select: { id: true, rank: true, deletedAt: true },
      orderBy: { rank: "asc" },
    });
    expect(new Set(all.map((r) => r.rank)).size).toBe(all.length);
    expect(all.some((r) => r.deletedAt !== null)).toBe(true);
  });
});

describe("moveItem: anchors, finer points", () => {
  it("after wins when both anchors are given; in-place + state change flips the state and leaves the rank alone", async () => {
    const ids = await order();
    const [x, y, z] = [ids[0]!, ids[1]!, ids[2]!];
    await moveItem(ownerCtx(), { itemId: z, afterId: x, beforeId: y });
    const after = await order();
    expect(after.indexOf(z)).toBe(after.indexOf(x) + 1);

    const done = await stateOf("DONE");
    const before = await f.platform.workItem.findUniqueOrThrow({ where: { id: z }, select: { rank: true } });
    const moved = await moveItem(ownerCtx(), { itemId: z, afterId: x, stateId: done.id });
    const row = await f.platform.workItem.findUniqueOrThrow({ where: { id: z }, select: { rank: true, stateId: true, completedAt: true } });
    expect(row.rank).toBe(before.rank);
    expect(row.stateId).toBe(done.id);
    expect(row.completedAt).not.toBeNull();
    expect(moved.stateCategory).toBe("DONE");
  });

  it("a drop into an EMPTY column keeps the place in the project order (self anchor) — never 'bottom of the project'", async () => {
    const ids = await order();
    const first = ids[0]!;
    const cancelled = await stateOf("CANCELLED");
    const moved = await moveItem(ownerCtx(), { itemId: first, stateId: cancelled.id, afterId: first });
    expect(moved.stateCategory).toBe("CANCELLED");
    expect((await order())[0]).toBe(first);
  });

  it("a key longer than 50 chars triggers the inline rebalance: order kept, keys short, audited once, flagged in the result", async () => {
    const x = (await createItem(ownerCtx(), { projectId: otherProjectId, title: "X" })).id;
    const y = (await createItem(ownerCtx(), { projectId: otherProjectId, title: "Y" })).id;
    const z = (await createItem(ownerCtx(), { projectId: otherProjectId, title: "Z" })).id;
    const xr = (await f.platform.workItem.findUniqueOrThrow({ where: { id: x }, select: { rank: true } })).rank;
    // Y directly after X with a pathologically long key, so the key BETWEEN X and Y is > 50 chars.
    await f.platform.workItem.update({ where: { id: y }, data: { rank: `${xr}${"0".repeat(50)}V` } });
    const moved = await moveItem(ownerCtx(), { itemId: z, afterId: x });
    expect(moved.rebalanced).toBe(true);
    // Relative order of the three (the project may hold rows from earlier tests).
    const three = new Set([x, y, z]);
    expect((await order(otherProjectId)).filter((id) => three.has(id))).toEqual([x, z, y]);
    const rows = await f.platform.workItem.findMany({
      where: { tenantId: f.tenantId, projectId: otherProjectId },
      select: { rank: true },
    });
    expect(Math.max(...rows.map((r) => r.rank.length))).toBeLessThan(10);
    const audits = await f.audits("work_item.bulk_edited");
    expect(audits.filter((e) => e.targetId === otherProjectId)).toHaveLength(1);
  });
});

describe("moveItem: concurrency", () => {
  it("12 concurrent drops into the same gap all land directly after the anchor with unique ranks", async () => {
    const anchor = (await createItem(ownerCtx(), { projectId, title: "Anchor" })).id;
    const tail = (await createItem(ownerCtx(), { projectId, title: "Tail" })).id;
    const movers: string[] = [];
    for (let i = 0; i < 12; i++) {
      movers.push((await createItem(ownerCtx(), { projectId, title: `Mover ${i}` })).id);
    }
    // Everyone drops "after Anchor" at once — the FOR UPDATE on the
    // anchor serialises them; the unique index + retry catch the rest.
    await Promise.all(movers.map((itemId) => moveItem(ownerCtx(), { itemId, afterId: anchor })));
    const ids = await order();
    const a = ids.indexOf(anchor);
    const between = ids.slice(a + 1, a + 1 + movers.length);
    expect(new Set(between)).toEqual(new Set(movers));
    // Tail was created after the movers and stays after all of them.
    expect(ids.indexOf(tail)).toBeGreaterThan(a + movers.length);
  });

  it("concurrent drops with NO shared anchor (bottom of the project) still end with unique ranks", async () => {
    const movers: string[] = [];
    for (let i = 0; i < 8; i++) {
      movers.push((await createItem(ownerCtx(), { projectId, title: `Bottom ${i}` })).id);
    }
    const first = (await order())[0]!;
    // Park them at the top first so "bottom" is a real move for each.
    for (const itemId of movers) await moveItem(ownerCtx(), { itemId, beforeId: first });
    await Promise.all(movers.map((itemId) => moveItem(ownerCtx(), { itemId })));
    const ids = await order();
    expect(new Set(ids.slice(-movers.length))).toEqual(new Set(movers));
  });
});

describe("rebalance + column create + freshness", () => {
  it("rebalanceProjectRanks keeps the order, shortens every key and audits once", async () => {
    const before = await order();
    const auditsBefore = (await f.audits("work_item.bulk_edited")).filter((e) => e.targetId === projectId).length;
    // Force a long key the way the hot path would see it.
    const victim = before.at(-1)!;
    await f.platform.workItem.update({
      where: { id: victim },
      data: { rank: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" },
    });
    const { count } = await rebalanceProjectRanks(ownerCtx(), projectId);
    // Every row of the project is rewritten — live AND soft-deleted (they share the index).
    const total = await f.platform.workItem.count({ where: { tenantId: f.tenantId, projectId } });
    expect(count).toBe(total);
    expect(total).toBeGreaterThanOrEqual(before.length);
    expect(await order()).toEqual(before);
    const rows = await f.platform.workItem.findMany({
      where: { tenantId: f.tenantId, projectId, deletedAt: null },
      select: { rank: true },
    });
    expect(Math.max(...rows.map((r) => r.rank.length))).toBeLessThan(10);
    const audits = await f.audits("work_item.bulk_edited");
    expect(audits.filter((e) => e.targetId === projectId)).toHaveLength(auditsBefore + 1);
  });

  it("createItem with a stateId lands in that column THROUGH the state machine (stamps + history); a foreign state is NOT_FOUND", async () => {
    const done = await stateOf("DONE");
    const { id } = await createItem(ownerCtx(), { projectId, title: "Straight to done", stateId: done.id });
    const row = await f.platform.workItem.findUniqueOrThrow({ where: { id } });
    expect(row.stateId).toBe(done.id);
    expect(row.stateCategory).toBe("DONE");
    expect(row.completedAt).not.toBeNull();
    const history = await f.platform.workItemActivity.findMany({
      where: { tenantId: f.tenantId, workItemId: id },
      select: { field: true },
    });
    expect(history.map((h) => h.field).sort()).toEqual(["created", "stateCategory"]);
    const foreignState = await f.platform.workflowState.findFirstOrThrow({
      where: { tenantId: f.tenantId, projectId: otherProjectId, category: "DONE" },
    });
    await expect(
      createItem(ownerCtx(), { projectId, title: "Nope", stateId: foreignState.id }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" } satisfies Partial<AuthzError>);
  });

  it("projectWorkVersion changes on a move and on a state change; the employee out of scope gets NOT_FOUND", async () => {
    const v0 = await projectWorkVersion(ownerCtx(), projectId);
    const ids = await order();
    await moveItem(ownerCtx(), { itemId: ids[0]!, afterId: ids[1]! });
    const v1 = await projectWorkVersion(ownerCtx(), projectId);
    expect(v1).not.toBe(v0);
    const done = await stateOf("DONE");
    await changeState(ownerCtx(), ids[2]!, done.id);
    const v2 = await projectWorkVersion(ownerCtx(), projectId);
    expect(v2).not.toBe(v1);
    await expect(projectWorkVersion(employeeCtx(), projectId)).rejects.toMatchObject({
      reason: "NOT_FOUND",
    } satisfies Partial<AuthzError>);
    // The list the board renders carries the hierarchy + wip columns the lanes need.
    const list = await listItems(ownerCtx(), projectId);
    expect(list.items.every((i) => typeof i.rootId === "string")).toBe(true);
    expect(list.states.every((s) => "wipLimit" in s)).toBe(true);
  });
});
