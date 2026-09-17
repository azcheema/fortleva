"use client";

import { PlayIcon, SquareIcon, TimerIcon } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useRef } from "react";

import { PriorityGlyph, StatusIcon } from "@/components/semantic";
import { isGoSequencePending, useScopeKeys } from "@/components/shell/use-hotkeys";
import { Button } from "@/components/ui/button";
import { dateColumn } from "@/lib/duration";
import { STATUS_MAP, type Priority, type StatusValue } from "@/lib/enum-map";
import { formatDate } from "@/lib/format";
import { focusedKeyApplies, focusedKeyGuards, keyEventShape, ownsArrows, rovingStep } from "@/lib/keymap";
import type { QueueGroup } from "@/lib/my-work-queue";
import { cn } from "@/lib/utils";
import { itemReturnTo } from "@/lib/work-view/item-surface";

import type { TimerPillState } from "../time/actions";
import { useTaskTimer } from "../time/use-task-timer";

/** One queue row after the page has resolved its state name — plain data, no Dates. */
export type QueueRow = {
  id: string;
  /** `ACME-12` — the key the row shows. */
  key: string;
  number: number;
  title: string;
  projectKey: string;
  projectName: string;
  stateCategory: string;
  stateName: string;
  priority: string;
  /** The due day as an ISO date, or null. */
  targetDate: string | null;
};

/**
 * The queue's rows (UI.md rule 8, §6 `home`): the grouped list with its
 * two row verbs — `J K` roving focus and `T` / a start-stop control for
 * the member's timer. The card around it, the empty state and the
 * truncation sentence stay in the server component (`my-work-queue.tsx`);
 * this is the part that needs a keyboard and the pill's timer facts.
 *
 * THE ROW'S FOCUS TARGET IS ITS LINK, not a `tabIndex=-1` row as on the
 * backlog. A backlog row holds four controls, so a focusable `<tr>` was
 * the only element that could stand for "the row"; a queue row is ONE
 * link and, for a member who tracks time, one button. Landing `J K` on
 * the link means Enter opens the task from wherever a `J` left the
 * member, and Tab from there reaches the row's button — a focusable
 * `<li>` would have added a stop that Enter can do nothing on.
 *
 * `T` is handled HERE, on the list, for the backlog's reason: only a
 * handler on the event target knows which row. It acts from anywhere in
 * the row (`closest("[data-item-id]")` — the link or the button), CLAIMS
 * the key even while a start is in flight (passed down, the global `T`
 * would stop the timer this row just started, or the one running
 * elsewhere), and is left to the global `T` only where this member can
 * start no timer (`timer === null`: no `time:track`, or the module is off
 * — the queue never lists an archived task or an archived project's).
 * The list has no inline delete question and no editor, so those two
 * places the backlog's `T` must reach do not exist here.
 *
 * THE BUTTON IS THE "ONE CLICK FROM HOME" the research pins (PLAN 2W): a
 * row is a link, and a link cannot hold a button, so it stands beside the
 * link in the `<li>`. It is the panel's control at row size — the same
 * `toggle`, the same Undo toast, the same staff notice on a first start —
 * and it flips to Stop while the member's timer runs on that task. The
 * glyph before the title says the same thing where the button is not the
 * eye's first stop, as the backlog row's does.
 */
export function QueueRows({
  groups,
  today,
  timer,
}: {
  groups: readonly { group: QueueGroup; rows: readonly QueueRow[] }[];
  /** The member's local date (UI.md §8) — the dates format relative to its year. */
  today: string;
  /**
   * The member's timer as the page read it (`getTimerStateAction`), or
   * `null` where this member can start no timer — REQUIRED (the standing
   * trap: state a shared component must reflect is never a default).
   */
  timer: TimerPillState | null;
}) {
  const t = useTranslations("home");
  const tPriority = useTranslations("states.priority");
  const tProjects = useTranslations("projects");
  const locale = useLocale();
  const listRef = useRef<HTMLDivElement>(null);
  const taskTimer = useTaskTimer(timer);
  const thisYear = today.slice(0, 4);

  // The rows in list order, across the groups: what `J K` steps through.
  const order = groups.flatMap(({ rows }) => rows.map((row) => row.id));
  const byId = new Map<string, QueueRow>();
  for (const { rows } of groups) for (const row of rows) byId.set(row.id, row);

  const linkOf = (id: string): HTMLElement | null =>
    listRef.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"] [data-queue-link]`) ?? null;
  const labelOf = (row: QueueRow) => tProjects("board.card.label", { key: row.key, title: row.title });

  const dueText = (group: QueueGroup, iso: string): string => {
    const day = dateColumn(iso);
    // A @db.Date is a calendar day: formatted in UTC, or it shifts west.
    if (group === "soon") return formatDate(locale, day, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
    return formatDate(locale, day, {
      day: "numeric",
      month: "short",
      ...(iso.slice(0, 4) === thisYear ? {} : { year: "numeric" }),
      timeZone: "UTC",
    });
  };

  // The registry's `J` is the ENTRY into the list (the backlog's rule):
  // it acts only when NO row holds focus — enforced here, not by trusting
  // the list handler to have `preventDefault`ed — and lands on the first
  // row whose link is already clear of its own scroll margin (which is
  // what clears the sticky header), so that `focus()` scrolls nothing. If
  // none qualifies (the list's end is under the header) the last row is
  // taken and the scroll is the honest outcome. Not a palette row: the
  // palette's "On this page" is for verbs.
  const enterList = () => {
    const list = listRef.current;
    if (!list) return;
    const active = document.activeElement;
    if (active instanceof Element && active.closest("[data-item-id]")) return;
    let fallback: HTMLElement | null = null;
    for (const el of list.querySelectorAll<HTMLElement>("[data-queue-link]")) {
      const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
      if (el.getBoundingClientRect().top >= margin) {
        el.focus();
        return;
      }
      fallback = el;
    }
    fallback?.focus();
  };
  useScopeKeys("home", [
    { key: "j", label: t("keys.navigate"), enabled: true, run: enterList, hint: ["J", "or", "K"], palette: false },
    // `T` on the focused row, the backlog's rule: `run: null`, handled on
    // the list, and it does not hide the global `T` in the overlay or the
    // palette — that one still acts whenever no row holds focus.
    { key: "t", label: t("keys.timer"), enabled: timer !== null, run: null },
  ]);

  // `J K` / `↑ ↓` and `T`. The row is the one the TARGET sits in, asked
  // of the DOM (`closest`).
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // The key FIRST, before any DOM walk.
    const step = rovingStep(e.key);
    const isT = e.key.toLowerCase() === "t";
    if ((step === undefined && !isT) || !(e.target instanceof Element)) return;
    const row = e.target.closest<HTMLElement>("[data-item-id]");
    const id = row?.dataset["itemId"];
    if (!row || !id) return;
    const shape = { ...keyEventShape(e), repeat: e.repeat };
    const goPending = isGoSequencePending();

    // ── `J K` / `↑ ↓`: roving focus ──
    if (step !== undefined) {
      // The arrows are left to a control that owns them, and to Shift,
      // which a list keeps for range selection.
      if (step.arrow && (e.shiftKey || ownsArrows(e.target))) return;
      // Auto-repeat ALLOWED: a move is one row per event whatever the
      // member holds, so a held `J` walks the list.
      if (!focusedKeyGuards(shape, goPending, { repeat: "allow" })) return;
      // The ends are the ends — nothing happens. A LETTER at the end is
      // still consumed: unprevented, it would reach the registry's `J`,
      // whose `run` enters the list at the first row on screen — a jump
      // to the top from the bottom. An arrow is left to the page, which
      // scrolls.
      const at = order.indexOf(id);
      const to = at < 0 ? undefined : order[at + step.delta];
      if (!to) {
        if (!step.arrow) e.preventDefault();
        return;
      }
      e.preventDefault();
      linkOf(to)?.focus();
      return;
    }

    // ── `T`: a timer on the focused row's task ──
    // A held `T` is refused (`focusedKeyApplies`); `G T` is the go-to.
    if (!timer || !focusedKeyApplies(shape, "t", goPending)) return;
    e.preventDefault();
    const item = byId.get(id);
    if (item) taskTimer.toggle(id, labelOf(item));
  };

  return (
    <>
      {/* A timer verb from a row is in flight too: the row's `T` and its
          button ignore a press until it has settled, and this tells
          assistive technology (and the e2e) so. No visible cue — the
          toast and the glyph follow. */}
      <div ref={listRef} onKeyDown={onKeyDown} aria-busy={taskTimer.busy || undefined}>
        {groups.map(({ group, rows }) => (
          <div
            key={group}
            data-testid="home-queue-group"
            data-group={group}
            className="border-b border-border last:border-b-0"
          >
            <h3
              className={cn(
                "eyebrow flex items-center gap-1.5 px-4 pt-3 pb-1",
                group === "overdue" ? "text-(--tone-danger-fg)" : "text-muted-foreground",
              )}
            >
              {t(`queueGroups.${group}`)}
              <span className="num">{rows.length}</span>
            </h3>
            <ul>
              {rows.map((row) => {
                const state = STATUS_MAP.stateCategory[row.stateCategory as StatusValue<"stateCategory">];
                const runningHere = taskTimer.runningItemId === row.id;
                return (
                  <li
                    key={row.id}
                    data-testid="home-queue-row"
                    data-item-id={row.id}
                    // The hover band is the ROW's — link and button as one —
                    // not the link's alone, which would stop short of the button.
                    className="flex items-center border-t border-border first:border-t-0 hover:bg-accent"
                  >
                    <Link
                      href={itemReturnTo("backlog-peek", row.projectKey, row.number)}
                      data-queue-link=""
                      // `J K` always; `T` where it acts. `scroll-mt-16` clears the
                      // sticky header when a step scrolls a row into view.
                      aria-keyshortcuts={timer ? "J K T" : "J K"}
                      className="flex min-h-10 min-w-0 flex-1 scroll-mt-16 scroll-mb-4 items-center gap-3 px-4 py-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                    >
                      {state ? (
                        <StatusIcon name={state.icon} aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                      ) : null}
                      {/* Below `sm` the title needs the room more than the key does — the
                          row still links by it, and the peek names it. */}
                      <span className="num-id hidden shrink-0 text-xs text-muted-foreground sm:inline sm:min-w-[10ch]">{row.key}</span>
                      {/* The member's OWN running timer (UI rule 14 — never a
                          colleague's): a glyph before the title, the backlog row's.
                          Its words come AFTER the title: this glyph is inside the
                          link's name, and a status read before the thing it is
                          about names the row wrong (review, slice 24). */}
                      {runningHere ? (
                        // `aria-hidden` on the SPAN, not only the icon: a titled
                        // element with no text is named by its `title`, which
                        // would put the words back before the title (fix review).
                        <span
                          data-testid="home-queue-row-timer"
                          aria-hidden="true"
                          className="inline-flex shrink-0 items-center text-(--tone-success-fg)"
                          title={t("queueTimer.running")}
                        >
                          <TimerIcon className="size-3.5" />
                        </span>
                      ) : null}
                      <span className="min-w-0 flex-1 truncate text-sm font-medium" title={row.title}>
                        {row.title}
                      </span>
                      {runningHere ? <span className="sr-only">{t("queueTimer.running")}</span> : null}
                      <span className="hidden w-36 shrink-0 truncate text-xs text-muted-foreground sm:block" title={row.projectName}>
                        {row.projectName}
                      </span>
                      <span className="hidden w-24 shrink-0 truncate text-xs text-muted-foreground md:block" title={row.stateName}>
                        {row.stateName}
                      </span>
                      {/* Below `md` the state is not drawn, and To do and In progress
                          share an icon — so it is still said. */}
                      <span className="sr-only md:hidden">{row.stateName}</span>
                      {/* A fixed slot, so the dates below line up whether or not a row has a priority. */}
                      <span className="inline-flex w-4 shrink-0 items-end justify-center">
                        {row.priority !== "NONE" ? (
                          <>
                            <PriorityGlyph value={row.priority as Priority} />
                            <span className="sr-only">
                              {t("queuePriority", { priority: tPriority(row.priority as Priority) })}
                            </span>
                          </>
                        ) : null}
                      </span>
                      {/* Today's group names its day in the heading; a date there would say it twice.
                          A fixed column from `sm` so dates align; on a phone it takes only what it holds. */}
                      <span
                        className={cn(
                          "shrink-0 text-right text-xs whitespace-nowrap tabular-nums sm:w-20",
                          group === "overdue" ? "text-(--tone-danger-fg)" : "text-muted-foreground",
                        )}
                      >
                        {row.targetDate && group !== "today" ? (
                          <time dateTime={row.targetDate}>{dueText(group, row.targetDate)}</time>
                        ) : null}
                      </span>
                    </Link>
                    {timer ? (
                      // Never `disabled` while busy: disabling the focused button
                      // drops focus to <body>, where every single key acts.
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className={cn("mr-2 shrink-0", runningHere ? "text-(--tone-success-fg)" : "text-muted-foreground")}
                        onClick={() => taskTimer.toggle(row.id, labelOf(row))}
                        aria-disabled={taskTimer.busy || undefined}
                        aria-keyshortcuts="T"
                        aria-label={runningHere ? t("queueTimer.stop", { task: row.title }) : t("queueTimer.start", { task: row.title })}
                        title={runningHere ? t("queueTimer.stop", { task: row.title }) : t("queueTimer.start", { task: row.title })}
                        data-testid={runningHere ? "home-queue-row-stop" : "home-queue-row-start"}
                      >
                        {runningHere ? <SquareIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      {taskTimer.notice}
    </>
  );
}
