import { PaperclipIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { Callout, EmptyState, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { VisibilityBadge } from "@/components/visibility-badge";
import type { DocumentListItem } from "@/documents/service";
import { formatDuration, type DurationStyle } from "@/lib/format";
import type { ItemList } from "@/modules/work";

import { DocumentsTable } from "../../../files/documents-table";
import { UploadForm } from "../../../files/upload-form";

/**
 * The item side-peek, started MINIMAL (2W-B): header + three read-only
 * properties + the attachments section, reusing the one documents table
 * and the one upload form verbatim (UI.md never-build list: no second
 * attachment list). The pinned full panel — Tiptap description,
 * subtasks, comments, property editing, single keys — grows onto this
 * shell in the side-peek + comments slice; the URL contract
 * (`?item=KEY-123`) is already the final one.
 */
export async function ItemPeek({
  item,
  itemKey,
  documents,
  caps,
  returnTo,
  durationStyle,
  error,
}: {
  item: ItemList["items"][number];
  /** "ACME-12" — the human key the header shows. */
  itemKey: string;
  documents: DocumentListItem[];
  caps: {
    viewDocuments: boolean;
    uploadDocuments: boolean;
    deleteDocuments: boolean;
    changeDocumentVisibility: boolean;
  };
  /** The peek's own URL — actions revalidate/bounce back into the peek. */
  returnTo: string;
  durationStyle: DurationStyle;
  /** A failed download/delete bounces back as `?error=` (the Files-tab
   * contract) — the peek must show it, or a failure looks like nothing
   * happened (the standing rule). */
  error?: string;
}) {
  const t = await getTranslations("projects.item");
  const tBacklog = await getTranslations("projects.backlog");
  const tFiles = await getTranslations("files");
  const tCommon = await getTranslations("common");
  const locale = await getLocale();
  const internal = item.visibility === "INTERNAL";

  return (
    <div className="flex flex-col">
      <SheetHeader>
        <span className="num-id text-xs text-muted-foreground">{itemKey}</span>
        <SheetTitle>{item.title}</SheetTitle>
        <SheetDescription className="sr-only">{t("description")}</SheetDescription>
        <div>
          <VisibilityBadge visibility={item.visibility} />
        </div>
      </SheetHeader>

      {/* Read-first property list (UI.md §10.15 pattern 7) — read-only in
          this slice; editing arrives with the PropertyPicker. */}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 px-4 pb-4 text-sm">
        <dt className="text-muted-foreground">{t("properties.state")}</dt>
        <dd>{item.stateName}</dd>
        <dt className="text-muted-foreground">{t("properties.assignee")}</dt>
        <dd>{item.assigneeName ?? tBacklog("unassigned")}</dd>
        <dt className="text-muted-foreground">{t("properties.estimate")}</dt>
        <dd className="num">
          {item.estimateMinutes != null ? formatDuration(locale, item.estimateMinutes, durationStyle) : "—"}
        </dd>
      </dl>

      <div className="px-4 pb-4">
        {error ? (
          <Callout tone="danger" role="alert" className="mb-4">
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="min-w-0 flex-1">{error}</span>
              <Button asChild variant="ghost" size="icon-sm">
                <Link href={returnTo} aria-label={tCommon("close")}>
                  <XIcon />
                </Link>
              </Button>
            </span>
          </Callout>
        ) : null}
        <SectionCard title={t("attachments.title")}>
          {!caps.viewDocuments ? (
            <EmptyState variant="forbidden" icon={PaperclipIcon} title={t("attachments.noAccess")} />
          ) : (
            <div className="flex flex-col gap-4">
              {documents.length === 0 ? (
                <EmptyState
                  variant="empty"
                  icon={PaperclipIcon}
                  title={t("attachments.empty")}
                  body={internal ? t("attachments.emptyDescription") : t("attachments.emptyDescriptionVisible")}
                  action={
                    caps.uploadDocuments ? (
                      <Button asChild size="sm">
                        <Link href="#upload-file">{tFiles("upload.title")}</Link>
                      </Button>
                    ) : null
                  }
                />
              ) : (
                <DocumentsTable
                  documents={documents}
                  returnTo={returnTo}
                  canDelete={caps.deleteDocuments}
                  canChangeVisibility={caps.changeDocumentVisibility}
                />
              )}
              {caps.uploadDocuments ? (
                <UploadForm
                  // Re-mount when the item's visibility changes under the
                  // open peek (the 12 s poll): the safety-critical select
                  // must never contradict its own hint (standing trap).
                  key={`${item.id}:${item.visibility}`}
                  target={{ attachedToType: "WORK_ITEM", attachedToId: item.id, returnTo }}
                  visibilityEnabled={!internal}
                  defaultVisibility={item.visibility}
                  visibilityHint={internal ? t("attachments.followsItem", { key: itemKey }) : undefined}
                />
              ) : null}
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
