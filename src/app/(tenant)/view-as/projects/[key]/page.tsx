import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { PortalProjectView } from "@/app/(portal)/portal/projects/[key]/project-view";
import { resolveViewAsTarget } from "@/clients/view-as-context";
import { resolveMemberLocale } from "@/i18n/resolve";
import { requireTenantContext } from "@/members/tenant-context";
import { synthesiseContactPrincipal } from "@/portal";

import { ViewAsBanner } from "../../view-as-banner";

export async function generateMetadata(): Promise<Metadata> {
  // The MEMBER'S language: a tab title is chrome, and chrome on this
  // route is the member's (see `../../view-as-banner.tsx`).
  const t = await getTranslations({ locale: await resolveMemberLocale(), namespace: "viewAs" });
  return { title: t("title") };
}

/**
 * `/view-as/projects/[key]` — View-as-Contact's rendering of the
 * one-screen project page (Phase 3, the Timeline slice).
 *
 * The same four obligations as `/view-as` (`../../page.tsx`, which has
 * the long form of each): the portal's OWN component under a
 * synthesised principal, the red banner outside `[data-portal-surface]`,
 * the entry audited once when the mode was entered, and output
 * byte-compared to a real contact session in CI. It exists because the
 * portal gained a second page, and a View-as that could show a member
 * the client's home but not the client's project page would be a
 * preview of half a portal — the pins' byte-identity claim would then
 * hold only for the half that was checked.
 *
 * The KEY is the only thing this route takes from the URL, and it is
 * handed to the component, which resolves it under the CONTACT
 * principal exactly as `/portal/projects/[key]` does. A key this
 * contact may not see renders the plane's uniform empty page here too —
 * which is the correct answer, because that is what the client gets.
 *
 * Nothing is read here; `src/authz/portal-view-as.test.ts` fails if
 * this file ever grows a query of its own.
 */
export default async function ViewAsProjectPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
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
          reason `/view-as` gives: this page carries the client's tick and
          links into the portal plane, none of which a member can follow. */}
      <div inert>
        <PortalProjectView principal={principal} name={target.name} projectKey={key} />
      </div>
    </>
  );
}
