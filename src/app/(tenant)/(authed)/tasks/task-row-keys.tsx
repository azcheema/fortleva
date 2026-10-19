"use client";

import { TimerIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { createContext, useContext, useRef } from "react";

import { isGoSequencePending, useScopeKeys } from "@/components/shell/use-hotkeys";
import { focusedKeyApplies, focusedKeyGuards, keyEventShape, ownsArrows, rovingStep } from "@/lib/keymap";

import type { TimerPillState } from "../time/actions";
import { useTaskTimer } from "../time/use-task-timer";

/** The task the member's own timer runs on, for the rows' glyphs (rule 14 — never a colleague's). */
const RunningItem = createContext<string | null>(null);

/**
 * THE TASKS PAGE'S ROW VERBS (slice 137; UI.md §6 `tasks`): `J K` roving focus
 * between the rows and `T` starting or stopping the member's timer on the
 * focused row's task — Home's queue's rule (`home/queue-rows.tsx`), which
 * this follows line for line. The list itself stays a server component, passed
 * in as children; this is the part that needs a keyboard and the pill's facts.
 *
 * The row's focus target is its LINK (`[data-task-key]`), as on Home: a row is
 * one link, and Enter on it opens the task beside the list. `T` acts from the
 * focused row (`closest("[data-item-id]")`), claims the key even while a start
 * is in flight, and is left to the global `T` where this member can start no
 * timer (`timer === null`) — the list never holds an archived task or an
 * archived project's.
 *
 * The rows are read from the DOM the server drew — their order (`[data-item-id]`
 * in document order, across the groups), a row's key (`data-task-key`) and title
 * (`[data-task-title]`) for the staff notice — never passed again as a prop: the
 * list holds up to 500 rows, and every title would cross to the client twice.
 *
 * WHILE A TASK IS OPEN BESIDE THE LIST (`peekOpen`) neither key is this list's:
 * focus is in the sheet, whose panel carries its own `T`, and the registry's
 * `J` must not move focus to a row behind it — the backlog's rule.
 */
export function TaskRowKeys({
  timer,
  peekOpen,
  children,
}: {
  /**
   * The member's timer as the page read it (`getTimerStateAction`), or `null`
   * where they can start none — REQUIRED (state a shared component must
   * reflect is never a default).
   */
  timer: TimerPillState | null;
  /** Whether a task is open beside the list — REQUIRED, for the same reason. */
  peekOpen: boolean;
  children: React.ReactNode;
}) {
  const t = useTranslations("tasks");
  const tProjects = useTranslations("projects");
  const listRef = useRef<HTMLDivElement>(null);
  const taskTimer = useTaskTimer(timer);

  const linkIn = (row: Element): HTMLElement | null => row.querySelector<HTMLElement>("[data-task-key]");

  // The registry's `J` is the ENTRY into the list: it acts only when no row
  // holds focus, and lands on the first row clear of its own scroll margin
  // (what clears the sticky header), so that `focus()` scrolls nothing. Not a
  // palette row: the palette's "On this page" is for verbs.
  const enterList = () => {
    const list = listRef.current;
    if (!list) return;
    const active = document.activeElement;
    if (active instanceof Element && active.closest("[data-item-id]")) return;
    let fallback: HTMLElement | null = null;
    for (const el of list.querySelectorAll<HTMLElement>("[data-task-key]")) {
      const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
      if (el.getBoundingClientRect().top >= margin) {
        el.focus();
        return;
      }
      fallback = el;
    }
    fallback?.focus();
  };
  useScopeKeys("tasks", [
    { key: "j", label: t("keys.navigate"), enabled: !peekOpen, run: enterList, hint: ["J", "or", "K"], palette: false },
    // `T` on the focused row: `run: null`, handled on the list, and it does
    // not hide the global `T` — that one still acts whenever no row holds focus.
    { key: "t", label: t("keys.timer"), enabled: timer !== null && !peekOpen, run: null },
  ]);

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
      if (step.arrow && (e.shiftKey || ownsArrows(e.target))) return;
      if (!focusedKeyGuards(shape, goPending, { repeat: "allow" })) return;
      // The ends are the ends. A LETTER there is still consumed — it would
      // otherwise reach the registry's entry `J`, a jump to the top; an arrow
      // is left to the page, which scrolls.
      const order = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-item-id]") ?? [])];
      const at = order.indexOf(row);
      const to = at < 0 ? undefined : order[at + step.delta];
      if (!to) {
        if (!step.arrow) e.preventDefault();
        return;
      }
      e.preventDefault();
      linkIn(to)?.focus();
      return;
    }

    // ── `T`: a timer on the focused row's task ── (held `T` refused; `G T` is the go-to)
    if (!timer || !focusedKeyApplies(shape, "t", goPending)) return;
    e.preventDefault();
    const key = linkIn(row)?.dataset["taskKey"];
    const title = row.querySelector("[data-task-title]")?.textContent ?? "";
    if (key) taskTimer.toggle(id, tProjects("board.card.label", { key, title }));
  };

  return (
    <RunningItem.Provider value={taskTimer.runningItemId}>
      {/* A timer verb from a row is in flight too: the row's `T` ignores a
          press until it has settled, and this tells assistive technology (and
          the e2e) so. No visible cue — the toast and the glyph follow. */}
      <div ref={listRef} onKeyDown={onKeyDown} aria-busy={taskTimer.busy || undefined} data-testid="tasks-list">
        {children}
      </div>
      {taskTimer.notice}
    </RunningItem.Provider>
  );
}

/**
 * The glyph before a row's title while the member's timer runs on its task.
 * `aria-hidden` on the SPAN: a titled element with no text is named by its
 * `title`, which would put the words before the title — they come after it,
 * in `RowTimerWords` (Home's rule, slice 24's review).
 */
export function RowTimerGlyph({ itemId }: { itemId: string }) {
  const t = useTranslations("tasks");
  const running = useContext(RunningItem);
  if (running !== itemId) return null;
  return (
    <span
      data-testid="tasks-row-timer"
      aria-hidden="true"
      className="inline-flex shrink-0 items-center text-(--tone-success-fg)"
      title={t("timerRunning")}
    >
      <TimerIcon className="size-3.5" />
    </span>
  );
}

/** The glyph's words, said after the row's title. */
export function RowTimerWords({ itemId }: { itemId: string }) {
  const t = useTranslations("tasks");
  const running = useContext(RunningItem);
  if (running !== itemId) return null;
  return <span className="sr-only">{t("timerRunning")}</span>;
}
