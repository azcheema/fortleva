import { getTranslations } from "next-intl/server";

import { listAssignableMembers } from "@/clients/service";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
        <Card size="sm">
          <CardHeader>
            <CardTitle>{t("details")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ProjectDetailsForm project={project} members={members} />
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardTitle>{t("internal")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ProjectInternalForm project={project} />
          </CardContent>
        </Card>
      </div>
      <div className="flex flex-col gap-6">
        <Card size="sm">
          <CardHeader>
            <CardTitle>{t("status")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ProjectStatusControls project={project} />
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardTitle>{t("portal")}</CardTitle>
          </CardHeader>
          <CardContent>
            <PortalControls project={project} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
