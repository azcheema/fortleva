import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

/**
 * The density wrapper. It sets --row-h once, which <TableRow> consumes
 * for its height AND <Skeleton> consumes for its loading shape — so a
 * table can never load at one rhythm and settle at another.
 *
 * Wrapper geometry (1px hairline, 10px radius, horizontal scroll) lives
 * here too, so a table inside a SectionCard and a table on bare canvas
 * look identical. It is the ONLY scroll container in the stack: the
 * scrollbar gutter is not reserved, because `overflow-x: auto` also
 * makes the block axis scrollable, and `scrollbar-gutter: stable` then
 * reserved 17px on the RIGHT for a vertical scrollbar that can never
 * appear on an auto-height box.
 */
export type Density = "compact" | "default";

export const ROW_HEIGHT: Record<Density, string> = { compact: "32px", default: "36px" };

export function DataTable({
  density = "default",
  stickyHeader = false,
  flush = false,
  className,
  children,
}: {
  density?: Density;
  stickyHeader?: boolean;
  /**
   * The table fills a SectionCard edge to edge (pair with
   * `contentClassName="p-0"`), so it drops its own hairline and radius
   * and lets the card's carry the surface. Without this a titled table
   * draws two borders 16px apart.
   */
  flush?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-slot="data-table"
      data-density={density}
      style={{ "--row-h": ROW_HEIGHT[density] } as CSSProperties}
      className={cn(
        "w-full overflow-x-auto bg-card",
        flush ? "rounded-none border-0" : "rounded-card border border-border",
        // The sticky header draws its own rule as an inset shadow: a
        // border-bottom on a sticky <th> detaches in Chromium.
        stickyHeader && "[&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-1",
        className,
      )}
    >
      {children}
    </div>
  );
}
