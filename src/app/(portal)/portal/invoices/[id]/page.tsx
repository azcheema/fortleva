import { DownloadIcon, ExternalLinkIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTimeZone, getTranslations } from "next-intl/server";

import { Callout, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { isUuid } from "@/db/context";
import { formatMoney } from "@/lib/format";
import { minorToNumber } from "@/modules/invoicing";
import { readPortalInvoice } from "@/modules/invoicing/portal";
import { readPortalInvoicePayment } from "@/modules/invoicing/portal-writes";
import { portalReadOrNull } from "@/portal";
import { requirePortalContext } from "@/portal/context";

import { PortalFrame } from "../../portal-frame";
import { downloadInvoiceAction } from "../actions";
import { InvoiceStateBadge } from "../state-badge";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("portal.invoices");
  return { title: t("title") };
}

const LINK =
  "rounded-sm text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * `/portal/invoices/[id]` — ONE SENT INVOICE OR CREDIT NOTE (Phase 4 slice
 * 109; founder decision C79 (b), (c)): its number, dates, amount as printed and
 * where it stands; for an invoice still to pay, the agency's PAY NOW link (only
 * while nothing of it has been credited — a fixed-amount link would ask for too
 * much) and the bank details with the invoice number as the reference; its
 * credit notes the client has, and what is left to pay; the PDF (the client's
 * copy of everything, the lines included).
 *
 * The projection reads under the contact (`readPortalInvoice`); the bank
 * details and the link come from the payment broker (a brokered read — the
 * ciphertext and the credit notes a contact cannot see). Anything refused is a
 * 404 — on this plane a reason is a fact about the agency.
 */
export default async function PortalInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  if (!isUuid(id)) notFound();
  const { principal, name } = await requirePortalContext();
  const t = await getTranslations("portal.invoices");
  const tDomain = await getTranslations("domainErrors");
  const locale = await getLocale();
  const format = await getFormatter();
  const timeZone = await getTimeZone();
  const invoice = await portalReadOrNull("readPortalInvoice", () => readPortalInvoice(principal, id, { timeZone }));
  if (!invoice) notFound();
  const payment = invoice.kind === "INVOICE" ? await portalReadOrNull("readPortalInvoicePayment", () => readPortalInvoicePayment(principal, id)) : null;
  const money = (minor: bigint) => formatMoney(locale, minorToNumber(minor), invoice.currency);
  const day = (iso: string) => format.dateTime(new Date(`${iso}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });
  const credit = invoice.kind === "CREDIT_NOTE";
  const open = invoice.state === "TO_PAY" || invoice.state === "OVERDUE";
  const refusal = error === "rate" ? tDomain("DOWNLOAD_RATE_LIMITED") : error ? t("errors.download") : null;
  const payHost = payment?.payLink ? new URL(payment.payLink).hostname : null;

  return (
    <PortalFrame name={name} principal={principal} nav="invoices">
      <Page>
        <div className="flex flex-col gap-6">
          <PageHeader
            title={credit ? t("creditNumber", { number: invoice.displayNumber }) : t("invoiceNumber", { number: invoice.displayNumber })}
            breadcrumb={
              <Link href="/portal/invoices" prefetch={false} className={LINK}>
                {t("back")}
              </Link>
            }
            badges={<InvoiceStateBadge state={invoice.state} />}
          />
          {refusal ? (
            <div data-testid="portal-invoice-error">
              <Callout tone="danger" role="alert">
                {refusal}
              </Callout>
            </div>
          ) : null}

          <SectionCard title={t("facts")}>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2" data-testid="portal-invoice-facts">
              <div className="flex min-w-0 flex-col gap-0.5">
                <dt className="text-xs text-muted-foreground">{t("issueDate")}</dt>
                <dd className="num text-sm">{day(invoice.issueDate)}</dd>
              </div>
              {invoice.dueDate ? (
                <div className="flex min-w-0 flex-col gap-0.5">
                  <dt className="text-xs text-muted-foreground">{t("dueDate")}</dt>
                  <dd className="num text-sm">{day(invoice.dueDate)}</dd>
                </div>
              ) : null}
              <div className="flex min-w-0 flex-col gap-0.5">
                <dt className="text-xs text-muted-foreground">{credit ? t("creditAmount") : t("amount")}</dt>
                <dd className="num text-sm font-medium" data-testid="portal-invoice-total">
                  {money(invoice.amount)}
                </dd>
              </div>
              {invoice.leftToPay !== null ? (
                <div className="flex min-w-0 flex-col gap-0.5">
                  <dt className="text-xs text-muted-foreground">{t("leftToPay")}</dt>
                  <dd className="num text-sm font-medium" data-testid="portal-invoice-left">
                    {money(invoice.leftToPay)}
                  </dd>
                </div>
              ) : null}
              {invoice.credits ? (
                <div className="flex min-w-0 flex-col gap-0.5 sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">{t("credits")}</dt>
                  <dd className="text-sm">
                    {invoice.credits.id ? (
                      <Link href={`/portal/invoices/${invoice.credits.id}`} prefetch={false} className={LINK}>
                        {t("invoiceNumber", { number: invoice.credits.displayNumber })}
                      </Link>
                    ) : (
                      t("invoiceNumber", { number: invoice.credits.displayNumber })
                    )}
                  </dd>
                </div>
              ) : null}
            </dl>
            {/* The PDF: a form post, never a link — the download is audited
                and its link is minted on the way (`files/file-list.tsx`). */}
            <form action={downloadInvoiceAction} className="mt-4">
              <input type="hidden" name="invoiceId" value={invoice.id} />
              <Button type="submit" variant="outline" size="sm" data-testid="portal-invoice-download">
                <DownloadIcon aria-hidden="true" />
                {t("download")}
              </Button>
            </form>
          </SectionCard>

          {open && payment && (payment.payLink || payment.bank) ? (
            <SectionCard title={t("payTitle")} contentClassName="flex flex-col gap-4">
              {payment.payLink ? (
                <div className="flex flex-col gap-1" data-testid="portal-pay-now">
                  <div>
                    <Button asChild size="sm">
                      <a href={payment.payLink} target="_blank" rel="noopener noreferrer">
                        <ExternalLinkIcon aria-hidden="true" />
                        {t("payNow")}
                      </a>
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("payNowOpens", { host: payHost ?? "" })}</p>
                </div>
              ) : null}
              {payment.bank ? (
                <div className="flex flex-col gap-1" data-testid="portal-pay-bank">
                  <p className="text-sm font-medium">{payment.payLink ? t("orBank") : t("bank")}</p>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                    {payment.bank.bankgiro ? (
                      <>
                        <dt className="text-muted-foreground">{t("bankgiro")}</dt>
                        <dd className="num-id font-mono">{payment.bank.bankgiro}</dd>
                      </>
                    ) : null}
                    {payment.bank.plusgiro ? (
                      <>
                        <dt className="text-muted-foreground">{t("plusgiro")}</dt>
                        <dd className="num-id font-mono">{payment.bank.plusgiro}</dd>
                      </>
                    ) : null}
                    {payment.bank.iban ? (
                      <>
                        <dt className="text-muted-foreground">{t("iban")}</dt>
                        <dd className="num-id min-w-0 font-mono break-all">{payment.bank.iban}</dd>
                      </>
                    ) : null}
                    {payment.bank.bic ? (
                      <>
                        <dt className="text-muted-foreground">{t("bic")}</dt>
                        <dd className="num-id font-mono">{payment.bank.bic}</dd>
                      </>
                    ) : null}
                  </dl>
                  <p className="text-xs text-muted-foreground">{t("reference", { number: invoice.displayNumber })}</p>
                </div>
              ) : null}
            </SectionCard>
          ) : null}

          {invoice.creditNotes.length > 0 ? (
            <SectionCard title={t("creditNotes")}>
              <ul className="flex flex-col gap-2" data-testid="portal-invoice-credit-notes">
                {invoice.creditNotes.map((n) => (
                  <li key={n.id} className="flex flex-wrap items-baseline justify-between gap-x-4 text-sm">
                    <Link href={`/portal/invoices/${n.id}`} prefetch={false} className={LINK}>
                      {t("creditNumber", { number: n.displayNumber })}
                    </Link>
                    <span className="num whitespace-nowrap">{money(n.amount)}</span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}
        </div>
      </Page>
    </PortalFrame>
  );
}
