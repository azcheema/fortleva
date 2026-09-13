import { cn } from "@/lib/utils";

/**
 * The §5.11 resting control box, shared by `InlineEdit`'s rest button
 * and `PropertyPicker`'s trigger — the two controls whose rest state IS
 * the value as text (Founder Mandate 1).
 *
 * It lives in `lib` rather than being exported from `inline-edit.tsx`
 * because that module is `"use client"`, and a client module's exported
 * constant interpolated into a SERVER component's `className` becomes a
 * throwing client reference — the standing trap, and the same reason
 * `src/lib/work-view/params.ts` carries no directive. Keeping the
 * geometry here means slice 6's four pickers cannot each invent their
 * own.
 *
 * The output is byte-identical to the string `inline-edit.tsx` carried
 * before it moved: do not tidy a class, a value or an order here, or
 * every InlineEdit stop in the visual sweep shifts.
 */
export const restBoxClass = (o: {
  density?: "default" | "table";
  fit?: boolean;
  align?: "start" | "end";
}): string =>
  cn(
    "flex min-w-0 items-center gap-1.5 rounded-md border bg-clip-padding px-2.5 text-sm",
    o.fit ? "w-fit max-w-full" : "w-full",
    o.density === "table" ? "h-7" : "h-8",
    o.align === "end" && "justify-end text-right",
  );

/**
 * One day of `CalendarGrid` (UI.md §9). Lives here, directive-free, for
 * the same reason `restBoxClass` does.
 *
 * · rest — `text-foreground` (≥ 4.5 on `--popover`); outside the month
 *   `text-muted-foreground`, never an opacity.
 * · hover — `bg-accent`, and only for an UNSELECTED day, so hovering
 *   never erases the selection.
 * · focus — a 2px `outline-ring` at a NEGATIVE offset: the popover is
 *   `overflow-hidden` and would clip a positive one. A negative ring
 *   covers the day's own 1px border and the outer pixel of its fill.
 * · selected — brand-tone fill + tone text + weight + a
 *   `--tone-brand-line` border, plus `aria-selected` on the cell. The
 *   LINE is the selection's only boundary of ≥ 3:1 (`contrast.test.ts`
 *   gates every `--tone-*-line` on `--popover`): the tint alone is about
 *   1.02:1 on the dark popover, fainter than the hover fill, so without
 *   it a hovered day read as the selected one. But at the default hue
 *   the line is the ring's own indigo, and a focused selected day — the
 *   first day Tab reaches whenever a date is set — read only as its
 *   border thickening by 1px. So `focus-visible:border-transparent`:
 *   while focused the line steps aside and the ring lands wholly on
 *   `--tone-brand-bg` ("--ring is >= 3:1 on --tone-brand-bg"). Never
 *   `bg-primary`, where the ring would vanish into the fill.
 * · today — an UNDERLINE plus `aria-current="date"`: a shape cue that
 *   survives on the selected day and that the ring never covers, where a
 *   "today" border would sit exactly under the ring and a fill would be
 *   the same slate as hover.
 */
export const calendarDayClass = (o: { outside: boolean; today: boolean; selected: boolean }): string =>
  cn(
    "inline-flex size-7 items-center justify-center rounded-md border border-transparent text-sm num",
    "transition-colors duration-(--dur-instant) ease-out",
    "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
    o.selected
      ? "border-(--tone-brand-line) bg-(--tone-brand-bg) font-semibold text-(--tone-brand-fg) focus-visible:border-transparent"
      : cn("hover:bg-accent hover:text-accent-foreground", o.outside ? "text-muted-foreground" : "text-foreground"),
    o.today && "underline decoration-2 underline-offset-4",
  );
