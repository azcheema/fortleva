"use client";

import { Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef, useTransition } from "react";
import { toast } from "sonner";

import { AutoForm } from "@/components/auto-form";
import { Field, FormMessage, InlineEdit, RowActions, StatusBadge } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import type { ContactRow } from "@/clients/service";
import type { FormResult } from "@/lib/server-actions";

import { createContactAction, deleteContactAction, updateContactAction } from "../actions";

import { CONTACT_GRID } from "./grid";

const PROFILES = ["CONTACT_PRIMARY", "CONTACT_COLLABORATOR"] as const;

/**
 * One contact row. A list of people is CONTENT (founder mandate 1): the
 * five permanently-mounted inputs are gone, every value renders as
 * text, and a click, Enter, Space or F2 turns one into the control it
 * already looked like. Auto-save semantics are untouched — the same
 * `<Input>` / `<NativeSelect>` mount inside the same `<AutoForm>`, and
 * `<InlineEdit>` keeps a hidden input at rest so the posted FormData is
 * byte-identical (WORKLIST hazard H1).
 *
 * The remove verb moved into the row's `⋯` menu: a solid red button on
 * every row of every table was the highest-chroma object on the page.
 */
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
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [, start] = useTransition();
  const remove = () =>
    start(async () => {
      const r = await deleteContactAction(clientId, contact.id);
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      router.refresh();
    });

  const profiles = PROFILES.map((p) => ({ value: p, label: t(`profiles.${p}`) }));
  const profileLabel = t(`profiles.${contact.portalProfile}`);
  const status = <StatusBadge domain="portalStatus" value={contact.portalStatus} />;
  // Removal is offered only while the contact has no portal identity —
  // unchanged; revoking access is a Phase-3 action of its own.
  const removable = editable && contact.portalStatus === "NO_ACCESS";

  const trailing = (
    <span className="flex min-w-0 items-center justify-between gap-2">
      {status}
      {removable ? (
        <RowActions
          label={tCommon("actionsFor", { name: contact.name })}
          items={[
            {
              key: "remove",
              label: t("removeContact"),
              icon: Trash2Icon,
              tone: "danger",
              confirm: t("removeConfirm"),
              onSelect: remove,
            },
          ]}
        />
      ) : null}
    </span>
  );

  const values = (readOnly: boolean) => (
    <>
      <InlineEdit
        kind="text"
        name="name"
        value={contact.name}
        label={t("name")}
        placeholder={tCommon("notSet")}
        readOnly={readOnly}
        density="table"
        inputProps={{ required: true }}
        controlClassName="font-medium"
        display={<span className="font-medium">{contact.name}</span>}
        className={readOnly ? "px-2.5" : undefined}
      />
      <InlineEdit
        kind="text"
        name="email"
        value={contact.email}
        label={t("email")}
        placeholder={tCommon("notSet")}
        readOnly={readOnly}
        density="table"
        inputProps={{ required: true, inputMode: "email", autoComplete: "email" }}
        className={readOnly ? "px-2.5" : undefined}
      />
      <InlineEdit
        kind="text"
        name="title"
        value={contact.title ?? ""}
        label={t("jobTitle")}
        placeholder={tCommon("notSet")}
        readOnly={readOnly}
        density="table"
        className={readOnly ? "px-2.5" : undefined}
      />
      <InlineEdit
        kind="text"
        name="phone"
        value={contact.phone ?? ""}
        label={t("phone")}
        placeholder={tCommon("notSet")}
        readOnly={readOnly}
        density="table"
        controlClassName="num"
        display={<span className="num">{contact.phone}</span>}
        className={readOnly ? "px-2.5" : undefined}
      />
      <InlineEdit
        kind="select"
        name="portalProfile"
        value={contact.portalProfile}
        label={t("profile")}
        placeholder={profileLabel}
        options={profiles}
        readOnly={readOnly}
        density="table"
        // A setting, not a fact about the person: it reads at hint
        // weight until someone goes looking for it.
        display={<span className="text-xs text-muted-foreground">{profileLabel}</span>}
        className={readOnly ? "px-2.5" : undefined}
      />
    </>
  );

  if (!editable) {
    return (
      <li className={`grid ${CONTACT_GRID} items-center px-3 py-1.5 text-sm`}>
        {values(true)}
        {trailing}
      </li>
    );
  }

  return (
    <li className="px-3 py-1.5">
      <AutoForm action={updateContactAction} className={`grid ${CONTACT_GRID} items-center`}>
        <input type="hidden" name="clientId" value={clientId} />
        <input type="hidden" name="contactId" value={contact.id} />
        {values(false)}
        {trailing}
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
