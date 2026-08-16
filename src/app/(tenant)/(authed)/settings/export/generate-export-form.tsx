"use client";

import { PackageIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useTransition, useState } from "react";
import { toast } from "sonner";

import { FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import type { FormResult } from "@/lib/server-actions";

import { generateExportAction } from "./actions";

/**
 * One button (tenant:export ✦): generates the zip; step-up navigation
 * happens server-side. Zipping a whole workspace is a long
 * indeterminate job, so the pending state says what is happening in
 * words and announces it politely — a spinner alone would leave the
 * reader wondering whether the click landed.
 */
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
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="lg"
          disabled={pending}
          onClick={() => startTransition(async () => setState(await generateExportAction()))}
        >
          <PackageIcon />
          {pending ? t("generating") : t("generate")}
        </Button>
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span aria-hidden="true">{"✦"}</span>
          {t("mfaHint")}
        </span>
      </div>
      {pending ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t("generatingHint")}
        </p>
      ) : null}
      {state && !state.ok ? <FormMessage state={state} /> : null}
    </div>
  );
}
