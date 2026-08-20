import { getLocale, getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { EmptyState, SectionCard } from "@/components/semantic";
import { withTenant } from "@/db";
import { resolveTimeZone } from "@/i18n/resolve";
import { localDateString } from "@/lib/duration";
import { monthContaining } from "@/lib/week";
import { requireTenantContext } from "@/members/tenant-context";
import { listReports } from "@/modules/time";
import { readPreferences } from "@/preferences/service";

import { loadProject } from "../../data";
import { ReportsPanel } from "./reports-panel";

/**
 * /projects/[key]/time/reports (D3; UI.md §3.1 "Reports sub-view"):
 * generate a draft for a period, preview the member-free snapshot with
 * INTERNAL names folded, publish it to the portal (one audited tx),
 * unpublish, archive. time_report:manage; publish needs
 * time_report:publish.
 */
export default async function ProjectTimeReportsPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const project = await loadProject(key);
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const t = await getTranslations("projects.time.reports");
  const tCommon = await getTranslations("common");
  const locale = await getLocale();
  const timezone = await resolveTimeZone();
  const prefs = await withTenant(membership.tenantId, { type: "member", id: membership.memberId }, (tx) =>
    readPreferences(tx, membership.tenantId),
  );
  const month = monthContaining(localDateString(new Date(), timezone));

  let reports: Awaited<ReturnType<typeof listReports>> | null = null;
  let canPublish = false;
  try {
    reports = await listReports(ctx, project.id);
    canPublish = await withTenant(membership.tenantId, { type: "member", id: membership.memberId }, async (tx) => {
      const { isAuthorized } = await import("@/authz/authorize");
      return isAuthorized(tx, actor, "time_report:publish");
    });
  } catch (e) {
    if (!(e instanceof AuthzError)) throw e;
  }

  if (!reports) {
    return (
      <SectionCard>
        <EmptyState variant="forbidden" title={tCommon("forbiddenTitle")} body={t("noPermission")} />
      </SectionCard>
    );
  }

  return (
    <ReportsPanel
      projectId={project.id}
      projectKey={project.key}
      reports={reports.map((r) => ({
        ...r,
        generatedAt: r.generatedAt.toISOString(),
        publishedAt: r.publishedAt?.toISOString() ?? null,
      }))}
      defaultPeriod={month}
      canPublish={canPublish}
      locale={locale}
      durationStyle={prefs.durationStyle}
    />
  );
}
