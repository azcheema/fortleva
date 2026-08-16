import { getTranslations } from "next-intl/server";

import { EmptyState } from "@/components/empty-state";

import { loadProject } from "../data";

/** Backlog arrives with the Work module (Phase 2W) — empty state until then. */
export default async function ProjectBacklogPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  await loadProject(key);
  const t = await getTranslations("projects.backlog");
  return <EmptyState title={t("title")} description={t("description")} />;
}
