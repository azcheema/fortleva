"use client";

import { Undo2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";

import { RowActions } from "@/components/semantic";

import { markInvoiceUnpaidAction } from "../actions";
import { DOWNLOAD_PDF_ID, focusWhenRendered } from "./issue-dialog";

/**
 * A PAID invoice's one verb (Phase 4 slice 109; founder decision C79 (h)):
 * MARK AS UNPAID — a Paid mark undone (the wrong invoice, the wrong day). It
 * takes the payment's day and note away and the client's portal says unpaid
 * again, so it earns the danger weight and asks first (a confirm on any other
 * tone never renders — AGENTS.md). Audited with what was undone.
 */
export function PaidMenu({ invoiceId, label }: { invoiceId: string; label: string }) {
  const t = useTranslations("invoices.payment");
  const [, start] = useTransition();
  return (
    <RowActions
      label={label}
      items={[
        {
          key: "unpaid",
          label: t("undo"),
          icon: Undo2Icon,
          tone: "danger",
          confirm: t("undoConfirm"),
          onSelect: () =>
            start(async () => {
              const r = await markInvoiceUnpaidAction(invoiceId);
              if (!r.ok) {
                toast.error(r.message);
                return;
              }
              toast.success(r.message);
              // The menu's trigger is gone from the re-rendered page (nothing is
              // paid any more): Download PDF, never <body> (the code review's low).
              focusWhenRendered(DOWNLOAD_PDF_ID);
            }),
        },
      ]}
    />
  );
}
