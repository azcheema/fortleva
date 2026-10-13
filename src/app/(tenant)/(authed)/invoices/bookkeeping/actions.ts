"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";

import { runAction, runForm, type ActionResult, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import {
  bookYearEnd,
  createExport,
  handOverUnsent,
  markFortnoxDelivery,
  type HandedOver,
  type MadeFile,
  type YearEndBooked,
} from "@/modules/invoicing";

/**
 * Make file (Phase 4 slice 111; C82): the next bookkeeping file of what is
 * new. Tenant and actor from the session; `bookkeeping.ts` checks the codes
 * and the tenant-wide scope, freezes the file and audits it.
 */
export async function createExportAction(): Promise<ActionResult<MadeFile>> {
  const { membership, actor } = await requireTenantContext();
  const r = await runAction("/invoices/bookkeeping", () => createExport({ tenantId: membership.tenantId, actor }));
  if (r.ok) revalidatePath("/invoices/bookkeeping");
  return r;
}

/**
 * Book the year end (Phase 4 slice 111b; C83 (a)): the year-end file of what
 * the person was shown — the day, how many invoices, their total (the
 * service refuses anything else). Tenant and actor from the session;
 * `/invoices` revalidated too, for its reminder — and the page EVEN ON A
 * REFUSAL (its code review's 3): after "the list changed" or "booked
 * meanwhile" the card must show what is true now, or the next press sends
 * the same stale figures.
 */
export async function bookYearEndAction(yearEnd: string, count: number, totalSek: string): Promise<ActionResult<YearEndBooked>> {
  const { membership, actor } = await requireTenantContext();
  const r = await runAction("/invoices/bookkeeping", () => bookYearEnd({ tenantId: membership.tenantId, actor }, { yearEnd, count, totalSek }));
  revalidatePath("/invoices/bookkeeping");
  if (r.ok) revalidatePath("/invoices");
  return r;
}

/**
 * Booked by hand / Not in Fortnox (Phase 4 slice 114c; C90): an entry owed to
 * Fortnox decided by the person. Tenant and actor from the session;
 * `fortnox-people.ts` checks the page's gates, which entries a person may
 * decide, and audits. The page EVEN ON A REFUSAL — after "decided meanwhile"
 * it must show what is true now.
 */
export async function markFortnoxDeliveryAction(deliveryId: string, act: string): Promise<FormResult> {
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("invoices.bookkeeping.needs");
  const r = await runForm("/invoices/bookkeeping", async () => {
    // Anything but the two acts is refused by the service (NOT_FOUND).
    await markFortnoxDelivery({ tenantId: membership.tenantId, actor }, String(deliveryId), String(act));
    return act === "NOT_IN_FORTNOX" ? t("notInFortnoxDone") : t("byHandDone");
  });
  revalidatePath("/invoices/bookkeeping");
  return r;
}

/**
 * Hand over a disconnected connection's file of entries never sent (slice
 * 114c; C90 (c)) — the count the person was shown travels with it; the
 * download itself is the GET that follows. The page EVEN ON A REFUSAL.
 */
export async function handOverUnsentAction(exportId: string, count: number): Promise<ActionResult<HandedOver>> {
  const { membership, actor } = await requireTenantContext();
  const r = await runAction("/invoices/bookkeeping", () => handOverUnsent({ tenantId: membership.tenantId, actor }, String(exportId), Number(count)));
  revalidatePath("/invoices/bookkeeping");
  return r;
}
