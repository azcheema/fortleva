"use client";

import { FileDownIcon } from "lucide-react";
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

import { handOverUnsentAction } from "./actions";
import { NEEDS_YOU_BODY_ID, NEWEST_FILE_LINK_ID, focusFirst, unsentLinkId } from "./ids";

/** Start a same-origin download, as a click on an `<a download>` would. */
function download(href: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * DOWNLOAD THE ENTRIES NOT SENT (Phase 4 slice 114c; founder decision C90 (c),
 * (d)) — a disconnected connection's file: asked once (Fortleva will never
 * send them; import the file once), then the HAND-OVER, a POST that marks
 * them handed over as the person (`handOverUnsentAction` — the count shown
 * travels with it, so a list that changed under the dialog is refused, never
 * handed over unseen), then the download itself, the GET of
 * `/invoices/bookkeeping/<file>/unsent` — which the file's row offers again
 * as "Not sent (SIE)". Once handed over this button is gone from the
 * re-rendered page, so focus goes to that link, or the card, or the newest
 * file's link — never `<body>`.
 */
export function HandOverUnsent({ exportId, number, count }: { exportId: string; number: number; count: number }) {
  const t = useTranslations("invoices.bookkeeping.needs.unsent");
  const tCommon = useTranslations("common");
  const tLines = useTranslations("invoices.lines");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const go = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await handOverUnsentAction(exportId, count);
      if (!r.ok) {
        // Closed first: the page re-renders with what is true now.
        setOpen(false);
        toast.error(r.message);
        return;
      }
      toast.success(t("handedOver", { count: r.value.count, number: r.value.number }));
      setOpen(false);
      download(`/invoices/bookkeeping/${exportId}/unsent`);
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
        <Button ref={triggerRef} type="button" size="sm" variant="outline" data-testid="bookkeeping-hand-over">
          <FileDownIcon aria-hidden />
          {t("open")}
        </Button>
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-md"
        data-testid="bookkeeping-hand-over-dialog"
        onCloseAutoFocus={(event) => {
          if (triggerRef.current?.isConnected) return;
          event.preventDefault();
          focusFirst([unsentLinkId(exportId), NEEDS_YOU_BODY_ID, NEWEST_FILE_LINK_ID]);
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("confirmTitle", { count, number })}</DialogTitle>
          <DialogDescription>{t("confirmBody")}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t("confirmAgain")}</p>
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
            {tCommon("cancel")}
          </Button>
          <Button type="button" size="sm" onClick={() => void go()} disabled={busy} data-testid="bookkeeping-hand-over-confirm">
            {busy ? <Pending label={tCommon("loading")} /> : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
