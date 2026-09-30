import { useFormatter, useLocale, useTranslations } from "next-intl";

import { RichText } from "@/components/rich-text/render";
import { Callout, HealthChip } from "@/components/semantic";
import { MetricTiles, type MetricTileSpec } from "@/components/updates/metric-tiles";
import { formatDay, formatDurationSeconds, formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { UpdateBody, UpdateSection } from "@/modules/work/update-body";
import type { PortalSnapshot } from "@/modules/work/update-snapshot";

/**
 * ONE PUBLISHED (OR PREVIEWED) UPDATE, DRAWN THE SAME WAY EVERYWHERE.
 *
 * The client's portal renders it; the member's Updates tab renders it
 * for a published post; the composer renders it LIVE as the preview
 * under the editor. One component and not three, for the reason the
 * Portal tab's preview reuses the portal's own task list (SECURITY.md
 * §5.1, "a separate preview renderer is how previews lie"): what the
 * author sees on the right of the composer is, byte for byte apart from
 * the numbers' freezing, what the client will read.
 *
 * It renders ONLY what a client may read: the health, the number, the
 * title, the period, the sections and the frozen portal-safe metrics.
 * The staff-only twin (per-member hours, margin, budget burn) is a
 * different component on the member plane (`internal-card.tsx`) and
 * takes a different type, so it cannot be handed to this one by
 * mistake. No "use client": it is prose and numbers, and the portal
 * pays for no JavaScript to read them.
 */

export type UpdateViewModel = {
  readonly seq: number | null;
  readonly health: "ON_TRACK" | "AT_RISK" | "OFF_TRACK" | "ON_HOLD" | "COMPLETE";
  readonly title: string | null;
  /** `@db.Date`s — a calendar day, formatted in UTC by `formatDay`. */
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
  readonly publishedAt: Date | null;
  readonly body: UpdateBody;
  readonly metrics: PortalSnapshot | null;
  readonly editNote: string | null;
};

const SECTION_HEADING: Record<Exclude<UpdateSection["key"], "CUSTOM">, true> = {
  SUMMARY: true,
  DONE: true,
  NEXT: true,
  BLOCKERS: true,
  DECISIONS_NEEDED: true,
};

/**
 * THE TWO REAL INSTANTS ON A POST — when it was published, and when its
 * numbers were computed — are formatted by next-intl in the REQUEST's
 * zone, never by `formatDate`, which uses the process's own. This
 * component also renders inside the composer, a CLIENT component, where
 * the process is the browser: a server in UTC and a browser in Stockholm
 * name different days for as many hours a night as the zones differ (two
 * in Stockholm's summer, one in winter), and React refused the
 * hydration (error 418 on the composer's "Numbers as of …", CI run
 * 36789135756 at 23:0x UTC). next-intl hands the same zone to both sides
 * (`NextIntlClientProvider` inherits it from `src/i18n/request.ts`). The
 * period's two days are `@db.Date`s and stay on `formatDay`, which is
 * pinned to UTC for the opposite reason.
 */
const DAY = { year: "numeric", month: "short", day: "numeric" } as const;

export function UpdateView({
  update,
  headingLevel = 3,
  className,
}: {
  update: UpdateViewModel;
  /** The section headings' level, so the component nests under whatever titles the page has. */
  headingLevel?: 2 | 3 | 4;
  className?: string;
}) {
  const t = useTranslations("updates");
  const locale = useLocale();
  const format = useFormatter();
  const Heading = `h${headingLevel}` as const;
  const period =
    update.periodStart && update.periodEnd
      ? t("period", { from: formatDay(locale, update.periodStart), to: formatDay(locale, update.periodEnd) })
      : update.periodStart
        ? t("periodFrom", { from: formatDay(locale, update.periodStart) })
        : update.periodEnd
          ? t("periodTo", { to: formatDay(locale, update.periodEnd) })
          : null;

  return (
    <article data-slot="update-view" data-health={update.health} className={cn("flex flex-col gap-4", className)}>
      <header className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <HealthChip value={update.health} />
          {update.seq !== null ? (
            <span className="num text-xs text-muted-foreground">{t("number", { seq: update.seq })}</span>
          ) : null}
        </div>
        {update.title ? (
          <p className="text-base font-semibold text-balance text-foreground">{update.title}</p>
        ) : null}
        {period || update.publishedAt ? (
          <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            {period ? <span>{period}</span> : null}
            {update.publishedAt ? (
              <span>{t("published", { date: format.dateTime(update.publishedAt, DAY) })}</span>
            ) : null}
          </p>
        ) : null}
      </header>

      {update.editNote ? (
        <Callout tone="info">
          {t("note", { note: update.editNote })}
        </Callout>
      ) : null}

      {update.body.sections.map((section, i) => (
        <section key={`${section.key}-${i}`} data-slot="update-section" data-key={section.key}>
          <Heading className="eyebrow mb-1.5 text-muted-foreground">
            {section.key === "CUSTOM"
              ? section.title
              : SECTION_HEADING[section.key]
                ? t(`sections.${section.key}`)
                : section.key}
          </Heading>
          <RichText doc={section.body} className="text-sm text-foreground" />
        </section>
      ))}

      {update.metrics ? <Metrics metrics={update.metrics} /> : null}
    </article>
  );
}

/**
 * The frozen numbers, as a compact strip. Every value is read straight
 * off the snapshot; nothing is recomputed here, because the whole point
 * of freezing at publish is that this block says the same thing next
 * year.
 */
function Metrics({ metrics }: { metrics: PortalSnapshot }) {
  const t = useTranslations("updates.metrics");
  const locale = useLocale();
  const format = useFormatter();
  const tiles: MetricTileSpec[] = [];

  if (metrics.tasks) {
    tiles.push({
      key: "tasks",
      label: t("tasks"),
      value: t("tasksValue", { done: metrics.tasks.done, total: metrics.tasks.total }),
      detail: t("tasksInPeriod", { count: metrics.tasks.doneInPeriod }),
    });
  }
  if (metrics.milestones) {
    tiles.push({
      key: "milestones",
      label: t("milestones"),
      value: t("milestonesValue", { done: metrics.milestones.done, total: metrics.milestones.total }),
      detail:
        metrics.milestones.hitInPeriod.length > 0
          ? t("milestonesHit", { names: metrics.milestones.hitInPeriod.join(", ") })
          : null,
    });
  }
  if (metrics.versions) {
    const shipped = metrics.versions.shippedInPeriod;
    tiles.push({
      key: "versions",
      label: t("versions"),
      value: shipped.length === 0 ? t("versionsNone") : shipped.map((v) => v.version).join(", "),
      detail: null,
    });
  }
  if (metrics.requests) {
    tiles.push({
      key: "requests",
      label: t("requests"),
      value: String(metrics.requests.open),
      detail: t("requestsAccepted", { count: metrics.requests.acceptedInPeriod }),
    });
  }
  if (metrics.hours) {
    const h = metrics.hours;
    const hours = (seconds: number) => formatDurationSeconds(locale, seconds, "hm");
    const details: string[] = [t("hoursToDate", { hours: hours(h.toDate.seconds) })];
    if (h.budgetSeconds !== null) details.push(t("budgetHours", { hours: hours(h.budgetSeconds) }));
    if (h.mode === "BILLABLE_AMOUNT" && h.currency) {
      if (h.inPeriod.amount) details.push(t("amountInPeriod", { amount: formatMoney(locale, Number(h.inPeriod.amount), h.currency) }));
      if (h.toDate.amount) details.push(t("amountToDate", { amount: formatMoney(locale, Number(h.toDate.amount), h.currency) }));
      if (h.budgetAmount) details.push(t("budgetAmount", { amount: formatMoney(locale, Number(h.budgetAmount), h.currency) }));
    }
    tiles.push({ key: "hours", label: t("hours"), value: hours(h.inPeriod.seconds), detail: details.join(" · ") });
  }
  if (tiles.length === 0) return null;

  return (
    <section data-slot="update-metrics" className="flex flex-col gap-2">
      <p className="eyebrow text-muted-foreground">{t("title")}</p>
      <MetricTiles tiles={tiles} className="lg:grid-cols-5" />
      <p className="text-xs text-muted-foreground">
        {t("asOf", { date: format.dateTime(new Date(metrics.computedAt), DAY) })}
      </p>
    </section>
  );
}
