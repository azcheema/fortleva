"use client";

import { useRouter } from "next/navigation";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useActionState, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { AutoForm } from "@/components/auto-form";
import { InlineConfirm } from "@/components/inline-confirm";
import { DataTable, Field, FormMessage, StatusBadge } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import type { ClientDetail } from "@/clients/service";
import { formatMoney } from "@/lib/format";
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

/** Company card: every field auto-saves on blur/change (UI.md §5.10). Read-only without client:edit. */
export function ClientCardForm({ client, editable }: { client: ClientDetail; editable: boolean }) {
  const t = useTranslations("clients.overview");
  const ro = !editable || client.status === "ARCHIVED";
  const text = (
    name: keyof ClientDetail & string,
    id: string,
    label: string,
    extra?: React.ComponentProps<"input"> & { fieldClassName?: string },
  ) => {
    const { fieldClassName, ...inputProps } = extra ?? {};
    return (
      <Field label={label} htmlFor={id} className={fieldClassName}>
        <Input
          id={id}
          name={name}
          defaultValue={(client[name] as string | null) ?? ""}
          readOnly={ro}
          {...inputProps}
        />
      </Field>
    );
  };
  return (
    <AutoForm action={updateClientCardAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <input type="hidden" name="clientId" value={client.id} />
      {text("name", "c-name", t("name"), { required: true, fieldClassName: "sm:col-span-2" })}
      {text("orgNr", "c-orgnr", t("orgNr"), { className: "num font-mono" })}
      {text("vatNumber", "c-vat", t("vatNumber"), { className: "num font-mono" })}
      <Field label={t("vatProfile")} htmlFor="c-vatprofile">
        <NativeSelect
          id="c-vatprofile"
          name="vatProfile"
          defaultValue={client.vatProfile ?? ""}
          disabled={ro}
        >
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
      {text("postalCode", "c-postal", t("postalCode"), { className: "num" })}
      {text("city", "c-city", t("city"))}
      {text("billingEmail", "c-billing", t("billingEmail"), { type: "email" })}
      {text("invoiceLocale", "c-locale", t("invoiceLocale"), { maxLength: 8 })}
    </AutoForm>
  );
}

/**
 * INTERNAL-only notes. The card header carries the VisibilityBadge, so
 * the field label here is for screen readers only: the promise that
 * only the team can read this is made once, loudly, and never in grey.
 */
export function ClientNotesForm({ client }: { client: ClientDetail }) {
  const t = useTranslations("clients.overview");
  return (
    <AutoForm action={updateClientNotesAction} className="flex flex-col gap-2">
      <input type="hidden" name="clientId" value={client.id} />
      <Label htmlFor="c-notes" className="sr-only">
        {t("notes")}
      </Label>
      <Textarea
        id="c-notes"
        name="internalNotes"
        rows={5}
        defaultValue={client.internalNotes ?? ""}
        placeholder={t("notesPlaceholder")}
        readOnly={client.status === "ARCHIVED"}
      />
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

// -- Services (records) ---------------------------------------------

/** Money and dates go through the cached Intl formatters (DESIGN SPEC §3.5). */
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
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const format = useFormatter();
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<FormResult>) =>
    start(async () => {
      const r = await fn();
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      router.refresh();
    });

  const money = (row: ServiceRow): string | null => {
    if (!row.priceExVat) return null;
    const amount = Number(row.priceExVat);
    if (!Number.isFinite(amount)) return row.priceExVat;
    return formatMoney(locale, amount, row.currency ?? "SEK");
  };

  return (
    <DataTable density="compact">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("columns.name")}</TableHead>
            <TableHead>{t("columns.billing")}</TableHead>
            <TableHead>{t("columns.scope")}</TableHead>
            <TableHead className="text-right">{t("columns.price")}</TableHead>
            <TableHead>{t("columns.renews")}</TableHead>
            <TableHead>{t("columns.status")}</TableHead>
            <TableHead className="text-right">
              <span className="sr-only">{tCommon("actions")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {services.map((s) => (
            <TableRow key={s.id}>
              <TableCell className="max-w-64 truncate font-medium">{s.name}</TableCell>
              <TableCell className="text-muted-foreground">
                {[
                  t(`kinds.${s.kind}`),
                  s.billingInterval ? t(`intervals.${s.billingInterval}`) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </TableCell>
              <TableCell>
                {s.projectKey ? (
                  <span className="num font-mono text-xs">{s.projectKey}</span>
                ) : (
                  <span className="text-muted-foreground">{t("clientLevel")}</span>
                )}
              </TableCell>
              <TableCell className="num text-right">{money(s) ?? "—"}</TableCell>
              <TableCell className="num text-muted-foreground">
                {s.renewsAt ? format.dateTime(s.renewsAt, { dateStyle: "medium" }) : "—"}
              </TableCell>
              <TableCell>
                <StatusBadge domain="serviceStatus" value={s.status} />
              </TableCell>
              <TableCell className="text-right">
                <span className="inline-flex items-center gap-1">
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
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </DataTable>
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
      <Field label={t("name")} htmlFor="s-name" className="col-span-2">
        <Input id="s-name" name="name" required disabled={pending} />
      </Field>
      <Field label={t("kind")} htmlFor="s-kind">
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
      <Field label={t("interval")} htmlFor="s-interval">
        <NativeSelect
          id="s-interval"
          name="billingInterval"
          defaultValue="MONTHLY"
          disabled={pending || kind !== "RECURRING"}
        >
          <option value="MONTHLY">{t("intervals.MONTHLY")}</option>
          <option value="QUARTERLY">{t("intervals.QUARTERLY")}</option>
          <option value="YEARLY">{t("intervals.YEARLY")}</option>
        </NativeSelect>
      </Field>
      <Field label={t("price")} htmlFor="s-price">
        <Input
          id="s-price"
          name="priceExVat"
          inputMode="decimal"
          className="num text-right"
          disabled={pending}
        />
      </Field>
      <Field label={t("currency")} htmlFor="s-currency">
        <Input
          id="s-currency"
          name="currency"
          maxLength={3}
          defaultValue="SEK"
          className="font-mono uppercase"
          disabled={pending}
        />
      </Field>
      <Field label={t("renewsAt")} htmlFor="s-renews">
        <Input
          id="s-renews"
          name="renewsAt"
          type="date"
          className="num"
          disabled={pending || kind !== "RECURRING"}
        />
      </Field>
      <Field label={t("project")} htmlFor="s-project">
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
