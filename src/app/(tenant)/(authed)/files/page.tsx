import type { Metadata } from "next";
import { getFormatter, getTranslations } from "next-intl/server";

import { isAuthorized } from "@/authz/authorize";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { withTenant } from "@/db";
import { listDocuments } from "@/documents/service";
import { requireTenantContext } from "@/members/tenant-context";

import { deleteDocumentAction, downloadAction } from "./actions";
import { UploadForm } from "./upload-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("files");
  return { title: t("shortTitle") };
}

/** Byte sizes: binary units, one decimal (locale-formatted number). */
const bytesParts = (n: number): { value: number; unit: "B" | "KB" | "MB" | "GB" } => {
  if (n < 1024) return { value: n, unit: "B" };
  if (n < 1024 * 1024) return { value: n / 1024, unit: "KB" };
  if (n < 1024 * 1024 * 1024) return { value: n / (1024 * 1024), unit: "MB" };
  return { value: n / (1024 * 1024 * 1024), unit: "GB" };
};

export default async function FilesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { membership, actor } = await requireTenantContext();
  const { error } = await searchParams;
  const t = await getTranslations("files");
  const tCommon = await getTranslations("common");
  const format = await getFormatter();
  const ctx = { tenantId: membership.tenantId, actor };

  const [documents, caps] = await Promise.all([
    listDocuments(ctx),
    withTenant(membership.tenantId, { type: "member", id: membership.memberId }, async (tx) => {
      const [canUpload, canDelete] = await Promise.all([
        isAuthorized(tx, actor, "document:upload"),
        isAuthorized(tx, actor, "document:delete"),
      ]);
      return { canUpload, canDelete };
    }),
  ]);

  const formatBytes = (n: number): string => {
    const { value, unit } = bytesParts(n);
    return `${format.number(value, { maximumFractionDigits: unit === "B" ? 0 : 1 })} ${unit}`;
  };

  return (
    <Page>
      <PageHeader title={t("title", { tenant: membership.tenantName })} />

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      <section className="mt-6">
        {documents.length === 0 ? (
          <EmptyState title={t("empty.title")} description={t("empty.description")} />
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.name")}</TableHead>
                  <TableHead>{t("columns.visibility")}</TableHead>
                  <TableHead className="text-right">{t("columns.size")}</TableHead>
                  <TableHead className="text-right">{t("columns.versions")}</TableHead>
                  <TableHead>{t("columns.updated")}</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {documents.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="max-w-64 truncate font-medium">{d.name}</TableCell>
                    <TableCell>
                      {/* Two-token visibility badge (UI.md §5.5) — never a third wording. */}
                      {d.visibility === "CLIENT_VISIBLE" ? (
                        <Badge className="bg-blue-50 text-blue-700">{t("visibility.clientVisible")}</Badge>
                      ) : (
                        <Badge variant="secondary">{t("visibility.internal")}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatBytes(d.sizeBytes)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {tCommon("versions", { count: d.versionCount })}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {format.dateTime(d.updatedAt, { dateStyle: "medium" })}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <form action={downloadAction}>
                          <input type="hidden" name="documentId" value={d.id} />
                          <Button type="submit" variant="ghost" size="xs">
                            {t("download")}
                          </Button>
                        </form>
                        {caps.canDelete ? (
                          <form action={deleteDocumentAction}>
                            <input type="hidden" name="documentId" value={d.id} />
                            <Button type="submit" variant="destructive" size="xs">
                              {t("delete")}
                            </Button>
                          </form>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {caps.canUpload ? (
        <Card size="sm" className="mt-6">
          <CardHeader>
            <CardTitle>{t("upload.title")}</CardTitle>
          </CardHeader>
          <CardContent>
            <UploadForm />
          </CardContent>
        </Card>
      ) : null}
    </Page>
  );
}
