import { getFormatter, getTranslations } from "next-intl/server";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { VisibilityBadge } from "@/components/visibility-badge";
import type { DocumentListItem } from "@/documents/service";

import { changeVisibilityAction, deleteDocumentAction, downloadAction } from "./actions";
import { VisibilitySelect } from "./visibility-select";

/** Byte sizes: binary units, one decimal (locale-formatted number). */
const bytesParts = (n: number): { value: number; unit: "B" | "KB" | "MB" | "GB" } => {
  if (n < 1024) return { value: n, unit: "B" };
  if (n < 1024 * 1024) return { value: n / 1024, unit: "KB" };
  if (n < 1024 * 1024 * 1024) return { value: n / (1024 * 1024), unit: "MB" };
  return { value: n / (1024 * 1024 * 1024), unit: "GB" };
};

/**
 * The one documents table (server component) shared by /files and the
 * client/project Files tabs. Visibility is a two-token badge, and — for
 * document:change_visibility holders on client-attached rows — a select
 * that commits on change (no Save button).
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
  const formatBytes = (n: number): string => {
    const { value, unit } = bytesParts(n);
    return `${format.number(value, { maximumFractionDigits: unit === "B" ? 0 : 1 })} ${unit}`;
  };

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("columns.name")}</TableHead>
            <TableHead>{t("columns.visibility")}</TableHead>
            <TableHead className="text-right">{t("columns.size")}</TableHead>
            <TableHead className="text-right">{t("columns.versions")}</TableHead>
            <TableHead>{t("columns.updated")}</TableHead>
            <TableHead className="w-0" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {documents.map((d) => (
            <TableRow key={d.id}>
              <TableCell className="max-w-64 truncate font-medium">{d.name}</TableCell>
              <TableCell>
                {canChangeVisibility && d.clientId ? (
                  <form action={changeVisibilityAction} className="inline-flex items-center gap-2">
                    <input type="hidden" name="documentId" value={d.id} />
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <VisibilitySelect value={d.visibility} />
                  </form>
                ) : (
                  <VisibilityBadge visibility={d.visibility} />
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatBytes(d.sizeBytes)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {tCommon("versions", { count: d.versionCount })}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {format.dateTime(d.updatedAt, { dateStyle: "medium" })}
              </TableCell>
              <TableCell>
                <div className="flex items-center justify-end gap-1">
                  <form action={downloadAction}>
                    <input type="hidden" name="documentId" value={d.id} />
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <Button type="submit" variant="ghost" size="xs">
                      {t("download")}
                    </Button>
                  </form>
                  {canDelete ? (
                    <form action={deleteDocumentAction}>
                      <input type="hidden" name="documentId" value={d.id} />
                      <input type="hidden" name="returnTo" value={returnTo} />
                      <Button type="submit" variant="destructive" size="xs">
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
    </div>
  );
}
