import type { TenantDb } from "@/db";
import type { PortalPrincipal } from "@/portal";

import type { HeldAsk } from "./ask-rows";

/**
 * LOCK THIS CONTACT'S ASK `FOR UPDATE` and read where it stands (Phase 3V
 * slice 98; founder decision C66) — the portal broker's hold on the ask,
 * taken AFTER the contact's own row (`submitterStanding`, `FOR SHARE`) and,
 * for a send, the hand-over budget's lock, before any login row: slice
 * 96's one order, extended. A cancellation (a member, `asks.ts`) takes this
 * row's lock alone, so a send, a decline and a cancellation of one ask are
 * decided one after the other, and the loser reads the winner's ending.
 *
 * Raw SQL in a file of its own, for `contact-budget-lock.ts`'s reason: the
 * portal tripwire refuses raw SQL in a broker's file and in its structural
 * tier (`ask-rows.ts`), and `FOR UPDATE` has no Prisma spelling. Bounded by
 * the PRINCIPAL — this tenant, the contact's own client, the contact
 * themself — so an id from a URL locks nothing but one of their own asks.
 */
export async function lockAskOf(tx: TenantDb, principal: PortalPrincipal, askId: string): Promise<HeldAsk | null> {
  const rows = await tx.$queryRaw<{ client_id: string; project_id: string | null; open: boolean }[]>`
    SELECT client_id, project_id,
           (sent_at IS NULL AND declined_at IS NULL AND cancelled_at IS NULL) AS open
      FROM credential_ask
     WHERE tenant_id = ${principal.tenantId} AND id = ${askId}
       AND client_id = ${principal.clientId} AND contact_id = ${principal.contactId}
       FOR UPDATE`;
  const row = rows[0];
  return row ? { clientId: row.client_id, projectId: row.project_id, open: row.open } : null;
}
