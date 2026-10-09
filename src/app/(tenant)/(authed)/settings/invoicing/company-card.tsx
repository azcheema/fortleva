"use client";

import { useTranslations } from "next-intl";

import { SELLER_TEXT_MAX, vatNumberFor } from "@/modules/invoicing/seller-fields";

import { updateCompanyAction } from "./actions";
import { ProtectedCard, type ProtectedField } from "./protected-card";

export type CompanyValues = {
  readonly legalName: string | null;
  readonly orgNr: string | null;
  readonly vatNumber: string | null;
  readonly seat: string | null;
  readonly fSkattApproved: boolean;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly postalCode: string | null;
  readonly city: string | null;
  readonly countryCode: string | null;
};

/**
 * YOUR COMPANY ON INVOICES (Phase 4 slice 107; founder decision C75 (j)) —
 * printed on every invoice, so protected like the payment details: the code
 * typed in the form, every owner mailed (`ProtectedCard`). It was a record of
 * inline edits until the security review showed that an address line could
 * carry "pay only to Bankgiro …" with neither.
 */
export function CompanyCard({
  values,
  editable,
  hasFactor,
  changed,
  enrolHref,
}: {
  values: CompanyValues;
  editable: boolean;
  hasFactor: boolean;
  changed: { readonly by: string | null; readonly at: string } | null;
  enrolHref: string;
}) {
  const t = useTranslations("settings.invoicing.company");
  const suggestedVat = vatNumberFor(values.orgNr);
  const fields: ProtectedField[] = [
    { name: "legalName", label: t("fields.legalName"), kind: "text", maxLength: SELLER_TEXT_MAX.legalName },
    { name: "orgNr", label: t("fields.orgNr"), kind: "text", mono: true, maxLength: 20 },
    {
      name: "vatNumber",
      label: t("fields.vatNumber"),
      kind: "text",
      mono: true,
      maxLength: 20,
      placeholder: suggestedVat ? t("vatHint", { vat: suggestedVat }) : undefined,
    },
    { name: "seat", label: t("fields.seat"), kind: "text", maxLength: SELLER_TEXT_MAX.seat, hint: t("seatHint") },
    { name: "addressLine1", label: t("fields.addressLine1"), kind: "text", maxLength: SELLER_TEXT_MAX.addressLine },
    { name: "addressLine2", label: t("fields.addressLine2"), kind: "text", maxLength: SELLER_TEXT_MAX.addressLine },
    { name: "postalCode", label: t("fields.postalCode"), kind: "text", mono: true, maxLength: SELLER_TEXT_MAX.postalCode },
    { name: "city", label: t("fields.city"), kind: "text", maxLength: SELLER_TEXT_MAX.city },
    { name: "countryCode", label: t("fields.countryCode"), kind: "text", maxLength: 2 },
    { name: "fSkattApproved", label: t("fields.fSkattApproved"), kind: "checkbox" },
  ];
  return (
    <ProtectedCard
      testId="invoice-company"
      fields={fields}
      values={values}
      editable={editable}
      hasFactor={hasFactor}
      changed={changed}
      enrolHref={enrolHref}
      action={updateCompanyAction}
      labels={{ change: t("change"), formLabel: t("formLabel"), formIntro: t("formIntro"), save: t("save") }}
    />
  );
}
