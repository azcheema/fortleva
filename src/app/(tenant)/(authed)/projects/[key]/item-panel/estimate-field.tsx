"use client";

import { CheckIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { PropertyPicker, type PickerOption } from "@/components/semantic";
import { useScopeKeys } from "@/components/shell/use-hotkeys";
import { parseEstimateMinutes } from "@/lib/duration";
import { formatDuration, type DurationStyle } from "@/lib/format";
import { panelSurfaceOf } from "@/lib/work-view";

import { setItemEstimateAction, type EstimateCommitted } from "../backlog/actions";
import { usePanelCommit } from "./use-panel-commit";

type ShownEstimate = { minutes: number | null; label: string | null };

/**
 * The item rail's Estimate (UI.md §5.2 `E`). Typed text IS the option:
 * `derive` turns `90m`, `2h` or `1,5` into ONE row through the shared
 * duration grammar (`parseEstimateMinutes`), so there is no second
 * parser and no "Apply" button. A typed `0` derives the grammar's own
 * meaning of zero: the unset row when nothing is set, the clear row
 * otherwise.
 *
 * The current state is the FIRST row — the value with a check, or a
 * checked "No estimate" (`none`) when unset — and the clear row
 * (`clear`) is last and only there when a value is set. The two carry
 * DIFFERENT values although both commit null: under one shared value, the
 * board poll's refresh turned a highlighted "No estimate" into "Remove
 * estimate" beneath the member's Enter, which then cleared a colleague's
 * estimate. With the picker seeding `""` for a first current row, cmdk
 * lights it itself, so a bare Enter on open commits nothing. (It is not
 * announced until the member steers — WHAT IS ANNOUNCED in
 * property-picker.tsx.)
 *
 * Values are minutes, never display text, so a label is never parsed
 * back (the C0 round-trip bug lived exactly there).
 */
export function EstimateField({
  itemId,
  itemNumber,
  projectKey,
  surface,
  estimateMinutes,
  estimateLabel,
  durationStyle,
  canEdit,
}: {
  itemId: string;
  itemNumber: number;
  projectKey: string;
  /** Decides the MFA step-up return address — see `panelSurfaceOf` / `itemReturnTo`. */
  surface: "board" | "backlog" | "page";
  estimateMinutes: number | null;
  /** Formatted on the server with the same helper, so the trigger never flickers. */
  estimateLabel: string | null;
  durationStyle: DurationStyle;
  canEdit: boolean;
}) {
  const t = useTranslations("projects.item");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const fmt = (minutes: number) => formatDuration(locale, minutes, durationStyle);

  const { shown, announced, commit } = usePanelCommit<ShownEstimate, EstimateCommitted>({
    canonical: { minutes: estimateMinutes, label: estimateLabel },
    same: (a, b) => a.minutes === b.minutes,
    adopt: (c) => ({
      minutes: c.estimateMinutes,
      label: c.estimateMinutes === null ? null : fmt(c.estimateMinutes),
    }),
    announce: (v) =>
      v.minutes === null ? t("estimate.cleared") : t("estimate.changed", { value: v.label ?? "" }),
    failedMessage: t("estimate.failed"),
  });

  useScopeKeys("item", [
    { key: "e", label: t("keys.estimate"), enabled: canEdit, run: () => setOpen(true) },
  ]);

  if (!canEdit) return <span className="num">{shown.label ?? "—"}</span>;

  const check = <CheckIcon className="size-3.5" aria-hidden="true" />;
  const options: PickerOption<string>[] =
    shown.minutes === null
      ? [{ value: "none", label: t("estimate.none"), meta: check, testId: "item-estimate-none" }]
      : [
          {
            value: `${shown.minutes}`,
            label: shown.label ?? fmt(shown.minutes),
            meta: check,
            testId: "item-estimate-current",
          },
          { value: "clear", label: t("estimate.clear"), testId: "item-estimate-clear" },
        ];

  const derive = (query: string): PickerOption<string> | null => {
    // null = CLEAR (a typed zero), undefined = REFUSED.
    const minutes = parseEstimateMinutes(query);
    if (minutes === undefined || (minutes !== null && !Number.isInteger(minutes))) return null;
    if (minutes === null) {
      // The same value as the fixed row it stands for, so that row is
      // dropped rather than listed twice.
      return shown.minutes === null
        ? { value: "none", label: t("estimate.none"), testId: "item-estimate-derived" }
        : { value: "clear", label: t("estimate.clear"), testId: "item-estimate-derived" };
    }
    return {
      value: `${minutes}`,
      label: t("estimate.set", { value: fmt(minutes) }),
      testId: "item-estimate-derived",
    };
  };

  const onSelect = (next: string) => {
    const minutes = next === "none" || next === "clear" ? null : Number(next);
    if (minutes !== null && !Number.isInteger(minutes)) return;
    commit({ minutes, label: minutes === null ? null : fmt(minutes) }, () =>
      setItemEstimateAction({
        itemId,
        projectKey,
        itemNumber,
        surface: panelSurfaceOf(surface),
        estimateMinutes: minutes,
      }),
    );
  };

  return (
    <>
      <PropertyPicker
        open={open}
        onOpenChange={setOpen}
        value={shown.minutes === null ? "none" : `${shown.minutes}`}
        options={options}
        onSelect={onSelect}
        derive={derive}
        hintKey="E"
        testId="item-estimate"
        className="-ms-2.5"
        labels={{
          trigger:
            shown.label === null
              ? t("estimate.triggerEmpty")
              : t("estimate.trigger", { value: shown.label }),
          input: t("estimate.input"),
          search: t("estimate.search"),
          empty: t("estimate.empty"),
          current: t("currentValue"),
        }}
      >
        <span className="num min-w-0 truncate" data-value={shown.minutes ?? ""}>
          {shown.label ?? "—"}
        </span>
      </PropertyPicker>
      <span role="status" aria-live="polite" className="sr-only">
        {announced}
      </span>
    </>
  );
}
