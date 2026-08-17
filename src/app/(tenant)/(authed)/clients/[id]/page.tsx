import { PlusIcon, ReceiptIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { listAssignableMembers } from "@/clients/service";
import { AssignmentsPanel } from "@/components/assignments-panel";
import { EmptyState, SectionCard, VisibilityBadge } from "@/components/semantic";
import { Button } from "@/components/ui/button";
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
  const tCommon = await getTranslations("common");
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

  const canAddService = client.caps.createServices && client.status === "ACTIVE";

  return (
    <div className="flex flex-col gap-6">
      <SectionCard title={t("overview.company")}>
        <ClientCardForm client={client} editable={client.caps.edit} />
      </SectionCard>

      {client.internalNotes !== undefined ? (
        <SectionCard
          title={t("overview.notes")}
          description={t("overview.notesHint")}
          actions={<VisibilityBadge value="INTERNAL" />}
        >
          <ClientNotesForm client={client} />
        </SectionCard>
      ) : null}

      {client.caps.viewServices ? (
        // p-0 + <DataTable flush>: a bordered table inside a padded card
        // draws two hairlines 16px apart (§10.15.1).
        <SectionCard title={t("services.title")} contentClassName="p-0">
          {services.length === 0 ? (
            <div className="px-4">
              {canAddService ? (
                <EmptyState
                  variant="empty"
                  icon={ReceiptIcon}
                  title={t("services.empty")}
                  body={t("services.emptyDescription")}
                  action={
                    <Button asChild size="sm">
                      <Link href="#new-service">
                        <PlusIcon />
                        {t("services.add")}
                      </Link>
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  variant="forbidden"
                  icon={ReceiptIcon}
                  title={t("services.emptyReadOnly")}
                  body={t("services.emptyReadOnlyDescription")}
                />
              )}
            </div>
          ) : (
            <ServicesList
              clientId={client.id}
              services={services}
              canEdit={client.caps.editServices}
              canDelete={client.caps.deleteServices}
            />
          )}
          {canAddService ? (
            <div id="new-service" className="border-t border-border p-4 scroll-mt-16">
              <CreateServiceForm
                clientId={client.id}
                projects={client.projects.map((p) => ({ id: p.id, key: p.key, name: p.name }))}
              />
            </div>
          ) : null}
        </SectionCard>
      ) : null}

      <SectionCard title={tAssign("title")}>
        <AssignmentsPanel
          assigned={client.assignments}
          members={members}
          canManage={client.caps.manageAssignments}
          assign={assign}
          unassign={unassign}
          emptyTitle={tAssign("empty")}
          emptyDescription={tAssign("emptyDescription")}
        />
      </SectionCard>

      {client.caps.delete ? (
        // A page-level destructive is not a row action and not a button
        // floating on the canvas: it gets its own footer card, one line
        // of consequence, and an outline resting weight (§5.9).
        <SectionCard title={tCommon("danger.title")}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 text-sm text-muted-foreground">
              {t("overview.dangerDescription")}
            </p>
            <ArchiveClientControl client={client} />
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}
