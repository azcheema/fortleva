import { describe, expect, it } from "vitest";

import { builtInPreset } from "../stage-preset";
import {
  buildDefinition,
  dayAfter,
  dayOffsetFrom,
  definitionBytes,
  parseDefinition,
  takeTasks,
  untickChecklists,
  type SourceMilestone,
  type SourceStage,
  type SourceTask,
  type SourceTaskHead,
  type TemplateDefinition,
} from "./definition";

// The built-in set as a project holds it, plus Triage (which a template leaves out).
const STAGES: SourceStage[] = [
  ...builtInPreset().map((s) => ({ ...s, id: `state-${s.seedKey}` })),
  { id: "state-TRIAGE", name: null, seedKey: "TRIAGE", category: "TRIAGE", isDefault: false, requiresApproval: false },
];
const ANCHOR = new Date("2026-03-02T00:00:00.000Z");

const head = (over: Partial<SourceTaskHead> & { id: string }): SourceTaskHead => ({
  parentId: null,
  depth: 0,
  type: "TASK",
  kind: "TASK",
  stateCategory: "TODO",
  archivedAt: null,
  deletedAt: null,
  ...over,
});

const task = (over: Partial<SourceTask> & { id: string }): SourceTask => ({
  parentId: null,
  depth: 0,
  type: "TASK",
  kind: "TASK",
  stateCategory: "TODO",
  archivedAt: null,
  deletedAt: null,
  title: `Task ${over.id}`,
  stateId: "state-TODO",
  estimateMinutes: null,
  startDate: null,
  targetDate: null,
  milestoneId: null,
  labelIds: [],
  description: null,
  ...over,
});

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

const build = (tasks: SourceTask[], milestones: SourceMilestone[] = [], labels = [] as { id: string; name: string; color: string | null }[]) =>
  buildDefinition({ stages: STAGES, milestones, labels, tasks, anchor: ANCHOR })!;

describe("takeTasks — which tasks a template takes (design §4)", () => {
  it("leaves out deleted, archived, requests, triage and cancelled, and keeps rank order", () => {
    const rows = [
      head({ id: "a" }),
      head({ id: "deleted", deletedAt: new Date() }),
      head({ id: "archived", archivedAt: new Date() }),
      head({ id: "request", kind: "REQUEST" }),
      head({ id: "triage", stateCategory: "TRIAGE" }),
      head({ id: "cancelled", stateCategory: "CANCELLED" }),
      head({ id: "done", stateCategory: "DONE" }),
      head({ id: "bug", kind: "BUG", stateCategory: "IN_PROGRESS" }),
    ];
    expect(takeTasks(rows)).toEqual(["a", "done", "bug"]);
  });

  it("drops a left-out parent's whole subtree, and keeps a taken parent's children", () => {
    const rows = [
      head({ id: "epic", type: "EPIC" }),
      head({ id: "child", parentId: "epic", depth: 1 }),
      head({ id: "grandchild", type: "SUBTASK", parentId: "child", depth: 2 }),
      head({ id: "gone", stateCategory: "CANCELLED" }),
      head({ id: "orphan", type: "SUBTASK", parentId: "gone", depth: 1 }),
      head({ id: "orphan2", type: "SUBTASK", parentId: "missing", depth: 1 }),
    ];
    expect(takeTasks(rows)).toEqual(["epic", "child", "grandchild"]);
  });
});

describe("buildDefinition — the document a template stores", () => {
  it("takes the stages without Triage, and the project's start stage", () => {
    const d = build([task({ id: "a" })]);
    expect(d.stages.map((s) => s.category)).toEqual(["BACKLOG", "TODO", "IN_PROGRESS", "IN_PROGRESS", "DONE", "CANCELLED"]);
    expect(d.stages.map((s) => s.key)).toEqual(["s0", "s1", "s2", "s3", "s4", "s5"]);
    expect(d.stages.find((s) => s.isDefault)?.category).toBe("TODO");
    expect(parseDefinition(d)).not.toBeNull();
  });

  it("starts a task where it was when that is Backlog or To do, and fresh otherwise", () => {
    const d = build([
      task({ id: "backlog", stateId: "state-BACKLOG", stateCategory: "BACKLOG" }),
      task({ id: "todo" }),
      task({ id: "doing", stateId: "state-IN_PROGRESS", stateCategory: "IN_PROGRESS" }),
      task({ id: "done", stateId: "state-DONE", stateCategory: "DONE" }),
    ]);
    const stageOf = (key: string) => d.stages.find((s) => s.key === key)!.category;
    expect(d.tasks.map((t) => stageOf(t.stage))).toEqual(["BACKLOG", "TODO", "TODO", "TODO"]);
  });

  it("never starts a task in a stage that needs approval, even a To do one", () => {
    const gated: SourceStage[] = STAGES.map((s) =>
      s.seedKey === "BACKLOG" ? { ...s, category: "BACKLOG", requiresApproval: true } : s,
    );
    const d = buildDefinition({
      stages: gated,
      milestones: [],
      labels: [],
      tasks: [task({ id: "a", stateId: "state-BACKLOG", stateCategory: "BACKLOG" })],
      anchor: ANCHOR,
    })!;
    expect(d.stages.find((s) => s.key === d.tasks[0]!.stage)!.category).toBe("TODO");
  });

  it("keeps the tree, the milestones but a cancelled one, the worn labels and the dates as days", () => {
    const d = build(
      [
        task({ id: "epic", type: "EPIC", milestoneId: "m-live", labelIds: ["l-used"] }),
        task({
          id: "child",
          parentId: "epic",
          depth: 1,
          estimateMinutes: 90,
          startDate: new Date("2026-03-02T00:00:00.000Z"),
          targetDate: new Date("2026-03-16T00:00:00.000Z"),
          milestoneId: "m-cancelled",
        }),
        task({ id: "sub", type: "SUBTASK", parentId: "child", depth: 2, targetDate: new Date("2026-02-27T00:00:00.000Z") }),
      ],
      [
        { id: "m-live", name: "Launch", description: "Go live", status: "IN_PROGRESS", dueAt: new Date("2026-04-01T00:00:00.000Z") },
        { id: "m-cancelled", name: "Dropped", description: null, status: "CANCELLED", dueAt: null },
      ],
      [
        { id: "l-used", name: "Design", color: "blue" },
        { id: "l-unused", name: "Never", color: null },
      ],
    );
    expect(d.milestones).toEqual([{ key: "m0", name: "Launch", description: "Go live", dueDay: 30 }]);
    expect(d.labels).toEqual([{ key: "l0", id: "l-used", name: "Design", color: "blue" }]);
    expect(d.tasks.map((t) => [t.key, t.parent, t.type, t.milestone, t.labels])).toEqual([
      ["t0", null, "EPIC", "m0", ["l0"]],
      ["t1", "t0", "TASK", null, []],
      ["t2", "t1", "SUBTASK", null, []],
    ]);
    expect(d.tasks[1]).toMatchObject({ estimateMinutes: 90, startDay: 0, targetDay: 14 });
    expect(d.tasks[2]!.targetDay).toBe(-3);
    const parsed = parseDefinition(d)!;
    expect(parsed.tasks.map((t) => t.depth)).toEqual([0, 1, 2]);
  });

  it("unticks every checklist item and keeps the words", () => {
    const d = build([task({ id: "a", description: checklistDoc(true) })]);
    const text = JSON.stringify(d.tasks[0]!.description);
    expect(text).toContain("Buy the domain");
    expect(text).toContain('"checked":false');
    expect(text).not.toContain('"checked":true');
  });

  it("keeps at most 50 labels on a task, in the labels' order, and the document still parses", () => {
    const labels = Array.from({ length: 60 }, (_, i) => ({ id: `l-${String(i).padStart(2, "0")}`, name: `L${i}`, color: null }));
    const d = build([task({ id: "a", labelIds: labels.map((l) => l.id).reverse() })], [], labels);
    expect(d.tasks[0]!.labels).toHaveLength(50);
    expect(d.tasks[0]!.labels.slice(0, 3)).toEqual(["l0", "l1", "l2"]);
    // Only the 50 it keeps enter the document.
    expect(d.labels.map((l) => l.id)).toEqual(labels.slice(0, 50).map((l) => l.id));
    expect(parseDefinition(d)).not.toBeNull();
  });

  it("drops a date more than ten years from the anchor rather than refusing the template", () => {
    const d = build([task({ id: "a", targetDate: new Date("2040-01-01T00:00:00.000Z") })]);
    expect(d.tasks[0]!.targetDay).toBeNull();
  });

  it("returns null for a stage set a new project could not be seeded with", () => {
    const broken = STAGES.map((s) => ({ ...s, isDefault: false }));
    expect(buildDefinition({ stages: broken, milestones: [], labels: [], tasks: [], anchor: ANCHOR })).toBeNull();
  });
});

describe("parseDefinition — never trusted", () => {
  const good = (): TemplateDefinition =>
    build([
      task({ id: "epic", type: "EPIC" }),
      task({ id: "child", parentId: "epic", depth: 1 }),
      task({ id: "sub", type: "SUBTASK", parentId: "child", depth: 2 }),
    ]);
  const broken = (mutate: (d: TemplateDefinition) => void) => {
    const d = structuredClone(good());
    mutate(d);
    return parseDefinition(d);
  };

  it("accepts what buildDefinition wrote", () => {
    expect(parseDefinition(good())).not.toBeNull();
  });

  it.each([
    ["another version", (d: TemplateDefinition) => Object.assign(d, { v: 2 })],
    ["an unknown field", (d: TemplateDefinition) => Object.assign(d.tasks[0]!, { assignee: "m1" })],
    ["a stage key that does not exist", (d: TemplateDefinition) => Object.assign(d.tasks[0]!, { stage: "s9" })],
    ["a start in a Done stage", (d: TemplateDefinition) => Object.assign(d.tasks[0]!, { stage: "s4" })],
    ["a start in In progress", (d: TemplateDefinition) => Object.assign(d.tasks[0]!, { stage: "s2" })],
    ["a milestone that does not exist", (d: TemplateDefinition) => Object.assign(d.tasks[0]!, { milestone: "m0" })],
    ["a label that does not exist", (d: TemplateDefinition) => Object.assign(d.tasks[0]!, { labels: ["l0"] })],
    ["a parent that does not exist", (d: TemplateDefinition) => Object.assign(d.tasks[1]!, { parent: "t9" })],
    ["an Epic with a parent", (d: TemplateDefinition) => Object.assign(d.tasks[0]!, { parent: "t1" })],
    ["a Subtask with no parent", (d: TemplateDefinition) => Object.assign(d.tasks[2]!, { parent: null })],
    ["a Task under a Subtask", (d: TemplateDefinition) => Object.assign(d.tasks[1]!, { parent: "t2" })],
    ["a Task under a Task", (d: TemplateDefinition) => Object.assign(d.tasks[2]!, { type: "TASK" })],
    ["a repeated key", (d: TemplateDefinition) => Object.assign(d.tasks[1]!, { key: "t0" })],
    ["a stage set with no start stage", (d: TemplateDefinition) => d.stages.forEach((s) => Object.assign(s, { isDefault: false }))],
    ["a day past ten years", (d: TemplateDefinition) => Object.assign(d.tasks[0]!, { targetDay: 4000 })],
    ["a blank title", (d: TemplateDefinition) => Object.assign(d.tasks[0]!, { title: "" })],
  ])("refuses %s", (_label, mutate) => {
    expect(broken(mutate)).toBeNull();
  });

  it("refuses a parent cycle", () => {
    const d = structuredClone(good());
    // Two Tasks naming each other: never a strictly higher level, so refused.
    d.tasks = [
      { ...d.tasks[1]!, key: "t0", parent: "t1" },
      { ...d.tasks[1]!, key: "t1", parent: "t0" },
    ];
    expect(parseDefinition(d)).toBeNull();
  });
});

describe("the small helpers", () => {
  it("counts whole days from the anchor across a month end and a DST change", () => {
    expect(dayOffsetFrom(ANCHOR, new Date("2026-03-30T00:00:00.000Z"))).toBe(28);
    expect(dayOffsetFrom(ANCHOR, new Date("2026-02-28T00:00:00.000Z"))).toBe(-2);
    expect(dayAfter(new Date("2026-03-27T00:00:00.000Z"), 3).toISOString()).toBe("2026-03-30T00:00:00.000Z");
    expect(dayAfter(new Date("2026-03-27T15:30:00.000Z"), 0).toISOString()).toBe("2026-03-27T00:00:00.000Z");
  });

  it("unticks without touching the stored document", () => {
    const doc = checklistDoc(true);
    const out = untickChecklists(doc);
    expect(JSON.stringify(out)).toContain('"checked":false');
    expect(JSON.stringify(doc)).toContain('"checked":true');
  });

  it("measures the document as JSON.stringify writes it", () => {
    const d = build([task({ id: "a" })]);
    expect(definitionBytes(d)).toBe(Buffer.byteLength(JSON.stringify(d)));
  });
});
