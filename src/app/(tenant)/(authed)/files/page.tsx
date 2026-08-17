import type { Metadata } from "next";
import { FileIcon, UploadIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { isAuthorized } from "@/authz/authorize";
import { Callout, EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
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
  const tCommon = await getTranslations("common");
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

  const uploadButton = (
    <Button asChild size="sm">
      <Link href="#new-file">
        <UploadIcon />
        {t("upload.title")}
      </Link>
    </Button>
  );

  return (
    <Page width="wide">
      {/* The h1 is the page noun; the workspace name lives in the header
          and in <title>, not in the heading of every route. */}
      <PageHeader
        title={t("shortTitle")}
        description={t("subtitle")}
        actions={caps.canUpload ? uploadButton : null}
      />

      {error ? (
        <Callout tone="danger" role="alert" className="mt-4">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-0 flex-1">{error}</span>
            {/* The banner names a failed action; it now also offers the
                two ways out instead of living in the layout for ever. */}
            {caps.canUpload ? (
              <Button asChild variant="outline" size="sm">
                <Link href="#new-file">{tCommon("retry")}</Link>
              </Button>
            ) : null}
            <Button asChild variant="ghost" size="icon-sm">
              <Link href="/files" aria-label={tCommon("close")}>
                <XIcon />
              </Link>
            </Button>
          </span>
        </Callout>
      ) : null}

      <section className="mt-6">
        {documents.length === 0 ? (
          <SectionCard>
            <EmptyState
              variant="empty"
              icon={FileIcon}
              title={t("empty.title")}
              body={t("empty.description")}
              action={caps.canUpload ? uploadButton : null}
            />
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
        // Constrained to the form column: a 1440px card around a 512px
        // form reads as a missing second column.
        <div className="mt-6 max-w-(--content-form)">
          <SectionCard id="new-file" className="scroll-mt-16" title={t("upload.title")}>
            <UploadForm />
          </SectionCard>
        </div>
      ) : null}
    </Page>
  );
}
