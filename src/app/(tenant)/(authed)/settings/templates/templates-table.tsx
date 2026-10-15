"use client";

import { FolderKanbanIcon, LayoutTemplateIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";

import { AutoForm } from "@/components/auto-form";
import { DataTable, EmptyState, InlineEdit, RowActions, type RowAction } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useRun } from "@/components/use-run";
import { MAX_TEMPLATE_NAME_LENGTH } from "@/lib/template-rules";

import { deleteTemplateAction, renameTemplateAction } from "./actions";

/**
 * The workspace's project templates (slice 124, C100 (b)): the name is a
 * record property, an <InlineEdit> in its own <AutoForm> (MANDATE 1);
 * Delete lives in the row menu, danger-toned, and asks. The counts and the
 * date are read-only — a template changes by saving a project again.
 */

export type TemplateRowView = {
  id: string;
  name: string;
  tasks: number;
  milestones: number;
  savedAt: string;
  source: { key: string; name: string } | null;
};

export function TemplatesTable({ rows }: { rows: TemplateRowView[] }) {
  const t = useTranslations("settings.templates");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const { run } = useRun();

  if (rows.length === 0) {
    return (
      <div className="px-4">
        <EmptyState
          variant="empty"
          icon={LayoutTemplateIcon}
          title={t("empty")}
          body={t("emptyBody")}
          action={
            <Button asChild size="sm" variant="outline">
              <Link href="/projects">
                <FolderKanbanIcon />
                {t("emptyAction")}
              </Link>
            </Button>
          }
        />
      </div>
    );
  }

  const actionsFor = (row: TemplateRowView): RowAction[] => [
    {
      key: "delete",
      label: t("menu.delete"),
      icon: Trash2Icon,
      tone: "danger",
      confirm: t("deleteConfirm", { name: row.name }),
      onSelect: () => run(() => deleteTemplateAction({ id: row.id })),
    },
  ];

  return (
    <DataTable flush scrollLabel={t("title")}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("columns.name")}</TableHead>
            <TableHead priority="medium" className="w-[10ch] text-right">
              {t("columns.tasks")}
            </TableHead>
            <TableHead priority="low" className="w-[12ch] text-right">
              {t("columns.milestones")}
            </TableHead>
            <TableHead priority="low" className="w-[22ch]">
              {t("columns.saved")}
            </TableHead>
            <TableHead pinned className="text-right">
              <span className="sr-only">{tCommon("actions")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const date = format.dateTime(new Date(row.savedAt), { dateStyle: "medium" });
            return (
              <TableRow key={row.id} data-testid="template-row">
                <TableCell className="font-medium">
                  <AutoForm action={renameTemplateAction}>
                    <input type="hidden" name="id" value={row.id} />
                    <InlineEdit
                      kind="text"
                      name="name"
                      value={row.name}
                      label={t("columns.name")}
                      placeholder={t("columns.name")}
                      density="table"
                      inputProps={{ required: true, maxLength: MAX_TEMPLATE_NAME_LENGTH }}
                    />
                  </AutoForm>
                </TableCell>
                <TableCell priority="medium" className="text-right tabular-nums text-muted-foreground">
                  {row.tasks}
                </TableCell>
                <TableCell priority="low" className="text-right tabular-nums text-muted-foreground">
                  {row.milestones}
                </TableCell>
                <TableCell priority="low" className="truncate text-muted-foreground">
                  {row.source
                    ? t.rich("savedFrom", {
                        date,
                        key: row.source.key,
                        // The key in the mono face every list wears, linked
                        // to the project it was last saved from.
                        link: (chunks) => (
                          <Link
                            href={`/projects/${row.source!.key}`}
                            className="num-id rounded-sm font-mono underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                            title={row.source!.name}
                          >
                            {chunks}
                          </Link>
                        ),
                      })
                    : date}
                </TableCell>
                <TableCell pinned className="text-right">
                  <RowActions label={tCommon("actionsFor", { name: row.name })} items={actionsFor(row)} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </DataTable>
  );
}
