"use client";

import { autoScrollWindowForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element";
import {
  attachClosestEdge,
  extractClosestEdge,
  type Edge,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { PaperclipIcon, PlusIcon, TimerIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useQueryStates } from "nuqs";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";
import { toast } from "sonner";

import {
  DataTable,
  EmptyState,
  ROW_HEIGHT,
  InlineEdit,
  MemberAvatar,
  PriorityIndicator,
  RowActions,
  VisibilityInlineEdit,
  visibilityRowCue,
  type RowAction,
} from "@/components/semantic";
import { isGoSequencePending, useScopeKeys } from "@/components/shell/use-hotkeys";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { BulkBar } from "@/components/work-view/bulk-bar";
import { WorkFilterBar } from "@/components/work-view/filter-bar";
import { LabelChips } from "@/components/work-view/label-chips";
import { isoDateOf, parseEstimateMinutes } from "@/lib/duration";
import { PRIORITIES, type Priority } from "@/lib/enum-map";
import { wroteSomething } from "@/lib/action-result";
import { durationInputText, formatDay, formatDuration, type DurationStyle } from "@/lib/format";
import { withCurrentOption } from "@/lib/inline-edit";
import { focusedKeyApplies, focusedKeyGuards, keyEventShape, ownsArrows, rovingStep } from "@/lib/keymap";
import type { ActionResult, FormResult } from "@/lib/server-actions";
import { cn } from "@/lib/utils";
import {
  EMPTY_SPAN,
  MAX_BULK_ITEMS,
  VIRTUALISE_ABOVE,
  allRowAnchors,
  applyMove,
  canEnterState,
  epicIdsOf,
  filtersOf,
  growTo,
  hasActiveFilters,
  initialWindow,
  laneKeyOf,
  peekHrefOf,
  visibleColumns,
  sameWindow,
  wholeList,
  windowOf,
  workView,
  workViewHref,
  workViewParsers,
  type Lane,
  type Move,
  type Rollup,
  type RowAnchors,
  type RowWindow,
  type WorkItem,
} from "@/lib/work-view";
import type { ResolvedItemList } from "@/modules/work";

import type { TimerPillState } from "../../../time/actions";
import { useTaskTimer } from "../../../time/use-task-timer";

import {
  bulkChangeStateAction,
  bulkSetArchivedAction,
  bulkSetPriorityAction,
  createItemAction,
  deleteItemAction,
  renameItemAction,
  setItemArchivedAction,
  moveItemAction,
  setItemAssigneeAction,
  setItemDueDateAction,
  setItemEstimateAction,
  setItemPriorityAction,
  setItemStateAction,
  setItemVisibilityAction,
} from "./actions";

/**
 * The ordered task list (2W core slice, grown into the full backlog by
 * 2W-F). Every property is an <InlineEdit> — text at rest, the control
 * on click (founder mandate 1); every mutation runs in a transition
 * with a toast on failure so a failed action never looks like a revert.
 *
 * The view — which filters are on, and how the list is grouped — lives
 * in the URL and is read HERE, live, rather than taken as a prop. The
 * filters are shallow (no server round trip: `listItems` already
 * returned the whole project), so the server's `searchParams` is stale
 * the moment a chip is clicked, and a peek link built from a server
 * prop would drop the member's filters on the way back. Reading
 * `useSearchParams()` is the standing trap's own prescription.
 *
 * Rank drag (slice 2) and the selection bar (slice 4) are here; what is
 * still to come is virtualisation, which stays inert at or below
 * `VIRTUALISE_ABOVE` rows so it cannot disturb any of this.
 */

type RunResult = FormResult | ActionResult<unknown>;

/**
 * Runs one row mutation in a transition. Accepts both result shapes: the
 * message-bearing `FormResult` (rename, archive, delete…) and the six
 * property setters' `ActionResult`, whose success carries the canonical
 * row instead of a sentence. The table re-renders from the server either
 * way, on failure too. ONE toast policy for both: nothing on success
 * unless asked — `serverMessage` toasts a `FormResult`'s own sentence,
 * `success` toasts the caller's, and never for an `ActionResult` whose
 * row says `changed: false` (claiming "saved" for a write that did not
 * happen is the sentence use-panel-commit.tsx refuses too).
 */
const useRun = (fallbackMessage: string) => {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<RunResult>, opts: { serverMessage?: boolean; success?: string } = {}) =>
    start(async () => {
      const r = await fn().catch(() => ({ ok: false as const, message: fallbackMessage }));
      if (!r.ok) toast.error(r.message);
      else if (opts.serverMessage && "message" in r) toast.success(r.message);
      else if (opts.success && wroteSomething(r)) toast.success(opts.success);
      router.refresh();
    });
  return { pending, run };
};

/**
 * The table's columns: select · key · title · state · priority ·
 * assignee · estimate · due · visibility · actions. Derived constants
 * rather than literals, because a group header spans all of them and the
 * create row spans all but its own two — and a `colSpan` that disagrees
 * with the header is invisible on desktop and wrong on a phone, where
 * column priority hides cells (the fixed-colSpan trap, PLAN §0).
 *
 * The labels chips are NOT a column of their own, and that is a MEASURED
 * decision, not a preference: when it was made (slice 16, before column
 * priority read the table and the actions column was pinned) the table at
 * the audited 1440px already filled its 1168px box, with all 63px of slack
 * in the flexible title column — 1ch is 8.2px, so a 14ch Labels column was
 * 115px the table did not have, and it would have put the row's verbs out
 * of view. Pinned, the verbs now stay in view, but the width is still
 * spoken for: a Labels column would push a narrower rung onto every
 * laptop, or make the table scroll. The chips live INSIDE the title cell,
 * spending the one budget that exists (see the cell).
 */
const COLUMN_COUNT = 10;
/** What the create row's title cell spans: everything after select + plus-icon. */
const SPAN_AFTER_KEY = COLUMN_COUNT - 2;

/**
 * Drag payload. `laneKey` rides along so a drop can refuse to cross a
 * group: a rank-only move has no way to express the property change
 * that leaving a group would be (`MoveInput` carries no property
 * field), so the same rule the board applies to lanes applies here.
 */
const NO_ANCHORS: RowAnchors = { up: null, down: null, top: null, bottom: null };

/**
 * How far outside the live window a focused row is still kept mounted.
 * Generous enough that ordinary interaction — open an editor, scroll a
 * screen, come back — never loses a keystroke, small enough that the
 * worst case mounts fifty extra rows rather than the whole list.
 */
const FOCUS_MARGIN = 50;

type RowData = { type: "backlog-row"; itemId: string; laneKey: string };
const isRowData = (d: Record<string | symbol, unknown>): d is RowData =>
  d["type"] === "backlog-row";

/**
 * Where the drop will land, as ONE normalised convention: the id of the
 * visible row the item will come to rest ABOVE, or `null` for the end of
 * the list.
 *
 * Normalising matters for more than tidiness. A line drawn at the bottom
 * of row N and a line drawn at the top of row N+1 describe the same
 * insertion point, but they paint about 3 px apart, because the rows
 * share one collapsed rule and only the top-aligned line paints over it.
 * Whichever row `attachClosestEdge` happens to report would then decide
 * how the indicator looks. Resolving to "above which row" first means
 * every indicator is pixel-identical.
 */
type DropAt = { above: string } | { belowLast: string };

/**
 * What the window is derived FROM. The measurement lives in state; the
 * window itself never does — see the long note at the call site.
 */
type Measured = {
  scrollTop: number;
  listTop: number;
  viewportHeight: number;
  rowHeight: number;
};

const sameMeasured = (a: Measured | null, b: Measured): boolean =>
  a !== null &&
  a.scrollTop === b.scrollTop &&
  a.listTop === b.listTop &&
  a.viewportHeight === b.viewportHeight &&
  a.rowHeight === b.rowHeight;

/**
 * The empty space standing in for rows that are not mounted.
 *
 * A RAW `<tr>` with no `data-slot`, deliberately: `craft.rowPitch`
 * selects `[data-slot=table-row]` and asserts every match measures one
 * `--row-h`, which a 7000px spacer plainly does not. It is invisible to
 * that check by construction rather than by an exemption someone could
 * later remove.
 *
 * `padding: 0` is an inline style so it beats `<DataTable>`'s
 * `[&_td]:py-0.5`. Measured, because the reason is not the obvious one:
 * with `box-sizing: border-box` the 4px of padding is absorbed INSIDE a
 * `height` property, so at 180px the padded and unpadded spacers are
 * both 180.000px. The guard bites only when the ask is smaller than the
 * padding — at a 2px ask it is 4px against 2px — which is exactly what
 * happens at the very top and bottom of the list.
 *
 * NEVER RENDERED AT ZERO. A zero-height spacer between two bordered
 * rows still measures 0.5px, because `border-collapse` splits the
 * inter-row rule into both boxes; and a trailing zero-height spacer
 * steals `:last-child` from the real last row, which then keeps the
 * bottom hairline `[&_tr:last-child]:border-b-0` exists to remove. The
 * caller renders it only when it stands for at least one row.
 */
function Spacer({ height, testId }: { height: number; testId: string }) {
  return (
    <tr aria-hidden="true" data-testid={testId} style={{ height }}>
      <td colSpan={COLUMN_COUNT} style={{ padding: 0 }} />
    </tr>
  );
}

const sameDropAt = (a: DropAt | null, b: DropAt | null): boolean => {
  if (a === null || b === null) return a === b;
  if ("above" in a) return "above" in b && a.above === b.above;
  return "belowLast" in b && a.belowLast === b.belowLast;
};

/**
 * A row that can be picked up and dropped on.
 *
 * It exists only to own the ref and the two registrations — the cells
 * stay in the list above, so the drag is additive to a row that already
 * worked. `getIsSticky` is deliberately NOT set: a table body has no
 * gaps between rows, so there is no dead space for stickiness to
 * rescue, and without it a release over a refused row (another group,
 * a group header, the create row) leaves `dropTargets` empty and the
 * monitor's early return makes the drop a true no-op. With stickiness
 * the same release would silently fall back to the last accepted row
 * and reorder something the member was no longer pointing at.
 */
function DragRow({
  itemId,
  laneKey,
  canDrag,
  className,
  onEdge,
  rowIndex,
  keyShortcuts,
  children,
}: {
  itemId: string;
  laneKey: string;
  canDrag: boolean;
  className?: string;
  /** The letters this row answers, for `aria-keyshortcuts`: `J K` always, `T` where it acts (`X` is on the row's checkbox). */
  keyShortcuts: string;
  onEdge: (itemId: string, edge: Edge | null) => void;
  /** 1-based position in the WHOLE list — set only while windowed, so a
   * screen reader is not told "row 3 of 40" in a list of four hundred. */
  rowIndex?: number | undefined;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLTableRowElement>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || !canDrag) return;
    const data: RowData = { type: "backlog-row", itemId, laneKey };
    // Desktop only (UI.md §7.1). A coarse pointer gets the row menu's
    // Move verbs instead, which is the twin the rule asks for.
    const finePointer = window.matchMedia("(pointer: fine)").matches;
    return combine(
      draggable({
        element: el,
        canDrag: () => finePointer,
        getInitialData: () => data,
        onDragStart: () => setDragging(true),
        onDrop: () => setDragging(false),
      }),
      dropTargetForElements({
        element: el,
        // Same group only: a rank-only move cannot express the property
        // change that leaving a group would be.
        canDrop: ({ source }) => isRowData(source.data) && source.data.laneKey === laneKey,
        getData: ({ input, element }) =>
          attachClosestEdge(data, { input, element, allowedEdges: ["top", "bottom"] }),
        onDrag: ({ self, source }) =>
          onEdge(
            itemId,
            isRowData(source.data) && source.data.itemId === itemId
              ? null
              : extractClosestEdge(self.data),
          ),
        onDragLeave: () => onEdge(itemId, null),
        onDrop: () => onEdge(itemId, null),
      }),
    );
  }, [canDrag, itemId, laneKey, onEdge]);

  return (
    <TableRow
      ref={ref}
      data-testid="backlog-row"
      data-item-id={itemId}
      aria-rowindex={rowIndex}
      // Focusable by KEY, never by Tab (UI.md §6); the ring is `TableRow`'s.
      tabIndex={-1}
      aria-keyshortcuts={keyShortcuts}
      // Opacity, never a transform: a transformed row would become the
      // containing block for the drop line and move it off the row.
      // `scroll-mt-16` / `scroll-mb-16` clear the sticky header (`h-12`)
      // and the sticky bulk bar when focus scrolls a row into view;
      // `TableRow`'s `scroll-mt-8` is too small for the header (UI.md §6).
      className={cn(
        className,
        "scroll-mt-16 scroll-mb-16",
        canDrag && "cursor-grab active:cursor-grabbing",
        dragging && "opacity-40",
      )}
    >
      {children}
    </TableRow>
  );
}

/**
 * The 2px insertion line. It lives INSIDE a cell — a bare <span> under a
 * <tr> is foster-parented out of the table by the HTML parser — but
 * `inset-x-0` resolves against the ROW, which `position: relative` makes
 * the containing block, so it spans the full width from whichever cell
 * hosts it. It starts inside the row's 2px left border, so it can never
 * paint over `visibilityRowCue`'s client-visible mark: the two colours
 * measure 1.0002:1 against each other, so an overlap would erase a
 * safety-critical marking with something indistinguishable from it.
 *
 * Do not add `transform`, `filter`, `backdrop-filter`, `will-change` or
 * `contain: paint` to the row or this cell — any of them re-parents the
 * containing block and the line silently moves.
 */
function DropLine({ edge }: { edge: "top" | "bottom" }) {
  return (
    <span
      aria-hidden="true"
      data-testid="backlog-drop-line"
      className={cn(
        // `z-2`: above the row's pinned actions cell (`z-1`), or the line
        // stops short of the row's end, under it.
        "pointer-events-none absolute inset-x-0 z-2 h-0.5 rounded-full bg-primary",
        edge === "top" ? "top-0" : "bottom-0",
      )}
    />
  );
}

export function BacklogTable({
  projectId,
  projectKey,
  locale,
  data,
  durationStyle,
  basePath,
  includeArchived,
  peekOpen,
  timer,
}: {
  projectId: string;
  projectKey: string;
  locale: string;
  data: ResolvedItemList;
  /** The tenant's `ui.durationStyle` — REQUIRED (standing trap: state a
   * shared component must reflect is never a default). */
  durationStyle: DurationStyle;
  /** The surface's path WITHOUT a query — the peek links rebuild the
   * query from the live URL, never from a server snapshot. */
  basePath: string;
  /** Whether the server loaded archived items too (`?archived=1`). */
  includeArchived: boolean;
  /** Whether the item peek is open over the list. REQUIRED (standing
   * trap): while it is, focus is trapped in the sheet and `X` cannot act,
   * so the overlay must not offer it — the board's `peekOpen` rule. */
  peekOpen: boolean;
  /**
   * The member's timer as the page read it (`loadPanelTimer`), or `null`
   * where they can start none — no `time:track`, or an archived project.
   * REQUIRED, `null` included: it decides whether a row takes `T`.
   */
  timer: TimerPillState | null;
}) {
  const t = useTranslations("projects.backlog");
  const tView = useTranslations("projects.workView");
  const tCommon = useTranslations("common");
  const tProjects = useTranslations("projects");
  const tPriority = useTranslations("states.priority");
  const router = useRouter();
  const { run } = useRun(t("actionFailed"));
  const searchParams = useSearchParams();
  const [params, setParams] = useQueryStates(workViewParsers, {
    shallow: true,
    history: "replace",
  });

  const filters = filtersOf(params);
  const [isPending, startTransition] = useTransition();
  // The optimistic list is the FULL project order — never the filtered
  // rows. `applyMove` splices against real neighbours, and rewriting a
  // subsequence would lose the places of everything the filter hides.
  const [items, applyOptimistic] = useOptimistic(
    data.items,
    (current: WorkItem[], move: Move): WorkItem[] => applyMove(current, move, data.states),
  );
  // Rows and summary from ONE call: computed separately they drifted,
  // because an epic is a header rather than a row under epic grouping.
  const { rows, rollup } = workView(items, params.group, data.members, filters);
  const peekHref = (number: number) =>
    peekHrefOf(basePath, searchParams, `${projectKey}-${number}`);
  // The archived toggle is a REAL navigation (it changes what the server
  // loads), but its href must still be built from the LIVE url: the
  // filters are shallow, so a server-rendered href would carry the query
  // as it was before the first chip was clicked and silently drop them.
  const runMove = useCallback(
    (move: Move) => {
      startTransition(async () => {
        applyOptimistic(move);
        // `surface: "backlog"` is the step-up return address, not a path:
        // without it a move that hits MFA_REQUIRED lands the member on
        // the board, which is not the page they were working on.
        const r = await moveItemAction({ ...move, projectKey, surface: "backlog" }).catch(() => ({
          ok: false as const,
          message: tView("move.failed"),
        }));
        if (!r.ok) toast.error(r.message);
        router.refresh();
      });
    },
    [applyOptimistic, projectKey, router, tView],
  );

  const archivedHref = workViewHref(basePath, searchParams, {
    archived: includeArchived ? null : "1",
    item: null,
    error: null,
  });

  // The same one rule as every board surface (2W-R): TRIAGE and — for a
  // non-approver — a gated state are not offered; an item ALREADY in a
  // filtered state keeps it via the current-value fallback below, so it
  // stays displayable and reopenable.
  const stateOptions = data.states
    .filter((s) => !s.isHidden && canEnterState(s, data.caps.canApprove))
    .map((s) => ({ value: s.id, label: s.name }));
  const assigneeOptions = [
    { value: "", label: t("unassigned") },
    ...data.members.map((m) => ({ value: m.id, label: m.name })),
  ];
  // "" means NONE so the resting cell shows the muted placeholder, the
  // same convention as the assignee's "" = unassigned.
  const priorityOptions = PRIORITIES.map((p) => ({
    value: p === "NONE" ? "" : p,
    label: tPriority(p),
  }));

  // The selection is stored as ids and INTERSECTED with what is on
  // screen at every use, never pruned in an effect (which the compiler
  // forbids). So filtering rows away silently removes them from the
  // selection's reach — a bulk verb can only ever touch what the member
  // can see — while re-showing them brings them back.
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  // Whether the live region should SAY the selection is empty. An emptied
  // polite region is not spoken, so taking the last row out — by `X` on a
  // key link, where focus announces nothing of its own — was silent. Set
  // ONLY by a member emptying the shown selection (the last shown row's
  // toggle, select-all off, Clear), and cleared during render whenever
  // anything is shown selected again (beside `selected`, below). So it is
  // true only while the shown selection is empty, and a filter or refresh
  // that LATER hides selected rows finds it false and stays silent, as it
  // always was. A bulk verb touches no flag: the selection it acted on was
  // not empty, so the flag is false — unless the member emptied the
  // selection while the verb was pending, and then the region already
  // reads "0 tasks selected", the verb's answer changes no text, and only
  // its toast speaks.
  const [announceNone, setAnnounceNone] = useState(false);

  // ── the window (2W-F slice 3) ───────────────────────────────────
  //
  // THE MEASUREMENT LIVES IN STATE; THE WINDOW NEVER DOES. That is not
  // style — a window kept in state goes stale and cannot recover. Its
  // `count` is `rows.length`, which moves with NO scroll event and NO
  // remount: the filter chips are shallow, `useOptimistic` rewrites the
  // list, and every mutation calls `router.refresh()`. Mount under a
  // filter showing five rows, then clear it: a stale window would render
  // five rows with no bottom spacer, the page would not be tall enough
  // to scroll, no scroll event could ever fire, and the other 395 rows
  // would be unreachable for good. Deriving in render means every render
  // uses THIS render's count.
  //
  // ONLY WHEN UNGROUPED. `workView` interleaves group headers and items
  // in one flat array, so a window can open in the middle of a group and
  // leave its header off screen — the member would read unlabelled rows
  // while the row menu offers "Move to top of" a group they cannot see.
  // A grouped list is also short by construction. Not worth the rope.
  const count = rows.length;
  const windowable = params.group === "none";
  /** True only when rows are actually being held back from the DOM. */
  const windowed = windowable && count > VIRTUALISE_ABOVE;
  const [measured, setMeasured] = useState<Measured | null>(null);
  // The span a drag has covered. Non-null means a drag is in flight, and
  // the window may then only GROW: if the source row unmounts, pdnd
  // never fires `dragend`, its `isActive` latch stays set (refusing the
  // next drag) and the auto-scroll scheduler keeps scrolling the page
  // after the mouse is released.
  const [dragSpan, setDragSpan] = useState<{ start: number; end: number } | null>(null);
  // The row that holds focus. An open <InlineEdit> keeps the member's
  // typed text in local state and commits on blur — and Chromium fires
  // NO blur when the focused element is removed from the DOM, so
  // scrolling an open editor out of the window would discard what they
  // typed with no commit, no toast and no revert message. Keeping its
  // row mounted is the fix; it costs one row.
  const [focusedRowId, setFocusedRowId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  // `J K` hand focus to a row AFTER it has rendered: the handler only
  // NAMES the row (`setFocusedRowId`), and this effect gives it focus
  // once it is in the DOM — never a timer, and no pending ref (a stale
  // id in a ref stole focus from the next click; review, round 1).
  //
  // NO DEPENDENCY LIST, on purpose: the row may reach the DOM on a LATER
  // render than the one that named it (a scroll between keydown and
  // commit moved the window), and a second `J` from the same row names
  // the same id, which is no state change — an effect keyed on the id
  // would never retry, and the keys would be dead (review, round 2).
  // Running on every render costs one ancestor walk in the common case.
  //
  // Three cases, told apart by where focus IS:
  //  · already inside the named row — a click or Tab into one of its
  //    controls set the state through `onFocusCapture`: nothing to do;
  //  · inside the table elsewhere — a step: focus the row, and let
  //    `focus()` scroll it into view under the row's own scroll margins
  //    (that scroll fires `measure`, which is how the window follows a
  //    held `J`);
  //  · on `<body>` — the named row was scrolled past the pin and
  //    unmounted with focus on it (Chromium fires no blur), and has now
  //    come back: restore focus WITHOUT scrolling, so the flow resumes
  //    where it was and the member's scroll position is not yanked;
  //  · anywhere else — the member moved on; the name is stale, leave it.
  useEffect(() => {
    if (!focusedRowId) return;
    const active = document.activeElement;
    const activeRow = active instanceof Element ? active.closest<HTMLElement>("[data-item-id]") : null;
    if (activeRow?.dataset["itemId"] === focusedRowId) return;
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-item-id="${focusedRowId}"]`);
    if (!el) return;
    if (active && bodyRef.current?.contains(active)) el.focus();
    else if (!active || active === document.body) el.focus({ preventScroll: true });
  });

  const live: RowWindow = !windowable
    ? wholeList(count)
    : measured === null
      ? initialWindow(count, parseFloat(ROW_HEIGHT.default))
      : windowOf({ ...measured, count });
  const rowHeight = measured?.rowHeight ?? parseFloat(ROW_HEIGHT.default);
  const focusedIndex = focusedRowId
    ? rows.findIndex((r) => r.kind === "item" && r.item.id === focusedRowId)
    : -1;
  // The focus pin is BOUNDED, and that is not a detail. `growTo` unions a
  // SPAN, so pinning a row far from the viewport would mount everything
  // in between — click a control, scroll to the other end of a 3000-row
  // backlog, and one render mounts 2950 rows. Within the margin the open
  // editor is kept alive, which is what protects the member's typed text
  // (Chromium fires no blur when a focused element is removed, so the
  // text would vanish with no commit and no toast). Beyond it the edit is
  // abandoned — the same outcome as clicking elsewhere, and a bounded
  // loss is better than an unbounded mount.
  // ONE definition of the reach, read by the pin here and by `J K` below:
  // a step whose target lies outside it is refused rather than named,
  // because a named row the pin will not mount leaves focus on `<body>`
  // (Chromium fires no blur for a removed focused element).
  const inPinReach = (index: number): boolean =>
    index >= 0 && index >= live.start - FOCUS_MARGIN && index < live.end + FOCUS_MARGIN;
  const pinned = inPinReach(focusedIndex);
  const win = !windowable
    ? live
    : growTo(
        growTo(live, dragSpan ?? EMPTY_SPAN, count, rowHeight),
        pinned ? { start: focusedIndex, end: focusedIndex + 1 } : EMPTY_SPAN,
        count,
        rowHeight,
      );

  /**
   * Read the page's geometry. Legal HERE and nowhere else: a ref read
   * during render is an error, and so is setState in an effect body —
   * but both are fine inside a callback the browser invokes.
   */
  // The window as last rendered, for the callbacks that outlive a
  // render. A ref WRITE in an effect is legal; a ref READ during render
  // is not, which is why the window itself is still derived above.
  const winRef = useRef(win);
  useEffect(() => {
    winRef.current = win;
  }, [win]);

  const measure = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Measure a real row rather than trusting the token: a browser at
    // 110% zoom renders 36px as 39.6, and an arithmetic window built on
    // the wrong height drifts further the longer the list.
    const firstRow = el.querySelector<HTMLElement>("[data-slot=table-row]");
    const measuredRow = firstRow?.getBoundingClientRect().height ?? 0;
    const next: Measured = {
      scrollTop: window.scrollY,
      listTop: rect.top + window.scrollY,
      viewportHeight: window.innerHeight,
      rowHeight: measuredRow > 0 ? measuredRow : parseFloat(ROW_HEIGHT.default),
    };
    // Bail on the derived WINDOW, not the raw measurement: scrollTop
    // changes on every frame, so comparing measurements would re-render
    // the whole table continuously. Scrolling within one row must cost
    // nothing.
    setMeasured((prev) => {
      if (prev === null) return next;
      if (sameMeasured(prev, next)) return prev;
      return sameWindow(windowOf({ ...prev, count }), windowOf({ ...next, count })) ? prev : next;
    });
    setDragSpan((prev) => {
      if (prev === null) return prev;
      const w = windowOf({ ...next, count });
      const start = Math.min(prev.start, w.start);
      const end = Math.max(prev.end, w.end);
      return start === prev.start && end === prev.end ? prev : { start, end };
    });
  }, [count]);

  // BEFORE PAINT, not after. Nothing else measures on load — no scroll
  // or resize event fires on mount — so browser scroll restoration (a
  // back-navigation) or the `#new-task` hash would otherwise land the
  // member deep in the list looking at blank spacer until they happened
  // to scroll. A layout effect also re-runs when `count` changes, which
  // is what keeps `listTop` right when the filter bar grows a Clear
  // control and pushes the table down with no scroll and no resize.
  useLayoutEffect(() => {
    if (windowed) measure();
  }, [measure, windowed]);

  useEffect(() => {
    // `windowed`, not `windowable`: below the threshold the whole list is
    // rendered anyway, so listening would re-render every backlog in the
    // product on every scroll event for no benefit at all.
    if (!windowed) return;
    const onScroll = () => measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [measure, windowed]);

  // Hoisted: epicIdsOf allocates a Set over every item, so computing it
  // inside the row map would be O(n^2) allocations on every render.
  const epicIds = epicIdsOf(items);

  // Which row the indicator sits above (`null` = no drop in progress).
  const [dropAt, setDropAt] = useState<DropAt | null>(null);
  // One O(n) pass for every row's move anchors. Asking `rowAnchors` per
  // row is O(n^2), and the row map re-runs on every pointer move of a
  // drag — the same cost the `epicIdsOf` hoist above avoids.
  // No useMemo: `rows` is built fresh in this render, so the compiler
  // refuses it as a dependency ("may be modified later") — and the React
  // Compiler already memoises this for us.
  const anchorsById = allRowAnchors(rows);
  const anchorsRef = useRef(anchorsById);
  useEffect(() => {
    anchorsRef.current = anchorsById;
  }, [anchorsById]);
  // Resolve "which half of row R" into the one convention the indicator
  // renders: the row the item will land ABOVE. Both halves of the same
  // seam therefore produce the same pixel, whichever row the hitbox
  // happened to report.
  // The monitor and this callback outlive a render, so they read the
  // anchors through a ref rather than closing over the array.
  const onEdge = useCallback((anchorId: string, edge: Edge | null) => {
    // Always compare before setting: `onDrag` fires on every pointer
    // move, and a fresh object each time would re-render the whole table
    // — and redo every row's work — dozens of times per drag.
    const next = ((): DropAt | null => {
      if (!edge) return null;
      if (edge === "top") return { above: anchorId };
      // A bottom edge means "after this row". Normalising it to "above
      // the NEXT row" is what makes both halves of one seam paint the
      // same pixel — but the next row must be the next row IN THE SAME
      // GROUP. Reading it off the flattened list would put the line under
      // the next group's header, promising a drop that a same-group
      // `canDrop` then refuses: the indicator and the outcome would
      // disagree. At a group's last row there is no next row, so the line
      // goes below the anchor itself.
      const down = anchorsRef.current.get(anchorId)?.down;
      return down?.afterId ? { above: down.afterId } : { belowLast: anchorId };
    })();
    setDropAt((current) => (sameDropAt(current, next) ? current : next));
  }, []);

  // One monitor for the whole list. `canMonitor` keeps it deaf to every
  // other drag on the page — without it this handler fires for anything
  // draggable anywhere in the shell.
  const canEdit = data.caps.canEdit;
  useEffect(() => {
    if (!canEdit) return;
    return combine(
      monitorForElements({
        canMonitor: ({ source }) => isRowData(source.data),
        // The window may only grow from here until the drop, whatever the
        // scroll does. EMPTY_SPAN widens nothing, so a drag that never
        // scrolls behaves exactly as if this were not here.
        // Seeded with the window AS IT IS NOW, not EMPTY_SPAN: the
        // union below only ever sees the NEW window, so a single large
        // scroll during a drag would otherwise drop the source row —
        // and a source row that unmounts means no `dragend`, a latch
        // that refuses every later drag, and auto-scroll that never
        // stops.
        onDragStart: () =>
          setDragSpan({ start: winRef.current.start, end: winRef.current.end }),
        onDrop: ({ source, location }) => {
          setDragSpan(null);
          setDropAt(null);
          const target = location.current.dropTargets[0];
          if (!target || !isRowData(source.data) || !isRowData(target.data)) return;
          if (target.data.itemId === source.data.itemId) return;
          const edge = extractClosestEdge(target.data);
          // The board's rule, unchanged: the anchor is the row the
          // pointer was over, the side is which half it was on. The
          // server resolves it against the LIVE project order under a
          // lock, so "directly after B" means the same thing whether or
          // not a filtered-out row sits between B and what follows it.
          runMove({
            itemId: source.data.itemId,
            ...(edge === "top"
              ? { beforeId: target.data.itemId }
              : { afterId: target.data.itemId }),
          });
        },
      }),
      // Vertical scrolling is the page's; the DataTable box scrolls
      // sideways only, so the window registration is the one that matters.
      autoScrollWindowForElements({ canScroll: ({ source }) => isRowData(source.data) }),
    );
  }, [canEdit, runMove]);


  const shownItems = rows.flatMap((r) => (r.kind === "item" ? [r.item] : []));
  const selected = shownItems.filter((i) => selectedIds.has(i.id));
  // `announceNone` may not outlive an empty shown selection (its comment
  // above): adjusted during render, never in an effect.
  if (announceNone && selected.length > 0) setAnnounceNone(false);

  const atCap = selected.length >= MAX_BULK_ITEMS;

  const toggleRow = (id: string, on: boolean) => {
    if (on && atCap && !selectedIds.has(id)) {
      // The cap binds the hand-ticked path too, or the 51st checkbox
      // silently arms a verb that can only fail with a generic toast.
      toast.info(tView("bulk.capped", { max: MAX_BULK_ITEMS }));
      return;
    }
    if (!on && selected.length === 1 && selected[0]!.id === id) setAnnounceNone(true);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  /** Select-all's target: what is shown, up to the cap. */
  const selectAllTarget = shownItems.slice(0, MAX_BULK_ITEMS);
  // "Checked" means every row select-all COULD take is taken — with more
  // rows on screen than the cap, requiring all of them would leave the
  // box permanently unchecked and turn its second click into another
  // select-all instead of a clear.
  const allShownSelected =
    selectAllTarget.length > 0 && selectAllTarget.every((i) => selectedIds.has(i.id));

  const runBulk = (fn: () => Promise<{ ok: boolean; message?: string; value?: { changed: number } }>) => {
    startTransition(async () => {
      const r = await fn().catch(() => ({ ok: false as const, message: tView("bulk.failed") }));
      if (!r.ok) {
        toast.error(r.message ?? tView("bulk.failed"));
        return;
      }
      const changed = r.value?.changed ?? 0;
      // A verb that changed nothing must SAY so — a silent success on a
      // selection that already had the value reads as a failed click.
      if (changed === 0) toast.info(tView("bulk.noneChanged"));
      else toast.success(tView("bulk.done", { changed }));
      setSelectedIds(new Set());
      router.refresh();
    });
  };

  // The backlog's region keys (UI.md §6): `J K` move focus between the
  // rows (every item row is focusable, `DragRow`), and `X` toggles the FOCUSED row's
  // selection — the row's checkbox, by keyboard, cap and all, and only
  // where that checkbox is displayed. Together they are the one-hand
  // flow: `J`, `X`, `J`, `X`.
  // On a focused row both are handled by the body's `onKeyDown`, for the
  // board's `S` reason: only a handler on the event target knows which
  // row. `X` is `run: null` (advertised only); `J` carries a `run`, below,
  // that acts only when focus is nowhere in the list. No ⌘K row for
  // either: the palette runs only run-bearing rows, and opening it moves
  // focus off the row.
  // `X` is hidden with the select column, so the overlay never offers a
  // key that the handler below refuses; `J K` need no column and no
  // permission — a viewer walks the list too. Neither is offered while
  // the peek is open: focus is trapped in the sheet and no row can hold it.
  //
  // Whether that column is DISPLAYED is observed on its header cell, not
  // asked of a media query: its cells are `priority="medium"`, a rung of
  // the TABLE's width (`PRIORITY` in `@/components/ui/table`), and the
  // viewport cannot see the 224px rail that narrows the table or the
  // member collapsing it. A `display: none` cell has no box, so
  // ResizeObserver reports the change both ways; it notifies on observe
  // only for a RENDERED cell, so the initial `false` stands for a hidden
  // one. This decides only what the overlay ADVERTISES — whether `X` acts
  // is asked of the row's own checkbox, below.
  const [selectColumnShown, setSelectColumnShown] = useState(false);
  const observeSelectColumn = useCallback((head: HTMLTableCellElement | null) => {
    if (!head) return;
    const observer = new ResizeObserver(() => setSelectColumnShown(head.getClientRects().length > 0));
    observer.observe(head);
    return () => observer.disconnect();
  }, []);
  // `J` alone carries a `run`, and it acts only when NO ROW holds focus —
  // enforced HERE, not by trusting the body handler to have
  // `preventDefault`ed: a row's `J` is prevented, but a `J` the handler
  // refuses (on the inline delete question, say) is not, and it reaches
  // this run, which would otherwise move focus and dismiss the question
  // (review, round 3). "No row", not "nothing in the body": the create
  // row's resting button is in the body and in no row, and `J` from it
  // enters the list (round 4). So the registry's `J` is the ENTRY into
  // the list — from the page, the filter bar, the table's scroll region,
  // or after a focused row was scrolled past the pin and unmounted with
  // focus on it — landing on the first row whose top is already past its
  // OWN scroll margin (`scroll-mt-16`, which is what clears the sticky
  // header), so that `focus()` scrolls nothing: a row merely clear of the
  // header but inside that margin would still be scrolled to it (review,
  // round 4). The window mounts eight rows above the viewport, so the
  // first mounted row is the wrong pick. If no row qualifies (the list's
  // end is under the header) the last mounted row is taken and the scroll
  // is the honest outcome. Not a palette row: the palette's "On this
  // page" is for verbs.
  const enterList = () => {
    const body = bodyRef.current;
    if (!body) return;
    const active = document.activeElement;
    if (active instanceof Element && active.closest("[data-item-id]")) return;
    let fallback: HTMLElement | null = null;
    for (const el of body.querySelectorAll<HTMLElement>("[data-item-id]")) {
      const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
      if (el.getBoundingClientRect().top >= margin) {
        el.focus();
        return;
      }
      fallback = el;
    }
    fallback?.focus();
  };
  const taskTimer = useTaskTimer(timer);
  useScopeKeys("backlog", [
    {
      key: "j",
      label: t("keys.navigate"),
      enabled: !peekOpen,
      run: enterList,
      hint: ["J", "or", "K"],
      palette: false,
    },
    {
      key: "x",
      label: t("keys.select"),
      enabled: data.caps.canEdit && !peekOpen && selectColumnShown,
      run: null,
    },
    // `T` on the focused row, the board card's rule: `run: null`, handled
    // on the body, and it does not hide the global `T` in the overlay or
    // the palette — that one still acts whenever no row holds focus.
    { key: "t", label: t("keys.timer"), enabled: timer !== null && !peekOpen, run: null },
  ]);

  // Things exist, none match: the third empty state (UI.md §5.8), never
  // conflated with "nothing yet" — the verb is to clear the filter, and
  // offering "create the first task" here would be a lie about the list.
  const filteredEmpty = rollup.total > 0 && rollup.shown === 0;

  return (
    // A timer verb from a row is in flight too: the row's `T` ignores a
    // press until it has settled, and this tells assistive technology (and
    // the e2e) so. No visible cue — the toast and the glyph follow.
    <div className="flex flex-col gap-3" aria-busy={isPending || taskTimer.busy || undefined}>
      <WorkFilterBar
        states={visibleColumns(data.states, data.items)}
        members={data.members}
        rollup={rollup}
      />
      <DataTable flush scrollLabel={t("scrollLabel")}>
        <Table
          // NO `table-fixed`, and the reason is measured rather than
          // theoretical. Fixed layout would make the `w-0` on the select
          // and actions headers AUTHORITATIVE instead of a min-content
          // floor, collapsing the actions column so the row's verbs
          // overflow the table's right edge — the same defect the audit's
          // `offscreenRowActions` caught at phone width, except up here no
          // stop would ever photograph it. Column widths may
          // therefore shift a little as long titles scroll into the
          // window; that is the lesser evil, and it is reversible if it
          // ever reads badly.
          //
          // The list is longer than the DOM, so it must say so. ARIA
          // counts the HEADER as row 1, hence the +1 on both.
          // Header + every task + the create row, which is always
          // rendered and is a row a screen reader can land on.
          {...(windowed
            ? { "aria-rowcount": count + 1 + (data.caps.canCreate ? 1 : 0) }
            : {})}
        >
          <TableHeader>
            <TableRow {...(windowed ? { "aria-rowindex": 1 } : {})}>
              {/* PHONE-DROPPED, and measured rather than guessed. Cells are
                  `whitespace-nowrap`, so the title column's min-content is
                  the whole title and the table is already at its natural
                  width at 390px — where the surviving columns are select ·
                  key · title · actions. Adding ~32px of checkbox put the
                  row's verbs 6px past the table's own box on every backlog
                  stop, which is the audit's `offscreenRowActions` catching
                  exactly the defect it was written for (a row's verbs
                  behind a horizontal scroll the page never advertises).
                  Column priority is the system's answer to a table that
                  does not fit, and selection is the one column here that a
                  phone can do without: the row menu still carries every
                  single-item verb. `medium` = a box of 38rem and up, the
                  same rung as visibility (the ladder is on the next
                  column). */}
              <TableHead ref={observeSelectColumn} priority="medium" className="w-0">
                {data.caps.canEdit ? (
                  <Checkbox
                    checked={allShownSelected}
                    aria-label={tView("bulk.selectAll")}
                    data-testid="backlog-select-all"
                    onCheckedChange={(on) => {
                      // Both directions touch only the rows on SCREEN, so
                      // a selection made under another filter survives —
                      // the persistence model this component documents.
                      const shownIds = new Set(shownItems.map((i) => i.id));
                      if (on !== true) {
                        setAnnounceNone(true);
                        setSelectedIds((current) =>
                          new Set([...current].filter((id) => !shownIds.has(id))),
                        );
                        return;
                      }
                      // Never select more than one action can carry: the
                      // service refuses a larger batch, so an uncapped
                      // select-all would make every verb fail with a
                      // generic toast and no clue why.
                      setSelectedIds((current) => {
                        const next = new Set(current);
                        for (const i of selectAllTarget) next.add(i.id);
                        return next;
                      });
                      if (selectAllTarget.length < shownItems.length) {
                        toast.info(tView("bulk.capped", { max: MAX_BULK_ITEMS }));
                      }
                    }}
                  />
                ) : null}
              </TableHead>
              {/* THE WIDEST TABLE IN THE PRODUCT, so it climbs every rung of
                  column priority. Its MIN-CONTENT width per rung, measured with
                  the table forced to 1px on the e2e seed, English / Swedish:
                  key · title (its 224px floor) · actions, + select and
                  visibility from `medium` — ~546 / ~556px against 608; + state
                  from `low` — ~671 / ~669 against 736; + priority and assignee
                  from `lower` — ~924 / ~958 against 984; + estimate and due
                  from `lowest` — ~1099 / ~1157 against 1136 (two builds, ±2px).
                  Swedish is the wider in every placeholder ("Ingen prioritet",
                  "Ingen ansvarig", "Ange datum"). The state and assignee names
                  are the tenant's own text, capped at 6rem below (a long pair
                  adds 44–50px). Where a row is wider than its rung's box — the
                  Swedish ten at `lowest`'s very edge (by up to ~21px, ~64 with
                  long names), or an 8-character key with a four-digit number
                  and a paperclip (+99px, measured) — the table scrolls UNDER
                  the pinned actions column, and the row's verbs stay in view.
                  At 1280px with the rail open (1008px, 991 with a classic
                  scrollbar) estimate and due step aside; 1440 (1168 / 1151),
                  or 1280 with the rail collapsed (1184 / 1167), shows all ten.
                  Visibility sits a rung BELOW state on purpose: the row's
                  left-edge cue carries it below `medium`, but a chip naming it
                  is the one safety fact the row should state in words as early
                  as it can. */}
              <TableHead className="w-[10ch]">{t("columns.key")}</TableHead>
              <TableHead>{t("columns.title")}</TableHead>
              <TableHead priority="low" className="w-[14ch]">{t("columns.state")}</TableHead>
              <TableHead priority="lower" className="w-[13ch]">{t("columns.priority")}</TableHead>
              <TableHead priority="lower" className="w-[16ch]">{t("columns.assignee")}</TableHead>
              <TableHead priority="lowest" className="w-[9ch] text-right">{t("columns.estimate")}</TableHead>
              <TableHead priority="lowest" className="w-[12ch]">{t("columns.due")}</TableHead>
              <TableHead priority="medium" className="w-[13ch]">{t("columns.visibility")}</TableHead>
              <TableHead pinned className="w-0 text-right">
                <span className="sr-only">{t("columns.actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody
            ref={bodyRef}
            // Which row holds focus, so the window can keep it mounted.
            // Capture phase: focus lands on a control inside the cell,
            // not on the row, and only the capture pass sees it on the
            // way down.
            onFocusCapture={(e) => {
              const row = (e.target as HTMLElement).closest<HTMLElement>("[data-item-id]");
              const id = row?.dataset["itemId"] ?? null;
              setFocusedRowId((prev) => (prev === id ? prev : id));
            }}
            // Released when focus leaves the table. Without this the row
            // is pinned for ever, and because the window only ever grows
            // to reach it, one focused row at the far end eventually
            // mounts the entire list — the opposite of the point.
            //
            // …EXCEPT into a dialog (`dialog-content`: the stop confirm, a
            // timer's staff notice, the palette, the `?` overlay). Each hands
            // focus back to its origin on close (`useFocusReturn`), and that
            // origin must still be in the document: a row mounted only by the
            // pin would otherwise unmount the moment the dialog took focus, and
            // focus would come back to <body> (review, slice 21). The peek is a
            // SHEET and still releases the pin, as before.
            onBlurCapture={(e) => {
              const next = e.relatedTarget as Node | null;
              if (next instanceof Element && next.closest('[data-slot="dialog-content"]')) return;
              if (!next || !e.currentTarget.contains(next)) setFocusedRowId(null);
            }}
            // `J K` and `X` (registered above). The row is the one the
            // TARGET sits in, asked of the DOM: a portalled row menu's
            // keydown bubbles through here in React's tree, but `closest`
            // walks the DOM, where that menu is inside no row.
            onKeyDown={(e) => {
              // The key FIRST, before any DOM walk or list scan: every
              // keystroke typed into a row's editor bubbles through here.
              const step = rovingStep(e.key);
              const isX = e.key.toLowerCase() === "x";
              const isT = e.key.toLowerCase() === "t";
              if ((step === undefined && !isX && !isT) || !(e.target instanceof Element)) return;
              // The registry hides these keys while the peek is open (focus is
              // trapped in the sheet); the handler refuses them too, so the
              // overlay never hides a key the list would still honour.
              if (peekOpen) return;
              // A row's inline delete question ("Delete this task? Yes No")
              // renders IN the row, not in a portal, so `closest` would find
              // the row from its Yes — and `X` would change the selection,
              // or `J` walk focus away, with a destructive question still
              // open. Escape is the way out of it. `T` there is SWALLOWED, not
              // left to the global `T`, which would stop a timer or leave the
              // page behind the open question (slice 21, round 2).
              if (e.target.closest('[data-slot="inline-confirm"]')) {
                if (isT && focusedKeyApplies({ ...keyEventShape(e), repeat: e.repeat }, "t", isGoSequencePending())) e.preventDefault();
                return;
              }
              const row = e.target.closest<HTMLElement>("[data-item-id]");
              const id = row?.dataset["itemId"];
              if (!row || !id) return;
              const shape = { ...keyEventShape(e), repeat: e.repeat };
              const goPending = isGoSequencePending();

              // ── `J K` / `↑ ↓`: roving focus ──
              if (step !== undefined) {
                // The arrows are left to a control that owns them, and to
                // Shift, which a list keeps for range selection.
                if (step.arrow && (e.shiftKey || ownsArrows(e.target))) return;
                // `X`'s guards, with auto-repeat ALLOWED: a move is one row
                // per event whatever the member holds, so a held `J` walks
                // the list (the board's rule), where a held toggle flips.
                if (!focusedKeyGuards(shape, goPending, { repeat: "allow" })) return;
                // Item rows only, so a group header is stepped over; the
                // ends are the ends — nothing happens. A LETTER at the end
                // is still consumed: unprevented, it would reach the
                // registry's `J`, whose `run` enters the list at the first
                // row on screen — a jump to the top from the bottom. An
                // arrow is left to the page, which scrolls. (A mounted row
                // is always in `shownItems`; `!to` carries the impossible
                // -1 as well.) The reach check needs the target's index in
                // `rows`, and that IS `at + delta`: the window is live only
                // ungrouped, where `rows` holds no group rows; grouped,
                // `live` is the whole list and every index is in reach.
                const at = shownItems.findIndex((i) => i.id === id);
                const to = at < 0 ? undefined : shownItems[at + step.delta];
                if (!to || !inPinReach(at + step.delta)) {
                  if (!step.arrow) e.preventDefault();
                  return;
                }
                e.preventDefault();
                setFocusedRowId(to.id);
                return;
              }

              // ── `T`: a timer on the focused row's task ──
              // Where this member can start no timer — or on an archived
              // task, which the panel offers no timer either — the key is
              // left alone and the global `T` keeps its meaning. Otherwise
              // the row CLAIMS it, even while a start is in flight and on a
              // row with no number yet: passed down, the global `T` would
              // stop the timer this row just started, or the one running
              // elsewhere. A held `T` is refused, as `X` is.
              if (isT) {
                // The guards before the list scan: a `t` typed into a row's
                // title editor stops at `inEditable` and scans nothing.
                if (!timer || !focusedKeyApplies(shape, "t", goPending)) return;
                const item = shownItems.find((i) => i.id === id);
                if (!item || item.archivedAt) return;
                e.preventDefault();
                if (item.number > 0) taskTimer.toggle(id, tProjects("board.card.label", { key: `${projectKey}-${item.number}`, title: item.title }));
                return;
              }

              // ── `X`: the focused row's checkbox, by keyboard ──
              if (!data.caps.canEdit) return;
              if (!focusedKeyApplies(shape, "x", goPending)) return;
              // `X` IS the row's checkbox, so where that checkbox is not
              // displayed it does nothing. Below the `medium` rung the select
              // column drops, and a row has no selected cue of its own — TableRow's
              // selected style is an inset LEFT bar in `--primary`, at the
              // edge where `visibilityRowCue` marks a client-visible row in
              // a colour 1.0002:1 against it — so a selection made there
              // could not be seen. Asked of the element, not of a breakpoint: no client
              // rects means `display: none` somewhere above it. DISPLAYED,
              // not necessarily in view: a table whose content outgrows its
              // box can scroll sideways past the checkbox and `X` still
              // acts — refusing would tie the key to a scroll position,
              // while the bar's count is on screen and the cue is one
              // scroll away.
              const box = row.querySelector('[role="checkbox"]');
              if (!box || box.getClientRects().length === 0) return;
              e.preventDefault();
              toggleRow(id, !selectedIds.has(id));
            }}
            // Chrome's scroll anchoring reacts to a mutating spacer by
            // adjusting scrollTop, which fires another scroll event,
            // which recomputes the window: a feedback loop that only
            // needs one pixel of row-height error to start.
            style={{ overflowAnchor: "none" }}
          >
            {win.padTop > 0 ? <Spacer height={win.padTop} testId="backlog-pad-top" /> : null}
            {rows.slice(win.start, win.end).map((row, offset) => {
              // 1-based, and the header is row 1 — so the first task is 2.
              const rowIndex = win.start + offset + 2;
              if (row.kind === "group") {
                return (
                  <GroupRow
                    key={`g:${row.key}`}
                    rowIndex={windowed ? rowIndex : undefined}
                    lane={row.lane}
                    rollup={row.rollup}
                    locale={locale}
                    durationStyle={durationStyle}
                    projectKey={projectKey}
                  />
                );
              }
              const item = row.item;
              const done = item.stateCategory === "DONE" || item.stateCategory === "CANCELLED";
              // The keyboard and touch twin of the drag (UI.md §7.1 asks
              // for one; §5.12 says reorder verbs live in the menu, never
              // behind hover, because a hover-only control is unreachable
              // by touch and invisible to a keyboard user). A verb whose
              // anchor is null is LEFT OUT rather than rendered inert —
              // the timeline's precedent for the same problem.
              const anchors = anchorsById.get(item.id) ?? NO_ANCHORS;
              // Under a filter or a grouping the ends are the ends of what
              // is ON SCREEN, so the wording says "here" rather than
              // promising the top of a list the member cannot see.
              const scoped = params.group !== "none" || hasActiveFilters(filters);
              const moveActions: RowAction[] = data.caps.canEdit
                ? [
                    ...(anchors.up
                      ? [{ key: "move-up", label: tView("move.up"), onSelect: () => runMove({ itemId: item.id, ...anchors.up }) }]
                      : []),
                    ...(anchors.down
                      ? [{ key: "move-down", label: tView("move.down"), onSelect: () => runMove({ itemId: item.id, ...anchors.down }) }]
                      : []),
                    ...(anchors.top
                      ? [{ key: "move-top", label: scoped ? tView("move.topScoped") : tView("move.top"), onSelect: () => runMove({ itemId: item.id, ...anchors.top }) }]
                      : []),
                    ...(anchors.bottom
                      ? [{ key: "move-bottom", label: scoped ? tView("move.bottomScoped") : tView("move.bottom"), onSelect: () => runMove({ itemId: item.id, ...anchors.bottom }) }]
                      : []),
                  ]
                : [];
              const actions: RowAction[] = [
                ...moveActions,
                item.archivedAt
                  ? {
                      key: "restore",
                      label: t("actions.restore"),
                      onSelect: () => run(() => setItemArchivedAction(item.id, projectKey, false), { serverMessage: true }),
                    }
                  : {
                      key: "archive",
                      label: t("actions.archive"),
                      onSelect: () => run(() => setItemArchivedAction(item.id, projectKey, true), { serverMessage: true }),
                    },
                ...(data.caps.canDelete
                  ? [
                      {
                        key: "delete",
                        label: t("actions.delete"),
                        tone: "danger" as const,
                        confirm: t("actions.confirmDelete"),
                        onSelect: () => run(() => deleteItemAction(item.id, projectKey), { serverMessage: true }),
                      },
                    ]
                  : []),
              ];
              const laneKey = laneKeyOf(item, params.group, epicIds);
              return (
                <DragRow
                  key={item.id}
                  itemId={item.id}
                  laneKey={laneKey}
                  // A row with no number yet is the optimistic create: the
                  // server takes ids, and its id is not one.
                  canDrag={data.caps.canEdit && item.number > 0}
                  onEdge={onEdge}
                  className={cn("relative", visibilityRowCue(item.visibility))}
                  rowIndex={windowed ? rowIndex : undefined}
                  keyShortcuts={["J", "K", ...(timer && !item.archivedAt && item.number > 0 ? ["T"] : [])].join(" ")}
                >
                  <TableCell priority="medium">
                    {data.caps.canEdit ? (
                      <Checkbox
                        checked={selectedIds.has(item.id)}
                        aria-label={tView("bulk.selectRow", { key: `${projectKey}-${item.number}` })}
                        data-testid="backlog-select-row"
                        aria-keyshortcuts="X"
                        onCheckedChange={(on) => toggleRow(item.id, on === true)}
                      />
                    ) : null}
                  </TableCell>
                  <TableCell className="num-id text-muted-foreground">
                    {dropAt && "above" in dropAt && dropAt.above === item.id ? (
                      <DropLine edge="top" />
                    ) : null}
                    {dropAt && "belowLast" in dropAt && dropAt.belowLast === item.id ? (
                      <DropLine edge="bottom" />
                    ) : null}
                    {/* The key IS the link to the item's peek (UI.md §5.4:
                        every peek is a link); the paperclip says the task
                        carries delivered files without opening it. */}
                    <span className="flex items-center gap-1.5">
                      <Link
                        className="underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        href={peekHref(item.number)}
                      >
                        {projectKey}-{item.number}
                      </Link>
                      {item.attachmentCount > 0 ? (
                        <span
                          data-testid="attachment-count"
                          className="num inline-flex items-center gap-0.5 text-xs"
                          title={t("attachments", { count: item.attachmentCount })}
                        >
                          <PaperclipIcon aria-hidden="true" className="size-3" />
                          <span className="sr-only">{t("attachments", { count: item.attachmentCount })}</span>
                          {item.attachmentCount}
                        </span>
                      ) : null}
                    </span>
                  </TableCell>
                  {/* The title AND the task's labels, in one cell and on one
                      line. The chips are here rather than in a column of
                      their own because this cell holds the table's only
                      horizontal slack (COLUMN_COUNT's comment has the
                      measurement); they are `shrink-0` so they take their
                      content width and the title's `w-full` <InlineEdit>
                      shrinks around them, and capped at half the cell so a
                      labelled task never loses its title.

                      `contain-inline-size` IS LOAD-BEARING, and was found by
                      the labels e2e, not by reading. Auto table layout sizes
                      a column from its cells' MIN-content, and while it does
                      so the group's `max-w-1/2` has no definite width to
                      resolve against — so the chips' FULL width became the
                      title column's floor, and two 18-character labels on
                      one row pushed the whole table 172px past its scroll
                      box. Measured with the style injected into the live
                      page: with it on every row's wrapper the table is back
                      to 1168 = 1168, the title column back to its old 287px,
                      and an unlabelled row's cell unchanged; on ONE row only
                      it still overflowed, because a column is one width. The
                      containment takes this wrapper out of the column's
                      intrinsic sizing (the cell's `min-w-56` is the floor
                      again), and `w-full` gives the flex row inside the
                      definite width its half-cell cap resolves against.

                      TWO CONSEQUENCES OF THAT, BOTH FROM THE REVIEW. (1) The
                      column no longer grows to fit a title, so the title must
                      truncate on EVERY render path: an editor's rest button
                      already does, but a read-only <InlineEdit> renders
                      `display` in a plain flex span, where a long title
                      painted over the chips and into the State column. Hence
                      `w-full` on the field and `min-w-0 truncate` (and the
                      full title as `title`, the read-only path having no
                      button to carry one) on `display`. (2) While the title
                      IS a control the chips step aside (`:has([data-editing])`
                      hides the group), so a 400-character title is edited in
                      the whole cell rather than in the half the chips leave. */}
                  <TableCell className="min-w-56">
                    <span className="flex w-full min-w-0 items-center gap-2 contain-inline-size has-[[data-editing]]:[&>[data-slot=label-chips]]:hidden">
                      {/* The member's OWN running timer (UI rule 14 — never a
                          colleague's): a glyph before the title. HERE, inside
                          the contained wrapper, because nothing in it can
                          widen a column — in the key cell it would have grown
                          a column measured to the character each time a timer
                          started (review, slice 21). No clock: the pill ticks. */}
                      {taskTimer.runningItemId === item.id ? (
                        <span
                          data-testid="backlog-row-timer"
                          className="inline-flex shrink-0 items-center text-(--tone-success-fg)"
                          title={t("timerRunning")}
                        >
                          <TimerIcon aria-hidden="true" className="size-3.5" />
                          <span className="sr-only">{t("timerRunning")}</span>
                        </span>
                      ) : null}
                      <InlineEdit
                        kind="text"
                        name="title"
                        density="table"
                        value={item.title}
                        label={t("titleLabel")}
                        placeholder={t("titleLabel")}
                        readOnly={!data.caps.canEdit}
                        hiddenInput={false}
                        className="w-full"
                        display={
                          <span
                            className={cn("min-w-0 truncate text-sm", done ? "text-muted-foreground line-through" : "font-medium", item.archivedAt ? "opacity-100 text-muted-foreground" : "")}
                            title={data.caps.canEdit ? undefined : item.title}
                          >
                            {item.title}
                          </span>
                        }
                        onCommit={(next) => {
                          if (next.trim() && next !== item.title)
                            run(() => renameItemAction(item.id, projectKey, next));
                        }}
                      />
                      <LabelChips labels={item.labels} surface="row" />
                    </span>
                  </TableCell>
                  <TableCell priority="low" data-testid="backlog-state">
                    <InlineEdit
                      kind="select"
                      name="stateId"
                      density="table"
                      fit
                      value={item.stateId}
                      label={t("stateLabel")}
                      placeholder={t("stateLabel")}
                      // The current value is always offered, even when it
                      // is not one that may be CHOSEN — see
                      // `withCurrentOption`. Here that keeps an item
                      // already in TRIAGE or a gated state displayable and
                      // reopenable; the assignee cell below now shares the
                      // helper rather than a second copy of the idiom.
                      options={withCurrentOption(stateOptions, item.stateId, item.stateName)}
                      readOnly={!data.caps.canEdit}
                      hiddenInput={false}
                      // CAPPED, like the assignee below: a state's name is the
                      // tenant's own text, and a nowrap cell grows with it —
                      // measured, a 29-character name widened this column by
                      // 134px and walked every rung's columns out of their box.
                      // At 6rem it costs 27px at most; the full name is the
                      // display's own `title`.
                      display={
                        <span
                          className="block max-w-24 truncate text-sm"
                          title={item.stateName}
                        >
                          {item.stateName}
                        </span>
                      }
                      onCommit={(next) => {
                        if (next !== item.stateId)
                          run(() =>
                            setItemStateAction({
                              itemId: item.id,
                              projectKey,
                              itemNumber: item.number,
                              surface: "backlog",
                              stateId: next,
                            }),
                          );
                      }}
                    />
                  </TableCell>
                  <TableCell priority="lower" data-testid="backlog-priority">
                    <InlineEdit
                      kind="select"
                      name="priority"
                      density="table"
                      fit
                      value={item.priority === "NONE" ? "" : item.priority}
                      label={t("priorityLabel")}
                      placeholder={tPriority("NONE")}
                      options={priorityOptions}
                      readOnly={!data.caps.canEdit}
                      hiddenInput={false}
                      display={
                        item.priority !== "NONE" ? (
                          <PriorityIndicator value={item.priority as Priority} showLabel />
                        ) : null
                      }
                      onCommit={(next) => {
                        const chosen = next === "" ? "NONE" : next;
                        if (chosen !== item.priority && (PRIORITIES as readonly string[]).includes(chosen))
                          run(() =>
                            setItemPriorityAction({
                              itemId: item.id,
                              projectKey,
                              itemNumber: item.number,
                              surface: "backlog",
                              priority: chosen as Priority,
                            }),
                          );
                      }}
                    />
                  </TableCell>
                  <TableCell priority="lower">
                    <InlineEdit
                      kind="select"
                      name="assigneeMemberId"
                      density="table"
                      fit
                      value={item.assigneeMemberId ?? ""}
                      label={t("assigneeLabel")}
                      placeholder={t("unassigned")}
                      // A DEACTIVATED ASSIGNEE IS STILL THIS ROW'S TRUTH.
                      // `assigneeOptions` is ACTIVE members, so before this
                      // the trigger announced the raw member id — a screen
                      // reader reading a UUID where a person's name belongs
                      // — and the native select, which takes `defaultValue`,
                      // opened on its FIRST option and stated "Unassigned"
                      // over a task that is assigned. Prepending the held
                      // member answers both and re-offers them to nothing
                      // else, which is the item panel's `A` picker reaching
                      // the same end by a different road (its row is simply
                      // absent, unchecked and inert).
                      options={withCurrentOption(assigneeOptions, item.assigneeMemberId ?? "", item.assigneeName)}
                      readOnly={!data.caps.canEdit}
                      hiddenInput={false}
                      display={
                        item.assigneeName ? (
                          <span
                            className="block max-w-24 truncate text-sm"
                            // Its own title as well as the trigger's: this is
                            // the element that TRUNCATES (§10.12), and the
                            // innermost title is the one a hover shows.
                            title={item.assigneeName}
                          >
                            {item.assigneeName}
                          </span>
                        ) : null
                      }
                      onCommit={(next) => {
                        if (next !== (item.assigneeMemberId ?? ""))
                          run(() =>
                            setItemAssigneeAction({
                              itemId: item.id,
                              projectKey,
                              itemNumber: item.number,
                              surface: "backlog",
                              memberId: next === "" ? null : next,
                            }),
                          );
                      }}
                    />
                  </TableCell>
                  <TableCell priority="lowest" className="text-right" data-testid="backlog-estimate">
                    <InlineEdit
                      kind="text"
                      name="estimate"
                      density="table"
                      fit
                      align="end"
                      // The edit seed is the locale-blind "1h 30m" the parser
                      // reads back in every style (format.ts round-trip rule).
                      value={item.estimateMinutes != null ? durationInputText(item.estimateMinutes * 60) : ""}
                      label={t("estimateLabel")}
                      placeholder={t("estimatePlaceholder")}
                      readOnly={!data.caps.canEdit}
                      hiddenInput={false}
                      display={
                        item.estimateMinutes != null ? (
                          <span className="num text-sm">{formatDuration(locale, item.estimateMinutes, durationStyle)}</span>
                        ) : null
                      }
                      onCommit={(next) => {
                        const minutes = parseEstimateMinutes(next);
                        if (minutes === undefined) {
                          toast.error(t("invalidEstimate"));
                          return;
                        }
                        if (minutes !== item.estimateMinutes)
                          run(() =>
                            setItemEstimateAction({
                              itemId: item.id,
                              projectKey,
                              itemNumber: item.number,
                              surface: "backlog",
                              estimateMinutes: minutes,
                            }),
                          );
                      }}
                    />
                  </TableCell>
                  <TableCell priority="lowest" data-testid="backlog-due">
                    <InlineEdit
                      kind="date"
                      name="dueDate"
                      density="table"
                      fit
                      value={item.targetDate ? isoDateOf(item.targetDate) : ""}
                      label={t("dueLabel")}
                      placeholder={t("duePlaceholder")}
                      readOnly={!data.caps.canEdit}
                      hiddenInput={false}
                      // The browser refuses what isIsoDate would (year range),
                      // so a typo year never sits in the cell looking saved.
                      inputProps={{ min: "1970-01-01", max: "2100-12-31" }}
                      display={
                        item.targetDate ? (
                          <span className="num text-sm">
                            {/* @db.Date = UTC midnight: formatDay formats in UTC,
                                or the day shifts west of UTC (review HIGH). The
                                same helper the action's `dueLabel` uses. */}
                            {formatDay(locale, item.targetDate)}
                          </span>
                        ) : null
                      }
                      onCommit={(next) => {
                        const current = item.targetDate ? isoDateOf(item.targetDate) : "";
                        if (next !== current)
                          run(() =>
                            setItemDueDateAction({
                              itemId: item.id,
                              projectKey,
                              itemNumber: item.number,
                              surface: "backlog",
                              targetDate: next === "" ? null : next,
                            }),
                          );
                      }}
                    />
                  </TableCell>
                  <TableCell priority="medium">
                    <VisibilityInlineEdit
                      value={item.visibility}
                      density="table"
                      fit
                      readOnly={!data.caps.canChangeVisibility}
                      hiddenInput={false}
                      onCommit={(next) => {
                        if (next === item.visibility) return;
                        // The badge at rest reads the SERVER prop, so the
                        // chip never shows a visibility the row does not hold
                        // (§10.4); the table still says "Saved" here, for a
                        // write that happened.
                        run(
                          () =>
                            setItemVisibilityAction({
                              itemId: item.id,
                              projectKey,
                              itemNumber: item.number,
                              surface: "backlog",
                              visibility: next,
                            }),
                          { success: t("saved") },
                        );
                      }}
                    />
                  </TableCell>
                  <TableCell pinned className="text-right">
                    {data.caps.canEdit ? (
                      <RowActions
                        label={tCommon("actionsFor", { name: `${projectKey}-${item.number}` })}
                        items={actions}
                      />
                    ) : null}
                  </TableCell>
                </DragRow>
              );
            })}
            {/* The create row stays at the foot of the list even under a
                filter: it is the surface's verb, and a filter that hides
                the way to add work would be the dead end §5.8 forbids.
                A task created here may not match the filter — the
                summary count above says so immediately. */}
            {/* BEFORE the create row, so `[&_tr:last-child]:border-b-0`
                keeps landing on the create row exactly as it does today.
                And never at zero height: a zero-height spacer still
                measures half a pixel (border-collapse splits the
                inter-row rule) and, for a member who cannot create, would
                take `:last-child` from the last real row and hand it back
                the hairline that rule exists to remove. */}
            {win.padBottom > 0 ? <Spacer height={win.padBottom} testId="backlog-pad-bottom" /> : null}
            {data.caps.canCreate ? (
              <CreateRow
                projectId={projectId}
                projectKey={projectKey}
                rowIndex={windowed ? count + 2 : undefined}
              />
            ) : null}
          </TableBody>
        </Table>
      </DataTable>
      {/* The live region is always mounted, and empty until there is a
          selection. A `role="status"` that appears WITH its text is not
          announced — only later changes to it are — so a region born
          inside the bar would stay silent on the very first tick, which
          is the one that matters. */}
      <span role="status" aria-live="polite" className="sr-only" data-testid="bulk-live">
        {/* …and says "0 tasks selected" once a member empties it, since an
            emptied region is silent (`announceNone`). */}
        {selected.length > 0 || announceNone ? tView("bulk.count", { count: selected.length }) : ""}
      </span>
      {selected.length > 0 ? (
        <BulkBar
          count={selected.length}
          // The one rule again (2W-R): a gated state is not a bulk target
          // for a non-approver either — `bulkChangeState` refuses it
          // server-side regardless, but offering it would be a lie.
          states={data.states.filter(
            (st) => !st.isHidden && canEnterState(st, data.caps.canApprove),
          )}
          anyArchived={selected.some((i) => i.archivedAt !== null)}
          pending={isPending}
          onState={(stateId) =>
            runBulk(() => bulkChangeStateAction(selected.map((i) => i.id), projectKey, stateId))
          }
          onPriority={(priority) =>
            runBulk(() => bulkSetPriorityAction(selected.map((i) => i.id), projectKey, priority))
          }
          onArchived={(archived) =>
            runBulk(() => bulkSetArchivedAction(selected.map((i) => i.id), projectKey, archived))
          }
          onClear={() => {
            setAnnounceNone(true);
            setSelectedIds(new Set());
          }}
        />
      ) : null}
      <p className="text-xs">
        <Link
          className="text-muted-foreground underline-offset-2 hover:underline"
          href={archivedHref}
          data-testid="backlog-archived-toggle"
        >
          {includeArchived ? tProjects("hideArchived") : tProjects("showArchived")}
        </Link>
      </p>
      {filteredEmpty ? (
        <EmptyState
          variant="filtered"
          title={tView("empty.filteredTitle")}
          body={tView("empty.filteredBody")}
          action={
            <Button
              size="sm"
              variant="outline"
              data-testid="backlog-filtered-clear"
              onClick={() =>
                void setParams({ state: null, assignee: null, priority: null, hideDone: null })
              }
            >
              {tView("empty.filteredAction")}
            </Button>
          }
        />
      ) : null}
      {taskTimer.notice}
    </div>
  );
}

/**
 * A group's header line. It is a row of the same table — one `--row-h`,
 * one spanning cell — so the list keeps a single rhythm and the group
 * label scrolls with the rows it names.
 *
 * The rollup counts the WHOLE group, not the filtered part: a
 * denominator that shrinks when you filter is a lie about the size of
 * the work. `shown` appears beside it only while a filter is hiding
 * something.
 */
function GroupRow({
  lane,
  rollup,
  locale,
  durationStyle,
  projectKey,
  rowIndex,
}: {
  lane: Lane;
  rollup: Rollup;
  locale: string;
  durationStyle: DurationStyle;
  projectKey: string;
  rowIndex?: number | undefined;
}) {
  const t = useTranslations("projects.workView");
  const tPriority = useTranslations("states.priority");
  const title =
    lane.kind === "member"
      ? lane.name
      : lane.kind === "unassigned"
        ? t("lanes.unassigned")
        : lane.kind === "priority"
          ? tPriority(lane.priority)
          : lane.kind === "epic"
            ? lane.title || t("lanes.epicUntitled")
            : t("lanes.noEpic");

  return (
    <TableRow
      data-testid="backlog-group"
      data-lane={lane.key}
      aria-rowindex={rowIndex}
      className="bg-muted/40"
    >
      <TableCell colSpan={COLUMN_COUNT}>
        <span className="flex items-center gap-2">
          {lane.kind === "member" ? <MemberAvatar id={lane.memberId} name={lane.name} size="sm" /> : null}
          {lane.kind === "priority" ? <PriorityIndicator value={lane.priority} /> : null}
          {lane.kind === "epic" && lane.epicKey > 0 ? (
            <span className="num-id text-xs text-muted-foreground">
              {projectKey}-{lane.epicKey}
            </span>
          ) : null}
          <span className="truncate text-sm font-semibold">{title}</span>
          <span className="num text-xs text-muted-foreground">
            {rollup.shown === rollup.total
              ? t("rollup.count", { total: rollup.total })
              : t("rollup.countFiltered", { shown: rollup.shown, total: rollup.total })}
          </span>
          {rollup.done > 0 ? (
            <span className="num text-xs text-muted-foreground">
              {t("rollup.done", { done: rollup.done })}
            </span>
          ) : null}
          {rollup.estimateMinutes > 0 ? (
            <span className="num ml-auto text-xs text-muted-foreground">
              {formatDuration(locale, rollup.estimateMinutes, durationStyle)}
            </span>
          ) : null}
        </span>
      </TableCell>
    </TableRow>
  );
}

/** Title-only create (UI rules 2 + 3): AT REST this row is a button —
 * an always-mounted input in a resting row is the defect the founder
 * mandate exists to prevent (and the visual audit fails on it).
 * Activating swaps in the focused field; Enter creates and STAYS open
 * for the next title; Escape or an empty blur returns to rest.
 * Deliberately not a <form action> — we clear the value on success,
 * React never resets it mid-flight. */
function CreateRow({
  projectId,
  projectKey,
  rowIndex,
}: {
  projectId: string;
  projectKey: string;
  rowIndex?: number | undefined;
}) {
  const t = useTranslations("projects.backlog");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    const value = title.trim();
    if (!value || pending) return;
    start(async () => {
      const r = await createItemAction(projectId, projectKey, value).catch(() => ({
        ok: false as const,
        message: t("actionFailed"),
      }));
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      setTitle("");
      inputRef.current?.focus();
      router.refresh();
    });
  };

  return (
    <TableRow id="new-task" aria-rowindex={rowIndex} className="scroll-mt-16">
      {/* The select column has no meaning for a row that does not exist
          yet, but the cell must still be there or every cell after it
          shifts one column left — and it must carry the SAME priority as
          the column it stands in, or it survives on a phone where its
          header does not. */}
      <TableCell priority="medium" aria-hidden="true" />
      <TableCell className="text-muted-foreground" aria-hidden="true">
        <PlusIcon className="size-3.5" />
      </TableCell>
      <TableCell colSpan={SPAN_AFTER_KEY}>
        {editing ? (
          <Input
            ref={inputRef}
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                setTitle("");
                setEditing(false);
              }
            }}
            onBlur={() => {
              if (title.trim() === "" && !pending) setEditing(false);
            }}
            placeholder={t("createPlaceholder")}
            aria-label={t("createLabel")}
            disabled={pending}
            className="h-7 border-none bg-transparent px-1 shadow-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex h-7 w-full items-center rounded-md px-1 text-left text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {t("empty.action")}
          </button>
        )}
      </TableCell>
    </TableRow>
  );
}
