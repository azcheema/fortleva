import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requirePortalContext } from "@/portal/context";

import { portalFileErrorOf } from "../files/files-view";
import { PortalReportsView } from "./reports-view";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("portal.reports");
  return { title: t("title") };
}

/**
 * `/portal/reports` — the monthly reports the agency published to this client
 * (Phase 6 slice 115; C91). Like every portal route since View-as landed, it
 * decides only WHO is asking — and whether a refused download just sent the
 * reader back with a word to draw. Everything else is `<PortalReportsView>`,
 * the component `/view-as/reports` renders under a synthesised principal.
 */
export default async function PortalReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const { principal, name } = await requirePortalContext();
  return <PortalReportsView principal={principal} name={name} error={portalFileErrorOf(error)} />;
}
