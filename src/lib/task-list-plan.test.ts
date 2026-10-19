import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  TASKS_PROJECT_KEY_RE,
  dueBounds,
  groupTasks,
  hasTaskFilters,
  isOverdue,
  parseTaskListParams,
  tasksHref,
  withSelfAsMe,
  type TaskAssignee,
  type TaskListParams,
} from "./task-list-plan";

const NONE: TaskListParams = { due: null, person: null, project: null, group: null, item: null, view: null };
const MEMBER = "0199a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b";
const VIEW = "0199a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a6c";

describe("parseTaskListParams — read strictly, nothing echoed", () => {
  it("reads every parameter it knows", () => {
    expect(
      parseTaskListParams({ due: "overdue", person: "none", project: "ACME", group: "person", item: "acme-12", view: VIEW.toUpperCase() }),
    ).toEqual({
      due: "overdue",
      person: { kind: "none" },
      project: "ACME",
      group: "person",
      item: { projectKey: "ACME", number: 12 },
      view: VIEW,
    });
    expect(parseTaskListParams({ due: "week", person: "me" })).toMatchObject({ due: "week", person: { kind: "me" } });
  });

  it("takes a member id as a person, lower-cased", () => {
    expect(parseTaskListParams({ person: MEMBER.toUpperCase() }).person).toEqual({ kind: "member", id: MEMBER });
  });

  it("falls back to the default for anything else", () => {
    expect(
      parseTaskListParams({
        due: "tomorrow",
        person: "<script>",
        project: "acme",
        group: "label",
        item: "ACME-0",
        view: "../tasks",
      }),
    ).toEqual(NONE);
    expect(parseTaskListParams({ project: "TOOLONGKEY", item: "ACME-1-2" })).toEqual(NONE);
    // A repeated parameter is no value at all.
    expect(parseTaskListParams({ due: ["overdue", "week"], project: ["ACME"] })).toEqual(NONE);
  });
});

describe("tasksHref — built from the parsed values only", () => {
  it("writes the defaults as no parameter", () => {
    expect(tasksHref(NONE)).toBe("/tasks");
  });

  it("writes each set parameter, the peek last", () => {
    expect(
      tasksHref({
        due: "week",
        person: { kind: "member", id: MEMBER },
        project: "ACME",
        group: "project",
        item: { projectKey: "ACME", number: 7 },
        view: VIEW,
      }),
    ).toBe(`/tasks?due=week&person=${MEMBER}&project=ACME&group=project&item=ACME-7&view=${VIEW}`);
    expect(tasksHref({ ...NONE, person: { kind: "none" } })).toBe("/tasks?person=none");
  });

  it("round-trips through the parser", () => {
    const p: TaskListParams = { due: "overdue", person: { kind: "me" }, project: "WEB", group: "person", item: { projectKey: "WEB", number: 3 }, view: VIEW };
    const q = Object.fromEntries(new URLSearchParams(tasksHref(p).split("?")[1]));
    expect(parseTaskListParams(q)).toEqual(p);
  });
});

describe("withSelfAsMe — the reader's own id is Me", () => {
  it("turns the reader's id, in any case, into Me and leaves anyone else alone", () => {
    expect(withSelfAsMe({ ...NONE, person: { kind: "member", id: MEMBER } }, MEMBER).person).toEqual({ kind: "me" });
    expect(withSelfAsMe(parseTaskListParams({ person: MEMBER.toUpperCase() }), MEMBER.toUpperCase()).person).toEqual({ kind: "me" });
    const other = { ...NONE, person: { kind: "member", id: MEMBER } } as const;
    expect(withSelfAsMe(other, "0199a2b3-c4d5-7e6f-8a9b-000000000000")).toBe(other);
    expect(withSelfAsMe({ ...NONE, person: { kind: "none" } }, MEMBER).person).toEqual({ kind: "none" });
  });
});

describe("the project key — the projects service's own shape", () => {
  it("restates PROJECT_KEY_RE exactly — the browser bundle cannot import it", () => {
    // Read from the SOURCE (the vault surface test's way): importing the
    // projects service reaches the database client, which a unit test has
    // no URL for.
    const source = readFileSync(join(process.cwd(), "src", "projects", "service.ts"), "utf8");
    const declared = /export const PROJECT_KEY_RE = (\/.+\/[a-z]*);/.exec(source)?.[1];
    expect(declared).toBeDefined();
    expect(String(TASKS_PROJECT_KEY_RE)).toBe(declared);
  });
});

describe("hasTaskFilters — grouping is not a filter", () => {
  it("is false with nothing set, or with only a grouping and a peek", () => {
    expect(hasTaskFilters(NONE)).toBe(false);
    expect(hasTaskFilters({ ...NONE, group: "project", item: { projectKey: "A", number: 1 } })).toBe(false);
  });

  it("is true with any of the three filters", () => {
    expect(hasTaskFilters({ ...NONE, due: "overdue" })).toBe(true);
    expect(hasTaskFilters({ ...NONE, person: { kind: "me" } })).toBe(true);
    expect(hasTaskFilters({ ...NONE, project: "ACME" })).toBe(true);
  });
});

describe("dueBounds and isOverdue", () => {
  // Thursday 2026-10-15.
  const today = "2026-10-15";

  it("OVERDUE is before today", () => {
    expect(dueBounds("overdue", today, "MONDAY")).toEqual({ before: today });
  });

  it("DUE THIS WEEK is the workspace's whole week, its passed days included", () => {
    expect(dueBounds("week", today, "MONDAY")).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    expect(dueBounds("week", today, "SUNDAY")).toEqual({ from: "2026-10-11", to: "2026-10-17" });
    expect(dueBounds("week", today, "SATURDAY")).toEqual({ from: "2026-10-10", to: "2026-10-16" });
  });

  it("a task is overdue only when its day is before today", () => {
    expect(isOverdue("2026-10-14", today)).toBe(true);
    expect(isOverdue(today, today)).toBe(false);
    expect(isOverdue("2026-10-16", today)).toBe(false);
    expect(isOverdue(null, today)).toBe(false);
  });
});

describe("groupTasks", () => {
  type R = { id: string; projectKey: string; projectName: string; assignee: TaskAssignee };
  const ada: TaskAssignee = { kind: "member", id: "m-ada", name: "Ada" };
  const bo: TaskAssignee = { kind: "member", id: "m-bo", name: "Bo" };
  const cleo: TaskAssignee = { kind: "contact", id: "c-cleo", name: "Aaron at client" };
  const none: TaskAssignee = { kind: "none" };
  const rows: R[] = [
    { id: "1", projectKey: "WEB", projectName: "Website", assignee: bo },
    { id: "2", projectKey: "APP", projectName: "App", assignee: none },
    { id: "3", projectKey: "WEB", projectName: "Website", assignee: cleo },
    { id: "4", projectKey: "SEO", projectName: "App", assignee: ada },
    { id: "5", projectKey: "APP", projectName: "App", assignee: bo },
  ];
  const compare = (a: string, b: string) => a.localeCompare(b, "en");

  it("by project: projects by name then key, rows kept in arrival order", () => {
    const groups = groupTasks(rows, "project", compare);
    expect(groups.map((g) => g.key)).toEqual(["project:APP", "project:SEO", "project:WEB"]);
    expect(groups[0]!.rows.map((r) => r.id)).toEqual(["2", "5"]);
    expect(groups[2]!.rows.map((r) => r.id)).toEqual(["1", "3"]);
  });

  it("by person: Nobody first, then members by name, then contacts — whatever their names", () => {
    const groups = groupTasks(rows, "person", compare);
    expect(groups.map((g) => g.key)).toEqual(["none", "member:m-ada", "member:m-bo", "contact:c-cleo"]);
    expect(groups[2]!.rows.map((r) => r.id)).toEqual(["1", "5"]);
  });

  it("two people with one name stay two groups", () => {
    const twin: TaskAssignee = { kind: "member", id: "m-ada-2", name: "Ada" };
    const groups = groupTasks([...rows, { id: "6", projectKey: "WEB", projectName: "Website", assignee: twin }], "person", compare);
    expect(groups.map((g) => g.key)).toEqual(["none", "member:m-ada", "member:m-ada-2", "member:m-bo", "contact:c-cleo"]);
  });
});
