"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { InlineConfirm } from "@/components/semantic";

import { discardUpdateDraftAction } from "./actions";

/**
 * THE ONE VERB A DRAFT KEEPS WHEN THE COMPOSER IS NOT OPEN — on an
 * archived project, whose drafts can no longer be edited or published
 * but must still be discardable (code review, slice 67: a draft with
 * no way out stays in the list forever).
 */
export function DraftActions({ projectKey, id }: { projectKey: string; id: string }) {
  const t = useTranslations("projects.updates.composer");
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <InlineConfirm
      label={t("discard")}
      question={t("discardQuestion")}
      pending={pending}
      variant="ghost"
      tone="danger"
      onConfirm={() =>
        start(async () => {
          const r = await discardUpdateDraftAction({ projectKey, id }).catch(() => ({
            ok: false as const,
            message: t("failed"),
          }));
          if (!r.ok) {
            toast.error(r.message || t("failed"));
            return;
          }
          toast.success(t("discarded"));
          router.push(`/projects/${projectKey}/updates`);
          router.refresh();
        })
      }
    />
  );
}
