"use client";

import { PlayIcon, SquareIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { useTimerSnapshot } from "@/components/shell/timer-pill";
import { useScopeKeys } from "@/components/shell/use-hotkeys";
import { Button } from "@/components/ui/button";
import { formatDurationClock } from "@/lib/format";

import type { TimerPillState } from "../../../time/actions";
import { useTaskTimer } from "../../../time/use-task-timer";

/**
 * `T` on a task (UI.md §5.2, §6): start a timer on THIS task, or stop it
 * when the running timer is this task's. The decision, the undo toast and
 * the staff notice on a first start are `useTaskTimer`'s — the same hook
 * the board and the backlog run for the card or row that holds focus.
 *
 * Whether the running timer is this task's is the PILL's answer, not a
 * second read: the pill re-syncs on every timer event, focus and
 * visibility, so a stop in the pill or on /time turns this button back
 * into Start without a refresh.
 *
 * Rendered only for a member who may track time, on a task that can take
 * an entry (not archived, in a project that is not) — the panel decides.
 */
export function TimerControl({ itemId, initial }: { itemId: string; initial: TimerPillState }) {
  const t = useTranslations("projects.item");
  const { runningItemId, busy, toggle, notice } = useTaskTimer(initial);
  const runningHere = runningItemId === itemId;

  // The item scope shadows the global `T` (stop the running timer, else go
  // to /time) while a task is open — the `enabled` mechanism `KeyBinding`
  // names for exactly this. While a start or stop is in flight the key is
  // SWALLOWED, not passed down to the global binding, so a quick double
  // `T` cannot stop what it started. A HELD `T` is refused outright (the
  // ⌘⇧O and `X` rule): an auto-repeat that outlived the round trip would
  // flip the timer back. A palette row runs with a synthetic event, whose
  // `repeat` is false.
  useScopeKeys("item", [
    {
      key: "t",
      label: runningHere ? t("keys.stopTimer") : t("keys.startTimer"),
      enabled: !busy,
      run: (e) => {
        if (!e.repeat) toggle(itemId);
      },
    },
  ]);

  return (
    <>
      <div className="flex items-center gap-2" data-testid="item-timer">
        {/* Never `disabled` while busy: disabling the focused button drops
            focus to <body>, where every single key acts behind the peek. */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => toggle(itemId)}
          aria-disabled={busy || undefined}
          aria-keyshortcuts="T"
          data-testid={runningHere ? "item-timer-stop" : "item-timer-start"}
        >
          {runningHere ? <SquareIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
          {runningHere ? t("timer.stop") : t("timer.start")}
        </Button>
        {runningHere ? <TimerElapsed initial={initial} data-testid="item-timer-elapsed" /> : null}
      </div>
      {notice}
    </>
  );
}

/**
 * The running timer's elapsed clock, ticking with the pill's own 1 Hz
 * clock. A leaf of its own: `useTimerSnapshot` re-renders its reader every
 * second, and that reader should be this span, not the surface around it.
 */
export function TimerElapsed({
  initial,
  className,
  "data-testid": testId,
}: {
  initial: TimerPillState;
  className?: string;
  "data-testid"?: string;
}) {
  const locale = useLocale();
  const { elapsed } = useTimerSnapshot(initial);
  return (
    <span className={className ?? "num text-sm text-muted-foreground tabular-nums"} aria-live="off" data-testid={testId}>
      {formatDurationClock(locale, elapsed)}
    </span>
  );
}
