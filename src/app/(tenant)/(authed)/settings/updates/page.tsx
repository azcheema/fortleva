import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { effectivePermissions } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { withTenant } from "@/db";
import { requireTenantContext } from "@/members/tenant-context";
import { listUpdateTemplates, type UpdateTemplateRow } from "@/modules/work";

import { DefaultLayoutForm, LayoutsSection } from "./layouts";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.updates");
  return { title: t("title") };
}

/**
 * /settings/updates (Phase 5 slice 105; founder decision C73 (c), (d), (g)) —
 * the workspace's progress-update LAYOUTS: which headings a new update opens
 * with, in what order, and which numbers start ticked; and which layout is
 * the default for every project that has not picked its own (a project picks
 * on its Overview). `settings:view` reads the page; `settings:edit` (owners
 * and admins by default) changes anything on it — the service checks again.
 */
export default async function UpdateSettingsPage() {
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("settings.updates");
  const tCommon = await getTranslations("common");

  let rows: UpdateTemplateRow[] | null = null;
  try {
    rows = await listUpdateTemplates({ tenantId: membership.tenantId, actor });
  } catch (e) {
    if (!(e instanceof AuthzError)) throw e;
  }
  if (!rows) {
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

  const held = await withTenant(membership.tenantId, { type: "member", id: membership.memberId }, (tx) =>
    effectivePermissions(tx, actor.memberId),
  );
  const canEdit = held.has("settings:edit");

  return (
    <Page width="form">
      <PageHeader title={t("title")} description={t("description")} />
      <div className="mt-6 flex flex-col gap-4">
        <SectionCard title={t("default.title")}>
          <DefaultLayoutForm rows={rows} canEdit={canEdit} />
        </SectionCard>
        <SectionCard title={t("layouts.title")} contentClassName="p-0">
          <LayoutsSection rows={rows} canEdit={canEdit} />
        </SectionCard>
      </div>
    </Page>
  );
}
