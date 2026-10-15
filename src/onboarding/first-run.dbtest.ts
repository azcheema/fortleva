import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setupTenant } from "@/members/dbtest-fixture";
import { createItem } from "@/modules/work";
import { updatePreferences } from "@/preferences/service";

import { hideFirstRunList, readFirstRunList } from "./first-run";

/**
 * THE GETTING-STARTED LIST on Home (Phase 6 slice 121; founder decision
 * C97 (d)) against the real database: who sees it, that each step ticks
 * itself from the workspace's own data, that it goes away by itself when
 * every step is done, and that Hide is the workspace switch. Prefix `frun-`.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
const owner = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const employee = () => ({ tenantId: f.tenantId, actor: f.seats.employee.actor });
const stepOf = async (key: string) => (await readFirstRunList(owner()))?.steps.find((s) => s.key === key);

beforeAll(async () => {
  f = await setupTenant("frun");
}, 120_000);

afterAll(async () => {
  const db = f.platform;
  await db.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItem.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
  await db.project.deleteMany({ where: { tenantId: f.tenantId } });
  await db.client.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 120_000);

describe("the getting-started list", () => {
  it("is for the people who set the workspace up — an employee never sees it", async () => {
    expect(await readFirstRunList(employee())).toBeNull();
    expect(await readFirstRunList(owner())).not.toBeNull();
  });

  it("starts with what the workspace already has ticked, and links each step for an owner", async () => {
    const list = (await readFirstRunList(owner()))!;
    expect(list.steps.map((s) => s.key)).toEqual(["company", "client", "project", "team", "tasks"]);
    // The fixture's workspace has four members: the team step is already done.
    expect(list.steps.find((s) => s.key === "team")).toMatchObject({ done: true, href: "/members" });
    expect(list.steps.find((s) => s.key === "client")).toMatchObject({ done: false, href: "/clients#new-client" });
    expect(list.steps.find((s) => s.key === "company")).toMatchObject({ done: false, href: "/settings/invoicing" });
    // No project yet, so the tasks step has nowhere to send anyone.
    expect(list.steps.find((s) => s.key === "tasks")).toMatchObject({ done: false, href: null });
    expect(list.done).toBe(1);
  });

  it("ticks each step from the data, links the import to the first project, and disappears when all are done", async () => {
    const clientId = randomUUID();
    const projectId = randomUUID();
    await f.platform.client.create({ data: { id: clientId, tenantId: f.tenantId, name: "First Co" } });
    expect((await stepOf("client"))!.done).toBe(true);
    await f.platform.project.create({ data: { id: projectId, tenantId: f.tenantId, clientId, key: "FRUN", name: "First" } });
    expect(await stepOf("project")).toMatchObject({ done: true });
    expect(await stepOf("tasks")).toMatchObject({ done: false, href: "/projects/FRUN/import" });
    await createItem(owner(), { projectId, title: "First task" });
    expect((await stepOf("tasks"))!.done).toBe(true);
    await f.platform.tenant.update({ where: { id: f.tenantId }, data: { legalName: "First Run AB" } });
    // Every step done: nothing to say.
    expect(await readFirstRunList(owner())).toBeNull();
    await f.platform.tenant.update({ where: { id: f.tenantId }, data: { legalName: null } });
  });

  it("Hide turns it off for the whole workspace; the preference turns it on again", async () => {
    expect(await readFirstRunList(owner())).not.toBeNull();
    await hideFirstRunList(owner());
    expect(await readFirstRunList(owner())).toBeNull();
    const row = await f.platform.tenantPreference.findFirst({ where: { tenantId: f.tenantId, key: "onboarding.checklist" } });
    expect(row?.value).toBe(false);
    await updatePreferences(owner(), { onboarding: { checklist: true } });
    expect(await readFirstRunList(owner())).not.toBeNull();
  });

  it("an employee cannot hide it", async () => {
    await expect(hideFirstRunList(employee())).rejects.toThrow();
  });
});
