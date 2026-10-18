import { describe, expect, it } from "vitest";

import { stageInTarget, type StageRef } from "./move-plan";

const stage = (id: string, over: Partial<StageRef>): StageRef => ({
  id,
  name: null,
  seedKey: null,
  category: "TODO",
  rank: "m",
  isDefault: false,
  ...over,
});

// A target project: its seeded stages, one renamed, plus one of its own.
const TARGET: StageRef[] = [
  stage("backlog", { seedKey: "backlog", category: "BACKLOG", rank: "a", isDefault: true }),
  stage("todo", { seedKey: "todo", category: "TODO", rank: "b" }),
  stage("doing", { name: "Doing", seedKey: "in_progress", category: "IN_PROGRESS", rank: "c" }),
  stage("review", { name: "Client review", category: "IN_PROGRESS", rank: "d" }),
  stage("done", { seedKey: "done", category: "DONE", rank: "e" }),
  stage("triage", { seedKey: "triage", category: "TRIAGE", rank: "0" }),
];

describe("stageInTarget — where a moved task lands", () => {
  it("1. takes the stage of the same kind with the same name, ignoring case and spaces", () => {
    expect(stageInTarget({ name: "  client REVIEW ", seedKey: null, category: "IN_PROGRESS" }, TARGET)).toBe("review");
    expect(stageInTarget({ name: "doing", seedKey: null, category: "IN_PROGRESS" }, TARGET)).toBe("doing");
  });

  it("never matches a name across kinds — a move never finishes or reopens a task", () => {
    // "Doing" is IN_PROGRESS there: a TO DO named so stays to do.
    expect(stageInTarget({ name: "doing", seedKey: null, category: "TODO" }, TARGET)).toBe("todo");
    const doneNamedQa: StageRef[] = [...TARGET, stage("qa-done", { name: "QA", category: "DONE", rank: "f" })];
    expect(stageInTarget({ name: "QA", seedKey: null, category: "IN_PROGRESS" }, doneNamedQa)).toBe("doing");
  });

  it("2. else the stage seeded as the same default, whatever either project calls it", () => {
    // Untouched "In progress" here; renamed "Doing" there — the same stage.
    expect(stageInTarget({ name: null, seedKey: "in_progress", category: "IN_PROGRESS" }, TARGET)).toBe("doing");
    // Renamed here, and no stage of that name there: the seed decides.
    expect(stageInTarget({ name: "Ready", seedKey: "todo", category: "TODO" }, TARGET)).toBe("todo");
  });

  it("3. else the first stage of the same kind, by column order", () => {
    expect(stageInTarget({ name: "QA", seedKey: null, category: "IN_PROGRESS" }, TARGET)).toBe("doing");
    expect(stageInTarget({ name: "Shipped", seedKey: null, category: "DONE" }, TARGET)).toBe("done");
    expect(stageInTarget({ name: null, seedKey: null, category: "TRIAGE" }, TARGET)).toBe("triage");
  });

  it("4. else where new tasks start", () => {
    const noCancelled = TARGET;
    expect(stageInTarget({ name: "Dropped", seedKey: "cancelled", category: "CANCELLED" }, noCancelled)).toBe("backlog");
  });

  it("is null only for a project with no stages", () => {
    expect(stageInTarget({ name: null, seedKey: "todo", category: "TODO" }, [])).toBeNull();
  });
});
