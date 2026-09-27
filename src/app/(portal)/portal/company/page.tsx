import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requirePortalContext } from "@/portal/context";

import { PortalCompanyView } from "./company-view";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("portal.company");
  return { title: t("title") };
}

/**
 * `/portal/company` — the client's own company record and their
 * agreements with the agency (Phase 3, the portal files-and-services
 * slice; UI.md §4). A route that decides only WHO is asking; everything
 * else is `<PortalCompanyView>`, which `/view-as/company` renders under
 * a synthesised principal and `e2e/view-as.spec.ts` byte-compares.
 */
export default async function PortalCompanyPage() {
  const { principal, name } = await requirePortalContext();
  return <PortalCompanyView principal={principal} name={name} />;
}
