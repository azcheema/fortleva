"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { NativeSelect } from "@/components/ui/native-select";

/** Two-token visibility select that submits its form on change (no Save button). */
export function VisibilitySelect({ value }: { value: "INTERNAL" | "CLIENT_VISIBLE" }) {
  const t = useTranslations("visibility");
  const [current, setCurrent] = useState(value);
  return (
    <NativeSelect
      name="visibility"
      value={current}
      aria-label={t("label")}
      className="h-7 w-auto text-xs"
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
