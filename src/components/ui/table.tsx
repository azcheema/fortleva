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
 * (74rem) exist for the tables that need more than a phone rung to fit
 * (the backlog, client agreements). Both are calibrated to SWEDISH
 * content, measured (the product's first locale, and wider than English in
 * every placeholder these tables show), and to a classic 17px page
 * scrollbar, computed rather than measured (the harness's headless Chromium
 * hides it, a Windows browser does not): so a 1280px laptop with the rail
 * open (991px with the scrollbar) still reaches `lower`, while `lowest`
 * needs ~1456px with the rail open (~1473 with the scrollbar), or the rail
 * collapsed on a window of ~1297px or more — a 1440px window with the rail
 * open shows the backlog's eight, and so does 1280 with it collapsed and a
 * scrollbar (1167px).
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
  lowest: "hidden @min-[74rem]/data-table:table-cell",
}

/**
 * A border-bottom on a sticky <th> detaches in Chromium, so the rule is
 * drawn as an inset box-shadow that rides along with the sticky box.
 */
function TableHead({
  className,
  priority = "high",
  ...props
}: React.ComponentProps<"th"> & { priority?: ColumnPriority }) {
  return (
    <th
      data-slot="table-head"
      data-priority={priority}
      className={cn(
        "h-8 bg-card px-2 text-left align-middle eyebrow whitespace-nowrap text-muted-foreground hairline-b has-[[role=checkbox]]:pr-0",
        PRIORITY[priority],
        className
      )}
      {...props}
    />
  )
}

function TableCell({
  className,
  priority = "high",
  ...props
}: React.ComponentProps<"td"> & { priority?: ColumnPriority }) {
  return (
    <td
      data-slot="table-cell"
      data-priority={priority}
      className={cn(
        "px-2 py-1.5 align-middle whitespace-nowrap has-[[role=checkbox]]:pr-0",
        PRIORITY[priority],
        className
      )}
      {...props}
    />
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
