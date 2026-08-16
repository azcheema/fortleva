import { getTranslations } from "next-intl/server";

import { EmptyState } from "@/components/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { listDocuments } from "@/documents/service";
import { requireTenantContext } from "@/members/tenant-context";

import { DocumentsTable } from "../../../files/documents-table";
import { UploadForm } from "../../../files/upload-form";
import { loadClient } from "../data";

/**
 * Files tab: client-level documents (no project) through the existing
 * upload flow, with the visibility select enabled — CLIENT_VISIBLE is
 * legal here because a client is attached. Direct client scope only.
 */
export default async function ClientFilesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  const client = await loadClient(id);
  const t = await getTranslations("clients.files");
  const tFiles = await getTranslations("files");
  const returnTo = `/clients/${client.id}/files`;

  if (!client.caps.viewDocuments) {
    return <EmptyState title={t("noAccess")} description={t("noAccessDescription")} />;
  }

  const { membership, actor } = await requireTenantContext();
  const documents = await listDocuments(
    { tenantId: membership.tenantId, actor },
    { clientId: client.id },
  );

  return (
    <div className="flex flex-col gap-6">
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      {documents.length === 0 ? (
        <EmptyState title={t("empty")} description={t("emptyDescription")} />
      ) : (
        <DocumentsTable
          documents={documents}
          returnTo={returnTo}
          canDelete={client.caps.deleteDocuments}
          canChangeVisibility={client.caps.changeDocumentVisibility}
        />
      )}
      {client.caps.uploadDocuments && client.status === "ACTIVE" ? (
        <Card size="sm">
          <CardHeader>
            <CardTitle>{tFiles("upload.title")}</CardTitle>
          </CardHeader>
          <CardContent>
            <UploadForm target={{ clientId: client.id, returnTo }} visibilityEnabled />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
