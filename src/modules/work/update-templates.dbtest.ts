import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { DomainError } from "@/lib/domain-error";
import { setupTenant } from "@/members/dbtest-fixture";
import { getProjectByKey, updateProject } from "@/projects/service";

import { guarded } from "./db-errors";
import { ALL_METRICS_INCLUDED } from "./update-body";
import { STANDARD_LAYOUT } from "./update-layout";
import {
  createUpdateTemplate,
  deleteUpdateTemplate,
  listUpdateTemplates,
  setDefaultUpdateTemplate,
  updateUpdateTemplate,
} from "./update-templates";
import { readComposerContext } from "./updates";

/**
 * PROGRESS-UPDATE LAYOUTS against the real database and app_runtime (Phase 5
 * slice 105; founder decision C73 (c), (d), (g)): owners and admins edit them
 * (`settings:edit`), a manager reads them, an employee neither — but sees a
 * project's choice and may pick one where they may edit the project; names
 * are one per workspace whatever their case; one default at a time; deleting
 * one sends its projects (archived ones too) back to the default; a project
 * can never point at another workspace's layout; and the composer opens with
 * the project's layout, else the default, else Fortleva standard.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let other: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
const P: Record<string, string> = {};

const as = (seat: "owner" | "admin" | "manager" | "employee") => ({ tenantId: f.tenantId, actor: f.seats[seat].actor });
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    if (e instanceof AuthzError) return e.reason;
    throw e;
  }
  return null;
};
const weekly = {
  name: "Weekly check-in",
  sections: [{ key: "SUMMARY" }, { key: "CUSTOM", title: "SEO this month" }, { key: "DONE" }],
  metrics: { ...ALL_METRICS_INCLUDED, hours: false },
};
const monthly = {
  name: "Monthly report",
  sections: [{ key: "DONE" }, { key: "NEXT" }],
  metrics: ALL_METRICS_INCLUDED,
};
const audits = (action: string) => f.platform.auditEvent.findMany({ where: { tenantId: f.tenantId, action }, select: { targetId: true, metadata: true } });

beforeAll(async () => {
  f = await setupTenant("layout");
  other = await setupTenant("layout");
  acme = randomUUID();
  await f.platform.client.create({ data: { id: acme, tenantId: f.tenantId, name: "Acme" } });
  for (const [key, status] of [
    ["LA", "ACTIVE"],
    ["LB", "ACTIVE"],
    ["LC", "ARCHIVED"],
  ] as const) {
    P[key] = randomUUID();
    await f.platform.project.create({
      data: { id: P[key], tenantId: f.tenantId, clientId: acme, key, name: key, status, ...(status === "ARCHIVED" ? { archivedAt: new Date() } : {}) },
    });
  }
  // The employee may edit LA (an assignment), and so see and pick its layout.
  await f.platform.memberProject.create({ data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, projectId: P["LA"]! } });
}, 120_000);

afterAll(async () => {
  for (const t of [f, other]) {
    if (!t) continue;
    const where = { where: { tenantId: t.tenantId } };
    await t.platform.memberProject.deleteMany(where);
    await t.platform.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${t.tenantId}`;
    await t.platform.project.deleteMany(where);
    await t.platform.client.deleteMany(where);
    await t.cleanup();
  }
}, 120_000);

describe("who may", () => {
  it("an owner and an admin edit; a manager reads only; an employee neither", async () => {
    const { id } = await createUpdateTemplate(as("admin"), weekly);
    expect((await listUpdateTemplates(as("manager"))).map((r) => r.id)).toContain(id);
    expect(await codeOf(createUpdateTemplate(as("manager"), monthly))).toBe("FORBIDDEN");
    expect(await codeOf(setDefaultUpdateTemplate(as("manager"), id))).toBe("FORBIDDEN");
    expect(await codeOf(listUpdateTemplates(as("employee")))).toBe("FORBIDDEN");
    expect(await codeOf(deleteUpdateTemplate(as("employee"), id))).toBe("FORBIDDEN");
    await deleteUpdateTemplate(as("owner"), id);
  });
});

describe("what a layout holds", () => {
  it("is stored as parsed, audited by field names only, and a malformed one is refused", async () => {
    const { id } = await createUpdateTemplate(as("owner"), weekly);
    const [row] = (await listUpdateTemplates(as("owner"))).filter((r) => r.id === id);
    expect(row!.sections).toEqual([
      { key: "SUMMARY", title: null },
      { key: "CUSTOM", title: "SEO this month" },
      { key: "DONE", title: null },
    ]);
    expect(row!.metrics.hours).toBe(false);
    await updateUpdateTemplate(as("owner"), id, { name: "Weekly", metrics: ALL_METRICS_INCLUDED });
    const [edited] = await audits("project_update_template.updated");
    expect(edited).toMatchObject({ targetId: id, metadata: { fields: ["name", "metrics"] } });
    // No Done (C73 (g)), and four of the workspace's own.
    expect(await codeOf(createUpdateTemplate(as("owner"), { ...monthly, name: "x", sections: [{ key: "NEXT" }] }))).toBe("INVALID_INPUT");
    expect(
      await codeOf(
        createUpdateTemplate(as("owner"), {
          ...monthly,
          name: "y",
          sections: [{ key: "DONE" }, ...["a", "b", "c", "d"].map((title) => ({ key: "CUSTOM", title }))],
        }),
      ),
    ).toBe("INVALID_INPUT");
    expect(await codeOf(createUpdateTemplate(as("owner"), { ...monthly, name: "   " }))).toBe("NAME_REQUIRED");
    await deleteUpdateTemplate(as("owner"), id);
  });

  it("names are one per workspace whatever their case — in the service, and in the database", async () => {
    const { id } = await createUpdateTemplate(as("owner"), weekly);
    expect(await codeOf(createUpdateTemplate(as("owner"), { ...monthly, name: "WEEKLY CHECK-IN" }))).toBe("LAYOUT_NAME_TAKEN");
    await expect(
      f.platform.projectUpdateTemplate.create({
        data: { tenantId: f.tenantId, name: "weekly check-in", sections: [{ key: "DONE" }], metricsIncluded: ALL_METRICS_INCLUDED },
      }),
    ).rejects.toThrow();
    // The database's refusal reads as the same sentence when a race gets past
    // the check (the code review's L5: the expression index's name is only in
    // the adapter's meta).
    expect(
      await codeOf(
        guarded(() =>
          f.platform.projectUpdateTemplate.create({
            data: { tenantId: f.tenantId, name: "WEEKLY check-in", sections: [{ key: "DONE" }], metricsIncluded: ALL_METRICS_INCLUDED },
          }),
        ),
      ),
    ).toBe("LAYOUT_NAME_TAKEN");
    // `_` and `%` are characters, not wildcards (the code review's L1): the
    // name WITH the wildcard comes second, when the one it would match as a
    // pattern already exists — the order an ILIKE check refuses (the fix-pass
    // review's low: the first version created them the other way round).
    const x = await createUpdateTemplate(as("owner"), { ...monthly, name: "QxA review" });
    const underscore = await createUpdateTemplate(as("owner"), { ...monthly, name: "Q_A review" });
    const plain = await createUpdateTemplate(as("owner"), { ...monthly, name: "100 percent done" });
    const percent = await createUpdateTemplate(as("owner"), { ...monthly, name: "100% done" });
    for (const l of [x, underscore, plain, percent]) await deleteUpdateTemplate(as("owner"), l.id);
    // Another workspace may use the same name.
    const theirs = await createUpdateTemplate({ tenantId: other.tenantId, actor: other.seats.owner.actor }, weekly);
    expect(theirs.name).toBe("Weekly check-in");
    await deleteUpdateTemplate(as("owner"), id);
  });
});

describe("the default", () => {
  it("one at a time; null is Fortleva standard; the change is audited", async () => {
    const a = await createUpdateTemplate(as("owner"), weekly);
    const b = await createUpdateTemplate(as("owner"), monthly);
    expect(await setDefaultUpdateTemplate(as("admin"), a.id)).toEqual({ changed: true });
    expect(await setDefaultUpdateTemplate(as("admin"), b.id)).toEqual({ changed: true });
    expect(await setDefaultUpdateTemplate(as("admin"), b.id)).toEqual({ changed: false });
    const rows = await listUpdateTemplates(as("owner"));
    expect(rows.filter((r) => r.isDefault).map((r) => r.id)).toEqual([b.id]);
    // The database holds the line too, and its refusal reads as a sentence.
    expect(
      await codeOf(guarded(() => f.platform.projectUpdateTemplate.update({ where: { id: a.id }, data: { isDefault: true } }))),
    ).toBe("LAYOUT_BUSY");
    await setDefaultUpdateTemplate(as("admin"), null);
    expect((await listUpdateTemplates(as("owner"))).some((r) => r.isDefault)).toBe(false);
    expect((await audits("project_update_template.default_changed")).map((r) => r.metadata)).toEqual(
      expect.arrayContaining([
        { from: null, to: a.id },
        { from: a.id, to: b.id },
        { from: b.id, to: null },
      ]),
    );
    await deleteUpdateTemplate(as("owner"), a.id);
    await deleteUpdateTemplate(as("owner"), b.id);
  });
});

describe("a project's layout", () => {
  it("an employee who may edit the project sees the choices and picks one; another workspace's is refused", async () => {
    const a = await createUpdateTemplate(as("owner"), weekly);
    await setDefaultUpdateTemplate(as("owner"), a.id);
    const b = await createUpdateTemplate(as("owner"), monthly);
    const detail = await getProjectByKey(as("employee"), "LA");
    expect(detail.updateLayouts).toEqual({
      choices: [
        { id: b.id, name: "Monthly report" },
        { id: a.id, name: "Weekly check-in" },
      ],
      defaultName: "Weekly check-in",
    });
    expect(await updateProject(as("employee"), P["LA"]!, { updateTemplateId: b.id })).toEqual({ changed: ["updateTemplateId"] });
    const foreign = await createUpdateTemplate({ tenantId: other.tenantId, actor: other.seats.owner.actor }, monthly);
    expect(await codeOf(updateProject(as("owner"), P["LB"]!, { updateTemplateId: foreign.id }))).toBe("INVALID_INPUT");
    // The key refuses it even written straight past the service.
    await expect(f.platform.project.update({ where: { id: P["LB"]! }, data: { updateTemplateId: foreign.id } })).rejects.toThrow();
    await updateProject(as("owner"), P["LA"]!, { updateTemplateId: null });
    await deleteUpdateTemplate(as("owner"), a.id);
    await deleteUpdateTemplate(as("owner"), b.id);
  });

  it("deleting a layout sends ALL its projects back to the default — archived ones too — and says how many", async () => {
    const a = await createUpdateTemplate(as("owner"), weekly);
    await updateProject(as("owner"), P["LA"]!, { updateTemplateId: a.id });
    await updateProject(as("owner"), P["LB"]!, { updateTemplateId: a.id });
    // An archived project cannot be edited through the service; its pick predates the archive.
    await f.platform.project.update({ where: { id: P["LC"]! }, data: { updateTemplateId: a.id } });
    // The list counts the live ones.
    expect((await listUpdateTemplates(as("owner"))).find((r) => r.id === a.id)?.projectCount).toBe(2);
    expect(await deleteUpdateTemplate(as("owner"), a.id)).toEqual({ projectsReset: 3 });
    const left = await f.platform.project.findMany({ where: { tenantId: f.tenantId, updateTemplateId: { not: null } } });
    expect(left).toEqual([]);
    const deleted = (await audits("project_update_template.deleted")).find((r) => r.targetId === a.id);
    expect(deleted).toMatchObject({ metadata: { projectsReset: 3, wasDefault: false } });
  });
});

describe("the composer opens with the project's layout", () => {
  it("the project's pick, else the workspace's default, else Fortleva standard", async () => {
    const period = { periodStart: null, periodEnd: null };
    expect((await readComposerContext(as("owner"), P["LA"]!, period)).layout).toEqual(STANDARD_LAYOUT);
    const a = await createUpdateTemplate(as("owner"), weekly);
    const b = await createUpdateTemplate(as("owner"), monthly);
    await setDefaultUpdateTemplate(as("owner"), b.id);
    expect((await readComposerContext(as("owner"), P["LA"]!, period)).layout.sections.map((s) => s.key)).toEqual(["DONE", "NEXT"]);
    await updateProject(as("owner"), P["LA"]!, { updateTemplateId: a.id });
    const picked = (await readComposerContext(as("owner"), P["LA"]!, period)).layout;
    expect(picked.sections.map((s) => s.key)).toEqual(["SUMMARY", "CUSTOM", "DONE"]);
    expect(picked.metrics.hours).toBe(false);
    await updateProject(as("owner"), P["LA"]!, { updateTemplateId: null });
    await setDefaultUpdateTemplate(as("owner"), null);
    await deleteUpdateTemplate(as("owner"), a.id);
    await deleteUpdateTemplate(as("owner"), b.id);
  });
});
