import type { Metadata } from "next";
import { LayoutTemplateIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { requireTenantContext } from "@/members/tenant-context";
import { contractVerbs, listContractTemplates, type ContractTemplateRow } from "@/modules/contracts";

import { TemplateMenu } from "./template-menu";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("contracts.templates");
  return { title: t("title") };
}

/**
 * /settings/contracts (Phase 4 slice 112; founder decision C84 (e), (g)) — the
 * workspace's contract templates, kept by owners and admins
 * (`contract:manage_templates`, which the service and the database both ask).
 * Each row opens its editor; New template opens an empty one.
 */
export default async function ContractTemplatesPage() {
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const t = await getTranslations("contracts.templates");
  const tCommon = await getTranslations("common");
  const format = await getFormatter();

  const verbs = await contractVerbs(ctx);
  let rows: ContractTemplateRow[] | null = null;
  if (verbs.manageTemplates) {
    try {
      rows = await listContractTemplates(ctx);
    } catch (e) {
      if (!(e instanceof AuthzError)) throw e;
    }
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

  return (
    <Page width="form">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Button asChild size="sm">
            <Link href="/settings/contracts/new" data-testid="new-contract-template">
              <PlusIcon aria-hidden />
              {t("new")}
            </Link>
          </Button>
        }
      />
      <div className="mt-6">
        <SectionCard contentClassName={rows.length === 0 ? undefined : "p-0"}>
          {rows.length === 0 ? (
            <EmptyState
              variant="empty"
              icon={LayoutTemplateIcon}
              title={t("empty")}
              body={t("emptyBody")}
              action={
                <Button asChild variant="outline">
                  <Link href="/settings/contracts/new">{t("new")}</Link>
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-border" data-testid="contract-template-list">
              {rows.map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-4 py-2" data-testid="contract-template-row">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <Link
                      href={`/settings/contracts/${r.id}`}
                      className="min-w-0 truncate rounded-sm text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      {r.name}
                    </Link>
                    <span className="text-xs text-muted-foreground">
                      {t("changed", { date: format.dateTime(r.updatedAt, { dateStyle: "medium" }) })}
                    </span>
                  </div>
                  <TemplateMenu templateId={r.id} name={r.name} />
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </Page>
  );
}
