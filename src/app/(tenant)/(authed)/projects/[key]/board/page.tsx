import { getTranslations } from "next-intl/server";

import { EmptyState, SectionCard } from "@/components/semantic";

import { loadProject } from "../data";

/** Board arrives with the Work module (Phase 2W) — empty state until then, no board built here. */
export default async function ProjectBoardPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  await loadProject(key);
  const t = await getTranslations("projects.board");
  // Pre-wired for Phase 2W: the board/backlog drops into this same
  // SectionCard at Page width="wide" (set by the project layout).
  return (
    <SectionCard>
      <EmptyState variant="empty" title={t("title")} body={t("description")} />
    </SectionCard>
  );
}
