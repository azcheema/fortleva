"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";

import { SectionCard } from "@/components/semantic";
import { Pending } from "@/components/semantic/field";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { isActionRedirect } from "@/lib/action-redirect";

import { setContractRemindersAction } from "../actions";

/**
 * "REMIND BEFORE IT ENDS" (Phase 4 slice 112c3; founder decision C87 (a)) — on
 * a SIGNED contract with an end date, written or signed elsewhere: ON, the
 * client's people and the owners are reminded 60, 30, 14, 7 and 1 days before
 * it ends and it is on Renewals; OFF — a contract renewed, or that won't be —
 * neither. `contract:edit`. The switch draws the SERVER's state (the action
 * revalidates the page) and is never optimistic, as "Show to the client"; a
 * refusal is a toast, never a silent revert (AGENTS.md); guarded on this
 * island's own `busy`, never a transition.
 */
export function ContractReminders({
  contractId,
  stoppedAt,
  canEdit,
}: {
  contractId: string;
  /** When they were turned off — the server's answer; null while reminding. */
  stoppedAt: Date | null;
  canEdit: boolean;
}) {
  const t = useTranslations("contracts.reminders");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const on = stoppedAt === null;

  const set = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await setContractRemindersAction(contractId, next);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(r.message);
    } catch (e) {
      if (isActionRedirect(e)) return;
      toast.error(t("unreachable"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard title={t("title")}>
      <div className="flex items-start justify-between gap-3 rounded-md border border-input p-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={id} className="text-sm">
            {t("label")}
          </Label>
          <span className="text-xs text-muted-foreground" data-testid="contract-reminders-state">
            {on ? t("on") : t("off", { date: format.dateTime(stoppedAt, { dateStyle: "medium" }) })}
          </span>
        </div>
        {busy ? <Pending label={tCommon("loading")} className="mt-1" /> : null}
        <Switch
          id={id}
          checked={on}
          disabled={!canEdit || busy}
          onCheckedChange={(next) => void set(next)}
          className="mt-1"
          data-testid="contract-reminders-switch"
        />
      </div>
      {!canEdit ? <p className="mt-2 text-xs text-muted-foreground">{t("noPermission")}</p> : null}
    </SectionCard>
  );
}
