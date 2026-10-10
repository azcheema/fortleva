import type { Metadata } from "next";
import { FileSignatureIcon, LayoutTemplateIcon } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { DataTable, EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireTenantContext } from "@/members/tenant-context";
import {
  CONTRACT_LIST_LIMIT,
  contractVerbs,
  listContractClients,
  listContracts,
  listContractTemplates,
  type ContractListRow,
} from "@/modules/contracts";

import { NewContract } from "./new-contract";

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
  const tStatus = await getTranslations("contracts.status");
  const tCommon = await getTranslations("common");
  const format = await getFormatter();

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
          verbs.manageTemplates ? (
            <Button asChild size="sm" variant="outline">
              <Link href="/settings/contracts" data-testid="open-contract-templates">
                <LayoutTemplateIcon aria-hidden />
                {t("templates")}
              </Link>
            </Button>
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
            <DataTable flush scrollLabel={t("listTitle")}>
              <Table data-testid="contract-list">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("columns.title")}</TableHead>
                    <TableHead priority="medium">{t("columns.client")}</TableHead>
                    <TableHead>{t("columns.status")}</TableHead>
                    <TableHead priority="low" className="w-[8ch]">
                      {t("columns.version")}
                    </TableHead>
                    <TableHead priority="low">{t("columns.updated")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id} data-testid="contract-row" data-contract-id={r.id} data-status={r.status}>
                      {/* The title YIELDS (`contain-inline-size`): a long one never widens the card. */}
                      <TableCell className="min-w-24">
                        <div className="flex w-full min-w-0 contain-inline-size">
                          <Link
                            href={`/contracts/${r.id}`}
                            title={r.title}
                            className="min-w-0 truncate rounded-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                          >
                            {r.title}
                          </Link>
                        </div>
                      </TableCell>
                      <TableCell priority="medium" className="max-w-48 truncate text-muted-foreground">
                        {r.client.name}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <Badge variant={r.status === "DRAFT" ? "neutral" : "brand"}>{tStatus(r.status)}</Badge>
                      </TableCell>
                      <TableCell priority="low" className="num whitespace-nowrap text-muted-foreground">
                        {t("versionValue", { version: r.version })}
                      </TableCell>
                      <TableCell priority="low" className="num whitespace-nowrap text-muted-foreground">
                        {format.dateTime(r.updatedAt, { dateStyle: "medium" })}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </DataTable>
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
