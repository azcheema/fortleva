"use client";

import { SquareIcon, TimerIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";

import { getTimerStateAction, stopTimerAction, type TimerPillState } from "@/app/(tenant)/(authed)/time/actions";
import { Button } from "@/components/ui/button";
import { secondsSince } from "@/lib/duration";
import { formatDurationClock } from "@/lib/format";
import { cn } from "@/lib/utils";

import { isEditableTarget, isGoSequencePending } from "./use-hotkeys";

/** Other surfaces dispatch this after they start/stop a timer so the pill re-syncs. */
export const TIMER_EVENT = "flv:timer";
export const notifyTimerChanged = (): void => {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(TIMER_EVENT));
};

/**
 * "Something about the timer may have changed": a timer event from another
 * surface, the window regaining focus, the tab becoming visible. The pill
 * re-syncs its snapshot on these; the home strip refreshes its server data
 * — one subscription, one list of triggers. `enabled` lets the pill's
 * second mount stay quiet (only the owner syncs).
 */
export function useTimerEvents(onChange: (e: Event) => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onVisible = (e: Event) => {
      if (document.visibilityState === "visible") onChange(e);
    };
    window.addEventListener(TIMER_EVENT, onChange);
    window.addEventListener("focus", onChange);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener(TIMER_EVENT, onChange);
      window.removeEventListener("focus", onChange);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [onChange, enabled]);
}

/**
 * One timer, two mount points. The shell renders the pill in the desktop
 * header AND in the mobile strip (CSS shows one); both instances read
 * this module store, and only the FIRST mounted instance (the owner)
 * runs the 1 Hz tick, the focus/visibility/event re-sync, the `T` hotkey
 * and the tab-title clock — the review found two instances each syncing
 * twice per event and the hotkey stopping the timer twice ("No timer is
 * running" toast after every `T`).
 */
type Snapshot = {
  state: TimerPillState | null;
  /** Browser clock minus server clock, measured when a snapshot arrives. */
  skew: number;
  /** Browser "now" the elapsed time is computed from (ticks once a second). */
  now: number;
};

let snapshot: Snapshot | null = null;
let mounted = 0;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const publish = (next: Snapshot) => {
  snapshot = next;
  for (const l of listeners) l();
};

const CLOCK_PREFIX = /^\d+:\d\d:\d\d · /;

/**
 * The persistent timer pill (UI.md §3.2, rule 9; PLAN.md 2T screens):
 * task title, elapsed time ticking once a second from the SERVER start
 * instant (skew-corrected), mirrored into the tab title, one tap to stop.
 * `T` anywhere outside an input stops the running timer or jumps to
 * /time — unless a `G` go-to sequence is armed. The layout passes the
 * server snapshot as the INITIAL state only (the "prop carrying server
 * state goes stale" trap): the pill re-reads its state on focus /
 * visibility and after every timer event.
 */
export function TimerPill({ initial, className }: { initial: TimerPillState | null; className?: string }) {
  const t = useTranslations("shell.timer");
  const locale = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const owner = useRef(false);
  const baseTitle = useRef<string | null>(null);

  // Server and first client render agree: elapsed AT the server's "now".
  const serverSnapshot = useMemo<Snapshot>(
    () => ({ state: initial, skew: 0, now: initial ? Date.parse(initial.serverNow) : 0 }),
    [initial],
  );
  const snap = useSyncExternalStore(
    subscribe,
    () => snapshot ?? serverSnapshot,
    () => serverSnapshot,
  );

  const sync = useCallback(async () => {
    const next = await getTimerStateAction().catch(() => null);
    if (next) publish({ state: next, skew: Date.now() - Date.parse(next.serverNow), now: Date.now() });
  }, []);

  // Ownership: the first mounted instance owns the side effects. Declared
  // first so the effects below (same commit) see the flag; mount-only, so
  // a layout refresh never re-elects.
  useEffect(() => {
    mounted += 1;
    owner.current = mounted === 1;
    return () => {
      mounted -= 1;
      if (mounted === 0) snapshot = null;
      owner.current = false;
    };
  }, []);

  // A fresh server snapshot (first mount, or the layout re-rendered after
  // a refresh) is authoritative: the owner publishes it for both instances.
  useEffect(() => {
    if (!owner.current || !initial) return;
    publish({ state: initial, skew: Date.now() - Date.parse(initial.serverNow), now: Date.now() });
  }, [initial]);

  // Re-sync on every "the timer may have changed" trigger — owner only (the ref is read in the handler, never in render).
  const onTimerEvent = useCallback(() => {
    if (owner.current) void sync();
  }, [sync]);
  useTimerEvents(onTimerEvent);

  const running = snap.state?.running ?? null;

  // 1 Hz tick (owner only); the tab title follows and is restored on stop.
  useEffect(() => {
    if (!owner.current) return;
    if (!running) {
      if (baseTitle.current !== null) {
        document.title = baseTitle.current;
        baseTitle.current = null;
      }
      return;
    }
    const id = window.setInterval(() => {
      if (snapshot) publish({ ...snapshot, now: Date.now() });
    }, 1000);
    return () => window.clearInterval(id);
  }, [running]);

  const elapsed = running ? secondsSince(running.startedAt, snap.now - snap.skew) : 0;
  const clock = formatDurationClock(locale, elapsed);

  useEffect(() => {
    if (!owner.current || !running) return;
    // A client-side navigation replaced the title underneath us: re-read
    // it whenever it no longer starts with our clock, so the tab never
    // sticks on the page where the timer was first seen.
    const current = document.title;
    if (!CLOCK_PREFIX.test(current)) baseTitle.current = current;
    if (baseTitle.current !== null) document.title = `${clock} · ${baseTitle.current}`;
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

  // `T`: stop the running timer, else go to /time (UI.md §6) — owner only,
  // and never as the second key of `G T` (the shell's go-to).
  useEffect(() => {
    if (!owner.current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target)) return;
      if (e.key.toLowerCase() !== "t") return;
      // `G T` must never reach here: when this listener runs FIRST the
      // sequence is still armed (isGoSequencePending); when it runs after
      // the shell (the effect re-registers on every running change) the
      // shell has already consumed the key and prevented its default.
      if (e.defaultPrevented || isGoSequencePending()) return;
      e.preventDefault();
      if (running) stop();
      else router.push("/time#quick-start");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running, router, stop]);

  if (!snap.state) return null;

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
        "flex max-w-md items-center gap-2 rounded-full border border-border bg-card py-0.5 pr-0.5 pl-3 text-sm",
        snap.state.nudge && "border-(--tone-warning-border)",
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
      {snap.state.nudge ? <span className="sr-only">{t("nudge")}</span> : null}
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
