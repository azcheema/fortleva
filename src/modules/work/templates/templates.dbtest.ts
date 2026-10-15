import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { DomainError } from "@/lib/domain-error";
import { ranksBetween } from "@/lib/rank";
import { normalizeDescription } from "@/lib/rich-text/normalize";
import { createRole, setRolePermissions } from "@/members/roles";
import { setupTenant } from "@/members/dbtest-fixture";
import { createMilestone, setMilestoneStatus } from "@/projects/milestones";

import { addProjectStage, createLabel, listItems, renameProjectStage } from "../index";
import { parseDefinition } from "./definition";
import {
  createProjectFromTemplate,
  deleteTemplate,
  listTemplateChoices,
  listTemplates,
  readTemplateSaveSummary,
  renameTemplate,
  saveProjectAsTemplate,
} from "./service";

/**
 * PROJECT TEMPLATES against the real database and the real app_runtime role
 * (slice 124, founder decision C100; design doc §4–§7): "Save as template"
 * takes a project's stages, its milestones but a cancelled one, and its
 * tasks — never a client's request, a cancelled or archived or deleted task
 * or a left-out parent's subtree — with descriptions (checklists unticked),
 * labels, estimates, subtasks, starting stages and dates as days from the
 * anchor; a project made from it holds all of that, PRIVATE, in ONE
 * transaction; names are unique ignoring case (the database's fold); and
 * the gates are `project_template:manage` to keep templates and the hand
 * codes to use one.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let clientId: string;
let sourceId: string;
let designLabelId: string;
let copyLabelId: string;
// Seats outside the fixture's four (custom roles), torn down in afterAll
// once the rows they made are gone.
const extraSeats: { userId: string; memberId: string | null }[] = [];

/** A member on a fresh custom role holding exactly `codes`, with no assignment. */
async function seatWith(name: string, codes: string[]): Promise<{ tenantId: string; actor: { memberId: string } }> {
  const { roleId } = await createRole({ tenantId: f.tenantId, actor: f.seats.owner.actor, name });
  await setRolePermissions({ tenantId: f.tenantId, actor: f.seats.owner.actor, roleId, codes });
  const seat: { userId: string; memberId: string | null } = { userId: randomUUID(), memberId: null };
  extraSeats.push(seat);
  await f.platform.user.create({
    data: { id: seat.userId, name, email: `seat-${extraSeats.length}-${f.tenantId.slice(0, 8)}@test.invalid` },
  });
  seat.memberId = (await f.platform.member.create({ data: { tenantId: f.tenantId, userId: seat.userId } })).id;
  await f.platform.memberRole.create({ data: { tenantId: f.tenantId, memberId: seat.memberId, roleId } });
  return { tenantId: f.tenantId, actor: { memberId: seat.memberId } };
}

/** The constraint a raw write broke, read off the error's `meta` — never its message (the Prisma code-frame trap). */
async function brokenConstraint(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return JSON.stringify((e as { meta?: unknown }).meta ?? "");
  }
  throw new Error("expected the database to refuse");
}

const owner = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const manager = () => ({ tenantId: f.tenantId, actor: f.seats.manager.actor });
const employee = () => ({ tenantId: f.tenantId, actor: f.seats.employee.actor });

const checklistDoc = (checked: boolean) => ({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Launch steps" }] },
    {
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Buy the domain" }] }],
        },
      ],
    },
  ],
});

const domainCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
  throw new Error("expected a refusal");
};

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

type Planted = {
  key: string;
  type?: "EPIC" | "TASK" | "SUBTASK";
  kind?: "TASK" | "BUG" | "REQUEST";
  seedKey?: string;
  parent?: string;
  archived?: boolean;
  deleted?: boolean;
  estimateMinutes?: number;
  startDate?: string;
  targetDate?: string;
  milestoneId?: string;
  description?: unknown;
  labels?: string[];
};

/** Tasks written straight into the source project, in rank order — every field a template reads. */
async function plant(projectId: string, rows: Planted[]): Promise<Map<string, string>> {
  const states = await f.platform.workflowState.findMany({ where: { tenantId: f.tenantId, projectId } });
  const ranks = ranksBetween(null, null, rows.length);
  const ids = new Map<string, string>();
  for (const [i, r] of rows.entries()) {
    const id = randomUUID();
    ids.set(r.key, id);
    const state = states.find((s) => s.seedKey === (r.seedKey ?? "TODO"))!;
    const doc = r.description === undefined ? null : normalizeDescription(r.description);
    await f.platform.workItem.create({
      data: {
        id,
        tenantId: f.tenantId,
        clientId,
        projectId,
        number: i + 1,
        type: r.type ?? "TASK",
        kind: r.kind ?? "TASK",
        title: `Task ${r.key}`,
        ...(doc === null
          ? {}
          : {
              description: doc.doc as object,
              descriptionText: doc.text,
              checklistTotal: doc.checklistTotal,
              checklistDone: doc.checklistDone,
            }),
        stateId: state.id,
        stateCategory: state.category,
        parentId: r.parent ? ids.get(r.parent)! : null,
        rootId: id,
        rank: ranks[i]!,
        estimateMinutes: r.estimateMinutes ?? null,
        startDate: r.startDate ? day(r.startDate) : null,
        targetDate: r.targetDate ? day(r.targetDate) : null,
        milestoneId: r.milestoneId ?? null,
        archivedAt: r.archived ? new Date() : null,
        deletedAt: r.deleted ? new Date() : null,
      },
    });
    for (const labelId of r.labels ?? []) {
      await f.platform.workItemLabel.create({ data: { tenantId: f.tenantId, workItemId: id, labelId } });
    }
  }
  return ids;
}

beforeAll(async () => {
  f = await setupTenant("tpl");
  clientId = randomUUID();
  await f.platform.client.create({ data: { id: clientId, tenantId: f.tenantId, name: "Acme" } });
  sourceId = randomUUID();
  await f.platform.project.create({
    data: { id: sourceId, tenantId: f.tenantId, clientId, key: "TPLSRC", name: "Acme website", startDate: day("2026-03-02") },
  });
  // The source's own stages: seeded, one renamed, one added.
  await listItems(owner(), sourceId);
  const todo = (await f.platform.workflowState.findFirstOrThrow({ where: { projectId: sourceId, seedKey: "TODO" } })).id;
  await renameProjectStage(owner(), sourceId, todo, "Ready");
  await addProjectStage(owner(), sourceId, { name: "QA", kind: "IN_PROGRESS" });
  designLabelId = (await createLabel(owner(), { name: "Design", color: "blue" })).label.id;
  copyLabelId = (await createLabel(owner(), { name: "Copy", color: null })).label.id;
  const launch = await createMilestone(owner(), { projectId: sourceId, name: "Launch", dueAt: day("2026-04-01") });
  const dropped = await createMilestone(owner(), { projectId: sourceId, name: "Dropped", dueAt: null });
  await setMilestoneStatus(owner(), dropped.id, "CANCELLED");
  await plant(sourceId, [
    { key: "epic", type: "EPIC", milestoneId: launch.id, labels: [designLabelId] },
    {
      key: "child",
      parent: "epic",
      estimateMinutes: 90,
      startDate: "2026-03-02",
      targetDate: "2026-03-16",
      description: checklistDoc(true),
      labels: [designLabelId, copyLabelId],
    },
    { key: "sub", type: "SUBTASK", parent: "child", seedKey: "DONE", targetDate: "2026-02-27" },
    { key: "backlog", seedKey: "BACKLOG", kind: "BUG" },
    { key: "doing", seedKey: "IN_PROGRESS" },
    { key: "request", kind: "REQUEST" },
    { key: "cancelled", seedKey: "CANCELLED" },
    { key: "orphan", type: "SUBTASK", parent: "cancelled" },
    { key: "archived", archived: true },
    { key: "deleted", deleted: true },
  ]);
}, 120_000);

afterAll(async () => {
  if (!f?.tenantId) return;
  const db = f.platform;
  await db.projectTemplate.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItemLabel.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItem.deleteMany({ where: { tenantId: f.tenantId } });
  await db.milestone.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
  await db.label.deleteMany({ where: { tenantId: f.tenantId } });
  await db.project.deleteMany({ where: { tenantId: f.tenantId } });
  await db.client.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  for (const seat of extraSeats) {
    if (seat.memberId) {
      await db.memberRole.deleteMany({ where: { tenantId: f.tenantId, memberId: seat.memberId } });
      await db.member.delete({ where: { id: seat.memberId } });
    }
    await db.user.deleteMany({ where: { id: seat.userId } });
  }
  await f.cleanup();
}, 120_000);

const stored = async (id: string) => f.platform.projectTemplate.findUniqueOrThrow({ where: { id } });

describe("saving a project as a template", () => {
  let templateId: string;

  it("says what would come along before anything is written", async () => {
    const summary = await readTemplateSaveSummary(owner(), sourceId);
    // epic, child, sub (done → starts fresh), backlog, doing — not the request,
    // the cancelled task or its subtask, the archived or the deleted one.
    expect(summary).toMatchObject({ tasks: 5, milestones: 1, anchor: "2026-03-02", anchorIsStart: true, tooLarge: false });
  });

  it("takes the stages, the live milestones and the chosen tasks — each starting fresh, checklists unticked", async () => {
    const saved = await saveProjectAsTemplate(owner(), { projectId: sourceId, name: "  Website   launch ", replace: false });
    templateId = saved.id;
    expect(saved).toMatchObject({ name: "Website launch", tasks: 5, milestones: 1, replaced: false });
    const row = await stored(templateId);
    expect(row).toMatchObject({ taskCount: 5, milestoneCount: 1, sourceProjectId: sourceId });
    const plan = parseDefinition(row.definition)!;
    expect(plan).not.toBeNull();
    expect(plan.stages.map((s) => s.name ?? s.seedKey)).toEqual(["BACKLOG", "Ready", "IN_PROGRESS", "IN_REVIEW", "QA", "DONE", "CANCELLED"]);
    expect(plan.milestones).toEqual([{ key: "m0", name: "Launch", description: null, dueDay: 30 }]);
    // In name order, and a task's own in that same order.
    expect(plan.labels.map((l) => [l.name, l.color])).toEqual([
      ["Copy", null],
      ["Design", "blue"],
    ]);
    const stageOf = (key: string) => plan.stages.find((s) => s.key === key)!;
    expect(plan.tasks.map((t) => [t.title, t.type, t.kind, stageOf(t.stage).category, t.depth])).toEqual([
      ["Task epic", "EPIC", "TASK", "TODO", 0],
      ["Task child", "TASK", "TASK", "TODO", 1],
      ["Task sub", "SUBTASK", "TASK", "TODO", 2],
      ["Task backlog", "TASK", "BUG", "BACKLOG", 0],
      ["Task doing", "TASK", "TASK", "TODO", 0],
    ]);
    expect(plan.tasks[1]).toMatchObject({ estimateMinutes: 90, startDay: 0, targetDay: 14, labels: ["l0", "l1"], milestone: null });
    expect(plan.tasks[0]).toMatchObject({ milestone: "m0", labels: ["l1"] });
    expect(plan.tasks[2]!.targetDay).toBe(-3);
    expect(JSON.stringify(plan.tasks[1]!.description)).toContain('"checked":false');
    const audit = (await f.audits("project_template.created")).find((a) => a.targetId === templateId)!;
    expect(audit.metadata).toEqual({ name: "Website launch", projectId: sourceId, tasks: 5, milestones: 1 });
  });

  it("refuses a name the workspace uses — ignoring case — unless asked to replace it, and keeps the stored name", async () => {
    expect(await domainCode(saveProjectAsTemplate(owner(), { projectId: sourceId, name: "WEBSITE LAUNCH", replace: false }))).toBe(
      "TEMPLATE_NAME_TAKEN",
    );
    const replaced = await saveProjectAsTemplate(manager(), { projectId: sourceId, name: "WEBSITE LAUNCH", replace: true });
    expect(replaced).toMatchObject({ id: templateId, name: "Website launch", replaced: true });
    expect(await f.platform.projectTemplate.count({ where: { tenantId: f.tenantId } })).toBe(1);
    expect((await f.audits("project_template.replaced")).map((a) => a.targetId)).toEqual([templateId]);
  });

  it("refuses a project past what a template holds, with a sentence", async () => {
    const big = randomUUID();
    await f.platform.project.create({ data: { id: big, tenantId: f.tenantId, clientId, key: "TPLBIG", name: "Big" } });
    const ranks = ranksBetween(null, null, 101);
    await f.platform.milestone.createMany({
      data: ranks.map((rank, i) => ({ tenantId: f.tenantId, clientId, projectId: big, name: `Phase ${i}`, rank })),
    });
    expect((await readTemplateSaveSummary(owner(), big)).tooLarge).toBe(true);
    expect(await domainCode(saveProjectAsTemplate(owner(), { projectId: big, name: "Too big", replace: false }))).toBe("TEMPLATE_TOO_LARGE");
  });

  it("is the member's scope: a project they do not reach cannot be saved, and Settings never names it", async () => {
    const keeper = await seatWith("Template keeper", ["client:view", "project:view", "work_item:view", "project_template:manage"]);
    await expect(saveProjectAsTemplate(keeper, { projectId: sourceId, name: "Out of scope", replace: false })).rejects.toBeInstanceOf(
      AuthzError,
    );
    const rows = await listTemplates(keeper);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.source === null)).toBe(true);
  });

  it("refuses an empty project, and is project_template:manage's — an employee is refused", async () => {
    const empty = randomUUID();
    await f.platform.project.create({ data: { id: empty, tenantId: f.tenantId, clientId, key: "TPLEMP", name: "Empty" } });
    expect(await domainCode(saveProjectAsTemplate(owner(), { projectId: empty, name: "Nothing", replace: false }))).toBe("TEMPLATE_EMPTY");
    // No start date: the anchor is the day it was made.
    expect((await readTemplateSaveSummary(owner(), empty)).anchorIsStart).toBe(false);
    await expect(saveProjectAsTemplate(employee(), { projectId: sourceId, name: "Mine", replace: false })).rejects.toBeInstanceOf(
      AuthzError,
    );
    await expect(listTemplates(employee())).rejects.toBeInstanceOf(AuthzError);
  });
});

describe("a new project from a template", () => {
  let templateId: string;
  beforeAll(async () => {
    templateId = (await f.platform.projectTemplate.findFirstOrThrow({ where: { tenantId: f.tenantId } })).id;
  });

  it("holds the template's stages, milestones and tasks — all private, dates moved to the new start — in one go", async () => {
    const made = await createProjectFromTemplate(owner(), {
      clientId,
      key: "tplnew",
      name: "Beta website",
      templateId,
      startDate: day("2026-05-04"),
    });
    expect(made).toMatchObject({ key: "TPLNEW", tasks: 5, milestones: 1 });
    const project = await f.platform.project.findUniqueOrThrow({ where: { id: made.id } });
    expect(project.startDate?.toISOString()).toBe("2026-05-04T00:00:00.000Z");

    const stages = await f.platform.workflowState.findMany({ where: { projectId: made.id }, orderBy: { rank: "asc" } });
    expect(stages.map((s) => s.name ?? s.seedKey)).toEqual(["BACKLOG", "Ready", "IN_PROGRESS", "IN_REVIEW", "QA", "DONE", "CANCELLED", "TRIAGE"]);
    expect(stages.find((s) => s.isDefault)!.name).toBe("Ready");

    const milestones = await f.platform.milestone.findMany({ where: { projectId: made.id } });
    expect(milestones.map((m) => [m.name, m.status, m.visibility, m.dueAt?.toISOString()])).toEqual([
      ["Launch", "PLANNED", "INTERNAL", "2026-06-03T00:00:00.000Z"],
    ]);

    const tasks = await f.platform.workItem.findMany({
      where: { projectId: made.id },
      orderBy: { rank: "asc" },
      include: { labels: { include: { label: true } }, state: true },
    });
    expect(tasks.map((t) => [t.number, t.title, t.type, t.kind, t.depth, t.state.name ?? t.state.seedKey, t.visibility, t.source])).toEqual([
      [1, "Task epic", "EPIC", "TASK", 0, "Ready", "INTERNAL", "IN_APP"],
      [2, "Task child", "TASK", "TASK", 1, "Ready", "INTERNAL", "IN_APP"],
      [3, "Task sub", "SUBTASK", "TASK", 2, "Ready", "INTERNAL", "IN_APP"],
      [4, "Task backlog", "TASK", "BUG", 0, "BACKLOG", "INTERNAL", "IN_APP"],
      [5, "Task doing", "TASK", "TASK", 0, "Ready", "INTERNAL", "IN_APP"],
    ]);
    const byTitle = new Map(tasks.map((t) => [t.title, t]));
    const child = byTitle.get("Task child")!;
    expect(child.parentId).toBe(byTitle.get("Task epic")!.id);
    expect(byTitle.get("Task sub")!.rootId).toBe(byTitle.get("Task epic")!.id);
    expect(child).toMatchObject({ estimateMinutes: 90, checklistTotal: 1, checklistDone: 0, descriptionText: expect.stringContaining("Buy the domain") });
    expect(child.startDate?.toISOString()).toBe("2026-05-04T00:00:00.000Z");
    expect(child.targetDate?.toISOString()).toBe("2026-05-18T00:00:00.000Z");
    expect(byTitle.get("Task sub")!.targetDate?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(child.labels.map((l) => l.label.name).sort()).toEqual(["Copy", "Design"]);
    expect(byTitle.get("Task epic")!.milestoneId).toBe(milestones[0]!.id);
    expect(tasks.every((t) => t.assigneeMemberId === null && t.startedAt === null && t.completedAt === null)).toBe(true);

    // The trail: the project, each milestone and task, the birth outside the
    // start stage, and the template applied.
    const created = (await f.audits("work_item.created")).filter((a) => (a.metadata as { projectId: string }).projectId === made.id);
    expect(created).toHaveLength(5);
    expect(created.every((a) => (a.metadata as { templateId: string; visibility: string }).templateId === templateId)).toBe(true);
    const moved = (await f.audits("work_item.state_changed")).filter((a) => (a.metadata as { projectId: string }).projectId === made.id);
    expect(moved.map((a) => a.metadata)).toEqual([{ from: "TODO", to: "BACKLOG", projectId: made.id }]);
    expect((await f.audits("milestone.created")).filter((a) => (a.metadata as { projectId: string }).projectId === made.id)).toHaveLength(1);
    const applied = (await f.audits("project_template.applied")).find((a) => (a.metadata as { projectId: string }).projectId === made.id)!;
    expect(applied).toMatchObject({ targetId: templateId, metadata: { name: "Website launch", projectId: made.id, tasks: 5, milestones: 1 } });
    // The history rows are private, and a new task numbers after the template's.
    const activity = await f.platform.workItemActivity.findMany({ where: { projectId: made.id } });
    expect(activity.length).toBe(6);
    expect(activity.every((a) => a.visibility === "INTERNAL")).toBe(true);
  });

  it("makes a label deleted since the save again for a member who may manage labels, and leaves it off for one who may not", async () => {
    await f.platform.workItemLabel.deleteMany({ where: { tenantId: f.tenantId, labelId: copyLabelId } });
    await f.platform.label.delete({ where: { id: copyLabelId } });

    // A role that may make projects and tasks but not labels — every code the
    // gates ask, and no `label:manage`.
    const lead = await seatWith("Lead, no labels", [
      "client:view",
      "client:view_all",
      "project:view",
      "project:create",
      "project:manage_versions",
      "work_item:view",
      "work_item:create",
      "work_item:edit",
    ]);
    const without = await createProjectFromTemplate(lead, { clientId, key: "TPLNL", name: "No labels", templateId, startDate: day("2026-05-04") });
    const leadsChild = await f.platform.workItem.findFirstOrThrow({
      where: { projectId: without.id, title: "Task child" },
      include: { labels: { include: { label: true } } },
    });
    expect(leadsChild.labels.map((l) => l.label.name)).toEqual(["Design"]);
    expect(await f.platform.label.count({ where: { tenantId: f.tenantId, name: "Copy" } })).toBe(0);

    const withLabels = await createProjectFromTemplate(owner(), { clientId, key: "TPLLB", name: "Labels again", templateId, startDate: day("2026-05-04") });
    const ownersChild = await f.platform.workItem.findFirstOrThrow({
      where: { projectId: withLabels.id, title: "Task child" },
      include: { labels: { include: { label: true } } },
    });
    expect(ownersChild.labels.map((l) => l.label.name).sort()).toEqual(["Copy", "Design"]);
    const remade = await f.platform.label.findFirstOrThrow({ where: { tenantId: f.tenantId, name: "Copy" } });
    expect((await f.audits("label.created")).some((a) => a.targetId === remade.id)).toBe(true);
    copyLabelId = remade.id;
  });

  it("refuses a member who may not make projects, offers them nothing, and refuses a tampered template before writing anything", async () => {
    await expect(
      createProjectFromTemplate(employee(), { clientId, key: "TPLEMPL", name: "No", templateId, startDate: day("2026-05-04") }),
    ).rejects.toBeInstanceOf(AuthzError);
    expect((await listTemplateChoices(employee())).choices).toEqual([]);
    expect((await listTemplateChoices(owner())).choices).toEqual([{ id: templateId, name: "Website launch", tasks: 5, milestones: 1 }]);

    const bad = randomUUID();
    await f.platform.projectTemplate.create({
      data: { id: bad, tenantId: f.tenantId, name: "Tampered", definition: { v: 1, stages: [], milestones: [], labels: [], tasks: [] }, taskCount: 1 },
    });
    expect(await domainCode(createProjectFromTemplate(owner(), { clientId, key: "TPLBAD", name: "Bad", templateId: bad, startDate: day("2026-05-04") }))).toBe(
      "TEMPLATE_INVALID",
    );
    expect(await f.platform.project.count({ where: { tenantId: f.tenantId, key: "TPLBAD" } })).toBe(0);
    // A taken key refuses the whole project — nothing of the template is left behind.
    expect(await domainCode(createProjectFromTemplate(owner(), { clientId, key: "TPLNEW", name: "Again", templateId, startDate: day("2026-05-04") }))).toBe(
      "KEY_TAKEN",
    );
    await f.platform.projectTemplate.delete({ where: { id: bad } });
  });
});

describe("Settings → Templates", () => {
  it("lists with the counts and the source, renames ignoring-case-unique, and deletes — audited", async () => {
    const [row] = await listTemplates(owner());
    expect(row).toMatchObject({ name: "Website launch", tasks: 5, milestones: 1, source: { key: "TPLSRC", name: "Acme website" } });
    const other = await saveProjectAsTemplate(owner(), { projectId: sourceId, name: "Second", replace: false });
    const savedAt = (await stored(other.id)).savedAt;
    expect(await domainCode(renameTemplate(owner(), other.id, "website LAUNCH"))).toBe("TEMPLATE_NAME_TAKEN");
    expect(await renameTemplate(owner(), other.id, "Retainer")).toEqual({ name: "Retainer", changed: true });
    expect((await stored(other.id)).savedAt.getTime()).toBe(savedAt.getTime()); // a rename never moves "saved"
    expect((await f.audits("project_template.renamed")).find((a) => a.targetId === other.id)!.metadata).toEqual({ from: "Second", to: "Retainer" });
    await deleteTemplate(owner(), other.id);
    expect(await f.platform.projectTemplate.count({ where: { id: other.id } })).toBe(0);
    expect((await f.audits("project_template.deleted")).find((a) => a.targetId === other.id)!.metadata).toEqual({ name: "Retainer" });
  });

  it("the database holds the rules: one line, ignoring-case unique, an object, at most 4 MiB", async () => {
    const insert = (name: string, definition: unknown = { v: 1 }, taskCount = 0) =>
      f.platform.projectTemplate.create({ data: { tenantId: f.tenantId, name, definition: definition as object, taskCount } });
    expect(await brokenConstraint(insert(" padded"))).toContain("project_template_name_ok");
    expect(await brokenConstraint(insert("two\nlines"))).toContain("project_template_name_ok");
    expect(await brokenConstraint(insert("WEBSITE launch"))).toContain("project_template_name_ci_key");
    expect(await brokenConstraint(insert("An array", [1, 2]))).toContain("project_template_definition_object");
    expect(await brokenConstraint(insert("Too big", { v: 1, pad: "x".repeat(4 * 1024 * 1024) }))).toContain(
      "project_template_definition_size",
    );
    expect(await brokenConstraint(insert("Too many", { v: 1 }, 1001))).toContain("project_template_counts_range");
    expect(await f.platform.projectTemplate.count({ where: { tenantId: f.tenantId } })).toBe(1);
  });
});
