import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requirePortalContext } from "@/portal/context";

import { PortalFilesView, portalFileErrorOf } from "./files-view";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("portal.files");
  return { title: t("title") };
}

/**
 * `/portal/files` — every file the agency has shared with this client
 * (Phase 3, the portal files-and-services slice; UI.md §4). Like every
 * portal route since View-as landed, it decides only WHO is asking —
 * and, here, whether a refused download just sent the reader back with
 * a word to draw. Everything else is `<PortalFilesView>`, the component
 * `/view-as/files` renders under a synthesised principal.
 */
export default async function PortalFilesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const { principal, name } = await requirePortalContext();
  return <PortalFilesView principal={principal} name={name} error={portalFileErrorOf(error)} />;
}
