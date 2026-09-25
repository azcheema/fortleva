import { describe, expect, it } from "vitest";

import {
  GROUP_BYS,
  NO_FILTERS,
  UNASSIGNED,
  WITH_CLIENT,
  activeFilterCount,
  allRowAnchors,
  applyMove,
  bulkStateTargets,
  canEnterState,
  canItemEnterState,
  cardsIn,
  edgeAnchors,
  enterableStates,
  epicIdsOf,
  filterItems,
  hasActiveFilters,
  isAnsweredRequest,
  isDone,
  isEndableRequest,
  laneKeyOf,
  lanesFor,
  LABEL_CHIP_CAP,
  rowAnchors,
  stateOrdinalKeys,
  milestonePickerTargets,
  splitLabelChips,
  statePickerTargets,
  visibleColumns,
  workView,
  type BulkStateTarget,
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
  kind: "TASK",
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
  assigneeContactId: null,
  assigneeContactName: null,
  rootId: id,
  parentId: null,
  archivedAt: null,
  checklistTotal: 0,
  checklistDone: 0,
  attachmentCount: 0,
  labels: [],
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

  it("assignee: the client's lane appears between the team and Unassigned, and only when it has work", () => {
    // ABSENT by default — a card can only be dragged within its own lane
    // (`canDrop` compares `laneKey`), so unlike the five priority lanes
    // this one does not have to exist as a drop target, and an
    // always-drawn empty lane would be a column of air on every board in
    // every tenant that has never handed a task over.
    expect(lanesFor("assignee", items, members).map((l) => l.kind)).not.toContain("withClient");

    const held = [...items, item("t6", { assigneeContactId: "k1", assigneeContactName: "Astrid" })];
    expect(lanesFor("assignee", held, members).map((l) => l.key)).toEqual([
      "m:m1",
      "m:m2",
      "with-client",
      "unassigned",
    ]);
    // BY ID, never by index: this fixture is shared and grows.
    const laneOf = (id: string) =>
      laneKeyOf(held.find((i) => i.id === id)!, "assignee", new Set());
    expect(laneOf("t6")).toBe("with-client");
    // And the other two answers are untouched by any of it.
    expect(laneOf("t1")).toBe("m:m2");
    expect(laneOf("t3")).toBe("unassigned");
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

  it("canItemEnterState (slice 6b): a REQUEST may not be moved into a cancelled state", () => {
    const cancelled = state("cancelled", "CANCELLED");
    const progress = state("prog", "IN_PROGRESS");
    const done = state("done", "DONE", false, true);

    // The rule, and it is about the thing being MOVED rather than the
    // target: ending a request is `work_item:triage` and carries a
    // reason the client reads, so no ordinary move may do it.
    expect(canItemEnterState(cancelled, true, "REQUEST")).toBe(false);
    // Ordinary work is cancelled the ordinary way — the refusal is
    // about requests, not about cancelling.
    expect(canItemEnterState(cancelled, true, "TASK")).toBe(true);
    expect(canItemEnterState(cancelled, true, "BUG")).toBe(true);
    // …and with NO kind, which is a surface that does not yet know
    // which item is moving (a column asking whether it is droppable at
    // all). It gets the old answer, which is the right one for that
    // question — the per-drag check is what refuses the card.
    expect(canItemEnterState(cancelled, true)).toBe(true);

    // Everything `canEnterState` already decided still holds: a REQUEST
    // is not otherwise special, and the approval gate is unchanged.
    expect(canItemEnterState(progress, false, "REQUEST")).toBe(true);
    expect(canItemEnterState(done, false, "REQUEST")).toBe(false);
    expect(canItemEnterState(done, true, "REQUEST")).toBe(true);
  });

  it("enterableStates and statePickerTargets stop offering Cancelled for a REQUEST", () => {
    const backlog = state("backlog", "BACKLOG");
    const cancelled = state("cancelled", "CANCELLED");
    const states = [backlog, cancelled];

    expect(enterableStates(states, true, "backlog", "REQUEST").map((s) => s.id)).toEqual(["backlog"]);
    expect(enterableStates(states, true, "backlog", "TASK").map((s) => s.id)).toEqual([
      "backlog",
      "cancelled",
    ]);
    expect(statePickerTargets(states, true, "backlog", "REQUEST").map((t) => t.state.id)).toEqual([
      "backlog",
    ]);

    // THE CURRENT STATE IS STILL UNCONDITIONAL, which is the clause that
    // keeps a picker able to show what the item IS: a request that has
    // ALREADY been declined sits in a cancelled state, and a picker that
    // hid it would render with nothing selected. Backlog is there too
    // and should be — reopening a declined request is an ordinary move,
    // and the rule only ever forbade the direction INTO cancelled.
    expect(enterableStates(states, true, "cancelled", "REQUEST").map((s) => s.id)).toEqual([
      "backlog",
      "cancelled",
    ]);
  });

  it("isEndableRequest (C29): a live client request offers Cancel and reply, and nothing else does", () => {
    const request = (over: Partial<WorkItem> = {}) => item("r1", { kind: "REQUEST", ...over });
    // Accepted and under way — the case C29 exists for: every move target
    // refuses Cancelled for it, so this is the only way to end it.
    expect(isEndableRequest(request({ stateCategory: "BACKLOG" }))).toBe(true);
    expect(isEndableRequest(request({ stateCategory: "TODO" }))).toBe(true);
    expect(isEndableRequest(request({ stateCategory: "IN_PROGRESS" }))).toBe(true);
    // STILL IN TRIAGE, deliberately: a snoozed request has left the lane,
    // and on the board or the backlog this is its only door.
    expect(isEndableRequest(request({ stateCategory: "TRIAGE" }))).toBe(true);
    // Already ended, delivered, or put away — `triageItem` refuses the
    // first and the last, and a delivered request is not stopping.
    expect(isEndableRequest(request({ stateCategory: "CANCELLED" }))).toBe(false);
    expect(isEndableRequest(request({ stateCategory: "DONE" }))).toBe(false);
    expect(isEndableRequest(request({ archivedAt: new Date("2026-09-25T09:00:00Z") }))).toBe(false);
    // Ordinary work is cancelled the ordinary way; nobody is owed a reply.
    expect(isEndableRequest(item("t1", { kind: "TASK" }))).toBe(false);
    expect(isEndableRequest(item("b1", { kind: "BUG" }))).toBe(false);
  });

  it("bulkStateTargets (C29b): a request in the selection REFUSES Cancelled instead of removing it", () => {
    const triage = state("triage", "TRIAGE", true);
    // A VISIBLE triage state too, so "TRIAGE is never a target" is decided
    // by `canEnterState`'s own rule and not by the fixture's `isHidden` —
    // the seeded one is hidden, and a test that leaned on that could not
    // tell the rule was gone (fix review).
    const visibleTriage = state("triage-open", "TRIAGE");
    const todo = state("todo", "TODO");
    const done = state("done", "DONE", false, true);
    const cancelled = state("cancelled", "CANCELLED");
    const states = [triage, visibleTriage, todo, done, cancelled];
    const shape = (targets: BulkStateTarget[]) => targets.map((x) => [x.state.id, x.blockedBy]);

    const live = item("r1", { kind: "REQUEST" });

    // Ordinary tasks: every target the member may use, none refused.
    expect(shape(bulkStateTargets(states, true, [item("t1"), item("t2")]))).toEqual([
      ["todo", null],
      ["done", null],
      ["cancelled", null],
    ]);
    // ONE live request among them, and Cancelled is still THERE — refused,
    // with the code that lets the bar say how to end it instead. It used
    // to vanish.
    expect(shape(bulkStateTargets(states, true, [item("t1"), live]))).toEqual([
      ["todo", null],
      ["done", null],
      ["cancelled", "liveRequest"],
    ]);
    // What does not depend on the selection is still hidden, not refused:
    // TRIAGE is never a target, and a gated Done is none for a non-approver.
    expect(shape(bulkStateTargets(states, false, [live]))).toEqual([
      ["todo", null],
      ["cancelled", "liveRequest"],
    ]);
    // Only a CANCELLED target is refused for a request — the one rule
    // `canItemEnterState` adds for it.
    expect(shape(bulkStateTargets([state("backlog", "BACKLOG")], true, [live]))).toEqual([["backlog", null]]);

    // A request with NO door of its own — delivered, or archived — still
    // refuses the target, but with the code that points at nothing: "end
    // each one from its own menu" would send the member to a verb that
    // row does not have. One such request is enough.
    const delivered = item("r2", { kind: "REQUEST", stateId: "done", stateCategory: "DONE" });
    const filed = item("r3", { kind: "REQUEST", archivedAt: new Date("2026-09-25T09:00:00Z") });
    expect(shape(bulkStateTargets(states, true, [delivered])).at(-1)).toEqual(["cancelled", "request"]);
    expect(shape(bulkStateTargets(states, true, [filed])).at(-1)).toEqual(["cancelled", "request"]);
    expect(shape(bulkStateTargets(states, true, [live, delivered])).at(-1)).toEqual(["cancelled", "request"]);

    // A request ALREADY in the target state does not block it:
    // `bulkChangeState` skips a row already where it is being sent, before
    // the request rule is asked, so refusing would be a false refusal.
    const alreadyCancelled = item("r4", { kind: "REQUEST", stateId: "cancelled", stateCategory: "CANCELLED" });
    expect(shape(bulkStateTargets(states, true, [item("t1"), alreadyCancelled])).at(-1)).toEqual([
      "cancelled",
      null,
    ]);
    // …while one elsewhere in the same selection still does.
    expect(shape(bulkStateTargets(states, true, [alreadyCancelled, live])).at(-1)).toEqual([
      "cancelled",
      "liveRequest",
    ]);
  });

  it("isAnsweredRequest (C29b): a request in a cancelled state — the ones deleteItem refuses", () => {
    // Declined, marked a duplicate or cancelled with a reply: every way a
    // request reaches a cancelled state writes the reply the client keeps.
    expect(isAnsweredRequest(item("r1", { kind: "REQUEST", stateCategory: "CANCELLED" }))).toBe(true);
    // Still open, or reopened (which clears the reply on the way out):
    // deletable, so nothing is refused.
    expect(isAnsweredRequest(item("r2", { kind: "REQUEST", stateCategory: "TODO" }))).toBe(false);
    expect(isAnsweredRequest(item("r3", { kind: "REQUEST", stateCategory: "TRIAGE" }))).toBe(false);
    // An ordinary cancelled task owes nobody a reply.
    expect(isAnsweredRequest(item("t1", { kind: "TASK", stateCategory: "CANCELLED" }))).toBe(false);
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

describe("milestonePickerTargets (the M picker's rows)", () => {
  const ms = (id: string, status: string) => ({ id, status });
  // Rank order, with a cancelled phase in the MIDDLE: the one shape in
  // which numbering the filtered rows would renumber every later phase.
  const list = [ms("design", "DONE"), ms("dropped", "CANCELLED"), ms("build", "IN_PROGRESS"), ms("launch", "PLANNED")];
  const keyOf = (targets: ReturnType<typeof milestonePickerTargets<{ id: string; status: string }>>, id: string) =>
    targets.find((t) => t.milestone.id === id)?.key;

  it("drops a cancelled phase, keeps every other status, and holds rank order", () => {
    const rows = milestonePickerTargets(list, null);
    expect(rows.map((t) => t.milestone.id)).toEqual(["design", "build", "launch"]);
    expect(rows.some((t) => t.disabled)).toBe(false);
  });

  it("always lists the item's OWN phase, non-selectable when it is cancelled", () => {
    const rows = milestonePickerTargets(list, "dropped");
    expect(rows.map((t) => t.milestone.id)).toEqual(["design", "dropped", "build", "launch"]);
    expect(rows.filter((t) => t.disabled).map((t) => t.milestone.id)).toEqual(["dropped"]);
  });

  it("gives a row the SAME key whichever phase the item is under", () => {
    const onNone = milestonePickerTargets(list, null);
    const onDropped = milestonePickerTargets(list, "dropped");
    expect(keyOf(onNone, "launch")).toBe("3");
    expect(keyOf(onDropped, "launch")).toBe("3");
    for (const t of onNone) expect(t.key).toBe(keyOf(onDropped, t.milestone.id));
  });

  it("a project with no phases has no rows", () => {
    expect(milestonePickerTargets([], null)).toEqual([]);
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

  it("a task the CLIENT holds is its own bucket, not 'no assignee'", () => {
    // The defect this bucket exists to end (found by a fresh code
    // review of slice 6c): with `assigneeMemberId ?? UNASSIGNED`, a task
    // handed to a contact matched "No assignee" — beside work nobody
    // holds — and vanished from every lane the moment a real person was
    // filtered for. "Nobody is doing this" and "the client is doing
    // this" are opposite facts.
    const held = [
      ...items,
      item("e", { assigneeContactId: "k1", assigneeContactName: "Astrid" }),
    ];
    const pick = (f: Partial<WorkFilters>) =>
      filterItems(held, { ...NO_FILTERS, ...f }).map((i) => i.id);
    expect(pick({ assigneeIds: [WITH_CLIENT] })).toEqual(["e"]);
    expect(pick({ assigneeIds: [UNASSIGNED] })).toEqual(["b", "c"]);
    expect(pick({ assigneeIds: ["m1"] })).toEqual(["a", "d"]);
    expect(pick({ assigneeIds: ["m1", WITH_CLIENT] })).toEqual(["a", "d", "e"]);
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

describe("splitLabelChips — which label names a surface shows, and which fold into a count", () => {
  const labels = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].map((name) => ({
    id: name,
    name,
    color: null,
  }));

  it("shows everything while the set fits the cap, and folds nothing", () => {
    for (const n of [0, 1, 2]) {
      const split = splitLabelChips(labels.slice(0, n), 2);
      expect(split.shown.map((l) => l.name)).toEqual(labels.slice(0, n).map((l) => l.name));
      expect(split.hidden).toEqual([]);
    }
  });

  it("folds the REMAINDER the moment the set passes the cap — there is no +1 grace", () => {
    // The rule a cap+1 grace would break: three labels in the row's
    // 16ch cell is two truncated names, where two names and a 4ch "+1"
    // both fit and read.
    const three = splitLabelChips(labels.slice(0, 3), 2);
    expect(three.shown.map((l) => l.name)).toEqual(["alpha", "beta"]);
    expect(three.hidden.map((l) => l.name)).toEqual(["gamma"]);
  });

  it("keeps the FIRST cap names, so the fold is stable across renders and both surfaces", () => {
    const row = splitLabelChips(labels, LABEL_CHIP_CAP.row);
    const card = splitLabelChips(labels, LABEL_CHIP_CAP.card);
    expect(row.shown.map((l) => l.name)).toEqual(["alpha", "beta"]);
    expect(card.shown.map((l) => l.name)).toEqual(["alpha", "beta", "gamma", "delta"]);
    // The card's chips are a PREFIX of nothing the row hides: what the
    // row folds away, the card may still show, and neither ever reorders.
    expect(card.shown.slice(0, row.shown.length)).toEqual(row.shown);
    expect([...row.shown, ...row.hidden]).toEqual(labels);
    expect([...card.shown, ...card.hidden]).toEqual(labels);
  });

  it("the caps are the two the two surfaces declare", () => {
    expect(LABEL_CHIP_CAP).toEqual({ row: 2, card: 4 });
  });

  it("never asks a surface to draw a count and no names", () => {
    // NaN once returned NO names and folded everything — `Math.max(1, NaN)` is NaN.
    for (const cap of [-1, 0, 0.5, 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const split = splitLabelChips(labels, cap);
      expect(split.shown.map((l) => l.name), String(cap)).toEqual(["alpha"]);
      expect(split.hidden).toHaveLength(labels.length - 1);
    }
  });

  it("copies the array rather than handing back the caller's", () => {
    const source = labels.slice(0, 2);
    const split = splitLabelChips(source, 2);
    expect(split.shown).toEqual(source);
    expect(split.shown).not.toBe(source);
  });
});
