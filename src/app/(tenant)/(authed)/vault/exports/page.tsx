import type { Metadata } from "next";
import { DownloadIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";

import { DataTable, EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { VaultLockTimer } from "@/components/vault/vault-lock-timer";
import { EXPORT_HISTORY_DAYS, EXPORT_HISTORY_LIMIT, listVaultExports, type VaultExportRecord } from "@/modules/vault";

import { openVaultPage } from "../vault-page";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("vault.exports");
  return { title: t("title") };
}

/**
 * `/vault/exports` — WHO EXPORTED LOGINS, AND WHEN (Phase 3V slice 95;
 * founder decision C63 (b)). Where every holder's security notice lands:
 * the mail names nobody (ARC-09), so this page says who exported how many
 * logins of what, and when — the last `EXPORT_HISTORY_DAYS` days, newest
 * first, read from the export's own audit rows.
 *
 * Behind the vault's door like every vault page (`vault-page.tsx`, C52
 * (a)); then for a member who holds `credential:export` (`listVaultExports`)
 * — anyone else gets a 404 (UI.md §7.3). A holder kept to some clients was
 * mailed too, so they get the page with a line saying the list is for
 * people who see every client: an export of everything says how many
 * logins the agency keeps.
 */
export default async function VaultExportsPage() {
  const opened = await openVaultPage("/vault/exports", (ctx) => listVaultExports(ctx));
  const t = await getTranslations("vault.exports");
  const header = (actions: React.ReactNode) => (
    <PageHeader title={t("title")} description={t("description", { days: EXPORT_HISTORY_DAYS })} actions={actions} />
  );
  if (opened.kind === "door") {
    return (
      <Page width="form">
        {header(null)}
        <div className="mt-6">{opened.door}</div>
      </Page>
    );
  }
  const history = opened.data;
  if (history === null) notFound();
  const format = await getFormatter();
  const exports = history.kind === "list" ? history.rows : [];

  const what = (e: VaultExportRecord): string =>
    e.scope === "agency"
      ? t("scopeAgency")
      : e.scope === "client"
        ? (e.client?.name ?? t("scopeGoneClient"))
        : t("scopeAll");

  return (
    <Page width="form">
      {header(<VaultLockTimer locksAt={opened.open.locksAt.toISOString()} msLeft={opened.msLeft} />)}
      <div className="mt-6 flex flex-col gap-4">
        <SectionCard contentClassName={exports.length === 0 ? undefined : "p-0"}>
          {history.kind === "scoped" ? (
            <EmptyState variant="forbidden" icon={DownloadIcon} title={t("scopedTitle")} body={t("scopedDescription")} />
          ) : exports.length === 0 ? (
            <EmptyState variant="forbidden" icon={DownloadIcon} title={t("empty")} body={t("emptyDescription")} />
          ) : (
            <DataTable flush scrollLabel={t("title")}>
              <Table data-testid="vault-exports">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("columns.when")}</TableHead>
                    <TableHead>{t("columns.who")}</TableHead>
                    <TableHead priority="medium">{t("columns.what")}</TableHead>
                    <TableHead className="text-right">{t("columns.count")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {exports.map((e) => (
                    <TableRow key={e.exportId} data-testid="vault-export-row">
                      <TableCell className="num whitespace-nowrap">
                        {format.dateTime(e.at, { dateStyle: "medium", timeStyle: "short" })}
                      </TableCell>
                      <TableCell className="max-w-48 truncate">{e.by ?? t("someoneGone")}</TableCell>
                      <TableCell priority="medium" className="max-w-48 truncate text-muted-foreground">
                        {what(e)}
                      </TableCell>
                      <TableCell className="num text-right">{e.count}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </DataTable>
          )}
        </SectionCard>
        {history.kind === "list" && history.more ? (
          <p className="text-xs text-muted-foreground" data-testid="vault-exports-limited">
            {t("limited", { limit: EXPORT_HISTORY_LIMIT })}
          </p>
        ) : null}
        <p className="text-sm">
          <Link
            href="/vault"
            className="rounded-sm text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {t("back")}
          </Link>
        </p>
      </div>
    </Page>
  );
}
