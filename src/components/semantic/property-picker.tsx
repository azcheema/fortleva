"use client";

import { useState } from "react";

import {
  Command,
  CommandEmptyState,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { restBoxClass } from "@/lib/control-classes";
import { matchesQuery } from "@/lib/text-match";
import { cn } from "@/lib/utils";

/**
 * `<PropertyPicker>` — the one control for every WORK-ITEM property
 * (UI.md §5.2): a popover with a type-ahead list, opened by a click or
 * by the property's single key, committing on Enter or click.
 *
 * It is Mandate 1's sibling (§5.11): the rest state IS the value as
 * text, in a box geometrically identical to the control it becomes, and
 * the popover is the editor. `InlineEdit` stays the control for free
 * text and record properties; a §5.2 property is always this.
 *
 * EVERY non-obvious prop below is load-bearing, and each answers a
 * hazard that would otherwise be rediscovered at four call sites when
 * `P E D V M L` land:
 *
 * · `<Popover modal>` — the item peek's overlay mounts `RemoveScroll`
 *   with `shards: [contentRef]`, which preventDefaults every wheel
 *   event outside the lock. A NON-modal popover inside the peek would
 *   have a list a mouse could not scroll. `modal` gives the popover its
 *   own RemoveScroll, and puts it above the sheet in the single shared
 *   dismissable-layer Set (there is exactly one
 *   `@radix-ui/react-dismissable-layer` in `.pnpm`; popover and dialog
 *   both symlink to it — which is what makes the Escape order below a
 *   fact rather than a hope).
 * · `p-0 overflow-hidden` on the content plus `rounded-none
 *   bg-transparent` on the Command root — `PopoverContent` already
 *   paints `rounded-card` + `p-3` + `bg-popover` and cmdk's root paints
 *   `rounded-xl` + `bg-popover` again, so nesting them un-tuned gives a
 *   12px radius inside a 10px one and 12px of dead padding. §10.8 says
 *   popovers are 10px, so the 12px loses.
 * · `shouldFilter={false}` with our own matching — cmdk's scorer also
 *   RE-SORTS, which would scramble a group order that means something
 *   (states are ordered by `WorkflowState.rank`). With filtering off,
 *   cmdk's own `CommandEmpty` can never fire, hence `CommandEmptyState`.
 * · `vimBindings={false}` — cmdk defaults it TRUE and its Ctrl+k means
 *   "previous item", shadowing the global ⌘K on Windows and Linux.
 * · `disablePointerSelection` — otherwise merely moving the mouse
 *   across the list re-highlights a row, and Enter then commits a
 *   property change the member never aimed at. (The palette shipped the
 *   navigation-flavoured version of this bug once.)
 * · NEVER `forceMount` — inside the sheet, `hideOthers` walks once on
 *   open and the node would stay `aria-hidden` for the sheet's whole
 *   life.
 * · The focus ring is `-outline-offset-2`, NEGATIVE: the peek is
 *   `overflow-y-auto` and clips a positive offset. A `box-shadow` ring
 *   is forbidden outright (§9).
 * · No local motion rule. `globals.css` already clamps
 *   `prefers-reduced-motion` to `1ms`, deliberately not `animation:
 *   none` — with none, Radix exits never fire `animationend` and the
 *   layer stays mounted forever.
 *
 * NO TOOLTIP ON THE TRIGGER, and that is a measured decision rather
 * than an omission. Radix opens a tooltip on FOCUS, and Radix returns
 * focus to this trigger when the picker closes — so the tooltip is open
 * the instant the popover shuts, its dismissable layer is then the
 * highest one, and the member's next Escape is spent closing a tooltip
 * they never asked for. The key is already advertised three other ways
 * (the `?` overlay, the ⌘K "On this page" row, and `aria-keyshortcuts`
 * below), so the tooltip was the one channel that cost something.
 *
 * FOCUS AND ESCAPE, stated once so no caller invents its own:
 * opening autofocuses `CommandInput`, which is an `<input>` — so
 * `isEditableTarget` deadens every global single key while the picker
 * is open, with `[data-slot="command"]` in `SUPPRESS_SELECTOR` as a
 * second belt. There is NO hand-written Escape handler anywhere in this
 * component, and there must never be one: Radix dismisses the highest
 * layer, which is the picker, leaving the peek open; a second Escape
 * closes the peek. On close Radix returns focus to the trigger — which
 * is why the trigger must be a real `<button>` — so the key reopens it.
 */

export type PickerOption<V extends string> = {
  /** An id or enum token — NEVER a label. cmdk tracks selection as ONE
   *  string and marks every item whose value matches, so two rows
   *  sharing a value both light up and Enter fires the first in the DOM. */
  value: V;
  /** Already translated, or tenant text. The picker never translates. */
  label: string;
  icon?: React.ReactNode;
  /** Extra match text, never rendered. */
  keywords?: string;
  /** Translated heading. Options keep ARRAY order inside a group. */
  group?: string;
  /** Trailing slot — the current-value check, a count, a hint. */
  meta?: React.ReactNode;
  /** Non-selectable: shown for context, refused as a target. */
  disabled?: boolean;
  testId?: string;
};

export function PropertyPicker<V extends string>({
  open,
  onOpenChange,
  value,
  options,
  onSelect,
  children,
  labels,
  hintKey,
  disabled = false,
  align = "start",
  testId,
  className,
}: {
  /** REQUIRED, both of them: the property's single key must be able to
   *  open this, so the state cannot live inside the component. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** REQUIRED. State a shared component must reflect is never a default. */
  value: V | null;
  options: readonly PickerOption<V>[];
  onSelect: (value: V) => void;
  /** The trigger's resting content — the value as text. */
  children: React.ReactNode;
  /** Translated by the caller; the picker owns no namespace. */
  labels: { trigger: string; search: string; empty: string };
  /** The single key that opens this — `aria-keyshortcuts` for AT. */
  hintKey?: string;
  disabled?: boolean;
  align?: "start" | "end";
  testId?: string;
  /** Merged after the rest box — e.g. a negative inset to sit flush in a `<dl>`. */
  className?: string;
}) {
  const trigger = (
    <button
      type="button"
      data-slot="property-picker"
      data-testid={testId}
      disabled={disabled}
      aria-label={labels.trigger}
      aria-keyshortcuts={hintKey}
      className={cn(
        restBoxClass({ fit: true }),
        "border-transparent bg-transparent text-start",
        "hover:border-input hover:bg-accent",
        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        "disabled:cursor-not-allowed disabled:text-fg-disabled disabled:hover:border-transparent disabled:hover:bg-transparent",
        className,
      )}
    >
      {children}
    </button>
  );

  return (
    <Popover
      modal
      open={open}
      onOpenChange={onOpenChange}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align={align}
        collisionPadding={16}
        className="w-64 max-w-[calc(100vw-2rem)] overflow-hidden p-0"
      >
        {/* The list's own state lives in a child that exists only while
            the popover is OPEN. Radix unmounts `PopoverContent` on close
            (there is no `forceMount` here, deliberately), so a fresh
            query and a fresh highlight on every open are a consequence
            of the tree rather than a reset anyone has to remember —
            including for a programmatic open, where Radix never calls
            `onOpenChange` at all because the popover is controlled and
            a property's single key sets `open` directly. */}
        <PickerBody
          options={options}
          value={value}
          onSelect={onSelect}
          onOpenChange={onOpenChange}
          labels={labels}
        />
      </PopoverContent>
    </Popover>
  );
}

function PickerBody<V extends string>({
  options,
  value,
  onSelect,
  onOpenChange,
  labels,
}: {
  options: readonly PickerOption<V>[];
  value: V | null;
  onSelect: (value: V) => void;
  onOpenChange: (open: boolean) => void;
  labels: { trigger: string; search: string; empty: string };
}) {
  const [query, setQuery] = useState("");
  // Seeded to the current value ONLY when that value is selectable.
  // `StateField` deliberately lists the item's current state disabled
  // when it is not a legal target (TRIAGE, or a gated Done under a
  // non-approver) — and cmdk attaches its select listener only to
  // ENABLED items, so highlighting a disabled one would mark it
  // `aria-selected`, make it the input's `aria-activedescendant`, and
  // leave Enter doing nothing at all.
  const [highlight, setHighlight] = useState<string>(() => {
    const current = options.find((o) => o.value === value);
    if (current && !current.disabled) return current.value;
    return options.find((o) => !o.disabled)?.value ?? "";
  });

  const shown = options.filter((o) => matchesQuery(`${o.label} ${o.keywords ?? ""}`, query));

  // Grouped in FIRST-SEEN order, and untouched within a group: the
  // caller's array order is the meaning (states arrive by rank).
  const groups: { heading: string | undefined; options: PickerOption<V>[] }[] = [];
  for (const option of shown) {
    const last = groups[groups.length - 1];
    if (last && last.heading === option.group) last.options.push(option);
    else groups.push({ heading: option.group, options: [option] });
  }

  return (
        <Command
          label={labels.trigger}
          shouldFilter={false}
          vimBindings={false}
          disablePointerSelection
          value={highlight}
          onValueChange={setHighlight}
          className="rounded-none bg-transparent"
        >
          <CommandInput placeholder={labels.search} value={query} onValueChange={setQuery} />
          <CommandList>
            {shown.length === 0 ? <CommandEmptyState>{labels.empty}</CommandEmptyState> : null}
            {groups.map((group, i) => (
              <CommandGroup key={group.heading ?? `:${i}`} heading={group.heading}>
                {group.options.map((option) => (
                  <CommandItem
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                    data-testid={option.testId}
                    // `disablePointerSelection` stops cmdk moving the
                    // SELECTION on hover — correctly, or an idle cursor
                    // would change what Enter commits — but it also
                    // leaves the rows inert under the pointer. A hover
                    // surface restores the affordance without moving the
                    // selection, and deliberately without the
                    // `data-selected` left bar, so a mouse user can see
                    // that the hovered row and the Enter target differ.
                    className="hover:bg-accent hover:text-accent-foreground"
                    onSelect={() => {
                      onSelect(option.value);
                      onOpenChange(false);
                    }}
                  >
                    {option.icon}
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.meta}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
  );
}
