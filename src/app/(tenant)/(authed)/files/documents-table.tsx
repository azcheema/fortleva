import { DownloadIcon, FileIcon } from "lucide-react";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";

import { DataTable, RowActions, VisibilityBadge, visibilityRowCue } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { DocumentListItem } from "@/documents/service";
import { bytesParts } from "@/lib/format";

import { deleteDocumentAction, downloadAction } from "./actions";
import { VisibilitySelect } from "./visibility-select";

/**
 * The one documents table (server component) shared by /files and the
 * client/project Files tabs.
 *
 * Visibility is SAFETY-CRITICAL here, so it is said three times over:
 * every row renders a chip (never absence) — the editable rows now
 * render the SAME chip, because `<VisibilitySelect>` is read-first —, a
 * client-visible row additionally carries the 2px warm left border from
 * visibilityRowCue(), and the table closes with a legend naming both
 * states in words. The row also emits data-visibility for E2E.
 *
 * The row's actions are one quiet ghost download icon plus a `⋯` menu.
 * Deleting a stored file used to be a solid red button that acted on
 * the first click; it is now a danger menu item that asks the question
 * in the row before anything is destroyed.
 *
 * Sizes are split into value and unit so the digits right-align on
 * their own rail while "kB"/"MB" stays quiet beside them.
 */
export async function DocumentsTable({
  documents,
  returnTo,
  canDelete,
  canChangeVisibility,
}: {
  documents: DocumentListItem[];
  returnTo: string;
  canDelete: boolean;
  canChangeVisibility: boolean;
}) {
  const t = await getTranslations("files");
  const tCommon = await getTranslations("common");
  const format = await getFormatter();
  const locale = await getLocale();

  return (
    <div className="flex flex-col gap-2">
      <DataTable scrollLabel={t("tableLabel")}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.name")}</TableHead>
              <TableHead>{t("columns.visibility")}</TableHead>
              <TableHead priority="medium" className="text-right">
                {t("columns.size")}
              </TableHead>
              <TableHead priority="low" className="text-right">
                {t("columns.versions")}
              </TableHead>
              <TableHead priority="low">{t("columns.updated")}</TableHead>
              <TableHead className="w-0 text-right">
                <span className="sr-only">{tCommon("actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {documents.map((d) => {
              const size = bytesParts(locale, d.sizeBytes);
              const download = t("downloadName", { name: d.name });
              return (
                <TableRow
                  key={d.id}
                  data-visibility={d.visibility}
                  className={visibilityRowCue(d.visibility)}
                >
                  {/* The cap is per-viewport, not absolute: at 390px an
                      untruncated filename pushed the download and the ⋯
                      clean off the screen, which is the one thing a row
                      of files exists to offer. */}
                  <TableCell className="max-w-28 sm:max-w-64">
                    <span className="flex min-w-0 items-center gap-2">
                      <FileIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate font-medium" title={d.name}>
                        {d.name}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell>
                    {canChangeVisibility && d.clientId ? (
                      <VisibilitySelect
                        documentId={d.id}
                        value={d.visibility}
                        returnTo={returnTo}
                      />
                    ) : (
                      <VisibilityBadge value={d.visibility} />
                    )}
                  </TableCell>
                  <TableCell priority="medium" className="num text-right whitespace-nowrap">
                    {size.value}
                    <span className="ml-1 text-muted-foreground">{size.unit}</span>
                  </TableCell>
                  <TableCell priority="low" className="num text-right">
                    {d.versionCount}
                  </TableCell>
                  <TableCell priority="low" className="num text-muted-foreground">
                    {format.dateTime(d.updatedAt, { dateStyle: "medium" })}
                  </TableCell>
                  <TableCell>
                    {/* A real form, so the presigned redirect still happens
                        on the server. */}
                    {canDelete ? (
                      <RowActions
                        label={tCommon("actionsFor", { name: d.name })}
                        primary={<DownloadButton id={d.id} returnTo={returnTo} label={download} />}
                        items={[
                          {
                            key: "delete",
                            label: t("delete"),
                            // No `icon`: this is a SERVER component, and a
                            // lucide icon is a plain function there — passing
                            // one across the RSC boundary to <RowActions>
                            // would fail to serialise at render time.
                            tone: "danger",
                            confirm: t("deleteConfirm", { name: d.name }),
                            formAction: deleteDocumentAction,
                            hidden: [
                              { name: "documentId", value: d.id },
                              { name: "returnTo", value: returnTo },
                            ],
                          },
                        ]}
                      />
                    ) : (
                      // No menu rather than an always-disabled one: a
                      // control that can never act is noise in every row.
                      <div
                        data-slot="row-actions"
                        className="flex items-center justify-end gap-1"
                      >
                        <DownloadButton id={d.id} returnTo={returnTo} label={download} />
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </DataTable>
      {/* The legend is part of the safety system, not decoration: it names
          both states in words, next to the exact chips the rows wear. It
          sits OUTSIDE the table's hairline — inside it, at cell padding,
          it read as a malformed third row. */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <VisibilityBadge value="INTERNAL" size="sm" />
          {t("legend.internal")}
        </span>
        <span className="inline-flex items-center gap-2">
          <VisibilityBadge value="CLIENT_VISIBLE" size="sm" />
          {t("legend.clientVisible")}
        </span>
      </div>
    </div>
  );
}

/** The row's one everyday verb: a 28px ghost icon whose tooltip is its label. */
function DownloadButton({ id, returnTo, label }: { id: string; returnTo: string; label: string }) {
  return (
    <form action={downloadAction}>
      <input type="hidden" name="documentId" value={id} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="submit" variant="ghost" size="icon-sm" aria-label={label}>
            <DownloadIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </form>
  );
}
