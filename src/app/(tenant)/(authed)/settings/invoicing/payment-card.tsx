"use client";

import { useTranslations } from "next-intl";

import { FOOTER_NOTE_MAX } from "@/modules/invoicing/seller-fields";

import { updatePaymentAction } from "./actions";
import { ProtectedCard, type ProtectedField } from "./protected-card";

export type PaymentValues = {
  readonly bankgiro: string | null;
  readonly plusgiro: string | null;
  readonly iban: string | null;
  readonly bic: string | null;
  readonly footerNote: string | null;
};

/**
 * HOW CLIENTS PAY (Phase 4 slice 107; founder decisions C75 (h), (i)) — the
 * Bankgiro, PlusGiro, IBAN and BIC printed on every invoice, and the note
 * printed under them: the code typed in the form, every owner mailed
 * (`ProtectedCard`).
 */
export function PaymentCard({
  values,
  editable,
  hasFactor,
  changed,
  enrolHref,
}: {
  values: PaymentValues;
  editable: boolean;
  hasFactor: boolean;
  changed: { readonly by: string | null; readonly at: string } | null;
  enrolHref: string;
}) {
  const t = useTranslations("settings.invoicing.payment");
  const fields: ProtectedField[] = [
    { name: "bankgiro", label: t("fields.bankgiro"), kind: "text", mono: true, maxLength: 20, hint: t("hints.bankgiro") },
    { name: "plusgiro", label: t("fields.plusgiro"), kind: "text", mono: true, maxLength: 20, hint: t("hints.plusgiro") },
    { name: "iban", label: t("fields.iban"), kind: "text", mono: true, maxLength: 50, hint: t("hints.iban") },
    { name: "bic", label: t("fields.bic"), kind: "text", mono: true, maxLength: 20, hint: t("hints.bic") },
    { name: "footerNote", label: t("fields.footerNote"), kind: "textarea", maxLength: FOOTER_NOTE_MAX, hint: t("hints.footerNote"), wide: true },
  ];
  return (
    <ProtectedCard
      testId="invoice-payment"
      fields={fields}
      values={values}
      editable={editable}
      hasFactor={hasFactor}
      changed={changed}
      enrolHref={enrolHref}
      action={updatePaymentAction}
      labels={{ change: t("change"), formLabel: t("formLabel"), formIntro: t("formIntro"), save: t("save") }}
    />
  );
}
