import type { Metadata } from "next";
import { DownloadIcon, FileArchiveIcon } from "lucide-react";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";

import { effectivePermissions } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import {
  Callout,
  DataTable,
  EmptyState,
  Page,
  PageHeader,
  SectionCard,
} from "@/components/semantic";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { withTenant } from "@/db";
import { listExports, type ExportListItem } from "@/export/service";
import { bytesParts } from "@/lib/format";
import { requireTenantContext } from "@/members/tenant-context";

import { downloadAction } from "../../files/actions";
import { GenerateExportForm } from "./generate-export-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.export");
  return { title: t("title") };
}

/**
 * /settings/export (PLAN.md Phase 2, CONTINUITY_BOX.md): the export
 * path is the continuity commitment, so the page opens by SAYING it —
 * as a Callout, not as small print under the title. settings:view
 * lists previous exports; tenant:export (✦) generates a new one;
 * downloads go through the ordinary presigned document path
 * (document:view).
 */
export default async function ExportPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { membership, actor } = await requireTenantContext();
  const { error } = await searchParams;
  const t = await getTranslations("settings.export");
  const tCommon = await getTranslations("common");
  const format = await getFormatter();
  const locale = await getLocale();

  let exports: ExportListItem[] | null = null;
  try {
    exports = await listExports({ tenantId: membership.tenantId, actor });
  } catch (e) {
    if (!(e instanceof AuthzError)) throw e;
  }
  if (!exports) {
    return (
      <Page width="form">
        <PageHeader title={t("title")} />
        <Callout tone="info" className="mt-4">
          {t("noPermission")}
        </Callout>
      </Page>
    );
  }

  const held = await withTenant(
    membership.tenantId,
    { type: "member", id: membership.memberId },
    (tx) => effectivePermissions(tx, actor.memberId),
  );
  // ✦ code: the button shows for holders; a stale factor becomes step-up on click.
  const canExport = held.has("tenant:export");
  const canDownload = held.has("document:view");

  return (
    <Page width="form">
      <PageHeader title={t("title")} description={t("description")} />

      {error ? (
        <Callout tone="danger" role="alert" className="mt-4">
          {error}
        </Callout>
      ) : null}

      <div className="mt-6 flex flex-col gap-4">
        <Callout tone="info" title={t("commitmentTitle")}>
          {t("commitment")}
        </Callout>

        <SectionCard title={t("newExport")} description={t("contents")}>
          {canExport ? (
            <GenerateExportForm />
          ) : (
            <p className="text-sm text-muted-foreground">{t("needsPermission")}</p>
          )}
        </SectionCard>

        <SectionCard
          title={t("previous")}
          contentClassName={exports.length === 0 ? undefined : "p-0"}
        >
          {exports.length === 0 ? (
            <EmptyState variant="empty" title={t("emptyTitle")} body={t("emptyDescription")} />
          ) : (
            <DataTable className="rounded-none border-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("columns.name")}</TableHead>
                    <TableHead>{t("columns.created")}</TableHead>
                    <TableHead className="text-right">{t("columns.size")}</TableHead>
                    <TableHead className="w-0 text-right">
                      <span className="sr-only">{tCommon("actions")}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {exports.map((e) => {
                    const size = bytesParts(locale, e.sizeBytes);
                    return (
                      <TableRow key={e.documentId}>
                        <TableCell className="max-w-64">
                          <span className="flex min-w-0 items-center gap-2">
                            <FileArchiveIcon
                              aria-hidden="true"
                              className="size-3.5 shrink-0 text-muted-foreground"
                            />
                            <span className="num truncate font-mono text-xs" title={e.name}>
                              {e.name}
                            </span>
                          </span>
                        </TableCell>
                        <TableCell className="num text-muted-foreground">
                          {format.dateTime(e.createdAt, {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                        </TableCell>
                        <TableCell className="num text-right whitespace-nowrap">
                          {size.value}
                          <span className="ml-1 text-muted-foreground">{size.unit}</span>
                        </TableCell>
                        <TableCell className="text-right">
                          {canDownload ? (
                            <form action={downloadAction}>
                              <input type="hidden" name="documentId" value={e.documentId} />
                              <input type="hidden" name="returnTo" value="/settings/export" />
                              <Button type="submit" variant="outline" size="sm">
                                <DownloadIcon />
                                {tCommon("download")}
                              </Button>
                            </form>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </DataTable>
          )}
        </SectionCard>
      </div>
    </Page>
  );
}
