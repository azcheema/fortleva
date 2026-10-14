// OUT OF THE REACT COMPILER: rendered by react-pdf's own reconciler, on the
// React that `@react-pdf/renderer` (a server-external package) loads — the
// invoice's PDF says why at length.
"use no memo";

import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { createTranslator } from "next-intl";

import { registerPdfFonts } from "@/lib/pdf-fonts";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

import type { MadeReportContent, MadeReportHealth, MadeReportProject, MadeReportUpdate } from "../made-report-shape";
import { RichTextBlocks } from "./rich-text";

/**
 * THE MONTHLY REPORT'S PDF (Phase 7 slice 119; founder decision C95; design
 * docs/research/2026-10-15-slice-119-monthly-report-design.md §4) — a pure
 * drawing of a `MadeReportPrint`: what the client can already see in their
 * portal for one month, in the report's language, with the team's two texts
 * around it. Every label from `reportPdf.*` (and the portal's own words for a
 * section's heading and a project's health) in the REPORT's language, never
 * the reader's.
 *
 * WHAT IS DRAWN (C95 (b), (d)): an eyebrow and the month; the client and the
 * agency; the team's SUMMARY; per ticked project its name and health, "What
 * got done" (a line per task: the title and the day it was finished) and
 * "Progress updates" (each with its number, day and health, its title, its
 * period and note when it has them, and its sections under their headings,
 * the body walked by `./rich-text.tsx`); the team's COMING NEXT; a foot with
 * the agency, the client, the month and the page.
 *
 * WHAT IS NOT (C95 (b), (c)): no numbers strip, no hours, no milestone, no
 * file, no website speed, no member's name, no task number, nothing of
 * Fortleva's (the agency's report to its client — R5).
 *
 * THE TRAPS: no `lineHeight` on the page (the foot's `render` page number
 * would inherit it and react-pdf 4.9 lays that text out at -1e22 points past
 * some twenty pages); never a newline in a Text (a line each); Inter
 * registered once (`@/lib/pdf-fonts`), read from disk, traced by
 * `next.config.ts` into `/clients/**`.
 */

export type MadeReportLocale = "sv" | "en";

export type MadeReportPrint = {
  readonly locale: MadeReportLocale;
  readonly clientName: string;
  readonly agencyName: string;
  /** The day it was made, `YYYY-MM-DD` in the workspace's zone. */
  readonly madeOn: string;
  readonly summary: string | null;
  readonly comingNext: string | null;
  readonly content: MadeReportContent;
};

/** Which drawing this is. Raise it whenever this file changes what a PDF looks like. */
export const MADE_REPORT_TEMPLATE_VERSION = 1;

/** A printed page has no theme: these are the PDF's own inks, not the app's tokens. */
const INK = { text: "#1a1a1a", muted: "#5f5f5f", rule: "#d4d4d4", band: "#f4f4f4" } as const;

const s = StyleSheet.create({
  page: { fontFamily: "Inter", fontSize: 9.5, color: INK.text, paddingTop: 44, paddingBottom: 72, paddingHorizontal: 54 },
  body: { lineHeight: 1.45 },
  eyebrow: { fontSize: 7.5, color: INK.muted, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 },
  title: { fontSize: 20, lineHeight: 1.2, fontWeight: 600, marginBottom: 6 },
  head: { marginBottom: 20, paddingBottom: 12, borderBottomWidth: 0.5, borderBottomColor: INK.rule },
  headLine: { color: INK.muted },
  strong: { fontWeight: 600 },
  section: { marginBottom: 14 },
  sectionTitle: { fontSize: 7.5, color: INK.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 5 },
  text: { marginBottom: 2 },
  project: { marginTop: 10, marginBottom: 8 },
  projectHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", borderBottomWidth: 1, borderBottomColor: INK.text, paddingBottom: 5, marginBottom: 8 },
  projectName: { fontSize: 13, lineHeight: 1.25, fontWeight: 600, flexGrow: 1, flexShrink: 1, flexBasis: 0, paddingRight: 8 },
  health: { fontSize: 8.5, color: INK.muted },
  taskRow: { flexDirection: "row", marginBottom: 2 },
  bullet: { width: 12 },
  taskTitle: { flexGrow: 1, flexShrink: 1, flexBasis: 0, paddingRight: 8 },
  taskDay: { width: 64, textAlign: "right", color: INK.muted },
  update: { marginTop: 6, marginBottom: 8, paddingTop: 6, borderTopWidth: 0.5, borderTopColor: INK.rule },
  updateHead: { fontSize: 8.5, color: INK.muted, marginBottom: 2 },
  updateTitle: { fontSize: 11, lineHeight: 1.3, fontWeight: 600, marginBottom: 3 },
  note: { backgroundColor: INK.band, padding: 6, marginTop: 4, marginBottom: 6, color: INK.muted },
  updateSection: { marginTop: 5 },
  nothing: { color: INK.muted },
  foot: { position: "absolute", bottom: 30, left: 54, right: 54, borderTopWidth: 0.5, borderTopColor: INK.rule, paddingTop: 6, fontSize: 7.5, color: INK.muted, flexDirection: "row", justifyContent: "space-between" },
});

const MESSAGES = { en, sv } as const;
const INTL = { sv: "sv-SE", en: "en-GB" } as const;

/** The report's own words. */
function translatorFor(locale: MadeReportLocale) {
  return createTranslator({ locale, messages: MESSAGES[locale], namespace: "reportPdf" });
}
/** The portal's words for a project's health and a section's heading, in the report's language. */
function healthWords(locale: MadeReportLocale) {
  return createTranslator({ locale, messages: MESSAGES[locale], namespace: "states.projectHealth" });
}
function sectionWords(locale: MadeReportLocale) {
  return createTranslator({ locale, messages: MESSAGES[locale], namespace: "updates.sections" });
}

/** "September 2026" / "september 2026" — in UTC, as every month label is (`reportMonthLabel`'s reason). */
export function monthLabel(month: string, locale: MadeReportLocale): string {
  return new Intl.DateTimeFormat(INTL[locale], { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${month}T00:00:00.000Z`),
  );
}

/** A `YYYY-MM-DD` as a day in the report's language ("12 September 2026" / "12 september 2026"). */
function dayLabel(day: string, locale: MadeReportLocale, style: "long" | "short"): string {
  return new Intl.DateTimeFormat(INTL[locale], {
    day: "numeric",
    month: style,
    ...(style === "long" ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00.000Z`));
}

/** The document's name — client-visible, in the report's language. */
export function madeReportName(month: string, locale: MadeReportLocale): string {
  return translatorFor(locale)("name", { month: monthLabel(month, locale) });
}

/** The PDF's file name. */
export function madeReportFileName(month: string, locale: MadeReportLocale): string {
  return translatorFor(locale)("fileName", { month: month.slice(0, 7) });
}

/** The team's words as LINES — never a newline inside a Text. An empty line keeps its height. */
function Lines({ text }: { readonly text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) => (
        <Text key={i} style={s.text}>
          {line.trim().length === 0 ? " " : line}
        </Text>
      ))}
    </>
  );
}

function Health({ value, locale }: { readonly value: MadeReportHealth; readonly locale: MadeReportLocale }) {
  return <Text style={s.health}>{healthWords(locale)(value)}</Text>;
}

function Update({ update, locale }: { readonly update: MadeReportUpdate; readonly locale: MadeReportLocale }) {
  const t = translatorFor(locale);
  const tSections = sectionWords(locale);
  const headParts = [
    t("updateNumber", { seq: update.seq }),
    dayLabel(update.publishedOn, locale, "long"),
    healthWords(locale)(update.health),
  ];
  return (
    <View style={s.update}>
      <Text style={s.updateHead}>{headParts.join(" · ")}</Text>
      {update.title ? <Text style={s.updateTitle}>{update.title}</Text> : null}
      {update.periodStart || update.periodEnd ? (
        <Text style={s.updateHead}>
          {update.periodStart && update.periodEnd
            ? t("period", { from: dayLabel(update.periodStart, locale, "long"), to: dayLabel(update.periodEnd, locale, "long") })
            : update.periodStart
              ? t("periodFrom", { from: dayLabel(update.periodStart, locale, "long") })
              : t("periodTo", { to: dayLabel(update.periodEnd!, locale, "long") })}
        </Text>
      ) : null}
      {update.editNote ? (
        <View style={s.note}>
          <Lines text={t("note", { note: update.editNote })} />
        </View>
      ) : null}
      {update.sections.map((section, i) => (
        <View key={i} style={s.updateSection}>
          <Text style={s.sectionTitle} minPresenceAhead={20}>
            {section.key === "CUSTOM" ? (section.title ?? "") : tSections(section.key)}
          </Text>
          <RichTextBlocks doc={section.body} />
        </View>
      ))}
    </View>
  );
}

function Project({ project, locale }: { readonly project: MadeReportProject; readonly locale: MadeReportLocale }) {
  const t = translatorFor(locale);
  return (
    <View style={s.project}>
      <View style={s.projectHead} wrap={false} minPresenceAhead={40}>
        <Text style={s.projectName}>{project.name}</Text>
        {project.health ? <Health value={project.health} locale={locale} /> : null}
      </View>
      {project.tasks.length === 0 && project.updates.length === 0 ? (
        <Text style={s.nothing}>{t("nothing")}</Text>
      ) : null}
      {project.tasks.length > 0 ? (
        <View style={s.section}>
          <Text style={s.sectionTitle} minPresenceAhead={20}>
            {t("done")}
          </Text>
          {project.tasks.map((task) => (
            <View key={task.id} style={s.taskRow}>
              <Text style={s.bullet}>•</Text>
              <Text style={s.taskTitle}>{task.title}</Text>
              <Text style={s.taskDay}>{dayLabel(task.completedOn, locale, "short")}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {project.updates.length > 0 ? (
        <View style={s.section}>
          <Text style={s.sectionTitle} minPresenceAhead={20}>
            {t("updates")}
          </Text>
          {project.updates.map((u) => (
            <Update key={u.id} update={u} locale={locale} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** The document, for `renderMadeReportPdf` and the unit test. */
export function MadeReportPdf({ print }: { readonly print: MadeReportPrint }) {
  const { locale } = print;
  const t = translatorFor(locale);
  const month = monthLabel(print.content.month, locale);
  const name = t("name", { month });
  return (
    <Document title={name} language={locale}>
      <Page size="A4" style={s.page}>
        <View style={s.body}>
          <View style={s.head}>
            <Text style={s.eyebrow}>{t("eyebrow")}</Text>
            <Text style={s.title}>{month}</Text>
            <Text style={s.strong}>{print.clientName}</Text>
            <Text style={s.headLine}>{t("from", { agency: print.agencyName })}</Text>
            <Text style={s.headLine}>{t("madeOn", { date: dayLabel(print.madeOn, locale, "long") })}</Text>
          </View>
          {print.summary ? (
            <View style={s.section}>
              <Text style={s.sectionTitle} minPresenceAhead={20}>
                {t("summary")}
              </Text>
              <Lines text={print.summary} />
            </View>
          ) : null}
          {print.content.projects.map((p) => (
            <Project key={p.id} project={p} locale={locale} />
          ))}
          {print.comingNext ? (
            <View style={s.section}>
              <Text style={s.sectionTitle} minPresenceAhead={20}>
                {t("comingNext")}
              </Text>
              <Lines text={print.comingNext} />
            </View>
          ) : null}
        </View>
        <View style={s.foot} fixed>
          <Text>{`${print.agencyName} · ${print.clientName} · ${name}`}</Text>
          <Text render={({ pageNumber, totalPages }) => t("page", { page: pageNumber, pages: totalPages })} />
        </View>
      </Page>
    </Document>
  );
}

export async function renderMadeReportPdf(print: MadeReportPrint): Promise<Uint8Array> {
  registerPdfFonts();
  const buffer = await renderToBuffer(<MadeReportPdf print={print} />);
  return new Uint8Array(buffer);
}
