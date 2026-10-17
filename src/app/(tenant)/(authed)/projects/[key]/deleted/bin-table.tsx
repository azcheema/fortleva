"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { DataTable, RowActions, SectionCard } from "@/components/semantic";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isActionRedirect } from "@/lib/action-redirect";
import type { BinBlock } from "@/modules/work";

import { restoreDeletedItemAction } from "../backlog/actions";
import { PRIVATE_SENTENCE_MS } from "../backlog/deleted-toast";

/**
 * THE PROJECT'S BIN (slice 126, founder decision C102; design §3.6) — the
 * tasks deleted in the last 30 days, newest first, each with its one verb.
 * Bring back is one click from the menu, without a question: it is the safe
 * direction (the task comes back hidden from the client), as the import's
 * Bring back is. A row whose Bring back the service would refuse draws it
 * DISABLED with the reason — never a press whose only answer is an error.
 *
 * THE TABLE FOLLOWS UI.md §10.12: the actions column PINNED, "Deleted" and
 * "By" dropped first as the box narrows, and the title in the contained
 * wrapper (`contain-inline-size`), so a long title never widens the table
 * past a phone's box — a `max-w` on a cell acts as a MINIMUM in Chromium
 * (visual.spec.ts). The code review's MEDIUM: the first cut had none of it.
 */

export type BinRow = {
  id: string;
  number: number;
  title: string;
  /** Formatted on the server, in the viewer's zone. */
  deletedAt: string;
  deletedBy: string | null;
  blocked: BinBlock | null;
};

export function BinTable({
  projectKey,
  rows,
  more,
}: {
  projectKey: string;
  rows: readonly BinRow[];
  /** More tasks are in the bin than the page shows: the count shown. */
  more: number | null;
}) {
  const t = useTranslations("projects.bin");
  const router = useRouter();

  const bringBack = async (id: string) => {
    try {
      const r = await restoreDeletedItemAction(id, projectKey, "bin");
      if (!r.ok) toast.error(r.message);
      else if (!r.value.changed) toast.success(r.value.message);
      else {
        const href = `/projects/${projectKey}/items/${r.value.number}`;
        toast.success(r.value.message, {
          action: { label: t("open"), onClick: () => router.push(href) },
          ...(r.value.madePrivate ? { duration: PRIVATE_SENTENCE_MS } : {}),
        });
      }
      router.refresh();
    } catch (err) {
      if (isActionRedirect(err)) return;
      toast.error(t("failed"));
    }
  };

  const reasonOf = (b: BinBlock): string =>
    b.reason === "archived"
      ? t("blocked.archived")
      : b.reason === "parent_in_bin"
        ? t("blocked.parentInBin", { parent: `${projectKey}-${b.parentNumber}` })
        : b.reason === "parent_from_import"
          ? t("blocked.parentFromImport")
          : b.reason === "source_twin"
            ? t("blocked.sourceTwin")
            : t("blocked.parentGone");

  return (
    // No title of its own: the page's heading already says "Deleted tasks".
    <SectionCard description={t("description")} contentClassName="p-0">
      <DataTable flush scrollLabel={t("title")}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.task")}</TableHead>
              {/* Fixed widths, so the spare width goes to the title rather
                  than being shared out by max-content (UI.md §10.12). */}
              <TableHead priority="medium" className="w-[20ch]">
                {t("columns.deleted")}
              </TableHead>
              <TableHead priority="low" className="w-[22ch]">
                {t("columns.by")}
              </TableHead>
              <TableHead pinned className="text-right">
                <span className="sr-only">{t("restore")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const key = `${projectKey}-${r.number}`;
              return (
                <TableRow key={r.id} data-testid="bin-row" data-key={key}>
                  <TableCell className="min-w-56">
                    <span className="flex w-full min-w-0 items-baseline gap-2 contain-inline-size">
                      <span className="num shrink-0 text-muted-foreground">{key}</span>
                      <span className="min-w-0 truncate" title={r.title}>
                        {r.title}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell priority="medium" className="num whitespace-nowrap">
                    {r.deletedAt}
                  </TableCell>
                  <TableCell priority="low" className="whitespace-nowrap text-muted-foreground">
                    {r.deletedBy ?? t("formerMember")}
                  </TableCell>
                  <TableCell pinned className="text-right">
                    <RowActions
                      label={t("actionsFor", { task: key })}
                      items={[
                        r.blocked
                          ? { key: "restore", label: t("restore"), disabled: true, disabledReason: reasonOf(r.blocked) }
                          : { key: "restore", label: t("restore"), onSelect: () => void bringBack(r.id) },
                      ]}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </DataTable>
      {more !== null ? <p className="px-4 py-3 text-xs text-muted-foreground">{t("more", { count: more })}</p> : null}
    </SectionCard>
  );
}
