import type { TenantDb } from "@/db";
import { moduleOpenUnderSystem } from "@/entitlements/resolver";
import { portalPrincipalVerdict, type PortalPrincipal } from "@/portal";

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

/**
 * THE STANDING OF A CONTACT HANDING A LOGIN OVER (Phase 3V slice 96; founder
 * decision C64) — restated by the portal's submission broker
 * (`submission-portal-writes.ts`) in its SYSTEM transaction, before it
 * writes: both modules open, and the contact still an ACTIVE, invited
 * contact of this client whose profile holds `portal.credential.submit`
 * (both profiles do — a helper may hand a login over, AUTHZ.md §8), by the
 * portal's own rule (`portalPrincipalVerdict`), never a copy of it.
 *
 * THE CONTACT'S ROW IS READ `FOR SHARE`, and that is the point of this
 * being raw SQL in this file (the broker's own file is scanned by the
 * portal tripwire's AST tier, which bans raw SQL): ending the contact's
 * access is an UPDATE of that row, so it waits until the hand-over commits
 * — and `deleteContact`, which needs the access ended first, then counts
 * the login and refuses. Either the end of access commits first and this
 * reads it (READ COMMITTED re-reads a row it waited for), or the hand-over
 * does. The migration's guard (20261006180000) takes the same lock again
 * for any writer; here it comes first, before the login's rows. A READ
 * (`lock: false` — the portal's "may I send a login?" bit, asked on page
 * views) takes no lock: it writes nothing a removal could orphan, and a
 * row lock marks the row on every view.
 */
export async function submitterStanding(
  tx: TenantDb,
  principal: PortalPrincipal,
  opts: { readonly lock: boolean },
): Promise<boolean> {
  if (!(await moduleOpenUnderSystem(tx, principal.tenantId, "portal"))) return false;
  if (!(await moduleOpenUnderSystem(tx, principal.tenantId, "vault"))) return false;
  type Row = { portal_profile: string; portal_status: string; invited_at: Date | null };
  const rows = opts.lock
    ? await tx.$queryRaw<Row[]>`
        SELECT portal_profile::text AS portal_profile, portal_status::text AS portal_status, invited_at
          FROM contact
         WHERE tenant_id = ${principal.tenantId} AND id = ${principal.contactId} AND client_id = ${principal.clientId}
           FOR SHARE`
    : await tx.$queryRaw<Row[]>`
        SELECT portal_profile::text AS portal_profile, portal_status::text AS portal_status, invited_at
          FROM contact
         WHERE tenant_id = ${principal.tenantId} AND id = ${principal.contactId} AND client_id = ${principal.clientId}`;
  const row = rows[0];
  if (!row) return false;
  return portalPrincipalVerdict({
    capability: "portal.credential.submit",
    profile: row.portal_profile,
    portalStatus: row.portal_status,
    invitedAt: row.invited_at,
  }).ok;
}
