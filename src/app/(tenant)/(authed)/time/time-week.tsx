"use client";

import { PlayIcon, TimerIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, useState, useTransition } from "react";
import { toast } from "sonner";

import { DataTable, EmptyState, Field, InlineEdit, RowActions, SectionCard, type RowAction } from "@/components/semantic";
import { notifyTimerChanged } from "@/components/shell/timer-pill";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SHOW_FROM, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { canSplitSeconds } from "@/lib/duration";
import { durationInputText, formatDurationSeconds, type DurationStyle } from "@/lib/format";
import { cn } from "@/lib/utils";

import { continueEntryAction, deleteEntryAction, splitEntryAction, updateEntryAction } from "./actions";

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

  // "Split…" from a row's menu is answered by ONE in-place form under the
  // table (the settings-rates precedent). Only the row's ID is state: the
  // form always shows the CURRENT row (a refresh that changed or removed
  // it is reflected, never a frozen snapshot), and the form owns its own
  // text so typing does not re-render the grid.
  const [splittingId, setSplittingId] = useState<string | null>(null);
  const splitting = splittingId ? (entries.find((e) => e.id === splittingId) ?? null) : null;
  const submitSplit = (id: string, first: string) =>
    run(async () => {
      const r = await splitEntryAction(id, first);
      if (r.ok) setSplittingId(null);
      return r;
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
              {/* low, not medium: with time, billable and agreement all on the
                  medium rung the table measured 29px wider than a 608px box
                  (the rung's own width), its row verbs 13px outside — at 642px
                  on a phone, or 882px with the rail open. The agreement is the
                  column that waits; the billable toggle is the one edited here. */}
              <TableHead priority="low" className="w-[16ch]">{t("columns.agreement")}</TableHead>
              <TableHead priority="low" className="w-[14ch]">{t("columns.type")}</TableHead>
              <TableHead priority="medium" className="w-[10ch]">{t("columns.billable")}</TableHead>
              <TableHead className="w-[10ch] text-right">{t("columns.duration")}</TableHead>
              <TableHead pinned className="w-0 text-right">
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
                      // Split: a finished, unlocked row long enough for two whole-minute halves (the service's rule, one helper).
                      ...(e.locked || running || !canSplitSeconds(e.durationSeconds)
                        ? []
                        : [{ key: "split", label: t("actions.split"), onSelect: () => setSplittingId(e.id) }]),
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
                        {/* WHAT, and it is the column that pays for the rest
                            (measured on CI run 35380530578: this table was
                            91px past a 356px box, 65px past 608 and 76px past
                            736 — the largest overflow left in the product).
                            Not a rung mistake: every badge is `shrink-0`
                            `whitespace-nowrap`, so four of them FORCED the
                            column exactly as `/clients`' city span forced its
                            own. Three changes, and each answers one part:

                            · `contain-inline-size` + `w-full` over the cell's
                              `min-w-40` floor takes this wrapper out of the
                              column's intrinsic sizing entirely (UI.md §10.12,
                              the backlog title cell's own answer), so the
                              column stops being measured from its content.
                              TEN rem, not the fourteen `/clients` uses, and
                              measured rather than chosen: this table also
                              carries a duration editor and a pinned column
                              with TWO buttons, ~170px of fixed width at a
                              356px box, so a 14rem floor left it 38px over —
                              the same way the client Projects tab's 10ch key
                              column made 14rem 6px too wide there (slice 28).
                              At 10rem the floor never binds on a phone: the
                              column takes the 186px remainder instead.
                            · `flex-wrap` is GONE. With the width now fixed the
                              badges would have wrapped instead of widening,
                              and a row that grows a second line fails the
                              craft audit's row-pitch assertion — the overflow
                              would have become a height bug.
                            · The three ADVISORY badges take the `medium`
                              rung, so below a 608px box they are not rendered.
                              That is the trade, stated: a phone loses the
                              advisories and keeps the entry they are about,
                              the same trade the Agreement and Type columns
                              already make two lines below — and "Running"
                              survives it anyway, since the row is tinted.
                              `Locked` is NOT one of them; see below. */}
                        <TableCell className="min-w-40">
                          <div className="flex w-full min-w-0 items-center gap-1.5 contain-inline-size">
                            {e.projectKey ? (
                              <span className="num-id shrink-0 text-muted-foreground">{e.projectKey}</span>
                            ) : null}
                            {/* The label is what YIELDS here, so it carries the
                                full text as its own `title` — the §10.12 rule
                                for any identifying cell that truncates. */}
                            <span className="truncate" title={e.label || t("adhoc")}>
                              {e.label || t("adhoc")}
                            </span>
                            {/* THE ADVISORY THREE, and only these, take the
                                rung — rendered at all only when there is one
                                to show, or the `gap-1.5` would eat 6px of
                                every badge-less label. Capped at half the
                                cell like the backlog's chips: they are
                                `shrink-0` `whitespace-nowrap` and size
                                containment does NOT clip, so three Swedish
                                ones (`Överlappar Kontrollera`) would have
                                collapsed the label to nothing and painted
                                straight back out of the cell — the scroll
                                this change removes. Past the cap the last
                                one clips, which is a bounded failure where
                                the alternative is an unbounded one. */}
                            {running || e.overlaps || e.needsReview ? (
                              <span
                                className={cn(
                                  "shrink-0 max-w-1/2 items-center gap-1.5 overflow-hidden",
                                  SHOW_FROM.medium,
                                )}
                              >
                                {running ? <Badge variant="outline">{t("badges.running")}</Badge> : null}
                                {e.overlaps ? <Badge variant="outline">{t("badges.overlap")}</Badge> : null}
                                {e.needsReview ? <Badge variant="outline">{t("badges.review")}</Badge> : null}
                              </span>
                            ) : null}
                            {/* LOCKED IS NOT ADVISORY and never takes a rung.
                                It is the one badge that explains a failed
                                interaction: on a locked row every editor is
                                read-only and the ⋯ trigger renders disabled,
                                so without it a phone shows a row that simply
                                refuses to be touched and says nothing about
                                why (review). Uncapped too, for the same
                                reason — it is the last thing that should
                                clip. */}
                            {e.locked ? (
                              <Badge variant="outline" className="shrink-0" title={t("badges.lockedWhy")}>
                                {t("badges.locked")}
                              </Badge>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell priority="low" className="text-muted-foreground">{e.serviceName ?? "—"}</TableCell>
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
                              value={durationInputText(e.durationSeconds ?? 0)}
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
                        <TableCell pinned className="text-right">
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
      {splitting ? (
        <SplitForm
          key={`${splitting.id}:${splitting.durationSeconds ?? 0}`}
          row={splitting}
          total={fmt(splitting.durationSeconds ?? 0)}
          pending={pending}
          onSubmit={(first) => submitSplit(splitting.id, first)}
          onCancel={() => setSplittingId(null)}
        />
      ) : null}
    </SectionCard>
  );
}

/**
 * The split question, under the table: the first part's length (default
 * half — as input text, the spelling the parser reads back), Split /
 * Cancel. Owns its text so keystrokes re-render only this form; re-keyed
 * by the row and its length, so a refresh that changed the row re-seeds
 * it. No focus grab: the row menu hands focus back to its ⋯ trigger on
 * close (the settings-rates precedent), and Tab reaches the field.
 */
function SplitForm({
  row,
  total,
  pending,
  onSubmit,
  onCancel,
}: {
  row: WeekEntryRow;
  total: string;
  pending: boolean;
  onSubmit: (first: string) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("time.week");
  const tCommon = useTranslations("common");
  const [first, setFirst] = useState(() => durationInputText(Math.max(60, Math.floor((row.durationSeconds ?? 0) / 120) * 60)));
  return (
    <form
      className="flex flex-wrap items-end gap-3 border-t border-border p-4"
      data-testid="split-form"
      onSubmit={(ev) => {
        ev.preventDefault();
        onSubmit(first);
      }}
    >
      <Field htmlFor="split-first" label={t("split.first", { name: row.label || t("adhoc") })} hint={t("split.hint", { total })}>
        <Input id="split-first" value={first} onChange={(ev) => setFirst(ev.target.value)} autoComplete="off" className="w-[12ch]" data-testid="split-first" />
      </Field>
      <Button type="submit" size="sm" disabled={pending || first.trim() === ""} data-testid="split-submit">
        {t("split.submit")}
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
        {tCommon("cancel")}
      </Button>
    </form>
  );
}
