import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { requireTenantContext } from "@/members/tenant-context";
// Off the barrel on purpose (labels.ts: the module's reads carry label ids).
import { listWorkspaceLabels, type LabelRow } from "@/modules/work/labels";

import { CreateLabelForm, LabelsTable } from "./labels-table";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("labelSettings") };
}

/**
 * /settings/labels (slice 123, founder decision C99 (b)): the workspace's
 * labels — rename, colour, delete, merge, and make new ones. `label:manage`;
 * anyone else sees `forbidden`. Internal only: labels never reach the portal.
 */
export default async function LabelSettingsPage() {
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const t = await getTranslations("settings.labels");
  const tCommon = await getTranslations("common");

  let labels: LabelRow[] | null = null;
  try {
    labels = await listWorkspaceLabels(ctx);
  } catch (e) {
    if (!(e instanceof AuthzError)) throw e;
  }
  if (!labels) {
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

  return (
    <Page width="form">
      <PageHeader title={t("title")} description={t("description")} />
      <div className="mt-6 flex flex-col gap-4">
        <SectionCard title={t("listTitle")} description={t("listDescription", { count: labels.length })} contentClassName="p-0">
          <LabelsTable rows={labels} />
        </SectionCard>
        <SectionCard id="new-label" title={t("addTitle")}>
          <CreateLabelForm />
        </SectionCard>
      </div>
    </Page>
  );
}
