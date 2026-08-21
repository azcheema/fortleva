"use client";

import { CoinsIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useState, useTransition } from "react";
import { toast } from "sonner";

import { DataTable, EmptyState, Field, FormMessage, RowActions, type RowAction } from "@/components/semantic";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeCheckbox } from "@/components/ui/native-checkbox";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { RateKind, RateScope } from "@/modules/time";

import {
  closeRateCardAction,
  createRateCardAction,
  repriceRateCardAction,
  setCostLayerAction,
  type RateFormState,
} from "./actions";

/**
 * Rate cards as a list (UI.md §10.15.1) — one shape for /settings/rates
 * (BILL and COST) and for a client's Agreements tab (the SERVICE-scoped
 * BILL cards of that client). Every label is FORMATTED ON THE SERVER and
 * passed as a string: Intl in a client component is a hydration hazard
 * (PLAN.md §0 trap), and the row's verbs are the only reason this is a
 * client component at all.
 *
 * Rows are immutable (DATA_MODEL.md §6.15): the only verbs are "close"
 * (effectiveTo, the one mutable column) and "reprice" (the audited
 * correction command). Both ask for a date in place below the table —
 * the same mechanism for two verbs, no modal (UI.md §5.9).
 */

export type RateCardRow = {
  id: string;
  kind: RateKind;
  scope: RateScope;
  /** Resolved on the server: member name, "KEY · Project", "Agreement · Client", or the workspace default. */
  appliesTo: string;
  /** Formatted "1 200,00 kr/h"; null when the amount is withheld (COST, not revealed). */
  rateLabel: string | null;
  fromLabel: string;
  toLabel: string | null;
  /** ISO date — the floor for the close-date picker. */
  effectiveFrom: string;
  open: boolean;
};

type RowFormState = { kind: "close" | "reprice"; id: string } | null;

export function RateCardTable({
  rows,
  canClose,
  canReprice,
  today,
  returnTo,
  scrollLabel,
  emptyTitle,
  emptyBody,
  addHref,
  addLabel,
}: {
  rows: RateCardRow[];
  canClose: boolean;
  canReprice: boolean;
  /** The member's local date — default for the close and reprice pickers. */
  today: string;
  /** Where a step-up redirect lands again (the page that rendered this table). */
  returnTo: string;
  scrollLabel: string;
  emptyTitle: string;
  emptyBody: string;
  /** When the viewer may add a card: the empty state's verb (UI.md §5.8). */
  addHref?: string;
  addLabel?: string;
}) {
  const t = useTranslations("settings.rates");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [form, setForm] = useState<RowFormState>(null);
  const [date, setDate] = useState(today);
  const [mode, setMode] = useState<"FROM_DATE" | "ALL_UNBILLED">("FROM_DATE");

  const openForm = (next: RowFormState, row: RateCardRow) => {
    // A close date can never precede the card's start; default to today or the start, whichever is later.
    setDate(next?.kind === "close" && row.effectiveFrom > today ? row.effectiveFrom : today);
    setMode("FROM_DATE");
    setForm(next);
  };

  const submit = () => {
    if (!form) return;
    const current = form;
    start(async () => {
      if (current.kind === "close") {
        const r = await closeRateCardAction({ id: current.id, effectiveTo: date, returnTo });
        if (r.ok) toast.success(r.message);
        else toast.error(r.message);
        if (r.ok) setForm(null);
      } else {
        const r = await repriceRateCardAction({
          id: current.id,
          mode,
          ...(mode === "FROM_DATE" ? { fromDate: date } : {}),
          returnTo,
        });
        if (r.ok) {
          toast.success(t("repriceForm.done", { repriced: r.value.repriced, skipped: r.value.skippedLocked }));
          setForm(null);
        } else toast.error(r.message);
      }
      router.refresh();
    });
  };

  const actionsFor = (row: RateCardRow): RowAction[] => [
    ...(canClose && row.open
      ? [{ key: "close", label: t("actions.close"), onSelect: () => openForm({ kind: "close", id: row.id }, row) } satisfies RowAction]
      : []),
    ...(canReprice
      ? [{ key: "reprice", label: t("actions.reprice"), onSelect: () => openForm({ kind: "reprice", id: row.id }, row) } satisfies RowAction]
      : []),
  ];

  if (rows.length === 0) {
    return (
      <div className="px-4">
        {addHref && addLabel ? (
          <EmptyState
            variant="empty"
            icon={CoinsIcon}
            title={emptyTitle}
            body={emptyBody}
            action={
              <Button asChild size="sm">
                <Link href={addHref}>
                  <PlusIcon />
                  {addLabel}
                </Link>
              </Button>
            }
          />
        ) : (
          <p className="py-4 text-sm text-muted-foreground">{emptyTitle}</p>
        )}
      </div>
    );
  }

  const active = form ? rows.find((r) => r.id === form.id) : null;

  return (
    <>
      <DataTable flush density="compact" scrollLabel={scrollLabel}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.appliesTo")}</TableHead>
              <TableHead priority="low">{t("columns.scope")}</TableHead>
              <TableHead className="text-right">{t("columns.rate")}</TableHead>
              <TableHead priority="medium" className="w-[13ch]">{t("columns.from")}</TableHead>
              <TableHead priority="medium" className="w-[13ch]">{t("columns.to")}</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">{tCommon("actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const actions = actionsFor(row);
              return (
                <TableRow key={row.id} data-testid="rate-card-row" data-open={row.open ? "1" : "0"}>
                  <TableCell className={cn("w-full max-w-0", row.open ? "font-medium" : "text-muted-foreground")}>
                    {/* The label column takes whatever width the fixed columns leave and truncates
                        there — `max-w-0` removes the cell's own min-content from the auto layout,
                        `w-full` hands it the remainder — so a long "Agreement · Client" label can
                        never push the row's verbs past the table's box (CI caught 2 px of exactly
                        that on the 720 px settings page; the phone case is the same rule). */}
                    <span className="block truncate" title={row.appliesTo}>
                      {row.appliesTo}
                    </span>
                  </TableCell>
                  <TableCell priority="low">
                    <Badge variant="outline">{t(`scopes.${row.scope}`)}</Badge>
                  </TableCell>
                  <TableCell className="num text-right">
                    {row.rateLabel ?? (
                      <span className="text-muted-foreground">
                        <span aria-hidden="true">{"✦ "}</span>
                        {t("cost.hidden")}
                      </span>
                    )}
                  </TableCell>
                  <TableCell priority="medium" className="num text-muted-foreground">{row.fromLabel}</TableCell>
                  <TableCell priority="medium" className="num text-muted-foreground">
                    {row.toLabel ?? <Badge variant="success">{t("open")}</Badge>}
                  </TableCell>
                  <TableCell className="text-right">
                    {actions.length > 0 ? (
                      <RowActions label={tCommon("actionsFor", { name: row.appliesTo })} items={actions} />
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </DataTable>

      {form && active ? (
        <form
          role="group"
          aria-label={form.kind === "close" ? t("closeForm.title") : t("repriceForm.title")}
          data-testid={`rate-card-${form.kind}-form`}
          className="flex flex-col gap-3 border-t border-border p-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div>
            <p className="text-sm font-medium">
              {form.kind === "close" ? t("closeForm.title") : t("repriceForm.title")}
              {" — "}
              <span className="font-normal text-muted-foreground">{active.appliesTo}</span>
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {form.kind === "close" ? t("closeForm.hint") : t("repriceForm.hint")}
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            {form.kind === "reprice" ? (
              <Field htmlFor="reprice-mode" label={t("repriceForm.mode")}>
                <NativeSelect
                  id="reprice-mode"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as "FROM_DATE" | "ALL_UNBILLED")}
                  className="w-auto"
                >
                  <option value="FROM_DATE">{t("repriceForm.fromDate")}</option>
                  <option value="ALL_UNBILLED">{t("repriceForm.allUnbilled")}</option>
                </NativeSelect>
              </Field>
            ) : null}
            {form.kind === "close" || mode === "FROM_DATE" ? (
              <Field htmlFor="row-form-date" label={form.kind === "close" ? t("closeForm.date") : t("repriceForm.date")}>
                <Input
                  id="row-form-date"
                  type="date"
                  value={date}
                  min={form.kind === "close" ? active.effectiveFrom : undefined}
                  onChange={(e) => setDate(e.target.value)}
                  required
                  className="w-auto"
                />
              </Field>
            ) : null}
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={pending} data-testid="rate-card-row-form-submit">
                {form.kind === "close" ? t("closeForm.submit") : t("repriceForm.submit")}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setForm(null)} disabled={pending}>
                {tCommon("cancel")}
              </Button>
            </div>
          </div>
        </form>
      ) : null}
    </>
  );
}

export type ScopeOptions = {
  members: { id: string; name: string }[];
  projects: { id: string; label: string }[];
  services: { id: string; label: string }[];
};

const BILL_SCOPES: readonly RateScope[] = ["TENANT", "SERVICE", "PROJECT", "PROJECT_MEMBER", "MEMBER"];
const COST_SCOPES: readonly RateScope[] = ["TENANT", "MEMBER"];

/**
 * "Add a rate" — which is also "change a rate": with `closeOpen` (on by
 * default) the open card of the same dimension closes on the new card's
 * start date in the same transaction. The pinned wording sits under the
 * date, where the decision is made, and again in the success message.
 */
export function CreateRateCardForm({
  kind,
  options,
  currencies,
  defaultCurrency,
  today,
  returnTo,
  fixedScope,
}: {
  kind: RateKind;
  options: ScopeOptions;
  currencies: readonly string[];
  defaultCurrency: string;
  today: string;
  returnTo: string;
  /** The Agreements tab pins SERVICE and offers only that client's agreements. */
  fixedScope?: RateScope;
}) {
  const t = useTranslations("settings.rates");
  const [state, action, pending] = useActionState<RateFormState, FormData>(createRateCardAction, null);
  const scopes = fixedScope ? [fixedScope] : kind === "COST" ? COST_SCOPES : BILL_SCOPES;
  const [scope, setScope] = useState<RateScope>(scopes[0]!);
  const needsMember = scope === "MEMBER" || scope === "PROJECT_MEMBER";
  const needsProject = scope === "PROJECT" || scope === "PROJECT_MEMBER";
  const needsService = scope === "SERVICE";
  const prefix = `rate-${kind.toLowerCase()}`;

  return (
    <form action={action} className="flex flex-col gap-4" data-testid={`${prefix}-form`}>
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="returnTo" value={returnTo} />
      {/* A disabled control posts nothing: a pinned scope travels as a hidden field. */}
      {scopes.length === 1 ? <input type="hidden" name="scope" value={scope} /> : null}
      <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
        <Field htmlFor={`${prefix}-scope`} label={t("form.scope")}>
          <NativeSelect
            id={`${prefix}-scope`}
            name={scopes.length === 1 ? undefined : "scope"}
            value={scope}
            onChange={(e) => setScope(e.target.value as RateScope)}
            disabled={scopes.length === 1}
          >
            {scopes.map((s) => (
              <option key={s} value={s}>
                {s === "TENANT" ? t("workspaceDefault") : t(`scopes.${s}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {needsMember ? (
          <Field htmlFor={`${prefix}-member`} label={t("form.member")} required>
            <NativeSelect id={`${prefix}-member`} name="memberId" required defaultValue="">
              <option value="" disabled>
                {"—"}
              </option>
              {options.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
        ) : null}
        {needsProject ? (
          <Field htmlFor={`${prefix}-project`} label={t("form.project")} required>
            <NativeSelect id={`${prefix}-project`} name="projectId" required defaultValue="">
              <option value="" disabled>
                {"—"}
              </option>
              {options.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
        ) : null}
        {needsService ? (
          <Field htmlFor={`${prefix}-service`} label={t("form.agreement")} required>
            <NativeSelect
              id={`${prefix}-service`}
              name="serviceId"
              required
              defaultValue={options.services.length === 1 ? options.services[0]!.id : ""}
            >
              <option value="" disabled>
                {"—"}
              </option>
              {options.services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
        ) : null}
        <Field htmlFor={`${prefix}-amount`} label={t("form.amount")} required>
          <div className="flex gap-2">
            <Input
              id={`${prefix}-amount`}
              name="amount"
              type="text"
              inputMode="decimal"
              required
              pattern="^\d{1,10}([.,]\d{1,2})?$"
              className="num"
              data-testid={`${prefix}-amount`}
            />
            {/* Fixed, not auto: as a flex item the select shrank below "SEK". */}
            <NativeSelect name="currency" defaultValue={defaultCurrency} aria-label={t("form.currency")} className="w-24 shrink-0">
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </NativeSelect>
          </div>
        </Field>
        <Field htmlFor={`${prefix}-from`} label={t("form.from")} hint={t("form.pinned")} required>
          <Input id={`${prefix}-from`} name="effectiveFrom" type="date" defaultValue={today} required className="w-auto" />
        </Field>
      </div>
      <div className="flex items-start gap-2">
        <NativeCheckbox id={`${prefix}-replace`} name="closeOpen" defaultChecked className="mt-0.5" />
        <Label htmlFor={`${prefix}-replace`} className="font-normal">
          {t("form.replace")}
        </Label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending} data-testid={`${prefix}-submit`}>
          {kind === "COST" ? <span aria-hidden="true">{"✦"}</span> : <PlusIcon />}
          {pending ? t("form.submitting") : t("form.submit")}
        </Button>
        <FormMessage state={state} className="text-xs" />
      </div>
    </form>
  );
}

/**
 * The tenant's cost layer (finance.costRates.enabled, settings:edit):
 * off means cost and margin exist nowhere in the UI, whatever anyone's
 * permissions say. Neutral track on purpose (UI.md §10.2): the thumb's
 * position is the signal, not a brand stripe.
 */
export function CostLayerSwitch({ enabled, canEdit }: { enabled: boolean; canEdit: boolean }) {
  const t = useTranslations("settings.rates.cost");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [on, setOn] = useState(enabled);
  const flip = (next: boolean) => {
    setOn(next);
    start(async () => {
      const r = await setCostLayerAction({ enabled: next });
      if (!r.ok) {
        setOn(!next);
        toast.error(r.message);
        return;
      }
      toast.success(r.message);
      router.refresh();
    });
  };
  return (
    <div className="flex items-center gap-2">
      <Switch
        id="cost-layer"
        checked={on}
        disabled={!canEdit || pending}
        onCheckedChange={flip}
        aria-describedby="cost-layer-hint"
        className="data-checked:bg-(--tone-neutral-line)"
        data-testid="cost-layer-switch"
      />
      <Label htmlFor="cost-layer" className="font-normal">
        {on ? t("layerOn") : t("layerOff")}
      </Label>
    </div>
  );
}
