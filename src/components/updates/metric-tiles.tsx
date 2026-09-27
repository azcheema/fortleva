import { cn } from "@/lib/utils";

/** One tile: a label, the number, an optional detail line under it. Every string is already formatted and localised by the caller. */
export type MetricTileSpec = {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly detail: string | null;
};

/**
 * THE METRIC STRIP — a `<dl>` of small bordered tiles, drawn once for
 * the two places that show a client its numbers: the frozen block on a
 * published update (`UpdateView`) and the live hours widget on the
 * portal's project page (`ProjectHours`). One markup, so a token or
 * padding change reaches both, and the widget really is the block's
 * live twin rather than a copy that was identical on the day it was
 * written.
 *
 * No directive: `UpdateView` is rendered by a client component (the
 * composer's preview) and `ProjectHours` is a server component, and
 * both may import this.
 */
export function MetricTiles({ tiles, className }: { tiles: readonly MetricTileSpec[]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-2 gap-2 md:grid-cols-3", className)}>
      {tiles.map((tile) => (
        <div
          key={tile.key}
          data-metric={tile.key}
          className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border bg-background p-3"
        >
          <dt className="text-xs text-muted-foreground">{tile.label}</dt>
          <dd className="num text-lg font-semibold text-foreground">{tile.value}</dd>
          {tile.detail ? <dd className="text-xs text-muted-foreground">{tile.detail}</dd> : null}
        </div>
      ))}
    </dl>
  );
}
