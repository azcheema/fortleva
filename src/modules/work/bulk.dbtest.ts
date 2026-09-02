import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { setupTenant } from "@/members/dbtest-fixture";
import { MAX_BULK_ITEMS } from "@/lib/work-view";

import {
  bulkChangeState,
  bulkSetArchived,
  bulkSetPriority,
  createItem,
  listItems,
} from "./index";

/**
 * The selection bar's three verbs against the real database and the
 * real `app_runtime` role (2W-F slice 4).
 *
 * What is actually at stake here is not the writes — it is that a bulk
 * verb keeps every promise the single-item path makes: the same audit
 * rows, the same activity rows, the same 2W-R approval gate, and the
 * same deny-default scoping. A loop that quietly drops one of those is
 * the defect this file exists to catch.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let clientId: string;
let projectId: string;
let otherProjectId: string;
/** A project of a DIFFERENT client — never in the employee's scope. */
let foreignClientId: string;
let foreignProjectId: string;

beforeAll(async () => {
  f = await setupTenant("bulk");
  clientId = randomUUID();
  projectId = randomUUID();
  otherProjectId = randomUUID();
  await f.platform.client.create({ data: { id: clientId, tenantId: f.tenantId, name: "Bulk Co" } });
  await f.platform.project.create({
    data: { id: projectId, tenantId: f.tenantId, clientId, key: "BULK", name: "Bulk project" },
  });
  await f.platform.project.create({
    data: { id: otherProjectId, tenantId: f.tenantId, clientId, key: "BULKB", name: "Other project" },
  });
  foreignClientId = randomUUID();
  foreignProjectId = randomUUID();
  await f.platform.client.create({
    data: { id: foreignClientId, tenantId: f.tenantId, name: "Not yours" },
  });
  await f.platform.project.create({
    data: {
      id: foreignProjectId,
      tenantId: f.tenantId,
      clientId: foreignClientId,
      key: "BULKX",
      name: "Foreign project",
    },
  });
}, 60_000);

afterAll(async () => {
  const db = f.platform;
  await db.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItem.deleteMany({ where: { tenantId: f.tenantId, parentId: { not: null } } });
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

const makeItems = async (n: number, prefix: string, project = projectId): Promise<string[]> => {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const { id } = await createItem(ownerCtx(), { projectId: project, title: `${prefix} ${i}` });
    ids.push(id);
  }
  return ids;
};

const statesOf = async (project = projectId) =>
  f.platform.workflowState.findMany({
    where: { tenantId: f.tenantId, projectId: project },
    orderBy: { rank: "asc" },
  });

const itemsById = async (ids: readonly string[]) =>
  f.platform.workItem.findMany({ where: { tenantId: f.tenantId, id: { in: [...ids] } } });

describe("bulkChangeState", () => {
  it("moves every selected item through the real state machine — stamps, activity and one audit row EACH", async () => {
    const ids = await makeItems(3, "State");
    const states = await statesOf();
    const inProgress = states.find((s) => s.category === "IN_PROGRESS")!;

    const before = (await f.audits("work_item.state_changed")).length;
    const r = await bulkChangeState(ownerCtx(), ids, inProgress.id);
    expect(r).toEqual({ changed: 3, skipped: 0 });

    const rows = await itemsById(ids);
    expect(rows.every((i) => i.stateId === inProgress.id)).toBe(true);
    // The stamp is the proof it went through transitionState rather than
    // a bare updateMany: an IN_PROGRESS arrival sets startedAt.
    expect(rows.every((i) => i.startedAt !== null)).toBe(true);

    const audits = await f.audits("work_item.state_changed");
    expect(audits.length - before).toBe(3);
    const activity = await f.platform.workItemActivity.findMany({
      where: { tenantId: f.tenantId, workItemId: { in: ids }, field: "stateCategory" },
    });
    expect(activity).toHaveLength(3);
  });

  it("an item already in the target state is SKIPPED — no second audit row", async () => {
    const ids = await makeItems(2, "Skip");
    const states = await statesOf();
    const inProgress = states.find((s) => s.category === "IN_PROGRESS")!;
    await bulkChangeState(ownerCtx(), ids, inProgress.id);

    const before = (await f.audits("work_item.state_changed")).length;
    const r = await bulkChangeState(ownerCtx(), ids, inProgress.id);
    expect(r).toEqual({ changed: 0, skipped: 2 });
    expect((await f.audits("work_item.state_changed")).length).toBe(before);
  });

  it("THE 2W-R GATE HOLDS PER ITEM: a non-approver cannot bulk into Done, and NOTHING is written", async () => {
    const ids = await makeItems(3, "Gate");
    // The employee needs the project in scope before the gate can be the
    // thing that refuses — otherwise this would pass for the wrong reason.
    await f.platform.memberClient.create({
      data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId },
    });
    const states = await statesOf();
    const done = states.find((s) => s.category === "DONE")!;
    expect(done.requiresApproval).toBe(true);

    await expect(bulkChangeState(employeeCtx(), ids, done.id)).rejects.toThrow();
    const rows = await itemsById(ids);
    expect(rows.every((i) => i.stateId !== done.id)).toBe(true);
  });

  it("a REFUSED batch writes nothing at all — no row, no activity, no audit", async () => {
    const ids = await makeItems(3, "Rollback");
    const states = await statesOf();
    const done = states.find((s) => s.category === "DONE")!;
    const auditsBefore = (await f.audits("work_item.state_changed")).length;
    // The employee is in scope (the previous test assigned the client)
    // but is not an approver, so the gate refuses the batch.
    await expect(bulkChangeState(employeeCtx(), ids, done.id)).rejects.toThrow();
    const rows = await itemsById(ids);
    expect(rows.every((i) => i.startedAt === null)).toBe(true);
    expect(rows.every((i) => i.stateId !== done.id)).toBe(true);
    const activity = await f.platform.workItemActivity.findMany({
      where: { tenantId: f.tenantId, workItemId: { in: ids }, field: "stateCategory" },
    });
    expect(activity).toHaveLength(0);
    expect((await f.audits("work_item.state_changed")).length).toBe(auditsBefore);

    // HONEST LIMIT, stated rather than implied: this proves a refused
    // batch leaves no partial write, NOT that a mid-loop failure rolls
    // back items already written. Every refusal path these three verbs
    // have — the cap, the mixed project, the scope check, the approval
    // gate — is reached before or at the first item, so there is no way
    // from here to fail on item three with one and two committed. The
    // single transaction is what makes that safe, and it is asserted by
    // construction (one `withTenant` per verb) rather than by this test.
  });

  it("entering TRIAGE is refused — it is its own verb, not a state change", async () => {
    const ids = await makeItems(1, "Triage");
    const triage = (await statesOf()).find((s) => s.category === "TRIAGE")!;
    await expect(bulkChangeState(ownerCtx(), ids, triage.id)).rejects.toBeInstanceOf(DomainError);
  });

  it("a state from ANOTHER project is NOT_FOUND", async () => {
    const ids = await makeItems(1, "Foreign");
    await listItems(ownerCtx(), otherProjectId); // seeds the other project's states
    const foreign = (await statesOf(otherProjectId))[0]!;
    await expect(bulkChangeState(ownerCtx(), ids, foreign.id)).rejects.toBeInstanceOf(AuthzError);
  });
});

describe("bulkSetPriority", () => {
  it("is a ROUTINE edit: one activity row per item and NO audit event, like the single-item path", async () => {
    const ids = await makeItems(3, "Prio");
    const auditsBefore = (await f.audits("work_item.bulk_edited")).length;

    const r = await bulkSetPriority(ownerCtx(), ids, "HIGH");
    expect(r).toEqual({ changed: 3, skipped: 0 });
    expect((await itemsById(ids)).every((i) => i.priority === "HIGH")).toBe(true);

    const activity = await f.platform.workItemActivity.findMany({
      where: { tenantId: f.tenantId, workItemId: { in: ids }, field: "priority" },
    });
    expect(activity).toHaveLength(3);
    expect(activity.every((a) => a.newValue === "HIGH")).toBe(true);
    expect((await f.audits("work_item.bulk_edited")).length).toBe(auditsBefore);
  });

  it("items already at that priority are skipped and write nothing", async () => {
    const ids = await makeItems(2, "Prio same");
    await bulkSetPriority(ownerCtx(), ids, "LOW");
    const r = await bulkSetPriority(ownerCtx(), ids, "LOW");
    expect(r).toEqual({ changed: 0, skipped: 2 });
    const activity = await f.platform.workItemActivity.findMany({
      where: { tenantId: f.tenantId, workItemId: { in: ids }, field: "priority" },
    });
    expect(activity).toHaveLength(2); // from the first call only
  });
});

describe("bulkSetArchived", () => {
  it("archives every selected item and audits EACH one — an archive nobody can trace is not undoable", async () => {
    const ids = await makeItems(3, "Archive");
    const before = (await f.audits("work_item.archived")).length;

    const r = await bulkSetArchived(ownerCtx(), ids, true);
    expect(r).toEqual({ changed: 3, skipped: 0 });
    expect((await itemsById(ids)).every((i) => i.archivedAt !== null)).toBe(true);

    const audits = await f.audits("work_item.archived");
    expect(audits.length - before).toBe(3);
    expect(audits.slice(-3).every((a) => ids.includes(a.targetId ?? ""))).toBe(true);

    // And back again.
    const restored = await bulkSetArchived(ownerCtx(), ids, false);
    expect(restored).toEqual({ changed: 3, skipped: 0 });
    expect((await itemsById(ids)).every((i) => i.archivedAt === null)).toBe(true);
  });
});

describe("the selection's own rules", () => {
  it("refuses an empty selection and one over the cap, before touching anything", async () => {
    await expect(bulkSetPriority(ownerCtx(), [], "HIGH")).rejects.toBeInstanceOf(DomainError);
    const tooMany = Array.from({ length: MAX_BULK_ITEMS + 1 }, () => randomUUID());
    await expect(bulkSetPriority(ownerCtx(), tooMany, "HIGH")).rejects.toBeInstanceOf(DomainError);
  });

  it("refuses a selection that spans two projects", async () => {
    const here = await makeItems(1, "Here");
    const there = await makeItems(1, "There", otherProjectId);
    await expect(
      bulkSetPriority(ownerCtx(), [...here, ...there], "HIGH"),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("a stale id (deleted in another tab) is ignored rather than failing the batch", async () => {
    const ids = await makeItems(2, "Stale");
    const r = await bulkSetPriority(ownerCtx(), [...ids, randomUUID()], "URGENT");
    // The unknown id simply is not in the selection — two items changed.
    expect(r).toEqual({ changed: 2, skipped: 0 });
  });

  it("SCOPE, BOTH DIRECTIONS: `client:view_all` reaches every project; a scope-limited member reaches only their own", async () => {
    const foreign = await makeItems(2, "Scope foreign", foreignProjectId);

    // The manager holds `client:view_all` — granted to owner/manager/admin
    // (`src/authz/catalog.ts`, the CMA row) — so `resolveScope` answers
    // `all` and a project with no assignment is still legitimately
    // theirs to edit. This half exists because the first version of this
    // test assumed the opposite and failed on CI: an unassigned seat is
    // NOT automatically an out-of-scope one.
    const managerCtx = { tenantId: f.tenantId, actor: f.seats.manager.actor };
    await expect(bulkSetPriority(managerCtx, foreign, "URGENT")).resolves.toEqual({
      changed: 2,
      skipped: 0,
    });

    // The employee holds no override and is assigned to `clientId` only,
    // so the very same ids are not theirs — and the refusal is NOT_FOUND,
    // never FORBIDDEN, so the answer does not confirm the rows exist.
    await expect(bulkSetPriority(employeeCtx(), foreign, "LOW")).rejects.toBeInstanceOf(AuthzError);
    expect((await itemsById(foreign)).every((i) => i.priority === "URGENT")).toBe(true);
  });

  it("NO EXISTENCE ORACLE: an out-of-scope id answers exactly like a nonexistent one", async () => {
    // The defect this pins (found by security review, 2026-09-02): the
    // load was tenant-scoped only — member scope is application-level,
    // not an RLS term — so the "spans one project" refusal fired on rows
    // the actor cannot see, and INVALID_INPUT vs NOT_FOUND told them the
    // foreign id was live. AUTHZ.md §4: existence must not leak.
    const mine = await makeItems(1, "Oracle mine");
    const foreign = await makeItems(1, "Oracle foreign", foreignProjectId);
    await f.platform.memberClient.upsert({
      where: { tenantId_memberId_clientId: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId } },
      create: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId },
      update: {},
    });

    // Same call, two kinds of second id. Both must look identical.
    const withForeign = await bulkSetPriority(employeeCtx(), [...mine, ...foreign], "LOW");
    const withGhost = await bulkSetPriority(employeeCtx(), [...mine, randomUUID()], "MEDIUM");
    expect(withForeign).toEqual({ changed: 1, skipped: 0 });
    expect(withGhost).toEqual({ changed: 1, skipped: 0 });

    // And the foreign item was not touched on the way past.
    const [foreignRow] = await itemsById(foreign);
    expect(foreignRow!.priority).toBe("NONE");
  });

  it("a selection of ONLY out-of-scope ids is NOT_FOUND — the same answer as only-ghosts", async () => {
    const foreign = await makeItems(1, "Oracle only-foreign", foreignProjectId);
    await expect(bulkSetPriority(employeeCtx(), foreign, "LOW")).rejects.toBeInstanceOf(AuthzError);
    await expect(bulkSetPriority(employeeCtx(), [randomUUID()], "LOW")).rejects.toBeInstanceOf(AuthzError);
  });

  it("every write went through withTenant — the rows carry this tenant and no other", async () => {
    const ids = await makeItems(2, "Tenant");
    await bulkSetPriority(ownerCtx(), ids, "MEDIUM");
    const rows = await withTenant(f.tenantId, { type: "member", id: f.seats.owner.memberId }, (tx) =>
      tx.workItem.findMany({ where: { id: { in: ids } }, select: { tenantId: true } }),
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.tenantId === f.tenantId)).toBe(true);
  });
});
