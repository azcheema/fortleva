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

import { useScopeKeys } from "./use-hotkeys";

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
const serverTime = (s: Snapshot | null): number => (s?.state ? Date.parse(s.state.serverNow) : -Infinity);
/**
 * A server read, published only if it is NEWER than the one the store
 * holds. Reads arrive by different roads — the layout's snapshot, a page's
 * own (a peek opened by a client navigation re-renders the page, not the
 * layout), an awaited re-read — and the one taken later wins, whatever
 * order they land in: an older read over a newer one would show a verb for
 * a timer that is no longer running.
 */
const publishRead = (state: TimerPillState) => {
  if (Date.parse(state.serverNow) < serverTime(snapshot)) return;
  publish({ state, skew: Date.now() - Date.parse(state.serverNow), now: Date.now() });
};

const CLOCK_PREFIX = /^\d+:\d\d:\d\d · /;

/**
 * Re-read the member's timer and publish it to every reader, AWAITABLY —
 * unlike `notifyTimerChanged`, whose re-sync nobody can wait for. A
 * surface that has just started or stopped a timer awaits this before it
 * takes the next press, so its "is the running timer mine?" is the
 * server's answer and not the one from before its own action.
 */
export async function syncTimerSnapshot(): Promise<void> {
  const next = await getTimerStateAction().catch(() => null);
  if (next) publishRead(next);
}

/**
 * The pill's picture of the member's timer, for a surface that must agree
 * with it — a task's timer control asks "is the running timer MINE?".
 * `initial` is this surface's own server read (for the panel, the same
 * per-request `getCurrentTimerOnce` the layout's pill takes). Whichever of
 * it and the store is the LATER read is the answer — and a later `initial`
 * is published into the store, so the pill follows it too. From then on a
 * start or stop on any surface reaches every reader, and the elapsed
 * seconds tick with the pill's own 1 Hz clock rather than a second one.
 */
export function useTimerSnapshot(initial: TimerPillState): { state: TimerPillState; elapsed: number } {
  const serverSnapshot = useMemo<Snapshot>(
    () => ({ state: initial, skew: 0, now: Date.parse(initial.serverNow) }),
    [initial],
  );
  const snap = useSyncExternalStore(
    subscribe,
    () => (serverTime(snapshot) >= serverTime(serverSnapshot) ? snapshot! : serverSnapshot),
    () => serverSnapshot,
  );
  useEffect(() => {
    publishRead(initial);
  }, [initial]);
  const state = snap.state ?? initial;
  const elapsed = state.running ? secondsSince(state.running.startedAt, snap.now - snap.skew) : 0;
  return { state, elapsed };
}

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

  const sync = useCallback(() => syncTimerSnapshot(), []);

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
    publishRead(initial);
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

  // `T`: stop the running timer, else go to /time (UI.md §6).
  //
  // Registered, not listened for. The old window listener needed BOTH an
  // `isGoSequencePending()` check and a `defaultPrevented` check because
  // it re-registered on every start/stop and so kept changing places with
  // the shell's listener in the dispatch order; with one dispatcher the
  // `G` sequence is consulted once, ahead of every scope, and both guards
  // are gone. The key-owner election goes with them: two pill instances
  // both register, dispatch returns after the FIRST match, so `stop()`
  // still fires once. `owner.current` keeps its other jobs (the 1 Hz
  // tick, the sync) untouched.
  //
  // ABOVE the early return below — a hook may not sit under a conditional.
  useScopeKeys("global", [
    {
      key: "t",
      label: t("keyLabel"),
      enabled: snap.state !== null,
      run: () => {
        if (running) stop();
        else router.push("/time#quick-start");
      },
    },
  ]);

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
