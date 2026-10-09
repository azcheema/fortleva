"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { AutoForm } from "@/components/auto-form";
import { InlineEdit } from "@/components/semantic";
import { PAYMENT_TERMS_RANGE } from "@/modules/invoicing/seller-fields";

import { updateTermsAction } from "./actions";

/**
 * The days a client has to pay, unless a draft says otherwise (Phase 4 slice
 * 107). One value, saved on blur; blank goes back to the default. A refusal
 * puts the value back (`resetKey`) and the toast says why.
 */
export function TermsCard({ days, editable }: { days: number; editable: boolean }) {
  const t = useTranslations("settings.invoicing.terms");
  const [resetKey, setResetKey] = useState(0);
  return (
    <AutoForm action={updateTermsAction} className="flex flex-col gap-1" onError={() => setResetKey((k) => k + 1)}>
      <dl className="flex min-w-0 flex-col gap-0.5">
        <dt className="px-2.5 text-xs text-muted-foreground">{t("label")}</dt>
        <dd className="min-w-0">
          <InlineEdit
            kind="text"
            name="paymentTermsDays"
            value={String(days)}
            label={t("label")}
            placeholder={String(days)}
            display={<span className="num">{t("days", { days })}</span>}
            readOnly={!editable}
            fit
            inputProps={{ inputMode: "numeric", maxLength: 3, pattern: "[0-9]*" }}
            className={editable ? undefined : "px-2.5"}
            resetKey={resetKey}
          />
        </dd>
      </dl>
      <p className="px-2.5 text-xs text-muted-foreground">
        {t("hint", { min: PAYMENT_TERMS_RANGE.min, max: PAYMENT_TERMS_RANGE.max })}
      </p>
    </AutoForm>
  );
}
