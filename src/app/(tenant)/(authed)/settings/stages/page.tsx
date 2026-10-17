import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { stateLabel } from "@/lib/state-label";
import { requireTenantContext } from "@/members/tenant-context";
import { getWorkspaceStages, type WorkspaceStages } from "@/modules/work";

import { RestoreStages } from "./restore-stages";
import { AddStageForm, StageTable, type StageRowView } from "./stage-editor";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("stageSettings") };
}

/**
 * /settings/stages (slice 123, founder decision C99 (a)): the workspace's
 * DEFAULT stages — what a new project's board starts with. Each project can
 * then change its own (its board's "Edit stages"). `workflow:manage`.
 */
export default async function StageSettingsPage() {
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const t = await getTranslations("settings.stages");
  const tCommon = await getTranslations("common");
  const tStates = await getTranslations("projects.states.seed");

  let data: WorkspaceStages | null = null;
  try {
    data = await getWorkspaceStages(ctx);
  } catch (e) {
    if (!(e instanceof AuthzError)) throw e;
  }
  if (!data) {
    return (
      <Page width="form">
        <PageHeader title={t("title")} />
        <div className="mt-6">
          <SectionCard>
            <EmptyState variant="forbidden" title={tCommon("forbiddenTitle")} body={t("noPermission")} />
          </SectionCard>
        </div>
      </Page>
    );
  }

  const rows: StageRowView[] = data.stages.map((s) => ({
    id: s.key,
    name: stateLabel({ name: s.name, seedKey: s.seedKey }, (k) => tStates(k)),
    category: s.category,
    isDefault: s.isDefault,
    requiresApproval: s.requiresApproval,
    tasks: null,
    binned: null,
  }));

  return (
    <Page width="form">
      <PageHeader title={t("title")} description={t("description")} />
      <div className="mt-6 flex flex-col gap-4">
        <SectionCard
          title={t("listTitle")}
          description={data.custom ? t("listCustom") : t("listOriginal")}
          contentClassName="p-0"
          actions={data.custom ? <RestoreStages /> : null}
        >
          <StageTable scope={{ kind: "workspace" }} rows={rows} canEdit />
        </SectionCard>
        <SectionCard title={t("addTitle")} description={t("addDescription")}>
          <AddStageForm scope={{ kind: "workspace" }} />
        </SectionCard>
      </div>
    </Page>
  );
}
