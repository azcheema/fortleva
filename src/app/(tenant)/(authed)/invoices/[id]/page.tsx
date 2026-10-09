import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { enrolUrl } from "@/authz/redirects";
import { Callout, DataTable, EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney } from "@/lib/format";
import { requireTenantContext } from "@/members/tenant-context";
import { formatFixed, getInvoice, minorToNumber, printFxRate, rateToNumber, signed, type InvoiceDetail } from "@/modules/invoicing";
import { CURRENCIES } from "@/preferences/service";

import { CreditDialog } from "./credit-dialog";
import { CreditReason } from "./credit-reason";
import { DownloadPdf } from "./download-pdf";
import { DraftDetails } from "./draft-details";
import { DraftMenu } from "./draft-menu";
import { InvoiceLines } from "./invoice-lines";
import { IssueDialog } from "./issue-dialog";
import { PaidDialog } from "./paid-dialog";
import { PaidMenu } from "./paid-menu";
import { SendDialog } from "./send-dialog";

export async function generateMetadata(): Promise<Metadata> {
  // Neutral: the same route is a draft and, once issued, an invoice.
  const t = await getTranslations("invoices.issued");
  return { title: t("pageTitle") };
}

/** A `@db.Date` (UTC midnight) as the date input's value. */
const dayText = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : "");

const LINK =
  "rounded-sm text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * /invoices/[id] (Phase 4 slices 107–108b) — one invoice or CREDIT NOTE. A
 * DRAFT is its editor: who it bills (the client's details, read live until it
 * is issued), its details, language and VAT treatment, its lines, its totals
 * as the lines make them — and, for a member who may issue, **Issue invoice…**
 * (slice 108). An ISSUED invoice is shown from its FROZEN record only (the
 * guard's snapshots, the stored totals and rate): who it was billed to as it
 * was then, its dates, the VAT in SEK when there is some, and **Download
 * PDF**; nothing on it is editable, and for a member who may credit and
 * issue, **Credit…** (slice 108b) — with its credit notes listed and "Partly
 * credited" derived from them.
 *
 * A CREDIT NOTE (slice 108b; C77) names the invoice it credits and why; its
 * terms are that invoice's (read-only), it bills the parties as that invoice
 * did, and every amount and quantity it shows has a minus sign (C77 (a) — the
 * one rule, `signed`). A draft of one is edited and issued like an invoice
 * (**Issue credit note…**), by a member who may credit.
 *
 * `invoice:view` and the client in the member's direct scope — anything else
 * is a 404 (UI.md §7.3).
 */
export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("invoices.draft");
  const tIssue = await getTranslations("invoices.issue");
  const tIssued = await getTranslations("invoices.issued");
  const tCredit = await getTranslations("invoices.credit");
  const tStatus = await getTranslations("invoices.list.status");
  const tSend = await getTranslations("invoices.send");
  const tPayment = await getTranslations("invoices.payment");
  const tMissing = await getTranslations("settings.invoicing.missing.items");
  const tCommon = await getTranslations("common");
  const locale = await getLocale();
  const format = await getFormatter();

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
  const credit = invoice.kind === "CREDIT_NOTE";
  const issued = invoice.issued;
  // Every amount a credit note shows has a minus sign (C77 (a)).
  const sign = (minor: bigint) => signed(minor, invoice.kind);
  const money = (minor: bigint, currency = invoice.currency) => formatMoney(locale, minorToNumber(minor), currency);
  // Who it bills: live on an invoice's draft; as the credited invoice named
  // them on a credit note's draft; as it was at issue once issued.
  const party = issued
    ? { ...issued.print.buyer, billingEmail: null }
    : credit && invoice.creditsBuyer
      ? { ...invoice.creditsBuyer, billingEmail: null }
      : { ...invoice.client, name: invoice.client.name };
  const liveParty = draft && !credit;
  const address = [party.addressLine1, party.addressLine2, [party.postalCode, party.city].filter(Boolean).join(" "), party.countryCode]
    .filter((s): s is string => Boolean(s && s.trim()));
  const totals = issued ? issued.print.totals : invoice.totals;
  const reducedRateLines = invoice.lines.filter((l) => l.vatRate === 1200n || l.vatRate === 600n).length;
  const check = invoice.issueCheck;
  const number = invoice.displayNumber ?? "";
  const title = draft
    ? credit
      ? t("creditTitle")
      : t("title")
    : credit
      ? tIssued("creditTitle", { number })
      : tIssued("title", { number });
  const summary = invoice.creditSummary;
  // ONE rule on this page (the code review's low: a draft's lines positive
  // above totals negative): a credit note's DRAFT shows what it credits,
  // positive — its lines' caption says the credit note prints them with a
  // minus sign —; an issued one shows them as printed. The issue dialog shows
  // the total as it will print.
  const lineSign = (minor: bigint) => (draft ? minor : sign(minor));
  // The VAT in SEK on a draft: the latest rate, that of the day the work ended
  // (C78 (a)), or — a credit note — its invoice's.
  const fxNote = !check?.needsFx
    ? null
    : check.kind === "CREDIT_NOTE"
      ? check.rateDay === null
        ? null // its invoice stated no rate: the noRate blocker says so
        : tIssue("creditFx", { date: check.rateDay })
      : check.rateDay !== null && check.rateDay !== check.issueDate
        ? tIssue("fxDay", { date: check.rateDay })
        : tIssue("fx");

  return (
    <Page>
      <PageHeader
        title={title}
        description={party.name}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {draft ? (
              <Badge variant="neutral">{t("draftBadge")}</Badge>
            ) : (
              <Badge variant="brand" data-testid="invoice-status">
                {tStatus(invoice.status)}
              </Badge>
            )}
            {summary?.partly ? (
              <Badge variant="caution" data-testid="invoice-partly-credited">
                {tCredit("partlyBadge")}
              </Badge>
            ) : null}
            {invoice.overdue ? (
              <Badge variant="caution" data-testid="invoice-overdue">
                {tPayment("overdue")}
              </Badge>
            ) : null}
            {issued ? <DownloadPdf invoiceId={invoice.id} /> : null}
            {issued && invoice.can.send && invoice.displayNumber ? (
              <SendDialog
                invoiceId={invoice.id}
                credit={credit}
                displayNumber={invoice.displayNumber}
                billingEmail={invoice.client.billingEmail}
                billingEmailBlocked={invoice.billingEmailBlocked}
                sentBefore={invoice.sentAt !== null}
                canMarkSent={invoice.can.markSent}
              />
            ) : null}
            {invoice.can.markPaid && invoice.displayNumber && invoice.today ? (
              <PaidDialog invoiceId={invoice.id} displayNumber={invoice.displayNumber} today={invoice.today} />
            ) : null}
            {invoice.can.markUnpaid ? <PaidMenu invoiceId={invoice.id} label={tPayment("menuLabel")} /> : null}
            {invoice.can.credit && invoice.displayNumber ? (
              <CreditDialog
                invoiceId={invoice.id}
                displayNumber={invoice.displayNumber}
                partlyCredited={Boolean(summary?.partly)}
                canCopy={invoice.can.copy}
              />
            ) : null}
            {draft && invoice.can.issue && check ? (
              <IssueDialog
                invoiceId={invoice.id}
                clientId={invoice.client.id}
                total={money(sign(invoice.totals.total))}
                check={{
                  kind: check.kind,
                  blockers: check.blockers,
                  sellerMissing: check.sellerMissing.map((m) => tMissing(m)).join(", "),
                  nextNumber: check.nextNumber,
                  issueDate: check.issueDate,
                  dueDate: check.dueDate,
                  needsFx: check.needsFx,
                  rateDay: check.rateDay,
                  overCredit: check.overCredit.map((o) => ({
                    // A number: the message says "{rate} %" itself (the code review's low: "25 % %").
                    rate: String(rateToNumber(o.rate)),
                    asked: money(o.asked),
                    left: money(o.left),
                  })),
                  language: t(`locale.names.${check.locale}`),
                  noPeriod: check.noPeriod,
                  creditsIssueDate: check.creditsIssueDate,
                  fingerprint: check.fingerprint,
                  paymentText: check.paymentText,
                }}
                payLink={invoice.payLinkUrl}
                hasFactor={actor.mfa?.enrolled === true}
                enrolHref={enrolUrl(`/invoices/${invoice.id}`)}
              />
            ) : null}
            {invoice.can.delete ? (
              <DraftMenu invoiceId={invoice.id} label={credit ? t("creditMenuLabel") : t("menuLabel")} creditNote={credit} />
            ) : null}
          </div>
        }
      />
      <div className="mt-6 flex flex-col gap-4">
        {draft ? <p className="text-sm text-muted-foreground">{credit ? t("creditNoNumberYet") : t("noNumberYet")}</p> : null}
        {issued && issued.pdfFileId === null ? (
          <p className="text-sm text-muted-foreground" data-testid="invoice-pdf-missing">
            {tIssued("pdfMissing")}
          </p>
        ) : null}
        {invoice.creditUnsent ? (
          <div data-testid="credit-unsent">
            <Callout tone="caution">{tSend("creditUnsent")}</Callout>
          </div>
        ) : null}

        {credit ? (
          <SectionCard title={tIssued("creditPageTitle")}>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2" data-testid="credit-note-of">
              <div className="flex min-w-0 flex-col gap-0.5">
                <dt className="px-2.5 text-xs text-muted-foreground">{tCredit("credits")}</dt>
                <dd className="min-w-0 px-2.5 text-sm">
                  {invoice.credits ? (
                    <Link href={`/invoices/${invoice.credits.id}`} className={LINK} data-testid="credit-note-original">
                      {tCredit("creditsLink", { number: invoice.credits.displayNumber ?? "" })}
                    </Link>
                  ) : null}
                  {invoice.credits?.issueDate ? <span className="num ml-2 text-muted-foreground">{invoice.credits.issueDate}</span> : null}
                </dd>
              </div>
              {draft && invoice.creditLeft ? (
                <div className="flex min-w-0 flex-col gap-0.5">
                  <dt className="px-2.5 text-xs text-muted-foreground">{tCredit("left")}</dt>
                  <dd className="num min-w-0 px-2.5 text-sm" data-testid="credit-left">
                    {[...invoice.creditLeft].map(([rate, left]) => (
                      <span key={String(rate)} className="block">
                        {tCredit("leftAt", { rate: rateToNumber(rate), amount: money(left) })}
                      </span>
                    ))}
                  </dd>
                </div>
              ) : null}
              <div className="flex min-w-0 flex-col gap-0.5 sm:col-span-2" data-testid="credit-reason">
                <dt className="px-2.5 text-xs text-muted-foreground">{tCredit("reasonLabel")}</dt>
                <dd className="min-w-0">
                  {draft ? (
                    <CreditReason invoiceId={invoice.id} value={invoice.creditReason ?? ""} editable={invoice.can.edit} />
                  ) : (
                    <p className="px-2.5 text-sm whitespace-pre-line">{invoice.creditReason}</p>
                  )}
                </dd>
              </div>
            </dl>
          </SectionCard>
        ) : null}

        <SectionCard
          title={issued ? tIssued("billedTo") : t("billTo.title")}
          actions={
            liveParty ? (
              <Link href={`/clients/${invoice.client.id}`} className={LINK}>
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
              {liveParty ? (
                <div className="flex min-w-0 flex-col gap-0.5">
                  <dt className="text-xs text-muted-foreground">{t("billTo.email")}</dt>
                  <dd className="min-w-0 truncate text-sm">{invoice.client.billingEmail ?? <span className="text-muted-foreground">{tCommon("notSet")}</span>}</dd>
                </div>
              ) : null}
            </dl>
            <p className="text-xs text-muted-foreground">
              {liveParty ? t("billTo.live") : draft ? t("billTo.asOriginal") : tIssued("asIssued")}
            </p>
            {liveParty && invoice.client.archived ? <Callout tone="caution">{t("billTo.archived")}</Callout> : null}
            {liveParty && invoice.vatProfile === "EU_REVERSE_CHARGE" && !invoice.client.vatNumber ? (
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
              {credit ? null : (
                <div className="flex min-w-0 flex-col gap-0.5">
                  <dt className="text-xs text-muted-foreground">{tIssued("dueDate")}</dt>
                  <dd className="num text-sm">{issued.print.dueDate}</dd>
                </div>
              )}
              {/* Slice 109: who issued it — what the owners' Pay now notice
                  sends them here to check. */}
              {invoice.issuedBy ? (
                <div className="flex min-w-0 flex-col gap-0.5 sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">{tIssued("issuedBy")}</dt>
                  <dd className="text-sm" data-testid="invoice-issued-by">
                    {tSend("historyBy", {
                      name: invoice.issuedBy.name ?? tIssued("issuedByGone"),
                      when: format.dateTime(invoice.issuedBy.at, { dateStyle: "medium", timeStyle: "short" }),
                    })}
                  </dd>
                </div>
              ) : null}
              {/* Slice 109 (C79 (d)): a payment marked by hand — its day, and
                  the team's own note (never the client's to read). */}
              {invoice.paidOn ? (
                <div className="flex min-w-0 flex-col gap-0.5 sm:col-span-2" data-testid="invoice-paid">
                  <dt className="text-xs text-muted-foreground">{tPayment("paidOnLabel")}</dt>
                  <dd className="text-sm">
                    <span className="num">{dayText(invoice.paidOn)}</span>
                    {invoice.paymentNote ? (
                      <span className="mt-0.5 block whitespace-pre-line text-muted-foreground" data-testid="invoice-payment-note">
                        {invoice.paymentNote}
                      </span>
                    ) : null}
                  </dd>
                </div>
              ) : null}
            </dl>
            {issued.paymentUnreadable ? (
              <div className="mt-3">
                <Callout tone="caution">{tIssued("paymentUnreadable")}</Callout>
              </div>
            ) : null}
          </SectionCard>
        ) : null}

        {/* Slice 109 (C79 (a), (e)): every send — emailed to whom, or marked
            as sent — newest first. Until the first, the client cannot see it. */}
        {issued ? (
          <SectionCard title={tSend("historyTitle")} description={invoice.sentAt ? undefined : tSend("notSentYet")}>
            {invoice.deliveries.length > 0 ? (
              <ul className="flex flex-col gap-2" data-testid="invoice-deliveries">
                {invoice.deliveries.map((d) => (
                  <li key={d.id} className="flex min-w-0 flex-col gap-0.5 text-sm" data-testid="invoice-delivery" data-method={d.method}>
                    <span className="min-w-0 wrap-break-word">
                      {d.method === "EMAIL" ? tSend("historyEmailed", { list: d.recipients.join(", ") }) : tSend("historyMarked")}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {tSend("historyBy", {
                        when: format.dateTime(d.at, { dateStyle: "medium", timeStyle: "short" }),
                        name: d.by ?? tSend("someoneGone"),
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground" data-testid="invoice-deliveries-none">
                {tSend("historyNone")}
              </p>
            )}
          </SectionCard>
        ) : null}

        {summary && summary.notes.length > 0 ? (
          <SectionCard title={tCredit("notesTitle")} contentClassName="p-0">
            <DataTable flush scrollLabel={tCredit("notesTitle")}>
              <Table data-testid="credit-notes">
                <TableHeader>
                  <TableRow>
                    <TableHead>{tCredit("notesColumns.number")}</TableHead>
                    <TableHead>{tCredit("notesColumns.date")}</TableHead>
                    <TableHead className="text-right">{tCredit("notesColumns.amount")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summary.notes.map((n) => (
                    <TableRow key={n.id} data-testid="credit-note-row" data-status={n.status}>
                      <TableCell className="whitespace-nowrap">
                        <Link href={`/invoices/${n.id}`} className={LINK}>
                          {n.displayNumber ? <span className="num-id font-mono">{n.displayNumber}</span> : tCredit("noteDraft")}
                        </Link>
                      </TableCell>
                      <TableCell className="num whitespace-nowrap text-muted-foreground">{n.issueDate ? dayText(n.issueDate) : null}</TableCell>
                      <TableCell className="num text-right whitespace-nowrap" data-testid="credit-note-amount">
                        {n.total === null ? null : money(signed(n.total, "CREDIT_NOTE"))}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </DataTable>
          </SectionCard>
        ) : null}

        <SectionCard title={t("details.title")}>
          <DraftDetails
            invoiceId={invoice.id}
            editable={invoice.can.edit}
            creditNote={credit}
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
              payLinkUrl: invoice.payLinkUrl ?? "",
            }}
          />
          {credit && draft ? <p className="mt-3 text-xs text-muted-foreground">{t("creditFixed")}</p> : null}
        </SectionCard>

        <SectionCard
          title={t("lines.title")}
          description={credit && draft ? t("creditLines", { currency: invoice.currency }) : t("lines.description", { currency: invoice.currency })}
          contentClassName="flex flex-col gap-3"
        >
          <InvoiceLines
            invoiceId={invoice.id}
            vatProfile={invoice.vatProfile}
            editable={invoice.can.edit}
            lines={invoice.lines.map((l) => ({
              id: l.id,
              description: l.description,
              quantity: formatFixed(lineSign(l.quantity), 3),
              unit: l.unit,
              unitPrice: formatFixed(l.unitPrice, 2),
              vatRate: formatFixed(l.vatRate, 2),
              amount: formatFixed(lineSign(l.amount), 2),
            }))}
          />
        </SectionCard>

        <SectionCard title={t("totals.title")}>
          <dl className="ml-auto grid w-full max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm" data-testid="invoice-totals">
            <dt className="text-muted-foreground">{t("totals.subtotal")}</dt>
            <dd className="num text-right" data-testid="invoice-subtotal">{money(lineSign(totals.subtotal))}</dd>
            {invoice.vatProfile === "SE_DOMESTIC" ? (
              totals.groups.map((g) => (
                <div key={String(g.rate)} className="contents">
                  <dt className="text-muted-foreground">{t("totals.vatAt", { rate: rateToNumber(g.rate), base: money(lineSign(g.net)) })}</dt>
                  <dd className="num text-right" data-testid="invoice-vat-group">{money(lineSign(g.vat))}</dd>
                </div>
              ))
            ) : (
              <>
                <dt className="text-muted-foreground">{t(`totals.noVat.${invoice.vatProfile}`)}</dt>
                <dd className="num text-right">{money(0n)}</dd>
              </>
            )}
            <dt className="border-t border-border pt-1 font-medium">{t("totals.total")}</dt>
            <dd className="num border-t border-border pt-1 text-right font-medium" data-testid="invoice-total">{money(lineSign(totals.total))}</dd>
          </dl>
          {issued?.print.sekVat ? (
            <dl className="mt-4 ml-auto grid w-full max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm" data-testid="invoice-sek-vat">
              <dt className="col-span-2 text-xs text-muted-foreground">{tIssued("sekTitle")}</dt>
              {issued.print.sekVat.groups.map((g) => (
                <div key={String(g.rate)} className="contents">
                  <dt className="text-muted-foreground">{tIssued("sekAt", { rate: rateToNumber(g.rate) })}</dt>
                  <dd className="num text-right">{money(sign(g.vatSek), "SEK")}</dd>
                </div>
              ))}
              {issued.print.sekVat.groups.length > 1 ? (
                <>
                  <dt className="text-muted-foreground">{tIssued("sekTotal")}</dt>
                  <dd className="num text-right">{money(sign(issued.print.sekVat.totalSek), "SEK")}</dd>
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
          {draft && fxNote ? <p className="mt-3 text-xs text-muted-foreground">{fxNote}</p> : null}
        </SectionCard>
      </div>
    </Page>
  );
}
