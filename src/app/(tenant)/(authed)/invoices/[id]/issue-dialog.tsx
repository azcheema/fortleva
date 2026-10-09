"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Callout } from "@/components/semantic";
import { Field, Pending } from "@/components/semantic/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

import { isActionRedirect } from "@/lib/action-redirect";
import type { IssueBlocker } from "@/modules/invoicing";

import { issueInvoiceAction } from "../actions";

/** What the server's issue check said, as plain values (`IssueCheck`, serialised). */
export type IssueDialogCheck = {
  /** A credit note's issue (slice 108b) says "credit note" throughout. */
  readonly kind: "INVOICE" | "CREDIT_NOTE";
  readonly blockers: readonly IssueBlocker[];
  /** Settings → Invoicing's missing items, already worded. */
  readonly sellerMissing: string;
  readonly nextNumber: number | null;
  readonly issueDate: string;
  readonly dueDate: string;
  readonly needsFx: boolean;
  /** The day of the ECB rate (C78 (a)); a credit note's: its invoice's rate's date. */
  readonly rateDay: string | null;
  /** A credit note: each rate it asks too much of, already worded ("25 %", amounts formatted). */
  readonly overCredit: readonly { readonly rate: string; readonly asked: string; readonly left: string }[];
  readonly language: string;
  readonly noPeriod: boolean;
  /** A credit note: its invoice's date (the "before its invoice" blocker names it). */
  readonly creditsIssueDate: string | null;
  /** What the dialog was opened on — sent back with the issue, refused if the draft moved since. */
  readonly fingerprint: string;
  /** Slice 109: the draft's own text reads like somewhere to pay (a web address, account details). */
  readonly paymentText: boolean;
};

/** The issued page's Download PDF — where focus goes after an issue (`download-pdf.tsx`). */
export const DOWNLOAD_PDF_ID = "invoice-download-pdf";

/** Focus an element once the revalidated page has rendered it (a few frames at most). */
export function focusWhenRendered(id: string, frames = 30): void {
  const target = document.getElementById(id);
  if (target) {
    target.focus();
    return;
  }
  if (frames > 0) requestAnimationFrame(() => focusWhenRendered(id, frames - 1));
}

const CLIENT_BLOCKERS: ReadonlySet<IssueBlocker> = new Set(["clientAddress", "clientCountry", "clientVatNumber", "clientVatCountry", "clientInEu"]);

/**
 * ISSUE INVOICE… (Phase 4 slice 108; founder decision C76) — the one way a
 * draft becomes an invoice. The dialog says what it will be (its number, its
 * date and due date, its total and language, the VAT in SEK when there is
 * some) and that it cannot be changed afterwards — or, while something is
 * missing, exactly what, with a link to where it is fixed and no confirm.
 * The number shown is the one it would take NOW; the toast names the one it
 * got (another issue may take it first).
 *
 * Busy is plain state, never a transition: a transition around an action that
 * revalidates stays pending until the whole page has re-rendered (AGENTS.md).
 * A failure is toasted and the dialog stays open — never a revert-looking
 * close; a success closes it and the page re-renders as the issued invoice.
 */
export function IssueDialog({
  invoiceId,
  clientId,
  total,
  check,
  payLink,
  hasFactor,
  enrolHref,
}: {
  invoiceId: string;
  clientId: string;
  /** The total, formatted in the invoice's currency. */
  total: string;
  check: IssueDialogCheck;
  /**
   * Slice 109 (C79 (c), (g)): the draft's Pay now link, shown IN FULL — where
   * the client's money would go — and, when there is one, the issuer's code
   * typed here, as for the bank details. Null: no link, no code.
   */
  payLink: string | null;
  /** The member has an authenticator to type a code from. */
  hasFactor: boolean;
  /** Where "Set up an authenticator" goes, back to this invoice after. */
  enrolHref: string;
}) {
  const t = useTranslations("invoices.issue");
  const tCommon = useTranslations("common");
  const tLines = useTranslations("invoices.lines");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const codeId = `issue-code-${invoiceId}`;
  const needsCode = payLink !== null;
  // Issued: the trigger is gone from the re-rendered page, so focus goes to
  // Download PDF — never to <body> (the code review's low).
  const issuedRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const blocked = check.blockers.length > 0;
  const credit = check.kind === "CREDIT_NOTE";
  // The VAT in SEK: an invoice's at the latest rate — or, when the work ended
  // earlier, that day's (C78 (a)); a credit note's at its invoice's.
  const fxText = credit
    ? t("creditFx", { date: check.rateDay ?? "" })
    : check.rateDay !== null && check.rateDay !== check.issueDate
      ? t("fxDay", { date: check.rateDay })
      : t("fx");

  const issue = async () => {
    setBusy(true);
    try {
      const r = await issueInvoiceAction(invoiceId, check.fingerprint, needsCode ? code : undefined);
      if (!r.ok) {
        toast.error(r.message);
        // A code is spent or wrong once checked: type the next one. One
        // refused before it was checked (too short) stays to be finished.
        if (needsCode && r.codeChecked !== false) setCode("");
        return;
      }
      if (r.caution) toast.warning(r.message);
      else toast.success(r.message);
      // The action revalidated the page: no refresh of our own.
      issuedRef.current = true;
      setOpen(false);
    } catch (e) {
      if (isActionRedirect(e)) return;
      toast.error(tLines("unreachable"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        // Each opening starts without a code (one typed before is spent or stale).
        if (next) setCode("");
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button ref={triggerRef} type="button" size="sm" data-testid="issue-open">
          {credit ? t("creditButton") : t("button")}
        </Button>
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-md"
        data-testid="issue-dialog"
        onCloseAutoFocus={(event) => {
          // Issued here — or by someone else, the page re-rendered without our
          // trigger: Download PDF, never <body> (the fix-pass re-check's nit).
          if (!issuedRef.current && triggerRef.current?.isConnected) return;
          event.preventDefault();
          focusWhenRendered(DOWNLOAD_PDF_ID);
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {credit
              ? check.nextNumber === null
                ? t("creditTitleNoNumber")
                : t("creditTitle", { number: check.nextNumber })
              : check.nextNumber === null
                ? t("titleNoNumber")
                : t("title", { number: check.nextNumber })}
          </DialogTitle>
          <DialogDescription>
            {credit ? t("creditBody", { issueDate: check.issueDate }) : t("body", { issueDate: check.issueDate, dueDate: check.dueDate })}
          </DialogDescription>
        </DialogHeader>
        {blocked ? (
          <div data-testid="issue-blockers">
            <Callout tone="caution" title={credit ? t("creditBlockedTitle") : t("blockedTitle")}>
              <ul className="flex list-disc flex-col gap-1 pl-4">
                {check.blockers.map((b) => (
                  <li key={b} data-testid={`issue-blocker-${b}`}>
                    {b === "seller"
                      ? t("blockers.seller", { list: check.sellerMissing })
                      : b === "beforeInvoice"
                        ? t("blockers.beforeInvoice", { date: check.creditsIssueDate ?? "" })
                        : t(`blockers.${b}`)}
                    {b === "overCredit" ? (
                      <ul className="mt-1 flex flex-col gap-0.5">
                        {check.overCredit.map((o) => (
                          <li key={o.rate} className="num">
                            {t("overCreditAt", o)}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                {check.blockers.includes("seller") ? (
                  <Link
                    href="/settings/invoicing"
                    className="rounded-sm text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {t("toSettings")}
                  </Link>
                ) : null}
                {check.blockers.some((b) => CLIENT_BLOCKERS.has(b)) ? (
                  <Link
                    href={`/clients/${clientId}`}
                    className="rounded-sm text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {t("toClient")}
                  </Link>
                ) : null}
              </div>
            </Callout>
          </div>
        ) : (
          <div className="flex flex-col gap-2 text-sm">
            <dl className="grid grid-cols-[1fr_auto] gap-x-6">
              <dt className="text-muted-foreground">{credit ? t("creditTotal") : t("total")}</dt>
              <dd className="num text-right font-medium" data-testid="issue-total">
                {total}
              </dd>
            </dl>
            <p className="text-muted-foreground">{t("language", { language: check.language })}</p>
            {check.needsFx ? <p className="text-muted-foreground">{fxText}</p> : null}
            {check.noPeriod && !credit ? (
              <div data-testid="issue-no-period">
                <Callout tone="caution">{t("noPeriod")}</Callout>
              </div>
            ) : null}
            {check.paymentText ? (
              <div data-testid="issue-payment-text">
                <Callout tone="caution">{t("paymentText")}</Callout>
              </div>
            ) : null}
            {payLink !== null ? (
              <div className="flex flex-col gap-2" data-testid="issue-pay-link">
                <Callout tone="caution" title={t("payLinkTitle")}>
                  <p className="break-all font-mono text-xs">{payLink}</p>
                  <p className="mt-1">{t("payLinkBody")}</p>
                </Callout>
                {hasFactor ? (
                  <Field label={t("codeLabel")} htmlFor={codeId} hint={t("codeHint")}>
                    <Input
                      id={codeId}
                      value={code}
                      onChange={(ev) => setCode(ev.target.value)}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={32}
                      className="num-id w-40 font-mono"
                      data-testid="issue-code"
                    />
                  </Field>
                ) : (
                  <p className="text-sm" data-testid="issue-needs-factor">
                    {t("needsFactor")}{" "}
                    <Link
                      href={enrolHref}
                      className="rounded-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      {t("setUpFactor")}
                    </Link>
                  </p>
                )}
              </div>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
            {tCommon("cancel")}
          </Button>
          {blocked || (needsCode && !hasFactor) ? null : (
            <Button type="button" size="sm" onClick={() => void issue()} disabled={busy} data-testid="issue-confirm">
              {busy ? <Pending label={tCommon("loading")} /> : credit ? t("creditConfirm") : t("confirm")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
