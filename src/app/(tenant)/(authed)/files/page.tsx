import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { isAuthorized } from "@/authz/authorize";
import { Callout, EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
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
 * client's or project's Files tab, which is also the only place
 * "Client can see" is a legal choice.
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
    <Page width="wide">
      <PageHeader
        title={t("title", { tenant: membership.tenantName })}
        description={t("subtitle")}
      />

      {error ? (
        <Callout tone="danger" role="alert" className="mt-4">
          {error}
        </Callout>
      ) : null}

      <section className="mt-6">
        {documents.length === 0 ? (
          <SectionCard>
            <EmptyState variant="empty" title={t("empty.title")} body={t("empty.description")} />
          </SectionCard>
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
        <div className="mt-6">
          <SectionCard title={t("upload.title")} description={t("upload.tenantScope")}>
            <UploadForm />
          </SectionCard>
        </div>
      ) : null}
    </Page>
  );
}
