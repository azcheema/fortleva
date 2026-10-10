import type { TenantDb } from "@/db";

/**
 * WHO MAY SIGN A CONTRACT (C84 (c), (d)) — the client's MAIN contacts whose
 * portal access is ACTIVE: they have signed in, nobody has paused them, and
 * AUTHZ §8 gives `portal.contract.sign` to main contacts only. An invited
 * person who has not yet accepted is not in the portal, and a collaborator
 * reads no contract. The picker lists exactly these; the page says how to
 * get anybody else there.
 *
 * A plain read under the member's own RLS — the caller has asked for the code.
 */

export type SignerOption = {
  readonly id: string;
  readonly name: string;
  readonly email: string;
};

export async function readSigners(tx: TenantDb, tenantId: string, clientId: string): Promise<SignerOption[]> {
  return tx.contact.findMany({
    where: { tenantId, clientId, portalStatus: "ACTIVE", portalProfile: "CONTACT_PRIMARY" },
    select: { id: true, name: true, email: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 200,
  });
}
