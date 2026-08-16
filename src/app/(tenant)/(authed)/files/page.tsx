import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { isAuthorized } from "@/authz/authorize";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { withTenant } from "@/db";
import { listDocuments } from "@/documents/service";
import { requireTenantContext } from "@/members/tenant-context";

import { DocumentsTable } from "./documents-table";
import { UploadForm } from "./upload-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("files");
  return { title: t("shortTitle") };
}

/**
 * /files: every document the member may see — tenant-internal ones plus
 * client/project documents inside their scope. Uploads here are
 * tenant-internal; attaching to a client/project happens on that
 * client's or project's Files tab.
 */
export default async function FilesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { membership, actor } = await requireTenantContext();
  const { error } = await searchParams;
  const t = await getTranslations("files");
  const ctx = { tenantId: membership.tenantId, actor };

  const [documents, caps] = await Promise.all([
    listDocuments(ctx),
    withTenant(membership.tenantId, { type: "member", id: membership.memberId }, async (tx) => {
      const [canUpload, canDelete, canChangeVisibility] = await Promise.all([
        isAuthorized(tx, actor, "document:upload"),
        isAuthorized(tx, actor, "document:delete"),
        isAuthorized(tx, actor, "document:change_visibility"),
      ]);
      return { canUpload, canDelete, canChangeVisibility };
    }),
  ]);

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
          <DocumentsTable
            documents={documents}
            returnTo="/files"
            canDelete={caps.canDelete}
            canChangeVisibility={caps.canChangeVisibility}
          />
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
