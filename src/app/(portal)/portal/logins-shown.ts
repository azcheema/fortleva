import { cache } from "react";

import { portalLoginsShown } from "@/modules/vault";
import type { PortalPrincipal } from "@/portal";

/**
 * "Is anything behind the Logins door for this contact?" — ONCE per request
 * (Phase 3V slice 91; the code review's low). The portal frame asks it on
 * every page to draw its nav, and `/portal/logins` asks it again for its own
 * body; React's request-scoped `cache` makes those one contact transaction.
 * Keyed on the principal OBJECT: a page builds one (`requirePortalContext`,
 * or View-as's `synthesiseContactPrincipal`) and hands that same object to
 * its frame, which is what makes the second ask a hit — never
 * `unstable_cache`: the answer moves the moment an agency
 * shows, hides or switches off, and nothing about a client is baked into
 * anything that outlives the request.
 */
export const loginsShown = cache((principal: PortalPrincipal): Promise<boolean> => portalLoginsShown(principal));
