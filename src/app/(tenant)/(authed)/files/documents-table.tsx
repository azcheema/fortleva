import { DownloadIcon, FileIcon } from "lucide-react";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";

import { DataTable, VisibilityBadge, visibilityRowCue } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { DocumentListItem } from "@/documents/service";
import { bytesParts } from "@/lib/format";

import { changeVisibilityAction, deleteDocumentAction, downloadAction } from "./actions";
import { VisibilitySelect } from "./visibility-select";

/**
 * The one documents table (server component) shared by /files and the
 * client/project Files tabs.
 *
 * Visibility is SAFETY-CRITICAL here, so it is said three times over:
 * every row renders a chip (never absence), a client-visible row
 * additionally carries the 2px warm left border from
 * visibilityRowCue() — so "a client can read this" survives both
 * colour-blindness and a glance down the leftmost edge without reading
 * a single chip — and the table closes with a legend naming both
 * states in words. The row also emits data-visibility for E2E.
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
    <DataTable>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("columns.name")}</TableHead>
            <TableHead>{t("columns.visibility")}</TableHead>
            <TableHead className="text-right">{t("columns.size")}</TableHead>
            <TableHead className="text-right">{t("columns.versions")}</TableHead>
            <TableHead>{t("columns.updated")}</TableHead>
            <TableHead className="w-0">
              <span className="sr-only">{tCommon("actions")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {documents.map((d) => {
            const size = bytesParts(locale, d.sizeBytes);
            return (
              <TableRow
                key={d.id}
                data-visibility={d.visibility}
                className={visibilityRowCue(d.visibility)}
              >
                <TableCell className="max-w-64">
                  <span className="flex min-w-0 items-center gap-2">
                    <FileIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium" title={d.name}>
                      {d.name}
                    </span>
                  </span>
                </TableCell>
                <TableCell>
                  {canChangeVisibility && d.clientId ? (
                    <form action={changeVisibilityAction} className="inline-flex items-center gap-2">
                      <input type="hidden" name="documentId" value={d.id} />
                      <input type="hidden" name="returnTo" value={returnTo} />
                      <VisibilitySelect value={d.visibility} />
                    </form>
                  ) : (
                    <VisibilityBadge value={d.visibility} />
                  )}
                </TableCell>
                <TableCell className="num text-right whitespace-nowrap">
                  {size.value}
                  <span className="ml-1 text-muted-foreground">{size.unit}</span>
                </TableCell>
                <TableCell className="num text-right">{d.versionCount}</TableCell>
                <TableCell className="num text-muted-foreground">
                  {format.dateTime(d.updatedAt, { dateStyle: "medium" })}
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    <form action={downloadAction}>
                      <input type="hidden" name="documentId" value={d.id} />
                      <input type="hidden" name="returnTo" value={returnTo} />
                      <Button type="submit" variant="outline" size="sm">
                        <DownloadIcon />
                        {t("download")}
                      </Button>
                    </form>
                    {canDelete ? (
                      <form action={deleteDocumentAction}>
                        <input type="hidden" name="documentId" value={d.id} />
                        <input type="hidden" name="returnTo" value={returnTo} />
                        <Button type="submit" variant="destructive" size="sm">
                          {t("delete")}
                        </Button>
                      </form>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {/* The legend is part of the safety system, not decoration: it names
          both states in words, next to the exact chips the rows wear. */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <VisibilityBadge value="INTERNAL" size="sm" />
          {t("legend.internal")}
        </span>
        <span className="inline-flex items-center gap-2">
          <VisibilityBadge value="CLIENT_VISIBLE" size="sm" />
          {t("legend.clientVisible")}
        </span>
      </div>
    </DataTable>
  );
}
