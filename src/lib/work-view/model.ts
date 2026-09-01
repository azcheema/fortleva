import { PRIORITIES, type Priority } from "@/lib/enum-map";
import type { ResolvedItemList } from "@/modules/work";

/**
 * THE work view's pure model (no React, no DOM): which columns show,
 * how items fall into lanes, which items a filter keeps, how a grouped
 * list flattens into rows, and how an optimistic move rewrites the list
 * BEFORE the server answers.
 *
 * ONE model for every work surface (UI.md rule 6, whose stated
 * enforcement is the import graph: "no second list/board
 * implementation"). The board renders it as columns, the backlog as
 * rows; /home and the portal list join later. It lives here rather than
 * beside either route so neither can quietly grow its own copy — the
 * two surfaces disagreeing about what "done" or "no epic" means is the
 * defect this file exists to prevent.
 *
 * One order per project (ARC-17): the list arrives by rank and every
 * column/lane/filter is a projection over it, so a move is "take the
 * item out, put it back after/before its anchor" — exactly the server's
 * rule. Filtering NEVER reorders: a filtered list is a subsequence of
 * the project order, which is what lets a drag under a filter anchor on
 * a visible row and still mean the same thing to the server.
 */

export type WorkItem = ResolvedItemList["items"][number];
export type WorkState = ResolvedItemList["states"][number];
export type WorkMember = ResolvedItemList["members"][number];

export const GROUP_BYS = ["none", "assignee", "priority", "epic"] as const;
export type GroupBy = (typeof GROUP_BYS)[number];
export const isGroupBy = (v: string | undefined | null): v is GroupBy =>
  (GROUP_BYS as readonly string[]).includes(v ?? "");

/** A hidden state (TRIAGE) is a column only while it holds items. */
export const visibleColumns = (states: readonly WorkState[], items: readonly WorkItem[]): WorkState[] =>
  states.filter((s) => !s.isHidden || items.some((i) => i.stateId === s.id));

/**
 * Whether a state is a legal move/create target for this member: TRIAGE
 * never is (entering it is the `work_item:triage` verb), and a
 * `requiresApproval` state (the seeded Done, 2W-R) only for an approver.
 * ONE rule for every surface — column drops, card drops, the move
 * picker, the backlog select, column create; hiding the target is UX,
 * `transitionState` is the belt.
 */
export const canEnterState = (
  s: Pick<WorkState, "category" | "requiresApproval">,
  canApprove: boolean,
): boolean => s.category !== "TRIAGE" && (canApprove || !s.requiresApproval);

/**
 * "Done" for every surface that offers to hide it: the two TERMINAL
 * categories, not the seeded Done state. A tenant with two done-ish
 * states, or one that renamed Done, still gets the same answer — which
 * is the whole reason `stateCategory` is denormalised onto the row.
 */
export const isDone = (item: Pick<WorkItem, "stateCategory">): boolean =>
  item.stateCategory === "DONE" || item.stateCategory === "CANCELLED";

// ── filters ──────────────────────────────────────────────────────────

/** The unassigned bucket's stable token in the URL and in the filter. */
export const UNASSIGNED = "none";

export type WorkFilters = {
  /** Empty = every state. Ids, because a column IS a state (not a category). */
  stateIds: readonly string[];
  /** Empty = everyone. `UNASSIGNED` matches items with no assignee. */
  assigneeIds: readonly string[];
  /** Empty = every priority. */
  priorities: readonly Priority[];
  /** Hide items in a terminal category. */
  hideDone: boolean;
};

export const NO_FILTERS: WorkFilters = {
  stateIds: [],
  assigneeIds: [],
  priorities: [],
  hideDone: false,
};

/** How many chips are "on" — the count the Clear control shows. */
export const activeFilterCount = (f: WorkFilters): number =>
  f.stateIds.length + f.assigneeIds.length + f.priorities.length + (f.hideDone ? 1 : 0);

export const hasActiveFilters = (f: WorkFilters): boolean => activeFilterCount(f) > 0;

/**
 * One item against one filter set. Every axis is AND, values inside an
 * axis are OR — the shape every filter UI in the world uses, and the
 * only one that makes "State: To do, In progress" mean what it reads.
 */
export function matchesFilters(item: WorkItem, f: WorkFilters): boolean {
  if (f.hideDone && isDone(item)) return false;
  if (f.stateIds.length > 0 && !f.stateIds.includes(item.stateId)) return false;
  if (f.priorities.length > 0 && !f.priorities.includes(item.priority as Priority)) return false;
  if (f.assigneeIds.length > 0) {
    const key = item.assigneeMemberId ?? UNASSIGNED;
    if (!f.assigneeIds.includes(key)) return false;
  }
  return true;
}

/** The filtered list, in project order — a subsequence, never a re-sort. */
export const filterItems = (items: readonly WorkItem[], f: WorkFilters): WorkItem[] =>
  items.filter((i) => matchesFilters(i, f));

// ── lanes (the board's rows, the backlog's groups) ───────────────────

export type Lane =
  | { key: "all"; kind: "all" }
  | { key: string; kind: "member"; memberId: string; name: string }
  | { key: "unassigned"; kind: "unassigned" }
  | { key: string; kind: "priority"; priority: Priority }
  | { key: string; kind: "epic"; epicId: string; title: string; epicKey: number }
  | { key: "no-epic"; kind: "noEpic" };

/** The ids of the EPIC rows in the list — the only roots that own a lane. */
export const epicIdsOf = (items: readonly WorkItem[]): ReadonlySet<string> =>
  new Set(items.filter((i) => i.type === "EPIC").map((i) => i.id));

/** The lane an item belongs to, for a grouping (the lane's `key`). */
export function laneKeyOf(item: WorkItem, groupBy: GroupBy, epicIds: ReadonlySet<string>): string {
  switch (groupBy) {
    case "none":
      return "all";
    case "assignee":
      return item.assigneeMemberId ? `m:${item.assigneeMemberId}` : "unassigned";
    case "priority":
      return `p:${item.priority}`;
    case "epic": {
      // Only a subtree whose ROOT is an epic in the list has an epic lane
      // (the epic itself, its tasks, their subtasks). A subtask under a
      // plain task, or under an epic that is archived/absent, is "No epic".
      return epicIds.has(item.rootId) ? `e:${item.rootId}` : "no-epic";
    }
  }
}

/**
 * Lanes in display order: members (alphabetical, only those with items)
 * then Unassigned; priorities URGENT → NONE (all five, so a drop target
 * exists); epics by rank then No epic. Group "none" is one unnamed lane.
 */
export function lanesFor(
  groupBy: GroupBy,
  items: readonly WorkItem[],
  members: readonly WorkMember[],
): Lane[] {
  switch (groupBy) {
    case "none":
      return [{ key: "all", kind: "all" }];
    case "assignee": {
      const used = new Set(items.map((i) => i.assigneeMemberId).filter((x): x is string => !!x));
      const named = members
        .filter((m) => used.has(m.id))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map<Lane>((m) => ({ key: `m:${m.id}`, kind: "member", memberId: m.id, name: m.name }));
      // An assignee no longer in the active member list still owns a lane.
      for (const id of used) {
        if (!members.some((m) => m.id === id)) {
          const name = items.find((i) => i.assigneeMemberId === id)?.assigneeName ?? "";
          named.push({ key: `m:${id}`, kind: "member", memberId: id, name });
        }
      }
      return [...named, { key: "unassigned", kind: "unassigned" }];
    }
    case "priority":
      return [...PRIORITIES]
        .reverse()
        .map<Lane>((p) => ({ key: `p:${p}`, kind: "priority", priority: p }));
    case "epic": {
      const epics = items
        .filter((i) => i.type === "EPIC")
        .map<Lane>((e) => ({ key: `e:${e.id}`, kind: "epic", epicId: e.id, title: e.title, epicKey: e.number }));
      return [...epics, { key: "no-epic", kind: "noEpic" }];
    }
  }
}

/** The cards of one cell (lane × column), in rank order. Epic rows never render as cards in their own lane. */
export const cardsIn = (
  items: readonly WorkItem[],
  groupBy: GroupBy,
  laneKey: string,
  stateId: string,
): WorkItem[] => {
  const epicIds = epicIdsOf(items);
  return items.filter(
    (i) =>
      i.stateId === stateId &&
      laneKeyOf(i, groupBy, epicIds) === laneKey &&
      !(groupBy === "epic" && i.type === "EPIC"),
  );
};

export const columnTotals = (cards: readonly WorkItem[]): { count: number; estimateMinutes: number } => ({
  count: cards.length,
  estimateMinutes: cards.reduce((sum, c) => sum + (c.estimateMinutes ?? 0), 0),
});

// ── the backlog's flattened rows ─────────────────────────────────────

/**
 * A grouped list is a FLAT array of rows, not nested arrays: one row is
 * one line of fixed height, which is what lets the same array feed the
 * renderer and (above the threshold) the window. A group header is a
 * row like any other, so the arithmetic never has to know that some
 * lines are taller than others.
 */
export type WorkRow =
  | { kind: "group"; key: string; lane: Lane; rollup: Rollup }
  | { kind: "item"; key: string; item: WorkItem };

/**
 * What a group header counts. `total` is the UNFILTERED size of the
 * group and `shown` the filtered one: a progress meter whose
 * denominator moves when you filter is a lie about the size of the
 * work, so the rollup always measures the whole group and the header
 * says separately how many of them the current filter is showing.
 */
export type Rollup = {
  shown: number;
  total: number;
  done: number;
  estimateMinutes: number;
};

const rollupOf = (all: readonly WorkItem[], shown: readonly WorkItem[]): Rollup => ({
  shown: shown.length,
  total: all.length,
  done: all.filter(isDone).length,
  estimateMinutes: all.reduce((sum, i) => sum + (i.estimateMinutes ?? 0), 0),
});

/** What a surface renders: the rows, and the count that describes them. */
export type WorkView = { rows: WorkRow[]; rollup: Rollup };

/**
 * The backlog's rows for a grouping and a filter, WITH the summary that
 * describes them.
 *
 * The two are returned together on purpose. Computing the rows from one
 * filter pass and the summary from another let them disagree — under
 * `group=epic` the epics are headers rather than rows, so a separate
 * `listRollup` counted tasks the list was not showing and the bar said
 * "1 task" beside an empty table. Deriving the summary FROM the rows
 * makes that class of drift unrepresentable.
 *
 * `items` is the FULL project list in rank order; the filter is applied
 * here so each group's own rollup can still see the whole group.
 * Ungrouped, the result is just the filtered items — no header row,
 * because "all" has no name worth a line.
 *
 * WHICH EMPTY GROUPS SURVIVE. A derived bucket (an assignee, a
 * priority, "outside a phase") is dropped when nothing in it shows: it
 * is a label for a pile, and an empty pile is a line that says nothing.
 * An EPIC lane is kept, because a phase is a thing in its own right —
 * "Launch · 0 of 3 shown" tells the reader the phase exists and the
 * filter is hiding its work, where dropping it would make a whole phase
 * vanish with no trace. (The board keeps every priority lane for the
 * opposite reason: a lane there is also a drop target.)
 */
export function workView(
  items: readonly WorkItem[],
  groupBy: GroupBy,
  members: readonly WorkMember[],
  filters: WorkFilters,
): WorkView {
  const shown = filterItems(items, filters);
  if (groupBy === "none") {
    return {
      rows: shown.map((item) => ({ kind: "item", key: item.id, item })),
      rollup: rollupOf(items, shown),
    };
  }
  const epicIds = epicIdsOf(items);
  // Grouping by epic, an epic is the HEADER of its group and never also
  // a line inside it — the same rule the board applies to an epic lane,
  // so the two surfaces agree about what an epic is. It is therefore
  // not a ROW, and must not be counted as one either.
  const isRow = (i: WorkItem) => !(groupBy === "epic" && i.type === "EPIC");
  const rows: WorkRow[] = [];
  for (const lane of lanesFor(groupBy, items, members)) {
    const inLane = (list: readonly WorkItem[]) =>
      list.filter((i) => laneKeyOf(i, groupBy, epicIds) === lane.key && isRow(i));
    const laneShown = inLane(shown);
    if (laneShown.length === 0 && lane.kind !== "epic") continue;
    rows.push({ kind: "group", key: lane.key, lane, rollup: rollupOf(inLane(items), laneShown) });
    for (const item of laneShown) rows.push({ kind: "item", key: item.id, item });
  }
  return { rows, rollup: rollupOf(items.filter(isRow), shown.filter(isRow)) };
}

// ── optimistic moves ─────────────────────────────────────────────────

export type Move = {
  itemId: string;
  stateId?: string;
  afterId?: string | null;
  beforeId?: string | null;
};

/**
 * The optimistic rewrite: the same rule the server applies. `after`
 * wins over `before`; no anchor = the end of the project order; an
 * anchor that is the item itself or unknown = keep the position.
 *
 * It runs over the FULL list, never the filtered one — the anchor is a
 * real row either way, and rewriting a subsequence would lose the
 * hidden rows' places.
 */
export function applyMove(
  items: readonly WorkItem[],
  move: Move,
  states: readonly WorkState[],
): WorkItem[] {
  const idx = items.findIndex((i) => i.id === move.itemId);
  if (idx === -1) return [...items];
  const current = items[idx]!;
  const state = move.stateId ? states.find((s) => s.id === move.stateId) : undefined;
  const moved: WorkItem = state
    ? { ...current, stateId: state.id, stateCategory: state.category, stateName: state.name }
    : current;
  const rest = items.filter((i) => i.id !== move.itemId);
  const afterId = move.afterId && move.afterId !== move.itemId ? move.afterId : null;
  const beforeId = move.beforeId && move.beforeId !== move.itemId ? move.beforeId : null;
  const selfAnchored = !afterId && !beforeId && (move.afterId === move.itemId || move.beforeId === move.itemId);
  if (selfAnchored) return replaceAt(items, idx, moved);
  if (afterId) {
    const at = rest.findIndex((i) => i.id === afterId);
    if (at === -1) return replaceAt(items, idx, moved);
    return [...rest.slice(0, at + 1), moved, ...rest.slice(at + 1)];
  }
  if (beforeId) {
    const at = rest.findIndex((i) => i.id === beforeId);
    if (at === -1) return replaceAt(items, idx, moved);
    return [...rest.slice(0, at), moved, ...rest.slice(at)];
  }
  return [...rest, moved];
}

const replaceAt = (items: readonly WorkItem[], idx: number, next: WorkItem): WorkItem[] =>
  items.map((i, k) => (k === idx ? next : i));

/**
 * Anchors for "Top of X" / "Bottom of X" inside one lane. An EMPTY
 * column has no top or bottom: the item keeps its place in the project
 * order and only the state changes — expressed as the self anchor the
 * server reads as "stay" (never as "bottom of the project", which would
 * silently demote the task in the backlog).
 */
export function edgeAnchors(
  items: readonly WorkItem[],
  groupBy: GroupBy,
  laneKey: string,
  stateId: string,
  itemId: string,
): { top: Pick<Move, "beforeId" | "afterId">; bottom: Pick<Move, "beforeId" | "afterId"> } {
  // `number === 0` is the optimistic create card: it has no row yet, so
  // it can never be an anchor the server understands.
  const cards = cardsIn(items, groupBy, laneKey, stateId).filter((c) => c.id !== itemId && c.number > 0);
  const first = cards[0];
  const last = cards.at(-1);
  return {
    top: first ? { beforeId: first.id } : { afterId: itemId },
    bottom: last ? { afterId: last.id } : { afterId: itemId },
  };
}
