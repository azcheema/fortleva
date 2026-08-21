import { getTranslations } from "next-intl/server";

import { listAssignableMembers } from "@/clients/service";
import { AssignmentsPanel } from "@/components/assignments-panel";
import { SectionCard, VisibilityBadge } from "@/components/semantic";
import { withTenant } from "@/db";
import { requireTenantContext } from "@/members/tenant-context";

import { assignClientMemberAction, unassignClientMemberAction } from "./actions";
import { loadClient } from "./data";
import { ArchiveClientControl, ClientCardForm, ClientNotesForm } from "./overview-forms";

/**
 * Overview tab: company card · internal notes · team · archive. Services
 * moved to the Agreements tab with 2T (UI.md §3.1): one place where an
 * agreement, its rate cards and its consumption live together.
 */
export default async function ClientOverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = await loadClient(id);
  const { membership } = await requireTenantContext();
  const t = await getTranslations("clients");
  const tAssign = await getTranslations("assignments");
  const tCommon = await getTranslations("common");

  const members = client.caps.manageAssignments
    ? await withTenant(membership.tenantId, { type: "member", id: membership.memberId }, listAssignableMembers)
    : [];

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

      {/* The "no presence, no activity" promise is a property of the
          card, not a footnote under its list (UI.md rule 14). */}
      <SectionCard title={tAssign("title")} description={tAssign("noPresence")}>
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
