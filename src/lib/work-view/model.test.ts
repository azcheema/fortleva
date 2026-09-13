import { describe, expect, it } from "vitest";

import {
  GROUP_BYS,
  NO_FILTERS,
  UNASSIGNED,
  activeFilterCount,
  allRowAnchors,
  applyMove,
  canEnterState,
  cardsIn,
  edgeAnchors,
  enterableStates,
  epicIdsOf,
  filterItems,
  hasActiveFilters,
  isDone,
  laneKeyOf,
  lanesFor,
  rowAnchors,
  stateOrdinalKeys,
  statePickerTargets,
  visibleColumns,
  workView,
  type StatePickerTarget,
  type WorkFilters,
  type WorkItem,
  type WorkRow,
  type WorkState,
} from "./model";

const state = (id: string, category: string, isHidden = false, requiresApproval = false): WorkState => ({
  id,
  name: id,
  category,
  isHidden,
  isDefault: category === "TODO",
  wipLimit: null,
  requiresApproval,
});

const item = (id: string, over: Partial<WorkItem> = {}): WorkItem => ({
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
  attachmentCount: 0,
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
  const ids = (xs: WorkItem[]) => xs.map((i) => i.id);

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

  it("edgeAnchors never anchors on the optimistic create card (number 0)", () => {
    const withTemp = [...items, item("temp-1", { number: 0 })];
    expect(edgeAnchors(withTemp, "none", "all", "todo", "t1")).toEqual({
      top: { beforeId: "e1" },
      bottom: { afterId: "t5" }, // not temp-1, which is last in the list
    });
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

  it("canEnterState (2W-R): TRIAGE never, a gated state only for an approver, everything else always", () => {
    const triage = state("triage", "TRIAGE", true);
    const done = state("done", "DONE", false, true);
    const progress = state("prog", "IN_PROGRESS");
    expect(canEnterState(triage, true)).toBe(false);
    expect(canEnterState(triage, false)).toBe(false);
    expect(canEnterState(done, false)).toBe(false);
    expect(canEnterState(done, true)).toBe(true);
    expect(canEnterState(progress, false)).toBe(true);
    expect(canEnterState(progress, true)).toBe(true);
  });

  describe("enterableStates (the §5.2 picker's option list)", () => {
    const backlog = state("backlog", "BACKLOG");
    const progress = state("prog", "IN_PROGRESS");
    const review = state("review", "IN_PROGRESS");
    const done = state("done", "DONE", false, true);
    const triage = state("triage", "TRIAGE", true);
    // Deliberately NOT in rank order alphabetically — the function must
    // preserve the caller's order, which is the project's rank order.
    const all = [backlog, progress, review, done, triage];

    it("an approver gets every enterable state, in the input's order, TRIAGE excluded", () => {
      expect(enterableStates(all, true, "prog").map((s) => s.id)).toEqual([
        "backlog",
        "prog",
        "review",
        "done",
      ]);
    });

    it("a non-approver does not get the gated state", () => {
      expect(enterableStates(all, false, "prog").map((s) => s.id)).toEqual([
        "backlog",
        "prog",
        "review",
      ]);
    });

    it("the CURRENT state is always present, even when it is gated and the member cannot approve", () => {
      // The 2W-R residue: without this the picker could not show a
      // non-approver what a Done item actually is.
      expect(enterableStates(all, false, "done").map((s) => s.id)).toContain("done");
    });

    it("the CURRENT state is always present, even when it is TRIAGE", () => {
      // §5.2: "TRIAGE hidden unless the item is in triage" is this
      // clause — entering triage stays refused by transitionState.
      const shown = enterableStates(all, true, "triage").map((s) => s.id);
      expect(shown).toContain("triage");
      expect(enterableStates(all, true, "prog").map((s) => s.id)).not.toContain("triage");
    });

    describe("stateOrdinalKeys (unique state test ids)", () => {
      // Seed-shaped, in rank order: two states share IN_PROGRESS.
      const seed = [
        state("backlog", "BACKLOG"),
        state("todo", "TODO"),
        progress,
        review,
        done,
        state("cancelled", "CANCELLED"),
        triage,
      ];

      it("numbers states 1-based within their category, in rank order", () => {
        const keys = stateOrdinalKeys(seed);
        expect(keys.get("prog")).toBe("IN_PROGRESS-1");
        expect(keys.get("review")).toBe("IN_PROGRESS-2");
        expect(keys.get("todo")).toBe("TODO-1");
        // Reversed rank, reversed ordinals: the key follows the order given.
        const flipped = stateOrdinalKeys([review, progress]);
        expect(flipped.get("review")).toBe("IN_PROGRESS-1");
        expect(flipped.get("prog")).toBe("IN_PROGRESS-2");
      });

      it("gives every state a key, and no two states the same key, with a custom state added", () => {
        const shipped = state("shipped", "DONE");
        const list = [...seed.slice(0, 5), shipped, ...seed.slice(5)];
        const keys = stateOrdinalKeys(list);
        expect(keys.size).toBe(list.length);
        expect(new Set(keys.values()).size).toBe(list.length);
        expect(keys.get("done")).toBe("DONE-1");
        expect(keys.get("shipped")).toBe("DONE-2");
      });

      it("numbers every state it is given, a hidden or gated one included", () => {
        // "Never depends on who is looking" is the CALLER's property —
        // pinned on `statePickerTargets` below, where the call now lives.
        const keys = stateOrdinalKeys(seed);
        expect(keys.get("triage")).toBe("TRIAGE-1");
        expect(keys.get("done")).toBe("DONE-1");
      });
    });

    describe("statePickerTargets (the State picker's rows)", () => {
      // A gated Done BEFORE a second, ungated DONE state: the one shape in
      // which numbering the filtered targets would renumber a shared row.
      const shipped = state("shipped", "DONE");
      const list = [backlog, progress, review, done, shipped, state("cancelled", "CANCELLED"), triage];
      const keyOf = (targets: readonly StatePickerTarget[], id: string) =>
        targets.find((t) => t.state.id === id)?.key;

      it("gives an approver and a non-approver the SAME key for every state both can see", () => {
        const approver = statePickerTargets(list, true, "prog");
        const employee = statePickerTargets(list, false, "prog");
        expect(approver.map((t) => t.state.id)).toContain("done");
        expect(employee.map((t) => t.state.id)).not.toContain("done");
        expect(keyOf(approver, "shipped")).toBe("DONE-2");
        expect(keyOf(employee, "shipped")).toBe("DONE-2");
        for (const t of employee) expect(t.key).toBe(keyOf(approver, t.state.id));
      });

      it("is enterableStates in rank order, with only the current state ever disabled", () => {
        const onDone = statePickerTargets(list, false, "done");
        expect(onDone.map((t) => t.state.id)).toEqual(enterableStates(list, false, "done").map((s) => s.id));
        expect(onDone.filter((t) => t.disabled).map((t) => t.state.id)).toEqual(["done"]);

        const onTriage = statePickerTargets(list, true, "triage");
        expect(onTriage.at(-1)).toMatchObject({ key: "TRIAGE-1", disabled: true });
        expect(onTriage.filter((t) => t.disabled)).toHaveLength(1);

        expect(statePickerTargets(list, true, "prog").some((t) => t.disabled)).toBe(false);
      });
    });

    it("a hidden state is excluded unless it is the current one", () => {
      const hiddenDone = state("hidden", "DONE", true);
      const withHidden = [progress, hiddenDone];
      expect(enterableStates(withHidden, true, "prog").map((s) => s.id)).toEqual(["prog"]);
      expect(enterableStates(withHidden, true, "hidden").map((s) => s.id)).toEqual([
        "prog",
        "hidden",
      ]);
    });
  });
});

// ── the filter/group model the backlog adds (2W-F) ───────────────────

describe("filters", () => {
  const done = state("done", "DONE");
  const cancelled = state("cancelled", "CANCELLED");
  const items = [
    item("a", { priority: "HIGH", assigneeMemberId: "m1", assigneeName: "Anna" }),
    item("b", { stateId: "prog", stateCategory: "IN_PROGRESS", priority: "LOW" }),
    item("c", { stateId: "done", stateCategory: "DONE" }),
    item("d", { stateId: "cancelled", stateCategory: "CANCELLED", assigneeMemberId: "m1", assigneeName: "Anna" }),
  ];
  const ids = (f: Partial<WorkFilters>) =>
    filterItems(items, { ...NO_FILTERS, ...f }).map((i) => i.id);

  it("no filter keeps everything, in project order", () => {
    expect(ids({})).toEqual(["a", "b", "c", "d"]);
  });

  it("hideDone hides BOTH terminal categories, not the state named Done", () => {
    expect(ids({ hideDone: true })).toEqual(["a", "b"]);
    expect(isDone(items[2]!)).toBe(true);
    expect(isDone(items[3]!)).toBe(true);
    expect(isDone(items[0]!)).toBe(false);
    // The categories are what decide it, so a renamed state still answers.
    expect(isDone({ stateCategory: done.category })).toBe(true);
    expect(isDone({ stateCategory: cancelled.category })).toBe(true);
  });

  it("values inside one axis are OR, axes are AND", () => {
    expect(ids({ stateIds: ["todo", "prog"] })).toEqual(["a", "b"]);
    expect(ids({ priorities: ["HIGH", "LOW"] })).toEqual(["a", "b"]);
    expect(ids({ stateIds: ["todo", "prog"], priorities: ["LOW"] })).toEqual(["b"]);
  });

  it("the unassigned bucket is a value of the assignee axis, not a separate flag", () => {
    expect(ids({ assigneeIds: ["m1"] })).toEqual(["a", "d"]);
    expect(ids({ assigneeIds: [UNASSIGNED] })).toEqual(["b", "c"]);
    expect(ids({ assigneeIds: ["m1", UNASSIGNED] })).toEqual(["a", "b", "c", "d"]);
  });

  it("an empty axis is 'everything', never 'nothing'", () => {
    expect(ids({ stateIds: [], assigneeIds: [], priorities: [] })).toEqual(["a", "b", "c", "d"]);
  });

  it("a filter that matches nothing yields an empty list, not the unfiltered one", () => {
    expect(ids({ stateIds: ["nope"] })).toEqual([]);
  });

  it("activeFilterCount counts every chosen value plus hide-done", () => {
    expect(activeFilterCount(NO_FILTERS)).toBe(0);
    expect(hasActiveFilters(NO_FILTERS)).toBe(false);
    const f = { ...NO_FILTERS, stateIds: ["todo", "prog"], priorities: ["HIGH" as const], hideDone: true };
    expect(activeFilterCount(f)).toBe(4);
    expect(hasActiveFilters(f)).toBe(true);
  });

  it("never mutates or reorders the input", () => {
    const copy = items.map((i) => ({ ...i }));
    filterItems(items, { ...NO_FILTERS, hideDone: true });
    expect(items).toEqual(copy);
  });
});

describe("workView — the flattened, grouped list and the count that describes it", () => {
  const members = [
    { id: "m2", name: "Zed" },
    { id: "m1", name: "Anna" },
  ];
  const items = [
    item("e1", { type: "EPIC", title: "Launch" }),
    item("t1", { rootId: "e1", parentId: "e1", assigneeMemberId: "m1", assigneeName: "Anna", estimateMinutes: 60 }),
    item("t2", { rootId: "e1", parentId: "e1", stateId: "done", stateCategory: "DONE", estimateMinutes: 30 }),
    item("t3", { assigneeMemberId: "m2", assigneeName: "Zed" }),
  ];
  const shape = (rows: WorkRow[]) =>
    rows.map((r) => (r.kind === "group" ? `[${r.key}]` : r.item.id));

  it("ungrouped is just the filtered items — no header line for a group with no name", () => {
    expect(shape(workView(items, "none", members, NO_FILTERS).rows)).toEqual(["e1", "t1", "t2", "t3"]);
    expect(shape(workView(items, "none", members, { ...NO_FILTERS, hideDone: true }).rows)).toEqual([
      "e1",
      "t1",
      "t3",
    ]);
  });

  it("grouped by epic: the epic is the HEADER of its group and never also a line inside it", () => {
    expect(shape(workView(items, "epic", members, NO_FILTERS).rows)).toEqual([
      "[e:e1]",
      "t1",
      "t2",
      "[no-epic]",
      "t3",
    ]);
  });

  it("an empty DERIVED bucket is dropped — a label for a pile with nothing in it says nothing", () => {
    // Only Anna's item survives, so Zed's group and No-epic disappear.
    const view = workView(items, "assignee", members, { ...NO_FILTERS, assigneeIds: ["m1"] });
    expect(shape(view.rows)).toEqual(["[m:m1]", "t1"]);
  });

  it("an epic lane SURVIVES with nothing in it — a phase must not vanish because a filter hid its work", () => {
    // Anna owns t1 only, so the epic's other child and the no-epic pile
    // both go. The phase itself stays, and says 1 of 2 are showing.
    const view = workView(items, "epic", members, { ...NO_FILTERS, assigneeIds: ["m2"] });
    expect(shape(view.rows)).toEqual(["[e:e1]", "[no-epic]", "t3"]);
    const epicRow = view.rows.find((r) => r.kind === "group" && r.key === "e:e1");
    if (epicRow?.kind !== "group") throw new Error("expected the epic's group row");
    expect(epicRow.rollup.shown).toBe(0);
    expect(epicRow.rollup.total).toBe(2);
  });

  it("every row key is unique, so a keyed render cannot collide", () => {
    const keys = workView(items, "epic", members, NO_FILTERS).rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("the rollup denominator is the UNFILTERED group; only `shown` follows the filter", () => {
    const view = workView(items, "epic", members, { ...NO_FILTERS, hideDone: true });
    const header = view.rows.find((r) => r.kind === "group" && r.key === "e:e1");
    if (header?.kind !== "group") throw new Error("expected a group row");
    // t1 + t2 are the epic's children; hide-done removes t2 from view but
    // not from the size of the work, and the estimate still sums both.
    expect(header.rollup).toEqual({ shown: 1, total: 2, done: 1, estimateMinutes: 90 });
  });

  it("REGRESSION: the summary counts exactly the rows rendered, in every grouping", () => {
    // Found by review: under `epic` the epic is a header, not a row, and
    // a separately-computed rollup counted it — the bar said "1 task"
    // beside a table showing none of it.
    for (const groupBy of GROUP_BYS) {
      for (const filters of [
        NO_FILTERS,
        { ...NO_FILTERS, hideDone: true },
        { ...NO_FILTERS, assigneeIds: ["m1"] },
        { ...NO_FILTERS, stateIds: ["nope"] },
      ]) {
        const view = workView(items, groupBy, members, filters);
        const rendered = view.rows.filter((r) => r.kind === "item").length;
        expect(view.rollup.shown, `${groupBy} shown`).toBe(rendered);
      }
    }
  });

  it("under epic grouping the epic leaves the denominator too, so `total` is rows-that-could-show", () => {
    const view = workView(items, "epic", members, NO_FILTERS);
    expect(view.rollup.total).toBe(3); // t1, t2, t3 — never the epic
    expect(workView(items, "none", members, NO_FILTERS).rollup.total).toBe(4);
  });
});


describe("rowAnchors — a rank-only move anchors on what the member can SEE", () => {
  const members = [{ id: "m1", name: "Anna" }];
  const items = [
    item("a", { number: 1 }),
    item("b", { number: 2 }),
    item("c", { number: 3 }),
    item("d", { number: 4 }),
  ];
  const rowsOf = (filters = NO_FILTERS, groupBy: "none" | "assignee" = "none") =>
    workView(items, groupBy, members, filters).rows;

  it("up/down are the neighbouring rows; top/bottom are the ends", () => {
    const rows = rowsOf();
    expect(rowAnchors(rows, "b")).toEqual({
      up: { beforeId: "a" },
      down: { afterId: "c" },
      top: { beforeId: "a" },
      bottom: { afterId: "d" },
    });
  });

  it("the first row has no up and no top; the last has no down and no bottom", () => {
    const rows = rowsOf();
    const first = rowAnchors(rows, "a");
    expect(first.up).toBeNull();
    expect(first.top).toBeNull();
    expect(first.down).toEqual({ afterId: "b" });
    const last = rowAnchors(rows, "d");
    expect(last.down).toBeNull();
    expect(last.bottom).toBeNull();
    expect(last.up).toEqual({ beforeId: "c" });
  });

  it("THE FILTERED-SUBSEQUENCE RULE: the anchor is the visible neighbour, never the hidden one", () => {
    // Hide `b`. From `c`, "up" must anchor on `a` — the row the member
    // can see — not on `b`. Anchoring on a hidden row would change the
    // rank while the screen stayed identical, so the member would click
    // again and the project order would drift silently.
    const hidden = [...items];
    hidden[1] = item("b", { number: 2, stateId: "done", stateCategory: "DONE" });
    const rows = workView(hidden, "none", members, { ...NO_FILTERS, hideDone: true }).rows;
    expect(rows.filter((r) => r.kind === "item").map((r) => (r.kind === "item" ? r.item.id : ""))).toEqual([
      "a",
      "c",
      "d",
    ]);
    expect(rowAnchors(rows, "c").up).toEqual({ beforeId: "a" });
    expect(rowAnchors(rows, "a").down).toEqual({ afterId: "c" });
  });

  it("anchors never leave the item's own GROUP — a rank-only move cannot change a property", () => {
    const grouped = [
      item("a", { number: 1, assigneeMemberId: "m1", assigneeName: "Anna" }),
      item("b", { number: 2, assigneeMemberId: "m1", assigneeName: "Anna" }),
      item("c", { number: 3 }),
      item("d", { number: 4 }),
    ];
    const rows = workView(grouped, "assignee", members, NO_FILTERS).rows;
    // Anna's group is [a, b]; the unassigned group is [c, d].
    const lastOfFirstGroup = rowAnchors(rows, "b");
    expect(lastOfFirstGroup.down).toBeNull();
    expect(lastOfFirstGroup.bottom).toBeNull();
    expect(lastOfFirstGroup.up).toEqual({ beforeId: "a" });
    const firstOfSecondGroup = rowAnchors(rows, "c");
    expect(firstOfSecondGroup.up).toBeNull();
    expect(firstOfSecondGroup.top).toBeNull();
    expect(firstOfSecondGroup.down).toEqual({ afterId: "d" });
  });

  it("the optimistic create row (number 0) is never an anchor, and does not hide the real row behind it", () => {
    const withTemp = [...items, item("temp-1", { number: 0 })];
    const rows = workView(withTemp, "none", members, NO_FILTERS).rows;
    // `d`'s "down" would be temp-1; there is no real row after it.
    expect(rowAnchors(rows, "d").down).toBeNull();
    expect(rowAnchors(rows, "d").bottom).toBeNull();
    // And the temp row itself anchors on real rows above it.
    expect(rowAnchors(rows, "temp-1").up).toEqual({ beforeId: "d" });
  });

  it("an unknown id yields no verbs at all rather than a wrong anchor", () => {
    expect(rowAnchors(rowsOf(), "nope")).toEqual({ up: null, down: null, top: null, bottom: null });
  });

  it("a one-row group offers nothing — every verb would be a no-op", () => {
    const rows = workView([item("only", { number: 1 })], "none", members, NO_FILTERS).rows;
    expect(rowAnchors(rows, "only")).toEqual({ up: null, down: null, top: null, bottom: null });
  });

  it("every anchor it returns is a REAL id present in the rendered rows", () => {
    const rows = rowsOf();
    const ids = new Set(rows.flatMap((r) => (r.kind === "item" ? [r.item.id] : [])));
    for (const id of ids) {
      const a = rowAnchors(rows, id);
      for (const target of [a.up?.beforeId, a.down?.afterId, a.top?.beforeId, a.bottom?.afterId]) {
        if (!target) continue;
        expect(ids.has(target)).toBe(true);
        expect(target).not.toBe(id);
      }
    }
  });
  it("allRowAnchors agrees with rowAnchors for every row, in every grouping — one pass, same answers", () => {
    const grouped = [
      item("a", { number: 1, assigneeMemberId: "m1", assigneeName: "Anna" }),
      item("b", { number: 2, assigneeMemberId: "m1", assigneeName: "Anna" }),
      item("c", { number: 3 }),
      item("d", { number: 4 }),
    ];
    // The un-persisted row is placed in the MIDDLE, not last: appending
    // it is exactly the bug this test exists to catch, and last is the
    // one position where a wrong implementation still agrees.
    const withTemp = [grouped[0]!, item("t", { number: 0 }), ...grouped.slice(1)];
    for (const groupBy of GROUP_BYS) {
      const rows = workView(withTemp, groupBy, members, NO_FILTERS).rows;
      const batch = allRowAnchors(rows);
      for (const row of rows) {
        if (row.kind !== "item") continue;
        expect(batch.get(row.item.id), `${groupBy}/${row.item.id}`).toEqual(
          rowAnchors(rows, row.item.id),
        );
      }
      // Every rendered row has an entry, and nothing else does.
      expect(batch.size).toBe(rows.filter((r) => r.kind === "item").length);
    }
  });
});
