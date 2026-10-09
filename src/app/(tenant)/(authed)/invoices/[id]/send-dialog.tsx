"use client";

import { SendIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { isActionRedirect } from "@/lib/action-redirect";

import { markInvoiceSentAction, sendInvoiceAction } from "../actions";
import { DOWNLOAD_PDF_ID } from "./issue-dialog";

/** Addresses one send may go to: the billing email and up to two more (C79 (e)). */
const EXTRA_ADDRESSES = 2;

/**
 * SEND… / SEND AGAIN… (Phase 4 slice 109; founder decision C79 (a), (e)) — an
 * issued invoice or credit note emailed by Fortleva WITH ITS PDF ATTACHED. The
 * first address is the client card's billing email, changeable; two more may
 * be added. The dialog says what happens: the PDF goes with it, and — the
 * first time — the client's main contacts can then see it in their portal.
 *
 * MARK AS SENT lives here too, below the form, with its consequence written
 * beside it (it opens the portal to the invoice for good): an invoice sent
 * another way. Not a menu item — a confirm on a menu item that is not a danger
 * would never render (AGENTS.md's trap), and this is not a danger.
 *
 * Busy is plain state, never a transition (the action revalidates — AGENTS.md).
 * A refusal is toasted and the dialog stays open with what was typed; a send
 * that reached some addresses, or whose record failed, is a warning toast.
 */
export function SendDialog({
  invoiceId,
  credit,
  displayNumber,
  billingEmail,
  billingEmailBlocked,
  sentBefore,
  canMarkSent,
}: {
  invoiceId: string;
  credit: boolean;
  displayNumber: string;
  /** The client card's billing email, or null. */
  billingEmail: string | null;
  /** That address is on the blocked list (bounced or reported) — never why (C71 (d)). */
  billingEmailBlocked: boolean;
  /** Sent before: "Send again…". */
  sentBefore: boolean;
  /** Not yet sent: "Mark as sent" is offered. */
  canMarkSent: boolean;
}) {
  const t = useTranslations("invoices.send");
  const tCommon = useTranslations("common");
  const tLines = useTranslations("invoices.lines");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [to, setTo] = useState(billingEmail ?? "");
  const [extra, setExtra] = useState<string[]>(Array.from({ length: EXTRA_ADDRESSES }, () => ""));
  const triggerRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef(false);

  const reset = () => {
    setTo(billingEmail ?? "");
    setExtra(Array.from({ length: EXTRA_ADDRESSES }, () => ""));
  };

  const finish = (r: { ok: boolean; message: string; caution?: boolean }) => {
    if (!r.ok) {
      toast.error(r.message);
      return;
    }
    if (r.caution) toast.warning(r.message);
    else toast.success(r.message);
    doneRef.current = true;
    setOpen(false);
  };

  const send = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      finish(await sendInvoiceAction(invoiceId, [to, ...extra]));
    } catch (e) {
      if (isActionRedirect(e)) return;
      toast.error(tLines("unreachable"));
    } finally {
      setBusy(false);
    }
  };

  const mark = async () => {
    if (busy) return;
    setBusy(true);
    try {
      finish(await markInvoiceSentAction(invoiceId));
    } catch (e) {
      if (isActionRedirect(e)) return;
      toast.error(tLines("unreachable"));
    } finally {
      setBusy(false);
    }
  };

  const toBlocked = billingEmailBlocked && billingEmail !== null && to.trim().toLowerCase() === billingEmail.toLowerCase();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (next) {
          reset();
          doneRef.current = false;
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button ref={triggerRef} type="button" size="sm" variant={sentBefore ? "outline" : "default"} data-testid="send-open">
          <SendIcon aria-hidden="true" />
          {sentBefore ? t("againButton") : t("button")}
        </Button>
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-md"
        data-testid="send-dialog"
        onCloseAutoFocus={(event) => {
          // The page re-rendered: the trigger is the same button unless it is
          // gone — then Download PDF, never <body>.
          if (triggerRef.current?.isConnected) return;
          event.preventDefault();
          document.getElementById(DOWNLOAD_PDF_ID)?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{credit ? t("titleCredit", { number: displayNumber }) : t("title", { number: displayNumber })}</DialogTitle>
          <DialogDescription>{sentBefore ? t("bodyAgain") : t("body")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(ev) => void send(ev)} className="flex flex-col gap-3" aria-label={t("formLabel")}>
          <Field label={t("to")} htmlFor={`send-to-${invoiceId}`} hint={billingEmail ? undefined : t("noBillingEmail")}>
            <Input
              id={`send-to-${invoiceId}`}
              type="email"
              value={to}
              onChange={(ev) => setTo(ev.target.value)}
              autoComplete="off"
              maxLength={254}
              required
              data-testid="send-to"
            />
          </Field>
          {toBlocked ? (
            <div data-testid="send-blocked">
              <Callout tone="caution">{t("blockedNote")}</Callout>
            </div>
          ) : null}
          {extra.map((value, i) => (
            <Field key={i} label={t("alsoTo", { n: i + 1 })} htmlFor={`send-also-${invoiceId}-${i}`}>
              <Input
                id={`send-also-${invoiceId}-${i}`}
                type="email"
                value={value}
                onChange={(ev) => setExtra((xs) => xs.map((x, j) => (j === i ? ev.target.value : x)))}
                autoComplete="off"
                maxLength={254}
                data-testid={`send-also-${i}`}
              />
            </Field>
          ))}
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
              {tCommon("cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={busy} data-testid="send-confirm">
              {busy ? <Pending label={tCommon("loading")} /> : t("confirm")}
            </Button>
          </DialogFooter>
        </form>
        {canMarkSent ? (
          <div className="flex flex-col gap-2 border-t border-border pt-3" data-testid="mark-sent">
            <p className="text-sm text-muted-foreground">{t("markBody")}</p>
            <div>
              <Button type="button" variant="outline" size="sm" onClick={() => void mark()} disabled={busy} data-testid="mark-sent-confirm">
                {t("markButton")}
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
