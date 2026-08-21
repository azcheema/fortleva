"use client";

import { PlayIcon, TimerIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect } from "react";

import { MetricTile, SectionCard } from "@/components/semantic";
import { TIMER_EVENT } from "@/components/shell/timer-pill";
import { useServerNow } from "@/components/shell/use-server-now";
import { Button } from "@/components/ui/button";
import { secondsSince } from "@/lib/duration";
import { formatDurationClock, formatDurationSeconds, type DurationStyle } from "@/lib/format";

export type HomeTimeStripProps = {
  /** Σ own finished seconds this week / today (the running entry is added live here). */
  weekSeconds: number;
  todaySeconds: number;
  /**
   * The running entry, if any: its server start instant, its local START
   * date — the date its seconds will land on when it stops (a midnight-
   * spanning row stays ONE row on its start date) — and its label.
   */
  running: { startedAt: string; localDate: string; label: string } | null;
  serverNow: string;
  /** The member's today and the grid week, as local ISO dates. */
  today: string;
  weekFrom: string;
  weekTo: string;
  durationStyle: DurationStyle;
  /** "Week 34 · 2026-08-17 – 2026-08-23", formatted by the page. */
  weekLabel: string;
};

/**
 * "Your time" on /home (UI.md rule 8: "timer slot, this-week hours —
 * own"): two numbers that change and the timer slot, in one card. The
 * finished seconds come from the server; a running timer's elapsed is
 * added LIVE and counted exactly where the stopped row will land — into
 * "today" iff it started today, into "this week" iff it started inside
 * the week — so the tiles never jump when the member presses Stop. Own
 * hours only — never a colleague's (the never-list).
 *
 * The card is static; only `LiveTiles` ticks. The page's snapshot can go
 * stale (a timer started or stopped in another tab, the 12 h auto-stop):
 * like the pill, the strip re-reads on a timer event and when the tab
 * becomes visible again — by refreshing the page's server data.
 */
export function HomeTimeStrip(props: HomeTimeStripProps) {
  const t = useTranslations("home.time");
  const router = useRouter();

  useEffect(() => {
    const refresh = () => router.refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener(TIMER_EVENT, refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener(TIMER_EVENT, refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router]);

  return (
    <SectionCard
      title={t("title")}
      description={props.weekLabel}
      actions={
        <Button asChild variant="outline" size="sm">
          <Link href="/time" data-testid="home-time-open">
            <TimerIcon aria-hidden="true" />
            {t("open")}
          </Link>
        </Button>
      }
    >
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
function LiveTiles({ weekSeconds, todaySeconds, running, serverNow, today, weekFrom, weekTo, durationStyle }: HomeTimeStripProps) {
  const t = useTranslations("home.time");
  const locale = useLocale();
  const nowSrv = useServerNow(serverNow, running !== null);

  const elapsed = running ? secondsSince(running.startedAt, nowSrv) : 0;
  const liveToday = running && running.localDate === today ? elapsed : 0;
  const liveWeek = running && running.localDate >= weekFrom && running.localDate <= weekTo ? elapsed : 0;
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
