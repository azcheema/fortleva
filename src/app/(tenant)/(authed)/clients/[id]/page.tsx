import { getTranslations } from "next-intl/server";

import { listAssignableMembers } from "@/clients/service";
import { AssignmentsPanel } from "@/components/assignments-panel";
import { EmptyState } from "@/components/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { withTenant } from "@/db";
import { requireTenantContext } from "@/members/tenant-context";
import { listServices } from "@/services/service";

import { assignClientMemberAction, unassignClientMemberAction } from "./actions";
import { loadClient } from "./data";
import {
  ArchiveClientControl,
  ClientCardForm,
  ClientNotesForm,
  CreateServiceForm,
  ServicesList,
} from "./overview-forms";

/** Overview tab: company card · internal notes · services · team · archive. */
export default async function ClientOverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = await loadClient(id);
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("clients");
  const tAssign = await getTranslations("assignments");
  const ctx = { tenantId: membership.tenantId, actor };

  const [services, members] = await Promise.all([
    client.caps.viewServices ? listServices(ctx, { clientId: client.id }) : Promise.resolve([]),
    client.caps.manageAssignments
      ? withTenant(membership.tenantId, { type: "member", id: membership.memberId }, listAssignableMembers)
      : Promise.resolve([]),
  ]);

  const assign = async (memberId: string) => {
    "use server";
    const name = members.find((m) => m.memberId === memberId)?.name ?? "";
    return assignClientMemberAction(client.id, memberId, name);
  };
  const unassign = async (memberId: string) => {
    "use server";
    const name = client.assignments.find((m) => m.memberId === memberId)?.name ?? "";
    return unassignClientMemberAction(client.id, memberId, name);
  };

  return (
    <div className="flex flex-col gap-6">
      <Card size="sm">
        <CardHeader>
          <CardTitle>{t("overview.company")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ClientCardForm client={client} editable={client.caps.edit} />
        </CardContent>
      </Card>

      {client.internalNotes !== undefined ? (
        <Card size="sm">
          <CardContent>
            <ClientNotesForm client={client} />
          </CardContent>
        </Card>
      ) : null}

      {client.caps.viewServices ? (
        <Card size="sm">
          <CardHeader>
            <CardTitle>{t("services.title")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {services.length === 0 ? (
              <EmptyState title={t("services.empty")} description={t("services.emptyDescription")} />
            ) : (
              <ServicesList
                clientId={client.id}
                services={services}
                canEdit={client.caps.editServices}
                canDelete={client.caps.deleteServices}
              />
            )}
            {client.caps.createServices && client.status === "ACTIVE" ? (
              <CreateServiceForm
                clientId={client.id}
                projects={client.projects.map((p) => ({ id: p.id, key: p.key, name: p.name }))}
              />
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card size="sm">
        <CardHeader>
          <CardTitle>{tAssign("title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <AssignmentsPanel
            assigned={client.assignments}
            members={members}
            canManage={client.caps.manageAssignments}
            assign={assign}
            unassign={unassign}
            emptyTitle={tAssign("empty")}
            emptyDescription={tAssign("emptyDescription")}
          />
        </CardContent>
      </Card>

      {client.caps.delete ? (
        <div className="flex justify-end">
          <ArchiveClientControl client={client} />
        </div>
      ) : null}
    </div>
  );
}
