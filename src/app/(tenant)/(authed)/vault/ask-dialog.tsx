"use client";

import { MailQuestionIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { startTransition, useActionState, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { FormResult } from "@/lib/server-actions";
import type { AskPlace, AskTarget, CredentialType } from "@/modules/vault";

import { askForLoginAction } from "./actions";
import { clientWhere, projectWhere, type VaultSurface } from "./surface";

/**
 * "ASK FOR A LOGIN…" (Phase 3V slice 98; founder decision C66) — a member
 * asks ONE person at the client (C66 (a); the main contact first) to send a
 * login through their portal. WHAT IS TYPED HERE IS SHOWN TO THAT PERSON —
 * the name and the note — and the form says so twice. They get one email
 * (C66 (b)) and can send it or say they do not have it (C66 (c)).
 *
 * A dialog with its own trigger (Radix returns focus to it on close). Its
 * form lives INSIDE the content, which Radix unmounts on close, so every
 * opening starts blank and a success closes it. Dispatched from `onSubmit`
 * in a transition, never through React's form-action path — AGENTS.md's
 * React 19 trap: a refusal would reset the native selects to their first
 * option while state kept the pick.
 */
export function AskForLoginDialog({
  surface,
  clientId,
  clientName,
  places,
  contacts,
  types,
  mailEveryHours,
}: {
  surface: VaultSurface;
  clientId: string;
  clientName: string;
  places: readonly AskPlace[];
  contacts: readonly AskTarget[];
  types: readonly CredentialType[];
  /** `ASK_MAIL_EVERY_HOURS`, handed down: this client module cannot import the vault. */
  mailEveryHours: number;
}) {
  const t = useTranslations("vault.asks.dialog");
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" data-testid="ask-for-login">
          <MailQuestionIcon />
          {t("open")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md" data-testid="ask-for-login-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description", { client: clientName })}</DialogDescription>
        </DialogHeader>
        <AskForm
          surface={surface}
          clientId={clientId}
          clientName={clientName}
          places={places}
          contacts={contacts}
          types={types}
          mailEveryHours={mailEveryHours}
          onDone={close}
        />
      </DialogContent>
    </Dialog>
  );
}

function AskForm({
  surface,
  clientId,
  clientName,
  places,
  contacts,
  types,
  mailEveryHours,
  onDone,
}: {
  surface: VaultSurface;
  clientId: string;
  clientName: string;
  places: readonly AskPlace[];
  contacts: readonly AskTarget[];
  types: readonly CredentialType[];
  mailEveryHours: number;
  onDone: () => void;
}) {
  const t = useTranslations("vault.asks.dialog");
  const tVault = useTranslations("vault");
  const tCommon = useTranslations("common");
  const [state, action, pending] = useActionState<FormResult | null, FormData>(askForLoginAction, null);
  const whereOf = (p: AskPlace) => (p.projectId === null ? clientWhere(clientId) : projectWhere(p.projectId));
  const [where, setWhere] = useState(places[0] ? whereOf(places[0]) : "");
  const [contactId, setContactId] = useState(contacts[0]?.id ?? "");
  const [type, setType] = useState<CredentialType>("LOGIN");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const asked = contacts.find((c) => c.id === contactId)?.name ?? "";

  useEffect(() => {
    if (state?.ok) {
      toast.success(state.message);
      onDone();
    }
  }, [state, onDone]);

  return (
    <form
      action={action}
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(() => action(fd));
      }}
      className="flex flex-col gap-3"
      data-testid="ask-for-login-form"
    >
      <input type="hidden" name="surface" value={surface} />
      <Field label={t("name")} htmlFor="ask-name" hint={t("nameHint")} required>
        <Input
          id="ask-name"
          name="name"
          required
          maxLength={200}
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={pending}
        />
      </Field>
      <Field label={t("type")} htmlFor="ask-type">
        <NativeSelect
          id="ask-type"
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
      {places.length > 1 ? (
        <Field label={t("place")} htmlFor="ask-where">
          <NativeSelect id="ask-where" name="where" value={where} onChange={(e) => setWhere(e.target.value)} disabled={pending}>
            {places.map((p) => (
              <option key={whereOf(p)} value={whereOf(p)}>
                {p.projectId === null ? t("placeClient", { client: clientName }) : p.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
      ) : (
        <>
          {/* One place only: still SAID (a single-option field must state
              its value — slice 86's lesson), and posted. */}
          <input type="hidden" name="where" value={where} />
          <p className="text-sm text-muted-foreground">
            {places[0] && places[0].projectId !== null
              ? t("placeOnly", { place: places[0].label })
              : t("placeOnly", { place: t("placeClient", { client: clientName }) })}
          </p>
        </>
      )}
      <Field label={t("contact")} htmlFor="ask-contact">
        <NativeSelect
          id="ask-contact"
          name="contactId"
          value={contactId}
          onChange={(e) => setContactId(e.target.value)}
          disabled={pending}
        >
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.email === null
                ? c.primary
                  ? t("contactPrimaryNoEmail", { name: c.name })
                  : c.name
                : c.primary
                  ? t("contactPrimary", { name: c.name, email: c.email })
                  : t("contactOther", { name: c.name, email: c.email })}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label={t("note")} htmlFor="ask-note" hint={t("noteHint")}>
        <Textarea
          id="ask-note"
          name="note"
          rows={3}
          maxLength={1000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={pending}
        />
      </Field>
      <p className="text-sm text-muted-foreground">{t("footer", { name: asked, hours: mailEveryHours })}</p>
      {state && !state.ok ? <FormMessage state={state} /> : null}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone} disabled={pending}>
          {tCommon("cancel")}
        </Button>
        <Button type="submit" disabled={pending || contactId === "" || where === ""}>
          {pending ? t("submitting") : t("submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
