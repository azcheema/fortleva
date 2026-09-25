import { useLocale, useTranslations } from "next-intl";

import { RichText } from "@/components/rich-text/render";
import { Callout, HealthChip } from "@/components/semantic";
import { formatDate, formatDay, formatDurationSeconds, formatMoney } from "@/lib/format";
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
              <span>{t("published", { date: formatDate(locale, update.publishedAt) })}</span>
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
  const tiles: { key: string; label: string; value: string; detail: string | null }[] = [];

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
      <dl className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-5">
        {tiles.map((tile) => (
          <div
            key={tile.key}
            data-metric={tile.key}
            className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border bg-background p-3"
          >
            <dt className="text-xs text-muted-foreground">{tile.label}</dt>
            <dd className="num text-lg font-semibold text-foreground">{tile.value}</dd>
            {tile.detail ? <dd className="text-xs text-muted-foreground">{tile.detail}</dd> : null}
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">
        {t("asOf", { date: formatDate(locale, new Date(metrics.computedAt)) })}
      </p>
    </section>
  );
}
