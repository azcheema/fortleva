import { getTranslations } from "next-intl/server";

import { listAssignableMembers } from "@/clients/service";
import { SectionCard, VisibilityBadge } from "@/components/semantic";
import { withTenant } from "@/db";
import { requireTenantContext } from "@/members/tenant-context";

import { loadProject } from "./data";
import {
  ProjectDangerZone,
  ProjectDetailsForm,
  ProjectInternalForm,
  ProjectStatusControls,
} from "./overview-forms";
import { SaveTemplateButton } from "./save-template";
import { WebsiteSpeedCard } from "./speed-card";

/**
 * Overview tab: details · internal (private) fields · status/key/archive.
 * The portal controls moved to their own tab on 2026-09-21 (Phase 3
 * slice 4), where the switch sits beside a preview of what it
 * publishes — one home per control.
 *
 * Two columns at lg: the two forms a member edits all day on the left,
 * the status controls that change what the project IS on the right. The
 * internal card wears a VisibilityBadge in its header rather than a
 * grey badge per field (DESIGN SPEC §7) — one unmistakable statement
 * about the whole card.
 *
 * Archiving is a danger footer at the foot of the main column, not a
 * red button inside the routine Status card (UI.md §5.9).
 *
 * Phase 6 slice 118 (C94 (d)): the Website speed card under Details, beside
 * the Production URL it measures, for a member holding `report:view`; its
 * `?device=` parameter picks phones (the default) or computers.
 */
export default async function ProjectOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ device?: string }>;
}) {
  const { key } = await params;
  const { device } = await searchParams;
  const project = await loadProject(key);
  const t = await getTranslations("projects.overview");
  const tTemplate = await getTranslations("projects.template");
  const { membership } = await requireTenantContext();
  const members = project.caps.edit
    ? await withTenant(membership.tenantId, { type: "member", id: membership.memberId }, listAssignableMembers)
    : project.leadMemberId && project.leadName
      ? [{ memberId: project.leadMemberId, name: project.leadName, email: "" }]
      : [];

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="flex flex-col gap-6 lg:col-span-2">
        <SectionCard title={t("details")}>
          <ProjectDetailsForm project={project} members={members} />
        </SectionCard>
        {project.caps.viewSpeed ? <WebsiteSpeedCard project={project} device={device === "desktop" ? "DESKTOP" : "PHONE"} /> : null}
        <SectionCard
          title={t("internal")}
          description={t("internalHint")}
          actions={<VisibilityBadge value="INTERNAL" />}
        >
          <ProjectInternalForm project={project} />
        </SectionCard>
        <ProjectDangerZone project={project} />
      </div>
      <div className="flex flex-col gap-6">
        <SectionCard title={t("status")}>
          <ProjectStatusControls project={project} />
        </SectionCard>
        {/* Slice 124 (C100 (b)): start new projects from this one. */}
        {project.caps.saveTemplate ? (
          <SectionCard title={tTemplate("title")} description={tTemplate("description")}>
            <SaveTemplateButton projectId={project.id} projectKey={project.key} projectName={project.name} />
          </SectionCard>
        ) : null}
      </div>
    </div>
  );
}
