import { getTranslations } from "next-intl/server";

import { EmptyState, SectionCard } from "@/components/semantic";

import { loadProject } from "../data";

/** Backlog arrives with the Work module (Phase 2W) — empty state until then. */
export default async function ProjectBacklogPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  await loadProject(key);
  const t = await getTranslations("projects.backlog");
  // Pre-wired for Phase 2W: the board/backlog drops into this same
  // SectionCard at Page width="wide" (set by the project layout).
  return (
    <SectionCard>
      <EmptyState variant="empty" title={t("title")} body={t("description")} />
    </SectionCard>
  );
}
