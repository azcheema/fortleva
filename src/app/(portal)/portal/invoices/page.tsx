import type { Metadata } from "next";
import Link from "next/link";
import { getFormatter, getLocale, getTimeZone, getTranslations } from "next-intl/server";

import { Callout, Page, PageHeader, SectionCard } from "@/components/semantic";
import { formatMoney } from "@/lib/format";
import { minorToNumber } from "@/modules/invoicing";
import { listPortalInvoices } from "@/modules/invoicing/portal";
import { portalReadOrNull } from "@/portal";
import { requirePortalContext } from "@/portal/context";

import { PortalFrame } from "../portal-frame";
import { PortalTasksEmpty } from "../task-list";
import { InvoiceStateBadge } from "./state-badge";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("portal.invoices");
  return { title: t("title") };
}

/**
 * `/portal/invoices` — THE CLIENT'S INVOICES (Phase 4 slice 109; founder
 * decision C79 (b)): every invoice and credit note of their company that the
 * agency has SENT, newest first — its number, date, due date, the amount as
 * printed (a credit note's with a minus sign) and where it stands. Main
 * contacts only (AUTHZ §8 — and the database's `portal_invoice_primary`).
 *
 * A LIST, NOT A TABLE: one row per document whose facts wrap on a phone (the
 * files page's shape) — a client reads this on whatever is in their hand.
 *
 * NO VIEW-AS TWIN, as Logins: View-as is open to members who hold no
 * `invoice:view`, so it must not be a way to read invoices; the nav entry is
 * still drawn inside View-as's frame from a count.
 *
 * Every way this can be empty is one page (`portalReadOrNull`): not a main
 * contact, the module closed, nothing sent yet.
 */
export default async function PortalInvoicesPage() {
  const { principal, name } = await requirePortalContext();
  const t = await getTranslations("portal.invoices");
  const locale = await getLocale();
  const format = await getFormatter();
  const timeZone = await getTimeZone();
  const list = await portalReadOrNull("listPortalInvoices", () => listPortalInvoices(principal, { timeZone }));
  const invoices = list?.invoices ?? [];
  // A stored `@db.Date` (UTC midnight), formatted in UTC so no zone shifts the day.
  const day = (iso: string) => format.dateTime(new Date(`${iso}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });

  return (
    <PortalFrame name={name} principal={principal} nav="invoices">
      <Page>
        <div className="flex flex-col gap-6">
          <PageHeader title={t("title")} description={t("description")} />
          {invoices.length === 0 ? (
            <PortalTasksEmpty />
          ) : (
            <>
              {list?.truncated ? <Callout tone="info">{t("truncated", { count: invoices.length })}</Callout> : null}
              <SectionCard contentClassName="p-0">
                <ul className="divide-y divide-border" data-testid="portal-invoices">
                  {invoices.map((i) => (
                    <li
                      key={i.id}
                      data-testid="portal-invoice-row"
                      data-state={i.state}
                      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3"
                    >
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <Link
                          href={`/portal/invoices/${i.id}`}
                          prefetch={false}
                          className="rounded-sm text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          {i.kind === "CREDIT_NOTE"
                            ? t("creditNumber", { number: i.displayNumber })
                            : t("invoiceNumber", { number: i.displayNumber })}
                        </Link>
                        <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                          <span className="num">{day(i.issueDate)}</span>
                          {i.dueDate ? <span className="num">{t("dueOn", { date: day(i.dueDate) })}</span> : null}
                        </span>
                      </span>
                      <span className="flex items-center gap-3">
                        <span className="num text-sm whitespace-nowrap" data-testid="portal-invoice-amount">
                          {formatMoney(locale, minorToNumber(i.amount), i.currency)}
                        </span>
                        <InvoiceStateBadge state={i.state} />
                      </span>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            </>
          )}
        </div>
      </Page>
    </PortalFrame>
  );
}
