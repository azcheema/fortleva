import type { NextRequest } from "next/server";
import { getFormatter, getTranslations } from "next-intl/server";

import { isUuid } from "@/db/context";
import { badRequest, crossSiteRefusal, downloadFailure, fileResponse } from "@/lib/http-download";
import { XLSX_MIME } from "@/lib/xlsx";
import { requireTenantContext } from "@/members/tenant-context";
import { exportFile, LIST_COLUMNS, LIST_EVENTS, VAT_PROFILES, type ListWords } from "@/modules/invoicing";

/**
 * GET /invoices/bookkeeping/<file>/sie | /xlsx (Phase 4 slice 111; C82 (a)) —
 * a bookkeeping file's SIE import for Fortnox, or its list. Regenerated from
 * what the file froze on every download (`exportFile`, which checks
 * `invoice:export`, `invoice:view` and the tenant-wide scope, and audits the
 * bytes' hash). Tenant and member from the session, never the URL; a
 * same-origin attachment, `no-store` (ARC-25).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; format: string }> }): Promise<Response> {
  const refused = crossSiteRefusal(request);
  if (refused) return refused;
  const { id, format } = await params;
  if (!isUuid(id)) return badRequest("file");
  if (format !== "sie" && format !== "xlsx") return badRequest("format");
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("invoices.bookkeeping.list");
  const formatter = await getFormatter();
  const day = (d: string) => formatter.dateTime(new Date(`${d}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });
  const words: ListWords & { readonly sheet: string } = {
    sheet: t("sheet"),
    headers: Object.fromEntries(LIST_COLUMNS.map((c) => [c, t(`headers.${c}`)])) as ListWords["headers"],
    events: Object.fromEntries(LIST_EVENTS.map((e) => [e, t(`events.${e}`)])) as ListWords["events"],
    invoice: t("invoice"),
    creditNote: t("creditNote"),
    treatments: Object.fromEntries(VAT_PROFILES.map((p) => [p, t(`treatments.${p}`)])) as ListWords["treatments"],
    remark: (r) => (r.day !== undefined && r.file !== undefined ? t(`remarks.${r.kind}`, { day: day(r.day), file: r.file }) : t(`remarks.${r.kind}`, { day: "", file: 0 })),
  };
  try {
    const file = await exportFile({ tenantId: membership.tenantId, actor }, id, format, words);
    return fileResponse(file.bytes, file.fileName, format === "sie" ? "application/octet-stream" : XLSX_MIME);
  } catch (e) {
    return downloadFailure(e, "/invoices/bookkeeping");
  }
}
