"use client";

import { RotateCcwIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import { RowActions } from "@/components/semantic";
import { useRun } from "@/components/use-run";

import { restoreStagesAction } from "./actions";

/**
 * "Restore Fortleva's original stages" — the card's menu, danger-toned so
 * it asks first (a `confirm` on a non-danger item is dead string,
 * AGENTS.md). It changes no project: only projects made afterwards.
 */
export function RestoreStages() {
  const t = useTranslations("settings.stages.restore");
  const { run } = useRun();
  return (
    <RowActions
      label={t("menu")}
      items={[
        {
          key: "restore",
          label: t("action"),
          icon: RotateCcwIcon,
          tone: "danger",
          confirm: t("confirm"),
          onSelect: () => run(() => restoreStagesAction()),
        },
      ]}
    />
  );
}
