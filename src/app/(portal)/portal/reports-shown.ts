import { cache } from "react";

import { countPortalReports } from "@/documents/portal";
import { countPortalWebsiteSpeed } from "@/modules/reports/portal";
import type { PortalPrincipal } from "@/portal";

/**
 * "Is there a report for this contact to see?" — ONCE per request (Phase 6
 * slice 115; C91 (b)), as `./contracts-shown`: the portal frame asks it on
 * every page to draw its nav. TRUE when the contact may read reports (every
 * profile, the portal and reports modules open) and at least one of their
 * client's has been published — or, since slice 118, at least one of their
 * projects' website speed charts is shown to them — a count under the
 * contact's own principal, where the database's gate decides. Never
 * `unstable_cache`: the answer moves the moment a report is published or
 * hidden, or a speed switch is pressed.
 */
export const reportsShown = cache(async (principal: PortalPrincipal): Promise<boolean> => {
  if ((await countPortalReports(principal)) > 0) return true;
  return (await countPortalWebsiteSpeed(principal)) > 0;
});
