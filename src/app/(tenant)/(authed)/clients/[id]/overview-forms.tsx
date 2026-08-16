"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { AutoForm } from "@/components/auto-form";
import { FormMessage } from "@/components/form-message";
import { InlineConfirm } from "@/components/inline-confirm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { ClientDetail } from "@/clients/service";
import type { FormResult } from "@/lib/server-actions";
import type { ServiceRow } from "@/services/service";

import {
  createServiceAction,
  deleteServiceAction,
  endServiceAction,
  setClientArchivedAction,
  updateClientCardAction,
  updateClientNotesAction,
} from "./actions";

const VAT_PROFILES = ["SE_DOMESTIC", "EU_REVERSE_CHARGE", "OUTSIDE_SCOPE"] as const;

function Field({
  id,
  label,
  children,
  className,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className ?? "flex flex-col gap-1"}>
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

/** Company card: every field auto-saves on blur/change (UI.md §5.10). Read-only without client:edit. */
export function ClientCardForm({ client, editable }: { client: ClientDetail; editable: boolean }) {
  const t = useTranslations("clients.overview");
  const ro = !editable || client.status === "ARCHIVED";
  const text = (name: keyof ClientDetail & string, id: string, label: string, extra?: React.ComponentProps<"input">) => (
    <Field id={id} label={label}>
      <Input id={id} name={name} defaultValue={(client[name] as string | null) ?? ""} readOnly={ro} {...extra} />
    </Field>
  );
  return (
    <AutoForm action={updateClientCardAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <input type="hidden" name="clientId" value={client.id} />
      {text("name", "c-name", t("name"), { required: true, className: "sm:col-span-2" })}
      {text("orgNr", "c-orgnr", t("orgNr"))}
      {text("vatNumber", "c-vat", t("vatNumber"))}
      <Field id="c-vatprofile" label={t("vatProfile")}>
        <NativeSelect id="c-vatprofile" name="vatProfile" defaultValue={client.vatProfile ?? ""} disabled={ro}>
          <option value="">{t("vatProfiles.none")}</option>
          {VAT_PROFILES.map((p) => (
            <option key={p} value={p}>
              {t(`vatProfiles.${p}`)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {text("countryCode", "c-country", t("countryCode"), { maxLength: 2, className: "uppercase" })}
      {text("addressLine1", "c-addr1", t("addressLine1"))}
      {text("addressLine2", "c-addr2", t("addressLine2"))}
      {text("postalCode", "c-postal", t("postalCode"))}
      {text("city", "c-city", t("city"))}
      {text("billingEmail", "c-billing", t("billingEmail"), { type: "email" })}
      {text("invoiceLocale", "c-locale", t("invoiceLocale"), { maxLength: 8 })}
    </AutoForm>
  );
}

/** INTERNAL-only notes: client:edit + direct scope; badge says so loudly (UI.md rule 10). */
export function ClientNotesForm({ client }: { client: ClientDetail }) {
  const t = useTranslations("clients.overview");
  const tCommon = useTranslations("common");
  return (
    <AutoForm action={updateClientNotesAction} className="flex flex-col gap-2">
      <input type="hidden" name="clientId" value={client.id} />
      <div className="flex items-center gap-2">
        <Label htmlFor="c-notes">{t("notes")}</Label>
        <Badge variant="secondary">{tCommon("private")}</Badge>
      </div>
      <Textarea
        id="c-notes"
        name="internalNotes"
        rows={5}
        defaultValue={client.internalNotes ?? ""}
        placeholder={t("notesPlaceholder")}
        readOnly={client.status === "ARCHIVED"}
      />
      <p className="text-xs text-muted-foreground">{t("notesHint")}</p>
    </AutoForm>
  );
}

export function ArchiveClientControl({ client }: { client: ClientDetail }) {
  const t = useTranslations("clients.overview");
  const router = useRouter();
  const [pending, start] = useTransition();
  const archived = client.status === "ARCHIVED";
  const run = () =>
    start(async () => {
      const r = await setClientArchivedAction(client.id, !archived);
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      router.refresh();
    });
  return archived ? (
    <Button type="button" variant="outline" size="sm" disabled={pending} onClick={run}>
      {t("unarchive")}
    </Button>
  ) : (
    <InlineConfirm
      label={t("archive")}
      question={t("archiveConfirm")}
      variant="destructive"
      size="sm"
      pending={pending}
      onConfirm={run}
    />
  );
}

// ── Services (records) ──────────────────────────────────────────────

export function ServicesList({
  clientId,
  services,
  canEdit,
  canDelete,
}: {
  clientId: string;
  services: ServiceRow[];
  canEdit: boolean;
  canDelete: boolean;
}) {
  const t = useTranslations("clients.services");
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<FormResult>) =>
    start(async () => {
      const r = await fn();
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      router.refresh();
    });
  return (
    <ul className="divide-y divide-border rounded-md border border-border text-sm">
      {services.map((s) => (
        <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
          <span className="flex min-w-0 flex-col">
            <span className="flex items-center gap-2">
              <span className="truncate font-medium">{s.name}</span>
              <Badge variant={s.status === "ACTIVE" ? "secondary" : "outline"}>{t(`status.${s.status}`)}</Badge>
            </span>
            <span className="text-xs text-muted-foreground">
              {[
                t(`kinds.${s.kind}`),
                s.billingInterval ? t(`intervals.${s.billingInterval}`) : null,
                s.priceExVat ? `${s.priceExVat} ${s.currency ?? ""}`.trim() : null,
                s.projectKey ?? t("clientLevel"),
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </span>
          <span className="flex items-center gap-1">
            {canEdit && s.status !== "ENDED" ? (
              <InlineConfirm
                label={t("end")}
                question={t("endConfirm")}
                pending={pending}
                onConfirm={() => run(() => endServiceAction(clientId, s.id))}
              />
            ) : null}
            {canDelete ? (
              <InlineConfirm
                label={t("delete")}
                question={t("deleteConfirm")}
                variant="destructive"
                pending={pending}
                onConfirm={() => run(() => deleteServiceAction(clientId, s.id))}
              />
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function CreateServiceForm({
  clientId,
  projects,
}: {
  clientId: string;
  projects: { id: string; key: string; name: string }[];
}) {
  const t = useTranslations("clients.services");
  const [kind, setKind] = useState<"ONE_TIME" | "RECURRING">("RECURRING");
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState<FormResult | null, FormData>(
    async (prev, formData) => {
      const r = await createServiceAction(prev, formData);
      if (r.ok) {
        toast.success(r.message);
        formRef.current?.reset();
        setKind("RECURRING");
      }
      return r;
    },
    null,
  );
  return (
    <form ref={formRef} action={action} className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <input type="hidden" name="clientId" value={clientId} />
      <Field id="s-name" label={t("name")} className="col-span-2 flex flex-col gap-1">
        <Input id="s-name" name="name" required disabled={pending} />
      </Field>
      <Field id="s-kind" label={t("kind")}>
        <NativeSelect
          id="s-kind"
          name="kind"
          value={kind}
          onChange={(e) => setKind(e.target.value === "ONE_TIME" ? "ONE_TIME" : "RECURRING")}
          disabled={pending}
        >
          <option value="RECURRING">{t("kinds.RECURRING")}</option>
          <option value="ONE_TIME">{t("kinds.ONE_TIME")}</option>
        </NativeSelect>
      </Field>
      <Field id="s-interval" label={t("interval")}>
        <NativeSelect id="s-interval" name="billingInterval" defaultValue="MONTHLY" disabled={pending || kind !== "RECURRING"}>
          <option value="MONTHLY">{t("intervals.MONTHLY")}</option>
          <option value="QUARTERLY">{t("intervals.QUARTERLY")}</option>
          <option value="YEARLY">{t("intervals.YEARLY")}</option>
        </NativeSelect>
      </Field>
      <Field id="s-price" label={t("price")}>
        <Input id="s-price" name="priceExVat" inputMode="decimal" disabled={pending} />
      </Field>
      <Field id="s-currency" label={t("currency")}>
        <Input id="s-currency" name="currency" maxLength={3} defaultValue="SEK" className="uppercase" disabled={pending} />
      </Field>
      <Field id="s-renews" label={t("renewsAt")}>
        <Input id="s-renews" name="renewsAt" type="date" disabled={pending || kind !== "RECURRING"} />
      </Field>
      <Field id="s-project" label={t("project")}>
        <NativeSelect id="s-project" name="projectId" defaultValue="" disabled={pending}>
          <option value="">{t("clientLevel")}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.key} — {p.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <div className="col-span-2 flex items-center gap-3 sm:col-span-4">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? t("adding") : t("add")}
        </Button>
        {state && !state.ok ? <FormMessage state={state} className="text-xs" /> : null}
      </div>
    </form>
  );
}
