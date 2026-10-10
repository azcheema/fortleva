"use client";

import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { InlineConfirm, InlineEdit } from "@/components/semantic";
import { Switch } from "@/components/ui/switch";
import { useRun } from "@/components/use-run";
import type { FormResult } from "@/lib/server-actions";
import { VAT_PROFILES, VAT_RATES, type VatProfile } from "@/modules/invoicing/vat";

import { setVatProfileAction, updateDraftDetailsAction } from "../actions";

export type DraftDetailsValues = {
  readonly vatProfile: VatProfile;
  readonly currency: string;
  readonly paymentTermsDays: number;
  readonly projectId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly buyerReference: string;
  readonly ourReference: string;
  readonly note: string;
  /** "" — the client's language (C76 (e)) — or "sv" / "en". */
  readonly locale: string;
  /** Slice 109 (C79 (c), (f)): the Pay now link, or "" — an invoice's only. */
  readonly payLinkUrl: string;
};

/**
 * THE DRAFT'S DETAILS (Phase 4 slice 107) — each value read-first and saved
 * on its own commit (the time grid's pattern: a standalone `<InlineEdit>`
 * that calls its action with a one-field patch), so one refused value never
 * poisons another. A refusal is toasted and that value goes back to what is
 * saved (`resetKey` per field).
 *
 * THE VAT TREATMENT asks first when changing it would take a line off a rate
 * it cannot keep at 12 or 6 % (only Swedish VAT has those): the select shows
 * the choice, an inline question says how many lines change, and "No" puts
 * the select back (the design review's low). Every other change acts at once
 * — a line at 0 % becomes 25 % and back without losing anything.
 *
 * A CREDIT NOTE's draft (slice 108b) shows its VAT treatment, currency,
 * language, project and work period read-only — they are its invoice's, and
 * the guard holds them — and no payment terms (it asks no one to pay); only
 * the references and the note are its own.
 *
 * THE TIME BREAKDOWN (slice 110b; C80 (d)) is a switch, an INVOICE's only and
 * only where it means something — the draft holds hours, or the switch is on
 * (so it can be turned off). Bound to the SERVER value (`useRun`: a refusal is
 * toasted, never a flick back); the page re-renders with its preview card.
 */
export function DraftDetails({
  invoiceId,
  values,
  editable,
  currencies,
  projects,
  reducedRateLines,
  clientLocale,
  creditNote,
  hoursBreakdown,
}: {
  invoiceId: string;
  values: DraftDetailsValues;
  editable: boolean;
  currencies: readonly string[];
  projects: readonly { readonly id: string; readonly key: string; readonly name: string; readonly archived?: boolean }[];
  /** Lines at 12 or 6 % — what leaving Swedish VAT would change. */
  reducedRateLines: number;
  /** The language the client's invoices take when the draft makes no choice. */
  clientLocale: "sv" | "en";
  /** A credit note: its invoice's terms, read-only (slice 108b). */
  creditNote: boolean;
  /** Slice 110b: the time breakdown tick, and whether the draft holds hours at all. Null for a credit note. */
  hoursBreakdown: { readonly on: boolean; readonly available: boolean } | null;
}) {
  const t = useTranslations("invoices.draft");
  const tCommon = useTranslations("common");
  const { run } = useRun();
  const breakdown = useRun();
  const [resets, setResets] = useState<Record<string, number>>({});
  const [askingFor, setAskingFor] = useState<VatProfile | null>(null);
  const vatRef = useRef<HTMLDivElement>(null);
  const questionRef = useRef<HTMLDivElement>(null);
  const confirmedRef = useRef(false);
  /**
   * When the question goes, focus goes back to the VAT select — but only if
   * it would otherwise fall to the page (it was inside the question, or is
   * already on <body>): a member who left the question by clicking another
   * field keeps that field (the code review's low).
   */
  const returnFocus = () => {
    const active = document.activeElement;
    if (active && active !== document.body && !questionRef.current?.contains(active)) return;
    requestAnimationFrame(() => vatRef.current?.querySelector<HTMLElement>("button, select")?.focus());
  };
  const bump = (name: string) => setResets((r) => ({ ...r, [name]: (r[name] ?? 0) + 1 }));
  const ro = !editable;
  /** What a credit note keeps from its invoice. */
  const fixed = ro || creditNote;

  /** Run a one-field save; on refusal put that field back. */
  const save = (name: string, call: () => Promise<FormResult>) =>
    run(async () => {
      const r = await call();
      if (!r.ok) bump(name);
      return r;
    });

  const detail = (name: keyof DraftDetailsValues, next: string) =>
    save(name, () => updateDraftDetailsAction(invoiceId, { [name]: next }));

  const changeProfile = (next: VatProfile) =>
    save("vatProfile", () => setVatProfileAction(invoiceId, next));

  const prop = (label: string, control: React.ReactNode, wide = false) => (
    <div className={wide ? "flex min-w-0 flex-col gap-0.5 sm:col-span-2" : "flex min-w-0 flex-col gap-0.5"}>
      <dt className="px-2.5 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{control}</dd>
    </div>
  );

  const projectOptions = [
    { value: "", label: t("noProject") },
    ...projects.map((p) => ({
      value: p.id,
      label: p.archived ? t("projectOptionArchived", { key: p.key, name: p.name }) : t("projectOption", { key: p.key, name: p.name }),
    })),
  ];
  const vatLabel = (p: VatProfile) => t(`vat.profiles.${p}`);

  return (
    <div className="flex flex-col gap-3" data-testid="draft-details">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        {prop(
          t("vat.label"),
          <div ref={vatRef} className="min-w-0">
          <InlineEdit
            kind="select"
            name="vatProfile"
            // The SAVED treatment, also while the question is open: re-keying
            // the control on the pending pick would remount it and drop focus.
            value={values.vatProfile}
            label={t("vat.label")}
            placeholder={vatLabel(values.vatProfile)}
            options={VAT_PROFILES.map((p) => ({ value: p, label: vatLabel(p) }))}
            readOnly={fixed}
            hiddenInput={false}
            resetKey={resets.vatProfile ?? 0}
            className={fixed ? "px-2.5" : undefined}
            onCommit={(next) => {
              const profile = VAT_PROFILES.find((p) => p === next);
              if (!profile || profile === values.vatProfile) return;
              const losing = values.vatProfile === "SE_DOMESTIC" && !VAT_RATES[profile].includes(1200n) ? reducedRateLines : 0;
              if (losing > 0) {
                setAskingFor(profile);
                return;
              }
              changeProfile(profile);
            }}
          />
          </div>,
          true,
        )}
        {askingFor ? (
          <div ref={questionRef} className="sm:col-span-2" data-testid="vat-question">
            <InlineConfirm
              label={t("vat.change")}
              question={t("vat.question", { count: reducedRateLines, profile: vatLabel(askingFor) })}
              trigger="none"
              asking
              onAskingChange={(asking) => {
                if (asking) return;
                // InlineConfirm reports "no longer asking" BEFORE it calls
                // onConfirm, so this waits a microtask to know which it was:
                // only a real cancel puts the select back (the code review's
                // medium — a Yes that reset the select read as a revert).
                queueMicrotask(() => {
                  if (confirmedRef.current) {
                    confirmedRef.current = false;
                    return;
                  }
                  setAskingFor(null);
                  bump("vatProfile");
                  returnFocus();
                });
              }}
              onConfirm={() => {
                confirmedRef.current = true;
                const profile = askingFor;
                setAskingFor(null);
                changeProfile(profile);
                returnFocus();
              }}
            />
          </div>
        ) : null}
        {prop(
          t("fields.currency"),
          <InlineEdit
            kind="select"
            name="currency"
            value={values.currency}
            label={t("fields.currency")}
            placeholder={values.currency}
            options={currencies.map((c) => ({ value: c, label: c }))}
            readOnly={fixed}
            hiddenInput={false}
            resetKey={resets.currency ?? 0}
            className={fixed ? "px-2.5" : undefined}
            onCommit={(next) => detail("currency", next)}
          />,
        )}
        {creditNote ? null : prop(
          t("fields.paymentTermsDays"),
          <InlineEdit
            kind="text"
            name="paymentTermsDays"
            value={String(values.paymentTermsDays)}
            label={t("fields.paymentTermsDays")}
            placeholder={String(values.paymentTermsDays)}
            display={<span className="num">{t("days", { days: values.paymentTermsDays })}</span>}
            readOnly={ro}
            hiddenInput={false}
            inputProps={{ inputMode: "numeric", maxLength: 3, pattern: "[0-9]*" }}
            resetKey={resets.paymentTermsDays ?? 0}
            className={ro ? "px-2.5" : undefined}
            onCommit={(next) => detail("paymentTermsDays", next)}
          />,
        )}
        {prop(
          t("fields.locale"),
          <InlineEdit
            kind="select"
            name="locale"
            value={values.locale}
            label={t("fields.locale")}
            placeholder={t("locale.client", { language: t(`locale.names.${clientLocale}`) })}
            options={[
              { value: "", label: t("locale.client", { language: t(`locale.names.${clientLocale}`) }) },
              { value: "sv", label: t("locale.sv") },
              { value: "en", label: t("locale.en") },
            ]}
            readOnly={fixed}
            hiddenInput={false}
            resetKey={resets.locale ?? 0}
            className={fixed ? "px-2.5" : undefined}
            onCommit={(next) => detail("locale", next)}
          />,
        )}
        {prop(
          t("fields.project"),
          <InlineEdit
            kind="select"
            name="projectId"
            value={values.projectId}
            label={t("fields.project")}
            placeholder={t("noProject")}
            options={projectOptions}
            readOnly={fixed}
            hiddenInput={false}
            resetKey={resets.projectId ?? 0}
            className={fixed ? "px-2.5" : undefined}
            onCommit={(next) => detail("projectId", next)}
          />,
        )}
        {prop(
          t("fields.periodStart"),
          <InlineEdit
            kind="date"
            name="periodStart"
            value={values.periodStart}
            label={t("fields.periodStart")}
            placeholder={tCommon("notSet")}
            readOnly={fixed}
            hiddenInput={false}
            inputProps={{ min: "2000-01-01", max: "2199-12-31" }}
            resetKey={resets.periodStart ?? 0}
            className={fixed ? "px-2.5" : undefined}
            onCommit={(next) => detail("periodStart", next)}
          />,
        )}
        {prop(
          t("fields.periodEnd"),
          <InlineEdit
            kind="date"
            name="periodEnd"
            value={values.periodEnd}
            label={t("fields.periodEnd")}
            placeholder={tCommon("notSet")}
            readOnly={fixed}
            hiddenInput={false}
            inputProps={{ min: "2000-01-01", max: "2199-12-31" }}
            resetKey={resets.periodEnd ?? 0}
            className={fixed ? "px-2.5" : undefined}
            onCommit={(next) => detail("periodEnd", next)}
          />,
        )}
        {prop(
          t("fields.buyerReference"),
          <InlineEdit
            kind="text"
            name="buyerReference"
            value={values.buyerReference}
            label={t("fields.buyerReference")}
            placeholder={tCommon("notSet")}
            readOnly={ro}
            hiddenInput={false}
            inputProps={{ maxLength: 100, autoComplete: "off" }}
            resetKey={resets.buyerReference ?? 0}
            className={ro ? "px-2.5" : undefined}
            onCommit={(next) => detail("buyerReference", next)}
          />,
        )}
        {prop(
          t("fields.ourReference"),
          <InlineEdit
            kind="text"
            name="ourReference"
            value={values.ourReference}
            label={t("fields.ourReference")}
            placeholder={tCommon("notSet")}
            readOnly={ro}
            hiddenInput={false}
            inputProps={{ maxLength: 100, autoComplete: "off" }}
            resetKey={resets.ourReference ?? 0}
            className={ro ? "px-2.5" : undefined}
            onCommit={(next) => detail("ourReference", next)}
          />,
        )}
        {prop(
          t("fields.note"),
          <InlineEdit
            kind="multiline"
            name="note"
            value={values.note}
            label={t("fields.note")}
            placeholder={t("notePlaceholder")}
            readOnly={ro}
            hiddenInput={false}
            resetKey={resets.note ?? 0}
            className={ro ? "px-2.5" : "min-w-0"}
            onCommit={(next) => detail("note", next)}
          />,
          true,
        )}
        {/* Slice 109 (C79 (c), (f)): a Stripe or PayPal link for this
            invoice's amount — the Pay now button in its email and the
            client's portal, never printed on the PDF; fixed at issue, and
            issuing one asks for the issuer's code (C79 (g)). A credit note
            asks no one to pay. */}
        {creditNote ? null : (
          <div className="flex min-w-0 flex-col gap-0.5 sm:col-span-2" data-testid="pay-link">
            <dt className="px-2.5 text-xs text-muted-foreground">{t("fields.payLinkUrl")}</dt>
            <dd className="min-w-0">
              <InlineEdit
                kind="text"
                name="payLinkUrl"
                value={values.payLinkUrl}
                label={t("fields.payLinkUrl")}
                placeholder={ro ? t("payLinkNone") : t("payLinkPlaceholder")}
                display={values.payLinkUrl ? <span className="break-all">{values.payLinkUrl}</span> : undefined}
                readOnly={ro}
                hiddenInput={false}
                inputProps={{ maxLength: 500, inputMode: "url", autoComplete: "off", spellCheck: false }}
                resetKey={resets.payLinkUrl ?? 0}
                className={ro ? "px-2.5" : "min-w-0"}
                onCommit={(next) => detail("payLinkUrl", next)}
              />
              {ro ? null : <p className="mt-1 px-2.5 text-xs text-muted-foreground">{t("payLinkHint")}</p>}
            </dd>
          </div>
        )}
        {hoursBreakdown && (hoursBreakdown.available || hoursBreakdown.on) ? (
          <div className="flex min-w-0 flex-col gap-0.5 sm:col-span-2" data-testid="include-hours">
            <dt className="px-2.5 text-xs text-muted-foreground">
              {ro ? t("fields.includeHours") : <label htmlFor={`include-hours-${invoiceId}`}>{t("fields.includeHours")}</label>}
            </dt>
            <dd className="flex min-w-0 items-start gap-3 px-2.5">
              {ro ? (
                <span className="text-sm">{hoursBreakdown.on ? t("includeHoursOn") : t("includeHoursOff")}</span>
              ) : (
                <Switch
                  id={`include-hours-${invoiceId}`}
                  checked={hoursBreakdown.on}
                  // NOT disabled while a save is pending, only refused: a
                  // disabled control drops keyboard focus to <body>, where
                  // every single-key shortcut acts (the code review's low;
                  // `settings/vault/vault-switch.tsx`'s precedent).
                  aria-busy={breakdown.pending}
                  aria-describedby={`include-hours-hint-${invoiceId}`}
                  onCheckedChange={(v) => {
                    if (breakdown.pending) return;
                    breakdown.run(() => updateDraftDetailsAction(invoiceId, { includeHours: v }));
                  }}
                  className="mt-0.5"
                />
              )}
              {ro ? null : (
                <p id={`include-hours-hint-${invoiceId}`} className="min-w-0 text-xs text-muted-foreground">
                  {hoursBreakdown.available ? t("includeHoursHint") : t("includeHoursNoHours")}
                </p>
              )}
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}
