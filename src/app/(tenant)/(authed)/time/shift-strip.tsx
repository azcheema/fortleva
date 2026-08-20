"use client";

import { CoffeeIcon, LogInIcon, LogOutIcon, PlayIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { MetricTile, SectionCard } from "@/components/semantic";
import { notifyTimerChanged } from "@/components/shell/timer-pill";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDuration, type DurationStyle } from "@/lib/format";

import { clockInAction, clockOutAction, confirmShiftAction, startBreakAction, stopBreakAction } from "./actions";

export type ShiftStripShift = {
  id: string;
  startedAt: string;
  stoppedAt: string | null;
  workedSeconds: number | null;
  needsReview: boolean;
  breaks: { id: string; startedAt: string; stoppedAt: string | null }[];
};

/**
 * The day reconciliation strip (D1; UI.md §3.1 /time): clock in/out and
 * breaks, and today's arithmetic — shift − breaks − tracked = unallocated.
 * Everything here is the member's OWN day (never a colleague's: the
 * never-list). An auto-closed shift is visibly provisional until the
 * member confirms it. Live values tick from the server instants with the
 * same skew correction the pill uses.
 */
export function ShiftStrip({
  shiftsToday,
  openShift,
  trackedTodaySeconds,
  runningStartedAt,
  serverNow,
  durationStyle,
}: {
  /** Closed shifts that started today (own). */
  shiftsToday: ShiftStripShift[];
  /** The member's open shift, if any (may have started yesterday). */
  openShift: ShiftStripShift | null;
  /** Σ finished entries today (own). */
  trackedTodaySeconds: number;
  /** The running entry's start, if any. */
  runningStartedAt: string | null;
  serverNow: string;
  durationStyle: DurationStyle;
}) {
  const t = useTranslations("time.shift");
  const locale = useLocale();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [now, setNow] = useState(() => Date.now());
  const [skew] = useState(() => Date.now() - Date.parse(serverNow));
  const live = openShift !== null || runningStartedAt !== null;

  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live]);

  const at = (iso: string) => Date.parse(iso);
  const nowSrv = now - skew;
  const sec = (ms: number) => Math.max(0, Math.floor(ms / 1000));

  const closedSpan = shiftsToday.reduce((s, sh) => s + sec(at(sh.stoppedAt ?? sh.startedAt) - at(sh.startedAt)), 0);
  const closedBreaks = shiftsToday.reduce(
    (s, sh) => s + sh.breaks.reduce((b, br) => b + sec(at(br.stoppedAt ?? sh.stoppedAt ?? sh.startedAt) - at(br.startedAt)), 0),
    0,
  );
  const openSpan = openShift ? sec(nowSrv - at(openShift.startedAt)) : 0;
  const openBreaks = openShift ? openShift.breaks.reduce((b, br) => b + sec((br.stoppedAt ? at(br.stoppedAt) : nowSrv) - at(br.startedAt)), 0) : 0;
  const onBreak = openShift?.breaks.some((b) => b.stoppedAt === null) ?? false;
  const runningSeconds = runningStartedAt ? sec(nowSrv - at(runningStartedAt)) : 0;

  const shiftSeconds = closedSpan + openSpan;
  const breakSeconds = closedBreaks + openBreaks;
  const trackedSeconds = trackedTodaySeconds + runningSeconds;
  const unallocated = shiftSeconds - breakSeconds - trackedSeconds;
  const fmt = (seconds: number) => formatDuration(locale, seconds / 60, durationStyle);

  const run = (fn: () => Promise<{ ok: boolean; message: string }>, after?: () => void) =>
    start(async () => {
      const r = await fn().catch(() => ({ ok: false, message: t("failed") }));
      if (!r.ok) toast.error(r.message);
      else {
        toast.success(r.message);
        after?.();
      }
      notifyTimerChanged();
      router.refresh();
    });

  const provisional = [...shiftsToday, ...(openShift ? [openShift] : [])].filter((s) => s.needsReview);

  return (
    <SectionCard
      title={t("title")}
      description={t("description")}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {openShift ? (
            <>
              {onBreak ? (
                <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => run(stopBreakAction)} data-testid="shift-end-break">
                  <PlayIcon aria-hidden="true" />
                  {t("endBreak")}
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  data-testid="shift-start-break"
                  onClick={() =>
                    run(async () => {
                      const r = await startBreakAction();
                      return r.ok ? { ok: true, message: r.value.stoppedTimerId ? t("breakStartedTimerStopped") : t("breakStarted") } : r;
                    })
                  }
                >
                  <CoffeeIcon aria-hidden="true" />
                  {t("startBreak")}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                disabled={pending}
                data-testid="shift-clock-out"
                onClick={() =>
                  run(async () => {
                    const r = await clockOutAction();
                    return r.ok ? { ok: true, message: t("clockedOut", { worked: fmt(r.value.workedSeconds) }) } : r;
                  })
                }
              >
                <LogOutIcon aria-hidden="true" />
                {t("clockOut")}
              </Button>
            </>
          ) : (
            <Button type="button" size="sm" disabled={pending} onClick={() => run(clockInAction)} data-testid="shift-clock-in">
              <LogInIcon aria-hidden="true" />
              {t("clockIn")}
            </Button>
          )}
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="shift-strip">
        <MetricTile label={t("metrics.shift")} value={fmt(shiftSeconds)} />
        <MetricTile label={t("metrics.breaks")} value={fmt(breakSeconds)} />
        <MetricTile label={t("metrics.tracked")} value={fmt(trackedSeconds)} />
        <MetricTile
          label={unallocated >= 0 ? t("metrics.unallocated") : t("metrics.over")}
          value={fmt(Math.abs(unallocated))}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {openShift ? (
          <Badge variant="outline">{onBreak ? t("status.onBreak") : t("status.clockedIn")}</Badge>
        ) : (
          <Badge variant="outline">{t("status.clockedOut")}</Badge>
        )}
        {provisional.map((s) => (
          <span key={s.id} className="inline-flex items-center gap-2">
            <Badge variant="outline">{t("provisional")}</Badge>
            <Button type="button" size="xs" variant="ghost" disabled={pending} onClick={() => run(() => confirmShiftAction(s.id))}>
              {t("confirm")}
            </Button>
          </span>
        ))}
      </div>
    </SectionCard>
  );
}
