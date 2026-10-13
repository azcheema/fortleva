"use client";

import { useFormatter, useTranslations } from "next-intl";

import { NativeSelect } from "@/components/ui/native-select";

/**
 * THE MONTH A REPORT COVERS (Phase 6 slice 115; C91 (d)) — a month and a year,
 * two native selects under one legend, posting one `YYYY-MM` value. Not an
 * `<input type="month">`: Safari and Firefox on the desktop draw it as a bare
 * text box. Controlled: the caller holds the value, so a form that resets
 * after an upload resets this too.
 *
 * Months after `latest` (the workspace's current month — a report for next
 * month is a typo, and the service refuses it) are not offered. Month names
 * come from next-intl's formatter in UTC, so the server's render and the
 * browser's agree whatever either's zone (AGENTS.md's hydration trap).
 */
export function MonthPicker({
  id,
  value,
  latest,
  onChange,
  disabled,
}: {
  /** Prefix for the two controls' ids. */
  id: string;
  /** `YYYY-MM`. */
  value: string;
  /** `YYYY-MM` — the newest month offered. */
  latest: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("clients.reports.month");
  const format = useFormatter();
  const [year, month] = [Number(value.slice(0, 4)), Number(value.slice(5, 7))];
  const [latestYear, latestMonth] = [Number(latest.slice(0, 4)), Number(latest.slice(5, 7))];
  // Six years back, and the value's own year if it is older (an old report
  // being corrected).
  const firstYear = Math.min(latestYear - 5, year);
  const years: number[] = [];
  for (let y = latestYear; y >= firstYear; y -= 1) years.push(y);
  const pad = (n: number) => String(n).padStart(2, "0");
  const set = (y: number, m: number) => {
    // A month past `latest` in the latest year falls back to `latest` itself.
    const clamped = y === latestYear && m > latestMonth ? latestMonth : m;
    onChange(`${y}-${pad(clamped)}`);
  };
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5" disabled={disabled}>
      <legend className="mb-1.5 text-sm font-medium">{t("label")}</legend>
      <div className="flex flex-wrap gap-2">
        <NativeSelect
          id={`${id}-month`}
          aria-label={t("monthLabel")}
          value={String(month)}
          onChange={(e) => set(year, Number(e.target.value))}
          className="w-auto min-w-36"
          data-testid="report-month"
        >
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <option key={m} value={String(m)} disabled={year === latestYear && m > latestMonth}>
              {format.dateTime(new Date(Date.UTC(2000, m - 1, 1)), { month: "long", timeZone: "UTC" })}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          id={`${id}-year`}
          aria-label={t("yearLabel")}
          value={String(year)}
          onChange={(e) => set(Number(e.target.value), month)}
          className="w-auto min-w-24"
          data-testid="report-year"
        >
          {years.map((y) => (
            <option key={y} value={String(y)}>
              {y}
            </option>
          ))}
        </NativeSelect>
      </div>
    </fieldset>
  );
}
