import { getTranslations } from "next-intl/server";

import { listAssignableMembers } from "@/clients/service";
import { SectionCard } from "@/components/semantic";
import { withTenant } from "@/db";
import { requireTenantContext } from "@/members/tenant-context";

import { loadProject } from "./data";
import {
  PortalControls,
  ProjectDetailsForm,
  ProjectInternalForm,
  ProjectStatusControls,
} from "./overview-forms";

/** Overview tab: details · status/key/archive · internal (private) fields · portal switch. */
export default async function ProjectOverviewPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const project = await loadProject(key);
  const t = await getTranslations("projects.overview");
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
        <SectionCard title={t("internal")}>
          <ProjectInternalForm project={project} />
        </SectionCard>
      </div>
      <div className="flex flex-col gap-6">
        <SectionCard title={t("status")}>
          <ProjectStatusControls project={project} />
        </SectionCard>
        <SectionCard title={t("portal")}>
          <PortalControls project={project} />
        </SectionCard>
      </div>
    </div>
  );
}
