"use client";

import { ChevronDownIcon, CopyIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

import { copyLastWeekAction } from "./actions";

/**
 * "Copy last week" on the week card (UI.md rule 9, D6): the primary copies
 * last week's ROWS into the viewed week with empty durations — the member
 * fills the hours in; "copy with durations" is the explicit secondary, one
 * item behind the caret, never the default. The page renders this only
 * when last week has rows (nothing to copy ⇒ no verb, §5.8). Not
 * destructive, so no confirm: every copied row is an ordinary entry the
 * grid can edit or delete, and copying twice adds nothing (idempotent).
 */
export function CopyLastWeek({ weekFrom }: { weekFrom: string }) {
  const t = useTranslations("time.week.copy");
  const router = useRouter();
  const [pending, start] = useTransition();

  const run = (withDurations: boolean) =>
    start(async () => {
      const r = await copyLastWeekAction({ weekFrom, withDurations }).catch(() => ({ ok: false as const, message: t("failed") }));
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      const { created, alreadyPresent, unusable } = r.value;
      if (created > 0) toast.success(t("done", { count: created, present: alreadyPresent, unusable }));
      else if (alreadyPresent + unusable > 0) toast.info(t("nothingNew", { present: alreadyPresent, unusable }));
      else toast.info(t("nothing"));
      router.refresh();
    });

  return (
    <div className="flex items-center gap-1" data-testid="copy-last-week">
      <Button type="button" variant="outline" size="sm" disabled={pending} title={t("hint")} onClick={() => run(false)} data-testid="copy-last-week-rows">
        <CopyIcon aria-hidden="true" />
        {t("button")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="icon-sm" disabled={pending} aria-label={t("more")} data-testid="copy-last-week-more">
            <ChevronDownIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => run(true)} data-testid="copy-last-week-durations">
            {t("withDurations")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
