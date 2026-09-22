"use client";

import { FilterXIcon, LayersIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useQueryStates } from "nuqs";

import { PriorityIndicator, StatusIcon } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PRIORITIES, STATUS_MAP, type Priority, type StatusValue } from "@/lib/enum-map";
import {
  GROUP_BYS,
  UNASSIGNED,
  WITH_CLIENT,
  activeFilterCount,
  workViewParsers,
  type GroupBy,
  type Rollup,
  type WorkMember,
  type WorkState,
} from "@/lib/work-view";

/**
 * The work view's filter chips (UI.md §5.3: "Filter chips are ALWAYS
 * VISIBLE above the view" — hidden filters are the top complaint in the
 * corpus the plan was built from, §37). The bar is the whole filter UI:
 * there is no filter drawer, no "advanced" panel and nothing behind a
 * disclosure, because a filter the member cannot see is a list that
 * lies about how much work there is.
 *
 * ONE CHIP PER DIMENSION, not per value. A chip per value reads better
 * with three states and wraps into four rows with seven states, two
 * members and five priorities — at 390 px in Swedish it is most of the
 * screen. Each chip is a menu of checkboxes instead, so the bar stays
 * one row and the resting width does not depend on the data.
 *
 * URL STATE, AND WHY IT IS `shallow`. Every param here is answered
 * entirely on the client: `listItems` already returned every item of the
 * project, so filtering is a predicate over an array the browser holds —
 * no round trip, no refetch, and the sub-50 ms reflow the plan asks for.
 * `history: "replace"` because a chip refines the view rather than
 * navigating to a new one; ten toggles must not become ten Back presses.
 * The view stays fully addressable — which is what UI.md rule 6 is
 * protecting — and `?item=` (a real peek navigation) still pushes, so
 * Back still closes the peek.
 */

/** The counts the bar reports, so "none match" is never silent. */
export type FilterBarProps = {
  /**
   * The states worth offering. Pass `visibleColumns(states, items)` so
   * the filter offers exactly what the board would show as a column — a
   * hidden state (TRIAGE) appears once it holds something and not
   * before, which is one rule for both surfaces rather than two.
   */
  states: readonly WorkState[];
  members: readonly WorkMember[];
  /**
   * REQUIRED — whether any task ON THIS SURFACE is held by a contact
   * (Phase 3 slice 6c). It decides whether the "With the client" option
   * is offered, by the rule the hidden-state comment above states for
   * states: the filter offers exactly what the surface could show, so a
   * bucket that can only ever match nothing is not a row in the menu.
   *
   * A REQUIRED PROP, never a default: this is state a shared component
   * must reflect, and a default would make the option silently absent on
   * whichever caller forgot it — which on this control reads as "no task
   * is with the client" rather than as a missing prop.
   */
  hasClientWork: boolean;
  rollup: Rollup;
  /** Grouping is offered only where the surface can render groups. */
  groupings?: readonly GroupBy[];
};

export function WorkFilterBar({
  states,
  members,
  hasClientWork,
  rollup,
  groupings = GROUP_BYS,
}: FilterBarProps) {
  const t = useTranslations("projects.workView");
  const tPriority = useTranslations("states.priority");
  const [params, setParams] = useQueryStates(workViewParsers, {
    shallow: true,
    history: "replace",
  });
  const active = activeFilterCount({
    stateIds: params.state,
    assigneeIds: params.assignee,
    priorities: params.priority,
    hideDone: params.hideDone,
  });

  /**
   * Toggle one value of a multi-value axis, preserving the rest.
   * An empty axis means "everything", and `clearOnDefault` then drops
   * the param entirely — so unticking the last value returns the bare
   * URL rather than leaving `?state=` behind.
   */
  const toggled = <T extends string>(list: readonly T[], value: T): T[] | null => {
    const next = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
    return next.length > 0 ? next : null;
  };

  return (
    <div
      role="group"
      aria-label={t("filters.label")}
      data-testid="work-filter-bar"
      className="flex flex-wrap items-center gap-1.5"
    >
      <ChipMenu
        testId="work-filter-state"
        label={t("filters.state")}
        count={params.state.length}
        heading={t("filters.stateHeading")}
      >
        {states.map((s) => {
          const spec = STATUS_MAP.stateCategory[s.category as StatusValue<"stateCategory">];
          return (
            <DropdownMenuCheckboxItem
              key={s.id}
              checked={params.state.includes(s.id)}
              onSelect={(e) => {
                // Keep the menu open: picking two states is one gesture.
                e.preventDefault();
                void setParams({ state: toggled(params.state, s.id) });
              }}
            >
              <StatusIcon name={spec.icon} className="size-3.5 text-muted-foreground" aria-hidden="true" />
              {s.name}
            </DropdownMenuCheckboxItem>
          );
        })}
      </ChipMenu>

      <ChipMenu
        testId="work-filter-assignee"
        label={t("filters.assignee")}
        count={params.assignee.length}
        heading={t("filters.assigneeHeading")}
      >
        <DropdownMenuCheckboxItem
          checked={params.assignee.includes(UNASSIGNED)}
          onSelect={(e) => {
            e.preventDefault();
            void setParams({ assignee: toggled(params.assignee, UNASSIGNED) });
          }}
        >
          {t("filters.unassigned")}
        </DropdownMenuCheckboxItem>
        {/* ITS OWN BUCKET, above the team, because it is the answer that
            is NOT a person at this agency. Before it existed a
            contact-held task matched "No assignee" — beside work nobody
            holds — and vanished from every lane the moment a real person
            was filtered for. */}
        {hasClientWork ? (
          <DropdownMenuCheckboxItem
            checked={params.assignee.includes(WITH_CLIENT)}
            onSelect={(e) => {
              e.preventDefault();
              void setParams({ assignee: toggled(params.assignee, WITH_CLIENT) });
            }}
          >
            {t("filters.withClient")}
          </DropdownMenuCheckboxItem>
        ) : null}
        {members.length > 0 ? <DropdownMenuSeparator /> : null}
        {members.map((m) => (
          <DropdownMenuCheckboxItem
            key={m.id}
            checked={params.assignee.includes(m.id)}
            onSelect={(e) => {
              e.preventDefault();
              void setParams({ assignee: toggled(params.assignee, m.id) });
            }}
          >
            {m.name}
          </DropdownMenuCheckboxItem>
        ))}
      </ChipMenu>

      <ChipMenu
        testId="work-filter-priority"
        label={t("filters.priority")}
        count={params.priority.length}
        heading={t("filters.priorityHeading")}
      >
        {[...PRIORITIES].reverse().map((p) => (
          <DropdownMenuCheckboxItem
            key={p}
            checked={params.priority.includes(p)}
            onSelect={(e) => {
              e.preventDefault();
              void setParams({ priority: toggled(params.priority, p) });
            }}
          >
            {p === "NONE" ? null : <PriorityIndicator value={p as Priority} />}
            {tPriority(p)}
          </DropdownMenuCheckboxItem>
        ))}
      </ChipMenu>

      {/* Hide done is its own chip rather than a state value: it is the
          one filter people reach for constantly, and it keeps working
          when a tenant adds a second done-ish state. */}
      <Button
        type="button"
        size="sm"
        variant={params.hideDone ? "secondary" : "outline"}
        aria-pressed={params.hideDone}
        data-testid="work-filter-hide-done"
        onClick={() => void setParams({ hideDone: params.hideDone ? null : true })}
      >
        {t("filters.hideDone")}
      </Button>

      {groupings.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant={params.group === "none" ? "outline" : "secondary"}
              data-testid="work-filter-group"
            >
              <LayersIcon aria-hidden="true" />
              {params.group === "none" ? t("group.label") : t(`group.${params.group}`)}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{t("group.heading")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={params.group}
              onValueChange={(v) => void setParams({ group: v === "none" ? null : (v as GroupBy) })}
            >
              {groupings.map((g) => (
                <DropdownMenuRadioItem key={g} value={g} data-testid={`work-group-${g}`}>
                  {t(`group.${g}`)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {active > 0 ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid="work-filter-clear"
          onClick={() =>
            void setParams({ state: null, assignee: null, priority: null, hideDone: null })
          }
        >
          <FilterXIcon aria-hidden="true" />
          {t("filters.clear", { count: active })}
        </Button>
      ) : null}

      {/* The count is a live region, not decoration: filtering is the one
          gesture that can make work disappear, so the surface says out
          loud how much of it is showing. `total` is the UNFILTERED size —
          a denominator that moves with the filter is a lie about how
          much work there is. */}
      <p
        role="status"
        data-testid="work-filter-summary"
        className="ml-auto text-xs text-muted-foreground"
      >
        {rollup.shown === rollup.total
          ? t("summary.all", { total: rollup.total })
          : t("summary.filtered", { shown: rollup.shown, total: rollup.total })}
      </p>
    </div>
  );
}

/** A dimension chip: the label, the number of values chosen, a menu. */
function ChipMenu({
  testId,
  label,
  count,
  heading,
  children,
}: {
  testId: string;
  label: string;
  count: number;
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="sm" variant={count > 0 ? "secondary" : "outline"} data-testid={testId}>
          {label}
          {count > 0 ? <span className="num text-2xs text-muted-foreground">{count}</span> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
        <DropdownMenuLabel>{heading}</DropdownMenuLabel>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
