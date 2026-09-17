"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { openStopConfirm } from "@/components/shell/stop-confirm";
import { syncTimerSnapshot } from "@/components/shell/timer-pill";

import { startTimerAction, stopTimerAction, undoStartAction, type TargetInput } from "./actions";

/**
 * Start and stop, with the toasts every surface that starts a timer owes
 * the member (UI.md rule 9): the quick start on /time and a task's own
 * timer control. One copy, because the undo is the part that must not
 * drift — starting another timer stops the running one in the SAME
 * transaction, and the toast is the only way back.
 *
 * `pending` covers the server action AND the re-read of the timer
 * (`syncTimerSnapshot`) — and deliberately NOT the page's refresh. A
 * transition around the whole thing stayed pending until the revalidated
 * page had re-rendered, measured at over two seconds on a task page, and
 * every `T` in that window was swallowed; once the timer store holds the
 * server's answer, the next press can safely act on it while the page
 * catches up. A surface that draws from its own server props rather than
 * the store (the quick start) passes `inTransition` — its own
 * `startTransition` — and EVERY verb, the undo included, then runs inside
 * it: a transition around the verb does last until the refresh lands.
 *
 * A second START or STOP while any verb is in flight is ignored, not
 * queued: it was decided against a picture the flight is about to change.
 * UNDO is never ignored. Its toast appears while the start's re-read is
 * still out, sonner removes a toast once its action is clicked, and a
 * dropped undo would take the only way back with it (found by review). It
 * needs no guard of its own: the server serialises every timer write under
 * the member's lock, and `undoStart` refuses anything but the entry this
 * start stopped. Each toast's Undo acts ONCE: sonner keeps the button
 * mounted for its exit animation, and a second keyboard press there would
 * send a second undo the server can only refuse.
 *
 * A failure is a toast, never a silent revert (the standing rule).
 */
export function useTimerCommands(
  options: {
    /** Run every verb inside the caller's own transition (`useTransition`'s start function). */
    inTransition?: (verb: () => Promise<void>) => void;
  } = {},
): {
  pending: boolean;
  /** `onStarted` runs only after the server said yes — the quick start clears its field there. */
  start: (target: TargetInput, onStarted?: () => void) => void;
  stop: () => void;
} {
  const t = useTranslations("time.timer");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  // How many verbs are out. A count, not a flag: an undo may overlap the
  // start whose toast offered it, and the first to finish must not clear
  // `pending` for the other.
  const flights = useRef(0);

  const fly = async (verb: () => Promise<void>) => {
    flights.current += 1;
    setPending(true);
    try {
      await verb();
    } finally {
      flights.current -= 1;
      if (flights.current === 0) setPending(false);
    }
  };
  const flyAlone = (verb: () => Promise<void>) => (flights.current > 0 ? Promise.resolve() : fly(verb));
  const launch = (flight: () => Promise<void>) => {
    if (options.inTransition) options.inTransition(flight);
    else void flight();
  };

  // After every answer, success or not: a refused start may have been
  // refused BECAUSE the client's picture was stale (a notice published
  // since, a timer stopped in another tab).
  const settle = async () => {
    await syncTimerSnapshot();
    router.refresh();
  };

  const undo = (startedId: string, resumeId: string) =>
    launch(() => fly(async () => {
      const u = await undoStartAction({ startedId, resumeId }).catch(() => ({ ok: false as const, message: t("failed") }));
      if (!u.ok) toast.error(u.message);
      else toast.success(u.message);
      await settle();
    }));

  const start = (target: TargetInput, onStarted?: () => void) =>
    launch(() => flyAlone(async () => {
      const r = await startTimerAction(target).catch(() => ({ ok: false as const, message: t("failed") }));
      if (!r.ok) {
        toast.error(r.message);
        await settle();
        return;
      }
      const { startedId, stoppedId, stoppedLabel } = r.value;
      if (stoppedId) {
        // The toast IS the undo affordance: the server accepts the undo for
        // UNDO_WINDOW_SECONDS (120 s); sonner's 4 s default vanished before a
        // slow refresh even showed the new timer. 30 s is the visible window.
        let undone = false;
        toast.success(t("startedStopped", { label: stoppedLabel ?? "" }), {
          duration: 30_000,
          action: {
            label: t("undo"),
            onClick: () => {
              if (undone) return;
              undone = true;
              undo(startedId, stoppedId);
            },
          },
        });
      } else {
        toast.success(t("started"));
      }
      onStarted?.();
      await settle();
    }));

  const stop = () =>
    launch(() => flyAlone(async () => {
      const r = await stopTimerAction().catch(() => ({ ok: false as const, message: t("failed") }));
      // Success is not a toast: the stop confirm shows what was saved.
      if (!r.ok) toast.error(r.message);
      else openStopConfirm(r.value);
      await settle();
    }));

  return { pending, start, stop };
}
