import type { Metadata } from "next";
import { ReceiptTextIcon } from "lucide-react";
import Link from "next/link";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { DataTable, EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { withTenant } from "@/db";
import { hasAccess } from "@/entitlements/resolver";
import { formatDurationSeconds, formatMoney } from "@/lib/format";
import { requireTenantContext } from "@/members/tenant-context";
import {
  INVOICE_LIST_LIMIT,
  listInvoiceableClients,
  listInvoices,
  listReadyToInvoice,
  minorToNumber,
  signed,
  type InvoiceListRow,
} from "@/modules/invoicing";
import { readPreferences } from "@/preferences/service";

import { InvoiceFilter } from "./invoice-filter";
import { NewInvoice, type InvoiceableClient } from "./new-invoice";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("invoices.list");
  return { title: t("title") };
}

/**
 * /invoices (Phase 4 slice 107; founder decision C75 (f), step 1) — every
 * invoice the member's client scope reaches, newest first; a draft wears
 * "Draft" where the number will be and its total is computed from its lines.
 * `?client=` filters to one client. "New invoice" (for `invoice:create`) is
 * an inline row: a client, optionally one of its projects, and "Create
 * draft". `invoice:view` on all four gates — the invoicing module closes it.
 */
export default async function InvoicesPage({ searchParams }: { searchParams: Promise<{ client?: string | string[] }> }) {
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const t = await getTranslations("invoices.list");
  const tCommon = await getTranslations("common");
  const format = await getFormatter();
  const locale = await getLocale();
  const { client } = await searchParams;
  const clientFilter = typeof client === "string" ? client : "";

  let listed: { rows: readonly InvoiceListRow[]; more: boolean } | null = null;
  try {
    listed = await listInvoices(ctx, { clientId: clientFilter || null });
  } catch (e) {
    if (!(e instanceof AuthzError)) throw e;
  }
  if (!listed) {
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

  const canCreate = await withTenant(membership.tenantId, { type: "member", id: membership.memberId }, (tx) =>
    hasAccess(tx, membership.tenantId, actor, "invoice:create"),
  );
  const clients: readonly InvoiceableClient[] = canCreate ? await listInvoiceableClients(ctx) : [];
  // Slice 110 (C80 (a)): the clients with billable hours waiting — for a
  // member who may put hours on invoices; every value through the database's
  // twin of the rounding (`listReadyToInvoice`).
  const { canGenerate, prefs } = await withTenant(membership.tenantId, { type: "member", id: membership.memberId }, async (tx) => ({
    canGenerate: await hasAccess(tx, membership.tenantId, actor, "invoice:generate_from_time"),
    prefs: await readPreferences(tx, membership.tenantId),
  }));
  const ready = canGenerate ? await listReadyToInvoice(ctx) : null;
  const tReady = await getTranslations("invoices.ready");
  const hours = (seconds: number) => formatDurationSeconds(locale, seconds, prefs.durationStyle);

  // The filter offers the clients the member can see invoices of: those on
  // the list, those they could make one for, and the one in the URL.
  const names = new Map<string, string>();
  for (const c of clients) names.set(c.id, c.name);
  for (const r of listed.rows) names.set(r.client.id, r.client.name);
  const filterOptions = [
    { value: "", label: t("allClients") },
    ...[...names.entries()]
      .sort(([, a], [, b]) => a.localeCompare(b, locale))
      .map(([value, label]) => ({ value, label })),
  ];
  const rows = listed.rows;

  return (
    <Page>
      <PageHeader title={t("title")} description={t("description")} />
      <div className="mt-6 flex flex-col gap-4">
        {canCreate ? (
          <SectionCard id="new-invoice" title={t("newTitle")}>
            {clients.length > 0 ? (
              <NewInvoice clients={clients} initialClientId={clientFilter} />
            ) : (
              <p className="text-sm text-muted-foreground">{t("noClients")}</p>
            )}
          </SectionCard>
        ) : null}
        {ready ? (
          <SectionCard
            id="ready-to-invoice"
            title={tReady("title")}
            description={tReady("description")}
            contentClassName={ready.length === 0 ? undefined : "p-0"}
          >
            {ready.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="ready-empty">
                {tReady("empty")}
              </p>
            ) : (
              <DataTable flush scrollLabel={tReady("title")}>
                <Table data-testid="ready-list">
                  <TableHeader>
                    <TableRow>
                      <TableHead>{tReady("columns.client")}</TableHead>
                      <TableHead className="w-[10ch] text-right">{tReady("columns.hours")}</TableHead>
                      <TableHead className="text-right">{tReady("columns.value")}</TableHead>
                      <TableHead priority="low">{tReady("columns.oldest")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ready.map((r) => {
                      const seconds = r.byCurrency.reduce((s, c) => s + c.seconds, 0) + r.noRateSeconds;
                      return (
                        <TableRow key={r.clientId} data-testid="ready-row" data-client-id={r.clientId}>
                          {/* The client YIELDS (`contain-inline-size`): a long name never widens the card. */}
                          <TableCell className="min-w-24">
                            <div className="flex w-full min-w-0 items-baseline gap-2 contain-inline-size">
                              <Link
                                href={`/invoices/ready/${r.clientId}`}
                                title={r.name}
                                className="min-w-0 truncate rounded-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                              >
                                {r.name}
                              </Link>
                              {r.archived ? <span className="shrink-0 text-2xs text-muted-foreground">{tReady("archived")}</span> : null}
                            </div>
                          </TableCell>
                          <TableCell className="num text-right whitespace-nowrap">{hours(seconds)}</TableCell>
                          {/* `leading-4`: the "without a rate" line under the value
                              keeps the row's 36px pitch (the credit note label's rule). */}
                          <TableCell className="num text-right whitespace-nowrap leading-4" data-testid="ready-value">
                            {r.byCurrency.map((c) => formatMoney(locale, minorToNumber(c.amount), c.currency)).join(" · ")}
                            {r.noRateSeconds > 0 ? (
                              <span className="block text-2xs text-muted-foreground">{tReady("noRate", { hours: hours(r.noRateSeconds) })}</span>
                            ) : null}
                          </TableCell>
                          <TableCell priority="low" className="num whitespace-nowrap text-muted-foreground">
                            {format.dateTime(new Date(`${r.oldest}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" })}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </DataTable>
            )}
          </SectionCard>
        ) : null}
        <SectionCard
          title={t("listTitle")}
          actions={filterOptions.length > 2 ? <InvoiceFilter value={names.has(clientFilter) ? clientFilter : ""} options={filterOptions} /> : null}
          contentClassName={rows.length === 0 ? undefined : "p-0"}
        >
          {rows.length === 0 ? (
            canCreate && clients.length > 0 ? (
              <EmptyState
                variant="empty"
                icon={ReceiptTextIcon}
                title={clientFilter ? t("emptyForClient") : t("empty")}
                body={t("emptyBody")}
                action={
                  <Button asChild variant="outline">
                    <a href="#new-invoice">{t("emptyAction")}</a>
                  </Button>
                }
              />
            ) : (
              <EmptyState variant="filtered" icon={ReceiptTextIcon} title={t("empty")} />
            )
          ) : (
            <DataTable flush scrollLabel={t("listTitle")}>
              <Table data-testid="invoice-list">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("columns.number")}</TableHead>
                    <TableHead>{t("columns.client")}</TableHead>
                    <TableHead priority="medium">{t("columns.project")}</TableHead>
                    <TableHead priority="low">{t("columns.date")}</TableHead>
                    <TableHead className="text-right">{t("columns.total")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id} data-testid="invoice-row" data-invoice-id={r.id} data-status={r.status}>
                      {/* `leading-4`: a credit note's two lines (the number, the
                          label under it) fit the row's 32px of content, so the
                          row keeps its --row-h (the fix review's high). */}
                      <TableCell className="whitespace-nowrap leading-4">
                        <Link
                          href={`/invoices/${r.id}`}
                          className="rounded-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          {r.displayNumber ? <span className="num-id font-mono">{r.displayNumber}</span> : t("draftLink")}
                        </Link>
                        {/* A credit note says so UNDER its number (slice 108b) —
                            beside it, the phone's table overflowed its box by
                            40px (the visual walk's audit, CI 37961042339). */}
                        {r.kind === "CREDIT_NOTE" ? (
                          <span className="block text-2xs text-muted-foreground" data-testid="invoice-row-credit">
                            {t("creditNote")}
                          </span>
                        ) : r.overdue ? (
                          // Slice 109: past its due date and unpaid — derived,
                          // never a status; under the number, as the credit
                          // note's label (the row keeps its pitch).
                          <span className="block text-2xs text-(--tone-caution-fg)" data-testid="invoice-row-overdue">
                            {t("overdue")}
                          </span>
                        ) : null}
                        {/* A draft's link already reads "Draft"; a badge saying it
                            again cost a phone its width (the visual walk's audit).
                            Issued invoices wear their status from slice 108. */}
                      </TableCell>
                      <TableCell className="max-w-56 truncate">{r.client.name}</TableCell>
                      <TableCell priority="medium" className="max-w-40 truncate text-muted-foreground" title={r.project?.name}>
                        {r.project ? r.project.key : null}
                      </TableCell>
                      <TableCell priority="low" className="num whitespace-nowrap text-muted-foreground">
                        {/* An issue date is a `@db.Date` (UTC midnight): formatted in
                            UTC, or a zone west of it shows the day before. */}
                        {r.issueDate
                          ? format.dateTime(r.issueDate, { dateStyle: "medium", timeZone: "UTC" })
                          : format.dateTime(r.createdAt, { dateStyle: "medium" })}
                      </TableCell>
                      <TableCell className="num text-right whitespace-nowrap" data-testid="invoice-row-total">
                        {/* A credit note's total with its minus sign (C77 (a)). */}
                        {formatMoney(locale, minorToNumber(signed(r.total, r.kind)), r.currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </DataTable>
          )}
        </SectionCard>
        {listed.more ? (
          <p className="text-xs text-muted-foreground" data-testid="invoice-list-limited">
            {t("limited", { limit: INVOICE_LIST_LIMIT })}
          </p>
        ) : null}
      </div>
    </Page>
  );
}
