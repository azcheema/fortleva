"use client";

import {
  autoScrollForElements,
  autoScrollWindowForElements,
} from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element";
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
import { HourglassIcon, KanbanSquareIcon, ListChecksIcon, PlusIcon, TimerIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useId,
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
import { isGoSequencePending, useScopeKeys } from "@/components/shell/use-hotkeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { VisibilityBadge, visibilityRowCue } from "@/components/visibility-badge";
import { LabelChips } from "@/components/work-view/label-chips";
import { STATUS_MAP, type Priority, type StatusValue } from "@/lib/enum-map";
import { formatDuration, type DurationStyle } from "@/lib/format";
import { focusedKeyApplies, keyEventShape, type KeyBinding } from "@/lib/keymap";
import { cn } from "@/lib/utils";
import {
  applyMove,
  canEnterState,
  cardsIn,
  columnTotals,
  edgeAnchors,
  epicIdsOf,
  laneKeyOf,
  lanesFor,
  visibleColumns,
  type GroupBy,
  type Lane,
  type Move,
  type WorkItem,
  type WorkState,
} from "@/lib/work-view";
import type { ItemSpent } from "@/modules/time";
import type { ItemList, ResolvedItemList } from "@/modules/work";

import type { TimerPillState } from "../../../time/actions";
import { useTaskTimer } from "../../../time/use-task-timer";
import { createItemInStateAction, deleteItemAction, moveItemAction, setItemArchivedAction } from "../backlog/actions";
import { TimerElapsed } from "../item-panel/timer-control";
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

type OptimisticAction = { type: "move"; move: Move } | { type: "create"; item: WorkItem };

const POLL_MS = 12_000;

export function Board({
  projectId,
  projectKey,
  locale,
  data,
  groupBy,
  version,
  durationStyle,
  peekOpen,
  timer,
  spent,
}: {
  projectId: string;
  projectKey: string;
  locale: string;
  data: ResolvedItemList;
  groupBy: GroupBy;
  /** The freshness token the page rendered with (ARC-18). */
  version: string;
  /** The tenant's `ui.durationStyle` — REQUIRED (standing trap). */
  durationStyle: DurationStyle;
  /**
   * The member's timer as the page read it (`loadPanelTimer`), or `null`
   * where they can start none — no `time:track`, or an archived project.
   * REQUIRED, `null` included: it decides whether a card takes `T`.
   */
  timer: TimerPillState | null;
  /**
   * Σ spent per task as the page read it (`projectItemSpent`): the team's
   * figure with `time:view_team`, the member's own with `time:track`
   * alone, `null` with neither. REQUIRED, `null` included — a card must
   * reflect it, never default it (standing trap).
   */
  spent: ItemSpent | null;
  /** True while the item peek (`?item=`) is open over the board: the
   * window-level `C` must not create behind the sheet's scrim (2W-B
   * review — the region-scoped keys are already inert, focus being
   * trapped in the sheet). */
  peekOpen: boolean;
}) {
  const t = useTranslations("projects.board");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [items, applyOptimistic] = useOptimistic(
    data.items,
    (current: WorkItem[], action: OptimisticAction): WorkItem[] =>
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
  const canApprove = data.caps.canApprove;

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
          // A card that has not been given its number yet (the optimistic
          // create) is not a legal anchor — the server takes ids, and its
          // id is a temporary one no row carries.
          const cards = cardsIn(current, groupBy, target.data.laneKey, target.data.stateId).filter(
            (c) => c.id !== from.itemId && c.number > 0,
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

  // Auto-scroll while dragging near an edge (UI.md §7.1): the page for
  // the vertical axis, and the board REGION for the horizontal one — six
  // columns need more than the 1392 px `Page width="wide"` allows, so
  // without the second registration the far column cannot be reached by
  // drag on any monitor.
  const regionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!canEdit) return;
    const region = regionRef.current;
    const canScroll = ({ source }: { source: { data: Record<string | symbol, unknown> } }) =>
      isCardData(source.data);
    return combine(
      autoScrollWindowForElements({ canScroll }),
      ...(region ? [autoScrollForElements({ element: region, canScroll })] : []),
    );
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
    let denials = 0;
    let id = 0;
    const check = async () => {
      if (disposed || pendingRef.current || document.visibilityState !== "visible") return;
      try {
        const res = await fetch(`/api/version?scope=project:${projectId}`, { cache: "no-store" });
        // A 404 is the route's ONE denial answer — "you may no longer see
        // this project" (it collapses every AuthzError into it). Refresh
        // once: a real revocation lands on the in-shell 404, which
        // unmounts this board entirely. A transport-level 404 (an
        // extension, an edge blip) leaves the board mounted, so polling
        // continues — and only a THIRD consecutive denial stops the timer,
        // because a board that has quietly given up on freshness is worse
        // than one that keeps asking.
        if (res.status === 404) {
          denials += 1;
          if (denials === 1) router.refresh();
          if (denials >= 3) window.clearInterval(id);
          return;
        }
        if (!res.ok) return;
        denials = 0;
        const body = (await res.json()) as { version?: string };
        if (!disposed && body.version && body.version !== versionRef.current) {
          versionRef.current = body.version;
          router.refresh();
        }
      } catch {
        // offline / aborted: the next tick tries again
      }
    };
    id = window.setInterval(check, POLL_MS);
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
  const [picker, setPicker] = useState<WorkItem | null>(null);
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const epicIds = useMemo(() => epicIdsOf(items), [items]);
  const firstCardId = items.find((i) => !(groupBy === "epic" && i.type === "EPIC"))?.id ?? null;
  const tabbableId = focusedId && items.some((i) => i.id === focusedId) ? focusedId : firstCardId;
  const defaultState = data.states.find((s) => s.isDefault) ?? columns[0];
  const canCreate = data.caps.canCreate && groupBy === "none";
  const taskTimer = useTaskTimer(timer);

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

  // `T` on a card (UI.md §6): a timer on its task. Unlike `S` and the
  // roving keys it acts from ANYWHERE in the card — the card itself or its
  // "…" button — because the key it would otherwise reach is not nothing
  // but the global `T`, which stops the timer running elsewhere or leaves
  // the board for /time. The card is asked of the DOM (`closest`), so a
  // portalled menu whose keydown bubbles here through React's tree is in no
  // card; `focusedKeyApplies` refuses a menu layer besides.
  //
  // Where this member can start no timer the key is left alone, and the
  // global `T` keeps its meaning — the item panel's rule. Otherwise the card
  // CLAIMS it, even while a start is still in flight and on a card with no
  // number yet: passed down, the global `T` would stop the timer this card
  // just started, or the one running elsewhere. The dispatcher's guards
  // first, since this runs before it; a HELD `T` is refused (a toggle flips
  // on every repeat) and reaches the global binding, which refuses it too.
  //
  // …and NOTHING under the card's inline delete question ("Delete this
  // task? Yes No"), which `RowActions` renders in place, inside the card:
  // `closest` finds the card from its Yes, and a timer must not start on
  // the task being deleted, nor the global `T` act behind the question —
  // so the key is swallowed there (review, round 2; the backlog row does
  // the same under its own question).
  const onCardTimerKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!(e.target instanceof Element)) return;
    if (!focusedKeyApplies({ ...keyEventShape(e), repeat: e.repeat }, "t", isGoSequencePending())) return;
    const card = e.target.closest<HTMLElement>("[data-board-card]");
    if (card && e.target.closest('[data-slot="inline-confirm"]')) {
      e.preventDefault();
      return;
    }
    const cardId = card?.dataset["boardCard"];
    const item = timer && cardId ? items.find((i) => i.id === cardId) : undefined;
    if (!item) return;
    e.preventDefault();
    if (item.number > 0) taskTimer.toggle(item.id, t("card.label", { key: `${projectKey}-${item.number}`, title: item.title }));
  };

  const onBoardKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "t" || e.key === "T") {
      onCardTimerKey(e);
      return;
    }
    const target = e.target as HTMLElement;
    const cardId = target.dataset["boardCard"];
    if (!cardId || e.metaKey || e.ctrlKey || e.altKey) return;
    const item = items.find((i) => i.id === cardId);
    if (!item) return;
    const laneKey = laneKeyOf(item, groupBy, epicIds);
    const cell = cardsIn(items, groupBy, laneKey, item.stateId);
    const at = cell.findIndex((c) => c.id === item.id);
    const col = columns.findIndex((c) => c.id === item.stateId);
    const step = (to: WorkItem | undefined) => {
      if (to) {
        e.preventDefault();
        focusCard(to.id);
      }
    };
    switch (e.key) {
      case "ArrowDown":
      case "j":
      case "J":
        step(cell[at + 1]);
        return;
      case "ArrowUp":
      case "k":
      case "K":
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
        // Never on a card that has no number yet (the optimistic create),
        // and never while a `G …` go-to sequence is armed (the shell owns it).
        if (canEdit && item.number > 0 && !isGoSequencePending()) {
          e.preventDefault();
          setPicker(item);
        }
        return;
      default:
        return;
    }
  };

  // The board's region keys (UI.md §6). `C` is the only one the registry
  // RUNS — the capture-phase window listener it replaces existed solely
  // so it could see an armed `G` before the shell's bubble listener
  // cleared it, and one dispatcher consults the sequence once, ahead of
  // every scope.
  //
  // `S` and the roving `↑↓←→ J K` stay in `onBoardKeyDown` and register
  // as `run: null` — advertised here, handled there. They need the
  // FOCUSED CARD, which only a handler on the event target can know:
  // migrating them to a window listener over `focusedId` (never cleared
  // on blur) or `document.activeElement.closest()` (true in strictly
  // more situations) would silently WIDEN a shipped key. Dispatch skips
  // a `run: null` binding rather than swallowing it, so the arrow row
  // never eats page scroll.
  const boardKeys = useMemo<KeyBinding[]>(
    () => [
      {
        key: "c",
        label: t("keys.create"),
        // The peek is a sibling of this component, not a descendant, so
        // nothing about the sheet makes a window listener inert — `C`
        // used to create cards behind the scrim. `peekOpen` stays the
        // explicit gate; it is now an `enabled` value rather than an
        // effect guard.
        enabled: Boolean(canCreate && defaultState && !peekOpen),
        run: () => {
          if (defaultState) setCreatingIn(defaultState.id);
        },
      },
      { key: "s", label: t("keys.move"), enabled: canEdit, run: null },
      // `run: null` like `S`: it needs the focused card. It does not hide
      // the global `T` in the overlay or the palette — that one still acts
      // whenever no card holds focus (`overlaySections`).
      { key: "t", label: t("keys.timer"), enabled: timer !== null && !peekOpen, run: null },
      { key: "j", label: t("keys.navigate"), enabled: true, run: null, hint: ["J", "or", "K"] },
    ],
    [canCreate, defaultState, peekOpen, canEdit, timer, t],
  );
  useScopeKeys("board", boardKeys);

  const onPickerChoose = (choice: { stateId: string; edge: "top" | "bottom" }) => {
    if (!picker) return;
    const laneKey = laneKeyOf(picker, groupBy, epicIds);
    const anchors = edgeAnchors(items, groupBy, laneKey, choice.stateId, picker.id);
    runMove({ itemId: picker.id, stateId: choice.stateId, ...anchors[choice.edge] });
    focusCard(picker.id);
  };

  return (
    <>
      {items.length === 0 && data.caps.canCreate ? (
        <SectionCard>
          <EmptyState
            variant="empty"
            icon={KanbanSquareIcon}
            title={t("empty.title")}
            body={t("empty.body")}
            action={
              // Creating happens in a column, and a grouped view has no
              // column to create in — there the verb is "leave the
              // grouping", never a dead end (§5.8).
              canCreate && defaultState ? (
                <Button size="sm" onClick={() => setCreatingIn(defaultState.id)} data-testid="board-empty-create">
                  {t("empty.action")}
                </Button>
              ) : (
                <Button asChild size="sm">
                  <Link href={`/projects/${projectKey}/board`} data-testid="board-empty-ungroup">
                    {t("empty.ungroup")}
                  </Link>
                </Button>
              )
            }
          />
        </SectionCard>
      ) : null}
      <div
        ref={regionRef}
        data-testid="board"
        data-slot="board"
        role="region"
        tabIndex={0}
        aria-label={t("scrollLabel")}
        // A timer verb from a card is in flight too: the card's `T` ignores
        // a press until it has settled, and this tells assistive technology
        // (and the e2e) so. No visible cue — the toast and the badge follow.
        aria-busy={isPending || taskTimer.busy || undefined}
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
              canApprove={canApprove}
              durationStyle={durationStyle}
              timer={timer}
              spent={spent}
              runningItemId={taskTimer.runningItemId}
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
          // Entering TRIAGE is its own verb (`work_item:triage`), and a
          // gated state (Done) takes an approver — the same rule the
          // drag follows; `transitionState` is the belt.
          states={columns.filter((s) => canEnterState(s, canApprove))}
          currentStateId={picker.stateId}
          onChoose={onPickerChoose}
        />
      ) : null}
      {taskTimer.notice}
    </>
  );
}

// ── a lane: one row of columns (the whole board when ungrouped) ──────

function BoardLane(props: {
  lane: Lane;
  groupBy: GroupBy;
  locale: string;
  columns: WorkState[];
  items: WorkItem[];
  members: ItemList["members"];
  projectId: string;
  projectKey: string;
  canEdit: boolean;
  canDelete: boolean;
  canCreate: boolean;
  canApprove: boolean;
  durationStyle: DurationStyle;
  timer: TimerPillState | null;
  spent: ItemSpent | null;
  runningItemId: string | null;
  tabbableId: string | null;
  defaultStateId: string | null;
  creatingIn: string | null;
  setCreatingIn: (stateId: string | null) => void;
  onFocusCard: (id: string) => void;
  onOpenPicker: (item: WorkItem) => void;
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
      {laneTitle === null ? <h2 className="sr-only">{t("scrollLabel")}</h2> : null}
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
  state: WorkState;
  lane: Lane;
  groupBy: GroupBy;
  locale: string;
  items: WorkItem[];
  projectId: string;
  projectKey: string;
  canEdit: boolean;
  canDelete: boolean;
  canCreate: boolean;
  canApprove: boolean;
  durationStyle: DurationStyle;
  timer: TimerPillState | null;
  spent: ItemSpent | null;
  runningItemId: string | null;
  tabbableId: string | null;
  defaultStateId: string | null;
  creatingIn: string | null;
  setCreatingIn: (stateId: string | null) => void;
  onFocusCard: (id: string) => void;
  onOpenPicker: (item: WorkItem) => void;
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
  const headingId = useId();
  const [isOver, setIsOver] = useState(false);
  // Entering TRIAGE is `work_item:triage` with a triageStatus, not a state
  // change (the DB CHECK refuses it), and a gated state (Done) takes an
  // approver — so neither is a drop target for this member; leaving
  // either is an ordinary move. `transitionState` is the belt.
  const droppable = props.canEdit && canEnterState(state, props.canApprove);

  useEffect(() => {
    const el = ref.current;
    if (!el || !droppable) return;
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
  }, [droppable, state.id, lane.key]);

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
        <h3 id={headingId} className="truncate text-sm font-medium">
          {state.name}
        </h3>
        <span
          className={cn("num ml-auto text-xs", overWip ? "font-semibold text-(--tone-caution-fg)" : "text-muted-foreground")}
          title={overWip ? t("column.wipOver", { limit: state.wipLimit ?? 0 }) : undefined}
        >
          {totals.count}
        </span>
        {totals.estimateMinutes > 0 ? (
          <span role="img" className="num text-xs text-muted-foreground" aria-label={t("column.estimate", { hours: formatDuration(props.locale, totals.estimateMinutes, props.durationStyle) })}>
            {formatDuration(props.locale, totals.estimateMinutes, props.durationStyle)}
          </span>
        ) : null}
      </header>
      <div role="list" aria-labelledby={headingId} className="flex flex-col gap-2 p-2">
        {cards.map((item) => (
          <BoardCard
            key={item.id}
            item={item}
            laneKey={lane.key}
            droppable={droppable}
            projectKey={props.projectKey}
            locale={props.locale}
            durationStyle={props.durationStyle}
            timer={props.runningItemId === item.id ? props.timer : null}
            spent={props.spent}
            takesTimerKey={props.timer !== null}
            canEdit={props.canEdit}
            canDelete={props.canDelete}
            tabbable={props.tabbableId === item.id}
            onFocus={() => props.onFocusCard(item.id)}
            onOpenPicker={() => props.onOpenPicker(item)}
            startTransition={props.startTransition}
            onMutate={props.onMutate}
          />
        ))}
      </div>
      {/* Outside the role="list": a button is not a list item, and
          aria-required-children would be violated by putting it inside. */}
      {/* Creating is `work_item:create`; TRIAGE cannot be created into
          (it needs a triageStatus) and a gated column takes an approver —
          createItem(stateId) runs the same transitionState gate.
          Deliberately NOT gated on `droppable`, which also folds in
          `work_item:edit`. */}
      {props.canCreate && canEnterState(state, props.canApprove) ? (
        <div className="px-2 pb-2">
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
        </div>
      ) : null}
    </div>
  );
}

// ── a card ───────────────────────────────────────────────────────────

/** Whole minutes of a task's Σ spent, 0 when the read has none (or none for this task). */
const spentMinutesOf = (spent: ItemSpent | null, itemId: string): number =>
  Math.round((spent?.seconds[itemId] ?? 0) / 60);

/**
 * Σ spent / estimate on a card (PLAN 2T; UI.md §5.4 "Σ spent on the
 * card"). Finished time only — the running badge beside it is the live
 * part — as ONE figure with the estimate when the task has one ("45 min /
 * 2 h"), so the two numbers are read against each other; a task over its
 * estimate wears the caution tone the column's WIP count wears. The
 * accessible name says whose time it is: the team's (`time:view_team`)
 * or "Your time" (a member with `time:track` alone, rule 14) — the glyph
 * is the same, the sentence is not. Under a minute rounds to nothing and
 * shows nothing, so a card never says "0 min". Without spent time the
 * estimate renders exactly as it always has.
 */
function SpentFigure({
  minutes,
  scope,
  estimateMinutes,
  locale,
  durationStyle,
}: {
  minutes: number;
  scope: ItemSpent["scope"] | null;
  estimateMinutes: number | null;
  locale: string;
  durationStyle: DurationStyle;
}) {
  const t = useTranslations("projects.board");
  const estimate = estimateMinutes !== null ? formatDuration(locale, estimateMinutes, durationStyle) : null;
  if (minutes < 1 || scope === null) {
    if (estimate === null) return null;
    return (
      <span role="img" className="num" aria-label={t("card.estimate", { hours: estimate })}>
        {estimate}
      </span>
    );
  }
  const spent = formatDuration(locale, minutes, durationStyle);
  const own = scope === "own";
  const label =
    estimate === null
      ? t(own ? "card.spentOwn" : "card.spent", { hours: spent })
      : t(own ? "card.spentOwnOfEstimate" : "card.spentOfEstimate", { spent, estimate });
  const over = !own && estimateMinutes !== null && minutes > estimateMinutes;
  return (
    <span
      role="img"
      data-testid="board-card-spent"
      aria-label={label}
      className={cn("num inline-flex items-center gap-1", over && "font-semibold text-(--tone-caution-fg)")}
    >
      <HourglassIcon aria-hidden="true" className="size-3" />
      {estimate === null ? spent : `${spent} / ${estimate}`}
    </span>
  );
}

function BoardCard({
  item,
  laneKey,
  projectKey,
  locale,
  durationStyle,
  timer,
  spent,
  takesTimerKey,
  canEdit,
  canDelete,
  droppable,
  tabbable,
  onFocus,
  onOpenPicker,
  startTransition,
  onMutate,
}: {
  item: WorkItem;
  laneKey: string;
  projectKey: string;
  locale: string;
  durationStyle: DurationStyle;
  /**
   * The member's timer when it runs on THIS card's task, else `null`: the
   * card draws its running badge from it. The pill's 1 Hz tick re-renders
   * no card (`useTimerFacts` changes only on a start or stop); the one clock
   * that ticks is the badge's own leaf.
   */
  timer: TimerPillState | null;
  /** The page's Σ spent read (`Board`'s `spent`); the card looks its own task up. */
  spent: ItemSpent | null;
  /** Whether `T` on this card starts a timer (the board's `timer` is not null). */
  takesTimerKey: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** False in a TRIAGE column: entering triage is its own verb. */
  droppable: boolean;
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
  const router = useRouter();
  const searchParams = useSearchParams();
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
      // The card ACCEPTS ITSELF on purpose: a drop target that refuses is
      // skipped by the library, which then hands the drop to the column
      // underneath — and a micro-drag that never left the card would be
      // read as "move to the bottom of this column". Accepting means the
      // monitor sees the card, recognises the identity and does nothing.
      // A card with no number yet (the optimistic create) is never a
      // target: the server takes ids, and its id is not one.
      dropTargetForElements({
        element: el,
        canDrop: ({ source }) =>
          droppable && isCardData(source.data) && source.data.laneKey === laneKey && item.number > 0,
        getData: ({ input, element }) =>
          attachClosestEdge(data, { input, element, allowedEdges: ["top", "bottom"] }),
        getIsSticky: () => true,
        onDrag: ({ self, source }) =>
          setEdge(isCardData(source.data) && source.data.itemId === item.id ? null : extractClosestEdge(self.data)),
        onDragLeave: () => setEdge(null),
        onDrop: () => setEdge(null),
      }),
    );
  }, [canEdit, droppable, item.id, item.stateId, item.number, laneKey]);

  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    startTransition(async () => {
      const r = await fn().catch(() => ({ ok: false, message: tBacklog("actionFailed") }));
      if (!r.ok) toast.error(r.message);
      else toast.success(r.message);
      onMutate();
    });

  // The board never lists archived items (listItems hides them), so there
  // is no Restore here — archiving says where the item went, and the
  // backlog's ?archived=1 view is where it comes back from.
  const actions: RowAction[] = [
    // A real row (the optimistic create has no number yet) opens as the
    // peek — the same `?item=` link the backlog's key cell is (2W-B);
    // useSearchParams keeps the group-by view.
    ...(item.number > 0
      ? [
          {
            key: "open",
            label: t("card.open"),
            onSelect: () => {
              const params = new URLSearchParams(searchParams.toString());
              params.set("item", key);
              router.push(`/projects/${projectKey}/board?${params.toString()}`);
            },
          },
        ]
      : []),
    { key: "move", label: t("moveTo"), onSelect: onOpenPicker },
    { key: "archive", label: tBacklog("actions.archive"), onSelect: () => run(() => setItemArchivedAction(item.id, projectKey, true)) },
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
      // The letters this card answers (the arrows are the list's own).
      aria-keyshortcuts={["J", "K", ...(canEdit && item.number > 0 ? ["S"] : []), ...(takesTimerKey && item.number > 0 ? ["T"] : [])].join(" ")}
      className={cn(
        "relative flex flex-col gap-1.5 rounded-md border border-border bg-background p-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        // The cue owns the left edge on a CLIENT_VISIBLE card; an INTERNAL
        // one keeps a left edge of the SAME width in the border colour —
        // `visibilityRowCue`'s transparent left is written for rows, which
        // have no border there to erase.
        item.visibility === "CLIENT_VISIBLE" ? visibilityRowCue(item.visibility) : "border-l-2 border-l-border",
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
      {/* Between the title and the meta row: a label is what the task IS
          about, so it reads with the title, above the numbers. Its own
          line because chips wrap here — the card has the height the
          backlog row does not (`LabelChips`, `surface="card"`). */}
      <LabelChips labels={item.labels} surface="card" />
      {item.checklistTotal > 0 || item.estimateMinutes !== null || spentMinutesOf(spent, item.id) >= 1 || timer || item.assigneeMemberId ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {item.checklistTotal > 0 ? (
            <span role="img" className="inline-flex items-center gap-1" aria-label={t("card.checklist", { done: item.checklistDone, total: item.checklistTotal })}>
              <ListChecksIcon aria-hidden="true" className="size-3" />
              <span className="num">
                {item.checklistDone}/{item.checklistTotal}
              </span>
            </span>
          ) : null}
          <SpentFigure
            minutes={spentMinutesOf(spent, item.id)}
            scope={spent?.scope ?? null}
            estimateMinutes={item.estimateMinutes}
            locale={locale}
            durationStyle={durationStyle}
          />
          {/* The member's OWN running timer, never anyone else's: a card
              that showed a colleague's clock would be the live presence
              UI rule 14 forbids. Beside the estimate, the number it will
              one day be read against; the label is static, so a reader is
              not handed a new clock every second. */}
          {timer ? (
            <span
              role="img"
              aria-label={t("card.timerRunning")}
              data-testid="board-card-timer"
              className="inline-flex items-center gap-1 text-(--tone-success-fg)"
            >
              <TimerIcon aria-hidden="true" className="size-3" />
              <TimerElapsed initial={timer} className="num tabular-nums" />
            </span>
          ) : null}
          {item.assigneeMemberId ? (
            <span role="img" className="ml-auto" aria-label={t("card.assignee", { name: item.assigneeName ?? "" })}>
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
  state: WorkState;
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
  // Escape leaves the field and hands focus back to the control that
  // opened it (UI.md §5.11) — but ONLY Escape. A blur-close because the
  // member clicked a card must leave that click's focus alone, or the
  // board's single-key handlers go deaf on a card nobody is focused on.
  // Same shape as InlineEdit / RowActions: a flag the button's callback
  // ref consumes once, after it has actually rendered.
  const returnFocus = useRef(false);

  const submit = () => {
    const value = title.trim();
    if (!value || busy) return;
    setBusy(true);
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
          attachmentCount: 0,
          // A title-only create carries no labels, and the `L` picker is
          // in the panel: the refresh cannot bring any either.
          labels: [],
        },
      });
      const r = await createItemInStateAction(projectId, projectKey, state.id, value).catch(() => ({
        ok: false as const,
        message: t("create.failed"),
      }));
      setBusy(false);
      inputRef.current?.focus();
      if (!r.ok) {
        // The title STAYS in the field — a failed action must never look
        // like a revert, and retyping a lost title is the worst of both
        // (AGENTS.md standing trap).
        toast.error(r.message);
        return;
      }
      // Clear only what was actually sent: a title typed while this one
      // was in flight belongs to the member, not to the round trip. The
      // comparison is on the TRIMMED value — `value` is trimmed, the field
      // is not, and "Fix login " would otherwise stay put and read as a
      // failure the member answers by creating the task twice.
      setTitle((current) => (current.trim() === value ? "" : current));
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
          returnFocus.current = true;
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
      ref={(node) => {
        if (node && returnFocus.current) {
          returnFocus.current = false;
          node.focus();
        }
      }}
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
