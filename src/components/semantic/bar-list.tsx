import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * HORIZONTAL BARS, STACKED (Phase 6 slice 117, the team charts) — a ranked
 * list where each row is a label, a bar of up to three parts and the row's
 * total. Plain HTML on the chart tokens, server-rendered, no directive: the
 * dataviz method's bar (≤ 24 px thick — here 12; square at the baseline, a
 * rounded data-end; a 2 px gap of the surface between parts, never a border)
 * with its legend under it. The row's TEXT is its label and its total, so a
 * screen reader reads the chart as a list; the bar itself is `aria-hidden`
 * and each part's split is in its `title` for a mouse and in the chart's
 * table twin for everyone (`ChartTable` — tooltips enhance, never gate).
 *
 * The scale is the largest row's total; a part's width is its share of that,
 * set as its flex BASIS with shrink on, so the gaps between parts are taken
 * out of the parts and the largest row never overflows its track.
 */

export type BarSeries = {
  readonly key: string;
  readonly label: string;
  /** A COMPLETE token class, e.g. "bg-(--chart-active)" — never assembled at runtime. */
  readonly fill: string;
  /** Drawn before the label in the legend — Late's icon (colour is never the only cue). */
  readonly icon?: ReactNode;
};

export type BarListRow = {
  readonly key: string;
  /** Text or a chip; it truncates. */
  readonly label: ReactNode;
  /** One value per series, in the series' order. */
  readonly values: readonly number[];
  /** Each part's words for its `title`, in the series' order. */
  readonly titles: readonly string[];
  /** The row's total, formatted. */
  readonly totalText: string;
};

export function BarList({
  label,
  series,
  rows,
  className,
}: {
  /** From t(): what the list is, for a screen reader. */
  label: string;
  series: readonly BarSeries[];
  rows: readonly BarListRow[];
  className?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.values.reduce((a, b) => a + b, 0)));
  return (
    <div data-slot="bar-list" className={cn("flex flex-col gap-3", className)}>
      <ul aria-label={label} className="flex flex-col">
        {rows.map((row) => {
          const last = row.values.reduce((at, v, i) => (v > 0 ? i : at), -1);
          return (
            <li key={row.key} data-testid="bar-row" className="flex h-8 min-w-0 items-center gap-3">
              <span className="flex w-28 min-w-0 shrink-0 items-center text-sm sm:w-40">{row.label}</span>
              <span aria-hidden="true" className="flex h-3 min-w-0 flex-1 gap-0.5">
                {row.values.map((v, i) =>
                  v > 0 ? (
                    <span
                      key={series[i]!.key}
                      title={row.titles[i]}
                      className={cn("h-full min-w-0.5 grow-0", series[i]!.fill, i === last && "rounded-r-sm")}
                      style={{ flexBasis: `${(v / max) * 100}%` } satisfies CSSProperties}
                    />
                  ) : null,
                )}
              </span>
              <span className="num w-20 shrink-0 text-right text-sm">{row.totalText}</span>
            </li>
          );
        })}
      </ul>
      {series.length > 1 ? <ChartLegend series={series} /> : null}
    </div>
  );
}

/** The legend: a swatch the shape of the mark, the icon where there is one, and the words — text in text tokens. */
export function ChartLegend({ series }: { series: readonly BarSeries[] }) {
  return (
    <ul data-slot="chart-legend" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={cn("size-2.5 shrink-0 rounded-sm", s.fill)} />
          {s.icon}
          {s.label}
        </li>
      ))}
    </ul>
  );
}
