import { getTranslations } from "next-intl/server";

import { Callout, EmptyState, SectionCard } from "@/components/semantic";
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
    return (
      <SectionCard>
        <EmptyState variant="forbidden" title={t("noAccess")} body={t("noAccessDescription")} />
      </SectionCard>
    );
  }

  const { membership, actor } = await requireTenantContext();
  const documents = await listDocuments(
    { tenantId: membership.tenantId, actor },
    { clientId: client.id },
  );

  return (
    <div className="flex flex-col gap-6">
      {error ? (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      ) : null}
      {documents.length === 0 ? (
        <SectionCard>
          <EmptyState variant="empty" title={t("empty")} body={t("emptyDescription")} />
        </SectionCard>
      ) : (
        <DocumentsTable
          documents={documents}
          returnTo={returnTo}
          canDelete={client.caps.deleteDocuments}
          canChangeVisibility={client.caps.changeDocumentVisibility}
        />
      )}
      {client.caps.uploadDocuments && client.status === "ACTIVE" ? (
        <SectionCard title={tFiles("upload.title")}>
          <UploadForm target={{ clientId: client.id, returnTo }} visibilityEnabled />
        </SectionCard>
      ) : null}
    </div>
  );
}
