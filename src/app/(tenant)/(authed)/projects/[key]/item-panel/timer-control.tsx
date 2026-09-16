"use client";

import { PlayIcon, ShieldCheckIcon, SquareIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useTimerSnapshot } from "@/components/shell/timer-pill";
import { useScopeKeys } from "@/components/shell/use-hotkeys";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFocusReturn } from "@/components/ui/use-focus-return";
import { formatDurationClock } from "@/lib/format";

import { acknowledgeNoticeAction, staffNoticeAction, type TimerPillState } from "../../../time/actions";
import { NoticeBody } from "../../../time/notice-gate";
import { useTimerCommands } from "../../../time/use-timer-commands";

type Notice = { id: string; version: number; title: string; body: string };

/**
 * `T` on a task (UI.md §5.2, §6): start a timer on THIS task, or stop it
 * when the running timer is this task's. Starting while another timer
 * runs stops that one in the same transaction, and the toast offers undo
 * — the quick start's contract, through the same `useTimerCommands`.
 *
 * Whether the running timer is this task's is the PILL's answer
 * (`useTimerSnapshot`), not a second read: the pill re-syncs on every
 * timer event, focus and visibility, so a stop in the pill or on /time
 * turns this button back into Start without a refresh.
 *
 * THE STAFF NOTICE COMES WITH THE START (SECURITY.md §9.7.5). The service
 * refuses every unacknowledged start whichever surface asks
 * (`assertNoticeAcknowledged`); until this control, /time was the only
 * surface that could start one, and so the only one that showed the
 * notice. A member who has not acknowledged the current version is shown
 * it HERE, in a dialog, and the start follows their acknowledgment — the
 * text is fetched when they press Start, never carried on every panel.
 *
 * Rendered only for a member who may track time, on a task that can take
 * an entry (not archived, in a project that is not) — the panel decides.
 */
export function TimerControl({ itemId, initial }: { itemId: string; initial: TimerPillState }) {
  const t = useTranslations("projects.item");
  const tNotice = useTranslations("time.notice");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const { state, elapsed } = useTimerSnapshot(initial);
  const { pending, start, stop } = useTimerCommands();
  // The notice's own round trips (fetch, acknowledge) — plain state, not a
  // transition, for `useTimerCommands`' reason: a transition around an
  // action that revalidates stays pending until the whole page re-renders.
  const [noticePending, setNoticePending] = useState(false);
  // The last notice fetched stays in state after close, so the dialog
  // keeps its content through Radix's exit animation; `open` is the switch.
  const [notice, setNotice] = useState<Notice | null>(null);
  const [open, setOpenState] = useState(false);
  // Mirrors `open` for the acknowledgment's continuation: a member who
  // pressed "start the timer" and then Cancel (or Escape, or the scrim)
  // before the round trip landed has changed their mind — the notice is
  // still acknowledged, but no timer starts.
  const openRef = useRef(false);
  const setOpen = (next: boolean) => {
    openRef.current = next;
    setOpenState(next);
  };
  // A notice fetch that lands after the panel closed must neither open a
  // dialog nor start a timer the member can no longer see being started.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const focusReturn = useFocusReturn();

  const runningHere = state.running !== null && state.running.workItemId === itemId;
  const busy = pending || noticePending;

  const startHere = () => start({ workItemId: itemId });

  const openNotice = async () => {
    setNoticePending(true);
    const r = await staffNoticeAction().catch(() => ({ ok: false as const, message: t("timer.noticeFailed") }));
    setNoticePending(false);
    if (!alive.current) return;
    if (!r.ok) {
      toast.error(r.message);
      return;
    }
    // Acknowledged since the pill last looked (another tab, /time): no
    // notice to show, so the press means what it says.
    if (r.value === null) startHere();
    else {
      setNotice(r.value);
      setOpen(true);
    }
  };

  const toggle = () => {
    if (busy) return;
    if (runningHere) stop();
    else if (state.noticeRequired) void openNotice();
    else startHere();
  };

  const acknowledgeAndStart = async (id: string) => {
    setNoticePending(true);
    const r = await acknowledgeNoticeAction(id).catch(() => ({ ok: false as const, message: tNotice("failed") }));
    setNoticePending(false);
    if (!r.ok) {
      toast.error(r.message);
      return;
    }
    if (!alive.current || !openRef.current) return;
    // No acknowledgment toast: the start's own toast follows at once,
    // and two in a row would bury the one that carries undo.
    setOpen(false);
    startHere();
  };

  // Above any conditional (hook rule). The item scope shadows the global
  // `T` (stop the running timer, else go to /time) while a task is open —
  // the `enabled` mechanism `KeyBinding` names for exactly this. While a
  // start or stop is in flight the key is SWALLOWED, not passed down to
  // the global binding, so a quick double `T` cannot stop what it started.
  // A HELD `T` is refused outright (the ⌘⇧O and `X` rule): an auto-repeat
  // that outlived the round trip would flip the timer back. A palette row
  // runs with a synthetic event, whose `repeat` is false.
  useScopeKeys("item", [
    {
      key: "t",
      label: runningHere ? t("keys.stopTimer") : t("keys.startTimer"),
      enabled: !busy,
      run: (e) => {
        if (!e.repeat) toggle();
      },
    },
  ]);
  // While the notice is open it owns the keyboard: its DialogContent is
  // not a suppressing layer (the peek is a dialog too), so without this a
  // `p` would open the priority picker behind it. `exclusive` FOLLOWS
  // `open` — an exclusive scope stops the walk whether or not it binds
  // anything (the standing trap).
  useScopeKeys("modal", [], { exclusive: open });

  return (
    <>
      <div className="flex items-center gap-2" data-testid="item-timer">
        {/* Never `disabled` while busy: disabling the focused button drops
            focus to <body>, where every single key acts behind the peek. */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={toggle}
          aria-disabled={busy || undefined}
          aria-keyshortcuts="T"
          data-testid={runningHere ? "item-timer-stop" : "item-timer-start"}
        >
          {runningHere ? <SquareIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
          {runningHere ? t("timer.stop") : t("timer.start")}
        </Button>
        {runningHere ? (
          <span className="num text-sm text-muted-foreground tabular-nums" aria-live="off" data-testid="item-timer-elapsed">
            {formatDurationClock(locale, elapsed)}
          </span>
        ) : null}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        {notice ? (
          // A flex column capped at the viewport, so on a short screen (a
          // phone on its side) the text scrolls and the title and the
          // buttons stay on screen: the scroll lock behind a modal leaves
          // nothing else that could scroll them into view.
          <DialogContent className="flex max-h-svh flex-col sm:max-w-lg" data-testid="item-timer-notice" {...focusReturn}>
            <DialogHeader>
              <DialogTitle>{notice.title}</DialogTitle>
              <DialogDescription>{tNotice("description", { version: notice.version })}</DialogDescription>
            </DialogHeader>
            {/* A long text in a bounded box: the region is focusable so a
                keyboard can scroll it, and it is the dialog's first stop. */}
            <div
              role="region"
              tabIndex={0}
              aria-label={notice.title}
              className="max-h-96 min-h-0 overflow-y-auto rounded-md focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            >
              <NoticeBody body={notice.body} />
              <p className="mt-4 text-xs text-muted-foreground">{tNotice("footnote")}</p>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  {tCommon("cancel")}
                </Button>
              </DialogClose>
              <Button
                type="button"
                onClick={() => {
                  if (!busy) void acknowledgeAndStart(notice.id);
                }}
                aria-disabled={busy || undefined}
                data-testid="item-timer-notice-acknowledge"
              >
                <ShieldCheckIcon aria-hidden="true" />
                {t("timer.acknowledgeAndStart")}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}
