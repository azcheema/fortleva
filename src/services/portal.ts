import type { BillingInterval, ServiceKind, ServiceStatus } from "@/generated/prisma/enums";
import { authorizePortal, withPortalRead, type PortalPrincipal } from "@/portal";

/**
 * THE SERVICES MODULE'S PORTAL PROJECTION — the agreements a client
 * holds, as the client reads them (PLAN Phase 3 "read surfaces: …
 * `Service`s"; DATA_MODEL §6.6: "client-visible in the portal minus"
 * the staff-only notes column). Reads only, under the contact
 * principal, allow-listed; both tripwire tiers scan this file.
 *
 * WHAT A CLIENT IS TOLD ABOUT AN AGREEMENT: its name and the one-line
 * description written for them, whether it is one-off or recurring and
 * at what interval, the FEE (the fixed or recurring price of the
 * service — what they pay, which is on their own invoices), whether it
 * is running, paused or ended, and when it renews or ends. Nothing
 * else: no staff notes, no hourly rate card (rates are `RateCard` rows,
 * class A, and on UI.md §11's never-shown list), no consumption.
 *
 * THE FEE IS MONEY, WHICH IS WHY THE CAPABILITY IS PRIMARY ONLY
 * (`portal.service.view`, `capabilities.ts`): AUTHZ.md §8's collaborator
 * rule is "no money", and a collaborator asking for this list gets the
 * plane's one uniform empty answer. And a fee without a currency is not
 * projected at all: the member plane falls back to the tenant's default
 * currency, which lives in `tenant_preference` (class A, `portal_deny`)
 * and cannot be read here — an amount with no unit is not a fact.
 */

export type PortalService = {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly kind: ServiceKind;
  readonly billingInterval: BillingInterval | null;
  /** The fee, or null when the row carries no amount or no currency. `amount` is a Decimal string. */
  readonly price: { readonly amount: string; readonly currency: string } | null;
  readonly status: ServiceStatus;
  readonly renewsAt: Date | null;
  readonly endsAt: Date | null;
  /** The project the agreement is tied to, or null for a company-level one. */
  readonly project: { readonly key: string; readonly name: string } | null;
};

/** The most agreements one read returns; a client holds a handful. */
export const PORTAL_SERVICE_LIMIT = 100;

/**
 * THE CLIENT'S AGREEMENTS — every CLIENT_VISIBLE service of the
 * contact's own client: company-level ones, and those tied to a
 * portal-enabled project that is not archived.
 *
 * `service`'s `portal_gate` is the three-term form, with `portal_enabled`
 * TRUE for a company-level row by the stamp trigger's rule; the
 * projection repeats the terms and adds the PROJECT's archive, the gap
 * every portal projection documents. Ordered running first, then
 * paused, then ended — the same order the member's own Agreements tab
 * uses — and by name inside each.
 */
export async function listPortalServices(principal: PortalPrincipal): Promise<readonly PortalService[]> {
  return withPortalRead(principal, async (tx) => {
    await authorizePortal(tx, principal, "portal.service.view", { kind: "client", clientId: principal.clientId });
    const rows = await tx.service.findMany({
      where: {
        tenantId: principal.tenantId,
        clientId: principal.clientId,
        visibility: "CLIENT_VISIBLE",
        portalEnabled: true,
        OR: [{ projectId: null }, { project: { archivedAt: null } }],
      },
      select: {
        id: true,
        name: true,
        description: true,
        kind: true,
        billingInterval: true,
        priceExVat: true,
        currency: true,
        status: true,
        renewsAt: true,
        endsAt: true,
        project: { select: { key: true, name: true } },
      },
      orderBy: [{ status: "asc" }, { name: "asc" }, { id: "asc" }],
      take: PORTAL_SERVICE_LIMIT,
    });
    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      kind: s.kind,
      billingInterval: s.billingInterval,
      price: s.priceExVat !== null && s.currency ? { amount: s.priceExVat.toString(), currency: s.currency } : null,
      status: s.status,
      renewsAt: s.renewsAt,
      endsAt: s.endsAt,
      project: s.project ? { key: s.project.key, name: s.project.name } : null,
    }));
  });
}
