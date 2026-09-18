"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Rows are 36px by default and 32px at compact density; the height
 * comes from --row-h, which <DataTable> sets and <Skeleton> reads, so
 * the loading and loaded shapes cannot drift apart.
 *
 * No zebra striping. A selected row is --accent fill PLUS a 2px inset
 * left border in --primary PLUS aria-selected — never tint alone.
 */
function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    // Not a scroll container: <DataTable> owns the horizontal scroll and
    // its gutter. Two nested `overflow-x:auto` boxes each reserved a
    // vertical scrollbar gutter they could never use, and every table in
    // the product sat 32px short of its card's right edge.
    <div data-slot="table-container" className="relative w-full">
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("", className)} {...props} />
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      // border-b-0, NOT border-0: `border-0` zeroes all four widths,
      // including the border-LEFT that visibilityRowCue() paints. The
      // last client-visible row of every table in the product was
      // therefore missing the safety-critical warm edge the legend
      // promises in words. Only the horizontal rule is dropped here.
      className={cn("[&_tr:last-child]:border-b-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t border-border bg-muted font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        // A FOCUSABLE row (the backlog's `J K`, UI.md §6) shows focus as
        // the standard OUTLINE (§9 — never a box-shadow ring: forced-colors
        // mode drops box-shadows, and engines differ on painting them on a
        // collapsed-border row), at `-outline-offset-6` rather than the
        // global +2 or a scroll container's -2. Measured from the border
        // edge inward, the left edge of a row is: 2px border, which is
        // `visibilityRowCue`'s client-visible mark; 2px `--primary` selected
        // bar (the inset shadow below); then the 2px outline at 4–6px. A -2
        // offset paints the outline OVER the cue, so a focused client-
        // visible row read as internal, and -4 paints it over the selected
        // bar; -6 sits beside both, and +2 would be clipped by the table
        // container's horizontal scroll and overlap the neighbouring rows.
        // Keyed on `:focus`, not `:focus-visible`: a row's focus only ever
        // arrives by key, by the list's own `focus()` or by a deliberate
        // click on its whitespace, and programmatic focus inherits the
        // previous element's focus-visible state in Firefox and WebKit —
        // a mouse-focused link followed by `J` would ring nothing there.
        "row-h border-b border-border transition-colors duration-(--dur-instant) ease-out scroll-mt-8 hover:bg-accent has-aria-expanded:bg-accent aria-selected:bg-accent aria-selected:shadow-[inset_2px_0_0_var(--primary)] data-[state=selected]:bg-accent data-[state=selected]:shadow-[inset_2px_0_0_var(--primary)] focus:outline-2 focus:-outline-offset-6 focus:outline-ring",
        className
      )}
      {...props}
    />
  )
}

/**
 * Column priority (UI.md §12: never a second implementation of a list).
 * A narrow table drops COLUMNS, not the table — one prop per column, no
 * parallel stacked-row renderer to drift from this one. The trailing
 * actions column is always `high`: an action a reader cannot reach is
 * the same as an action that does not exist.
 *
 * Each rung is a width of the TABLE — `<DataTable>`'s scroll box is the
 * `data-table` size container — never of the viewport (UI.md §10.12).
 * The rail is 224px, open by default from `md` up and collapsible by the
 * member, and a media query can see neither fact: at 768px the box was
 * 494px, narrower than `sm`, while `md:` switched the low columns ON —
 * measured, ten tables overflowed there and five put their row actions
 * past the box, and the backlog overflowed from 768px all the way to
 * ~1370px. Below `md` there is no rail, so `medium` (38rem = `sm` less the
 * page's two 16px gutters) and `low` (46rem = `md` less them) keep a phone
 * as it was, to the pixel for a flush table on the canvas (a bordered or
 * carded one reaches `medium` at 642px). `lower` (61.5rem) and `lowest`
 * (71rem) exist for the tables that need more than a phone rung to fit
 * (the backlog, client agreements), placed for real laptops: with a classic
 * 17px page scrollbar (computed — the harness's headless Chromium hides it,
 * a Windows browser does not), a 1280px window with the rail open (991px)
 * reaches `lower`, and a 1440px one with it open (1151px) or a 1280px one
 * with it collapsed (1167px) reaches `lowest`. Since the actions column is
 * PINNED (below), a rung no longer has to fit the widest content to keep a
 * row's verbs in view — a Swedish backlog row is ~21px wider than `lowest`'s
 * narrowest box and simply scrolls under the pinned column there — so the
 * rungs trade a little scroll at their very edge for more columns.
 * A `form`-width page never gives a table more than 670px, and a
 * `default`-width one caps it at 1030px, so a column that must render there
 * sits no higher than `medium` or `lower` respectively.
 *
 * A column with a priority renders only inside a `<DataTable>`: outside
 * one there is no container, the query never matches, and it stays hidden.
 */
type ColumnPriority = "high" | "medium" | "low" | "lower" | "lowest"

const PRIORITY: Record<ColumnPriority, string> = {
  high: "",
  medium: "hidden @min-[38rem]/data-table:table-cell",
  low: "hidden @min-[46rem]/data-table:table-cell",
  lower: "hidden @min-[61.5rem]/data-table:table-cell",
  lowest: "hidden @min-[71rem]/data-table:table-cell",
}

/**
 * The SAME rungs, for something that is not a column.
 *
 * Sometimes the thing that will not fit is inside a cell rather than
 * being a cell — the time week's status badges, which are `shrink-0`
 * `whitespace-nowrap` and so force their column exactly as a cell would.
 * Such an element wants the same widths, and the reason this exists is
 * that it was first written out by hand at its call site: a rung spelled
 * twice is a rung that can be re-measured in one place and not the
 * other, and the stop that would have caught it is exempt from the
 * overflow ratchet (review, 2026-09-18).
 *
 * `flex`, not `table-cell` — and the strings are COMPLETE class names on
 * purpose, never built by concatenation, because Tailwind scans source
 * text and a class assembled at runtime is a class that is never
 * generated. `high` is "" for the same reason `PRIORITY.high` is: it
 * always renders.
 */
export const SHOW_FROM: Record<ColumnPriority, string> = {
  high: "",
  medium: "hidden @min-[38rem]/data-table:flex",
  low: "hidden @min-[46rem]/data-table:flex",
  lower: "hidden @min-[61.5rem]/data-table:flex",
  lowest: "hidden @min-[71rem]/data-table:flex",
}

/**
 * THE PINNED COLUMN — the trailing actions column's `pinned` (UI.md §10.12).
 * Its cells are `position: sticky` at the scroll box's right edge, so a
 * row's verbs are in view however far a table scrolls: column priority
 * decides how MUCH scrolls, and pinning guarantees that the verbs never do.
 *
 * A sticky cell floats over the columns scrolling beneath it, so it must
 * be OPAQUE and still read as part of its row — hover, an open menu,
 * selection, and a tinted row (the time week's running entry) all paint
 * the ROW's background, which a cell does not inherit by default. Hence
 * three layers inside the cell's own stacking context (sticky always makes
 * one): the cell takes the row's colour (`bg-inherit`, which only its
 * pseudo-elements read), `::before` lays `--card` down as the opaque base,
 * and `::after` inherits the row's colour again over it — a translucent tint
 * composited onto the card exactly as the row's own cells show it. Both
 * layers sit at negative z-index, below the cell's content.
 *
 * The header cell needs none of that: it is already `bg-card`, and its
 * rule is an inset shadow painted with it. `data-pinned:z-2` outranks the
 * sticky-header variant's `z-1` and every pinned body cell at rest.
 *
 * Every pinned cell is its own layer, painted in document order — so the
 * NEXT row's opaque cell would cover the bottom of a focused ⋯ button's
 * ring, which sits 4px outside a 28px button and so 2px into its
 * neighbours on a 32px compact row (and the pinned header its top, on the
 * first row). `focus-within:z-3` lifts the cell holding focus above both.
 */
const PINNED_HEAD = "sticky right-0 data-pinned:z-2"
const PINNED_CELL =
  "sticky right-0 z-1 focus-within:z-3 bg-inherit before:absolute before:inset-0 before:-z-2 before:bg-card after:absolute after:inset-0 after:-z-1 after:bg-inherit"
/**
 * A focusable row's ring (`TableRow`: a 2px outline at -6px) is painted
 * with the row, and a pinned cell — a later, positioned layer — covers its
 * right-hand end, measured in the live page. The cell therefore draws that
 * end itself: the ring's top, right and bottom sides at the same 4–6px
 * inset, open on the left where the row's own ring runs underneath. Borders,
 * not a box-shadow, so forced-colors mode keeps it (§9). The 3.5px is
 * measured, not a typo: in a collapsed-border table a cell's padding box —
 * what an absolute child is placed against — sits half the rows' 1px rule
 * inside the row's box at the top and the bottom, so `inset-y-1` put this
 * ring half a pixel inside the row's (horizontally the two meet exactly).
 * The last row has no rule below it (`TableBody`'s `border-b-0`), so its
 * bottom is the whole 4px; a row under the backlog's top spacer (a bare
 * `<tr>` with no rule) is half a pixel out at the top, recorded, not fixed.
 */
const PINNED_RING =
  "pointer-events-none absolute inset-y-[3.5px] right-1 left-0 hidden border-2 border-l-0 border-ring [tr:focus>td>&]:block [tr:last-child>td>&]:bottom-1"

/**
 * A border-bottom on a sticky <th> detaches in Chromium, so the rule is
 * drawn as an inset box-shadow that rides along with the sticky box.
 */
function TableHead({
  className,
  priority = "high",
  pinned = false,
  ...props
}: React.ComponentProps<"th"> & {
  priority?: ColumnPriority
  /** The trailing actions column — see `PINNED_CELL`; pair it with the cells'. */
  pinned?: boolean
}) {
  return (
    <th
      data-slot="table-head"
      data-priority={priority}
      data-pinned={pinned || undefined}
      className={cn(
        "h-8 bg-card px-2 text-left align-middle eyebrow whitespace-nowrap text-muted-foreground hairline-b has-[[role=checkbox]]:pr-0",
        PRIORITY[priority],
        pinned && PINNED_HEAD,
        className
      )}
      {...props}
    />
  )
}

function TableCell({
  className,
  priority = "high",
  pinned = false,
  children,
  ...props
}: React.ComponentProps<"td"> & {
  priority?: ColumnPriority
  /** The trailing actions column — see `PINNED_CELL`; pair it with the header's. */
  pinned?: boolean
}) {
  return (
    <td
      data-slot="table-cell"
      data-priority={priority}
      data-pinned={pinned || undefined}
      className={cn(
        "px-2 py-1.5 align-middle whitespace-nowrap has-[[role=checkbox]]:pr-0",
        PRIORITY[priority],
        pinned && PINNED_CELL,
        className
      )}
      {...props}
    >
      {pinned ? <span aria-hidden="true" data-slot="pinned-ring" className={PINNED_RING} /> : null}
      {children}
    </td>
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  type ColumnPriority,
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
