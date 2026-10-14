import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import type { CSSProperties } from "react";

import type { CruxFormFactor, CruxMetric } from "@/integrations/crux";
import { formatNumber, formatPercent } from "@/lib/format";
import { bandOf, BANDS, SPEED_METRICS, speedValue, type SpeedMetric } from "@/modules/reports/speed-bands";
import type { SpeedSeries, SpeedWeek } from "@/modules/reports/speed-shapes";
import { cn } from "@/lib/utils";

import { ChartTable } from "./chart-table";
import { SectionCard } from "./section-card";
import { StatusBadge } from "./status-badge";

/**
 * THE WEBSITE SPEED CHARTS (Phase 6 slice 118; founder decision C94) — the
 * one component both planes draw: the project's Overview card and the
 * client's Reports page. A server component, no directive, plain HTML and
 * inline SVG on the design tokens; its words from `websiteSpeed` and
 * `states.speedBand`, so the two planes say the same thing.
 *
 * PHONES FIRST, COMPUTERS ONE TAP AWAY (C94 (b)): the device toggle is two
 * PLAIN anchors on the page's own `?device=` parameter — relative, so the
 * portal page and its View-as twin render the same bytes; plain rather than
 * `<Link>` because a two-state toggle needs no prefetch or client-side
 * transition (the e2e caught the RSC navigation landing on the error
 * boundary once, and a full load has nothing to race).
 *
 * ONE BLOCK PER CORE WEB VITAL, the dataviz method's forms: a stat tile (the
 * latest period's 75th percentile with its band as a chip — the band's WORD
 * and icon, never colour alone), a part-to-whole meter of the latest
 * period's visits by band (status tones, which is what the bands are), and
 * a single-series LINE over the weeks held (2 px, the active chart token),
 * with Google's band edges as recessive hairlines labelled in words and the
 * latest point labelled; no legend box for one series (the heading names
 * it). Every value is reachable without hover or colour: the table twin
 * lists every week's number and shares.
 *
 * THE LINE'S GEOMETRY: the plot is an SVG with `preserveAspectRatio="none"`
 * holding only lines (their stroke kept at 2 px by `vector-effect`), and
 * every piece of text, the band labels and the dots are HTML positioned by
 * percentage over it — stretched SVG text is unreadable, and a stretched
 * circle an ellipse. The band edges' words are a caption UNDER the plot
 * (the lower hairline is the Good edge, the upper the Poor one): beside the
 * line they crossed it near the latest point, and in a gutter they ran past
 * a three-column card's width.
 *
 * ONE CARD PER METRIC, each ending with its table twin — `ChartTable`'s
 * contract is the last child of a default-size card, whose padding its
 * flush bleed is. The caller draws the toggle's siblings (a title, a
 * switch, the empty states) in a card of its own above this.
 */

const PLOT_H = 96;

/** The band edges' tones — the status palette, as the dataviz rule reserves it. */
const BAND_FILL = {
  GOOD: "bg-(--tone-success-line)",
  NEEDS_WORK: "bg-(--tone-caution-line)",
  POOR: "bg-(--tone-danger-line)",
} as const;

const metricOf = (w: SpeedWeek, m: SpeedMetric): CruxMetric | null => (m === "lcp" ? w.lcp : m === "inp" ? w.inp : w.cls);

export async function WebsiteSpeedCharts({
  series,
  device,
  deviceHref,
  idPrefix,
}: {
  series: SpeedSeries;
  device: CruxFormFactor;
  /** The page's own address with the other device chosen — relative, e.g. "?device=desktop". */
  deviceHref: (device: CruxFormFactor) => string;
  /** Keeps element ids unique when a page draws several projects. */
  idPrefix: string;
}) {
  const t = await getTranslations("websiteSpeed");
  const tBands = await getTranslations("states");
  const format = await getFormatter();
  const locale = await getLocale();
  const weeks = series[device];
  const dateOf = (iso: string) => format.dateTime(new Date(`${iso}T00:00:00.000Z`), { day: "numeric", month: "short", timeZone: "UTC" });
  const dateWithYear = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00.000Z`), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const valueText = (metric: SpeedMetric, p75: number): string => {
    const v = speedValue(metric, p75);
    const value = formatNumber(locale, v.value, { minimumFractionDigits: v.digits, maximumFractionDigits: v.digits });
    return t(`units.${v.unit}`, { value });
  };
  const bandWord = (band: "GOOD" | "NEEDS_WORK" | "POOR") => tBands(`speedBand.${band}`);

  return (
    <div data-slot="website-speed" data-device={device} className="flex flex-col gap-6">
      <nav aria-label={t("device.label")} className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t("device.label")}</span>
        {(["PHONE", "DESKTOP"] as const).map((d) => (
          <a
            key={d}
            href={deviceHref(d)}
            aria-current={d === device ? "page" : undefined}
            data-testid={`speed-device-${d.toLowerCase()}`}
            className={cn(
              "rounded-md border px-2.5 py-1 transition-colors duration-(--dur-instant) ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              d === device ? "border-border bg-accent font-medium text-foreground" : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {t(`device.${d}`)}
          </a>
        ))}
      </nav>
      {weeks.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="speed-no-device">
          {t("noDevice", { device: t(`device.${device}`).toLowerCase() })}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {SPEED_METRICS.map((metric) => {
            const points = weeks.map((w) => ({ week: w, value: metricOf(w, metric) }));
            const latest = points.at(-1)!;
            const band = latest.value ? bandOf(metric, latest.value.p75) : null;
            const { goodMax, needsMax } = BANDS[metric];
            const values = points.map((p) => p.value?.p75 ?? 0);
            // The plot's top: the Good edge with headroom, or the data with
            // headroom when it climbs past that — so a fast site's line is not
            // squashed under a Poor edge it never nears (seen on the founder's
            // first real site); a hairline is drawn only inside the plot.
            const yMax = Math.max(goodMax * 1.25, Math.max(...values) * 1.15, 0.001);
            const drawn = points.map((p, i) => ({ ...p, i })).filter((p) => p.value !== null);
            // 2–98 % of the plot, so the end dots (centred on their point) stay inside its box.
            const x = (i: number) => (points.length === 1 ? 50 : 2 + (i / (points.length - 1)) * 96);
            const y = (v: number) => 100 - (Math.min(v, yMax) / yMax) * 100;
            const lineId = `${idPrefix}-${metric}-trend`;
            return (
              <div key={metric} data-testid={`speed-metric-${metric}`} className="min-w-0">
              <SectionCard title={t(`metrics.${metric}.name`)} description={t(`metrics.${metric}.hint`)} contentClassName="flex min-w-0 flex-col gap-3">
                {/* The latest period: the number is the chart. */}
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  {latest.value ? (
                    <>
                      <span className="text-2xl font-semibold text-foreground" data-testid="speed-latest">
                        {valueText(metric, latest.value.p75)}
                      </span>
                      {band ? <StatusBadge domain="speedBand" value={band} className="self-center" /> : null}
                    </>
                  ) : (
                    <span className="text-sm text-muted-foreground">{t("noLatest")}</span>
                  )}
                  <span className="basis-full text-xs text-muted-foreground">{t("latestEnding", { date: dateWithYear(latest.week.periodEnd) })}</span>
                </div>
                {/* The latest period's visits by band — a part-to-whole meter; the words carry the split. */}
                {latest.value ? (
                  <div className="flex flex-col gap-1.5">
                    <span className="sr-only">{t("shares")}</span>
                    <div aria-hidden="true" className="flex h-2 w-full gap-0.5 overflow-hidden rounded-sm">
                      {(
                        [
                          ["GOOD", latest.value.good],
                          ["NEEDS_WORK", latest.value.needsWork],
                          ["POOR", latest.value.poor],
                        ] as const
                      ).map(([b, share]) =>
                        share > 0 ? (
                          <span
                            key={b}
                            className={cn("h-full min-w-0.5", BAND_FILL[b])}
                            style={{ flexBasis: `${share * 100}%` } satisfies CSSProperties}
                          />
                        ) : null,
                      )}
                    </div>
                    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {(
                        [
                          ["GOOD", latest.value.good],
                          ["NEEDS_WORK", latest.value.needsWork],
                          ["POOR", latest.value.poor],
                        ] as const
                      ).map(([b, share]) => (
                        <li key={b} className="flex items-center gap-1.5">
                          <span aria-hidden="true" className={cn("size-2.5 shrink-0 rounded-sm", BAND_FILL[b])} />
                          {bandWord(b)} <span className="num">{formatPercent(locale, share)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {/* The weekly line over Google's bands. */}
                <figure className="flex flex-col gap-1" aria-labelledby={lineId}>
                  <figcaption id={lineId} className="sr-only">
                    {t("trend", { metric: t(`metrics.${metric}.name`) })}
                  </figcaption>
                  <div className="relative mt-2" style={{ blockSize: `${PLOT_H}px` } satisfies CSSProperties}>
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 100 100"
                      preserveAspectRatio="none"
                      className="absolute inset-0 size-full overflow-visible"
                    >
                      {[goodMax, needsMax].filter((edge) => edge <= yMax).map((edge) => (
                        <line
                          key={edge}
                          x1="0"
                          x2="100"
                          y1={y(edge)}
                          y2={y(edge)}
                          className="stroke-(--border)"
                          strokeWidth="1"
                          vectorEffect="non-scaling-stroke"
                        />
                      ))}
                      {drawn.length > 1 ? (
                        <polyline
                          points={drawn.map((p) => `${x(p.i)},${y(p.value!.p75)}`).join(" ")}
                          fill="none"
                          className="stroke-(--chart-active)"
                          strokeWidth="2"
                          strokeLinejoin="round"
                          strokeLinecap="round"
                          vectorEffect="non-scaling-stroke"
                        />
                      ) : null}
                    </svg>
                    {/* Hit targets for a mouse (an enhancement; the twin has every value). */}
                    {drawn.map((p) => (
                      <span
                        key={p.week.periodEnd}
                        aria-hidden="true"
                        title={t("pointTitle", { date: dateOf(p.week.periodEnd), value: valueText(metric, p.value!.p75) })}
                        className="absolute size-3 -translate-x-1/2 -translate-y-1/2"
                        style={{ left: `${x(p.i)}%`, top: `${y(p.value!.p75)}%` } satisfies CSSProperties}
                      />
                    ))}
                    {/* The marker on the LAST MEASURED point — which is the latest period unless Google had no data for it. */}
                    {drawn.length > 0 ? (
                      <span
                        aria-hidden="true"
                        className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-(--chart-active) ring-2 ring-card"
                        style={{ left: `${x(drawn.at(-1)!.i)}%`, top: `${y(drawn.at(-1)!.value!.p75)}%` } satisfies CSSProperties}
                      />
                    ) : null}
                  </div>
                  <div aria-hidden="true" className="flex justify-between text-2xs text-muted-foreground">
                    <span>{dateOf(points[0]!.week.periodEnd)}</span>
                    {points.length > 1 ? <span>{dateOf(latest.week.periodEnd)}</span> : null}
                  </div>
                  {/* The band edges' words — the lower hairline is the Good edge, the upper the Poor one. */}
                  <p className="text-2xs text-muted-foreground">
                    {t("goodUpTo", { value: valueText(metric, goodMax) })} · {t("poorFrom", { value: valueText(metric, needsMax) })}
                  </p>
                </figure>
                <ChartTable
                  label={t("showTable")}
                  scrollLabel={t("tableLabel")}
                  columns={[
                    t("columns.period"),
                    t("columns.value"),
                    { label: t("columns.good"), priority: "low" },
                    { label: t("columns.needsWork"), priority: "low" },
                    { label: t("columns.poor"), priority: "low" },
                  ]}
                  rows={[...points].reverse().map((p) => ({
                    key: p.week.periodEnd,
                    cells: [
                      dateWithYear(p.week.periodEnd),
                      p.value ? valueText(metric, p.value.p75) : "—",
                      p.value ? formatPercent(locale, p.value.good) : "—",
                      p.value ? formatPercent(locale, p.value.needsWork) : "—",
                      p.value ? formatPercent(locale, p.value.poor) : "—",
                    ],
                  }))}
                />
              </SectionCard>
              </div>
            );
          })}
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t("trendHint")}</p>
    </div>
  );
}
