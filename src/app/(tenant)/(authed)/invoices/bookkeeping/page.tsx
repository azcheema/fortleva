import type { Metadata } from "next";
import { BookOpenCheckIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { Callout, DataTable, EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireTenantContext } from "@/members/tenant-context";
import { readBookkeeping, type BookkeepingPage } from "@/modules/invoicing";

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
 */
export default async function BookkeepingPageRoute({ searchParams }: { searchParams: Promise<{ before?: string | string[] }> }) {
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("invoices.bookkeeping");
  const format = await getFormatter();
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
  const next = page.next;

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
        ) : (
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
                </ul>
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
                  {page.files.map((f) => (
                    <TableRow key={f.id} data-testid="bookkeeping-file" data-number={f.number}>
                      <TableCell className="whitespace-nowrap font-medium">{t("files.number", { number: f.number })}</TableCell>
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
                          <a href={`/invoices/bookkeeping/${f.id}/xlsx`} className={LINK} data-testid="bookkeeping-xlsx" download>
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
