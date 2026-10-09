"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Callout } from "@/components/semantic";
import { Pending } from "@/components/semantic/field";
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

import { isActionRedirect } from "@/lib/action-redirect";
import type { IssueBlocker } from "@/modules/invoicing";

import { issueInvoiceAction } from "../actions";

/** What the server's issue check said, as plain values (`IssueCheck`, serialised). */
export type IssueDialogCheck = {
  readonly blockers: readonly IssueBlocker[];
  /** Settings → Invoicing's missing items, already worded. */
  readonly sellerMissing: string;
  readonly nextNumber: number | null;
  readonly issueDate: string;
  readonly dueDate: string;
  readonly needsFx: boolean;
  readonly language: string;
  readonly noPeriod: boolean;
  /** What the dialog was opened on — sent back with the issue, refused if the draft moved since. */
  readonly fingerprint: string;
};

/** The issued page's Download PDF — where focus goes after an issue (`download-pdf.tsx`). */
export const DOWNLOAD_PDF_ID = "invoice-download-pdf";

/** Focus an element once the revalidated page has rendered it (a few frames at most). */
function focusWhenRendered(id: string, frames = 30): void {
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
}: {
  invoiceId: string;
  clientId: string;
  /** The total, formatted in the invoice's currency. */
  total: string;
  check: IssueDialogCheck;
}) {
  const t = useTranslations("invoices.issue");
  const tCommon = useTranslations("common");
  const tLines = useTranslations("invoices.lines");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Issued: the trigger is gone from the re-rendered page, so focus goes to
  // Download PDF — never to <body> (the code review's low).
  const issuedRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const blocked = check.blockers.length > 0;

  const issue = async () => {
    setBusy(true);
    try {
      const r = await issueInvoiceAction(invoiceId, check.fingerprint);
      if (!r.ok) {
        toast.error(r.message);
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
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : setOpen(next))}>
      <DialogTrigger asChild>
        <Button ref={triggerRef} type="button" size="sm" data-testid="issue-open">
          {t("button")}
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
          <DialogTitle>{check.nextNumber === null ? t("titleNoNumber") : t("title", { number: check.nextNumber })}</DialogTitle>
          <DialogDescription>{t("body", { issueDate: check.issueDate, dueDate: check.dueDate })}</DialogDescription>
        </DialogHeader>
        {blocked ? (
          <div data-testid="issue-blockers">
            <Callout tone="caution" title={t("blockedTitle")}>
              <ul className="flex list-disc flex-col gap-1 pl-4">
                {check.blockers.map((b) => (
                  <li key={b} data-testid={`issue-blocker-${b}`}>
                    {b === "seller" ? t("blockers.seller", { list: check.sellerMissing }) : t(`blockers.${b}`)}
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
              <dt className="text-muted-foreground">{t("total")}</dt>
              <dd className="num text-right font-medium" data-testid="issue-total">
                {total}
              </dd>
            </dl>
            <p className="text-muted-foreground">{t("language", { language: check.language })}</p>
            {check.needsFx ? <p className="text-muted-foreground">{t("fx")}</p> : null}
            {check.noPeriod ? (
              <div data-testid="issue-no-period">
                <Callout tone="caution">{t("noPeriod")}</Callout>
              </div>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
            {tCommon("cancel")}
          </Button>
          {blocked ? null : (
            <Button type="button" size="sm" onClick={() => void issue()} disabled={busy} data-testid="issue-confirm">
              {busy ? <Pending label={tCommon("loading")} /> : t("confirm")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
