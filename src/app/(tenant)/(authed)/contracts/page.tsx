import type { Metadata } from "next";
import { FileSignatureIcon, LayoutTemplateIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { requireTenantContext } from "@/members/tenant-context";
import {
  CONTRACT_LIST_LIMIT,
  CONTRACT_UPLOAD_MAX_BYTES,
  contractVerbs,
  listContractClients,
  listContracts,
  listContractTemplates,
  type ContractListRow,
} from "@/modules/contracts";

import { ContractTable } from "./contract-table";
import { NewContract } from "./new-contract";
import { UploadContract } from "./upload-contract";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("contracts.list");
  return { title: t("title") };
}

/**
 * /contracts (Phase 4 slice 112; founder decision C84) — every contract the
 * member's client scope reaches, most recently changed first, and, for a
 * member who may start one (`contract:create`), "New contract" inline: a
 * client, a template or blank, the signer, a title. `contract:view` on all
 * four gates — the contracts module closes it. Templates are kept on Settings
 * → Contract templates, linked here for those who keep them.
 */
export default async function ContractsPage() {
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const t = await getTranslations("contracts.list");
  const tCommon = await getTranslations("common");

  let listed: { rows: readonly ContractListRow[]; more: boolean } | null = null;
  try {
    listed = await listContracts(ctx);
  } catch (e) {
    if (!(e instanceof AuthzError)) throw e;
  }
  if (!listed) {
    return (
      <Page>
        <PageHeader title={t("title")} />
        <div className="mt-6">
          <SectionCard>
            <EmptyState variant="forbidden" title={tCommon("forbiddenTitle")} body={t("noPermission")} />
          </SectionCard>
        </div>
      </Page>
    );
  }

  const verbs = await contractVerbs(ctx);
  const clients = verbs.create ? await listContractClients(ctx) : [];
  const templates = verbs.create ? await listContractTemplates(ctx) : [];
  const rows = listed.rows;

  return (
    <Page>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          verbs.manageTemplates || (verbs.create && clients.length > 0) ? (
            <div className="flex flex-wrap items-center gap-2">
              {/* Slice 112c (C84 (f)): a contract signed elsewhere, put in with its PDF. */}
              {verbs.create && clients.length > 0 ? <UploadContract clients={clients} maxBytes={CONTRACT_UPLOAD_MAX_BYTES} /> : null}
              {verbs.manageTemplates ? (
                <Button asChild size="sm" variant="outline">
                  <Link href="/settings/contracts" data-testid="open-contract-templates">
                    <LayoutTemplateIcon aria-hidden />
                    {t("templates")}
                  </Link>
                </Button>
              ) : null}
            </div>
          ) : null
        }
      />
      <div className="mt-6 flex flex-col gap-4">
        {verbs.create ? (
          <SectionCard id="new-contract" title={t("newTitle")}>
            {clients.length > 0 ? (
              <NewContract clients={clients} templates={templates} />
            ) : (
              <p className="text-sm text-muted-foreground">{t("noClients")}</p>
            )}
          </SectionCard>
        ) : null}
        <SectionCard title={t("listTitle")} contentClassName={rows.length === 0 ? undefined : "p-0"}>
          {rows.length === 0 ? (
            verbs.create && clients.length > 0 ? (
              <EmptyState
                variant="empty"
                icon={FileSignatureIcon}
                title={t("empty")}
                body={t("emptyBody")}
                action={
                  <Button asChild variant="outline">
                    <a href="#new-contract">{t("newTitle")}</a>
                  </Button>
                }
              />
            ) : (
              <EmptyState variant="filtered" icon={FileSignatureIcon} title={t("empty")} />
            )
          ) : (
            <ContractTable rows={rows} showClient label={t("listTitle")} />
          )}
        </SectionCard>
        {listed.more ? (
          <p className="text-xs text-muted-foreground" data-testid="contract-list-limited">
            {t("limited", { limit: CONTRACT_LIST_LIMIT })}
          </p>
        ) : null}
      </div>
    </Page>
  );
}
