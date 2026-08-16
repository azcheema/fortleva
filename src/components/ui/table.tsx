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
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto scrollbar-gutter-stable"
    >
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
      className={cn("[&_tr:last-child]:border-0", className)}
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
 * A border-bottom on a sticky <th> detaches in Chromium, so the rule is
 * drawn as an inset box-shadow that rides along with the sticky box.
 */
function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-8 bg-card px-2 text-left align-middle text-2xs font-semibold tracking-[0.04em] whitespace-nowrap text-muted-foreground uppercase hairline-b has-[[role=checkbox]]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "px-2 py-1.5 align-middle whitespace-nowrap has-[[role=checkbox]]:pr-0",
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
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
