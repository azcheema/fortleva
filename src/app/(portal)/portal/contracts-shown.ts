import { cache } from "react";

import { portalContractsShown } from "@/modules/contracts/portal";
import type { PortalPrincipal } from "@/portal";

/**
 * "Is there a contract for this contact to see?" — ONCE per request (Phase 4
 * slice 112b2; C85), as `./invoices-shown`: the portal frame asks it on every
 * page to draw its nav. TRUE when the contact may see contracts (a MAIN
 * contact, the contracts module open) and at least one of their client's has
 * been sent — a read under the contact's own principal, where the database's
 * gate decides. Never `unstable_cache`: the answer moves the moment a contract
 * is sent or the contact is demoted.
 */
export const contractsShown = cache((principal: PortalPrincipal): Promise<boolean> => portalContractsShown(principal));
