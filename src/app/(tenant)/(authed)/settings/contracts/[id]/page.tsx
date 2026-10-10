import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { isUuid } from "@/db/context";
import { EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { DomainError } from "@/lib/domain-error";
import { requireTenantContext } from "@/members/tenant-context";
import { readContractTemplate, type ContractTemplateDetail } from "@/modules/contracts";

import { TemplateEditor } from "../template-editor";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("contracts.templates");
  return { title: t("editTitle") };
}

const LINK =
  "rounded-sm text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** /settings/contracts/[id] (Phase 4 slice 112) — one template's editor; `contract:manage_templates`. */
export default async function ContractTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("contracts.templates");
  const tCommon = await getTranslations("common");

  let template: ContractTemplateDetail | null = null;
  try {
    template = await readContractTemplate({ tenantId: membership.tenantId, actor }, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    if (!(e instanceof AuthzError)) throw e;
  }
  if (!template) {
    return (
      <Page width="form">
        <PageHeader title={t("editTitle")} />
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
      <PageHeader title={template.name} />
      <div className="mt-6">
        <TemplateEditor
          templateId={template.id}
          initialName={template.name}
          initialBody={template.body}
        />
      </div>
    </Page>
  );
}
