"use server";

import { revalidatePath } from "next/cache";

import { runAction, type ActionResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import { bookYearEnd, createExport, type MadeFile, type YearEndBooked } from "@/modules/invoicing";

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
