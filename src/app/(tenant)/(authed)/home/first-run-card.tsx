"use client";

import { ArrowRightIcon, CircleCheckIcon, CircleIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

import { SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { isActionRedirect } from "@/lib/action-redirect";
import { TONE_LINE } from "@/lib/tones";
import { cn } from "@/lib/utils";
import type { FirstRunList } from "@/onboarding/first-run";

import { hideFirstRunListAction } from "./actions";

/**
 * GET STARTED (Phase 6 slice 121; founder decision C97 (d)) — the first-run
 * list on Home, for the people who set the workspace up. Each step ticks
 * itself from the workspace's data (`src/onboarding/first-run.ts`) and
 * links to where it is done when the viewer may do it; Hide turns the list
 * off for the whole workspace (Settings → Preferences turns it on again).
 * Skippable and dismissible for good — UI.md §5.8's rule for an onboarding
 * checklist.
 */
export function FirstRunCard({ list }: { list: FirstRunList }) {
  const t = useTranslations("home.firstRun");
  const router = useRouter();
  const [hiding, setHiding] = useState(false);

  const hide = async () => {
    setHiding(true);
    try {
      const r = await hideFirstRunListAction();
      if (!r.ok) {
        toast.error(r.message);
        setHiding(false);
        return;
      }
      toast.success(t("hidden"));
      router.refresh();
    } catch (err) {
      if (isActionRedirect(err)) return;
      toast.error(t("failed"));
      setHiding(false);
    }
  };

  return (
    <SectionCard
      title={t("title")}
      description={t("progress", { done: list.done, total: list.steps.length })}
      actions={
        <Button type="button" variant="ghost" size="sm" onClick={() => void hide()} disabled={hiding} data-testid="first-run-hide">
          {t("hide")}
        </Button>
      }
    >
      <ul className="flex flex-col divide-y divide-border" data-testid="first-run">
        {list.steps.map((s) => (
          <li key={s.key} className="flex min-h-10 items-center gap-3 py-2" data-step={s.key} data-done={s.done ? "true" : "false"}>
            {s.done ? (
              <CircleCheckIcon className={cn("size-4 shrink-0", TONE_LINE.success)} aria-hidden="true" />
            ) : (
              <CircleIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <span className="min-w-0 flex-1">
              <span className={s.done ? "block text-sm text-muted-foreground line-through" : "block text-sm"}>{t(`steps.${s.key}.title`)}</span>
              {!s.done ? <span className="block text-xs text-muted-foreground">{t(`steps.${s.key}.body`)}</span> : null}
              <span className="sr-only">{s.done ? t("doneSr") : t("todoSr")}</span>
            </span>
            {!s.done && s.href ? (
              <Button asChild variant="outline" size="sm" className="shrink-0">
                <Link href={s.href}>
                  {t(`steps.${s.key}.action`)}
                  <ArrowRightIcon />
                </Link>
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
