import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MemberActor } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { ranksBetween } from "@/lib/rank";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";

import {
  assignItem,
  assignItemToContact,
  changeItemVisibility,
  createItem,
  createLabel,
  deleteItem,
  restoreDeletedItem,
  setItemArchived,
  setItemLabel,
  setItemRepeat,
} from "./index";
import { readItemRepeat } from "./repeat";
import { copyOne, makeRepeatCopies } from "./repeat-copies";
import { createRequest } from "./requests";

/**
 * REPEATING TASKS (slice 127, founder decision C103) against the real
 * schema, the real `app_runtime` role, the real triggers and a real contact
 * principal: who may set a repeat and what is refused; what a copy IS — the
 * newest task's title, unticked description, labels, estimate and subtasks,
 * always PRIVATE (C103 (f)), where new tasks start, due the day before the
 * next copy (C103 (d)), given to whoever held it only if they can still take
 * it (C103 (c)); ONE copy for the latest day (§3.5); the series moving onto
 * the copy; what waits (a deleted holder, a closed project) and what does
 * not (an archived holder); two kicks at once; and the database's belts
 * (the UNIQUE per day, the anchor CHECK, `portal_deny`).
 *
 * Tenant slugs come from `setupTenant("repeat")`; the prefix `repeat-` is
 * registered in `DBTEST_PREFIXES` (e2e/fixtures/seed-cli.ts).
 */

const run = randomUUID().slice(0, 8);
const LONG = 240_000;

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let beta: string;
/** Acme's project, portal on. */
let pOn: string;
/** Carol — ACTIVE, CONTACT_PRIMARY, of acme. */
let carol: string;
/** `work_item:view` + `work_item:edit` only — no `work_item:create`. */
let editOnly: { memberId: string; actor: MemberActor };
/** `work_item:view` + edit + create, scoped to BETA only — acme's tasks are out of its reach. */
let betaSeat: { memberId: string; actor: MemberActor };
const extraUserIds: string[] = [];

/** 10 November 2026, 11:00 in Stockholm — the workspace's zone (the dbtest tenant's default). */
const NOW = new Date("2026-11-10T10:00:00Z");
const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const ctxOf = (actor: MemberActor) => ({ tenantId: f.tenantId, actor });
const sys = <T>(fn: (tx: TenantDb) => Promise<T>) => withTenant(f.tenantId, { type: "system" }, fn);
const copyFor = (seriesId: string, today: string) => sys((tx) => copyOne(tx, f.tenantId, seriesId, today));
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

async function task(title: string, opts: { parentId?: string } = {}): Promise<{ id: string; number: number }> {
  const { id, number } = await createItem(ownerCtx(), {
    projectId: pOn,
    title: `${title} ${run}`,
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
  });
  return { id, number };
}

const seriesOf = (workItemId: string) =>
  f.platform.workItemRepeat.findFirst({ where: { tenantId: f.tenantId, workItemId } });

/** Start a repeat and plant its next day where the test wants it — the service only takes days after today. */
async function repeating(
  itemId: string,
  rhythm: "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY",
  nextOn: string,
): Promise<string> {
  await setItemRepeat(ownerCtx(), itemId, { rhythm }, NOW);
  const s = await seriesOf(itemId);
  const anchor = rhythm === "WEEKLY" || rhythm === "BIWEEKLY" ? null : Number(nextOn.slice(8, 10));
  await f.platform.workItemRepeat.update({ where: { id: s!.id }, data: { nextOn: at(nextOn), anchorDay: anchor } });
  return s!.id;
}

const checklist = (checked: boolean) => ({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Send the monthly report" }] },
    {
      type: "taskList",
      content: [
        { type: "taskItem", attrs: { checked }, content: [{ type: "paragraph", content: [{ type: "text", text: "Pull the numbers" }] }] },
        { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Write it up" }] }] },
      ],
    },
  ],
});

/** The constraint a raw write broke, read off the error's `meta` — never its message (the Prisma code-frame trap). */
async function brokenConstraint(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return JSON.stringify((e as { meta?: unknown }).meta ?? "");
  }
  throw new Error("expected the database to refuse");
}

/** `n` subtasks planted under `parentId` in one statement, with REAL order keys after the project's last. */
async function plantSubtasks(parentId: string, n: number, description?: (i: number) => object | null): Promise<string[]> {
  const state = await f.platform.workflowState.findFirstOrThrow({ where: { tenantId: f.tenantId, projectId: pOn, isDefault: true } });
  const parent = await f.platform.workItem.findUniqueOrThrow({ where: { id: parentId }, select: { clientId: true } });
  const last = await f.platform.workItem.findFirst({ where: { tenantId: f.tenantId, projectId: pOn }, orderBy: { rank: "desc" }, select: { rank: true } });
  const top = await f.platform.workItem.findFirst({ where: { tenantId: f.tenantId, projectId: pOn }, orderBy: { number: "desc" }, select: { number: true } });
  const keys = ranksBetween(last?.rank ?? null, null, n);
  const ids = Array.from({ length: n }, () => randomUUID());
  await f.platform.workItem.createMany({
    data: ids.map((id, i) => {
      const doc = description?.(i) ?? null;
      return {
        id,
        tenantId: f.tenantId,
        clientId: parent.clientId,
        projectId: pOn,
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

async function seat(label: string, codes: string[], scope: { clientId?: string } = {}) {
  const userId = randomUUID();
  const email = `repeat-${label}-${run}@test.invalid`;
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
  f = await setupTenant("repeat");
  acme = randomUUID();
  beta = randomUUID();
  pOn = randomUUID();
  carol = randomUUID();
  const up = run.slice(0, 3).toUpperCase();
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: `Acme ${run}` },
      { id: beta, tenantId: f.tenantId, name: `Beta ${run}` },
    ],
  });
  await f.platform.project.create({
    data: { id: pOn, tenantId: f.tenantId, clientId: acme, key: `RPA${up}`, name: `Site ${run}`, portalEnabled: true },
  });
  await f.platform.contact.create({
    data: {
      id: carol,
      tenantId: f.tenantId,
      clientId: acme,
      name: "Carol",
      email: `repeat-carol-${run}@test.invalid`,
      portalProfile: "CONTACT_PRIMARY",
      portalStatus: "ACTIVE",
      invitedAt: new Date("2026-09-01T09:00:00Z"),
      emailVerified: true,
    },
  });
  editOnly = await seat("editonly", ["work_item:view", "work_item:edit"], { clientId: acme });
  betaSeat = await seat("beta", ["work_item:view", "work_item:edit", "work_item:create"], { clientId: beta });
  // The EMPLOYEE reaches acme: the assignee who CAN take a copy.
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
  // The series and their tasks cascade from `work_item`.
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

describe("setting a repeat (setItemRepeat)", () => {
  it("starts one period from today in the workspace's zone, and records it", async () => {
    const { id } = await task("Starts");
    const r = await setItemRepeat(ownerCtx(), id, { rhythm: "MONTHLY" }, NOW);
    expect(r).toEqual({ rhythm: "MONTHLY", nextOn: "2026-12-10", changed: true });
    const s = await seriesOf(id);
    expect(s).toMatchObject({ rhythm: "MONTHLY", anchorDay: 10, createdByMemberId: f.seats.owner.memberId });
    expect(day(s!.nextOn)).toBe("2026-12-10");
    const member = await f.platform.workItemRepeatItem.findFirst({ where: { tenantId: f.tenantId, workItemId: id } });
    expect(member).toMatchObject({ repeatId: s!.id, madeFor: null });
    const history = await f.platform.workItemActivity.findMany({ where: { tenantId: f.tenantId, workItemId: id, field: "repeat" } });
    expect(history).toEqual([expect.objectContaining({ oldValue: null, newValue: "MONTHLY:2026-12-10", visibility: "INTERNAL" })]);
    const audit = (await f.audits("work_item.repeat_changed")).filter((a) => a.targetId === id);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ from: null, to: { rhythm: "MONTHLY", nextOn: "2026-12-10" } });
    // The same again changes nothing, and writes nothing.
    expect(await setItemRepeat(ownerCtx(), id, { rhythm: "MONTHLY" }, NOW)).toEqual({ rhythm: "MONTHLY", nextOn: "2026-12-10", changed: false });
    expect(await f.audits("work_item.repeat_changed").then((a) => a.filter((x) => x.targetId === id))).toHaveLength(1);
  }, LONG);

  it("a rhythm change keeps the day; a new day re-anchors; Stop deletes the series", async () => {
    const { id } = await task("Changes");
    await setItemRepeat(ownerCtx(), id, { rhythm: "MONTHLY" }, NOW);
    expect(await setItemRepeat(ownerCtx(), id, { rhythm: "WEEKLY" }, NOW)).toEqual({ rhythm: "WEEKLY", nextOn: "2026-12-10", changed: true });
    expect(await seriesOf(id)).toMatchObject({ rhythm: "WEEKLY", anchorDay: null });
    await setItemRepeat(ownerCtx(), id, { rhythm: "MONTHLY" }, NOW);
    expect(await setItemRepeat(ownerCtx(), id, { nextOn: "2026-12-31" }, NOW)).toEqual({ rhythm: "MONTHLY", nextOn: "2026-12-31", changed: true });
    expect(await seriesOf(id)).toMatchObject({ anchorDay: 31 });
    expect(await setItemRepeat(ownerCtx(), id, null, NOW)).toEqual({ rhythm: null, nextOn: null, changed: true });
    expect(await seriesOf(id)).toBeNull();
    expect(await f.platform.workItemRepeatItem.count({ where: { tenantId: f.tenantId, workItemId: id } })).toBe(0);
    const last = await f.platform.workItemActivity.findFirst({
      where: { tenantId: f.tenantId, workItemId: id, field: "repeat" },
      orderBy: { id: "desc" },
    });
    expect(last).toMatchObject({ oldValue: "MONTHLY:2026-12-31", newValue: null });
    // Stopping what does not repeat changes nothing.
    expect(await setItemRepeat(ownerCtx(), id, null, NOW)).toEqual({ rhythm: null, nextOn: null, changed: false });
  }, LONG);

  it("refuses a day not after today or more than two years ahead, and a day with no rhythm", async () => {
    const { id } = await task("Bounds");
    await expect(setItemRepeat(ownerCtx(), id, { nextOn: "2026-12-01" }, NOW)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await setItemRepeat(ownerCtx(), id, { rhythm: "YEARLY" }, NOW);
    await expect(setItemRepeat(ownerCtx(), id, { nextOn: "2026-11-10" }, NOW)).rejects.toMatchObject({ code: "REPEAT_DAY_INVALID" });
    await expect(setItemRepeat(ownerCtx(), id, { nextOn: "2026-11-09" }, NOW)).rejects.toMatchObject({ code: "REPEAT_DAY_INVALID" });
    await expect(setItemRepeat(ownerCtx(), id, { nextOn: "2028-11-11" }, NOW)).rejects.toMatchObject({ code: "REPEAT_DAY_INVALID" });
    expect((await setItemRepeat(ownerCtx(), id, { nextOn: "2028-11-10" }, NOW)).nextOn).toBe("2028-11-10");
  }, LONG);

  it("asks work_item:create as well as edit, and the task's scope", async () => {
    const { id } = await task("Gates");
    await expect(setItemRepeat(ctxOf(editOnly.actor), id, { rhythm: "WEEKLY" }, NOW)).rejects.toBeInstanceOf(AuthzError);
    await expect(setItemRepeat(ctxOf(betaSeat.actor), id, { rhythm: "WEEKLY" }, NOW)).rejects.toBeInstanceOf(AuthzError);
    expect(await seriesOf(id)).toBeNull();
    // The employee template holds both and reaches acme.
    expect((await setItemRepeat(ctxOf(f.seats.employee.actor), id, { rhythm: "WEEKLY" }, NOW)).changed).toBe(true);
  }, LONG);

  it("refuses a client's request, and a task with more than 100 tasks under it", async () => {
    const req = await sys((tx) =>
      createRequest(tx, f.tenantId, { projectId: pOn, title: `Asked ${run}`, body: null, reportedByContactId: carol }),
    );
    await expect(setItemRepeat(ownerCtx(), req.id, { rhythm: "WEEKLY" }, NOW)).rejects.toMatchObject({ code: "REPEAT_NOT_ALLOWED" });

    const big = await task("Big");
    const state = await f.platform.workflowState.findFirstOrThrow({ where: { tenantId: f.tenantId, projectId: pOn, isDefault: true } });
    const holder = await f.platform.workItem.findUniqueOrThrow({ where: { id: big.id }, select: { clientId: true } });
    // REAL order keys after the project's last: a made-up key poisons every
    // later bottom-of-project create ("invalid order key").
    const last = await f.platform.workItem.findFirst({ where: { tenantId: f.tenantId, projectId: pOn }, orderBy: { rank: "desc" }, select: { rank: true } });
    const keys = ranksBetween(last?.rank ?? null, null, 101);
    await f.platform.workItem.createMany({
      data: Array.from({ length: 101 }, (_, i) => {
        const sid = randomUUID();
        return {
          id: sid,
          tenantId: f.tenantId,
          clientId: holder.clientId,
          projectId: pOn,
          number: 900_000 + i,
          type: "SUBTASK" as const,
          title: `Under ${i} ${run}`,
          stateId: state.id,
          stateCategory: state.category,
          parentId: big.id,
          rootId: sid,
          rank: keys[i]!,
        };
      }),
    });
    await expect(setItemRepeat(ownerCtx(), big.id, { rhythm: "WEEKLY" }, NOW)).rejects.toMatchObject({ code: "REPEAT_TOO_BIG" });
    // One fewer is fine.
    await f.platform.workItem.update({ where: { tenantId_projectId_number: { tenantId: f.tenantId, projectId: pOn, number: 900_100 } }, data: { deletedAt: new Date() } });
    expect((await setItemRepeat(ownerCtx(), big.id, { rhythm: "WEEKLY" }, NOW)).changed).toBe(true);
    await setItemRepeat(ownerCtx(), big.id, null, NOW);
  }, LONG);
});

describe("the pre-apply review's rules", () => {
  it("refuses a repeat inside a repeating task, and around one (M2)", async () => {
    const outer = await task("Outer");
    const inner = await task("Inner", { parentId: outer.id });
    await setItemRepeat(ownerCtx(), outer.id, { rhythm: "MONTHLY" }, NOW);
    await expect(setItemRepeat(ownerCtx(), inner.id, { rhythm: "WEEKLY" }, NOW)).rejects.toMatchObject({ code: "REPEAT_NESTED" });
    await setItemRepeat(ownerCtx(), outer.id, null, NOW);
    await setItemRepeat(ownerCtx(), inner.id, { rhythm: "WEEKLY" }, NOW);
    await expect(setItemRepeat(ownerCtx(), outer.id, { rhythm: "MONTHLY" }, NOW)).rejects.toMatchObject({ code: "REPEAT_NESTED" });
    await setItemRepeat(ownerCtx(), inner.id, null, NOW);
  }, LONG);

  it("lets an older copy stop its series only while the newest is deleted (M3)", async () => {
    const first = await task("Stranded");
    const seriesId = await repeating(first.id, "WEEKLY", "2026-12-07");
    const made = await copyFor(seriesId, "2026-12-07");
    await expect(setItemRepeat(ownerCtx(), first.id, null, NOW)).rejects.toMatchObject({ code: "REPEAT_NOT_NEWEST" });
    await deleteItem(ownerCtx(), made!.copyId);
    expect(await sys((tx) => readItemRepeat(tx, f.tenantId, { id: first.id, projectId: pOn }))).toMatchObject({
      role: "copy",
      holderDeleted: true,
    });
    // Only a stop: not a new rhythm.
    await expect(setItemRepeat(ownerCtx(), first.id, { rhythm: "MONTHLY" }, NOW)).rejects.toMatchObject({ code: "REPEAT_NOT_NEWEST" });
    expect(await setItemRepeat(ownerCtx(), first.id, null, NOW)).toEqual({ rhythm: null, nextOn: null, changed: true });
    expect(await f.platform.workItemRepeat.count({ where: { id: seriesId } })).toBe(0);
    expect(await sys((tx) => readItemRepeat(tx, f.tenantId, { id: first.id, projectId: pOn }))).toBeNull();
    const audit = (await f.audits("work_item.repeat_changed")).filter((a) => a.targetId === first.id).at(-1);
    expect(audit!.metadata).toMatchObject({ to: null, newestId: made!.copyId, newestDeleted: true });
  }, LONG);

  it("moves on past a day already copied rather than failing on it every kick (L3)", async () => {
    const { id } = await task("Already");
    const seriesId = await repeating(id, "WEEKLY", "2026-12-14");
    const elsewhere = await task("Made that day");
    await f.platform.workItemRepeatItem.create({ data: { tenantId: f.tenantId, repeatId: seriesId, workItemId: elsewhere.id, madeFor: at("2026-12-14") } });
    expect(await copyFor(seriesId, "2026-12-14")).toBeNull();
    const s = await f.platform.workItemRepeat.findUniqueOrThrow({ where: { id: seriesId } });
    expect(s.workItemId).toBe(id);
    expect(day(s.nextOn)).toBe("2026-12-21");
    // That move is audited (the reviews' NIT): it is the one no copy carries.
    const moved = (await f.audits("work_item.repeat_changed")).filter((a) => a.targetId === id).at(-1);
    expect(moved).toMatchObject({ actorType: "SYSTEM" });
    expect(moved!.metadata).toMatchObject({ reason: "day_already_made", madeFor: "2026-12-14", to: { nextOn: "2026-12-21" } });
    await setItemRepeat(ownerCtx(), id, null, NOW);
  }, LONG);

  it("anchors a month rhythm on the day it was started, and keeps it between month rhythms (L2)", async () => {
    const { id } = await task("End of month");
    const jan31 = new Date("2027-01-31T10:00:00Z");
    expect(await setItemRepeat(ownerCtx(), id, { rhythm: "MONTHLY" }, jan31)).toMatchObject({ nextOn: "2027-02-28" });
    expect(await seriesOf(id)).toMatchObject({ anchorDay: 31 });
    expect(await setItemRepeat(ownerCtx(), id, { rhythm: "QUARTERLY" }, jan31)).toMatchObject({ nextOn: "2027-02-28" });
    expect(await seriesOf(id)).toMatchObject({ anchorDay: 31 });
    // And the copier lands on the 31st again after the short month.
    const seriesId = (await seriesOf(id))!.id;
    await setItemRepeat(ownerCtx(), id, { rhythm: "MONTHLY" }, jan31);
    await copyFor(seriesId, "2027-02-28");
    expect(day((await f.platform.workItemRepeat.findUniqueOrThrow({ where: { id: seriesId } })).nextOn)).toBe("2027-03-31");
    const holder = (await f.platform.workItemRepeat.findUniqueOrThrow({ where: { id: seriesId } })).workItemId;
    await setItemRepeat(ownerCtx(), holder, null, NOW);
  }, LONG);

  it("makes no copies in a paused project (L1)", async () => {
    const { id } = await task("Paused");
    const seriesId = await repeating(id, "WEEKLY", "2026-12-21");
    await f.platform.project.update({ where: { id: pOn }, data: { status: "PAUSED" } });
    try {
      expect(await copyFor(seriesId, "2026-12-21")).toBeNull();
      expect(await sys((tx) => readItemRepeat(tx, f.tenantId, { id, projectId: pOn }))).toMatchObject({ projectClosed: true });
    } finally {
      await f.platform.project.update({ where: { id: pOn }, data: { status: "ACTIVE" } });
    }
    await setItemRepeat(ownerCtx(), id, null, NOW);
  }, LONG);
});

describe("the slice reviews' rules", () => {
  it("copies a repeating SUBTASK inside its task, after the project's last task", async () => {
    const parent = await task("Website care");
    const step = await task("Update plugins", { parentId: parent.id });
    const seriesId = await repeating(step.id, "MONTHLY", "2026-12-05");
    const bottom = await f.platform.workItem.findFirst({ where: { tenantId: f.tenantId, projectId: pOn }, orderBy: { rank: "desc" }, select: { rank: true } });
    const made = await copyFor(seriesId, "2026-12-05");
    const copy = await f.platform.workItem.findUniqueOrThrow({ where: { id: made!.copyId } });
    expect(copy).toMatchObject({ parentId: parent.id, type: "SUBTASK", visibility: "INTERNAL" });
    expect(copy.rank > bottom!.rank).toBe(true);
    await setItemRepeat(ownerCtx(), copy.id, null, NOW);
  }, LONG);

  it("leaves a task of another series out of a copy, with its children (the M2 belt)", async () => {
    const holder = await task("Outer belt");
    const plain = await task("Plain step", { parentId: holder.id });
    const other = await task("Other series' task", { parentId: holder.id });
    const seriesId = await repeating(holder.id, "WEEKLY", "2026-12-07");
    // Planted round the set-time refusal: `other` belongs to a series of its own.
    const otherSeries = randomUUID();
    await f.platform.workItemRepeat.create({
      data: { id: otherSeries, tenantId: f.tenantId, workItemId: other.id, rhythm: "WEEKLY", nextOn: at("2027-01-04") },
    });
    await f.platform.workItemRepeatItem.create({ data: { tenantId: f.tenantId, repeatId: otherSeries, workItemId: other.id, madeFor: null } });
    const made = await copyFor(seriesId, "2026-12-07");
    const children = await f.platform.workItem.findMany({ where: { tenantId: f.tenantId, parentId: made!.copyId }, select: { title: true } });
    expect(children.map((c) => c.title)).toEqual([`Plain step ${run}`]);
    void plain;
    await f.platform.workItemRepeat.delete({ where: { id: otherSeries } });
    await setItemRepeat(ownerCtx(), made!.copyId, null, NOW);
  }, LONG);

  it("cuts a tree past 100 tasks to 100 and leaves descriptions past the budget out — and refuses to start either", async () => {
    // ~99 KB each as stored JSON — under the description profile's 100 000
    // characters, so normalising keeps them: 21 fit in 2 MiB, 22 do not.
    const doc = () => bigDoc(99_000);
    // Refused at the start: too many descriptions' bytes.
    const heavy = await task("Heavy");
    await plantSubtasks(heavy.id, 22, doc);
    await expect(setItemRepeat(ownerCtx(), heavy.id, { rhythm: "WEEKLY" }, NOW)).rejects.toMatchObject({ code: "REPEAT_TOO_BIG" });

    // Grown past both after it started: the copy takes the first 100 and the
    // descriptions that fit, and its audit row says what it left out.
    const grown = await task("Grown");
    const seriesId = await repeating(grown.id, "WEEKLY", "2026-12-28");
    await plantSubtasks(grown.id, 101, (i) => (i < 22 ? doc() : null));
    const made = await copyFor(seriesId, "2026-12-28");
    expect(made!.subtasks).toBe(100);
    const audit = (await f.audits("work_item.created")).find((a) => a.targetId === made!.copyId);
    expect(audit!.metadata).toMatchObject({ leftOut: 1, descriptionsLeftOut: 1 });
    const [described] = await f.platform.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM work_item WHERE tenant_id = ${f.tenantId} AND parent_id = ${made!.copyId} AND description IS NOT NULL`;
    expect(described!.n).toBe(21);
    await setItemRepeat(ownerCtx(), made!.copyId, null, NOW);
  }, LONG);
});

describe("a copy (copyOne)", () => {
  it("is the newest task now — unticked, labelled, estimated, with its subtasks — PRIVATE, where new tasks start, due before the next", async () => {
    const holder = await task("Monthly report");
    await f.platform.workItem.update({
      where: { id: holder.id },
      data: { description: checklist(true), descriptionText: "Send the monthly report", checklistTotal: 2, checklistDone: 1, estimateMinutes: 90 },
    });
    const { label } = await createLabel(ownerCtx(), { name: `Routine ${run}` });
    await setItemLabel(ownerCtx(), holder.id, label.id, true);
    await assignItem(ownerCtx(), holder.id, f.seats.employee.memberId);
    await changeItemVisibility(ownerCtx(), holder.id, "CLIENT_VISIBLE");
    const kept = await task("Pull numbers", { parentId: holder.id });
    await assignItem(ownerCtx(), kept.id, f.seats.employee.memberId);
    const cancelled = await task("Old step", { parentId: holder.id });
    const cancelledState = await f.platform.workflowState.findFirstOrThrow({ where: { tenantId: f.tenantId, projectId: pOn, category: "CANCELLED" } });
    await f.platform.workItem.update({ where: { id: cancelled.id }, data: { stateId: cancelledState.id } });
    const gone = await task("Deleted step", { parentId: holder.id });
    await deleteItem(ownerCtx(), gone.id);
    // Archived this period: housekeeping — still a step of every later copy (L4).
    const filed = await task("Filed step", { parentId: holder.id });
    await setItemArchived(ownerCtx(), filed.id, true);
    const seriesId = await repeating(holder.id, "MONTHLY", "2026-12-01");

    // Not owed the day before.
    expect(await copyFor(seriesId, "2026-11-30")).toBeNull();
    const made = await copyFor(seriesId, "2026-12-01");
    expect(made).toMatchObject({ madeFor: "2026-12-01", subtasks: 2 });

    const start = await f.platform.workflowState.findFirstOrThrow({ where: { tenantId: f.tenantId, projectId: pOn, isDefault: true } });
    const copy = await f.platform.workItem.findUniqueOrThrow({ where: { id: made!.copyId }, include: { labels: true } });
    expect(copy).toMatchObject({
      title: `Monthly report ${run}`,
      visibility: "INTERNAL",
      stateId: start.id,
      estimateMinutes: 90,
      assigneeMemberId: f.seats.employee.memberId,
      createdByMemberId: null,
      parentId: null,
      checklistTotal: 2,
      checklistDone: 0,
      source: "IN_APP",
    });
    expect(day(copy.startDate)).toBe("2026-12-01");
    expect(day(copy.targetDate)).toBe("2026-12-31");
    expect(JSON.stringify(copy.description)).not.toContain('"checked":true');
    expect(copy.labels.map((l) => l.labelId)).toEqual([label.id]);

    const all = await f.platform.workItem.findMany({ where: { tenantId: f.tenantId, parentId: copy.id }, orderBy: { rank: "asc" } });
    expect(all.map((c) => [c.title, c.archivedAt])).toEqual([
      [`Pull numbers ${run}`, null],
      [`Filed step ${run}`, null],
    ]);
    const children = all.filter((c) => c.title === `Pull numbers ${run}`);
    expect(children[0]).toMatchObject({
      title: `Pull numbers ${run}`,
      visibility: "INTERNAL",
      assigneeMemberId: f.seats.employee.memberId,
      startDate: null,
      targetDate: null,
      stateId: start.id,
    });

    // The series moved onto the copy, its next day after it.
    const s = await f.platform.workItemRepeat.findUniqueOrThrow({ where: { id: seriesId } });
    expect(s.workItemId).toBe(copy.id);
    expect(day(s.nextOn)).toBe("2027-01-01");
    const members = await f.platform.workItemRepeatItem.findMany({ where: { tenantId: f.tenantId, repeatId: seriesId }, orderBy: { createdAt: "asc" } });
    expect(members.map((m) => [m.workItemId, day(m.madeFor)])).toEqual([
      [holder.id, null],
      [copy.id, "2026-12-01"],
    ]);

    // Told ONCE — the employee holds the copy and its subtask.
    const told = await f.platform.notification.findMany({
      where: { tenantId: f.tenantId, receiverId: f.seats.employee.memberId, kind: "work_item.assigned", entityId: { in: [copy.id, children[0]!.id] } },
    });
    expect(told).toEqual([expect.objectContaining({ entityId: copy.id, reason: "ASSIGNEE", actorId: null })]);

    // Audited as SYSTEM; history as System, all INTERNAL.
    const created = (await f.audits("work_item.created")).filter((a) => a.targetId === copy.id || a.targetId === children[0]!.id);
    expect(created).toHaveLength(2);
    for (const a of created) expect(a).toMatchObject({ actorType: "SYSTEM", actorId: null });
    expect(created.find((a) => a.targetId === copy.id)!.metadata).toMatchObject({
      repeatId: seriesId,
      repeatedFromId: holder.id,
      madeFor: "2026-12-01",
      visibility: "INTERNAL",
    });
    const history = await f.platform.workItemActivity.findMany({ where: { tenantId: f.tenantId, workItemId: { in: [copy.id, holder.id] }, field: { in: ["created", "repeatedFrom", "repeatCopied", "assignee"] }, createdAt: { gte: copy.createdAt } } });
    for (const h of history) expect(h).toMatchObject({ actorMemberId: null, actorContactId: null, visibility: "INTERNAL" });
    expect(history.find((h) => h.field === "repeatedFrom")).toMatchObject({ workItemId: copy.id, oldValue: String(holder.number) });
    expect(history.find((h) => h.field === "repeatCopied")).toMatchObject({ workItemId: holder.id, newValue: String(copy.number) });

    // The same day again: nothing owed.
    expect(await copyFor(seriesId, "2026-12-01")).toBeNull();
    expect(await f.platform.workItemRepeatItem.count({ where: { tenantId: f.tenantId, repeatId: seriesId } })).toBe(2);

    // The panel's read: the old task is a copy pointing at the newest; the newest holds it.
    const old = await sys((tx) => readItemRepeat(tx, f.tenantId, { id: holder.id, projectId: pOn }));
    expect(old).toEqual({ role: "copy", holderNumber: copy.number, holderDeleted: false });
    const fresh = await sys((tx) => readItemRepeat(tx, f.tenantId, { id: copy.id, projectId: pOn }));
    expect(fresh).toEqual({ role: "holder", rhythm: "MONTHLY", nextOn: "2027-01-01", projectClosed: false });
    // "Edit the newest one": the older copy refuses; Stop on the newest frees it.
    await expect(setItemRepeat(ownerCtx(), holder.id, { rhythm: "WEEKLY" }, NOW)).rejects.toMatchObject({ code: "REPEAT_NOT_NEWEST" });
    await setItemRepeat(ownerCtx(), copy.id, null, NOW);
    expect(await f.platform.workItemRepeatItem.count({ where: { tenantId: f.tenantId, repeatId: seriesId } })).toBe(0);
    expect((await setItemRepeat(ownerCtx(), holder.id, { rhythm: "WEEKLY" }, NOW)).changed).toBe(true);
    await setItemRepeat(ownerCtx(), holder.id, null, NOW);
  }, LONG);

  it("gives it to the same person only if they can still take it — never to a suspended member, one out of reach, or a client", async () => {
    // A member who later loses the workspace.
    const leaver = await seat("leaver", ["work_item:view", "work_item:edit"], { clientId: acme });
    const a = await task("Suspended's");
    await assignItem(ownerCtx(), a.id, leaver.memberId);
    await f.platform.member.update({ where: { id: leaver.memberId }, data: { status: "SUSPENDED" } });
    // A member who never reached this client (assignment checks ACTIVE only).
    const b = await task("Out of reach");
    await assignItem(ownerCtx(), b.id, betaSeat.memberId);
    // A task handed to the client's contact (so it is shared).
    const c = await task("Client's");
    await changeItemVisibility(ownerCtx(), c.id, "CLIENT_VISIBLE");
    await assignItemToContact(ownerCtx(), c.id, carol);

    for (const holder of [a, b, c]) {
      const seriesId = await repeating(holder.id, "WEEKLY", "2026-12-07");
      const made = await copyFor(seriesId, "2026-12-07");
      const copy = await f.platform.workItem.findUniqueOrThrow({ where: { id: made!.copyId } });
      expect(copy).toMatchObject({ assigneeMemberId: null, assigneeContactId: null, visibility: "INTERNAL" });
      expect(day(copy.targetDate)).toBe("2026-12-13");
      const audit = (await f.audits("work_item.created")).find((x) => x.targetId === copy.id);
      if (holder !== c) expect(audit!.metadata).toMatchObject({ assigneeDropped: true });
      await setItemRepeat(ownerCtx(), copy.id, null, NOW);
    }
  }, LONG);

  it("after a gap makes ONE copy, for the latest day — never a pile, never born late", async () => {
    const { id } = await task("Weekly check");
    const seriesId = await repeating(id, "WEEKLY", "2026-10-13");
    const made = await copyFor(seriesId, "2026-11-04");
    expect(made!.madeFor).toBe("2026-11-03");
    const copy = await f.platform.workItem.findUniqueOrThrow({ where: { id: made!.copyId } });
    expect(day(copy.targetDate)).toBe("2026-11-09");
    expect(day((await f.platform.workItemRepeat.findUniqueOrThrow({ where: { id: seriesId } })).nextOn)).toBe("2026-11-10");
    expect(await f.platform.workItemRepeatItem.count({ where: { tenantId: f.tenantId, repeatId: seriesId } })).toBe(2);
    await setItemRepeat(ownerCtx(), copy.id, null, NOW);
  }, LONG);

  it("waits while the task is deleted and comes back with it; still copies an archived task; makes none in an archived project", async () => {
    const { id } = await task("Waits");
    const seriesId = await repeating(id, "MONTHLY", "2026-12-15");
    const { deletedAt } = await deleteItem(ownerCtx(), id);
    expect(await copyFor(seriesId, "2026-12-15")).toBeNull();
    expect(day((await f.platform.workItemRepeat.findUniqueOrThrow({ where: { id: seriesId } })).nextOn)).toBe("2026-12-15");
    await restoreDeletedItem(ownerCtx(), id, "bin", deletedAt);

    await f.platform.project.update({ where: { id: pOn }, data: { archivedAt: new Date() } });
    try {
      expect(await sys((tx) => readItemRepeat(tx, f.tenantId, { id, projectId: pOn }))).toMatchObject({ projectClosed: true });
      expect(await copyFor(seriesId, "2026-12-15")).toBeNull();
    } finally {
      await f.platform.project.update({ where: { id: pOn }, data: { archivedAt: null } });
    }

    await setItemArchived(ownerCtx(), id, true);
    const made = await copyFor(seriesId, "2026-12-15");
    expect(made).not.toBeNull();
    const copy = await f.platform.workItem.findUniqueOrThrow({ where: { id: made!.copyId } });
    expect(copy.archivedAt).toBeNull();
    await setItemRepeat(ownerCtx(), copy.id, null, NOW);
  }, LONG);
});

describe("the database's belts", () => {
  it("refuses a second task for the same series and day, a month day off its anchor, and an unknown rhythm", async () => {
    const { id } = await task("Belts");
    const seriesId = await repeating(id, "MONTHLY", "2026-12-31");
    const other = await task("Belts other");
    await f.platform.workItemRepeatItem.create({ data: { tenantId: f.tenantId, repeatId: seriesId, workItemId: other.id, madeFor: at("2026-12-31") } });
    const third = await task("Belts third");
    await expect(
      f.platform.workItemRepeatItem.create({ data: { tenantId: f.tenantId, repeatId: seriesId, workItemId: third.id, madeFor: at("2026-12-31") } }),
    ).rejects.toMatchObject({ code: "P2002" });
    // A second task the repeat was "set on" (made_for NULL) is refused too.
    expect(
      await brokenConstraint(
        f.platform.workItemRepeatItem.create({ data: { tenantId: f.tenantId, repeatId: seriesId, workItemId: third.id, madeFor: null } }),
      ),
    ).toContain("work_item_repeat_item_one_origin");
    // On the 31st: 28 February is its month's last day (fine), the 27th is not.
    await f.platform.workItemRepeat.update({ where: { id: seriesId }, data: { nextOn: at("2027-02-28") } });
    expect(
      await brokenConstraint(f.platform.workItemRepeat.update({ where: { id: seriesId }, data: { nextOn: at("2027-02-27") } })),
    ).toContain("work_item_repeat_anchor_lands");
    expect(await brokenConstraint(f.platform.workItemRepeat.update({ where: { id: seriesId }, data: { rhythm: "DAILY" } }))).toContain(
      "work_item_repeat_rhythm_known",
    );
    // A week rhythm carries no anchor.
    expect(await brokenConstraint(f.platform.workItemRepeat.update({ where: { id: seriesId }, data: { rhythm: "WEEKLY" } }))).toContain(
      "work_item_repeat_anchor_shape",
    );
    await setItemRepeat(ownerCtx(), id, null, NOW);
  }, LONG);

  it("shows a contact neither table", async () => {
    const { id } = await task("Hidden");
    await changeItemVisibility(ownerCtx(), id, "CLIENT_VISIBLE");
    await setItemRepeat(ownerCtx(), id, { rhythm: "WEEKLY" }, NOW);
    const seen = await withTenant(f.tenantId, { type: "contact", id: carol, clientId: acme }, async (tx) => ({
      series: await tx.workItemRepeat.findMany({ select: { id: true } }),
      items: await tx.workItemRepeatItem.findMany({ select: { workItemId: true } }),
    }));
    expect(seen).toEqual({ series: [], items: [] });
    expect(await f.platform.workItemRepeat.count({ where: { tenantId: f.tenantId, workItemId: id } })).toBe(1);
    await setItemRepeat(ownerCtx(), id, null, NOW);
  }, LONG);
});

describe("the per-workspace run (makeRepeatCopies)", () => {
  it("decides today in the workspace's zone, and two kicks at once make ONE copy", async () => {
    // Only this test's series is due: every earlier test stopped its own.
    await f.platform.workItemRepeat.deleteMany({ where: { tenantId: f.tenantId } });
    const { id } = await task("Zone");
    const seriesId = await repeating(id, "MONTHLY", "2026-12-01");
    // 23:30 UTC on 30 November is 00:30 on 1 December in Stockholm; 22:30 is still 30 November.
    const before = await makeRepeatCopies(f.tenantId, new Date("2026-11-30T22:30:00Z"));
    expect(before).toMatchObject({ today: "2026-11-30", considered: 0, made: 0 });
    const kicks = await Promise.all([
      makeRepeatCopies(f.tenantId, new Date("2026-11-30T23:30:00Z")),
      makeRepeatCopies(f.tenantId, new Date("2026-11-30T23:30:00Z")),
    ]);
    expect(kicks.map((k) => k.today)).toEqual(["2026-12-01", "2026-12-01"]);
    expect(kicks.reduce((n, k) => n + k.made, 0)).toBe(1);
    expect(kicks.reduce((n, k) => n + k.failed, 0)).toBe(0);
    expect(await f.platform.workItemRepeatItem.count({ where: { tenantId: f.tenantId, repeatId: seriesId, madeFor: at("2026-12-01") } })).toBe(1);
  }, LONG);

  it("takes the LEAST recently touched series first, so one that keeps failing goes to the back (security M-1)", async () => {
    await f.platform.workItemRepeat.deleteMany({ where: { tenantId: f.tenantId } });
    const a = await task("Touched long ago");
    const b = await task("Touched just now");
    const sa = await repeating(a.id, "WEEKLY", "2026-12-07");
    const sb = await repeating(b.id, "WEEKLY", "2026-12-07");
    // `a` was touched an hour ago, `b` now — as a failure's touch leaves it.
    await f.platform.workItemRepeat.update({ where: { id: sa }, data: { updatedAt: new Date(Date.now() - 3_600_000) } });
    await f.platform.workItemRepeat.update({ where: { id: sb }, data: { updatedAt: new Date() } });
    const r = await makeRepeatCopies(f.tenantId, new Date("2026-12-07T10:00:00Z"), { cap: 1 });
    expect(r).toMatchObject({ considered: 1, made: 1 });
    expect(await f.platform.workItemRepeatItem.count({ where: { tenantId: f.tenantId, repeatId: sa, madeFor: { not: null } } })).toBe(1);
    expect(await f.platform.workItemRepeatItem.count({ where: { tenantId: f.tenantId, repeatId: sb, madeFor: { not: null } } })).toBe(0);
  }, LONG);
});

// A domain refusal is a DomainError with its code — the matcher above reads `code`.
void DomainError;
