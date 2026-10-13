"use client";

import { DownloadIcon, EyeOffIcon, FileChartColumnIcon, PencilIcon, SendIcon, Trash2Icon } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { startTransition, useActionState, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { DataTable, Field, FormMessage, RowActions, VisibilityBadge, visibilityRowCue, type RowAction } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { HIDE_FROM, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useFocusReturn } from "@/components/ui/use-focus-return";
import { useRun } from "@/components/use-run";
import { afterClosingLayers } from "@/lib/after-closing-layers";
import { bytesParts } from "@/lib/format";
import type { FormResult } from "@/lib/server-actions";
import { cn } from "@/lib/utils";

import { downloadAction } from "../../../files/actions";
import { deleteReportAction, editReportAction, hideReportAction, publishReportAction } from "./actions";
import { MonthPicker } from "./month-picker";

/** One report as the tab draws it — `ClientReport` with its dates serialised by React. */
export type ReportRowData = {
  readonly id: string;
  readonly name: string;
  /** `YYYY-MM-01`. */
  readonly month: string;
  readonly visibility: "INTERNAL" | "CLIENT_VISIBLE";
  readonly publishedAt: Date | null;
  readonly sizeBytes: number;
  readonly contentType: string;
};

export type ReportAbilities = {
  readonly publish: boolean;
  /** Hide is always offered to who may publish; publishing an ARCHIVED client's report is not. */
  readonly clientActive: boolean;
  readonly edit: boolean;
  readonly delete: boolean;
};

/**
 * THE CLIENT'S REPORTS (Phase 6 slice 115; C91) — newest month first, each row
 * its month, its name and file, and WHO CAN SEE IT: the visibility chip every
 * file wears (never absence — UI.md §10.4), the warm row cue on a published
 * one, and the date it was published. The everyday verb is the download icon;
 * the rest live in the row menu: Publish… (a dialog that says who will see it
 * and that they get an email), Hide from client (one click: it takes access
 * away), Edit (name and month), Delete (danger, with its question).
 *
 * The dialogs stay mounted whatever the row's state, so the revalidation that
 * flips the row cannot unmount one before its success is said (slice 70's
 * lesson, the vault row's shape).
 */
export function ReportTable({
  clientId,
  clientName,
  rows,
  can,
  latestMonth,
}: {
  clientId: string;
  clientName: string;
  rows: readonly ReportRowData[];
  can: ReportAbilities;
  /** `YYYY-MM` — the newest month a report may cover. */
  latestMonth: string;
}) {
  const t = useTranslations("clients.reports");
  return (
    <div className="flex flex-col gap-2">
    <DataTable scrollLabel={t("tableLabel")}>
      <Table>
        <TableHeader>
          <TableRow>
            {/* ONE LINE PER ROW, at the row height every table keeps (the
                walk's row-pitch audit), and the Files table's widths: on a
                phone only the report (with its short month in front), who can
                see it and the verbs — the badge is safety-critical and never
                the column that yields. The month, the date it was published
                and the size join as the table widens. */}
            <TableHead priority="medium" className="w-[16ch]">
              {t("columns.month")}
            </TableHead>
            <TableHead>{t("columns.report")}</TableHead>
            <TableHead className="w-[18ch]">{t("columns.status")}</TableHead>
            <TableHead priority="low" className="w-[14ch]">
              {t("columns.published")}
            </TableHead>
            <TableHead priority="low" className="w-[10ch] text-right">
              {t("columns.size")}
            </TableHead>
            <TableHead pinned className="w-0 text-right">
              <span className="sr-only">{t("columns.actions")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <ReportRow key={r.id} clientId={clientId} clientName={clientName} row={r} can={can} latestMonth={latestMonth} />
          ))}
        </TableBody>
      </Table>
    </DataTable>
      {/* The legend is part of the safety system (the Files table's): both
          states in words, beside the exact chips the rows wear. */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 pb-3 text-xs text-muted-foreground">
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

function ReportRow({
  clientId,
  clientName,
  row,
  can,
  latestMonth,
}: {
  clientId: string;
  clientName: string;
  row: ReportRowData;
  can: ReportAbilities;
  latestMonth: string;
}) {
  const t = useTranslations("clients.reports");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const locale = useLocale();
  const { run } = useRun();
  const [publishOpen, setPublishOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const monthDate = new Date(`${row.month}T00:00:00.000Z`);
  const monthLabel = format.dateTime(monthDate, { month: "long", year: "numeric", timeZone: "UTC" });
  const shortMonth = format.dateTime(monthDate, { month: "short", year: "numeric", timeZone: "UTC" });
  const size = bytesParts(locale, row.sizeBytes);
  const published = row.visibility === "CLIENT_VISIBLE";

  const items: RowAction[] = [];
  if (can.publish && !published && can.clientActive) {
    items.push({
      key: "publish",
      label: t("menu.publish"),
      icon: SendIcon,
      onSelect: () => afterClosingLayers(() => setPublishOpen(true)),
    });
  }
  if (can.publish && published) {
    // One click: it takes access away — no confirm (a confirm on a
    // non-danger action is dead string, AGENTS.md).
    items.push({
      key: "hide",
      label: t("menu.hide"),
      icon: EyeOffIcon,
      onSelect: () => run(() => hideReportAction(clientId, row.id)),
    });
  }
  if (can.edit) {
    items.push({
      key: "edit",
      label: t("menu.edit"),
      icon: PencilIcon,
      onSelect: () => afterClosingLayers(() => setEditOpen(true)),
    });
  }
  if (can.delete) {
    items.push({
      key: "delete",
      label: t("menu.delete"),
      icon: Trash2Icon,
      tone: "danger",
      confirm: published ? t("deletePublishedConfirm", { name: row.name }) : t("deleteConfirm", { name: row.name }),
      onSelect: () => run(() => deleteReportAction(clientId, row.id)),
    });
  }
  const download = t("download", { name: row.name });
  const downloadButton = (
    <form action={downloadAction}>
      <input type="hidden" name="documentId" value={row.id} />
      <input type="hidden" name="returnTo" value={`/clients/${clientId}/reports`} />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="submit" variant="ghost" size="icon-sm" aria-label={download}>
            <DownloadIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{download}</TooltipContent>
      </Tooltip>
    </form>
  );

  return (
    <TableRow data-visibility={row.visibility} data-testid="report-row" className={visibilityRowCue(row.visibility)}>
      <TableCell priority="medium" className="font-medium whitespace-nowrap">
        {monthLabel}
      </TableCell>
      <TableCell className="min-w-20">
        <span className="flex w-full min-w-0 items-center gap-2 contain-inline-size">
          <FileChartColumnIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate" title={row.name}>
            {/* The month, short, while its own column (`medium`) is hidden. */}
            <span className={cn("font-medium", HIDE_FROM.medium)}>{t("monthPrefix", { month: shortMonth })}</span>
            {row.name}
          </span>
        </span>
      </TableCell>
      <TableCell>
        <VisibilityBadge value={row.visibility} />
      </TableCell>
      <TableCell priority="low" className="num whitespace-nowrap text-muted-foreground" data-testid="report-published">
        {published && row.publishedAt
          ? format.dateTime(row.publishedAt, { day: "numeric", month: "short", year: "numeric" })
          : null}
      </TableCell>
      <TableCell priority="low" className="num text-right whitespace-nowrap">
        {size.value}
        <span className="ml-1 text-muted-foreground">{size.unit}</span>
      </TableCell>
      <TableCell pinned>
        {items.length > 0 ? (
          <RowActions label={tCommon("actionsFor", { name: row.name })} primary={downloadButton} items={items} />
        ) : (
          // No menu rather than an always-disabled one (the Files table's rule).
          <div data-slot="row-actions" className="flex items-center justify-end gap-1">
            {downloadButton}
          </div>
        )}
        <PublishDialog
          clientId={clientId}
          clientName={clientName}
          documentId={row.id}
          monthLabel={monthLabel}
          open={publishOpen}
          onOpenChange={setPublishOpen}
        />
        {can.edit ? (
          <EditDialog clientId={clientId} row={row} latestMonth={latestMonth} open={editOpen} onOpenChange={setEditOpen} />
        ) : null}
      </TableCell>
    </TableRow>
  );
}

/**
 * PUBLISH A REPORT (C91 (b), (c)) — the question, said plainly before it
 * happens: everyone at the client with portal access will be able to open it,
 * and they get an email. Opened from the row menu after it has gone
 * (`afterClosingLayers`), returning focus through `useFocusReturn` since it
 * has no trigger of its own; no `autoFocus` inside (`keymap.test.ts`).
 */
function PublishDialog({
  clientId,
  clientName,
  documentId,
  monthLabel,
  open,
  onOpenChange,
}: {
  clientId: string;
  clientName: string;
  documentId: string;
  monthLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("clients.reports.publish");
  const tCommon = useTranslations("common");
  const focusReturn = useFocusReturn();
  const { run, pending } = useRun();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent {...focusReturn} className="sm:max-w-md" data-testid="publish-report-dialog">
        <DialogHeader>
          <DialogTitle>{t("title", { month: monthLabel })}</DialogTitle>
          <DialogDescription>{t("description", { client: clientName })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            {tCommon("cancel")}
          </Button>
          <Button
            type="button"
            disabled={pending}
            data-testid="publish-report-confirm"
            onClick={() => run(() => publishReportAction(clientId, documentId), () => onOpenChange(false))}
          >
            {pending ? t("submitting") : t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** EDIT A REPORT — its name and month; a refusal stays in the dialog, a success closes it with a toast. */
function EditDialog({
  clientId,
  row,
  latestMonth,
  open,
  onOpenChange,
}: {
  clientId: string;
  row: ReportRowData;
  latestMonth: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("clients.reports.edit");
  const focusReturn = useFocusReturn();
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent {...focusReturn} className="sm:max-w-md" data-testid="edit-report-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <EditForm clientId={clientId} row={row} latestMonth={latestMonth} onDone={close} />
      </DialogContent>
    </Dialog>
  );
}

function EditForm({
  clientId,
  row,
  latestMonth,
  onDone,
}: {
  clientId: string;
  row: ReportRowData;
  latestMonth: string;
  onDone: () => void;
}) {
  const t = useTranslations("clients.reports.edit");
  const tCommon = useTranslations("common");
  const [state, action, pending] = useActionState<FormResult | null, FormData>(editReportAction, null);
  const [month, setMonth] = useState(row.month.slice(0, 7));
  const [name, setName] = useState(row.name);

  useEffect(() => {
    if (state?.ok) {
      toast.success(state.message);
      onDone();
    }
  }, [state, onDone]);

  return (
    <form
      onSubmit={(e) => {
        // NOT a `<form action>`: React 19 resets one after EVERY action, a
        // refusal included (AGENTS.md's standing trap).
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(() => action(fd));
      }}
      className="flex flex-col gap-4"
      data-testid="edit-report-form"
    >
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="documentId" value={row.id} />
      <input type="hidden" name="month" value={month} />
      <MonthPicker id={`edit-${row.id}`} value={month} latest={latestMonth} onChange={setMonth} disabled={pending} />
      <Field label={t("name")} htmlFor={`edit-${row.id}-name`} required>
        <Input
          id={`edit-${row.id}-name`}
          name="name"
          value={name}
          maxLength={255}
          required
          onChange={(e) => setName(e.target.value)}
          disabled={pending}
        />
      </Field>
      {state && !state.ok ? <FormMessage state={state} /> : null}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone} disabled={pending}>
          {tCommon("cancel")}
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? t("submitting") : t("submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
