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
 * The verbs are BUTTONS, not single keys. A single-key binding would owe
 * UI.md rule 7 a ⌘K entry and a row in the `?` overlay, and neither is
 * possible yet: the palette has no registry for page-contextual actions,
 * and the overlay is not scope-aware (UI.md §6 records that deferral —
 * it arrives with `react-hotkeys-hook` and the `item` scope). Shipping a
 * key the overlay cannot advertise is exactly what rule 7 forbids, so
 * this slice ships none.
 *
 * Three verbs, deliberately. Visibility, assignment and deletion are NOT
 * here: each needs machinery a loop cannot stand in for, and the reasons
 * are recorded on `src/modules/work/bulk.ts`.
 */
export function BulkBar({
  count,
  states,
  anyArchived,
  pending,
  onState,
  onPriority,
  onArchived,
  onClear,
}: {
  /** How many of the rows ON SCREEN are selected. */
  count: number;
  /** Legal targets only — `canEnterState` has already filtered these. */
  states: readonly WorkState[];
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
            {states.map((s) => {
              const spec = STATUS_MAP.stateCategory[s.category as StatusValue<"stateCategory">];
              return (
                <DropdownMenuItem key={s.id} onSelect={() => onState(s.id)}>
                  <StatusIcon name={spec.icon} className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  {s.name}
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
