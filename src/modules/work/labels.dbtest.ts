import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { compareLabelNames } from "@/lib/work-view";
import { setupTenant } from "@/members/dbtest-fixture";
import { changeItemVisibility, createItem, createLabel, getItemDetail, setItemLabel } from "./index";

/**
 * The labels service against the real database and the real
 * app_runtime role (panel slice 12): a label is a tenant word under
 * `label:manage`, audited on creation and unique per tenant
 * case-insensitively — by the partial expression index
 * `label_tenant_wide_name_key` (20260915180000), because the schema's
 * composite unique cannot refuse two NULL project ids, and the test
 * races two creators into it; putting a label on a task is routine
 * (an INTERNAL history row, whatever the task's visibility), decided by
 * the join write's own row count so two concurrent adds of one label
 * count exactly once; a label of another project is as absent as one
 * that does not exist; and the panel's read lists the task's labels and
 * its vocabulary by name, with the history's refs resolved.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let clientId: string;
let projectId: string;
let otherProjectId: string;

beforeAll(async () => {
  f = await setupTenant("work");
  clientId = randomUUID();
  projectId = randomUUID();
  otherProjectId = randomUUID();
  await f.platform.client.create({ data: { id: clientId, tenantId: f.tenantId, name: "Acme" } });
  await f.platform.project.create({
    data: { id: projectId, tenantId: f.tenantId, clientId, key: "ACME", name: "Acme site" },
  });
  await f.platform.project.create({
    data: { id: otherProjectId, tenantId: f.tenantId, clientId, key: "OTHER", name: "Other site" },
  });
  // The employee is scoped to the client (deny-default otherwise).
  await f.platform.memberClient.create({
    data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId },
  });
}, 60_000);

afterAll(async () => {
  if (!f?.tenantId) return;
  const db = f.platform;
  await db.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItem.deleteMany({ where: { tenantId: f.tenantId } }); // work_item_label cascades
  await db.label.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
  await db.memberClient.deleteMany({ where: { tenantId: f.tenantId } });
  await db.project.deleteMany({ where: { tenantId: f.tenantId } });
  await db.client.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 60_000);

const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const employeeCtx = () => ({ tenantId: f.tenantId, actor: f.seats.employee.actor });

/** A name no other test in this file can collide with. */
const unique = (stem: string) => `${stem} ${randomUUID().slice(0, 6)}`;

const labelHistory = (itemId: string) =>
  f.platform.workItemActivity.findMany({
    where: { tenantId: f.tenantId, workItemId: itemId, field: "labels" },
    orderBy: { id: "asc" },
    select: { oldRef: true, newRef: true, oldValue: true, newValue: true, visibility: true },
  });

describe("createLabel", () => {
  it("a tenant-wide label under label:manage, audited label.created; an employee is refused", async () => {
    const name = unique("Bug");
    const { label, labels } = await createLabel(ownerCtx(), { name });
    expect(label).toMatchObject({ name, color: null });
    expect(labels).toBeNull();
    const row = await f.platform.label.findUniqueOrThrow({ where: { id: label.id } });
    expect(row.projectId).toBeNull();
    const audits = await f.platform.auditEvent.findMany({ where: { tenantId: f.tenantId, targetId: label.id } });
    expect(audits.map((a) => a.action)).toEqual(["label.created"]);
    // CMA: the employee holds work_item:edit but not label:manage.
    await expect(createLabel(employeeCtx(), { name: unique("Nope") })).rejects.toThrow(AuthzError);
  });

  it("refuses an empty name, a name past the bound, and a name already taken — case-insensitively", async () => {
    await expect(createLabel(ownerCtx(), { name: "   " })).rejects.toMatchObject({ code: "NAME_REQUIRED" });
    await expect(createLabel(ownerCtx(), { name: "x".repeat(41) })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const name = unique("Design");
    await createLabel(ownerCtx(), { name });
    // The schema's composite unique would have accepted this — NULL
    // project ids are distinct to it — so the refusal is the partial
    // index's on lower(name), mapped to LABEL_TAKEN.
    await expect(createLabel(ownerCtx(), { name: name.toUpperCase() })).rejects.toMatchObject({ code: "LABEL_TAKEN" });
    await expect(createLabel(ownerCtx(), { name: ` ${name} ` })).rejects.toMatchObject({ code: "LABEL_TAKEN" });
  });

  it("two creators of the same name at once: exactly one label, the other told LABEL_TAKEN", async () => {
    const name = unique("Race");
    const results = await Promise.allSettled([
      createLabel(ownerCtx(), { name }),
      createLabel(ownerCtx(), { name: name.toLowerCase() }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toMatchObject({ code: "LABEL_TAKEN" });
    const rows = await f.platform.label.findMany({ where: { tenantId: f.tenantId }, select: { name: true } });
    expect(rows.filter((r) => r.name.toLowerCase() === name.toLowerCase())).toHaveLength(1);
  });

  it("with applyTo: one transaction creates, audits and files the task — and a task the member may not edit creates nothing", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Labelled at birth" });
    const name = unique("Hotfix");
    const created = await createLabel(ownerCtx(), { name, applyTo: id });
    expect(created.labels?.map((l) => l.name)).toEqual([name]);
    expect(await labelHistory(id)).toEqual([
      { oldRef: null, newRef: created.label.id, oldValue: null, newValue: null, visibility: "INTERNAL" },
    ]);
    // A task that does not exist: the create is refused BEFORE any label
    // row exists — no orphan word in the tenant's vocabulary.
    const orphan = unique("Orphan");
    await expect(createLabel(ownerCtx(), { name: orphan, applyTo: randomUUID() })).rejects.toThrow(AuthzError);
    expect(await f.platform.label.count({ where: { tenantId: f.tenantId, name: orphan } })).toBe(0);
  });
});

describe("setItemLabel", () => {
  it("adds and removes, one INTERNAL history row per real change, and a repeat is changed:false with no row", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Toggled" });
    const a = (await createLabel(ownerCtx(), { name: unique("Alpha") })).label;
    const b = (await createLabel(ownerCtx(), { name: unique("Beta") })).label;

    const on = await setItemLabel(ownerCtx(), id, a.id, true);
    expect(on).toMatchObject({ changed: true, verb: "added", label: { id: a.id } });
    expect(on.labels.map((l) => l.id)).toEqual([a.id]);
    const again = await setItemLabel(ownerCtx(), id, a.id, true);
    expect(again.changed).toBe(false);
    expect(again.labels.map((l) => l.id)).toEqual([a.id]);

    const both = await setItemLabel(ownerCtx(), id, b.id, true);
    // By NAME under the ONE comparator every surface uses — never the
    // database's collation, which CI's C.UTF-8 and the browser disagree on.
    expect(both.labels.map((l) => l.id)).toEqual(
      [a, b].sort((x, y) => compareLabelNames(x.name, y.name)).map((l) => l.id),
    );

    const off = await setItemLabel(ownerCtx(), id, a.id, false);
    expect(off).toMatchObject({ changed: true, verb: "removed", label: { id: a.id } });
    expect(off.labels.map((l) => l.id)).toEqual([b.id]);
    expect((await setItemLabel(ownerCtx(), id, a.id, false)).changed).toBe(false);

    // The schema's own shape: an add is newRef, a removal oldRef, no verb.
    expect(await labelHistory(id)).toEqual([
      { oldRef: null, newRef: a.id, oldValue: null, newValue: null, visibility: "INTERNAL" },
      { oldRef: null, newRef: b.id, oldValue: null, newValue: null, visibility: "INTERNAL" },
      { oldRef: a.id, newRef: null, oldValue: null, newValue: null, visibility: "INTERNAL" },
    ]);
  });

  it("`labels` is not portal-safe: the row stays INTERNAL on a shared task", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Shared but labelled" });
    await changeItemVisibility(ownerCtx(), id, "CLIENT_VISIBLE");
    const l = (await createLabel(ownerCtx(), { name: unique("Public") })).label;
    await setItemLabel(ownerCtx(), id, l.id, true);
    expect((await labelHistory(id)).map((r) => r.visibility)).toEqual(["INTERNAL"]);
  });

  it("a label of ANOTHER project is NOT_FOUND; this project's own and a tenant-wide one are accepted", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Scoped labels" });
    // Nothing creates a project-scoped label yet; the rows are made raw.
    const theirs = await f.platform.label.create({
      data: { tenantId: f.tenantId, projectId: otherProjectId, name: unique("Theirs") },
    });
    const mine = await f.platform.label.create({
      data: { tenantId: f.tenantId, projectId, name: unique("Mine") },
    });
    await expect(setItemLabel(ownerCtx(), id, theirs.id, true)).rejects.toThrow(AuthzError);
    await expect(setItemLabel(ownerCtx(), id, randomUUID(), true)).rejects.toThrow(AuthzError);
    expect((await setItemLabel(ownerCtx(), id, mine.id, true)).changed).toBe(true);
    expect(await labelHistory(id)).toHaveLength(1);
  });

  it("two adds of the same label at once: exactly one counts, one history row", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Raced label" });
    const l = (await createLabel(ownerCtx(), { name: unique("Twice") })).label;
    const [x, y] = await Promise.all([
      setItemLabel(ownerCtx(), id, l.id, true),
      setItemLabel(ownerCtx(), id, l.id, true),
    ]);
    expect([x.changed, y.changed].filter(Boolean)).toHaveLength(1);
    expect(x.labels.map((m) => m.id)).toEqual([l.id]);
    expect(y.labels.map((m) => m.id)).toEqual([l.id]);
    expect(await labelHistory(id)).toHaveLength(1);
  });

  it("the employee may label a task in scope but may not create a word", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Employee labels" });
    const l = (await createLabel(ownerCtx(), { name: unique("Ok") })).label;
    expect((await setItemLabel(employeeCtx(), id, l.id, true)).changed).toBe(true);
  });
});

describe("getItemDetail carries the labels (panel slice 12)", () => {
  it("applied and offered by name — the tenant's and this project's, never another project's — with the caps and the history's names", async () => {
    const { id, number } = await createItem(ownerCtx(), { projectId, title: "Panel labels" });
    const stem = randomUUID().slice(0, 6);
    const zed = (await createLabel(ownerCtx(), { name: `Zed ${stem}` })).label;
    const ant = (await createLabel(ownerCtx(), { name: `Ant ${stem}` })).label;
    const scoped = await f.platform.label.create({
      data: { tenantId: f.tenantId, projectId, name: `Mid ${stem}` },
    });
    const foreign = await f.platform.label.create({
      data: { tenantId: f.tenantId, projectId: otherProjectId, name: `Foreign ${stem}` },
    });
    await setItemLabel(ownerCtx(), id, zed.id, true);
    await setItemLabel(ownerCtx(), id, ant.id, true);
    await setItemLabel(ownerCtx(), id, zed.id, false);

    const detail = await getItemDetail(ownerCtx(), projectId, number);
    expect(detail.labels.applied.map((l) => l.id)).toEqual([ant.id]);
    const offered = detail.labels.offered.map((l) => l.id);
    expect(offered).toContain(ant.id);
    expect(offered).toContain(zed.id);
    expect(offered).toContain(scoped.id);
    expect(offered).not.toContain(foreign.id);
    // By NAME across both scopes under the one comparator, not tenant-wide first.
    const names = detail.labels.offered.map((l) => l.name);
    expect(names).toEqual([...names].sort(compareLabelNames));
    expect(detail.caps.manageLabels).toBe(true);

    const rows = detail.activity.rows.filter((r) => r.field === "labels");
    expect(rows.map((r) => [r.oldRefName, r.newRefName])).toEqual([
      [zed.name, null],
      [null, ant.name],
      [null, zed.name],
    ]);

    const theirs = await getItemDetail(employeeCtx(), projectId, number);
    expect(theirs.caps.edit).toBe(true);
    expect(theirs.caps.manageLabels).toBe(false);
    expect(theirs.labels.offered.length).toBeGreaterThan(0);
  });
});
