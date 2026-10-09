import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { Callout, EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/format";
import { requireTenantContext } from "@/members/tenant-context";
import { formatFixed, getInvoice, minorToNumber, rateToNumber, type InvoiceDetail } from "@/modules/invoicing";
import { CURRENCIES } from "@/preferences/service";

import { DraftDetails } from "./draft-details";
import { DraftMenu } from "./draft-menu";
import { InvoiceLines } from "./invoice-lines";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("invoices.draft");
  return { title: t("title") };
}

/** A `@db.Date` (UTC midnight) as the date input's value. */
const dayText = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : "");

/**
 * /invoices/[id] (Phase 4 slice 107) — one invoice. A DRAFT is its editor:
 * who it bills (the client's details, read live until it is issued), its
 * details and VAT treatment, its lines, and its totals as the lines make them
 * (VAT once per rate, on the rate's sum). `invoice:view` and the client in
 * the member's direct scope — anything else is a 404 (UI.md §7.3). Editing
 * wants `invoice:edit`, deleting `invoice:delete`; issuing is slice 108.
 */
export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("invoices.draft");
  const tCommon = await getTranslations("common");
  const locale = await getLocale();

  let invoice: InvoiceDetail | null = null;
  try {
    invoice = await getInvoice({ tenantId: membership.tenantId, actor }, id);
  } catch (e) {
    if (!(e instanceof AuthzError)) throw e;
    if (e.reason === "NOT_FOUND") notFound();
  }
  if (!invoice) {
    return (
      <Page>
        <PageHeader title={t("title")} />
        <div className="mt-6">
          <SectionCard>
            <EmptyState variant="forbidden" title={tCommon("forbiddenTitle")} body={t("noPermission")} />
          </SectionCard>
        </div>
      </Page>
    );
  }

  const draft = invoice.status === "DRAFT";
  const client = invoice.client;
  const money = (minor: bigint) => formatMoney(locale, minorToNumber(minor), invoice.currency);
  const address = [client.addressLine1, client.addressLine2, [client.postalCode, client.city].filter(Boolean).join(" "), client.countryCode]
    .filter((s): s is string => Boolean(s && s.trim()));
  const reducedRateLines = invoice.lines.filter((l) => l.vatRate === 1200n || l.vatRate === 600n).length;

  return (
    <Page>
      <PageHeader
        title={draft ? t("title") : (invoice.displayNumber ?? t("title"))}
        description={client.name}
        actions={
          <div className="flex items-center gap-2">
            {draft ? <Badge variant="neutral">{t("draftBadge")}</Badge> : null}
            {invoice.can.delete ? <DraftMenu invoiceId={invoice.id} label={t("menuLabel")} /> : null}
          </div>
        }
      />
      <div className="mt-6 flex flex-col gap-4">
        {draft ? <p className="text-sm text-muted-foreground">{t("noNumberYet")}</p> : null}

        <SectionCard
          title={t("billTo.title")}
          actions={
            <Link
              href={`/clients/${client.id}`}
              className="rounded-sm text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {t("billTo.edit")}
            </Link>
          }
        >
          <div className="flex flex-col gap-3" data-testid="bill-to">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-0.5">
                <dt className="text-xs text-muted-foreground">{t("billTo.name")}</dt>
                <dd className="min-w-0 text-sm font-medium">{client.name}</dd>
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <dt className="text-xs text-muted-foreground">{t("billTo.address")}</dt>
                <dd className="min-w-0 text-sm">
                  {address.length > 0 ? address.map((line, i) => <span key={i} className="block">{line}</span>) : <span className="text-muted-foreground">{tCommon("notSet")}</span>}
                </dd>
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <dt className="text-xs text-muted-foreground">{t("billTo.orgNr")}</dt>
                <dd className="num-id min-w-0 font-mono text-sm">{client.orgNr ?? <span className="font-sans text-muted-foreground">{tCommon("notSet")}</span>}</dd>
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <dt className="text-xs text-muted-foreground">{t("billTo.vatNumber")}</dt>
                <dd className="num-id min-w-0 font-mono text-sm">{client.vatNumber ?? <span className="font-sans text-muted-foreground">{tCommon("notSet")}</span>}</dd>
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <dt className="text-xs text-muted-foreground">{t("billTo.email")}</dt>
                <dd className="min-w-0 truncate text-sm">{client.billingEmail ?? <span className="text-muted-foreground">{tCommon("notSet")}</span>}</dd>
              </div>
            </dl>
            {draft ? <p className="text-xs text-muted-foreground">{t("billTo.live")}</p> : null}
            {client.archived ? (
              <Callout tone="caution">{t("billTo.archived")}</Callout>
            ) : null}
            {draft && invoice.vatProfile === "EU_REVERSE_CHARGE" && !client.vatNumber ? (
              <div data-testid="reverse-charge-no-vat">
                <Callout tone="caution">{t("billTo.reverseChargeNeedsVat")}</Callout>
              </div>
            ) : null}
          </div>
        </SectionCard>

        <SectionCard title={t("details.title")}>
          <DraftDetails
            invoiceId={invoice.id}
            editable={invoice.can.edit}
            currencies={CURRENCIES.includes(invoice.currency as (typeof CURRENCIES)[number]) ? CURRENCIES : [...CURRENCIES, invoice.currency]}
            projects={invoice.projects}
            reducedRateLines={reducedRateLines}
            values={{
              vatProfile: invoice.vatProfile,
              currency: invoice.currency,
              paymentTermsDays: invoice.paymentTermsDays,
              projectId: invoice.project?.id ?? "",
              periodStart: dayText(invoice.periodStart),
              periodEnd: dayText(invoice.periodEnd),
              buyerReference: invoice.buyerReference ?? "",
              ourReference: invoice.ourReference ?? "",
              note: invoice.note ?? "",
            }}
          />
        </SectionCard>

        <SectionCard title={t("lines.title")} description={t("lines.description", { currency: invoice.currency })} contentClassName="flex flex-col gap-3">
          <InvoiceLines
            invoiceId={invoice.id}
            vatProfile={invoice.vatProfile}
            editable={invoice.can.edit}
            lines={invoice.lines.map((l) => ({
              id: l.id,
              description: l.description,
              quantity: formatFixed(l.quantity, 3),
              unit: l.unit,
              unitPrice: formatFixed(l.unitPrice, 2),
              vatRate: formatFixed(l.vatRate, 2),
              amount: formatFixed(l.amount, 2),
            }))}
          />
        </SectionCard>

        <SectionCard title={t("totals.title")}>
          <dl className="ml-auto grid w-full max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm" data-testid="invoice-totals">
            <dt className="text-muted-foreground">{t("totals.subtotal")}</dt>
            <dd className="num text-right" data-testid="invoice-subtotal">{money(invoice.totals.subtotal)}</dd>
            {invoice.vatProfile === "SE_DOMESTIC" ? (
              invoice.totals.groups.map((g) => (
                <div key={String(g.rate)} className="contents">
                  <dt className="text-muted-foreground">{t("totals.vatAt", { rate: rateToNumber(g.rate), base: money(g.net) })}</dt>
                  <dd className="num text-right" data-testid="invoice-vat-group">{money(g.vat)}</dd>
                </div>
              ))
            ) : (
              <>
                <dt className="text-muted-foreground">{t(`totals.noVat.${invoice.vatProfile}`)}</dt>
                <dd className="num text-right">{money(0n)}</dd>
              </>
            )}
            <dt className="border-t border-border pt-1 font-medium">{t("totals.total")}</dt>
            <dd className="num border-t border-border pt-1 text-right font-medium" data-testid="invoice-total">{money(invoice.totals.total)}</dd>
          </dl>
        </SectionCard>
      </div>
    </Page>
  );
}
