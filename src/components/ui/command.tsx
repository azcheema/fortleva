"use client"

import * as React from "react"
import { Command as CommandPrimitive } from "cmdk"

import { cn } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useFocusReturn } from "@/components/ui/use-focus-return"
import { SearchIcon } from "lucide-react"

/**
 * The cmdk root. `vimBindings` defaults to FALSE here, where cmdk
 * defaults it TRUE: its Ctrl+J/K/N/P move the highlight, and Ctrl+K as
 * "previous item" shadows the global ⌘K on Windows and Linux inside
 * every list. This is the only file that imports cmdk, so one default
 * here fixes it by construction for every caller, the next one
 * included — `src/lib/keymap.test.ts` pins both halves.
 */
function Command({
  className,
  vimBindings = false,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      vimBindings={vimBindings}
      className={cn(
        "flex size-full flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground",
        className
      )}
      {...props}
    />
  )
}

/**
 * Sits at the top third, 12px radius, --shadow-2, no padding of its own.
 *
 * FOCUS GOES BACK WHERE IT CAME FROM. No caller opens this from a
 * `DialogTrigger`: the palette opens from ⌘K and two header buttons,
 * MovePicker from a card's `S`. On close Radix calls `preventDefault()`
 * and focuses the TRIGGER, and with no trigger that focuses nothing, so
 * focus fell to <body>. No suppression guard covers <body>, so every
 * single key then acted behind whatever layer was still open underneath.
 * Two examples: ⌘K from a due-date day, Escape, `p` stacked a second
 * picker on the first; Ctrl+K inside MovePicker, Escape, `c` opened a
 * create field behind the modal.
 *
 * So the element that had focus when it OPENED — or, when it opened from
 * inside another such dialog that was already closing, THAT dialog's
 * origin (`useFocusReturn`) — is refocused when it closes, but only while
 * that still makes sense:
 *  · the element must still be in the document. A remounted one is
 *    disconnected and skipped; the board hands focus to a moved card's
 *    NEW node itself.
 *  · focus must have nowhere better to be. Whatever has already taken it
 *    by the time Radix asks keeps it: the board's card, or the picker a
 *    palette row opened a frame later.
 *
 * It is captured in `onOpenAutoFocus`, which Radix dispatches only while
 * focus is still OUTSIDE the content, so NO CHILD MAY USE `autoFocus`.
 * React focuses such an element during commit, before Radix's mount
 * effect runs, and the event is then never sent. FocusScope focuses the
 * first tabbable element (the search box) without it.
 * `src/lib/keymap.test.ts` pins that.
 */
function CommandDialog({
  title,
  description,
  children,
  className,
  showCloseButton = false,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  /** Screen-reader title/description — translated by the caller. */
  title: string
  description: string
  className?: string
  showCloseButton?: boolean
  /** Runs after the focus origin is recorded. */
  onOpenAutoFocus?: React.ComponentProps<typeof DialogContent>["onOpenAutoFocus"]
  /** Runs FIRST; `preventDefault()` in it to place focus yourself. */
  onCloseAutoFocus?: React.ComponentProps<typeof DialogContent>["onCloseAutoFocus"]
}) {
  // The rule lives in ONE hook, shared with the `?` overlay and the
  // shell's More sheet — the other dialogs nothing opens from a trigger.
  const focusReturn = useFocusReturn({ onOpenAutoFocus, onCloseAutoFocus })
  return (
    <Dialog {...props}>
      <DialogContent
        className={cn(
          "top-1/3 translate-y-0 overflow-hidden rounded-xl p-0 shadow-(--shadow-2) sm:max-w-lg",
          className
        )}
        showCloseButton={showCloseButton}
        {...focusReturn}
      >
        {/* The sr-only header lives INSIDE DialogContent. Radix labels
            the dialog by a context counter rather than by subtree, so it
            was labelled correctly either way — but DialogHeader is a
            plain div while only DialogContent is mounted-on-open, so
            outside it put two hidden-but-accessible nodes (an <h2> and a
            <p>) on every authed page whether the palette was open or
            not. Inside, their lifetime is the dialog's.

            THE cmdk ROOT IS THE CALLER'S. It is not rendered here on
            purpose: <Command> owns `shouldFilter`, which both filters
            AND re-sorts its items by fuzzy score — right for a
            navigation list, wrong for server-ranked results — so the
            surface that knows which it is must choose. Both callers
            render their own; command-palette.tsx forgot to, and the
            palette threw `Cannot read properties of undefined (reading
            'subscribe')` from cmdk's useSyncExternalStore the instant it
            opened. e2e/palette.spec.ts is the guard. */}
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}

/** 44px input row with a single hairline underneath — no nested field. */
function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div
      data-slot="command-input-wrapper"
      className="flex h-11 items-center gap-2 border-b border-border px-3"
    >
      <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "h-full w-full bg-transparent text-sm text-foreground outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:text-fg-disabled",
          className
        )}
        {...props}
      />
    </div>
  )
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        "max-h-80 scroll-py-1 overflow-x-hidden overflow-y-auto p-1 outline-none",
        className
      )}
      {...props}
    />
  )
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn("py-8 text-center text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

/**
 * The empty row for callers that own their own filtering.
 *
 * `CommandEmpty` cannot fire with `shouldFilter={false}` — cmdk sets its
 * filtered count to the number of MOUNTED items, so the string is
 * unreachable. Every such caller therefore had to hand-write this div;
 * this is that div, once, so the next picker does not make a third copy.
 */
function CommandEmptyState({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="command-empty-state"
      role="presentation"
      className={cn("px-3 py-6 text-center text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden text-foreground **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:eyebrow **:[[cmdk-group-heading]]:text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

/** Highlight is --accent plus a 2px --primary left bar: two channels, never tint alone. */
function CommandItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "group/command-item relative flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:text-fg-disabled data-selected:bg-accent data-selected:text-accent-foreground data-selected:shadow-[inset_2px_0_0_var(--primary)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg]:text-muted-foreground data-selected:[&_svg]:text-foreground",
        className
      )}
      {...props}
    >
      {children}
    </CommandPrimitive.Item>
  )
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "num-id ml-auto font-mono text-2xs text-muted-foreground group-data-selected/command-item:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandEmptyState,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
}
