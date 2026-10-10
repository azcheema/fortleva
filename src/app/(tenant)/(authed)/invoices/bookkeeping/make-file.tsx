"use client";

import { FileDownIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

import { Pending } from "@/components/semantic/field";
import { Button } from "@/components/ui/button";
import { isActionRedirect } from "@/lib/action-redirect";

import { createExportAction } from "./actions";

/**
 * Make file (Phase 4 slice 111): the action, then a toast naming the file —
 * from the action, never from the page (the list re-renders under it). Busy
 * is plain state, not a transition (AGENTS.md: a revalidating action keeps a
 * transition pending through the whole re-render).
 */
export function MakeFile() {
  const t = useTranslations("invoices.bookkeeping.next");
  const tCommon = useTranslations("common");
  const tLines = useTranslations("invoices.lines");
  const [busy, setBusy] = useState(false);

  const make = async () => {
    setBusy(true);
    try {
      const r = await createExportAction();
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(r.value.waiting > 0 ? t("madeWaiting", { number: r.value.number, count: r.value.waiting }) : t("made", { number: r.value.number }));
    } catch (e) {
      if (isActionRedirect(e)) return;
      toast.error(tLines("unreachable"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button type="button" size="sm" onClick={() => void make()} disabled={busy} data-testid="bookkeeping-make">
      {busy ? <Pending label={tCommon("loading")} /> : <FileDownIcon aria-hidden />}
      {t("make")}
    </Button>
  );
}
