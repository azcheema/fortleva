import { getFormatter, getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { SectionCard, WebsiteSpeedCharts } from "@/components/semantic";
import { cruxTransportKind } from "@/config";
import type { CruxFormFactor } from "@/integrations/crux";
import { requireTenantContext } from "@/members/tenant-context";
import { readWebsiteSpeed, type WebsiteSpeed } from "@/modules/reports/speed";
import type { ProjectDetail } from "@/projects/service";

import { SpeedShareSwitch } from "./speed-switch";

/**
 * THE WEBSITE SPEED CARD (Phase 6 slice 118; founder decision C94 (d)) — on
 * the project's Overview tab under Details, beside the Production URL it
 * measures. Drawn for a member holding `report:view` (the page's `caps`);
 * the "Show to the client" switch in its header for `project:manage_portal`.
 *
 * EVERY EMPTY STATE IS WORDS (Phase 6's non-negotiable): no Production URL,
 * the server's transport off, not checked yet, Google has no data for the
 * site, a refusal, an outage — each its own line, with the date Google was
 * last asked. With numbers: the three metric cards under it (one component
 * with the portal's, `WebsiteSpeedCharts`), phones first.
 */
export async function WebsiteSpeedCard({ project, device }: { project: ProjectDetail; device: CruxFormFactor }) {
  const t = await getTranslations("projects.speed");
  const format = await getFormatter();
  const { membership, actor } = await requireTenantContext();
  let speed: WebsiteSpeed;
  try {
    speed = await readWebsiteSpeed({ tenantId: membership.tenantId, actor }, project.id);
  } catch (e) {
    // The card is drawn on `caps.viewSpeed`; a refusal between the two reads
    // (a role changed under the member) leaves the card out, never the page.
    if (e instanceof AuthzError) return null;
    throw e;
  }
  const hasRows = speed.series.PHONE.length > 0 || speed.series.DESKTOP.length > 0;
  // The date Google was last asked about THIS site — a check of a previous
  // site (the URL moved since) is not this one's (the re-check's 2).
  const checked =
    speed.check && speed.check.origin === speed.origin
      ? t("checked", { date: format.dateTime(speed.check.checkedAt, { day: "numeric", month: "short", year: "numeric" }) })
      : null;

  const state = ((): string | null => {
    if (speed.origin === null) return t("states.noUrl");
    // Off is off: no retry is coming on this server, whatever the last check
    // said (the code review's 5).
    if (cruxTransportKind === "off") return t("states.transportOff");
    // A check of a PREVIOUS site (the Production URL moved since) is no
    // answer about this one (the code review's 2).
    if (!speed.check || speed.check.origin !== speed.origin) return t("states.notChecked");
    switch (speed.check.outcome) {
      case "NO_DATA":
        return t("states.noData");
      case "REFUSED":
        return speed.check.detail === "key" ? t("states.refusedKey") : t("states.refused");
      case "FAILED":
        return speed.check.detail === "shape" ? t("states.shape") : t("states.failed");
      default:
        return null;
    }
  })();

  const sharing = speed.shown ? (speed.portalEnabled ? t("sharing.on") : t("sharing.portalOff")) : t("sharing.off");

  return (
    <div data-testid="speed-card" data-shown={speed.shown} className="flex flex-col gap-6">
      <SectionCard
        title={t("title")}
        description={t("description")}
        actions={
          project.caps.managePortal ? (
            <SpeedShareSwitch projectId={project.id} projectKey={project.key} shown={speed.shown} disabled={speed.archived} />
          ) : null
        }
      >
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground" data-testid="speed-sharing">
            {sharing}
          </p>
          {state ? (
            <p className="text-sm text-muted-foreground" data-testid="speed-state">
              {state}
              {checked ? <span className="num"> · {checked}</span> : null}
            </p>
          ) : null}
          {hasRows && speed.origin ? (
            <p className="text-xs text-muted-foreground">
              {t("measured", { origin: speed.origin })}
              {checked && !state ? <span className="num"> · {checked}</span> : null}
            </p>
          ) : null}
        </div>
      </SectionCard>
      {hasRows ? (
        <WebsiteSpeedCharts
          series={speed.series}
          device={device}
          deviceHref={(d) => (d === "DESKTOP" ? "?device=desktop" : "?device=phone")}
          idPrefix="project-speed"
        />
      ) : null}
    </div>
  );
}
