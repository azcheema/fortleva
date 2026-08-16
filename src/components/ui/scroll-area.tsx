import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Native scrolling, deliberately. The Radix overlay scrollbar was
 * replaced: it hides the OS scrollbar, which breaks scroll-anchoring,
 * loses the platform's own thumb affordances and cannot be reached by
 * assistive tech that drives the scroll container directly. `scrollbar-
 * width: thin` + `scrollbar-color` (set once on <html> in globals.css,
 * inherited here) gives a quiet thumb on every engine that matters, and
 * ::-webkit-scrollbar is not used at all.
 *
 * The API is kept so callers do not change: <ScrollArea> is the scroll
 * container, <ScrollBar> is now a no-op kept for source compatibility.
 */
function ScrollArea({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="scroll-area"
      className={cn("relative overflow-auto overscroll-contain", className)}
      {...props}
    >
      {children}
    </div>
  )
}

type ScrollBarProps = {
  className?: string
  orientation?: "vertical" | "horizontal"
}

function ScrollBar(props: ScrollBarProps) {
  void props
  return null
}

export { ScrollArea, ScrollBar }
