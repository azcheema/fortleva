"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";

import { Callout } from "@/components/semantic";
import { Field, Pending } from "@/components/semantic/field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { NativeCheckbox } from "@/components/ui/native-checkbox";
import { Textarea } from "@/components/ui/textarea";
import { isActionRedirect } from "@/lib/action-redirect";

import { createCreditDraftAction, creditInFullAction } from "../actions";

/** The radio's look: a native control on the checkbox's geometry, round (the checkbox's tokens). */
const RADIO =
  "mt-0.5 size-4 shrink-0 rounded-full border border-input accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:accent-bg-disabled";

/**
 * CREDIT… (Phase 4 slice 108b; founder decisions C76 (f), C77) — on an issued
 * invoice, for a member who may credit and issue. It asks WHY (required —
 * printed on the credit note, C77 (b)) and WHAT:
 *   - "The whole invoice" — a credit note for every line, issued at once; with
 *     "Make a corrected copy" (checked: C77 (c); offered to a member who may
 *     create invoices) a new draft of the invoice opens, ready to fix and
 *     issue; without, the credit note opens. Offered only while nothing of
 *     the invoice has been credited yet.
 *   - "Part of it" — a credit-note DRAFT with every line opens, to lower or
 *     remove what is not credited and then issue.
 * Busy is plain state, never a transition (AGENTS.md: an action that
 * revalidates keeps a transition pending through the whole re-render). A
 * refusal is toasted and the dialog stays open with what was typed.
 */
export function CreditDialog({
  invoiceId,
  displayNumber,
  partlyCredited,
  canCopy,
}: {
  invoiceId: string;
  displayNumber: string;
  /** Some of it is credited already: only "part of it" is offered. */
  partlyCredited: boolean;
  /** The member may create invoices — the corrected copy is a new draft (`invoice:create`). */
  canCopy: boolean;
}) {
  const t = useTranslations("invoices.credit");
  const tCommon = useTranslations("common");
  const tLines = useTranslations("invoices.lines");
  const router = useRouter();
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [scope, setScope] = useState<"whole" | "part">(partlyCredited ? "part" : "whole");
  // Checked by default (C77 (c)) — for a member who may make the copy at all;
  // otherwise never asked for, so the credit is never refused for it.
  const [copy, setCopy] = useState(canCopy);
  const whole = scope === "whole" && !partlyCredited;
  const reasonId = `${ids}-reason`;

  const submit = async () => {
    setBusy(true);
    try {
      if (whole) {
        const r = await creditInFullAction(invoiceId, reason, canCopy && copy);
        if (!r.ok) {
          toast.error(r.message);
          return;
        }
        if (r.value.caution) toast.warning(r.value.message);
        else toast.success(r.value.message);
        setOpen(false);
        router.push(r.value.goTo);
        return;
      }
      const r = await createCreditDraftAction(invoiceId, reason);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(t("draftMade"));
      setOpen(false);
      router.push(`/invoices/${r.value}`);
    } catch (e) {
      if (isActionRedirect(e)) return;
      toast.error(tLines("unreachable"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : setOpen(next))}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline" data-testid="credit-open">
          {t("button")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md" data-testid="credit-dialog">
        <DialogHeader>
          <DialogTitle>{t("title", { number: displayNumber })}</DialogTitle>
          <DialogDescription>{t("body")}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && reason.trim()) void submit();
          }}
        >
          <Field label={t("reason")} htmlFor={reasonId} hint={t("reasonHint")} required>
            <Textarea
              id={reasonId}
              value={reason}
              maxLength={500}
              rows={2}
              placeholder={t("reasonPlaceholder")}
              onChange={(e) => setReason(e.target.value)}
              data-testid="credit-reason"
            />
          </Field>
          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="mb-1.5 text-sm font-medium">{t("scope")}</legend>
            {partlyCredited ? <Callout tone="info">{t("partlyCredited")}</Callout> : null}
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name={`${ids}-scope`}
                className={RADIO}
                checked={whole}
                disabled={partlyCredited}
                onChange={() => setScope("whole")}
                data-testid="credit-whole"
              />
              <span className="flex min-w-0 flex-col">
                <span>{t("whole")}</span>
                <span className="text-xs text-muted-foreground">{t("wholeHint")}</span>
              </span>
            </label>
            {whole && !canCopy ? <p className="ml-6 text-xs text-muted-foreground">{t("copyNotAllowed")}</p> : null}
            {whole && canCopy ? (
              <label className="ml-6 flex items-start gap-2 text-sm">
                <NativeCheckbox className="mt-0.5" checked={copy} onChange={(e) => setCopy(e.target.checked)} data-testid="credit-copy" />
                <span className="flex min-w-0 flex-col">
                  <span>{t("copy")}</span>
                  <span className="text-xs text-muted-foreground">{t("copyHint")}</span>
                </span>
              </label>
            ) : null}
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name={`${ids}-scope`}
                className={RADIO}
                checked={!whole}
                onChange={() => setScope("part")}
                data-testid="credit-part"
              />
              <span className="flex min-w-0 flex-col">
                <span>{t("part")}</span>
                <span className="text-xs text-muted-foreground">{t("partHint")}</span>
              </span>
            </label>
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
              {tCommon("cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={busy || !reason.trim()} data-testid="credit-confirm">
              {busy ? <Pending label={tCommon("loading")} /> : whole ? t("confirmWhole") : t("confirmPart")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
