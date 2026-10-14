import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

import { ChartLegend, type BarSeries } from "./bar-list";

/**
 * COLUMNS OVER TIME (Phase 6 slice 117, the team charts) — one value per
 * period, a column each, the value on its cap and the period under it. Plain
 * HTML on the chart tokens, no directive. The EMPHASIS form: the columns the
 * reader asked about wear the active colour, the rest the neutral, and the
 * legend says which is which. A period with no value draws no column and a
 * dash for its value. The tallest column is 96 px inside a 128 px band that
 * also holds its label, so the card never grows a nested scroll.
 */

export type Column = {
  readonly key: string;
  /** "Oct" — under the column. */
  readonly label: string;
  readonly value: number | null;
  /** On the cap — "4.5" or "—". */
  readonly valueText: string;
  /** Said after the value to a screen reader — "days", or "day" for a value of 1. */
  readonly unitText?: string;
  readonly emphasis: boolean;
};

const PLOT_PX = 96;

export function ColumnChart({
  label,
  columns,
  emphasis,
  rest,
}: {
  /** From t(): what the chart is, for a screen reader. */
  label: string;
  columns: readonly Column[];
  /** The legend entries of the emphasised columns and of the others. */
  emphasis: BarSeries;
  rest: BarSeries;
}) {
  const max = Math.max(0, ...columns.map((c) => c.value ?? 0));
  return (
    <div data-slot="column-chart" className="flex flex-col gap-3">
      <ul aria-label={label} className="flex h-32 items-end gap-3 border-b border-border">
        {columns.map((c) => (
          <li key={c.key} data-testid="column" className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
            <span className="num text-xs">
              <span className="sr-only">{c.label} </span>
              {c.valueText}
              {c.unitText && c.value !== null ? <span className="sr-only"> {c.unitText}</span> : null}
            </span>
            {c.value !== null && max > 0 ? (
              <span
                aria-hidden="true"
                className={cn("w-full max-w-6 rounded-t-sm", c.emphasis ? emphasis.fill : rest.fill)}
                style={{ blockSize: `${Math.max(2, Math.round((c.value / max) * PLOT_PX))}px` } satisfies CSSProperties}
              />
            ) : null}
          </li>
        ))}
      </ul>
      <div aria-hidden="true" className="-mt-2 flex gap-3">
        {columns.map((c) => (
          <span key={c.key} className="min-w-0 flex-1 truncate text-center text-xs text-muted-foreground">
            {c.label}
          </span>
        ))}
      </div>
      <ChartLegend series={[emphasis, rest]} />
    </div>
  );
}
