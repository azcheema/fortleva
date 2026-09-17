"use client";

import { ShieldCheckIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { useTimerFacts } from "@/components/shell/timer-pill";
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

import { acknowledgeNoticeAction, staffNoticeAction, type TimerPillState } from "./actions";
import { NoticeBody } from "./notice-gate";
import { useTimerCommands } from "./use-timer-commands";

type Notice = { id: string; version: number; title: string; body: string };

/**
 * A timer on a TASK, from whichever surface names the task (UI.md §5.4
 * "Timer", §6 `T`): the item panel's control names its own task; the board
 * and the backlog name the card or row that holds focus. ONE copy of the
 * start-or-stop decision and of the staff notice, so the surfaces cannot
 * drift on either.
 *
 * `toggle(itemId)` stops the member's timer when it runs on that task, and
 * otherwise starts one there — through `useTimerCommands`, so starting
 * while another timer runs stops that one in the same transaction and the
 * toast offers Undo. A press while a start, a stop or the notice's own
 * round trip is in flight is IGNORED (`busy`): it was decided against a
 * picture the flight is about to change.
 *
 * Whether the timer runs on a task is the PILL's answer (`useTimerFacts`),
 * never a second read, and it changes only when a timer starts or stops —
 * so a board of two hundred cards does not re-render on the pill's tick.
 *
 * THE STAFF NOTICE COMES WITH THE START (SECURITY.md §9.7.5). The service
 * refuses every unacknowledged start whichever surface asks
 * (`assertNoticeAcknowledged`). A member who has not acknowledged the
 * current version is shown it in `notice` — a dialog the caller renders —
 * and the start follows their acknowledgment, on the task they pressed
 * for. The text is fetched on the press, never carried on every render.
 *
 * `initial` is the surface's own server read (`loadPanelTimer`), and `null`
 * where this member can start no timer: then nothing is running here and
 * `toggle` does nothing. The caller claims no key there — the panel renders
 * no control, the board and the backlog register their `T` row disabled
 * and leave the key to the global `T`.
 *
 * `label` names the task in the notice ("KEY-12: title"). The panel has no
 * need of it — its task is on screen — but a notice opened from a card or a
 * row covers the list, and the start goes to the task pressed for even if
 * focus has moved on since, so the dialog says which task that is.
 */
export function useTaskTimer(initial: TimerPillState | null): {
  runningItemId: string | null;
  busy: boolean;
  toggle: (itemId: string, label?: string) => void;
  notice: ReactNode;
} {
  const t = useTranslations("projects.item");
  const tNotice = useTranslations("time.notice");
  const tCommon = useTranslations("common");
  const { runningItemId, noticeRequired } = useTimerFacts(initial);
  const { pending, start, stop } = useTimerCommands();
  // The notice's own round trips (fetch, acknowledge) — plain state, not a
  // transition, for `useTimerCommands`' reason: a transition around an
  // action that revalidates stays pending until the whole page re-renders.
  const [noticePending, setNoticePending] = useState(false);
  // The last notice fetched stays in state after close, so the dialog
  // keeps its content through Radix's exit animation; `open` is the switch.
  // `itemId` is the task the member pressed for: the start that follows
  // the acknowledgment goes THERE, whatever holds focus by then.
  const [notice, setNotice] = useState<(Notice & { itemId: string; label: string | null }) | null>(null);
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
  // A notice fetch that lands after the surface unmounted must neither open
  // a dialog nor start a timer the member can no longer see being started.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const focusReturn = useFocusReturn();

  const busy = pending || noticePending;

  const openNotice = async (itemId: string, label: string | null) => {
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
    if (r.value === null) start({ workItemId: itemId });
    else {
      setNotice({ ...r.value, itemId, label });
      setOpen(true);
    }
  };

  const toggle = (itemId: string, label?: string) => {
    if (initial === null || busy) return;
    if (runningItemId === itemId) stop();
    else if (noticeRequired) void openNotice(itemId, label ?? null);
    else start({ workItemId: itemId });
  };

  const acknowledgeAndStart = async (id: string, itemId: string) => {
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
    start({ workItemId: itemId });
  };

  // While the notice is open it owns the keyboard: its DialogContent is
  // not a suppressing layer (the peek is a dialog too), so without this a
  // `p` would open the priority picker behind it. `exclusive` FOLLOWS
  // `open` — an exclusive scope stops the walk whether or not it binds
  // anything (the standing trap).
  useScopeKeys("modal", [], { exclusive: open });

  const dialog = (
    <Dialog open={open} onOpenChange={setOpen}>
      {notice ? (
        // A flex column capped at the viewport, so on a short screen (a
        // phone on its side) the text scrolls and the title and the
        // buttons stay on screen: the scroll lock behind a modal leaves
        // nothing else that could scroll them into view.
        <DialogContent className="flex max-h-svh flex-col sm:max-w-lg" data-testid="item-timer-notice" {...focusReturn}>
          <DialogHeader>
            <DialogTitle>{notice.title}</DialogTitle>
            <DialogDescription>
              {tNotice("description", { version: notice.version })}
              {notice.label ? <span className="mt-1 block text-foreground">{t("timer.noticeFor", { task: notice.label })}</span> : null}
            </DialogDescription>
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
                if (!busy) void acknowledgeAndStart(notice.id, notice.itemId);
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
  );

  return { runningItemId, busy, toggle, notice: dialog };
}
