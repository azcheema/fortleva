"use client";

import { CircleSlashIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useActionState, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { AutoForm } from "@/components/auto-form";
import { InlineConfirm } from "@/components/inline-confirm";
import {
  DataTable,
  Disclosure,
  Field,
  FormMessage,
  InlineEdit,
  RowActions,
  StatusBadge,
  type RowAction,
} from "@/components/semantic";
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
import type { InlineEditOption } from "@/lib/inline-edit";
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

type CardFieldName =
  | "name"
  | "orgNr"
  | "vatNumber"
  | "vatProfile"
  | "countryCode"
  | "addressLine1"
  | "addressLine2"
  | "postalCode"
  | "city"
  | "billingEmail"
  | "invoiceLocale";

type CardField = {
  name: CardFieldName;
  label: string;
  kind: "text" | "select";
  /** Always shown, even when empty — the record cannot exist without it. */
  always?: boolean;
  options?: InlineEditOption[];
  /** Identifiers read in the mono face with lining figures (§10.7). */
  mono?: boolean;
  placeholder?: string;
  inputProps?: Omit<React.ComponentProps<"input">, "name" | "defaultValue" | "type" | "ref">;
};

/**
 * The company card is a RECORD, not a data-entry form (founder mandate
 * 1; UI.md rule 3). Eleven bordered inputs — most of them empty — made
 * the page read as a form someone abandoned halfway. Now every value is
 * text in a box geometrically identical to the control it becomes, and
 * only a click, Enter, Space or F2 turns one into that control.
 *
 * Two consequences of that, both deliberate:
 *  - the empty fields are behind ONE disclosure, so the card leads with
 *    what is known about the client instead of with what is not;
 *  - the org. number leads, not the name — the name is already the h1
 *    60px above, and stating it twice in the first two lines of a page
 *    is the duplication this pass removes everywhere else.
 *
 * The posted FormData is unchanged: `<InlineEdit>` renders a hidden
 * input at rest (WORKLIST hazard H1), including for the fields inside
 * the closed disclosure, which are hidden but still in the DOM.
 */
export function ClientCardForm({ client, editable }: { client: ClientDetail; editable: boolean }) {
  const t = useTranslations("clients.overview");
  const tCommon = useTranslations("common");
  const ro = !editable || client.status === "ARCHIVED";

  const valueOf = (name: CardFieldName): string => (client[name] as string | null) ?? "";

  const fields: CardField[] = [
    { name: "orgNr", label: t("orgNr"), kind: "text", always: true, mono: true },
    {
      name: "name",
      label: t("name"),
      kind: "text",
      always: true,
      inputProps: { required: true },
    },
    { name: "vatNumber", label: t("vatNumber"), kind: "text", mono: true },
    {
      name: "vatProfile",
      label: t("vatProfile"),
      kind: "select",
      placeholder: t("vatProfiles.none"),
      options: [
        { value: "", label: t("vatProfiles.none") },
        ...VAT_PROFILES.map((p) => ({ value: p, label: t(`vatProfiles.${p}`) })),
      ],
    },
    {
      name: "billingEmail",
      label: t("billingEmail"),
      kind: "text",
      inputProps: { inputMode: "email", autoComplete: "email" },
    },
    { name: "addressLine1", label: t("addressLine1"), kind: "text" },
    { name: "addressLine2", label: t("addressLine2"), kind: "text" },
    { name: "postalCode", label: t("postalCode"), kind: "text", mono: true },
    { name: "city", label: t("city"), kind: "text" },
    {
      name: "countryCode",
      label: t("countryCode"),
      kind: "text",
      inputProps: { maxLength: 2, className: "uppercase" },
    },
    { name: "invoiceLocale", label: t("invoiceLocale"), kind: "text", inputProps: { maxLength: 8 } },
  ];

  const row = (f: CardField) => {
    const value = valueOf(f.name);
    return (
      <div key={f.name} className="flex min-w-0 flex-col gap-0.5">
        {/* The label carries the control's own horizontal inset, so the
            resting text sits directly under it rather than 10px right. */}
        <dt className="px-2.5 text-xs text-muted-foreground">{f.label}</dt>
        <dd className="min-w-0">
          <InlineEdit
            kind={f.kind}
            name={f.name}
            value={value}
            label={f.label}
            placeholder={f.placeholder ?? tCommon("notSet")}
            options={f.options}
            display={f.mono ? <span className="num-id font-mono">{value}</span> : undefined}
            readOnly={ro}
            inputProps={f.inputProps}
            controlClassName={f.mono ? "num-id font-mono" : undefined}
            className={ro ? "px-2.5" : undefined}
          />
        </dd>
      </div>
    );
  };

  const known = fields.filter((f) => f.always || valueOf(f.name) !== "");
  const blank = fields.filter((f) => !f.always && valueOf(f.name) === "");

  return (
    <AutoForm action={updateClientCardAction} className="flex flex-col gap-4">
      <input type="hidden" name="clientId" value={client.id} />
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">{known.map(row)}</dl>
      {blank.length > 0 && !ro ? (
        <Disclosure label={tCommon("addDetails")}>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">{blank.map(row)}</dl>
        </Disclosure>
      ) : null}
    </AutoForm>
  );
}

/**
 * INTERNAL-only notes. The card header carries the VisibilityBadge, so
 * the field label here is for screen readers only: the promise that
 * only the team can read this is made once, loudly, and never in grey.
 *
 * Deliberately NOT an inline edit: a card whose whole purpose is
 * writing free text keeps its writing surface (WORKLIST §3.8).
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

/**
 * Archiving rests at OUTLINE weight inside the page's danger footer;
 * the product's only solid --destructive fill is the "Yes" of the
 * question it asks (§5.9). It used to be a solid red button floating
 * right-aligned on the canvas outside any card.
 */
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
      variant="outline"
      tone="danger"
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
  rates,
  usage,
}: {
  clientId: string;
  services: ServiceRow[];
  canEdit: boolean;
  canDelete: boolean;
  /**
   * 2T (Agreements tab): the agreement's open BILL rate, FORMATTED ON THE
   * SERVER ("1 200,00 kr/h"), null = no card; absent = the viewer lacks
   * rate:view_bill and the column does not exist (UI.md rule 14).
   */
  rates?: Record<string, string | null>;
  /** 2T: hours on the agreement this month, formatted on the server. */
  usage?: Record<string, string>;
}) {
  const t = useTranslations("clients.services");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const format = useFormatter();
  const router = useRouter();
  const [, start] = useTransition();
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

  /**
   * One quiet trigger per row instead of two solid buttons: a
   * destructive verb repeated down a table is the loudest object on the
   * page and it outranks the rows it serves (§5.9).
   */
  const actionsFor = (s: ServiceRow): RowAction[] => [
    ...(canEdit && s.status !== "ENDED"
      ? [
          {
            key: "end",
            label: t("endService"),
            icon: CircleSlashIcon,
            confirm: t("endConfirm"),
            onSelect: () => run(() => endServiceAction(clientId, s.id)),
          } satisfies RowAction,
        ]
      : []),
    ...(canDelete
      ? [
          {
            key: "delete",
            label: t("deleteService"),
            icon: Trash2Icon,
            tone: "danger",
            confirm: t("deleteConfirm"),
            onSelect: () => run(() => deleteServiceAction(clientId, s.id)),
          } satisfies RowAction,
        ]
      : []),
  ];

  return (
    <DataTable density="compact" flush scrollLabel={t("title")}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("columns.name")}</TableHead>
            <TableHead priority="medium">{t("columns.billing")}</TableHead>
            <TableHead priority="low">{t("columns.scope")}</TableHead>
            <TableHead className="text-right">{t("columns.price")}</TableHead>
            {/* Phones keep name · price · status · ⋯; the rate still shows there in the
                rate-card table beneath, so these two columns wait for a wider screen. */}
            {rates ? <TableHead priority="medium" className="text-right">{t("columns.rate")}</TableHead> : null}
            {usage ? <TableHead priority="low" className="text-right">{t("columns.thisMonth")}</TableHead> : null}
            <TableHead priority="low">{t("columns.renews")}</TableHead>
            <TableHead>{t("columns.status")}</TableHead>
            <TableHead className="text-right">
              <span className="sr-only">{tCommon("actions")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {services.map((s) => {
            const actions = actionsFor(s);
            return (
              <TableRow key={s.id}>
                <TableCell className="max-w-64 truncate font-medium">{s.name}</TableCell>
                <TableCell priority="medium" className="text-muted-foreground">
                  {[
                    t(`kinds.${s.kind}`),
                    s.billingInterval ? t(`intervals.${s.billingInterval}`) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </TableCell>
                <TableCell priority="low">
                  {s.projectKey ? (
                    <span className="num-id font-mono text-xs">{s.projectKey}</span>
                  ) : (
                    <span className="text-muted-foreground">{t("clientLevel")}</span>
                  )}
                </TableCell>
                <TableCell className="num text-right">{money(s) ?? "—"}</TableCell>
                {rates ? (
                  <TableCell priority="medium" className="num text-right" data-testid="agreement-rate">
                    {rates[s.id] ?? <span className="text-muted-foreground">{"—"}</span>}
                  </TableCell>
                ) : null}
                {usage ? (
                  <TableCell priority="low" className="num text-right text-muted-foreground" data-testid="agreement-usage">
                    {usage[s.id] ?? "—"}
                  </TableCell>
                ) : null}
                <TableCell priority="low" className="num text-muted-foreground">
                  {s.renewsAt ? format.dateTime(s.renewsAt, { dateStyle: "medium" }) : "—"}
                </TableCell>
                <TableCell>
                  <StatusBadge domain="serviceStatus" value={s.status} />
                </TableCell>
                <TableCell className="text-right">
                  {actions.length > 0 ? (
                    <RowActions
                      label={tCommon("actionsFor", { name: s.name })}
                      items={actions}
                    />
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
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
