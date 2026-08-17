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
        "row-h border-b border-border transition-colors duration-(--dur-instant) ease-out scroll-mt-8 hover:bg-accent has-aria-expanded:bg-accent aria-selected:bg-accent aria-selected:shadow-[inset_2px_0_0_var(--primary)] data-[state=selected]:bg-accent data-[state=selected]:shadow-[inset_2px_0_0_var(--primary)]",
        className
      )}
      {...props}
    />
  )
}

/**
 * Column priority (UI.md §12: never a second implementation of a list).
 * A phone drops COLUMNS, not the table — one prop per column, no
 * parallel stacked-row renderer to drift from this one. The trailing
 * actions column is always `high`: an action a reader cannot reach is
 * the same as an action that does not exist.
 */
type ColumnPriority = "high" | "medium" | "low"

const PRIORITY: Record<ColumnPriority, string> = {
  high: "",
  medium: "hidden sm:table-cell",
  low: "hidden md:table-cell",
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
