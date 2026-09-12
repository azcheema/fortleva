import { MaximizeIcon, PaperclipIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { Callout, EmptyState, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { VisibilityBadge } from "@/components/visibility-badge";
import type { DocumentListItem } from "@/documents/service";
import { formatDate, formatDuration, type DurationStyle } from "@/lib/format";
import type { ResolvedItemDetail } from "@/modules/work";

import { DocumentsTable } from "../../../files/documents-table";
import { UploadForm } from "../../../files/upload-form";

/**
 * ONE item panel, rendered in two places (UI.md §5.4): the side-peek
 * (`?item=KEY-123`, a sheet) and the full page (`/projects/KEY/items/12`).
 * Everything below the header is identical by construction — a second
 * copy is how the two drift apart.
 *
 * This slice is still read-first: header, the property rail, attachments.
 * The description editor, subtasks, comments, the Activity tab and the
 * single keys grow onto this shell in the slices after it.
 */

export type ItemPanelCaps = {
  viewDocuments: boolean;
  uploadDocuments: boolean;
  deleteDocuments: boolean;
  changeDocumentVisibility: boolean;
};

export async function ItemPanel({
  item,
  itemKey,
  projectKey,
  documents,
  caps,
  returnTo,
  durationStyle,
  error,
  variant,
  fullPageHref,
}: {
  item: ResolvedItemDetail;
  /** "ACME-12" — the human key the header shows. */
  itemKey: string;
  projectKey: string;
  documents: DocumentListItem[];
  caps: ItemPanelCaps;
  /** This panel's own URL — actions revalidate/bounce back into it. */
  returnTo: string;
  durationStyle: DurationStyle;
  /** A failed download/delete bounces back as `?error=` (the Files-tab
   * contract) — the panel must show it, or a failure looks like nothing
   * happened (the standing rule). */
  error?: string;
  /** The sheet owns the dialog title; the page owns the document's h1. */
  variant: "peek" | "page";
  /** Peek only: the link out to the full page. */
  fullPageHref?: string;
}) {
  const t = await getTranslations("projects.item");
  const tBacklog = await getTranslations("projects.backlog");
  const tStates = await getTranslations("states");
  const tFiles = await getTranslations("files");
  const tCommon = await getTranslations("common");
  const locale = await getLocale();
  const internal = item.visibility === "INTERNAL";
  // @db.Date columns are UTC midnight: format in UTC or the day shifts
  // west of UTC (the backlog's review finding).
  const day = (value: Date) =>
    formatDate(locale, value, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

  // `parentKey` is built here because a template literal as a JSX CHILD
  // is what react/jsx-no-literals reports (props are exempt); the href
  // is hoisted only to keep the pair together.
  const parentKey = item.parent ? `${projectKey}-${item.parent.number}` : null;
  const parentHref = item.parent ? `/projects/${projectKey}/items/${item.parent.number}` : null;

  // h2, not h1: the project shell above already owns the page's single
  // h1 (its header), and the craft audit fails any stop with two — this
  // panel is a tab-level surface, exactly like the board and the backlog.
  const title =
    variant === "peek" ? (
      <SheetTitle>{item.title}</SheetTitle>
    ) : (
      <h2 className="text-lg font-semibold tracking-tight">{item.title}</h2>
    );

  const header = (
    <>
      <span className="num-id text-xs text-muted-foreground">{itemKey}</span>
      {title}
      {variant === "peek" ? <SheetDescription className="sr-only">{t("description")}</SheetDescription> : null}
      <div className="flex flex-wrap items-center gap-2">
        <VisibilityBadge visibility={item.visibility} />
        {item.archivedAt ? <span className="text-xs text-muted-foreground">{tCommon("archived")}</span> : null}
        {variant === "peek" && fullPageHref ? (
          <Button asChild variant="ghost" size="sm" className="ms-auto">
            <Link href={fullPageHref} data-testid="item-full-page">
              <MaximizeIcon />
              {t("openFullPage")}
            </Link>
          </Button>
        ) : null}
      </div>
    </>
  );

  // Read-first property list (UI.md §10.15 pattern 7) — read-only in
  // this slice; editing arrives with the PropertyPicker.
  const rail = (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm" data-testid="item-properties">
        <dt className="text-muted-foreground">{t("properties.state")}</dt>
        <dd>{item.stateName}</dd>
        <dt className="text-muted-foreground">{t("properties.assignee")}</dt>
        <dd>{item.assigneeName ?? tBacklog("unassigned")}</dd>
        <dt className="text-muted-foreground">{t("properties.type")}</dt>
        <dd>
          {tStates(`workItemType.${item.type}`)}
          {item.kind !== "TASK" ? ` · ${tStates(`workItemKind.${item.kind}`)}` : ""}
        </dd>
        <dt className="text-muted-foreground">{t("properties.priority")}</dt>
        <dd>{tStates(`priority.${item.priority}`)}</dd>
        <dt className="text-muted-foreground">{t("properties.estimate")}</dt>
        <dd className="num">
          {item.estimateMinutes != null ? formatDuration(locale, item.estimateMinutes, durationStyle) : "—"}
        </dd>
        <dt className="text-muted-foreground">{t("properties.startDate")}</dt>
        <dd className="num">{item.startDate ? day(item.startDate) : "—"}</dd>
        <dt className="text-muted-foreground">{t("properties.dueDate")}</dt>
        <dd className="num">{item.targetDate ? day(item.targetDate) : "—"}</dd>
        {item.parent && parentHref ? (
          <>
            <dt className="text-muted-foreground">{t("properties.parent")}</dt>
            <dd>
              <Link href={parentHref} className="underline-offset-4 hover:underline" data-testid="item-parent-link">
                <span className="num-id">{parentKey}</span> <span>{item.parent.title}</span>
              </Link>
            </dd>
          </>
        ) : null}
        {item.milestone ? (
          <>
            <dt className="text-muted-foreground">{t("properties.milestone")}</dt>
            <dd>{item.milestone.name}</dd>
          </>
        ) : null}
        {item.checklistTotal > 0 ? (
          <>
            <dt className="text-muted-foreground">{t("properties.checklist")}</dt>
            <dd className="num">{t("properties.checklistValue", { done: item.checklistDone, total: item.checklistTotal })}</dd>
          </>
        ) : null}
    </dl>
  );

  return (
    <div className="flex flex-col">
      {/* The sheet owns its own header slot; on the page the identity and
          the rail sit in a card, as every other tab-level surface does. */}
      {variant === "peek" ? (
        <>
          <SheetHeader>{header}</SheetHeader>
          <div className="px-4 pb-4">{rail}</div>
        </>
      ) : (
        <div className="pb-4">
          <SectionCard>
            <div className="flex flex-col gap-2 pb-4">{header}</div>
            {rail}
          </SectionCard>
        </div>
      )}

      <div className={variant === "peek" ? "px-4 pb-4" : ""}>
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
                  // open panel (the 12 s poll): the safety-critical select
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
