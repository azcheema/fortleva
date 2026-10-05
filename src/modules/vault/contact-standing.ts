import type { TenantDb } from "@/db";
import { moduleOpenUnderSystem } from "@/entitlements/resolver";
import type { PortalPrincipal } from "@/portal";

/**
 * THE CONTACT'S STANDING (Phase 3V slices 91 and 93) — restated by the
 * portal's vault brokers (`portal-writes.ts`, `sealed-portal-writes.ts`) in
 * every SYSTEM transaction before it acts: the `portal` and `vault` modules
 * open (gates 1–3, read under the system principal as `share-open.ts`
 * does), and the contact still an ACTIVE, invited MAIN contact of this
 * client (C59 (a), C61 (e)) — what the contact's own `authorizePortal`
 * proved a moment ago, read again where it is relied on, because RLS no
 * longer does. In its own file because every export of a `portal-writes.ts`
 * is held to the broker's pins (`src/portal/brokered-writes.test.ts`).
 */
export async function contactStanding(tx: TenantDb, principal: PortalPrincipal): Promise<boolean> {
  if (!(await moduleOpenUnderSystem(tx, principal.tenantId, "portal"))) return false;
  if (!(await moduleOpenUnderSystem(tx, principal.tenantId, "vault"))) return false;
  const contact = await tx.contact.findFirst({
    where: {
      tenantId: principal.tenantId,
      id: principal.contactId,
      clientId: principal.clientId,
      portalProfile: "CONTACT_PRIMARY",
      portalStatus: "ACTIVE",
      invitedAt: { not: null },
    },
    select: { id: true },
  });
  return contact !== null;
}
