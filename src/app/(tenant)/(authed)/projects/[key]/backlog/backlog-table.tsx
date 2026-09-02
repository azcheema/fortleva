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
import { PaperclipIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useQueryStates } from "nuqs";
import { useCallback, useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import {
  DataTable,
  EmptyState,
  InlineEdit,
  MemberAvatar,
  PriorityIndicator,
  RowActions,
  VisibilityInlineEdit,
  visibilityRowCue,
  type RowAction,
} from "@/components/semantic";
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
import { isoDateOf, parseEstimateMinutes } from "@/lib/duration";
import { PRIORITIES, type Priority } from "@/lib/enum-map";
import { durationInputText, formatDate, formatDuration, type DurationStyle } from "@/lib/format";
import type { FormResult } from "@/lib/server-actions";
import { cn } from "@/lib/utils";
import {
  MAX_BULK_ITEMS,
  allRowAnchors,
  applyMove,
  canEnterState,
  epicIdsOf,
  filtersOf,
  hasActiveFilters,
  laneKeyOf,
  peekHrefOf,
  visibleColumns,
  workView,
  workViewHref,
  workViewParsers,
  type Lane,
  type Move,
  type Rollup,
  type RowAnchors,
  type WorkItem,
} from "@/lib/work-view";
import type { ResolvedItemList } from "@/modules/work";

import {
  assignItemAction,
  bulkChangeStateAction,
  bulkSetArchivedAction,
  bulkSetPriorityAction,
  createItemAction,
  deleteItemAction,
  renameItemAction,
  setItemArchivedAction,
  moveItemAction,
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

const useRun = (locale: string) => {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<FormResult>, quiet = true) =>
    start(async () => {
      const r = await fn().catch(() => ({ ok: false as const, message: locale }));
      if (!r.ok) toast.error(r.message);
      else if (!quiet) toast.success(r.message);
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
  children,
}: {
  itemId: string;
  laneKey: string;
  canDrag: boolean;
  className?: string;
  onEdge: (itemId: string, edge: Edge | null) => void;
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
      // Opacity, never a transform: a transformed row would become the
      // containing block for the drop line and move it off the row.
      className={cn(className, canDrag && "cursor-grab active:cursor-grabbing", dragging && "opacity-40")}
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
        "pointer-events-none absolute inset-x-0 h-0.5 rounded-full bg-primary",
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
        onDrop: ({ source, location }) => {
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

  const atCap = selected.length >= MAX_BULK_ITEMS;

  const toggleRow = (id: string, on: boolean) => {
    if (on && atCap && !selectedIds.has(id)) {
      // The cap binds the hand-ticked path too, or the 51st checkbox
      // silently arms a verb that can only fail with a generic toast.
      toast.info(tView("bulk.capped", { max: MAX_BULK_ITEMS }));
      return;
    }
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

  // Things exist, none match: the third empty state (UI.md §5.8), never
  // conflated with "nothing yet" — the verb is to clear the filter, and
  // offering "create the first task" here would be a lie about the list.
  const filteredEmpty = rollup.total > 0 && rollup.shown === 0;

  return (
    <div className="flex flex-col gap-3" aria-busy={isPending || undefined}>
      <WorkFilterBar
        states={visibleColumns(data.states, data.items)}
        members={data.members}
        rollup={rollup}
      />
      <DataTable flush scrollLabel={t("scrollLabel")}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-0">
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
              <TableHead className="w-[10ch]">{t("columns.key")}</TableHead>
              <TableHead>{t("columns.title")}</TableHead>
              <TableHead priority="medium" className="w-[14ch]">{t("columns.state")}</TableHead>
              <TableHead priority="low" className="w-[13ch]">{t("columns.priority")}</TableHead>
              <TableHead priority="low" className="w-[16ch]">{t("columns.assignee")}</TableHead>
              <TableHead priority="low" className="w-[9ch] text-right">{t("columns.estimate")}</TableHead>
              <TableHead priority="low" className="w-[12ch]">{t("columns.due")}</TableHead>
              <TableHead priority="medium" className="w-[13ch]">{t("columns.visibility")}</TableHead>
              <TableHead className="w-0 text-right">
                <span className="sr-only">{t("columns.actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              if (row.kind === "group") {
                return (
                  <GroupRow
                    key={`g:${row.key}`}
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
                      onSelect: () => run(() => setItemArchivedAction(item.id, projectKey, false), false),
                    }
                  : {
                      key: "archive",
                      label: t("actions.archive"),
                      onSelect: () => run(() => setItemArchivedAction(item.id, projectKey, true), false),
                    },
                ...(data.caps.canDelete
                  ? [
                      {
                        key: "delete",
                        label: t("actions.delete"),
                        tone: "danger" as const,
                        confirm: t("actions.confirmDelete"),
                        onSelect: () => run(() => deleteItemAction(item.id, projectKey), false),
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
                >
                  <TableCell>
                    {data.caps.canEdit ? (
                      <Checkbox
                        checked={selectedIds.has(item.id)}
                        aria-label={tView("bulk.selectRow", { key: `${projectKey}-${item.number}` })}
                        data-testid="backlog-select-row"
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
                  {/* The floor only binds at PHONE width — on desktop the
                      title takes whatever the other columns leave — and
                      224px no longer fits there. At 390px the surviving
                      columns are select · key · title · actions, and once
                      the selection bar makes the page tall enough to gain
                      a vertical scrollbar the content column loses ~15px:
                      the row's verbs then sat 6px past the table's own
                      box, which is the defect `craft.offscreenRowActions`
                      exists to catch and which the new
                      `project-backlog-selection` stop caught on its first
                      CI run. 160px leaves real headroom. */}
                  <TableCell className="min-w-40">
                    <InlineEdit
                      kind="text"
                      name="title"
                      density="table"
                      value={item.title}
                      label={t("titleLabel")}
                      placeholder={t("titleLabel")}
                      readOnly={!data.caps.canEdit}
                      hiddenInput={false}
                      display={
                        <span className={cn("text-sm", done ? "text-muted-foreground line-through" : "font-medium", item.archivedAt ? "opacity-100 text-muted-foreground" : "")}>
                          {item.title}
                        </span>
                      }
                      onCommit={(next) => {
                        if (next.trim() && next !== item.title)
                          run(() => renameItemAction(item.id, projectKey, next));
                      }}
                    />
                  </TableCell>
                  <TableCell priority="medium" data-testid="backlog-state">
                    <InlineEdit
                      kind="select"
                      name="stateId"
                      density="table"
                      fit
                      value={item.stateId}
                      label={t("stateLabel")}
                      placeholder={t("stateLabel")}
                      options={stateOptions.some((o) => o.value === item.stateId)
                        ? stateOptions
                        : [{ value: item.stateId, label: item.stateName }, ...stateOptions]}
                      readOnly={!data.caps.canEdit}
                      hiddenInput={false}
                      display={<span className="text-sm">{item.stateName}</span>}
                      onCommit={(next) => {
                        if (next !== item.stateId) run(() => setItemStateAction(item.id, projectKey, next));
                      }}
                    />
                  </TableCell>
                  <TableCell priority="low" data-testid="backlog-priority">
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
                        if (chosen !== item.priority)
                          run(() => setItemPriorityAction(item.id, projectKey, chosen));
                      }}
                    />
                  </TableCell>
                  <TableCell priority="low">
                    <InlineEdit
                      kind="select"
                      name="assigneeMemberId"
                      density="table"
                      fit
                      value={item.assigneeMemberId ?? ""}
                      label={t("assigneeLabel")}
                      placeholder={t("unassigned")}
                      options={assigneeOptions}
                      readOnly={!data.caps.canEdit}
                      hiddenInput={false}
                      display={
                        item.assigneeName ? (
                          <span className="text-sm">{item.assigneeName}</span>
                        ) : null
                      }
                      onCommit={(next) => {
                        if (next !== (item.assigneeMemberId ?? ""))
                          run(() => assignItemAction(item.id, projectKey, next));
                      }}
                    />
                  </TableCell>
                  <TableCell priority="low" className="text-right" data-testid="backlog-estimate">
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
                          run(() => setItemEstimateAction(item.id, projectKey, minutes));
                      }}
                    />
                  </TableCell>
                  <TableCell priority="low" data-testid="backlog-due">
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
                            {/* @db.Date = UTC midnight: format in UTC or the
                                day shifts west of UTC (review HIGH). */}
                            {formatDate(locale, item.targetDate, {
                              year: "numeric",
                              month: "short",
                              day: "numeric",
                              timeZone: "UTC",
                            })}
                          </span>
                        ) : null
                      }
                      onCommit={(next) => {
                        const current = item.targetDate ? isoDateOf(item.targetDate) : "";
                        if (next !== current)
                          run(() => setItemDueDateAction(item.id, projectKey, next === "" ? null : next));
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
                        if (next !== item.visibility)
                          run(() => setItemVisibilityAction(item.id, projectKey, next), false);
                      }}
                    />
                  </TableCell>
                  <TableCell className="text-right">
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
            {data.caps.canCreate ? (
              <CreateRow projectId={projectId} projectKey={projectKey} />
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
        {selected.length > 0 ? tView("bulk.count", { count: selected.length }) : ""}
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
          onClear={() => setSelectedIds(new Set())}
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
}: {
  lane: Lane;
  rollup: Rollup;
  locale: string;
  durationStyle: DurationStyle;
  projectKey: string;
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
    <TableRow data-testid="backlog-group" data-lane={lane.key} className="bg-muted/40">
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
function CreateRow({ projectId, projectKey }: { projectId: string; projectKey: string }) {
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
    <TableRow id="new-task" className="scroll-mt-16">
      {/* The select column has no meaning for a row that does not exist
          yet, but the cell must still be there or every cell after it
          shifts one column left. */}
      <TableCell aria-hidden="true" />
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
