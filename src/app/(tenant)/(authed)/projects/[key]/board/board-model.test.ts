import { describe, expect, it } from "vitest";

import {
  applyMove,
  cardsIn,
  edgeAnchors,
  epicIdsOf,
  laneKeyOf,
  lanesFor,
  visibleColumns,
  type BoardItem,
  type BoardState,
} from "./board-model";

const state = (id: string, category: string, isHidden = false): BoardState => ({
  id,
  name: id,
  category,
  isHidden,
  isDefault: category === "TODO",
  wipLimit: null,
});

const item = (id: string, over: Partial<BoardItem> = {}): BoardItem => ({
  id,
  number: Number(id.replace(/\D/g, "")) || 0,
  title: id,
  type: "TASK",
  stateId: "todo",
  stateCategory: "TODO",
  stateName: "todo",
  priority: "NONE",
  estimateMinutes: null,
  targetDate: null,
  visibility: "INTERNAL",
  assigneeMemberId: null,
  assigneeName: null,
  rootId: id,
  parentId: null,
  archivedAt: null,
  checklistTotal: 0,
  checklistDone: 0,
  ...over,
});

const STATES = [state("todo", "TODO"), state("prog", "IN_PROGRESS"), state("triage", "TRIAGE", true)];

describe("visibleColumns", () => {
  it("hides a hidden state until it has items", () => {
    expect(visibleColumns(STATES, [item("t1")]).map((s) => s.id)).toEqual(["todo", "prog"]);
    expect(visibleColumns(STATES, [item("t1", { stateId: "triage" })]).map((s) => s.id)).toEqual([
      "todo",
      "prog",
      "triage",
    ]);
  });
});

describe("applyMove — the optimistic rewrite mirrors the server", () => {
  const items = [item("a"), item("b"), item("c"), item("d")];
  const ids = (xs: BoardItem[]) => xs.map((i) => i.id);

  it("after wins over before; before inserts ahead; no anchor = bottom", () => {
    expect(ids(applyMove(items, { itemId: "d", afterId: "a", beforeId: "c" }, STATES))).toEqual(["a", "d", "b", "c"]);
    expect(ids(applyMove(items, { itemId: "a", beforeId: "c" }, STATES))).toEqual(["b", "a", "c", "d"]);
    expect(ids(applyMove(items, { itemId: "b" }, STATES))).toEqual(["a", "c", "d", "b"]);
  });

  it("a self anchor or an unknown anchor keeps the position; the state still changes", () => {
    const self = applyMove(items, { itemId: "c", afterId: "c", stateId: "prog" }, STATES);
    expect(ids(self)).toEqual(["a", "b", "c", "d"]);
    expect(self[2]!.stateId).toBe("prog");
    expect(self[2]!.stateCategory).toBe("IN_PROGRESS");
    expect(ids(applyMove(items, { itemId: "c", beforeId: "zz" }, STATES))).toEqual(["a", "b", "c", "d"]);
    expect(ids(applyMove(items, { itemId: "nope", afterId: "a" }, STATES))).toEqual(["a", "b", "c", "d"]);
  });

  it("never mutates the input", () => {
    const copy = items.map((i) => ({ ...i }));
    applyMove(items, { itemId: "a", afterId: "d" }, STATES);
    expect(items).toEqual(copy);
  });
});

describe("lanes", () => {
  const members = [
    { id: "m2", name: "Zed" },
    { id: "m1", name: "Anna" },
    { id: "m3", name: "Idle" },
  ];
  const items = [
    item("e1", { type: "EPIC" }),
    item("t1", { rootId: "e1", parentId: "e1", assigneeMemberId: "m2", assigneeName: "Zed", priority: "HIGH" }),
    item("t2", { assigneeMemberId: "m1", assigneeName: "Anna", stateId: "prog", stateCategory: "IN_PROGRESS" }),
    item("t3"),
    // A subtree under an epic that is NOT in the list (archived) …
    item("t4", { rootId: "gone", parentId: "gone" }),
    // … and a SUBTASK under a plain task: neither owns an epic lane.
    item("t5", { type: "SUBTASK", rootId: "t3", parentId: "t3" }),
  ];

  it("assignee: members with items alphabetically, then Unassigned", () => {
    expect(lanesFor("assignee", items, members).map((l) => l.key)).toEqual(["m:m1", "m:m2", "unassigned"]);
  });

  it("priority: URGENT → NONE, always all five", () => {
    expect(lanesFor("priority", items, members).map((l) => l.key)).toEqual([
      "p:URGENT",
      "p:HIGH",
      "p:MEDIUM",
      "p:LOW",
      "p:NONE",
    ]);
  });

  it("epic: only real epics own a lane, then No epic; the epic itself is not a card; orphans and task-subtasks are No epic", () => {
    const lanes = lanesFor("epic", items, members);
    expect(lanes.map((l) => l.key)).toEqual(["e:e1", "no-epic"]);
    const epics = epicIdsOf(items);
    expect(laneKeyOf(items[0]!, "epic", epics)).toBe("e:e1");
    expect(laneKeyOf(items[4]!, "epic", epics)).toBe("no-epic");
    expect(laneKeyOf(items[5]!, "epic", epics)).toBe("no-epic");
    expect(cardsIn(items, "epic", "e:e1", "todo").map((i) => i.id)).toEqual(["t1"]);
    expect(cardsIn(items, "epic", "no-epic", "todo").map((i) => i.id)).toEqual(["t3", "t4", "t5"]);
  });

  it("none: one lane with everything", () => {
    expect(lanesFor("none", items, members)).toEqual([{ key: "all", kind: "all" }]);
    expect(cardsIn(items, "none", "all", "todo").map((i) => i.id)).toEqual(["e1", "t1", "t3", "t4", "t5"]);
  });

  it("edgeAnchors: top = before the first card, bottom = after the last (moved item excluded); an empty column = keep the position (self anchor)", () => {
    expect(edgeAnchors(items, "none", "all", "todo", "t1")).toEqual({
      top: { beforeId: "e1" },
      bottom: { afterId: "t5" },
    });
    expect(edgeAnchors(items, "none", "all", "prog", "t2")).toEqual({
      top: { afterId: "t2" },
      bottom: { afterId: "t2" },
    });
  });
});
