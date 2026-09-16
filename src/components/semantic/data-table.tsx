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
 *
 * The scroll box is also the `data-table` SIZE CONTAINER that column
 * priority queries: whether a column fits is a question about this box,
 * which the rail narrows and a viewport query cannot see (`PRIORITY` in
 * `@/components/ui/table` has the measurement). Its width comes from its
 * parent, never its content, so the inline-size containment costs nothing.
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
          // `peer`: the region's focus ring is drawn by the overlay below,
          // not by this box's own outline — a PINNED actions column is a
          // later, positioned layer and covered the ring's right side.
          "peer @container/data-table w-full overflow-x-auto bg-card focus-visible:outline-none",
          flush
            ? // Flush means the CARD owns the surface — and the card's
              // 16px padding, which the table must match or its first
              // column hangs 8px left of the title above it.
              "rounded-none border-0 [&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4"
            : "rounded-card border border-border",
          // THE ROW IS ITS --row-h, and cells are `align-middle`, so
          // vertical cell padding buys nothing visually — it only acts as
          // a floor that taller content pushes through. 6px of it turned
          // a 28px control (an <InlineEdit> at table density, a
          // <RowActions> trigger, a <MemberAvatar>) into a 40px row and a
          // 22px chip into a 34px compact row: the density promise
          // broken by padding rather than by content. 2px leaves a 32px
          // budget in a 36px row and 28px in a compact one, which is
          // every in-row object the product has.
          "[&_td]:py-0.5",
          // The sticky header draws its own rule as an inset shadow: a
          // border-bottom on a sticky <th> detaches in Chromium.
          stickyHeader && "[&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-1",
          className,
        )}
      >
        {children}
      </div>
      <ScrollFade />
      {/* The scroll region's focus ring, as its own layer above the pinned
          column (`z-3`, the pinned cells' ceiling) — the same 2px `--ring`
          outline at -2px the box drew on itself before columns were pinned. */}
      <span
        aria-hidden="true"
        data-slot="data-table-focus"
        className={cn(
          "pointer-events-none absolute inset-0 z-3 hidden outline-2 -outline-offset-2 outline-ring peer-focus-visible:block",
          !flush && "rounded-card",
        )}
      />
    </div>
  );
}
