"use client";

import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import { PropertyPicker, StatusIcon, type PickerOption } from "@/components/semantic";
import { useScopeKeys } from "@/components/shell/use-hotkeys";
import { STATUS_MAP, type StatusValue } from "@/lib/enum-map";
import { panelSurfaceOf, statePickerTargets } from "@/lib/work-view";
import type { ResolvedWorkflowState } from "@/modules/work";

import { setItemStateAction, type StateCommitted } from "../backlog/actions";
import { usePanelCommit } from "./use-panel-commit";

type ShownState = { stateId: string; stateName: string; stateCategory: string };

/**
 * The item panel's State property (UI.md §5.2 `S`) — the first
 * `<PropertyPicker>`, and the shape `P E D` took after it.
 *
 * ONE island owns the trigger, the key and the mutation together: the
 * key binding sits beside the state it mutates, so there is no registry
 * entry to keep in sync with a handler somewhere else. What happens
 * between the pick and the server's answer is `usePanelCommit`'s, shared
 * by all four, so they cannot drift into four ideas of "saved".
 *
 * It renders inside a SERVER component on two surfaces (the peek sheet
 * and the full item page), so every fact it needs is a REQUIRED prop —
 * a default here would be a shared component quietly disagreeing with
 * itself on one of the two.
 */
export function StateField({
  itemId,
  itemNumber,
  projectKey,
  surface,
  stateId,
  stateName,
  stateCategory,
  states,
  canEdit,
  canApprove,
}: {
  itemId: string;
  itemNumber: number;
  projectKey: string;
  /** Decides the MFA step-up return address — see `panelSurfaceOf` / `itemReturnTo`. */
  surface: "board" | "backlog" | "page";
  stateId: string;
  stateName: string;
  stateCategory: string;
  states: readonly ResolvedWorkflowState[];
  canEdit: boolean;
  canApprove: boolean;
}) {
  const t = useTranslations("projects.item");
  const tCat = useTranslations("states.stateCategory");
  const [open, setOpen] = useState(false);

  const { shown, status, commit } = usePanelCommit<ShownState, StateCommitted>({
    canonical: { stateId, stateName, stateCategory },
    same: (a, b) => a.stateId === b.stateId,
    adopt: (c) => ({ stateId: c.stateId, stateName: c.stateName, stateCategory: c.stateCategory }),
    announce: (s) => t("state.changed", { state: s.stateName }),
    failedMessage: t("state.failed"),
  });

  // ONE rule for every surface — the board's drops, the backlog's select
  // and this picker all ask `@/lib/work-view`, never a local predicate.
  // Each target arrives with its test-id key already numbered over ALL
  // the project's states, so a row's id cannot depend on who is looking,
  // and no call site can quietly number the filtered list instead.
  const targets = useMemo(
    () => statePickerTargets(states, canApprove, stateId),
    [states, canApprove, stateId],
  );

  const options = useMemo<PickerOption<string>[]>(
    () =>
      targets.map(({ state: s, key, disabled }) => ({
        value: s.id,
        label: s.name,
        group: tCat(s.category as StatusValue<"stateCategory">),
        icon: (
          <StatusIcon
            name={STATUS_MAP.stateCategory[s.category as StatusValue<"stateCategory">].icon}
            className="size-3 shrink-0"
            aria-hidden="true"
          />
        ),
        // The item's CURRENT state is always listed, and non-selectable
        // when it is not a legal target — TRIAGE, or a gated Done under
        // a non-approver. A picker that cannot show what the item IS is
        // broken (§5.2, and the residue the 2W-R review accepted).
        disabled,
        // `item-state-IN_PROGRESS-2`: the category alone named both of the
        // seed's IN_PROGRESS states.
        testId: `item-state-${key}`,
      })),
    [targets, tCat],
  );

  // Above the early return: a hook may not sit under a conditional. The
  // binding is DISABLED rather than absent when there is nothing to
  // choose, so `S` is swallowed here instead of falling through to the
  // board's "Move to…" underneath.
  useScopeKeys("item", [
    {
      key: "s",
      label: t("keys.state"),
      enabled: canEdit && options.some((o) => !o.disabled),
      run: () => setOpen(true),
    },
  ]);

  const onSelect = (next: string) => {
    setOpen(false);
    const target = targets.find((x) => x.state.id === next);
    // cmdk never selects a disabled row; this is the belt.
    if (!target || target.disabled) return;
    const s = target.state;
    // `changeState`, never `moveItemAction`: this path cannot re-rank.
    commit({ stateId: s.id, stateName: s.name, stateCategory: s.category }, () =>
      setItemStateAction({
        itemId,
        stateId: next,
        projectKey,
        itemNumber,
        surface: panelSurfaceOf(surface),
      }),
    );
  };

  // Honest degradation: without `work_item:edit` — or in the unreachable
  // case of a project whose states were never seeded — the value is
  // still the value, just not a control.
  if (!canEdit || states.length === 0) return <>{shown.stateName}</>;

  const spec = STATUS_MAP.stateCategory[shown.stateCategory as StatusValue<"stateCategory">];

  return (
    <>
      <PropertyPicker
        open={open}
        onOpenChange={setOpen}
        value={shown.stateId}
        options={options}
        onSelect={onSelect}
        hintKey="S"
        testId="item-state"
        // The trigger carries the rest box's own `px-2.5`, which would
        // otherwise indent the State value 10px past every sibling
        // `<dd>` in the rail (§10.15 pattern 7).
        className="-ms-2.5"
        labels={{
          trigger: t("state.trigger", { state: shown.stateName }),
          search: t("state.search"),
          empty: t("state.empty"),
          current: t("currentValue"),
        }}
      >
        <StatusIcon name={spec.icon} className="size-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{shown.stateName}</span>
      </PropertyPicker>
      {status}
    </>
  );
}
