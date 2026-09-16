"use client";

import { useFormatter, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { LABEL_CHIP_CAP, splitLabelChips, type LabelSurface } from "@/lib/work-view";
import { cn } from "@/lib/utils";
import type { LabelEntry } from "@/modules/work";

/**
 * A task's labels as chips, on the board card and the backlog row
 * (`display.labels`, UI.md §5.3) — the ONE renderer for both, so the two
 * surfaces can never disagree about which names a task wears or in what
 * order.
 *
 * NEUTRAL OUTLINE `Badge`s, and that is a pin, not a default (UI.md §5.2
 * slice 12): `Label.color` is a design-token name nothing writes yet, and
 * a chip is IDENTITY, never status (§10.4) — a coloured label chip beside
 * the visibility badge would put a second meaning on the one filled warm
 * pill that means "Client can see". The rail's chips
 * (`item-panel/labels-field.tsx`) are the same `variant="outline"`, so a
 * label looks the same wherever it is read — but they are deliberately
 * NOT this component: the rail is the EDITOR, so it shows every applied
 * label with no cap and no fold (a picker that hid two of your five
 * labels behind a count would be unusable), it lives inside a picker
 * trigger whose own `title` and `aria-label` already speak the set, and
 * its chips carry the `(applied)` semantics of the picker's `selected`
 * seam. A third `surface` would have had to turn all of that off.
 *
 * INTERNAL-ONLY. A label is on the never-list (UI.md §11) and both
 * callers are member-plane surfaces; nothing here is reachable from the
 * portal, whose task list gets its own projection.
 *
 * WHAT THE SURFACE DECIDES is the whole difference, which is why it is
 * ONE prop: the cap (`LABEL_CHIP_CAP`), whether chips may wrap, and how
 * much of their container they may take. A `"row"` shares the backlog's
 * title cell inside a `--row-h` the craft audit measures, so it may not
 * wrap, it is `shrink-0` (it takes its content width and the title's
 * `w-full` field shrinks around it), and it may never exceed HALF the
 * cell — a task must not lose its title to its labels. A `"card"` is its
 * own block on the board card, so it wraps and takes the full width.
 *
 * A `"row"` CALLER OWES ONE THING: the flex row it sits in must have a
 * definite width and be out of its table column's intrinsic sizing
 * (`w-full contain-inline-size`, as `backlog-table.tsx`'s title cell
 * has). Without it `max-w-1/2` cannot resolve while the table sizes its
 * columns, the chips' full width becomes the column's floor, and long
 * label names push the table past its scroll box — measured, not
 * assumed (UI.md §5.3a).
 *
 * Both carry the sr-only property name: neither surface has a column
 * header to say "Labels" for them.
 */
export function LabelChips({
  labels,
  surface,
  className,
}: {
  labels: readonly LabelEntry[];
  surface: LabelSurface;
  className?: string;
}) {
  const t = useTranslations("projects.workView");
  const format = useFormatter();
  if (labels.length === 0) return null;

  const { shown, hidden } = splitLabelChips(labels, LABEL_CHIP_CAP[surface]);
  // The folded names, spelled once and in the VIEWER's language ("Mitt and
  // Zeta", "Mitt och Zeta" — never a hard-coded comma list): the `+n`
  // chip's tooltip for a mouse and its sr-only words for a reader.
  const hiddenNames = format.list(hidden.map((l) => l.name));

  return (
    <span
      data-slot="label-chips"
      data-testid="label-chips"
      data-surface={surface}
      className={cn(
        "flex min-w-0 items-center gap-1",
        surface === "card" ? "flex-wrap" : "max-w-1/2 shrink-0 overflow-hidden",
        className,
      )}
    >
      <span className="sr-only">{t("labels.aria")}</span>
      {shown.map((l) => (
        <Badge
          key={l.id}
          variant="outline"
          data-label={l.id}
          // `Badge` is `shrink-0 whitespace-nowrap`; a NAME chip must be
          // able to shrink instead, or the group's half-cell cap would
          // CLIP the last chip mid-word rather than truncate it. The
          // `title` is what a mouse reads when it does truncate — the
          // identifying-column pattern (UI.md §10.12).
          className="min-w-0 shrink"
          title={l.name}
        >
          <span className="truncate">{l.name}</span>
        </Badge>
      ))}
      {hidden.length > 0 ? (
        // NOT shrinkable: "+2" is three glyphs and is the one thing in
        // the group that must stay readable at any width.
        <Badge variant="outline" data-testid="label-chips-more" title={hiddenNames}>
          {/* The count is the visible mark; the NAMES are what a reader
              gets, because "+2" alone says a task has labels nobody can
              read. `title` is for the mouse and is never the only copy. */}
          <span aria-hidden="true">{t("labels.more", { count: hidden.length })}</span>
          <span className="sr-only">{t("labels.moreNames", { names: hiddenNames })}</span>
        </Badge>
      ) : null}
    </span>
  );
}
