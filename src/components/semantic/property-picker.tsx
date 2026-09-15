"use client";

import { CheckIcon } from "lucide-react";
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
import {
  derivedRowValue,
  highlightAfterChange,
  highlightBasis,
  highlightBasisChanged,
  initialHighlight,
  pickerRows,
} from "@/lib/picker-rows";
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
 * · `p-0 gap-0` on the content plus `rounded-none bg-transparent` on the
 *   Command root — `PopoverContent` already paints `rounded-card` +
 *   `p-3` + `gap-2.5` + `bg-popover` and cmdk's root paints `rounded-xl`
 *   + `bg-popover` again, so nesting them un-tuned gives a 12px radius
 *   inside a 10px one, 12px of dead padding, and 10px of air between the
 *   list and a `footer`. §10.8 says popovers are 10px, so the 12px loses.
 * · `max-h-(--radix-popover-content-available-height)`, with the CONTENT
 *   as the scroller: `overflow-y-auto` clips to the 10px radius exactly
 *   as `overflow-hidden` did. Radix flips a popover but never resizes it,
 *   and the peek's RemoveScroll and this popover's own leave nothing else
 *   that can scroll, so D's ~450px of list and calendar, opened from a
 *   trigger ~330px down a 667px phone, ran off the bottom of the screen
 *   with no way to reach the last weeks. `shrink-0` on the cmdk root
 *   keeps the flex column from squeezing the input and the list instead
 *   of scrolling; the list keeps its own `max-h-80`, so a long list still
 *   wheel-scrolls by itself, nested inside.
 * · `shouldFilter={false}` with our own matching — cmdk's scorer also
 *   RE-SORTS, which would scramble a group order that means something
 *   (states are ordered by `WorkflowState.rank`). With filtering off,
 *   cmdk's own `CommandEmpty` can never fire, hence `CommandEmptyState`
 *   — and, because a `role="status"` that appears together with its
 *   text is never announced, an ALWAYS-mounted sr-only status beside
 *   it that speaks the empty text for a query that matched nothing.
 * · `vimBindings={false}` — cmdk defaults it TRUE and its Ctrl+k means
 *   "previous item", shadowing the global ⌘K on Windows and Linux. The
 *   `Command` wrapper now defaults it false for every caller
 *   (`keymap.test.ts` pins that); it stays spelled out here, on the
 *   surface whose bug it was.
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
 * THREE OPTIONAL SEAMS, and where each one must live:
 *
 * · `derive` builds ONE row from the typed text (E's `90m`, D's
 *   `2031-03-14`). It renders first, ungrouped and unfiltered, so cmdk
 *   selects it as the member types; a fixed option with the same value
 *   is dropped, a disabled result counts as none, and the row's cmdk
 *   value is a reserved one that still commits the plain value
 *   (`picker-rows.ts` says why each of the three matters).
 * · `footer` renders non-list content AFTER the cmdk root, inside the
 *   popover (D's calendar). After, never inside: cmdk's root `onKeyDown`
 *   owns Enter, ArrowUp, ArrowDown, Home and End (never ArrowLeft or
 *   ArrowRight) for EVERY descendant, so a calendar inside `<Command>`
 *   would commit the highlighted row when the member pressed Enter on a
 *   day, and lose its week-to-week arrows. Inside the popover,
 *   `[data-slot="popover-content"]` keeps every single key inert.
 *   `footer` is handed `commit` — the exact select-and-close a row runs —
 *   so there is one commit path, not two. It is a flex child of the
 *   scrolling content, so its root must not shrink (no `overflow` of its
 *   own, as `CalendarGrid`'s has none).
 * · `selected` (slice 12) marks a MULTI property's applied rows (L): each
 *   wears the check and the sr-only `labels.current` words, while `value`
 *   stays null — so nothing is seeded, a bare Enter is inert, and the
 *   member steers or types before anything can commit. The contract is
 *   otherwise untouched: a pick still commits ONE row and closes, the
 *   island toggles that one row, and the picker never learns what a set
 *   is. A multi property has no "No …"/clear pair — every applied row is
 *   its own toggle, in the one order the list keeps.
 *
 * WHAT A BARE ENTER COMMITS: never a value the member did not choose.
 *
 * · The highlight is SEEDED on open (`initialHighlight`): `""` when the
 *   current row is the first enabled one, so cmdk lights it itself; the
 *   current value when it is enabled but not first; `NO_HIGHLIGHT` —
 *   nothing lit, Enter inert — when it is disabled. A property that can
 *   be empty therefore lists its current state as the FIRST row (the
 *   value with a check, or a checked "No …" row when unset) and its clear
 *   row LAST, under a DIFFERENT value from the unset row, so no refresh
 *   can turn a highlighted no-op into a clear.
 * · It is SETTLED AGAIN whenever `value` or the options change while the
 *   picker is open (`highlightAfterChange`), because the board's poll
 *   refreshes the peek underneath it. A highlight the member STEERED
 *   survives while its row is still theirs: still rendered, still
 *   enabled, in the same group, and not the old value's row — or it is
 *   the typed derived row. Anything else is RE-SEEDED (`reseedHighlight`)
 *   and counts as un-steered again: a highlight left on the old value's
 *   row wrote the member's Enter over a colleague's edit, and a `steered`
 *   that outlived its row would let Enter commit the row cmdk lit in its
 *   place. The query is not watched, so typing never re-seeds.
 * · And Enter is REFUSED unless the highlight is the current value or the
 *   member has steered since the seed, because cmdk can move the
 *   selection on its own (see `onKeyDown` in `PickerBody`).
 *
 * WHAT IS ANNOUNCED — less than the seeds were designed for, and that
 * was MEASURED in Chromium against cmdk 1.1.1, not read off its source.
 * cmdk renders `aria-activedescendant` from `selectedItemId`, which it
 * assigns only when its store's value changes. A row cmdk lights BY
 * ITSELF — the `""` seed's first-row pick on open, a typed derived row,
 * a re-pick after the lit row unmounts — gets that assignment inside
 * cmdk's own layout flush, from a DOM that has not re-rendered yet, so
 * the attribute stays unset or names the row lit before. A RE-SEED gets
 * no assignment at all: it reaches cmdk only through the controlled
 * `value`, which cmdk stores without touching the attribute, so after
 * one the attribute keeps naming the last row the member steered to — or
 * a node that has since left the DOM — until they steer again. Only the
 * member's own ArrowUp/ArrowDown/Home/End or a click set it right. So
 * no seed is announced until the member steers, and after a typed
 * derived row the attribute can name the row that was lit before it: a
 * RECORDED DEFECT (PLAN §0), whose fix is active-descendant wiring of
 * our own. What Enter acts on is `aria-selected`, never the attribute,
 * so none of this can change what is written. The current row also
 * carries `labels.current` as sr-only words, because its check is
 * aria-hidden and nothing else says which row it is.
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
  /** An id or enum token — NEVER a label, never empty, never containing
   *  whitespace (`pickerRows` throws: the picker's reserved cmdk values
   *  contain a space, which is what keeps every option clear of them).
   *  cmdk tracks selection as ONE string and marks every item whose value
   *  matches, so two rows sharing a value both light up and Enter fires
   *  the first in the DOM. */
  value: V;
  /** Already translated, or tenant text. The picker never translates. */
  label: string;
  icon?: React.ReactNode;
  /** Extra match text, never rendered. */
  keywords?: string;
  /** Translated heading. Options keep ARRAY order inside a group. */
  group?: string;
  /** Trailing slot — a count, a hint, D's resolved dates. The current row's
   *  check is the picker's own (drawn beside `labels.current`), never `meta`. */
  meta?: React.ReactNode;
  /** Non-selectable: shown for context, refused as a target. */
  disabled?: boolean;
  testId?: string;
};

/** Translated by the caller; the picker owns no namespace. */
type PickerLabels = {
  trigger: string;
  search: string;
  empty: string;
  /** Accessible name of the combobox and the listbox; defaults to `trigger`. */
  input?: string;
  /** Sr-only words on the fixed row whose value is the current one ("(current)").
   *  The check in `meta` is aria-hidden, so without these nothing SAYS which row it is. */
  current?: string;
};

/** The keys cmdk's root moves the selection with (`vimBindings` is off). */
const STEERING_KEYS = new Set(["ArrowUp", "ArrowDown", "Home", "End"]);

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
  derive,
  footer,
  selected,
}: {
  /** REQUIRED, both of them: the property's single key must be able to
   *  open this, so the state cannot live inside the component. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** REQUIRED. State a shared component must reflect is never a default.
   *  A change while the picker is open settles the highlight again (WHAT A BARE ENTER COMMITS). */
  value: V | null;
  options: readonly PickerOption<V>[];
  onSelect: (value: V) => void;
  /** The trigger's resting content — the value as text. */
  children: React.ReactNode;
  labels: PickerLabels;
  /** The single key that opens this — `aria-keyshortcuts` for AT. */
  hintKey?: string;
  disabled?: boolean;
  align?: "start" | "end";
  testId?: string;
  /** Merged after the rest box — e.g. a negative inset to sit flush in a `<dl>`. */
  className?: string;
  /** ONE row built from the typed query (E: "90m"; D: "2031-03-14"). Never called for a blank query.
   *  Rendered FIRST, ungrouped, never filtered, under a reserved cmdk value that still commits the
   *  plain one; a fixed option with the same value is dropped. A `disabled` result is treated as null
   *  (cmdk's first-row selection would skip it and Enter would commit the next row). Return null for
   *  text that is not a value — the empty state speaks. */
  derive?: (query: string) => PickerOption<V> | null;
  /** Non-list content AFTER the cmdk root, inside the popover. `commit` is the exact select-and-close
   *  a row runs. Its root must not shrink: the popover content is a scrolling flex column. */
  footer?: (commit: (value: V) => void) => React.ReactNode;
  /** A MULTI property's applied values (L). Each such row wears the check and `labels.current`; `value`
   *  stays null, so nothing is seeded, a bare Enter is inert, and the member steers or types. A pick still
   *  commits ONE row and closes — the contract is unchanged; only which rows are marked "current" is. The
   *  set is part of the highlight BASIS: a lit row whose membership flips underneath the member is re-seeded
   *  (`picker-rows.ts`), because a pick there is a toggle and would have gone the other way. */
  selected?: ReadonlySet<V>;
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
        className="max-h-(--radix-popover-content-available-height) w-64 max-w-[calc(100vw-2rem)] gap-0 overflow-x-hidden overflow-y-auto p-0"
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
          selected={selected}
          onSelect={onSelect}
          onOpenChange={onOpenChange}
          labels={labels}
          derive={derive}
          footer={footer}
        />
      </PopoverContent>
    </Popover>
  );
}

function PickerBody<V extends string>({
  options,
  value,
  selected,
  onSelect,
  onOpenChange,
  labels,
  derive,
  footer,
}: {
  options: readonly PickerOption<V>[];
  value: V | null;
  selected: ReadonlySet<V> | undefined;
  onSelect: (value: V) => void;
  onOpenChange: (open: boolean) => void;
  labels: PickerLabels;
  derive: ((query: string) => PickerOption<V> | null) | undefined;
  footer: ((commit: (value: V) => void) => React.ReactNode) | undefined;
}) {
  const [query, setQuery] = useState("");
  // The seed on open: `""`, the current value, or `NO_HIGHLIGHT` — see
  // `initialHighlight` for what each one makes a bare Enter do.
  const [highlight, setHighlight] = useState<string>(() => initialHighlight(options, value));
  // Whether the member has STEERED since the last seed — a navigation
  // key, or a keystroke in the search field. Read by `onKeyDown`.
  const [steered, setSteered] = useState(false);
  // What the highlight was last settled against: the value, and each
  // option's fields that decide whether and where its row renders. Never
  // the query — see `HighlightBasis`.
  const [basis, setBasis] = useState(() => highlightBasis(options, value, selected));

  // Grouped in FIRST-SEEN order, untouched within a group: the caller's
  // array order is the meaning (states arrive by rank).
  const rows = pickerRows(options, query, derive);

  // SETTLED DURING RENDER when the value or the options change under an
  // open picker (React's "adjusting state when a prop changes", never an
  // effect). The board polls and refreshes the peek underneath this list:
  // a highlight left on the old value's row wrote a bare Enter over a
  // colleague's change, and one discarded wholesale dropped a pick the
  // change had nothing to do with. `highlightAfterChange` keeps a steered
  // highlight whose row is still the member's, and re-seeds and
  // un-steers everything else.
  if (highlightBasisChanged(basis, options, value, selected)) {
    const next = highlightAfterChange(basis, { options, value, rows, selected }, { highlight, steered });
    setBasis(highlightBasis(options, value, selected));
    setHighlight(next.highlight);
    setSteered(next.steered);
  }

  const { derived, groups, empty } = rows;
  const derivedValue = derived ? derivedRowValue(derived.value) : null;

  // The ONE select-and-close: every row runs it, and `footer` is handed
  // it, so a non-list body cannot grow a second commit path.
  const commit = (next: V) => {
    onSelect(next);
    onOpenChange(false);
  };

  const name = labels.input ?? labels.trigger;
  // ONE comparison decides the check AND the sr-only words: the single
  // current value, or — for a multi property — membership of `selected`.
  const isCurrent = (v: V) => (selected ? selected.has(v) : v === value);

  return (
    <>
      <Command
        label={name}
        shouldFilter={false}
        vimBindings={false}
        disablePointerSelection
        value={highlight}
        onValueChange={setHighlight}
        // THE BELT under every seed: a bare Enter commits only the current
        // value (a no-op) or a row the member steered to. cmdk re-picks its
        // first enabled row BY ITSELF when the lit row unmounts — which a
        // refresh can do in the very commit that re-seeds — and in
        // controlled mode it writes that pick into its own store before
        // asking, so no `value` prop can take it back. A change that takes
        // the lit row away is always settled as a re-seed, which clears
        // `steered` in the same render, so that pick lands un-steered and
        // Enter on it is refused unless it is the current value. This
        // handler runs before cmdk's own switch, which skips a
        // defaultPrevented event, so refusing Enter here refuses the
        // dispatch itself. A click is never refused: it is aimed.
        onKeyDown={(e) => {
          if (STEERING_KEYS.has(e.key)) setSteered(true);
          else if (e.key === "Enter" && !steered && highlight !== value) e.preventDefault();
        }}
        className="shrink-0 rounded-none bg-transparent"
      >
        <CommandInput
          placeholder={labels.search}
          value={query}
          onValueChange={(next) => {
            setQuery(next);
            setSteered(true);
          }}
        />
        {/* cmdk names the listbox "Suggestions" unless told otherwise. */}
        <CommandList label={name}>
          {empty ? <CommandEmptyState>{labels.empty}</CommandEmptyState> : null}
          {derived && derivedValue ? (
            // No highlight code: typing runs cmdk's `setState("search")`,
            // which selects the first enabled DOM row — this one. Its cmdk
            // value is RESERVED (`derivedRowValue`), so the selection
            // string changes even when the text derives the value of the
            // row that was lit, and `aria-selected` moves to it through a
            // real selection change. It does NOT make
            // `aria-activedescendant` follow — see WHAT IS ANNOUNCED
            // above. It commits the plain value.
            <CommandItem
              key={derivedValue}
              value={derivedValue}
              data-testid={derived.testId}
              className="hover:bg-accent hover:text-accent-foreground"
              onSelect={() => commit(derived.value)}
            >
              {derived.icon}
              <span className="min-w-0 flex-1 truncate">{derived.label}</span>
              {derived.meta}
            </CommandItem>
          ) : null}
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
                  onSelect={() => commit(option.value)}
                >
                  {option.icon}
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {/* The current row's check is the PICKER's (slice 7),
                      drawn from the one comparison that also emits the
                      sr-only words for it, so the two can never disagree
                      — no island hands it a check through `meta`. The
                      words are a SIBLING of the label, both flex items,
                      so the option's name reads "1h 30m (current)" with
                      the space between. */}
                  {isCurrent(option.value) ? (
                    <>
                      {labels.current ? <span className="sr-only">{labels.current}</span> : null}
                      <CheckIcon className="size-3.5" aria-hidden="true" />
                    </>
                  ) : null}
                  {option.meta}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
      {/* ALWAYS mounted, so the text arriving is what gets announced. It
          speaks only for a typed query that matched nothing: the visible
          empty row is `role="presentation"` and silent. */}
      <span role="status" aria-live="polite" className="sr-only">
        {empty && query.trim() !== "" ? labels.empty : ""}
      </span>
      {footer?.(commit)}
    </>
  );
}
