import { AuthzError } from "@/authz/errors";
import { authorizePortal, withPortalRead, type PortalPrincipal } from "@/portal";

import type { OpenPortalDoor } from "./portal-writes";

/**
 * THE VAULT'S PORTAL PROJECTION — the logins an agency SHOWS a client, as
 * the client's main contact reads them (Phase 3V slice 91; founder
 * decisions C52 (d), C59). Reads only, under the CONTACT principal,
 * allow-listed; both tripwire tiers scan this file.
 *
 * THE DATABASE DECIDES WHICH ROWS EXIST HERE: `portal_gate` on
 * `credential_item` gives a contact only their own client's CLIENT_VISIBLE
 * rows, and `portal_vault_switch` gives them none at all while the
 * workspace has client logins switched off (migration 20261005120000). The
 * `where` below repeats the gate's terms and adds what the policy does not
 * carry — the bin and the archive.
 *
 * WHAT A CLIENT IS TOLD ABOUT A LOGIN: its name, username, web address and
 * which secret fields it has — never a value (each is one audited look,
 * `portal-writes.ts`), never the agency's notes or tags (free text written
 * for staff), never the project it hangs on, its expiry, its rotation state
 * or who made it. No one-time codes (C59 (d)).
 */

export type PortalLogin = {
  readonly id: string;
  readonly name: string;
  readonly username: string | null;
  readonly url: string | null;
  /** The secret fields this login carries (`SECRET_FIELDS` keys), in the order stored — names, never values. */
  readonly fields: readonly string[];
};

/** The most logins the page draws; a client is shown a handful. */
export const PORTAL_LOGIN_LIMIT = 200;

const LIVE = { deletedAt: null, archivedAt: null } as const;

/**
 * THE LOGINS BEHIND THE DOOR — only for a door open in this session, which
 * the page proves by passing what `readPortalLoginsDoor` returned (C52 (k):
 * the list is behind the door too, as the staff vault's is).
 */
export async function listPortalLogins(
  principal: PortalPrincipal,
  door: OpenPortalDoor,
): Promise<readonly PortalLogin[]> {
  if (!door) throw new Error("vault: the client's logins are listed only behind an open door");
  return withPortalRead(principal, async (tx) => {
    await authorizePortal(tx, principal, "portal.credential.view", { kind: "client", clientId: principal.clientId });
    const rows = await tx.credentialItem.findMany({
      where: {
        tenantId: principal.tenantId,
        clientId: principal.clientId,
        visibility: "CLIENT_VISIBLE",
        ...LIVE,
      },
      select: { id: true, name: true, username: true, url: true, secretFieldKeys: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: PORTAL_LOGIN_LIMIT,
    });
    return rows.map((r) => ({ id: r.id, name: r.name, username: r.username, url: r.url, fields: r.secretFieldKeys }));
  });
}

/**
 * Is there anything for this contact behind the door? — what the portal's
 * nav asks before it draws "Logins". False for a contact without the
 * capability (a collaborator, a module switched off — the plane's one
 * quiet answer, never an error) and while nothing is shown: a count under
 * the contact's own principal, so the database's gate and switch decide.
 * Says nothing about the door, and opens nothing.
 */
export async function portalLoginsShown(principal: PortalPrincipal): Promise<boolean> {
  return withPortalRead(principal, async (tx) => {
    try {
      await authorizePortal(tx, principal, "portal.credential.view");
    } catch (e) {
      if (e instanceof AuthzError) return false;
      throw e;
    }
    const shown = await tx.credentialItem.count({
      where: { tenantId: principal.tenantId, clientId: principal.clientId, visibility: "CLIENT_VISIBLE", ...LIVE },
    });
    return shown > 0;
  });
}
