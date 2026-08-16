import { getTranslations } from "next-intl/server";

import { EmptyState } from "@/components/empty-state";

import { loadProject } from "../data";

/** Board arrives with the Work module (Phase 2W) — empty state until then, no board built here. */
export default async function ProjectBoardPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  await loadProject(key);
  const t = await getTranslations("projects.board");
  return <EmptyState title={t("title")} description={t("description")} />;
}
