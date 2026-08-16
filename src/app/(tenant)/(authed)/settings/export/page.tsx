import type { Metadata } from "next";
import { getFormatter, getTranslations } from "next-intl/server";

import { effectivePermissions } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { requireTenantContext } from "@/members/tenant-context";

import { downloadAction } from "../../files/actions";
import { GenerateExportForm } from "./generate-export-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.export");
  return { title: t("title") };
}

const bytesParts = (n: number): { value: number; unit: "B" | "KB" | "MB" | "GB" } => {
  if (n < 1024) return { value: n, unit: "B" };
  if (n < 1024 * 1024) return { value: n / 1024, unit: "KB" };
  if (n < 1024 * 1024 * 1024) return { value: n / (1024 * 1024), unit: "MB" };
  return { value: n / (1024 * 1024 * 1024), unit: "GB" };
};

/**
 * /settings/export (PLAN.md Phase 2, CONTINUITY_BOX.md): the export
 * path is the continuity commitment. settings:view lists previous
 * exports; tenant:export (✦) generates a new one; downloads go through
 * the ordinary presigned document path (document:view).
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

  let exports: ExportListItem[] | null = null;
  try {
    exports = await listExports({ tenantId: membership.tenantId, actor });
  } catch (e) {
    if (!(e instanceof AuthzError)) throw e;
  }
  if (!exports) {
    return (
      <Page>
        <PageHeader title={t("title")} />
        <p className="mt-4 text-sm text-muted-foreground">{t("noPermission")}</p>
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
  const formatBytes = (n: number): string => {
    const { value, unit } = bytesParts(n);
    return `${format.number(value, { maximumFractionDigits: unit === "B" ? 0 : 1 })} ${unit}`;
  };

  return (
    <Page>
      <PageHeader title={t("title")} description={t("commitment")} />
      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      <div className="mt-6 grid gap-4">
        <Card>
          <CardHeader>
            <CardTitle>{t("newExport")}</CardTitle>
            <CardDescription>{t("contents")}</CardDescription>
          </CardHeader>
          <CardContent>
            {canExport ? (
              <GenerateExportForm />
            ) : (
              <p className="text-sm text-muted-foreground">{t("needsPermission")}</p>
            )}
          </CardContent>
        </Card>

        <section>
          <h2 className="mb-2 text-sm font-medium">{t("previous")}</h2>
          {exports.length === 0 ? (
            <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} />
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("columns.name")}</TableHead>
                    <TableHead>{t("columns.created")}</TableHead>
                    <TableHead className="text-right">{t("columns.size")}</TableHead>
                    <TableHead className="w-24" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {exports.map((e) => (
                    <TableRow key={e.documentId}>
                      <TableCell className="font-medium">{e.name}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {format.dateTime(e.createdAt, { dateStyle: "medium", timeStyle: "short" })}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatBytes(e.sizeBytes)}</TableCell>
                      <TableCell className="text-right">
                        {canDownload ? (
                          <form action={downloadAction}>
                            <input type="hidden" name="documentId" value={e.documentId} />
                            <input type="hidden" name="returnTo" value="/settings/export" />
                            <Button type="submit" variant="ghost" size="xs">
                              {tCommon("download")}
                            </Button>
                          </form>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      </div>
    </Page>
  );
}
