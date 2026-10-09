"use client";

import { DownloadIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

import { Pending } from "@/components/semantic/field";
import { Button } from "@/components/ui/button";
import { isActionRedirect } from "@/lib/action-redirect";

import { invoicePdfUrlAction } from "../actions";
import { DOWNLOAD_PDF_ID } from "./issue-dialog";

/**
 * Download PDF (Phase 4 slice 108): asks the server for a minute-long,
 * attachment-only link to the issued invoice's archived PDF — made first if
 * its issue could not make it — and goes there. A POST (a server action), so
 * no cross-site link can make a PDF. Busy is plain state (AGENTS.md: the
 * action revalidates, and a transition would stay pending through it).
 */
export function DownloadPdf({ invoiceId }: { invoiceId: string }) {
  const t = useTranslations("invoices.issued");
  const tCommon = useTranslations("common");
  const tLines = useTranslations("invoices.lines");
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setBusy(true);
    try {
      const r = await invoicePdfUrlAction(invoiceId);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      window.location.assign(r.value);
    } catch (e) {
      if (isActionRedirect(e)) return;
      toast.error(tLines("unreachable"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      id={DOWNLOAD_PDF_ID}
      type="button"
      size="sm"
      variant="outline"
      onClick={() => void download()}
      disabled={busy}
      data-testid="invoice-download"
    >
      {busy ? <Pending label={tCommon("loading")} /> : <DownloadIcon aria-hidden />}
      {t("download")}
    </Button>
  );
}
