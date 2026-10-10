"use client";

import { Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";

import { RowActions } from "@/components/semantic";

import { deleteContractDraftAction } from "../actions";

/**
 * The draft's own verbs: Delete draft — danger, asks first; `contract:delete`
 * (owners and managers). A sent contract has no delete (112b withdraws it).
 * The toast comes from here, before the list loads, because the page that held
 * the menu is gone once it succeeds.
 */
export function ContractDraftMenu({ contractId }: { contractId: string }) {
  const t = useTranslations("contracts.draft");
  const router = useRouter();
  const [, start] = useTransition();
  return (
    <RowActions
      label={t("menu")}
      items={[
        {
          key: "delete",
          label: t("delete"),
          icon: Trash2Icon,
          tone: "danger",
          confirm: t("deleteConfirm"),
          onSelect: () =>
            start(async () => {
              const r = await deleteContractDraftAction(contractId);
              if (!r.ok) {
                toast.error(r.message);
                return;
              }
              toast.success(r.message);
              router.push("/contracts");
            }),
        },
      ]}
    />
  );
}
