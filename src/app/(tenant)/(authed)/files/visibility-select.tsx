"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";

/**
 * Two-token visibility select that submits its form on change (no Save
 * button). SAFETY-CRITICAL (DESIGN SPEC §2.4): the write control carries
 * the same warm fill as the read chip when the value is CLIENT_VISIBLE,
 * so an editable row is never *less* legible than a read-only one. The
 * row it sits in also carries the 2px warm left border, and the option
 * text states the value in words — three channels, no hue dependency.
 *
 * The mutation is deliberately NOT optimistic: `current` only moves the
 * control's own value, and the row re-renders from the server response.
 */
export function VisibilitySelect({ value }: { value: "INTERNAL" | "CLIENT_VISIBLE" }) {
  const t = useTranslations("visibility");
  const [current, setCurrent] = useState(value);
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
        setCurrent(e.target.value === "CLIENT_VISIBLE" ? "CLIENT_VISIBLE" : "INTERNAL");
        e.currentTarget.form?.requestSubmit();
      }}
    >
      <option value="INTERNAL">{t("internal")}</option>
      <option value="CLIENT_VISIBLE">{t("clientVisible")}</option>
    </NativeSelect>
  );
}
