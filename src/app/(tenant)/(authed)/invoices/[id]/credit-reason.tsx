"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { InlineEdit } from "@/components/semantic";
import { useRun } from "@/components/use-run";

import { updateDraftDetailsAction } from "../actions";

/**
 * A credit-note draft's REASON (slice 108b; C77 (b)) — read-first, saved on
 * its own commit like every draft detail (`draft-details.tsx`). It is
 * required, so clearing it is refused and the field goes back to what is
 * saved (`resetKey`).
 */
export function CreditReason({ invoiceId, value, editable }: { invoiceId: string; value: string; editable: boolean }) {
  const t = useTranslations("invoices.credit");
  const { run } = useRun();
  const [reset, setReset] = useState(0);
  return (
    <InlineEdit
      kind="multiline"
      name="creditReason"
      value={value}
      label={t("reasonLabel")}
      placeholder={t("reasonPlaceholder")}
      readOnly={!editable}
      hiddenInput={false}
      resetKey={reset}
      className={editable ? "min-w-0" : "px-2.5"}
      onCommit={(next) =>
        run(async () => {
          const r = await updateDraftDetailsAction(invoiceId, { creditReason: next });
          if (!r.ok) setReset((n) => n + 1);
          return r;
        })
      }
    />
  );
}
