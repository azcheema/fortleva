"use server";

import { revalidatePath } from "next/cache";

import { runAction, type ActionResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import { createExport, type MadeFile } from "@/modules/invoicing";

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
