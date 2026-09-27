import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { PortalFilesView } from "@/app/(portal)/portal/files/files-view";
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
 * `/view-as/files` — View-as-Contact's rendering of the client's files
 * page (Phase 3, the portal files-and-services slice).
 *
 * The same four obligations as `/view-as` (`../page.tsx` has the long
 * form of each): the portal's OWN component under a synthesised
 * principal, the red banner outside `[data-portal-surface]`, the entry
 * audited once when the mode was entered, and output byte-compared to
 * a real contact session in CI. It exists because the portal gained a
 * third page, and a View-as that could show a member the client's home
 * but not the files the client can download would be a preview of part
 * of a portal.
 *
 * Nothing is read here; `src/authz/portal-view-as.test.ts` fails if
 * this file ever grows a query of its own.
 */
export default async function ViewAsFilesPage() {
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
      {/* LOOK, DON'T TOUCH — `inert` OUTSIDE the compared region, for the
          reason `/view-as` gives: every row here carries a download form
          that can only bounce a member to the client sign-in page. */}
      <div inert>
        <PortalFilesView principal={principal} name={target.name} />
      </div>
    </>
  );
}
