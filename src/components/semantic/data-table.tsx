import { useTranslations } from "next-intl";
import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

import { ScrollFade } from "./scroll-fade";

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
 *
 * The scroll box is a NAMED, FOCUSABLE region. A scroll container that
 * only a mouse can reach is content that a keyboard user cannot read,
 * and an unnamed one is announced as "region" with no clue what it
 * holds. The right-edge fade says the content continues; column
 * priority (`TableHead priority`) is what actually shortens it.
 */
export type Density = "compact" | "default";

export const ROW_HEIGHT: Record<Density, string> = { compact: "32px", default: "36px" };

export function DataTable({
  density = "default",
  stickyHeader = false,
  flush = false,
  scrollLabel,
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
  /** Names the scroll region, from t(). Defaults to the generic noun. */
  scrollLabel?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const t = useTranslations("common");

  return (
    <div className="relative w-full">
      <div
        data-slot="data-table"
        data-density={density}
        role="region"
        tabIndex={0}
        aria-label={scrollLabel ?? t("table")}
        style={{ "--row-h": ROW_HEIGHT[density] } as CSSProperties}
        className={cn(
          "w-full overflow-x-auto bg-card focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
          flush
            ? // Flush means the CARD owns the surface — and the card's
              // 16px padding, which the table must match or its first
              // column hangs 8px left of the title above it.
              "rounded-none border-0 [&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4"
            : "rounded-card border border-border",
          // An <InlineEdit> at table density is a 28px box; without this
          // the cell's 6px padding pushes the row past its --row-h.
          "[&_td:has([data-slot=inline-edit])]:py-0.5 [&_td:has([data-slot=inline-edit-field])]:py-0.5",
          // The sticky header draws its own rule as an inset shadow: a
          // border-bottom on a sticky <th> detaches in Chromium.
          stickyHeader && "[&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-1",
          className,
        )}
      >
        {children}
      </div>
      <ScrollFade />
    </div>
  );
}
