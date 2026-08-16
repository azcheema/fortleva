import { getTranslations } from "next-intl/server";

import { listAssignableMembers } from "@/clients/service";
import { AssignmentsPanel } from "@/components/assignments-panel";
import { SectionCard } from "@/components/semantic";
import { withTenant } from "@/db";
import { requireTenantContext } from "@/members/tenant-context";

import { assignProjectMemberAction, unassignProjectMemberAction } from "../actions";
import { loadProject } from "../data";

/** Team tab: assigned members with assign/unassign — no time, no presence (UI.md rule 14). */
export default async function ProjectTeamPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const project = await loadProject(key);
  const t = await getTranslations("projects.team");
  const tAssign = await getTranslations("assignments");
  const { membership } = await requireTenantContext();
  const members = project.caps.manageAssignments
    ? await withTenant(membership.tenantId, { type: "member", id: membership.memberId }, listAssignableMembers)
    : [];

  const assign = async (memberId: string) => {
    "use server";
    const name = members.find((m) => m.memberId === memberId)?.name ?? "";
    return assignProjectMemberAction(project.id, project.key, memberId, name);
  };
  const unassign = async (memberId: string) => {
    "use server";
    const name = project.assignments.find((m) => m.memberId === memberId)?.name ?? "";
    return unassignProjectMemberAction(project.id, project.key, memberId, name);
  };

  return (
    <div className="max-w-(--content-default)">
      <SectionCard title={tAssign("title")} description={t("description")}>
        <AssignmentsPanel
          assigned={project.assignments}
          members={members}
          canManage={project.caps.manageAssignments && project.status !== "ARCHIVED"}
          assign={assign}
          unassign={unassign}
          emptyTitle={t("empty")}
          emptyDescription={t("emptyDescription")}
        />
      </SectionCard>
    </div>
  );
}
