import { cache } from "react";

import { portalInvoicesShown } from "@/modules/invoicing/portal";
import type { PortalPrincipal } from "@/portal";

/**
 * "Is there an invoice for this contact to see?" — ONCE per request (Phase 4
 * slice 109; C79 (b)), as `./logins-shown`: the portal frame asks it on every
 * page to draw its nav, and React's request-scoped `cache` makes the frame's
 * ask and a page's own one answer. TRUE when the contact may see invoices (a
 * MAIN contact, the invoicing module open) and at least one of their client's
 * has been sent — a count under the contact's own principal, where the
 * database's gate decides. Never `unstable_cache`: the answer moves the moment
 * an invoice is sent or the contact is demoted.
 */
export const invoicesShown = cache((principal: PortalPrincipal): Promise<boolean> => portalInvoicesShown(principal));
