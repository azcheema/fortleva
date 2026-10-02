"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { FormResult } from "@/lib/server-actions";
import type { CredentialType } from "@/modules/vault";

import { createCredentialAction } from "./actions";
import { fieldLabelKey, isMultilineSecret, type FieldsByType } from "./vault-shape";

export type WhereOption = { readonly value: string; readonly label: string };

/**
 * ADD A LOGIN — inline, never a modal (UI.md rule 1). The type picks which
 * secret fields are asked for; a project picks where it hangs (or the
 * client itself, offered only to a member assigned to the client directly
 * — the service would refuse anyone else, AUTHZ §4).
 *
 * The secret inputs are TEXT inputs masked by `secret-mask`, never
 * `type="password"`: a password field makes the browser offer to save the
 * client's secret into the MEMBER's password manager, or to update the
 * member's own saved Fortleva password with it (slice 85's security
 * review). A note and a private key are text, typed in a textarea.
 */
export function AddCredentialForm({
  clientId,
  where,
  types,
  fieldsByType,
}: {
  clientId: string;
  /** "client" (when allowed) and the client's live projects in scope. */
  where: readonly WhereOption[];
  types: readonly CredentialType[];
  fieldsByType: FieldsByType;
}) {
  const t = useTranslations("clients.vault");
  const tVault = useTranslations("vault");
  const [type, setType] = useState<CredentialType>("LOGIN");
  const [state, action, pending] = useActionState<FormResult | null, FormData>(createCredentialAction, null);
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

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
      action={action}
      // React resets a form after its action (AGENTS.md's trap), which puts
      // the UNCONTROLLED type select back on LOGIN: the fields it asks for
      // must follow, or a reset form would post one type with another's keys.
      onReset={() => setType("LOGIN")}
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      data-testid="add-credential"
    >
      <input type="hidden" name="clientId" value={clientId} />
      <Field label={t("add.type")} htmlFor="vc-type">
        <NativeSelect
          id="vc-type"
          name="type"
          defaultValue="LOGIN"
          onChange={(e) => setType(e.target.value as CredentialType)}
          disabled={pending}
        >
          {types.map((k) => (
            <option key={k} value={k}>
              {tVault(`types.${k}`)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label={t("add.where")} htmlFor="vc-where">
        <NativeSelect id="vc-where" name="where" defaultValue={where[0]?.value} disabled={pending}>
          {where.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label={t("name")} htmlFor="vc-name" required>
        <Input id="vc-name" ref={nameRef} name="name" required maxLength={200} autoComplete="off" disabled={pending} />
      </Field>
      <Field label={t("username")} htmlFor="vc-username">
        <Input id="vc-username" name="username" maxLength={320} autoComplete="off" spellCheck={false} disabled={pending} />
      </Field>
      <Field label={t("url")} htmlFor="vc-url" className="sm:col-span-2">
        <Input id="vc-url" name="url" inputMode="url" maxLength={2048} autoComplete="off" disabled={pending} />
      </Field>
      {fieldsByType[type].map((key) => (
        <Field
          key={`${type}-${key}`}
          label={tVault(fieldLabelKey(key))}
          htmlFor={`vc-secret-${key}`}
          className={isMultilineSecret(key) ? "sm:col-span-2" : undefined}
        >
          {isMultilineSecret(key) ? (
            <Textarea
              id={`vc-secret-${key}`}
              name={`secret.${key}`}
              rows={4}
              className="font-mono text-xs"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={pending}
            />
          ) : (
            <Input
              id={`vc-secret-${key}`}
              name={`secret.${key}`}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="secret-mask font-mono"
              data-lpignore="true"
              data-1p-ignore=""
              disabled={pending}
            />
          )}
        </Field>
      ))}
      <Field label={t("add.totp")} htmlFor="vc-totp" hint={t("add.totpHint")} className="sm:col-span-2">
        <Input id="vc-totp" name="totp" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={pending} />
      </Field>
      <Field label={t("notes")} htmlFor="vc-notes" hint={t("add.notesHint")} className="sm:col-span-2">
        <Textarea id="vc-notes" name="notes" rows={2} maxLength={5000} disabled={pending} />
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
