import { getTranslations } from "next-intl/server";

import { EmptyState } from "@/components/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
      <Card size="sm">
        <CardHeader>
          <CardTitle>{t("milestones")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {project.milestones.length === 0 ? (
            <EmptyState title={t("milestonesEmpty")} description={t("milestonesEmptyDescription")} />
          ) : (
            <ol className="divide-y divide-border rounded-md border border-border">
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
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>{t("versions")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {project.versions.length === 0 ? (
            <EmptyState title={t("versionsEmpty")} description={t("versionsEmptyDescription")} />
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {project.versions.map((v) => (
                <VersionItem key={v.id} projectKey={project.key} version={v} editable={editable} />
              ))}
            </ul>
          )}
          {editable ? <CreateVersionForm projectId={project.id} projectKey={project.key} /> : null}
          <p className="text-xs text-muted-foreground">{t("shippedVisibleHint")}</p>
        </CardContent>
      </Card>
    </div>
  );
}
