import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { PortalCompanyView } from "@/app/(portal)/portal/company/company-view";
import { resolveViewAsTarget } from "@/clients/view-as-context";
import { resolveMemberLocale } from "@/i18n/resolve";
import { requireTenantContext } from "@/members/tenant-context";
import { synthesiseContactPrincipal } from "@/portal";

import { ViewAsBanner } from "../view-as-banner";

export async function generateMetadata(): Promise<Metadata> {
  // The MEMBER'S language: a tab title is chrome, and chrome on this
  // route is the member's (see `../view-as-banner.tsx`).
  const t = await getTranslations({ locale: await resolveMemberLocale(), namespace: "viewAs" });
  return { title: t("title") };
}

/**
 * `/view-as/company` — View-as-Contact's rendering of the client's own
 * company page (Phase 3, the portal files-and-services slice): the
 * record the agency holds on them, and the agreements between them.
 *
 * The same four obligations as `/view-as` (`../page.tsx` has the long
 * form of each). This page is the one where a PROFILE visibly matters:
 * a primary contact sees the agreements and a collaborator does not
 * (`portal.service.view` is money), and because the component runs the
 * contact's own projection under a principal synthesised from THEIR
 * row, the member sees exactly the half that contact would.
 *
 * Nothing is read here; `src/authz/portal-view-as.test.ts` fails if
 * this file ever grows a query of its own.
 */
export default async function ViewAsCompanyPage() {
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
      {/* LOOK, DON'T TOUCH — `inert` OUTSIDE the compared region, as on
          every View-as page: the nav's links point at the portal plane. */}
      <div inert>
        <PortalCompanyView principal={principal} name={target.name} />
      </div>
    </>
  );
}
