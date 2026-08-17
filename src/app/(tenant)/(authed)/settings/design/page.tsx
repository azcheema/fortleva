import { join } from "node:path";

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import {
  Callout,
  DataTable,
  EmptyState,
  EntityChip,
  Field,
  FormMessage,
  HealthChip,
  KeyboardHint,
  MemberAvatar,
  MetricTile,
  Page,
  PageHeader,
  PriorityIndicator,
  ProgressMeter,
  SectionCard,
  StatusBadge,
  StatusIcon,
  ThemeToggle,
  Timeline,
  TimelineItem,
  VisibilityBadge,
  visibilityRowCue,
} from "@/components/semantic";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { oklchToHex } from "@/lib/color";
import { loadDesignTokens, type DesignTokens, type ThemeName } from "@/lib/css-tokens";
import { ENTITY_HUES } from "@/lib/entity-color";
import { PRIORITIES, PROJECT_HEALTHS, STATUS_MAP, type StatusDomain } from "@/lib/enum-map";
import { formatNumber } from "@/lib/format";
import { getThemePreference } from "@/lib/theme-server";
import { cn } from "@/lib/utils";

import { DemoControls } from "./demo-controls";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("design");
  return { title: t("shortTitle") };
}

/* ------------------------------------------------------------------ *
 * The measured table. Same parser as the release gate
 * (src/lib/contrast.test.ts), so what is printed here is what CI
 * asserts — never a hand-kept copy that can drift.
 * ------------------------------------------------------------------ */

type Pair = { token: string; against: string; floor: number };

const ROLE_PAIRS: Pair[] = [
  { token: "--foreground", against: "--background", floor: 4.5 },
  { token: "--foreground", against: "--card", floor: 4.5 },
  { token: "--muted-foreground", against: "--background", floor: 4.5 },
  { token: "--muted-foreground", against: "--card", floor: 4.5 },
  { token: "--muted-foreground", against: "--popover", floor: 4.5 },
  { token: "--muted-foreground", against: "--muted", floor: 4.5 },
  { token: "--muted-foreground", against: "--accent", floor: 4.5 },
  { token: "--sidebar-foreground", against: "--sidebar", floor: 4.5 },
  { token: "--primary-foreground", against: "--primary", floor: 4.5 },
  { token: "--primary-foreground", against: "--primary-hover", floor: 4.5 },
  { token: "--destructive-foreground", against: "--destructive", floor: 4.5 },
  { token: "--success-foreground", against: "--success", floor: 4.5 },
  { token: "--warning-foreground", against: "--warning", floor: 4.5 },
  { token: "--vis-client-fg", against: "--vis-client", floor: 4.5 },
  { token: "--input", against: "--card", floor: 3 },
  { token: "--input", against: "--background", floor: 3 },
  { token: "--ring", against: "--background", floor: 3 },
  { token: "--ring", against: "--card", floor: 3 },
  { token: "--fg-disabled", against: "--muted", floor: 3 },
  { token: "--border", against: "--card", floor: 1 },
  // Set B. Danger as plain text (FormMessage, Field errors, the
  // destructive menu item), control boundaries on the row-hover
  // surface, and the safety-critical 2px row cue.
  { token: "--tone-danger-fg", against: "--card", floor: 4.5 },
  { token: "--tone-success-fg", against: "--card", floor: 4.5 },
  { token: "--tone-quiet-fg", against: "--card", floor: 4.5 },
  { token: "--tone-quiet-line", against: "--card", floor: 3 },
  { token: "--input", against: "--accent", floor: 3 },
  { token: "--ring", against: "--accent", floor: 3 },
  { token: "--vis-client-cue", against: "--card", floor: 3 },
  { token: "--vis-client-cue", against: "--accent", floor: 3 },
  { token: "--vis-internal-border", against: "--accent", floor: 3 },
];

const TONE_KEYS = ["neutral", "brand", "caution", "success", "danger", "quiet"] as const;
const CORE_BADGES = ["default", "secondary", "outline", "destructive"] as const;
/** Every button variant, so a reader can tell six specimens apart. */
const BUTTON_VARIANTS = [
  "default",
  "secondary",
  "outline",
  "ghost",
  "destructive",
  "link",
] as const;

/**
 * A specimen and the words for what it is. Without the caption a reader
 * cannot tell `default` from `secondary` from `outline` from `ghost`,
 * which is the only thing this page exists to make possible. The
 * caption is a code identifier (a variant name), so it wears the mono
 * face and is not a translated string.
 */
function Specimen({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <span className="flex flex-col items-start gap-1">
      {children}
      <span className="num font-mono text-2xs text-muted-foreground">{caption}</span>
    </span>
  );
}

/** The page is ~11 700px tall; the jump list is how it is navigable. */
const SECTIONS = [
  "color",
  "ramps",
  "type",
  "controls",
  "states",
  "visibility",
  "entities",
  "charts",
  "rail",
  "feedback",
  "elevation",
  "density",
] as const;

const RAMPS = [
  { name: "slate", steps: [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] },
  { name: "indigo", steps: [100, 200, 300, 400, 500, 600, 700, 800, 950] },
  { name: "red", steps: [100, 200, 300, 400, 600, 800, 950] },
  { name: "amber", steps: [100, 200, 300, 400, 600, 800, 950] },
  { name: "green", steps: [100, 200, 300, 400, 600, 800, 950] },
] as const;

const SURFACES = [
  "--color-surface-l0",
  "--color-surface-l1",
  "--color-surface-l2",
  "--color-surface-d0",
  "--color-surface-d1",
  "--color-surface-d2",
  "--color-surface-d3",
  "--color-surface-d4",
] as const;

const CHART_TOKENS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5"] as const;
const ENTITY_TOKENS = ENTITY_HUES.map((_, index) => `--entity-${index}`);
const STATUS_DOMAINS = Object.keys(STATUS_MAP) as StatusDomain[];

const TYPE_ROLES = [
  { key: "display", className: "text-3xl font-semibold" },
  { key: "dialog", className: "text-2xl font-semibold" },
  { key: "pageTitle", className: "text-xl font-semibold" },
  { key: "section", className: "text-lg font-semibold" },
  { key: "subsection", className: "text-base font-semibold" },
  { key: "body", className: "text-sm" },
  { key: "bodyStrong", className: "text-sm font-medium" },
  { key: "secondary", className: "text-xs text-muted-foreground" },
  { key: "caption", className: "text-2xs" },
  { key: "tableHeader", className: "eyebrow" },
  { key: "code", className: "num font-mono text-xs" },
] as const;

const SIMULATIONS = [
  { key: "normal", filter: undefined },
  { key: "protanopia", filter: "url(#fl-protan)" },
  { key: "deuteranopia", filter: "url(#fl-deutan)" },
  { key: "tritanopia", filter: "url(#fl-tritan)" },
  { key: "greyscale", filter: "grayscale(1)" },
] as const;

const ELEVATIONS = [
  { key: "anchored", className: "border border-border" },
  { key: "shadow1", className: "border border-border shadow-(--shadow-1)" },
  { key: "shadow2", className: "border border-border shadow-(--shadow-2)" },
  { key: "shadow3", className: "border border-border shadow-(--shadow-3)" },
] as const;

const DURATIONS = ["instant", "fast", "base", "slow"] as const;
const DENSITIES = ["default", "compact"] as const;

const BUTTON_SIZES = [
  { size: "xs", label: "24" },
  { size: "sm", label: "28" },
  { size: "default", label: "32" },
  { size: "lg", label: "40" },
] as const;

/** Sample data. Not copy — figures and glyphs the eye needs to judge shape. */
const SAMPLE = {
  aa: "Aa",
  dash: "—",
  hoursA: "12,50",
  hoursB: "7,25",
  hoursZero: "0,00",
  metricProjects: "12",
  metricHours: "37,5",
  metricUnbilled: "48 200",
  unitHour: "h",
  unitMoney: "kr",
  deltaUp: "+8%",
  deltaDown: "-4%",
  keyVadero: "VADERO",
  keySjoberg: "SJOBERG",
} as const;

const ESC_KEY = ["Esc"];
const HELP_KEY = ["?"];
const PALETTE_KEYS = ["mod", "K"];
const GOTO_KEYS = ["G", "then", "P"];

/** Machado 2009 severity-1.0 matrices, applied in linearRGB (the SVG default). */
const CVD_FILTERS = [
  {
    id: "fl-protan",
    values:
      "0.152286 1.052583 -0.204868 0 0  0.114503 0.786281 0.099216 0 0  -0.003882 -0.048116 1.051998 0 0  0 0 0 1 0",
  },
  {
    id: "fl-deutan",
    values:
      "0.367322 0.860646 -0.227968 0 0  0.280085 0.672501 0.047413 0 0  -0.011820 0.042940 0.968881 0 0  0 0 0 1 0",
  },
  {
    id: "fl-tritan",
    values:
      "1.255528 -0.076749 -0.178779 0 0  -0.078411 0.930809 0.147602 0 0  0.004733 0.691367 0.303900 0 0  0 0 0 1 0",
  },
] as const;

/**
 * StatusBadge is generic so that call sites in screens get a compile
 * error when a domain and a value disagree. This page walks the whole
 * map at runtime, where that pairing cannot be expressed — one cast,
 * here, rather than a weaker signature everywhere.
 */
const AnyStatusBadge = StatusBadge as unknown as (props: {
  domain: string;
  value: string;
}) => React.ReactElement;

/**
 * /settings/design — the release gate the founder reads.
 *
 * Member-gated with no permission of its own (the (authed) layout has
 * already required a member session): anyone who can see the app can
 * see the system. It 404s in production, and its nav entry is dropped
 * there too (nav.ts `devOnly`), so it never ships to a tenant.
 */
export default async function DesignPage() {
  if (process.env.NODE_ENV === "production") notFound();

  const t = await getTranslations("design");
  const tTheme = await getTranslations("theme");
  const tCommon = await getTranslations("common");
  const locale = await getLocale();
  const theme = await getThemePreference();

  let tokens: DesignTokens | null = null;
  try {
    tokens = loadDesignTokens(join(process.cwd(), "src", "app", "globals.css"));
  } catch {
    tokens = null;
  }

  const ratio = (a: string, b: string, theme: ThemeName): number | null => {
    try {
      return tokens?.ratio(a, b, theme) ?? null;
    } catch {
      return null;
    }
  };
  const hex = (token: string, theme: ThemeName): string | null => {
    try {
      const lch = tokens?.color(token, theme);
      return lch ? oklchToHex(lch) : null;
    } catch {
      return null;
    }
  };
  const num = (value: number) =>
    formatNumber(locale, value, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const ratioText = (value: number | null) =>
    value === null ? SAMPLE.dash : t("ratio", { value: num(value) });

  const ratioCell = (value: number | null, floor: number) => {
    if (value === null) return <span className="text-muted-foreground">{SAMPLE.dash}</span>;
    const ok = value >= floor;
    return (
      <span className="inline-flex items-center justify-end gap-1.5">
        <span className="num">{t("ratio", { value: num(value) })}</span>
        {floor > 1 ? (
          <Badge variant={ok ? "success" : "danger"}>{ok ? t("pass") : t("fail")}</Badge>
        ) : null}
      </span>
    );
  };

  const eyebrow = "eyebrow text-muted-foreground";

  return (
    <Page width="wide" className="flex flex-col gap-6">
      {/* CVD simulation filters. feColorMatrix runs in linearRGB by
          default, which is exactly where the Machado matrices belong —
          applying them to gamma-encoded values overstates separation. */}
      <svg aria-hidden="true" focusable="false" className="absolute size-0">
        <defs>
          {CVD_FILTERS.map((f) => (
            <filter key={f.id} id={f.id} colorInterpolationFilters="linearRGB">
              <feColorMatrix type="matrix" values={f.values} />
            </filter>
          ))}
        </defs>
      </svg>

      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={<ThemeToggle value={theme} />}
      />

      <nav
        aria-label={tCommon("sections")}
        className="sticky top-0 z-10 -mx-4 flex gap-1 overflow-x-auto border-b border-border bg-background px-4 py-2 md:-mx-6 md:px-6"
      >
        {SECTIONS.map((section) => (
          <a
            key={section}
            href={`#${section}`}
            className="inline-flex h-7 shrink-0 items-center rounded-md px-2 text-xs whitespace-nowrap text-muted-foreground transition-colors duration-(--dur-instant) ease-out hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          >
            {t(`sections.${section}`)}
          </a>
        ))}
      </nav>

      <Callout tone="caution" title={t("devOnly")} />

      {/* The card owns the surface; the table drops its own hairline
          (§10.15.1) instead of drawing a second one 16px inside it. */}
      <SectionCard
        id="color" className="scroll-mt-14"
        title={t("sections.color")}
        description={t("sections.colorHint")}
        contentClassName="p-0"
      >
        <DataTable density="compact" flush scrollLabel={t("sections.color")}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("columns.sample")}</TableHead>
                <TableHead>{t("columns.token")}</TableHead>
                <TableHead priority="medium">{t("columns.against")}</TableHead>
                <TableHead className="text-right">{tTheme("light")}</TableHead>
                <TableHead className="text-right">{tTheme("dark")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ROLE_PAIRS.map((pair) => (
                <TableRow key={`${pair.token}-${pair.against}`}>
                  <TableCell>
                    <span
                      aria-hidden="true"
                      style={{ background: `var(${pair.against})`, color: `var(${pair.token})` }}
                      className="inline-flex h-6 items-center rounded-sm border border-border px-2 text-2xs font-semibold"
                    >
                      {SAMPLE.aa}
                    </span>
                  </TableCell>
                  <TableCell className="num font-mono text-xs">{pair.token}</TableCell>
                  <TableCell
                    priority="medium"
                    className="num font-mono text-xs text-muted-foreground"
                  >
                    {pair.against}
                  </TableCell>
                  {/* Numbers right-align, always (§10.15.1): forty ragged
                      rows was the most visible violation on this page. */}
                  <TableCell className="text-right">
                    {ratioCell(ratio(pair.token, pair.against, "light"), pair.floor)}
                  </TableCell>
                  <TableCell className="text-right">
                    {ratioCell(ratio(pair.token, pair.against, "dark"), pair.floor)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DataTable>
      </SectionCard>

      <SectionCard id="ramps" className="scroll-mt-14" title={t("sections.ramps")} description={t("sections.rampsHint")}>
        <div className="flex flex-col gap-5">
          {RAMPS.map((ramp) => (
            <div key={ramp.name} className="flex flex-col gap-1.5">
              <p className="num font-mono text-xs text-muted-foreground">{ramp.name}</p>
              <div className="flex flex-wrap gap-1.5">
                {ramp.steps.map((step) => {
                  const token = `--color-${ramp.name}-${step}`;
                  return (
                    <div key={step} className="flex w-16 flex-col gap-1">
                      <span
                        aria-hidden="true"
                        style={{ background: `var(${token})` }}
                        className="h-8 rounded-sm border border-border"
                      />
                      <span className="num font-mono text-2xs text-muted-foreground">{step}</span>
                      <span className="num font-mono text-2xs text-muted-foreground">
                        {hex(token, "light") ?? SAMPLE.dash}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="flex flex-col gap-1.5 border-t border-border pt-4">
            <p className="text-xs text-muted-foreground">{t("sections.surfacesHint")}</p>
            <div className="flex flex-wrap gap-1.5">
              {SURFACES.map((token) => (
                <div key={token} className="flex w-24 flex-col gap-1">
                  <span
                    aria-hidden="true"
                    style={{ background: `var(${token})` }}
                    className="h-8 rounded-sm border border-border"
                  />
                  <span className="num font-mono text-2xs text-muted-foreground">
                    {token.replace("--color-surface-", "")}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard id="type" className="scroll-mt-14" title={t("sections.type")} description={t("sections.typeHint")}>
        <div className="flex flex-col gap-3">
          {TYPE_ROLES.map((role) => (
            <div key={role.key} className="flex flex-wrap items-baseline justify-between gap-3">
              <span className={role.className}>
                {role.key === "code" ? t("numeralSample") : t("typeSample")}
              </span>
              <span className="shrink-0 text-2xs text-muted-foreground">
                {t(`typeRoles.${role.key}`)}
              </span>
            </div>
          ))}
          <p className="num border-t border-border pt-3 text-sm">{t("numeralSample")}</p>
        </div>
      </SectionCard>

      <SectionCard id="controls" className="scroll-mt-14" title={t("sections.controls")} description={t("controls.hoverNote")}>
        <div className="flex flex-col gap-5">
          {/* Every specimen says what it is. Six buttons all labelled
              "Rest" cannot be told apart, which is the one thing a
              showcase has to make possible. */}
          <div className="flex flex-col gap-4">
            <p className={eyebrow}>{t("controls.buttons")}</p>
            <div className="flex flex-wrap items-start gap-3">
              {BUTTON_VARIANTS.map((variant) => (
                <Specimen key={variant} caption={`${variant} · ${t("controls.rest")}`}>
                  <Button variant={variant}>{t("controls.rest")}</Button>
                </Specimen>
              ))}
            </div>
            <div className="flex flex-wrap items-start gap-3">
              <Specimen caption={`default · ${t("controls.disabled")}`}>
                <Button disabled>{t("controls.disabled")}</Button>
              </Specimen>
              <Specimen caption={`outline · ${t("controls.disabled")}`}>
                <Button variant="outline" disabled>
                  {t("controls.disabled")}
                </Button>
              </Specimen>
              <Specimen caption={`destructive · ${t("controls.disabled")}`}>
                <Button variant="destructive" disabled>
                  {t("controls.disabled")}
                </Button>
              </Specimen>
              <Specimen caption={`outline · ${t("controls.focus")}`}>
                <span className="inline-flex rounded-md outline-2 outline-offset-2 outline-ring">
                  <Button variant="outline">{t("controls.focus")}</Button>
                </span>
              </Specimen>
            </div>
            {/* The size ladder is a ruler, and §10.2 gives the brand fill
                exactly three jobs — measuring is not one of them. */}
            <div className="flex flex-wrap items-start gap-3">
              {BUTTON_SIZES.map((item) => (
                <Specimen key={item.size} caption={`${item.size} · ${item.label}px`}>
                  <Button variant="outline" size={item.size}>
                    {item.label}
                  </Button>
                </Specimen>
              ))}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <Field label={t("controls.label")} hint={t("controls.hint")}>
              <Input placeholder={t("controls.placeholder")} />
            </Field>
            <Field label={t("controls.invalid")} error={t("controls.invalidHint")}>
              <Input aria-invalid defaultValue={SAMPLE.aa} />
            </Field>
            <Field label={t("controls.disabled")}>
              <Input disabled placeholder={t("controls.placeholder")} />
            </Field>
            <Field label={t("controls.label")}>
              <Textarea placeholder={t("controls.placeholder")} />
            </Field>
            <Field label={t("controls.label")}>
              <NativeSelect defaultValue="a">
                <option value="a">{t("controls.optionA")}</option>
                <option value="b">{t("controls.optionB")}</option>
              </NativeSelect>
            </Field>
            <Field label={t("controls.toggles")}>
              <div className="flex items-center gap-4 pt-1">
                <Checkbox defaultChecked />
                <Checkbox />
                <Checkbox disabled />
                <Switch defaultChecked />
                <Switch />
                <Switch size="sm" defaultChecked />
              </div>
            </Field>
          </div>

          {/* Tones and variants are two different axes; run together they
              read as one list of ten interchangeable chips. */}
          <div className="flex flex-col gap-3">
            <p className={eyebrow}>{t("controls.badges")}</p>
            <div className="flex flex-col gap-1.5">
              <p className="text-2xs text-muted-foreground">{t("controls.badgeTones")}</p>
              <div className="flex flex-wrap items-center gap-2">
                {TONE_KEYS.map((tone) => (
                  <Badge key={tone} variant={tone}>
                    {tone}
                  </Badge>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <p className="text-2xs text-muted-foreground">{t("controls.badgeVariants")}</p>
              <div className="flex flex-wrap items-center gap-2">
                {CORE_BADGES.map((variant) => (
                  <Badge key={variant} variant={variant}>
                    {variant}
                  </Badge>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <p className={eyebrow}>{t("controls.menus")}</p>
            <DemoControls />
          </div>
        </div>
      </SectionCard>

      <SectionCard id="states" className="scroll-mt-14" title={t("sections.states")} description={t("sections.statesHint")}>
        <div className="flex flex-col gap-3">
          {/* Below md the label sits ABOVE its chips with a hairline
              between rows: wrapped chips used to restart under the NEXT
              row's label, which reads as the wrong domain. */}
          {STATUS_DOMAINS.map((domain) => (
            <div
              key={domain}
              className="flex flex-col gap-1.5 border-t border-border pt-3 first:border-t-0 first:pt-0 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2 sm:border-t-0 sm:pt-0"
            >
              <span className="font-mono text-2xs text-muted-foreground sm:w-36 sm:shrink-0">
                {domain}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {Object.keys(STATUS_MAP[domain]).map((value) => (
                  <AnyStatusBadge key={value} domain={domain} value={value} />
                ))}
              </div>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-5 border-t border-border pt-4">
            {PRIORITIES.map((priority) => (
              <PriorityIndicator key={priority} value={priority} showLabel />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {PROJECT_HEALTHS.map((health) => (
              <HealthChip key={health} value={health} />
            ))}
          </div>
        </div>
      </SectionCard>

      <SectionCard
        id="visibility" className="scroll-mt-14"
        title={t("sections.visibility")}
        description={t("visibilityHint")}
      >
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {SIMULATIONS.map((sim) => (
              <div key={sim.key} className="flex flex-col gap-2">
                <span className={eyebrow}>{t(`simulation.${sim.key}`)}</span>
                <div
                  style={sim.filter ? { filter: sim.filter } : undefined}
                  className="flex flex-col items-start gap-2 rounded-md border border-border bg-card p-3"
                >
                  <VisibilityBadge value="INTERNAL" />
                  <VisibilityBadge value="CLIENT_VISIBLE" />
                  <span className="inline-flex h-5 items-center rounded-full bg-primary px-2 text-2xs text-primary-foreground">
                    {t("columns.role")}
                  </span>
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t("visibilityRow")}</p>
          {/* Bled to the card's edges, so the card's own hairline is the
              only one: a bordered table inside 16px of padding draws two
              rules 16px apart (§10.15.1). */}
          <div className="-mx-4 -mb-4 border-t border-border">
            <DataTable density="compact" flush scrollLabel={t("sections.visibility")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.name")}</TableHead>
                  <TableHead>{t("columns.visibility")}</TableHead>
                  <TableHead className="text-right">{t("columns.hours")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow className={visibilityRowCue("INTERNAL")}>
                  <TableCell>{t("entitySamples.one")}</TableCell>
                  <TableCell>
                    <VisibilityBadge value="INTERNAL" />
                  </TableCell>
                  <TableCell className="num text-right">{SAMPLE.hoursA}</TableCell>
                </TableRow>
                <TableRow className={visibilityRowCue("CLIENT_VISIBLE")}>
                  <TableCell>{t("entitySamples.two")}</TableCell>
                  <TableCell>
                    <VisibilityBadge value="CLIENT_VISIBLE" />
                  </TableCell>
                  <TableCell className="num text-right">{SAMPLE.hoursB}</TableCell>
                </TableRow>
              </TableBody>
              </Table>
            </DataTable>
          </div>
        </div>
      </SectionCard>

      <SectionCard id="entities" className="scroll-mt-14" title={t("sections.entities")} description={t("sections.entitiesHint")}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            {ENTITY_TOKENS.map((token, index) => (
              <div key={token} className="flex w-24 flex-col gap-1">
                <span
                  aria-hidden="true"
                  style={{ background: `var(${token})` }}
                  className="h-8 rounded-sm border border-border"
                />
                <span className="num font-mono text-2xs text-muted-foreground">
                  {ENTITY_HUES[index]}
                </span>
                <span className="num font-mono text-2xs text-muted-foreground">
                  {ratioText(ratio(token, "--card", "light"))}
                </span>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-5 border-t border-border pt-4">
            <EntityChip id="cuid-1" name={t("entitySamples.one")} kind="client" />
            <EntityChip id="cuid-2" name={t("entitySamples.two")} kind="client" size="md" />
            <EntityChip
              id="cuid-3"
              name={t("entitySamples.three")}
              entityKey={SAMPLE.keyVadero}
              kind="project"
            />
            <EntityChip
              id="cuid-4"
              name={t("entitySamples.four")}
              entityKey={SAMPLE.keySjoberg}
              kind="project"
            />
          </div>
        </div>
      </SectionCard>

      <SectionCard id="charts" className="scroll-mt-14" title={t("sections.charts")} description={t("chartsHint")}>
        <div className="flex flex-wrap gap-2">
          {CHART_TOKENS.map((token) => (
            <div key={token} className="flex w-28 flex-col gap-1">
              <span
                aria-hidden="true"
                style={{ background: `var(${token})` }}
                className="h-8 rounded-sm border border-border"
              />
              <span className="num font-mono text-2xs text-muted-foreground">{token}</span>
              <span className="num font-mono text-2xs text-muted-foreground">
                {ratioText(ratio(token, "--background", "light"))}
              </span>
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard id="rail" className="scroll-mt-14" title={t("sections.rail")} description={t("sections.railHint")}>
        <div className="grid gap-6 lg:grid-cols-2">
          <Timeline>
            {(
              [
                { value: "DONE", filled: true, cue: "INTERNAL", name: "one" },
                { value: "IN_PROGRESS", filled: false, cue: "CLIENT_VISIBLE", name: "two" },
                { value: "CANCELLED", filled: true, cue: "INTERNAL", name: "three" },
                { value: "PLANNED", filled: false, cue: "INTERNAL", name: "four" },
              ] as const
            ).map((row, i, all) => {
              const spec = STATUS_MAP.milestoneStatus[row.value];
              return (
                <TimelineItem
                  key={row.value}
                  node={<StatusIcon name={spec.icon} className="size-3.5" />}
                  tone={spec.tone}
                  filled={row.filled}
                  last={i === all.length - 1}
                  contentClassName={cn("flex flex-col gap-1.5", visibilityRowCue(row.cue))}
                >
                  <span
                    className={cn(
                      "text-sm",
                      row.filled ? "text-muted-foreground line-through" : "font-medium",
                    )}
                  >
                    {t(`entitySamples.${row.name}`)}
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <StatusBadge domain="milestoneStatus" value={row.value} />
                    <VisibilityBadge value={row.cue} />
                  </span>
                </TimelineItem>
              );
            })}
          </Timeline>
          <div className="flex flex-col gap-4">
            <ProgressMeter value={3} total={8} label={formatNumber(locale, 3) + "/" + formatNumber(locale, 8)} />
            <ProgressMeter value={8} total={8} label={formatNumber(locale, 8) + "/" + formatNumber(locale, 8)} />
            <div className="flex items-center gap-2 border-t border-border pt-4">
              <MemberAvatar id="cuid-1" name={t("entitySamples.one")} />
              <MemberAvatar id="cuid-2" name={t("entitySamples.two")} size="default" />
              <MemberAvatar id="cuid-3" name={t("entitySamples.three")} size="lg" />
              <MemberAvatar id="cuid-4" name={t("entitySamples.four")} size="lg" />
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard id="feedback" className="scroll-mt-14" title={t("sections.feedback")}>
        <div className="flex flex-col gap-5">
          <div className="grid gap-3 md:grid-cols-3">
            <MetricTile label={t("feedbackItems.metricProjects")} value={SAMPLE.metricProjects} />
            <MetricTile
              label={t("feedbackItems.metricHours")}
              value={SAMPLE.metricHours}
              unit={SAMPLE.unitHour}
              delta={SAMPLE.deltaUp}
              deltaTone="up"
            />
            <MetricTile
              label={t("feedbackItems.metricUnbilled")}
              value={SAMPLE.metricUnbilled}
              unit={SAMPLE.unitMoney}
              delta={SAMPLE.deltaDown}
              deltaTone="down"
            />
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <Callout tone="info" title={t("feedbackItems.calloutInfo")}>
              {t("feedbackItems.calloutInfoBody")}
            </Callout>
            <Callout tone="caution" title={t("feedbackItems.calloutCaution")}>
              {t("feedbackItems.calloutCautionBody")}
            </Callout>
            <Callout tone="danger" title={t("feedbackItems.calloutDanger")}>
              {t("feedbackItems.calloutDangerBody")}
            </Callout>
            <Callout tone="success" title={t("feedbackItems.calloutSuccess")}>
              {t("feedbackItems.calloutSuccessBody")}
            </Callout>
          </div>

          <div className="flex flex-wrap items-center gap-6">
            <FormMessage state={{ ok: true, message: t("feedbackItems.messageOk") }} />
            <FormMessage state={{ ok: false, message: t("feedbackItems.messageError") }} />
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <span className={eyebrow}>{t("feedbackItems.keyboard")}</span>
            <KeyboardHint keys={PALETTE_KEYS} />
            <KeyboardHint keys={GOTO_KEYS} />
            <KeyboardHint keys={ESC_KEY} />
            <KeyboardHint keys={HELP_KEY} />
          </div>

          <div className="grid gap-6 md:grid-cols-3">
            <EmptyState
              variant="empty"
              title={t("feedbackItems.emptyTitle")}
              body={t("feedbackItems.emptyBody")}
              action={<Button size="sm">{t("feedbackItems.empty")}</Button>}
            />
            <EmptyState
              variant="filtered"
              title={t("feedbackItems.filteredTitle")}
              body={t("feedbackItems.filteredBody")}
            />
            <EmptyState
              variant="forbidden"
              title={t("feedbackItems.forbiddenTitle")}
              body={t("feedbackItems.forbiddenBody")}
            />
          </div>

          <div className="flex flex-col gap-2">
            <span className={eyebrow}>{t("feedbackItems.skeleton")}</span>
            <div className="flex flex-col gap-1">
              {[0, 1, 2, 3, 4].map((row) => (
                <Skeleton key={row} className="row-h w-full" />
              ))}
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard id="elevation" className="scroll-mt-14" title={t("sections.elevation")}>
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {ELEVATIONS.map((item) => (
              <div
                key={item.key}
                className={cn("rounded-card bg-popover p-4 text-xs", item.className)}
              >
                {t(`elevationItems.${item.key}`)}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-5 border-t border-border pt-4">
            {DURATIONS.map((key) => (
              <span key={key} className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                <span aria-hidden="true" className="size-2 rounded-full bg-primary" />
                {t(`elevationItems.${key}`)}
              </span>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t("elevationItems.reducedMotion")}</p>
        </div>
      </SectionCard>

      <SectionCard id="density" className="scroll-mt-14" title={t("sections.density")} contentClassName="p-0">
        {/* Two specimens of the list surface, each owning a half of the
            card. A bordered DataTable inside the card's padding would
            draw a second hairline 16px in (§10.15.1). */}
        <div className="grid lg:grid-cols-2">
          {DENSITIES.map((density, i) => (
            <div
              key={density}
              className={cn(
                "flex flex-col",
                i > 0 && "border-t border-border lg:border-t-0 lg:border-l",
              )}
            >
              <span className={cn(eyebrow, "px-4 pt-4 pb-2")}>
                {t(`densityItems.${density}`)}
              </span>
              <DataTable density={density} stickyHeader flush scrollLabel={t("sections.density")}>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("columns.name")}</TableHead>
                      <TableHead>{t("columns.status")}</TableHead>
                      <TableHead className="text-right">{t("columns.hours")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell>
                        <EntityChip id="cuid-1" name={t("entitySamples.one")} kind="client" />
                      </TableCell>
                      <TableCell>
                        <StatusBadge domain="projectStatus" value="ACTIVE" />
                      </TableCell>
                      <TableCell className="num text-right">{SAMPLE.hoursA}</TableCell>
                    </TableRow>
                    <TableRow aria-selected="true">
                      <TableCell>
                        <EntityChip id="cuid-3" name={t("entitySamples.three")} kind="client" />
                      </TableCell>
                      <TableCell>
                        <StatusBadge domain="projectStatus" value="PAUSED" />
                      </TableCell>
                      <TableCell className="num text-right">{SAMPLE.hoursB}</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell>
                        <EntityChip id="cuid-4" name={t("entitySamples.four")} kind="client" />
                      </TableCell>
                      <TableCell>
                        <StatusBadge domain="projectStatus" value="ARCHIVED" />
                      </TableCell>
                      <TableCell className="num text-right">{SAMPLE.hoursZero}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </DataTable>
            </div>
          ))}
        </div>
      </SectionCard>
    </Page>
  );
}
