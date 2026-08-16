import { getTranslations } from "next-intl/server";

import { Callout, EmptyState, SectionCard } from "@/components/semantic";
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
          canDelete={project.caps.deleteDocuments}
          canChangeVisibility={project.caps.changeDocumentVisibility}
        />
      )}
      {project.caps.uploadDocuments && project.status !== "ARCHIVED" ? (
        <SectionCard
          title={tFiles("upload.title")}
          description={project.portalEnabled ? t("uploadPortalOn") : t("uploadPortalOff")}
        >
          <UploadForm target={{ projectId: project.id, returnTo }} visibilityEnabled />
        </SectionCard>
      ) : null}
    </div>
  );
}
