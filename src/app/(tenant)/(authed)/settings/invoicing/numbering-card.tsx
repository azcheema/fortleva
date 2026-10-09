"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { AutoForm } from "@/components/auto-form";
import { InlineEdit } from "@/components/semantic";

import { setFirstNumberAction } from "./actions";

/**
 * The workspace's invoice numbers (Phase 4 slice 108; founder decision C76
 * (a)–(c)). Before the first invoice: the FIRST number, one value saved on
 * blur by an owner (`invoice:manage_series` ✦ — the step-up page when the
 * second factor is stale). After it: the next number, read-only — fixed for
 * good. A refusal puts the value back (`resetKey`) and the toast says why.
 */
export function NumberingCard({
  firstNumber,
  nextNumber,
  used,
  editable,
}: {
  firstNumber: number | null;
  nextNumber: number | null;
  used: boolean;
  editable: boolean;
}) {
  const t = useTranslations("settings.invoicing.numbering");
  const [resetKey, setResetKey] = useState(0);

  if (used && nextNumber !== null) {
    return (
      <div className="flex flex-col gap-1" data-testid="invoice-numbering">
        <dl className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">{t("next")}</dt>
          <dd className="num-id font-mono text-sm" data-testid="invoice-next-number">
            {nextNumber}
          </dd>
        </dl>
        <p className="text-xs text-muted-foreground">{t("fixed")}</p>
      </div>
    );
  }

  return (
    <AutoForm action={setFirstNumberAction} className="flex flex-col gap-1" onError={() => setResetKey((k) => k + 1)}>
      <dl className="flex min-w-0 flex-col gap-0.5" data-testid="invoice-numbering">
        <dt className="px-2.5 text-xs text-muted-foreground">{t("firstLabel")}</dt>
        <dd className="min-w-0">
          <InlineEdit
            kind="text"
            name="firstNumber"
            value={firstNumber === null ? "" : String(firstNumber)}
            label={t("firstLabel")}
            placeholder={t("notSet")}
            display={firstNumber === null ? undefined : <span className="num-id font-mono">{firstNumber}</span>}
            readOnly={!editable}
            fit
            inputProps={{ inputMode: "numeric", maxLength: 11, pattern: "[0-9 ]*" }}
            controlClassName="num-id font-mono"
            className={editable ? undefined : "px-2.5"}
            resetKey={resetKey}
          />
        </dd>
      </dl>
      <p className="px-2.5 text-xs text-muted-foreground">{editable ? t("firstHint") : t("ownersOnly")}</p>
    </AutoForm>
  );
}
