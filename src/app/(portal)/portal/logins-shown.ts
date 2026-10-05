import { cache } from "react";

import { portalHasSealedLogins, portalLoginsShown } from "@/modules/vault";
import type { PortalPrincipal } from "@/portal";

/** Only the SHOWN half — whether the agency shows this contact a login — for the page body; cached alike. */
export const shownToContact = cache((principal: PortalPrincipal): Promise<boolean> => portalLoginsShown(principal));

/**
 * "Is there anything on the Logins page for this contact?" — ONCE per
 * request (Phase 3V slice 91; the code review's low). The portal frame asks
 * it on every page to draw its nav, and `/portal/logins` asks it again for
 * its own body; React's request-scoped `cache` makes those one answer.
 * Keyed on the principal OBJECT: a page builds one (`requirePortalContext`,
 * or View-as's `synthesiseContactPrincipal`) and hands that same object to
 * its frame, which is what makes the second ask a hit — never
 * `unstable_cache`: the answer moves the moment an agency shows, hides,
 * seals or switches off, and nothing about a client is baked into anything
 * that outlives the request.
 *
 * TRUE when the agency SHOWS this client a login (a count under the
 * contact's own principal, where the database's gate and switch decide),
 * or — since slice 93 — keeps logins SEALED for them, or an ask of theirs
 * is still in play (the sealed broker's one bit; C61 (a) and (d): a client
 * can see that there is something to ask for whether or not the agency
 * shows logins at all). In sequence, the shown count first.
 */
export const loginsShown = cache(
  async (principal: PortalPrincipal): Promise<boolean> =>
    (await shownToContact(principal)) || (await portalHasSealedLogins(principal)),
);
