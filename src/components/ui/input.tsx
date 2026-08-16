import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * 32px control, 1px --input boundary (3:1 — the boundary of an input is
 * non-text UI and carries a WCAG duty; --border does not). Placeholder
 * uses --muted-foreground, which is held at >= 4.5:1 because a
 * placeholder is text and SC 1.4.3 grants it no exemption.
 *
 * Focus moves the outline, never the border: a border swap reflows
 * nothing but reads as a size change at 13px.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-md border border-input bg-card px-2.5 py-1 text-base text-foreground transition-[border-color,background-color] duration-(--dur-instant) ease-out file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground hover:border-input-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:border-border disabled:bg-bg-disabled disabled:text-fg-disabled disabled:placeholder:text-fg-disabled aria-invalid:border-destructive md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Input }
