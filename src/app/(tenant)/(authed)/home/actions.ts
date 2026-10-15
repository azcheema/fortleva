"use server";

import { revalidatePath } from "next/cache";

import { runAction, type ActionResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import { hideFirstRunList } from "@/onboarding/first-run";

/**
 * Hide the getting-started list (Phase 6 slice 121; founder decision C97
 * (d)) — for the whole workspace, through the preferences' own
 * `settings:edit` gate and audit. The tenant and member come from the
 * session, never from a parameter.
 */
export async function hideFirstRunListAction(): Promise<ActionResult<void>> {
  const { membership, actor } = await requireTenantContext();
  const r = await runAction("/home", () => hideFirstRunList({ tenantId: membership.tenantId, actor }));
  if (r.ok) revalidatePath("/home");
  return r;
}
