"use client";

import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { toast } from "sonner";

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
import { Textarea } from "@/components/ui/textarea";
import { isActionRedirect } from "@/lib/action-redirect";

import { markInvoicePaidAction } from "../actions";
import { DOWNLOAD_PDF_ID } from "./issue-dialog";

/** The note's limit (the database's CHECK). */
const NOTE_MAX = 500;

/**
 * MARK AS PAID… (Phase 4 slice 109; founder decision C79 (d)) — an unpaid
 * invoice marked paid by hand: the day the money arrived (today in the
 * workspace's zone to start with; never after it) and, optionally, the
 * agency's own note — the bank's reference, "USD 15 short, bank fee". The
 * client's portal then says Paid; the note is the team's only.
 *
 * Once marked, the trigger is gone from the re-rendered page, so focus goes to
 * Download PDF — never to <body>.
 *
 * Slice 111b (its design review's L9): a day on or before the newest booked
 * year end says so — the next bookkeeping file books the payment into a
 * year the accountant may have closed.
 */
export function PaidDialog({
  invoiceId,
  displayNumber,
  today,
  closedYear,
}: {
  invoiceId: string;
  displayNumber: string;
  today: string;
  /** The newest booked year end (`YYYY-MM-DD`) and how the page prints it, or null. */
  closedYear: { day: string; label: string } | null;
}) {
  const t = useTranslations("invoices.payment");
  const tCommon = useTranslations("common");
  const tLines = useTranslations("invoices.lines");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [paidOn, setPaidOn] = useState(today);
  const [note, setNote] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const r = await markInvoicePaidAction(invoiceId, paidOn, note.trim() === "" ? null : note);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(r.message);
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
        if (next) {
          setPaidOn(today);
          setNote("");
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button ref={triggerRef} type="button" size="sm" variant="outline" data-testid="paid-open">
          {t("button")}
        </Button>
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-md"
        data-testid="paid-dialog"
        onCloseAutoFocus={(event) => {
          if (triggerRef.current?.isConnected) return;
          event.preventDefault();
          document.getElementById(DOWNLOAD_PDF_ID)?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("title", { number: displayNumber })}</DialogTitle>
          <DialogDescription>{t("body")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(ev) => void submit(ev)} className="flex flex-col gap-3" aria-label={t("formLabel")}>
          <Field label={t("paidOn")} htmlFor={`paid-on-${invoiceId}`}>
            <Input
              id={`paid-on-${invoiceId}`}
              type="date"
              value={paidOn}
              max={today}
              onChange={(ev) => setPaidOn(ev.target.value)}
              required
              className="w-44"
              data-testid="paid-on"
            />
          </Field>
          {closedYear && paidOn !== "" && paidOn <= closedYear.day ? (
            <p className="text-sm text-muted-foreground" data-testid="paid-closed-year">
              {t("closedYear", { day: closedYear.label })}
            </p>
          ) : null}
          <Field label={t("note")} htmlFor={`paid-note-${invoiceId}`} hint={t("noteHint")}>
            <Textarea
              id={`paid-note-${invoiceId}`}
              value={note}
              onChange={(ev) => setNote(ev.target.value)}
              maxLength={NOTE_MAX}
              rows={2}
              data-testid="paid-note"
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
              {tCommon("cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={busy} data-testid="paid-confirm">
              {busy ? <Pending label={tCommon("loading")} /> : t("confirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
