import { authorizePortal, withPortalRead, type PortalPrincipal } from "@/portal";

/**
 * THE CLIENT'S OWN COMPANY RECORD, as the client reads it (PLAN Phase 3
 * "read surfaces: … own company record"; `/portal/company`). Reads
 * only, under the contact principal, allow-listed; both tripwire tiers
 * scan this file.
 *
 * WHAT A CLIENT IS TOLD ABOUT THEMSELVES: the name the agency has them
 * under, their organisation number and VAT number, and the address on
 * file — the facts a client would check and email a correction about.
 * Nothing the agency wrote FOR ITSELF: not the staff-only notes column
 * (on both tripwire lists), not the client's status in the agency's
 * pipeline, not which members are assigned to them, not the billing
 * address's invoice settings (Phase 4's, with the invoice surface).
 *
 * `client`'s `portal_gate` is the client-root form — `id =
 * app.client_id` — so under this principal the read can only ever
 * return the contact's own client; the `where` repeats it.
 */
export type PortalCompany = {
  readonly id: string;
  readonly name: string;
  readonly orgNr: string | null;
  readonly vatNumber: string | null;
  readonly address: {
    readonly line1: string | null;
    readonly line2: string | null;
    readonly postalCode: string | null;
    readonly city: string | null;
    readonly countryCode: string | null;
  } | null;
};

export async function readPortalCompany(principal: PortalPrincipal): Promise<PortalCompany | null> {
  return withPortalRead(principal, async (tx) => {
    await authorizePortal(tx, principal, "portal.company.view", { kind: "client", clientId: principal.clientId });
    const row = await tx.client.findFirst({
      where: { tenantId: principal.tenantId, id: principal.clientId },
      select: {
        id: true,
        name: true,
        orgNr: true,
        vatNumber: true,
        addressLine1: true,
        addressLine2: true,
        postalCode: true,
        city: true,
        countryCode: true,
      },
    });
    if (!row) return null;
    const hasAddress = Boolean(row.addressLine1 || row.addressLine2 || row.postalCode || row.city || row.countryCode);
    return {
      id: row.id,
      name: row.name,
      orgNr: row.orgNr,
      vatNumber: row.vatNumber,
      address: hasAddress
        ? {
            line1: row.addressLine1,
            line2: row.addressLine2,
            postalCode: row.postalCode,
            city: row.city,
            countryCode: row.countryCode,
          }
        : null,
    };
  });
}
