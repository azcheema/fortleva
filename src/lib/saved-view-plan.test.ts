import { describe, expect, it } from "vitest";

import {
  SAVED_VIEW_LIST_MAX,
  SAVED_VIEW_NAME_MAX,
  SAVED_VIEW_QUERY_MAX,
  backlogScreenQuery,
  canonicalBacklogQuery,
  canonicalTasksQuery,
  canonicalViewQuery,
  savedViewHref,
  savedViewName,
  searchOf,
  viewParamOf,
} from "./saved-view-plan";
import { tasksHref } from "./task-list-plan";

const SELF = "0199a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b";
const OTHER = "0199a2b3-c4d5-7e6f-8a9b-000000000001";
const S1 = "0199a2b3-c4d5-7e6f-8a9b-00000000000a";
const S2 = "0199a2b3-c4d5-7e6f-8a9b-00000000000b";
const VIEW = "0199a2b3-c4d5-7e6f-8a9b-0000000000ff";

/** The database's outline (CHECK `saved_view_query_ok`). */
const OUTLINE = /^[A-Za-z0-9=&,_-]*$/;

describe("canonicalTasksQuery — the Tasks page's filters, one spelling", () => {
  it("keeps the four filters in a fixed order and drops everything else", () => {
    expect(
      canonicalTasksQuery(searchOf("group=person&project=WEB&item=WEB-3&person=none&due=overdue&view=x&error=y"), SELF),
    ).toBe("due=overdue&person=none&project=WEB&group=person");
  });

  it("writes the reader's own id as me, and any other member lower-cased", () => {
    expect(canonicalTasksQuery(searchOf(`person=${SELF.toUpperCase()}`), SELF)).toBe("person=me");
    expect(canonicalTasksQuery(searchOf(`person=${OTHER.toUpperCase()}`), SELF)).toBe(`person=${OTHER}`);
  });

  it("reads what the page would ignore as no filter", () => {
    expect(canonicalTasksQuery(searchOf("due=tomorrow&person=<x>&project=web&group=label"), SELF)).toBe("");
  });

  it("is the same for what tasksHref writes, so an open view compares equal", () => {
    const href = tasksHref({ due: "week", person: { kind: "me" }, project: "ACME", group: "project", item: { projectKey: "ACME", number: 2 }, view: VIEW });
    expect(canonicalTasksQuery(searchOf(href.split("?")[1]!), SELF)).toBe("due=week&person=me&project=ACME&group=project");
  });
});

describe("canonicalBacklogQuery — a backlog's filters, one spelling", () => {
  it("sorts and de-duplicates the lists, orders priorities as the product does, keeps the flags", () => {
    expect(
      canonicalBacklogQuery(
        searchOf(`group=assignee&hideDone=true&priority=URGENT,LOW,URGENT&assignee=client,${OTHER.toUpperCase()},none&state=${S2},${S1},${S2}`),
      ),
    ).toEqual({
      ok: true,
      query: `state=${S1},${S2}&assignee=${OTHER},client,none&priority=LOW,URGENT&hideDone=true&group=assignee`,
    });
  });

  it("writes defaults as no key", () => {
    expect(canonicalBacklogQuery(searchOf("group=none&hideDone=false&archived=1&item=WEB-2&view=x"))).toEqual({ ok: true, query: "" });
  });

  it("refuses what a view could not keep honestly", () => {
    expect(canonicalBacklogQuery(searchOf("state=todo")).ok).toBe(false);
    expect(canonicalBacklogQuery(searchOf("assignee=everyone")).ok).toBe(false);
    expect(canonicalBacklogQuery(searchOf("priority=HUGE")).ok).toBe(false);
    const many = Array.from({ length: SAVED_VIEW_LIST_MAX + 1 }, (_, i) => `0199a2b3-c4d5-7e6f-8a9b-${String(i).padStart(12, "0")}`);
    expect(canonicalBacklogQuery(searchOf(`state=${many.join(",")}`)).ok).toBe(false);
    expect(canonicalBacklogQuery(searchOf(`state=${many.slice(1).join(",")}`)).ok).toBe(true);
  });

  it("stays inside the database's outline and bound at its largest", () => {
    const ids = (seed: string) =>
      Array.from({ length: SAVED_VIEW_LIST_MAX }, (_, i) => `${seed}-c4d5-7e6f-8a9b-${String(i).padStart(12, "0")}`).join(",");
    const r = canonicalBacklogQuery(
      searchOf(`state=${ids("0199a2b3")}&assignee=${ids("0199a2b4")}&priority=NONE,LOW,MEDIUM,HIGH,URGENT&hideDone=true&group=priority`),
    );
    expect(r.ok).toBe(true);
    const query = (r as { query: string }).query;
    expect(query).toMatch(OUTLINE);
    expect(query.length).toBeLessThanOrEqual(SAVED_VIEW_QUERY_MAX);
  });
});

describe("backlogScreenQuery — the filter bar's state as a view keeps it", () => {
  it("is canonical for what the bar can set", () => {
    expect(backlogScreenQuery({ state: [S2, S1], assignee: ["none"], priority: ["HIGH"], hideDone: true, group: "epic" })).toBe(
      `state=${S1},${S2}&assignee=none&priority=HIGH&hideDone=true&group=epic`,
    );
    expect(backlogScreenQuery({ state: [], assignee: [], priority: [], hideDone: false, group: "none" })).toBe("");
  });

  it("passes a value the bar could not have set through as written, for the service to refuse", () => {
    const q = backlogScreenQuery({ state: ["todo"], assignee: [], priority: [], hideDone: false, group: "none" });
    expect(q).toBe("state=todo");
    expect(canonicalViewQuery("BACKLOG", searchOf(q), SELF).ok).toBe(false);
  });
});

describe("the open view and its address", () => {
  it("reads ?view= strictly", () => {
    expect(viewParamOf({ view: VIEW.toUpperCase() })).toBe(VIEW);
    expect(viewParamOf(new URLSearchParams(`view=${VIEW}`))).toBe(VIEW);
    expect(viewParamOf({ view: "javascript:alert(1)" })).toBeNull();
    expect(viewParamOf({})).toBeNull();
  });

  it("opens the list with its filters, the view last", () => {
    expect(savedViewHref("TASKS", null, "due=overdue", VIEW)).toBe(`/tasks?due=overdue&view=${VIEW}`);
    expect(savedViewHref("TASKS", null, "", VIEW)).toBe(`/tasks?view=${VIEW}`);
    expect(savedViewHref("BACKLOG", "WEB", "hideDone=true", VIEW)).toBe(`/projects/WEB/backlog?hideDone=true&view=${VIEW}`);
  });
});

describe("savedViewName — one line, short, visible", () => {
  it("collapses whitespace and trims", () => {
    expect(savedViewName("  My\toverdue\n tasks ")).toEqual({ ok: true, name: "My overdue tasks" });
  });

  it("refuses blank, too long and invisible", () => {
    expect(savedViewName("   ")).toEqual({ ok: false, code: "NAME_REQUIRED" });
    expect(savedViewName("x".repeat(SAVED_VIEW_NAME_MAX + 1)).ok).toBe(false);
    expect(savedViewName("x".repeat(SAVED_VIEW_NAME_MAX)).ok).toBe(true);
    expect(savedViewName(`Mine${String.fromCodePoint(0x202e)}`).ok).toBe(false);
  });
});
