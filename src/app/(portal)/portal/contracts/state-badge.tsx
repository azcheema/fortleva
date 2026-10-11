import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import type { PortalContractStatus } from "@/modules/contracts/portal";

const VARIANT: Record<PortalContractStatus, "brand" | "danger" | "success" | "neutral"> = {
  SENT: "brand",
  SIGNED: "success",
  DECLINED: "danger",
  WITHDRAWN: "neutral",
};

/** Where a client's contract stands, in words (slice 112b2) — the list's and the contract page's one badge. */
export function ContractStateBadge({ status, waitingForYou }: { status: PortalContractStatus; waitingForYou: boolean }) {
  const t = useTranslations("portal.contracts.state");
  return (
    <Badge variant={VARIANT[status]} data-testid="portal-contract-state" data-status={status}>
      {status === "SENT" && waitingForYou ? t("SENT_YOU") : t(status)}
    </Badge>
  );
}
