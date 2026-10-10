"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { DataTable, InlineConfirm, SectionCard } from "@/components/semantic";
import { NativeCheckbox } from "@/components/ui/native-checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useRun } from "@/components/use-run";

import { returnHoursAction } from "../actions";

/** Where an hour this invoice billed is NOW — its mark only (C80 (e); the design review's M7). */
export type HourStateView =
  | { readonly kind: "here" | "returned" | "billedElsewhere" | "wontInvoice" | "otherClient" | "splitHere" }
  | { readonly kind: "other"; readonly invoiceId: string; readonly number: string | null; readonly draft: boolean };

export type HourRowView = {
  readonly entryId: string;
  readonly dateLabel: string;
  readonly member: string | null;
  readonly task: string | null;
  readonly projectKey: string | null;
  /** As billed — the record, never the hour's edits since. */
  readonly billed: string;
  readonly state: HourStateView;
};

/**
 * THE HOURS AN INVOICE BILLED (Phase 4 slice 110) — the team's card, never
 * the client's. Each row is the RECORD (as billed) and where the hour's mark
 * is now; an hour edited since shows nothing here (C80 (e): the warning is the
 * time grid's, and the invoice does not change). After a PART credit, a
 * member who may put hours on invoices and credit them picks the hours the
 * credit note covered and returns them to the ready list (C80 (f)).
 */
export function InvoiceHoursCard({
  invoiceId,
  draft,
  canReturn,
  rows,
  more,
}: {
  invoiceId: string;
  draft: boolean;
  canReturn: boolean;
  rows: readonly HourRowView[];
  more: number;
}) {
  const t = useTranslations("invoices.hoursCard");
  const { pending, run } = useRun();
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
  const marked = (s: HourStateView) => s.kind === "here" || s.kind === "splitHere";
  const returnable = canReturn ? rows.filter((r) => marked(r.state)) : [];
  const picked = [...chosen].filter((id) => returnable.some((r) => r.entryId === id));

  const stateText = (s: HourStateView) =>
    s.kind === "other"
      ? s.draft || s.number === null
        ? t("states.otherDraft")
        : t("states.otherInvoice", { number: s.number })
      : t(`states.${s.kind}`);

  return (
    <SectionCard
      title={t("title")}
      description={draft ? t("descriptionDraft") : t("descriptionIssued")}
      contentClassName="p-0"
    >
      <div data-testid="invoice-hours">
        <DataTable flush scrollLabel={t("title")}>
          <Table>
            <TableHeader>
              <TableRow>
                {canReturn ? (
                  <TableHead className="w-0">
                    <span className="sr-only">{t("return")}</span>
                  </TableHead>
                ) : null}
                <TableHead className="w-[11ch]">{t("columns.date")}</TableHead>
                <TableHead priority="medium">{t("columns.person")}</TableHead>
                <TableHead>{t("columns.task")}</TableHead>
                <TableHead className="text-right">{t("columns.billed")}</TableHead>
                {draft ? null : <TableHead priority="low">{t("columns.now")}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.entryId} data-testid="invoice-hour" data-entry-id={r.entryId} data-state={r.state.kind}>
                  {canReturn ? (
                    <TableCell>
                      {marked(r.state) ? (
                        <NativeCheckbox
                          checked={chosen.has(r.entryId)}
                          onChange={(e) =>
                            setChosen((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(r.entryId);
                              else next.delete(r.entryId);
                              return next;
                            })
                          }
                          aria-label={t("selectRow", { date: r.dateLabel })}
                        />
                      ) : null}
                    </TableCell>
                  ) : null}
                  <TableCell className="num whitespace-nowrap text-muted-foreground">{r.dateLabel}</TableCell>
                  <TableCell priority="medium" className="max-w-40 truncate text-muted-foreground">
                    {r.member ?? "—"}
                  </TableCell>
                  <TableCell className="max-w-72 truncate" title={r.task ?? undefined}>
                    {r.task ?? (r.projectKey ? <span className="num-id font-mono text-muted-foreground">{r.projectKey}</span> : "—")}
                  </TableCell>
                  <TableCell className="num text-right whitespace-nowrap">{r.billed}</TableCell>
                  {draft ? null : (
                    <TableCell priority="low" className="whitespace-nowrap text-muted-foreground">
                      {r.state.kind === "other" ? (
                        <Link
                          href={`/invoices/${r.state.invoiceId}`}
                          className="rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          {stateText(r.state)}
                        </Link>
                      ) : (
                        stateText(r.state)
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DataTable>
        {more > 0 || canReturn ? (
          <div className="flex flex-col gap-2 border-t border-border p-3">
            {more > 0 ? <p className="text-xs text-muted-foreground">{t("more", { count: more })}</p> : null}
            {canReturn ? (
              <>
                <p className="text-xs text-muted-foreground">{t("returnHint")}</p>
                <div>
                  <InlineConfirm
                    label={t("return")}
                    question={t("confirmReturn", { count: picked.length })}
                    onConfirm={() => run(() => returnHoursAction(invoiceId, picked), () => setChosen(new Set()))}
                    pending={pending}
                    disabled={picked.length === 0}
                    variant="outline"
                    size="sm"
                  />
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}
