"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef, useTransition } from "react";
import { toast } from "sonner";

import { AutoForm } from "@/components/auto-form";
import { InlineConfirm } from "@/components/inline-confirm";
import { Field, FormMessage, StatusBadge } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import type { ContactRow } from "@/clients/service";
import type { FormResult } from "@/lib/server-actions";

import { createContactAction, deleteContactAction, updateContactAction } from "../actions";

import { CONTACT_GRID } from "./grid";

const PROFILES = ["CONTACT_PRIMARY", "CONTACT_COLLABORATOR"] as const;

/** One contact row: inline auto-saving fields (client:manage_contacts) or read-only text. */
export function ContactRowForm({
  clientId,
  contact,
  editable,
}: {
  clientId: string;
  contact: ContactRow;
  editable: boolean;
}) {
  const t = useTranslations("clients.contacts");
  const router = useRouter();
  const [pending, start] = useTransition();
  const remove = () =>
    start(async () => {
      const r = await deleteContactAction(clientId, contact.id);
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      router.refresh();
    });

  const status = <StatusBadge domain="portalStatus" value={contact.portalStatus} />;

  if (!editable) {
    return (
      <li className={`grid ${CONTACT_GRID} items-center px-3 py-2 text-sm`}>
        <span className="truncate font-medium">{contact.name}</span>
        <span className="truncate text-muted-foreground">{contact.email}</span>
        <span className="truncate text-muted-foreground">{contact.title ?? "—"}</span>
        <span className="num truncate text-muted-foreground">{contact.phone ?? "—"}</span>
        <span className="truncate text-muted-foreground">
          {t(`profiles.${contact.portalProfile}`)}
        </span>
        <span className="flex items-center">{status}</span>
      </li>
    );
  }

  return (
    <li className="px-3 py-2">
      <AutoForm action={updateContactAction} className={`grid ${CONTACT_GRID} items-center`}>
        <input type="hidden" name="clientId" value={clientId} />
        <input type="hidden" name="contactId" value={contact.id} />
        <Input name="name" defaultValue={contact.name} required aria-label={t("name")} />
        <Input
          name="email"
          type="email"
          defaultValue={contact.email}
          required
          aria-label={t("email")}
        />
        <Input name="title" defaultValue={contact.title ?? ""} aria-label={t("jobTitle")} />
        <Input
          name="phone"
          defaultValue={contact.phone ?? ""}
          className="num"
          aria-label={t("phone")}
        />
        <NativeSelect
          name="portalProfile"
          defaultValue={contact.portalProfile}
          aria-label={t("profile")}
        >
          {PROFILES.map((p) => (
            <option key={p} value={p}>
              {t(`profiles.${p}`)}
            </option>
          ))}
        </NativeSelect>
        <span className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          {status}
          {contact.portalStatus === "NO_ACCESS" ? (
            <InlineConfirm
              label={t("remove")}
              question={t("removeConfirm")}
              variant="destructive"
              pending={pending}
              onConfirm={remove}
            />
          ) : null}
        </span>
      </AutoForm>
    </li>
  );
}

/** Inline add: name + email required; Enter adds the next (UI.md rule 2). */
export function CreateContactForm({ clientId }: { clientId: string }) {
  const t = useTranslations("clients.contacts");
  const [state, action, pending] = useActionState<FormResult | null, FormData>(
    createContactAction,
    null,
  );
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
    <form ref={formRef} action={action} className="grid grid-cols-2 items-end gap-3 sm:grid-cols-6">
      <input type="hidden" name="clientId" value={clientId} />
      <Field label={t("name")} htmlFor="ct-name">
        <Input id="ct-name" ref={nameRef} name="name" required disabled={pending} />
      </Field>
      <Field label={t("email")} htmlFor="ct-email">
        <Input id="ct-email" name="email" type="email" required disabled={pending} />
      </Field>
      <Field label={t("jobTitle")} htmlFor="ct-title">
        <Input id="ct-title" name="title" disabled={pending} />
      </Field>
      <Field label={t("phone")} htmlFor="ct-phone">
        <Input id="ct-phone" name="phone" className="num" disabled={pending} />
      </Field>
      <Field label={t("profile")} htmlFor="ct-profile">
        <NativeSelect
          id="ct-profile"
          name="portalProfile"
          defaultValue="CONTACT_COLLABORATOR"
          disabled={pending}
        >
          {PROFILES.map((p) => (
            <option key={p} value={p}>
              {t(`profiles.${p}`)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Button type="submit" disabled={pending}>
        {pending ? t("adding") : t("add")}
      </Button>
      {state && !state.ok ? <FormMessage state={state} className="col-span-2 sm:col-span-6" /> : null}
    </form>
  );
}
