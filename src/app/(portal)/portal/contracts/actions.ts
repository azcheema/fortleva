"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { field } from "@/lib/server-actions";
import { decidePortalContract } from "@/modules/contracts/portal-sign";
import { resolvePortalContractPdf } from "@/modules/contracts/portal-writes";
import { parseContractDecision } from "@/modules/contracts/sign-input";
import { runPortalAction } from "@/portal/action";
import { requirePortalContext } from "@/portal/context";

/**
 * THE CLIENT'S CONTRACT ACTIONS (Phase 4 slice 112b2; founder decisions C84,
 * C85). The principal from the SESSION and nowhere else; the contract id an
 * argument that names a row and never widens what is reachable — the census
 * write (`decidePortalContract`) and the broker (`resolvePortalContractPdf`)
 * prove it under the contact. Every refusal is the plane's (`runPortalAction`):
 * the reader's own input or budget said as such, everything else one generic
 * sentence — a reason is a fact about the agency.
 */

export type ContractDecisionAnswer =
  | { readonly ok: true; readonly status: "SIGNED" | "DECLINED"; readonly decidedAt: string; readonly changed: boolean }
  | { readonly ok: false; readonly message: string };

/**
 * SIGN or DECLINE. The IP address and browser the evidence keeps are the
 * REQUEST's, read by the service — never a field here. Revalidates the whole
 * portal: the nav, the home's card and the list all say what waits.
 */
export async function decideContractAction(
  contractId: string,
  input: { readonly decision: unknown; readonly accepted?: unknown; readonly typedName?: unknown; readonly reason?: unknown },
): Promise<ContractDecisionAnswer> {
  const { principal } = await requirePortalContext();
  const result = await runPortalAction("decideContract", async () =>
    decidePortalContract(principal, contractId, parseContractDecision(input)),
  );
  if (!result.ok) return { ok: false, message: result.message };
  revalidatePath("/portal", "layout");
  const v = result.value;
  return { ok: true, status: v.status, decidedAt: v.decidedAt.toISOString(), changed: v.changed };
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DOWNLOAD the PDF as sent or the signed copy — the invoice download's shape
 * (`../invoices/actions.ts`): success redirects off-origin to a short-lived
 * attachment-only link; a refusal lands back on the contract's own page with
 * one of two words — `rate` (the reader's own budget) or `download`.
 */
export async function downloadContractAction(formData: FormData): Promise<void> {
  const raw = field(formData, "contractId") ?? "";
  // Only an id shapes the landing path — never an open redirect.
  const contractId = ID.test(raw) ? raw : "";
  const kind = field(formData, "kind") === "signed" ? "signed" : "sent";
  const returnTo = contractId ? `/portal/contracts/${contractId}` : "/portal/contracts";
  const { principal } = await requirePortalContext();
  const result = await runPortalAction("downloadContract", () => resolvePortalContractPdf(principal, contractId, kind));
  if (!result.ok) {
    redirect(`${returnTo}?error=${result.code === "DOWNLOAD_RATE_LIMITED" ? "rate" : "download"}`);
  }
  redirect(result.value.url);
}
