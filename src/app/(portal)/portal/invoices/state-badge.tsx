import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import type { PortalInvoiceState } from "@/modules/invoicing/portal";

const VARIANT: Record<PortalInvoiceState, "brand" | "danger" | "success" | "neutral"> = {
  TO_PAY: "brand",
  OVERDUE: "danger",
  PAID: "success",
  CREDITED: "neutral",
  CREDIT_NOTE: "neutral",
};

/** Where a client's invoice stands, in words (slice 109) — the list's and the invoice page's one badge. */
export function InvoiceStateBadge({ state }: { state: PortalInvoiceState }) {
  const t = useTranslations("portal.invoices.state");
  return (
    <Badge variant={VARIANT[state]} data-testid="portal-invoice-state">
      {t(state)}
    </Badge>
  );
}
