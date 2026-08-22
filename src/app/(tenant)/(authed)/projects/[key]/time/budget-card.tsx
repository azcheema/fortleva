"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useTransition } from "react";
import { toast } from "sonner";

import { Field, FormMessage, InlineConfirm, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeCheckbox } from "@/components/ui/native-checkbox";
import { NativeSelect } from "@/components/ui/native-select";
import type { FormResult } from "@/lib/server-actions";
import type { BudgetView } from "@/modules/time";

import { archiveBudgetAction, saveBudgetAction } from "./actions";

/**
 * The project's budget (budget:manage): one ACTIVE budget — hours or
 * money, optionally per period — with thresholds that alert once each.
 * Creating a new one archives the old; the alert job runs hourly (and
 * from POST /api/jobs/run until crons exist).
 */
export function BudgetCard({
  projectId,
  projectKey,
  budget,
  currency,
}: {
  projectId: string;
  projectKey: string;
  budget: BudgetView | null;
  currency: string | null;
}) {
  const t = useTranslations("projects.time.budget");
  const router = useRouter();
  const [state, action, pending] = useActionState<FormResult | null, FormData>(async (_p, fd) => saveBudgetAction(fd), null);
  const [archiving, startArchive] = useTransition();

  useEffect(() => {
    if (state?.ok) {
      toast.success(state.message);
      router.refresh();
    }
  }, [state, router]);

  const archive = () =>
    startArchive(async () => {
      if (!budget) return;
      const r = await archiveBudgetAction(budget.id, projectKey).catch(() => ({ ok: false as const, message: t("failed") }));
      if (!r.ok) toast.error(r.message);
      else {
        toast.success(r.message);
        router.refresh();
      }
    });

  return (
    <SectionCard
      title={budget ? t("editTitle") : t("newTitle")}
      description={t("formDescription")}
      size="sm"
      actions={
        budget ? (
          <InlineConfirm
            label={t("archive")}
            question={t("archiveQuestion")}
            onConfirm={archive}
            pending={archiving}
            variant="outline"
            size="sm"
            tone="danger"
          />
        ) : null
      }
    >
      {/* items-START, not items-end: only three of the five fields carry a hint, and
          bottom-alignment pushed the hint-less controls (kind, period) a hint-height
          below the rest. Tops aligned, the controls sit on one line and the hints hang
          under them. The action cell has no label, so it keeps the old bottom edge. */}
      <form action={action} className="grid grid-cols-2 items-start gap-3 md:grid-cols-6">
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="projectKey" value={projectKey} />
        {budget ? <input type="hidden" name="budgetId" value={budget.id} /> : null}
        {/* A disabled control posts nothing: the pinned kind travels as a hidden field (belt; the action does not require it on edit). */}
        {budget ? <input type="hidden" name="kind" value={budget.kind} /> : null}
        <Field htmlFor="b-kind" label={t("kind")}>
          <NativeSelect id="b-kind" name="kind" defaultValue={budget?.kind ?? "HOURS"} disabled={budget !== null}>
            <option value="HOURS">{t("kinds.HOURS")}</option>
            <option value="MONEY">{t("kinds.MONEY")}</option>
          </NativeSelect>
        </Field>
        <Field htmlFor="b-amount" label={t("amount")} hint={currency ?? undefined}>
          <Input id="b-amount" name="amount" inputMode="decimal" defaultValue={budget?.amount ?? ""} required />
        </Field>
        <Field htmlFor="b-period" label={t("period")}>
          <NativeSelect id="b-period" name="period" defaultValue={budget?.period ?? "NONE"} disabled={budget !== null}>
            {(["NONE", "WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"] as const).map((p) => (
              <option key={p} value={p}>
                {t(`periods.${p}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field htmlFor="b-anchor" label={t("periodAnchor")} hint={t("periodAnchorHint")}>
          <Input id="b-anchor" name="periodAnchor" type="date" defaultValue={budget?.periodAnchor ?? ""} disabled={budget !== null} />
        </Field>
        <Field htmlFor="b-thresholds" label={t("thresholds")} hint={t("thresholdsHint")}>
          <Input id="b-thresholds" name="thresholds" defaultValue={(budget?.thresholds ?? [80, 100]).join(", ")} />
        </Field>
        <div className="flex items-center gap-3 self-end">
          <label className="flex items-center gap-2 text-sm">
            <NativeCheckbox name="includeNonBillable" defaultChecked={budget?.includeNonBillable ?? false} />
            {t("includeNonBillable")}
          </label>
          <Button type="submit" size="sm" disabled={pending} className="ml-auto">
            {budget ? t("save") : t("create")}
          </Button>
        </div>
        <FormMessage state={state?.ok ? null : state} className="col-span-2 md:col-span-6" />
      </form>
    </SectionCard>
  );
}
