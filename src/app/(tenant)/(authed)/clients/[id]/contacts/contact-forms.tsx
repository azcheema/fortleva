"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef, useTransition } from "react";
import { toast } from "sonner";

import { AutoForm } from "@/components/auto-form";
import { FormMessage } from "@/components/form-message";
import { InlineConfirm } from "@/components/inline-confirm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type { ContactRow } from "@/clients/service";
import type { FormResult } from "@/lib/server-actions";

import { createContactAction, deleteContactAction, updateContactAction } from "../actions";

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

  const status =
    contact.portalStatus === "NO_ACCESS" ? null : (
      <Badge variant="outline">{t(`portalStatus.${contact.portalStatus}`)}</Badge>
    );

  if (!editable) {
    return (
      <li className="grid grid-cols-2 gap-x-3 gap-y-1 px-3 py-2 text-sm sm:grid-cols-5">
        <span className="font-medium">{contact.name}</span>
        <span className="truncate text-muted-foreground">{contact.email}</span>
        <span className="text-muted-foreground">{contact.title ?? "—"}</span>
        <span className="text-muted-foreground">{contact.phone ?? "—"}</span>
        <span className="flex items-center gap-2 text-muted-foreground">
          {t(`profiles.${contact.portalProfile}`)}
          {status}
        </span>
      </li>
    );
  }

  return (
    <li className="px-3 py-2">
      <AutoForm action={updateContactAction} className="grid grid-cols-2 items-center gap-2 sm:grid-cols-6">
        <input type="hidden" name="clientId" value={clientId} />
        <input type="hidden" name="contactId" value={contact.id} />
        <Input name="name" defaultValue={contact.name} required aria-label={t("name")} />
        <Input name="email" type="email" defaultValue={contact.email} required aria-label={t("email")} />
        <Input name="title" defaultValue={contact.title ?? ""} aria-label={t("jobTitle")} />
        <Input name="phone" defaultValue={contact.phone ?? ""} aria-label={t("phone")} />
        <NativeSelect name="portalProfile" defaultValue={contact.portalProfile} aria-label={t("profile")}>
          {PROFILES.map((p) => (
            <option key={p} value={p}>
              {t(`profiles.${p}`)}
            </option>
          ))}
        </NativeSelect>
        <span className="flex items-center justify-end gap-2">
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
  const [state, action, pending] = useActionState<FormResult | null, FormData>(createContactAction, null);
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
      <div className="flex flex-col gap-1">
        <Label htmlFor="ct-name" className="text-xs text-muted-foreground">
          {t("name")}
        </Label>
        <Input id="ct-name" ref={nameRef} name="name" required disabled={pending} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="ct-email" className="text-xs text-muted-foreground">
          {t("email")}
        </Label>
        <Input id="ct-email" name="email" type="email" required disabled={pending} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="ct-title" className="text-xs text-muted-foreground">
          {t("jobTitle")}
        </Label>
        <Input id="ct-title" name="title" disabled={pending} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="ct-phone" className="text-xs text-muted-foreground">
          {t("phone")}
        </Label>
        <Input id="ct-phone" name="phone" disabled={pending} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="ct-profile" className="text-xs text-muted-foreground">
          {t("profile")}
        </Label>
        <NativeSelect id="ct-profile" name="portalProfile" defaultValue="CONTACT_COLLABORATOR" disabled={pending}>
          {PROFILES.map((p) => (
            <option key={p} value={p}>
              {t(`profiles.${p}`)}
            </option>
          ))}
        </NativeSelect>
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? t("adding") : t("add")}
      </Button>
      {state && !state.ok ? <FormMessage state={state} className="col-span-2 sm:col-span-6" /> : null}
    </form>
  );
}
