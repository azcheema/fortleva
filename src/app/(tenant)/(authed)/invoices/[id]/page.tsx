import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { Callout, EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/format";
import { requireTenantContext } from "@/members/tenant-context";
import { formatFixed, getInvoice, minorToNumber, printFxRate, rateToNumber, type InvoiceDetail } from "@/modules/invoicing";
import { CURRENCIES } from "@/preferences/service";

import { DownloadPdf } from "./download-pdf";
import { DraftDetails } from "./draft-details";
import { DraftMenu } from "./draft-menu";
import { InvoiceLines } from "./invoice-lines";
import { IssueDialog } from "./issue-dialog";

export async function generateMetadata(): Promise<Metadata> {
  // Neutral: the same route is a draft and, once issued, an invoice.
  const t = await getTranslations("invoices.issued");
  return { title: t("pageTitle") };
}

/** A `@db.Date` (UTC midnight) as the date input's value. */
const dayText = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : "");

/**
 * /invoices/[id] (Phase 4 slices 107–108) — one invoice. A DRAFT is its
 * editor: who it bills (the client's details, read live until it is issued),
 * its details, language and VAT treatment, its lines, its totals as the lines
 * make them — and, for a member who may issue, **Issue invoice…** (slice 108).
 * An ISSUED invoice is shown from its FROZEN record only (the guard's
 * snapshots, the stored totals and rate): who it was billed to as it was then,
 * its dates, the VAT in SEK when there is some, and **Download PDF**. Nothing
 * on it is editable. `invoice:view` and the client in the member's direct
 * scope — anything else is a 404 (UI.md §7.3).
 */
export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("invoices.draft");
  const tIssue = await getTranslations("invoices.issue");
  const tIssued = await getTranslations("invoices.issued");
  const tStatus = await getTranslations("invoices.list.status");
  const tMissing = await getTranslations("settings.invoicing.missing.items");
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
  const issued = invoice.issued;
  const money = (minor: bigint, currency = invoice.currency) => formatMoney(locale, minorToNumber(minor), currency);
  // Who it bills: live on a draft, as it was at issue once issued.
  const party = issued
    ? { ...issued.print.buyer, billingEmail: null }
    : { ...invoice.client, name: invoice.client.name };
  const address = [party.addressLine1, party.addressLine2, [party.postalCode, party.city].filter(Boolean).join(" "), party.countryCode]
    .filter((s): s is string => Boolean(s && s.trim()));
  const totals = issued ? issued.print.totals : invoice.totals;
  const reducedRateLines = invoice.lines.filter((l) => l.vatRate === 1200n || l.vatRate === 600n).length;
  const check = invoice.issueCheck;
  const title = draft ? t("title") : tIssued("title", { number: invoice.displayNumber ?? "" });

  return (
    <Page>
      <PageHeader
        title={title}
        description={issued ? issued.print.buyer.name : invoice.client.name}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {draft ? (
              <Badge variant="neutral">{t("draftBadge")}</Badge>
            ) : (
              <Badge variant="brand" data-testid="invoice-status">
                {tStatus(invoice.status)}
              </Badge>
            )}
            {issued ? <DownloadPdf invoiceId={invoice.id} /> : null}
            {draft && invoice.can.issue && check ? (
              <IssueDialog
                invoiceId={invoice.id}
                clientId={invoice.client.id}
                total={money(invoice.totals.total)}
                check={{
                  blockers: check.blockers,
                  sellerMissing: check.sellerMissing.map((m) => tMissing(m)).join(", "),
                  nextNumber: check.nextNumber,
                  issueDate: check.issueDate,
                  dueDate: check.dueDate,
                  needsFx: check.needsFx,
                  language: t(`locale.names.${check.locale}`),
                  noPeriod: check.noPeriod,
                  fingerprint: check.fingerprint,
                }}
              />
            ) : null}
            {invoice.can.delete ? <DraftMenu invoiceId={invoice.id} label={t("menuLabel")} /> : null}
          </div>
        }
      />
      <div className="mt-6 flex flex-col gap-4">
        {draft ? <p className="text-sm text-muted-foreground">{t("noNumberYet")}</p> : null}
        {issued && issued.pdfFileId === null ? (
          <p className="text-sm text-muted-foreground" data-testid="invoice-pdf-missing">
            {tIssued("pdfMissing")}
          </p>
        ) : null}

        <SectionCard
          title={issued ? tIssued("billedTo") : t("billTo.title")}
          actions={
            draft ? (
              <Link
                href={`/clients/${invoice.client.id}`}
                className="rounded-sm text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {t("billTo.edit")}
              </Link>
            ) : undefined
          }
        >
          <div className="flex flex-col gap-3" data-testid="bill-to">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-0.5">
                <dt className="text-xs text-muted-foreground">{t("billTo.name")}</dt>
                <dd className="min-w-0 text-sm font-medium">{party.name}</dd>
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <dt className="text-xs text-muted-foreground">{t("billTo.address")}</dt>
                <dd className="min-w-0 text-sm">
                  {address.length > 0 ? address.map((line, i) => <span key={i} className="block">{line}</span>) : <span className="text-muted-foreground">{tCommon("notSet")}</span>}
                </dd>
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <dt className="text-xs text-muted-foreground">{t("billTo.orgNr")}</dt>
                <dd className="num-id min-w-0 font-mono text-sm">{party.orgNr ?? <span className="font-sans text-muted-foreground">{tCommon("notSet")}</span>}</dd>
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <dt className="text-xs text-muted-foreground">{t("billTo.vatNumber")}</dt>
                <dd className="num-id min-w-0 font-mono text-sm">{party.vatNumber ?? <span className="font-sans text-muted-foreground">{tCommon("notSet")}</span>}</dd>
              </div>
              {draft ? (
                <div className="flex min-w-0 flex-col gap-0.5">
                  <dt className="text-xs text-muted-foreground">{t("billTo.email")}</dt>
                  <dd className="min-w-0 truncate text-sm">{invoice.client.billingEmail ?? <span className="text-muted-foreground">{tCommon("notSet")}</span>}</dd>
                </div>
              ) : null}
            </dl>
            <p className="text-xs text-muted-foreground">{draft ? t("billTo.live") : tIssued("asIssued")}</p>
            {draft && invoice.client.archived ? <Callout tone="caution">{t("billTo.archived")}</Callout> : null}
            {draft && invoice.vatProfile === "EU_REVERSE_CHARGE" && !invoice.client.vatNumber ? (
              <div data-testid="reverse-charge-no-vat">
                <Callout tone="caution">{t("billTo.reverseChargeNeedsVat")}</Callout>
              </div>
            ) : null}
          </div>
        </SectionCard>

        {issued ? (
          <SectionCard title={tIssued("dates")}>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2" data-testid="invoice-dates">
              <div className="flex min-w-0 flex-col gap-0.5">
                <dt className="text-xs text-muted-foreground">{tIssued("issueDate")}</dt>
                <dd className="num text-sm">{issued.print.issueDate}</dd>
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <dt className="text-xs text-muted-foreground">{tIssued("dueDate")}</dt>
                <dd className="num text-sm">{issued.print.dueDate}</dd>
              </div>
            </dl>
            {issued.paymentUnreadable ? (
              <div className="mt-3">
                <Callout tone="caution">{tIssued("paymentUnreadable")}</Callout>
              </div>
            ) : null}
          </SectionCard>
        ) : null}

        <SectionCard title={t("details.title")}>
          <DraftDetails
            invoiceId={invoice.id}
            editable={invoice.can.edit}
            currencies={CURRENCIES.includes(invoice.currency as (typeof CURRENCIES)[number]) ? CURRENCIES : [...CURRENCIES, invoice.currency]}
            projects={invoice.projects}
            reducedRateLines={reducedRateLines}
            clientLocale={invoice.clientLocale}
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
              locale: invoice.locale ?? "",
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
            <dd className="num text-right" data-testid="invoice-subtotal">{money(totals.subtotal)}</dd>
            {invoice.vatProfile === "SE_DOMESTIC" ? (
              totals.groups.map((g) => (
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
            <dd className="num border-t border-border pt-1 text-right font-medium" data-testid="invoice-total">{money(totals.total)}</dd>
          </dl>
          {issued?.print.sekVat ? (
            <dl className="mt-4 ml-auto grid w-full max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm" data-testid="invoice-sek-vat">
              <dt className="col-span-2 text-xs text-muted-foreground">{tIssued("sekTitle")}</dt>
              {issued.print.sekVat.groups.map((g) => (
                <div key={String(g.rate)} className="contents">
                  <dt className="text-muted-foreground">{tIssued("sekAt", { rate: rateToNumber(g.rate) })}</dt>
                  <dd className="num text-right">{money(g.vatSek, "SEK")}</dd>
                </div>
              ))}
              {issued.print.sekVat.groups.length > 1 ? (
                <>
                  <dt className="text-muted-foreground">{tIssued("sekTotal")}</dt>
                  <dd className="num text-right">{money(issued.print.sekVat.totalSek, "SEK")}</dd>
                </>
              ) : null}
              <dd className="col-span-2 text-xs text-muted-foreground">
                {tIssued("sekRate", {
                  rate: printFxRate(issued.print.sekVat.micros, locale.startsWith("sv") ? "sv" : "en"),
                  currency: invoice.currency,
                  date: issued.print.sekVat.date,
                })}
              </dd>
            </dl>
          ) : null}
          {draft && check?.needsFx ? <p className="mt-3 text-xs text-muted-foreground">{tIssue("fx")}</p> : null}
        </SectionCard>
      </div>
    </Page>
  );
}
