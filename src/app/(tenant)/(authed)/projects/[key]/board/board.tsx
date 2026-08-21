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
import { KanbanSquareIcon, ListChecksIcon, PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";
import { toast } from "sonner";

import {
  EmptyState,
  MemberAvatar,
  PriorityIndicator,
  RowActions,
  SectionCard,
  StatusIcon,
  type RowAction,
} from "@/components/semantic";
import { isEditableTarget, isGoSequencePending } from "@/components/shell/use-hotkeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { VisibilityBadge, visibilityRowCue } from "@/components/visibility-badge";
import { STATUS_MAP, type Priority, type StatusValue } from "@/lib/enum-map";
import { formatDurationHm } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ItemList } from "@/modules/work";

import { createItemInStateAction, deleteItemAction, moveItemAction, setItemArchivedAction } from "../backlog/actions";
import {
  applyMove,
  cardsIn,
  columnTotals,
  edgeAnchors,
  epicIdsOf,
  laneKeyOf,
  lanesFor,
  visibleColumns,
  type BoardItem,
  type BoardState,
  type GroupBy,
  type Lane,
  type Move,
} from "./board-model";
import { MovePicker } from "./move-picker";

/**
 * The project board (PLAN 2W screens; UI.md rule 5, §5.3, §7.1, §7.2):
 * columns are the project's states, position is priority, one order per
 * project. A drop is a state change + a rank change in ONE server
 * action; the client sends ids, never a rank. Every move is optimistic
 * (`useOptimistic` over the server list → action → `router.refresh()`),
 * a failure reverts to the server's truth and says so in a toast. Drag
 * is desktop-only (Pragmatic, pointer: fine); the "Move to…" picker is
 * the keyboard / mobile twin and lives in the card's menu and on `S`.
 * Freshness: a 12 s version poll + a check on focus (ARC-18).
 *
 * Group-by lanes (assignee / priority / epic) are read-only rows of the
 * same columns: a drag stays inside its lane (state + position), the
 * property itself is changed where it is edited (the backlog's inline
 * pickers). Cross-lane drag — "property change + rank" — is a later
 * slice, noted in PLAN.
 */

type CardData = { type: "card"; itemId: string; stateId: string; laneKey: string };
type ColumnData = { type: "column"; stateId: string; laneKey: string };
const isCardData = (d: Record<string | symbol, unknown>): d is CardData => d["type"] === "card";
const isColumnData = (d: Record<string | symbol, unknown>): d is ColumnData => d["type"] === "column";

type OptimisticAction = { type: "move"; move: Move } | { type: "create"; item: BoardItem };

const POLL_MS = 12_000;

export function Board({
  projectId,
  projectKey,
  locale,
  data,
  groupBy,
  version,
}: {
  projectId: string;
  projectKey: string;
  locale: string;
  data: ItemList;
  groupBy: GroupBy;
  /** The freshness token the page rendered with (ARC-18). */
  version: string;
}) {
  const t = useTranslations("projects.board");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [items, applyOptimistic] = useOptimistic(
    data.items,
    (current: BoardItem[], action: OptimisticAction): BoardItem[] =>
      action.type === "move"
        ? applyMove(current, action.move, data.states)
        : [...current, action.item],
  );
  // Refs mirror render state for the DnD monitor / poll callbacks; they
  // are written in effects, never during render (React Compiler rule).
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const columns = useMemo(() => visibleColumns(data.states, items), [data.states, items]);
  const lanes = useMemo(() => lanesFor(groupBy, items, data.members), [groupBy, items, data.members]);
  const canEdit = data.caps.canEdit;

  // ── the one mutation path ─────────────────────────────────────────
  const runMove = useCallback(
    (move: Move) => {
      startTransition(async () => {
        applyOptimistic({ type: "move", move });
        const r = await moveItemAction({ ...move, projectKey }).catch(() => ({
          ok: false as const,
          message: t("moveFailed"),
        }));
        if (!r.ok) toast.error(r.message);
        router.refresh();
      });
    },
    [applyOptimistic, projectKey, router, t],
  );

  // ── drag: one monitor for the whole board ─────────────────────────
  useEffect(() => {
    if (!canEdit) return;
    return monitorForElements({
      canMonitor: ({ source }) => isCardData(source.data),
      onDrop: ({ source, location }) => {
        const target = location.current.dropTargets[0];
        if (!target || !isCardData(source.data)) return;
        const from = source.data;
        const current = itemsRef.current;
        if (isCardData(target.data)) {
          if (target.data.itemId === from.itemId) return;
          const edge = extractClosestEdge(target.data);
          const anchor = target.data.itemId;
          runMove({
            itemId: from.itemId,
            stateId: target.data.stateId,
            ...(edge === "top" ? { beforeId: anchor } : { afterId: anchor }),
          });
          return;
        }
        if (isColumnData(target.data)) {
          const cards = cardsIn(current, groupBy, target.data.laneKey, target.data.stateId).filter(
            (c) => c.id !== from.itemId,
          );
          // Dropped on the body of its own, otherwise empty column: nothing to do.
          if (target.data.stateId === from.stateId && cards.length === 0) return;
          const last = cards.at(-1);
          // An empty column has no bottom: the state changes, the place in
          // the project order is kept (self anchor = "stay").
          runMove({
            itemId: from.itemId,
            stateId: target.data.stateId,
            afterId: last ? last.id : from.itemId,
          });
        }
      },
    });
  }, [canEdit, groupBy, runMove]);

  // Columns grow with the page (no inner scroll box), so the page itself
  // auto-scrolls while a card is dragged near an edge.
  useEffect(() => {
    if (!canEdit) return;
    return autoScrollWindowForElements({ canScroll: ({ source }) => isCardData(source.data) });
  }, [canEdit]);

  // ── freshness (ARC-18): poll while visible, check on focus ────────
  const versionRef = useRef(version);
  useEffect(() => {
    versionRef.current = version;
  }, [version]);
  const pendingRef = useRef(isPending);
  useEffect(() => {
    pendingRef.current = isPending;
  }, [isPending]);
  useEffect(() => {
    let disposed = false;
    const check = async () => {
      if (disposed || pendingRef.current || document.visibilityState !== "visible") return;
      try {
        const res = await fetch(`/api/version?scope=project:${projectId}`, { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { version?: string };
        if (!disposed && body.version && body.version !== versionRef.current) {
          versionRef.current = body.version;
          router.refresh();
        }
      } catch {
        // offline / aborted: the next tick tries again
      }
    };
    const id = window.setInterval(check, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      window.clearInterval(id);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [projectId, router]);

  // ── keyboard: roving focus across cells, S = move, C = create ─────
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [picker, setPicker] = useState<BoardItem | null>(null);
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const epicIds = useMemo(() => epicIdsOf(items), [items]);
  const firstCardId = items.find((i) => !(groupBy === "epic" && i.type === "EPIC"))?.id ?? null;
  const tabbableId = focusedId && items.some((i) => i.id === focusedId) ? focusedId : firstCardId;
  const defaultState = data.states.find((s) => s.isDefault) ?? columns[0];
  const canCreate = data.caps.canCreate && groupBy === "none";

  // Focus is handed back to a card AFTER it has rendered where it now
  // lives (a moved card is a new DOM node in another column), never on
  // a timer racing the transition.
  const pendingFocusRef = useRef<string | null>(null);
  const focusCard = useCallback((id: string) => {
    setFocusedId(id);
    pendingFocusRef.current = id;
  }, []);
  useEffect(() => {
    const id = pendingFocusRef.current;
    if (!id || picker) return;
    const el = document.querySelector<HTMLElement>(`[data-board-card="${id}"]`);
    if (el) {
      pendingFocusRef.current = null;
      el.focus();
    }
  }, [picker, items]);

  const onBoardKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const cardId = target.dataset["boardCard"];
    if (!cardId || e.metaKey || e.ctrlKey || e.altKey) return;
    const item = items.find((i) => i.id === cardId);
    if (!item) return;
    const laneKey = laneKeyOf(item, groupBy, epicIds);
    const cell = cardsIn(items, groupBy, laneKey, item.stateId);
    const at = cell.findIndex((c) => c.id === item.id);
    const col = columns.findIndex((c) => c.id === item.stateId);
    const step = (to: BoardItem | undefined) => {
      if (to) {
        e.preventDefault();
        focusCard(to.id);
      }
    };
    switch (e.key) {
      case "ArrowDown":
      case "j":
        step(cell[at + 1]);
        return;
      case "ArrowUp":
      case "k":
        step(cell[at - 1]);
        return;
      case "ArrowRight":
      case "ArrowLeft": {
        const dir = e.key === "ArrowRight" ? 1 : -1;
        // The nearest non-empty column in that direction, same lane, same row (clamped).
        for (let c = col + dir; c >= 0 && c < columns.length; c += dir) {
          const cards = cardsIn(items, groupBy, laneKey, columns[c]!.id);
          if (cards.length > 0) {
            step(cards[Math.min(at, cards.length - 1)]);
            return;
          }
        }
        return;
      }
      case "s":
      case "S":
        if (canEdit) {
          e.preventDefault();
          setPicker(item);
        }
        return;
      default:
        return;
    }
  };

  // `C` anywhere on the page (UI.md §6 global): a new task in context —
  // the default column's title field. Inert in inputs, behind ⌘/Ctrl,
  // and while a `G …` go-to sequence is armed. Capture phase on purpose:
  // the shell's bubble listener clears the armed `G` on the second key,
  // so a bubble listener here would see `G C` as a plain `C`.
  useEffect(() => {
    if (!canCreate || !defaultState) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() !== "c" || isEditableTarget(e.target) || isGoSequencePending()) return;
      e.preventDefault();
      setCreatingIn(defaultState.id);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [canCreate, defaultState]);

  const onPickerChoose = (choice: { stateId: string; edge: "top" | "bottom" }) => {
    if (!picker) return;
    const laneKey = laneKeyOf(picker, groupBy, epicIds);
    const anchors = edgeAnchors(items, groupBy, laneKey, choice.stateId, picker.id);
    runMove({ itemId: picker.id, stateId: choice.stateId, ...anchors[choice.edge] });
    focusCard(picker.id);
  };

  return (
    <>
      {items.length === 0 && canCreate && defaultState ? (
        <SectionCard>
          <EmptyState
            variant="empty"
            icon={KanbanSquareIcon}
            title={t("empty.title")}
            body={t("empty.body")}
            action={
              <Button size="sm" onClick={() => setCreatingIn(defaultState.id)} data-testid="board-empty-create">
                {t("empty.action")}
              </Button>
            }
          />
        </SectionCard>
      ) : null}
      <div
        data-testid="board"
        data-slot="board"
        role="region"
        tabIndex={0}
        aria-label={t("scrollLabel")}
        aria-busy={isPending || undefined}
        className="-mx-1 overflow-x-auto px-1 pb-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        onKeyDown={onBoardKeyDown}
      >
        <div className="flex min-w-full flex-col gap-6">
          {lanes.map((lane) => (
            <BoardLane
              key={lane.key}
              lane={lane}
              groupBy={groupBy}
              locale={locale}
              columns={columns}
              items={items}
              members={data.members}
              projectId={projectId}
              projectKey={projectKey}
              canEdit={canEdit}
              canDelete={data.caps.canDelete}
              canCreate={canCreate}
              tabbableId={tabbableId}
              defaultStateId={defaultState?.id ?? null}
              creatingIn={creatingIn}
              setCreatingIn={setCreatingIn}
              onFocusCard={setFocusedId}
              onOpenPicker={setPicker}
              applyOptimistic={applyOptimistic}
              startTransition={startTransition}
              onMutate={() => router.refresh()}
            />
          ))}
        </div>
      </div>
      {picker ? (
        <MovePicker
          open
          onOpenChange={(open) => {
            if (!open) {
              const id = picker.id;
              setPicker(null);
              focusCard(id);
            }
          }}
          itemKey={`${projectKey}-${picker.number}`}
          states={columns}
          currentStateId={picker.stateId}
          onChoose={onPickerChoose}
        />
      ) : null}
    </>
  );
}

// ── a lane: one row of columns (the whole board when ungrouped) ──────

function BoardLane(props: {
  lane: Lane;
  groupBy: GroupBy;
  locale: string;
  columns: BoardState[];
  items: BoardItem[];
  members: ItemList["members"];
  projectId: string;
  projectKey: string;
  canEdit: boolean;
  canDelete: boolean;
  canCreate: boolean;
  tabbableId: string | null;
  defaultStateId: string | null;
  creatingIn: string | null;
  setCreatingIn: (stateId: string | null) => void;
  onFocusCard: (id: string) => void;
  onOpenPicker: (item: BoardItem) => void;
  applyOptimistic: (a: OptimisticAction) => void;
  startTransition: (fn: () => Promise<void>) => void;
  onMutate: () => void;
}) {
  const t = useTranslations("projects.board");
  const tPriority = useTranslations("states.priority");
  const { lane } = props;
  const laneTitle =
    lane.kind === "all"
      ? null
      : lane.kind === "member"
        ? lane.name
        : lane.kind === "unassigned"
          ? t("lanes.unassigned")
          : lane.kind === "priority"
            ? tPriority(lane.priority)
            : lane.kind === "epic"
              ? lane.title || t("lanes.epicUntitled")
              : t("lanes.noEpic");
  const epicIds = useMemo(() => epicIdsOf(props.items), [props.items]);
  const laneCount = props.items.filter(
    (i) => laneKeyOf(i, props.groupBy, epicIds) === lane.key && !(props.groupBy === "epic" && i.type === "EPIC"),
  ).length;
  // An empty lane (no cards anywhere) is still a drop target row for
  // priorities, whose lanes are fixed; member/epic lanes exist only with items.
  return (
    <section data-testid="board-lane" data-lane={lane.key} aria-label={laneTitle ?? undefined} className="flex flex-col gap-2">
      {laneTitle !== null ? (
        <header className="flex items-center gap-2 px-1">
          {lane.kind === "member" ? <MemberAvatar id={lane.memberId} name={lane.name} size="sm" /> : null}
          {lane.kind === "priority" ? <PriorityIndicator value={lane.priority} /> : null}
          {lane.kind === "epic" && lane.epicKey > 0 ? (
            <span className="num-id text-xs text-muted-foreground">
              {props.projectKey}-{lane.epicKey}
            </span>
          ) : null}
          <h2 className="text-sm font-semibold">{laneTitle}</h2>
          <span className="text-xs text-muted-foreground">{t("column.tasks", { count: laneCount })}</span>
        </header>
      ) : null}
      <div
        // Phone: one column, states stacked (UI.md §3.3). Desktop: a row
        // of EQUAL implicit columns (`grid-cols-none`, or the first track
        // keeps `minmax(0,1fr)` and gets crushed) that scrolls sideways
        // inside the region.
        className="grid grid-cols-1 gap-3 md:auto-cols-[minmax(16rem,1fr)] md:grid-flow-col md:grid-cols-none"
      >
        {props.columns.map((state) => (
          <BoardColumn key={state.id} state={state} {...props} />
        ))}
      </div>
    </section>
  );
}

// ── a column cell: header + cards + create ───────────────────────────

function BoardColumn(props: {
  state: BoardState;
  lane: Lane;
  groupBy: GroupBy;
  locale: string;
  items: BoardItem[];
  projectId: string;
  projectKey: string;
  canEdit: boolean;
  canDelete: boolean;
  canCreate: boolean;
  tabbableId: string | null;
  defaultStateId: string | null;
  creatingIn: string | null;
  setCreatingIn: (stateId: string | null) => void;
  onFocusCard: (id: string) => void;
  onOpenPicker: (item: BoardItem) => void;
  applyOptimistic: (a: OptimisticAction) => void;
  startTransition: (fn: () => Promise<void>) => void;
  onMutate: () => void;
}) {
  const t = useTranslations("projects.board");
  const { state, lane, groupBy, items } = props;
  const cards = useMemo(() => cardsIn(items, groupBy, lane.key, state.id), [items, groupBy, lane.key, state.id]);
  const totals = columnTotals(cards);
  const spec = STATUS_MAP.stateCategory[state.category as StatusValue<"stateCategory">];
  const overWip = state.wipLimit !== null && totals.count > state.wipLimit;
  const ref = useRef<HTMLDivElement>(null);
  const [isOver, setIsOver] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || !props.canEdit) return;
    const data: ColumnData = { type: "column", stateId: state.id, laneKey: lane.key };
    return dropTargetForElements({
      element: el,
      canDrop: ({ source }) => isCardData(source.data) && source.data.laneKey === lane.key,
      getData: () => data,
      getIsSticky: () => true,
      onDragEnter: () => setIsOver(true),
      onDragLeave: () => setIsOver(false),
      onDrop: () => setIsOver(false),
    });
  }, [props.canEdit, state.id, lane.key]);

  return (
    <div
      ref={ref}
      data-testid="board-column"
      data-state-category={state.category}
      data-state-id={state.id}
      data-over={isOver ? "true" : undefined}
      className={cn(
        "flex min-h-24 flex-col rounded-card border border-border bg-card transition-colors duration-(--dur-fast)",
        isOver && "border-ring bg-accent",
      )}
    >
      <header className="flex h-9 items-center gap-2 border-b border-border px-3">
        <StatusIcon name={spec.icon} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h3 className="truncate text-sm font-medium">{state.name}</h3>
        <span
          className={cn("num ml-auto text-xs", overWip ? "font-semibold text-(--tone-caution-fg)" : "text-muted-foreground")}
          title={overWip ? t("column.wipOver", { limit: state.wipLimit ?? 0 }) : undefined}
        >
          {totals.count}
        </span>
        {totals.estimateMinutes > 0 ? (
          <span className="num text-xs text-muted-foreground" aria-label={t("column.estimate", { hours: formatDurationHm(props.locale, totals.estimateMinutes) })}>
            {formatDurationHm(props.locale, totals.estimateMinutes)}
          </span>
        ) : null}
      </header>
      <div role="list" className="flex flex-col gap-2 p-2">
        {cards.map((item) => (
          <BoardCard
            key={item.id}
            item={item}
            laneKey={lane.key}
            projectKey={props.projectKey}
            locale={props.locale}
            canEdit={props.canEdit}
            canDelete={props.canDelete}
            tabbable={props.tabbableId === item.id}
            onFocus={() => props.onFocusCard(item.id)}
            onOpenPicker={() => props.onOpenPicker(item)}
            startTransition={props.startTransition}
            onMutate={props.onMutate}
          />
        ))}
        {props.canCreate ? (
          <ColumnCreate
            state={state}
            projectId={props.projectId}
            projectKey={props.projectKey}
            isDefault={props.defaultStateId === state.id}
            editing={props.creatingIn === state.id}
            setEditing={(on) => props.setCreatingIn(on ? state.id : null)}
            applyOptimistic={props.applyOptimistic}
            startTransition={props.startTransition}
            onMutate={props.onMutate}
          />
        ) : null}
      </div>
    </div>
  );
}

// ── a card ───────────────────────────────────────────────────────────

function BoardCard({
  item,
  laneKey,
  projectKey,
  locale,
  canEdit,
  canDelete,
  tabbable,
  onFocus,
  onOpenPicker,
  startTransition,
  onMutate,
}: {
  item: BoardItem;
  laneKey: string;
  projectKey: string;
  locale: string;
  canEdit: boolean;
  canDelete: boolean;
  tabbable: boolean;
  onFocus: () => void;
  onOpenPicker: () => void;
  startTransition: (fn: () => Promise<void>) => void;
  onMutate: () => void;
}) {
  const t = useTranslations("projects.board");
  const tBacklog = useTranslations("projects.backlog");
  const tCommon = useTranslations("common");
  const ref = useRef<HTMLElement>(null);
  const [dragging, setDragging] = useState(false);
  const [edge, setEdge] = useState<Edge | null>(null);
  const key = `${projectKey}-${item.number > 0 ? item.number : "…"}`;
  const done = item.stateCategory === "DONE" || item.stateCategory === "CANCELLED";

  useEffect(() => {
    const el = ref.current;
    if (!el || !canEdit) return;
    const data: CardData = { type: "card", itemId: item.id, stateId: item.stateId, laneKey };
    // Desktop-only (ARC-17): no drag from a coarse pointer; the picker is the twin.
    const finePointer = window.matchMedia("(pointer: fine)").matches;
    return combine(
      draggable({
        element: el,
        canDrag: () => finePointer && item.number > 0,
        getInitialData: () => data,
        onDragStart: () => setDragging(true),
        onDrop: () => setDragging(false),
      }),
      dropTargetForElements({
        element: el,
        canDrop: ({ source }) =>
          isCardData(source.data) && source.data.laneKey === laneKey && source.data.itemId !== item.id,
        getData: ({ input, element }) =>
          attachClosestEdge(data, { input, element, allowedEdges: ["top", "bottom"] }),
        getIsSticky: () => true,
        onDrag: ({ self }) => setEdge(extractClosestEdge(self.data)),
        onDragLeave: () => setEdge(null),
        onDrop: () => setEdge(null),
      }),
    );
  }, [canEdit, item.id, item.stateId, item.number, laneKey]);

  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    startTransition(async () => {
      const r = await fn().catch(() => ({ ok: false, message: tBacklog("actionFailed") }));
      if (!r.ok) toast.error(r.message);
      else toast.success(r.message);
      onMutate();
    });

  const actions: RowAction[] = [
    { key: "move", label: t("moveTo"), onSelect: onOpenPicker },
    item.archivedAt
      ? { key: "restore", label: tBacklog("actions.restore"), onSelect: () => run(() => setItemArchivedAction(item.id, projectKey, false)) }
      : { key: "archive", label: tBacklog("actions.archive"), onSelect: () => run(() => setItemArchivedAction(item.id, projectKey, true)) },
    ...(canDelete
      ? [
          {
            key: "delete",
            label: tBacklog("actions.delete"),
            tone: "danger" as const,
            confirm: tBacklog("actions.confirmDelete"),
            onSelect: () => run(() => deleteItemAction(item.id, projectKey)),
          },
        ]
      : []),
  ];

  return (
    <article
      ref={ref}
      role="listitem"
      data-testid="board-card"
      data-board-card={item.id}
      data-item-key={key}
      data-visibility={item.visibility}
      tabIndex={tabbable ? 0 : -1}
      onFocus={onFocus}
      aria-label={t("card.label", { key, title: item.title })}
      className={cn(
        "relative flex flex-col gap-1.5 rounded-md border border-border bg-background p-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        visibilityRowCue(item.visibility),
        canEdit && item.number > 0 && "cursor-grab active:cursor-grabbing",
        dragging && "opacity-40",
        item.number === 0 && "text-muted-foreground",
      )}
    >
      {edge ? (
        <span
          aria-hidden="true"
          className={cn("pointer-events-none absolute inset-x-0 h-0.5 rounded-full bg-primary", edge === "top" ? "-top-1.5" : "-bottom-1.5")}
        />
      ) : null}
      <div className="flex items-center gap-1.5">
        <span className="num-id text-xs text-muted-foreground">{key}</span>
        {item.priority !== "NONE" ? <PriorityIndicator value={item.priority as Priority} /> : null}
        {item.visibility === "CLIENT_VISIBLE" ? <VisibilityBadge value="CLIENT_VISIBLE" size="sm" className="ml-auto" /> : null}
        {canEdit && item.number > 0 ? (
          <span className={cn(item.visibility === "CLIENT_VISIBLE" ? "" : "ml-auto")}>
            <RowActions label={tCommon("actionsFor", { name: key })} items={actions} />
          </span>
        ) : null}
      </div>
      <p className={cn("leading-snug", done ? "text-muted-foreground line-through" : "font-medium")}>{item.title}</p>
      {item.checklistTotal > 0 || item.estimateMinutes !== null || item.assigneeMemberId ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {item.checklistTotal > 0 ? (
            <span className="inline-flex items-center gap-1" aria-label={t("card.checklist", { done: item.checklistDone, total: item.checklistTotal })}>
              <ListChecksIcon aria-hidden="true" className="size-3" />
              <span className="num">
                {item.checklistDone}/{item.checklistTotal}
              </span>
            </span>
          ) : null}
          {item.estimateMinutes !== null ? (
            <span className="num" aria-label={t("card.estimate", { hours: formatDurationHm(locale, item.estimateMinutes) })}>
              {formatDurationHm(locale, item.estimateMinutes)}
            </span>
          ) : null}
          {item.assigneeMemberId ? (
            <span className="ml-auto" aria-label={t("card.assignee", { name: item.assigneeName ?? "" })}>
              <MemberAvatar id={item.assigneeMemberId} name={item.assigneeName ?? ""} size="sm" />
            </span>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

// ── title-only create at the foot of a column ────────────────────────

/** At rest a button (founder mandate 1); activating swaps in the field;
 * Enter creates and stays open; Escape or an empty blur rests. Not a
 * <form action> — the value is cleared on success, React never resets
 * it mid-flight. The created card appears at once (optimistic, keyed
 * "…") and takes its real number on the refresh. */
function ColumnCreate({
  state,
  projectId,
  projectKey,
  isDefault,
  editing,
  setEditing,
  applyOptimistic,
  startTransition,
  onMutate,
}: {
  state: BoardState;
  projectId: string;
  projectKey: string;
  isDefault: boolean;
  editing: boolean;
  setEditing: (on: boolean) => void;
  applyOptimistic: (a: OptimisticAction) => void;
  startTransition: (fn: () => Promise<void>) => void;
  onMutate: () => void;
}) {
  const t = useTranslations("projects.board");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    const value = title.trim();
    if (!value || busy) return;
    setBusy(true);
    setTitle("");
    startTransition(async () => {
      applyOptimistic({
        type: "create",
        item: {
          id: `temp-${Date.now()}`,
          number: 0,
          title: value,
          type: "TASK",
          stateId: state.id,
          stateCategory: state.category,
          stateName: state.name,
          priority: "NONE",
          estimateMinutes: null,
          targetDate: null,
          visibility: "INTERNAL",
          assigneeMemberId: null,
          assigneeName: null,
          rootId: "",
          parentId: null,
          archivedAt: null,
          checklistTotal: 0,
          checklistDone: 0,
        },
      });
      const r = await createItemInStateAction(projectId, projectKey, state.id, value).catch(() => ({
        ok: false as const,
        message: t("moveFailed"),
      }));
      if (!r.ok) toast.error(r.message);
      setBusy(false);
      inputRef.current?.focus();
      onMutate();
    });
  };

  return editing ? (
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
        if (title.trim() === "" && !busy) setEditing(false);
      }}
      placeholder={t("create.placeholder")}
      aria-label={t("create.label", { state: state.name })}
      data-testid="board-create-input"
      className="h-8"
    />
  ) : (
    <button
      type="button"
      id={isDefault ? "board-create" : undefined}
      data-testid="board-create"
      onClick={() => setEditing(true)}
      className="flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <PlusIcon aria-hidden="true" className="size-3.5" />
      {t("create.button")}
    </button>
  );
}
