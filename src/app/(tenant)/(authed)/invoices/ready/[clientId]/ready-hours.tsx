"use client";

import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { Fragment, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { DataTable, InlineConfirm, SectionCard } from "@/components/semantic";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeCheckbox } from "@/components/ui/native-checkbox";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { hoursLines, LINE_GROUPINGS, type LineGrouping, type LineTexts } from "@/modules/invoicing/hours-lines";
import { readFixed } from "@/modules/invoicing/money";

import { addHoursToDraftAction, clearHourMarksAction, createInvoiceFromHoursAction, markHoursAction } from "../../actions";

/** One waiting hour as the page hands it over — labels formatted on the server, the rate as decimal text. */
export type ReadyHourRow = {
  readonly id: string;
  readonly dateLabel: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly projectName: string;
  /** The team's view of what it was: "KEY-12 Title", the entry's note, or "Project work". */
  readonly what: string;
  readonly memberId: string;
  readonly memberName: string;
  readonly tracked: string;
  readonly billed: string;
  readonly billedSeconds: number;
  /** "1000.00", or null for an hour with no rate. */
  readonly rate: string | null;
  readonly taskId: string | null;
  readonly sharedTaskTitle: string | null;
  readonly serviceId: string | null;
  readonly visibleAgreementName: string | null;
  readonly needsReview: boolean;
};

export type MarkedHourRow = {
  readonly id: string;
  readonly dateLabel: string;
  readonly projectKey: string;
  readonly what: string;
  readonly memberName: string;
  readonly billed: string;
  readonly mark: "BILLED_ELSEWHERE" | "WONT_INVOICE";
  /** What it would bill, decimal text — the written-off value of "Won't invoice". */
  readonly amount: string | null;
  /** The amount's currency (null with no rate). */
  readonly currency: string | null;
};

/**
 * THE CLIENT'S HOURS, CHOSEN AND TURNED INTO LINES (Phase 4 slice 110;
 * founder decision C80). Every waiting hour starts selected — except one the
 * time module stopped by itself (`needsReview`), which is a guess until a
 * member confirms it (the design review's low). The preview is
 * `hoursLines` — the very function the action runs on the hours it locks —
 * so what is shown is what is made; the server re-reads every hour and
 * refuses (HOURS_CHANGED) if one moved meanwhile.
 *
 * The actions are buttons calling server actions from a click, never a
 * `<form action>` (React 19 resets a form around its action; a refusal would
 * clear the selection).
 */
export function ReadyHours({
  clientId,
  rows,
  marked,
  markedMore,
  texts,
  currency,
  draft,
  can,
  maxRows,
  more,
  filtered,
}: {
  clientId: string;
  /** A period or project is chosen: "nothing matches", not "nothing waits". */
  filtered: boolean;
  rows: readonly ReadyHourRow[];
  /** More hours wait than the page lists: narrow the period. */
  more: boolean;
  marked: readonly MarkedHourRow[];
  markedMore: boolean;
  /** In the INVOICE's language — the lines' own words. */
  texts: LineTexts;
  /** The currency every price here is in (the draft's, the filter's, or the hours' one). */
  currency: string;
  draft: { readonly id: string } | null;
  can: { readonly create: boolean; readonly add: boolean; readonly mark: boolean };
  maxRows: number;
}) {
  const t = useTranslations("invoices.hours");
  const tLines = useTranslations("invoices.lines");
  const format = useFormatter();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(rows.filter((r) => !r.needsReview).map((r) => r.id)));
  const [grouping, setGrouping] = useState<LineGrouping>("PROJECT");
  const [markedSelected, setMarkedSelected] = useState<ReadonlySet<string>>(() => new Set());

  // Rows the server no longer lists (taken, marked — or, for the Marked card,
  // undone by someone else) leave the selection: an id that is not drawn can
  // never be unchecked, and would refuse every later action (the code
  // review's low).
  const live = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  const chosen = useMemo(() => [...selected].filter((id) => live.has(id)), [selected, live]);
  const liveMarked = useMemo(() => new Set(marked.map((m) => m.id)), [marked]);
  const markedChosen = useMemo(() => [...markedSelected].filter((id) => liveMarked.has(id)), [markedSelected, liveMarked]);
  const byProject = useMemo(() => {
    const m = new Map<string, ReadyHourRow[]>();
    for (const r of rows) m.set(r.projectId, [...(m.get(r.projectId) ?? []), r]);
    return [...m.values()];
  }, [rows]);

  const preview = useMemo(
    () =>
      hoursLines(
        rows
          .filter((r) => selected.has(r.id))
          .map((r) => ({
            id: r.id,
            projectId: r.projectId,
            projectName: r.projectName,
            workItemId: r.taskId,
            sharedTaskTitle: r.sharedTaskTitle,
            serviceId: r.serviceId,
            visibleAgreementName: r.visibleAgreementName,
            memberId: r.memberId,
            memberName: r.memberName,
            rate: r.rate === null ? null : readFixed(r.rate, 2),
            billedSeconds: r.billedSeconds,
          })),
        grouping,
        texts,
      ),
    [rows, selected, grouping, texts],
  );
  const billing = preview.filter((l) => l.quantity > 0n);
  const leftOut = preview.filter((l) => l.quantity === 0n).reduce((n, l) => n + l.entryIds.length, 0);
  const total = billing.reduce((s, l) => s + l.amount, 0n);
  const money = (minor: bigint) => format.number(Number(minor) / 100, { style: "currency", currency });
  const qty = (thousandths: bigint) => format.number(Number(thousandths) / 1000, { maximumFractionDigits: 3 });

  const toggle = (ids: readonly string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const go = (fn: () => Promise<{ ok: boolean; message: string; caution?: boolean }>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) {
        toast.error(r.message);
        router.refresh();
        return;
      }
      if (r.caution) toast.warning(r.message);
      else toast.success(r.message);
      after?.();
      router.refresh();
    });

  const create = () =>
    start(async () => {
      const r = await createInvoiceFromHoursAction(clientId, chosen, grouping);
      if (!r.ok) {
        toast.error(r.message);
        router.refresh();
        return;
      }
      if (r.value.leftOut > 0) toast.warning(`${t("created")} ${t("leftOut", { count: r.value.leftOut })}`);
      else toast.success(t("created"));
      router.push(`/invoices/${r.value.invoiceId}`);
    });

  const add = () => {
    if (!draft) return;
    go(
      () => addHoursToDraftAction(draft.id, clientId, chosen, grouping),
      () => router.push(`/invoices/${draft.id}`),
    );
  };

  const nothingChosen = chosen.length === 0 || billing.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <SectionCard title={t("listTitle")} description={t("selected", { count: chosen.length })} contentClassName={rows.length === 0 ? undefined : "p-0"}>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="hours-empty">
            {filtered ? t("emptyFiltered") : t("empty")}
          </p>
        ) : (
          <DataTable flush scrollLabel={t("listTitle")}>
            <Table data-testid="hours-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-0">
                    <span className="sr-only">{t("selected", { count: chosen.length })}</span>
                  </TableHead>
                  {/* medium: on a phone the date is the column that yields (the
                      project rows group the hours, the period filter bounds them) —
                      the time grid's own trade for its clock column; measured by
                      the visual walk's audit (CI 38035736535: 116px over a 356px box). */}
                  <TableHead priority="medium" className="w-[11ch]">
                    {t("columns.date")}
                  </TableHead>
                  <TableHead>{t("columns.what")}</TableHead>
                  <TableHead priority="medium" className="w-[16ch]">{t("columns.person")}</TableHead>
                  <TableHead priority="low" className="w-[10ch] text-right">
                    {t("columns.tracked")}
                  </TableHead>
                  <TableHead className="w-[10ch] text-right">{t("columns.billed")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byProject.map((group) => {
                  const first = group[0]!;
                  const ids = group.map((r) => r.id);
                  const all = ids.every((id) => selected.has(id));
                  return (
                    <Fragment key={first.projectId}>
                      <TableRow className="bg-muted/40" data-testid="hours-project">
                        <TableCell>
                          <NativeCheckbox
                            checked={all}
                            onChange={(e) => toggle(ids, e.target.checked)}
                            aria-label={t("selectProject", { project: first.projectName })}
                          />
                        </TableCell>
                        <TableCell colSpan={5} className="text-xs font-semibold text-muted-foreground">
                          {/* Contained: a long project name never widens a phone's table. */}
                          <div className="w-full min-w-0 truncate contain-inline-size" title={first.projectName}>
                            <span className="num-id font-mono">{first.projectKey}</span> {first.projectName}
                          </div>
                        </TableCell>
                      </TableRow>
                      {group.map((r) => (
                        <TableRow key={r.id} data-testid="hours-row" data-entry-id={r.id}>
                          <TableCell>
                            <NativeCheckbox
                              checked={selected.has(r.id)}
                              onChange={(e) => toggle([r.id], e.target.checked)}
                              aria-label={t("selectRow", { date: r.dateLabel })}
                            />
                          </TableCell>
                          <TableCell priority="medium" className="num whitespace-nowrap text-muted-foreground">
                            {r.dateLabel}
                          </TableCell>
                          {/* WHAT YIELDS: `contain-inline-size` + `w-full` takes the
                              wrapper out of the column's intrinsic sizing (UI.md
                              §10.12, the time grid's answer), and the badges are
                              capped at half the cell so they clip, never push. */}
                          <TableCell className="min-w-24">
                            <div className="flex w-full min-w-0 items-center gap-2 contain-inline-size">
                              <span className="truncate" title={r.what}>
                                {r.what}
                              </span>
                              {r.needsReview || r.rate === null ? (
                                <span className="flex max-w-1/2 shrink-0 items-center gap-1 overflow-hidden">
                                  {r.needsReview ? (
                                    <Badge variant="outline" className="shrink-0" title={t("needsReviewWhy")}>
                                      {t("needsReview")}
                                    </Badge>
                                  ) : null}
                                  {r.rate === null ? (
                                    <Badge variant="outline" className="shrink-0">
                                      {t("noRate")}
                                    </Badge>
                                  ) : null}
                                </span>
                              ) : null}
                            </div>
                          </TableCell>
                          <TableCell priority="medium" className="max-w-40 truncate text-muted-foreground">
                            {r.memberName}
                          </TableCell>
                          <TableCell priority="low" className="num text-right whitespace-nowrap text-muted-foreground">
                            {r.tracked}
                          </TableCell>
                          <TableCell className="num text-right whitespace-nowrap">{r.billed}</TableCell>
                        </TableRow>
                      ))}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </DataTable>
        )}
      </SectionCard>
      {more ? (
        <p className="text-xs text-muted-foreground" data-testid="hours-more">
          {t("more", { max: maxRows })}
        </p>
      ) : null}

      {rows.length > 0 ? (
        // Unpadded, the table flush between two padded bands — a bordered
        // table inside a padded card is two hairlines (UI.md §10.15.1; the
        // visual walk's audit, CI 38035736535); the Marked card's shape.
        <SectionCard title={t("linesTitle")} contentClassName="p-0">
          <div className="flex flex-col gap-1 border-b border-border p-4">
            <Label htmlFor="hours-grouping">{t("groupBy")}</Label>
            <NativeSelect
              id="hours-grouping"
              className="w-full sm:w-56"
              value={grouping}
              onChange={(e) => setGrouping(e.target.value as LineGrouping)}
              data-testid="hours-grouping"
            >
              {LINE_GROUPINGS.map((g) => (
                <option key={g} value={g}>
                  {t(`groupings.${g}`)}
                </option>
              ))}
            </NativeSelect>
            {grouping === "PERSON" ? <p className="text-xs text-(--tone-caution-fg)">{t("personWarning")}</p> : null}
            {grouping === "TASK" ? <p className="text-xs text-muted-foreground">{t("taskHint")}</p> : null}
          </div>
          {billing.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{t("previewEmpty")}</p>
          ) : (
            <DataTable flush scrollLabel={t("linesTitle")}>
              <Table data-testid="hours-preview">
                <TableHeader>
                  <TableRow>
                    <TableHead>{tLines("columns.description")}</TableHead>
                    <TableHead className="w-[10ch] text-right">{tLines("columns.quantity")}</TableHead>
                    <TableHead priority="medium" className="w-[14ch] text-right">
                      {tLines("columns.unitPrice")}
                    </TableHead>
                    <TableHead className="w-[14ch] text-right">{tLines("columns.amount")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {billing.map((l) => (
                    <TableRow key={l.key} data-testid="hours-preview-line">
                      <TableCell className="min-w-24">
                        <div className="w-full min-w-0 contain-inline-size">
                          <span className="block truncate" title={l.description}>
                            {l.description}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="num text-right whitespace-nowrap">{t("quantity", { quantity: qty(l.quantity) })}</TableCell>
                      <TableCell priority="medium" className="num text-right whitespace-nowrap">
                        {l.noRate ? <span className="text-(--tone-caution-fg)">{t("noRateLine")}</span> : money(l.unitPrice)}
                      </TableCell>
                      <TableCell className="num text-right whitespace-nowrap">{money(l.amount)}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow>
                    <TableCell colSpan={2} className="font-medium">
                      {t("total")}
                    </TableCell>
                    <TableCell priority="medium" />
                    <TableCell className="num text-right font-medium whitespace-nowrap" data-testid="hours-preview-total">
                      {money(total)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </DataTable>
          )}
          {/* Only when there is something to say or do — never an empty bordered strip. */}
          {leftOut > 0 || (draft ? can.add : can.create) || can.mark ? (
            <div className="flex flex-col gap-3 border-t border-border p-3">
              {leftOut > 0 ? <p className="text-xs text-(--tone-caution-fg)">{t("leftOut", { count: leftOut })}</p> : null}
              <div className="flex flex-wrap items-center gap-2">
                {draft ? (
                  can.add ? (
                    <Button onClick={add} disabled={pending || nothingChosen} data-testid="hours-add">
                      {t("add")}
                    </Button>
                  ) : null
                ) : can.create ? (
                  <Button onClick={create} disabled={pending || nothingChosen} data-testid="hours-create">
                    {t("create")}
                  </Button>
                ) : null}
                {can.mark ? (
                  <>
                    <InlineConfirm
                      label={t("billedElsewhere")}
                      question={t("confirmBilledElsewhere", { count: chosen.length })}
                      onConfirm={() => go(() => markHoursAction(clientId, chosen, "BILLED_ELSEWHERE"))}
                      pending={pending}
                      disabled={chosen.length === 0}
                      variant="outline"
                    />
                    <InlineConfirm
                      label={t("wontInvoice")}
                      question={t("confirmWontInvoice", { count: chosen.length })}
                      onConfirm={() => go(() => markHoursAction(clientId, chosen, "WONT_INVOICE"))}
                      pending={pending}
                      disabled={chosen.length === 0}
                      variant="outline"
                    />
                  </>
                ) : null}
              </div>
            </div>
          ) : null}
        </SectionCard>
      ) : null}

      <SectionCard title={t("markedTitle")} description={t("markedDescription")} contentClassName={marked.length === 0 ? undefined : "p-0"}>
        {marked.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("markedEmpty")}</p>
        ) : (
          <>
            <DataTable flush scrollLabel={t("markedTitle")}>
              <Table data-testid="marked-table">
                <TableHeader>
                  <TableRow>
                    {can.mark ? (
                      <TableHead className="w-0">
                        <span className="sr-only">{t("undo")}</span>
                      </TableHead>
                    ) : null}
                    <TableHead priority="medium" className="w-[11ch]">
                      {t("columns.date")}
                    </TableHead>
                    <TableHead>{t("columns.what")}</TableHead>
                    <TableHead priority="medium" className="w-[16ch]">{t("columns.person")}</TableHead>
                    <TableHead className="w-[10ch] text-right">{t("columns.billed")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {marked.map((m) => (
                    <TableRow key={m.id} data-testid="marked-row" data-entry-id={m.id} data-mark={m.mark}>
                      {can.mark ? (
                        <TableCell>
                          <NativeCheckbox
                            checked={markedSelected.has(m.id)}
                            onChange={(e) =>
                              setMarkedSelected((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(m.id);
                                else next.delete(m.id);
                                return next;
                              })
                            }
                            aria-label={t("selectRow", { date: m.dateLabel })}
                          />
                        </TableCell>
                      ) : null}
                      <TableCell priority="medium" className="num whitespace-nowrap text-muted-foreground">
                        {m.dateLabel}
                      </TableCell>
                      <TableCell className="min-w-24">
                        <div className="flex w-full min-w-0 items-center gap-2 contain-inline-size">
                          <span className="truncate" title={m.what}>
                            <span className="num-id font-mono text-muted-foreground">{m.projectKey}</span> {m.what}
                          </span>
                          {/* The mark is what tells these rows apart: capped, truncated
                              with an ellipsis, and whole in its title (the time grid's
                              billing badge). */}
                          <Badge variant="outline" className="min-w-0 max-w-1/2 overflow-hidden" title={t(`markedStates.${m.mark}`)}>
                            <span className="truncate">{t(`markedStates.${m.mark}`)}</span>
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell priority="medium" className="max-w-40 truncate text-muted-foreground">
                        {m.memberName}
                      </TableCell>
                      <TableCell className="num text-right whitespace-nowrap">{m.billed}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </DataTable>
            <div className="flex flex-wrap items-center gap-3 border-t border-border p-3">
              {can.mark ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending || markedChosen.length === 0}
                  onClick={() => go(() => clearHourMarksAction(clientId, markedChosen), () => setMarkedSelected(new Set()))}
                  data-testid="marked-undo"
                >
                  {t("undo")}
                </Button>
              ) : null}
              {(() => {
                // Per currency: written-off EUR and SEK are two figures, never one (the code review's low).
                const written = new Map<string, bigint>();
                for (const m of marked) {
                  if (m.mark !== "WONT_INVOICE" || m.amount === null || m.currency === null) continue;
                  written.set(m.currency, (written.get(m.currency) ?? 0n) + readFixed(m.amount, 2));
                }
                const text = [...written.entries()]
                  .filter(([, v]) => v > 0n)
                  .map(([c, v]) => format.number(Number(v) / 100, { style: "currency", currency: c }))
                  .join(" · ");
                return text ? <span className="text-xs text-muted-foreground">{t("writtenOff", { amount: text })}</span> : null;
              })()}
              {markedMore ? <span className="text-xs text-muted-foreground">{t("markedMore", { max: maxRows })}</span> : null}
            </div>
          </>
        )}
      </SectionCard>
    </div>
  );
}
