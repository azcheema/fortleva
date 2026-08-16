import { getTranslations } from "next-intl/server";

import { EmptyState, SectionCard } from "@/components/semantic";

import { loadProject } from "../data";
import { CreateMilestoneForm, CreateVersionForm, MilestoneItem, VersionItem } from "./timeline-forms";

/**
 * Timeline tab (DATA_MODEL.md §6.5): milestones in rank order with a
 * keyboard reorder twin, and the version list with a ship action. A
 * list, deliberately not a Gantt (decision #7).
 */
export default async function ProjectTimelinePage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const project = await loadProject(key);
  const t = await getTranslations("projects.timeline");
  const editable = project.caps.manageVersions && project.status !== "ARCHIVED";
  const siblings = project.milestones.map((m) => ({ id: m.id, name: m.name }));

  return (
    <div className="flex flex-col gap-6">
      <SectionCard title={t("milestones")} contentClassName="flex flex-col gap-4">
        {project.milestones.length === 0 ? (
          <EmptyState
            variant="empty"
            title={t("milestonesEmpty")}
            body={t("milestonesEmptyDescription")}
          />
        ) : (
          // 36px rhythm, hairline separators, no zebra — the same row
          // language as DataTable, in a list because milestones reorder.
          <ol className="divide-y divide-border overflow-hidden rounded-md border border-border">
            {project.milestones.map((m, i) => (
              <MilestoneItem
                key={m.id}
                projectKey={project.key}
                milestone={m}
                index={i}
                siblings={siblings}
                editable={editable}
              />
            ))}
          </ol>
        )}
        {editable ? <CreateMilestoneForm projectId={project.id} projectKey={project.key} /> : null}
      </SectionCard>

      <SectionCard title={t("versions")} contentClassName="flex flex-col gap-4">
        {project.versions.length === 0 ? (
          <EmptyState
            variant="empty"
            title={t("versionsEmpty")}
            body={t("versionsEmptyDescription")}
          />
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
            {project.versions.map((v) => (
              <VersionItem key={v.id} projectKey={project.key} version={v} editable={editable} />
            ))}
          </ul>
        )}
        {editable ? <CreateVersionForm projectId={project.id} projectKey={project.key} /> : null}
        <p className="text-xs text-muted-foreground">{t("shippedVisibleHint")}</p>
      </SectionCard>
    </div>
  );
}
