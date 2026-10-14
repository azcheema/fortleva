import { DownloadIcon, FileChartColumnIcon } from "lucide-react";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";

import { Callout, EmptyState, Page, PageHeader, SectionCard, WebsiteSpeedCharts } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { listPortalReports, type PortalReport } from "@/documents/portal";
import type { CruxFormFactor } from "@/integrations/crux";
import { formatBytes } from "@/lib/format";
import { listPortalWebsiteSpeed } from "@/modules/reports/portal";
import { portalReadOrNull, type PortalPrincipal } from "@/portal";

import { downloadDocumentAction } from "../files/actions";
import type { PortalFileError } from "../files/files-view";
import { PortalFrame } from "../portal-frame";

/**
 * `/portal/reports`, AS A COMPONENT (Phase 6 slice 115; founder decision C91)
 * — the monthly reports the agency published to the contact's client, newest
 * month first, a card per month. A component and not a page for the reason
 * `<PortalFilesView>` is: `/view-as/reports` renders it under a synthesised
 * principal and `e2e/view-as.spec.ts` byte-compares the two. Nothing in here
 * reaches for a request context; the name comes in as a prop.
 *
 * WHAT A ROW SAYS: the report's name, when it was published, its size — and
 * the download, the Files page's own form POST (`downloadDocumentAction`,
 * which asks `portal.report.view` too for a report). Nothing else.
 *
 * TWO READS, each through `portalReadOrNull`: a refusal and an empty answer
 * are the same page (`src/portal/render.ts`). THE REFUSAL BANNER is the one
 * thing that makes the two routes differ, and only when it is there.
 *
 * WEBSITE SPEED (Phase 6 slice 118; C94): above the monthly cards, one card
 * per project whose charts the agency switched on — Google's weekly numbers
 * for the client's own site, phones first, `?device=desktop` a tap away
 * (a relative link, so the View-as twin renders the same bytes).
 */
export async function PortalReportsView({
  principal,
  name,
  error,
  device = "PHONE",
}: {
  principal: PortalPrincipal;
  name: string;
  error?: PortalFileError;
  device?: CruxFormFactor;
}) {
  const t = await getTranslations("portal.reports");
  const tFiles = await getTranslations("portal.files");
  const tDomain = await getTranslations("domainErrors");
  const format = await getFormatter();
  const locale = await getLocale();
  const refusal = error === "rate" ? tDomain("DOWNLOAD_RATE_LIMITED") : error ? tFiles("errors.download") : null;
  const reports = (await portalReadOrNull("listPortalReports", () => listPortalReports(principal))) ?? [];
  // In SEQUENCE, after the reports' transaction has closed.
  const speed = (await portalReadOrNull("listPortalWebsiteSpeed", () => listPortalWebsiteSpeed(principal))) ?? [];

  // A card per month, in the projection's order (newest month first).
  const months: { month: string; reports: PortalReport[] }[] = [];
  for (const r of reports) {
    const last = months.at(-1);
    if (last && last.month === r.month) last.reports.push(r);
    else months.push({ month: r.month, reports: [r] });
  }
  // A `date` column read as UTC midnight: labelled in UTC, or a zone west of
  // Greenwich would name the month before.
  const monthLabel = (month: string) =>
    format.dateTime(new Date(`${month}T00:00:00.000Z`), { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <PortalFrame name={name} principal={principal} nav="reports">
      <Page>
        <div className="flex flex-col gap-6">
          <PageHeader title={t("title")} description={t("description")} />
          {refusal ? (
            <div data-testid="portal-file-error">
              <Callout tone="danger" role="alert">
                {refusal}
              </Callout>
            </div>
          ) : null}
          {speed.length > 0 ? (
            <section aria-labelledby="portal-speed-heading" data-testid="portal-speed" className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <h2 id="portal-speed-heading" className="text-base font-semibold text-foreground">
                  {t("speed.title")}
                </h2>
                <p className="text-sm text-muted-foreground">{t("speed.description")}</p>
              </div>
              {speed.map((p) => (
                <div key={p.id} data-testid="portal-speed-project" data-project-key={p.key} className="flex flex-col gap-4">
                  <div className="flex flex-col gap-0.5">
                    <h3 className="text-sm font-semibold text-foreground">{p.name}</h3>
                    <p className="text-xs text-muted-foreground">{t("speed.measured", { origin: p.origin })}</p>
                  </div>
                  <WebsiteSpeedCharts
                    series={p.series}
                    device={device}
                    deviceHref={(d) => (d === "DESKTOP" ? "?device=desktop" : "?device=phone")}
                    idPrefix={`portal-speed-${p.key}`}
                  />
                </div>
              ))}
            </section>
          ) : null}
          {months.length === 0 && speed.length === 0 ? (
            <SectionCard>
              <EmptyState variant="forbidden" icon={FileChartColumnIcon} title={t("empty")} body={t("emptyBody")} />
            </SectionCard>
          ) : (
            months.map(({ month, reports: rows }) => (
              <SectionCard key={month} title={monthLabel(month)} contentClassName="p-0">
                <ul className="divide-y divide-border">
                  {rows.map((r) => (
                    <li
                      key={r.id}
                      data-slot="portal-report"
                      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 p-4"
                    >
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate text-sm font-medium text-foreground" title={r.name}>
                          {r.name}
                        </span>
                        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                          <span>
                            {t("published", {
                              date: format.dateTime(r.publishedAt, { day: "numeric", month: "short", year: "numeric" }),
                            })}
                          </span>
                          <span className="num">{formatBytes(locale, r.version.sizeBytes)}</span>
                        </span>
                      </span>
                      <form action={downloadDocumentAction} className="shrink-0">
                        <input type="hidden" name="documentId" value={r.id} />
                        <input type="hidden" name="returnTo" value="/portal/reports" />
                        <Button type="submit" variant="outline" size="sm" aria-label={tFiles("downloadName", { name: r.name })}>
                          <DownloadIcon aria-hidden="true" />
                          {tFiles("download")}
                        </Button>
                      </form>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            ))
          )}
        </div>
      </Page>
    </PortalFrame>
  );
}
