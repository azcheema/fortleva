import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { PortalReportsView } from "@/app/(portal)/portal/reports/reports-view";
import { resolveViewAsTarget } from "@/clients/view-as-context";
import { resolveMemberLocale } from "@/i18n/resolve";
import { requireTenantContext } from "@/members/tenant-context";
import { synthesiseContactPrincipal } from "@/portal";

import { ViewAsBanner } from "../view-as-banner";

export async function generateMetadata(): Promise<Metadata> {
  // The MEMBER'S language: a tab title is chrome (see `../view-as-banner.tsx`).
  const t = await getTranslations({ locale: await resolveMemberLocale(), namespace: "viewAs" });
  return { title: t("title") };
}

/**
 * `/view-as/reports` — View-as-Contact's rendering of the client's Reports
 * page (Phase 6 slice 115; C91). The same four obligations as `/view-as/files`
 * (`../page.tsx` has the long form): the portal's OWN component under a
 * synthesised principal, the banner outside `[data-portal-surface]`, the entry
 * audited once when the mode was entered, and output byte-compared to a real
 * contact session in CI.
 *
 * Gated, like the Files twin, by View-as's own permission
 * (`project:manage_portal`, `src/clients/view-as.ts`) and not by `report:view`:
 * View-as shows a member what the CLIENT sees, and what it shows here is only
 * what the agency has already published to that client (the design review's
 * L5, recorded in the slice's design §4.4).
 *
 * Nothing is read here; `src/authz/portal-view-as.test.ts` fails if this file
 * ever grows a query of its own.
 */
export default async function ViewAsReportsPage() {
  const target = await resolveViewAsTarget();
  if (!target) redirect("/home");

  const { membership } = await requireTenantContext();
  const principal = await synthesiseContactPrincipal(membership.tenantId, {
    id: target.contactId,
    tenantId: target.tenantId,
    clientId: target.clientId,
  });

  return (
    <>
      <ViewAsBanner name={target.name} />
      {/* LOOK, DON'T TOUCH — `inert` OUTSIDE the compared region: every row
          carries a download form that can only bounce a member to the client
          sign-in page. */}
      <div inert>
        <PortalReportsView principal={principal} name={target.name} />
      </div>
    </>
  );
}
