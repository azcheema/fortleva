"use client";

import { PrinterIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";

/** The one client-side verb of the statement page: the browser's print dialog. Hidden on paper. */
export function PrintButton() {
  const t = useTranslations("time.statement");
  return (
    <Button type="button" size="sm" className="print:hidden" onClick={() => window.print()} data-testid="statement-print">
      <PrinterIcon aria-hidden="true" />
      {t("printButton")}
    </Button>
  );
}
