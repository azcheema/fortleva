"use client"

import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { isReturningFocus } from "@/components/ui/use-focus-return"
import { cn } from "@/lib/utils"

function TooltipProvider({
  delayDuration = 300,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

/**
 * A focus RETURN never opens the tooltip. Radix opens it on any focus a
 * pointer did not cause, and a dialog closing (`useFocusReturn`) puts
 * focus back on the element it was opened from — often a tooltip-wrapped
 * button, such as a row's Download or the header's help button. The
 * tooltip's layer then took the member's next Escape. Radix runs the
 * caller's `onFocus` first and skips its own open once the event is
 * default-prevented, so refusing that one event here covers every
 * trigger in the app, not only the ones someone remembered.
 */
function TooltipTrigger({
  onFocus,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      onFocus={(event) => {
        onFocus?.(event)
        if (isReturningFocus()) event.preventDefault()
      }}
      {...props}
    />
  )
}

/**
 * Inverted surface, 300ms delay. The text must be IDENTICAL to the
 * trigger's aria-label — a tooltip that paraphrases the label reads as
 * two different controls to a screen-reader user.
 */
function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 inline-flex w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin) items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1.5 text-xs text-background duration-(--dur-fast) ease-entrance has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 data-closed:duration-(--dur-instant)",
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2 translate-y-[calc(-50%-1px)] rotate-45 rounded-[1px] bg-foreground fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
