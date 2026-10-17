"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

import { CalendarGrid, PropertyPicker, type PickerOption } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { parseDueQuery, todayIn } from "@/lib/due-date";
import { dateColumn } from "@/lib/duration";
import { formatDay } from "@/lib/format";
import { REPEAT_RHYTHMS, firstRepeatDay, isRepeatRhythm, nextDayAllowed, type RepeatRhythm } from "@/lib/repeat-rules";
import type { WeekStart } from "@/lib/week";
import { panelSurfaceOf } from "@/lib/work-view";
import type { ItemRepeat } from "@/modules/work";

import { setItemRepeatAction, type RepeatSettingCommitted } from "../backlog/actions";
import { usePanelCommit } from "./use-panel-commit";

/**
 * `copyOf` is part of what is SHOWN, not decoration (the code review's
 * HIGH): an older copy and a task that does not repeat both have no rhythm,
 * so without it the hook's no-op guard read the copy's Stop as "nothing
 * changes" and never sent it.
 */
type ShownRepeat = { rhythm: RepeatRhythm | null; nextOn: string | null; nextLabel: string | null; copyOf: boolean };

/**
 * The item rail's Repeat and Next copy rows (slice 127; founder decision
 * C103 — docs/research/2026-10-17-slice-127-repeating-tasks-design.md §3.9).
 * Renders its own `<dt>`/`<dd>` pairs, as the Visibility island does, because
 * the second row exists only while the task repeats.
 *
 * - On a task that holds the setting (or none): a picker of the five rhythms,
 *   each showing the day it would start on (one period from today) — or,
 *   when it already repeats, the day it keeps — and "Stop repeating"; then a
 *   Next copy row with the Due date field's shape (a typed date, a month
 *   grid in the `footer`), and one line saying what a copy is.
 * - On an older copy: "Repeats from KEY-14", a link to the newest — the next
 *   copies are made from it (C103 (a)) — or why no more come.
 * - A member without `work_item:edit` + `work_item:create` sees the words.
 *
 * "Today" is the WORKSPACE's day (`timeZone` is its `ui.timezone`, not the
 * member's own zone), taken when a picker OPENS (the Due date field's rule):
 * the day the copier and `setItemRepeat` decide by, so the rows' start days
 * and the Next copy picker's refusal of a day not after today (a typed row
 * not offered, a picked day toasted) agree with the service. The service
 * still decides (`REPEAT_DAY_INVALID`, toasted).
 */
export function RepeatField({
  itemId,
  itemNumber,
  projectKey,
  surface,
  repeat,
  nextLabel,
  holderHref,
  timeZone,
  weekStart,
  showIsoWeek,
  canEdit,
  labelClassName,
  valueClassName,
}: {
  itemId: string;
  itemNumber: number;
  projectKey: string;
  /** Decides the MFA step-up return address — see `panelSurfaceOf` / `itemReturnTo`. */
  surface: "board" | "backlog" | "page";
  /** REQUIRED — `getItemDetail`'s answer. */
  repeat: ItemRepeat;
  /** The next day formatted on the server (`formatDay`), so the trigger never flickers between ICUs. */
  nextLabel: string | null;
  /** On an older copy: the newest task's link on this surface. */
  holderHref: string | null;
  /** The WORKSPACE's zone (`ui.timezone`) — never the member's, never the browser's. */
  timeZone: string;
  weekStart: WeekStart;
  showIsoWeek: boolean;
  /** `caps.repeat` — `work_item:edit` AND `work_item:create`. */
  canEdit: boolean;
  labelClassName: string;
  valueClassName: string;
}) {
  const t = useTranslations("projects.item");
  const locale = useLocale();
  const [open, setOpen] = useState<"rhythm" | "next" | null>(null);
  const [today, setToday] = useState<string | null>(null);
  const day = (iso: string) => formatDay(locale, dateColumn(iso));
  const rhythmLabel = (r: RepeatRhythm) => t(`repeat.rhythm.${r}`);

  const tErrors = useTranslations("domainErrors");
  const held = repeat?.role === "holder" ? repeat : null;
  const { shown, status, commit } = usePanelCommit<ShownRepeat, RepeatSettingCommitted>({
    canonical: {
      rhythm: held?.rhythm ?? null,
      nextOn: held?.nextOn ?? null,
      nextLabel: held ? nextLabel : null,
      copyOf: repeat?.role === "copy",
    },
    same: (a, b) => a.rhythm === b.rhythm && a.nextOn === b.nextOn && a.copyOf === b.copyOf,
    // Whatever the task was, the answer is its own setting now: never an older copy.
    adopt: (c) => ({ rhythm: c.rhythm, nextOn: c.nextOn, nextLabel: c.nextLabel, copyOf: false }),
    announce: (v) =>
      v.rhythm === null
        ? t("repeat.stopped")
        : t("repeat.changed", { rhythm: t(`repeat.inSentence.${v.rhythm}`), date: v.nextLabel ?? "" }),
    failedMessage: t("repeat.failed"),
  });

  // ONE open path per picker, so "today" is taken at the moment it opens.
  const openPicker = (which: "rhythm" | "next") => (next: boolean) => {
    if (next) setToday(todayIn(timeZone));
    setOpen(next ? which : null);
  };

  const send = (next: ShownRepeat, repeatArg: { rhythm: RepeatRhythm } | { nextOn: string } | null) =>
    // The hook's own path: optimistic, toast on a refusal, the canonical row adopted.
    commit(next, () =>
      setItemRepeatAction({ itemId, projectKey, itemNumber, surface: panelSurfaceOf(surface), repeat: repeatArg }),
    );

  // An older copy of a series: the link to the newest, never a picker. While
  // the newest is deleted the series waits, and — so a newest copy deleted
  // for good can never strand it — this task may stop it (`setItemRepeat`).
  // Drawn from what is SHOWN, so a Stop pressed here gives way at once to the
  // task's own (now plain) row, and a refusal puts this back with its toast.
  if (repeat?.role === "copy" && shown.copyOf) {
    const key = `${projectKey}-${repeat.holderNumber}`;
    return (
      <>
        <dt className={labelClassName}>{t("properties.repeat")}</dt>
        <dd className={`${valueClassName} min-w-0 flex-wrap gap-x-2`} data-testid="item-repeat-copy">
          {repeat.holderDeleted || holderHref === null ? (
            <>
              <span className="text-muted-foreground">{t("repeat.holderDeleted", { key })}</span>
              {/* What it did arrives with the revalidated page (the row goes);
                  a refusal is the hook's toast — never a local "stopped". */}
              {canEdit ? (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto px-0"
                  onClick={() => send({ rhythm: null, nextOn: null, nextLabel: null, copyOf: false }, null)}
                  data-testid="item-repeat-stop-series"
                >
                  {t("repeat.stop")}
                </Button>
              ) : null}
            </>
          ) : (
            <Link href={holderHref} className="underline-offset-4 hover:underline" data-testid="item-repeat-holder-link">
              {t("repeat.copyOf", { key })}
            </Link>
          )}
          {status}
        </dd>
      </>
    );
  }

  const note =
    shown.rhythm === null ? null : (
      <dd className="col-span-2 pb-1 text-xs text-muted-foreground" data-testid="item-repeat-note">
        {held?.projectClosed ? t("repeat.projectClosed") : t("repeat.note")}
      </dd>
    );

  if (!canEdit) {
    return (
      <>
        <dt className={labelClassName}>{t("properties.repeat")}</dt>
        <dd className={valueClassName} data-testid="item-repeat">
          {shown.rhythm === null ? t("repeat.never") : rhythmLabel(shown.rhythm)}
        </dd>
        {shown.rhythm !== null ? (
          <>
            <dt className={labelClassName}>{t("properties.nextCopy")}</dt>
            <dd className={`${valueClassName} num`}>{shown.nextLabel ?? "—"}</dd>
            {note}
          </>
        ) : null}
      </>
    );
  }

  // Rhythm rows: the current state first, the other rhythms with the day
  // each would start on, "Stop repeating" last when set.
  const rhythmOptions: PickerOption<string>[] =
    today === null
      ? []
      : [
          shown.rhythm === null
            ? { value: "none", label: t("repeat.never"), testId: "item-repeat-none" }
            : { value: shown.rhythm, label: rhythmLabel(shown.rhythm), testId: "item-repeat-current" },
          ...REPEAT_RHYTHMS.filter((r) => r !== shown.rhythm).map((r) => {
            const from = shown.nextOn ?? firstRepeatDay(r, today);
            return {
              value: r,
              label: rhythmLabel(r),
              meta:
                from === null ? undefined : (
                  <span className="num text-xs text-muted-foreground">
                    {shown.nextOn === null ? t("repeat.startsOn", { date: day(from) }) : t("repeat.keepsDay", { date: day(from) })}
                  </span>
                ),
              testId: `item-repeat-rhythm-${r}`,
            };
          }),
          ...(shown.rhythm === null ? [] : [{ value: "stop", label: t("repeat.stop"), testId: "item-repeat-stop" }]),
        ];

  const onRhythm = (choice: string) => {
    if (today === null) return;
    if (choice === "stop") {
      send({ rhythm: null, nextOn: null, nextLabel: null, copyOf: false }, null);
      return;
    }
    if (!isRepeatRhythm(choice) || choice === shown.rhythm) return;
    const nextOn = shown.nextOn ?? firstRepeatDay(choice, today);
    send({ rhythm: choice, nextOn, nextLabel: nextOn === null ? null : day(nextOn), copyOf: false }, { rhythm: choice });
  };

  const onNext = (iso: string) => {
    if (today === null || shown.rhythm === null || iso === shown.nextOn) return;
    // The grid offers every day; one not after today (or past two years) is
    // refused here with the service's own sentence, before any request.
    if (!nextDayAllowed(iso, today)) {
      toast.error(tErrors("REPEAT_DAY_INVALID"));
      return;
    }
    send({ rhythm: shown.rhythm, nextOn: iso, nextLabel: day(iso), copyOf: false }, { nextOn: iso });
  };

  return (
    <>
      <dt className={labelClassName}>{t("properties.repeat")}</dt>
      <dd className={valueClassName}>
        <PropertyPicker
          open={open === "rhythm"}
          onOpenChange={openPicker("rhythm")}
          value={shown.rhythm ?? "none"}
          options={rhythmOptions}
          onSelect={onRhythm}
          testId="item-repeat"
          className="-ms-2.5"
          labels={{
            trigger:
              shown.rhythm === null ? t("repeat.triggerEmpty") : t("repeat.trigger", { rhythm: rhythmLabel(shown.rhythm) }),
            input: t("repeat.input"),
            search: t("repeat.search"),
            empty: t("repeat.empty"),
            current: t("currentValue"),
          }}
        >
          <span className="min-w-0 truncate" data-value={shown.rhythm ?? ""}>
            {shown.rhythm === null ? t("repeat.never") : rhythmLabel(shown.rhythm)}
          </span>
        </PropertyPicker>
        {status}
      </dd>
      {shown.rhythm !== null && shown.nextOn !== null ? (
        <>
          <dt className={labelClassName}>{t("properties.nextCopy")}</dt>
          <dd className={valueClassName}>
            <PropertyPicker
              open={open === "next"}
              onOpenChange={openPicker("next")}
              value={shown.nextOn}
              options={
                today === null ? [] : [{ value: shown.nextOn, label: shown.nextLabel ?? day(shown.nextOn), testId: "item-repeat-next-current" }]
              }
              onSelect={onNext}
              derive={(query) => {
                const iso = parseDueQuery(query);
                // A typed day the service would refuse is never offered as a row.
                return iso && today !== null && nextDayAllowed(iso, today)
                  ? { value: iso, label: t("repeat.setNext", { date: day(iso) }), testId: "item-repeat-next-derived" }
                  : null;
              }}
              // After the cmdk root, inside the popover — the grid's keys are
              // its own (CalendarGrid; the Due date field's placement).
              footer={
                today === null
                  ? undefined
                  : (pick) => (
                      <CalendarGrid
                        value={shown.nextOn}
                        today={today}
                        weekStart={weekStart}
                        showWeekNumbers={showIsoWeek}
                        onPick={pick}
                        testId="item-repeat-calendar"
                      />
                    )
              }
              testId="item-repeat-next"
              className="-ms-2.5"
              labels={{
                trigger: t("repeat.nextTrigger", { date: shown.nextLabel ?? day(shown.nextOn) }),
                input: t("repeat.nextInput"),
                search: t("repeat.nextSearch"),
                empty: t("repeat.nextEmpty"),
                current: t("currentValue"),
              }}
            >
              <span className="num min-w-0 truncate" data-value={shown.nextOn}>
                {shown.nextLabel ?? day(shown.nextOn)}
              </span>
            </PropertyPicker>
          </dd>
          {note}
        </>
      ) : null}
    </>
  );
}
