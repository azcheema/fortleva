"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import {
  PropertyPicker,
  VISIBILITY_VALUES,
  VisibilityBadge,
  VisibilityIcon,
  visibilityLabelKey,
  type PickerOption,
  type VisibilityValue,
} from "@/components/semantic";
import { useScopeKeys } from "@/components/shell/use-hotkeys";
import { panelSurfaceOf } from "@/lib/work-view";

import { setItemVisibilityAction, type VisibilityCommitted } from "../backlog/actions";
import { usePanelCommit } from "./use-panel-commit";

/**
 * The item rail's Visibility (UI.md §5.2 `V`, §10.4 — SAFETY-CRITICAL).
 * Two tokens and nothing else. The trigger's rest state IS the
 * `<VisibilityBadge>`, exactly as `VisibilityInlineEdit`'s is on the
 * files table, so the editable chip and the read-only chip are one
 * silhouette carrying all five channels; a member without
 * `work_item:change_visibility` gets the chip alone — never no chip
 * (§10.4: absence is indistinguishable from a bug). The rows' icons and
 * words are the badge's own (`VisibilityIcon`, `visibilityLabelKey`),
 * so the CVD-measured pair cannot drift between the chip and the list.
 *
 * NEVER OPTIMISTIC (§10.4). `usePanelCommit` is asked to hold the shown
 * value until the server answers, then it adopts the canonical row. So
 * a downgrade the database refuses — a subtask, comment or file the
 * client can still see — never flashes "Private to team" over a task
 * that is not, and the refusal's own sentence is what gets toasted
 * (`HAS_VISIBLE_CHILDREN`, which says what to make private first). A
 * pick while one is in flight compares against that pick, not the
 * unchanged chip, so a reversal supersedes rather than vanishes.
 *
 * INTERNAL is always the first row: the picker seeds `""` for it when it
 * is current (cmdk lights it), and the current value when the item is
 * shared — either way a bare Enter is the no-op §5.2 requires.
 */
export function VisibilityField({
  itemId,
  itemNumber,
  projectKey,
  surface,
  visibility,
  canChangeVisibility,
}: {
  itemId: string;
  itemNumber: number;
  projectKey: string;
  /** Decides the MFA step-up return address — see `panelSurfaceOf` / `itemReturnTo`. */
  surface: "board" | "backlog" | "page";
  visibility: VisibilityValue;
  /** `work_item:change_visibility` — REQUIRED, from `getItemDetail`. */
  canChangeVisibility: boolean;
}) {
  const t = useTranslations("projects.item");
  const tVisibility = useTranslations("visibility");
  const [open, setOpen] = useState(false);
  const labelOf = (v: VisibilityValue) => tVisibility(visibilityLabelKey(v));

  const { shown, status, commit } = usePanelCommit<VisibilityValue, VisibilityCommitted>({
    canonical: visibility,
    same: (a, b) => a === b,
    adopt: (c) => c.visibility,
    announce: (v) => t("visibility.changed", { visibility: labelOf(v) }),
    failedMessage: t("visibility.failed"),
    optimistic: false,
  });

  // Above the early return: a hook may not sit under a conditional. A
  // DISABLED binding swallows `V` rather than letting a lower scope have it.
  useScopeKeys("item", [
    { key: "v", label: t("keys.visibility"), enabled: canChangeVisibility, run: () => setOpen(true) },
  ]);

  if (!canChangeVisibility) return <VisibilityBadge value={shown} />;

  const options: PickerOption<VisibilityValue>[] = VISIBILITY_VALUES.map((v) => ({
    value: v,
    label: labelOf(v),
    icon: <VisibilityIcon value={v} className="shrink-0" />,
    testId: `item-visibility-${v}`,
  }));

  const onSelect = (next: VisibilityValue) =>
    commit(next, () =>
      setItemVisibilityAction({
        itemId,
        projectKey,
        itemNumber,
        surface: panelSurfaceOf(surface),
        visibility: next,
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
        hintKey="V"
        testId="item-visibility"
        // Flush with the rail's other values: the rest box carries `px-2.5`.
        className="-ms-2.5"
        labels={{
          trigger: t("visibility.trigger", { visibility: labelOf(shown) }),
          search: t("visibility.search"),
          empty: t("visibility.empty"),
          current: t("currentValue"),
        }}
      >
        {/* The chip is the value: the badge emits `data-visibility` for the tests. */}
        <VisibilityBadge value={shown} />
      </PropertyPicker>
      {status}
    </>
  );
}
