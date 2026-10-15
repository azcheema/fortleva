import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { requireTenantContext } from "@/members/tenant-context";
// Off the barrel on purpose: the templates are one feature's service.
import { listTemplates, type TemplateRow } from "@/modules/work/templates/service";

import { TemplatesTable } from "./templates-table";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("templateSettings") };
}

/**
 * /settings/templates (slice 124, founder decision C100 (b)): the
 * workspace's project templates — rename and delete. They are MADE by "Save
 * as template" on a project's Overview, and changed by saving a project
 * again under the same name; there is no editor here, by the founder's
 * choice. `project_template:manage`; anyone else sees `forbidden`.
 * Internal only: templates never reach the portal.
 */
export default async function TemplateSettingsPage() {
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const t = await getTranslations("settings.templates");
  const tCommon = await getTranslations("common");

  let templates: TemplateRow[] | null = null;
  try {
    templates = await listTemplates(ctx);
  } catch (e) {
    if (!(e instanceof AuthzError)) throw e;
  }
  if (!templates) {
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
      <div className="mt-6">
        <SectionCard
          title={t("listTitle")}
          description={t("listDescription", { count: templates.length })}
          contentClassName="p-0"
        >
          <TemplatesTable rows={templates.map((r) => ({ ...r, savedAt: r.savedAt.toISOString() }))} />
        </SectionCard>
      </div>
    </Page>
  );
}
