import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { requireTenantContext } from "@/members/tenant-context";
import { contractVerbs } from "@/modules/contracts";

import { TemplateEditor } from "../template-editor";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("contracts.templates");
  return { title: t("newTitle") };
}

const LINK =
  "rounded-sm text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** /settings/contracts/new (Phase 4 slice 112) — an empty template's editor; Create opens it at its own address. */
export default async function NewContractTemplatePage() {
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("contracts.templates");
  const tCommon = await getTranslations("common");
  const verbs = await contractVerbs({ tenantId: membership.tenantId, actor });
  if (!verbs.manageTemplates) {
    return (
      <Page width="form">
        <PageHeader title={t("newTitle")} />
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
      <div className="mb-2">
        <Link href="/settings/contracts" className={LINK}>
          {t("back")}
        </Link>
      </div>
      <PageHeader title={t("newTitle")} />
      <div className="mt-6">
        <TemplateEditor templateId={null} initialName="" initialBody={null} />
      </div>
    </Page>
  );
}
