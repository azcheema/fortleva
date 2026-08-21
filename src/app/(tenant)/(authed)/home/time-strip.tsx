"use client";

import { PlayIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef } from "react";

import { MetricTile, SectionCard } from "@/components/semantic";
import { TIMER_EVENT, useTimerEvents } from "@/components/shell/timer-pill";
import { useServerNow } from "@/components/shell/use-server-now";
import { Button } from "@/components/ui/button";
import { secondsSince } from "@/lib/duration";
import { formatDurationClock, formatDurationSeconds, type DurationStyle } from "@/lib/format";

export type HomeTimeStripProps = {
  /** Σ own finished seconds this week / today (the running entry is added live here). */
  weekSeconds: number;
  todaySeconds: number;
  /**
   * The running entry, if any: its server start instant, its label, and
   * where its seconds will land when it stops — decided on the server by
   * the row's START local date (a midnight-spanning row stays ONE row on
   * its start date), so the live number goes exactly where the stopped
   * row will.
   */
  running: { startedAt: string; label: string; countsToday: boolean; countsThisWeek: boolean } | null;
  serverNow: string;
  durationStyle: DurationStyle;
  /** "Week 34 · 2026-08-17 – 2026-08-23", formatted by the page. */
  weekLabel: string;
};

/** A tab that was away shorter than this is not stale enough to re-render the landing page for. */
const STALE_AFTER_MS = 60_000;

/**
 * "Your time" on /home (UI.md rule 8: "timer slot, this-week hours —
 * own"): two numbers that change and the timer slot, in one card. The
 * finished seconds come from the server; a running timer's elapsed is
 * added LIVE and counted where the stopped row will land, so the tiles
 * never jump when the member presses Stop. Own hours only — never a
 * colleague's (the never-list). No header verb: the rail item and both
 * tiles already lead to /time.
 *
 * The card is static; only `LiveTiles` ticks. The page's snapshot can go
 * stale (a timer started or stopped in another tab, the 12 h auto-stop):
 * the strip shares the pill's triggers (`useTimerEvents`) and refreshes
 * the page's server data — on a timer event at once, on a tab return
 * only after a real absence, so alt-tabbing does not re-render /home.
 */
export function HomeTimeStrip(props: HomeTimeStripProps) {
  const t = useTranslations("home.time");
  const router = useRouter();
  const awaySince = useRef<number | null>(null);

  // Remember when the tab went away; the return side is the shared trigger below.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") awaySince.current = Date.now();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);

  const onTimerEvent = useCallback(
    (e: Event) => {
      if (e.type === TIMER_EVENT) {
        router.refresh();
        return;
      }
      const since = awaySince.current;
      awaySince.current = null;
      if (since !== null && Date.now() - since > STALE_AFTER_MS) router.refresh();
    },
    [router],
  );
  useTimerEvents(onTimerEvent);

  return (
    <SectionCard title={t("title")} description={props.weekLabel}>
      <LiveTiles {...props} />
      {props.running ? (
        <p className="mt-3 truncate text-xs text-muted-foreground" title={props.running.label}>
          {t("runningLabel", { label: props.running.label })}
        </p>
      ) : null}
    </SectionCard>
  );
}

/** The three tiles — the only part that re-renders once a second while a timer runs. */
function LiveTiles({ weekSeconds, todaySeconds, running, serverNow, durationStyle }: HomeTimeStripProps) {
  const t = useTranslations("home.time");
  const locale = useLocale();
  const nowSrv = useServerNow(serverNow, running !== null);

  const elapsed = running ? secondsSince(running.startedAt, nowSrv) : 0;
  const liveToday = running?.countsToday ? elapsed : 0;
  const liveWeek = running?.countsThisWeek ? elapsed : 0;
  const fmt = (seconds: number) => formatDurationSeconds(locale, seconds, durationStyle);

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3" data-testid="home-time-strip">
      <MetricTile label={t("week")} value={<span data-testid="home-time-week">{fmt(weekSeconds + liveWeek)}</span>} href="/time" />
      <MetricTile label={t("today")} value={<span data-testid="home-time-today">{fmt(todaySeconds + liveToday)}</span>} href="/time" />
      {running ? (
        <MetricTile
          label={t("running")}
          value={<span data-testid="home-time-running">{formatDurationClock(locale, elapsed)}</span>}
          href="/time"
          className="col-span-2 md:col-span-1"
        />
      ) : (
        // The same tile, as a ghost: one class of difference (dashed, no fill), the value slot holds the verb.
        <MetricTile
          label={t("timer")}
          value={
            <Button asChild variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
              <Link href="/time#quick-start" data-testid="home-time-start">
                <PlayIcon aria-hidden="true" />
                {t("start")}
              </Link>
            </Button>
          }
          className="col-span-2 border-dashed bg-transparent md:col-span-1"
        />
      )}
    </div>
  );
}
