"use client";

import { CheckIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import {
  PriorityGlyph,
  PriorityIndicator,
  PropertyPicker,
  type PickerOption,
} from "@/components/semantic";
import { useScopeKeys } from "@/components/shell/use-hotkeys";
import { PRIORITIES, type Priority } from "@/lib/enum-map";
import { panelSurfaceOf } from "@/lib/work-view";

import { setItemPriorityAction, type PriorityCommitted } from "../backlog/actions";
import { usePanelCommit } from "./use-panel-commit";

/**
 * The item rail's Priority (UI.md §5.2 `P`): the same island as
 * `StateField` — trigger, key and action together — on the shared
 * `usePanelCommit` path.
 *
 * The rows are the enum in ORDER (NONE → URGENT), so the current value
 * is usually not the first row: the picker keeps its controlled seed on
 * it (`initialHighlight`), which lights the row at once but leaves
 * `aria-activedescendant` unset until the member's first
 * ArrowUp/ArrowDown/Home/End that moves the selection — a recorded
 * residue, spoken meanwhile by the combobox's name, which falls back to
 * the trigger's label. The row itself says "(current)" once it is.
 */
export function PriorityField({
  itemId,
  itemNumber,
  projectKey,
  surface,
  priority,
  canEdit,
}: {
  itemId: string;
  itemNumber: number;
  projectKey: string;
  /** Decides the MFA step-up return address — see `panelSurfaceOf` / `itemReturnTo`. */
  surface: "board" | "backlog" | "page";
  priority: Priority;
  canEdit: boolean;
}) {
  const t = useTranslations("projects.item");
  const tPriority = useTranslations("states.priority");
  const [open, setOpen] = useState(false);

  const { shown, announced, commit } = usePanelCommit<Priority, PriorityCommitted>({
    canonical: priority,
    same: (a, b) => a === b,
    adopt: (c) => c.priority,
    announce: (v) => t("priority.changed", { priority: tPriority(v) }),
    failedMessage: t("priority.failed"),
  });

  // Above the early return: a hook may not sit under a conditional. A
  // DISABLED binding swallows `P` rather than letting a lower scope have it.
  useScopeKeys("item", [
    { key: "p", label: t("keys.priority"), enabled: canEdit, run: () => setOpen(true) },
  ]);

  if (!canEdit) return <>{tPriority(shown)}</>;

  const options: PickerOption<Priority>[] = PRIORITIES.map((v) => ({
    value: v,
    label: tPriority(v),
    icon: <PriorityGlyph value={v} />,
    meta: v === shown ? <CheckIcon className="size-3.5" aria-hidden="true" /> : undefined,
    testId: `item-priority-${v}`,
  }));

  const onSelect = (next: Priority) =>
    commit(next, () =>
      setItemPriorityAction({
        itemId,
        projectKey,
        itemNumber,
        surface: panelSurfaceOf(surface),
        priority: next,
      }),
    );

  return (
    <>
      <PropertyPicker
        open={open}
        onOpenChange={setOpen}
        value={shown}
        options={options}
        onSelect={onSelect}
        hintKey="P"
        testId="item-priority"
        // Flush with the rail's other values: the rest box carries `px-2.5`.
        className="-ms-2.5"
        labels={{
          trigger: t("priority.trigger", { priority: tPriority(shown) }),
          search: t("priority.search"),
          empty: t("priority.empty"),
          current: t("currentValue"),
        }}
      >
        {/* The label branch: no Tooltip inside a trigger (§5.2). */}
        <PriorityIndicator value={shown} showLabel />
      </PropertyPicker>
      <span role="status" aria-live="polite" className="sr-only">
        {announced}
      </span>
    </>
  );
}
