"use client";

import { useTranslations } from "next-intl";
import { startTransition, useActionState, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { FormResult } from "@/lib/server-actions";
import type { AssetType } from "@/modules/vault";

import { createAssetAction } from "./actions";
import { assetFieldLabelKey, DAY_MAX, DAY_MIN, type AssetFieldsByType } from "./asset-shape";

/** One place a new asset may hang: `""` for the client as a whole, else a project id. */
export type AssetWhereOption = { readonly value: string; readonly label: string };

const FIRST_TYPE: AssetType = "DOMAIN";

/**
 * ADD AN ASSET — inline, never a modal (UI.md rule 1). The type picks the
 * few extra facts asked for (nameservers for a domain, seats for a
 * licence…). `where` lists the places it may hang, as the page knows them:
 * the client itself (offered only to a member assigned to the client
 * directly — the service would refuse anyone else, AUTHZ §4) and its live
 * projects. With ONE place there is nothing to choose, but the place is
 * still SAID, and the name field carries that line as its description —
 * the vault form's rule (slice 86's reviews).
 *
 * NOT A `<form action>`: React 19 resets such a form after EVERY action,
 * a refusal included, so one mistyped web address would have emptied ten
 * typed fields under the member while showing them why (the code review;
 * UI.md says the same of the portal's forms). The submit is dispatched in
 * a transition instead, and the form is reset only on success — where the
 * uncontrolled type select goes back to its default and the fields it asks
 * for must follow (`onReset`).
 */
export function AddAssetForm({
  clientId,
  where,
  types,
  fieldsByType,
  currencies,
  defaultCurrency,
}: {
  clientId: string;
  /** At least one; the first is the default. */
  where: readonly AssetWhereOption[];
  types: readonly AssetType[];
  fieldsByType: AssetFieldsByType;
  currencies: readonly string[];
  defaultCurrency: string;
}) {
  const t = useTranslations("assets");
  const [type, setType] = useState<AssetType>(FIRST_TYPE);
  const [state, action, pending] = useActionState<FormResult | null, FormData>(createAssetAction, null);
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const whereId = useId();
  const fixedWhere = where.length === 1 ? whereId : undefined;

  useEffect(() => {
    if (state?.ok) {
      toast.success(state.message);
      formRef.current?.reset();
      nameRef.current?.focus();
    }
  }, [state]);

  return (
    <form
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(() => action(fd));
      }}
      onReset={() => setType(FIRST_TYPE)}
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      data-testid="add-asset"
    >
      <input type="hidden" name="clientId" value={clientId} />
      <Field label={t("add.type")} htmlFor="as-type">
        <NativeSelect
          id="as-type"
          name="type"
          defaultValue={FIRST_TYPE}
          onChange={(e) => setType(e.target.value as AssetType)}
          disabled={pending}
        >
          {types.map((k) => (
            <option key={k} value={k}>
              {t(`types.${k}`)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {where.length === 1 ? (
        <p id={whereId} className="self-end pb-1.5 text-sm text-muted-foreground" data-testid="add-asset-where">
          <input type="hidden" name="projectId" value={where[0]!.value} />
          {t("add.whereFixed", { place: where[0]!.label })}
        </p>
      ) : (
        <Field label={t("add.where")} htmlFor="as-where">
          <NativeSelect id="as-where" name="projectId" defaultValue={where[0]?.value} disabled={pending}>
            {where.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
      )}
      <Field label={t("row.name")} htmlFor="as-name" hint={t(`add.nameHint.${type}`)} required>
        <Input
          id="as-name"
          ref={nameRef}
          name="name"
          required
          maxLength={200}
          autoComplete="off"
          aria-describedby={fixedWhere}
          disabled={pending}
        />
      </Field>
      <Field label={t("row.provider")} htmlFor="as-provider" hint={t("add.providerHint")}>
        <Input id="as-provider" name="provider" maxLength={200} autoComplete="off" disabled={pending} />
      </Field>
      <Field label={t("row.identifier")} htmlFor="as-identifier" hint={t(`add.identifierHint.${type}`)}>
        <Input id="as-identifier" name="identifier" maxLength={255} autoComplete="off" spellCheck={false} disabled={pending} />
      </Field>
      <Field label={t("row.url")} htmlFor="as-url">
        <Input id="as-url" name="url" inputMode="url" maxLength={2048} autoComplete="off" disabled={pending} />
      </Field>
      <Field label={t("row.expiresAt")} htmlFor="as-expires">
        <Input id="as-expires" name="expiresAt" type="date" min={DAY_MIN} max={DAY_MAX} className="num" disabled={pending} />
      </Field>
      <Field label={t("row.autoRenew")} htmlFor="as-auto">
        <NativeSelect id="as-auto" name="autoRenew" defaultValue="" disabled={pending}>
          <option value="">{t("autoRenew.unknown")}</option>
          <option value="yes">{t("autoRenew.yes")}</option>
          <option value="no">{t("autoRenew.no")}</option>
        </NativeSelect>
      </Field>
      <div className="grid grid-cols-[1fr_auto] gap-3">
        <Field label={t("row.renewalCost")} htmlFor="as-cost">
          <Input id="as-cost" name="renewalCost" inputMode="decimal" maxLength={16} className="num" autoComplete="off" disabled={pending} />
        </Field>
        <Field label={t("row.currency")} htmlFor="as-currency">
          <NativeSelect id="as-currency" name="currency" defaultValue={defaultCurrency} disabled={pending}>
            {currencies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      {fieldsByType[type].map(({ key, kind }) => (
        <Field
          key={`${type}-${key}`}
          label={t(assetFieldLabelKey(key))}
          htmlFor={`as-field-${key}`}
          hint={kind === "list" ? t("add.listHint") : undefined}
        >
          <Input
            id={`as-field-${key}`}
            name={`field.${key}`}
            inputMode={kind === "count" ? "numeric" : undefined}
            className={kind === "count" ? "num" : undefined}
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
          />
        </Field>
      ))}
      <Field label={t("row.notes")} htmlFor="as-notes" hint={t("add.notesHint")} className="sm:col-span-2">
        <Textarea id="as-notes" name="notes" rows={2} maxLength={5000} disabled={pending} />
      </Field>
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button type="submit" disabled={pending}>
          {pending ? t("add.adding") : t("add.submit")}
        </Button>
        {state && !state.ok ? <FormMessage state={state} /> : null}
      </div>
    </form>
  );
}
