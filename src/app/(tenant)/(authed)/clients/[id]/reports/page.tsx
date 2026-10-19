import { FileChartColumnIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { Callout, EmptyState, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { withTenant } from "@/db";
import { defaultReportMonth, latestReportMonth, reportMonthFormValue } from "@/documents/report-month";
import { listClientReports } from "@/documents/reports";
import { bounceMessage } from "@/lib/bounce";
import { localDateString } from "@/lib/duration";
import { requireTenantContext } from "@/members/tenant-context";
import { readPreferences } from "@/preferences/service";

import { readMakeReportForm } from "@/documents/made-reports";

import { loadClient } from "../data";
import { AddReport } from "./add-report";
import { MakeReport } from "./make-report";
import { ReportTable } from "./report-table";

/**
 * The client's REPORTS tab (Phase 6 slice 115; founder decision C91): the
 * monthly reports the agency uploads, publishes to the client's portal and
 * hides again — the ONLY place a report is handled (the Files tab never lists
 * one). The tab exists for `document:view` + `report:view` on all four gates
 * and a DIRECT assignment (the client loader's cap, the Files tab's rule); a
 * member without them gets a 404 (UI.md §7.3).
 */
export default async function ClientReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const error = await bounceMessage((await searchParams).error);
  const client = await loadClient(id);
  if (!client.caps.viewReports) notFound();
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const t = await getTranslations("clients.reports");
  const reports = await listClientReports(ctx, client.id);
  // The months the forms offer, in the WORKSPACE's zone: a report covers a
  // finished month, so the upload starts at last month, and none may be later
  // than this one (the service repeats the rule).
  const today = await withTenant(membership.tenantId, { type: "member", id: actor.memberId }, async (tx) => {
    const { timezone } = await readPreferences(tx, membership.tenantId);
    return localDateString(new Date(), timezone);
  });
  const latestMonth = reportMonthFormValue(latestReportMonth(today));
  const defaultMonth = reportMonthFormValue(defaultReportMonth(today));
  const active = client.status === "ACTIVE";
  // The Make a report card (slice 119): the client's portal projects, whether
  // anyone there could read it, and its invoice language. In SEQUENCE after
  // the list (its own transaction).
  const makeForm = client.caps.makeReports ? await readMakeReportForm(ctx, client.id) : null;

  return (
    <div className="flex flex-col gap-6">
      {error ? (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      ) : null}
      <SectionCard
        title={t("title")}
        description={t("description")}
        contentClassName={reports.length === 0 ? undefined : "p-0"}
      >
        {reports.length === 0 ? (
          client.caps.uploadReports ? (
            <EmptyState
              variant="empty"
              icon={FileChartColumnIcon}
              title={t("empty")}
              body={makeForm ? t("emptyBodyMake") : t("emptyBody")}
              action={
                <Button asChild size="sm">
                  <Link href={makeForm ? "#make-report" : "#new-report"}>
                    <PlusIcon />
                    {makeForm ? t("make.title") : t("add.title")}
                  </Link>
                </Button>
              }
            />
          ) : (
            <EmptyState variant="filtered" icon={FileChartColumnIcon} title={t("empty")} />
          )
        ) : (
          <ReportTable
            clientId={client.id}
            clientName={client.name}
            rows={reports}
            can={{
              publish: client.caps.publishReports,
              clientActive: active,
              edit: client.caps.editReports,
              delete: client.caps.deleteReports,
            }}
            latestMonth={latestMonth}
          />
        )}
      </SectionCard>
      {makeForm ? (
        <SectionCard id="make-report" className="scroll-mt-16" title={t("make.title")} description={t("make.description")}>
          {/* The picker's newest month is LAST month: a made report covers a month that has ENDED (C95 (g)). */}
          <MakeReport
            clientId={client.id}
            latestMonth={defaultMonth}
            defaultLocale={makeForm.defaultLocale}
            projects={makeForm.projects}
            hasAudience={makeForm.hasAudience}
            draftMonths={makeForm.draftMonths.map(reportMonthFormValue)}
            emptyMonths={makeForm.emptyMonths.map(reportMonthFormValue)}
          />
        </SectionCard>
      ) : null}
      {client.caps.uploadReports ? (
        <SectionCard id="new-report" className="scroll-mt-16" title={t("add.title")} description={t("add.description")}>
          <AddReport clientId={client.id} defaultMonth={defaultMonth} latestMonth={latestMonth} />
        </SectionCard>
      ) : null}
    </div>
  );
}
