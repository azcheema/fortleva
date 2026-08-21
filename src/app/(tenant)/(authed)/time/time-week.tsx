"use client";

import { PlayIcon, TimerIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, useTransition } from "react";
import { toast } from "sonner";

import { DataTable, EmptyState, InlineEdit, RowActions, SectionCard, type RowAction } from "@/components/semantic";
import { notifyTimerChanged } from "@/components/shell/timer-pill";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDurationSeconds, formatDurationHm, type DurationStyle } from "@/lib/format";
import { cn } from "@/lib/utils";

import { continueEntryAction, deleteEntryAction, updateEntryAction } from "./actions";

export type WeekEntryRow = {
  id: string;
  date: string;
  startedAt: string;
  stoppedAt: string | null;
  /** "08:00–09:30" (or "08:00–…" while running) formatted on the SERVER — see the note in TimeWeek. */
  timeLabel: string;
  durationSeconds: number | null;
  label: string;
  projectKey: string | null;
  serviceName: string | null;
  workTypeName: string | null;
  billable: boolean;
  overlaps: boolean;
  needsReview: boolean;
  locked: boolean;
  entryMode: "TIMER" | "MANUAL" | "DURATION";
};

/**
 * The week grid of My Time (UI.md §3.1, rule 9): every own entry in the
 * range grouped by local date with day and week totals; the duration is
 * read-first and editable inline (own unlocked entries), every row has
 * one-click continue (D6) and a delete behind an inline confirm; overlap
 * (allow + flag), needs-review and locked are badges — locked rows say
 * why (D6 UX) and never mutate. Running entries show live elsewhere.
 *
 * Date and clock labels arrive PRE-FORMATTED from the server (`dayLabels`,
 * `timeLabel`): an `Intl.DateTimeFormat` built here runs once in Node
 * (SSR) and once in the browser (hydration), and the two ICU builds do
 * not always agree on `weekday: "short"` order or separators — React
 * #418 on every visit where they differ (first seen on CI: Node 22 vs
 * Chromium). One formatter, one place, one string.
 */
export function TimeWeek({
  days,
  dayLabels,
  entries,
  durationStyle,
  actions,
}: {
  days: string[];
  /** ISO date → server-formatted heading ("Thu 20 Aug"), built with @/lib/format. */
  dayLabels: Record<string, string>;
  entries: WeekEntryRow[];
  durationStyle: DurationStyle;
  /** The card's header verbs (copy last week) — shown with rows and in the empty state alike. */
  actions?: React.ReactNode;
}) {
  const t = useTranslations("time.week");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const r = await fn().catch(() => ({ ok: false, message: t("failed") }));
      if (!r.ok) toast.error(r.message);
      else toast.success(r.message);
      notifyTimerChanged();
      router.refresh();
    });

  const fmt = (seconds: number) => formatDurationSeconds(locale, seconds, durationStyle);
  const byDay = new Map<string, WeekEntryRow[]>();
  for (const e of entries) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e]);
  const weekTotal = entries.reduce((s, e) => s + (e.durationSeconds ?? 0), 0);

  if (entries.length === 0) {
    return (
      <SectionCard title={t("title")} actions={actions}>
        <EmptyState
          variant="empty"
          icon={TimerIcon}
          title={t("empty.title")}
          body={t("empty.body")}
          action={
            <Button asChild size="sm">
              <Link href="#quick-start">{t("empty.action")}</Link>
            </Button>
          }
          className="mx-auto items-center py-8 text-center"
        />
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title={t("title")}
      description={t("total", { total: fmt(weekTotal) })}
      actions={actions}
      contentClassName="p-0"
    >
      <DataTable flush scrollLabel={t("scrollLabel")}>
        <Table>
          <TableHeader>
            <TableRow>
              {/* medium: at 390px the clock range is the column that yields, so the
                  trailing verbs stay inside the table's visible box (UI.md §10.15 1). */}
              <TableHead priority="medium" className="w-[12ch]">{t("columns.time")}</TableHead>
              <TableHead>{t("columns.what")}</TableHead>
              <TableHead priority="medium" className="w-[16ch]">{t("columns.agreement")}</TableHead>
              <TableHead priority="low" className="w-[14ch]">{t("columns.type")}</TableHead>
              <TableHead priority="medium" className="w-[10ch]">{t("columns.billable")}</TableHead>
              <TableHead className="w-[10ch] text-right">{t("columns.duration")}</TableHead>
              <TableHead className="w-0 text-right">
                <span className="sr-only">{t("columns.actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {days.map((day) => {
              const rows = byDay.get(day) ?? [];
              if (rows.length === 0) return null;
              const dayTotal = rows.reduce((s, e) => s + (e.durationSeconds ?? 0), 0);
              return (
                <Fragment key={day}>
                  {/* One cell spanning every column: a fixed colSpan + a separate total cell
                      assumed all seven columns are visible, and on a phone (four hidden by
                      priority) the total landed past the right edge. */}
                  <TableRow className="bg-muted/40">
                    <TableCell colSpan={7} className="text-xs font-semibold text-muted-foreground">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="uppercase tracking-wide">{dayLabels[day] ?? day}</span>
                        <span className="num">{fmt(dayTotal)}</span>
                      </div>
                    </TableCell>
                  </TableRow>
                  {rows.map((e) => {
                    const running = e.stoppedAt === null;
                    const rowActions: RowAction[] = [
                      ...(e.locked
                        ? []
                        : [
                            {
                              key: "delete",
                              label: t("actions.delete"),
                              tone: "danger" as const,
                              confirm: t("actions.confirmDelete"),
                              onSelect: () => run(() => deleteEntryAction(e.id)),
                            },
                          ]),
                    ];
                    return (
                      <TableRow key={e.id} data-testid="time-entry-row" data-entry-id={e.id} className={cn(running && "bg-(--tone-success-bg)/30")}>
                        <TableCell priority="medium" className="num text-muted-foreground">
                          {e.entryMode === "DURATION" ? t("durationOnly") : e.timeLabel}
                        </TableCell>
                        <TableCell>
                          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                            {e.projectKey ? <span className="num-id text-muted-foreground">{e.projectKey}</span> : null}
                            <span className="truncate">{e.label || t("adhoc")}</span>
                            {running ? <Badge variant="outline">{t("badges.running")}</Badge> : null}
                            {e.overlaps ? <Badge variant="outline">{t("badges.overlap")}</Badge> : null}
                            {e.needsReview ? <Badge variant="outline">{t("badges.review")}</Badge> : null}
                            {e.locked ? (
                              <Badge variant="outline" title={t("badges.lockedWhy")}>
                                {t("badges.locked")}
                              </Badge>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell priority="medium" className="text-muted-foreground">{e.serviceName ?? "—"}</TableCell>
                        <TableCell priority="low" className="text-muted-foreground">{e.workTypeName ?? "—"}</TableCell>
                        <TableCell priority="medium">
                          <InlineEdit
                            kind="select"
                            name={`billable-${e.id}`}
                            value={e.billable ? "yes" : "no"}
                            label={t("columns.billable")}
                            placeholder={t("billable.no")}
                            options={[
                              { value: "yes", label: t("billable.yes") },
                              { value: "no", label: t("billable.no") },
                            ]}
                            readOnly={e.locked || !e.projectKey}
                            density="table"
                            fit
                            hiddenInput={false}
                            onCommit={(next) => run(() => updateEntryAction(e.id, { billable: next === "yes" }))}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          {running ? (
                            <span className="num text-muted-foreground">{t("badges.running")}</span>
                          ) : (
                            <InlineEdit
                              kind="text"
                              name={`duration-${e.id}`}
                              value={formatDurationHm("en", (e.durationSeconds ?? 0) / 60)}
                              display={<span className="num">{fmt(e.durationSeconds ?? 0)}</span>}
                              label={t("columns.duration")}
                              placeholder={t("durationPlaceholder")}
                              readOnly={e.locked}
                              density="table"
                              fit
                              align="end"
                              hiddenInput={false}
                              inputProps={{ inputMode: "text", pattern: ".*" }}
                              onCommit={(next) => run(() => updateEntryAction(e.id, { durationText: next }))}
                            />
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <RowActions
                            label={tCommon("actionsFor", { name: e.label || t("adhoc") })}
                            primary={
                              running ? undefined : (
                                <Button
                                  type="button"
                                  size="icon-sm"
                                  variant="ghost"
                                  aria-label={t("actions.continue")}
                                  disabled={pending}
                                  data-testid="entry-continue"
                                  onClick={() =>
                                    run(async () => {
                                      const r = await continueEntryAction(e.id);
                                      return r.ok ? { ok: true, message: t("actions.continued") } : r;
                                    })
                                  }
                                >
                                  <PlayIcon aria-hidden="true" />
                                </Button>
                              )
                            }
                            items={rowActions}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </DataTable>
    </SectionCard>
  );
}
