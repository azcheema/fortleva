"use client";

import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TimerIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { DataTable, InlineEdit, RowActions, type RowAction } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useRun } from "@/components/use-run";
import type { FormResult } from "@/lib/server-actions";
import { VAT_RATES, type VatProfile } from "@/modules/invoicing/vat";

import { addLineAction, moveLineAction, removeLineAction, updateLineAction } from "../actions";

/** A line as the page hands it over: decimals as the database's text. */
export type LineRow = {
  readonly id: string;
  readonly description: string;
  /** "1.500" — three decimals. */
  readonly quantity: string;
  readonly unit: string | null;
  /** "1250.00". */
  readonly unitPrice: string;
  /** "25.00". */
  readonly vatRate: string;
  /** "1875.00". */
  readonly amount: string;
  /** Slice 110: how many tracked time entries it was made from (0: typed by hand). */
  readonly hours: number;
};

/** A stored decimal as a member types it: no trailing zeros past what it needs, the locale's separator. */
function editText(decimal: string, locale: string, keepTwo: boolean): string {
  const parts = decimal.split(".");
  const int = parts[0] ?? "0";
  const raw = parts[1] ?? "";
  const frac = keepTwo ? raw.padEnd(2, "0").slice(0, Math.max(2, raw.replace(/0+$/, "").length)) : raw.replace(/0+$/, "");
  const text = frac ? `${int}.${frac}` : int;
  return locale.startsWith("sv") ? text.replace(".", ",") : text;
}

/** Where focus goes once the page has re-rendered after a verb that moved or removed its row. */
type PendingFocus = { readonly kind: "row"; readonly lineId: string } | { readonly kind: "add" } | null;

/**
 * THE DRAFT'S LINES (Phase 4 slice 107) — a real table (rule 3: every value
 * is text until clicked), each cell its own commit through `updateLineAction`
 * with a one-field patch, the time grid's pattern: a refusal is toasted and
 * that cell goes back to what is saved (`resetKey` per cell) — never a cell
 * left showing a value the server did not take. The amount is the server's
 * (quantity × price, to the öre) and refreshes with the page.
 *
 * COLUMNS BY WIDTH (UI.md §10.12, measured by the visual walk's craft audit):
 * a phone keeps Description, Amount and the row's verbs; Qty and Price join
 * from the `medium` rung, Unit and VAT from `low`. The currency is said once,
 * in the card's description, not in two headers. Description yields
 * (`contain-inline-size`, the time grid's trick) so a long one never widens
 * the table.
 *
 * Verbs in the row's menu (MANDATE 2): Move up / Move down (each offered only
 * where it moves something) and Remove (asks). After a move, focus goes to the
 * moved row's menu trigger; after a remove, to the add field — once the
 * re-render has put them where they are going (the code review's low: React
 * moving a row's node, or unmounting it, dropped focus to the page). A NEW
 * line is title-only (rule 2): its description and Enter; focus stays in the
 * field, and a second Enter while the first is saving waits on a ref, not on
 * the revalidating transition (AGENTS.md's isPending trap).
 */
export function InvoiceLines({
  invoiceId,
  lines,
  vatProfile,
  editable,
}: {
  invoiceId: string;
  lines: readonly LineRow[];
  vatProfile: VatProfile;
  editable: boolean;
}) {
  const t = useTranslations("invoices.lines");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const locale = useLocale();
  const { run } = useRun();
  const router = useRouter();
  const [resets, setResets] = useState<Record<string, number>>({});
  const [newText, setNewText] = useState("");
  const [adding, setAdding] = useState(false);
  const addingRef = useRef(false);
  const newRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  // Where focus should land, and the lines it was asked against: it lands
  // once the refresh has brought NEW lines (the moved row in its place, the
  // removed one gone), never on the render that asked.
  const [pendingFocus, setPendingFocus] = useState<{ readonly want: PendingFocus; readonly asked: readonly LineRow[] } | null>(null);
  /** The request already acted on — written only here, in the effect (no state set in an effect). */
  const handled = useRef<object | null>(null);
  const ro = !editable;

  useEffect(() => {
    if (!pendingFocus || pendingFocus.asked === lines || handled.current === pendingFocus) return;
    handled.current = pendingFocus;
    const { want } = pendingFocus;
    if (!want) return;
    if (want.kind === "add") {
      newRef.current?.focus();
      return;
    }
    const trigger = tableRef.current?.querySelector<HTMLElement>(
      `[data-line-id="${CSS.escape(want.lineId)}"] [data-slot="row-actions"] button`,
    );
    (trigger ?? newRef.current)?.focus();
  }, [lines, pendingFocus]);

  const money = (decimal: string) =>
    format.number(Number(decimal), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const qty = (decimal: string) => format.number(Number(decimal), { maximumFractionDigits: 3 });
  const pct = (decimal: string) => t("rate", { rate: Number(decimal) });
  const rates = VAT_RATES[vatProfile];

  const cellKey = (lineId: string, field: string) => `${lineId}:${field}`;
  const commit = (lineId: string, field: string, value: string) =>
    run(async () => {
      const r: FormResult = await updateLineAction(invoiceId, lineId, { [field]: value });
      if (!r.ok) setResets((s) => ({ ...s, [cellKey(lineId, field)]: (s[cellKey(lineId, field)] ?? 0) + 1 }));
      return r;
    });

  const add = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (addingRef.current) return;
    const description = newText.trim();
    if (description === "") {
      newRef.current?.focus();
      return;
    }
    addingRef.current = true;
    setAdding(true);
    try {
      const r = await addLineAction(invoiceId, description);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      setNewText("");
      toast.success(r.message);
      router.refresh();
    } catch {
      toast.error(t("unreachable"));
    } finally {
      addingRef.current = false;
      setAdding(false);
      newRef.current?.focus();
    }
  };

  const itemsFor = (line: LineRow, index: number): RowAction[] => {
    const items: RowAction[] = [];
    // Focus is asked for only once the verb SUCCEEDED (`run`'s onOk): a
    // refused move or remove refreshes the page too, and must not send focus
    // away from a row that is still where it was (the fix-pass review's low).
    const move = (direction: "up" | "down") => () =>
      run(
        () => moveLineAction(invoiceId, line.id, direction),
        () => setPendingFocus({ want: { kind: "row", lineId: line.id }, asked: lines }),
      );
    if (index > 0) items.push({ key: "up", label: t("moveUp"), icon: ArrowUpIcon, onSelect: move("up") });
    if (index < lines.length - 1) items.push({ key: "down", label: t("moveDown"), icon: ArrowDownIcon, onSelect: move("down") });
    items.push({
      key: "remove",
      label: t("remove"),
      icon: Trash2Icon,
      tone: "danger",
      confirm: t("removeConfirm", { description: line.description }),
      onSelect: () =>
        run(
          () => removeLineAction(invoiceId, line.id),
          () => setPendingFocus({ want: { kind: "add" }, asked: lines }),
        ),
    });
    return items;
  };

  return (
    <div className="flex flex-col gap-3" ref={tableRef}>
      {lines.length > 0 ? (
        <DataTable flush scrollLabel={t("title")}>
          <Table data-testid="invoice-lines">
            <TableHeader>
              <TableRow>
                <TableHead>{t("columns.description")}</TableHead>
                <TableHead priority="medium" className="text-right">
                  {t("columns.quantity")}
                </TableHead>
                <TableHead priority="low">{t("columns.unit")}</TableHead>
                <TableHead priority="medium" className="text-right">
                  {t("columns.unitPrice")}
                </TableHead>
                <TableHead priority="low" className="text-right">
                  {t("columns.vat")}
                </TableHead>
                <TableHead className="text-right">{t("columns.amount")}</TableHead>
                {editable ? <TableHead pinned className="w-0" aria-label={tCommon("actions")} /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((line, index) => (
                <TableRow key={line.id} data-testid="invoice-line" data-line-id={line.id}>
                  <TableCell className="min-w-32">
                    <div className="flex w-full min-w-0 items-center gap-1.5 contain-inline-size">
                      <div className="min-w-0 flex-1">
                        <InlineEdit
                          kind="text"
                          name={`description-${line.id}`}
                          value={line.description}
                          label={t("columns.description")}
                          placeholder={line.description}
                          readOnly={ro}
                          density="table"
                          hiddenInput={false}
                          inputProps={{ maxLength: 2000, required: true }}
                          resetKey={resets[cellKey(line.id, "description")] ?? 0}
                          onCommit={(next) => commit(line.id, "description", next)}
                        />
                      </div>
                      {/* Slice 110: a line made from tracked hours says how many —
                          on its own row, not under it (the row keeps its pitch). */}
                      {line.hours > 0 ? (
                        <span
                          className="inline-flex shrink-0 items-center gap-0.5 text-2xs text-muted-foreground"
                          title={t("fromHours", { count: line.hours })}
                          data-testid="invoice-line-hours"
                        >
                          <TimerIcon className="size-3" aria-hidden />
                          <span aria-hidden className="num">
                            {line.hours}
                          </span>
                          <span className="sr-only">{t("fromHours", { count: line.hours })}</span>
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell priority="medium" className="text-right">
                    <InlineEdit
                      kind="text"
                      name={`quantity-${line.id}`}
                      value={editText(line.quantity, locale, false)}
                      display={<span className="num">{qty(line.quantity)}</span>}
                      label={t("columns.quantity")}
                      placeholder={qty(line.quantity)}
                      readOnly={ro}
                      density="table"
                      fit
                      align="end"
                      hiddenInput={false}
                      inputProps={{ inputMode: "decimal", maxLength: 16 }}
                      resetKey={resets[cellKey(line.id, "quantity")] ?? 0}
                      onCommit={(next) => commit(line.id, "quantity", next)}
                    />
                  </TableCell>
                  <TableCell priority="low">
                    <InlineEdit
                      kind="text"
                      name={`unit-${line.id}`}
                      value={line.unit ?? ""}
                      label={t("columns.unit")}
                      placeholder={t("unitPlaceholder")}
                      readOnly={ro}
                      density="table"
                      fit
                      hiddenInput={false}
                      inputProps={{ maxLength: 20 }}
                      resetKey={resets[cellKey(line.id, "unit")] ?? 0}
                      onCommit={(next) => commit(line.id, "unit", next)}
                    />
                  </TableCell>
                  <TableCell priority="medium" className="text-right">
                    <InlineEdit
                      kind="text"
                      name={`unitPrice-${line.id}`}
                      value={editText(line.unitPrice, locale, true)}
                      display={<span className="num">{money(line.unitPrice)}</span>}
                      label={t("columns.unitPrice")}
                      placeholder={money(line.unitPrice)}
                      readOnly={ro}
                      density="table"
                      fit
                      align="end"
                      hiddenInput={false}
                      inputProps={{ inputMode: "decimal", maxLength: 20 }}
                      resetKey={resets[cellKey(line.id, "unitPrice")] ?? 0}
                      onCommit={(next) => commit(line.id, "unitPrice", next)}
                    />
                  </TableCell>
                  <TableCell priority="low" className="text-right">
                    {rates.length > 1 ? (
                      <InlineEdit
                        kind="select"
                        name={`vatRate-${line.id}`}
                        value={line.vatRate}
                        label={t("columns.vat")}
                        placeholder={pct(line.vatRate)}
                        options={rates.map((r) => {
                          const value = `${Number(r) / 100}.00`;
                          return { value, label: pct(value) };
                        })}
                        readOnly={ro}
                        density="table"
                        fit
                        align="end"
                        hiddenInput={false}
                        resetKey={resets[cellKey(line.id, "vatRate")] ?? 0}
                        onCommit={(next) => commit(line.id, "vatRate", next)}
                      />
                    ) : (
                      <span className="num px-2.5 text-muted-foreground">{pct(line.vatRate)}</span>
                    )}
                  </TableCell>
                  <TableCell className="num text-right whitespace-nowrap" data-testid="invoice-line-amount">
                    {money(line.amount)}
                  </TableCell>
                  {editable ? (
                    <TableCell pinned className="text-right">
                      <RowActions label={tCommon("actionsFor", { name: line.description })} items={itemsFor(line, index)} />
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DataTable>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="invoice-lines-empty">
          {editable ? t("emptyEditable") : t("empty")}
        </p>
      )}
      {editable ? (
        <form onSubmit={add} className="flex flex-col gap-2 sm:flex-row sm:items-end" data-testid="invoice-line-add">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Label htmlFor="invoice-new-line">{t("newLabel")}</Label>
            <Input
              id="invoice-new-line"
              ref={newRef}
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              placeholder={t("newPlaceholder")}
              maxLength={2000}
              autoComplete="off"
            />
          </div>
          <Button type="submit" variant="outline" aria-disabled={adding}>
            <PlusIcon aria-hidden="true" />
            {t("add")}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
