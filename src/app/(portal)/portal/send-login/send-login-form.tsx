"use client";

import { useTranslations } from "next-intl";
import { startTransition, useActionState, useState } from "react";

// A LEAF, never the vault barrel (which reaches Prisma): what each secret
// field is called and which ones are text. The portal list and the share
// page import it too.
import { fieldLabelKey, isMultilineSecret, type FieldsByType } from "@/app/(tenant)/(authed)/vault/vault-shape";
import { Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { FormResult } from "@/lib/server-actions";
import type { CredentialType } from "@/modules/vault";
import type { PortalProjectOption } from "@/projects/portal";

import { sendLoginAction } from "./actions";

/**
 * THE "SEND US A LOGIN" FORM (Phase 3V slice 96; founder decision C64).
 *
 * DISPATCHED FROM `onSubmit`, NEVER THROUGH REACT'S FORM-ACTION PATH —
 * AGENTS.md's React 19 trap, and the code review's medium: a form submitted
 * through its `action` is RESET
 * by React around every action, and while a controlled input or textarea
 * survives that, a controlled `<select>` does not (React keeps each
 * option's `selected`, never its `defaultSelected`), so after a refusal
 * the type and project selects would SHOW their first option while state
 * kept the pick — and a resend would post what they show: a login filed
 * on the company instead of the project, or a key refused as "not a Login
 * field". `onSubmit` + `startTransition(dispatch)` (the Assets form's
 * shape) queues no reset at all: when a submit's default is prevented and
 * its handler started a transition, React runs the form's own action as a
 * no-op (no reset, no second call).
 *
 * …AND THE FORM KEEPS `action={action}` (the fix-pass review's medium):
 * without it, a press of Send before the page's script has loaded — a slow
 * phone, a failed chunk, a proxy that strips scripts — is the browser's own
 * GET to this page with every field in the QUERY STRING, the secret
 * included, landing in history, the address bar and an access log. With
 * it, React renders the progressive-enhancement POST to the server action,
 * so a form sent before hydration still never puts a value in a URL
 * (`portal-send-login.spec.ts` sends one with JavaScript off and checks).
 * The Assets form could leave it out because its fields are not secret.
 *
 * The fields stay controlled, so a refusal leaves everything typed in
 * place; on success the action redirects and this component is gone, so
 * nothing typed — the secret included — outlives the send.
 *
 * THE SECRET INPUTS ARE MASKED TEXT (`secret-mask`), never
 * `type="password"`, as on the agency's side (`add-credential.tsx`): a
 * password field makes the browser offer to save this login as the
 * client's PORTAL password, or to fill the portal password in. Notes and
 * private keys are text, typed in a textarea.
 *
 * THE PROJECT is the one place the form names anything: "for the company"
 * (the default) or one of the client's portal projects. Only the secret
 * fields of the chosen type are posted.
 */
export function SendLoginForm({
  types,
  fieldsByType,
  projects,
}: {
  types: readonly CredentialType[];
  fieldsByType: FieldsByType;
  projects: readonly PortalProjectOption[];
}) {
  const t = useTranslations("portal.sendLogin.form");
  const tVault = useTranslations("vault");
  const [state, action, pending] = useActionState<FormResult | null, FormData>(sendLoginAction, null);
  const [type, setType] = useState<CredentialType>("LOGIN");
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [username, setUsername] = useState("");
  const [url, setUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [secrets, setSecrets] = useState<Readonly<Record<string, string>>>({});
  const setSecret = (key: string, value: string) => setSecrets((prev) => ({ ...prev, [key]: value }));

  return (
    <form
      action={action}
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(() => action(fd));
      }}
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      data-testid="send-login-form"
    >
      <Field label={t("type")} htmlFor="sl-type">
        <NativeSelect
          id="sl-type"
          name="type"
          value={type}
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
      {projects.length > 0 ? (
        <Field label={t("project")} htmlFor="sl-project">
          <NativeSelect
            id="sl-project"
            name="projectId"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            disabled={pending}
          >
            <option value="">{t("noProject")}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
      ) : null}
      <Field label={t("name")} htmlFor="sl-name" hint={t("nameHint")} required className="sm:col-span-2">
        <Input
          id="sl-name"
          name="name"
          required
          maxLength={200}
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={pending}
        />
      </Field>
      <Field label={tVault("row.username")} htmlFor="sl-username">
        <Input
          id="sl-username"
          name="username"
          maxLength={320}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={pending}
        />
      </Field>
      <Field label={tVault("row.url")} htmlFor="sl-url">
        <Input
          id="sl-url"
          name="url"
          inputMode="url"
          maxLength={2048}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={pending}
        />
      </Field>
      {fieldsByType[type].map((key) => (
        <Field
          key={`${type}-${key}`}
          label={tVault(fieldLabelKey(key))}
          htmlFor={`sl-secret-${key}`}
          className={isMultilineSecret(key) ? "sm:col-span-2" : undefined}
        >
          {isMultilineSecret(key) ? (
            <Textarea
              id={`sl-secret-${key}`}
              name={`secret.${key}`}
              rows={4}
              className="font-mono text-xs"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={secrets[key] ?? ""}
              onChange={(e) => setSecret(key, e.target.value)}
              disabled={pending}
            />
          ) : (
            <Input
              id={`sl-secret-${key}`}
              name={`secret.${key}`}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="secret-mask font-mono"
              data-lpignore="true"
              data-1p-ignore=""
              value={secrets[key] ?? ""}
              onChange={(e) => setSecret(key, e.target.value)}
              disabled={pending}
            />
          )}
        </Field>
      ))}
      <Field label={t("notes")} htmlFor="sl-notes" hint={t("notesHint")} className="sm:col-span-2">
        <Textarea
          id="sl-notes"
          name="notes"
          rows={2}
          maxLength={5000}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          disabled={pending}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="submit" disabled={pending}>
          {pending ? t("sending") : t("submit")}
        </Button>
        {state && !state.ok ? <FormMessage state={state} /> : null}
      </div>
    </form>
  );
}
