import { cache } from "react";

import { deny } from "@/authz/errors";

import type { PortalPrincipal } from "./authorize";
import { resolvePortalModuleGates } from "./module-gates";

/**
 * THE MEMBER PLANE'S ONE PRINCIPAL BUILDER — the second and last place
 * in the product where a `PortalPrincipal` is born.
 *
 * `src/portal/context.ts` builds one from a CONTACT SESSION. This
 * builds one from a CONTACT ROW that a member has already been
 * authorised to look through: the Project → Portal tab's "what the
 * client sees" panel (slice 4) and View-as-Contact (slice 5). Both hand
 * the result to the very same projection functions a real contact's own
 * request runs, because SECURITY.md §5.1 says it in six words — *a
 * separate preview renderer is how previews lie*.
 *
 * WHY THE TWO CALLERS SHARE THIS RATHER THAN EACH BUILDING THEIR OWN.
 * `src/authz/portal-view-as.test.ts` pins the CLOSED SET of files that
 * may assemble this object, and slice 5 could have made that set three.
 * A third entry is a third place to review, and the whole value of the
 * rule is that the set is small enough to read. More importantly, the
 * two obligations below are the kind that a second copy honours on the
 * day it is written and stops honouring later. Here they are executed
 * once, by code, for every member-plane principal that will ever exist.
 *
 * OBLIGATION ONE: THE GATES COME FROM THE VIEWED CONTACT'S TENANT.
 * `src/portal/authorize.ts` names this hazard at the type and named
 * View-as-Contact as the slice that must close it: `gates` is a
 * caller-supplied map of a tenant's entitlement state, so a surface
 * that carried the MEMBER'S map while reading a contact's rows would
 * let one agency's plan decide another's. That is not a spoofing risk —
 * it is the ordinary mistake of passing the tenant id already in hand.
 * This function never takes a tenant id to resolve gates FROM. It reads
 * `contact.tenantId` off the row and resolves them from that, so the
 * obligation is discharged by the signature rather than by remembering.
 *
 * SAID EXACTLY, because a mutation check refused to pretend otherwise:
 * with the belt below in place the two tenant ids are provably equal at
 * that line, so swapping `contact.tenantId` for the caller's argument
 * changes no behaviour and no test can tell them apart. The SAFETY comes
 * from the belt; reading the row is what keeps the intent legible and
 * what would still be correct if the belt were ever relaxed. Claiming a
 * test covers that line would be claiming more than was measured.
 *
 * OBLIGATION TWO: THE BELT. Under `tenant_isolation` a member's own
 * RLS-scoped read cannot return another tenant's contact, so the check
 * below can only fire when a GUC and a row disagree — which is exactly
 * when one wants it to. The caller passes the tenant it believes it is
 * acting for and this refuses the pair if they differ. Slice 4 carried
 * this belt inline; it is the same belt, in the place that cannot be
 * bypassed by the next caller.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not authorise the MEMBER
 * — no permission, no scope, no contact admission. Those are the
 * caller's, because they differ: the tab needs `project:manage_portal`
 * plus project scope, View-as needs the same permission plus the whole
 * CLIENT. A helper that did some of the authorization would be a helper
 * someone trusts to do all of it.
 */

/**
 * The module gates, resolved once per request. The same treatment the
 * portal plane gives them (`src/portal/context.ts`) and for the same
 * reason: it is a system-principal round trip, and React's `cache` is
 * request-scoped, never `unstable_cache` — entitlements are read per
 * request and never baked into anything long-lived (AUTHZ §5;
 * revocation lag on a downgrade is the failure that rule prevents).
 * Outside a request (a dbtest) `cache` degrades to a plain call.
 *
 * EXPORTED so that a member-plane surface which needs the gates for its
 * OWN reasoning — the Portal tab computes a `MODULE_OFF` blocker from
 * them — shares this one memo rather than making a second. Two `cache()`
 * wrappers around the same function are two caches and therefore two
 * round trips, which is what the first cut of slice 5 did.
 */
export const portalGatesFor = cache(resolvePortalModuleGates);

/**
 * The fields of a contact row this needs, and no more. A structural
 * type rather than the Prisma model so a caller may pass a narrowed
 * `select` — which every caller should, because a member-plane read of
 * a contact is PII crossing a boundary (slice 4 dropped `email` from
 * the preview for exactly this reason).
 */
export type SynthesisableContact = {
  readonly id: string;
  readonly tenantId: string;
  readonly clientId: string;
};

export async function synthesiseContactPrincipal(
  /** The tenant the CALLER believes it is acting for — the belt's other half. */
  tenantId: string,
  contact: SynthesisableContact,
): Promise<PortalPrincipal> {
  if (contact.tenantId !== tenantId) {
    // NOT_FOUND, never a description of the mismatch: this is reached
    // through member-plane surfaces whose refusals are already
    // NOT_FOUND for everything out of scope (AUTHZ §4).
    deny("NOT_FOUND", "contact tenant does not match");
  }
  return {
    contactId: contact.id,
    tenantId: contact.tenantId,
    clientId: contact.clientId,
    gates: await portalGatesFor(contact.tenantId),
  };
}
