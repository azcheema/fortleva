"use client";

import { Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";

import { RowActions } from "@/components/semantic";

import { deleteDraftAction } from "../actions";

/**
 * The draft's own verbs (MANDATE 2): Delete draft — danger, asks first;
 * `invoice:delete` (owners and admins). An issued invoice has no delete: it
 * is credited (slice 108). The toast comes from here, before the list loads,
 * because the page that held the menu is gone once it succeeds.
 */
export function DraftMenu({ invoiceId, label }: { invoiceId: string; label: string }) {
  const t = useTranslations("invoices.draft");
  const router = useRouter();
  const [, start] = useTransition();
  return (
    <RowActions
      label={label}
      items={[
        {
          key: "delete",
          label: t("delete"),
          icon: Trash2Icon,
          tone: "danger",
          confirm: t("deleteConfirm"),
          onSelect: () =>
            start(async () => {
              const r = await deleteDraftAction(invoiceId);
              if (!r.ok) {
                toast.error(r.message);
                return;
              }
              toast.success(r.message);
              router.push("/invoices");
            }),
        },
      ]}
    />
  );
}
