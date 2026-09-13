"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  addMonthsClamped,
  calendarMoveOf,
  canShowMonth,
  clampDate,
  monthGrid,
  moveDate,
} from "@/lib/calendar";
import { calendarDayClass } from "@/lib/control-classes";
import { dateColumn } from "@/lib/duration";
import { dateFormat } from "@/lib/format";
import { addDays, shiftMonth, weekContaining, type WeekStart } from "@/lib/week";

/**
 * `<CalendarGrid>` — a month of days as an ARIA grid (UI.md §5.2 `D`,
 * §9). Built in-house on `week.ts` + `Intl` (ARC-24): the week numbers
 * are the ones `/time` already shows, and no date library brings its
 * own focus model and CSS.
 *
 * It is a `footer` of `<PropertyPicker>`, and that placement is the
 * whole keyboard story:
 *
 * · AFTER `</Command>`, never inside it — cmdk's root `onKeyDown` owns
 *   Enter, the arrows, Home and End for every descendant, so a grid
 *   inside it would commit the highlighted ROW when the member pressed
 *   Enter on a DAY.
 * · INSIDE `[data-slot="popover-content"]`, so the window dispatcher
 *   leaves every single key (S P E D T ? g) alone while a day has focus.
 * · It preventDefaults EXACTLY the keys it consumes (`calendarMoveOf`)
 *   and never stops propagation: ⌘K and every other chord still reach
 *   the dispatcher, Tab stays Radix's focus loop, Escape stays Radix's
 *   (the picker first, the peek second), and Enter/Space stay the
 *   native button click — which is the one commit path.
 *
 * Focus moves only on the KEYBOARD path, one render after the date it
 * moved to exists; it never moves on mount, or the picker's search
 * field would lose Radix's autofocus the moment it opened.
 *
 * The month buttons are `aria-disabled`, never `disabled`: a native
 * `disabled` on the focused button at the 2100-12 bound would drop
 * focus to `<body>`. They carry NO tooltip, for the trigger's measured
 * reason — a tooltip that opens on focus eats the next Escape.
 *
 * Every name is `Intl` in UTC over ISO dates, so no zone can shift a
 * day. That is hydration-safe only because `PopoverContent` mounts on
 * open and never server-renders (no `forceMount`).
 */
export function CalendarGrid({
  value,
  today,
  weekStart,
  showWeekNumbers,
  onPick,
  testId,
}: {
  /** REQUIRED. The committed ISO date, or null. */
  value: string | null;
  /** REQUIRED. The member-zone date, resolved by the caller when the picker OPENED. */
  today: string;
  /** REQUIRED. The tenant's `ui.weekStart`. */
  weekStart: WeekStart;
  /** REQUIRED. The tenant's `ui.showIsoWeek`. */
  showWeekNumbers: boolean;
  onPick: (isoDate: string) => void;
  testId?: string;
}) {
  const t = useTranslations("common.calendar");
  const locale = useLocale();
  const captionId = useId();
  const gridRef = useRef<HTMLTableElement>(null);
  // The shown month is ALWAYS the focus date's, so the roving tab stop
  // is always a rendered button.
  const [focusDate, setFocusDate] = useState(() => clampDate(value ?? today));
  const focusAfterRender = useRef(false);

  useEffect(() => {
    if (!focusAfterRender.current) return;
    focusAfterRender.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`button[data-date="${focusDate}"]`)?.focus();
  }, [focusDate]);

  const yearMonth = focusDate.slice(0, 7);
  const rows = monthGrid(yearMonth, weekStart);
  const canPrevious = canShowMonth(shiftMonth(yearMonth, -1));
  const canNext = canShowMonth(shiftMonth(yearMonth, 1));

  const shortWeekday = dateFormat(locale, { weekday: "short", timeZone: "UTC" });
  const longWeekday = dateFormat(locale, { weekday: "long", timeZone: "UTC" });
  const dayName = dateFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  // The header follows `weekStart`: the seven raw days of the first row.
  const firstDay = weekContaining(`${yearMonth}-01`, weekStart).from;
  const weekdays = Array.from({ length: 7 }, (_, i) => {
    const iso = addDays(firstDay, i);
    return { iso, short: shortWeekday.format(dateColumn(iso)), long: longWeekday.format(dateColumn(iso)) };
  });
  const caption = dateFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(
    dateColumn(`${yearMonth}-01`),
  );
  const longDay = (iso: string) => dayName.format(dateColumn(iso));

  const onKeyDown = (e: React.KeyboardEvent<HTMLTableElement>) => {
    const move = calendarMoveOf(e);
    // ⌘K and every chord fall through to the window dispatcher.
    if (!move) return;
    e.preventDefault();
    const next = moveDate(focusDate, move, weekStart);
    if (next !== focusDate) {
      focusAfterRender.current = true;
      setFocusDate(next);
    }
  };

  const headerCell = "h-6 w-7 text-center text-2xs font-medium text-muted-foreground";

  return (
    <div
      data-slot="calendar-grid"
      data-testid={testId}
      className="flex flex-col gap-1 border-t border-border px-2 pt-1 pb-2"
    >
      <div className="flex items-center justify-between">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("previousMonth")}
          aria-disabled={!canPrevious || undefined}
          // Negative, like every ring inside this overflow-hidden popover.
          className="focus-visible:-outline-offset-2"
          onClick={() => {
            if (canPrevious) setFocusDate(addMonthsClamped(focusDate, -1));
          }}
        >
          <ChevronLeftIcon aria-hidden="true" />
        </Button>
        <div id={captionId} aria-live="polite" aria-atomic="true" className="text-sm font-medium">
          {caption}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("nextMonth")}
          aria-disabled={!canNext || undefined}
          className="focus-visible:-outline-offset-2"
          onClick={() => {
            if (canNext) setFocusDate(addMonthsClamped(focusDate, 1));
          }}
        >
          <ChevronRightIcon aria-hidden="true" />
        </Button>
      </div>
      <table
        ref={gridRef}
        role="grid"
        aria-labelledby={captionId}
        onKeyDown={onKeyDown}
        className="border-collapse"
      >
        <thead>
          <tr>
            {showWeekNumbers ? (
              <th scope="col" className={headerCell}>
                <span aria-hidden="true">{t("weekShort")}</span>
                <span className="sr-only">{t("week")}</span>
              </th>
            ) : null}
            {weekdays.map((d) => (
              <th key={d.iso} scope="col" aria-label={d.long} className={headerCell}>
                {d.short}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {/* A row with no day in it — December 2100's sixth, always
              (`monthGrid`) — has no week number, and is hidden whole:
              a "Week 1" header over seven spacers would announce a week
              that is not here. It still renders, so the grid keeps its
              six rows and the popover never resizes. */}
          {rows.map((row, r) => (
            <tr key={r} aria-hidden={row.isoWeek === null || undefined}>
              {showWeekNumbers ? (
                row.isoWeek === null ? (
                  <td />
                ) : (
                  <th
                    scope="row"
                    aria-label={t("weekNumber", { week: row.isoWeek })}
                    className="num text-center text-2xs text-muted-foreground"
                  >
                    {row.isoWeek}
                  </th>
                )
              ) : null}
              {row.days.map((day, c) =>
                day === null ? (
                  // Outside 1970–2100: an inert spacer, never a disabled
                  // day — it is not a date the server would accept.
                  <td key={`spacer:${c}`} role="gridcell" aria-hidden="true">
                    <span className="block size-7" />
                  </td>
                ) : (
                  <td key={day} role="gridcell" aria-selected={day === value}>
                    <button
                      type="button"
                      data-date={day}
                      tabIndex={day === focusDate ? 0 : -1}
                      aria-current={day === today ? "date" : undefined}
                      aria-label={day === value ? t("daySelected", { date: longDay(day) }) : longDay(day)}
                      className={calendarDayClass({
                        outside: day.slice(0, 7) !== yearMonth,
                        today: day === today,
                        selected: day === value,
                      })}
                      onClick={() => onPick(day)}
                    >
                      {Number(day.slice(8))}
                    </button>
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
