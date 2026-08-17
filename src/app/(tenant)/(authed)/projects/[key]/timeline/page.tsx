import { getTranslations } from "next-intl/server";

import { Callout, EmptyState, SectionCard, Timeline } from "@/components/semantic";
import type { MilestoneRow, VersionRow } from "@/projects/service";

import { loadProject } from "../data";
import { CreateMilestoneForm, CreateVersionForm, MilestoneItem, VersionItem } from "./timeline-forms";

/**
 * Timeline tab (DATA_MODEL.md §6.5): the project's plan and what has
 * actually shipped, on ONE vertical rail — a list, deliberately not a
 * Gantt (decision #7).
 *
 * Ordering rule, and the reason it is safe: milestones keep their RANK
 * order, because rank is what the reorder arrows move and what the
 * portal reads. Shipped versions are then slotted BETWEEN them at the
 * chronological point they were shipped, against a monotonically
 * non-decreasing cursor over the milestone dates — so a project whose
 * milestone dates run backwards cannot make releases jump around. The
 * milestone sequence the user sees is therefore exactly the rank
 * sequence the arrows act on; only releases are interleaved.
 * Unshipped drafts have no date, so they collect at the foot of the
 * rail, which is also where they belong: next up.
 */
type Entry =
  | { kind: "milestone"; milestone: MilestoneRow; index: number }
  | { kind: "version"; version: VersionRow };

function buildRail(milestones: MilestoneRow[], versions: VersionRow[]): Entry[] {
  const shipped = versions
    .filter((v) => v.status === "SHIPPED" && v.shippedAt)
    .sort((a, b) => a.shippedAt!.getTime() - b.shippedAt!.getTime());
  const drafts = versions.filter((v) => !(v.status === "SHIPPED" && v.shippedAt));

  const entries: Entry[] = [];
  let cursor = Number.NEGATIVE_INFINITY;
  let next = 0;

  milestones.forEach((milestone, index) => {
    const anchor = milestone.completedAt ?? milestone.dueAt;
    if (anchor) {
      cursor = Math.max(cursor, anchor.getTime());
      while (next < shipped.length && shipped[next]!.shippedAt!.getTime() <= cursor) {
        entries.push({ kind: "version", version: shipped[next++]! });
      }
    }
    entries.push({ kind: "milestone", milestone, index });
  });
  while (next < shipped.length) entries.push({ kind: "version", version: shipped[next++]! });
  for (const version of drafts) entries.push({ kind: "version", version });

  return entries;
}

export default async function ProjectTimelinePage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const project = await loadProject(key);
  const t = await getTranslations("projects.timeline");
  const editable = project.caps.manageVersions && project.status !== "ARCHIVED";
  const siblings = project.milestones.map((m) => ({ id: m.id, name: m.name }));
  const entries = buildRail(project.milestones, project.versions);

  return (
    <div className="flex flex-col gap-6">
      <SectionCard title={t("title")} description={t("description")}>
        {entries.length === 0 ? (
          <EmptyState
            variant="empty"
            title={t("milestonesEmpty")}
            body={t("milestonesEmptyDescription")}
          />
        ) : (
          <Timeline>
            {entries.map((entry, i) =>
              entry.kind === "milestone" ? (
                <MilestoneItem
                  key={entry.milestone.id}
                  projectKey={project.key}
                  milestone={entry.milestone}
                  index={entry.index}
                  siblings={siblings}
                  editable={editable}
                  last={i === entries.length - 1}
                />
              ) : (
                <VersionItem
                  key={entry.version.id}
                  projectKey={project.key}
                  version={entry.version}
                  editable={editable}
                  last={i === entries.length - 1}
                />
              ),
            )}
          </Timeline>
        )}
      </SectionCard>

      {editable ? (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          {/* The two cards are half the content column wide, so the forms
              inside them lay themselves out against the CARD's width. */}
          <SectionCard
            title={t("milestones")}
            description={t("milestonesHint")}
            contentClassName="@container"
          >
            <CreateMilestoneForm projectId={project.id} projectKey={project.key} />
          </SectionCard>
          <SectionCard
            title={t("versions")}
            description={t("versionsHint")}
            contentClassName="@container flex flex-col gap-4"
          >
            <CreateVersionForm projectId={project.id} projectKey={project.key} />
            <Callout tone="info">{t("shippedVisibleHint")}</Callout>
          </SectionCard>
        </div>
      ) : null}
    </div>
  );
}
