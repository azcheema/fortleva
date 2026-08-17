"use client";

import { useTranslations } from "next-intl";
import { useOptimistic, useTransition } from "react";
import { toast } from "sonner";

import { NativeSelect } from "@/components/ui/native-select";
import type { Visibility } from "@/documents/service";
import { cn } from "@/lib/utils";

import { changeVisibilityAction } from "./actions";

/**
 * Two-token visibility select that saves on change (no Save button).
 * SAFETY-CRITICAL (DESIGN SPEC §2.4): the write control carries the
 * same warm fill as the read chip when the value is CLIENT_VISIBLE, so
 * an editable row is never *less* legible than a read-only one. The row
 * it sits in also carries the 2px warm left border, and the option text
 * states the value in words — three channels, no hue dependency.
 *
 * It is NOT wrapped in a <form action>: React resets a form once its
 * action has run, which restores a native <select> to the value the
 * server rendered — the control then showed the OLD visibility while
 * the database held the new one. Instead the action is called inside a
 * transition, and useOptimistic keeps the SERVER value authoritative:
 * the chosen value is shown while the round trip is in flight, and
 * whatever comes back from the revalidated page is what remains. A
 * failure therefore falls back to the truth *and* says so out loud —
 * this control must never revert quietly.
 */
export function VisibilitySelect({
  documentId,
  value,
  returnTo,
}: {
  documentId: string;
  value: Visibility;
  returnTo: string;
}) {
  const t = useTranslations("visibility");
  const tErrors = useTranslations("files.errors");
  const [, startTransition] = useTransition();
  const [current, setCurrent] = useOptimistic(value);
  const isClientVisible = current === "CLIENT_VISIBLE";

  return (
    <NativeSelect
      name="visibility"
      value={current}
      aria-label={t("label")}
      data-visibility={current}
      className={cn(
        "h-7 w-auto text-xs",
        isClientVisible &&
          "border-vis-client-border bg-vis-client font-semibold text-vis-client-fg",
      )}
      onChange={(e) => {
        const next: Visibility =
          e.target.value === "CLIENT_VISIBLE" ? "CLIENT_VISIBLE" : "INTERNAL";
        startTransition(async () => {
          setCurrent(next);
          const result = await changeVisibilityAction({
            documentId,
            visibility: next,
            returnTo,
          }).catch(() => ({ ok: false as const, message: tErrors("visibilityFailed") }));
          if (!result.ok) toast.error(result.message);
        });
      }}
    >
      <option value="INTERNAL">{t("internal")}</option>
      <option value="CLIENT_VISIBLE">{t("clientVisible")}</option>
    </NativeSelect>
  );
}
