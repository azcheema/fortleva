"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { DataTable, EmptyState, Field, FormMessage, RowActions, SectionCard, VisibilityBadge, type RowAction } from "@/components/semantic";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeCheckbox } from "@/components/ui/native-checkbox";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDuration, formatMoney, type DurationStyle } from "@/lib/format";
import type { FormResult } from "@/lib/server-actions";
import type { ReportSnapshot, ReportView } from "@/modules/time";

import { archiveReportAction, deleteReportAction, generateReportAction, publishReportAction, unpublishReportAction } from "../actions";

type ReportRow = Omit<ReportView, "generatedAt" | "publishedAt"> & { generatedAt: string; publishedAt: string | null };

/**
 * Reports list + generator + preview (D3). A published report wears the
 * two-token visibility badge; its snapshot never changes — unpublish
 * hides it, archive retires it, and a new period gets a new report.
 */
export function ReportsPanel({
  projectId,
  projectKey,
  reports,
  defaultPeriod,
  canPublish,
  locale,
  durationStyle,
}: {
  projectId: string;
  projectKey: string;
  reports: ReportRow[];
  defaultPeriod: { from: string; to: string };
  canPublish: boolean;
  locale: string;
  durationStyle: DurationStyle;
}) {
  const t = useTranslations("projects.time.reports");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [state, action, pending] = useActionState<FormResult | null, FormData>(async (_p, fd) => generateReportAction(fd), null);
  const [, start] = useTransition();
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    if (state?.ok) {
      toast.success(state.message);
      router.refresh();
    }
  }, [state, router]);

  const run = (fn: () => Promise<FormResult>) =>
    start(async () => {
      const r = await fn().catch(() => ({ ok: false as const, message: t("failed") }));
      if (!r.ok) toast.error(r.message);
      else toast.success(r.message);
      router.refresh();
    });

  const fmt = (seconds: number) => formatDuration(locale, seconds / 60, durationStyle);
  const open = reports.find((r) => r.id === openId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <SectionCard title={t("generateTitle")} description={t("generateDescription")} size="sm">
        <form action={action} className="grid grid-cols-2 items-end gap-3 md:grid-cols-6">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="projectKey" value={projectKey} />
          <Field htmlFor="r-title" label={t("fields.title")} className="col-span-2">
            <Input id="r-title" name="title" required maxLength={200} placeholder={t("fields.titlePlaceholder")} />
          </Field>
          <Field htmlFor="r-from" label={t("fields.from")}>
            <Input id="r-from" name="periodStart" type="date" defaultValue={defaultPeriod.from} required />
          </Field>
          <Field htmlFor="r-to" label={t("fields.to")}>
            <Input id="r-to" name="periodEnd" type="date" defaultValue={defaultPeriod.to} required />
          </Field>
          <Field htmlFor="r-group" label={t("fields.groupBy")}>
            <NativeSelect id="r-group" name="groupBy" defaultValue="DAY">
              {(["DAY", "WORK_ITEM", "EPIC", "SERVICE"] as const).map((g) => (
                <option key={g} value={g}>
                  {t(`groupBy.${g}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <div className="flex flex-col gap-1 text-sm">
            <label className="flex items-center gap-2">
              <NativeCheckbox name="includeAmounts" />
              {t("fields.includeAmounts")}
            </label>
            <label className="flex items-center gap-2">
              <NativeCheckbox name="includeNonBillable" />
              {t("fields.includeNonBillable")}
            </label>
          </div>
          <div className="col-span-2 flex items-center md:col-span-6">
            <FormMessage state={state?.ok ? null : state} />
            <Button type="submit" size="sm" disabled={pending} className="ml-auto">
              {t("generate")}
            </Button>
          </div>
        </form>
      </SectionCard>

      <SectionCard title={t("listTitle")} contentClassName="p-0">
        {reports.length === 0 ? (
          <div className="p-4">
            <EmptyState variant="filtered" title={t("empty.title")} body={t("empty.body")} className="py-6 text-center" />
          </div>
        ) : (
          <DataTable flush scrollLabel={t("listTitle")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.title")}</TableHead>
                  <TableHead priority="medium">{t("columns.period")}</TableHead>
                  <TableHead priority="low">{t("columns.groupBy")}</TableHead>
                  <TableHead className="w-[10ch] text-right">{t("columns.hours")}</TableHead>
                  <TableHead>{t("columns.status")}</TableHead>
                  <TableHead className="w-0 text-right">
                    <span className="sr-only">{tCommon("actions")}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reports.map((r) => {
                  const items: RowAction[] = [
                    { key: "preview", label: t("actions.preview"), onSelect: () => setOpenId(r.id === openId ? null : r.id) },
                    ...(canPublish && r.status === "DRAFT"
                      ? [{ key: "publish", label: t("actions.publish"), confirm: t("actions.publishQuestion"), onSelect: () => run(() => publishReportAction(r.id, projectKey)) }]
                      : []),
                    ...(canPublish && r.status === "PUBLISHED" && r.visibility === "CLIENT_VISIBLE"
                      ? [{ key: "unpublish", label: t("actions.unpublish"), onSelect: () => run(() => unpublishReportAction(r.id, projectKey)) }]
                      : []),
                    ...(canPublish && r.status === "PUBLISHED" && r.visibility === "INTERNAL"
                      ? [{ key: "republish", label: t("actions.republish"), onSelect: () => run(() => publishReportAction(r.id, projectKey)) }]
                      : []),
                    ...(r.status !== "ARCHIVED"
                      ? [{ key: "archive", label: t("actions.archive"), onSelect: () => run(() => archiveReportAction(r.id, projectKey)) }]
                      : []),
                    ...(r.status === "DRAFT"
                      ? [{ key: "delete", label: t("actions.delete"), tone: "danger" as const, confirm: t("actions.deleteQuestion"), onSelect: () => run(() => deleteReportAction(r.id, projectKey)) }]
                      : []),
                  ];
                  return (
                    <TableRow key={r.id}>
                      <TableCell>
                        <button type="button" className="text-left hover:underline" onClick={() => setOpenId(r.id === openId ? null : r.id)}>
                          {r.title}
                        </button>
                      </TableCell>
                      <TableCell priority="medium" className="num text-muted-foreground">
                        {r.periodStart} – {r.periodEnd}
                      </TableCell>
                      <TableCell priority="low" className="text-muted-foreground">{t(`groupBy.${r.groupBy}`)}</TableCell>
                      <TableCell className="num text-right">{fmt(r.totalSeconds)}</TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-2">
                          <Badge variant="outline">{t(`status.${r.status}`)}</Badge>
                          {r.status === "PUBLISHED" ? <VisibilityBadge value={r.visibility} /> : null}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <RowActions label={tCommon("actionsFor", { name: r.title })} items={items} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </DataTable>
        )}
      </SectionCard>

      {open ? <SnapshotPreview report={open} fmt={fmt} locale={locale} /> : null}
    </div>
  );
}

function SnapshotPreview({ report, fmt, locale }: { report: ReportRow; fmt: (s: number) => string; locale: string }) {
  const t = useTranslations("projects.time.reports");
  const s = report.snapshot as ReportSnapshot;
  const money = (a: string | undefined) => (a !== undefined && s.currency ? formatMoney(locale, Number(a), s.currency) : null);
  const label = (l: ReportSnapshot["lines"][number]): string => {
    switch (l.kind) {
      case "day":
        return l.date;
      case "work_item":
      case "epic":
        return `${l.ref} ${l.label}`;
      case "service":
        return l.label;
      case "other":
        return t("preview.other");
    }
  };
  return (
    <SectionCard
      title={t("preview.title", { title: report.title })}
      description={t("preview.description", { from: s.period.start, to: s.period.end })}
      contentClassName="p-0"
    >
      <DataTable flush density="compact" scrollLabel={t("preview.title", { title: report.title })}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("preview.line")}</TableHead>
              <TableHead className="w-[10ch] text-right">{t("preview.hours")}</TableHead>
              <TableHead priority="medium" className="w-[10ch] text-right">{t("preview.billable")}</TableHead>
              {s.includeAmounts ? <TableHead priority="low" className="w-[14ch] text-right">{t("preview.amount")}</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {s.lines.map((l, i) => (
              <TableRow key={i}>
                <TableCell className={l.kind === "other" ? "text-muted-foreground" : undefined}>{label(l)}</TableCell>
                <TableCell className="num text-right">{fmt(l.seconds)}</TableCell>
                <TableCell priority="medium" className="num text-right text-muted-foreground">{fmt(l.billableSeconds)}</TableCell>
                {s.includeAmounts ? <TableCell priority="low" className="num text-right">{money(l.amount) ?? "—"}</TableCell> : null}
              </TableRow>
            ))}
            <TableRow className="bg-muted/40">
              <TableCell className="font-semibold">{t("preview.total")}</TableCell>
              <TableCell className="num text-right font-semibold">{fmt(s.totals.seconds)}</TableCell>
              <TableCell priority="medium" className="num text-right">{fmt(s.totals.billableSeconds)}</TableCell>
              {s.includeAmounts ? <TableCell priority="low" className="num text-right font-semibold">{money(s.totals.amount) ?? "—"}</TableCell> : null}
            </TableRow>
          </TableBody>
        </Table>
      </DataTable>
    </SectionCard>
  );
}
