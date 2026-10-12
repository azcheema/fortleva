"use client";

import { CircleSlashIcon, PauseIcon, PlayIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";

import { AutoForm } from "@/components/auto-form";
import { InlineEdit, RowActions, StatusBadge, type RowAction } from "@/components/semantic";
import { Pending } from "@/components/semantic/field";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useRun } from "@/components/use-run";
import { isActionRedirect } from "@/lib/action-redirect";
import { withCurrentOption } from "@/lib/inline-edit";

import {
  deleteServiceAction,
  endServiceAction,
  setAgreementInvoicingAction,
  setAgreementRunningAction,
  updateAgreementAction,
} from "../actions";
import { DAY_MAX, DAY_MIN, type AgreementItem } from "./agreement-shape";

/** What the member may do with a row (the client loader's `service:*` caps). */
export type AgreementRowAbilities = { readonly edit: boolean; readonly delete: boolean };

/**
 * ONE AGREEMENT, read-first (slice 113; UI.md §5.11 FOUNDER MANDATE 1, the
 * Assets tab's row as the model): every value is text until edited, saved
 * through the row's `<AutoForm>`; its verbs — pause, run again, end, delete —
 * live in the row's menu (MANDATE 2).
 *
 * Its price and renewal date now matter beyond this page: the renewal date
 * moves on by itself once it has passed (`src/services/renewals.ts`), and
 * slice 113b drafts each renewal's invoice from the price. So both are
 * editable here, and a one-time agreement shows neither an interval nor a
 * renewal date (the service clears them when the billing changes).
 *
 * A REFUSED SAVE PUTS THE ROW BACK (the Assets tab's rule): the row posts all
 * of its fields on every save, so a refused value left in its hidden input
 * would fail every later save of the row too; a refusal is toasted
 * (AutoForm) and every value at rest is reseeded to the server's (`resetKey`).
 *
 * Pausing is reversible, so it acts on one click; ENDING is not (there is no
 * way back in the product) and DELETING is not, so both are danger items that
 * ask first — a `confirm` without the danger tone is dead string (AGENTS.md),
 * which is how "End service" used to act on one click.
 */
export function AgreementRow({
  clientId,
  item,
  can,
  currencies,
  defaultCurrency,
}: {
  clientId: string;
  item: AgreementItem;
  can: AgreementRowAbilities;
  currencies: readonly string[];
  defaultCurrency: string;
}) {
  const t = useTranslations("clients.services");
  const tCommon = useTranslations("common");
  const { run } = useRun();
  const readOnly = !can.edit;
  const recurring = item.kind === "RECURRING";

  const [resetKey, setResetKey] = useState(0);
  const track = () => ({ resetKey });

  const items: RowAction[] = [];
  if (can.edit && item.status === "ACTIVE") {
    items.push({
      key: "pause",
      label: t("row.pause"),
      icon: PauseIcon,
      onSelect: () => run(() => setAgreementRunningAction(clientId, item.id, false)),
    });
  }
  if (can.edit && item.status === "PAUSED") {
    items.push({
      key: "resume",
      label: t("row.resume"),
      icon: PlayIcon,
      onSelect: () => run(() => setAgreementRunningAction(clientId, item.id, true)),
    });
  }
  if (can.edit && item.status !== "ENDED") {
    items.push({
      key: "end",
      label: t("row.end"),
      icon: CircleSlashIcon,
      tone: "danger",
      confirm: t("row.endConfirm", { name: item.name }),
      onSelect: () => run(() => endServiceAction(clientId, item.id)),
    });
  }
  if (can.delete) {
    items.push({
      key: "delete",
      label: t("row.delete"),
      icon: Trash2Icon,
      tone: "danger",
      confirm: t("row.deleteConfirm", { name: item.name }),
      onSelect: () => run(() => deleteServiceAction(clientId, item.id)),
    });
  }

  /** One labelled property: a fixed-width label, the read-first value beside it. */
  const prop = (label: string, value: React.ReactNode) => (
    <div className="flex min-w-0 items-center gap-2">
      <dt className="w-32 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-1 items-center gap-1">{value}</dd>
    </div>
  );

  const shownCurrency = item.currency ?? defaultCurrency;

  const body = (
    <>
      <div className="flex min-w-0 items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <InlineEdit
            kind="text"
            name="name"
            value={item.name}
            label={t("row.name")}
            placeholder={item.name}
            readOnly={readOnly}
            density="table"
            fit
            inputProps={{ required: true, maxLength: 200 }}
            controlClassName="font-medium"
            display={<span className="font-medium">{item.name}</span>}
            {...track()}
          />
          {item.project ? <Badge variant="outline">{item.project.key}</Badge> : null}
          {item.status !== "ACTIVE" ? <StatusBadge domain="serviceStatus" value={item.status} /> : null}
        </div>
        {items.length > 0 ? <RowActions label={tCommon("actionsFor", { name: item.name })} items={items} /> : null}
      </div>
      <dl className="grid min-w-0 gap-x-4 gap-y-1 sm:grid-cols-2">
        {/* Billing is TEXT, never a control (the code review's low): a select
            saves on change, and one arrow key on a focused one would turn a
            recurring agreement one-time — clearing its interval and its
            renewal date with no question. Set when the agreement is added. */}
        {prop(t("row.billing"), <span className="px-2.5 text-sm">{t(`kinds.${item.kind}`)}</span>)}
        {recurring
          ? prop(
              t("interval"),
              <InlineEdit
                kind="select"
                name="billingInterval"
                value={item.billingInterval ?? "MONTHLY"}
                label={t("interval")}
                placeholder={t(`intervals.${item.billingInterval ?? "MONTHLY"}`)}
                options={[
                  { value: "MONTHLY", label: t("intervals.MONTHLY") },
                  { value: "QUARTERLY", label: t("intervals.QUARTERLY") },
                  { value: "YEARLY", label: t("intervals.YEARLY") },
                ]}
                readOnly={readOnly}
                density="table"
                {...track()}
              />,
            )
          : null}
        {prop(
          t("row.price"),
          <>
            {/* The amount, then its currency beside it ("1 200,00 SEK"), as an
                asset's cost: the currency is drawn only with a price — as its
                select when the row is editable, as text when it is not. */}
            <InlineEdit
              kind="text"
              name="priceExVat"
              value={item.price ?? ""}
              label={t("row.price")}
              placeholder={tCommon("notSet")}
              display={
                item.priceLabel ? (
                  <span className="num">{readOnly ? `${item.priceLabel} ${shownCurrency}` : item.priceLabel}</span>
                ) : undefined
              }
              readOnly={readOnly}
              density="table"
              fit
              inputProps={{ maxLength: 16, inputMode: "decimal", autoComplete: "off" }}
              {...track()}
            />
            {!readOnly && item.price !== null ? (
              <InlineEdit
                kind="select"
                name="currency"
                value={item.currency ?? ""}
                label={t("row.currency")}
                placeholder={tCommon("notSet")}
                // A stored currency outside the offered list stays a choice, or
                // the select would open on another and every save rewrite it.
                // No currency of its own is its own choice, "Not set" (slice
                // 113b's re-check): picking the workspace's currency must be a
                // change — renewal invoices are drafted only with one set.
                options={[
                  ...(item.currency === null ? [{ value: "", label: tCommon("notSet") }] : []),
                  ...withCurrentOption(
                    currencies.map((c) => ({ value: c, label: c })),
                    item.currency ?? "",
                    item.currency,
                  ),
                ]}
                density="table"
                fit
                {...track()}
              />
            ) : null}
          </>,
        )}
        {recurring
          ? prop(
              t("row.renewsOn"),
              <InlineEdit
                kind="date"
                name="renewsAt"
                value={item.renewsOn ?? ""}
                label={t("row.renewsOn")}
                placeholder={tCommon("notSet")}
                display={item.renewsLabel ? <span className="num">{item.renewsLabel}</span> : undefined}
                readOnly={readOnly}
                density="table"
                inputProps={{ min: DAY_MIN, max: DAY_MAX }}
                {...track()}
              />,
            )
          : null}
        {prop(
          t("row.endsOn"),
          <InlineEdit
            kind="date"
            name="endsAt"
            value={item.endsOn ?? ""}
            label={t("row.endsOn")}
            placeholder={tCommon("notSet")}
            display={item.endsLabel ? <span className="num">{item.endsLabel}</span> : undefined}
            // An ENDED agreement's end is the day it was ended: kept, never
            // moved on or cleared afterwards (the code review's low).
            readOnly={readOnly || item.status === "ENDED"}
            density="table"
            inputProps={{ min: DAY_MIN, max: DAY_MAX }}
            {...track()}
          />,
        )}
        {item.rate !== undefined
          ? prop(
              t("row.rate"),
              <span className="num px-2.5 text-sm" data-testid="agreement-rate">
                {item.rate ?? <span className="text-muted-foreground">{"—"}</span>}
              </span>,
            )
          : null}
        {prop(
          t("row.thisMonth"),
          <span className="num px-2.5 text-sm text-muted-foreground" data-testid="agreement-usage">
            {item.thisMonth ?? "—"}
          </span>,
        )}
      </dl>
    </>
  );

  // "Invoice each renewal" sits OUTSIDE the row's AutoForm: a switch inside a
  // form renders a checkbox the form would save the whole row on.
  // Never on an ended agreement: nothing renews (the code review of 113b).
  const invoicing =
    recurring && item.status !== "ENDED" ? (
      <AgreementInvoicing
        clientId={clientId}
        serviceId={item.id}
        on={item.invoiceRenewals}
        priced={item.price !== null && Number(item.price) > 0}
        hasCurrency={item.currency !== null}
        canEdit={can.edit}
      />
    ) : null;

  return (
    <li className="flex flex-col gap-2 px-3 py-3" data-testid="agreement-item" data-name={item.name} data-agreement-id={item.id}>
      {readOnly ? (
        <div className="flex flex-col gap-2">{body}</div>
      ) : (
        <AutoForm action={updateAgreementAction} className="flex flex-col gap-2" onError={() => setResetKey((k) => k + 1)}>
          <input type="hidden" name="clientId" value={clientId} />
          <input type="hidden" name="serviceId" value={item.id} />
          {/* The date this row was drawn with: the job may move it on while the
              page is open, and a save of another field must not put it back. */}
          {recurring ? <input type="hidden" name="renewsAtWas" value={item.renewsOn ?? ""} /> : null}
          {/* …and the end date: ending writes it from the row menu, so a page
              loaded before an End must not post the old one back. */}
          <input type="hidden" name="endsAtWas" value={item.endsOn ?? ""} />
          {/* …and the currency its select was drawn with (the default when the
              agreement has none): only a currency the member picks is saved. */}
          {item.price !== null ? <input type="hidden" name="currencyWas" value={item.currency ?? ""} /> : null}
          {body}
        </AutoForm>
      )}
      {invoicing}
    </li>
  );
}

/**
 * "INVOICE EACH RENEWAL" (Phase 4 slice 113b; founder decision C88 (e)) — ON
 * by default: 14 days before the agreement renews, Fortleva drafts that
 * period's invoice onto the client's renewal draft. OFF — an agreement the
 * client pays another way — it drafts nothing. `service:edit`. The switch
 * draws the SERVER's state (the action revalidates the page) and is never
 * optimistic, as "Remind before it ends"; a refusal is a toast, never a
 * silent revert (AGENTS.md); guarded on its own `busy`.
 */
function AgreementInvoicing({
  clientId,
  serviceId,
  on,
  priced,
  hasCurrency,
  canEdit,
}: {
  clientId: string;
  serviceId: string;
  /** The server's answer. */
  on: boolean;
  /** A price above zero — the job drafts nothing without one. */
  priced: boolean;
  /** A currency of its own — the job drafts nothing without one (it would bill in whatever the default became). */
  hasCurrency: boolean;
  canEdit: boolean;
}) {
  const t = useTranslations("clients.services.invoicing");
  const tCommon = useTranslations("common");
  const id = useId();
  const [busy, setBusy] = useState(false);

  const set = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await setAgreementInvoicingAction(clientId, serviceId, next);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(r.message);
    } catch (e) {
      if (isActionRedirect(e)) return;
      toast.error(t("unreachable"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-input p-2.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <Label htmlFor={id} className="text-sm">
          {t("label")}
        </Label>
        <span className="text-xs text-muted-foreground" data-testid="agreement-invoicing-state">
          {!on ? t("off") : !priced ? t("noPrice") : !hasCurrency ? t("noCurrency") : t("on")}
        </span>
      </div>
      {busy ? <Pending label={tCommon("loading")} className="mt-1" /> : null}
      <Switch
        id={id}
        checked={on}
        disabled={!canEdit || busy}
        onCheckedChange={(next) => void set(next)}
        className="mt-1"
        data-testid="agreement-invoicing-switch"
      />
    </div>
  );
}
