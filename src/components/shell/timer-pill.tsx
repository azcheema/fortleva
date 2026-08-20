"use client";

import { SquareIcon, TimerIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { getTimerStateAction, stopTimerAction, type TimerPillState } from "@/app/(tenant)/(authed)/time/actions";
import { Button } from "@/components/ui/button";
import { formatDurationClock } from "@/lib/format";
import { cn } from "@/lib/utils";

import { isEditableTarget } from "./use-hotkeys";

/** Other surfaces dispatch this after they start/stop a timer so the pill re-syncs. */
export const TIMER_EVENT = "flv:timer";
export const notifyTimerChanged = (): void => {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(TIMER_EVENT));
};

/**
 * The persistent timer pill (UI.md §3.2, rule 9; PLAN.md 2T screens):
 * task title, elapsed time ticking once a second from the SERVER start
 * instant (skew-corrected: the server's "now" is compared with the
 * browser's at mount), mirrored into the tab title, one tap to stop.
 * `T` anywhere outside an input stops the running timer or jumps to
 * /time. The layout passes the server snapshot as the INITIAL state only
 * (the "prop carrying server state goes stale" trap): the pill re-reads
 * its state on focus/visibility and after every timer event.
 */
export function TimerPill({ initial, className }: { initial: TimerPillState | null; className?: string }) {
  const t = useTranslations("shell.timer");
  const locale = useLocale();
  const router = useRouter();
  const [state, setState] = useState<TimerPillState | null>(initial);
  const [now, setNow] = useState(() => Date.now());
  // Browser clock minus server clock, measured when a snapshot arrives.
  const [skew, setSkew] = useState(() => (initial ? Date.now() - Date.parse(initial.serverNow) : 0));
  const [pending, startTransition] = useTransition();
  const baseTitle = useRef<string | null>(null);

  const sync = useCallback(async () => {
    const next = await getTimerStateAction().catch(() => null);
    if (next) {
      setSkew(Date.now() - Date.parse(next.serverNow));
      setState(next);
    }
  }, []);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void sync();
    };
    window.addEventListener(TIMER_EVENT, sync);
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener(TIMER_EVENT, sync);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sync]);

  const running = state?.running ?? null;

  // 1 Hz tick, isolated to this component; the tab title follows.
  useEffect(() => {
    if (!running) {
      if (baseTitle.current !== null) {
        document.title = baseTitle.current;
        baseTitle.current = null;
      }
      return;
    }
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  const elapsed = running ? Math.max(0, Math.floor((now - skew - Date.parse(running.startedAt)) / 1000)) : 0;
  const clock = formatDurationClock(locale, elapsed);

  useEffect(() => {
    if (!running) return;
    if (baseTitle.current === null) baseTitle.current = document.title.replace(/^\d+:\d\d:\d\d · /, "");
    document.title = `${clock} · ${baseTitle.current}`;
  }, [clock, running]);

  const stop = useCallback(() => {
    startTransition(async () => {
      const r = await stopTimerAction().catch(() => ({ ok: false as const, message: t("stopFailed") }));
      if (!r.ok) toast.error(r.message);
      else toast.success(t("stopped", { duration: formatDurationClock(locale, r.value.durationSeconds) }));
      await sync();
      router.refresh();
    });
  }, [locale, router, sync, t]);

  // `T`: stop the running timer, else go to /time (UI.md §6).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target)) return;
      if (e.key.toLowerCase() !== "t") return;
      e.preventDefault();
      if (running) stop();
      else router.push("/time#quick-start");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running, router, stop]);

  if (!state) return null;

  if (!running) {
    return (
      <div data-slot="timer-pill" className={cn("flex items-center", className)}>
        <Button asChild variant="ghost" size="sm" className="gap-2 text-muted-foreground">
          <Link href="/time#quick-start" aria-label={t("startLabel")} data-testid="timer-pill-idle">
            <TimerIcon aria-hidden="true" />
            <span className="hidden lg:inline">{t("start")}</span>
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div
      data-slot="timer-pill"
      data-testid="timer-pill"
      className={cn(
        "flex max-w-[28rem] items-center gap-2 rounded-full border border-border bg-card py-0.5 pr-0.5 pl-3 text-sm",
        state.nudge && "border-(--tone-warning-border)",
        className,
      )}
    >
      <TimerIcon aria-hidden="true" className="size-4 shrink-0 text-(--tone-success-fg)" />
      <Link href="/time" className="min-w-0 truncate hover:underline" title={running.label}>
        {running.label}
      </Link>
      <span className="num shrink-0 tabular-nums" aria-live="off" data-testid="timer-pill-elapsed">
        {clock}
      </span>
      {state.nudge ? <span className="sr-only">{t("nudge")}</span> : null}
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={t("stop")}
        onClick={stop}
        disabled={pending}
        data-testid="timer-pill-stop"
      >
        <SquareIcon aria-hidden="true" className="size-3.5" />
      </Button>
    </div>
  );
}
