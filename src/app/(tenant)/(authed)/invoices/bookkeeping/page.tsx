import type { Metadata } from "next";
import { BookOpenCheckIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { Callout, DataTable, EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney } from "@/lib/format";
import { addDays } from "@/lib/week";
import { requireTenantContext } from "@/members/tenant-context";
import { readBookkeeping, type BookkeepingPage } from "@/modules/invoicing";

import { BookYearEnd } from "./book-year-end";
import { NEWEST_FILE_LINK_ID } from "./ids";
import { MakeFile } from "./make-file";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("invoices.bookkeeping");
  return { title: t("title") };
}

const LINK =
  "rounded-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * /invoices/bookkeeping (Phase 4 slice 111; founder decision C82) — the files
 * for the workspace's bookkeeping program: what the next one would hold, Make
 * file, every file made (newest first, 50 a page) with its two downloads — the
 * SIE import for Fortnox and the list — and how to import. `invoice:export`
 * with `invoice:view` and a tenant-wide client scope; anyone else gets a 404
 * (UI.md §7.3). The method is chosen in Settings → Invoicing first.
 *
 * Slice 111b (C83): under the cash method, once a financial year has ended,
 * a Year end card above the rest — the invoices unpaid on its last day and
 * Book the year end, waiting while entries of that year still go in a file;
 * and a warning on the next file when it books into a year whose year end is
 * already booked (a late payment's correction).
 */
export default async function BookkeepingPageRoute({ searchParams }: { searchParams: Promise<{ before?: string | string[] }> }) {
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("invoices.bookkeeping");
  const format = await getFormatter();
  const locale = await getLocale();
  const { before } = await searchParams;
  const beforeNumber = typeof before === "string" && /^[1-9]\d{0,8}$/.test(before) ? Number(before) : undefined;

  let page: BookkeepingPage | null = null;
  try {
    page = await readBookkeeping({ tenantId: membership.tenantId, actor }, beforeNumber ? { before: beforeNumber } : {});
  } catch (e) {
    if (!(e instanceof AuthzError)) throw e;
  }
  if (!page) notFound();

  const day = (d: string) => format.dateTime(new Date(`${d}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });
  const range = (first: string | null, last: string | null) =>
    first === null || last === null ? "" : first === last ? day(first) : t("range", { first: day(first), last: day(last) });
  const sek = (amount: string) => formatMoney(locale, Number(amount), "SEK");
  const next = page.next;
  const yearEnd = page.yearEnd;

  return (
    <Page width="form">
      <PageHeader title={t("title")} description={t("description")} />
      <div className="mt-6 flex flex-col gap-4">
        {page.method === null ? (
          <div data-testid="bookkeeping-no-method">
            <Callout tone="caution" title={t("noMethod.title")}>
              {page.canEditSettings ? (
                <>
                  {t("noMethod.body")}{" "}
                  <Link href="/settings/invoicing#bookkeeping" className={LINK}>
                    {t("noMethod.action")}
                  </Link>
                </>
              ) : (
                t("noMethod.bodyAsk")
              )}
            </Callout>
          </div>
        ) : null}

        {yearEnd ? (
          <SectionCard
            id="year-end"
            className="scroll-mt-16"
            title={t("yearEnd.title", { day: day(yearEnd.date) })}
            description={t("yearEnd.description", { day: day(yearEnd.date), nextDay: day(addDays(yearEnd.date, 1)) })}
          >
            <div className="flex flex-col gap-3" data-testid="year-end" data-year-end={yearEnd.date}>
              {yearEnd.waiting > 0 ? (
                <div data-testid="year-end-waiting">
                  <Callout tone="caution">{t("yearEnd.waiting", { count: yearEnd.waiting, day: day(yearEnd.date) })}</Callout>
                </div>
              ) : null}
              {yearEnd.leftOut.map((l) => (
                <p key={l.orgNr} className="text-sm text-muted-foreground" data-testid="year-end-left-out">
                  {t("yearEnd.leftOut", { count: l.count, orgNr: l.orgNr })}
                </p>
              ))}
              {yearEnd.count === 0 ? (
                <p className="text-sm text-muted-foreground">{t("yearEnd.none", { day: day(yearEnd.date) })}</p>
              ) : (
                <>
                  <DataTable scrollLabel={t("yearEnd.title", { day: day(yearEnd.date) })}>
                    <Table data-testid="year-end-invoices">
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("yearEnd.columns.number")}</TableHead>
                          <TableHead>{t("yearEnd.columns.client")}</TableHead>
                          <TableHead priority="low">{t("yearEnd.columns.date")}</TableHead>
                          <TableHead className="text-right">{t("yearEnd.columns.amount")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {yearEnd.rows.map((r) => (
                          <TableRow key={r.number} data-testid="year-end-invoice">
                            <TableCell className="num whitespace-nowrap font-medium">{r.number}</TableCell>
                            <TableCell className="min-w-32">
                              <div className="w-full min-w-0 truncate contain-inline-size">{r.client}</div>
                            </TableCell>
                            <TableCell priority="low" className="num whitespace-nowrap text-muted-foreground">
                              {day(r.issueDate)}
                            </TableCell>
                            <TableCell className="num text-right whitespace-nowrap">{sek(r.totalSek)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </DataTable>
                  {yearEnd.count > yearEnd.rows.length ? (
                    <p className="text-xs text-muted-foreground">{t("yearEnd.more", { count: yearEnd.count - yearEnd.rows.length })}</p>
                  ) : null}
                  <p className="text-sm">{t("yearEnd.total", { count: yearEnd.count, total: sek(yearEnd.totalSek) })}</p>
                </>
              )}
              <p className="text-sm">{t("yearEnd.markFirst", { day: day(yearEnd.date) })}</p>
              <div>
                <BookYearEnd
                  yearEnd={yearEnd.date}
                  dayLabel={day(yearEnd.date)}
                  nextDayLabel={day(addDays(yearEnd.date, 1))}
                  count={yearEnd.count}
                  totalSek={yearEnd.totalSek}
                  totalLabel={sek(yearEnd.totalSek)}
                  disabled={yearEnd.waiting > 0}
                />
              </div>
              <ul className="flex list-disc flex-col gap-0.5 pl-5 text-xs text-muted-foreground">
                <li>{t("yearEnd.vat")}</li>
                <li>{t("yearEnd.refunds")}</li>
              </ul>
            </div>
          </SectionCard>
        ) : null}

        {page.method === null ? null : (
          <SectionCard title={t("next.title")} description={t(`method.${page.method}`)}>
            {next === null || next.count === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="bookkeeping-nothing">
                {t("next.empty")}
              </p>
            ) : (
              <div className="flex flex-col gap-3" data-testid="bookkeeping-next">
                <p className="text-sm">
                  {t("next.summary", { count: next.count, range: range(next.first, next.last) })}
                </p>
                <ul className="flex flex-col gap-0.5 text-sm text-muted-foreground">
                  {next.byEvent.ISSUE > 0 ? <li>{t("next.issued", { count: next.byEvent.ISSUE })}</li> : null}
                  {next.byEvent.PAYMENT > 0 ? <li>{t("next.payments", { count: next.byEvent.PAYMENT })}</li> : null}
                  {next.byEvent.PAYMENT_UNDONE > 0 ? <li>{t("next.undone", { count: next.byEvent.PAYMENT_UNDONE })}</li> : null}
                  {next.byEvent.CREDIT_NOTED > 0 ? <li>{t("next.noted", { count: next.byEvent.CREDIT_NOTED })}</li> : null}
                  {next.byEvent.YEAR_END_REVERSED > 0 ? <li>{t("next.yearEndReversed", { count: next.byEvent.YEAR_END_REVERSED })}</li> : null}
                  {next.byEvent.YEAR_END_UNDONE > 0 ? <li>{t("next.yearEndUndone", { count: next.byEvent.YEAR_END_UNDONE })}</li> : null}
                  {next.byEvent.YEAR_END_REVERSAL_UNDONE > 0 ? (
                    <li>{t("next.yearEndReversalUndone", { count: next.byEvent.YEAR_END_REVERSAL_UNDONE })}</li>
                  ) : null}
                </ul>
                {next.intoBookedYear ? (
                  <div data-testid="bookkeeping-into-booked-year">
                    <Callout tone="caution" title={t("next.intoBookedYear.title", { day: day(next.intoBookedYear) })}>
                      {t("next.intoBookedYear.body")}
                    </Callout>
                  </div>
                ) : null}
                {next.waiting > 0 ? <p className="text-xs text-muted-foreground">{t("next.waiting", { count: next.waiting })}</p> : null}
                <div>
                  <MakeFile />
                </div>
              </div>
            )}
          </SectionCard>
        )}

        <SectionCard title={t("files.title")} contentClassName={page.files.length === 0 ? undefined : "p-0"}>
          {page.files.length === 0 ? (
            <EmptyState variant="filtered" icon={BookOpenCheckIcon} title={t("files.empty")} body={t("files.emptyBody")} />
          ) : (
            <DataTable flush scrollLabel={t("files.title")}>
              <Table data-testid="bookkeeping-files">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("files.columns.file")}</TableHead>
                    <TableHead priority="medium">{t("files.columns.made")}</TableHead>
                    <TableHead priority="low">{t("files.columns.by")}</TableHead>
                    <TableHead className="text-right">{t("files.columns.entries")}</TableHead>
                    <TableHead priority="low">{t("files.columns.dates")}</TableHead>
                    <TableHead pinned className="text-right">
                      {t("files.columns.download")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {page.files.map((f, i) => (
                    <TableRow key={f.id} data-testid="bookkeeping-file" data-number={f.number} data-year-end={f.yearEnd ?? undefined}>
                      <TableCell className="whitespace-nowrap font-medium">
                        {f.yearEnd ? t("files.numberYearEnd", { number: f.number, day: day(f.yearEnd) }) : t("files.number", { number: f.number })}
                      </TableCell>
                      <TableCell priority="medium" className="num whitespace-nowrap text-muted-foreground">
                        {day(f.madeOn)}
                      </TableCell>
                      <TableCell priority="low" className="min-w-24">
                        <div className="w-full min-w-0 truncate contain-inline-size text-muted-foreground">{f.madeBy ?? t("files.someoneGone")}</div>
                      </TableCell>
                      <TableCell className="num text-right whitespace-nowrap">{f.vouchers + f.listed}</TableCell>
                      <TableCell priority="low" className="num whitespace-nowrap text-muted-foreground">
                        {range(f.first, f.last)}
                      </TableCell>
                      <TableCell pinned className="text-right whitespace-nowrap">
                        <span className="inline-flex items-center gap-3">
                          {f.vouchers > 0 ? (
                            <a href={`/invoices/bookkeeping/${f.id}/sie`} className={LINK} data-testid="bookkeeping-sie" download>
                              {t("files.fortnox")}
                            </a>
                          ) : (
                            <span className="text-muted-foreground">{t("files.nothingToBook")}</span>
                          )}
                          <a
                            href={`/invoices/bookkeeping/${f.id}/xlsx`}
                            id={i === 0 && !beforeNumber ? NEWEST_FILE_LINK_ID : undefined}
                            className={LINK}
                            data-testid="bookkeeping-xlsx"
                            download
                          >
                            {t("files.list")}
                          </a>
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </DataTable>
          )}
        </SectionCard>
        {page.olderBefore !== null || beforeNumber ? (
          <div className="flex gap-2">
            {beforeNumber ? (
              <Button asChild size="sm" variant="outline">
                <Link href="/invoices/bookkeeping">{t("files.newest")}</Link>
              </Button>
            ) : null}
            {page.olderBefore !== null ? (
              <Button asChild size="sm" variant="outline">
                <Link href={`/invoices/bookkeeping?before=${page.olderBefore}`}>{t("files.older")}</Link>
              </Button>
            ) : null}
          </div>
        ) : null}

        <SectionCard title={t("help.title")}>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm" data-testid="bookkeeping-help">
            <li>{t("help.import")}</li>
            <li>{t("help.series", { series: page.series })}</li>
            <li>{t("help.once")}</li>
            {page.method === "CASH" ? <li>{t("help.bank")}</li> : null}
            {page.method === "CASH" ? <li>{t("help.yearEnd")}</li> : null}
            <li>{t("help.eu")}</li>
            <li>{t("help.first")}</li>
          </ul>
        </SectionCard>
      </div>
    </Page>
  );
}
