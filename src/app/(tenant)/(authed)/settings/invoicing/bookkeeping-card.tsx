"use client";

import { useFormatter, useTranslations } from "next-intl";
import { Fragment, useState } from "react";

import { InlineEdit } from "@/components/semantic";
import { useRun } from "@/components/use-run";
import {
  ACCOUNT_ROLES,
  BOOKKEEPING_DEFAULTS,
  BOOKKEEPING_METHODS,
  type BookkeepingField,
  type BookkeepingSettings,
} from "@/modules/invoicing/bookkeeping-accounts";

import { updateBookkeepingAction } from "./actions";

/**
 * Settings → Invoicing → Bookkeeping (Phase 4 slice 111; founder decision
 * C82): how the bookkeeping file books — the method (asked before the first
 * file, fixed once one exists), the month the financial year starts, the
 * voucher series, and the accounts with their BAS defaults. Each field saves
 * itself; a refusal puts that field back and the toast says why (the draft
 * details' pattern — never a revert that looks like one).
 */
export function BookkeepingCard({
  values,
  editable,
  methodFixed,
}: {
  values: BookkeepingSettings;
  editable: boolean;
  methodFixed: boolean;
}) {
  const t = useTranslations("settings.invoicing.bookkeeping");
  const format = useFormatter();
  const { run } = useRun();
  const [resets, setResets] = useState<Partial<Record<BookkeepingField, number>>>({});
  const bump = (name: BookkeepingField) => setResets((r) => ({ ...r, [name]: (r[name] ?? 0) + 1 }));

  const save = (name: BookkeepingField, next: string) =>
    run(async () => {
      const r = await updateBookkeepingAction({ [name]: next });
      if (!r.ok) bump(name);
      return r;
    });

  const prop = (label: string, control: React.ReactNode, hint?: string) => (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="px-2.5 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{control}</dd>
      {hint ? <p className="px-2.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );

  const ro = !editable;
  const methodLabel = (m: string) => (m === "INVOICE" || m === "CASH" ? t(`method.${m}`) : t("method.placeholder"));
  const month = (m: number) => format.dateTime(new Date(Date.UTC(2026, m - 1, 1)), { month: "long", timeZone: "UTC" });
  const text = (name: BookkeepingField, label: string, maxLength: number, numeric: boolean) =>
    prop(
      label,
      <InlineEdit
        kind="text"
        name={name}
        value={values[name]}
        label={label}
        placeholder={BOOKKEEPING_DEFAULTS[name]}
        display={<span className="num">{values[name]}</span>}
        readOnly={ro}
        hiddenInput={false}
        resetKey={resets[name] ?? 0}
        className={ro ? "px-2.5" : undefined}
        inputProps={{ maxLength, ...(numeric ? { inputMode: "numeric" as const, pattern: "[0-9]*" } : {}) }}
        onCommit={(next) => save(name, next)}
      />,
    );

  return (
    <div className="flex flex-col gap-4" data-testid="bookkeeping-settings">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        {prop(
          t("method.label"),
          <InlineEdit
            kind="select"
            name="method"
            value={values.method}
            label={t("method.label")}
            placeholder={methodLabel(values.method)}
            display={methodLabel(values.method)}
            options={BOOKKEEPING_METHODS.map((m) => ({ value: m, label: methodLabel(m) }))}
            readOnly={ro || methodFixed}
            hiddenInput={false}
            resetKey={resets.method ?? 0}
            className={ro || methodFixed ? "px-2.5" : undefined}
            onCommit={(next) => {
              if (next !== values.method) save("method", next);
            }}
          />,
          methodFixed ? t("method.fixed") : undefined,
        )}
        {prop(
          t("yearStart.label"),
          <InlineEdit
            kind="select"
            name="yearStart"
            value={values.yearStart}
            label={t("yearStart.label")}
            placeholder={month(Number(values.yearStart) || 1)}
            display={month(Number(values.yearStart) || 1)}
            options={Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: month(i + 1) }))}
            readOnly={ro}
            hiddenInput={false}
            resetKey={resets.yearStart ?? 0}
            className={ro ? "px-2.5" : undefined}
            onCommit={(next) => {
              if (next !== values.yearStart) save("yearStart", next);
            }}
          />,
        )}
        {text("series", t("series.label"), 10, false)}
      </dl>
      <div className="flex flex-col gap-2">
        <h3 className="px-2.5 text-xs font-medium text-muted-foreground">{t("accounts.title")}</h3>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          {ACCOUNT_ROLES.map((role) => (
            <Fragment key={role}>{text(role, t(`accounts.${role}`), 4, true)}</Fragment>
          ))}
        </dl>
        <p className="px-2.5 text-xs text-muted-foreground">{t("hint")}</p>
      </div>
    </div>
  );
}
