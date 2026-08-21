import { PRIORITIES, type Priority } from "@/lib/enum-map";
import type { ItemList, ItemListEntry } from "@/modules/work";

/**
 * The board's pure model (no React, no DOM): which columns show, how
 * items fall into lanes, and how an optimistic move rewrites the list
 * BEFORE the server answers. Kept separate so it is unit-tested in
 * isolation and the component stays a renderer.
 *
 * One order per project (ARC-17): the list arrives by rank and every
 * column/lane is a filter over it, so a move is "take the item out, put
 * it back after/before its anchor" — exactly the server's rule.
 */

export type BoardItem = ItemListEntry;
export type BoardState = ItemList["states"][number];
export type BoardMember = ItemList["members"][number];

export const GROUP_BYS = ["none", "assignee", "priority", "epic"] as const;
export type GroupBy = (typeof GROUP_BYS)[number];
export const isGroupBy = (v: string | undefined | null): v is GroupBy =>
  (GROUP_BYS as readonly string[]).includes(v ?? "");

/** A hidden state (TRIAGE) is a column only while it holds items. */
export const visibleColumns = (states: readonly BoardState[], items: readonly BoardItem[]): BoardState[] =>
  states.filter((s) => !s.isHidden || items.some((i) => i.stateId === s.id));

export type Lane =
  | { key: "all"; kind: "all" }
  | { key: string; kind: "member"; memberId: string; name: string }
  | { key: "unassigned"; kind: "unassigned" }
  | { key: string; kind: "priority"; priority: Priority }
  | { key: string; kind: "epic"; epicId: string; title: string; epicKey: number }
  | { key: "no-epic"; kind: "noEpic" };

/** The ids of the EPIC rows in the list — the only roots that own a lane. */
export const epicIdsOf = (items: readonly BoardItem[]): ReadonlySet<string> =>
  new Set(items.filter((i) => i.type === "EPIC").map((i) => i.id));

/** The lane an item belongs to, for a grouping (the lane's `key`). */
export function laneKeyOf(item: BoardItem, groupBy: GroupBy, epicIds: ReadonlySet<string>): string {
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
  items: readonly BoardItem[],
  members: readonly BoardMember[],
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
  items: readonly BoardItem[],
  groupBy: GroupBy,
  laneKey: string,
  stateId: string,
): BoardItem[] => {
  const epicIds = epicIdsOf(items);
  return items.filter(
    (i) =>
      i.stateId === stateId &&
      laneKeyOf(i, groupBy, epicIds) === laneKey &&
      !(groupBy === "epic" && i.type === "EPIC"),
  );
};

export const columnTotals = (cards: readonly BoardItem[]): { count: number; estimateMinutes: number } => ({
  count: cards.length,
  estimateMinutes: cards.reduce((sum, c) => sum + (c.estimateMinutes ?? 0), 0),
});

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
 */
export function applyMove(
  items: readonly BoardItem[],
  move: Move,
  states: readonly BoardState[],
): BoardItem[] {
  const idx = items.findIndex((i) => i.id === move.itemId);
  if (idx === -1) return [...items];
  const current = items[idx]!;
  const state = move.stateId ? states.find((s) => s.id === move.stateId) : undefined;
  const moved: BoardItem = state
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

const replaceAt = (items: readonly BoardItem[], idx: number, next: BoardItem): BoardItem[] =>
  items.map((i, k) => (k === idx ? next : i));

/**
 * Anchors for "Top of X" / "Bottom of X" inside one lane. An EMPTY
 * column has no top or bottom: the item keeps its place in the project
 * order and only the state changes — expressed as the self anchor the
 * server reads as "stay" (never as "bottom of the project", which would
 * silently demote the task in the backlog).
 */
export function edgeAnchors(
  items: readonly BoardItem[],
  groupBy: GroupBy,
  laneKey: string,
  stateId: string,
  itemId: string,
): { top: Pick<Move, "beforeId" | "afterId">; bottom: Pick<Move, "beforeId" | "afterId"> } {
  const cards = cardsIn(items, groupBy, laneKey, stateId).filter((c) => c.id !== itemId);
  const first = cards[0];
  const last = cards.at(-1);
  return {
    top: first ? { beforeId: first.id } : { afterId: itemId },
    bottom: last ? { afterId: last.id } : { afterId: itemId },
  };
}
