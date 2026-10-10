"use client";

import { PencilIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";

import { RowActions } from "@/components/semantic";

import { deleteContractTemplateAction } from "./actions";

/** A template row's verbs: Edit, and Delete — danger, asks first. */
export function TemplateMenu({ templateId, name }: { templateId: string; name: string }) {
  const t = useTranslations("contracts.templates");
  const router = useRouter();
  const [, start] = useTransition();
  return (
    <RowActions
      label={t("menu", { name })}
      items={[
        {
          key: "edit",
          label: t("edit"),
          icon: PencilIcon,
          onSelect: () => router.push(`/settings/contracts/${templateId}`),
        },
        {
          key: "delete",
          label: t("delete"),
          icon: Trash2Icon,
          tone: "danger",
          confirm: t("deleteConfirm"),
          onSelect: () =>
            start(async () => {
              const r = await deleteContractTemplateAction(templateId);
              if (!r.ok) {
                toast.error(r.message);
                return;
              }
              toast.success(r.message);
              router.refresh();
            }),
        },
      ]}
    />
  );
}
