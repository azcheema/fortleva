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
import { formatBytes } from "@/lib/format";

import { changeVisibilityAction, deleteDocumentAction, downloadAction } from "./actions";
import { VisibilitySelect } from "./visibility-select";

/**
 * The one documents table (server component) shared by /files and the
 * client/project Files tabs. Visibility is SAFETY-CRITICAL here: every
 * row renders a chip (never absence), and a client-visible row
 * additionally carries the 2px warm left border from
 * visibilityRowCue() — so the "a client can read this" signal survives
 * both colour-blindness and a glance down the leftmost edge of the
 * table, without reading a single chip.
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
          {documents.map((d) => (
            <TableRow key={d.id} className={visibilityRowCue(d.visibility)}>
              <TableCell className="max-w-64 truncate font-medium">{d.name}</TableCell>
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
              <TableCell className="num text-right">{formatBytes(locale, d.sizeBytes)}</TableCell>
              <TableCell className="num text-right">
                {tCommon("versions", { count: d.versionCount })}
              </TableCell>
              <TableCell className="num text-muted-foreground">
                {format.dateTime(d.updatedAt, { dateStyle: "medium" })}
              </TableCell>
              <TableCell>
                <div className="flex items-center justify-end gap-1">
                  <form action={downloadAction}>
                    <input type="hidden" name="documentId" value={d.id} />
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <Button type="submit" variant="ghost" size="sm">
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
          ))}
        </TableBody>
      </Table>
    </DataTable>
  );
}
