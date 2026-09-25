"use client";

import { ArchiveIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import { PriorityIndicator, StatusIcon } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PRIORITIES, STATUS_MAP, type Priority, type StatusValue } from "@/lib/enum-map";
import type { WorkState } from "@/lib/work-view";

/**
 * The selection bar (UI.md §5.3: "Bulk bar appears on X/checkbox").
 *
 * STICKY, NEVER FIXED. It sits in the content flow and sticks to the
 * bottom of the viewport, so it cannot cover the page's own footer
 * controls and cannot escape a scroll container. On phones it clears the
 * shell's fixed tab bar — `h-14` at `z-30`, `md:hidden` — by that bar's
 * exact height plus the safe-area inset, and sits at `z-20` so the tab
 * bar stays on top of it rather than the other way round.
 *
 * The verbs are BUTTONS, not single keys. When this bar shipped (2W-F
 * slice 4) no key was possible: the `?` overlay was not scope-aware and
 * the palette had no page rows, so rule 7 could not be met. Both came
 * with the keyboard registry (panel slice 5), and the SELECTION now has
 * its key — `X` on a focused backlog row (panel slice 14, in
 * `backlog-table.tsx`). The verbs still have none; which single key
 * should archive a selection is a question nobody has asked yet.
 *
 * Three verbs, deliberately. Visibility, assignment and deletion are NOT
 * here: each needs machinery a loop cannot stand in for, and the reasons
 * are recorded on `src/modules/work/bulk.ts`.
 */
export function BulkBar({
  count,
  stateTargets,
  anyArchived,
  pending,
  onState,
  onPriority,
  onArchived,
  onClear,
}: {
  /** How many of the rows ON SCREEN are selected. */
  count: number;
  /**
   * The Status menu's rows: every state this member may move tasks into
   * (`bulkStateTargets` has already dropped TRIAGE, which is never a move
   * target, and — for a non-approver — a gated state: neither depends on
   * the selection, so both stay hidden per UI.md §3.1), each with the
   * sentence saying why THIS selection cannot go there, or `null` when it
   * can. Since C29b that is a CANCELLED state under a selection holding a
   * client request: it used to vanish from the menu with nothing said,
   * and the member was left to guess.
   */
  stateTargets: readonly { state: WorkState; refusal: string | null }[];
  /** True when the selection holds at least one archived item, so the
   * verb reads Restore rather than Archive. */
  anyArchived: boolean;
  pending: boolean;
  onState: (stateId: string) => void;
  onPriority: (priority: Priority) => void;
  onArchived: (archived: boolean) => void;
  onClear: () => void;
}) {
  const t = useTranslations("projects.workView");
  const tPriority = useTranslations("states.priority");

  return (
    <div className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-20 md:bottom-0">
      <div
        role="group"
        aria-label={t("bulk.label")}
        data-testid="bulk-bar"
        aria-busy={pending || undefined}
        // Border + surface step, no shadow: §10.8 reserves the three
        // shadows for things that genuinely float (popovers, toasts,
        // dialogs). A sticky bar is anchored in the flow, and an opaque
        // `bg-card` with a hairline is the surface language for that.
        className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-card p-2"
      >
        {/* Plain text, NOT a live region: the announcement comes from a
            region that outlives this bar (a `role="status"` mounted with
            its content is never spoken), and two regions saying the same
            number would announce it twice. */}
        <span data-testid="bulk-count" className="px-1 text-sm font-medium">
          {t("bulk.count", { count })}
        </span>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="sm" variant="outline" disabled={pending} data-testid="bulk-state">
              {t("bulk.state")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
            <DropdownMenuLabel>{t("bulk.statePlaceholder")}</DropdownMenuLabel>
            {stateTargets.map(({ state: s, refusal }) => {
              const spec = STATUS_MAP.stateCategory[s.category as StatusValue<"stateCategory">];
              if (refusal === null) {
                return (
                  <DropdownMenuItem key={s.id} onSelect={() => onState(s.id)}>
                    <StatusIcon name={spec.icon} className="size-3.5 text-muted-foreground" aria-hidden="true" />
                    {s.name}
                  </DropdownMenuItem>
                );
              }
              // REFUSED, AND STILL FOCUSABLE — `aria-disabled`, not Radix's
              // `disabled`. A Radix-disabled item is skipped by the menu's
              // roving focus, so the reason printed under it is only ever
              // SEEN: the arrows walk straight past it and a screen reader
              // never speaks it, which is §5.12's "a reason nobody can
              // read" for everyone who is not looking. So the arrows stop
              // here, the reason is part of what is announced, and a press
              // does nothing and leaves the menu open (the `preventDefault`
              // is Radix's way of keeping it open). The WAI-ARIA menu
              // pattern's own rule: disabled items are focusable, they just
              // cannot be activated.
              //
              // FOCUSED, IT KEEPS BOTH FOCUS CHANNELS (UI.md §9: the accent
              // fill AND the inset bar) and lifts its name to
              // `--muted-foreground`: `--fg-disabled` is tuned to ~3:1 on the
              // menu's own surface and falls to 2.56:1 on the dark accent
              // fill, below §9's floor for disabled text, while
              // `--muted-foreground` holds ≥ 4.5:1 on the accent (pinned in
              // `contrast.test.ts`) and still reads as quieter than a live
              // item's. The first cut dropped the fill instead, which kept
              // the contrast and broke the two-channel rule (review).
              return (
                <DropdownMenuItem
                  key={s.id}
                  aria-disabled="true"
                  data-testid="bulk-state-refused"
                  onSelect={(e) => e.preventDefault()}
                  className="h-auto cursor-not-allowed items-start py-1 text-fg-disabled focus:text-muted-foreground"
                >
                  {/* On the name's line, not centred on the two: the item
                      grows downward and the glyph belongs to the state. */}
                  <StatusIcon name={spec.icon} className="mt-0.5 size-3.5 text-muted-foreground" aria-hidden="true" />
                  <span className="flex min-w-0 flex-col">
                    <span>{s.name}</span>
                    <span className="max-w-56 text-2xs text-muted-foreground">{refusal}</span>
                  </span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="sm" variant="outline" disabled={pending} data-testid="bulk-priority">
              {t("bulk.priority")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{t("bulk.priorityPlaceholder")}</DropdownMenuLabel>
            {[...PRIORITIES].reverse().map((p) => (
              <DropdownMenuItem key={p} onSelect={() => onPriority(p)}>
                {p === "NONE" ? null : <PriorityIndicator value={p} />}
                {tPriority(p)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Archiving is reversible and explicit (UI rule 12), so it takes
            no confirm — the row menu's single-item archive takes none
            either, and the verb flips to Restore for a selection that is
            already archived rather than offering a no-op. */}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          data-testid="bulk-archive"
          onClick={() => onArchived(!anyArchived)}
        >
          <ArchiveIcon aria-hidden="true" />
          {anyArchived ? t("bulk.restore") : t("bulk.archive")}
        </Button>

        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto"
          data-testid="bulk-clear"
          onClick={onClear}
        >
          <XIcon aria-hidden="true" />
          {t("bulk.clear")}
        </Button>
      </div>
    </div>
  );
}
