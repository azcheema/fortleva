"use client";

import { CalendarCheckIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { toast } from "sonner";

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

import { bookYearEndAction } from "./actions";
import { NEWEST_FILE_LINK_ID } from "./ids";

/**
 * BOOK THE YEAR END (Phase 4 slice 111b; founder decision C83 (a)) — asked
 * once more before a one-way act: the day, how many unpaid invoices and
 * their total, and that a payment marked later corrects it in a later file
 * (C83 (b)). Disabled while entries of that year still wait for a file. The
 * day, the count and the total travel with the action, so a year end booked
 * meanwhile, or a list that changed under the dialog, is refused — never
 * booked unseen.
 *
 * Once booked the card is gone from the re-rendered page, so focus goes to
 * the new file's List link — never to <body>.
 */
export function BookYearEnd({
  yearEnd,
  dayLabel,
  nextDayLabel,
  count,
  totalSek,
  totalLabel,
  disabled,
}: {
  yearEnd: string;
  dayLabel: string;
  nextDayLabel: string;
  count: number;
  /** The total as the service computed it ("12345.00") — sent back with the press. */
  totalSek: string;
  totalLabel: string;
  disabled: boolean;
}) {
  const t = useTranslations("invoices.bookkeeping.yearEnd");
  const tCommon = useTranslations("common");
  const tLines = useTranslations("invoices.lines");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const book = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await bookYearEndAction(yearEnd, count, totalSek);
      if (!r.ok) {
        // Closed first: the page re-renders with what is true now, and a second
        // press must come from the card it shows, never this dialog's old figures.
        setOpen(false);
        toast.error(r.message);
        return;
      }
      toast.success(r.value.count > 0 ? t("booked", { number: r.value.number }) : t("bookedEmpty", { day: dayLabel, number: r.value.number }));
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
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button ref={triggerRef} type="button" size="sm" disabled={disabled} data-testid="year-end-open">
          <CalendarCheckIcon aria-hidden />
          {t("book")}
        </Button>
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-md"
        data-testid="year-end-dialog"
        onCloseAutoFocus={(event) => {
          if (triggerRef.current?.isConnected) return;
          event.preventDefault();
          document.getElementById(NEWEST_FILE_LINK_ID)?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("confirmTitle", { day: dayLabel })}</DialogTitle>
          <DialogDescription>
            {count > 0 ? t("confirmBody", { count, total: totalLabel, day: dayLabel, nextDay: nextDayLabel }) : t("confirmEmpty", { day: dayLabel })}
          </DialogDescription>
        </DialogHeader>
        {count > 0 ? <p className="text-sm text-muted-foreground">{t("confirmLate")}</p> : null}
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
            {tCommon("cancel")}
          </Button>
          <Button type="button" size="sm" onClick={() => void book()} disabled={busy} data-testid="year-end-confirm">
            {busy ? <Pending label={tCommon("loading")} /> : t("book")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
