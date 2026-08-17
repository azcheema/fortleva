import { FileIcon, UploadIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { Callout, EmptyState, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { listDocuments } from "@/documents/service";
import { requireTenantContext } from "@/members/tenant-context";

import { DocumentsTable } from "../../../files/documents-table";
import { UploadForm } from "../../../files/upload-form";
import { loadProject } from "../data";

/**
 * Files tab: project documents. Uploads attach to the project (clientId
 * derived server-side); the visibility select is enabled here —
 * CLIENT_VISIBLE rows reach the portal only while Project.portalEnabled
 * (trigger-derived), which the upload card says in words.
 */
export default async function ProjectFilesPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { key } = await params;
  const { error } = await searchParams;
  const project = await loadProject(key);
  const t = await getTranslations("projects.files");
  const tFiles = await getTranslations("files");
  const tCommon = await getTranslations("common");
  const returnTo = `/projects/${project.key}/files`;
  if (!project.caps.viewDocuments) {
    // "Nothing here" and "not yours to see" are different facts and get
    // different empty states, exactly as on the client Files tab.
    return (
      <SectionCard>
        <EmptyState variant="forbidden" title={t("noAccess")} body={t("noAccessDescription")} />
      </SectionCard>
    );
  }

  const { membership, actor } = await requireTenantContext();
  const documents = await listDocuments(
    { tenantId: membership.tenantId, actor },
    { projectId: project.id },
  );

  const canUpload = project.caps.uploadDocuments && project.status !== "ARCHIVED";
  const uploadButton = (
    <Button asChild size="sm">
      <Link href="#new-file">
        <UploadIcon />
        {tFiles("upload.title")}
      </Link>
    </Button>
  );

  return (
    <div className="flex flex-col gap-6">
      {error ? (
        <Callout tone="danger" role="alert">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-0 flex-1">{error}</span>
            {canUpload ? (
              <Button asChild variant="outline" size="sm">
                <Link href="#new-file">{tCommon("retry")}</Link>
              </Button>
            ) : null}
            <Button asChild variant="ghost" size="icon-sm">
              <Link href={returnTo} aria-label={tCommon("close")}>
                <XIcon />
              </Link>
            </Button>
          </span>
        </Callout>
      ) : null}
      {documents.length === 0 ? (
        <SectionCard>
          <EmptyState
            variant="empty"
            icon={FileIcon}
            title={t("empty")}
            body={t("emptyDescription")}
            action={canUpload ? uploadButton : null}
          />
        </SectionCard>
      ) : (
        <DocumentsTable
          documents={documents}
          returnTo={returnTo}
          canDelete={project.caps.deleteDocuments}
          canChangeVisibility={project.caps.changeDocumentVisibility}
        />
      )}
      {canUpload ? (
        <div className="max-w-(--content-form)">
          <SectionCard
            id="new-file"
            className="scroll-mt-16"
            title={tFiles("upload.title")}
            description={project.portalEnabled ? t("uploadPortalOn") : t("uploadPortalOff")}
          >
            <UploadForm target={{ projectId: project.id, returnTo }} visibilityEnabled />
          </SectionCard>
        </div>
      ) : null}
    </div>
  );
}
