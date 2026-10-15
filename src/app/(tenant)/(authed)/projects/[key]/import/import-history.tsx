"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { DataTable, RowActions, SectionCard, StatusBadge, type RowAction } from "@/components/semantic";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isActionRedirect } from "@/lib/action-redirect";

import { restoreImportAction, undoImportAction } from "./actions";

/**
 * EARLIER IMPORTS (Phase 6 slice 121; design §5, §6) — who imported which
 * file when, what it made, and the two verbs: Undo (7 days; a danger item
 * that asks, because it moves tasks to the bin) and Bring back (30 days
 * after an undo; one click — it only returns what the undo took). Each verb
 * is offered only when the server said THIS viewer may press it now.
 */

export type ImportHistoryRow = {
  id: string;
  source: "CSV" | "TRELLO";
  fileName: string;
  /** Formatted on the server, in the viewer's zone. */
  startedAt: string;
  startedBy: string | null;
  status: "RUNNING" | "STOPPED" | "DONE" | "UNDONE";
  created: number;
  updated: number;
  /** Tasks the undo moved to the bin (still there, unless brought back). */
  undone: number | null;
  restored: boolean;
  canUndo: boolean;
  canRestore: boolean;
};

export function ImportHistory({ projectKey, rows }: { projectKey: string; rows: readonly ImportHistoryRow[] }) {
  const t = useTranslations("projects.import");
  const router = useRouter();

  const act = async (fn: () => Promise<{ ok: true; message: string } | { ok: false; message: string }>) => {
    try {
      const r = await fn();
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      router.refresh();
    } catch (err) {
      if (isActionRedirect(err)) return;
      toast.error(t("result.failed"));
    }
  };

  const undo = (id: string) =>
    act(async () => {
      const r = await undoImportAction(projectKey, id);
      if (!r.ok) return r;
      const said = t("history.undone", { removed: r.value.removed });
      return { ok: true, message: r.value.kept > 0 ? `${said} ${t("history.undoneKept", { kept: r.value.kept })}` : said };
    });
  const restore = (id: string) =>
    act(async () => {
      const r = await restoreImportAction(projectKey, id);
      if (!r.ok) return r;
      const said = t("history.restored", { restored: r.value.restored });
      return {
        ok: true,
        message: r.value.skipped > 0 ? `${said} ${t("history.restoredSkipped", { skipped: r.value.skipped })}` : said,
      };
    });

  return (
    <SectionCard title={t("history.title")} description={t("history.description")} contentClassName="p-0">
      <DataTable flush>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("history.columns.when")}</TableHead>
              <TableHead>{t("history.columns.file")}</TableHead>
              <TableHead>{t("history.columns.by")}</TableHead>
              <TableHead>{t("history.columns.tasks")}</TableHead>
              <TableHead>{t("history.columns.status")}</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">{t("history.columns.status")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const items: RowAction[] = [];
              if (r.canUndo) {
                items.push({ key: "undo", label: t("history.undo"), tone: "danger", confirm: t("history.undoConfirm"), onSelect: () => void undo(r.id) });
              }
              if (r.canRestore) items.push({ key: "restore", label: t("history.restore"), onSelect: () => void restore(r.id) });
              return (
                <TableRow key={r.id} data-testid="import-history-row" data-status={r.status}>
                  <TableCell className="num whitespace-nowrap">{r.startedAt}</TableCell>
                  <TableCell className="max-w-[28ch] truncate">
                    <span className="text-muted-foreground">{t(`source.${r.source}`)}</span>
                    {" · "}
                    {r.fileName}
                  </TableCell>
                  <TableCell className="max-w-[20ch] truncate">{r.startedBy ?? t("history.formerMember")}</TableCell>
                  <TableCell className="num whitespace-nowrap">
                    {t("history.tasks", { created: r.created, updated: r.updated })}
                    {r.status === "UNDONE" && r.undone !== null ? (
                      <span className="text-muted-foreground">
                        {" · "}
                        {t("history.inBin", { count: r.undone })}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <StatusBadge domain="importStatus" value={r.status} />
                  </TableCell>
                  <TableCell className="text-right">
                    {items.length > 0 ? <RowActions label={t("history.actionsFor", { file: r.fileName })} items={items} /> : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </DataTable>
    </SectionCard>
  );
}
