"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useTransition, useState } from "react";
import { toast } from "sonner";

import { FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import type { FormResult } from "@/lib/server-actions";

import { generateExportAction } from "./actions";

/** One button (tenant:export ✦): generates the zip; step-up navigation happens server-side. */
export function GenerateExportForm() {
  const t = useTranslations("settings.export");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<FormResult | null>(null);

  useEffect(() => {
    if (state?.ok) {
      toast.success(state.message);
      router.refresh();
    }
  }, [state, router]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        type="button"
        disabled={pending}
        onClick={() => startTransition(async () => setState(await generateExportAction()))}
      >
        {pending ? t("generating") : t("generate")}
      </Button>
      <span className="text-xs text-muted-foreground">{t("mfaHint")}</span>
      {state && !state.ok ? <FormMessage state={state} className="basis-full" /> : null}
    </div>
  );
}
