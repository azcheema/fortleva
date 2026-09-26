import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requirePortalContext } from "@/portal/context";

import { PortalProjectView } from "./project-view";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("portal.project");
  // The one word, as the updates page does — not the name (a portal
  // read, not worth a transaction before the page has decided whether
  // this contact may see the project) and not the URL segment either:
  // an unbounded, unvalidated string echoed into the tab title was the
  // first cut, and a review pointed out it made "not yours" and "nothing
  // shared" differ in the one place this plane keeps identical.
  return { title: t("title") };
}

/**
 * `/portal/projects/[key]` — THE ONE-SCREEN PROJECT PAGE (Phase 3,
 * UI.md §4), and like `/portal` since View-as landed, a route that
 * decides only WHO is asking. Everything below the principal is
 * `<PortalProjectView>`, the component `/view-as/projects/[key]` renders
 * under a synthesised principal and `e2e/view-as.spec.ts` byte-compares
 * against this route.
 */
export default async function PortalProjectPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const { principal, name } = await requirePortalContext();
  return <PortalProjectView principal={principal} name={name} projectKey={key} />;
}
