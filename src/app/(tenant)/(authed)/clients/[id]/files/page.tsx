import { FileIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { Callout, EmptyState, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
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
  const canUpload = client.caps.uploadDocuments && client.status === "ACTIVE";

  return (
    <div className="flex flex-col gap-6">
      {error ? (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      ) : null}
      {documents.length === 0 ? (
        <SectionCard>
          {canUpload ? (
            <EmptyState
              variant="empty"
              icon={FileIcon}
              title={t("empty")}
              body={t("emptyDescription")}
              action={
                <Button asChild size="sm">
                  <Link href="#new-file">
                    <PlusIcon />
                    {tFiles("upload.title")}
                  </Link>
                </Button>
              }
            />
          ) : (
            <EmptyState
              variant="forbidden"
              icon={FileIcon}
              title={t("emptyReadOnly")}
              body={t("emptyReadOnlyDescription")}
            />
          )}
        </SectionCard>
      ) : (
        <DocumentsTable
          documents={documents}
          returnTo={returnTo}
          canDelete={client.caps.deleteDocuments}
          canChangeVisibility={client.caps.changeDocumentVisibility}
        />
      )}
      {canUpload ? (
        <SectionCard
          id="new-file"
          className="scroll-mt-16"
          title={tFiles("upload.title")}
          description={t("emptyDescription")}
        >
          <UploadForm target={{ clientId: client.id, returnTo }} visibilityEnabled />
        </SectionCard>
      ) : null}
    </div>
  );
}
